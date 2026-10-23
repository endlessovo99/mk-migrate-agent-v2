import {isOmittedRemoteManualField} from "./omitted-remote-selector.js";
import {sourceReadScopeBindingIssues} from './template-read-scope.js';
import {verifiedDateOverlapReadyAction} from "../translator/date-overlap-lifecycle.js";
import { choiceOtherCompanionDiagnostics } from "./source-choice-other-companion.js";
import { mobileCaptionSourceDiagnostics } from "./source-mobile-caption-grid.js";
import { radioSourceDiagnostics } from "./source-radio-layout.js";
import { detailRowSourceEffectDiagnostics } from "./source-detail-row-effects.js";
import { sourceNumberEditors, sourceNumberDisplays } from "./source-number-editor.js";
import { sourceCheckboxLayouts } from "./source-checkbox-layout.js";
import { sourceInlineEditorWidths } from "./source-inline-editor-width.js";
import { remoteDialogSourceDiagnostics } from "./remote-dialog.js";
import { selectEmptyEventProof } from "./source-select-empty-event.js";
import { sourceRowDiagnosticProof } from "./source-row-diagnostic.js";
import { validateAssignmentBranchSemantics } from "../agent-review/script-semantic-closure.js";
import { catalogRefs, validationPolicyRef, validateCatalogVersions } from "./catalogs.js";
import { validateMigrationDsl } from "./schema.js";
import { draftSourceDraft, MIGRATION_DSL_VERSION } from "../translator/dsl-draft.js";
import { SOURCE_DRAFT_VERSION } from "../translator/source-draft.js";
import { inspectWorkflowFormulaProvenance } from "../translator/workflow-formula-participants.js";
import { sourcePresentationIssues } from "./source-presentation.js";
import { nativeCaptionFoldIssues } from "./native-caption-fold.js";
import { sourceRequiresReadOnly } from "./source-readonly.js";
import { inputLengthRequirements, inputLengthPolicyWarning } from "./source-input-length.js";
import { validateSourceSignIntegrity } from "./workflow-sign-contract.js";
import { nestedGeometrySourceDiagnostics } from "../translator/sysform-designer-layout.js";
import { migrationPolicyProvenanceDiagnostics } from "../translator/approved-migration-policies.js";
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
    captionFolding: trusted.review?.captionFolding,
    ...(nestedGeometrySourceDiagnostics(sourceDraft).length
      ? { errors: nestedGeometrySourceDiagnostics(sourceDraft) } : {}),
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
  diagnostics.push(...nestedGeometrySourceDiagnostics(sourceDraft));
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
  validateTemplateAuthorizationProvenance(sourceDraft, migrationDsl, diagnostics);
  diagnostics.push(...remoteDialogSourceDiagnostics(sourceDraft?.form, migrationDsl?.form,{dsl:migrationDsl}));
  const expectedDraft = validateStaticAddressDefaultProvenance(sourceDraft, migrationDsl, diagnostics);
  const expectedGrid = expectedDraft?.form?.layout?.sourceGrid, actualGrid = migrationDsl?.form?.layout?.sourceGrid;
  if ((expectedGrid?.rootTable !== undefined || actualGrid?.rootTable !== undefined) &&
      canonicalJson(expectedGrid) !== canonicalJson(actualGrid)) {
    diagnostics.push(error("trust.layout.source_grid_mismatch",
      "Root-table layout evidence must preserve the complete source grid.", "/form/layout/sourceGrid"));
  }
  validateReadOnlySourceRestrictions(sourceDraft, migrationDsl, diagnostics,expectedDraft);
  diagnostics.push(...migrationPolicyProvenanceDiagnostics(sourceDraft, expectedDraft, migrationDsl));
  diagnostics.push(...choiceOtherCompanionDiagnostics(sourceDraft?.form, migrationDsl?.form, expectedDraft?.form));
  diagnostics.push(...mobileCaptionSourceDiagnostics(expectedDraft?.form, migrationDsl?.form));
  diagnostics.push(...radioSourceDiagnostics(expectedDraft?.form, migrationDsl?.form));
  diagnostics.push(...validateSourceSignIntegrity(sourceDraft, migrationDsl, expectedDraft?.workflow).diagnostics);
  validateInputLengthSourceRestrictions(sourceDraft, migrationDsl, expectedDraft, diagnostics);
  validateSourceNumberEditors(sourceDraft, migrationDsl, expectedDraft, diagnostics);
  validateSourceNumberDisplays(sourceDraft, migrationDsl, expectedDraft, diagnostics);
  validateSourceCheckboxLayouts(sourceDraft, migrationDsl, expectedDraft, diagnostics);
  validateSourceInlineEditorWidths(sourceDraft, migrationDsl, expectedDraft, diagnostics);
  validateFixedSourceFieldFacts(expectedDraft, migrationDsl, diagnostics);
  const dataOnlySourceRefs = new Set(flattenFormFields(expectedDraft?.form?.fields)
    .filter((field) => field.dataOnly === true).map((field) => field.sourceRef));
  const dataOnlyFieldIds = new Set((expectedDraft?.form?.fields || [])
    .filter((field) => field.dataOnly === true).map((field) => field.id));
  const presentationReferenceMap = new Map((expectedDraft?.form?.fields || [])
    .filter((field) => dataOnlyFieldIds.has(field.sourceProps?.addressDisplayCompanionId) ||
      field.sourceProps?.consumedAddressDisplayCompanionId)
    .map((field) => [field.sourceProps.addressDisplayCompanionId, field.sourceProps?.originalId || field.id]));
  const captionFolds = nativeCaptionFoldIssues(expectedDraft?.form, migrationDsl?.form);
  const presentationIssues = sourcePresentationIssues(sourceDraft?.form, migrationDsl?.form, {
    dataOnlySourceRefs, presentationReferenceMap,
    foldedSourceRefs: captionFolds.foldedSourceRefs, consumedCaptionIds: captionFolds.consumedCaptionIds
  });
  for (const issue of [...captionFolds.issues, ...presentationIssues]) {
    diagnostics.push(error(
      `trust.form.presentation_${issue.reason}_mismatch`,
      "Target presentation must preserve source line boundaries, item dimensions, hidden titles and unit text.",
      "/form", issue
    ));
  }
  validateWorkflowFormulaProvenance(sourceDraft, migrationDsl, diagnostics);
  validateScriptSourceProvenance(sourceDraft, migrationDsl, diagnostics);

  const executionValidation = validateMigrationDsl(migrationDsl, { mode: "execute" });
  diagnostics.push(...executionValidation.diagnostics);

  return finalize("trust", diagnostics);
}

function validateStaticAddressDefaultProvenance(sourceDraft, migrationDsl, diagnostics) {
  let expectedDraft;
  try {
    expectedDraft = draftSourceDraft(sourceDraft);
  } catch (cause) {
    diagnostics.push(error(
      "trust.form.static_address_default_source_rebuild_failed",
      "Static address defaults could not be independently rebuilt from the Source Draft.",
      "/form/fields",
      { error: String(cause?.message || cause) }
    ));
    return;
  }

  const expectedBySourceRef = new Map(flattenFormFields(expectedDraft?.form?.fields)
    .map((field) => [field.sourceRef, field]));
  for (const actual of flattenFormFields(migrationDsl?.form?.fields)) {
    const expected = expectedBySourceRef.get(actual.sourceRef);
    const expectedDefault = expected?.props?.defaultValue;
    const actualDefault = actual?.props?.defaultValue;
    if (expectedDefault?.kind !== "staticOrg" && actualDefault?.kind !== "staticOrg") continue;
    if (canonicalJson(expectedDefault) === canonicalJson(actualDefault)) continue;
    diagnostics.push(error(
      "trust.form.static_address_default_source_mismatch",
      "Trusted static address defaults must exactly preserve the deterministic source mapping.",
      "/form/fields",
      { fieldId: actual?.id || expected?.id, sourceRef: actual?.sourceRef || expected?.sourceRef }
    ));
  }
  return expectedDraft;
}

function flattenFormFields(fields = []) {
  return (Array.isArray(fields) ? fields : []).flatMap((field) =>
    field?.type === "detailTable" ? field.columns || [] : [field]
  );
}

function validateFixedSourceFieldFacts(expectedDraft, migrationDsl, diagnostics) {
  if (!expectedDraft) return;
  const expectedFields = flattenFormFields(expectedDraft.form?.fields);
  const actualFields = flattenFormFields(migrationDsl?.form?.fields);
  for (const [key, code] of [["mainStringValueBindingFact", "main_string_binding"], ["remoteSelectorSourceContract", "remote_selector_contract"], ["approvedRemoteSelectorSourceFact", "remote_selector_runtime"], ["remoteSelectorOmissionSourceFact", "remote_selector_omission"],
    ["dynamicHyperlinkProjection", "dynamic_hyperlink_projection"]]) {
    const refs = new Set([...expectedFields, ...actualFields]
      .filter(field => field.sourceProps?.[key] !== undefined).map(field => field.sourceRef));
    for (const ref of refs) {
      const expected = expectedFields.filter(field => field.sourceRef === ref);
      const actual = actualFields.filter(field => field.sourceRef === ref);
      if (expected.length === 1 && actual.length === 1 && canonicalJson(expected[0].sourceProps?.[key]) ===
          canonicalJson(actual[0].sourceProps?.[key])) continue;
      diagnostics.push(error(
        `trust.form.${code}_source_mismatch`,
        "Fixed field facts must exactly preserve the current source export evidence.",
        "/form/fields", { sourceRef: ref }
      ));
    }
  }
}

function validateTemplateAuthorizationProvenance(sourceDraft, migrationDsl, diagnostics) {
  for(const reason of sourceReadScopeBindingIssues(sourceDraft))diagnostics.push(error('trust.template.read_scope_source_mismatch','Reader mode must bind the current paired source XML and authorization.', '/template/authorization/readScope',{reason}));
  const expected = sourceDraft?.template?.authorization;
  const actual = migrationDsl?.template?.authorization;
  if (canonicalJson(expected) === canonicalJson(actual)) return;
  diagnostics.push(error(
    "trust.template.authorization_source_mismatch",
    "Trusted template authorization must exactly preserve the source authorization evidence.",
    "/template/authorization"
  ));
}

function validateReadOnlySourceRestrictions(sourceDraft, migrationDsl, diagnostics,expectedDraft) {
  const sourceFields = [
    ...(sourceDraft?.form?.controls || []),
    ...(sourceDraft?.form?.dataFields || []),
    ...(sourceDraft?.form?.detailTables || []).flatMap((table) => table.columns || [])
  ];
  const actualFields = (migrationDsl?.form?.fields || []).flatMap((field) =>
    field.type === "detailTable" ? field.columns || [] : [field]
  );
  for (const source of sourceFields) {
    if (source.sourceType === "description" || !sourceRequiresReadOnly(source)) continue;
    const actual = actualFields.find((field) => field.sourceRef === source.sourceRef);
    if (actual?.props?.readOnly === true || actual?.componentId === "xform-description") continue;
    const expected=flattenFormFields(expectedDraft?.form?.fields).find(field=>field.sourceRef===source.sourceRef);
    if (expected && isOmittedRemoteManualField(expectedDraft,expected) && actual?.props?.readOnly===false) continue;
    diagnostics.push(error(
      "trust.form.read_only_source_mismatch",
      "Trusted fields must preserve the source static read-only restriction.",
      "/form/fields",
      { fieldId: actual?.id || source.id, sourceRef: source.sourceRef }
    ));
  }
}

function validateInputLengthSourceRestrictions(sourceDraft, migrationDsl, expectedDraft, diagnostics) {
  if (!expectedDraft) return;
  const actualFields = flattenFormFields(migrationDsl?.form?.fields);
  const requirements = inputLengthRequirements(sourceDraft?.form, expectedDraft.form);
  const requiredRefs = new Set(requirements.map(({ source }) => source.sourceRef));
  for (const requirement of requirements) {
    const { source, field, path, fact } = requirement;
    const details = { fieldId: field.id, sourceRef: source.sourceRef };
    if (fact.status !== "valid") {
      diagnostics.push(error(
        `trust.form.input_length_source_${fact.status}`,
        "An invalid or conflicting source input limit cannot be trusted by replacing the candidate value or deleting draft errors.",
        `${path}/props/maxLength`, {
          ...details, evidence: fact.evidence,
          ...(fact.sourceIds ? { sourceFieldIds: fact.sourceIds } : {})
        }
      ));
      continue;
    }
    const actual = actualFields.filter((field) => field.sourceRef === source.sourceRef);
    if (actual.length !== 1 || actual[0].componentId !== "xform-input" || actual[0].props?.maxLength !== fact.limit) {
      diagnostics.push(error(
        "trust.form.input_length_source_mismatch",
        "Trusted input fields must exactly preserve the explicit source length under the supported input projection.",
        `${path}/props/maxLength`, { ...details, expected: fact.limit }
      ));
    }
    const expectedWarning = inputLengthPolicyWarning(requirement);
    if (!(migrationDsl.review?.warnings || []).some((warning) =>
      warning.code === expectedWarning.code && warning.message === expectedWarning.message &&
      warning.path === expectedWarning.path && canonicalJson(warning.details) === canonicalJson(expectedWarning.details))) {
      diagnostics.push(error(
        "trust.form.input_length_policy_missing",
        "Trusted input limits must retain the explicit target-counting policy and its source evidence; source equivalence is not implied.",
        "/review/warnings", details
      ));
    }
  }
  const expectedFields = flattenFormFields(expectedDraft.form?.fields);
  const expectedInputRefs = new Set(expectedFields
    .filter((field) => field.componentId === "xform-input").map((field) => field.sourceRef));
  for (const actual of actualFields) {
    const otherComponents = expectedFields.filter((field) =>
      field.sourceRef === actual.sourceRef && field.componentId !== "xform-input");
    if (actual.componentId === "xform-input" && otherComponents.length &&
        (actual.props?.maxLength !== undefined || otherComponents.some((field) => field.props?.maxLength !== undefined))) {
      diagnostics.push(error(
        "trust.form.input_length_component_transition_unproven",
        "Changing a non-input field into an input does not prove the new length-counting policy or permit dropping its source limit.",
        "/form/fields", { fieldId: actual.id, sourceRef: actual.sourceRef }
      ));
    }
    if (!expectedInputRefs.has(actual.sourceRef) || requiredRefs.has(actual.sourceRef) || actual.props?.maxLength === undefined) continue;
    diagnostics.push(error(
      "trust.form.input_length_source_missing",
      "Input maxLength requires an explicit source validation limit; storage metadata alone is insufficient.",
      "/form/fields", { fieldId: actual.id, sourceRef: actual.sourceRef }
    ));
  }
}

function validateScriptSourceProvenance(sourceDraft, migrationDsl, diagnostics) {
  const actualActions = migrationDsl?.scripts?.actions || [];
  const sourceHasScripts = Array.isArray(sourceDraft?.scripts?.sources) &&
    sourceDraft.scripts.sources.length > 0;
  if (!actualActions.length && !sourceHasScripts) return;

  let expectedDraft;
  try {
    expectedDraft = draftSourceDraft(sourceDraft);
  } catch (cause) {
    diagnostics.push(error(
      "trust.script_source_rebuild_failed",
      "Script provenance could not be independently rebuilt from the Source Draft.",
      "/scripts/actions",
      { error: String(cause?.message || cause) }
    ));
    return;
  }

  const expectedActions = expectedDraft?.scripts?.actions || [];
  diagnostics.push(...detailRowSourceEffectDiagnostics(expectedActions, actualActions));
  for (const expected of expectedActions) {
    const matches = actualActions.filter(action => scriptActionSourceBindingKey(action) === scriptActionSourceBindingKey(expected));
    if (matches.length !== 1) continue; // The existing immutable binding-count gate reports missing/changed owners.
    const actual = matches[0];
    const proof = selectEmptyEventProof(actual, { sourceAction: expected, sourceForm: sourceDraft.form, targetForm: migrationDsl.form,
      sourceScripts: sourceDraft.scripts?.sources,
      sourceFormRules: expectedDraft.formRules, targetFormRules: migrationDsl.formRules, authoritative: true });
    const assignments = proof.ok && proof.adapted && !proof.diagnosticOnly ? validateAssignmentBranchSemantics({ sourceFunction: expected.function,
      reviewedFunction: proof.function, form: expectedDraft.form,
      residuals: (expected.coverage?.residuals || []).filter(residual => residual.code === "script.residual.field_value_assignment") }) : { ok: true };
    if (!proof.ok || !assignments.ok) diagnostics.push(error("trust.script_select_empty_source_mismatch",
      "Native select event adaptation must be independently justified by the fixed SourceDraft and preserve every source assignment branch.",
      `/scripts/actions/${actualActions.indexOf(actual)}/function`, { reason: proof.reason || assignments.reason }));
    const rowDiagnostics = sourceRowDiagnosticProof({ sourceAction: expected, action: actual, sourceDraft,
      expectedForm: expectedDraft.form, targetForm: migrationDsl.form,
      sourceFormRules: expectedDraft.formRules, targetFormRules: migrationDsl.formRules, emptyEventProof: proof });
    if (!rowDiagnostics.ok) diagnostics.push(error("trust.script_row_diagnostic_source_mismatch",
      "Source row diagnostics must retain the original callback, reads, arguments and effect order.",
      `/scripts/actions/${actualActions.indexOf(actual)}/function`, { reason: rowDiagnostics.reason }));
  }
  for (const action of expectedActions.filter(action => action.semanticHints?.jqueryReadyInitialization)) {
    if(verifiedDateOverlapReadyAction(sourceDraft,expectedDraft.form,action))continue;
    diagnostics.push(error(
      "trust.script_ready_lifecycle_unproven",
      "The authoritative source contains document-ready initialization without a proven target lifecycle contract.",
      "/scripts/actions",
      { actionId: action.id, sourceRefs: action.sourceRefs }
    ));
  }
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
    if (["matched", "reviewed_fallback"].includes(inspection.status)) continue;
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

function validateSourceNumberEditors(sourceDraft, candidate, expected, diagnostics) {
  validateSourceNumberProfiles(sourceDraft, candidate, expected, diagnostics, sourceNumberEditors,
    "trust.form.number_editor_source_mismatch",
    "Numeric text editor projection must preserve fixed source identity, width, units and numeric semantics.");
}

function validateSourceNumberDisplays(sourceDraft, candidate, expected, diagnostics) {
  validateSourceNumberProfiles(sourceDraft, candidate, expected, diagnostics, sourceNumberDisplays,
    "trust.form.number_display_source_mismatch",
    "Readonly numeric display projection must preserve fixed source identity, runtime width, permissions and numeric semantics.");
}

function validateSourceCheckboxLayouts(sourceDraft, candidate, expected, diagnostics) {
  const sourceProfiles = sourceCheckboxLayouts(sourceDraft?.form);
  const fixedProfiles = sourceCheckboxLayouts(expected?.form);
  const actualProfiles = sourceCheckboxLayouts(candidate?.form);
  const fixedFields = flattenFormFields(expected?.form?.fields);
  const actualFields = flattenFormFields(candidate?.form?.fields);
  const semantics = field => ({ id: field?.id, type: field?.type, componentId: field?.componentId,
    sourceRef: field?.sourceRef, dataOnly: field?.dataOnly === true, options: field?.props?.options,
    designerId: field?.sourceProps?.designerId, designerType: field?.sourceProps?.designerType,
    designerValues: field?.sourceProps?.designerValues,
    otherTextCompanion: field?.sourceProps?.otherTextCompanion,
    otherTextCompanionId: field?.sourceProps?.otherTextCompanionId });
  const refs = new Set([...sourceProfiles.keys(), ...fixedProfiles.keys(), ...actualProfiles.keys()]);
  for (const sourceRef of refs) {
    const fixed = fixedFields.filter(field => field.sourceRef === sourceRef);
    const actual = actualFields.filter(field => field.sourceRef === sourceRef);
    if (!sourceProfiles.has(sourceRef) || !fixedProfiles.has(sourceRef) || fixed.length !== 1 || actual.length !== 1 ||
        canonicalJson(fixedProfiles.get(sourceRef)) !== canonicalJson(actualProfiles.get(sourceRef)) ||
        canonicalJson(semantics(fixed[0])) !== canonicalJson(semantics(actual[0]))) {
      diagnostics.push(error("trust.form.checkbox_layout_source_mismatch",
        "Checkbox grouping must preserve fixed source alignment, complete options, identity, scope and other-text topology.",
        "/form", { sourceRef }));
    }
  }
}

function validateSourceInlineEditorWidths(sourceDraft, candidate, expected, diagnostics) {
  const sourceProfiles = sourceInlineEditorWidths(sourceDraft?.form);
  const fixedProfiles = sourceInlineEditorWidths(expected?.form);
  const actualProfiles = sourceInlineEditorWidths(candidate?.form);
  const fixedFields = flattenFormFields(expected?.form?.fields);
  const actualFields = flattenFormFields(candidate?.form?.fields);
  const semantics = field => ({ id: field?.id, type: field?.type, componentId: field?.componentId,
    sourceRef: field?.sourceRef, title: field?.title, dataOnly: field?.dataOnly === true,
    sourceProps: field?.sourceProps, props: field?.props });
  const fail = id => diagnostics.push(error("trust.form.inline_editor_width_source_mismatch",
    "Inline editor sizing must preserve fixed source identity, title, permissions, metadata and complete field semantics.",
    "/form", { fieldId: id }));
  for (const [id, profile] of sourceProfiles) {
    const fixed = fixedFields.filter(field => field.id === id || field.sourceRef === profile.sourceRef);
    const actual = actualFields.filter(field => field.id === id || field.sourceRef === profile.sourceRef);
    if (fixed.length !== 1 || actual.length !== 1 ||
        canonicalJson(semantics(fixed[0])) !== canonicalJson(semantics(actual[0])) ||
        fixedProfiles.has(id) && (!actualProfiles.has(id) ||
          canonicalJson(fixedProfiles.get(id)) !== canonicalJson(actualProfiles.get(id))) ||
        !fixedProfiles.has(id) && actualProfiles.has(id)) fail(id);
  }
  for (const id of actualProfiles.keys()) if (!sourceProfiles.has(id) || !fixedProfiles.has(id)) fail(id);
}

function validateSourceNumberProfiles(sourceDraft, candidate, expected, diagnostics, profilesFor, code, message) {
  const sourceProfiles = profilesFor(sourceDraft?.form);
  const fixedProfiles = profilesFor(expected?.form);
  const candidateProfiles = profilesFor(candidate?.form);
  const fields = flattenFormFields(candidate?.form?.fields);
  const fixedFields = expected?.form?.fields || [];
  const fail = (fieldId, reason) => diagnostics.push(error(code, message, "/form", { fieldId, reason }));
  for (const [id, profile] of sourceProfiles) {
    const fixed = fixedFields.find(field => field.id === id);
    const matches = fields.filter(field => field.sourceRef === profile.sourceRef || field.id === id);
    const actual = matches[0];
    const semantics = field => ({ id: field?.id, type: field?.type, componentId: field?.componentId, sourceRef: field?.sourceRef,
      sourceProps: field?.sourceProps, required: field?.props?.required, hiddenLabel: field?.props?.hiddenLabel,
      readOnly: field?.props?.readOnly, precision: field?.props?.precision, unit: field?.props?.unit,
      calculation: field?.props?.calculation, defaultValue: field?.props?.defaultValue });
    // Fixed source calculations and script-derived restrictions can remove editor eligibility.
    // Compare their complete fixed semantics too; candidate changes cannot choose the policy scope.
    const editorExpected = fixedProfiles.has(id);
    if (matches.length !== 1 || canonicalJson(semantics(actual)) !== canonicalJson(semantics(fixed)) ||
        editorExpected && (!candidateProfiles.has(id) || canonicalJson(candidateProfiles.get(id)) !== canonicalJson(profile)) ||
        !editorExpected && candidateProfiles.has(id)) fail(id, "source_profile");
    if (editorExpected && profile.unitId) {
      const unit = fixedFields.find(field => field.id === profile.unitId);
      const units = fields.filter(field => field.id === unit?.id || field.sourceRef === unit?.sourceRef);
      if (units.length !== 1 || canonicalJson(units[0]) !== canonicalJson(unit)) fail(id, "external_unit");
    }
  }
  for (const id of candidateProfiles.keys()) if (!sourceProfiles.has(id) || !fixedProfiles.has(id)) fail(id, "unproven_profile");
}
