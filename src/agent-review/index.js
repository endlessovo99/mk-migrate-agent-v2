import { checkDraft } from "../dsl/checks.js";
import { FIELD_TYPES } from "../dsl/schema.js";
import { checkTrust, createTrustedMigrationDsl } from "../dsl/trust.js";
import { SOURCE_DRAFT_VERSION } from "../translator/source-draft.js";
import { OpenAIResponsesReviewProvider, redactSecrets } from "./provider.js";
import { AGENT_REVIEW_PROMPT_VERSION } from "./prompt.js";

const TOP_LEVEL_KEYS = new Set(["summary", "patches", "diagnostics"]);
const PATCH_KEYS = ["op", "path", "value", "sourceRefs", "evidence", "confidence", "rationale"];
const DIAGNOSTIC_LEVELS = new Set(["info", "warning", "error", "blocked"]);
const SCRIPT_COVERAGE_STATUSES = new Set(["none", "partial", "uncovered", "covered", "translated"]);

export async function runAgentReview(sourceDraft, dslDraft, options = {}) {
  const provider = options.provider || new OpenAIResponsesReviewProvider(options.providerOptions);
  const metadata = providerMetadata(provider);
  const maxRepairAttempts = options.maxRepairAttempts ?? 1;
  const repairHistory = [];
  const inputDiagnostics = validateInputs(sourceDraft, dslDraft);
  if (inputDiagnostics.length) {
    return blockedResult({
      ...metadata,
      stage: "agent-review.input",
      diagnostics: inputDiagnostics
    });
  }

  const providerResult = await provider.review({ sourceDraft, dslDraft });
  if (!providerResult.ok) {
    return blockedResult({
      ...metadata,
      ...providerResult,
      diagnostics: providerResult.diagnostics || []
    });
  }

  const reviewedAt = options.reviewedAt || new Date().toISOString();
  let activeProviderResult = providerResult;
  let review = evaluateProviderReviewResult(sourceDraft, dslDraft, activeProviderResult, metadata);

  for (let attempt = 1; !review.ok && review.repairable && attempt <= maxRepairAttempts; attempt += 1) {
    if (typeof provider.repairReviewResponse !== "function") break;
    repairHistory.push(repairHistoryEntry(review, attempt));
    const repairProviderResult = await provider.repairReviewResponse({
      sourceDraft,
      dslDraft,
      rawText: activeProviderResult.rawText,
      diagnostics: review.diagnostics,
      rejectedPatches: review.rejectedPatches || [],
      attempt
    });

    if (!repairProviderResult.ok) {
      return blockedResult({
        ...metadata,
        ...repairProviderResult,
        diagnostics: repairProviderResult.diagnostics || [],
        repairAttempts: repairHistory.length,
        repairHistory
      });
    }

    activeProviderResult = repairProviderResult;
    review = evaluateProviderReviewResult(sourceDraft, dslDraft, activeProviderResult, metadata);
  }

  if (!review.ok) {
    return blockedResult({
      ...review.blockedInput,
      repairAttempts: repairHistory.length,
      repairHistory
    });
  }

  const { diagnosticCheck, parsed, patchResult, promptVersion } = review;

  const agentReview = {
    provider: activeProviderResult.provider || metadata.provider || "openai",
    baseUrl: activeProviderResult.baseUrl || metadata.baseUrl || "",
    model: activeProviderResult.model || metadata.model || "",
    promptVersion,
    reviewedAt,
    summary: parsed.response.summary,
    patchCount: parsed.response.patches.length,
    diagnosticCount: parsed.response.diagnostics.length,
    scriptTranslation: summarizeScriptTranslation(patchResult.dslDraft.scripts)
  };

  const trusted = createTrustedMigrationDsl(sourceDraft, patchResult.dslDraft, {
    externalAgentReviewed: true,
    reviewerName: "openai-responses-agent",
    checkedAt: reviewedAt,
    decisions: patchResult.decisions,
    agentReview,
    reviewWarnings: diagnosticCheck.warnings
  });
  const trustCheck = checkTrust(sourceDraft, trusted);
  if (!trustCheck.ok) {
    return {
      ok: false,
      status: "blocked",
      dslDraft: patchResult.dslDraft,
      report: pruneUndefined({
        ok: false,
        status: "blocked",
        stage: "agent-review.trust-validation",
        provider: activeProviderResult.provider || metadata.provider || "openai",
        baseUrl: activeProviderResult.baseUrl || metadata.baseUrl || "",
        model: activeProviderResult.model || metadata.model || "",
        promptVersion,
        diagnostics: trustCheck.diagnostics,
        acceptedPatchCount: patchResult.acceptedPatches.length,
        diagnosticCount: parsed.response.diagnostics.length,
        scriptTranslation: summarizeScriptTranslation(patchResult.dslDraft.scripts),
        rawResponsePreview: activeProviderResult.rawResponsePreview ? redactSecrets(activeProviderResult.rawResponsePreview) : undefined,
        repairAttempts: repairHistory.length,
        repairHistory
      })
    };
  }

  const report = {
    ok: true,
    status: trustCheck.status,
    stage: "agent-review.complete",
    provider: agentReview.provider,
    baseUrl: agentReview.baseUrl,
    model: agentReview.model,
    promptVersion,
    reviewedAt,
    artifact: trusted.artifact,
    diagnostics: trustCheck.diagnostics,
    acceptedPatchCount: patchResult.acceptedPatches.length,
    diagnosticCount: parsed.response.diagnostics.length,
    scriptTranslation: agentReview.scriptTranslation,
    repairAttempts: repairHistory.length,
    repairHistory
  };

  return {
    ok: true,
    status: trustCheck.status,
    dsl: trusted,
    report
  };
}

function evaluateProviderReviewResult(sourceDraft, dslDraft, providerResult, metadata) {
  const promptVersion = providerResult.promptVersion || AGENT_REVIEW_PROMPT_VERSION;
  const parsed = parseAgentReviewResponse(providerResult.rawText);
  if (!parsed.ok) {
    return failedReview({
      ...metadata,
      ...providerResult,
      stage: "agent-review.response-parse",
      diagnostics: parsed.diagnostics,
      rawResponsePreview: providerResult.rawText || providerResult.rawResponsePreview,
      repairable: true
    });
  }

  const diagnosticCheck = evaluateReviewDiagnostics(parsed.response.diagnostics);
  if (diagnosticCheck.blocking.length) {
    return failedReview({
      ...metadata,
      ...providerResult,
      stage: "agent-review.diagnostics",
      diagnostics: diagnosticCheck.blocking,
      rawResponsePreview: providerResult.rawResponsePreview,
      repairable: false
    });
  }

  const patchResult = applyEvidenceBackedPatches(dslDraft, parsed.response.patches, {
    sourceRefs: collectSourceRefs(sourceDraft)
  });
  if (!patchResult.ok) {
    return failedReview({
      ...metadata,
      ...providerResult,
      stage: "agent-review.patch-validation",
      diagnostics: patchResult.diagnostics,
      rejectedPatches: patchResult.rejectedPatches,
      rawResponsePreview: providerResult.rawResponsePreview,
      repairable: true
    });
  }

  const draftCheck = checkDraft(patchResult.dslDraft);
  if (!draftCheck.ok) {
    return failedReview({
      ...metadata,
      ...providerResult,
      stage: "agent-review.dsl-validation",
      diagnostics: draftCheck.diagnostics,
      rawResponsePreview: providerResult.rawResponsePreview,
      repairable: false
    });
  }

  return {
    ok: true,
    promptVersion,
    parsed,
    diagnosticCheck,
    patchResult
  };
}

function failedReview(input) {
  return {
    ok: false,
    repairable: input.repairable === true,
    stage: input.stage,
    diagnostics: input.diagnostics || [],
    rejectedPatches: input.rejectedPatches,
    blockedInput: input
  };
}

export function parseAgentReviewResponse(rawText) {
  let response;
  try {
    response = typeof rawText === "string" ? JSON.parse(rawText) : rawText;
  } catch {
    return invalidResponse("agent.response.invalid_json", "Agent review response must be valid JSON.", "/response");
  }

  if (!isRecord(response)) {
    return invalidResponse("agent.response.root_type", "Agent review response must be a JSON object.", "/response");
  }

  const keys = Object.keys(response);
  const unexpected = keys.filter((key) => !TOP_LEVEL_KEYS.has(key));
  const missing = [...TOP_LEVEL_KEYS].filter((key) => !Object.hasOwn(response, key));
  if (unexpected.length || missing.length) {
    return invalidResponse("agent.response.top_level_keys", "Agent review response must contain only summary, patches, and diagnostics.", "/response", {
      unexpected,
      missing
    });
  }

  const diagnostics = [];
  if (!nonEmptyString(response.summary)) {
    diagnostics.push(error("agent.response.summary_required", "Agent review response summary must be a non-empty string.", "/summary"));
  }
  if (!Array.isArray(response.patches)) {
    diagnostics.push(error("agent.response.patches_required", "Agent review response patches must be an array.", "/patches"));
  }
  if (!Array.isArray(response.diagnostics)) {
    diagnostics.push(error("agent.response.diagnostics_required", "Agent review response diagnostics must be an array.", "/diagnostics"));
  }

  if (Array.isArray(response.diagnostics)) {
    response.diagnostics.forEach((diagnostic, index) => {
      diagnostics.push(...validateAgentDiagnostic(diagnostic, `/diagnostics/${index}`));
    });
  }

  if (diagnostics.length) {
    return { ok: false, diagnostics };
  }

  return {
    ok: true,
    response: {
      summary: response.summary,
      patches: response.patches,
      diagnostics: response.diagnostics
    }
  };
}

export function applyEvidenceBackedPatches(dslDraft, patches, options = {}) {
  const diagnostics = [];
  const rejectedPatches = [];
  const acceptedPatches = [];
  const decisions = [];
  const seenPaths = new Set();
  const sourceRefs = options.sourceRefs || new Set();

  patches.forEach((patch, index) => {
    const result = validatePatch(patch, index, dslDraft, sourceRefs, seenPaths);
    if (!result.ok) {
      diagnostics.push(...result.diagnostics);
      rejectedPatches.push(patchSummary(patch, index, result.diagnostics));
      return;
    }
    seenPaths.add(patch.path);
    acceptedPatches.push(patch);
  });

  if (diagnostics.length) {
    return { ok: false, diagnostics, rejectedPatches };
  }

  const patchedDraft = clone(dslDraft);
  acceptedPatches.forEach((patch, index) => {
    setByPointer(patchedDraft, patch.path, clone(patch.value));
    decisions.push({
      id: `agent-review-patch-${index + 1}`,
      status: "accepted",
      decisionType: "agent_review_patch",
      sourceRefs: patch.sourceRefs,
      targetRefs: [patch.path],
      rationale: patch.rationale,
      result: `replaced ${patch.path}`,
      evidence: patch.evidence,
      confidence: patch.confidence
    });
  });

  return {
    ok: true,
    dslDraft: patchedDraft,
    acceptedPatches,
    rejectedPatches,
    decisions
  };
}

function validateInputs(sourceDraft, dslDraft) {
  const diagnostics = [];
  if (sourceDraft?.version !== SOURCE_DRAFT_VERSION || sourceDraft?.artifact !== "source-draft") {
    diagnostics.push(error("agent.input.source_draft_required", "agent-review requires a source-draft artifact.", "/sourceDraft"));
  }
  if (dslDraft?.artifact !== "dsl-draft" || dslDraft?.trust?.level !== "draft" || dslDraft?.trust?.executable !== false) {
    diagnostics.push(error("agent.input.dsl_draft_required", "agent-review requires a non-executable dsl-draft artifact.", "/dslDraft"));
  }
  return diagnostics;
}

function validatePatch(patch, index, dslDraft, sourceRefs, seenPaths) {
  const path = `/patches/${index}`;
  const diagnostics = [];
  if (!isRecord(patch)) {
    return {
      ok: false,
      diagnostics: [error("agent.patch.type", "Agent patch must be an object.", path)]
    };
  }

  for (const key of PATCH_KEYS) {
    if (!Object.hasOwn(patch, key)) {
      diagnostics.push(error("agent.patch.field_required", `Agent patch requires ${key}.`, `${path}/${key}`));
    }
  }

  if (patch.op !== "replace") {
    diagnostics.push(error("agent.patch.op_unsupported", "Agent review supports only replace patches.", `${path}/op`, {
      actual: patch.op
    }));
  }

  const target = parseAllowedPatchPath(patch.path);
  const currentTarget = target.ok ? getByPointer(dslDraft, patch.path) : { exists: false };
  if (!target.ok) {
    diagnostics.push(error("agent.patch.path_disallowed", "Agent patch path is outside the allowed form/script DSL patch scope.", `${path}/path`, {
      path: patch.path,
      allowed: "form field/detail-column title, type, componentId, props paths and scripts.actions function, translationStatus, functionMappings, coverage paths only"
    }));
  } else if (!currentTarget.exists) {
    diagnostics.push(error("agent.patch.path_missing", "Agent patch path does not exist in the DSL draft.", `${path}/path`, {
      path: patch.path
    }));
  }

  if (seenPaths.has(patch.path)) {
    diagnostics.push(error("agent.patch.path_duplicate", "Agent patch response must not patch the same path more than once.", `${path}/path`, {
      path: patch.path
    }));
  }

  if (!Array.isArray(patch.sourceRefs) || patch.sourceRefs.length === 0 || patch.sourceRefs.some((ref) => !nonEmptyString(ref))) {
    diagnostics.push(error("agent.patch.source_refs_required", "Agent patch sourceRefs must be a non-empty string array.", `${path}/sourceRefs`));
  } else {
    const missingRefs = patch.sourceRefs.filter((ref) => !sourceRefs.has(ref));
    if (missingRefs.length) {
      diagnostics.push(error("agent.patch.source_refs_missing", "Agent patch sourceRefs must exist in the source draft.", `${path}/sourceRefs`, {
        missingRefs
      }));
    }
  }

  if (!Array.isArray(patch.evidence) || patch.evidence.length === 0 || patch.evidence.some((item) => !nonEmptyString(item))) {
    diagnostics.push(error("agent.patch.evidence_required", "Agent patch evidence must be a non-empty string array.", `${path}/evidence`));
  }
  if (!Number.isFinite(patch.confidence) || patch.confidence < 0 || patch.confidence > 1) {
    diagnostics.push(error("agent.patch.confidence_invalid", "Agent patch confidence must be a number between 0 and 1.", `${path}/confidence`));
  } else if (target.ok && patch.confidence < confidenceThreshold(target.property)) {
    diagnostics.push(error("agent.patch.low_confidence", "Agent patch confidence is below the required threshold.", `${path}/confidence`, {
      path: patch.path,
      confidence: patch.confidence,
      threshold: confidenceThreshold(target.property)
    }));
  }
  if (!nonEmptyString(patch.rationale)) {
    diagnostics.push(error("agent.patch.rationale_required", "Agent patch rationale must be a non-empty string.", `${path}/rationale`));
  }

  if (target.ok) {
    diagnostics.push(...validatePatchValue(patch, target, path, currentTarget.value, dslDraft));
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics
  };
}

function validatePatchValue(patch, target, path, currentValue, dslDraft) {
  if (target.scope === "scriptAction") {
    return validateScriptPatchValue(patch, target, path, currentValue, dslDraft);
  }
  if (target.property === "title" && !nonEmptyString(patch.value)) {
    return [error("agent.patch.value_title_required", "Title patches require a non-empty string value.", `${path}/value`)];
  }
  if (target.property === "type" && !FIELD_TYPES.has(patch.value)) {
    return [error("agent.patch.value_type_invalid", "Type patches require a supported DSL field type.", `${path}/value`, {
      actual: patch.value,
      supported: [...FIELD_TYPES]
    })];
  }
  if (target.property === "type" && target.scope === "column" && patch.value === "detailTable") {
    return [error("agent.patch.value_column_type_invalid", "Detail table columns cannot be patched to detailTable type.", `${path}/value`)];
  }
  if (target.property === "componentId" && !nonEmptyString(patch.value)) {
    return [error("agent.patch.value_component_required", "componentId patches require a non-empty string value.", `${path}/value`)];
  }
  if (target.property === "props" && !isRecord(patch.value)) {
    return [error("agent.patch.value_props_required", "props patches require an object value.", `${path}/value`)];
  }
  if (target.property === "props") {
    const unsupportedProps = Object.keys(patch.value).filter((key) => !["required", "options", "maxLength"].includes(key));
    if (unsupportedProps.length) {
      return [error("agent.patch.value_props_unsupported", "Agent Review v1 may patch only required, options, and maxLength props.", `${path}/value`, {
        unsupportedProps
      })];
    }
  }
  return [];
}

function validateScriptPatchValue(patch, target, path, currentValue, dslDraft) {
  const action = getScriptAction(dslDraft, target.actionIndex);
  const protection = protectedScriptActionReason(action);
  if (target.property === "function" && typeof patch.value !== "string") {
    return [error("agent.patch.value_script_function_required", "Script function patches require a string value. Empty strings are valid only when the final action is omitted.", `${path}/value`)];
  }
  if (target.property === "translationStatus" && !["mapped", "needs_review", "manual", "omitted"].includes(patch.value)) {
    return [error("agent.patch.value_script_status_invalid", "Script translationStatus patches require mapped, needs_review, manual, or omitted.", `${path}/value`, {
      actual: patch.value
    })];
  }
  if (
    target.property === "translationStatus" &&
    protection &&
    ["needs_review", "manual"].includes(patch.value)
  ) {
    return [error("agent.patch.script_status_downgrade_forbidden", "Agent Review must not downgrade a protected deterministic or native-covered script action; leave it unchanged and emit a diagnostic if confidence is insufficient.", `${path}/value`, {
      current: currentValue,
      proposed: patch.value,
      actionIndex: target.actionIndex,
      protection
    })];
  }
  if (target.property === "functionMappings" && !Array.isArray(patch.value)) {
    return [error("agent.patch.value_function_mappings_required", "Script functionMappings patches require an array value.", `${path}/value`)];
  }
  if (target.property === "coverage" && !isRecord(patch.value)) {
    return [error("agent.patch.value_coverage_required", "Script coverage patches require an object value.", `${path}/value`)];
  }
  if (target.property === "coverage") {
    const diagnostics = [];
    if (!SCRIPT_COVERAGE_STATUSES.has(patch.value.status)) {
      diagnostics.push(error("agent.patch.value_coverage_status_invalid", "Script coverage.status patches require none, partial, uncovered, covered, or translated.", `${path}/value/status`, {
        actual: patch.value.status
      }));
    } else if (
      protection &&
      (["partial", "uncovered"].includes(patch.value.status) ||
        (Array.isArray(patch.value.residuals) && patch.value.residuals.length > 0))
    ) {
      diagnostics.push(error("agent.patch.script_coverage_downgrade_forbidden", "Agent Review must not downgrade coverage for a protected deterministic or native-covered script action; leave it unchanged and emit a diagnostic if confidence is insufficient.", `${path}/value/status`, {
        current: action?.coverage?.status,
        proposed: patch.value.status,
        actionIndex: target.actionIndex,
        protection,
        residualCount: Array.isArray(patch.value.residuals) ? patch.value.residuals.length : undefined
      }));
    }
    if (patch.value.nativeRules !== undefined && !Array.isArray(patch.value.nativeRules)) {
      diagnostics.push(error("agent.patch.value_coverage_native_rules_invalid", "Script coverage.nativeRules must be an array when present.", `${path}/value/nativeRules`));
    }
    if (patch.value.residuals !== undefined && !Array.isArray(patch.value.residuals)) {
      diagnostics.push(error("agent.patch.value_coverage_residuals_invalid", "Script coverage.residuals must be an array when present.", `${path}/value/residuals`));
    }
    return diagnostics;
  }
  return [];
}

function getScriptAction(dslDraft, actionIndex) {
  if (!Number.isInteger(actionIndex)) return undefined;
  const actions = dslDraft?.scripts?.actions;
  return Array.isArray(actions) ? actions[actionIndex] : undefined;
}

function protectedScriptActionReason(action) {
  if (!isRecord(action)) return undefined;
  if (action.translationStatus === "omitted" && action.coverage?.status === "covered") {
    return "native-covered";
  }
  const mappings = Array.isArray(action.functionMappings) ? action.functionMappings : [];
  const hasDeterministicPattern = mappings.some((mapping) => (
    mapping?.basis === "deterministic-pattern" &&
    mapping?.reviewRequired === false
  ));
  const residuals = action.coverage?.residuals;
  const residualFree = Array.isArray(residuals) && residuals.length === 0;
  if (action.translationStatus === "mapped" && hasDeterministicPattern && residualFree) {
    return "deterministic-pattern";
  }
  return undefined;
}

function parseAllowedPatchPath(path) {
  if (!nonEmptyString(path)) return { ok: false };
  const parts = parsePointer(path);
  if (!parts) return { ok: false };
  if (parts.length === 4 && parts[0] === "form" && parts[1] === "fields" && isArrayIndex(parts[2]) && isPatchProperty(parts[3])) {
    return { ok: true, scope: "field", property: parts[3] };
  }
  if (
    parts.length === 6 &&
    parts[0] === "form" &&
    parts[1] === "fields" &&
    isArrayIndex(parts[2]) &&
    parts[3] === "columns" &&
    isArrayIndex(parts[4]) &&
    isPatchProperty(parts[5])
  ) {
    return { ok: true, scope: "column", property: parts[5] };
  }
  if (
    parts.length === 4 &&
    parts[0] === "scripts" &&
    parts[1] === "actions" &&
    isArrayIndex(parts[2]) &&
    isScriptPatchProperty(parts[3])
  ) {
    return { ok: true, scope: "scriptAction", actionIndex: Number(parts[2]), property: parts[3] };
  }
  return { ok: false };
}

function evaluateReviewDiagnostics(diagnostics) {
  const warnings = [];
  const blocking = [];
  diagnostics.forEach((diagnostic, index) => {
    const normalized = normalizeAgentDiagnostic(diagnostic, index);
    if (normalized.level === "error" || normalized.level === "blocked") {
      blocking.push({
        ...normalized,
        level: "error",
        code: normalized.code || "agent.review.blocked"
      });
      return;
    }
    if (normalized.level === "warning") warnings.push(normalized);
  });
  return { warnings, blocking };
}

function normalizeAgentDiagnostic(diagnostic, index) {
  return {
    level: diagnostic.level,
    code: diagnostic.code,
    path: diagnostic.path || `/diagnostics/${index}`,
    message: diagnostic.message,
    details: diagnostic.details
  };
}

function validateAgentDiagnostic(diagnostic, path) {
  if (!isRecord(diagnostic)) {
    return [error("agent.response.diagnostic_type", "Agent diagnostics must be objects.", path)];
  }
  const diagnostics = [];
  if (!DIAGNOSTIC_LEVELS.has(diagnostic.level)) {
    diagnostics.push(error("agent.response.diagnostic_level", "Agent diagnostic level must be info, warning, error, or blocked.", `${path}/level`, {
      actual: diagnostic.level
    }));
  }
  for (const key of ["code", "path", "message"]) {
    if (!nonEmptyString(diagnostic[key])) {
      diagnostics.push(error("agent.response.diagnostic_field_required", `Agent diagnostic ${key} must be a non-empty string.`, `${path}/${key}`));
    }
  }
  return diagnostics;
}

function collectSourceRefs(value) {
  const refs = new Set();
  for (const item of walk(value)) {
    if (item.key === "sourceRef" && nonEmptyString(item.value)) refs.add(item.value);
  }
  return refs;
}

function* walk(value) {
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    yield { key, value: child };
    yield* walk(child);
  }
}

function providerMetadata(provider) {
  if (typeof provider?.metadata === "function") return provider.metadata();
  return { provider: "openai", baseUrl: "", model: "" };
}

function blockedResult(input) {
  return {
    ok: false,
    status: "blocked",
    report: pruneUndefined({
      ok: false,
      status: "blocked",
      stage: input.stage || "agent-review.blocked",
      provider: input.provider || "openai",
      baseUrl: input.baseUrl || "",
      model: input.model || "",
      promptVersion: input.promptVersion,
      diagnostics: input.diagnostics || [],
      rejectedPatches: input.rejectedPatches,
      rawResponsePreview: input.rawResponsePreview ? redactSecrets(input.rawResponsePreview) : undefined,
      repairAttempts: input.repairAttempts,
      repairHistory: input.repairHistory
    })
  };
}

function invalidResponse(code, message, path, details) {
  return {
    ok: false,
    diagnostics: [error(code, message, path, details)]
  };
}

function patchSummary(patch, index, diagnostics) {
  return {
    index,
    op: patch?.op,
    path: patch?.path,
    confidence: patch?.confidence,
    codes: diagnostics.map((diagnostic) => diagnostic.code)
  };
}

function repairHistoryEntry(review, attempt) {
  return pruneUndefined({
    attempt,
    stage: review.stage,
    diagnostics: review.diagnostics,
    rejectedPatches: review.rejectedPatches
  });
}

function summarizeScriptTranslation(scripts = {}) {
  const actions = Array.isArray(scripts.actions) ? scripts.actions : [];
  const byStatus = {};
  const byScope = {};
  const byEvent = {};
  for (const action of actions) {
    increment(byStatus, action.translationStatus || "unknown");
    increment(byScope, action.scope || "unknown");
    increment(byEvent, action.event || action.name || "unknown");
  }
  return {
    actionCount: actions.length,
    byStatus,
    byScope,
    byEvent
  };
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function confidenceThreshold(property) {
  return property === "title" ? 0.7 : 0.85;
}

function getByPointer(value, pointer) {
  const parts = parsePointer(pointer);
  if (!parts) return { exists: false };
  let current = value;
  for (const part of parts) {
    if (!isRecord(current) && !Array.isArray(current)) return { exists: false };
    if (!Object.hasOwn(current, part)) return { exists: false };
    current = current[part];
  }
  return { exists: true, value: current };
}

function setByPointer(value, pointer, nextValue) {
  const parts = parsePointer(pointer);
  let current = value;
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current[parts[index]];
  }
  current[parts.at(-1)] = nextValue;
}

function parsePointer(pointer) {
  if (!nonEmptyString(pointer) || !pointer.startsWith("/")) return undefined;
  const rawParts = pointer.slice(1).split("/");
  const parts = [];
  for (const part of rawParts) {
    if (/~(?!0|1)/.test(part)) return undefined;
    parts.push(part.replace(/~1/g, "/").replace(/~0/g, "~"));
  }
  return parts;
}

function isPatchProperty(value) {
  return ["title", "type", "componentId", "props"].includes(value);
}

function isScriptPatchProperty(value) {
  return ["function", "translationStatus", "functionMappings", "coverage"].includes(value);
}

function isArrayIndex(value) {
  return /^(0|[1-9]\d*)$/.test(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function pruneUndefined(value) {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, pruneUndefined(entry)])
  );
}

function error(code, message, path, details) {
  return { level: "error", code, message, path, details };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
