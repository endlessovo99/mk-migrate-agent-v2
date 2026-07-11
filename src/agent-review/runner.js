import { isValidCheckpointSigningKey } from "./checkpoint.js";
import { AGENT_REVIEW_PROMPT_VERSION } from "./prompt.js";
import { OpenAIResponsesReviewProvider } from "./provider.js";
import { completeAgentReview } from "./review-completion.js";
import {
  actionStateSnapshot,
  appendUniqueDiagnostics,
  blockedResult,
  blockedResultWithState,
  clone,
  createInitialReviewState,
  createReviewerAudit,
  createRunCheckpoint,
  error,
  incompleteReviewResult,
  mergeAcceptedPatches,
  pendingScriptActions,
  positiveInteger,
  providerMetadata,
  repairHistoryEntry,
  restoreReviewState,
  selectPendingBatch,
  validateInputs
} from "./run-support.js";
import {
  applyEvidenceBackedPatches,
  collectSourceRefs,
  evaluateProviderReviewResult
} from "./review-validation.js";

export async function runAgentReview(sourceDraft, dslDraft, options = {}) {
  const provider = options.provider || new OpenAIResponsesReviewProvider(options.providerOptions);
  const metadata = providerMetadata(provider);
  const batchSize = positiveInteger(options.batchSize, 12);
  const maxAttemptsPerAction = positiveInteger(options.maxAttemptsPerAction, 2);
  const checkpointSigningKey = options.checkpointSigningKey;
  const checkpointEnabled = isValidCheckpointSigningKey(checkpointSigningKey);
  const resumeRequested = options.resumeCheckpoint !== undefined;
  const checkpointRequested = resumeRequested || typeof options.onCheckpoint === "function";
  const inputDiagnostics = validateInputs(sourceDraft, dslDraft);
  if (inputDiagnostics.length) {
    return blockedResult({
      ...metadata,
      stage: "agent-review.input",
      diagnostics: inputDiagnostics
    });
  }
  if (checkpointRequested && !checkpointEnabled) {
    return blockedResult({
      ...metadata,
      stage: "agent-review.checkpoint",
      diagnostics: [error(
        "agent.checkpoint.signing_key_required",
        "Checkpoint persistence and resume require AGENT_REVIEW_CHECKPOINT_KEY with at least 32 characters.",
        "/checkpoint/auth"
      )]
    });
  }

  const reviewedAt = options.reviewedAt || new Date().toISOString();
  const initialPendingCount = pendingScriptActions(dslDraft).length;
  const defaultMaxRounds = Math.max(1, Math.ceil(Math.max(1, initialPendingCount) / batchSize) * maxAttemptsPerAction + 1);
  const context = {
    sourceDraft,
    dslDraft,
    provider,
    metadata,
    reviewedAt,
    reviewerName: options.reviewerName || "openai-responses-agent",
    maxRepairAttempts: options.maxRepairAttempts ?? 1,
    batchSize,
    maxAttemptsPerAction,
    maxReviewRounds: positiveInteger(options.maxReviewRounds, defaultMaxRounds),
    checkpointSigningKey,
    checkpointEnabled,
    resumeRequested,
    onCheckpoint: options.onCheckpoint
  };

  let state = createInitialReviewState(dslDraft);
  if (resumeRequested) {
    const restored = restoreReviewState(options.resumeCheckpoint, context);
    if (!restored.ok) return restored.result;
    state = restored.state;
  }

  const roundResult = await runReviewRounds(context, state);
  if (!roundResult.ok) return roundResult.result;

  const cumulativePatchResult = applyEvidenceBackedPatches(dslDraft, state.acceptedPatches, {
    sourceRefs: collectSourceRefs(sourceDraft)
  });
  if (!cumulativePatchResult.ok) {
    return blockedResultWithState({
      ...metadata,
      stage: "agent-review.patch-validation",
      diagnostics: cumulativePatchResult.diagnostics,
      rejectedPatches: cumulativePatchResult.rejectedPatches,
      repairAttempts: state.repairHistory.length,
      repairHistory: state.repairHistory
    }, state);
  }
  state.workingDraft = cumulativePatchResult.dslDraft;
  return completeAgentReview(context, state, cumulativePatchResult);
}

async function runReviewRounds(context, state) {
  for (let round = 1; round <= context.maxReviewRounds; round += 1) {
    const pending = pendingScriptActions(state.workingDraft);
    const shouldReview = pending.length > 0 || (round === 1 && state.batches.length === 0);
    if (!shouldReview) break;

    const selected = selectPendingBatch(
      pending,
      state.attemptsByActionIndex,
      context.batchSize,
      context.maxAttemptsPerAction
    );
    if (pending.length > 0 && selected.length === 0) {
      return {
        ok: false,
        result: incompleteReviewResult({ metadata: context.metadata, state, reason: "attempts_exhausted" })
      };
    }

    const reviewScope = {
      actionIndexes: selected.map((item) => item.actionIndex),
      actionIds: selected.map((item) => item.actionId),
      includeFormTargets: state.includeFormTargets
    };
    const batchOrdinal = state.batches.length + 1;
    const before = actionStateSnapshot(state.workingDraft, reviewScope.actionIndexes);
    state.providerCalled = true;
    const batchResult = await runAgentReviewBatch({
      provider: context.provider,
      metadata: context.metadata,
      sourceDraft: context.sourceDraft,
      dslDraft: state.workingDraft,
      reviewScope,
      batchOrdinal,
      maxRepairAttempts: context.maxRepairAttempts,
      repairHistory: state.repairHistory
    });
    if (!batchResult.ok) {
      return {
        ok: false,
        result: blockedResultWithState({
          ...batchResult.blockedInput,
          repairAttempts: state.repairHistory.length,
          repairHistory: state.repairHistory
        }, state)
      };
    }

    state.latestProviderResponse = batchResult.providerResponse;
    state.promptVersion = batchResult.review.promptVersion;
    state.reviewerAudit = createReviewerAudit(
      batchResult.providerResponse,
      state.promptVersion,
      context.reviewedAt
    );
    const applied = applyBatchReview(context, state, batchResult.review, reviewScope, batchOrdinal, before);
    if (!applied.ok) return applied;

    state.latestCheckpoint = createRunCheckpoint("partial", context, state);
    if (typeof context.onCheckpoint === "function") {
      await context.onCheckpoint(state.latestCheckpoint);
    }
    if (applied.after.some((action) => action.translationStatus === "manual")) {
      return {
        ok: false,
        result: incompleteReviewResult({ metadata: context.metadata, state, reason: "manual_required" })
      };
    }
  }

  if (pendingScriptActions(state.workingDraft).length > 0) {
    return {
      ok: false,
      result: incompleteReviewResult({ metadata: context.metadata, state, reason: "max_rounds" })
    };
  }
  return { ok: true };
}

function applyBatchReview(context, state, review, reviewScope, batchOrdinal, before) {
  const { diagnosticCheck, parsed, patchResult } = review;
  const previousPatchesByPath = new Map(state.acceptedPatches.map((patch) => [patch.path, patch]));
  const previousPatchPaths = new Set(state.acceptedPatches.map((patch) => patch.path));
  const supersededPatchPaths = patchResult.acceptedPatches
    .map((patch) => patch.path)
    .filter((path) => previousPatchPaths.has(path));
  const supersededPatches = patchResult.acceptedPatches
    .filter((patch) => previousPatchesByPath.has(patch.path))
    .map((patch) => ({
      path: patch.path,
      previous: previousPatchesByPath.get(patch.path),
      replacement: patch
    }));
  const mergedPatches = mergeAcceptedPatches(state.acceptedPatches, patchResult.acceptedPatches);
  const cumulativePatchResult = applyEvidenceBackedPatches(context.dslDraft, mergedPatches, {
    sourceRefs: collectSourceRefs(context.sourceDraft)
  });
  if (!cumulativePatchResult.ok) {
    return {
      ok: false,
      result: blockedResultWithState({
        ...context.metadata,
        stage: "agent-review.patch-validation",
        diagnostics: cumulativePatchResult.diagnostics,
        rejectedPatches: cumulativePatchResult.rejectedPatches,
        repairAttempts: state.repairHistory.length,
        repairHistory: state.repairHistory
      }, state)
    };
  }

  state.workingDraft = cumulativePatchResult.dslDraft;
  state.acceptedPatches.splice(0, state.acceptedPatches.length, ...mergedPatches);
  state.summaries.push(parsed.response.summary);
  state.diagnosticCount += parsed.response.diagnostics.length;
  appendUniqueDiagnostics(state.reviewWarnings, diagnosticCheck.warnings);
  const after = actionStateSnapshot(state.workingDraft, reviewScope.actionIndexes);
  state.batches.push({
    batchOrdinal,
    actionIndexes: reviewScope.actionIndexes,
    actionIds: reviewScope.actionIds,
    acceptedPatchCount: patchResult.acceptedPatches.length,
    effectivePatchCount: state.acceptedPatches.length,
    acceptedPatchPaths: patchResult.acceptedPatches.map((patch) => patch.path),
    supersededPatchPaths,
    supersededPatches,
    warnings: clone(diagnosticCheck.warnings),
    reviewer: state.reviewerAudit,
    before,
    after
  });
  for (const action of after) {
    if (action.translationStatus !== "needs_review") continue;
    state.attemptsByActionIndex.set(
      action.actionIndex,
      (state.attemptsByActionIndex.get(action.actionIndex) || 0) + 1
    );
  }
  state.includeFormTargets = false;
  return { ok: true, after };
}

async function runAgentReviewBatch({
  provider,
  metadata,
  sourceDraft,
  dslDraft,
  reviewScope,
  batchOrdinal,
  maxRepairAttempts,
  repairHistory
}) {
  const firstResponse = await provider.review({ sourceDraft, dslDraft, reviewScope });
  if (!firstResponse.ok) {
    return {
      ok: false,
      blockedInput: {
        ...metadata,
        ...firstResponse,
        diagnostics: firstResponse.diagnostics || []
      }
    };
  }

  let providerResponse = firstResponse;
  let review = evaluateProviderReviewResult(sourceDraft, dslDraft, providerResponse, metadata, reviewScope);
  for (let attempt = 1; !review.ok && review.repairable && attempt <= maxRepairAttempts; attempt += 1) {
    if (typeof provider.repairReviewResponse !== "function") break;
    repairHistory.push(repairHistoryEntry(review, attempt, batchOrdinal, reviewScope, repairHistory.length + 1));
    const repairResponse = await provider.repairReviewResponse({
      sourceDraft,
      dslDraft,
      reviewScope,
      rawText: providerResponse.rawText,
      diagnostics: review.diagnostics,
      rejectedPatches: review.rejectedPatches || [],
      attempt
    });
    if (!repairResponse.ok) {
      return {
        ok: false,
        blockedInput: {
          ...metadata,
          ...repairResponse,
          diagnostics: repairResponse.diagnostics || []
        }
      };
    }
    providerResponse = repairResponse;
    review = evaluateProviderReviewResult(sourceDraft, dslDraft, providerResponse, metadata, reviewScope);
  }

  if (!review.ok) {
    return { ok: false, blockedInput: review.blockedInput };
  }
  return { ok: true, providerResponse, review };
}
