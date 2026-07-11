import { hmacSha256Digest, secureDigestEqual, sha256Digest } from "./digest.js";
import {
  COMPONENT_CATALOG,
  CONTROL_EVENTS_CATALOG,
  FUNCTION_CATALOG,
  JS_METHOD_CATALOG,
  MK_JS_SNIPPETS_CATALOG,
  VALIDATION_POLICY
} from "../dsl/catalogs.js";
import { MIGRATION_DSL_VERSION } from "../translator/dsl-draft.js";
import { SOURCE_DRAFT_VERSION } from "../translator/source-draft.js";
import { JSP_TRANSLATION_PLAYBOOK } from "./playbook.js";

export const AGENT_REVIEW_CHECKPOINT_VERSION = "1";
export const AGENT_REVIEW_BATCH_CONTRACT_VERSION = "agent-review-batches.v1";
export const AGENT_REVIEW_PATCH_VALIDATOR_VERSION = "agent-review-patch-validator.v3";
const CHECKPOINT_STATUSES = new Set(["partial", "complete"]);
const MIN_SIGNING_KEY_LENGTH = 32;

export function createReviewCheckpoint(input) {
  if (!isValidCheckpointSigningKey(input.signingKey)) {
    throw new Error(`Agent Review checkpoint signing key must contain at least ${MIN_SIGNING_KEY_LENGTH} characters.`);
  }
  const acceptedPatches = clone(input.acceptedPatches || []);
  const inputDigests = {
    sourceDraft: sha256Digest(input.sourceDraft),
    originalDslDraft: sha256Digest(input.originalDslDraft)
  };
  const contract = reviewContract(input);
  const checkpoint = {
    artifact: "agent-review-checkpoint",
    version: AGENT_REVIEW_CHECKPOINT_VERSION,
    status: input.status || "partial",
    cacheKey: sha256Digest({
      checkpointVersion: AGENT_REVIEW_CHECKPOINT_VERSION,
      inputDigests,
      reviewContractDigest: contract.reviewContractDigest
    }),
    inputDigests,
    contract,
    acceptedPatches,
    patchSetDigest: sha256Digest(acceptedPatches),
    reviewedDslDraftDigest: sha256Digest(input.reviewedDslDraft),
    batches: clone(input.batches || []),
    summaries: clone(input.summaries || []),
    reviewWarnings: clone(input.reviewWarnings || []),
    diagnosticCount: input.diagnosticCount || 0,
    repairHistory: clone(input.repairHistory || []),
    reviewer: clone(input.reviewer || {})
  };
  return {
    ...checkpoint,
    auth: {
      algorithm: "hmac-sha256",
      signature: hmacSha256Digest(checkpoint, input.signingKey)
    }
  };
}

export function validateReviewCheckpoint(checkpoint, expected) {
  const diagnostics = [];
  if (!isRecord(checkpoint) || checkpoint.artifact !== "agent-review-checkpoint" || checkpoint.version !== AGENT_REVIEW_CHECKPOINT_VERSION) {
    diagnostics.push(error("agent.checkpoint.invalid", "Agent Review checkpoint artifact or version is invalid.", "/checkpoint"));
    return { ok: false, diagnostics };
  }
  if (!isValidCheckpointSigningKey(expected.signingKey)) {
    diagnostics.push(error("agent.checkpoint.signing_key_required", `Agent Review checkpoint resume requires a signing key with at least ${MIN_SIGNING_KEY_LENGTH} characters.`, "/checkpoint/auth"));
  } else if (
    checkpoint.auth?.algorithm !== "hmac-sha256" ||
    !secureDigestEqual(checkpoint.auth?.signature, hmacSha256Digest(checkpointPayload(checkpoint), expected.signingKey))
  ) {
    diagnostics.push(error("agent.checkpoint.signature_mismatch", "Agent Review checkpoint signature is missing or invalid.", "/checkpoint/auth/signature"));
  }
  if (!CHECKPOINT_STATUSES.has(checkpoint.status)) {
    diagnostics.push(error("agent.checkpoint.status_invalid", "Agent Review checkpoint status must be partial or complete.", "/checkpoint/status"));
  }
  for (const field of ["acceptedPatches", "batches", "summaries", "reviewWarnings", "repairHistory"]) {
    if (!Array.isArray(checkpoint[field])) {
      diagnostics.push(error("agent.checkpoint.shape_invalid", `Agent Review checkpoint ${field} must be an array.`, `/checkpoint/${field}`));
    }
  }
  if (Array.isArray(checkpoint.batches)) {
    checkpoint.batches.forEach((batch, index) => {
      if (!validCheckpointBatch(batch, index)) {
        diagnostics.push(error("agent.checkpoint.batch_invalid", "Agent Review checkpoint batch history is invalid.", `/checkpoint/batches/${index}`));
      }
    });
  }
  if (!Number.isInteger(checkpoint.diagnosticCount) || checkpoint.diagnosticCount < 0) {
    diagnostics.push(error("agent.checkpoint.diagnostic_count_invalid", "Agent Review checkpoint diagnosticCount must be a non-negative integer.", "/checkpoint/diagnosticCount"));
  }
  if (!validReviewer(checkpoint.reviewer)) {
    diagnostics.push(error("agent.checkpoint.reviewer_invalid", "Agent Review checkpoint must record its reviewer provider, prompt version, and review time.", "/checkpoint/reviewer"));
  }
  compareDigest(diagnostics, "sourceDraft", checkpoint.inputDigests?.sourceDraft, sha256Digest(expected.sourceDraft));
  compareDigest(diagnostics, "originalDslDraft", checkpoint.inputDigests?.originalDslDraft, sha256Digest(expected.originalDslDraft));
  compareDigest(diagnostics, "patchSet", checkpoint.patchSetDigest, sha256Digest(checkpoint.acceptedPatches || []));
  const expectedContract = reviewContract(expected);
  const expectedCacheKey = sha256Digest({
    checkpointVersion: AGENT_REVIEW_CHECKPOINT_VERSION,
    inputDigests: {
      sourceDraft: sha256Digest(expected.sourceDraft),
      originalDslDraft: sha256Digest(expected.originalDslDraft)
    },
    reviewContractDigest: expectedContract.reviewContractDigest
  });
  if (checkpoint.cacheKey !== expectedCacheKey) {
    diagnostics.push(error("agent.checkpoint.cache_key_mismatch", "Agent Review checkpoint cache key does not match the current inputs and review contract.", "/checkpoint/cacheKey", {
      expected: expectedCacheKey,
      actual: checkpoint.cacheKey
    }));
  }
  if (!isRecord(checkpoint.contract) ||
      sha256Digest(checkpoint.contract) !== sha256Digest(expectedContract) ||
      checkpoint.contract?.reviewContractDigest !== expectedContract.reviewContractDigest ||
      checkpoint.contract?.promptVersion !== expected.promptVersion ||
      checkpoint.contract?.batchContractVersion !== AGENT_REVIEW_BATCH_CONTRACT_VERSION ||
      checkpoint.contract?.batchSize !== expected.batchSize ||
      checkpoint.contract?.maxAttemptsPerAction !== expected.maxAttemptsPerAction) {
    diagnostics.push(error("agent.checkpoint.contract_mismatch", "Agent Review checkpoint contract does not match the current review run.", "/checkpoint/contract", {
      expected: expectedContract,
      actual: checkpoint.contract
    }));
  }
  return diagnostics.length
    ? { ok: false, diagnostics }
    : { ok: true, checkpoint: clone(checkpoint) };
}

export function isValidCheckpointSigningKey(value) {
  return typeof value === "string" && value === value.trim() && value.length >= MIN_SIGNING_KEY_LENGTH;
}

function reviewContract(input) {
  const manifest = {
    promptVersion: input.promptVersion,
    patchValidatorVersion: AGENT_REVIEW_PATCH_VALIDATOR_VERSION,
    batchContractVersion: AGENT_REVIEW_BATCH_CONTRACT_VERSION,
    batchSize: input.batchSize,
    maxAttemptsPerAction: input.maxAttemptsPerAction,
    sourceDraftVersion: SOURCE_DRAFT_VERSION,
    migrationDslVersion: MIGRATION_DSL_VERSION,
    playbook: contentRef(JSP_TRANSLATION_PLAYBOOK),
    catalogs: {
      components: contentRef(COMPONENT_CATALOG),
      controlEvents: contentRef(CONTROL_EVENTS_CATALOG),
      functions: contentRef(FUNCTION_CATALOG),
      jsMethods: contentRef(JS_METHOD_CATALOG),
      targetApis: contentRef(MK_JS_SNIPPETS_CATALOG),
      validationPolicy: contentRef(VALIDATION_POLICY)
    }
  };
  return {
    ...manifest,
    reviewContractDigest: sha256Digest(manifest)
  };
}

function contentRef(value) {
  return {
    id: value?.id,
    version: value?.version,
    digest: sha256Digest(value)
  };
}

export function validateReviewedDraftDigest(checkpoint, reviewedDslDraft) {
  const actual = sha256Digest(reviewedDslDraft);
  if (checkpoint.reviewedDslDraftDigest === actual) return { ok: true };
  return {
    ok: false,
    diagnostics: [error("agent.checkpoint.reviewed_dsl_mismatch", "Replayed checkpoint patches did not reproduce the recorded reviewed DSL Draft.", "/checkpoint/reviewedDslDraftDigest", {
      expected: checkpoint.reviewedDslDraftDigest,
      actual
    })]
  };
}

function compareDigest(diagnostics, name, actual, expected) {
  if (actual === expected) return;
  diagnostics.push(error("agent.checkpoint.digest_mismatch", `Agent Review checkpoint ${name} digest does not match.`, `/checkpoint/${name}Digest`, {
    expected,
    actual
  }));
}

function checkpointPayload(checkpoint) {
  const { auth: _auth, ...payload } = checkpoint;
  return payload;
}

function validCheckpointBatch(batch, index) {
  if (!isRecord(batch) || batch.batchOrdinal !== index + 1) return false;
  if (!Array.isArray(batch.actionIndexes) || batch.actionIndexes.some((value) => !Number.isInteger(value) || value < 0)) return false;
  if (!Array.isArray(batch.actionIds) || batch.actionIds.some((value) => !nonEmptyString(value))) return false;
  if (!Number.isInteger(batch.acceptedPatchCount) || batch.acceptedPatchCount < 0) return false;
  if (!Number.isInteger(batch.effectivePatchCount) || batch.effectivePatchCount < 0) return false;
  for (const field of ["acceptedPatchPaths", "supersededPatchPaths", "supersededPatches", "warnings", "before", "after"]) {
    if (!Array.isArray(batch[field])) return false;
  }
  if (batch.acceptedPatchPaths.some((value) => !nonEmptyString(value))) return false;
  if (batch.supersededPatchPaths.some((value) => !nonEmptyString(value))) return false;
  if (batch.supersededPatches.some((entry) => (
    !isRecord(entry) ||
    !nonEmptyString(entry.path) ||
    !isRecord(entry.previous) || entry.previous.path !== entry.path ||
    !isRecord(entry.replacement) || entry.replacement.path !== entry.path
  ))) return false;
  if (![...batch.before, ...batch.after].every(validActionState)) return false;
  return validReviewer(batch.reviewer);
}

function validActionState(value) {
  return isRecord(value) &&
    Number.isInteger(value.actionIndex) && value.actionIndex >= 0 &&
    nonEmptyString(value.actionId) && nonEmptyString(value.translationStatus);
}

function validReviewer(value) {
  return isRecord(value) &&
    nonEmptyString(value.provider) &&
    nonEmptyString(value.promptVersion) &&
    nonEmptyString(value.reviewedAt);
}

function error(code, message, path, details) {
  return { level: "error", code, message, path, details };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
