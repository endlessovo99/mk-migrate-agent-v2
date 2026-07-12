import { COMPONENTS_BY_ID } from "../../dsl/catalogs.js";
import { packLayoutCells } from "../../dsl/layout-pack.js";
import {
  buildFormRuleRefIndex,
  resolveDirectRef,
  resolveEffectTarget
} from "../../dsl/form-rules.js";
import { EXECUTABLE_WORKFLOW_NODE_TYPE_SET, INVARIANT_VERSION } from "./invariants.js";
import { digestText, normalizeBoolean, normalizeScalar, stableStringify } from "./normalize.js";
import { projectionError } from "./diagnostics.js";
import { selectDefaultBranchEdge } from "./branch-defaults.js";
import { detailTableNameFor } from "./detail-table-names.js";

export function buildExpectedInvariants(dsl, envelope) {
  const diagnostics = [];
  const envelopeExpected = buildExpectedEnvelope(envelope, diagnostics);
  const formExpected = buildExpectedForm(dsl?.form || {}, envelope?.tableName, diagnostics);
  const rulesExpected = buildExpectedRules(dsl?.formRules, dsl?.form || {}, diagnostics);
  const scriptsExpected = buildExpectedScripts(dsl?.scripts, dsl?.form || {}, envelope?.tableName, diagnostics);
  const workflowExpected = dsl?.workflow
    ? buildExpectedWorkflow(dsl.workflow, diagnostics, {
      templateId: envelope?.templateId,
      runtime: dsl?.runtime
    })
    : { expected: false };

  if (diagnostics.length) {
    return { ok: false, diagnostics };
  }

  return {
    ok: true,
    expected: {
      invariantVersion: INVARIANT_VERSION,
      envelope: envelopeExpected,
      form: formExpected,
      rules: rulesExpected,
      scripts: scriptsExpected,
      workflow: workflowExpected
    }
  };
}

function buildExpectedEnvelope(envelope = {}, diagnostics) {
  const required = [
    ["templateId", envelope.templateId],
    ["templateName", envelope.templateName],
    ["categoryId", envelope.categoryId],
    ["tableName", envelope.tableName]
  ];
  for (const [key, value] of required) {
    if (!nonEmptyString(value)) {
      diagnostics.push(projectionError(
        "projection.envelope.missing",
        `Persistence envelope is missing ${key}.`,
        { field: key }
      ));
    }
  }
  if (envelope.templateName && !String(envelope.templateName).startsWith("MK_TEST_")) {
    diagnostics.push(projectionError(
      "projection.envelope.template_name_prefix",
      "Persistence envelope templateName must use the MK_TEST_ prefix.",
      { templateName: envelope.templateName }
    ));
  }

  return {
    templateId: normalizeScalar(envelope.templateId),
    templateName: normalizeScalar(envelope.templateName),
    categoryId: normalizeScalar(envelope.categoryId),
    tableName: normalizeScalar(envelope.tableName),
    lifecycle: {
      draft: envelope.lifecycle?.draft !== false,
      unpublished: envelope.lifecycle?.unpublished !== false,
      fdStatus: envelope.lifecycle?.fdStatus ?? 0,
      xformStatus: envelope.lifecycle?.xformStatus || "draft",
      lbpmStatus: envelope.lifecycle?.lbpmStatus || "draft",
      lbpmIsDraft: envelope.lifecycle?.lbpmIsDraft !== false
    },
    bindings: {
      formFdId: normalizeScalar(envelope.bindings?.formFdId || envelope.templateId),
      workflowFdId: normalizeScalar(envelope.bindings?.workflowFdId || "")
    }
  };
}

function buildExpectedForm(form, mainTableName, diagnostics) {
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const rows = Array.isArray(form.layout?.mkTree) ? form.layout.mkTree : [];
  const fieldIds = new Set();

  const expectedFields = fields.map((field, index) => {
    if (!nonEmptyString(field?.id)) {
      diagnostics.push(projectionError(
        "projection.form.field_id_missing",
        "DSL form field is missing an id.",
        { index }
      ));
      return null;
    }
    if (fieldIds.has(field.id)) {
      diagnostics.push(projectionError(
        "projection.form.field_id_duplicate",
        "DSL form field id is duplicated.",
        { fieldId: field.id }
      ));
    }
    fieldIds.add(field.id);
    if (field.type === "detailTable") {
      return {
        id: field.id,
        title: normalizeScalar(field.title),
        type: "detailTable",
        component: field.componentId,
        dataOnly: false,
        props: executableProps(field),
        columns: (Array.isArray(field.columns) ? field.columns : []).map((column, columnIndex) => {
          if (!nonEmptyString(column?.id)) {
            diagnostics.push(projectionError(
              "projection.form.column_id_missing",
              "DSL detail column is missing an id.",
              { fieldId: field.id, index: columnIndex }
            ));
            return null;
          }
          return {
            id: column.id,
            title: normalizeScalar(column.title),
            type: column.type,
            component: column.componentId,
            props: executableProps(column)
          };
        }).filter(Boolean)
      };
    }
    return {
      id: field.id,
      title: normalizeScalar(field.title),
      type: field.type,
      component: field.componentId,
      dataOnly: field.dataOnly === true,
      props: executableProps(field),
      columns: []
    };
  }).filter(Boolean);

  const layoutRows = rows.map((row, rowIndex) => {
    if (!nonEmptyString(row?.id)) {
      diagnostics.push(projectionError(
        "projection.form.layout_row_id_missing",
        "DSL layout row is missing an id.",
        { index: rowIndex }
      ));
      return null;
    }
    const packed = packLayoutCells(Array.isArray(row.children) ? row.children : []);
    return {
      id: row.id,
      cells: packed.cells.map((cell, cellIndex) => {
        const fieldIdsForCell = childRefIds(cell);
        if (!fieldIdsForCell.length) {
          diagnostics.push(projectionError(
            "projection.form.layout_cell_empty",
            "DSL layout cell has no field references.",
            { rowId: row.id, index: cellIndex }
          ));
        }
        return {
          id: cell.id || `${row.id}-cell-${cellIndex}`,
          fieldIds: fieldIdsForCell,
          column: cell.column,
          colspan: cell.colspan
        };
      })
    };
  }).filter(Boolean);

  return {
    fields: expectedFields,
    layoutRows,
    subjectRule: {},
    persistence: {
      distinctModelTableNames: true,
      detailModels: expectedFields
        .filter((field) => field.type === "detailTable")
        .map((field) => ({
          fieldId: field.id,
          tableName: detailTableNameFor(mainTableName, field.id),
          tableType: "detail",
          fieldMechanismType: "SYS-XFORM",
          fieldColumnName: "",
          requireModelControlBinding: true,
          requireFieldModelBinding: true,
          requireFieldTableBinding: true,
          columnIds: field.columns.map((column) => column.id)
        }))
    }
  };
}

function executableProps(field = {}) {
  const props = {};
  if (field.props?.required === true) props.required = true;
  if (Array.isArray(field.props?.options) && field.props.options.length) {
    props.options = field.props.options.map((option) => ({
      label: normalizeScalar(option.label ?? option.text ?? option.value),
      value: normalizeScalar(option.value ?? option.label ?? option.text)
    }));
  }
  if (field.componentId === "xform-select~multi") props.multi = true;
  if (field.props?.content !== undefined) props.content = normalizeScalar(field.props.content);
  if (field.props?.maxLength !== undefined) props.maxLength = field.props.maxLength;
  if (field.componentId === "xform-description") {
    const style = descriptionStyle(field.props?.style);
    if (style) props.style = style;
  }
  const catalog = COMPONENTS_BY_ID.get(field.componentId);
  if (catalog?.componentId) props.componentId = catalog.componentId;
  return props;
}

function descriptionStyle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const style = {};
  if (typeof value.color === "string" && value.color.trim()) style.color = value.color.trim();
  if (typeof value.fontWeight === "string" && value.fontWeight.trim()) style.fontWeight = value.fontWeight.trim();
  return Object.keys(style).length ? style : undefined;
}

function buildExpectedRules(formRules = {}, form = {}, diagnostics) {
  const linkage = (Array.isArray(formRules?.linkage) ? formRules.linkage : [])
    .filter((rule) => rule?.translationStatus === "executable");
  const formIndex = buildFormRuleRefIndex(form || {});
  const rules = [];

  for (const [index, rule] of linkage.entries()) {
    const ruleId = rule.id || `linkage-${index + 1}`;
    const when = Array.isArray(rule.when) ? rule.when : [];
    pushRuleSemantics(rules, {
      ruleId,
      branch: "when",
      logic: rule.logic === "or" ? "or" : "and",
      when,
      effects: Array.isArray(rule.effects) ? rule.effects : [],
      formIndex
    }, diagnostics);
    if (Array.isArray(rule.else) && rule.else.length) {
      pushRuleSemantics(rules, {
        ruleId,
        branch: "else",
        logic: rule.logic === "or" ? "and" : "or",
        when: invertClauses(when),
        effects: rule.else,
        formIndex
      }, diagnostics);
    }
  }

  return { rules };
}

function pushRuleSemantics(rules, { ruleId, branch, logic, when, effects, formIndex }, diagnostics) {
  const displayEffects = [];
  const requireEffects = [];
  for (const effect of effects) {
    const targets = resolveEffectFieldNames(formIndex, effect.target, diagnostics, ruleId);
    for (const target of targets) {
      if (effect?.type === "visible") {
        displayEffects.push({
          target,
          visible: effect.value !== false
        });
      }
      if (effect?.type === "required") {
        requireEffects.push({
          target,
          required: effect.value !== false
        });
      }
    }
  }
  const conditions = when.map((clause) => ({
    field: resolveConditionFieldName(formIndex, clause.field),
    op: normalizeScalar(clause.op),
    value: normalizeRuleValue(clause.value)
  }));
  if (displayEffects.length) {
    rules.push({
      kind: "display",
      ruleId,
      branch,
      logic,
      conditions,
      effects: displayEffects
    });
  }
  if (requireEffects.length) {
    rules.push({
      kind: "require",
      ruleId,
      branch,
      logic,
      conditions,
      effects: requireEffects
    });
  }
}

function resolveEffectFieldNames(formIndex, ref, diagnostics, ruleId) {
  const resolved = resolveEffectTarget(formIndex, ref);
  if (!resolved || resolved.unresolved?.length) {
    diagnostics.push(projectionError(
      "projection.form_rules.target_unresolved",
      "Executable form rule effect target could not be resolved.",
      { ruleId, target: ref, unresolved: resolved?.unresolved || [ref] }
    ));
    return [];
  }
  return resolved.targets.map((target) => normalizeScalar(target.id));
}

function resolveConditionFieldName(formIndex, ref) {
  const direct = resolveDirectRef(formIndex, ref);
  return normalizeScalar(direct?.id || ref);
}

function invertClauses(clauses) {
  const invert = {
    eq: "ne",
    ne: "eq",
    contains: "notContains",
    notContains: "contains",
    in: "notContains",
    empty: "notEmpty",
    notEmpty: "empty"
  };
  return clauses.map((clause) => ({
    ...clause,
    op: invert[clause.op] || clause.op
  }));
}

function normalizeRuleValue(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeScalar(item));
  return normalizeScalar(value);
}

function buildExpectedScripts(scripts = {}, form = {}, mainTableName, diagnostics) {
  const actions = [];
  const detailTableNames = Object.fromEntries(
    (Array.isArray(form?.fields) ? form.fields : [])
      .filter((field) => field?.type === "detailTable")
      .map((field) => [field.id, detailTableNameFor(mainTableName, field.id)])
  );
  for (const action of Array.isArray(scripts?.actions) ? scripts.actions : []) {
    if (action?.translationStatus === "omitted") {
      actions.push({
        id: action.id,
        omitted: true
      });
      continue;
    }
    if (!nonEmptyString(action?.id)) {
      diagnostics.push(projectionError(
        "projection.scripts.action_id_missing",
        "DSL script action is missing an id."
      ));
      continue;
    }
    if (typeof action.function !== "string" || !action.function.trim()) {
      diagnostics.push(projectionError(
        "projection.scripts.action_body_missing",
        "DSL script action is missing a function body.",
        { actionId: action.id }
      ));
      continue;
    }
    const event = action.event || action.name;
    const renderedBody = renderExpectedScriptBody(action.function, detailTableNames);
    actions.push({
      id: action.id,
      omitted: false,
      event,
      scope: action.scope || "global",
      controlId: action.controlId || undefined,
      tableId: action.tableId || undefined,
      runWhen: action.runWhen ? clone(action.runWhen) : undefined,
      bodyDigest: digestText(canonicalizeScriptBody(renderedBody)),
      hasCanonicalGuardExpectation: Boolean(action.runWhen?.viewStatusIn?.length)
    });
  }
  return { actions };
}

function renderExpectedScriptBody(source, detailTableNames = {}) {
  return String(source || "").replace(/\$\{table:([^}]+)\}/g, (_, tableId) => {
    const sourceTableId = String(tableId || "").trim();
    return detailTableNames[sourceTableId] || sourceTableId;
  });
}

function buildExpectedWorkflow(workflow, diagnostics, context = {}) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  const initiatorSelectTargetNodeIds = collectInitiatorSelectTargetNodeIds(nodes);
  const defaultEdgeIds = collectDefaultEdgeIds(nodes, edges);
  const conditionBranchNodeIds = new Set(
    nodes.filter((node) => node?.type === "conditionBranch").map((node) => node.id)
  );
  const expectedNodes = nodes.map((node, index) => {
    if (!nonEmptyString(node?.id)) {
      diagnostics.push(projectionError(
        "projection.workflow.node_id_missing",
        "DSL workflow node is missing an id.",
        { index }
      ));
      return null;
    }
    if (!EXECUTABLE_WORKFLOW_NODE_TYPE_SET.has(node.type)) {
      diagnostics.push(projectionError(
        "projection.workflow.node_type_unsupported",
        `Workflow node type is not an executable NewOA type: ${node.type}`,
        { nodeId: node.id, type: node.type }
      ));
      return null;
    }
    const attributes = sourceAttributes(node);
    if (node.participants?.mode === "unmapped_formula") {
      diagnostics.push(projectionError(
        "projection.workflow.formula_participant_unmapped",
        "Workflow formula participants must be translated to a supported ES5 script before persistence.",
        {
          nodeId: node.id,
          sourceExpression: node.participants.sourceExpression || attributes.handlerIds || ""
        }
      ));
      return null;
    }
    return {
      id: node.id,
      name: normalizeScalar(node.name),
      type: node.type,
      element: node.element || defaultElementForType(node.type),
      mustModifyHandlerNodeIds: splitRelatedNodeIds(attributes.mustModifyHandlerNodeIds),
      canModifyHandlerNodeIds: splitRelatedNodeIds(attributes.canModifyHandlerNodeIds),
      participants: summarizeParticipants(node, initiatorSelectTargetNodeIds.has(node.id), context),
      alternativeParticipants: summarizeAlternativeParticipants(node.participants),
      sendConfig: summarizeSendConfig(node),
      dataAuthority: summarizeDataAuthority(node),
      ignoreOnSameIdentity: expectedIgnoreOnSameIdentity(node)
    };
  }).filter(Boolean);

  const expectedEdges = edges.map((edge, index) => {
    if (!nonEmptyString(edge?.id)) {
      diagnostics.push(projectionError(
        "projection.workflow.edge_id_missing",
        "DSL workflow edge is missing an id.",
        { index }
      ));
      return null;
    }
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      isDefault: defaultEdgeIds.has(edge.id),
      branch: normalizeScalar(edge.attributes?.branch || edge.branch || ""),
      condition: summarizeCondition(edge, conditionBranchNodeIds.has(edge.source), context)
    };
  }).filter(Boolean);

  return {
    expected: true,
    readable: true,
    nodes: expectedNodes,
    edges: expectedEdges
  };
}

function collectDefaultEdgeIds(nodes = [], edges = []) {
  const conditionBranchNodeIds = new Set(
    nodes.filter((node) => node?.type === "conditionBranch").map((node) => node.id)
  );
  const edgesBySource = new Map();
  for (const edge of edges) {
    if (!conditionBranchNodeIds.has(edge?.source)) continue;
    if (!edgesBySource.has(edge.source)) edgesBySource.set(edge.source, []);
    edgesBySource.get(edge.source).push(edge);
  }

  const defaultEdgeIds = new Set();
  for (const sourceEdges of edgesBySource.values()) {
    const defaultEdge = selectDefaultBranchEdge(sourceEdges);
    if (defaultEdge?.id) defaultEdgeIds.add(defaultEdge.id);
  }
  return defaultEdgeIds;
}

function summarizeParticipants(node, initiatorSelectTarget, context = {}) {
  if (initiatorSelectTarget) {
    return {
      mode: "initiator_select",
      handlersType: "org",
      handlersSource: "1",
      handlersRuleKey: "",
      handlersRuleName: "",
      handlersElement: "users",
      members: []
    };
  }
  if (!node?.participants) return undefined;
  if (node.participants.mode === "initiator_select") {
    return undefined;
  }
  if (node.participants.mode === "form_field") {
    return {
      mode: "form_field",
      fieldId: node.participants.fieldId,
      nativeFormula: expectedParticipantFormula(node.participants, context)
    };
  }
  if (node.participants.mode === "doc_creator") {
    return {
      mode: "doc_creator",
      nativeFormula: expectedParticipantFormula(node.participants, context)
    };
  }
  if (node.participants.mode === "person_by_login_name") {
    return {
      mode: "person_by_login_name",
      fieldId: node.participants.fieldId,
      nativeFormula: expectedParticipantFormula(node.participants, context)
    };
  }
  if (node.participants.mode === "dept_leader_by_no") {
    return {
      mode: "dept_leader_by_no",
      fieldId: node.participants.fieldId,
      nativeFormula: expectedParticipantFormula(node.participants, context)
    };
  }
  if (node.participants.mode === "role_line") {
    if (node.participants.subjectKind === "node_handlers" || node.participants.nodeId) {
      return {
        mode: "role_line",
        subjectKind: "node_handlers",
        nodeId: node.participants.nodeId,
        companyRole: node.participants.companyRole,
        departmentRole: node.participants.departmentRole,
        nativeFormula: expectedParticipantFormula(node.participants, context)
      };
    }
    return {
      mode: "role_line",
      subjectKind: "field",
      fieldId: node.participants.fieldId,
      companyRole: node.participants.companyRole,
      departmentRole: node.participants.departmentRole,
      nativeFormula: expectedParticipantFormula(node.participants, context)
    };
  }
  if (node.participants.mode === "explicit") {
    return {
      mode: "explicit",
      handlersType: "org",
      handlersSource: "1",
      handlersRuleKey: "",
      handlersRuleName: "",
      handlersElement: "users",
      members: (node.participants.members || [])
        .map((member) => ({
          id: normalizeScalar(member.id),
          element: "user",
          type: expectedNativeMemberType(member)
        }))
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    };
  }
  // empty / unsupported participant modes are not error-level persisted invariants
  return undefined;
}

function expectedParticipantFormula(participants, context = {}) {
  const fieldId = participants?.fieldId || "";
  const fieldRef = context.templateId ? `${context.templateId}-${fieldId}` : fieldId;
  let script = "";
  let varIds = [];
  let ruleMode = "simple";
  let ruleKeyMode = "simple";

  if (participants?.mode === "form_field") {
    script = `\${data.${fieldRef}}`;
    varIds = [fieldRef];
  } else if (participants?.mode === "person_by_login_name") {
    script = `\${func.sysorg.getPersonByLoginName}(\${data.${fieldRef}})`;
    varIds = [fieldRef];
    ruleMode = "formula";
    ruleKeyMode = "formula";
  } else if (participants?.mode === "dept_leader_by_no") {
    script = `$部门领导.根据部门编号获取部门领导$(\${data.${fieldRef}})`;
    varIds = [fieldRef];
  } else if (participants?.mode === "doc_creator") {
    script = "${data._ProcessCreator}";
    ruleMode = "formula";
    ruleKeyMode = "formula";
  } else if (participants?.mode === "role_line") {
    const companyRole = JSON.stringify(participants.companyRole || "");
    const departmentRole = JSON.stringify(participants.departmentRole || "");
    if (participants.subjectKind === "node_handlers" || participants.nodeId) {
      const subjectRef = participants.subjectExpression ||
        `$流程.获取节点实际处理人$(${JSON.stringify(participants.nodeId || "")})`;
      script = `$组织架构.解释角色线$(${subjectRef}, ${companyRole}, ${departmentRole})`;
    } else {
      script = `$组织架构.解释角色线$(\${data.${fieldRef}}, ${companyRole}, ${departmentRole})`;
      varIds = [fieldRef];
    }
  }

  return {
    script,
    varIds,
    handlerSelectType: "formula",
    handlersType: "formula",
    handlersSource: "2",
    handlersElement: "users",
    memberCount: 0,
    ruleMode,
    formulaType: "formula",
    ruleKeyType: "Eval",
    ruleKeyMode,
    ruleVoMode: "formula",
    resultType: ["person_by_login_name", "doc_creator"].includes(participants?.mode)
      ? "org_array"
      : "none"
  };
}

function summarizeAlternativeParticipants(participants) {
  const hasAlternativeConfig = Array.isArray(participants?.alternativeMembers) ||
    participants?.useAlternativeOnly !== undefined;
  if (!hasAlternativeConfig) return undefined;

  return {
    handlersType: "org",
    handlersSource: "1",
    handlersRuleKey: "",
    handlersRuleName: "",
    handlersElement: "users",
    useAlternativeOnly: nativeBoolean(participants?.useAlternativeOnly),
    members: (participants?.alternativeMembers || [])
      .map((member) => ({
        id: normalizeScalar(member.id),
        element: "user",
        type: expectedNativeMemberType(member)
      }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
  };
}

function expectedNativeMemberType(member = {}) {
  const sourceOrgType = member.targetOrgType ?? member.sourceOrgType ?? member.fdOrgType;
  if (sourceOrgType !== undefined && sourceOrgType !== null && String(sourceOrgType).trim() !== "") {
    const normalized = String(sourceOrgType).trim().toLowerCase();
    if (normalized === "8" || normalized === "person" || normalized === "user") return "1";
    if (normalized === "4" || normalized === "post" || normalized === "position") return "2";
    return "3";
  }
  const existingType = String(member.type || "").trim().toLowerCase();
  if (["1", "8", "person", "user"].includes(existingType)) return "1";
  if (["2", "4", "post", "position", "dept"].includes(existingType)) return "2";
  return "3";
}

function nativeBoolean(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return value === true || value === 1 || normalized === "true" || normalized === "1";
}

function collectInitiatorSelectTargetNodeIds(nodes = []) {
  const targetNodeIds = new Set();
  for (const node of nodes) {
    const attrs = sourceAttributes(node);
    for (const attribute of ["mustModifyHandlerNodeIds", "canModifyHandlerNodeIds"]) {
      for (const targetNodeId of splitRelatedNodeIds(attrs[attribute])) {
        targetNodeIds.add(targetNodeId);
      }
    }
  }
  return targetNodeIds;
}

function sourceAttributes(node) {
  return {
    ...(node?.attributes || {}),
    ...(node?.definition?.attributes || {})
  };
}

function expectedIgnoreOnSameIdentity(node) {
  if (!node || !["review", "send"].includes(node.type)) return undefined;
  const attrs = sourceAttributes(node);
  const fields = node.dataAuthority?.fields || {};
  const hasRequiredField = Object.values(fields).some((field) => field?.required === true);
  const hasMustModifyHandlerNodes = splitRelatedNodeIds(
    attrs.mustModifyHandlerNodeIds || attrs.mustModifyHandlerNodes
  ).length > 0;
  const hasCanModifyHandlerNodes = splitRelatedNodeIds(
    attrs.canModifyHandlerNodeIds || attrs.canModifyHandlerNodes
  ).length > 0;
  const eSign = attrs.eSignConfig || node.eSignConfig;
  const hasEnabledESign = eSign && (eSign.enable === true || eSign.enable === "true");
  if (hasRequiredField || hasMustModifyHandlerNodes || hasCanModifyHandlerNodes || hasEnabledESign) return "1";
  return attrs.ignoreOnHandlerSame === "false" ? "1" : "2";
}

function splitRelatedNodeIds(value = "") {
  return [...new Set(
    String(value || "").split(/[;,，\s]+/).map((item) => item.trim()).filter(Boolean)
  )];
}

function summarizeDataAuthority(node) {
  if (!node?.dataAuthority?.fields || node.dataAuthority.enabled === false) return undefined;
  return {
    enabled: node.dataAuthority.enabled !== false,
    fields: Object.fromEntries(
      Object.entries(node.dataAuthority.fields).map(([fieldId, value]) => [fieldId, {
        visible: normalizeBoolean(value.visible),
        editable: normalizeBoolean(value.editable),
        required: normalizeBoolean(value.required)
      }])
    )
  };
}

function summarizeSendConfig(node) {
  if (node?.type !== "send") return undefined;
  return {
    modifyProcessAuthority: "0",
    systemNotifyType: "2",
    languageNameUs: "CC node"
  };
}

function summarizeCondition(edge, conditionBranch, context = {}) {
  const sourceText = edge?.condition?.sourceText ||
    (typeof edge?.condition === "string" ? edge.condition : "") ||
    edge?.condition?.targetText ||
    edge?.condition?.displayText ||
    edge?.displayCondition ||
    "";
  if (!String(sourceText).trim()) return undefined;
  const nativeSemantics = conditionBranch
    ? expectedBatchConditionSemantics(sourceText, context)
    : undefined;
  return {
    sourceText: normalizeScalar(sourceText),
    nativeRequired: true,
    nativeKind: conditionBranch ? "batch_formula" : "rule",
    ...(nativeSemantics ? { nativeSemantics } : {})
  };
}

function expectedBatchConditionSemantics(sourceText, context = {}) {
  const compact = String(sourceText || "").replace(/\s+/g, "");
  if (/^(?:1={2,3}2|1!={1,2}1|false)$/i.test(compact)) {
    return { resultShape: "false", varCount: 0 };
  }

  const negated = unwrapExpectedNegation(compact);
  const text = negated.text;
  const fieldSum = text.match(
    /^\(?\$([^$]+)\$\+\$([^$]+)\$\)?(>=|<=|>|<|==|!=)(-?\d+(?:\.\d+)?)$/
  );
  if (fieldSum) {
    const leftRef = expectedFormulaFieldRef(context.templateId, fieldSum[1]);
    const rightRef = expectedFormulaFieldRef(context.templateId, fieldSum[2]);
    const symbol = negated.negated ? negateExpectedCompareSymbol(fieldSum[3]) : fieldSum[3];
    return {
      resultShape: "(${VAR})",
      evalExpressions: [`(\${data.${leftRef}} + \${data.${rightRef}}) ${symbol} ${JSON.stringify(fieldSum[4])}`],
      ruleSymbols: [symbol]
    };
  }

  const orgFdNo = text.match(/^\$([^$]+)\$\.fdNo\.equals\(["']([^"']+)["']\)$/i);
  if (orgFdNo) {
    const hit = context.runtime?.conditionOrgByFdNo?.[orgFdNo[2]];
    const symbol = negated.negated ? "notbelong" : "belongany";
    const functionId = "sysorg.isOrganizationBelongOrIncludeAnother";
    const orgIds = hit?.fdId ? [String(hit.fdId)] : [];
    return {
      resultShape: negated.negated ? "(!${VAR})" : "(${VAR})",
      functionIds: [functionId],
      orgIds,
      functionCalls: [{
        functionId,
        inputs: [{
          key: "firstOrgs",
          type: "Var",
          value: expectedFormulaFieldRef(context.templateId, orgFdNo[1])
        }],
        fixedArguments: [{
          key: "isCross",
          type: "Fixed",
          value: true
        }, {
          key: "relationType",
          type: "Fixed",
          value: 4
        }, {
          key: "secondOrgs",
          type: "Fixed",
          value: { orgIds }
        }]
      }],
      ruleSymbols: [symbol]
    };
  }

  const emptySymbol = expectedEmptyConditionSymbol(text, negated.negated);
  if (emptySymbol) {
    const fieldId = text.match(/\$([^$]+)\$/)?.[1] || "";
    const functionId = "global.isEmpty";
    return {
      resultShape: emptySymbol === "notempty" ? "(!${VAR})" : "(${VAR})",
      functionIds: [functionId],
      functionCalls: [{
        functionId,
        inputs: [{
          key: "value",
          type: "Var",
          value: expectedFormulaFieldRef(context.templateId, fieldId)
        }],
        fixedArguments: []
      }],
      ruleSymbols: [emptySymbol]
    };
  }

  return undefined;
}

function unwrapExpectedNegation(compact) {
  if (compact.startsWith("!(") && compact.endsWith(")")) {
    return { text: compact.slice(2, -1), negated: true };
  }
  if (compact.startsWith("!")) {
    return { text: compact.slice(1), negated: true };
  }
  return { text: compact, negated: false };
}

function expectedEmptyConditionSymbol(text, outerNegated) {
  let symbol;
  if (/^null!=\$[^$]+\$$/i.test(text) || /^\$[^$]+\$!=null$/i.test(text) || /^\$[^$]+\$\.length\(\)>0$/.test(text)) {
    symbol = "notempty";
  } else if (/^null==\$[^$]+\$$/i.test(text) || /^\$[^$]+\$==null$/i.test(text) || /^\$[^$]+\$\.length\(\)==0$/.test(text)) {
    symbol = "empty";
  } else if (/^\$[^$]+\$(?:==|===)["']["']$/.test(text) || /^\$[^$]+\$\.equals\(["']["']\)$/.test(text)) {
    symbol = "empty";
  } else if (/^\$[^$]+\$(?:!=|!==)["']["']$/.test(text) || /^!\$[^$]+\$\.equals\(["']["']\)$/.test(text)) {
    symbol = "notempty";
  }
  if (!symbol) return undefined;
  if (!outerNegated) return symbol;
  return symbol === "empty" ? "notempty" : "empty";
}

function expectedFormulaFieldRef(templateId, fieldId) {
  return templateId ? `${templateId}-${fieldId}` : fieldId;
}

function negateExpectedCompareSymbol(symbol) {
  if (symbol === "==") return "!=";
  if (symbol === "!=") return "==";
  if (symbol === ">") return "<=";
  if (symbol === ">=") return "<";
  if (symbol === "<") return ">=";
  if (symbol === "<=") return ">";
  return symbol;
}

function defaultElementForType(type) {
  if (type === "generalStart") return "startEvent";
  if (type === "generalEnd") return "endEvent";
  if (type === "conditionBranch") return "exclusiveGateway";
  if (type === "split" || type === "join") return "parallelGateway";
  if (type === "robot") return "robot";
  return "manualTask";
}

function canonicalizeScriptBody(source) {
  return String(source || "")
    .replace(/\/\*\s*mk-migrate:[^*]+?\*\//g, "")
    .replace(/\bif\s*\(\s*MKXFORM\.viewStatus\s*!==[\s\S]*?\)\s*(return true|return)\s*;?/g, "")
    .replace(/\bfunction\s+[A-Za-z0-9_]+\s*\(/g, "function __fn(")
    .replace(/\s+/g, " ")
    .trim();
}

function childRefIds(cell = {}) {
  if (Array.isArray(cell.refIds) && cell.refIds.length) return cell.refIds.filter(Boolean);
  if (cell.refId) return [cell.refId];
  return [];
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function expectedRuleFingerprint(rule) {
  return stableStringify({
    kind: rule.kind,
    logic: rule.logic,
    conditions: rule.conditions,
    effects: rule.effects
  });
}
