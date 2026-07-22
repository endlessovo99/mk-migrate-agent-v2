import { createHash } from "node:crypto";

export const DETERMINISTIC_SCRIPT_BRANCH_PROOF_VERSION = 2;

const CLOSED_DETERMINISTIC_SCRIPT_BASES = new Set([
  "deterministic-allowance-calculation",
  "deterministic-calculation-assignment",
  "deterministic-clamped-detail-aggregate",
  "deterministic-conditional-total-uppercase",
  "deterministic-detail-row-expansion",
  "deterministic-detail-lookup-calculation",
  "deterministic-detail-threshold-calculation",
  "deterministic-finance-detail-generation",
  "deterministic-grouped-detail-calculation",
  "deterministic-person-text-calculation"
]);

export function buildDeterministicScriptBranchProof(action) {
  const basis = deterministicBasis(action);
  if (!basis || !hasSourceRecipeEvidence(action, basis)) return undefined;
  const payload = proofPayload(action, basis);
  return {
    version: DETERMINISTIC_SCRIPT_BRANCH_PROOF_VERSION,
    basis,
    functionSha256: sha256(String(action?.function || "")),
    identitySha256: sha256(canonicalJson(payload))
  };
}

export function inspectDeterministicScriptBranchProof(action, options = {}) {
  const proof = action?.deterministicBranchProof;
  if (proof === undefined) return { ok: false, reason: "deterministic_branch_proof_missing" };
  if (!isRecord(proof)) return { ok: false, reason: "deterministic_branch_proof_type_invalid" };
  if (proof.version !== DETERMINISTIC_SCRIPT_BRANCH_PROOF_VERSION) {
    return { ok: false, reason: "deterministic_branch_proof_version_invalid" };
  }
  const basis = deterministicBasis(action);
  if (!basis || proof.basis !== basis) {
    return { ok: false, reason: "deterministic_branch_proof_basis_mismatch" };
  }
  if (!hasSourceRecipeEvidence(action, basis)) {
    return { ok: false, reason: "deterministic_branch_source_evidence_missing" };
  }
  const expected = buildDeterministicScriptBranchProof(action);
  if (proof.functionSha256 !== expected.functionSha256) {
    return { ok: false, reason: "deterministic_branch_function_changed" };
  }
  if (proof.identitySha256 !== expected.identitySha256) {
    return { ok: false, reason: "deterministic_branch_identity_changed" };
  }
  const residualClosure = inspectManualResidualClosures(
    action,
    options.calculationDecisions
  );
  if (!residualClosure.ok) return residualClosure;
  return { ok: true, basis, expected };
}

export function hasVerifiedDeterministicScriptBranchProof(action, options = {}) {
  return inspectDeterministicScriptBranchProof(action, options).ok;
}

export function claimsDeterministicScriptTranslation(action) {
  return (Array.isArray(action?.functionMappings) ? action.functionMappings : [])
    .some((mapping) => (
      typeof mapping?.basis === "string" && mapping.basis.startsWith("deterministic-")
    ));
}

export function deterministicManualResidualDecisionId(action, residual) {
  const sourceKey = String(action?.sourceRefs?.[0] || action?.id || "action")
    .replace(/[^A-Za-z0-9_.-]+/gu, "-");
  return `calculation.manual.${sourceKey}.${residual?.code || "residual"}`;
}

export function deterministicManualResidualDecisionIds(action) {
  return uniqueStrings((action?.functionMappings || [])
    .flatMap((mapping) => mapping?.manualResiduals || [])
    .map((residual) => deterministicManualResidualDecisionId(action, residual)));
}

function deterministicBasis(action) {
  const mappings = Array.isArray(action?.functionMappings) ? action.functionMappings : [];
  const residuals = Array.isArray(action?.coverage?.residuals) ? action.coverage.residuals : undefined;
  const bases = [...new Set(mappings.map((mapping) => mapping?.basis))];
  if (
    action?.translationStatus !== "mapped" ||
    action?.coverage?.status !== "translated" ||
    residuals?.length !== 0 ||
    mappings.length === 0 ||
    bases.length !== 1 ||
    !CLOSED_DETERMINISTIC_SCRIPT_BASES.has(bases[0]) ||
    mappings.some((mapping) => !closedMappingEvidence(mapping))
  ) return undefined;
  return bases[0];
}

function closedMappingEvidence(mapping) {
  const manualResiduals = mapping?.manualResiduals;
  if (mapping?.reviewRequired === false) {
    return manualResiduals === undefined ||
      (Array.isArray(manualResiduals) && manualResiduals.length === 0);
  }
  return mapping?.reviewRequired === true &&
    Array.isArray(manualResiduals) &&
    manualResiduals.length > 0 &&
    manualResiduals.every((residual) => (
      isRecord(residual) &&
      nonEmptyString(residual.code) &&
      nonEmptyString(residual.reason)
    ));
}

function inspectManualResidualClosures(action, calculationDecisions) {
  const residuals = (action?.functionMappings || [])
    .flatMap((mapping) => mapping?.manualResiduals || []);
  if (!residuals.length) return { ok: true };
  if (!Array.isArray(calculationDecisions)) {
    return { ok: false, reason: "deterministic_manual_residual_decisions_missing" };
  }
  for (const residual of residuals) {
    const decisionId = deterministicManualResidualDecisionId(action, residual);
    const decision = calculationDecisions.find((candidate) => candidate?.id === decisionId);
    if (
      decision?.classification !== "manual" ||
      decision?.code !== residual.code ||
      decision?.reason !== residual.reason ||
      !sameStrings(decision?.sourceRefs, action?.sourceRefs)
    ) {
      return {
        ok: false,
        reason: "deterministic_manual_residual_decision_mismatch",
        decisionId
      };
    }
  }
  return { ok: true };
}

function hasSourceRecipeEvidence(action, basis) {
  if (basis === "deterministic-calculation-assignment") {
    return nonEmptyString(action?.sourceActionKey) &&
      Array.isArray(action?.sourceRefs) && action.sourceRefs.length > 0;
  }
  if (basis === "deterministic-detail-row-expansion") {
    return Array.isArray(action?.sourceRefs) && action.sourceRefs.length > 0 &&
      nonEmptyString(action?.semanticHints?.targetDetailTableId);
  }
  const ranges = action?.semanticHints?.coveredCalculationRanges;
  return Array.isArray(ranges) && ranges.length > 0 && ranges.every((range) => (
    isRecord(range) &&
    nonEmptyString(range.sourceRef) &&
    nonEmptyString(range.name) &&
    Number.isInteger(range.start) && range.start >= 0 &&
    Number.isInteger(range.end) && range.end > range.start &&
    Array.isArray(action?.sourceRefs) && action.sourceRefs.includes(range.sourceRef)
  ));
}

function proofPayload(action, basis) {
  return {
    basis,
    event: action?.event,
    scope: action?.scope,
    controlId: action?.controlId,
    tableId: action?.tableId,
    sourceRefs: action?.sourceRefs,
    sourceActionKey: action?.sourceActionKey,
    coveredCalculationRanges: action?.semanticHints?.coveredCalculationRanges,
    functionMappings: action?.functionMappings,
    coverage: action?.coverage,
    functionSha256: sha256(String(action?.function || ""))
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(nonEmptyString))];
}

function sameStrings(left, right) {
  const leftValues = uniqueStrings(left).sort();
  const rightValues = uniqueStrings(right).sort();
  return leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index]);
}
