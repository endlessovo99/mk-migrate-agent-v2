import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { MemoryBatchStore } from "../../src/batch/store.js";
import { createBatch, cleanSnapshot } from "../../src/batch/intake.js";
import { createRepair, previewRepair, applyRepair } from "../../src/batch/repairs.js";
import { approveBatch, executeBatch, inspectBatch, prepareBatch } from "../../src/batch/service.js";
import { claimItem, executionJournal, recoverBatch, retryItem, setBatchStatus, updateClaim } from "../../src/batch/scheduler.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { checkTrust } from "../../src/dsl/trust.js";
import { createFakeReviewProvider } from "../route-validation/fake-review-provider.js";

const manifestPath = fileURLToPath(new URL("../fixtures/batch/manifest.json", import.meta.url));
const relativeTo = dirname(manifestPath);
const engine = "test-engine-v1";
const credentials = { username: "offline-user", encryptedPassword: "offline-password" };
const manifest = () => JSON.parse(readFileSync(manifestPath, "utf8"));
const workerOptions = { engineDigest: engine, concurrency: 2, leaseMs: 60000,
  checkpointSigningKey: "offline-batch-checkpoint-signing-key-32-characters" };
const review = (source, draft, options) => runAgentReview(source, draft, {
  ...options, provider: createFakeReviewProvider("accept"), reviewedAt: "2026-09-26T00:00:00.000Z"
});
const executionOptions = (execute) => ({ ...workerOptions, confirmWrite: true, credentials, execute });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function setup(input = manifest()) {
  const store = new MemoryBatchStore();
  const batch = await createBatch(store, input, { relativeTo });
  return { store, batch };
}

async function prepareAndApprove(store, batchId) {
  const report = await prepareBatch(store, batchId, { ...workerOptions, review });
  assert.equal(report.counts.ready, report.items.length, JSON.stringify(report.items));
  await approveBatch(store, batchId, { expectedDigest: report.approvalDigest, confirmWrite: true, actor: "offline-reviewer" });
  return report;
}

async function successfulExecution(dsl, options) {
  const templateId = `target-${dsl.derivedFrom.sourceId}`;
  await options.journal.beforeWrite({ operation: "add", templateName: dsl.template.name });
  await options.journal.afterWrite({ operation: "add", result: { targetTemplateId: templateId } });
  return { ok: true, templateId, diagnostics: [], remoteWriteAttempted: true, writeOutcomeUnknown: false };
}

describe("batch intake, preparation, and execution service", () => {
  it("freezes paired source bytes, creates stable drafts, and rejects duplicates across batches", async (t) => {
    const temporary = mkdtempSync(join(tmpdir(), "mk-batch-intake-test-"));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const source = join(temporary, "source");
    cpSync(join(relativeTo, "../route-validation/paired"), source, { recursive: true });
    const input = manifest();
    input.items = [{ sourcePath: source }];
    const { store, batch } = await setup(input);
    const original = (await store.list("item", { batchId: batch.id }))[0];
    assert.deepEqual(cleanSnapshot(original.snapshot, original.templateName), original.sourceDraft);
    assert.deepEqual(cleanSnapshot(original.snapshot, original.templateName), cleanSnapshot(original.snapshot, original.templateName));
    await assert.rejects(createBatch(store, { ...input, name: "Duplicate import" }, { relativeTo }), { code: "BATCH_CONFLICT" });
    assert.equal((await store.list("batch")).length, 1);
    assert.equal((await store.list("item")).length, 1);
    for (const name of readdirSync(source)) writeFileSync(join(source, name), "original intake files were replaced after import");
    const prepared = await prepareBatch(store, batch.id, { ...workerOptions, review });
    assert.equal(prepared.counts.ready, 1);
    const item = (await store.list("item", { batchId: batch.id }))[0];
    assert.deepEqual(item.snapshot, original.snapshot);
    assert.equal(item.sourceDigest, original.sourceDigest);
    assert.deepEqual(item.sourceDraft, original.sourceDraft);
    assert.equal(checkTrust(item.sourceDraft, item.dsl).ok, true);
  });

  it("enforces trust even when a review provider claims the replacement source is accepted", async () => {
    const input = manifest();
    input.items = [input.items[0]];
    const { store, batch } = await setup(input);
    const result = await prepareBatch(store, batch.id, { ...workerOptions, review: async (...args) => {
      const accepted = await review(...args);
      accepted.dsl.derivedFrom.sourceId = "unrelated-source";
      return accepted;
    } });
    assert.equal(result.counts.blocked, 1);
    const [item] = await store.list("item", { batchId: batch.id });
    assert.equal(item.dsl, null);
    assert.ok(item.diagnostics.some((entry) => entry.code === "trust.derived_from_mismatch"));
    assert.equal(item.attempts.length, 1);
    assert.equal(item.attempts[0].report.trust.ok, false);
  });

  it("requires approval and rejects stale proposals and changed mappings before any write", async () => {
    const { store, batch } = await setup();
    let writes = 0;
    const execute = async (...args) => { writes += 1; return successfulExecution(...args); };
    await assert.rejects(executeBatch(store, batch.id, executionOptions(execute)), { code: "BATCH_APPROVAL_REQUIRED" });
    const report = await prepareBatch(store, batch.id, { ...workerOptions, review });
    await assert.rejects(approveBatch(store, batch.id, { expectedDigest: report.approvalDigest, actor: "operator", confirmWrite: false }), { code: "BATCH_APPROVAL_REQUIRED" });
    await assert.rejects(approveBatch(store, batch.id, { expectedDigest: "outdated", actor: "operator", confirmWrite: true }), { code: "BATCH_APPROVAL_STALE" });
    await approveBatch(store, batch.id, { expectedDigest: report.approvalDigest, actor: "operator", confirmWrite: true });
    const [item] = await store.list("item", { batchId: batch.id });
    await store.mutate("item", item.id, (current) => ({ ...current, executionOptions: { allowMissingDirectPersonFallback: true } }));
    await assert.rejects(executeBatch(store, batch.id, executionOptions(execute)), { code: "BATCH_APPROVAL_STALE" });
    assert.equal(writes, 0);
    assert.notEqual((await inspectBatch(store, batch.id)).approvalDigest, report.approvalDigest);
  });

  it("records an engine upgrade block and completes the public reprepare repair and reapproval workflow", async () => {
    const input = manifest();
    input.items = [input.items[1]];
    const { store, batch } = await setup(input);
    await prepareAndApprove(store, batch.id);
    const [before] = await store.list("item", { batchId: batch.id });
    assert.deepEqual(before.diagnostics, []);
    let writes = 0;
    const execute = async (...args) => { writes += 1; return successfulExecution(...args); };
    const upgradedEngine = "test-engine-v2";
    const blocked = await executeBatch(store, batch.id, { ...executionOptions(execute), engineDigest: upgradedEngine });
    assert.equal(writes, 0);
    assert.equal(blocked.counts.blocked, 1);
    const stale = await store.get("item", before.id);
    assert.ok(stale.diagnostics.some((entry) => entry.code === "BATCH_ENGINE_CHANGED"));
    assert.deepEqual(stale.attempts, before.attempts);
    await setBatchStatus(store, batch.id, "paused");
    await assert.rejects(retryItem(store, batch.id, stale.id), { code: "BATCH_RETRY_FORBIDDEN" });
    const repair = await createRepair(store, {
      title: "重新准备受引擎升级影响的迁移", rootCause: "已准备任务绑定了旧引擎", reason: "用新版重新生成、审查及批准",
      evidence: ["test-engine-v2 reviewed release"], version: "1",
      selector: { diagnosticCodes: ["BATCH_ENGINE_CHANGED"] }, action: { kind: "reprepare" }
    });
    const preview = await previewRepair(store, repair.id, { batchId: batch.id });
    assert.equal(preview.summary.applicable, 1);
    const applied = await applyRepair(store, preview.id, {
      expectedDigest: preview.digest, confirmApply: true, actor: "upgrade-reviewer"
    });
    const application = await store.get("repair_application", applied.applicationIds[0]);
    assert.deepEqual(application.before.dsl, before.dsl);
    assert.ok(application.before.diagnostics.some((entry) => entry.code === "BATCH_ENGINE_CHANGED"));
    assert.equal((await store.get("batch", batch.id)).approval, null);
    const prepared = await prepareBatch(store, batch.id, { ...workerOptions, engineDigest: upgradedEngine, review });
    assert.equal(prepared.counts.ready, 1);
    assert.equal((await store.get("item", before.id)).engineDigest, upgradedEngine);
    await approveBatch(store, batch.id, { expectedDigest: prepared.approvalDigest, confirmWrite: true, actor: "upgrade-reviewer" });
    const finished = await executeBatch(store, batch.id, { ...executionOptions(execute), engineDigest: upgradedEngine });
    assert.equal(finished.counts.succeeded, 1);
    assert.equal(writes, 1);
    const after = await store.get("item", before.id);
    assert.deepEqual(after.attempts.map((attempt) => attempt.phase), ["prepare", "prepare", "execute"]);
    assert.deepEqual(after.attempts[0], before.attempts[0]);
    assert.deepEqual(after.repairHistory, [application.id]);
  });

  it("refuses actual artifact changes and target category drift even when stored digest fields were not updated", async () => {
    for (const changed of ["dsl", "sourceDraft", "snapshot", "targetCategoryId"]) {
      const input = manifest();
      input.items = [input.items[1]];
      const { store, batch } = await setup(input);
      await prepareAndApprove(store, batch.id);
      const [before] = await store.list("item", { batchId: batch.id });
      if (changed === "targetCategoryId") {
        await store.mutate("batch", batch.id, (current) => ({ ...current, targetCategoryId: "unapproved-category" }));
      } else {
        await store.mutate("item", before.id, (current) => {
          if (changed === "dsl") current.dsl.template.name = "Unapproved renamed template";
          if (changed === "sourceDraft") current.sourceDraft.template.name = "Unapproved source label";
          if (changed === "snapshot") current.snapshot.files[0].content += "\n<!-- source changed -->";
          return current;
        });
      }
      let writes = 0;
      await assert.rejects(executeBatch(store, batch.id, executionOptions(async (...args) => {
        writes += 1;
        return successfulExecution(...args);
      })), { code: "BATCH_APPROVAL_STALE" }, changed);
      assert.equal(writes, 0, changed);
      assert.deepEqual((await store.get("item", before.id)).attempts, before.attempts, changed);
    }
  });

  it("pauses new work while finishing in-flight work and resumes without redoing completed items", async () => {
    const { store, batch } = await setup();
    const entered = deferred();
    const release = deferred();
    let reviews = 0;
    const preparing = prepareBatch(store, batch.id, { ...workerOptions, concurrency: 1, review: async (...args) => {
      reviews += 1;
      if (reviews === 1) { entered.resolve(); await release.promise; }
      return review(...args);
    } });
    await entered.promise;
    await setBatchStatus(store, batch.id, "paused");
    release.resolve();
    const paused = await preparing;
    assert.equal(paused.counts.ready, 1);
    assert.equal(paused.counts.pending, 1);
    assert.equal(paused.batch.status, "paused");
    await prepareAndApprove(store, batch.id);
    const started = deferred();
    const complete = deferred();
    const calls = [];
    const execute = async (dsl, options) => {
      calls.push(dsl.derivedFrom.sourceId);
      if (calls.length === 1) { started.resolve(); await complete.promise; }
      return successfulExecution(dsl, options);
    };
    const executing = executeBatch(store, batch.id, { ...executionOptions(execute), concurrency: 1 });
    await started.promise;
    await setBatchStatus(store, batch.id, "paused");
    complete.resolve();
    const partial = await executing;
    assert.equal(partial.counts.succeeded, 1);
    assert.equal(partial.counts.ready, 1);
    const finished = await executeBatch(store, batch.id, executionOptions(execute));
    assert.equal(finished.counts.succeeded, 2);
    await executeBatch(store, batch.id, executionOptions(execute));
    assert.equal(calls.length, 2);
    assert.equal(new Set(calls).size, 2);
    for (const item of await store.list("item", { batchId: batch.id })) {
      assert.deepEqual(item.attempts.map((attempt) => attempt.phase), ["prepare", "execute"]);
      assert.equal(item.attempts[1].steps[0].outcome, "confirmed");
    }
  });

  it("allows one origin write at a time across workers and batches and drains both batches", async () => {
    const { store, batch } = await setup();
    const secondInput = manifest();
    secondInput.migrationKey = "independent-second-migration";
    const second = await createBatch(store, secondInput, { relativeTo });
    await prepareAndApprove(store, batch.id);
    await prepareAndApprove(store, second.id);
    let active = 0;
    let maximum = 0;
    const calls = [];
    const execute = async (dsl, options) => {
      active += 1;
      maximum = Math.max(maximum, active);
      calls.push(dsl.derivedFrom.sourceId);
      try {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return await successfulExecution(dsl, options);
      } finally { active -= 1; }
    };
    await Promise.all([
      executeBatch(store, batch.id, { ...executionOptions(execute), workerId: "first-worker" }),
      executeBatch(store, batch.id, { ...executionOptions(execute), workerId: "second-worker" }),
      executeBatch(store, second.id, { ...executionOptions(execute), workerId: "third-worker" })
    ]);
    assert.equal(maximum, 1);
    assert.equal(calls.length, 4);
    assert.equal((await inspectBatch(store, batch.id)).counts.succeeded, 2);
    assert.equal((await inspectBatch(store, second.id)).counts.succeeded, 2);
    for (const item of await store.list("item")) assert.equal(item.attempts.filter((attempt) => attempt.phase === "execute").length, 1);
  });

  it("releases another batch's expired origin slot while quarantining any unacknowledged write", async () => {
    for (const abandonedPhase of ["prewrite", "write_pending"]) {
      const input = manifest();
      input.items = [input.items[1]];
      const { store, batch } = await setup(input);
      const second = await createBatch(store, { ...input, migrationKey: "second-migration" }, { relativeTo });
      await prepareAndApprove(store, batch.id);
      await prepareAndApprove(store, second.id);
      const abandoned = await claimItem(store, batch.id, "execute", {
        workerId: "lost-worker", leaseMs: 60000, engineDigest: engine
      });
      if (abandonedPhase === "write_pending") {
        await executionJournal(store, abandoned.id, abandoned.activeAttemptId).beforeWrite({ operation: "add" });
      }
      await store.mutate("item", abandoned.id, (item) => ({ ...item, leaseUntil: "2000-01-01T00:00:00.000Z" }));
      let calls = 0;
      const stopIfStalled = setTimeout(() => { void setBatchStatus(store, second.id, "paused"); }, 1000);
      let finished;
      try {
        finished = await executeBatch(store, second.id, executionOptions(async (...args) => {
          calls += 1;
          return successfulExecution(...args);
        }));
      } finally { clearTimeout(stopIfStalled); }
      assert.equal(finished.counts.succeeded, 1, abandonedPhase);
      assert.equal(calls, 1);
      const recovered = await store.get("item", abandoned.id);
      assert.equal(recovered.status, abandonedPhase === "prewrite" ? "ready" : "outcome_unknown");
      assert.equal(recovered.activeAttemptId, null);
      assert.equal(recovered.attempts.at(-1).status, "interrupted");
      assert.equal(recovered.attempts.length, abandoned.attempts.length);
      if (abandonedPhase === "write_pending") {
        assert.equal(recovered.attempts.at(-1).steps[0].outcome, "pending");
        await setBatchStatus(store, batch.id, "paused");
        await assert.rejects(retryItem(store, batch.id, abandoned.id), { code: "BATCH_RETRY_FORBIDDEN" });
      }
    }
  });

  it("isolates prewrite failures, permits an explicit retry, and preserves every attempt", async () => {
    const { store, batch } = await setup();
    await prepareAndApprove(store, batch.id);
    let failedSource;
    const called = new Map();
    const execute = async (dsl, options) => {
      const sourceId = dsl.derivedFrom.sourceId;
      called.set(sourceId, (called.get(sourceId) || 0) + 1);
      if (!failedSource) {
        failedSource = sourceId;
        throw new Error("sensitive-credential-that-must-not-be-recorded");
      }
      return successfulExecution(dsl, options);
    };
    const first = await executeBatch(store, batch.id, executionOptions(execute));
    assert.equal(first.counts.blocked, 1);
    assert.equal(first.counts.succeeded, 1);
    const blocked = (await store.list("item", { batchId: batch.id, status: "blocked" }))[0];
    assert.equal(JSON.stringify(blocked).includes("sensitive-credential"), false);
    assert.equal(blocked.writeStarted, false);
    await setBatchStatus(store, batch.id, "paused");
    await retryItem(store, batch.id, blocked.id);
    const final = await executeBatch(store, batch.id, executionOptions(execute));
    assert.equal(final.counts.succeeded, 2);
    const after = await store.get("item", blocked.id);
    assert.deepEqual(after.attempts.map((attempt) => attempt.status), ["ready", "blocked", "succeeded"]);
    assert.equal(called.get(failedSource), 2);
    assert.equal([...called.values()].filter((count) => count === 1).length, 1);
    await setBatchStatus(store, batch.id, "paused");
    await assert.rejects(retryItem(store, batch.id, blocked.id), { code: "BATCH_RETRY_FORBIDDEN" });
  });

  it("recovers expired preparation and prewrite execution leases but isolates unacknowledged writes", async () => {
    const { store, batch } = await setup();
    await setBatchStatus(store, batch.id, "running");
    const context = { workerId: "abandoned-worker", leaseMs: 60000, engineDigest: engine };
    const preparing = await claimItem(store, batch.id, "prepare", context);
    await store.mutate("item", preparing.id, (item) => ({ ...item, leaseUntil: "2000-01-01T00:00:00.000Z" }));
    assert.deepEqual((await recoverBatch(store, batch.id)).recovered, [{ itemId: preparing.id, status: "pending" }]);
    await assert.rejects(updateClaim(store, preparing.id, preparing.activeAttemptId, (item) => item), { code: "BATCH_LEASE_LOST" });
    await prepareAndApprove(store, batch.id);
    const prewrite = await claimItem(store, batch.id, "execute", context);
    await store.mutate("item", prewrite.id, (item) => ({ ...item, leaseUntil: "2000-01-01T00:00:00.000Z" }));
    assert.deepEqual((await recoverBatch(store, batch.id)).recovered, [{ itemId: prewrite.id, status: "ready" }]);
    const unknown = await claimItem(store, batch.id, "execute", context);
    assert.equal(unknown.id, prewrite.id);
    await executionJournal(store, unknown.id, unknown.activeAttemptId).beforeWrite({ operation: "add" });
    await store.mutate("item", unknown.id, (item) => ({ ...item, leaseUntil: "2000-01-01T00:00:00.000Z" }));
    assert.deepEqual((await recoverBatch(store, batch.id)).recovered, [{ itemId: unknown.id, status: "outcome_unknown" }]);
    const confirmed = await claimItem(store, batch.id, "execute", context);
    const journal = executionJournal(store, confirmed.id, confirmed.activeAttemptId);
    await journal.beforeWrite({ operation: "add" });
    await journal.afterWrite({ operation: "add", result: { targetTemplateId: "retained-draft" } });
    await store.mutate("item", confirmed.id, (item) => ({ ...item, leaseUntil: "2000-01-01T00:00:00.000Z" }));
    assert.deepEqual((await recoverBatch(store, batch.id)).recovered, [{ itemId: confirmed.id, status: "needs_repair" }]);
    await setBatchStatus(store, batch.id, "paused");
    for (const itemId of [unknown.id, confirmed.id]) {
      await assert.rejects(retryItem(store, batch.id, itemId), { code: "BATCH_RETRY_FORBIDDEN" });
    }
    const unknownAfter = await store.get("item", unknown.id);
    assert.equal(unknownAfter.attempts.at(-1).steps[0].outcome, "pending");
    assert.equal(unknownAfter.attempts.filter((attempt) => attempt.status === "interrupted").length >= 2, true);
    assert.equal((await store.get("item", confirmed.id)).targetTemplateId, "retained-draft");
  });
});
