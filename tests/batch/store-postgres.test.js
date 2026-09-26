import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PostgresBatchStore } from "../../src/batch/store.js";

// Opt in with an isolated test database. Never load repository credentials or .env.
const connectionString = process.env.MK_BATCH_TEST_DATABASE_URL;

describe("PostgreSQL batch storage integration", { skip: !connectionString }, () => {
  const schema = `mk_batch_store_${randomBytes(10).toString("hex")}`;
  const stores = [];
  let admin;
  let createStore;
  let store;

  before(async () => {
    const { Pool } = await import("pg");
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    createStore = () => {
      const next = new PostgresBatchStore(new Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 }));
      stores.push(next);
      return next;
    };
    store = createStore();
    await Promise.all([store.init(), createStore().init(), createStore().init()]);
    await store.init();
  });

  after(async () => {
    try {
      await Promise.all(stores.map((entry) => entry.close()));
      if (admin) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin?.end();
    }
  });

  it("retains documents when a worker closes and another connects", async () => {
    const writer = createStore();
    await writer.create("batch", "restart-batch", { status: "paused", nested: { evidence: ["one"] } });
    await writer.close();
    const reader = createStore();
    const document = await reader.get("batch", "restart-batch");
    assert.deepEqual(document, { status: "paused", nested: { evidence: ["one"] }, id: "restart-batch", version: 1 });
    document.nested.evidence.push("local-only");
    assert.deepEqual((await reader.get("batch", "restart-batch")).nested.evidence, ["one"]);
  });

  it("serializes updates from independent pools without lost increments", async () => {
    const other = createStore();
    await store.create("item", "counter", { count: 0, identityKey: "counter-identity" });
    await Promise.all(Array.from({ length: 30 }, (_, index) => (index % 2 ? store : other)
      .mutate("item", "counter", async (current) => {
        await Promise.resolve();
        return { ...current, count: current.count + 1 };
      })));
    const result = await store.get("item", "counter");
    assert.equal(result.count, 30);
    assert.equal(result.version, 31);
    assert.equal(await store.mutate("item", "counter", () => null), null);
    assert.equal((await store.get("item", "counter")).version, 31);
  });

  it("claims one eligible item only once across competing transactions", async () => {
    const other = createStore();
    await store.create("target", "claim-target", { origin: "https://example.test", executionConcurrency: 1 });
    await store.create("item", "claim-item", { batchId: "claims", status: "ready", approvedFor: "approved-digest" });
    const claims = await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? store : other)
      .transaction(async (tx) => {
        await tx.mutate("target", "claim-target", () => null);
        const [candidate] = await tx.list("item", { batchId: "claims", status: "ready", approvedFor: "approved-digest" }, { limit: 1 });
        if (!candidate) return null;
        return tx.mutate("item", candidate.id, (current) => ({ ...current, status: "running", worker: String(index) }));
      })));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((await store.get("item", "claim-item")).version, 2);
  });

  it("rolls back all changes on global identity conflicts", async () => {
    await store.create("item", "identity-original", { batchId: "first", identityKey: "global-source-intent" });
    await assert.rejects(store.transaction(async (tx) => {
      await tx.create("repair", "rollback-repair", { status: "planned" });
      await tx.create("item", "identity-duplicate", { batchId: "second", identityKey: "global-source-intent" });
    }), { code: "BATCH_CONFLICT" });
    assert.equal(await store.get("repair", "rollback-repair"), null);
    assert.equal(await store.get("item", "identity-duplicate"), null);
    assert.equal((await store.get("item", "identity-original")).batchId, "first");
    await assert.rejects(store.create("item", "identity-original", {}), { code: "BATCH_CONFLICT" });
  });

  it("applies exact string filters and stable limits to normal and locked reads", async () => {
    for (const id of ["z", "a", "b"]) {
      await store.create("repair_application", `ordered-${id}`, { batchId: "ordered", status: "applied", value: "7" });
    }
    await store.create("repair_application", "ordered-0-number", { batchId: "ordered", status: "applied", value: 7 });
    const filters = { batchId: "ordered", status: "applied", value: "7" };
    const listed = await store.list("repair_application", filters, { limit: 2 });
    assert.deepEqual(listed.map((row) => row.id), ["ordered-a", "ordered-b"]);
    const locked = await store.transaction((tx) => tx.list("repair_application", filters, { limit: 1 }));
    assert.deepEqual(locked.map((row) => row.id), ["ordered-a"]);
    const projection = await store.transaction((tx) => tx.list("repair_application", filters, { fields: ["status", "missing"], limit: 1 }));
    assert.deepEqual(projection, [{ id: "ordered-a", version: 1, status: "applied" }]);
    const identities = await store.list("repair_application", filters, { fields: [], limit: 1 });
    assert.deepEqual(identities, [{ id: "ordered-a", version: 1 }]);
  });
});
