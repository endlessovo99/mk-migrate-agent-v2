import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { MemoryBatchStore } from "../../src/batch/store.js";
import { createRepair, previewRepair, applyRepair } from "../../src/batch/repairs.js";
import { sha256Digest } from "../../src/agent-review/digest.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { executeDsl } from "../../src/executor/execute.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { resolveRouteFixture } from "./fixture.js";
import { withNetworkGuard } from "./network-guard.js";

it("Route-validation retains a prewrite failure, applies a reviewed mapping repair, and verifies the native target", async () => {
  await withNetworkGuard(async () => {
    const sourceDraft = cleanSourceFile(resolveRouteFixture({ kind: "paired", relativePath: "companion-person-source" }));
    const reviewed = await runAgentReview(sourceDraft, draftSourceDraft(sourceDraft), {
      provider: createFakeReviewProvider("accept"), reviewedAt: "2026-09-26T00:00:00.000Z"
    });
    assert.equal(reviewed.ok, true);
    const options = { participantOverrides: [{ sourceId: "legacy-companion-reviewer", targetFdId: "missing-person" }] };
    const executionOptions = {
      credentials: { username: "route-test-user", encryptedPassword: "route-test-encrypted-password" },
      confirmWrite: true, targetCategoryId: "route-category-id"
    };
    const failedClient = new FakeNewoaAdapter("persist", { templateAuthorization: reviewed.dsl.template.authorization });
    const getElementInfo = failedClient.getElementInfo.bind(failedClient);
    failedClient.getElementInfo = async (targets) => targets.includes("missing-person") ? [] : getElementInfo(targets);
    const failed = await executeDsl(reviewed.dsl, { ...executionOptions, ...options, client: failedClient });
    assert.equal(failed.ok, false);
    assert.ok(failed.diagnostics.some((diagnostic) => diagnostic.code === "workflow.participant_resolution_failed"));
    assert.equal(failedClient.transcript().some((entry) => entry.operation === "add"), false);

    const store = new MemoryBatchStore();
    await store.create("batch", "route-batch", { status: "paused", approval: null });
    await store.create("item", "route-item", {
      batchId: "route-batch", identityKey: "route-source", status: "needs_repair", sourceDraft,
      sourceDigest: sha256Digest(sourceDraft), dsl: reviewed.dsl, dslDigest: sha256Digest(reviewed.dsl),
      executionOptions: options, diagnostics: failed.diagnostics,
      attempts: [{ id: "failed-before-write", report: JSON.parse(JSON.stringify(failed)) }],
      activeAttemptId: null, writeStarted: false, targetTemplateId: null, repairHistory: []
    });
    const definition = JSON.parse(readFileSync(new URL("../fixtures/batch/repair-route-participant.json", import.meta.url), "utf8"));
    const repair = await createRepair(store, definition);
    const preview = await previewRepair(store, repair.id, { batchId: "route-batch" });
    assert.equal(preview.summary.applicable, 1);
    const repaired = await applyRepair(store, preview.id, { expectedDigest: preview.digest, confirmApply: true, actor: "route-reviewer" });
    const item = await store.get("item", "route-item");
    assert.equal(item.attempts.length, 1);
    assert.equal(item.attempts[0].report.ok, false);
    assert.equal(repaired.applicationIds.length, 1);
    const client = new FakeNewoaAdapter("persist", { templateAuthorization: reviewed.dsl.template.authorization });
    const executed = await executeDsl(item.dsl, { ...executionOptions, ...item.executionOptions, client });
    assert.equal(executed.ok, true);
    assert.equal(executed.readback.partitions.workflow, "verified");
    assert.equal(client.transcript().filter((entry) => entry.operation === "add").length, 1);
    assert.ok(client.transcript().some((entry) => entry.operation === "add-transfer-record"));
  });
});
