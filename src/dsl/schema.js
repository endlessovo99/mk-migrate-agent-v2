import {
  validateCatalogVersions,
  validateComponentProps,
  validateFunctionCatalogAudit
} from "./catalogs.js";
import {
  FORM_RULE_EFFECT_TYPES,
  FORM_RULE_LOGIC,
  FORM_RULE_OPERATORS,
  FORM_RULE_TRIGGERS,
  buildFormRuleRefIndex,
  resolveDirectRef,
  resolveEffectTarget
} from "./form-rules.js";
import {
  SCRIPT_EVENTS,
  SCRIPT_GLOBAL_EVENTS,
  SCRIPT_SCOPES,
  SCRIPT_TRANSLATION_STATUSES,
  analyzeScriptFunction,
  handlesDraftContext,
  hasExplicitBeforeSubmitReturn,
  parseNamedFunctionParams,
  resolveControlEventSupport,
  resolveScriptControlTarget,
  scriptTargetApiSummary,
  validateSetFieldAttrTargets
} from "./scripts.js";

export const DSL_VERSION = "2.0-migration";

export const FIELD_TYPES = new Set([
  "text",
  "longText",
  "number",
  "date",
  "dateTime",
  "singleSelect",
  "multiSelect",
  "radio",
  "checkbox",
  "attachment",
  "description",
  "detailTable"
]);

const SCRIPT_COVERAGE_STATUSES = new Set(["none", "partial", "uncovered", "covered", "translated"]);
const WORKFLOW_NODE_TYPES = new Set(["generalStart", "draft", "review", "send", "robot", "conditionBranch", "split", "join", "generalEnd"]);
const WORKFLOW_NODE_ELEMENTS = new Set(["startEvent", "manualTask", "exclusiveGateway", "parallelGateway", "robot", "endEvent"]);
const WORKFLOW_PARTICIPANT_MODES = new Set([
  "empty",
  "initiator_select",
  "explicit",
  "form_field",
  "person_by_login_name",
  "dept_leader_by_no",
  "doc_creator",
  "role_line"
]);
const MK_FIELD_ID_MAX_LENGTH = 25;

export function validateMigrationDsl(input, options = {}) {
  const diagnostics = [];
  const root = isRecord(input) ? input : {};
  const mode = options.mode || "any";

  if (!isRecord(input)) {
    diagnostics.push(error("dsl.root_type", "DSL must be a JSON object.", "/"));
  }

  if (root.version !== DSL_VERSION) {
    diagnostics.push(error("dsl.version_unsupported", `DSL version must be ${DSL_VERSION}.`, "/version", {
      current: root.version,
      supported: [DSL_VERSION]
    }));
  }

  validateArtifact(root, diagnostics, mode);
  validateTrust(root, diagnostics, mode);
  validateCatalogVersions(root, diagnostics);
  validateTemplate(root.template, diagnostics);
  const formContext = validateForm(root.form, diagnostics);
  validateFormRules(root.formRules, diagnostics, { mode, form: root.form });
  validateScripts(root.scripts, diagnostics, { mode, form: root.form, formRules: root.formRules });
  validateReview(root.review, diagnostics, root.trust?.level);
  if (root.workflow !== undefined) {
    validateWorkflow(root.workflow, diagnostics, {
      mode,
      fieldIds: formContext.fieldIds,
      dataAuthorityFieldIds: formContext.dataAuthorityFieldIds
    });
  }

  const hasErrors = diagnostics.some((item) => item.level === "error");
  const hasWarnings = diagnostics.some((item) => item.level === "warning");

  return {
    ok: !hasErrors,
    status: hasErrors ? "invalid" : hasWarnings ? "needs_manual" : "ok",
    diagnostics,
    dsl: root
  };
}

function validateArtifact(root, diagnostics, mode) {
  if (!["dsl-draft", "migration-dsl"].includes(root.artifact)) {
    diagnostics.push(error("dsl.artifact_invalid", "DSL artifact must be dsl-draft or migration-dsl.", "/artifact", {
      actual: root.artifact
    }));
    return;
  }
  if (mode === "draft" && root.artifact !== "dsl-draft") {
    diagnostics.push(error("dsl.artifact_draft_required", "check draft requires a dsl-draft artifact.", "/artifact"));
  }
  if (mode === "execute" && root.artifact !== "migration-dsl") {
    diagnostics.push(error("dsl.artifact_trusted_required", "Execution accepts only trusted migration.dsl.json artifacts.", "/artifact"));
  }
}

function validateTrust(root, diagnostics, mode) {
  const trust = isRecord(root.trust) ? root.trust : {};
  if (!isRecord(root.trust)) {
    diagnostics.push(error("dsl.trust_required", "trust metadata is required.", "/trust"));
    return;
  }

  if (mode === "draft") {
    if (trust.level !== "draft") {
      diagnostics.push(error("dsl.trust.draft_level_required", "dsl-draft must set trust.level = draft.", "/trust/level"));
    }
    if (trust.executable !== false) {
      diagnostics.push(error("dsl.trust.draft_not_executable", "dsl-draft must set trust.executable = false.", "/trust/executable"));
    }
    return;
  }

  if (mode === "execute") {
    if (trust.level !== "trusted") {
      diagnostics.push(error("dsl.trust.trusted_required", "Execution accepts only trust.level = trusted.", "/trust/level", {
        actual: trust.level
      }));
    }
    if (trust.executable !== true) {
      diagnostics.push(error("dsl.trust.executable_required", "Execution accepts only trust.executable = true.", "/trust/executable", {
        actual: trust.executable
      }));
    }
    if (trust.reviewer?.type !== "agent") {
      diagnostics.push(error("dsl.trust.reviewer_agent_required", "Trusted DSL must record reviewer.type = agent.", "/trust/reviewer/type"));
    }
    if (!nonEmptyString(trust.reviewer?.name) || !nonEmptyString(trust.reviewer?.mode)) {
      diagnostics.push(error("dsl.trust.reviewer_external_required", "Trusted DSL must record external Agent reviewer name and mode.", "/trust/reviewer"));
    }
    if (trust.trustCheck?.status !== "passed") {
      diagnostics.push(warning("trust.trust_check_status_missing", "trust.trustCheck.status is not passed; first version treats this as a warning.", "/trust/trustCheck/status", {
        actual: trust.trustCheck?.status
      }));
    }
    return;
  }

  if (trust.level === "draft" && trust.executable !== false) {
    diagnostics.push(error("dsl.trust.draft_not_executable", "Draft DSL must not be executable.", "/trust/executable"));
  }
  if (trust.level === "trusted" && trust.executable !== true) {
    diagnostics.push(error("dsl.trust.trusted_executable_required", "Trusted DSL must be executable.", "/trust/executable"));
  }
}

function validateTemplate(template, diagnostics) {
  if (!isRecord(template)) {
    diagnostics.push(error("dsl.template_required", "template is required.", "/template"));
    return;
  }
  if (!nonEmptyString(template.name)) {
    diagnostics.push(error("dsl.template.name_required", "template.name is required.", "/template/name"));
  }
}

function validateForm(form, diagnostics) {
  if (!isRecord(form)) {
    diagnostics.push(error("dsl.form_required", "form is required.", "/form"));
    return { fieldIds: new Set(), dataAuthorityFieldIds: new Set(), detailTableIds: new Set(), layoutNodeIds: new Set() };
  }

  const fieldIds = validateFields(form.fields, diagnostics);
  const dataOnlyFieldIds = new Set(
    (Array.isArray(form.fields) ? form.fields : [])
      .filter((field) => field?.type !== "detailTable" && field?.dataOnly === true)
      .map((field) => field.id)
      .filter(nonEmptyString)
  );
  const dataAuthorityFieldIds = collectDataAuthorityFieldIds(form.fields);
  const detailTableIds = new Set((form.fields || []).filter((field) => field?.type === "detailTable").map((field) => field.id));
  const layoutNodeIds = validateFormLayout(form.layout, { fieldIds, detailTableIds, dataOnlyFieldIds }, diagnostics);
  return { fieldIds, dataAuthorityFieldIds, detailTableIds, layoutNodeIds };
}

function validateFields(fields, diagnostics) {
  const ids = new Set();

  if (!Array.isArray(fields) || fields.length === 0) {
    diagnostics.push(error("dsl.form.fields_required", "form.fields must contain at least one field.", "/form/fields"));
    return ids;
  }

  fields.forEach((field, index) => {
    const path = `/form/fields/${index}`;
    validateFieldLike(field, diagnostics, path, ids, field?.type === "detailTable" ? "detailTable" : "field");
    if (field?.type === "detailTable") {
      validateDetailColumns(field.columns, diagnostics, `${path}/columns`);
    }
  });

  return ids;
}

function validateFieldLike(field, diagnostics, path, ids, scope) {
  if (!isRecord(field)) {
    diagnostics.push(error("dsl.field.type", "Field must be a JSON object.", path));
    return;
  }

  if (!nonEmptyString(field.id)) {
    diagnostics.push(error("dsl.field.id_required", "Field id is required.", `${path}/id`));
  } else {
    if (field.id.length > MK_FIELD_ID_MAX_LENGTH) {
      diagnostics.push(error("dsl.field.id_too_long", `Field id must not exceed ${MK_FIELD_ID_MAX_LENGTH} characters for MK.`, `${path}/id`, {
        id: field.id,
        length: field.id.length,
        maxLength: MK_FIELD_ID_MAX_LENGTH
      }));
    }
    if (ids?.has(field.id)) {
      diagnostics.push(error("dsl.field.id_duplicate", "Field id must be unique.", `${path}/id`, { id: field.id }));
    } else {
      ids?.add(field.id);
    }
  }

  if (!nonEmptyString(field.title)) {
    diagnostics.push(error("dsl.field.title_required", "Field title is required.", `${path}/title`));
  }

  if (!FIELD_TYPES.has(field.type)) {
    diagnostics.push(error("dsl.field.type_unsupported", "Field type is not supported by the migration DSL.", `${path}/type`, {
      current: field.type,
      supported: Array.from(FIELD_TYPES)
    }));
  }

  validateComponentProps({
    componentId: field.componentId,
    props: field.props,
    scope,
    path
  }, diagnostics);

  if (!isRecord(field.sourceProps)) {
    diagnostics.push(error("dsl.field.source_props_required", "sourceProps is required for audit and must be an object.", `${path}/sourceProps`));
  }
  if (!nonEmptyString(field.sourceRef) && field.generated !== true) {
    diagnostics.push(error("dsl.field.source_ref_required", "Field sourceRef is required unless generated is true.", `${path}/sourceRef`));
  }
  if (field.generated === true && !nonEmptyString(field.reason)) {
    diagnostics.push(error("dsl.field.generated_reason_required", "Generated fields must include a reason.", `${path}/reason`));
  }
  if (field.dataOnly !== undefined && typeof field.dataOnly !== "boolean") {
    diagnostics.push(error("dsl.field.data_only_type", "Field dataOnly must be a boolean when present.", `${path}/dataOnly`));
  }
  if (field.dataOnly === true && scope !== "field") {
    diagnostics.push(error("dsl.field.data_only_scope", "dataOnly is supported only on ordinary main-form fields.", `${path}/dataOnly`, {
      scope
    }));
  }
  if (field.dataOnly === true && field.props?.required === true) {
    diagnostics.push(error("dsl.field.data_only_required_forbidden", "Data-only fields cannot be required because they have no rendered input control.", `${path}/props/required`));
  }
}

function validateDetailColumns(columns, diagnostics, path) {
  if (!Array.isArray(columns) || columns.length === 0) {
    diagnostics.push(error("dsl.detail_table.columns_required", "Detail table fields must contain at least one column.", path));
    return;
  }

  const ids = new Set();
  columns.forEach((column, index) => {
    const columnPath = `${path}/${index}`;
    if (column?.type === "detailTable") {
      diagnostics.push(error("dsl.detail_table.column_type_unsupported", "Detail table columns cannot be detail tables.", `${columnPath}/type`));
    }
    validateFieldLike(column, diagnostics, columnPath, ids, "detailColumn");
  });
}

function collectDataAuthorityFieldIds(fields) {
  const ids = new Set();
  for (const field of fields || []) {
    if (!isRecord(field)) continue;
    if (nonEmptyString(field.id)) ids.add(field.id);
    if (field.type !== "detailTable") continue;
    for (const column of field.columns || []) {
      if (nonEmptyString(column?.id)) ids.add(column.id);
    }
  }
  return ids;
}

function validateFormLayout(layout, refs, diagnostics) {
  const layoutNodeIds = new Set();
  if (!isRecord(layout)) {
    diagnostics.push(error("dsl.form.layout_required", "form.layout is required.", "/form/layout"));
    return layoutNodeIds;
  }

  if (!isRecord(layout.sourceGrid)) {
    diagnostics.push(error("dsl.form.layout.source_grid_required", "form.layout.sourceGrid is required.", "/form/layout/sourceGrid"));
  }

  if (!Array.isArray(layout.mkTree) || layout.mkTree.length === 0) {
    diagnostics.push(error("dsl.form.layout.mk_tree_required", "form.layout.mkTree must contain explicit MK layout nodes.", "/form/layout/mkTree"));
    return layoutNodeIds;
  }

  layout.mkTree.forEach((node, index) => validateMkTreeNode(node, index, refs, diagnostics, layoutNodeIds));
  return layoutNodeIds;
}

function validateMkTreeNode(node, index, refs, diagnostics, layoutNodeIds) {
  const path = `/form/layout/mkTree/${index}`;
  if (!isRecord(node)) {
    diagnostics.push(error("dsl.form.layout.mk_tree.node_type", "mkTree node must be an object.", path));
    return;
  }
  if (!nonEmptyString(node.id)) {
    diagnostics.push(error("dsl.form.layout.mk_tree.node_id_required", "mkTree node id is required.", `${path}/id`));
  } else if (layoutNodeIds.has(node.id)) {
    diagnostics.push(error("dsl.form.layout.mk_tree.node_id_duplicate", "mkTree node id must be unique.", `${path}/id`, { id: node.id }));
  } else {
    layoutNodeIds.add(node.id);
  }

  const component = validateComponentProps({
    componentId: node.componentId,
    props: node.props,
    scope: "layout",
    path
  }, diagnostics);
  if (component && component.kind !== "layout") {
    diagnostics.push(error("dsl.form.layout.component_kind_invalid", "mkTree node componentId must be a layout component.", `${path}/componentId`));
  }

  if (!nonEmptyString(node.sourceRef) && node.generated !== true) {
    diagnostics.push(error("dsl.form.layout.source_ref_required", "mkTree node sourceRef is required unless generated is true.", `${path}/sourceRef`));
  }

  if (!Array.isArray(node.children) || node.children.length === 0) {
    diagnostics.push(error("dsl.form.layout.children_required", "mkTree layout nodes must contain children references.", `${path}/children`));
    return;
  }

  node.children.forEach((child, childIndex) => {
    const childPath = `${path}/children/${childIndex}`;
    if (!isRecord(child)) {
      diagnostics.push(error("dsl.form.layout.child_type", "mkTree child must be an object.", childPath));
      return;
    }
    if (!["field", "detailTable", "layout"].includes(child.refType)) {
      diagnostics.push(error("dsl.form.layout.child_ref_type_invalid", "mkTree child refType must be field, detailTable, or layout.", `${childPath}/refType`));
    }
    const refIds = Array.isArray(child.refIds) ? child.refIds : [child.refId].filter(Boolean);
    if (!refIds.length) {
      diagnostics.push(error("dsl.form.layout.child_ref_required", "mkTree child must reference at least one field, detail table, or layout node.", `${childPath}/refIds`));
    }
    refIds.forEach((refId, refIndex) => {
      const refPath = Array.isArray(child.refIds) ? `${childPath}/refIds/${refIndex}` : `${childPath}/refId`;
      if (!nonEmptyString(refId)) {
        diagnostics.push(error("dsl.form.layout.child_ref_required", "mkTree child reference must be a non-empty string.", refPath));
        return;
      }
      if (child.refType === "field" && !refs.fieldIds.has(refId)) {
        diagnostics.push(error("dsl.form.layout.field_missing", "mkTree child field reference must exist in form.fields.", refPath, { refId }));
      }
      if (child.refType === "field" && refs.dataOnlyFieldIds.has(refId)) {
        diagnostics.push(error("dsl.form.layout.data_only_field_rendered", "Data-only fields must not be referenced by form.layout.mkTree.", refPath, { refId }));
      }
      if (child.refType === "detailTable" && !refs.detailTableIds.has(refId)) {
        diagnostics.push(error("dsl.form.layout.detail_table_missing", "mkTree child detail-table reference must exist in form.fields.", refPath, { refId }));
      }
    });
  });
}

function validateFormRules(formRules, diagnostics, context) {
  if (formRules === undefined) return;
  if (!isRecord(formRules)) {
    diagnostics.push(error("dsl.form_rules.type", "formRules must be a JSON object.", "/formRules"));
    return;
  }

  if (!Array.isArray(formRules.linkage)) {
    diagnostics.push(error("dsl.form_rules.linkage_required", "formRules.linkage must be an array.", "/formRules/linkage"));
    return;
  }
  if (formRules.validations !== undefined && !Array.isArray(formRules.validations)) {
    diagnostics.push(error("dsl.form_rules.validations_type", "formRules.validations must be an array when present.", "/formRules/validations"));
  }
  if (formRules.impliedRequired !== undefined && !Array.isArray(formRules.impliedRequired)) {
    diagnostics.push(error("dsl.form_rules.implied_required_type", "formRules.impliedRequired must be an array when present.", "/formRules/impliedRequired"));
  }
  if (formRules.review !== undefined && !isRecord(formRules.review)) {
    diagnostics.push(error("dsl.form_rules.review_type", "formRules.review must be an object when present.", "/formRules/review"));
  }

  const refIndex = buildFormRuleRefIndex(context.form || {});
  formRules.linkage.forEach((rule, ruleIndex) => validateLinkageRule(rule, ruleIndex, diagnostics, {
    ...context,
    refIndex
  }));
}

function validateLinkageRule(rule, ruleIndex, diagnostics, context) {
  const path = `/formRules/linkage/${ruleIndex}`;
  if (!isRecord(rule)) {
    diagnostics.push(error("dsl.form_rules.linkage.type", "formRules.linkage[] must be an object.", path));
    return;
  }

  if (!nonEmptyString(rule.id)) {
    diagnostics.push(error("dsl.form_rules.linkage.id_required", "formRules.linkage[].id is required.", `${path}/id`));
  }
  if (!FORM_RULE_TRIGGERS.has(rule.trigger)) {
    diagnostics.push(error("dsl.form_rules.linkage.trigger_unsupported", "formRules.linkage[].trigger must be change or load.", `${path}/trigger`, {
      actual: rule.trigger
    }));
  }
  if (rule.source !== undefined && !nonEmptyString(rule.source)) {
    diagnostics.push(error("dsl.form_rules.linkage.source_type", "formRules.linkage[].source must be a non-empty string when present.", `${path}/source`));
  }
  if (!FORM_RULE_LOGIC.has(rule.logic)) {
    diagnostics.push(error("dsl.form_rules.linkage.logic_unsupported", "formRules.linkage[].logic must be \"and\" or \"or\".", `${path}/logic`, {
      actual: rule.logic
    }));
  }
  if (!["executable", "needs_review", "manual"].includes(rule.translationStatus)) {
    diagnostics.push(error("dsl.form_rules.linkage.status_unsupported", "formRules.linkage[].translationStatus must be executable, needs_review, or manual.", `${path}/translationStatus`, {
      actual: rule.translationStatus
    }));
  }
  if (context.mode === "execute" && rule.translationStatus !== "executable") {
    diagnostics.push(error("dsl.form_rules.linkage_not_executable", "Executable DSL cannot contain formRules.linkage entries that still need review.", `${path}/translationStatus`));
  }

  validateLinkageConditions(rule.when, `${path}/when`, diagnostics, context, rule);
  validateLinkageEffects(rule.effects, `${path}/effects`, diagnostics, context, rule);
  if (rule.else !== undefined) {
    validateLinkageEffects(rule.else, `${path}/else`, diagnostics, context, rule);
  }
}

function validateLinkageConditions(when, path, diagnostics, context, rule) {
  if (!Array.isArray(when) || when.length === 0) {
    diagnostics.push(error("dsl.form_rules.when_required", "Executable formRules.linkage entries require non-empty when[].", path));
    return;
  }

  when.forEach((condition, conditionIndex) => {
    const conditionPath = `${path}/${conditionIndex}`;
    if (!isRecord(condition)) {
      diagnostics.push(error("dsl.form_rules.when.type", "formRules.linkage[].when[] must be an object.", conditionPath));
      return;
    }
    if (!nonEmptyString(condition.field)) {
      diagnostics.push(error("dsl.form_rules.when.field_required", "formRules.linkage[].when[].field is required.", `${conditionPath}/field`));
    } else if (context.mode === "execute" && rule.translationStatus === "executable" && !resolveDirectRef(context.refIndex, condition.field)) {
      diagnostics.push(error("dsl.form_rules.condition_field_unresolved", "Executable formRules.linkage condition field must resolve to a form field or detail column.", `${conditionPath}/field`, {
        ref: condition.field,
        ruleId: rule.id
      }));
    }
    if (!FORM_RULE_OPERATORS.has(condition.op)) {
      diagnostics.push(error("dsl.form_rules.when.op_unsupported", "formRules.linkage[].when[].op is not supported.", `${conditionPath}/op`, {
        actual: condition.op,
        supported: Array.from(FORM_RULE_OPERATORS)
      }));
    }
    if (!["empty", "notEmpty"].includes(condition.op) && condition.value === undefined) {
      diagnostics.push(error("dsl.form_rules.when.value_required", "formRules.linkage[].when[].value is required for this op.", `${conditionPath}/value`, {
        op: condition.op
      }));
    }
  });
}

function validateLinkageEffects(effects, path, diagnostics, context, rule) {
  if (!Array.isArray(effects) || effects.length === 0) {
    diagnostics.push(error("dsl.form_rules.effects_required", "formRules.linkage effect branches must be non-empty arrays.", path));
    return;
  }

  effects.forEach((effect, effectIndex) => {
    const effectPath = `${path}/${effectIndex}`;
    if (!isRecord(effect)) {
      diagnostics.push(error("dsl.form_rules.effect.type", "formRules.linkage effects must be objects.", effectPath));
      return;
    }
    if (!FORM_RULE_EFFECT_TYPES.has(effect.type)) {
      diagnostics.push(error("dsl.form_rules.effect.type_unsupported", "formRules.linkage effects support only visible and required.", `${effectPath}/type`, {
        actual: effect.type
      }));
    }
    if (!nonEmptyString(effect.target)) {
      diagnostics.push(error("dsl.form_rules.effect.target_required", "formRules.linkage effects require target.", `${effectPath}/target`));
    } else if (context.mode === "execute" && rule.translationStatus === "executable") {
      const resolved = resolveEffectTarget(context.refIndex, effect.target);
      if (!resolved || resolved.unresolved?.length || !resolved.targets.length) {
        diagnostics.push(error("dsl.form_rules.effect_target_unresolved", "Executable formRules.linkage effect target must resolve through direct fields or mkTree.sourceMarkers.", `${effectPath}/target`, {
          ref: effect.target,
          ruleId: rule.id,
          unresolved: resolved?.unresolved
        }));
      } else if (resolved.targets.some((target) => target.field?.dataOnly === true)) {
        diagnostics.push(error("dsl.form_rules.data_only_effect_forbidden", "Visible/required form-rule effects cannot target data-only fields.", `${effectPath}/target`, {
          ref: effect.target,
          ruleId: rule.id,
          dataOnlyFieldIds: resolved.targets.filter((target) => target.field?.dataOnly === true).map((target) => target.id)
        }));
      }
    }
    if (typeof effect.value !== "boolean") {
      diagnostics.push(error("dsl.form_rules.effect.value_required", "formRules.linkage effects require boolean value.", `${effectPath}/value`));
    }
  });
}

function validateReview(review, diagnostics, trustLevel) {
  if (!isRecord(review)) return;

  const warnings = Array.isArray(review.warnings) ? review.warnings : [];
  for (const warningItem of warnings) {
    diagnostics.push(warning(
      warningItem.code || "dsl.review.warning",
      warningItem.message || "DSL contains a review warning.",
      warningItem.path || "/review/warnings",
      warningItem.details
    ));
  }

  const errors = Array.isArray(review.errors) ? review.errors : [];
  for (const reviewError of errors) {
    diagnostics.push(error(
      reviewError.code || "dsl.review.error",
      reviewError.message || "DSL contains a review error.",
      reviewError.path || "/review/errors",
      reviewError.details
    ));
  }

  validateFunctionCatalogAudit(review.functionWhitelist, diagnostics);
  validateAgentReview(review.agentReview, diagnostics);

  if (trustLevel !== "trusted" && Array.isArray(review.decisions) && review.decisions.length) {
    diagnostics.push(error("dsl.review.decisions_not_allowed_in_draft", "review.decisions[] is allowed only in trusted DSL.", "/review/decisions"));
  }
  if (trustLevel === "trusted") {
    if (!Array.isArray(review.decisions)) {
      diagnostics.push(error("dsl.review.decisions_required", "Trusted DSL must contain review.decisions[].", "/review/decisions"));
    } else {
      review.decisions.forEach((decision, index) => {
        const path = `/review/decisions/${index}`;
        if (decision?.status === "blocked") {
          diagnostics.push(error("dsl.review.decision_blocked", "Blocked review decisions fail execution checks.", `${path}/status`));
        }
        for (const key of ["status", "decisionType", "rationale", "result"]) {
          if (!nonEmptyString(decision?.[key])) {
            diagnostics.push(error("dsl.review.decision_field_required", `review.decisions[].${key} is required.`, `${path}/${key}`));
          }
        }
      });
    }
  }
}

function validateAgentReview(agentReview, diagnostics) {
  if (agentReview === undefined) return;
  if (!isRecord(agentReview)) {
    diagnostics.push(error("dsl.review.agent_review_type", "review.agentReview must be an object when present.", "/review/agentReview"));
    return;
  }

  for (const key of ["provider", "baseUrl", "model", "promptVersion", "reviewedAt", "summary"]) {
    if (!nonEmptyString(agentReview[key])) {
      diagnostics.push(error("dsl.review.agent_review_field_required", `review.agentReview.${key} is required.`, `/review/agentReview/${key}`));
    }
  }
  for (const key of ["patchCount", "diagnosticCount"]) {
    if (!Number.isInteger(agentReview[key]) || agentReview[key] < 0) {
      diagnostics.push(error("dsl.review.agent_review_count_invalid", `review.agentReview.${key} must be a non-negative integer.`, `/review/agentReview/${key}`));
    }
  }
  const forbiddenSecretKeys = ["apiKey", "OPENAI_API_KEY", "authorization", "headers", "credentials"];
  for (const key of forbiddenSecretKeys) {
    if (Object.hasOwn(agentReview, key)) {
      diagnostics.push(error("dsl.review.agent_review_secret_forbidden", "review.agentReview must not include API keys or credential-bearing request data.", `/review/agentReview/${key}`));
    }
  }
}

function validateScripts(scripts, diagnostics, context) {
  if (scripts === undefined) return;
  if (!isRecord(scripts)) {
    diagnostics.push(error("dsl.scripts.type", "scripts must be a JSON object.", "/scripts"));
    return;
  }

  if (!Array.isArray(scripts.actions)) {
    diagnostics.push(error("dsl.scripts.actions_required", "scripts.actions must be an array when scripts are present.", "/scripts/actions"));
    return;
  }

  scripts.actions.forEach((action, index) => {
    const path = `/scripts/actions/${index}`;
    if (!isRecord(action)) {
      diagnostics.push(error("dsl.scripts.action.type", "Script action must be a JSON object.", path));
      return;
    }
    for (const key of ["id", "name", "event", "translationStatus", "scope"]) {
      if (!nonEmptyString(action[key])) {
        diagnostics.push(error("dsl.scripts.action_field_required", `scripts.actions[].${key} is required.`, `${path}/${key}`));
      }
    }
    if (action.translationStatus !== "omitted" && !nonEmptyString(action.function)) {
      diagnostics.push(error("dsl.scripts.action_field_required", "scripts.actions[].function is required unless translationStatus is omitted.", `${path}/function`));
    }
    if (!SCRIPT_EVENTS.has(action.event)) {
      diagnostics.push(error("dsl.scripts.event_unsupported", "Script action event is not in the MK control-events catalog.", `${path}/event`, {
        actual: action.event
      }));
    }
    if (!SCRIPT_TRANSLATION_STATUSES.has(action.translationStatus)) {
      diagnostics.push(error("dsl.scripts.translation_status_invalid", "Script action translationStatus must be mapped, needs_review, manual, or omitted.", `${path}/translationStatus`, {
        actual: action.translationStatus
      }));
    }
    const coverageResiduals = Array.isArray(action.coverage?.residuals) ? action.coverage.residuals : [];
    if (action.translationStatus === "mapped" && coverageResiduals.length) {
      diagnostics.push(error("dsl.scripts.mapped_with_residuals", "Mapped script actions cannot retain untranslated coverage residuals.", `${path}/coverage/residuals`));
    }
    if (action.coverage?.status !== undefined && !SCRIPT_COVERAGE_STATUSES.has(action.coverage.status)) {
      diagnostics.push(error("dsl.scripts.coverage_status_invalid", "Script coverage.status must be none, partial, uncovered, covered, or translated.", `${path}/coverage/status`, {
        actual: action.coverage.status
      }));
    }
    validateStaticPropCoverage(action.coverage?.staticProps, context.form, `${path}/coverage/staticProps`, diagnostics);
    if (action.translationStatus === "mapped" && !["translated", "covered"].includes(action.coverage?.status)) {
      diagnostics.push(error("dsl.scripts.mapped_coverage_status_invalid", "Mapped script actions must mark source behavior as translated or covered before execution.", `${path}/coverage/status`, {
        actual: action.coverage?.status
      }));
    }
    if (action.translationStatus === "mapped" && (!Array.isArray(action.functionMappings) || action.functionMappings.length === 0)) {
      diagnostics.push(error("dsl.scripts.mapped_function_mappings_required", "Mapped script actions must record at least one functionMappings[] evidence entry.", `${path}/functionMappings`));
    }
    if (action.translationStatus === "omitted" && action.coverage?.status !== "covered") {
      diagnostics.push(error("dsl.scripts.omitted_not_covered", "Omitted script actions must be fully covered by native formRules or static form properties.", `${path}/coverage/status`, {
        actual: action.coverage?.status
      }));
    }
    if (
      action.translationStatus === "omitted" &&
      action.coverage?.staticProps !== undefined &&
      !hasCompleteOmissionCoverage(action, context)
    ) {
      diagnostics.push(error("dsl.scripts.omitted_coverage_incomplete", "Omitted script actions require complete, residual-free native-rule or static-property coverage evidence.", `${path}/coverage`));
    }
    validateScriptRunWhen(action, path, diagnostics);
    if (
      action.translationStatus === "omitted" &&
      action.runWhen !== undefined &&
      !hasCompleteExecutableNativeCoverage(action, context.formRules) &&
      !hasLegacyRuntimeNoopCoverage(action)
    ) {
      diagnostics.push(error("dsl.scripts.gated_omission_forbidden", "View-gated script actions may be omitted only when the empty action body is fully covered by referenced executable native form rules or a legacy runtime no-op with no residuals.", `${path}/translationStatus`));
    }
    if (!SCRIPT_SCOPES.has(action.scope)) {
      diagnostics.push(error("dsl.scripts.scope_invalid", "Script action scope must be global or control.", `${path}/scope`, {
        actual: action.scope
      }));
    }
    validateScriptActionTarget(action, path, diagnostics, context);
    validateScriptActionFunction(action, path, diagnostics, context);
    if (context.mode === "execute" && ["needs_review", "manual"].includes(action.translationStatus)) {
      diagnostics.push(error("dsl.scripts.needs_review", "Executable DSL cannot contain script actions that still need review or manual handling.", `${path}/translationStatus`, {
        actual: action.translationStatus
      }));
    }
  });
}

function hasCompleteOmissionCoverage(action, context) {
  if (nonEmptyString(action.function)) return false;
  if (action.coverage?.status !== "covered") return false;
  if (!Array.isArray(action.coverage?.residuals) || action.coverage.residuals.length) return false;
  const nativeRules = Array.isArray(action.coverage?.nativeRules) ? action.coverage.nativeRules : [];
  const staticProps = Array.isArray(action.coverage?.staticProps) ? action.coverage.staticProps : [];
  return nativeRules.length + staticProps.length > 0 &&
    nativeRulesAreExecutable(nativeRules, context.formRules) &&
    staticProps.every((entry) => staticPropCoverageSatisfied(entry, context.form));
}

function hasCompleteExecutableNativeCoverage(action, formRules) {
  if (nonEmptyString(action.function)) return false;
  if (action.coverage?.status !== "covered") return false;
  if (!Array.isArray(action.coverage?.residuals) || action.coverage.residuals.length) return false;
  const nativeRules = Array.isArray(action.coverage?.nativeRules) ? action.coverage.nativeRules : [];
  if (!nativeRules.length) return false;
  return nativeRulesAreExecutable(nativeRules, formRules);
}

function hasLegacyRuntimeNoopCoverage(action) {
  if (nonEmptyString(action.function)) return false;
  if (action.coverage?.status !== "covered") return false;
  if (!Array.isArray(action.coverage?.residuals) || action.coverage.residuals.length) return false;
  if (Array.isArray(action.coverage?.nativeRules) && action.coverage.nativeRules.length) return false;
  if (Array.isArray(action.coverage?.staticProps) && action.coverage.staticProps.length) return false;
  return (Array.isArray(action.functionMappings) ? action.functionMappings : [])
    .some((mapping) => mapping?.basis === "legacy-runtime-noop" && mapping.reviewRequired === false);
}

function nativeRulesAreExecutable(nativeRules, formRules) {
  const executableRuleIds = new Set(
    (Array.isArray(formRules?.linkage) ? formRules.linkage : [])
      .filter((rule) => rule?.translationStatus === "executable" && nonEmptyString(rule.id))
      .map((rule) => rule.id)
  );
  return nativeRules.every((ruleId) => executableRuleIds.has(ruleId));
}

function validateStaticPropCoverage(staticProps, form, path, diagnostics) {
  if (staticProps === undefined) return;
  if (!Array.isArray(staticProps)) {
    diagnostics.push(error("dsl.scripts.static_props_type", "Script coverage.staticProps must be an array when present.", path));
    return;
  }

  staticProps.forEach((entry, index) => {
    const entryPath = `${path}/${index}`;
    if (!isRecord(entry)) {
      diagnostics.push(error("dsl.scripts.static_prop_type", "Script static-property coverage entries must be objects.", entryPath));
      return;
    }
    if (entry.prop !== "required" || entry.value !== true) {
      diagnostics.push(error("dsl.scripts.static_prop_unsupported", "Static script coverage currently supports only { prop: \"required\", value: true }.", entryPath, {
        prop: entry.prop,
        value: entry.value
      }));
      return;
    }
    const field = findStaticCoverageField(form, entry.fieldId);
    if (!field) {
      diagnostics.push(error("dsl.scripts.static_prop_field_missing", "Static script coverage must reference an existing ordinary form field.", `${entryPath}/fieldId`, {
        fieldId: entry.fieldId
      }));
      return;
    }
    if (field.props?.required !== true) {
      diagnostics.push(error("dsl.scripts.static_prop_not_satisfied", "Static script coverage requires the referenced field to keep props.required=true.", entryPath, {
        fieldId: entry.fieldId,
        actual: field.props?.required
      }));
    }
  });
}

function staticPropCoverageSatisfied(entry, form) {
  return isRecord(entry) &&
    entry.prop === "required" &&
    entry.value === true &&
    findStaticCoverageField(form, entry.fieldId)?.props?.required === true;
}

function findStaticCoverageField(form, fieldId) {
  if (!nonEmptyString(fieldId)) return undefined;
  return (Array.isArray(form?.fields) ? form.fields : [])
    .find((field) => field?.id === fieldId && field?.type !== "detailTable");
}

function validateScriptRunWhen(action, path, diagnostics) {
  if (action.runWhen === undefined) return;
  const runWhen = action.runWhen;
  const keys = isRecord(runWhen) ? Object.keys(runWhen) : [];
  const statuses = isRecord(runWhen) ? runWhen.viewStatusIn : undefined;
  const canonical = Array.isArray(statuses) && (
    JSON.stringify(statuses) === JSON.stringify(["add", "edit"]) ||
    JSON.stringify(statuses) === JSON.stringify(["view"])
  );
  if (!isRecord(runWhen) || keys.length !== 1 || keys[0] !== "viewStatusIn" || !canonical) {
    diagnostics.push(error("dsl.scripts.run_when_invalid", "scripts.actions[].runWhen must be exactly { viewStatusIn: [\"add\", \"edit\"] } or { viewStatusIn: [\"view\"] }.", `${path}/runWhen`, {
      actual: runWhen
    }));
  }
}

function validateScriptActionTarget(action, path, diagnostics, context) {
  if (action.scope === "global") {
    if (!SCRIPT_GLOBAL_EVENTS.has(action.event)) {
      diagnostics.push(error("dsl.scripts.global_event_invalid", "Global script actions support only onLoad, onBeforeSubmit, and onAfterSubmit.", `${path}/event`, {
        actual: action.event
      }));
    }
    if (action.controlId !== undefined) {
      diagnostics.push(error("dsl.scripts.global_control_forbidden", "Global script actions must not set controlId.", `${path}/controlId`));
    }
    if (action.tableId !== undefined) {
      diagnostics.push(error("dsl.scripts.global_table_forbidden", "Global script actions must not set tableId.", `${path}/tableId`));
    }
    return;
  }

  if (action.scope === "control") {
    if (action.translationStatus === "omitted") return;
    const target = resolveScriptControlTarget(context.form, action);
    if (!target.ok) {
      if (context.mode !== "execute" && ["needs_review", "manual"].includes(action.translationStatus)) {
        diagnostics.push(warning(`dsl.scripts.${target.code}_pending_review`, target.message, `${path}/controlId`, {
          controlId: target.controlId,
          tableId: target.tableId
        }));
        return;
      }
      diagnostics.push(error(`dsl.scripts.${target.code}`, target.message, `${path}/controlId`, {
        controlId: target.controlId,
        tableId: target.tableId
      }));
      return;
    }

    const support = resolveControlEventSupport(target, action.event);
    if (support.status === "unsupported") {
      diagnostics.push(error("dsl.scripts.control_event_unsupported", "Control script action event is not supported by the target MK component.", `${path}/event`, {
        actual: action.event,
        componentId: support.componentId,
        supportedEvents: support.supportedEvents,
        scope: support.scope,
        reason: support.reason
      }));
    }
    if (support.status === "unknown") {
      const diagnostic = context.mode === "execute" ? error : warning;
      diagnostics.push(diagnostic("dsl.scripts.control_event_unknown", "Control script action event support is not verified for the target MK component.", `${path}/event`, {
        actual: action.event,
        componentId: support.componentId,
        supportedEvents: support.supportedEvents,
        scope: support.scope,
        reason: support.reason
      }));
    }
  }
}

function validateScriptActionFunction(action, path, diagnostics, context) {
  if (action.translationStatus === "omitted") {
    if (nonEmptyString(action.function)) {
      diagnostics.push(error("dsl.scripts.omitted_function_forbidden", "Omitted script actions must not carry executable function text.", `${path}/function`));
    }
    return;
  }
  if (!nonEmptyString(action.function)) return;

  try {
    // Syntax-only check; function declarations inside the body are not executed.
    // eslint-disable-next-line no-new-func
    new Function(action.function);
  } catch (syntaxError) {
    diagnostics.push(error("dsl.scripts.function_syntax_invalid", "Script action function must be valid JavaScript.", `${path}/function`, {
      message: syntaxError instanceof Error ? syntaxError.message : String(syntaxError)
    }));
    return;
  }

  const expectedName = action.name || action.event;
  const params = parseNamedFunctionParams(action.function, expectedName);
  if (!params) {
    diagnostics.push(error("dsl.scripts.function_name_missing", "Script function must declare the action name.", `${path}/function`, {
      expectedName
    }));
  }
  if (action.event === "onChange") {
    if (!params?.length || params[0] !== "value") {
      diagnostics.push(error("dsl.scripts.on_change_value_param_required", "onChange functions must declare value as the first parameter.", `${path}/function`));
    }
    if (action.tableId && (!params || params[1] !== "rowNum")) {
      diagnostics.push(error("dsl.scripts.on_change_row_param_required", "Detail-table onChange functions must declare rowNum as the second parameter.", `${path}/function`));
    }
  }
  if (action.event === "onBeforeSubmit") {
    if (!hasExplicitBeforeSubmitReturn(action.function)) {
      diagnostics.push(error("dsl.scripts.before_submit_return_required", "onBeforeSubmit must explicitly return true, false, or Promise<boolean>.", `${path}/function`));
    }
    if (!handlesDraftContext(action.function)) {
      diagnostics.push(error("dsl.scripts.before_submit_draft_guard_required", "onBeforeSubmit must explicitly handle context.isDraft.", `${path}/function`));
    }
  }

  if (context.mode === "execute" || action.translationStatus === "mapped") {
    const analysis = analyzeScriptFunction(action.function);
    if (analysis.domUsages.length) {
      diagnostics.push(error("dsl.scripts.dom_api_forbidden", "Mapped script actions must use MK component APIs instead of direct DOM APIs.", `${path}/function`, {
        usages: analysis.domUsages
      }));
    }
    if (analysis.disallowedTargetCalls.length) {
      diagnostics.push(error("dsl.scripts.target_api_unsupported", "Mapped script actions may call only target APIs from the script target catalog.", `${path}/function`, {
        calls: analysis.disallowedTargetCalls.map((call) => ({
          name: call.name,
          safety: call.targetApi?.safety,
          reason: call.targetApi?.reason,
          snippet: call.snippet
        })),
        targetApi: scriptTargetApiSummary()
      }));
    }
    if (analysis.reviewTargetCalls.length && !hasReviewTargetEvidence(action)) {
      const diagnostic = context.mode === "execute" ? error : warning;
      diagnostics.push(diagnostic("dsl.scripts.review_target_api_evidence_required", "Review-grade target APIs require functionMappings and coverage.status translated or covered before executable mapping.", `${path}/function`, {
        calls: analysis.reviewTargetCalls.map((call) => call.name),
        coverageStatus: action.coverage?.status,
        functionMappingCount: Array.isArray(action.functionMappings) ? action.functionMappings.length : 0
      }));
    }
    if (analysis.disallowedCalls.length) {
      diagnostics.push(error("dsl.scripts.call_unsupported", "Mapped script actions may call only local helpers, cataloged JavaScript methods, and whitelisted MKXFORM APIs.", `${path}/function`, {
        calls: analysis.disallowedCalls
      }));
    }
    const setFieldAttrIssues = validateSetFieldAttrTargets(action.function, context.form);
    if (setFieldAttrIssues.length) {
      diagnostics.push(error("dsl.scripts.set_field_attr_target_invalid", "Mapped MKXFORM.setFieldAttr targets must be main field ids or layout sourceMarkers, not detail-table ids or ${table:...} placeholders.", `${path}/function`, {
        issues: setFieldAttrIssues
      }));
    }
  }
}

function hasReviewTargetEvidence(action) {
  const coverageStatus = action.coverage?.status;
  const residuals = Array.isArray(action.coverage?.residuals) ? action.coverage.residuals : [];
  return ["translated", "covered"].includes(coverageStatus) &&
    residuals.length === 0 &&
    Array.isArray(action.functionMappings) &&
    action.functionMappings.length > 0;
}

function validateWorkflow(workflow, diagnostics, context) {
  if (!isRecord(workflow)) {
    diagnostics.push(error("dsl.workflow.type", "workflow must be a JSON object.", "/workflow"));
    return;
  }

  const process = isRecord(workflow.process) ? workflow.process : {};
  if (!isRecord(workflow.process)) {
    diagnostics.push(error("dsl.workflow.process_required", "workflow.process is required.", "/workflow/process"));
  } else if (!nonEmptyString(process.id)) {
    diagnostics.push(error("dsl.workflow.process.id_required", "workflow.process.id is required.", "/workflow/process/id"));
  }

  const nodeMap = validateWorkflowNodes(workflow.nodes, diagnostics, context);
  validateWorkflowParticipantNodeReferences(workflow.nodes, nodeMap, diagnostics);
  const edges = validateWorkflowEdges(workflow.edges, nodeMap, diagnostics);
  validateTopologicalOrder(workflow.topologicalOrder, nodeMap, edges, diagnostics);
  validateWorkflowConnectivity(nodeMap, edges, diagnostics);
  validateWorkflowConditions(edges, diagnostics, context);
  validateParallelGateways(workflow.nodes, nodeMap, diagnostics);
}

function validateWorkflowNodes(nodes, diagnostics, context) {
  const nodeMap = new Map();

  if (!Array.isArray(nodes) || nodes.length === 0) {
    diagnostics.push(error("dsl.workflow.nodes_required", "workflow.nodes must contain at least one node.", "/workflow/nodes"));
    return nodeMap;
  }

  nodes.forEach((node, index) => {
    const path = `/workflow/nodes/${index}`;
    if (!isRecord(node)) {
      diagnostics.push(error("dsl.workflow.node.type", "Workflow node must be a JSON object.", path));
      return;
    }

    if (!nonEmptyString(node.id)) {
      diagnostics.push(error("dsl.workflow.node.id_required", "Workflow node id is required.", `${path}/id`));
    } else if (nodeMap.has(node.id)) {
      diagnostics.push(error("dsl.workflow.node.id_duplicate", "Workflow node id must be unique.", `${path}/id`, { id: node.id }));
    } else {
      nodeMap.set(node.id, node);
    }

    if (!WORKFLOW_NODE_TYPES.has(node.type)) {
      diagnostics.push(error("dsl.workflow.node.type_unsupported", "Workflow node type must be explicit NewOA execution semantics.", `${path}/type`, {
        current: node.type
      }));
    }
    if (!WORKFLOW_NODE_ELEMENTS.has(node.element)) {
      diagnostics.push(error("dsl.workflow.node.element_unsupported", "Workflow node element must be explicit NewOA graph semantics.", `${path}/element`, {
        current: node.element
      }));
    }
    if (["split", "join"].includes(node.type) && node.element !== "parallelGateway") {
      diagnostics.push(error("dsl.workflow.parallel_gateway.element_required", "Parallel split/join nodes must use element = parallelGateway.", `${path}/element`, {
        current: node.element
      }));
    }
    if (!nonEmptyString(node.sourceRef) && node.generated !== true) {
      diagnostics.push(error("dsl.workflow.node.source_ref_required", "Workflow node sourceRef is required unless generated is true.", `${path}/sourceRef`));
    }
    validateParticipants(node.participants, diagnostics, `${path}/participants`, context);
    validateNodeDataAuthority(node.dataAuthority, diagnostics, `${path}/dataAuthority`, context);
    if (context.mode === "execute" && node.translationStatus === "pending_review") {
      diagnostics.push(error("dsl.workflow.node.pending_review", "Executable workflow nodes cannot remain pending_review.", `${path}/translationStatus`));
    }
  });

  return nodeMap;
}

function validateNodeDataAuthority(dataAuthority, diagnostics, path, context) {
  if (dataAuthority === undefined) return;
  if (!isRecord(dataAuthority)) {
    diagnostics.push(error("dsl.workflow.data_authority.type", "Node dataAuthority must be a JSON object.", path));
    return;
  }
  if (dataAuthority.enabled !== undefined && typeof dataAuthority.enabled !== "boolean") {
    diagnostics.push(error("dsl.workflow.data_authority.enabled_type", "Node dataAuthority.enabled must be a boolean.", `${path}/enabled`));
  }

  const fields = dataAuthority.fields;
  if (!isRecord(fields)) {
    if (dataAuthority.enabled !== false) {
      diagnostics.push(error("dsl.workflow.data_authority.fields_required", "Enabled node dataAuthority requires fields.", `${path}/fields`));
    }
    return;
  }
  if (dataAuthority.enabled !== false && Object.keys(fields).length === 0) {
    diagnostics.push(error("dsl.workflow.data_authority.fields_required", "Enabled node dataAuthority requires at least one field.", `${path}/fields`));
  }

  for (const [fieldId, value] of Object.entries(fields)) {
    const fieldPath = `${path}/fields/${escapePointer(fieldId)}`;
    if (!nonEmptyString(fieldId)) {
      diagnostics.push(error("dsl.workflow.data_authority.field_id_required", "Node dataAuthority field keys must be non-empty field ids.", fieldPath));
    } else if (
      context.mode === "execute" &&
      context.dataAuthorityFieldIds instanceof Set &&
      !context.dataAuthorityFieldIds.has(fieldId)
    ) {
      diagnostics.push(error("dsl.workflow.data_authority.field_missing", "Executable node dataAuthority field must reference an existing form field or detail column.", fieldPath, {
        fieldId
      }));
    }

    if (!isRecord(value)) {
      diagnostics.push(error("dsl.workflow.data_authority.field_type", "Node dataAuthority field entry must be a JSON object.", fieldPath));
      continue;
    }
    for (const key of ["visible", "editable", "required"]) {
      if (typeof value[key] !== "boolean") {
        diagnostics.push(error("dsl.workflow.data_authority.flag_required", `Node dataAuthority field ${key} must be a boolean.`, `${fieldPath}/${key}`));
      }
    }
    if (value.sourceMode !== undefined && !["hidden", "view", "edit"].includes(value.sourceMode)) {
      diagnostics.push(error("dsl.workflow.data_authority.source_mode_invalid", "Node dataAuthority sourceMode must be hidden, view, or edit when present.", `${fieldPath}/sourceMode`, {
        actual: value.sourceMode
      }));
    }
    if (value.sourceRef !== undefined && !nonEmptyString(value.sourceRef)) {
      diagnostics.push(error("dsl.workflow.data_authority.source_ref_type", "Node dataAuthority sourceRef must be a non-empty string when present.", `${fieldPath}/sourceRef`));
    }
  }
}

function validateParallelGateways(nodes, nodeMap, diagnostics) {
  if (!Array.isArray(nodes)) return;

  nodes.forEach((node, index) => {
    if (!isRecord(node) || !["split", "join"].includes(node.type)) return;
    if (node.translationStatus !== "executable") return;

    const path = `/workflow/nodes/${index}`;
    const attrs = workflowNodeAttributes(node);
    const relatedIds = splitRelatedNodeIds(attrs.relatedNodeIds);
    if (relatedIds.length !== 1) {
      diagnostics.push(error("dsl.workflow.parallel_gateway.related_single_required", "Executable parallel gateways require exactly one relatedNodeIds value.", `${path}/attributes/relatedNodeIds`, {
        current: attrs.relatedNodeIds
      }));
      return;
    }

    const related = nodeMap.get(relatedIds[0]);
    const expectedRelatedType = node.type === "split" ? "join" : "split";
    if (!related || related.type !== expectedRelatedType) {
      diagnostics.push(error("dsl.workflow.parallel_gateway.related_type_mismatch", "Executable parallel gateways must point to the opposite split/join node.", `${path}/attributes/relatedNodeIds`, {
        relatedNodeId: relatedIds[0],
        expectedType: expectedRelatedType,
        actualType: related?.type
      }));
      return;
    }

    const relatedBackIds = splitRelatedNodeIds(workflowNodeAttributes(related).relatedNodeIds);
    if (relatedBackIds.length !== 1 || relatedBackIds[0] !== node.id) {
      diagnostics.push(error("dsl.workflow.parallel_gateway.related_not_reciprocal", "Executable parallel gateway pairs must reference each other.", `${path}/attributes/relatedNodeIds`, {
        relatedNodeId: related.id,
        relatedBackIds
      }));
    }

    if (!isSupportedParallelGatewayPair(node, related)) {
      const modeKey = node.type === "split" ? "splitType" : "joinType";
      diagnostics.push(error("dsl.workflow.parallel_gateway.mode_unsupported", "Executable parallel gateways must be all/all, or a condition split paired with an all join.", `${path}/definition/attributes/${modeKey}`, {
        current: attrs[modeKey]
      }));
    }
  });
}

function isSupportedParallelGatewayPair(node, related) {
  const attrs = workflowNodeAttributes(node);
  const relatedAttrs = workflowNodeAttributes(related);
  const modeKey = node.type === "split" ? "splitType" : "joinType";
  const relatedModeKey = node.type === "split" ? "joinType" : "splitType";
  const mode = normalizeParallelMode(attrs[modeKey]);
  const relatedMode = normalizeParallelMode(relatedAttrs[relatedModeKey]);
  return (mode === "all" && relatedMode === "all") ||
    (node.type === "split" && mode === "condition" && relatedMode === "all") ||
    (node.type === "join" && mode === "all" && relatedMode === "condition");
}

function validateParticipants(participants, diagnostics, path, context = {}) {
  if (participants === undefined) return;
  if (!isRecord(participants)) {
    diagnostics.push(error("workflow.participants.type", "Workflow participants must be a JSON object.", path));
    return;
  }
  if (!WORKFLOW_PARTICIPANT_MODES.has(participants.mode)) {
    diagnostics.push(error(
      "workflow.participants.mode_unsupported",
      "Workflow participant mode is unsupported.",
      `${path}/mode`,
      { actual: participants.mode }
    ));
    return;
  }
  if (participants.mode === "empty") {
    diagnostics.push(warning("workflow.participants.empty", "Workflow participants are empty because the source did not specify executable participants.", path, {
      reason: participants.reason
    }));
    return;
  }
  if (participants.mode === "initiator_select" && !nonEmptyString(participants.sourceSemantics)) {
    diagnostics.push(error("workflow.participants.initiator_select_without_source", "initiator_select is allowed only when source semantics explicitly mention initiator/drafter selection.", `${path}/sourceSemantics`));
    return;
  }
  if (participants.mode === "explicit" && !Array.isArray(participants.members)) {
    diagnostics.push(error("workflow.participants.members_required", "Explicit participants require members[].", `${path}/members`));
  }
  if (participants.mode === "form_field") {
    if (!nonEmptyString(participants.fieldId)) {
      diagnostics.push(error("workflow.participants.form_field_required", "Form-field participants require fieldId.", `${path}/fieldId`));
      return;
    }
    if (context.fieldIds instanceof Set && !context.fieldIds.has(participants.fieldId)) {
      diagnostics.push(error("workflow.participants.form_field_missing", "Form-field participant fieldId must reference an existing form field.", `${path}/fieldId`, {
        fieldId: participants.fieldId
      }));
    }
    if (!nonEmptyString(participants.sourceExpression)) {
      diagnostics.push(error("workflow.participants.form_field_source_required", "Form-field participants must preserve the source handler expression.", `${path}/sourceExpression`));
    }
  }
  if (participants.mode === "doc_creator") {
    if (!nonEmptyString(participants.sourceExpression)) {
      diagnostics.push(error("workflow.participants.doc_creator_source_required", "Document-creator participants must preserve the source handler expression.", `${path}/sourceExpression`));
    }
  }
  if (participants.mode === "person_by_login_name" || participants.mode === "dept_leader_by_no") {
    const mode = participants.mode;
    if (!nonEmptyString(participants.fieldId)) {
      diagnostics.push(error(`workflow.participants.${mode}_required`, `${mode} participants require fieldId.`, `${path}/fieldId`));
      return;
    }
    if (context.fieldIds instanceof Set && !context.fieldIds.has(participants.fieldId)) {
      diagnostics.push(error(`workflow.participants.${mode}_missing`, `${mode} participant fieldId must reference an existing form field.`, `${path}/fieldId`, {
        fieldId: participants.fieldId
      }));
    }
    if (!nonEmptyString(participants.sourceExpression)) {
      diagnostics.push(error(`workflow.participants.${mode}_source_required`, `${mode} participants must preserve the source handler expression.`, `${path}/sourceExpression`));
    }
  }
  if (participants.mode === "role_line") {
    if (!["field", "node_handlers"].includes(participants.subjectKind)) {
      diagnostics.push(error(
        "workflow.participants.role_line_subject_kind_unsupported",
        "Role-line participants require subjectKind = field or node_handlers.",
        `${path}/subjectKind`,
        { actual: participants.subjectKind }
      ));
      return;
    }
    const isNodeHandlers = participants.subjectKind === "node_handlers";
    if (isNodeHandlers) {
      if (!nonEmptyString(participants.nodeId)) {
        diagnostics.push(error("workflow.participants.role_line_node_required", "Role-line node-handler participants require nodeId.", `${path}/nodeId`));
        return;
      }
      if (nonEmptyString(participants.fieldId)) {
        diagnostics.push(error("workflow.participants.role_line_subject_conflict", "Role-line node-handler participants cannot also reference fieldId.", `${path}/fieldId`));
      }
      if (!nonEmptyString(participants.subjectExpression)) {
        diagnostics.push(error("workflow.participants.role_line_subject_required", "Role-line node-handler participants require subjectExpression.", `${path}/subjectExpression`));
      } else {
        const subjectMatch = participants.subjectExpression.match(
          /^\$流程\.获取节点实际处理人\$\s*\(\s*["']([^"']+)["']\s*\)$/
        );
        if (!subjectMatch || subjectMatch[1] !== participants.nodeId) {
          diagnostics.push(error("workflow.participants.role_line_subject_mismatch", "Role-line subjectExpression must reference nodeId.", `${path}/subjectExpression`, {
            nodeId: participants.nodeId
          }));
        }
      }
    } else {
      if (nonEmptyString(participants.nodeId) || nonEmptyString(participants.subjectExpression)) {
        diagnostics.push(error("workflow.participants.role_line_subject_conflict", "Role-line field participants cannot also reference node handlers.", `${path}/subjectKind`));
      }
      if (!nonEmptyString(participants.fieldId)) {
        diagnostics.push(error("workflow.participants.role_line_field_required", "Role-line participants require fieldId.", `${path}/fieldId`));
        return;
      }
      if (context.fieldIds instanceof Set && !context.fieldIds.has(participants.fieldId)) {
        diagnostics.push(error("workflow.participants.role_line_field_missing", "Role-line participant fieldId must reference an existing form field.", `${path}/fieldId`, {
          fieldId: participants.fieldId
        }));
      }
    }
    for (const key of ["companyRole", "departmentRole", "sourceExpression"]) {
      if (!nonEmptyString(participants[key])) {
        diagnostics.push(error("workflow.participants.role_line_field_required", `Role-line participants require ${key}.`, `${path}/${key}`));
      }
    }
  }
}

function validateWorkflowParticipantNodeReferences(nodes, nodeMap, diagnostics) {
  if (!Array.isArray(nodes)) return;
  nodes.forEach((node, index) => {
    const participants = node?.participants;
    if (participants?.mode !== "role_line") return;
    if (participants.subjectKind !== "node_handlers") return;
    if (!nonEmptyString(participants.nodeId) || nodeMap.has(participants.nodeId)) return;
    diagnostics.push(error(
      "workflow.participants.role_line_node_missing",
      "Role-line participant nodeId must reference an existing workflow node.",
      `/workflow/nodes/${index}/participants/nodeId`,
      { nodeId: participants.nodeId }
    ));
  });
}

function validateWorkflowEdges(edges, nodeMap, diagnostics) {
  const ids = new Set();
  const validEdges = [];

  if (!Array.isArray(edges)) {
    diagnostics.push(error("dsl.workflow.edges_required", "workflow.edges must be an array.", "/workflow/edges"));
    return validEdges;
  }

  edges.forEach((edge, index) => {
    const path = `/workflow/edges/${index}`;
    if (!isRecord(edge)) {
      diagnostics.push(error("dsl.workflow.edge.type", "Workflow edge must be a JSON object.", path));
      return;
    }

    if (!nonEmptyString(edge.id)) {
      diagnostics.push(error("dsl.workflow.edge.id_required", "Workflow edge id is required.", `${path}/id`));
    } else if (ids.has(edge.id)) {
      diagnostics.push(error("dsl.workflow.edge.id_duplicate", "Workflow edge id must be unique.", `${path}/id`, { id: edge.id }));
    } else {
      ids.add(edge.id);
    }

    if (!nonEmptyString(edge.source)) {
      diagnostics.push(error("dsl.workflow.edge.source_required", "Workflow edge source is required.", `${path}/source`));
    } else if (!nodeMap.has(edge.source)) {
      diagnostics.push(error("dsl.workflow.edge.source_missing", "Workflow edge source must reference an existing node.", `${path}/source`, { source: edge.source }));
    }

    if (!nonEmptyString(edge.target)) {
      diagnostics.push(error("dsl.workflow.edge.target_required", "Workflow edge target is required.", `${path}/target`));
    } else if (!nodeMap.has(edge.target)) {
      diagnostics.push(error("dsl.workflow.edge.target_missing", "Workflow edge target must reference an existing node.", `${path}/target`, { target: edge.target }));
    }

    if (!nonEmptyString(edge.sourceRef) && edge.generated !== true) {
      diagnostics.push(error("dsl.workflow.edge.source_ref_required", "Workflow edge sourceRef is required unless generated is true.", `${path}/sourceRef`));
    }

    if (nodeMap.has(edge.source) && nodeMap.has(edge.target)) {
      validEdges.push(edge);
    }
  });

  return validEdges;
}

function validateTopologicalOrder(order, nodeMap, edges, diagnostics) {
  if (!Array.isArray(order)) {
    diagnostics.push(error("dsl.workflow.topological_order_required", "workflow.topologicalOrder is required.", "/workflow/topologicalOrder"));
    return;
  }

  const positions = new Map();
  order.forEach((nodeId, index) => {
    if (!nonEmptyString(nodeId)) {
      diagnostics.push(error("dsl.workflow.topological_order.item_type", "workflow.topologicalOrder entries must be node ids.", `/workflow/topologicalOrder/${index}`));
      return;
    }
    if (positions.has(nodeId)) {
      diagnostics.push(error("dsl.workflow.topological_order.duplicate", "workflow.topologicalOrder must not contain duplicate ids.", `/workflow/topologicalOrder/${index}`, { id: nodeId }));
      return;
    }
    if (!nodeMap.has(nodeId)) {
      diagnostics.push(error("dsl.workflow.topological_order.unknown_node", "workflow.topologicalOrder must only contain workflow node ids.", `/workflow/topologicalOrder/${index}`, { id: nodeId }));
      return;
    }
    positions.set(nodeId, index);
  });

  if (positions.size !== nodeMap.size) {
    diagnostics.push(error("dsl.workflow.topological_order.incomplete", "workflow.topologicalOrder must include every workflow node exactly once.", "/workflow/topologicalOrder", {
      expected: nodeMap.size,
      current: positions.size
    }));
  }

  for (const edge of edges) {
    if ((positions.get(edge.source) ?? Number.POSITIVE_INFINITY) >= (positions.get(edge.target) ?? Number.NEGATIVE_INFINITY)) {
      // Retry/reject loops are valid in LBPM; keep them as manual-review warnings so
      // needs_manual trusted DSL can still execute while preserving the cycle.
      diagnostics.push(warning("dsl.workflow.cycle_or_bad_order", "workflow edges must follow topologicalOrder; cyclic or reverse edges need manual review.", "/workflow/topologicalOrder", {
        edge: edge.id,
        source: edge.source,
        target: edge.target
      }));
    }
  }
}

function validateWorkflowConnectivity(nodeMap, edges, diagnostics) {
  if (!nodeMap.size) return;
  const starts = [...nodeMap.values()].filter((node) => node.type === "generalStart");
  const ends = [...nodeMap.values()].filter((node) => node.type === "generalEnd");
  if (starts.length !== 1) {
    diagnostics.push(error("dsl.workflow.start_node_required", "Workflow must contain exactly one start node.", "/workflow/nodes", { count: starts.length }));
  }
  if (ends.length !== 1) {
    diagnostics.push(error("dsl.workflow.end_node_required", "Workflow must contain exactly one end node.", "/workflow/nodes", { count: ends.length }));
  }
  if (starts.length !== 1 || ends.length !== 1) return;

  const outgoing = groupEdges(edges, "source", "target");
  const incoming = groupEdges(edges, "target", "source");
  const reachableFromStart = visit(starts[0].id, outgoing);
  const canReachEnd = visit(ends[0].id, incoming);

  for (const nodeId of nodeMap.keys()) {
    if (!reachableFromStart.has(nodeId)) {
      diagnostics.push(error("dsl.workflow.node_unreachable_from_start", "All workflow nodes must be reachable from start.", "/workflow/nodes", { nodeId }));
    }
    if (!canReachEnd.has(nodeId)) {
      diagnostics.push(error("dsl.workflow.node_cannot_reach_end", "All workflow nodes must be able to reach end.", "/workflow/nodes", { nodeId }));
    }
  }
}

function validateWorkflowConditions(edges, diagnostics, context) {
  edges.forEach((edge, index) => {
    const condition = edge.condition;
    if (!isRecord(condition)) return;
    const hasCondition = Boolean(condition.sourceText || condition.displayText || condition.targetText);
    if (!hasCondition) return;
    if (condition.translationStatus === "pending_review") {
      if (context.mode !== "execute") return;
      diagnostics.push(error("dsl.workflow.condition_pending_review", "Executable workflow conditions cannot remain pending_review.", `/workflow/edges/${index}/condition/translationStatus`));
      return;
    }
    if (condition.critical === true && condition.translationStatus !== "executable") {
      diagnostics.push(error("dsl.workflow.condition_not_executable", "Critical executable conditions require translationStatus = executable.", `/workflow/edges/${index}/condition/translationStatus`));
      return;
    }
    if (condition.translationStatus === "display_only") {
      diagnostics.push(warning("workflow.condition.display_only", "Workflow condition is preserved for display/review but is not guaranteed executable.", `/workflow/edges/${index}/condition`, {
        edgeId: edge.id
      }));
      return;
    }
    if (condition.translationStatus !== "executable") {
      diagnostics.push(error("dsl.workflow.condition_status_invalid", "Workflow condition translationStatus must be executable, display_only, or pending_review.", `/workflow/edges/${index}/condition/translationStatus`, {
        actual: condition.translationStatus
      }));
    }
  });
}

function workflowNodeAttributes(node) {
  return {
    ...(node?.attributes || {}),
    ...(node?.definition?.attributes || {})
  };
}

function splitRelatedNodeIds(value = "") {
  return String(value || "").split(/[;,，\s]+/).map((item) => item.trim()).filter(Boolean);
}

function isAllParallelMode(value) {
  const normalized = normalizeParallelMode(value);
  return normalized === "all" || normalized === "1";
}

function normalizeParallelMode(value) {
  return String(value || "").trim().toLowerCase();
}

function groupEdges(edges, key, valueKey) {
  const grouped = new Map();
  for (const edge of edges) {
    if (!grouped.has(edge[key])) grouped.set(edge[key], []);
    grouped.get(edge[key]).push(edge[valueKey]);
  }
  return grouped;
}

function visit(start, graph) {
  const seen = new Set();
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    for (const next of graph.get(nodeId) || []) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

function error(code, message, path, details) {
  return { level: "error", code, message, path, details };
}

function warning(code, message, path, details) {
  return { level: "warning", code, message, path, details };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function escapePointer(value) {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}
