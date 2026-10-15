import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { executionOptions, itemBinding } from "../../src/batch/contracts.js";
import { applicableRepairOptions, validateRepairOptions } from "../../src/batch/repair-options.js";
import { createRepair, previewRepair, applyRepair } from "../../src/batch/repairs.js";
import { MemoryBatchStore } from "../../src/batch/store.js";
import { sha256Digest } from "../../src/agent-review/digest.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
const policy = JSON.parse(readFileSync("tests/fixtures/route-validation/workflow-sign/sign-policy.json"));
const sourceDraft = cleanSourceFile("tests/fixtures/route-validation/workflow-sign");
const dsl = createTrustedMigrationDsl(sourceDraft, draftSourceDraft(sourceDraft), { externalAgentReviewed: true });

it("validates explicit sign options and binds every policy and operation digest to approval", () => {
  assert.deepEqual(executionOptions(policy), policy); assert.doesNotThrow(() => validateRepairOptions(policy));
  const item = { id: "fixture-item", sourceDigest: "s", dslDigest: "d", sourceDraftDigest: "sd", engineDigest: "e", executionOptions: policy };
  const before = sha256Digest(itemBinding(item));
  for (const mutate of [
    options => delete options.workflowSignDocumentPolicy,
    options => options.workflowOperationSetOverrides[0].targetOperationRefId = "other",
    options => options.workflowOperationSetOverrides[0].expectedSemanticDigest = `sha256:${"0".repeat(64)}`
  ]) {
    const candidate = structuredClone(item); mutate(candidate.executionOptions);
    assert.notEqual(sha256Digest(itemBinding(candidate)), before);
  }
  for (const bad of [false, null, "ignore-permissions", {}]) {
    assert.throws(() => executionOptions({ ...policy, workflowSignDocumentPolicy: bad }));
    assert.throws(() => validateRepairOptions({ ...policy, workflowSignDocumentPolicy: bad }));
  }
});

it("selects only exact evidenced sign references and keeps unrelated review nodes out", () => {
  const before = JSON.stringify(dsl);
  const selected = applicableRepairOptions(dsl, { allowTemplateAuthorizationFallback: true }, policy);
  assert.deepEqual(selected.options, { allowTemplateAuthorizationFallback: true, ...policy });
  assert.equal(selected.diagnostics.length, 0); assert.equal(JSON.stringify(dsl), before);
  const mismatched = structuredClone(policy); mismatched.workflowOperationSetOverrides[0].sourceOperationRefId = "unmatched";
  assert.equal(applicableRepairOptions(dsl, {}, { workflowOperationSetOverrides: mismatched.workflowOperationSetOverrides }).matchingMappings, 0);
  const ordinary = structuredClone(dsl); for (const node of ordinary.workflow.nodes) { node.type = "review"; node.sourceType = "reviewNode"; if (node.definition) node.definition.sourceType = "reviewNode"; }
  assert.equal(applicableRepairOptions(ordinary, {}, { workflowSignDocumentPolicy: "form-only-audit" }).matchingMappings, 0);
  const conflict = structuredClone(dsl); conflict.workflow.nodes.find(node => node.type === "sign").attributes.canModifyMainDoc = "false";
  assert.ok(applicableRepairOptions(conflict, {}, policy).diagnostics.some(row => row.code === "batch.repair.sign_source_ambiguous"));
});

it("uses formal repair history, invalidates approval, and preserves unknown-write isolation", async () => {
  const store = new MemoryBatchStore();
  await store.create("batch", "batch-sign", { status: "paused", approval: { digest: "prior-approval" } });
  await store.create("item", "item-sign", { batchId: "batch-sign", sourceId: "fixture-sign-source", status: "ready", sourceDraft, dsl,
    sourceDigest: sha256Digest(sourceDraft), sourceDraftDigest: sha256Digest(sourceDraft), dslDigest: sha256Digest(dsl),
    executionOptions: {}, diagnostics: [{ code: "workflow.participants.empty" }], attempts: [{ id: "retained-attempt" }],
    activeAttemptId: null, writeStarted: false, targetTemplateId: null, repairHistory: [] });
  const before = await store.get("item", "item-sign");
  const repair = await createRepair(store, { title: "Explicit sign policy", rootCause: "Source sign operation reference requires explicit target mapping",
    reason: "Caller authorized form-only audit and exact target operation set", evidence: ["Offline sign route fixture"], version: "1",
    selector: { diagnosticCodes: ["workflow.participants.empty"] }, action: { kind: "execution_options", options: policy } });
  const preview = await previewRepair(store, repair.id, { batchId: "batch-sign" });
  assert.equal(preview.summary.applicable, 1, JSON.stringify(preview.items));
  await applyRepair(store, preview.id, { expectedDigest: preview.digest, confirmApply: true, actor: "fixture-operator" });
  const after = await store.get("item", "item-sign");
  assert.deepEqual(after.executionOptions, policy); assert.deepEqual(after.sourceDraft, before.sourceDraft);
  assert.deepEqual(after.dsl, before.dsl); assert.deepEqual(after.attempts, before.attempts);
  assert.equal((await store.get("batch", "batch-sign")).approval, null);
  assert.ok(after.repairHistory.length > 0);
  await store.mutate("item", "item-sign", item => ({ ...item, status: "outcome_unknown", writeStarted: true, targetTemplateId: "existing-target" }));
  assert.equal((await previewRepair(store, repair.id, { batchId: "batch-sign" })).summary.applicable, 0);
});
