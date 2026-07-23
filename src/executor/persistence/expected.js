import { COMPONENTS_BY_ID, componentSupportsProp } from "../../dsl/catalogs.js";
import { conditionContextSemantic } from "../../dsl/condition-context.js";
import { projectLayoutGrid } from "../../dsl/layout-pack.js";
import {
  buildFormRuleRefIndex,
  resolveDirectRef,
  resolveEffectTarget
} from "../../dsl/form-rules.js";
import {
  compileNativeFormRuleFormula,
  inspectNativeFormRuleActionBinding,
  inspectNativeFormRuleProjection
} from "../../dsl/native-form-rule-projection.js";
import { EXECUTABLE_WORKFLOW_NODE_TYPE_SET, INVARIANT_VERSION } from "./invariants.js";
import { digestText, normalizeBoolean, normalizeScalar, stableStringify } from "./normalize.js";
import { projectionError } from "./diagnostics.js";
import {
  edgeConditionText,
  isExplicitDefaultEdge,
  isTautologyCondition as sharedIsTautologyCondition,
  selectDefaultBranchEdge
} from "./branch-defaults.js";
import { detailTableNameFor } from "./detail-table-names.js";
import { projectSubProcessWorkflow, subProcessContract } from "../../dsl/subprocess.js";
import { persistedFieldLabel } from "./field-labels.js";
import { isAddressField } from "../condition-org-resolver.js";
import { collectConditionTerms, createConditionExpressionParser } from "./condition-expression.js";
import {
  canRenderEvalConditionFormula,
  conditionAstUsesFieldSum,
  renderEvalConditionFormula
} from "./condition-eval-formula.js";
import {
  SCRIPT_SINGLETON_GLOBAL_EVENTS,
  compileSetFieldAttrRowMarkerTargets
} from "../../dsl/scripts.js";
import { singletonDispatcherContract } from "./script-dispatcher-contract.js";
import { normalizeRuleConditionText } from "./condition-rule.js";

const parseExpectedContextConditionExpression = createConditionExpressionParser({
  parseTerm: parseExpectedContextConditionTerm,
  negateTerm: negateExpectedContextConditionTerm
});

const parseExpectedEvalConditionExpression = createConditionExpressionParser({
  parseTerm: parseExpectedEvalConditionTerm,
  negateTerm: negateExpectedEvalConditionTerm
});

export function buildExpectedInvariants(dsl, envelope) {
  const diagnostics = [];
  const envelopeExpected = buildExpectedEnvelope(envelope, diagnostics, Boolean(dsl?.workflow));
  const formExpected = buildExpectedForm(dsl?.form || {}, envelope?.tableName, diagnostics);
  const rulesExpected = buildExpectedRules(
    dsl?.formRules,
    dsl?.form || {},
    dsl?.scripts,
    diagnostics
  );
  const scriptsExpected = buildExpectedScripts(dsl?.scripts, dsl?.form || {}, envelope?.tableName, diagnostics);
  const workflowExpected = dsl?.workflow
    ? buildExpectedWorkflow(dsl.workflow, diagnostics, {
      templateId: envelope?.templateId,
      mainTableName: envelope?.tableName,
      form: dsl?.form,
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

function buildExpectedEnvelope(envelope = {}, diagnostics, workflowExpected = false) {
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
      lbpmStatus: workflowExpected ? envelope.lifecycle?.lbpmStatus || "draft" : undefined,
      lbpmIsDraft: workflowExpected ? envelope.lifecycle?.lbpmIsDraft !== false : undefined
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
        title: normalizeScalar(persistedFieldLabel(field)),
        type: "detailTable",
        component: field.componentId,
        dataOnly: false,
        props: executableProps(field, form),
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
            title: normalizeScalar(persistedFieldLabel(column)),
            type: column.type,
            component: column.componentId,
            props: executableProps(column, form)
          };
        }).filter(Boolean)
      };
    }
    return {
      id: field.id,
      title: normalizeScalar(persistedFieldLabel(field)),
      type: field.type,
      component: field.componentId,
      dataOnly: field.dataOnly === true,
      props: executableProps(field, form),
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
    const packed = projectLayoutGrid(Array.isArray(row.children) ? row.children : [], {
      columns: row.props?.columns,
      rows: row.componentId === "xform-multi-row-table-layout" ? row.props?.rows : 1
    });
    return {
      id: row.id,
      rows: packed.rows,
      columns: packed.columns,
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
          row: cell.row,
          column: cell.column,
          colspan: cell.colspan
        };
      })
    };
  }).filter(Boolean);

  return {
    fields: expectedFields,
    calculationOrder: expectedCalculationOrder(form, diagnostics),
    layoutRows,
    subjectRule: {},
    persistence: {
      distinctModelTableNames: true,
      detailModels: expectedFields
        .filter((field) => field.type === "detailTable")
        .map((field) => ({
          fieldId: field.id,
          title: normalizeScalar(persistedFieldLabel(field)),
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

function expectedCalculationOrder(form = {}, diagnostics = []) {
  const entries = (form.fields || []).flatMap((field) => {
    if (field?.type !== "detailTable") {
      return field?.props?.calculation ? [{ field, ref: field.id }] : [];
    }
    return (field.columns || [])
      .filter((column) => column?.props?.calculation)
      .map((column) => ({ field: column, tableId: field.id, ref: `${field.id}.${column.id}` }));
  });
  const knownRefs = new Set(entries.map((entry) => entry.ref));
  const pending = entries.map((entry) => ({
    ...entry,
    dependencies: expectedCalculationDependencies(entry, knownRefs)
  }));
  const order = [];
  const emitted = new Set();
  while (pending.length) {
    const index = pending.findIndex((entry) => entry.dependencies.every((ref) => emitted.has(ref)));
    if (index === -1) {
      diagnostics.push(projectionError(
        "projection.form.calculation_dependency_cycle",
        "Native calculation dependency cycle detected.",
        { fieldRefs: pending.map((entry) => entry.ref) }
      ));
      return [...order, ...pending.map((entry) => entry.ref)];
    }
    const [entry] = pending.splice(index, 1);
    order.push(entry.ref);
    emitted.add(entry.ref);
  }
  return order;
}

function expectedCalculationDependencies(entry, knownRefs) {
  const calculation = entry.field.props.calculation;
  if (calculation.kind === "aggregate") {
    const ref = `${calculation.tableId}.${calculation.fieldId}`;
    return knownRefs.has(ref) ? [ref] : [];
  }
  if (calculation.kind !== "formula") return [];
  return (calculation.fieldIds || [])
    .map((fieldId) => entry.tableId ? `${entry.tableId}.${fieldId}` : fieldId)
    .filter((ref) => knownRefs.has(ref));
}

function executableProps(field = {}, form = {}) {
  const props = {};
  if (field.props?.required === true) props.required = true;
  if (componentSupportsProp(field.componentId, "placeholder") && typeof field.props?.placeholder === "string") {
    props.placeholder = normalizeScalar(field.props.placeholder);
  }
  if (componentSupportsProp(field.componentId, "unit") && typeof field.props?.unit === "string") {
    props.unit = normalizeScalar(field.props.unit);
  }
  if (Array.isArray(field.props?.options) && field.props.options.length) {
    props.options = field.props.options.map((option) => ({
      label: normalizeScalar(option.label ?? option.text ?? option.value),
      value: normalizeScalar(option.value ?? option.label ?? option.text)
    }));
  }
  if (field.componentId === "xform-select~multi") props.multi = true;
  if (field.componentId === "xform-hyperlinks") {
    props.largestSet = field.props?.largestSet ?? 1;
    props.editable = field.props?.editable ?? false;
  }
  if (componentSupportsProp(field.componentId, "precision") && Number.isInteger(field.props?.precision)) {
    props.precision = field.props.precision;
  }
  if (componentSupportsProp(field.componentId, "defaultValue") && field.props?.defaultValue !== undefined) {
    props.defaultValue = cloneJson(field.props.defaultValue);
  }
  if (componentSupportsProp(field.componentId, "calculation") && field.props?.calculation !== undefined) {
    props.calculation = expectedCalculation(field.props.calculation, form);
  }
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

function expectedCalculation(calculation, form = {}) {
  const next = cloneJson(calculation);
  if (next?.kind !== "formula") return next;
  const display = String(next.displayExpression || "").trim();
  if (!display) return next;
  const titles = formulaDisplayTitleIndex(form);
  next.displayExpression = display.replace(/\$([A-Za-z_][\w]*)\$/gu, (_, fieldId) => (
    `$${titles.get(fieldId) || fieldId}$`
  ));
  return next;
}

function formulaDisplayTitleIndex(form = {}) {
  const titles = new Map();
  for (const field of form.fields || []) {
    if (field?.type === "detailTable") {
      for (const column of field.columns || []) {
        if (column?.id) titles.set(column.id, normalizeScalar(persistedFieldLabel(column)) || column.id);
      }
      continue;
    }
    if (field?.id) titles.set(field.id, normalizeScalar(persistedFieldLabel(field)) || field.id);
  }
  return titles;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function descriptionStyle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const style = {};
  if (typeof value.color === "string" && value.color.trim()) style.color = value.color.trim();
  if (typeof value.fontWeight === "string" && value.fontWeight.trim()) style.fontWeight = value.fontWeight.trim();
  return Object.keys(style).length ? style : undefined;
}

function buildExpectedRules(formRules = {}, form = {}, scripts = {}, diagnostics) {
  const linkage = (Array.isArray(formRules?.linkage) ? formRules.linkage : [])
    .filter((rule) => rule?.translationStatus === "executable");
  const formIndex = buildFormRuleRefIndex(form || {});
  const rules = [];

  for (const [index, rule] of linkage.entries()) {
    const ruleId = rule.id || `linkage-${index + 1}`;
    const when = Array.isArray(rule.when) ? rule.when : [];
    const projection = inspectNativeFormRuleProjection(rule);
    const actionBinding = inspectNativeFormRuleActionBinding(rule, scripts);
    if (!projection.ok || !actionBinding.ok) {
      diagnostics.push(projectionError(
        rule.meta?.runWhen === undefined
          ? "projection.form_rule.native_projection_unproven"
          : "projection.form_rule.run_when_not_persistable",
        "Expected native form-rule semantics are not statically projectable.",
        { ruleId, issues: [...(projection.issues || []), ...(actionBinding.issues || [])] }
      ));
      continue;
    }
    const whenFormula = projection.kind === "view-status-formula"
      ? compileNativeFormRuleFormula(rule, {
          branch: "when",
          resolveFieldName: (field) => resolveConditionFieldName(formIndex, field)
        })
      : undefined;
    pushRuleSemantics(rules, {
      ruleId,
      branch: "when",
      active: rule.active !== false,
      logic: rule.logic === "or" ? "or" : "and",
      when,
      effects: Array.isArray(rule.effects) ? rule.effects : [],
      formIndex,
      nativeFormula: whenFormula
    }, diagnostics);
    if (Array.isArray(rule.else) && rule.else.length) {
      const elseFormula = projection.kind === "view-status-formula"
        ? compileNativeFormRuleFormula(rule, {
            branch: "else",
            resolveFieldName: (field) => resolveConditionFieldName(formIndex, field)
          })
        : undefined;
      pushRuleSemantics(rules, {
        ruleId,
        branch: "else",
        active: rule.active !== false,
        logic: rule.logic === "or" ? "and" : "or",
        when: invertClauses(when),
        effects: rule.else,
        formIndex,
        nativeFormula: elseFormula
      }, diagnostics);
    }
  }

  return { rules };
}

function pushRuleSemantics(rules, {
  ruleId,
  branch,
  active,
  logic,
  when,
  effects,
  formIndex,
  nativeFormula
}, diagnostics) {
  const displayEffects = [];
  const requireEffects = [];
  for (const effect of effects) {
    const targets = resolveEffectFieldNames(formIndex, effect.target, diagnostics, ruleId);
    for (const target of targets) {
      if (effect?.type === "visible") {
        displayEffects.push({
          ...target,
          visible: effect.value !== false
        });
      }
      if (effect?.type === "required") {
        requireEffects.push({
          target: target.target,
          required: effect.value !== false
        });
      }
    }
  }
  const conditions = nativeFormula
    ? [{
        field: "$formula",
        op: "formula",
        valueType: "formula",
        evalType: "Eval",
        voMode: "formula",
        voContent: normalizeScalar(nativeFormula.script),
        value: normalizeScalar(nativeFormula.script),
        varIds: nativeFormula.varIds.map(normalizeScalar)
      }]
    : when.map((clause) => ({
        field: resolveConditionFieldName(formIndex, clause.field),
        op: normalizeScalar(clause.op),
        value: normalizeRuleValue(clause.value)
      }));
  const nativeLogic = nativeFormula ? "and" : logic;
  const uniqueDisplayEffects = uniqueRuleEffects(displayEffects);
  const uniqueRequireEffects = uniqueRuleEffects(requireEffects);
  if (uniqueDisplayEffects.length) {
    rules.push({
      kind: "display",
      ruleId,
      branch,
      active,
      logic: nativeLogic,
      conditions,
      effects: uniqueDisplayEffects
    });
  }
  if (uniqueRequireEffects.length) {
    rules.push({
      kind: "require",
      ruleId,
      branch,
      active,
      logic: nativeLogic,
      conditions,
      effects: uniqueRequireEffects
    });
  }
}

function uniqueRuleEffects(effects) {
  const seen = new Set();
  return effects.filter((effect) => {
    const key = stableStringify(effect);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  return resolved.targets.map((target) => ({
    target: normalizeScalar(target.id),
    ...(target.kind === "detailTable"
      ? {
          nativeFieldNames: [
            "all",
            ...(target.columns || []).map((column) => normalizeScalar(column.id))
          ]
        }
      : {})
  }));
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
    const renderedBody = renderExpectedScriptBody(action.function, detailTableNames, form);
    const scope = action.scope || "global";
    const controlId = action.tableId && action.controlId === action.tableId
      ? detailTableNames[action.tableId]
      : action.controlId || undefined;
    const physicalTableName = action.tableId
      ? detailTableNames[action.tableId]
      : mainTableName;
    actions.push({
      id: action.id,
      omitted: false,
      event,
      scope,
      controlId,
      controlKey: scope === "control" && controlId
        ? `${physicalTableName}.${controlId}`
        : undefined,
      tableId: action.tableId || undefined,
      runWhen: action.runWhen ? clone(action.runWhen) : undefined,
      bodyDigest: digestText(canonicalizeScriptBody(renderedBody)),
      hasCanonicalGuardExpectation: Boolean(action.runWhen?.viewStatusIn?.length)
    });
  }
  return { actions, dispatchers: expectedSingletonDispatchers(scripts.actions) };
}

function expectedSingletonDispatchers(scriptActions = []) {
  const grouped = new Map();
  for (const action of Array.isArray(scriptActions) ? scriptActions : []) {
    const event = action?.event || action?.name;
    if (
      action?.translationStatus === "omitted" ||
      (action?.scope || "global") !== "global" ||
      !SCRIPT_SINGLETON_GLOBAL_EVENTS.has(event) ||
      !nonEmptyString(action?.function)
    ) {
      continue;
    }
    if (!grouped.has(event)) grouped.set(event, []);
    grouped.get(event).push(action);
  }
  return [...grouped.entries()].map(([event, actions]) => singletonDispatcherContract(event, actions));
}

function renderExpectedScriptBody(source, detailTableNames = {}, form = {}) {
  const compiled = compileSetFieldAttrRowMarkerTargets(source, form);
  return String(compiled || "").replace(/\$\{table:([^}]+)\}/g, (_, tableId) => {
    const sourceTableId = String(tableId || "").trim();
    return detailTableNames[sourceTableId] || sourceTableId;
  });
}

function buildExpectedWorkflow(workflow, diagnostics, context = {}) {
  const projectedWorkflow = projectSubProcessWorkflow(workflow);
  const nodes = projectedWorkflow.nodes;
  const edges = projectedWorkflow.edges;
  const formulaParticipantNodeIds = new Set(
    nodes.filter((node) => isFormulaParticipantMode(node?.participants?.mode)).map((node) => node.id)
  );
  const initiatorSelectTargetNodeIds = collectInitiatorSelectTargetNodeIds(nodes);
  for (const nodeId of formulaParticipantNodeIds) initiatorSelectTargetNodeIds.delete(nodeId);
  const defaultEdgeIds = collectDefaultEdgeIds(nodes, edges);
  const conditionBranchNodeIds = new Set(
    nodes.filter(isNativeFormulaGatewayNode).map((node) => node.id)
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
    if (node.participants?.mode === "configured_person_fallback") {
      diagnostics.push(projectionError(
        "projection.workflow.configured_fallback_unresolved",
        "Configured formula participant fallbacks must be materialized by participant resolution before persistence.",
        {
          nodeId: node.id,
          fallbackKind: node.participants.fallbackKind || "",
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
      help: nonEmptyString(node.help) ? normalizeScalar(node.help) : undefined,
      mustModifyHandlerNodeIds: splitRelatedNodeIds(attributes.mustModifyHandlerNodeIds)
        .filter((nodeId) => !formulaParticipantNodeIds.has(nodeId)),
      canModifyHandlerNodeIds: splitRelatedNodeIds(attributes.canModifyHandlerNodeIds)
        .filter((nodeId) => !formulaParticipantNodeIds.has(nodeId)),
      participants: summarizeParticipants(node, initiatorSelectTargetNodeIds.has(node.id), context),
      alternativeParticipants: summarizeAlternativeParticipants(node.participants),
      sendConfig: summarizeSendConfig(node),
      manualBranch: summarizeExpectedManualBranch(node),
      parallelGateway: summarizeExpectedParallelGateway(node, edges),
      dataAuthority: summarizeDataAuthority(node),
      ignoreOnSameIdentity: expectedIgnoreOnSameIdentity(node),
      subProcess: node.type === "startSubProcess" ? summarizeExpectedSubProcess(node.subProcess) : undefined
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

function summarizeExpectedSubProcess(value = {}) {
  const contract = subProcessContract(value);
  return {
    ...contract,
    templateId: normalizeScalar(contract.templateId),
    recoverNodeId: normalizeScalar(contract.recoverNodeId),
    startCountType: normalizeScalar(contract.startCountType),
    flowType: normalizeScalar(contract.flowType)
  };
}

function isFormulaParticipantMode(mode) {
  return [
    "form_field",
    "person_by_login_name",
    "dept_leader_by_no",
    "doc_creator",
    "node_history_superior_department_head",
    "field_role_line_script",
    "configured_person_fallback",
    "script_formula"
  ].includes(mode);
}

function collectDefaultEdgeIds(nodes = [], edges = []) {
  const conditionBranchNodeIds = new Set(
    nodes.filter(isNativeFormulaGatewayNode).map((node) => node.id)
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
    const members = node?.participants?.mode === "explicit"
      ? (node.participants.members || [])
        .map((member) => ({
          id: normalizeScalar(member.id),
          element: "user",
          type: expectedNativeMemberType(member)
        }))
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
      : [];
    return {
      mode: "initiator_select",
      handlersType: "org",
      handlersSource: "1",
      handlersRuleKey: "",
      handlersRuleName: "",
      handlersElement: "users",
      members
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
  if (node.participants.mode === "script_formula") {
    return {
      mode: "script_formula",
      recipe: node.participants.recipe,
      fieldId: node.participants.fieldId,
      nativeFormula: expectedParticipantFormula(node.participants, context)
    };
  }
  if (node.participants.mode === "field_role_line_script") {
    return {
      mode: "field_role_line_script",
      recipe: node.participants.recipe,
      fieldId: node.participants.fieldId,
      nativeFormula: expectedParticipantFormula(node.participants, context)
    };
  }
  if (node.participants.mode === "node_history_superior_department_head") {
    return {
      mode: "node_history_superior_department_head",
      nodeId: node.participants.nodeId,
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
  let ruleVoContent;

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
  } else if (participants?.mode === "node_history_superior_department_head") {
    const nodeId = JSON.stringify(String(participants.nodeId || ""));
    script = `return \${func.sysorg.getSuperiorDepartmenthead}(\${func.lbpm.getNodeHistoryHandlers}(${nodeId}, false), 1)`;
    ruleVoContent = `return #查找上级部门领导#(#获取节点历史处理人#(${nodeId}, false), 1)`;
    ruleMode = "script";
    ruleKeyMode = "";
  } else if (participants?.mode === "field_role_line_script") {
    const dataRef = `\${data.${fieldRef}}`;
    const displayRef = `$内置表单.${participants.fieldTitle || fieldId}$`;
    if (participants.recipe === "department_head") {
      script = `return \${func.sysorg.getDepartmentHead}(${dataRef}) || [];`;
      ruleVoContent = `return #查找部门领导#(${displayRef}) || [];`;
    } else if (participants.recipe === "superior_department_head") {
      script = `return \${func.sysorg.getSuperiorDepartmenthead}(${dataRef}, 1) || [];`;
      ruleVoContent = `return #查找上级部门领导#(${displayRef}, 1) || [];`;
    }
    ruleMode = "script";
    ruleKeyMode = "";
  } else if (participants?.mode === "script_formula") {
    const binding = expectedDetailScriptFormulaBinding(participants, context);
    const dataRef = `\${data.${binding.variableId}}`;
    if (participants.recipe === "detail_login_names_to_persons") {
      script = `var values = ${dataRef} || []; var handlers = []; var seen = {}; for (var i = 0; i < values.length; i++) { var loginName = String(values[i] || ""); if (!loginName || seen[loginName]) { continue; } seen[loginName] = true; var found = \${func.sysorg.getPersonByLoginName}(loginName) || []; if (Object.prototype.toString.call(found) === "[object Array]") { for (var j = 0; j < found.length; j++) { if (found[j]) { handlers.push(found[j]); } } } else if (found) { handlers.push(found); } } return handlers;`;
    } else if (participants.recipe === "first_detail_department_code_to_head") {
      script = `var values = ${dataRef} || []; if (!values.length) { return []; } var departments = \${func.sysorg.getElementByNo}(String(values[0]), "2") || []; return \${func.sysorg.getDepartmentHead}(departments) || [];`;
    }
    ruleVoContent = expectedScriptFormulaDisplayContent(script, dataRef, binding.displayRef);
    ruleMode = "script";
    ruleKeyMode = "";
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
    ruleKeyType: ["script_formula", "node_history_superior_department_head", "field_role_line_script"].includes(participants?.mode)
      ? "Script"
      : "Eval",
    ruleKeyMode,
    ruleVoMode: ["script_formula", "node_history_superior_department_head", "field_role_line_script"].includes(participants?.mode)
      ? "script"
      : "formula",
    ...(ruleVoContent !== undefined ? { ruleVoContent } : {}),
    resultType: [
      "person_by_login_name",
      "doc_creator",
      "script_formula",
      "node_history_superior_department_head",
      "field_role_line_script"
    ].includes(participants?.mode)
      ? "org_array"
      : "none"
  };
}

function expectedDetailScriptFormulaBinding(participants, context = {}) {
  const detailTableId = String(participants?.detailTableId || "").trim();
  const fieldId = String(participants?.fieldId || "").trim();
  const detailTable = (context.form?.fields || []).find((field) =>
    field?.id === detailTableId && field?.type === "detailTable"
  );
  const column = (detailTable?.columns || []).find((field) => field?.id === fieldId);
  const physicalTableName = detailTableNameFor(context.mainTableName, detailTableId);
  const fieldTitle = participants?.fieldTitle || column?.title || fieldId;
  return {
    variableId: `${context.templateId}-${physicalTableName}.${fieldId}`,
    displayRef: `$内置表单.${detailTable?.title || detailTableId}.${fieldTitle}$`
  };
}

function expectedScriptFormulaDisplayContent(script, dataRef, displayRef) {
  return String(script)
    .replace(dataRef, () => displayRef)
    .replace(/\$\{func\.sysorg\.getPersonByLoginName\}/g, "#根据登录名查找人员#")
    .replace(/\$\{func\.sysorg\.getElementByNo\}/g, "#根据组织编码查找组织#")
    .replace(/\$\{func\.sysorg\.getDepartmentHead\}/g, "#查找部门领导#");
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

function summarizeExpectedParallelGateway(node, edges = []) {
  if (!node || !["split", "join"].includes(node.type)) return undefined;
  const attrs = sourceAttributes(node);
  const conditional = isConditionalParallelSplit(node);
  return {
    mode: conditional ? "3" : "1",
    relatedNodeId: splitRelatedNodeIds(attrs.relatedNodeIds)[0] || "",
    direction: node.type === "split" ? "diverging" : "converging",
    ...(conditional ? {
      conditionType: "1",
      conditionRouteIds: edges
        .filter((edge) => edge?.source === node.id && (
          edgeConditionText(edge) || edge.name || isExplicitDefaultEdge(edge)
        ))
        .map((edge) => edge.id)
        .sort()
    } : {})
  };
}

function summarizeExpectedManualBranch(node) {
  if (node?.type !== "manualBranch") return undefined;
  return { decisionType: normalizeScalar(node.decisionType) };
}

function isNativeFormulaGatewayNode(node) {
  return node?.type === "conditionBranch" || isConditionalParallelSplit(node);
}

function isConditionalParallelSplit(node) {
  return node?.type === "split" &&
    String(sourceAttributes(node).splitType || "").trim().toLowerCase() === "condition";
}

function summarizeCondition(edge, conditionBranch, context = {}) {
  const sourceText = edge?.condition?.sourceText ||
    (typeof edge?.condition === "string" ? edge.condition : "") ||
    edge?.condition?.targetText ||
    edge?.condition?.displayText ||
    edge?.displayCondition ||
    "";
  const semanticText = edge?.condition?.targetText || sourceText;
  if (!String(sourceText).trim()) return undefined;
  const scriptSemantics = conditionBranch
    ? expectedCreatorParentPathContainsScriptSemantics(semanticText)
    : undefined;
  const nativeSemantics = scriptSemantics || (
    conditionBranch ? expectedBatchConditionSemantics(semanticText, context) : undefined
  );
  const nativeKind = conditionBranch
    ? scriptSemantics
      ? "script_formula"
      : nativeSemantics?.recipe === "eval_formula"
        ? "eval_formula"
        : nativeSemantics || sharedIsTautologyCondition(sourceText)
          ? "batch_formula"
          : undefined
    : "rule";
  return {
    sourceText: normalizeScalar(sourceText),
    nativeRequired: true,
    ...(nativeKind ? { nativeKind } : {}),
    ...(nativeKind === "rule" ? { nativeText: normalizeRuleConditionText(semanticText) } : {}),
    ...(nativeSemantics ? { nativeSemantics } : {})
  };
}

function expectedCreatorParentPathContainsScriptSemantics(sourceText) {
  const match = String(sourceText || "").trim().match(
    /^\$字符串\.包含\$\(\s*\$(?:docCreator|申请人|起草人)\$\s*\.\s*getFdParentsName\s*\(\s*["']\/["']\s*\)\s*,\s*("(?:\\.|[^"\\])*")\s*\)$/i
  );
  if (!match) return undefined;
  try {
    return {
      recipe: "creator_parent_path_contains",
      needle: JSON.parse(match[1])
    };
  } catch {
    return undefined;
  }
}

function expectedBatchConditionSemantics(sourceText, context = {}) {
  const compact = String(sourceText || "").replace(/\s+/g, "");
  if (/^(?:1={2,3}2|1!={1,2}1|false)$/i.test(compact)) {
    return { resultShape: "false", varCount: 0 };
  }

  // Field sums are written as formula-designer Eval scripts, never Batch RULEs.
  const evalSemantics = expectedEvalConditionSemantics(sourceText, context);
  if (evalSemantics) return evalSemantics;

  const parsedAst = parseExpectedContextConditionExpression(sourceText);
  if (parsedAst) {
    return expectedContextConditionSemantics(parsedAst, context);
  }

  const negated = unwrapExpectedNegation(compact);
  const text = negated.text;
  const orgFdNo = text.match(/^\$([^$]+)\$\.fdNo\.equals\(["']([^"']+)["']\)$/i);
  if (orgFdNo) {
    if (!expectedConditionFieldExists(context, orgFdNo[1])) return undefined;
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
    if (!expectedConditionFieldExists(context, fieldId)) return undefined;
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

function expectedEvalConditionSemantics(sourceText, context = {}) {
  if (!context.templateId) return undefined;
  const ast = parseExpectedEvalConditionExpression(sourceText);
  if (!ast || !conditionAstUsesFieldSum(ast) || !canRenderEvalConditionFormula(ast)) return undefined;
  const parts = renderEvalConditionFormula(ast, {
    templateId: context.templateId,
    resolveField(fieldId) {
      return expectedEvalConditionField(context, fieldId);
    }
  });
  if (!parts?.script) return undefined;
  return { recipe: "eval_formula", script: parts.script };
}

function expectedEvalConditionField(context, fieldId) {
  const field = expectedConditionField(context.form, fieldId);
  if (field) return field;
  const semantic = conditionContextSemantic(fieldId);
  if (semantic?.source === "creatorDept" && semantic.property === "fdName") {
    return { id: "fdCreatorDept.fdName", title: "创建者部门名称" };
  }
  return undefined;
}

// Mirrors the writer's parseSimpleCondition for the term shapes the Eval
// renderer supports (field sums plus plain comparisons). Everything else
// delegates to the context parser so contains/equals idioms keep parsing;
// non-renderable terms make canRenderEvalConditionFormula reject the AST.
function parseExpectedEvalConditionTerm(value) {
  const text = String(value || "").trim();

  const fieldSumCompare = text.match(
    /^\(\s*\$([^$]+)\$\s*\+\s*\$([^$]+)\$\s*\)\s*(>=|<=|>|<|==|!=)\s*(-?\d+(?:\.\d+)?)$/
  ) || text.match(
    /^\$([^$]+)\$\s*\+\s*\$([^$]+)\$\s*(>=|<=|>|<|==|!=)\s*(-?\d+(?:\.\d+)?)$/
  );
  if (fieldSumCompare) {
    const leftField = fieldSumCompare[1].trim();
    const rightField = fieldSumCompare[2].trim();
    return {
      field: leftField,
      fields: [leftField, rightField],
      value: fieldSumCompare[4],
      symbol: fieldSumCompare[3],
      expressionType: "fieldSumCompare",
      operator: "+"
    };
  }

  const fieldCompareNumber = text.match(/^\$([^$]+)\$\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (fieldCompareNumber) {
    return {
      field: fieldCompareNumber[1].trim(),
      value: fieldCompareNumber[3],
      symbol: fieldCompareNumber[2],
      expressionType: fieldCompareNumber[2]
    };
  }

  const valueCompareNumber = text.match(/^(-?\d+(?:\.\d+)?)\s*(>=|<=|>|<)\s*\$([^$]+)\$$/);
  if (valueCompareNumber) {
    const symbol = flipExpectedCompareSymbol(valueCompareNumber[2]);
    return {
      value: valueCompareNumber[1],
      field: valueCompareNumber[3].trim(),
      symbol,
      expressionType: symbol
    };
  }

  const fieldNotEquals = text.match(/^\$([^$]+)\$\s*!={1,2}\s*["']([^"']*)["']$/) ||
    text.match(/^\$([^$]+)\$\s*!={1,2}\s*(-?\d+(?:\.\d+)?)$/);
  if (fieldNotEquals) {
    return {
      field: fieldNotEquals[1].trim(),
      value: fieldNotEquals[2],
      symbol: "!=",
      expressionType: "!="
    };
  }

  return parseExpectedContextConditionTerm(text);
}

function negateExpectedEvalConditionTerm(term) {
  if (term.expressionType === "fieldSumCompare") {
    return { ...term, symbol: negateExpectedCompareSymbol(term.symbol) };
  }
  if (["==", "!=", ">", ">=", "<", "<="].includes(term.symbol)) {
    const symbol = negateExpectedCompareSymbol(term.symbol);
    return { ...term, symbol, expressionType: symbol };
  }
  return negateExpectedContextConditionTerm(term);
}

function flipExpectedCompareSymbol(symbol) {
  if (symbol === ">") return "<";
  if (symbol === "<") return ">";
  if (symbol === ">=") return "<=";
  if (symbol === "<=") return ">=";
  return symbol;
}

function expectedContextConditionSemantics(ast, context) {
  const functionIds = new Set();
  const orgIds = new Set();
  const evalExpressions = new Set();
  const ruleSymbols = new Set();
  const functionCalls = [];
  const terms = collectConditionTerms(ast);

  for (const term of terms) {
    const contextSemantic = conditionContextSemantic(term.field);
    const field = contextSemantic
      ? { id: "fdCreatorDept.fdName", type: "text" }
      : expectedConditionField(context.form, term.field);
    if (!field) return undefined;
    const fieldRef = expectedFormulaFieldRef(context.templateId, field.id);
    const org = term.expressionType === "contains" && isAddressField(field)
      ? expectedConditionOrg(context.runtime, term.value)
      : undefined;

    if (org) {
      const functionId = "sysorg.isOrganizationBelongOrIncludeAnother";
      functionIds.add(functionId);
      orgIds.add(org.fdId);
      ruleSymbols.add(term.negateResult ? "notbelong" : "belongany");
      functionCalls.push({
        functionId,
        inputs: [{ key: "firstOrgs", type: "Var", value: fieldRef }],
        fixedArguments: [{ key: "isCross", type: "Fixed", value: true }, {
          key: "relationType",
          type: "Fixed",
          value: 4
        }, {
          key: "secondOrgs",
          type: "Fixed",
          value: { orgIds: [org.fdId] }
        }]
      });
      continue;
    }

    if (term.expressionType === "contains") {
      const functionId = "global.contains";
      functionIds.add(functionId);
      ruleSymbols.add(term.negateResult ? "notcontain" : "contain");
      functionCalls.push({
        functionId,
        inputs: [{ key: "X", type: "Var", value: fieldRef }],
        fixedArguments: [{ key: "Y", type: "Fixed", value: term.value }]
      });
      continue;
    }

    const symbol = term.expressionType === "==" ? "==" : term.expressionType;
    if (!["==", "!=", ">", ">=", "<", "<="].includes(symbol)) return undefined;
    evalExpressions.add(`\${data.${fieldRef}} ${symbol} ${JSON.stringify(term.value)}`);
    ruleSymbols.add(term.symbol);
  }

  return {
    resultShape: expectedConditionResultShape(ast),
    varCount: terms.length,
    functionIds: [...functionIds].sort(),
    orgIds: [...orgIds].sort(),
    evalExpressions: [...evalExpressions].sort(),
    ruleSymbols: [...ruleSymbols].sort(),
    functionCalls: functionCalls.sort((left, right) =>
      stableStringify(left).localeCompare(stableStringify(right))
    )
  };
}

function parseExpectedContextConditionTerm(value) {
  const text = String(value || "").trim();
  const contains = text.match(
    /^\$(?:字符串|列表)\.包含\$\(\s*\$([^$]+)\$(?:\s*\.\s*getFdName\s*\(\s*\))?\s*,\s*(["'])([\s\S]*?)\2\s*\)$/
  );
  if (contains) {
    return {
      field: contains[1].trim(),
      value: contains[3],
      symbol: "contain",
      expressionType: "contains",
      negateResult: false
    };
  }

  const legacyEquals = text.match(/^["']([^"']*)["']\s*\.\s*equals\s*\(\s*\$([^$]+)\$\s*\)$/);
  if (legacyEquals) {
    return { value: legacyEquals[1], field: legacyEquals[2].trim(), symbol: "==", expressionType: "==" };
  }
  const fieldMethodEquals = text.match(/^\$([^$]+)\$\s*\.\s*equals\s*\(\s*["']([^"']*)["']\s*\)$/i);
  if (fieldMethodEquals) {
    return { field: fieldMethodEquals[1].trim(), value: fieldMethodEquals[2], symbol: "==", expressionType: "==" };
  }
  const fieldEqualsString = text.match(/^\$([^$]+)\$\s*={2,3}\s*["']([^"']*)["']$/);
  if (fieldEqualsString) {
    return { field: fieldEqualsString[1].trim(), value: fieldEqualsString[2], symbol: "==", expressionType: "==" };
  }
  const fieldEqualsNumber = text.match(/^\$([^$]+)\$\s*={2,3}\s*(-?\d+(?:\.\d+)?)$/);
  if (fieldEqualsNumber) {
    return { field: fieldEqualsNumber[1].trim(), value: fieldEqualsNumber[2], symbol: "==", expressionType: "==" };
  }
  return undefined;
}

function negateExpectedContextConditionTerm(term) {
  if (term.expressionType === "contains") {
    const negated = !term.negateResult;
    return {
      ...term,
      symbol: negated ? "notcontain" : "contain",
      negateResult: negated
    };
  }
  const symbol = negateExpectedCompareSymbol(term.symbol);
  return { ...term, symbol, expressionType: symbol };
}

function expectedConditionResultShape(ast) {
  if (ast.type === "term") return `(${expectedConditionTermResult(ast.term)})`;
  return `(${ast.children.map((child) =>
    child.type === "term"
      ? expectedConditionTermResult(child.term)
      : expectedConditionResultShape(child)
  ).join(` ${ast.operator} `)})`;
}

function expectedConditionTermResult(term) {
  return term.negateResult ? "!${VAR}" : "${VAR}";
}

function expectedConditionField(form, fieldId) {
  for (const field of form?.fields || []) {
    if (field?.id === fieldId) return field;
    const column = (field?.columns || []).find((item) => item?.id === fieldId);
    if (column) return column;
  }
  return undefined;
}

function expectedConditionOrg(runtime, name) {
  const values = runtime?.conditionOrgByName;
  const hit = values instanceof Map ? values.get(String(name || "")) : values?.[String(name || "")];
  if (!hit?.fdId || !hit?.fdName) return undefined;
  return { fdId: String(hit.fdId) };
}

function expectedConditionFieldExists(context = {}, fieldId) {
  const id = String(fieldId || "").trim();
  if (!id) return false;
  if (context.formFieldById instanceof Map && context.formFieldById.has(id)) return true;
  return Boolean(expectedConditionField(context.form, id));
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
  if (type === "conditionBranch" || type === "manualBranch") return "exclusiveGateway";
  if (type === "split" || type === "join") return "parallelGateway";
  if (type === "robot") return "robot";
  if (type === "startSubProcess" || type === "recoverSubProcess") return "subProcess";
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
    active: rule.active,
    logic: rule.logic,
    conditions: rule.conditions,
    effects: rule.effects
  });
}
