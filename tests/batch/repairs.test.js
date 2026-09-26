import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { MemoryBatchStore } from "../../src/batch/store.js";
import { createRepair, previewRepair, applyRepair } from "../../src/batch/repairs.js";
import { sha256Digest } from "../../src/agent-review/digest.js";
import { sampleSourceDraft, sampleTrustedDsl } from "../helpers/sample-dsl.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/batch/repair-${name}.json`, import.meta.url), "utf8"));
const approval = (preview) => ({ expectedDigest: preview.digest, confirmApply: true, actor: "fixture-operator" });

async function setup(items = [{}]) {
  const store = new MemoryBatchStore();
  await store.create("batch", "batch-1", { status: "paused", approval: { digest: "previous-approval" } });
  for (const [index, overrides] of items.entries()) {
    const dsl = sampleTrustedDsl();
    const sourceDraft = sampleSourceDraft();
    await store.create("item", `item-${index + 1}`, {
      batchId: "batch-1", identityKey: `source-${index}`, status: "blocked", sourceDraft,
      sourceDigest: sha256Digest(sourceDraft), dsl, dslDraft: null, dslDigest: sha256Digest(dsl),
      executionOptions: {}, diagnostics: [{ code: "script.unsupported" }],
      attempts: [{ id: "prior-attempt", status: "prewrite_failed", report: { diagnostic: "retained" } }],
      activeAttemptId: null, writeStarted: false, targetTemplateId: null, repairHistory: [],
      ...overrides
    });
  }
  return store;
}

describe("batch repair records and application", () => {
  it("previews concrete differences and retains prior artifacts and attempts when re-preparing", async () => {
    const store = await setup();
    const before = await store.get("item", "item-1");
    const repair = await createRepair(store, fixture("reprepare"));
    const preview = await previewRepair(store, repair.id, { batchId: "batch-1" });
    assert.equal(preview.summary.applicable, 1);
    assert.ok(preview.items[0].diff.some((entry) => entry.path === "/dsl" && entry.after === null));
    assert.deepEqual(await store.get("item", "item-1"), before);
    const applied = await applyRepair(store, preview.id, approval(preview));
    const after = await store.get("item", "item-1");
    const application = await store.get("repair_application", applied.applicationIds[0]);
    assert.equal(after.status, "pending");
    assert.equal(after.dsl, null);
    assert.equal(after.dslDigest, null);
    assert.deepEqual(after.sourceDraft, before.sourceDraft);
    assert.deepEqual(after.attempts, before.attempts);
    assert.deepEqual(application.before, before);
    assert.deepEqual(application.after, after);
    assert.equal(application.afterDigest, sha256Digest(after));
    assert.equal(application.actor, "fixture-operator");
    assert.deepEqual(application.evidence, fixture("reprepare").evidence);
    assert.equal(after.repairHistory[0], application.id);
    assert.equal((await store.get("batch", "batch-1")).approval, null);
  });

  it("explains unrelated diagnostics, active work, successful work, and all target write boundaries", async () => {
    const store = await setup([
      { diagnostics: [{ code: "another.failure" }] }, { status: "running", activeAttemptId: "in-flight" },
      { status: "succeeded" }, { status: "outcome_unknown" }, { writeStarted: true },
      { targetTemplateId: "existing-template" }, { attempts: [{ writeStarted: true }] }
    ]);
    const repair = await createRepair(store, fixture("reprepare"));
    const preview = await previewRepair(store, repair.id, { batchId: "batch-1" });
    assert.equal(preview.summary.applicable, 0);
    assert.deepEqual(preview.items.map((item) => item.reason), [
      "diagnostic_not_matched", "item_active", "already_succeeded", "write_outcome_unknown",
      "needs_scoped_target_repair", "needs_scoped_target_repair", "needs_scoped_target_repair"
    ]);
  });

  it("requires explicit approval, its exact digest, a paused batch, and a named actor", async () => {
    const store = await setup();
    const repair = await createRepair(store, fixture("reprepare"));
    const preview = await previewRepair(store, repair.id, { batchId: "batch-1" });
    await assert.rejects(applyRepair(store, preview.id, { ...approval(preview), confirmApply: false }), { code: "batch.repair.confirmation_required" });
    await assert.rejects(applyRepair(store, preview.id, { ...approval(preview), expectedDigest: "wrong" }), { code: "batch.repair.preview_digest_mismatch" });
    await assert.rejects(applyRepair(store, preview.id, { ...approval(preview), actor: "" }), /actor/);
    await store.mutate("batch", "batch-1", (batch) => ({ ...batch, status: "running" }));
    await assert.rejects(applyRepair(store, preview.id, approval(preview)), { code: "batch.repair.batch_not_paused" });
    assert.equal((await store.list("repair_application")).length, 0);
  });

  it("atomically refuses every application when any eligible item drifted", async () => {
    const store = await setup([{}, {}]);
    const repair = await createRepair(store, fixture("reprepare"));
    const preview = await previewRepair(store, repair.id, { batchId: "batch-1" });
    const first = await store.get("item", "item-1");
    await store.mutate("item", "item-2", (item) => ({ ...item, sourceDigest: sha256Digest("changed XML") }));
    await assert.rejects(applyRepair(store, preview.id, approval(preview)), { code: "batch.repair.stale_preview" });
    assert.deepEqual(await store.get("item", "item-1"), first);
    assert.equal((await store.get("repair_run", preview.id)).status, "preview");
    assert.equal((await store.list("repair_application")).length, 0);
  });

  it("refuses a changed repair definition and tampered persisted preview", async () => {
    const store = await setup();
    const repair = await createRepair(store, fixture("reprepare"));
    const preview = await previewRepair(store, repair.id, { batchId: "batch-1" });
    await store.mutate("repair", repair.id, (current) => ({ ...current, definition: { ...current.definition, reason: "new reason" } }));
    await assert.rejects(applyRepair(store, preview.id, approval(preview)), { code: "batch.repair.stale_preview" });
    const next = await previewRepair(store, repair.id, { batchId: "batch-1" });
    await store.mutate("repair_run", next.id, (current) => ({ ...current, summary: { ...current.summary, applicable: 999 } }));
    await assert.rejects(applyRepair(store, next.id, approval(next)), { code: "batch.repair.preview_digest_mismatch" });
  });

  it("allows only one concurrent application and preserves previous repair history", async () => {
    const store = await setup([{ repairHistory: ["older-application"] }]);
    const repair = await createRepair(store, fixture("reprepare"));
    const preview = await previewRepair(store, repair.id, { batchId: "batch-1" });
    const results = await Promise.allSettled([
      applyRepair(store, preview.id, approval(preview)), applyRepair(store, preview.id, approval(preview))
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.code, "batch.repair.already_applied");
    assert.equal((await store.list("repair_application")).length, 1);
    assert.equal((await store.get("item", "item-1")).repairHistory[0], "older-application");
    await assert.rejects(applyRepair(store, preview.id, approval(preview)), { code: "batch.repair.already_applied" });
  });

  it("isolates batch selection and source selectors", async () => {
    const store = await setup();
    const definition = fixture("reprepare");
    definition.selector.sourceIds = ["different-source"];
    const repair = await createRepair(store, definition);
    await assert.rejects(previewRepair(store, repair.id, { batchId: "batch-1", itemIds: ["outside-item"] }), { code: "batch.repair.item_outside_batch" });
    const preview = await previewRepair(store, repair.id, { batchId: "batch-1" });
    assert.equal(preview.items[0].reason, "source_not_matched");
  });

  it("validates replacement trust and source binding and applies only the exact prior DSL", async () => {
    const store = await setup([{}, {}]);
    const definition = fixture("reprepare");
    const current = await store.get("item", "item-1");
    const valid = sampleTrustedDsl();
    valid.review.warnings.push("Repair review evidence retained");
    const forged = sampleTrustedDsl({ derivedFrom: { sourceId: "another-source" } });
    definition.action = { kind: "replace_dsl", replacements: [
      { itemId: "item-1", expectedDslDigest: current.dslDigest, dsl: valid },
      { itemId: "item-2", expectedDslDigest: current.dslDigest, dsl: forged }
    ] };
    const repair = await createRepair(store, definition);
    const preview = await previewRepair(store, repair.id, { batchId: "batch-1" });
    assert.equal(preview.items[0].applicable, true);
    assert.equal(preview.items[1].reason, "validation_failed");
    assert.ok(preview.items[1].validation.diagnostics.some((entry) => entry.code === "trust.derived_from_mismatch"));
    await applyRepair(store, preview.id, approval(preview));
    assert.equal((await store.get("item", "item-1")).dslDigest, sha256Digest(valid));
    assert.equal((await store.get("item", "item-2")).status, "blocked");
  });

  it("merges only source-evidenced participant mappings and retains unrelated options", async () => {
    const dsl = sampleTrustedDsl();
    dsl.workflow.nodes[0].participants = { mode: "explicit", members: [
      { name: "审批人", type: "user_or_org", sourceId: "legacy-person", sourceOrgType: 8, sourceLoginName: "reviewer" }
    ] };
    const store = await setup([{ dsl, dslDigest: sha256Digest(dsl),
      diagnostics: [{ code: "workflow.participant_resolution_failed" }],
      executionOptions: { allowMissingDirectPersonFallback: false,
        participantOverrides: [{ sourceId: "legacy-person", targetFdId: "old-target" }] }
    }]);
    const repair = await createRepair(store, fixture("participant"));
    const preview = await previewRepair(store, repair.id, { batchId: "batch-1" });
    assert.equal(preview.items[0].applicable, true, JSON.stringify(preview.items[0].validation));
    assert.equal(preview.items[0].validation.targetValidation, "deferred_to_executor");
    await applyRepair(store, preview.id, approval(preview));
    assert.deepEqual((await store.get("item", "item-1")).executionOptions, {
      allowMissingDirectPersonFallback: false, participantOverrides: [{ sourceId: "legacy-person", targetFdId: "target-person" }]
    });
  });

  it("rejects unknown execution controls and ambiguous source identities", async () => {
    const store = await setup();
    for (const options of [
      { confirmWrite: true }, { participantOverrides: [{ sourceId: "id", targetFdId: "target", unsafe: true }] },
      { participantOverrides: [{ sourceId: "id", targetFdId: "target" }, { sourceId: "id", targetFdId: "second" }] }
    ]) {
      const definition = fixture("participant");
      definition.action.options = options;
      await assert.rejects(createRepair(store, definition));
    }
    const dsl = sampleTrustedDsl();
    dsl.workflow.nodes[0].participants = { mode: "explicit", members: [
      { name: "甲", type: "user_or_org", sourceId: "legacy-person", sourceOrgType: 8, sourceLoginName: "a" },
      { name: "乙", type: "user_or_org", sourceId: "legacy-person", sourceOrgType: 8, sourceLoginName: "b" }
    ] };
    await store.mutate("item", "item-1", (item) => ({ ...item, dsl, dslDigest: sha256Digest(dsl), diagnostics: [{ code: "workflow.participant_resolution_failed" }] }));
    const repair = await createRepair(store, fixture("participant"));
    const preview = await previewRepair(store, repair.id, { batchId: "batch-1" });
    assert.equal(preview.items[0].reason, "mapping_identity_ambiguous");
  });

  it("keeps authorization mappings separate and requires typed direct identities", async () => {
    const dsl = sampleTrustedDsl();
    const sourceDraft = sampleSourceDraft();
    const authorization = { readerFlag: true, editors: [], allReaders: [], allEditors: [], temporaryReaders: [], temporaryEditors: [],
      readers: [{ name: "授权人", type: "user_or_org", sourceId: "legacy-person", sourceOrgType: 8 }] };
    dsl.template.authorization = authorization;
    sourceDraft.template.authorization = structuredClone(authorization);
    dsl.workflow.nodes[0].participants = { mode: "explicit", members: [
      { id: "old-direct-person", name: "直接审批人", type: "user_or_org", targetOrgType: 8 }
    ] };
    const store = await setup([{ dsl, sourceDraft, dslDigest: sha256Digest(dsl),
      diagnostics: [{ code: "workflow.participant_resolution_failed" }] }]);
    const definition = fixture("participant");
    definition.action.options = {
      participantOverrides: [{ sourceId: "legacy-person", targetFdId: "wrong-scope" }],
      templateAuthorizationOverrides: [{ sourceId: "legacy-person", targetFdId: "target-reader" }],
      directParticipantOverrides: [{ sourceTargetId: "old-direct-person", targetFdId: "target-reviewer" }]
    };
    const repair = await createRepair(store, definition);
    const preview = await previewRepair(store, repair.id, { batchId: "batch-1" });
    assert.equal(preview.items[0].applicable, true, JSON.stringify(preview.items[0].validation));
    assert.deepEqual(preview.items[0].after.executionOptions, {
      templateAuthorizationOverrides: [{ sourceId: "legacy-person", targetFdId: "target-reader" }],
      directParticipantOverrides: [{ sourceTargetId: "old-direct-person", targetFdId: "target-reviewer" }]
    });
    delete dsl.workflow.nodes[0].participants.members[0].targetOrgType;
    await store.mutate("item", "item-1", (item) => ({ ...item, dsl, dslDigest: sha256Digest(dsl) }));
    const untyped = await previewRepair(store, repair.id, { batchId: "batch-1" });
    assert.equal(untyped.items[0].applicable, false);
    assert.ok(["validation_failed", "mapping_identity_ambiguous"].includes(untyped.items[0].reason));
  });

  it("rejects replacement digests even when the new DSL is otherwise valid", async () => {
    const store = await setup();
    const definition = fixture("reprepare");
    definition.action = { kind: "replace_dsl", replacements: [{
      itemId: "item-1", expectedDslDigest: sha256Digest("different prior DSL"), dsl: sampleTrustedDsl()
    }] };
    const repair = await createRepair(store, definition);
    const preview = await previewRepair(store, repair.id, { batchId: "batch-1" });
    assert.equal(preview.items[0].reason, "replacement_digest_mismatch");
    assert.equal((await store.get("item", "item-1")).status, "blocked");
  });
});
