import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { executionOptions } from "../../src/batch/contracts.js";
import { applicableRepairOptions, validateRepairOptions } from "../../src/batch/repair-options.js";
import { createRepair, previewRepair, applyRepair } from "../../src/batch/repairs.js";
import { MemoryBatchStore } from "../../src/batch/store.js";
import { sha256Digest } from "../../src/agent-review/digest.js";
import { sampleTrustedDsl, sampleSourceDraft } from "../helpers/sample-dsl.js";

const definition = JSON.parse(readFileSync(new URL("../fixtures/batch/repair-workflow-cooperation.json", import.meta.url), "utf8"));
function artifacts(value = "0") {
  const dsl = sampleTrustedDsl();
  const sourceDraft = sampleSourceDraft();
  const node = { id: "R", name: "Review", type: "review", element: "manualTask", sourceType: "reviewNode",
    sourceRef: "source.workflow.node.R", attributes: { processType: value }, definition: { attributes: { processType: value } }, translationStatus: "executable" };
  dsl.workflow.nodes.splice(1, 0, node);
  dsl.workflow.edges[0].target = "R";
  dsl.workflow.edges.push({ ...dsl.workflow.edges[0], id: "L2", source: "R", target: "N2", sourceRef: "source.workflow.edge.L2" });
  dsl.workflow.topologicalOrder = ["N1", "R", "N2"];
  sourceDraft.workflow.nodes.splice(1, 0, { id: "R", sourceType: "reviewNode", sourceRef: node.sourceRef, attributes: { processType: value } });
  sourceDraft.workflow.edges.push({ id: "L2", sourceRef: "source.workflow.edge.L2" });
  return { dsl, sourceDraft };
}

describe("explicit workflow cooperation batch options", () => {
  it("accepts only explicit native enum strings without introducing a default", () => {
    assert.deepEqual(executionOptions({}), {});
    for (const value of ["1", "2", "3"]) {
      assert.deepEqual(executionOptions({ workflowCooperationDefault: value }), { workflowCooperationDefault: value });
      assert.doesNotThrow(() => validateRepairOptions({ workflowCooperationDefault: value }));
    }
    for (const value of ["0", "4", "", " 2", 2, null, true, [], {}]) {
      assert.throws(() => executionOptions({ workflowCooperationDefault: value }));
      assert.throws(() => validateRepairOptions({ workflowCooperationDefault: value }));
    }
  });

  it("selects only evidenced zero nodes and rejects conflicting source attributes", () => {
    const before = artifacts();
    const immutable = JSON.stringify(before);
    const selected = applicableRepairOptions(before.dsl, { allowTemplateAuthorizationFallback: true }, { workflowCooperationDefault: "3" });
    assert.equal(selected.matchingMappings, 1);
    assert.deepEqual(selected.options, { allowTemplateAuthorizationFallback: true, workflowCooperationDefault: "3" });
    assert.equal(JSON.stringify(before), immutable);
    for (const value of ["1", "2", "3", undefined, "unknown"]) {
      const candidate = artifacts(value).dsl;
      if (value === undefined) {
        delete candidate.workflow.nodes[1].attributes.processType;
        delete candidate.workflow.nodes[1].definition.attributes.processType;
      }
      assert.equal(applicableRepairOptions(candidate, {}, { workflowCooperationDefault: "2" }).matchingMappings, 0);
    }
    const conflicted = artifacts(); conflicted.dsl.workflow.nodes[1].definition.attributes.processType = "1";
    const conflict = applicableRepairOptions(conflicted.dsl, {}, { workflowCooperationDefault: "2" });
    assert.ok(conflict.diagnostics.some(d => d.code === "batch.repair.cooperation_source_ambiguous"));
    assert.equal(conflict.matchingMappings, 0);
  });

  it("uses the existing repair transaction, invalidates approval and retains immutable input and attempts", async () => {
    const store = new MemoryBatchStore();
    const { dsl, sourceDraft } = artifacts();
    await store.create("batch", "batch-1", { status: "paused", approval: { digest: "old" } });
    await store.create("item", "item-1", { batchId: "batch-1", sourceId: "sample-source", status: "ready", sourceDraft, dsl,
      sourceDigest: sha256Digest(sourceDraft), dslDigest: sha256Digest(dsl), executionOptions: {},
      diagnostics: [{ code: "workflow.participants.empty" }], attempts: [{ id: "old", status: "ready" }],
      activeAttemptId: null, writeStarted: false, targetTemplateId: null, repairHistory: [] });
    const before = await store.get("item", "item-1");
    const repair = await createRepair(store, definition);
    const preview = await previewRepair(store, repair.id, { batchId: "batch-1" });
    assert.equal(preview.summary.applicable, 1, JSON.stringify(preview.items[0].validation));
    assert.equal(preview.items[0].validation.targetValidation, "deferred_to_executor");
    const applied = await applyRepair(store, preview.id, { expectedDigest: preview.digest, confirmApply: true, actor: "fixture-operator" });
    const after = await store.get("item", "item-1");
    assert.deepEqual(after.executionOptions, { workflowCooperationDefault: "2" });
    assert.deepEqual(after.dsl, before.dsl);
    assert.deepEqual(after.sourceDraft, before.sourceDraft);
    assert.deepEqual(after.attempts, before.attempts);
    assert.equal((await store.get("batch", "batch-1")).approval, null);
    assert.equal(applied.applicationIds.length, 1);
    await assert.rejects(applyRepair(store, preview.id, { expectedDigest: preview.digest, confirmApply: true, actor: "fixture-operator" }), /already been applied/);
    await store.mutate("item", "item-1", item => ({ ...item, status: "outcome_unknown", writeStarted: true, targetTemplateId: "known-target" }));
    const fenced = await previewRepair(store, repair.id, { batchId: "batch-1" });
    assert.equal(fenced.summary.applicable, 0);
  });
});
