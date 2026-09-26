import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { MemoryBatchStore } from "../../src/batch/store.js";
import { createBatch } from "../../src/batch/intake.js";
import { prepareBatch, approveBatch, executeBatch } from "../../src/batch/service.js";
import { claimItem, recoverBatch, executionJournal } from "../../src/batch/scheduler.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { createFakeReviewProvider } from "../route-validation/fake-review-provider.js";

const ENGINE = "worker-evidence-engine";
const WORKER = { engineDigest: ENGINE, concurrency: 1, leaseMs: 60000,
  checkpointSigningKey: "worker-evidence-checkpoint-key-long-enough" };
const CREDENTIALS = { username: "fake-worker-user", encryptedPassword: "fake-worker-password" };
const SUCCESS = {
  ok: true, status: "written", templateId: "observed-target", diagnostics: [],
  readback: { ok: true, partitions: { form: "verified", workflow: "verified" } },
  transferRecord: { fdId: "observed-record", status: "recorded" },
  remoteWriteAttempted: true, writeOutcomeUnknown: false
};

describe("batch worker completion evidence", () => {
  it("retains the complete successful report after a transient heartbeat persistence failure", async () => {
    const { store, batch, item } = await prepared();
    const heartbeatFailed = deferred();
    const mutate = store.mutate.bind(store);
    let failHeartbeat = false;
    store.mutate = async (...args) => {
      if (failHeartbeat) {
        failHeartbeat = false;
        heartbeatFailed.resolve();
        throw new Error("transient heartbeat storage failure");
      }
      return mutate(...args);
    };
    let writes = 0;
    const result = await executeBatch(store, batch.id, executeOptions(async (_dsl, options) => {
      await acknowledgedCreation(options);
      writes++;
      failHeartbeat = true;
      await heartbeatFailed.promise;
      await delay(5);
      return SUCCESS;
    }, { leaseMs: 1000 }));
    assert.equal(writes, 1);
    assert.equal(result.counts.succeeded, 1);
    const after = await store.get("item", item.id);
    assert.deepEqual(after.attempts.at(-1).report, SUCCESS);
    assert.equal(after.status, "succeeded");
    assert.equal(after.activeAttemptId, null);
    assert.ok(after.diagnostics.some((entry) => entry.code === "batch.heartbeat_failed"));
  });

  it("retains observations after failed completion storage and never repeats acknowledged writes", async () => {
    const { store, batch, item } = await prepared();
    const mutate = store.mutate.bind(store);
    let failCompletion = false;
    store.mutate = async (...args) => {
      if (failCompletion) {
        failCompletion = false;
        throw new Error("transient completion storage failure");
      }
      return mutate(...args);
    };
    let writes = 0;
    const execute = async (_dsl, options) => {
      await acknowledgedCreation(options);
      writes++;
      failCompletion = true;
      return SUCCESS;
    };
    await assert.rejects(executeBatch(store, batch.id, executeOptions(execute)), /transient completion storage failure/);
    const observed = await store.get("item", item.id);
    const attempt = observed.attempts.at(-1);
    assert.equal(observed.status, "running");
    assert.equal(observed.activeAttemptId, attempt.id);
    assert.equal(attempt.report, undefined);
    assert.deepEqual(attempt.observations[0].result.report, SUCCESS);
    assert.equal(attempt.steps[0].outcome, "confirmed");
    await executeBatch(store, batch.id, executeOptions(execute));
    assert.equal(writes, 1);
    await store.mutate("item", item.id, (value) => ({ ...value, leaseUntil: "2000-01-01T00:00:00.000Z" }));
    await recoverBatch(store, batch.id);
    assert.equal((await store.get("item", item.id)).status, "needs_repair");
    await executeBatch(store, batch.id, executeOptions(execute));
    assert.equal(writes, 1);
    assert.deepEqual((await store.get("item", item.id)).attempts.at(-1).observations[0].result.report, SUCCESS);
  });

  it("lets a stale worker append observations without reclaiming another worker's ownership", async () => {
    const { store, batch, item } = await prepared();
    const entered = deferred();
    const release = deferred();
    let forbiddenWriteCalls = 0;
    const staleReport = { ok: false, status: "failed", diagnostics: [{ code: "BATCH_LEASE_LOST" }], remoteWriteAttempted: false };
    const running = executeBatch(store, batch.id, executeOptions(async (_dsl, options) => {
      entered.resolve();
      await release.promise;
      await assert.rejects(async () => {
        await options.journal.beforeWrite({ operation: "add" });
        forbiddenWriteCalls++;
      }, { code: "BATCH_LEASE_LOST" });
      return staleReport;
    }, { workerId: "old-worker" }));
    const completion = assert.rejects(running, { code: "BATCH_LEASE_LOST" });
    await entered.promise;
    const old = await store.get("item", item.id);
    await store.mutate("item", item.id, (value) => ({ ...value, leaseUntil: "2000-01-01T00:00:00.000Z" }));
    await recoverBatch(store, batch.id);
    const replacement = await claimItem(store, batch.id, "execute", {
      workerId: "replacement-worker", engineDigest: ENGINE, leaseMs: 60000
    });
    assert.notEqual(replacement.activeAttemptId, old.activeAttemptId);
    release.resolve();
    await completion;
    const after = await store.get("item", item.id);
    assert.equal(forbiddenWriteCalls, 0);
    assert.equal(after.status, "running");
    assert.equal(after.workerId, "replacement-worker");
    assert.equal(after.activeAttemptId, replacement.activeAttemptId);
    const staleAttempt = after.attempts.find((attempt) => attempt.id === old.activeAttemptId);
    assert.equal(staleAttempt.status, "interrupted");
    assert.equal(staleAttempt.report, undefined);
    assert.deepEqual(staleAttempt.observations[0].result.report, staleReport);
    assert.equal(after.attempts.at(-1).observations, undefined);
    assert.deepEqual(after.attempts.at(-1).steps, []);
  });

  for (const changed of ["dsl", "sourceDraft", "snapshot", "targetCategoryId"]) {
    it(`rejects changed ${changed} content after approval even when stored item digests are unchanged`, async () => {
      const { store, batch, item } = await prepared();
      if (changed === "targetCategoryId") await store.mutate("batch", batch.id, (value) => ({ ...value, targetCategoryId: "unapproved-category" }));
      else await store.mutate("item", item.id, (value) => {
        if (changed === "dsl") value.dsl.template.name = "unapproved-template-name";
        if (changed === "sourceDraft") value.sourceDraft.template.name = "unapproved-source-name";
        if (changed === "snapshot") value.snapshot.files[0].content += "\n<!-- changed -->";
        return value;
      });
      let writes = 0;
      await assert.rejects(executeBatch(store, batch.id, executeOptions(async () => { writes++; return SUCCESS; })), { code: "BATCH_APPROVAL_STALE" });
      assert.equal(writes, 0);
      assert.equal((await store.get("item", item.id)).activeAttemptId, null);
    });
  }

  it("recovers an expired slot from another batch without replaying that batch's uncertain write", async () => {
    const { store, batch, item } = await prepared();
    const original = await claimItem(store, batch.id, "execute", { workerId: "abandoned", engineDigest: ENGINE, leaseMs: 60000 });
    await executionJournal(store, item.id, original.activeAttemptId).beforeWrite({ operation: "add" });
    await store.mutate("item", item.id, (value) => ({ ...value, leaseUntil: "2000-01-01T00:00:00.000Z" }));
    const second = await prepared(store, "second-migration");
    const claimed = await claimItem(store, second.batch.id, "execute", { workerId: "new-batch", engineDigest: ENGINE, leaseMs: 60000 });
    assert.equal(claimed.batchId, second.batch.id);
    assert.equal(claimed.status, "running");
    assert.equal(claimed.waiting, undefined);
    const abandoned = await store.get("item", item.id);
    assert.equal(abandoned.status, "outcome_unknown");
    assert.equal(abandoned.activeAttemptId, null);
    assert.equal(abandoned.attempts.at(-1).steps[0].outcome, "pending");
  });
});

async function prepared(store = new MemoryBatchStore(), migrationKey = "worker-evidence") {
  const manifest = JSON.parse(readFileSync(new URL("../fixtures/batch/manifest.json", import.meta.url), "utf8"));
  manifest.items = manifest.items.slice(0, 1);
  manifest.migrationKey = migrationKey;
  const batch = await createBatch(store, manifest, { relativeTo: new URL("../fixtures/batch/", import.meta.url).pathname });
  const report = await prepareBatch(store, batch.id, { ...WORKER,
    review: (source, draft, options) => runAgentReview(source, draft, { ...options, provider: createFakeReviewProvider("accept") })
  });
  assert.equal(report.counts.ready, 1);
  await approveBatch(store, batch.id, { expectedDigest: report.approvalDigest, confirmWrite: true, actor: "test-reviewer" });
  const [item] = await store.list("item", { batchId: batch.id });
  return { store, batch, item };
}
function executeOptions(execute, overrides = {}) { return { ...WORKER, execute, confirmWrite: true, credentials: CREDENTIALS, ...overrides }; }
async function acknowledgedCreation(options) {
  await options.journal.beforeWrite({ operation: "add" });
  await options.journal.afterWrite({ operation: "add", result: { targetTemplateId: SUCCESS.templateId } });
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
