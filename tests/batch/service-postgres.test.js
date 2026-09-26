import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { PostgresBatchStore } from "../../src/batch/store.js";
import { createBatch } from "../../src/batch/intake.js";
import { approveBatch, executeBatch, inspectBatch, prepareBatch } from "../../src/batch/service.js";
import { claimItem, executionJournal, recoverBatch, retryItem, setBatchStatus, updateClaim } from "../../src/batch/scheduler.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { checkTrust } from "../../src/dsl/trust.js";
import { createFakeReviewProvider } from "../route-validation/fake-review-provider.js";

// Explicit opt-in only. Every test run owns one randomly named, temporary schema.
const connectionString = process.env.MK_BATCH_TEST_DATABASE_URL;
const manifestPath = fileURLToPath(new URL("../fixtures/batch/manifest.json", import.meta.url));
const relativeTo = dirname(manifestPath);
const workerOptions = {
  engineDigest: "postgres-route-test-engine-v1", concurrency: 2, leaseMs: 60000,
  checkpointSigningKey: "postgres-batch-test-checkpoint-signing-key-32-characters"
};
const credentials = { username: "offline-user", encryptedPassword: "offline-password" };
const manifest = (migrationKey) => ({ ...JSON.parse(readFileSync(manifestPath, "utf8")), migrationKey });
const review = (source, draft, options) => runAgentReview(source, draft, {
  ...options, provider: createFakeReviewProvider("accept"), reviewedAt: "2026-09-26T00:00:00.000Z"
});

async function prepareAndApprove(store, batchId) {
  const prepared = await prepareBatch(store, batchId, { ...workerOptions, review });
  assert.equal(prepared.counts.ready, prepared.items.length, JSON.stringify(prepared.items));
  for (const item of await store.list("item", { batchId })) {
    assert.equal(checkTrust(item.sourceDraft, item.dsl).ok, true);
  }
  await approveBatch(store, batchId, { expectedDigest: prepared.approvalDigest, confirmWrite: true, actor: "postgres-test-reviewer" });
  return prepared;
}

describe("PostgreSQL batch service integration", { skip: !connectionString }, () => {
  const schema = `mk_batch_service_${randomBytes(10).toString("hex")}`;
  const stores = [];
  let admin;
  let createStore;
  let first;
  let second;

  before(async () => {
    const { Pool } = await import("pg");
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    createStore = () => {
      const store = new PostgresBatchStore(new Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 }));
      stores.push(store);
      return store;
    };
    first = createStore();
    second = createStore();
    await first.init();
  });

  after(async () => {
    try {
      await Promise.all(stores.map((store) => store.close()));
      if (admin) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin?.end();
    }
  });

  it("shares an origin limit across independent pools and batches without duplicate execution", { timeout: 20000 }, async () => {
    const one = await createBatch(first, manifest("postgres-concurrent-one"), { relativeTo });
    const two = await createBatch(second, manifest("postgres-concurrent-two"), { relativeTo });
    await Promise.all([prepareAndApprove(first, one.id), prepareAndApprove(second, two.id)]);
    let active = 0;
    let maximum = 0;
    let writes = 0;
    const execute = async (_dsl, options) => {
      active += 1;
      maximum = Math.max(maximum, active);
      const templateId = `postgres-fake-target-${++writes}`;
      try {
        await options.journal.beforeWrite({ operation: "add" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await options.journal.afterWrite({ operation: "add", result: { targetTemplateId: templateId } });
        return { ok: true, templateId, diagnostics: [], remoteWriteAttempted: true, writeOutcomeUnknown: false };
      } finally { active -= 1; }
    };
    const executionOptions = { ...workerOptions, confirmWrite: true, credentials, execute };
    await Promise.all([
      executeBatch(first, one.id, { ...executionOptions, workerId: "first-pool-worker" }),
      executeBatch(second, one.id, { ...executionOptions, workerId: "second-pool-worker" }),
      executeBatch(second, two.id, { ...executionOptions, workerId: "second-batch-worker" })
    ]);
    assert.equal(maximum, 1);
    assert.equal(writes, 4);
    assert.equal((await inspectBatch(second, one.id)).counts.succeeded, 2);
    assert.equal((await inspectBatch(first, two.id)).counts.succeeded, 2);
    for (const batchId of [one.id, two.id]) {
      for (const item of await second.list("item", { batchId })) {
        const attempts = item.attempts.filter((attempt) => attempt.phase === "execute");
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0].steps[0].outcome, "confirmed");
        assert.equal(item.status, "succeeded");
      }
    }
    await Promise.all([executeBatch(first, one.id, executionOptions), executeBatch(second, two.id, executionOptions)]);
    assert.equal(writes, 4);
    await assert.rejects(createBatch(second, manifest("postgres-concurrent-one"), { relativeTo }), { code: "BATCH_CONFLICT" });
    assert.equal((await first.list("batch", { migrationKey: "postgres-concurrent-one" })).length, 1);
  });

  it("recovers safe leases after reconnection and never replays an unacknowledged write", { timeout: 20000 }, async () => {
    const writer = createStore();
    const input = manifest("postgres-recovery");
    input.items = [input.items[0]];
    const batch = await createBatch(writer, input, { relativeTo });
    await setBatchStatus(writer, batch.id, "running");
    const context = { ...workerOptions, workerId: "abandoned-worker" };
    const preparing = await claimItem(writer, batch.id, "prepare", context);
    await writer.mutate("item", preparing.id, (item) => ({ ...item, leaseUntil: "2000-01-01T00:00:00.000Z" }));
    await writer.close();
    const replacement = createStore();
    assert.deepEqual((await recoverBatch(replacement, batch.id)).recovered, [{ itemId: preparing.id, status: "pending" }]);
    await assert.rejects(updateClaim(replacement, preparing.id, preparing.activeAttemptId, (item) => item), { code: "BATCH_LEASE_LOST" });
    await prepareAndApprove(replacement, batch.id);
    const prewrite = await claimItem(replacement, batch.id, "execute", context);
    await replacement.mutate("item", prewrite.id, (item) => ({ ...item, leaseUntil: "2000-01-01T00:00:00.000Z" }));
    await replacement.close();
    const recovering = createStore();
    assert.deepEqual((await recoverBatch(recovering, batch.id)).recovered, [{ itemId: prewrite.id, status: "ready" }]);
    const unknown = await claimItem(recovering, batch.id, "execute", context);
    assert.equal(unknown.id, prewrite.id);
    await executionJournal(recovering, unknown.id, unknown.activeAttemptId).beforeWrite({ operation: "add" });
    await recovering.mutate("item", unknown.id, (item) => ({ ...item, leaseUntil: "2000-01-01T00:00:00.000Z" }));
    await recovering.close();
    const finalWorker = createStore();
    assert.deepEqual((await recoverBatch(finalWorker, batch.id)).recovered, [{ itemId: unknown.id, status: "outcome_unknown" }]);
    let calls = 0;
    const inspected = await executeBatch(finalWorker, batch.id, {
      ...workerOptions, confirmWrite: true, credentials, execute: async () => { calls += 1; throw new Error("must not replay"); }
    });
    assert.equal(calls, 0);
    assert.equal(inspected.counts.outcome_unknown, 1);
    const retained = await finalWorker.get("item", unknown.id);
    assert.equal(retained.attempts.at(-1).steps[0].outcome, "pending");
    assert.equal(retained.writeStarted, true);
    assert.equal(retained.targetTemplateId, null);
    await setBatchStatus(finalWorker, batch.id, "paused");
    await assert.rejects(retryItem(finalWorker, batch.id, unknown.id), { code: "BATCH_RETRY_FORBIDDEN" });
  });
});
