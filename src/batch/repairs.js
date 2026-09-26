import { randomUUID } from "node:crypto";
import { sha256Digest } from "../agent-review/digest.js";
import { checkTrust } from "../dsl/trust.js";
import { checkExecute } from "../dsl/checks.js";
import { applicableRepairOptions, exactKeys, validateRepairOptions } from "./repair-options.js";
import { engineDigest } from "./contracts.js";

export async function createRepair(store, definition) {
  validateDefinition(definition);
  return store.create("repair", randomUUID(), {
    definition: copy(definition), createdAt: new Date().toISOString()
  });
}

export async function previewRepair(store, repairId, { batchId, itemIds } = {}) {
  requireText(batchId, "batchId");
  if (itemIds !== undefined) requireStrings(itemIds, "itemIds");
  const currentEngineDigest = engineDigest();
  return store.transaction(async (tx) => {
    await tx.mutate("batch", batchId, () => null);
    await requireDocument(tx, "batch", batchId);
    const repair = await requireDocument(tx, "repair", repairId);
    validateDefinition(repair.definition);
    const candidates = await tx.list("item", { batchId });
    const selected = itemIds ? new Set(itemIds) : null;
    if (selected && [...selected].some((id) => !candidates.some((item) => item.id === id))) {
      throw repairError("item_outside_batch", "Every selected item must belong to the selected batch.");
    }
    const items = candidates.filter((item) => !selected || selected.has(item.id))
      .sort((a, b) => a.id.localeCompare(b.id)).map((item) => planItem(repair.definition, item, currentEngineDigest));
    const plan = {
      repairId, batchId, repairVersion: repair.version, repairDigest: sha256Digest(repair.definition),
      definition: copy(repair.definition), engineDigest: currentEngineDigest, items,
      summary: { selected: items.length, applicable: items.filter((item) => item.applicable).length,
        skipped: items.filter((item) => !item.applicable).length }
    };
    return tx.create("repair_run", randomUUID(), {
      ...plan, digest: sha256Digest(plan), status: "preview", createdAt: new Date().toISOString(), applicationIds: []
    });
  });
}

export async function applyRepair(store, previewId, { expectedDigest, confirmApply, actor } = {}) {
  if (confirmApply !== true) throw repairError("confirmation_required", "Local repair application requires confirmApply: true.");
  requireText(actor, "actor");
  requireText(expectedDigest, "expectedDigest");
  const preview = await requireDocument(store, "repair_run", previewId);
  const currentEngineDigest = engineDigest();
  return store.transaction(async (tx) => {
    await tx.mutate("batch", preview.batchId, () => null);
    const batch = await requireDocument(tx, "batch", preview.batchId);
    if (batch.status !== "paused") throw repairError("batch_not_paused", "Pause the batch before applying repairs.");
    await tx.mutate("repair_run", previewId, () => null);
    const run = await requireDocument(tx, "repair_run", previewId);
    if (run.status !== "preview") throw repairError("already_applied", "This repair preview has already been applied.");
    if (run.digest !== expectedDigest || sha256Digest(runPlan(run)) !== run.digest) {
      throw repairError("preview_digest_mismatch", "Repair confirmation does not match the retained preview.");
    }
    if (run.engineDigest !== currentEngineDigest) throw repairError("engine_changed", "Code or catalogs changed after preview; preview again.");
    const repair = await requireDocument(tx, "repair", run.repairId);
    if (repair.version !== run.repairVersion || sha256Digest(repair.definition) !== run.repairDigest) {
      throw repairError("stale_preview", "Repair definition changed after preview; preview again.");
    }
    const plans = [];
    for (const planned of [...run.items].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
      if (!planned.applicable) continue;
      await tx.mutate("item", planned.itemId, () => null);
      const item = await requireDocument(tx, "item", planned.itemId);
      const current = planItem(repair.definition, item, currentEngineDigest);
      if (item.batchId !== run.batchId || sha256Digest(current) !== sha256Digest(planned)) {
        throw repairError("stale_preview", `Item ${item.id} changed after preview; preview again.`);
      }
      plans.push({ item, planned });
    }
    const appliedAt = new Date().toISOString();
    const applicationIds = [];
    for (const { item, planned } of plans) {
      const applicationId = randomUUID();
      const after = await tx.mutate("item", item.id, () => ({
        ...planned.after, repairHistory: [...(item.repairHistory || []), applicationId]
      }));
      await tx.create("repair_application", applicationId, {
        repairId: run.repairId, repairRunId: run.id, repairVersion: run.definition.version,
        batchId: run.batchId, itemId: item.id, actor, appliedAt, status: "applied",
        reason: run.definition.reason, rootCause: run.definition.rootCause, evidence: run.definition.evidence,
        action: run.definition.action, before: planned.before, after,
        beforeDigest: planned.binding.digest, afterDigest: sha256Digest(after),
        diff: planned.diff, validation: planned.validation
      });
      applicationIds.push(applicationId);
    }
    if (applicationIds.length) await tx.mutate("batch", batch.id, (current) => ({ ...current, approval: null }));
    return tx.mutate("repair_run", run.id, (current) => ({
      ...current, status: "applied", actor, appliedAt, applicationIds
    }));
  });
}

function planItem(definition, item, currentEngineDigest) {
  const before = copy(item);
  const result = {
    itemId: item.id, applicable: false, reason: null, before, after: before, diff: [],
    binding: { version: item.version, sourceDigest: item.sourceDigest || null,
      dslDigest: item.dslDigest || null, digest: sha256Digest(before) },
    validation: { ok: false, diagnostics: [] }
  };
  const skip = (reason, diagnostics = []) => ({ ...result, reason, validation: { ok: false, diagnostics } });
  if (item.writeStarted || item.targetTemplateId || item.attempts?.some((attempt) => attempt.writeStarted || attempt.targetTemplateId)) {
    return skip("needs_scoped_target_repair");
  }
  if (item.status === "outcome_unknown") return skip("write_outcome_unknown");
  if (item.status === "succeeded") return skip("already_succeeded");
  if (item.activeAttemptId || ["preparing", "running"].includes(item.status)) return skip("item_active");
  if (!["pending", "ready", "blocked", "needs_repair"].includes(item.status)) return skip("unsupported_item_status");
  const codes = new Set((item.diagnostics || []).map((entry) => entry.code));
  if (!definition.selector.diagnosticCodes.some((code) => codes.has(code))) return skip("diagnostic_not_matched");
  const sourceId = item.sourceId || item.sourceDraft?.source?.sourceId || item.dsl?.derivedFrom?.sourceId;
  if (definition.selector.sourceIds && !definition.selector.sourceIds.includes(sourceId)) return skip("source_not_matched");
  let after = copy(before);
  const action = definition.action;
  let validation = { ok: true, diagnostics: [] };
  if (action.kind === "reprepare") {
    after = { ...after, status: "pending", dsl: null, dslDraft: null, dslDigest: null,
      checkpoint: null, approval: null, activeAttemptId: null, diagnostics: [] };
  } else if (action.kind === "execution_options") {
    if (!item.dsl) return skip("trusted_dsl_required");
    validation = validateDsl(item.sourceDraft, item.dsl);
    if (!validation.ok) return skip("validation_failed", validation.diagnostics);
    const mapped = applicableRepairOptions(item.dsl, item.executionOptions, action.options);
    if (mapped.diagnostics.length) return skip("mapping_identity_ambiguous", mapped.diagnostics);
    if (!mapped.matchingMappings) return skip("mapping_not_applicable");
    if (sha256Digest(mapped.options) === sha256Digest(item.executionOptions || {})) return skip("no_change");
    after = { ...after, executionOptions: mapped.options, engineDigest: currentEngineDigest, status: "ready", approval: null,
      diagnostics: [], activeAttemptId: null };
    validation = { ...validation, targetValidation: "deferred_to_executor" };
  } else {
    const replacement = action.replacements.find((entry) => entry.itemId === item.id);
    if (!replacement) return skip("replacement_not_supplied");
    if (replacement.expectedDslDigest !== item.dslDigest || (item.dsl && sha256Digest(item.dsl) !== item.dslDigest)) {
      return skip("replacement_digest_mismatch");
    }
    validation = validateDsl(item.sourceDraft, replacement.dsl);
    if (!validation.ok) return skip("validation_failed", validation.diagnostics);
    after = { ...after, dsl: copy(replacement.dsl), dslDigest: sha256Digest(replacement.dsl), engineDigest: currentEngineDigest,
      dslDraft: null, checkpoint: null, status: "ready", approval: null, diagnostics: [], activeAttemptId: null };
  }
  const diff = differences(before, after);
  return diff.length ? { ...result, applicable: true, reason: "applicable", after, diff, validation } : skip("no_change");
}

function validateDsl(sourceDraft, dsl) {
  try {
    const trust = checkTrust(sourceDraft, dsl);
    const execute = checkExecute(dsl);
    return copy({ ok: trust.ok && execute.ok, trust, execute, diagnostics: [...trust.diagnostics, ...execute.diagnostics] });
  } catch (cause) {
    return { ok: false, diagnostics: [{ level: "error", code: "batch.repair.validation_failed", message: cause.message }] };
  }
}

function validateDefinition(definition) {
  exactKeys(definition, ["title", "rootCause", "reason", "evidence", "version", "selector", "action"], "repair");
  for (const key of ["title", "rootCause", "reason"]) requireText(definition[key], key);
  if (!(typeof definition.version === "string" && definition.version.trim()) &&
      !(Number.isInteger(definition.version) && definition.version > 0)) throw new Error("Repair version is required.");
  if (!Array.isArray(definition.evidence) || !definition.evidence.length || definition.evidence.some((entry) =>
    entry === null || typeof entry === "boolean" || typeof entry === "number" || (typeof entry === "string" && !entry.trim()))) {
    throw new Error("Repair evidence must be a non-empty array of evidence references or objects.");
  }
  exactKeys(definition.selector, ["diagnosticCodes", "sourceIds"], "selector");
  requireStrings(definition.selector.diagnosticCodes, "selector.diagnosticCodes");
  if (definition.selector.sourceIds !== undefined) requireStrings(definition.selector.sourceIds, "selector.sourceIds");
  const action = definition.action;
  if (action?.kind === "reprepare") exactKeys(action, ["kind"], "action");
  else if (action?.kind === "execution_options") {
    exactKeys(action, ["kind", "options"], "action");
    validateRepairOptions(action.options);
  } else if (action?.kind === "replace_dsl") {
    exactKeys(action, ["kind", "replacements"], "action");
    if (!Array.isArray(action.replacements) || !action.replacements.length) throw new Error("DSL replacements are required.");
    const ids = new Set();
    for (const entry of action.replacements) {
      exactKeys(entry, ["itemId", "expectedDslDigest", "dsl"], "replacement");
      requireText(entry.itemId, "replacement.itemId");
      requireText(entry.expectedDslDigest, "replacement.expectedDslDigest");
      if (!/^sha256:[a-f0-9]{64}$/.test(entry.expectedDslDigest)) throw new Error("replacement.expectedDslDigest must be a SHA-256 digest.");
      if (!entry.dsl || typeof entry.dsl !== "object" || Array.isArray(entry.dsl)) throw new Error("replacement.dsl must be an object.");
      if (ids.has(entry.itemId)) throw new Error("DSL replacements contain duplicate item IDs.");
      ids.add(entry.itemId);
    }
  } else throw new Error("Unsupported repair action.");
  copy(definition);
}

function runPlan(run) {
  const { repairId, batchId, repairVersion, repairDigest, definition, engineDigest, items, summary } = run;
  return { repairId, batchId, repairVersion, repairDigest, definition, engineDigest, items, summary };
}

function differences(before, after, path = "") {
  if (sha256Digest(before ?? null) === sha256Digest(after ?? null)) return [];
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((key) =>
      differences(before[key], after[key], `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`));
  }
  return [{ path, before: before ?? null, after: after ?? null }];
}

async function requireDocument(store, kind, id) {
  const document = await store.get(kind, id);
  if (!document) throw repairError("not_found", `${kind} ${id} was not found.`);
  return document;
}

function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
}

function requireStrings(value, name) {
  if (!Array.isArray(value) || !value.length || value.some((entry) => typeof entry !== "string" || !entry.trim()) || new Set(value).size !== value.length) {
    throw new Error(`${name} must be a non-empty array of unique strings.`);
  }
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function repairError(code, message) {
  const error = new Error(message);
  error.code = `batch.repair.${code}`;
  return error;
}
