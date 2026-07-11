import { checkTrust, createTrustedMigrationDsl } from "../dsl/trust.js";
import { sha256Digest } from "./digest.js";
import { redactSecrets } from "./provider.js";
import {
  createRunCheckpoint,
  pruneUndefined,
  summarizeScriptTranslation,
  uniqueBatchReviewers
} from "./run-support.js";

export async function completeAgentReview(context, state, cumulativePatchResult) {
  const reviewer = state.reviewerAudit || context.metadata;
  const reusedWithoutProvider = context.resumeRequested && !state.providerCalled;
  const effectiveReviewedAt = reviewer.reviewedAt || context.reviewedAt;
  const reviewers = uniqueBatchReviewers(state.batches);
  const scriptTranslation = summarizeScriptTranslation(state.workingDraft.scripts);
  const reuseAudit = reusedWithoutProvider ? { reusedAt: context.reviewedAt } : {};
  const agentReview = {
    provider: reviewer.provider || context.metadata.provider || "openai",
    baseUrl: reviewer.baseUrl || context.metadata.baseUrl || "",
    model: reviewer.model || context.metadata.model || "",
    promptVersion: state.promptVersion,
    reviewedAt: effectiveReviewedAt,
    ...reuseAudit,
    summary: state.summaries.join(" "),
    patchCount: state.acceptedPatches.length,
    diagnosticCount: state.diagnosticCount,
    batchCount: state.batches.length,
    scriptTranslation,
    reviewers
  };

  const trusted = createTrustedMigrationDsl(context.sourceDraft, state.workingDraft, {
    externalAgentReviewed: true,
    reviewerName: context.reviewerName,
    checkedAt: context.reviewedAt,
    sourceDraftDigest: sha256Digest(context.sourceDraft),
    dslDraftDigest: sha256Digest(state.workingDraft),
    decisions: cumulativePatchResult.decisions,
    agentReview,
    reviewWarnings: state.reviewWarnings
  });
  const trustCheck = checkTrust(context.sourceDraft, trusted);
  if (!trustCheck.ok) {
    return {
      ok: false,
      status: "blocked",
      dslDraft: state.workingDraft,
      checkpoint: state.latestCheckpoint,
      report: pruneUndefined({
        ok: false,
        status: "blocked",
        stage: "agent-review.trust-validation",
        provider: agentReview.provider,
        baseUrl: agentReview.baseUrl,
        model: agentReview.model,
        promptVersion: state.promptVersion,
        diagnostics: trustCheck.diagnostics,
        acceptedPatchCount: state.acceptedPatches.length,
        diagnosticCount: state.diagnosticCount,
        batchCount: state.batches.length,
        batches: state.batches,
        reviewers,
        scriptTranslation,
        rawResponsePreview: state.latestProviderResponse?.rawResponsePreview
          ? redactSecrets(state.latestProviderResponse.rawResponsePreview)
          : undefined,
        repairAttempts: state.repairHistory.length,
        repairHistory: state.repairHistory
      })
    };
  }

  const completeCheckpoint = createRunCheckpoint("complete", context, state);
  if (typeof context.onCheckpoint === "function") {
    await context.onCheckpoint(completeCheckpoint);
  }

  const report = {
    ok: true,
    status: trustCheck.status,
    stage: "agent-review.complete",
    provider: agentReview.provider,
    baseUrl: agentReview.baseUrl,
    model: agentReview.model,
    promptVersion: state.promptVersion,
    reviewedAt: effectiveReviewedAt,
    ...reuseAudit,
    artifact: trusted.artifact,
    diagnostics: trustCheck.diagnostics,
    acceptedPatchCount: state.acceptedPatches.length,
    diagnosticCount: state.diagnosticCount,
    batchCount: state.batches.length,
    batches: state.batches,
    reviewers,
    scriptTranslation,
    repairAttempts: state.repairHistory.length,
    repairHistory: state.repairHistory
  };

  return {
    ok: true,
    status: trustCheck.status,
    dsl: trusted,
    checkpoint: completeCheckpoint,
    report
  };
}
