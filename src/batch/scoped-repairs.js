import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256Digest } from "../agent-review/digest.js";
import { repairLockedDraft } from "../executor/locked-draft-repair.js";
import { reconcileTransferRecord } from "../executor/reconcile-transfer-record.js";
import { normalizeBaseUrl } from "../executor/newoa-client.js";
import { withoutMechanismTokens } from "../executor/published-form-patch.js";
import { engineDigest, exactKeys, json, newId, now, text } from "./contracts.js";

export async function createScopedRepair(store, definition) {
  validateDefinition(definition);
  return store.create("repair", newId("repair"), { definition: json(definition), createdAt: now() });
}

/** Read-only target previews; immutable inputs and native evidence are retained per item. */
export async function previewScopedRepair(store, repairId, options = {}) {
  text(options.batchId, "batchId");
  credentialsRequired(options.credentials);
  if (options.itemIds !== undefined) strings(options.itemIds, "itemIds");
  const repair = await document(store, "repair", repairId);
  validateDefinition(repair.definition);
  const batch = await document(store, "batch", options.batchId);
  const candidates = await store.list("item", { batchId: batch.id });
  const selected = options.itemIds ? new Set(options.itemIds) : null;
  assert(!selected || [...selected].every((id) => candidates.some((item) => item.id === id)), "item_outside_batch");
  const replacements = replacementMap(options.replacements, repair.definition.action, candidates);
  const items = [];
  const targets = new Set();
  for (const item of candidates.filter((entry) => !selected || selected.has(entry.id))) {
    const planned = planItem(item, batch, repair.definition, replacements.get(item.id));
    if (planned.applicable) {
      const claimId = targetClaimId(planned.input);
      if (targets.has(claimId)) Object.assign(planned, { applicable: false, reason: "duplicate_target" });
      else if (await store.get("repair_application", claimId)) {
        Object.assign(planned, { applicable: false, reason: "target_already_attempted" });
      } else {
        targets.add(claimId);
        planned.preview = await invoke(planned.input, repair.definition.action, options, false);
        const status = repair.definition.action.kind === "locked_draft" ? "repair_ready" : "verified_unrecorded";
        planned.applicable = planned.preview.ok === true && planned.preview.status === status &&
          /^[a-f0-9]{64}$/.test(planned.preview.evidenceDigest || "") &&
          /^[a-f0-9]{64}$/.test(planned.preview.snapshotDigest || planned.preview.targetSnapshotDigest || "");
        planned.reason = planned.applicable ? "applicable" : "native_gate_rejected";
      }
    }
    items.push(planned);
  }
  const plan = {
    kind: "scoped", repairId, batchId: batch.id, repairVersion: repair.version,
    repairDigest: sha256Digest(repair.definition), definition: json(repair.definition), engineDigest: engineDigest(),
    target: batchTarget(batch), items,
    summary: { selected: items.length, applicable: items.filter((item) => item.applicable).length,
      skipped: items.filter((item) => !item.applicable).length }
  };
  return store.create("repair_run", newId("repair-run"), {
    ...plan, digest: sha256Digest(plan), status: "preview", applicationIds: [], createdAt: now()
  });
}

/** A target claim is permanent, independent of the requested artifacts directory. */
export async function applyScopedRepair(store, previewId, options = {}) {
  assert(options.confirmWrite === true, "confirmation_required");
  text(options.expectedDigest, "expectedDigest");
  text(options.actor, "actor");
  credentialsRequired(options.credentials);
  const artifactsRoot = resolve(text(options.artifactsRoot, "artifactsRoot"));
  await mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
  const rootStat = await stat(artifactsRoot);
  assert(rootStat.isDirectory() && (rootStat.mode & 0o077) === 0, "artifacts_root_not_private");
  const preview = await document(store, "repair_run", previewId);
  const currentEngineDigest = engineDigest();
  const run = await store.transaction(async (tx) => {
    const batch = await document(tx, "batch", preview.batchId);
    const current = await document(tx, "repair_run", previewId);
    assert(batch.status === "paused", "batch_not_paused");
    assert(current.kind === "scoped" && current.status === "preview", "already_applied");
    assert(current.digest === options.expectedDigest && sha256Digest(runPlan(current)) === current.digest, "preview_digest_mismatch");
    assert(current.engineDigest === currentEngineDigest, "engine_changed");
    assert(sha256Digest(batchTarget(batch)) === sha256Digest(current.target), "stale_preview");
    await validateRepairVersion(tx, current);
    for (const planned of current.items.filter((item) => item.applicable)) {
      const item = await document(tx, "item", planned.itemId);
      assertBinding(item, planned, batch, current.definition);
    }
    return tx.mutate("repair_run", current.id, (value) => ({
      ...value, status: "applying", actor: options.actor, startedAt: now()
    }));
  });

  for (const planned of run.items.filter((item) => item.applicable)) {
    const claimId = targetClaimId(planned.input);
    const artifactsDir = join(artifactsRoot, newId("target-repair"));
    const claimed = await store.transaction(async (tx) => {
      const batch = await document(tx, "batch", run.batchId);
      const currentRun = await document(tx, "repair_run", run.id);
      assert(batch.status === "paused" && currentRun.status === "applying", "batch_not_paused");
      assert(sha256Digest(batchTarget(batch)) === sha256Digest(run.target), "stale_preview");
      await validateRepairVersion(tx, run);
      const item = await document(tx, "item", planned.itemId);
      assertBinding(item, planned, batch, run.definition);
      const application = await tx.create("repair_application", claimId, {
        kind: "scoped", repairId: run.repairId, runId: run.id, repairRunId: run.id,
        batchId: run.batchId, itemId: item.id, actor: options.actor, status: "intent",
        repairVersion: run.definition.version, action: run.definition.action,
        rootCause: run.definition.rootCause, reason: run.definition.reason, evidence: run.definition.evidence,
        input: planned.input, before: item, evidenceDigest: planned.preview.evidenceDigest,
        artifactsDir, startedAt: now(), result: null
      });
      await tx.mutate("item", item.id, (value) => ({
        ...value, status: "outcome_unknown", writeStarted: true, scopedRepairClaimId: claimId,
        repairHistory: [...(value.repairHistory || []), claimId]
      }));
      await tx.mutate("batch", batch.id, (value) => ({ ...value, approval: null }));
      await tx.mutate("repair_run", run.id, (value) => ({ ...value, applicationIds: [...value.applicationIds, claimId] }));
      return application;
    });

    const result = await invoke(planned.input, run.definition.action, options, true, {
      expectedEvidenceDigest: planned.preview.evidenceDigest, artifactsDir
    });
    await store.transaction(async (tx) => {
      await document(tx, "batch", run.batchId);
      await document(tx, "repair_run", run.id);
      const item = await document(tx, "item", planned.itemId);
      assert(item.scopedRepairClaimId === claimId && item.status === "outcome_unknown", "claim_changed");
      const succeeded = result.ok === true && result.transferRecord?.status === "recorded" &&
        result.readback?.ok === true && result.templateId === planned.input.targetTemplateId &&
        result.baseUrl === planned.input.baseUrl &&
        result.status === (run.definition.action.kind === "locked_draft" ? "repaired_and_recorded" : "transfer_record_recorded") &&
        result.evidenceDigest === planned.preview.evidenceDigest && !outcomeUnknown(result);
      const completedAt = now();
      const after = {
        ...item, status: succeeded ? "succeeded" : "outcome_unknown",
        dsl: succeeded ? planned.input.dsl : item.dsl,
        dslDigest: succeeded ? sha256Digest(planned.input.dsl) : item.dslDigest,
        attemptCount: (item.attemptCount || 0) + 1,
        diagnostics: result.diagnostics || [],
        attempts: [...(item.attempts || []), {
          id: newId("repair-attempt"), kind: "scoped_repair", repairApplicationId: claimId,
          sourceDraft: planned.input.sourceDraft, sourceDigest: item.sourceDigest,
          dsl: planned.input.dsl, dslDigest: sha256Digest(planned.input.dsl),
          writeStarted: true, targetTemplateId: item.targetTemplateId, report: result, completedAt
        }]
      };
      await tx.mutate("item", item.id, () => after);
      await tx.mutate("repair_application", claimed.id, (value) => ({
        ...value, status: succeeded ? "succeeded" : "outcome_unknown", result,
        after: { status: after.status, dslDigest: after.dslDigest, attemptId: after.attempts.at(-1).id }, completedAt
      }));
    });
  }
  return store.transaction(async (tx) => {
    await document(tx, "batch", run.batchId);
    return tx.mutate("repair_run", run.id, (value) => ({ ...value, status: "applied", completedAt: now() }));
  });
}

function planItem(item, batch, definition, replacement) {
  const result = { itemId: item.id, applicable: false, reason: null, binding: sha256Digest(item), input: null, preview: null };
  const skip = (reason) => ({ ...result, reason });
  if (item.status !== "needs_repair" || item.activeAttemptId || item.scopedRepairClaimId) return skip("item_not_eligible");
  const attempt = item.attempts?.at(-1);
  const report = attempt?.report;
  if (item.attempts?.some((entry) => outcomeUnknown(entry.report)) || outcomeUnknown(item)) return skip("write_outcome_unknown");
  if (report?.status !== "readback_failed" || !item.targetTemplateId || report.templateId !== item.targetTemplateId ||
      report.transferRecord || report.apiStages?.some((stage) => stage.name === "addTransferRecord")) return skip("retained_readback_required");
  const codes = new Set([...(item.diagnostics || []), ...(report.diagnostics || [])].map((entry) => entry.code));
  if (!definition.selector.diagnosticCodes.some((code) => codes.has(code))) return skip("diagnostic_not_matched");
  try {
    if (normalizeBaseUrl(item.baseUrl) !== normalizeBaseUrl(batch.baseUrl) || normalizeBaseUrl(report.baseUrl) !== normalizeBaseUrl(batch.baseUrl)) return skip("target_mismatch");
  } catch { return skip("target_mismatch"); }
  if (!item.snapshot || sha256Digest({ snapshot: item.snapshot, templateName: item.templateName || "" }) !== item.sourceDigest ||
      !item.sourceDraft || !attempt.sourceDraft || sha256Digest(item.sourceDraft) !== sha256Digest(attempt.sourceDraft)) return skip("source_digest_mismatch");
  if (!item.dsl || !attempt.dsl || sha256Digest(item.dsl) !== item.dslDigest ||
      sha256Digest(attempt.dsl) !== item.dslDigest || (attempt.dslDigest && attempt.dslDigest !== item.dslDigest)) return skip("dsl_digest_mismatch");
  const calculation = definition.action.kind === "locked_draft" && definition.action.repairKind === "calculation";
  if (calculation && (!replacement || replacement.expectedDslDigest !== item.dslDigest)) return skip("calculation_replacement_required");
  const input = {
    baseUrl: normalizeBaseUrl(batch.baseUrl), targetCategoryId: batch.targetCategoryId,
    targetTemplateId: item.targetTemplateId, sourceDraft: json(item.sourceDraft),
    priorSourceDraft: json(attempt.sourceDraft), priorDsl: json(attempt.dsl),
    dsl: json(calculation ? replacement.dsl : item.dsl), priorExecutionReport: json(report),
    ...(definition.action.kind === "locked_draft" && item.executionOptions?.fallbackFdIds
      ? { fallbackFdIds: json(item.executionOptions.fallbackFdIds) } : {})
  };
  return { ...result, applicable: true, reason: "applicable", input };
}

function assertBinding(item, planned, batch, definition) {
  const replacement = { expectedDslDigest: item.dslDigest, dsl: planned.input.dsl };
  const current = planItem(item, batch, definition, replacement);
  assert(item.batchId === batch.id && current.applicable && current.binding === planned.binding &&
    sha256Digest(current.input) === sha256Digest(planned.input), "stale_preview");
}

async function invoke(input, action, options, confirmWrite, confirmation = {}) {
  try {
    const client = options.clientFactory ? await options.clientFactory({
      baseUrl: input.baseUrl, targetTemplateId: input.targetTemplateId
    }) : undefined;
    const fn = action.kind === "locked_draft"
      ? options.repairLockedDraft || repairLockedDraft
      : options.reconcileTransferRecord || reconcileTransferRecord;
    const result = await fn(json(input.dsl), {
      baseUrl: input.baseUrl, targetTemplateId: input.targetTemplateId, targetCategoryId: input.targetCategoryId,
      sourceDraft: json(input.sourceDraft), priorSourceDraft: json(input.priorSourceDraft),
      priorExecutionReport: json(input.priorExecutionReport), credentials: options.credentials,
      expectedDslDigest: rawDigest(input.dsl), expectedPriorReportDigest: rawDigest(input.priorExecutionReport),
      expectedPriorSourceDraftDigest: rawDigest(input.priorSourceDraft), confirmWrite, ...confirmation,
      ...(client ? { client } : {}),
      ...(action.kind === "locked_draft" ? {
        repairKind: action.repairKind, priorDsl: json(input.priorDsl), expectedPriorDslDigest: rawDigest(input.priorDsl),
        ...(input.fallbackFdIds ? { fallbackFdIds: input.fallbackFdIds } : {})
      } : {})
    });
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Missing native repair report.");
    return sanitize(result, options.credentials);
  } catch {
    return { ok: false, status: confirmWrite ? "outcome_unknown" : "failed", writeOutcomeUnknown: confirmWrite,
      diagnostics: [{ level: "error", code: "batch.scoped_repair.executor_failed", message: "Scoped execution failed; no automatic retry is permitted." }] };
  }
}

function validateDefinition(definition) {
  exactKeys(definition, ["title", "rootCause", "reason", "evidence", "version", "selector", "action"], "repair");
  for (const field of ["title", "rootCause", "reason"]) text(definition[field], field);
  assert((typeof definition.version === "string" && definition.version.trim()) ||
    (Number.isInteger(definition.version) && definition.version > 0), "version_required");
  assert(Array.isArray(definition.evidence) && definition.evidence.length > 0 && definition.evidence.every((entry) =>
    (typeof entry === "string" && entry.trim()) || (entry && typeof entry === "object" && Object.keys(entry).length > 0)), "evidence_required");
  exactKeys(definition.selector, ["diagnosticCodes"], "selector");
  strings(definition.selector.diagnosticCodes, "diagnosticCodes");
  const action = definition.action;
  if (action?.kind === "locked_draft") {
    exactKeys(action, ["kind", "repairKind"], "action");
    assert(["template_authorization", "calculation"].includes(action.repairKind), "unsupported_action");
  } else {
    exactKeys(action, ["kind"], "action");
    assert(action.kind === "reconcile_transfer_record", "unsupported_action");
  }
}

function replacementMap(replacements = [], action, candidates) {
  assert(Array.isArray(replacements), "invalid_replacements");
  assert(!replacements.length || (action.kind === "locked_draft" && action.repairKind === "calculation"), "unsupported_replacements");
  const map = new Map();
  for (const entry of replacements) {
    exactKeys(entry, ["itemId", "expectedDslDigest", "dsl"], "replacement");
    text(entry.itemId, "replacement.itemId");
    assert(!map.has(entry.itemId) && candidates.some((item) => item.id === entry.itemId), "invalid_replacements");
    assert(/^sha256:[a-f0-9]{64}$/.test(entry.expectedDslDigest) && entry.dsl && typeof entry.dsl === "object" && !Array.isArray(entry.dsl), "invalid_replacements");
    map.set(entry.itemId, json(entry));
  }
  return map;
}

async function validateRepairVersion(store, run) {
  const repair = await document(store, "repair", run.repairId);
  assert(repair.version === run.repairVersion && sha256Digest(repair.definition) === run.repairDigest, "stale_preview");
}

function runPlan(run) {
  const { kind, repairId, batchId, repairVersion, repairDigest, definition, engineDigest, target, items, summary } = run;
  return { kind, repairId, batchId, repairVersion, repairDigest, definition, engineDigest, target, items, summary };
}
function batchTarget(batch) { return { baseUrl: batch.baseUrl, targetCategoryId: batch.targetCategoryId, targetId: batch.targetId || null }; }
function targetClaimId(input) { return `scoped-target-${rawDigest({ baseUrl: input.baseUrl, targetTemplateId: input.targetTemplateId })}`; }
function rawDigest(value) { return sha256Digest(value).slice("sha256:".length); }
function outcomeUnknown(value) {
  return value?.writeOutcomeUnknown === true || value?.templateWriteOutcomeUnknown === true ||
    value?.transferRecord?.writeOutcomeUnknown === true || value?.status === "outcome_unknown" ||
    value?.apiStages?.some((stage) => stage.writeOutcomeUnknown === true);
}
function sanitize(value, credentials) {
  const secrets = [credentials.username, credentials.encryptedPassword].filter(Boolean).sort((a, b) => b.length - a.length);
  const visit = (entry) => typeof entry === "string" ? secrets.reduce((result, secret) => result.split(secret).join("[REDACTED]"), entry)
    : Array.isArray(entry) ? entry.map(visit)
      : entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry).filter(([, child]) => child !== undefined).map(([key, child]) => [key, visit(child)])) : entry;
  return visit(withoutMechanismTokens(value));
}
function credentialsRequired(credentials) { text(credentials?.username, "credentials.username"); text(credentials?.encryptedPassword, "credentials.encryptedPassword"); }
function strings(values, name) { assert(Array.isArray(values) && values.length > 0 && new Set(values).size === values.length && values.every((value) => typeof value === "string" && value.trim()), `${name}_required`); }
function assert(condition, code) { if (!condition) throw Object.assign(new Error(`Scoped repair rejected: ${code}.`), { code: `batch.scoped_repair.${code}` }); }
async function document(store, kind, id) { const value = await store.get(kind, id); assert(value, "not_found"); return value; }
