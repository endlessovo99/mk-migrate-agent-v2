import { SOURCE_DRAFT_VERSION } from "../translator/source-draft.js";
import { inspectWorkflowFormulaProvenance } from "../translator/workflow-formula-participants.js";
import {
  createReviewCheckpoint,
  validateReviewCheckpoint,
  validateReviewedDraftDigest
} from "./checkpoint.js";
import { sha256Digest } from "./digest.js";
import { AGENT_REVIEW_PROMPT_VERSION } from "./prompt.js";
import { redactSecrets } from "./provider.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "./review-validation.js";

export function createInitialReviewState(dslDraft) {
  return {
    attemptsByActionIndex: new Map(),
    acceptedPatches: [],
    summaries: [],
    reviewWarnings: [],
    batches: [],
    diagnosticCount: 0,
    repairHistory: [],
    workingDraft: clone(dslDraft),
    reviewerAudit: undefined,
    latestProviderResponse: undefined,
    promptVersion: AGENT_REVIEW_PROMPT_VERSION,
    includeFormTargets: true,
    latestCheckpoint: undefined,
    providerCalled: false
  };
}

export function restoreReviewState(checkpoint, context) {
  const checkpointValidation = validateReviewCheckpoint(checkpoint, {
    sourceDraft: context.sourceDraft,
    originalDslDraft: context.dslDraft,
    promptVersion: AGENT_REVIEW_PROMPT_VERSION,
    batchSize: context.batchSize,
    maxAttemptsPerAction: context.maxAttemptsPerAction,
    signingKey: context.checkpointSigningKey
  });
  if (!checkpointValidation.ok) {
    return {
      ok: false,
      result: blockedResult({
        ...context.metadata,
        stage: "agent-review.checkpoint",
        diagnostics: checkpointValidation.diagnostics
      })
    };
  }

  const validatedCheckpoint = checkpointValidation.checkpoint;
  const replay = applyEvidenceBackedPatches(context.dslDraft, validatedCheckpoint.acceptedPatches, {
    sourceRefs: collectSourceRefs(context.sourceDraft),
    sourceDraft: context.sourceDraft
  });
  if (!replay.ok) {
    return {
      ok: false,
      result: blockedResult({
        ...context.metadata,
        stage: "agent-review.checkpoint",
        diagnostics: replay.diagnostics,
        rejectedPatches: replay.rejectedPatches
      })
    };
  }

  const reviewedDigestValidation = validateReviewedDraftDigest(validatedCheckpoint, replay.dslDraft);
  if (!reviewedDigestValidation.ok) {
    return {
      ok: false,
      result: blockedResult({
        ...context.metadata,
        stage: "agent-review.checkpoint",
        diagnostics: reviewedDigestValidation.diagnostics
      })
    };
  }

  const attemptsByActionIndex = new Map();
  restoreAttemptsFromBatches(attemptsByActionIndex, validatedCheckpoint.batches);
  return {
    ok: true,
    state: {
      attemptsByActionIndex,
      acceptedPatches: [...validatedCheckpoint.acceptedPatches],
      summaries: [...(validatedCheckpoint.summaries || [])],
      reviewWarnings: [...(validatedCheckpoint.reviewWarnings || [])],
      batches: [...validatedCheckpoint.batches],
      diagnosticCount: validatedCheckpoint.diagnosticCount || 0,
      repairHistory: [...(validatedCheckpoint.repairHistory || [])],
      workingDraft: replay.dslDraft,
      reviewerAudit: validatedCheckpoint.reviewer,
      latestProviderResponse: undefined,
      promptVersion: validatedCheckpoint.reviewer?.promptVersion || validatedCheckpoint.contract.promptVersion,
      includeFormTargets: validatedCheckpoint.batches.length === 0,
      latestCheckpoint: validatedCheckpoint,
      providerCalled: false
    }
  };
}

export function createRunCheckpoint(status, context, state) {
  if (!context.checkpointEnabled) return undefined;
  return createReviewCheckpoint({
    status,
    sourceDraft: context.sourceDraft,
    originalDslDraft: context.dslDraft,
    reviewedDslDraft: state.workingDraft,
    promptVersion: AGENT_REVIEW_PROMPT_VERSION,
    batchSize: context.batchSize,
    maxAttemptsPerAction: context.maxAttemptsPerAction,
    acceptedPatches: state.acceptedPatches,
    batches: state.batches,
    summaries: state.summaries,
    reviewWarnings: state.reviewWarnings,
    diagnosticCount: state.diagnosticCount,
    repairHistory: state.repairHistory,
    reviewer: state.reviewerAudit,
    signingKey: context.checkpointSigningKey
  });
}

export function validateInputs(sourceDraft, dslDraft) {
  const diagnostics = [];
  if (sourceDraft?.version !== SOURCE_DRAFT_VERSION || sourceDraft?.artifact !== "source-draft") {
    diagnostics.push(error("agent.input.source_draft_required", "agent-review requires a source-draft artifact.", "/sourceDraft"));
  }
  if (dslDraft?.artifact !== "dsl-draft" || dslDraft?.trust?.level !== "draft" || dslDraft?.trust?.executable !== false) {
    diagnostics.push(error("agent.input.dsl_draft_required", "agent-review requires a non-executable dsl-draft artifact.", "/dslDraft"));
  }
  for (const inspection of inspectWorkflowFormulaProvenance(sourceDraft, dslDraft)) {
    if (inspection.status === "unmapped") {
      diagnostics.push(error(
        "agent.input.workflow_formula_unrepairable",
        "Agent Review cannot repair workflow participant formulas; add a deterministic Script mapping before review.",
        `/dslDraft/workflow/nodes/${inspection.nodeIndex}/participants`,
        inspection
      ));
    } else if (inspection.status !== "matched") {
      diagnostics.push(error(
        "agent.input.workflow_formula_provenance_mismatch",
        "Workflow formula evidence must match the authoritative source draft before Agent Review.",
        `/dslDraft/workflow/nodes/${inspection.nodeIndex}/participants`,
        inspection
      ));
    }
  }
  return diagnostics;
}

export function providerMetadata(provider) {
  if (typeof provider?.metadata === "function") return provider.metadata();
  return { provider: "openai", baseUrl: "", model: "" };
}

export function createReviewerAudit(providerResponse, promptVersion, reviewedAt) {
  return pruneUndefined({
    provider: providerResponse?.provider || "openai",
    baseUrl: providerResponse?.baseUrl || "",
    model: providerResponse?.model || "",
    promptVersion,
    reviewedAt: providerResponse?.reviewedAt || reviewedAt
  });
}

export function pendingScriptActions(dslDraft) {
  const actions = Array.isArray(dslDraft?.scripts?.actions) ? dslDraft.scripts.actions : [];
  return actions
    .map((action, actionIndex) => ({
      actionIndex,
      actionId: action?.id || `action-${actionIndex}`,
      translationStatus: action?.translationStatus
    }))
    .filter((item) => item.translationStatus === "needs_review");
}

export function selectPendingBatch(pending, attemptsByActionIndex, batchSize, maxAttemptsPerAction) {
  return pending
    .filter((item) => (attemptsByActionIndex.get(item.actionIndex) || 0) < maxAttemptsPerAction)
    .sort((left, right) => {
      const attemptDifference = (attemptsByActionIndex.get(left.actionIndex) || 0) - (attemptsByActionIndex.get(right.actionIndex) || 0);
      return attemptDifference || left.actionIndex - right.actionIndex;
    })
    .slice(0, batchSize)
    .sort((left, right) => left.actionIndex - right.actionIndex);
}

export function actionStateSnapshot(dslDraft, actionIndexes) {
  const actions = Array.isArray(dslDraft?.scripts?.actions) ? dslDraft.scripts.actions : [];
  return actionIndexes.map((actionIndex) => ({
    actionIndex,
    actionId: actions[actionIndex]?.id || `action-${actionIndex}`,
    translationStatus: actions[actionIndex]?.translationStatus || "unknown"
  }));
}

export function mergeAcceptedPatches(existingPatches, nextPatches) {
  const byPath = new Map(existingPatches.map((patch) => [patch.path, patch]));
  for (const patch of nextPatches) byPath.set(patch.path, patch);
  return [...byPath.values()];
}

export function incompleteReviewResult({ metadata, state, reason }) {
  const remaining = pendingScriptActions(state.workingDraft);
  const reviewer = state.reviewerAudit || metadata;
  const diagnostics = [error(
    `agent.review.${reason}`,
    "Agent Review stopped before every script action reached a trusted terminal status.",
    "/scripts/actions",
    {
      reason,
      remainingActionCount: remaining.length,
      remainingActionIds: remaining.map((item) => item.actionId)
    }
  )];
  return {
    ok: false,
    status: "blocked",
    dslDraft: state.workingDraft,
    checkpoint: state.latestCheckpoint,
    report: pruneUndefined({
      ok: false,
      status: "blocked",
      stage: "agent-review.incomplete",
      provider: reviewer.provider || metadata.provider || "openai",
      baseUrl: reviewer.baseUrl || metadata.baseUrl || "",
      model: reviewer.model || metadata.model || "",
      promptVersion: state.promptVersion,
      diagnostics,
      acceptedPatchCount: state.acceptedPatches.length,
      diagnosticCount: state.diagnosticCount,
      batchCount: state.batches.length,
      batches: state.batches,
      remainingReviewCount: remaining.length,
      scriptTranslation: summarizeScriptTranslation(state.workingDraft.scripts),
      rawResponsePreview: state.latestProviderResponse?.rawResponsePreview
        ? redactSecrets(state.latestProviderResponse.rawResponsePreview)
        : undefined,
      repairAttempts: state.repairHistory.length,
      repairHistory: state.repairHistory
    })
  };
}

export function blockedResultWithState(input, state) {
  const result = blockedResult(input);
  return {
    ...result,
    dslDraft: state.workingDraft,
    checkpoint: state.latestCheckpoint,
    report: pruneUndefined({
      ...result.report,
      acceptedPatchCount: state.acceptedPatches.length,
      diagnosticCount: state.diagnosticCount,
      batchCount: state.batches.length,
      batches: state.batches,
      scriptTranslation: summarizeScriptTranslation(state.workingDraft.scripts)
    })
  };
}

export function blockedResult(input) {
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

export function repairHistoryEntry(review, attempt, batchOrdinal, reviewScope, globalAttempt) {
  return pruneUndefined({
    attempt,
    globalAttempt,
    batchOrdinal,
    reviewScope: clone(reviewScope),
    stage: review.stage,
    diagnostics: review.diagnostics,
    rejectedPatches: review.rejectedPatches
  });
}

export function appendUniqueDiagnostics(target, nextDiagnostics) {
  const seen = new Set(target.map((diagnostic) => sha256Digest(diagnostic)));
  for (const diagnostic of nextDiagnostics) {
    const digest = sha256Digest(diagnostic);
    if (seen.has(digest)) continue;
    target.push(diagnostic);
    seen.add(digest);
  }
}

export function uniqueBatchReviewers(batches) {
  const reviewers = [];
  const seen = new Set();
  for (const batch of batches) {
    if (!isRecord(batch.reviewer)) continue;
    const digest = sha256Digest(batch.reviewer);
    if (seen.has(digest)) continue;
    reviewers.push(batch.reviewer);
    seen.add(digest);
  }
  return reviewers;
}

export function summarizeScriptTranslation(scripts = {}) {
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

export function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function pruneUndefined(value) {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, pruneUndefined(entry)])
  );
}

export function error(code, message, path, details) {
  return { level: "error", code, message, path, details };
}

function restoreAttemptsFromBatches(attemptsByActionIndex, batches) {
  for (const batch of batches || []) {
    for (const state of batch.after || []) {
      if (state.translationStatus !== "needs_review") continue;
      attemptsByActionIndex.set(state.actionIndex, (attemptsByActionIndex.get(state.actionIndex) || 0) + 1);
    }
  }
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
