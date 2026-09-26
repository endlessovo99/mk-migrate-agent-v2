import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryBatchStore, PostgresBatchStore } from "../../src/batch/store.js";

const isConflict = (error) => error.code === "BATCH_CONFLICT";
const isInvalid = (error) => error.code === "BATCH_INVALID_ARGUMENT";

describe("memory batch document storage", () => {
  it("keeps detached snapshots, versions and reserved metadata", async () => {
    const store = new MemoryBatchStore();
    await store.init();
    const input = { state: "queued", evidence: { refs: ["source-1"] }, id: "ignored", version: 90 };
    const created = await store.create("batch", "batch-1", input);
    input.evidence.refs.push("changed-input");
    created.evidence.refs.push("changed-result");
    assert.deepEqual(await store.get("batch", "batch-1"), {
      state: "queued", evidence: { refs: ["source-1"] }, id: "batch-1", version: 1
    });
    const changed = await store.mutate("batch", "batch-1", async (current) => ({ ...current, state: "paused" }));
    assert.equal(changed.version, 2);
    assert.equal(changed.state, "paused");
    assert.equal(await store.mutate("batch", "batch-1", (current) => {
      current.evidence.refs.push("must-not-persist");
      return null;
    }), null);
    assert.deepEqual((await store.get("batch", "batch-1")).evidence.refs, ["source-1"]);
    assert.equal((await store.get("batch", "batch-1")).version, 2);
    assert.equal(await store.get("batch", "missing"), null);
    assert.equal(await store.mutate("batch", "missing", () => { throw new Error("not called"); }), null);
    await store.close();
    await store.close();
    await assert.rejects(store.get("batch", "batch-1"), { code: "BATCH_STORE_CLOSED" });
  });

  it("filters exact string fields and sorts results by id", async () => {
    const store = new MemoryBatchStore();
    await store.create("item", "z", { batchId: "one", state: "queued", nested: { state: "blocked" } });
    await store.create("item", "b", { batchId: "one", state: "blocked" });
    await store.create("item", "a", { batchId: "one", state: "queued" });
    await store.create("item", "c", { batchId: "two", state: "queued" });
    await store.create("batch", "other-kind", { batchId: "one", state: "queued" });
    const rows = await store.list("item", { batchId: "one", state: "queued" });
    assert.deepEqual(rows.map((row) => row.id), ["a", "z"]);
    assert.deepEqual((await store.list("item", { batchId: "one", state: "queued" }, { limit: 1 })).map((row) => row.id), ["a"]);
    assert.deepEqual((await store.transaction((tx) => tx.list("item", { batchId: "one" }, { limit: 2 }))).map((row) => row.id), ["a", "b"]);
    rows[1].nested.state = "changed";
    assert.equal((await store.get("item", "z")).nested.state, "blocked");
    assert.deepEqual(await store.list("item", { version: "1" }), []);
  });

  it("rejects duplicate ids and migration identities across batches without overwriting", async () => {
    const store = new MemoryBatchStore();
    await store.create("item", "first", { batchId: "one", identityKey: "same-migration" });
    await assert.rejects(store.create("item", "first", { batchId: "changed" }), isConflict);
    await assert.rejects(store.create("item", "second", { batchId: "two", identityKey: "same-migration" }), isConflict);
    await store.create("item", "second", { batchId: "two", identityKey: "another-migration" });
    await assert.rejects(store.mutate("item", "second", (current) => ({ ...current, identityKey: "same-migration" })), isConflict);
    assert.equal((await store.get("item", "first")).batchId, "one");
    assert.equal((await store.get("item", "second")).version, 1);
    await store.create("repair", "first", { identityKey: "same-migration" });
    await store.create("target", "origin-lock", { origin: "https://example.test", executionConcurrency: 1 });
  });

  it("projects requested fields without changing filters or exposing full snapshots", async () => {
    const store = new MemoryBatchStore();
    await store.create("item", "projected", { batchId: "one", status: "ready", targetTemplateId: null, nested: { count: 1 }, snapshot: "large-source" });
    assert.deepEqual(await store.list("item", { status: "ready" }, { fields: [] }), [{ id: "projected", version: 1 }]);
    const [result] = await store.list("item", { status: "ready" }, { fields: ["status", "missing", "nested", "targetTemplateId"], limit: 1 });
    assert.deepEqual(result, { status: "ready", nested: { count: 1 }, targetTemplateId: null, id: "projected", version: 1 });
    result.nested.count = 2;
    assert.equal((await store.get("item", "projected")).nested.count, 1);
  });

  it("rolls back a failed multi-document transaction and prevents leaked transaction use", async () => {
    const store = new MemoryBatchStore();
    await store.create("batch", "batch-1", { state: "queued" });
    let retained;
    const failure = new Error("failure after writing documents");
    await assert.rejects(store.transaction(async (tx) => {
      retained = tx;
      assert.equal(tx.transaction, undefined);
      assert.equal(tx.close, undefined);
      await tx.mutate("batch", "batch-1", (current) => ({ ...current, state: "running" }));
      await tx.create("item", "item-1", { batchId: "batch-1", state: "queued" });
      throw failure;
    }), (error) => error === failure);
    assert.deepEqual(await store.get("batch", "batch-1"), { state: "queued", id: "batch-1", version: 1 });
    assert.equal(await store.get("item", "item-1"), null);
    await assert.rejects(retained.create("item", "escape", {}), { code: "BATCH_STORE_CLOSED" });
    const result = await store.transaction(async (tx) => {
      retained = tx;
      await tx.create("repair", "repair-1", { state: "planned" });
      return tx.get("repair", "repair-1");
    });
    assert.equal(result.version, 1);
    await assert.rejects(retained.get("repair", "repair-1"), { code: "BATCH_STORE_CLOSED" });
  });

  it("serializes asynchronous claims so a migration is claimed once", async () => {
    const store = new MemoryBatchStore();
    await store.create("item", "one", { state: "queued", count: 0 });
    const claims = await Promise.all(Array.from({ length: 12 }, (_, index) => store.transaction(async (tx) => {
      const current = await tx.get("item", "one");
      await Promise.resolve();
      if (current.state !== "queued") return null;
      return tx.mutate("item", "one", (item) => ({ ...item, state: "running", worker: String(index) }));
    })));
    assert.equal(claims.filter(Boolean).length, 1);
    await Promise.all(Array.from({ length: 30 }, () => store.mutate("item", "one", async (current) => {
      await Promise.resolve();
      return { ...current, count: current.count + 1 };
    })));
    const result = await store.get("item", "one");
    assert.equal(result.count, 30);
    assert.equal(result.version, 32);
  });

  it("rejects invalid documents, ids, kinds, filters and callbacks", async () => {
    const store = new MemoryBatchStore();
    for (const kind of ["unknown", "batch; DROP TABLE anything", null]) {
      await assert.rejects(store.get(kind, "id"), isInvalid);
    }
    for (const id of ["", " ", "bad\nline", "a".repeat(513), 12]) {
      await assert.rejects(store.create("batch", id, {}), isInvalid);
    }
    for (const filters of [null, [], { state: 1 }, { "nested.state": "queued" }, { "state' OR 1=1": "queued" }]) {
      await assert.rejects(store.list("item", filters), isInvalid);
    }
    for (const options of [null, [], { offset: 2 }, { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: 10001 }, { limit: "1" },
      { fields: null }, { fields: "status" }, { fields: ["nested.status"] }, { fields: [1] }, { fields: ["x' OR 1=1"] }]) {
      await assert.rejects(store.list("item", {}, options), isInvalid);
    }
    const cycle = {};
    cycle.self = cycle;
    for (const data of [null, [], { missing: undefined }, { count: NaN }, { count: 1n }, cycle]) {
      await assert.rejects(store.create("batch", "bad-data", data), isInvalid);
    }
    for (const identityKey of [null, 5, "", " "]) {
      await assert.rejects(store.create("item", "bad-identity", { identityKey }), isInvalid);
    }
    await assert.rejects(store.transaction(null), isInvalid);
    await assert.rejects(store.mutate("item", "missing", null), isInvalid);
  });
});

function fakePool(responder = () => ({ rows: [] })) {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ connection: "client", sql, values });
      return responder(sql, values);
    },
    release() { calls.push({ release: true }); }
  };
  return {
    calls,
    async query(sql, values) {
      calls.push({ connection: "pool", sql, values });
      return responder(sql, values);
    },
    async connect() { calls.push({ connect: true }); return client; },
    async end() { calls.push({ end: true }); }
  };
}

describe("PostgreSQL batch storage adapter", () => {
  it("loads only the local schema and parameterizes untrusted document/filter strings", async () => {
    const pool = fakePool((sql, values) => sql.startsWith("INSERT")
      ? { rows: [{ id: values[1], version: 1, data: JSON.parse(values[2]) }] }
      : { rows: [] });
    const store = new PostgresBatchStore(pool);
    await store.init();
    const injected = "x'); DROP TABLE mk_migration_documents; --";
    const result = await store.create("batch", injected, { state: injected });
    assert.equal(result.id, injected);
    await store.list("item", { state: injected });
    const schemaCall = pool.calls.find((call) => call.sql?.includes("CREATE TABLE"));
    assert.match(schemaCall.sql, /CREATE UNIQUE INDEX IF NOT EXISTS mk_migration_item_identity_key/u);
    assert.equal(pool.calls.some((call) => call.sql?.includes("pg_advisory_xact_lock")), true);
    const queries = pool.calls.filter((call) => call.connection === "pool");
    assert.equal(queries[0].sql.includes(injected), false);
    assert.deepEqual(queries[0].values, ["batch", injected, JSON.stringify({ state: injected })]);
    assert.equal(queries[1].sql.includes(injected), false);
    assert.deepEqual(queries[1].values, ["item", JSON.stringify({ state: injected })]);
    const beforeInvalid = pool.calls.length;
    await assert.rejects(store.list("item", { "bad.key": "value" }), isInvalid);
    assert.equal(pool.calls.length, beforeInvalid);
    await store.close();
    await store.close();
    assert.equal(pool.calls.filter((call) => call.end).length, 1);
  });

  it("locks and mutates a document on one connection, then commits and releases", async () => {
    const pool = fakePool((sql, values) => {
      if (sql.startsWith("SELECT")) return { rows: [{ id: "one", version: 3, data: { state: "queued" } }] };
      if (sql.startsWith("UPDATE")) return { rows: [{ id: "one", version: 4, data: JSON.parse(values[2]) }] };
      return { rows: [] };
    });
    const store = new PostgresBatchStore(pool);
    const result = await store.mutate("item", "one", (current) => ({ ...current, state: "running" }));
    assert.equal(result.version, 4);
    assert.deepEqual(pool.calls.map((call) => call.sql || (call.connect ? "CONNECT" : "RELEASE")), [
      "CONNECT", "BEGIN",
      "SELECT id, version, data FROM mk_migration_documents WHERE kind = $1 AND id = $2 FOR UPDATE",
      "UPDATE mk_migration_documents SET data = $3::jsonb, version = version + 1 WHERE kind = $1 AND id = $2 RETURNING id, version, data",
      "COMMIT", "RELEASE"
    ]);
    assert.equal(pool.calls.some((call) => call.connection === "pool"), false);
    assert.deepEqual(JSON.parse(pool.calls[3].values[2]), { state: "running" });
  });

  it("parameterizes list limits before transactional row locks", async () => {
    const pool = fakePool();
    const store = new PostgresBatchStore(pool);
    await store.list("item", { status: "ready" }, { limit: 2 });
    await store.transaction((tx) => tx.list("item", { status: "ready" }, { limit: 1 }));
    const selects = pool.calls.filter((call) => call.sql?.startsWith("SELECT"));
    assert.match(selects[0].sql, /LIMIT \$3$/u);
    assert.deepEqual(selects[0].values, ["item", '{"status":"ready"}', 2]);
    assert.match(selects[1].sql, /LIMIT \$3 FOR UPDATE$/u);
    assert.deepEqual(selects[1].values, ["item", '{"status":"ready"}', 1]);
    const beforeInvalid = pool.calls.length;
    await assert.rejects(store.list("item", {}, { limit: 0 }), isInvalid);
    assert.equal(pool.calls.length, beforeInvalid);
  });

  it("parameterizes projection fields independently from filters and limits", async () => {
    const pool = fakePool();
    const store = new PostgresBatchStore(pool);
    await store.list("item", { status: "ready" }, { fields: [] });
    await store.transaction((tx) => tx.list("item", { status: "ready" }, { fields: ["status", "batchId"], limit: 2 }));
    const selects = pool.calls.filter((call) => call.sql?.startsWith("SELECT"));
    assert.match(selects[0].sql, /ANY\(\$3::text\[\]\)/u);
    assert.deepEqual(selects[0].values, ["item", '{"status":"ready"}', []]);
    assert.match(selects[1].sql, /ANY\(\$3::text\[\]\)/u);
    assert.match(selects[1].sql, /LIMIT \$4 FOR UPDATE$/u);
    assert.deepEqual(selects[1].values, ["item", '{"status":"ready"}', ["status", "batchId"], 2]);
    const beforeInvalid = pool.calls.length;
    await assert.rejects(store.list("item", {}, { fields: ["nested.field"] }), isInvalid);
    assert.equal(pool.calls.length, beforeInvalid);
  });

  it("leaves missing and no-op mutations unchanged", async () => {
    let found = false;
    const pool = fakePool((sql) => sql.startsWith("SELECT") && found
      ? { rows: [{ id: "one", version: 1, data: { state: "queued" } }] }
      : { rows: [] });
    const store = new PostgresBatchStore(pool);
    assert.equal(await store.mutate("item", "one", () => { throw new Error("not called"); }), null);
    found = true;
    assert.equal(await store.mutate("item", "one", () => null), null);
    assert.equal(pool.calls.some((call) => call.sql?.startsWith("UPDATE")), false);
    assert.equal(pool.calls.filter((call) => call.sql === "COMMIT").length, 2);
  });

  it("rolls back conflicts and callback failures, and expires transaction handles", async () => {
    const pool = fakePool((sql) => {
      if (sql.startsWith("INSERT")) throw Object.assign(new Error("unique violation"), { code: "23505" });
      return { rows: [] };
    });
    const store = new PostgresBatchStore(pool);
    let retained;
    await assert.rejects(store.transaction(async (tx) => {
      retained = tx;
      await tx.get("batch", "batch-1");
      await tx.list("item", { batchId: "batch-1" });
      await tx.create("item", "item-1", {});
    }), isConflict);
    const selects = pool.calls.filter((call) => call.sql?.startsWith("SELECT"));
    assert.equal(selects.length, 2);
    assert.equal(selects.every((call) => call.sql.endsWith("FOR UPDATE")), true);
    assert.equal(pool.calls.at(-2).sql, "ROLLBACK");
    assert.deepEqual(pool.calls.at(-1), { release: true });
    await assert.rejects(retained.create("item", "escape", {}), { code: "BATCH_STORE_CLOSED" });
    const failure = new Error("callback failed");
    await assert.rejects(store.transaction(async () => { throw failure; }), (error) => error === failure);
    assert.equal(pool.calls.filter((call) => call.sql === "ROLLBACK").length, 2);
  });
});
