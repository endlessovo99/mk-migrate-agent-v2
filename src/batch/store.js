import { readFile } from "node:fs/promises";

const KINDS = new Set(["batch", "item", "repair", "repair_run", "repair_application", "target"]);

function failure(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function invalid(message) {
  throw failure("BATCH_INVALID_ARGUMENT", message);
}

function plainObject(value) {
  return value !== null && typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function validateKind(kind) {
  if (!KINDS.has(kind)) invalid("Unknown migration document kind.");
}

function validateKey(kind, id) {
  validateKind(kind);
  if (typeof id !== "string" || !id.trim() || id.length > 512 || /[\u0000-\u001f\u007f]/u.test(id)) {
    invalid("Document id must be a nonempty string of at most 512 characters without control characters.");
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function documentData(kind, data) {
  if (!plainObject(data)) invalid("Document data must be a JSON object.");
  let copy;
  try {
    copy = JSON.parse(JSON.stringify(data, (_key, value) => {
      if (value === undefined || typeof value === "bigint" || typeof value === "function" ||
        typeof value === "symbol" || (typeof value === "number" && !Number.isFinite(value))) {
        invalid("Document data must contain only JSON values.");
      }
      return value;
    }));
  } catch (error) {
    if (error.code === "BATCH_INVALID_ARGUMENT") throw error;
    throw failure("BATCH_INVALID_ARGUMENT", "Document data must contain only JSON values.", error);
  }
  if (!plainObject(copy)) invalid("Document data must serialize to a JSON object.");
  delete copy.id;
  delete copy.version;
  if (kind === "item" && Object.hasOwn(copy, "identityKey") &&
    (typeof copy.identityKey !== "string" || !copy.identityKey.trim())) {
    invalid("An item identityKey must be a nonempty string.");
  }
  return copy;
}

function validateFilters(kind, filters) {
  validateKind(kind);
  if (!plainObject(filters) || Object.entries(filters).some(([key, value]) =>
    !/^[A-Za-z][A-Za-z0-9_]*$/u.test(key) || typeof value !== "string")) {
    invalid("Filters must contain top-level field names and string values.");
  }
}

function listOptions(options) {
  if (!plainObject(options) || Object.keys(options).some((key) => !["limit", "fields"].includes(key)) ||
    (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10000))) {
    invalid("List options accept a limit from 1 to 10000 and an optional fields array.");
  }
  if (options.fields !== undefined && (!Array.isArray(options.fields) || options.fields.some((field) =>
    typeof field !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(field)))) {
    invalid("Projection fields must be top-level field names.");
  }
  return { limit: options.limit, fields: options.fields?.slice() };
}

function rowDocument(row) {
  return row ? { ...clone(row.data), id: row.id, version: Number(row.version) } : null;
}

function uniqueError(error) {
  if (error.code === "23505") {
    return failure("BATCH_CONFLICT", "A migration document or item identity already exists.", error);
  }
  return error;
}

async function withTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the original transaction error. */ }
    throw uniqueError(error);
  } finally {
    client.release();
  }
}

function postgresView(client, { lockReads = false, active = () => true } = {}) {
  const query = async (sql, values) => {
    if (!active()) throw failure("BATCH_STORE_CLOSED", "The transaction is no longer active.");
    try {
      return await client.query(sql, values);
    } catch (error) {
      throw uniqueError(error);
    }
  };
  const get = async (kind, id, locked = lockReads) => {
    validateKey(kind, id);
    const result = await query(
      `SELECT id, version, data FROM mk_migration_documents WHERE kind = $1 AND id = $2${locked ? " FOR UPDATE" : ""}`,
      [kind, id]
    );
    return rowDocument(result.rows[0]);
  };
  return {
    async create(kind, id, data) {
      validateKey(kind, id);
      const result = await query(
        "INSERT INTO mk_migration_documents (kind, id, data) VALUES ($1, $2, $3::jsonb) RETURNING id, version, data",
        [kind, id, JSON.stringify(documentData(kind, data))]
      );
      return rowDocument(result.rows[0]);
    },
    get: (kind, id) => get(kind, id),
    async list(kind, filters = {}, options = {}) {
      validateFilters(kind, filters);
      const { limit, fields } = listOptions(options);
      const parameters = [kind, JSON.stringify(filters)];
      let projection = "data";
      if (fields !== undefined) {
        parameters.push(fields);
        projection = `COALESCE((SELECT jsonb_object_agg(entry.key, entry.value) FROM jsonb_each(data) AS entry WHERE entry.key = ANY($${parameters.length}::text[])), '{}'::jsonb) AS data`;
      }
      let limitSql = "";
      if (limit !== undefined) {
        parameters.push(limit);
        limitSql = ` LIMIT $${parameters.length}`;
      }
      const result = await query(
        `SELECT id, version, ${projection} FROM mk_migration_documents WHERE kind = $1 AND data @> $2::jsonb ORDER BY id COLLATE "C"${limitSql}${lockReads ? " FOR UPDATE" : ""}`,
        parameters
      );
      return result.rows.map(rowDocument);
    },
    async mutate(kind, id, updater) {
      validateKey(kind, id);
      if (typeof updater !== "function") invalid("Document updater must be a function.");
      const current = await get(kind, id, true);
      if (!current) return null;
      const next = await updater(current);
      if (next === null) return null;
      const result = await query(
        "UPDATE mk_migration_documents SET data = $3::jsonb, version = version + 1 WHERE kind = $1 AND id = $2 RETURNING id, version, data",
        [kind, id, JSON.stringify(documentData(kind, next))]
      );
      return rowDocument(result.rows[0]);
    }
  };
}

/**
 * Shared batch/repair document store. Inject a pg Pool; no connection configuration
 * or NewOA credentials are read here. init() installs schema.sql; close() ends the pool.
 * create/get/list/mutate return detached {...data, id, version} documents. Reserved
 * id/version fields in data are ignored. Filters compare top-level JSON string values.
 * list(kind, filters, {limit, fields}) may cap results at 1..10000 in stable id
 * order and project top-level fields. Empty fields returns only id/version.
 * A null updater result is a no-op returning null; missing documents also return null.
 * Duplicate ids or item.identityKey values fail with BATCH_CONFLICT.
 *
 * transaction(callback) passes create/get/list/mutate on one locked connection.
 * Await operations sequentially and keep remote calls outside the transaction.
 * The callback is never retried. A thrown error rolls back every document change.
 */
export class PostgresBatchStore {
  #pool;
  #closed = false;

  constructor(pool) {
    if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function" || typeof pool.end !== "function") {
      invalid("PostgresBatchStore requires a pg Pool.");
    }
    this.#pool = pool;
  }

  #view() {
    return postgresView(this.#pool, { active: () => !this.#closed });
  }

  async init() {
    if (this.#closed) throw failure("BATCH_STORE_CLOSED", "The store is closed.");
    const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
    await withTransaction(this.#pool, async (client) => {
      // IF NOT EXISTS alone can race on PostgreSQL's type catalog during first startup.
      await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('mk_migration_documents_schema'))");
      await client.query(schema);
    });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pool.end();
  }

  create(kind, id, data) { return this.#view().create(kind, id, data); }
  get(kind, id) { return this.#view().get(kind, id); }
  list(kind, filters = {}, options = {}) { return this.#view().list(kind, filters, options); }
  mutate(kind, id, updater) { return this.transaction((tx) => tx.mutate(kind, id, updater)); }

  async transaction(callback) {
    if (typeof callback !== "function") invalid("Transaction callback must be a function.");
    if (this.#closed) throw failure("BATCH_STORE_CLOSED", "The store is closed.");
    return withTransaction(this.#pool, async (client) => {
      let active = true;
      try {
        return await callback(postgresView(client, { lockReads: true, active: () => active }));
      } finally { active = false; }
    });
  }
}

function memoryView(documents, active = () => true) {
  function assertActive() {
    if (!active()) throw failure("BATCH_STORE_CLOSED", "The transaction is no longer active.");
  }
  function save(kind, id, data, version) {
    const copy = documentData(kind, data);
    if (kind === "item" && Object.hasOwn(copy, "identityKey")) {
      for (const row of documents.values()) {
        if (row.kind === "item" && row.id !== id && row.data.identityKey === copy.identityKey) {
          throw failure("BATCH_CONFLICT", "A migration item identity already exists.");
        }
      }
    }
    const row = { kind, id, version, data: copy };
    documents.set(`${kind}:${id}`, row);
    return rowDocument(row);
  }
  return {
    async create(kind, id, data) {
      assertActive();
      validateKey(kind, id);
      if (documents.has(`${kind}:${id}`)) throw failure("BATCH_CONFLICT", "A migration document already exists.");
      return save(kind, id, data, 1);
    },
    async get(kind, id) {
      assertActive();
      validateKey(kind, id);
      return rowDocument(documents.get(`${kind}:${id}`));
    },
    async list(kind, filters = {}, options = {}) {
      assertActive();
      validateFilters(kind, filters);
      const { limit, fields } = listOptions(options);
      return [...documents.values()]
        .filter((row) => row.kind === kind && Object.entries(filters).every(([key, value]) => row.data[key] === value))
        .sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)))
        .slice(0, limit)
        .map((row) => rowDocument(fields === undefined ? row : {
          ...row, data: Object.fromEntries(fields.filter((field) => Object.hasOwn(row.data, field)).map((field) => [field, row.data[field]]))
        }));
    },
    async mutate(kind, id, updater) {
      assertActive();
      validateKey(kind, id);
      if (typeof updater !== "function") invalid("Document updater must be a function.");
      const row = documents.get(`${kind}:${id}`);
      if (!row) return null;
      const next = await updater(rowDocument(row));
      assertActive();
      return next === null ? null : save(kind, id, next, row.version + 1);
    }
  };
}

/** Offline equivalent of PostgresBatchStore; transactions hold one async mutex. */
export class MemoryBatchStore {
  #documents = new Map();
  #tail = Promise.resolve();
  #closed = false;

  async #exclusive(operation) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.#closed) throw failure("BATCH_STORE_CLOSED", "The store is closed.");
      return await operation();
    } finally {
      release();
    }
  }

  async init() { await this.#exclusive(() => {}); }
  async close() { if (!this.#closed) await this.#exclusive(() => { this.#closed = true; }); }
  create(kind, id, data) { return this.transaction((tx) => tx.create(kind, id, data)); }
  get(kind, id) { return this.#exclusive(() => memoryView(this.#documents).get(kind, id)); }
  list(kind, filters = {}, options = {}) { return this.#exclusive(() => memoryView(this.#documents).list(kind, filters, options)); }
  mutate(kind, id, updater) { return this.transaction((tx) => tx.mutate(kind, id, updater)); }

  async transaction(callback) {
    if (typeof callback !== "function") invalid("Transaction callback must be a function.");
    return this.#exclusive(async () => {
      const staged = new Map(this.#documents);
      let active = true;
      try {
        const result = await callback(memoryView(staged, () => active));
        this.#documents = staged;
        return result;
      } finally {
        active = false;
      }
    });
  }
}
