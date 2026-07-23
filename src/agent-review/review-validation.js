import { checkDraft } from "../dsl/checks.js";
import { FIELD_TYPES } from "../dsl/schema.js";
import { nativeFormRuleBelongsToAction } from "../dsl/native-form-rule-projection.js";
import { inspectMappedScriptBranchProvenance } from "../dsl/script-branch-provenance.js";
import { analyzeScriptFunction, validateSetFieldAttrTargets } from "../dsl/scripts.js";
import { AGENT_REVIEW_PROMPT_VERSION } from "./prompt.js";
import { classifyActionRowMarkers } from "./row-marker-policy.js";
import {
  validateAssignmentBranchSemantics,
  validateRowMarkerBranchSemantics
} from "./script-semantic-closure.js";

const TOP_LEVEL_KEYS = new Set(["summary", "patches", "diagnostics"]);
const PATCH_KEYS = ["op", "path", "value", "sourceRefs", "evidence", "confidence", "rationale"];
const DIAGNOSTIC_LEVELS = new Set(["info", "warning", "error", "blocked"]);
const SCRIPT_COVERAGE_STATUSES = new Set(["none", "partial", "uncovered", "covered", "translated"]);

export function evaluateProviderReviewResult(sourceDraft, dslDraft, providerResult, metadata, reviewScope) {
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
    sourceRefs: collectSourceRefs(sourceDraft),
    sourceDraft,
    reviewScope,
    normalizeSourceRefs: true
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
      repairable: true
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
  const sourceDraft = options.sourceDraft;
  const reviewScope = options.reviewScope;

  patches.forEach((patch, index) => {
    const normalizedPatch = options.normalizeSourceRefs === true
      ? normalizePatchSourceRefs(patch, dslDraft)
      : patch;
    const result = validatePatch(normalizedPatch, index, dslDraft, sourceRefs, seenPaths, reviewScope);
    if (!result.ok) {
      diagnostics.push(...result.diagnostics);
      rejectedPatches.push(patchSummary(normalizedPatch, index, result.diagnostics));
      return;
    }
    seenPaths.add(normalizedPatch.path);
    acceptedPatches.push(normalizedPatch);
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

  const rowMarkerDiagnostics = validateRowMarkerClosures(
    dslDraft,
    patchedDraft,
    acceptedPatches,
    sourceDraft
  );
  const residualDiagnostics = validateDeterministicResidualClosures(
    dslDraft,
    patchedDraft,
    acceptedPatches
  );
  const branchProvenanceDiagnostics = validateActionBranchProvenanceClosures(
    dslDraft,
    patchedDraft,
    acceptedPatches
  );
  const closureDiagnostics = [
    ...rowMarkerDiagnostics,
    ...residualDiagnostics,
    ...branchProvenanceDiagnostics
  ];
  if (closureDiagnostics.length) {
    return {
      ok: false,
      diagnostics: closureDiagnostics,
      rejectedPatches: acceptedPatches
        .map((patch, index) => ({ patch, index }))
        .filter(({ patch }) => /^\/scripts\/actions\/\d+\//.test(patch.path))
        .map(({ patch, index }) => patchSummary(patch, index, closureDiagnostics))
    };
  }

  return {
    ok: true,
    dslDraft: patchedDraft,
    acceptedPatches,
    rejectedPatches,
    decisions
  };
}

function validateActionBranchProvenanceClosures(dslDraft, patchedDraft, patches) {
  const touchedActionIndexes = new Set(patches.flatMap((patch) => {
    const match = String(patch?.path || "").match(/^\/scripts\/actions\/(\d+)\//);
    return match ? [Number(match[1])] : [];
  }));
  const diagnostics = [];

  for (const actionIndex of touchedActionIndexes) {
    const sourceAction = dslDraft?.scripts?.actions?.[actionIndex];
    const reviewedAction = patchedDraft?.scripts?.actions?.[actionIndex];
    if (!sourceAction?.branchProvenance) {
      const semanticClaim = (reviewedAction?.functionMappings || []).some((mapping) => (
        ["semantic-translation", "native-form-rule", "static-form-prop"].includes(mapping?.basis)
      ));
      if (
        !sourceAction?.deterministicBranchProof &&
        ["onChange", "onLoad"].includes(sourceAction?.event) &&
        ["mapped", "omitted"].includes(reviewedAction?.translationStatus) &&
        semanticClaim
      ) {
        diagnostics.push(error(
          "agent.patch.branch_provenance_missing",
          "An onChange/onLoad action without immutable source provenance must remain needs_review.",
          `/scripts/actions/${actionIndex}/translationStatus`,
          { actionIndex, actionId: sourceAction.id, event: sourceAction.event }
        ));
      }
      continue;
    }
    let inspection;
    if (
      reviewedAction?.translationStatus === "omitted" &&
      sourceAction.branchProvenance.status === "unproven"
    ) {
      inspection = {
        ok: false,
        reason: "source_branch_provenance_unproven",
        expected: sourceAction.branchProvenance
      };
    } else if (reviewedAction?.translationStatus === "mapped") {
      inspection = inspectMappedScriptBranchProvenance(
        reviewedAction,
        sourceAction.branchProvenance
      );
    } else continue;
    if (inspection.ok) continue;
    if (nativeRowBranchesOwnAllReviewedConditions(sourceAction, reviewedAction, inspection)) {
      continue;
    }
    diagnostics.push(error(
      "agent.patch.condition_operand_provenance_unverified",
      "A reviewed mapped script may preserve source branches only when every condition operand is statically traceable to the action-local source: onChange uses its input value and onLoad uses the original source field read.",
      `/scripts/actions/${actionIndex}/function`,
      {
        actionIndex,
        actionId: sourceAction.id,
        event: sourceAction.event,
        reason: inspection.reason,
        expected: inspection.expected,
        observed: inspection.observed
      }
    ));
  }
  return diagnostics;
}

function nativeRowBranchesOwnAllReviewedConditions(sourceAction, reviewedAction, inspection) {
  if (
    sourceAction?.event !== "onChange" ||
    inspection?.reason !== "target_branch_provenance_unproven" ||
    inspection?.observed?.status !== "none"
  ) return false;
  const sourceNativeRules = uniqueStrings(sourceAction?.coverage?.nativeRules || []);
  const reviewedNativeRules = uniqueStrings(reviewedAction?.coverage?.nativeRules || []);
  if (
    !sourceNativeRules.length ||
    sourceNativeRules.length !== reviewedNativeRules.length ||
    sourceNativeRules.some((ruleId) => !reviewedNativeRules.includes(ruleId))
  ) return false;
  if (extractSetFieldAttrTargets(reviewedAction?.function).length) return false;

  const residuals = Array.isArray(sourceAction?.coverage?.residuals)
    ? sourceAction.coverage.residuals
    : [];
  if (!residuals.length) return true;
  const expectedAssignments = residuals.map((residual) => {
    if (residual?.code !== "script.residual.form_rule_behavior_uncovered") return undefined;
    const match = String(residual.evidence || "").match(
      /^SetXFormFieldValueById\(\s*(["'])([^"']+)\1\s*,\s*value\s*,\s*false\s*\);?$/
    );
    return match?.[2];
  });
  if (expectedAssignments.some((target) => !target)) return false;
  const observedAssignments = extractSetValueAssignments(reviewedAction?.function);
  return expectedAssignments.every((target) => observedAssignments.some((assignment) => (
    assignment.target === target && assignment.valueSignature === "expression:value"
  )));
}

function validateDeterministicResidualClosures(dslDraft, patchedDraft, patches) {
  const protectedResidualCodes = new Set([
    "script.residual.field_value_assignment",
    "script.residual.form_rule_chain_untranslated"
  ]);
  const touchedActionIndexes = new Set(patches.flatMap((patch) => {
    const match = String(patch?.path || "").match(/^\/scripts\/actions\/(\d+)\//);
    return match ? [Number(match[1])] : [];
  }));
  const diagnostics = [];

  for (const actionIndex of touchedActionIndexes) {
    const sourceAction = dslDraft?.scripts?.actions?.[actionIndex];
    const reviewedAction = patchedDraft?.scripts?.actions?.[actionIndex];
    const protectedResiduals = (Array.isArray(sourceAction?.coverage?.residuals)
      ? sourceAction.coverage.residuals
      : []).filter((residual) => protectedResidualCodes.has(residual?.code));
    if (!protectedResiduals.length) continue;
    const reviewedResiduals = Array.isArray(reviewedAction?.coverage?.residuals)
      ? reviewedAction.coverage.residuals
      : [];
    const removedResiduals = subtractResidualEvidence(protectedResiduals, reviewedResiduals);
    if (!removedResiduals.length) continue;

    const clearedAssignments = removedResiduals.filter((residual) => (
      residual?.code === "script.residual.field_value_assignment"
    ));
    const functionText = reviewedAction?.function;
    if (
      !nonEmptyString(functionText) ||
      (clearedAssignments.length > 0 && reviewedAction?.translationStatus !== "mapped")
    ) {
      diagnostics.push(error(
        "agent.patch.deterministic_residual_omitted",
        "Agent Review must translate deterministic field-assignment or unlowered row behavior into a non-empty mapped function before clearing its residual evidence.",
        `/scripts/actions/${actionIndex}/function`,
        {
          actionIndex,
          translationStatus: reviewedAction?.translationStatus,
          residualCodes: [...new Set(removedResiduals.map((residual) => residual.code))],
          residualTargets: [...new Set(removedResiduals.map((residual) => residual.target).filter(nonEmptyString))]
        }
      ));
      continue;
    }

    if (clearedAssignments.length) {
      const assignmentCheck = validateFieldValueAssignmentClosure(
        protectedResiduals.filter((residual) => residual?.code === "script.residual.field_value_assignment"),
        functionText
      );
      if (!assignmentCheck.ok) {
        diagnostics.push(error(
          "agent.patch.field_value_assignment_incomplete",
          "A mapped script may clear field-value-assignment residuals only when its executable MKXFORM.setValue calls preserve every evidenced target/value assignment branch.",
          `/scripts/actions/${actionIndex}/function`,
          {
            actionIndex,
            missingAssignments: assignmentCheck.missingAssignments,
            observedAssignments: assignmentCheck.observedAssignments
          }
        ));
      } else {
        const semanticCheck = validateAssignmentBranchSemantics({
          sourceFunction: sourceAction?.function,
          reviewedFunction: functionText,
          residuals: protectedResiduals.filter((residual) => (
            residual?.code === "script.residual.field_value_assignment"
          ))
        });
        if (!semanticCheck.ok) {
          diagnostics.push(error(
            "agent.patch.field_value_assignment_semantics_unverified",
            "A mapped script may clear field-value-assignment residuals only when a statically verified if/else-if/else chain preserves each assignment's source branch and priority.",
            `/scripts/actions/${actionIndex}/function`,
            {
              actionIndex,
              reason: semanticCheck.reason,
              expectedConditions: semanticCheck.expectedConditions,
              observedConditions: semanticCheck.observedConditions,
              expectedBranches: semanticCheck.expectedBranches,
              observedBranches: semanticCheck.observedBranches
            }
          ));
        }
      }
    }
  }
  return diagnostics;
}

function subtractResidualEvidence(sourceResiduals, reviewedResiduals) {
  const unmatched = [...reviewedResiduals];
  return sourceResiduals.filter((sourceResidual) => {
    const matchIndex = unmatched.findIndex((reviewedResidual) => (
      sameResidualEvidence(sourceResidual, reviewedResidual)
    ));
    if (matchIndex < 0) return true;
    unmatched.splice(matchIndex, 1);
    return false;
  });
}

function sameResidualEvidence(left, right) {
  if (left?.code !== right?.code) return false;
  for (const key of ["type", "sourceRef", "target", "evidence"]) {
    if ((left?.[key] ?? undefined) !== (right?.[key] ?? undefined)) return false;
  }
  return true;
}

function validateFieldValueAssignmentClosure(residuals, functionText) {
  const expectedAssignments = residuals.map(parseResidualAssignment);
  const observedAssignments = extractSetValueAssignments(functionText);
  const unmatchedObserved = [...observedAssignments];
  const missingAssignments = [];

  for (const expected of expectedAssignments) {
    if (!expected.target || !expected.valueSignature) {
      missingAssignments.push({
        target: expected.target,
        evidence: expected.evidence,
        reason: "assignment_evidence_unparseable"
      });
      continue;
    }
    const matchIndex = unmatchedObserved.findIndex((observed) => (
      observed.target === expected.target && observed.valueSignature === expected.valueSignature
    ));
    if (matchIndex < 0) {
      missingAssignments.push({
        target: expected.target,
        evidence: expected.evidence,
        value: expected.value
      });
      continue;
    }
    unmatchedObserved.splice(matchIndex, 1);
  }

  return {
    ok: missingAssignments.length === 0,
    missingAssignments,
    observedAssignments: observedAssignments.map((assignment) => ({
      target: assignment.target,
      value: assignment.value
    }))
  };
}

function parseResidualAssignment(residual) {
  const evidence = String(residual?.evidence || "").trim();
  const match = evidence.match(/\.\s*value\s*=\s*([\s\S]+?)\s*;?$/);
  const value = match?.[1]?.trim();
  return {
    target: nonEmptyString(residual?.target) ? residual.target : undefined,
    evidence: residual?.evidence,
    value,
    valueSignature: valueExpressionSignature(value)
  };
}

function extractSetValueAssignments(functionText) {
  const source = String(functionText || "");
  const analysis = analyzeScriptFunction(source);
  return analysis.calls
    .filter((call) => call.name === "MKXFORM.setValue")
    .flatMap((call) => {
      const args = parseCallArguments(source, call.index, call.name);
      if (!args || args.length < 2) return [];
      const target = staticStringValue(args[0]);
      const valueSignature = valueExpressionSignature(args[1]);
      if (target === undefined || !valueSignature) return [];
      return [{ target, value: args[1].trim(), valueSignature }];
    });
}

function parseCallArguments(source, callIndex, callName) {
  let index = callIndex + callName.length;
  while (/\s/.test(source[index] || "")) index += 1;
  if (source[index] !== "(") return undefined;

  const args = [];
  let start = index + 1;
  let parenDepth = 1;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;

  for (index += 1; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (["'", "\"", "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (char === "(") parenDepth += 1;
    else if (char === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        args.push(source.slice(start, index).trim());
        return args;
      }
    } else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    else if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "," && parenDepth === 1 && bracketDepth === 0 && braceDepth === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  return undefined;
}

function valueExpressionSignature(expression) {
  if (!nonEmptyString(expression)) return undefined;
  const text = expression.trim().replace(/;\s*$/, "").trim();
  const stringValue = staticStringValue(text);
  if (stringValue !== undefined) return `string:${JSON.stringify(stringValue)}`;
  if (/^(?:true|false|null|undefined|-?(?:\d+(?:\.\d*)?|\.\d+))$/.test(text)) {
    return `primitive:${text}`;
  }
  return `expression:${text.replace(/\s+/g, "")}`;
}

function staticStringValue(expression) {
  if (!nonEmptyString(expression)) return undefined;
  const text = expression.trim();
  const quote = text[0];
  if (!["'", "\"", "`"].includes(quote) || text.at(-1) !== quote) return undefined;
  if (quote === "`" && text.includes("${")) return undefined;
  let result = "";
  for (let index = 1; index < text.length - 1; index += 1) {
    const char = text[index];
    if (char !== "\\") {
      result += char;
      continue;
    }
    index += 1;
    if (index >= text.length - 1) return undefined;
    const escaped = text[index];
    const simpleEscapes = {
      "0": "\0",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v"
    };
    if (Object.hasOwn(simpleEscapes, escaped)) {
      result += simpleEscapes[escaped];
    } else if (escaped === "x" && /^[0-9a-fA-F]{2}$/.test(text.slice(index + 1, index + 3))) {
      result += String.fromCharCode(Number.parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else if (escaped === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) {
      result += String.fromCharCode(Number.parseInt(text.slice(index + 1, index + 5), 16));
      index += 4;
    } else {
      result += escaped;
    }
  }
  return result;
}

function normalizePatchSourceRefs(patch, dslDraft) {
  if (!isRecord(patch) || !Array.isArray(patch.sourceRefs)) return patch;
  const target = parseAllowedPatchPath(patch.path);
  if (!target.ok) return patch;
  const expectedRefs = targetEvidenceRefs(target, dslDraft);
  if (expectedRefs.length === 0) return patch;
  const retainedRefs = patch.sourceRefs
    .filter(nonEmptyString)
    .filter((ref, index, refs) => refs.indexOf(ref) === index)
    .filter((ref) => expectedRefs.includes(ref));
  if (retainedRefs.length === 0 || retainedRefs.length === patch.sourceRefs.length) return patch;
  return {
    ...patch,
    sourceRefs: retainedRefs
  };
}

function validateRowMarkerClosures(dslDraft, patchedDraft, patches, sourceDraft) {
  if (!sourceDraft) return [];
  const touchedActionIndexes = new Set(patches.flatMap((patch) => {
    const match = String(patch?.path || "").match(/^\/scripts\/actions\/(\d+)\//);
    return match ? [Number(match[1])] : [];
  }));
  const diagnostics = [];

  for (const actionIndex of touchedActionIndexes) {
    const sourceAction = dslDraft?.scripts?.actions?.[actionIndex];
    const reviewedAction = patchedDraft?.scripts?.actions?.[actionIndex];
    if (!sourceAction || !reviewedAction) continue;
    if (!["mapped", "omitted"].includes(reviewedAction.translationStatus)) continue;

    const policy = classifyActionRowMarkers(sourceAction, dslDraft?.form, sourceDraft);
    if (policy.unresolvedMarkers.length) {
      diagnostics.push(error(
        "agent.patch.row_marker_orphan_evidence_invalid",
        "Agent Review cannot close a script action while missing row markers lack exact auditable orphan evidence.",
        `/scripts/actions/${actionIndex}/translationStatus`,
        {
          actionIndex,
          sourceRefs: sourceAction.sourceRefs || [],
          orphanRowMarkers: policy.orphanMarkers,
          unresolvedRowMarkers: policy.unresolvedMarkers
        }
      ));
      continue;
    }
    if (!policy.resolvedMarkers.length) continue;

    const resetMarkers = policy.markers.filter((marker) => (
      marker.reset === true && policy.resolvedMarkers.includes(marker.rowId)
    ));
    if (resetMarkers.length) {
      diagnostics.push(error(
        "agent.patch.row_marker_reset_untranslated",
        "Agent Review cannot close a resolved row-helper action whose reset=true side effect has no verified MK target mapping.",
        `/scripts/actions/${actionIndex}/function`,
        {
          actionIndex,
          markers: uniqueRowMarkerEvidence(resetMarkers)
        }
      ));
      continue;
    }

    const expectedEffects = expectedRowMarkerEffects(policy, dslDraft?.form);
    const observedEffects = extractSetFieldAttrEffects(reviewedAction.function);
    const nativeClosure = proveNativeRowEffectClosure({
      sourceAction,
      reviewedAction,
      formRules: dslDraft?.formRules,
      policy,
      form: dslDraft?.form,
      expectedEffects
    });
    if (nativeClosure.candidateRuleIds.length) {
      if (!nativeClosure.complete) {
        diagnostics.push(error(
          "agent.patch.row_marker_native_coverage_incomplete",
          "Native row-rule credit is all-or-nothing: every resolved row dimension must have one action-bound executable rule with complementary when/else states.",
          `/scripts/actions/${actionIndex}/coverage/nativeRules`,
          {
            actionIndex,
            candidateRuleIds: nativeClosure.candidateRuleIds,
            issues: nativeClosure.issues,
            expectedEffects,
            coveredEffects: nativeClosure.coveredEffects
          }
        ));
        continue;
      }
      const duplicateTargets = extractSetFieldAttrTargets(reviewedAction.function)
        .map((target) => nativeClosure.primaryMarkerByAlias.get(target) || target)
        .filter((target) => nativeClosure.coveredTargets.has(target));
      if (duplicateTargets.length) {
        diagnostics.push(error(
          "agent.patch.row_marker_native_effect_duplicated",
          "Residual JavaScript must not rewrite row dimensions already owned by verified native form rules.",
          `/scripts/actions/${actionIndex}/function`,
          {
            actionIndex,
            duplicateTargets: [...new Set(duplicateTargets)]
          }
        ));
      }
      continue;
    }
    const observedKeys = new Set(observedEffects.map(rowMarkerEffectKey));
    const missingEffects = expectedEffects.filter((effect) => !observedKeys.has(rowMarkerEffectKey(effect)));
    if (missingEffects.length) {
      diagnostics.push(error(
        "agent.patch.row_marker_effect_incomplete",
        "A mapped row-visibility script must preserve every evidenced show/hide and required/non-required state for each resolved row marker.",
        `/scripts/actions/${actionIndex}/function`,
        {
          actionIndex,
          missingEffects,
          observedEffects
        }
      ));
      continue;
    }

    const semanticCheck = validateRowMarkerBranchSemantics({
      sourceFunction: sourceAction.function,
      reviewedFunction: reviewedAction.function,
      resolvedMarkers: policy.resolvedMarkers,
      primaryMarkerByAlias: primaryLayoutMarkerByAlias(dslDraft?.form)
    });
    if (!semanticCheck.ok) {
      diagnostics.push(error(
        "agent.patch.row_marker_semantics_unverified",
        "A mapped row-visibility script must keep each row state associated with the same statically verified source condition branch; dead-code or unconditional state enumeration is not coverage.",
        `/scripts/actions/${actionIndex}/function`,
        {
          actionIndex,
          reason: semanticCheck.reason,
          conditionalReason: semanticCheck.conditionalReason,
          ternaryReason: semanticCheck.ternaryReason,
          conditionalDetails: semanticCheck.conditionalDetails,
          ternaryDetails: semanticCheck.ternaryDetails,
          scenario: semanticCheck.scenario,
          state: semanticCheck.state,
          expected: semanticCheck.expected,
          observed: semanticCheck.observed
        }
      ));
    }
  }

  return diagnostics;
}

function expectedRowMarkerEffects(policy, form) {
  const resolved = new Set(policy.resolvedMarkers || []);
  const primaryByAlias = primaryLayoutMarkerByAlias(form);
  const effects = [];
  const seen = new Set();
  for (const marker of policy.markers || []) {
    if (!resolved.has(marker.rowId)) continue;
    const target = primaryByAlias.get(marker.rowId) || marker.rowId;
    for (const attribute of [marker.visible ? 5 : 4, marker.required ? 3 : 6]) {
      const effect = { target, attribute };
      const key = rowMarkerEffectKey(effect);
      if (seen.has(key)) continue;
      seen.add(key);
      effects.push(effect);
    }
  }
  return effects;
}

function extractSetFieldAttrEffects(functionText) {
  const source = String(functionText || "");
  const effects = [];
  const seen = new Set();
  for (const call of analyzeScriptFunction(source).calls) {
    if (call.name !== "MKXFORM.setFieldAttr") continue;
    const args = parseCallArguments(source, call.index, call.name);
    if (!args || args.length < 2) continue;
    const target = staticStringValue(args[0]);
    if (!nonEmptyString(target)) continue;
    for (const attribute of possibleFieldAttributeValues(args[1])) {
      const effect = { target, attribute };
      const key = rowMarkerEffectKey(effect);
      if (seen.has(key)) continue;
      seen.add(key);
      effects.push(effect);
    }
  }
  return effects;
}

function extractSetFieldAttrTargets(functionText) {
  const source = String(functionText || "");
  const targets = [];
  for (const call of analyzeScriptFunction(source).calls) {
    if (call.name !== "MKXFORM.setFieldAttr") continue;
    const args = parseCallArguments(source, call.index, call.name);
    const target = args ? staticStringValue(args[0]) : undefined;
    if (nonEmptyString(target)) targets.push(target);
  }
  return targets;
}

function proveNativeRowEffectClosure({
  sourceAction,
  reviewedAction,
  formRules,
  policy,
  form,
  expectedEffects
}) {
  const candidateRuleIds = uniqueStrings(sourceAction?.coverage?.nativeRules || []);
  const primaryMarkerByAlias = primaryLayoutMarkerByAlias(form);
  const resolvedTargets = new Set((policy.resolvedMarkers || []).map((marker) => (
    primaryMarkerByAlias.get(marker) || marker
  )));
  const result = {
    candidateRuleIds,
    complete: false,
    issues: [],
    coveredEffects: [],
    coveredTargets: new Set(),
    primaryMarkerByAlias
  };
  if (!candidateRuleIds.length) return result;

  const reviewedRuleIds = new Set(reviewedAction?.coverage?.nativeRules || []);
  const rules = Array.isArray(formRules?.linkage) ? formRules.linkage : [];
  const rulesById = new Map();
  for (const rule of rules) {
    if (!rulesById.has(rule.id)) rulesById.set(rule.id, []);
    rulesById.get(rule.id).push(rule);
  }
  const ownersByDimension = new Map();
  const coveredEffects = [];

  for (const ruleId of candidateRuleIds) {
    const matches = rulesById.get(ruleId) || [];
    if (!reviewedRuleIds.has(ruleId)) {
      result.issues.push({ ruleId, reason: "reviewed_coverage_missing" });
      continue;
    }
    if (matches.length !== 1) {
      result.issues.push({ ruleId, reason: matches.length ? "rule_id_ambiguous" : "rule_missing" });
      continue;
    }
    const rule = matches[0];
    if (rule.translationStatus !== "executable" || !nativeFormRuleBelongsToAction(rule, sourceAction)) {
      result.issues.push({ ruleId, reason: "rule_not_executable_or_action_bound" });
      continue;
    }

    const whenByDimension = rowEffectsByDimension(rule.effects, primaryMarkerByAlias, resolvedTargets);
    const elseByDimension = rowEffectsByDimension(rule.else, primaryMarkerByAlias, resolvedTargets);
    const dimensions = new Set([...whenByDimension.keys(), ...elseByDimension.keys()]);
    for (const dimension of dimensions) {
      const when = whenByDimension.get(dimension) || [];
      const otherwise = elseByDimension.get(dimension) || [];
      if (when.length !== 1 || otherwise.length !== 1) {
        result.issues.push({ ruleId, dimension, reason: "when_else_not_complementary" });
        continue;
      }
      if (ownersByDimension.has(dimension)) {
        result.issues.push({
          ruleId,
          dimension,
          reason: "multiple_native_writers",
          conflictingRuleId: ownersByDimension.get(dimension)
        });
        continue;
      }
      ownersByDimension.set(dimension, ruleId);
      for (const effect of [when[0], otherwise[0]]) {
        coveredEffects.push({
          target: effect.target,
          attribute: effect.type === "visible"
            ? (effect.value ? 5 : 4)
            : (effect.value ? 3 : 6)
        });
        result.coveredTargets.add(effect.target);
      }
    }
  }

  result.coveredEffects = dedupeRowMarkerEffects(coveredEffects);
  const expectedKeys = new Set(expectedEffects.map(rowMarkerEffectKey));
  const coveredKeys = new Set(result.coveredEffects.map(rowMarkerEffectKey));
  if (
    result.issues.length === 0 &&
    expectedKeys.size === coveredKeys.size &&
    [...expectedKeys].every((key) => coveredKeys.has(key))
  ) {
    result.complete = true;
  } else if (result.issues.length === 0) {
    result.issues.push({ reason: "native_effect_set_incomplete" });
  }
  return result;
}

function rowEffectsByDimension(effects, primaryMarkerByAlias, resolvedTargets) {
  const result = new Map();
  for (const effect of Array.isArray(effects) ? effects : []) {
    if (!["visible", "required"].includes(effect?.type) || typeof effect.value !== "boolean") continue;
    const target = primaryMarkerByAlias.get(effect.target) || effect.target;
    if (!resolvedTargets.has(target)) continue;
    const dimension = `${target}:${effect.type}`;
    if (!result.has(dimension)) result.set(dimension, []);
    result.get(dimension).push({ ...effect, target });
  }
  return result;
}

function dedupeRowMarkerEffects(effects) {
  const seen = new Set();
  return effects.filter((effect) => {
    const key = rowMarkerEffectKey(effect);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function possibleFieldAttributeValues(expression) {
  const code = codeWithoutStringsAndComments(String(expression || ""));
  return [...new Set(
    [...code.matchAll(/(?:^|[^\w.])([3-6])(?=$|[^\w.])/g)].map((match) => Number(match[1]))
  )];
}

function codeWithoutStringsAndComments(source) {
  let output = "";
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        output += "\n";
      } else {
        output += " ";
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        output += "  ";
        index += 1;
      } else {
        output += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (quote) {
      if (char === "\\") {
        output += "  ";
        index += 1;
      } else if (char === quote) {
        quote = "";
        output += " ";
      } else {
        output += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      output += "  ";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      output += "  ";
      index += 1;
      continue;
    }
    if (["'", "\"", "`"].includes(char)) {
      quote = char;
      output += " ";
      continue;
    }
    output += char;
  }
  return output;
}

function primaryLayoutMarkerByAlias(form) {
  const primaryByAlias = new Map();
  for (const row of Array.isArray(form?.layout?.mkTree) ? form.layout.mkTree : []) {
    const markers = (Array.isArray(row?.sourceMarkers) ? row.sourceMarkers : [])
      .filter(nonEmptyString);
    if (!markers.length) continue;
    for (const marker of markers) primaryByAlias.set(marker, markers[0]);
  }
  return primaryByAlias;
}

function uniqueRowMarkerEvidence(markers) {
  const seen = new Set();
  return markers.filter((marker) => {
    const key = `${marker.rowId}:${marker.evidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((marker) => ({ rowId: marker.rowId, evidence: marker.evidence }));
}

function rowMarkerEffectKey(effect) {
  return `${effect.target}:${effect.attribute}`;
}

export function collectSourceRefs(value) {
  const refs = new Set();
  for (const item of walk(value)) {
    if (item.key === "sourceRef" && nonEmptyString(item.value)) refs.add(item.value);
  }
  return refs;
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

function validatePatch(patch, index, dslDraft, sourceRefs, seenPaths, reviewScope) {
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
  } else if (!patchTargetInReviewScope(target, reviewScope)) {
    diagnostics.push(error("agent.patch.path_outside_review_scope", "Agent patch path is outside the current review batch scope.", `${path}/path`, {
      path: patch.path,
      reviewScope
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
    if (target.ok) {
      diagnostics.push(...validatePatchTargetEvidence(patch, target, dslDraft, path));
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
  if (target.property === "function" && typeof patch.value === "string" && patch.value.trim()) {
    const setFieldAttrIssues = validateSetFieldAttrTargets(patch.value, dslDraft?.form);
    if (setFieldAttrIssues.length) {
      return [error("agent.patch.set_field_attr_target_invalid", "Script function patches must use MKXFORM.setFieldAttr only with main field ids or layout sourceMarkers, not detail-table ids or ${table:...} placeholders.", `${path}/value`, {
        issues: setFieldAttrIssues,
        actionIndex: target.actionIndex
      })];
    }
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
    } else {
      diagnostics.push(...validateNativeRulePatchCoverage(
        patch.value.nativeRules,
        patch.value.status,
        action,
        dslDraft?.formRules,
        `${path}/value/nativeRules`
      ));
    }
    diagnostics.push(...validateStaticPropPatchCoverage(
      patch.value.staticProps,
      dslDraft?.form,
      `${path}/value/staticProps`,
      action?.coverage?.staticProps
    ));
    if (patch.value.residuals !== undefined && !Array.isArray(patch.value.residuals)) {
      diagnostics.push(error("agent.patch.value_coverage_residuals_invalid", "Script coverage.residuals must be an array when present.", `${path}/value/residuals`));
    }
    return diagnostics;
  }
  return [];
}

function validateNativeRulePatchCoverage(proposedNativeRules, proposedStatus, action, formRules, path) {
  const currentNativeRules = Array.isArray(action?.coverage?.nativeRules)
    ? action.coverage.nativeRules
    : [];
  if (!Array.isArray(proposedNativeRules)) {
    return currentNativeRules.length
      ? [error(
          "agent.patch.native_rules_deterministic_evidence_changed",
          "Agent Review must preserve every deterministically identified native form rule.",
          path,
          { current: currentNativeRules, proposed: proposedNativeRules }
        )]
      : [];
  }

  const diagnostics = [];
  const invalidIds = proposedNativeRules.filter((ruleId) => !nonEmptyString(ruleId));
  if (invalidIds.length) {
    diagnostics.push(error(
      "agent.patch.native_rule_id_invalid",
      "Script coverage.nativeRules entries must be non-empty rule ids.",
      path,
      { invalidIds }
    ));
  }
  const proposedSet = new Set(proposedNativeRules.filter(nonEmptyString));
  if (proposedSet.size !== proposedNativeRules.length) {
    diagnostics.push(error(
      "agent.patch.native_rule_id_duplicate",
      "Script coverage.nativeRules must not contain duplicate rule ids.",
      path
    ));
  }

  const missingDeterministic = currentNativeRules.filter((ruleId) => !proposedSet.has(ruleId));
  if (missingDeterministic.length) {
    diagnostics.push(error(
      "agent.patch.native_rules_deterministic_evidence_changed",
      "Agent Review must preserve every deterministically identified native form rule.",
      path,
      { current: currentNativeRules, proposed: proposedNativeRules, missing: missingDeterministic }
    ));
  }

  const eligibleRules = (Array.isArray(formRules?.linkage) ? formRules.linkage : [])
    .filter((rule) => {
      if (
        rule?.translationStatus !== "executable" ||
        !nativeFormRuleBelongsToAction(rule, action)
      ) return false;
      return true;
    });
  const eligibleById = new Map(eligibleRules.map((rule) => [rule.id, rule]));
  const incompatible = proposedNativeRules.filter((ruleId) => !eligibleById.has(ruleId));
  if (incompatible.length) {
    diagnostics.push(error(
      "agent.patch.native_rule_action_mismatch",
      "Native form-rule coverage must belong to the same control onChange action and source evidence.",
      path,
      {
        actionId: action?.id,
        event: action?.event,
        controlId: action?.controlId,
        incompatible
      }
    ));
  }

  if (proposedStatus === "covered" && proposedNativeRules.length) {
    const missingEligible = eligibleRules
      .map((rule) => rule.id)
      .filter((ruleId) => !proposedSet.has(ruleId));
    if (missingEligible.length) {
      diagnostics.push(error(
        "agent.patch.native_rules_incomplete",
        "Covered native form-rule evidence must include every executable rule for the same control action.",
        path,
        { missing: missingEligible }
      ));
    }
  }
  return diagnostics;
}

function getScriptAction(dslDraft, actionIndex) {
  if (!Number.isInteger(actionIndex)) return undefined;
  const actions = dslDraft?.scripts?.actions;
  return Array.isArray(actions) ? actions[actionIndex] : undefined;
}

function validateStaticPropPatchCoverage(staticProps, form, path, currentStaticProps) {
  const hasCurrentStaticProps = Array.isArray(currentStaticProps) && currentStaticProps.length > 0;
  if (staticProps === undefined) {
    return hasCurrentStaticProps
      ? [staticPropsChangedError(path, currentStaticProps, staticProps)]
      : [];
  }
  if (!Array.isArray(staticProps)) {
    return [error("agent.patch.static_props_type", "Script coverage.staticProps patches must be arrays.", path)];
  }

  const diagnostics = [];
  if (
    hasCurrentStaticProps &&
    JSON.stringify(staticProps) !== JSON.stringify(currentStaticProps)
  ) {
    diagnostics.push(staticPropsChangedError(path, currentStaticProps, staticProps));
  }
  staticProps.forEach((entry, index) => {
    const entryPath = `${path}/${index}`;
    if (!isRecord(entry)) {
      diagnostics.push(error("agent.patch.static_prop_type", "Static-property coverage entries must be objects.", entryPath));
      return;
    }
    if (entry.prop !== "required" || entry.value !== true) {
      diagnostics.push(error("agent.patch.static_prop_unsupported", "Agent Review static coverage currently supports only { prop: \"required\", value: true }.", entryPath, {
        prop: entry.prop,
        value: entry.value
      }));
      return;
    }
    const field = (Array.isArray(form?.fields) ? form.fields : [])
      .find((candidate) => candidate?.id === entry.fieldId && candidate?.type !== "detailTable");
    if (!field) {
      diagnostics.push(error("agent.patch.static_prop_field_missing", "Static-property coverage must reference an existing ordinary form field.", `${entryPath}/fieldId`, {
        fieldId: entry.fieldId
      }));
      return;
    }
    if (field.props?.required !== true) {
      diagnostics.push(error("agent.patch.static_prop_not_satisfied", "Static required coverage must reference a field whose current DSL props.required is true.", entryPath, {
        fieldId: entry.fieldId,
        actual: field.props?.required
      }));
    }
  });
  return diagnostics;
}

function staticPropsChangedError(path, current, proposed) {
  return error("agent.patch.static_props_changed", "Agent Review must preserve deterministic static-property coverage evidence exactly.", path, {
    current,
    proposed
  });
}

function protectedScriptActionReason(action) {
  if (!isRecord(action)) return undefined;
  if (action.translationStatus === "omitted" && action.coverage?.status === "covered") {
    return Array.isArray(action.coverage?.staticProps) && action.coverage.staticProps.length
      ? "static-property-covered"
      : "native-covered";
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
    return { ok: true, scope: "field", fieldIndex: Number(parts[2]), property: parts[3] };
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
    return {
      ok: true,
      scope: "column",
      fieldIndex: Number(parts[2]),
      columnIndex: Number(parts[4]),
      property: parts[5]
    };
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

function validatePatchTargetEvidence(patch, target, dslDraft, path) {
  const expectedRefs = targetEvidenceRefs(target, dslDraft);
  if (expectedRefs.length === 0) {
    return [error(
      "agent.patch.target_source_refs_missing",
      "Agent patches require target-owned source refs, but the patched target has none.",
      `${path}/sourceRefs`,
      { actual: patch.sourceRefs }
    )];
  }
  const unrelatedRefs = patch.sourceRefs.filter((ref) => !expectedRefs.includes(ref));
  if (unrelatedRefs.length === 0) return [];
  return [error(
    "agent.patch.source_refs_outside_target",
    "Every Agent patch sourceRef must belong to the patched form target or script action.",
    `${path}/sourceRefs`,
    { expectedRefs, actual: patch.sourceRefs, unrelatedRefs }
  )];
}

function targetEvidenceRefs(target, dslDraft) {
  if (target.scope === "scriptAction") {
    const refs = getScriptAction(dslDraft, target.actionIndex)?.sourceRefs;
    return Array.isArray(refs) ? refs.filter(nonEmptyString) : [];
  }
  const field = dslDraft?.form?.fields?.[target.fieldIndex];
  const value = target.scope === "column" ? field?.columns?.[target.columnIndex] : field;
  return nonEmptyString(value?.sourceRef) ? [value.sourceRef] : [];
}

function patchTargetInReviewScope(target, reviewScope) {
  if (reviewScope === undefined) return true;
  if (!isRecord(reviewScope)) return false;
  if (target.scope === "scriptAction") {
    return Array.isArray(reviewScope.actionIndexes) && reviewScope.actionIndexes.includes(target.actionIndex);
  }
  return reviewScope.includeFormTargets === true;
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

function error(code, message, path, details) {
  return { level: "error", code, message, path, details };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(nonEmptyString))];
}
