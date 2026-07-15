import { componentSupportsProp } from "../../dsl/catalogs.js";

export function buildFormSummary(observedForm, observedRules, observedScripts) {
  const fields = (observedForm?.fields || []).map((field) => ({
    id: field.id,
    title: field.title,
    type: field.type,
    component: field.component,
    required: field.props?.required === true,
    ...(componentSupportsProp(field.component, "placeholder") && field.props?.placeholder !== undefined
      ? { placeholder: field.props.placeholder }
      : {}),
    style: field.props?.style,
    dataOnly: field.dataOnly === true,
    columns: (field.columns || []).map((column) => ({
      id: column.id,
      title: column.title,
      type: column.type,
      component: column.component,
      required: column.props?.required === true,
      ...(componentSupportsProp(column.component, "placeholder") && column.props?.placeholder !== undefined
        ? { placeholder: column.props.placeholder }
        : {})
    }))
  }));
  const layoutRows = (observedForm?.layoutRows || []).map((row) => ({
    id: row.id,
    rows: row.rows,
    columns: row.columns,
    fields: (row.cells || []).flatMap((cell) => cell.fieldIds || []),
    cells: (row.cells || []).map((cell) => ({
      fieldId: (cell.fieldIds || [])[0],
      fieldIds: cell.fieldIds || [],
      row: cell.row,
      column: cell.column,
      colspan: cell.colspan
    }))
  }));
  const rules = observedRules?.rules || [];
  const displayRules = rules.filter((rule) => rule.kind === "display");
  const requireRules = rules.filter((rule) => rule.kind === "require");
  const actions = observedScripts?.actions || [];

  return {
    fieldCount: fields.length,
    fields,
    subjectRule: observedForm?.subjectRule,
    persistence: {
      mainTableName: observedForm?.tableName,
      detailTables: (observedForm?.persistence?.detailModels || []).map((model) => ({
        fieldId: model.fieldId,
        tableName: model.tableName
      }))
    },
    detailTableCount: fields.filter((field) => field.type === "detailTable").length,
    layoutRowCount: layoutRows.length,
    layoutRows,
    scripts: {
      actionCount: actions.length,
      persistedActionCount: observedScripts?.persistedActionCount ?? actions.length,
      events: [...new Set(actions.map((action) => action.event).filter(Boolean))],
      dispatchers: observedScripts?.dispatchers || [],
      controlEvents: actions
        .filter((action) => action.scope === "control")
        .map((action) => ({
          controlKey: action.controlKey,
          event: action.event,
          count: 1
        })),
      javascriptLength: 0,
      actions: actions.map((action) => ({
        id: action.id,
        event: action.event,
        scope: action.scope,
        controlKey: action.controlKey,
        runWhen: action.runWhen,
        guardViewStatusIn: action.runWhen?.viewStatusIn,
        hasCanonicalGuard: action.hasCanonicalGuard === true
      }))
    },
    formRules: {
      displayRuleCount: displayRules.length,
      requireRuleCount: requireRules.length,
      displayRules,
      requireRules
    }
  };
}

export function buildWorkflowSummary(observedWorkflow) {
  if (!observedWorkflow) return undefined;
  const nodes = observedWorkflow.nodes || [];
  const edges = observedWorkflow.edges || [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const hasCondition = (edge) => Boolean(
    edge.condition?.text || edge.condition?.nativeStatus === "ok"
  );
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    conditionEdgeCount: edges.filter(hasCondition).length,
    invalidEdgeCount: edges.filter((edge) => !edge.source || !edge.target || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)).length,
    initiatorSelectNodeIds: nodes
      .filter((node) => node.participants?.mode === "initiator_select")
      .map((node) => node.id)
      .sort(),
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      element: node.element,
      ignoreOnSameIdentity: node.ignoreOnSameIdentity,
      ...(summarizeWorkflowParticipants(node.participants)
        ? { participants: summarizeWorkflowParticipants(node.participants) }
        : {})
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      isDefault: edge.isDefault === true,
      hasCondition: hasCondition(edge),
      condition: edge.condition ? {
        nativeKind: edge.condition.nativeKind,
        nativeStatus: edge.condition.nativeStatus,
        functionIds: edge.condition.functionIds || [],
        orgIds: edge.condition.orgIds || []
      } : undefined
    }))
  };
}

function summarizeWorkflowParticipants(participants) {
  if (!participants || typeof participants !== "object" || !participants.mode) return undefined;
  return {
    mode: participants.mode,
    ...(participants.fieldId ? { fieldId: participants.fieldId } : {}),
    ...(participants.subjectKind ? { subjectKind: participants.subjectKind } : {}),
    ...(participants.nodeId ? { nodeId: participants.nodeId } : {})
  };
}
