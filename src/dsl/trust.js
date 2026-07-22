import { catalogRefs, validationPolicyRef, validateCatalogVersions } from "./catalogs.js";
import { validateMigrationDsl } from "./schema.js";
import { draftSourceDraft, MIGRATION_DSL_VERSION } from "../translator/dsl-draft.js";
import { SOURCE_DRAFT_VERSION } from "../translator/source-draft.js";
import { inspectWorkflowFormulaProvenance } from "../translator/workflow-formula-participants.js";
import {
  claimsDeterministicScriptTranslation,
  deterministicManualResidualDecisionIds
} from "./deterministic-script-translations.js";

export function createTrustedMigrationDsl(sourceDraft, dslDraft, options = {}) {
  if (sourceDraft?.version !== SOURCE_DRAFT_VERSION || sourceDraft?.artifact !== "source-draft") {
    throw new Error("trust requires a source-draft artifact");
  }
  if (dslDraft?.trust?.level !== "draft" || dslDraft?.trust?.executable !== false) {
    throw new Error("trust requires a non-executable dsl-draft artifact");
  }
  if (options.externalAgentReviewed !== true) {
    throw new Error("trust requires --external-agent-reviewed to record the external Codex Agent boundary");
  }

  const reviewerName = nonEmptyString(options.reviewerName) ? options.reviewerName : "external-codex-agent";
  const trusted = clone(dslDraft);
  trusted.version = MIGRATION_DSL_VERSION;
  trusted.artifact = "migration-dsl";
  trusted.catalogs = catalogRefs();
  trusted.validationPolicy = validationPolicyRef();
  trusted.trust = {
    level: "trusted",
    executable: true,
    reviewer: {
      type: "agent",
      name: reviewerName,
      mode: "external-codex"
    },
    external: true,
    trustCheck: {
      status: "passed",
      checkedAt: options.checkedAt || new Date().toISOString()
    },
    digests: {
      sourceDraft: options.sourceDraftDigest || trusted.digests?.sourceDraft || "",
      dslDraft: options.dslDraftDigest || ""
    }
  };
  trusted.review = pruneUndefined({
    warnings: [
      ...(trusted.review?.warnings || []),
      ...(options.reviewWarnings || [])
    ],
    decisions: normalizeDecisions(options.decisions || []),
    agentReview: options.agentReview
  });

  return trusted;
}

export function checkTrust(sourceDraft, migrationDsl) {
  const diagnostics = [];
  if (sourceDraft?.version !== SOURCE_DRAFT_VERSION || sourceDraft?.artifact !== "source-draft") {
    diagnostics.push(error("trust.source_draft_required", "check trust requires a source-draft artifact.", "/sourceDraft"));
  }

  validateTrustedMetadata(migrationDsl, diagnostics);
  validateCatalogVersions(migrationDsl, diagnostics);
  validateReviewDecisions(migrationDsl?.review?.decisions, diagnostics);
  validateNoPendingReview(migrationDsl, diagnostics);

  const sourceRefs = collectSourceRefs(sourceDraft);
  validateDerivedFrom(sourceDraft, migrationDsl, diagnostics);
  validateCoreProvenance(migrationDsl, sourceRefs, diagnostics);
  validateWorkflowFormulaProvenance(sourceDraft, migrationDsl, diagnostics);
  validateScriptSourceProvenance(sourceDraft, migrationDsl, diagnostics);

  const executionValidation = validateMigrationDsl(migrationDsl, { mode: "execute" });
  diagnostics.push(...executionValidation.diagnostics);

  return finalize("trust", diagnostics);
}

function validateScriptSourceProvenance(sourceDraft, migrationDsl, diagnostics) {
  const actualActions = migrationDsl?.scripts?.actions || [];
  const sourceHasScripts = Array.isArray(sourceDraft?.scripts?.sources) &&
    sourceDraft.scripts.sources.length > 0;
  if (!actualActions.length && !sourceHasScripts) return;

  let expectedDraft;
  try {
    expectedDraft = draftSourceDraft(sourceDraft);
  } catch (error) {
    diagnostics.push(error(
      "trust.script_source_rebuild_failed",
      "Script provenance could not be independently rebuilt from the Source Draft.",
      "/scripts/actions",
      { error: String(error?.message || error) }
    ));
    return;
  }

  const expectedActions = expectedDraft?.scripts?.actions || [];
  validateScriptActionSourceBindings(
    expectedActions.filter(isSourceBoundScriptAction),
    actualActions.filter(isSourceBoundScriptAction),
    diagnostics
  );
  validateOrdinaryScriptBranchSourceProvenance(expectedActions, actualActions, diagnostics);
  validateDeterministicScriptSourceProvenance(
    expectedDraft,
    migrationDsl,
    diagnostics
  );
}

function validateScriptActionSourceBindings(expectedActions, actualActions, diagnostics) {
  const expectedCounts = actionBindingCounts(expectedActions);
  const actualCounts = actionBindingCounts(actualActions);
  if (canonicalJson(expectedCounts) === canonicalJson(actualCounts)) return;

  diagnostics.push(error(
    "trust.script_action_source_mismatch",
    "Trusted script actions must retain the exact action identities independently rebuilt from the Source Draft.",
    "/scripts/actions",
    {
      expectedActionCount: expectedActions.length,
      actualActionCount: actualActions.length,
      missing: bindingCountDifference(expectedCounts, actualCounts),
      unexpected: bindingCountDifference(actualCounts, expectedCounts)
    }
  ));
}

function validateOrdinaryScriptBranchSourceProvenance(expectedActions, actualActions, diagnostics) {
  const actualByBinding = new Map();
  for (const action of actualActions) {
    const key = scriptActionSourceBindingKey(action);
    if (!actualByBinding.has(key)) actualByBinding.set(key, []);
    actualByBinding.get(key).push(action);
  }

  expectedActions.forEach((expected, expectedIndex) => {
    if (expected?.deterministicBranchProof !== undefined) return;
    const candidates = actualByBinding.get(scriptActionSourceBindingKey(expected)) || [];
    const action = candidates.length === 1 ? candidates[0] : undefined;
    if (!action) return;
    if (
      expected?.branchProvenance === undefined && action.branchProvenance === undefined
    ) return;
    if (
      canonicalJson(expected.branchProvenance) !== canonicalJson(action.branchProvenance)
    ) {
      diagnostics.push(error(
        "trust.script_branch_source_mismatch",
        "Branch provenance must exactly match the action independently rebuilt from the authoritative Source Draft.",
        `/scripts/actions/${actualActions.indexOf(action)}/branchProvenance`,
        {
          actionId: action?.id,
          expectedActionIndex: expectedIndex,
          actualActionCount: candidates.length
        }
      ));
    }
  });
}

function validateDeterministicScriptSourceProvenance(expectedDraft, migrationDsl, diagnostics) {
  const actualActions = (migrationDsl?.scripts?.actions || []).filter((action) => (
    action?.deterministicBranchProof !== undefined || claimsDeterministicScriptTranslation(action)
  ));
  if (!actualActions.length) return;

  const expectedById = new Map();
  for (const action of expectedDraft?.scripts?.actions || []) {
    if (!expectedById.has(action?.id)) expectedById.set(action?.id, []);
    expectedById.get(action?.id).push(action);
  }
  const actualDecisions = new Map(
    (migrationDsl?.scripts?.calculationDecisions || []).map((decision) => [decision?.id, decision])
  );
  const expectedDecisions = new Map(
    (expectedDraft?.scripts?.calculationDecisions || []).map((decision) => [decision?.id, decision])
  );

  actualActions.forEach((action, actionIndex) => {
    const candidates = expectedById.get(action?.id) || [];
    const expected = candidates.length === 1 ? candidates[0] : undefined;
    if (
      !expected?.deterministicBranchProof ||
      canonicalJson(expected.deterministicBranchProof) !== canonicalJson(action.deterministicBranchProof)
    ) {
      diagnostics.push(error(
        "trust.deterministic_script_source_mismatch",
        "A deterministic script proof must exactly match the action independently rebuilt from the authoritative Source Draft.",
        `/scripts/actions/${actionIndex}/deterministicBranchProof`,
        {
          actionId: action?.id,
          expectedActionCount: candidates.length
        }
      ));
      return;
    }

    for (const decisionId of deterministicManualResidualDecisionIds(action)) {
      if (
        !expectedDecisions.has(decisionId) ||
        canonicalJson(expectedDecisions.get(decisionId)) !== canonicalJson(actualDecisions.get(decisionId))
      ) {
        diagnostics.push(error(
          "trust.deterministic_script_manual_residual_mismatch",
          "Deterministic script manual residual closure must match the Source Draft calculation decision.",
          `/scripts/calculationDecisions/${decisionId}`,
          { actionId: action?.id, decisionId }
        ));
      }
    }
  });
}

function actionBindingCounts(actions) {
  const counts = {};
  for (const action of actions || []) {
    const key = scriptActionSourceBindingKey(action);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function bindingCountDifference(left, right) {
  return Object.entries(left)
    .flatMap(([key, count]) => Array(Math.max(0, count - (right[key] || 0))).fill(key));
}

function scriptActionSourceBindingKey(action = {}) {
  return canonicalJson({
    id: action.id,
    name: action.name,
    event: action.event,
    scope: action.scope,
    controlId: action.controlId,
    tableId: action.tableId,
    runWhen: action.runWhen,
    sourceRefs: action.sourceRefs,
    sourceActionKey: action.sourceActionKey,
    recipe: action.recipe,
    semanticHints: action.semanticHints
  });
}

function isSourceBoundScriptAction(action) {
  return action?.branchProvenance !== undefined ||
    action?.deterministicBranchProof !== undefined ||
    claimsDeterministicScriptTranslation(action);
}

function validateWorkflowFormulaProvenance(sourceDraft, migrationDsl, diagnostics) {
  for (const inspection of inspectWorkflowFormulaProvenance(sourceDraft, migrationDsl)) {
    if (inspection.status === "matched") continue;
    diagnostics.push(error(
      inspection.status === "unmapped"
        ? "trust.workflow_formula_unmapped"
        : "trust.workflow_formula_provenance_mismatch",
      inspection.status === "unmapped"
        ? "Unmapped source workflow formulas cannot become executable."
        : "Executable workflow formula evidence must match the authoritative source draft.",
      `/workflow/nodes/${inspection.nodeIndex}/participants`,
      inspection
    ));
  }
}

export function validateTrustedMetadata(root, diagnostics, path = "") {
  if (root?.trust?.level !== "trusted") {
    diagnostics.push(error("trust.level_required", "Trusted migration DSL must set trust.level to trusted.", `${path}/trust/level`, {
      actual: root?.trust?.level
    }));
  }
  if (root?.trust?.executable !== true) {
    diagnostics.push(error("trust.executable_required", "Trusted migration DSL must set trust.executable to true.", `${path}/trust/executable`, {
      actual: root?.trust?.executable
    }));
  }
  if (root?.trust?.reviewer?.type !== "agent") {
    diagnostics.push(error("trust.reviewer_type_required", "Trusted migration DSL must record reviewer.type = agent.", `${path}/trust/reviewer/type`));
  }
  if (!nonEmptyString(root?.trust?.reviewer?.name)) {
    diagnostics.push(error("trust.reviewer_name_required", "Trusted migration DSL must record reviewer.name.", `${path}/trust/reviewer/name`));
  }
  if (!nonEmptyString(root?.trust?.reviewer?.mode)) {
    diagnostics.push(error("trust.reviewer_mode_required", "Trusted migration DSL must record external reviewer mode.", `${path}/trust/reviewer/mode`));
  }
  if (root?.trust?.trustCheck?.status !== "passed") {
    diagnostics.push(warning("trust.trust_check_status_missing", "trust.trustCheck.status is not passed; first version treats this as a warning.", `${path}/trust/trustCheck/status`, {
      actual: root?.trust?.trustCheck?.status
    }));
  }
}

function normalizeDecisions(decisions) {
  return decisions.map((decision, index) => ({
    id: decision.id || `decision-${index + 1}`,
    status: decision.status || "accepted",
    decisionType: decision.decisionType || "external_agent_review",
    sourceRefs: decision.sourceRefs || [],
    targetRefs: decision.targetRefs || [],
    rationale: decision.rationale || "External Codex Agent review accepted the target DSL.",
    result: decision.result || "accepted"
  }));
}

function validateReviewDecisions(decisions, diagnostics) {
  if (!Array.isArray(decisions)) {
    diagnostics.push(error("trust.review_decisions_required", "Trusted migration DSL must contain review.decisions[].", "/review/decisions"));
    return;
  }

  decisions.forEach((decision, index) => {
    const path = `/review/decisions/${index}`;
    if (decision?.status === "blocked") {
      diagnostics.push(error("trust.review_decision_blocked", "Blocked Agent decisions fail trust checks.", `${path}/status`));
    }
    for (const key of ["status", "decisionType", "rationale", "result"]) {
      if (!nonEmptyString(decision?.[key])) {
        diagnostics.push(error("trust.review_decision_field_required", `review.decisions[].${key} is required.`, `${path}/${key}`));
      }
    }
    if (!Array.isArray(decision?.sourceRefs)) {
      diagnostics.push(error("trust.review_decision_source_refs_required", "review.decisions[].sourceRefs must be an array.", `${path}/sourceRefs`));
    }
    if (decision?.targetRefs !== undefined && !Array.isArray(decision.targetRefs)) {
      diagnostics.push(error("trust.review_decision_target_refs_type", "review.decisions[].targetRefs must be an array.", `${path}/targetRefs`));
    }
  });
}

function validateNoPendingReview(root, diagnostics) {
  for (const item of walk(root)) {
    if (item.value === "pending_review" && item.path.startsWith("/workflow")) {
      diagnostics.push(error("trust.pending_review_executable", "Executable workflow areas cannot contain pending_review.", item.path));
    }
  }
}

function validateDerivedFrom(sourceDraft, migrationDsl, diagnostics) {
  if (!nonEmptyString(migrationDsl?.derivedFrom?.sourceId)) {
    diagnostics.push(error("trust.derived_from_required", "Trusted DSL must record derivedFrom.sourceId.", "/derivedFrom/sourceId"));
    return;
  }
  const expected = sourceDraft?.source?.sourceId || sourceDraft?.source?.path;
  if (expected && migrationDsl.derivedFrom.sourceId !== expected) {
    diagnostics.push(error("trust.derived_from_mismatch", "Trusted DSL derivedFrom.sourceId must match the source draft.", "/derivedFrom/sourceId", {
      expected,
      actual: migrationDsl.derivedFrom.sourceId
    }));
  }
}

function validateCoreProvenance(root, sourceRefs, diagnostics) {
  const coreObjects = [
    ...((root?.form?.fields || []).flatMap((field, index) => [
      { value: field, path: `/form/fields/${index}` },
      ...((field.columns || []).map((column, columnIndex) => ({ value: column, path: `/form/fields/${index}/columns/${columnIndex}` })))
    ])),
    ...((root?.form?.layout?.mkTree || []).flatMap((node, index) => [
      { value: node, path: `/form/layout/mkTree/${index}` },
      ...((node.children || []).map((child, childIndex) => ({ value: child, path: `/form/layout/mkTree/${index}/children/${childIndex}` })))
    ])),
    ...((root?.workflow?.nodes || []).map((node, index) => ({ value: node, path: `/workflow/nodes/${index}` }))),
    ...((root?.workflow?.edges || []).map((edge, index) => ({ value: edge, path: `/workflow/edges/${index}` })))
  ];

  for (const item of coreObjects) {
    const value = item.value || {};
    if (value.generated === true) {
      if (!nonEmptyString(value.reason)) {
        diagnostics.push(error("trust.generated_reason_required", "Generated DSL objects must include a non-empty reason.", `${item.path}/reason`));
      }
      continue;
    }
    if (!nonEmptyString(value.sourceRef)) {
      diagnostics.push(error("trust.source_ref_required", "Core DSL objects must carry sourceRef unless explicitly generated.", `${item.path}/sourceRef`));
      continue;
    }
    if (!sourceRefs.has(value.sourceRef)) {
      diagnostics.push(error("trust.source_ref_missing", "DSL sourceRef must exist in source-draft.", `${item.path}/sourceRef`, {
        sourceRef: value.sourceRef
      }));
    }
  }
}

function collectSourceRefs(value) {
  const refs = new Set();
  for (const item of walk(value)) {
    if (item.key === "sourceRef" && nonEmptyString(item.value)) refs.add(item.value);
  }
  return refs;
}

function* walk(value, path = "") {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      yield* walk(value[index], `${path}/${index}`);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${escapePointer(key)}`;
    yield { key, value: child, path: childPath };
    yield* walk(child, childPath);
  }
}

function finalize(kind, diagnostics) {
  const hasErrors = diagnostics.some((diagnostic) => diagnostic.level === "error");
  const hasWarnings = diagnostics.some((diagnostic) => diagnostic.level === "warning");
  return {
    ok: !hasErrors,
    status: hasErrors ? "invalid" : hasWarnings ? "needs_manual" : "passed",
    kind,
    diagnostics
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function pruneUndefined(value) {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, pruneUndefined(entry)])
  );
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function error(code, message, path, details) {
  return { level: "error", code, message, path, details };
}

function warning(code, message, path, details) {
  return { level: "warning", code, message, path, details };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function escapePointer(value) {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}
