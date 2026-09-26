import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBatchStore } from "../../src/batch/store.js";
import { createScopedRepair, previewScopedRepair, applyScopedRepair } from "../../src/batch/scoped-repairs.js";
import { sha256Digest } from "../../src/agent-review/digest.js";
import { sampleSourceDraft, sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";

const ORIGIN = "https://p-sit.onewo.com";
const CODE = "readback.workflow.template_authorization_mismatch";
const CREDENTIALS = { username: "scoped-test-user", encryptedPassword: "scoped-test-password" };
const EVIDENCE = "e".repeat(64);
const DEFINITION = {
  title: "Repair authorization", rootCause: "Collection shape", reason: "Restore source authorization",
  evidence: ["retained readback report"], version: 1, selector: { diagnosticCodes: [CODE] },
  action: { kind: "locked_draft", repairKind: "template_authorization" }
};

describe("batch scoped target repair", () => {
  it("binds full inputs and native evidence, persists intent before one write, and preserves history", async (t) => {
    const { store, repair } = await setup();
    const root = await privateRoot(t);
    const before = await store.get("item", "item-1");
    const calls = [];
    const handler = async (dsl, options) => {
      calls.push({ dsl, options });
      assert.equal(options.expectedDslDigest, digest(dsl));
      assert.equal(options.expectedPriorReportDigest, digest(before.attempts[0].report));
      assert.equal(options.expectedPriorSourceDraftDigest, digest(before.sourceDraft));
      assert.deepEqual(options.priorExecutionReport, before.attempts[0].report);
      assert.deepEqual(options.sourceDraft, before.sourceDraft);
      assert.equal(options.baseUrl, ORIGIN);
      assert.equal(options.targetTemplateId, "template-1");
      assert.equal(options.targetCategoryId, "category-1");
      assert.equal(options.testLockRoot, undefined);
      if (options.confirmWrite) {
        const during = await store.get("item", "item-1");
        const applications = await store.list("repair_application");
        assert.equal(during.status, "outcome_unknown");
        assert.equal(applications[0].status, "intent");
        assert.equal(options.expectedEvidenceDigest, EVIDENCE);
        await assert.rejects(stat(options.artifactsDir), { code: "ENOENT" });
        return success(options);
      }
      return ready();
    };
    const preview = await previewScopedRepair(store, repair.id, {
      batchId: "batch-1", credentials: CREDENTIALS, repairLockedDraft: handler,
      clientFactory: async () => ({ label: "fake" })
    });
    assert.equal(preview.kind, "scoped");
    assert.equal(preview.summary.applicable, 1);
    assert.equal((await store.list("repair_application")).length, 0);
    const applied = await applyScopedRepair(store, preview.id, applyOptions(root, preview, handler));
    assert.equal(applied.status, "applied");
    assert.equal(calls.length, 2);
    const after = await store.get("item", "item-1");
    assert.equal(after.status, "succeeded");
    assert.equal(after.attempts.length, 2);
    assert.equal(after.attemptCount, before.attemptCount + 1);
    assert.deepEqual(after.attempts[0], before.attempts[0]);
    assert.equal(after.repairHistory.length, 1);
    const application = await store.get("repair_application", after.repairHistory[0]);
    assert.equal(application.result.transferRecord.status, "recorded");
    assert.equal(application.before.version, before.version);
    assert.equal(application.status, "succeeded");
    const serialized = JSON.stringify(await store.list("repair_run")) + JSON.stringify(await store.list("repair_application"));
    assert.equal(serialized.includes(CREDENTIALS.username), false);
    assert.equal(serialized.includes(CREDENTIALS.encryptedPassword), false);
  });

  it("supports record-only reconciliation with the original callback gate", async (t) => {
    const { store, repair } = await setup({ action: { kind: "reconcile_transfer_record" } });
    const root = await privateRoot(t);
    const calls = [];
    const reconcile = async (_dsl, options) => {
      calls.push(options);
      assert.equal(options.repairKind, undefined);
      assert.equal(options.fallbackFdIds, undefined);
      return options.confirmWrite ? success(options, "transfer_record_recorded") : ready("verified_unrecorded");
    };
    const preview = await previewScopedRepair(store, repair.id, {
      batchId: "batch-1", credentials: CREDENTIALS, reconcileTransferRecord: reconcile
    });
    await applyScopedRepair(store, preview.id, {
      ...applyOptions(root, preview), reconcileTransferRecord: reconcile
    });
    assert.equal(calls.filter((options) => options.confirmWrite).length, 1);
    assert.equal((await store.get("item", "item-1")).status, "succeeded");
  });

  it("requires explicit per-item calculation replacement and binds both DSL generations", async (t) => {
    const { store, repair } = await setup({ action: { kind: "locked_draft", repairKind: "calculation" } });
    const root = await privateRoot(t);
    const item = await store.get("item", "item-1");
    const replacement = { ...item.dsl, calculationRepairEvidence: "test" };
    const handler = async (dsl, options) => {
      assert.deepEqual(dsl, replacement);
      assert.deepEqual(options.priorDsl, item.dsl);
      assert.equal(options.expectedPriorDslDigest, digest(item.dsl));
      return options.confirmWrite ? success(options) : ready();
    };
    const without = await previewScopedRepair(store, repair.id, {
      batchId: "batch-1", credentials: CREDENTIALS, repairLockedDraft: handler
    });
    assert.equal(without.items[0].reason, "calculation_replacement_required");
    const preview = await previewScopedRepair(store, repair.id, {
      batchId: "batch-1", credentials: CREDENTIALS, repairLockedDraft: handler,
      replacements: [{ itemId: item.id, expectedDslDigest: item.dslDigest, dsl: replacement }]
    });
    await applyScopedRepair(store, preview.id, applyOptions(root, preview, handler));
    assert.deepEqual((await store.get("item", item.id)).dsl, replacement);
  });

  it("never selects successful, active, unknown, callback-attempted or historical-report-only items", async () => {
    const { store, repair } = await setup();
    const base = await store.get("item", "item-1");
    const variants = [
      { status: "succeeded" }, { status: "running", activeAttemptId: "running" },
      { status: "outcome_unknown" }, { writeOutcomeUnknown: true },
      { attempts: [...base.attempts, { report: { status: "failed" } }] },
      { attempts: [{ ...base.attempts[0], report: { ...base.attempts[0].report, transferRecord: { status: "outcome_unknown" } } }] }
    ];
    for (const [index, change] of variants.entries()) await store.create("item", `skip-${index}`, { ...base, ...change });
    let previews = 0;
    const preview = await previewScopedRepair(store, repair.id, {
      batchId: "batch-1", credentials: CREDENTIALS, repairLockedDraft: async () => { previews++; return ready(); }
    });
    assert.equal(previews, 1);
    assert.equal(preview.summary.skipped, variants.length);
  });

  for (const mutation of ["source", "dsl", "report", "repair", "category", "version"]) {
    it(`rejects stale ${mutation} evidence before claiming or writing`, async (t) => {
      const { store, repair } = await setup();
      const root = await privateRoot(t);
      const preview = await previewScopedRepair(store, repair.id, {
        batchId: "batch-1", credentials: CREDENTIALS, repairLockedDraft: async () => ready()
      });
      if (mutation === "repair") await store.mutate("repair", repair.id, (value) => ({ ...value, definition: { ...value.definition, version: 2 } }));
      else if (mutation === "category") await store.mutate("batch", "batch-1", (value) => ({ ...value, targetCategoryId: "different" }));
      else await store.mutate("item", "item-1", (value) => {
        if (mutation === "source") value.sourceDraft.template.name = "Changed";
        if (mutation === "dsl") value.dsl.template.name = "Changed";
        if (mutation === "report") value.attempts[0].report.diagnostics.push({ code: "changed" });
        return value;
      });
      let writes = 0;
      await assert.rejects(applyScopedRepair(store, preview.id, applyOptions(root, preview, async () => { writes++; })), /stale_preview/);
      assert.equal(writes, 0);
      assert.equal((await store.list("repair_application")).length, 0);
    });
  }

  it("allows only one concurrent application and cannot bypass a target claim with a new preview or directory", async (t) => {
    const { store, repair } = await setup();
    const root = await privateRoot(t);
    let writes = 0;
    const handler = async (_dsl, options) => {
      if (!options.confirmWrite) return ready();
      writes++;
      throw new Error(`lost response ${CREDENTIALS.encryptedPassword}`);
    };
    const preview = await previewScopedRepair(store, repair.id, {
      batchId: "batch-1", credentials: CREDENTIALS, repairLockedDraft: handler
    });
    const results = await Promise.allSettled([
      applyScopedRepair(store, preview.id, applyOptions(root, preview, handler)),
      applyScopedRepair(store, preview.id, applyOptions(root, preview, handler))
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(writes, 1);
    const item = await store.get("item", "item-1");
    assert.equal(item.status, "outcome_unknown");
    assert.equal(JSON.stringify(item).includes(CREDENTIALS.encryptedPassword), false);
    const duplicate = { ...item, status: "needs_repair", scopedRepairClaimId: null, attempts: [item.attempts[0]], repairHistory: [] };
    await store.create("item", "duplicate-target", duplicate);
    const another = await previewScopedRepair(store, repair.id, {
      batchId: "batch-1", itemIds: ["duplicate-target"], credentials: CREDENTIALS, repairLockedDraft: handler
    });
    assert.equal(another.items[0].reason, "target_already_attempted");
    assert.equal(another.summary.applicable, 0);
  });

  it("continues independent targets after a failed native confirmation and records every result", async (t) => {
    const { store, repair } = await setup();
    const root = await privateRoot(t);
    const first = await store.get("item", "item-1");
    const second = structuredClone(first);
    second.targetTemplateId = "template-2";
    second.attempts[0].report.templateId = "template-2";
    second.attempts[0].report.createdFdIds = ["template-2"];
    await store.create("item", "item-2", second);
    const handler = async (_dsl, options) => !options.confirmWrite ? ready() : options.targetTemplateId === "template-1"
      ? { ok: false, status: "blocked", diagnostics: [{ code: "locked_draft.snapshot_changed" }] }
      : success(options);
    const preview = await previewScopedRepair(store, repair.id, {
      batchId: "batch-1", credentials: CREDENTIALS, repairLockedDraft: handler
    });
    const applied = await applyScopedRepair(store, preview.id, applyOptions(root, preview, handler));
    assert.equal(applied.applicationIds.length, 2);
    assert.equal((await store.get("item", "item-1")).status, "outcome_unknown");
    assert.equal((await store.get("item", "item-2")).status, "succeeded");
  });

  it("retains its permanent intent if completion storage fails after a remote success", async (t) => {
    const { store, repair } = await setup();
    const root = await privateRoot(t);
    const transaction = store.transaction.bind(store);
    let writes = 0;
    const handler = async (_dsl, options) => {
      if (!options.confirmWrite) return ready();
      writes++;
      store.transaction = async () => { throw new Error("completion storage unavailable"); };
      return success(options);
    };
    const preview = await previewScopedRepair(store, repair.id, {
      batchId: "batch-1", credentials: CREDENTIALS, repairLockedDraft: handler
    });
    await assert.rejects(applyScopedRepair(store, preview.id, applyOptions(root, preview, handler)), /completion storage unavailable/);
    store.transaction = transaction;
    assert.equal((await store.get("item", "item-1")).status, "outcome_unknown");
    assert.equal((await store.list("repair_application"))[0].status, "intent");
    await assert.rejects(applyScopedRepair(store, preview.id, applyOptions(root, preview, handler)), /already_applied/);
    assert.equal(writes, 1);
  });

  it("requires a paused batch and matching explicit confirmation", async (t) => {
    const { store, repair } = await setup();
    const root = await privateRoot(t);
    const preview = await previewScopedRepair(store, repair.id, {
      batchId: "batch-1", credentials: CREDENTIALS, repairLockedDraft: async () => ready()
    });
    await assert.rejects(applyScopedRepair(store, preview.id, { ...applyOptions(root, preview), confirmWrite: false }), /confirmation_required/);
    await assert.rejects(applyScopedRepair(store, preview.id, { ...applyOptions(root, preview), expectedDigest: "wrong" }), /preview_digest_mismatch/);
    await store.mutate("batch", "batch-1", (value) => ({ ...value, status: "running" }));
    await assert.rejects(applyScopedRepair(store, preview.id, applyOptions(root, preview)), /batch_not_paused/);
    assert.equal((await store.list("repair_application")).length, 0);
  });

  it("passes an existing XML route fixture through the real native gate, which refuses incomplete historical evidence", async () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/route-validation/workflow-data-authority");
    const draft = draftSourceDraft(sourceDraft);
    const dsl = createTrustedMigrationDsl(sourceDraft, draft, {
      externalAgentReviewed: true, reviewerName: "scoped-route-test", checkedAt: "2026-09-26T00:00:00.000Z",
      sourceDraftDigest: sha256Digest(sourceDraft), dslDraftDigest: sha256Digest(draft)
    });
    const { store, repair } = await setup({}, { sourceDraft, dsl });
    let remoteCalls = 0;
    const preview = await previewScopedRepair(store, repair.id, {
      batchId: "batch-1", credentials: CREDENTIALS,
      clientFactory: async () => ({ async login() { remoteCalls++; throw new Error("must not log in"); } })
    });
    assert.equal(preview.summary.applicable, 0);
    assert.equal(preview.items[0].reason, "native_gate_rejected");
    assert.equal(preview.items[0].preview.diagnostics.some((entry) => entry.code === "locked_draft.prior_write_sequence_invalid"), true);
    assert.equal(remoteCalls, 0);
  });
});

async function setup(definition = {}, values = {}) {
  const store = new MemoryBatchStore();
  await store.create("batch", "batch-1", { baseUrl: ORIGIN, targetCategoryId: "category-1", status: "paused", targetId: "origin-1" });
  const sourceDraft = values.sourceDraft || sampleSourceDraft();
  const dsl = values.dsl || sampleTrustedDsl();
  const report = {
    status: "readback_failed", failedAt: "readback", baseUrl: ORIGIN, templateId: "template-1",
    createdFdIds: ["template-1"], updatedFdIds: [], readback: { ok: false },
    plan: buildDryRunPlan(dsl), apiStages: [], diagnostics: [{ code: CODE, level: "error" }]
  };
  const snapshot = { directory: false, files: [{ name: "test_SysFormTemplate.xml", content: "fixture" }] };
  await store.create("item", "item-1", {
    batchId: "batch-1", baseUrl: ORIGIN, status: "needs_repair", sourceDraft, dsl,
    snapshot, templateName: "", sourceDigest: sha256Digest({ snapshot, templateName: "" }), dslDigest: sha256Digest(dsl),
    executionOptions: {}, attempts: [{ id: "attempt-1", sourceDraft, dsl, dslDigest: sha256Digest(dsl), report }],
    writeStarted: true, targetTemplateId: "template-1", repairHistory: [], diagnostics: report.diagnostics, activeAttemptId: null, attemptCount: 1
  });
  const repair = await createScopedRepair(store, { ...DEFINITION, ...definition });
  return { store, repair };
}
function ready(status = "repair_ready") { return { ok: true, status, evidenceDigest: EVIDENCE, snapshotDigest: "f".repeat(64), diagnostics: [] }; }
function success(options, status = "repaired_and_recorded") {
  return { ok: true, status, baseUrl: options.baseUrl, templateId: options.targetTemplateId, evidenceDigest: EVIDENCE,
    readback: { ok: true }, transferRecord: { status: "recorded" }, diagnostics: [] };
}
function applyOptions(root, preview, handler) {
  return { expectedDigest: preview.digest, confirmWrite: true, actor: "test-operator", credentials: CREDENTIALS,
    artifactsRoot: root, ...(handler ? { repairLockedDraft: handler } : {}) };
}
async function privateRoot(t) { const root = await mkdtemp(join(tmpdir(), "mk-scoped-batch-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
function digest(value) { return sha256Digest(value).slice(7); }
