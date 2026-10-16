import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MemoryBatchStore } from "../../src/batch/store.js";
import { createBatch } from "../../src/batch/intake.js";
import { engineDigest } from "../../src/batch/contracts.js";
import { createRepair, previewRepair, applyRepair } from "../../src/batch/repairs.js";
import { approveBatch, executeBatch, prepareBatch } from "../../src/batch/service.js";
import { setBatchStatus } from "../../src/batch/scheduler.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { executeDsl } from "../../src/executor/execute.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { resolveRouteFixture } from "./fixture.js";
import { withNetworkGuard } from "./network-guard.js";

const definition = () => JSON.parse(readFileSync(new URL("../fixtures/batch/repair-engine-reprepare.json", import.meta.url), "utf8"));
const review = (source, draft) => runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") });

test("a stale ready item with no diagnostics can be rebuilt before approval or any target call", async () => {
  await withNetworkGuard(async () => {
    const store = new MemoryBatchStore();
    const batch = await createBatch(store, {
      version: 1, name: "Engine rebuild route", migrationKey: "engine-rebuild-route",
      baseUrl: "https://p-sit.onewo.com", targetCategoryId: "route-category-id", executionConcurrency: 1,
      items: [{ sourcePath: resolveRouteFixture({ kind: "form-only", relativePath: "leading-inline-caption/shared-leading_SysFormTemplate.xml" }) }]
    });
    await prepareBatch(store, batch.id, { review, engineDigest: "retained-old-engine", concurrency: 1 });
    await setBatchStatus(store, batch.id, "paused");
    const [before] = await store.list("item", { batchId: batch.id });
    assert.equal(before.status, "ready");
    assert.deepEqual(before.diagnostics, []);
    const repair = await createRepair(store, definition());
    const preview = await previewRepair(store, repair.id, { batchId: batch.id });
    assert.equal(preview.summary.applicable, 1);
    assert.deepEqual(await store.get("item", before.id), before);
    const applied = await applyRepair(store, preview.id, { expectedDigest: preview.digest, confirmApply: true, actor: "route-reviewer" });
    const after = await store.get("item", before.id);
    assert.equal(after.status, "pending");
    assert.equal(after.dsl, null);
    assert.deepEqual(after.snapshot, before.snapshot);
    assert.deepEqual(after.attempts, before.attempts);
    assert.deepEqual(before.diagnostics, []);
    const application = await store.get("repair_application", applied.applicationIds[0]);
    assert.deepEqual(application.before, before);
    assert.equal(application.before.engineDigest, "retained-old-engine");
    assert.equal((await store.get("batch", batch.id)).approval, null);

    const prepared = await prepareBatch(store, batch.id, { review, concurrency: 1 });
    assert.equal(prepared.counts.ready, 1);
    assert.equal((await store.get("item", before.id)).engineDigest, engineDigest());
    await approveBatch(store, batch.id, { expectedDigest: prepared.approvalDigest, confirmWrite: true, actor: "route-reviewer" });
    let client;
    const result = await executeBatch(store, batch.id, {
      confirmWrite: true, concurrency: 1, credentials: { username: "route-user", encryptedPassword: "route-password" },
      execute: (dsl, options) => {
        client = new FakeNewoaAdapter("persist", { templateAuthorization: dsl.template.authorization });
        return executeDsl(dsl, { ...options, client });
      }
    });
    assert.equal(result.counts.succeeded, 1);
    assert.equal(client.transcript().filter(entry => entry.operation === "add").length, 1);
    assert.equal(client.transcript().filter(entry => entry.operation === "add-transfer-record").length, 1);
    const final = await store.get("item", before.id);
    assert.deepEqual(final.attempts[0], before.attempts[0]);
    assert.deepEqual(final.attempts.map(entry => entry.phase), ["prepare", "prepare", "execute"]);
  });
});

for (const [name, overrides, reason] of [
  ["same engine", { engineDigest: engineDigest() }, "diagnostic_not_matched"],
  ["missing engine", { engineDigest: null }, "diagnostic_not_matched"],
  ["unknown outcome", { status: "outcome_unknown" }, "write_outcome_unknown"],
  ["active item", { status: "preparing", activeAttemptId: "active" }, "item_active"],
  ["completed item", { status: "succeeded" }, "already_succeeded"],
  ["write intent", { writeStarted: true }, "needs_scoped_target_repair"],
  ["existing target", { targetTemplateId: "retained-target" }, "needs_scoped_target_repair"],
  ["prior attempt write", { attempts: [{ writeStarted: true }] }, "needs_scoped_target_repair"],
  ["prior attempt target", { attempts: [{ targetTemplateId: "retained-target" }] }, "needs_scoped_target_repair"]
]) {
  test(`engine reprepare preserves the ${name} boundary`, async () => {
    const store = new MemoryBatchStore();
    await store.create("batch", "batch", { status: "paused", approval: null });
    await store.create("item", "item", { batchId: "batch", status: "ready", engineDigest: "old-engine", diagnostics: [], attempts: [], ...overrides });
    const repair = await createRepair(store, definition());
    const preview = await previewRepair(store, repair.id, { batchId: "batch" });
    assert.equal(preview.summary.applicable, 0);
    assert.equal(preview.items[0].reason, reason);
  });
}

test("the derived engine mismatch does not authorize execution option repairs", async () => {
  const store = new MemoryBatchStore();
  await store.create("batch", "batch", { status: "paused", approval: null });
  await store.create("item", "item", { batchId: "batch", status: "ready", engineDigest: "old-engine", diagnostics: [], attempts: [] });
  const input = definition();
  input.action = { kind: "execution_options", options: { workflowCooperationDefault: "3" } };
  const repair = await createRepair(store, input);
  const preview = await previewRepair(store, repair.id, { batchId: "batch" });
  assert.equal(preview.items[0].reason, "diagnostic_not_matched");
});
