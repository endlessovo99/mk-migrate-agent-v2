export function applyWorkflowPayload(template, dsl) {
  if (!dsl.workflow) return template;

  const next = clone(template);
  next.mechanisms = next.mechanisms || {};
  next.mechanisms.lbpmTemplate = Array.isArray(next.mechanisms.lbpmTemplate)
    ? next.mechanisms.lbpmTemplate
    : [{}];

  const lbpm = next.mechanisms.lbpmTemplate[0] || {};
  next.mechanisms.lbpmTemplate[0] = lbpm;
  lbpm.fdContent = JSON.stringify(buildWorkflowContent(dsl.workflow, {
    templateId: next.fdId || next.mechanisms["sys-xform"]?.fdId || "",
    form: dsl.form
  }));
  lbpm.fdStatus = "draft";
  lbpm.fdPublishType ||= "instant";
  lbpm.isDraft = true;
  lbpm.fdReaders = next.fdReaders || lbpm.fdReaders || [];
  lbpm.fdEditors = next.fdEditors || lbpm.fdEditors || [];

  return next;
}

export function buildWorkflowContent(workflow, context = {}) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  const outgoingEdges = groupEdgesBySource(edges);
  const workflowContext = {
    ...context,
    formFieldById: context.formFieldById || buildFormFieldIndex(context.form),
    formFieldsByTitle: context.formFieldsByTitle || buildFormFieldTitleIndex(context.form)
  };
  const branchRoutes = buildBranchRoutes(nodes, outgoingEdges, workflowContext);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const nodeElements = nodes.map((node, index) => buildNodeElement(
    node,
    index,
    outgoingEdges.get(node.id) || [],
    nodeById,
    branchRoutes.bySource.get(node.id) || [],
    workflowContext
  ));
  const edgeElements = edges.map((edge, index) => buildEdgeElement(edge, index, branchRoutes.byEdge.get(edge.id)));

  return {
    name: workflow.process?.name || workflow.process?.id || "流程模板",
    elements: [...nodeElements, ...edgeElements],
    operSubmitValidators: [],
    aiCheckConfig: [],
    signalCatchers: [],
    events: [],
    default: [],
    diagram: "",
    flowType: "0",
    notifyDrafterOnEnd: "false",
    notifyParticipantOnEnd: "false",
    notifyDrafterOnException: "false",
    notifyAdminOnException: "false",
    notifyCurrentHandlerOnDraftRetract: "false",
    adminFormAuth: "{\"view\":true,\"editable\":false,\"deletable\":false}",
    processEndIsCirculated: "false",
    rejectDenyRetract: "false",
    canCirculationIdentity: "draft",
    fdHighLights: {},
    groupChat: { isEnabled: false },
    migrationDsl: {
      workflow: summarizeDslWorkflow(workflow)
    }
  };
}

export function summarizeWorkflowFromTemplate(template) {
  const content = parseJsonObject(template?.mechanisms?.lbpmTemplate?.[0]?.fdContent || "{}");
  const elements = Array.isArray(content.elements) ? content.elements : [];
  const nodes = elements.filter((element) => element.type !== "sequenceFlow");
  const edges = elements.filter((element) => element.type === "sequenceFlow");
  const nodeIds = new Set(nodes.map((node) => node.id).filter(Boolean));
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    conditionEdgeCount: edges.filter((element) => hasEdgeCondition(element)).length,
    invalidEdgeCount: edges.filter((edge) => !edge.sourceRef || !edge.targetRef || !nodeIds.has(edge.sourceRef) || !nodeIds.has(edge.targetRef)).length,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      element: node.element
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceRef,
      target: edge.targetRef,
      hasCondition: hasEdgeCondition(edge)
    }))
  };
}

export function summarizeDslWorkflow(workflow = {}) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  return {
    processId: workflow.process?.id || "",
    nodeCount: nodes.length,
    edgeCount: edges.length,
    conditionEdgeCount: edges.filter((edge) => Boolean(edgeConditionText(edge))).length,
    invalidEdgeCount: 0,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      mappedType: node.type
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      hasCondition: Boolean(edgeConditionText(edge))
    }))
  };
}

export function workflowMappingDiagnostics(workflow) {
  const diagnostics = [];
  for (const node of workflow?.nodes || []) {
    if (isKnownNodeType(node.type)) continue;
    diagnostics.push({
      level: "warning",
      code: "workflow.node_type_mapped_to_review",
      message: `Workflow node ${node.id} has unsupported type ${node.type}; mapped to review.`,
      path: "/workflow/nodes",
      details: {
        nodeId: node.id,
        sourceType: node.type,
        mappedType: "review"
      }
    });
  }
  return diagnostics;
}

function mapNodeType(type = "") {
  const normalized = String(type).toLowerCase();
  if (["generalstart", "generalend", "draft", "review", "send", "robot", "conditionbranch", "split", "join"].includes(normalized)) {
    return type;
  }
  if (normalized.includes("start")) return "generalStart";
  if (normalized.includes("split")) return "split";
  if (normalized.includes("join")) return "join";
  if (normalized.includes("send") || normalized.includes("cc")) return "send";
  if (normalized.includes("end")) return "generalEnd";
  if (normalized.includes("draft")) return "draft";
  if (normalized.includes("robot")) return "robot";
  if (normalized.includes("gateway") || normalized.includes("branch")) return "conditionBranch";
  if (normalized.includes("review") || normalized.includes("manual") || normalized.includes("task") || normalized.includes("approval")) {
    return "review";
  }
  return "review";
}

function isKnownNodeType(type = "") {
  const normalized = String(type).toLowerCase();
  return normalized.includes("start") ||
    normalized.includes("end") ||
    normalized.includes("draft") ||
    normalized.includes("review") ||
    normalized.includes("send") ||
    normalized.includes("split") ||
    normalized.includes("join") ||
    normalized.includes("parallel") ||
    normalized.includes("robot") ||
    normalized.includes("manual") ||
    normalized.includes("task") ||
    normalized.includes("approval") ||
    normalized.includes("gateway") ||
    normalized.includes("branch");
}

function mapNodeElement(type = "") {
  const mapped = mapNodeType(type);
  if (mapped === "generalStart") return "startEvent";
  if (mapped === "generalEnd") return "endEvent";
  if (mapped === "conditionBranch") return "exclusiveGateway";
  if (mapped === "split" || mapped === "join") return "parallelGateway";
  if (mapped === "robot") return "robot";
  return "manualTask";
}

function buildNodeElement(node, index, outgoingEdges, nodeById, branchRoutes, context = {}) {
  const mappedType = mapNodeType(node.type);
  const builders = {
    generalStart: buildStartNode,
    generalEnd: buildEndNode,
    draft: buildDraftNode,
    conditionBranch: (value) => buildConditionBranchNode(value, branchRoutes),
    split: (value, valueIndex) => buildParallelGatewayNode(value, valueIndex, "split", nodeById),
    join: (value, valueIndex) => buildParallelGatewayNode(value, valueIndex, "join", nodeById),
    send: (value) => buildArtificialNode(value, "send", context),
    robot: buildRobotNode,
    review: (value) => buildArtificialNode(value, "review", context)
  };
  const builder = builders[mappedType] || builders.review;
  return builder(node, index);
}

function buildStartNode(node, index) {
  return {
    ...baseNode(node, index, "generalStart", "startEvent", 34, 34),
    language: { nameCn: node.name || "开始节点", nameUs: "Start Node" }
  };
}

function buildEndNode(node, index) {
  return {
    ...baseNode(node, index, "generalEnd", "endEvent", 34, 34),
    language: { nameCn: node.name || "结束节点", nameUs: "End Node" }
  };
}

function buildDraftNode(node, index) {
  const attrs = sourceAttributes(node);
  return {
    ...baseNode(node, index, "draft", "manualTask", 160, 40),
    mustModifyHandlerNodes: attrs.mustModifyHandlerNodeIds || "",
    formKey: "default",
    formName: "默认表单",
    operationRefId: "custom",
    openModifyProcessAuthority: "true",
    openNodeAuthority: "false",
    modifyProcessAuthority: "2",
    nodeAuthority: "0",
    canAbandonRejectedProcess: "true",
    number: node.id,
    allowUploadAttachments: "true",
    nodeNotifyTypeMethod: [],
    operations: [
      {
        identity: "1",
        elements: [{ element: "operation", type: "drafter_abandon", name: "废弃", srcName: "废弃" }]
      },
      {
        identity: "2",
        elements: [{ element: "operation", type: "drafter_submit", name: "提交", srcName: "提交", isAlway: true }]
      },
      { identity: "3", elements: [] }
    ],
    language: { nameCn: node.name || "起草节点", nameUs: "Drafting Node" },
    ...commentAuthority(),
    nodeNotifyType: "{\"system\":\"todo\"}"
  };
}

function buildArtificialNode(node, type, context = {}) {
  const attrs = sourceAttributes(node);
  const name = node.name || attrs.name || (type === "send" ? "抄送" : "审批节点");
  return {
    ...baseNode(node, 0, type, "manualTask", 160, 40),
    name,
    required: true,
    emptyHandlerType: 2,
    formKey: "default",
    operationRefId: "default",
    openModifyProcessAuthority: "true",
    openNodeAuthority: "true",
    modifyProcessAuthority: "1",
    nodeAuthority: "2",
    allowUploadAttachments: "true",
    canModifyCommentViewPermission: "false",
    canModifyProcess: "false",
    handSignRequired: "false",
    canCirculated: "false",
    allowQuickApproval: "false",
    allowSendDing: "true",
    allowMobileHandle: "true",
    approvalFormConfigType: "default",
    simpleName: type === "send" ? "抄送" : name,
    scope: "artificial",
    number: node.id,
    relateId: node.id,
    cooperateType: attrs.processType || "2",
    ignoreOnSameIdentity: normalizeSameIdentity(attrs.ignoreOnHandlerSame),
    handlerIds: attrs.handlerIds,
    handlerNames: attrs.handlerNames,
    handlerSelectType: attrs.handlerSelectType,
    recalculateHandler: attrs.recalculateHandler,
    ignoreOnHandlerEmpty: attrs.ignoreOnHandlerEmpty,
    nodeNotifyTypeMethod: [],
    handlers: handlersFromParticipants(node.participants, attrs, context),
    fdScene: { fdMode: 0 },
    language: { nameCn: name, nameUs: type === "send" ? "Approval Node" : "Approval Node" },
    ...commentAuthority(),
    nodeNotifyType: "{\"system\":\"todo\"}",
    nodeNotifyContentType: "system"
  };
}

function buildRobotNode(node, index) {
  const attrs = sourceAttributes(node);
  return {
    ...baseNode(node, index, "robot", "robot", 160, 40),
    nodeErrorSkip: "true",
    simpleName: "机器人节点",
    scope: "advanced",
    number: node.id,
    relateId: node.id,
    robotType: attrs.unid || "com.landray.paas.lbpm.support.node.robot.control.RobotNodePauseAndWakeServiceImpl",
    robotConfig: attrs.content || "{}",
    events: [],
    language: { nameCn: node.name || "机器人节点", nameUs: "Robot Node" }
  };
}

function buildConditionBranchNode(node, routes) {
  const attrs = sourceAttributes(node);
  const defaultRoute = routes.find((route) => route.defaultTrend) || routes[routes.length - 1];
  const element = {
    ...baseNode(node, 0, "conditionBranch", "exclusiveGateway", 34, 34),
    conditionType: "1",
    simpleName: node.name || attrs.name || "条件分支",
    number: node.id,
    relateId: node.id,
    scope: "branch",
    operations: [],
    language: { nameCn: node.name || "条件分支", nameUs: "Conditional Branch" }
  };
  if (routes.length) {
    element.resultSetMapping = JSON.stringify(routes.map((route) => ({ id: route.lineId, resultCode: route.resultCode })));
    element.default = defaultRoute.lineId;
    element.conditionId = defaultRoute.lineId;
    element.conditionValue = JSON.stringify({
      formulas: routes.map((route) => route.conditionValue)
    });
  }
  return element;
}

function buildParallelGatewayNode(node, index, type, nodeById) {
  const attrs = sourceAttributes(node);
  const relatedId = singleRelatedNodeId(attrs) || node.id;
  const relatedNode = nodeById.get(relatedId);
  const name = node.name || attrs.name || "并行分支";
  const element = {
    ...baseNode(node, index, type, "parallelGateway", 34, 34),
    language: { nameCn: name, nameUs: "Parallel Branch" },
    simpleName: name,
    number: node.id,
    relateId: relatedId,
    gatewayDirection: type === "split" ? "diverging" : "converging"
  };

  if (type === "split") {
    return {
      ...element,
      splitType: "1",
      scope: "branch",
      relation: relatedNode ? {
        name: relatedNode.name || name,
        simpleName: relatedNode.name || name,
        type: "join",
        element: "parallelGateway",
        hidden: true,
        bounds: boundsFor(relatedNode, index, 34, 34)
      } : undefined
    };
  }

  return {
    ...element,
    joinType: "1",
    hidden: true
  };
}

function baseNode(node, index, type, element, width, height) {
  const name = node.name || node.id;
  return {
    type,
    id: node.id,
    element,
    name,
    bounds: boundsFor(node, index, width, height),
    openDataAuthority: false,
    operations: [],
    timeoutStrategies: "[]",
    config: "{}",
    componentOriginalValue: "{}",
    migrationSource: migrationNodeSource(node)
  };
}

function buildEdgeElement(edge, index, branchRoute) {
  const formula = edgeConditionText(edge);
  const displayText = edge.condition?.displayText || edge.displayCondition || formula;
  const element = {
    type: "sequenceFlow",
    id: edge.id || `E${index + 1}`,
    element: "sequenceFlow",
    sourceRef: edge.source,
    targetRef: edge.target,
    name: edge.name || "",
    wayPoints: parseWayPoints(edge.points || edge.attributes?.points),
    style: branchRoute?.defaultTrend ? "sequenceFlow;marker" : "sequenceFlow",
    openDataAuthority: false,
    operations: [],
    timeoutStrategies: "[]",
    config: "{}",
    componentOriginalValue: "{}",
    migrationSource: {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      name: edge.name || "",
      sourceRef: edge.sourceRef || "",
      condition: edge.condition?.sourceText || edge.condition || "",
      displayCondition: edge.condition?.displayText || edge.displayCondition || "",
      targetText: edge.condition?.targetText || "",
      translationStatus: edge.condition?.translationStatus || "",
      sourcePosition: edge.sourcePosition || edge.attributes?.startPosition || "",
      targetPosition: edge.targetPosition || edge.attributes?.endPosition || "",
      points: edge.points || edge.attributes?.points || "",
      priority: edge.priority || edge.attributes?.priority || "",
      attributes: edge.attributes || {},
      sourceXml: edge.sourceXml || ""
    }
  };
  if (branchRoute) {
    const hasFormulaConfig = Boolean(branchRoute.formulaConfig);
    element.priority = branchRoute.priority;
    element.formulaName = hasFormulaConfig ? "" : displayText || branchRoute.resultCode || "";
    element.formulaType = hasFormulaConfig ? "formula" : branchRoute.resultCode ? "rule" : "formula";
    element.defaultTrend = branchRoute.defaultTrend;
    element.language = { nameCn: edge.name || "" };
    element.formula = hasFormulaConfig ? JSON.stringify(branchRoute.formulaConfig) : branchRoute.resultCode || "";
    return element;
  }
  if (formula) {
    element.priority = parseInteger(edge.priority || edge.attributes?.priority, index + 1);
    element.formula = formula;
    element.formulaName = displayText || "";
    element.formulaType = "rule";
    element.defaultTrend = false;
    element.language = { nameCn: edge.name || "" };
  }
  return element;
}

function buildBranchRoutes(nodes, outgoingEdges, context) {
  const bySource = new Map();
  const byEdge = new Map();

  for (const node of nodes) {
    if (mapNodeType(node.type) !== "conditionBranch") continue;

    const routes = (outgoingEdges.get(node.id) || [])
      .filter((edge) => edgeConditionText(edge) || edge.name)
      .map((edge, index) => buildBranchRoute(node, edge, index, context));
    const defaultRoute = routes.find((route) => route.defaultCandidate) || routes[routes.length - 1];
    if (defaultRoute) defaultRoute.defaultTrend = true;
    for (const route of routes) {
      route.conditionValue.defaultTrend = route.defaultTrend;
      byEdge.set(route.lineId, route);
    }
    bySource.set(node.id, routes);
  }

  return { bySource, byEdge };
}

function buildBranchRoute(node, edge, index, context) {
  const resultCode = edgeConditionText(edge);
  const defaultCandidate = isOtherTautologyRoute(edge);
  const formulaConfig = defaultCandidate
    ? buildOtherDefaultFormulaDesignerConfig(node, edge, context) || buildFormulaDesignerConfig(edge, context)
    : buildFormulaDesignerConfig(edge, context);
  const conditionValue = {
    lineId: edge.id,
    lineName: edge.name || edge.id,
    priority: parseInteger(edge.priority || edge.attributes?.priority, index + 1),
    formula: formulaConfig || resultCode || "",
    formulaName: formulaConfig ? "" : edge.condition?.displayText || edge.displayCondition || resultCode || "",
    mode: "simple",
    defaultTrend: false,
    type: "formulas"
  };

  if (formulaConfig) {
    conditionValue.conditionSimpleData = formulaConfig;
    conditionValue.formulaConfig = formulaConfig;
  }

  return {
    lineId: edge.id,
    lineName: edge.name || edge.id,
    priority: conditionValue.priority,
    resultCode,
    formulaConfig,
    defaultTrend: false,
    defaultCandidate,
    conditionValue
  };
}

function buildOtherDefaultFormulaDesignerConfig(node, edge, context) {
  const field = branchFieldForNode(node, context);
  if (!field || !context.templateId) return undefined;

  return buildNotEmptyFormulaDesignerConfig(edge, field, context);
}

function buildNotEmptyFormulaDesignerConfig(edge, field, context) {
  const templateId = context.templateId || "";
  const fieldId = field.id;
  const variableKey = formulaVariableKey(edge.id, `${fieldId}_notempty`);
  const groupKey = formulaVariableKey(edge.id, "group");
  const rootKey = formulaVariableKey(edge.id, "ROOT");
  const fdVarValue = `${templateId}-${fieldId}`;
  const fieldLabel = field.title || fieldId;
  const fieldType = formulaFieldType(field);

  return {
    result: {
      resultType: { type: "boolean" },
      type: "Eval",
      value: `(!\${data.$VAR.${variableKey}})`
    },
    type: "Batch",
    vars: [{
      key: variableKey,
      resultType: { type: "boolean" },
      type: "Function",
      value: "global.isEmpty",
      arguments: [{
        key: "value",
        resultType: { type: "any" },
        type: "Var",
        value: fdVarValue
      }]
    }],
    vo: {
      mode: "simple",
      modeType: "simpleRule",
      data: {
        key: "ROOT",
        fdKey: rootKey,
        leavel: "1",
        fdList: [{
          fdKey: groupKey,
          fdType: "OR",
          leavel: "1",
          parentLeavel: "1-1",
          parentKey: rootKey,
          metaType: "GROUP",
          fdList: [{
            fdKey: variableKey,
            metaType: "RULE",
            parentKey: groupKey,
            parentLeavel: "1-1",
            leavel: "3",
            fdValue: "",
            fdVarValue,
            fdDataType: fieldType,
            fdLabel: `$${fieldLabel}$`,
            vo: formulaFieldVo(field, fieldType),
            fdSymbol: "notempty",
            fdFunctionId: "global.isEmpty"
          }]
        }]
      }
    }
  };
}

function isOtherTautologyRoute(edge) {
  return String(edge?.name || "").trim() === "其他" && isTautologyCondition(edgeConditionText(edge));
}

function isTautologyCondition(condition) {
  return /^(?:1\s*={2,3}\s*1|true)$/i.test(String(condition || "").trim());
}

function branchFieldForNode(node, context) {
  const names = [
    node?.name,
    node?.attributes?.name,
    node?.definition?.attributes?.name
  ].map(normalizeBranchFieldName).filter(Boolean);

  for (const name of names) {
    const candidates = context.formFieldsByTitle?.get(name) || [];
    if (candidates.length === 1) return candidates[0];
  }

  for (const name of names) {
    const stripped = name.replace(/\d+$/g, "");
    if (!stripped || stripped === name) continue;
    const candidates = context.formFieldsByTitle?.get(stripped) || [];
    if (candidates.length === 1) return candidates[0];
  }

  return undefined;
}

function buildFormulaDesignerConfig(edge, context) {
  const parsed = parseEqualityConditionExpression(edgeConditionText(edge));
  if (!parsed) return undefined;

  const templateId = context.templateId || "";
  const groupKey = formulaVariableKey(edge.id, "group");
  const rootKey = formulaVariableKey(edge.id, "ROOT");
  if (!templateId) return undefined;

  const terms = parsed.terms.map((term, index) => {
    const field = context.formFieldById?.get(term.field);
    const fieldId = field?.id || term.field;
    if (!fieldId) return undefined;
    const variableKey = formulaVariableKey(
      edge.id,
      parsed.terms.length === 1 ? fieldId : `${fieldId}_${index + 1}`
    );
    const fdVarValue = `${templateId}-${fieldId}`;
    const fieldLabel = field?.title || fieldId;
    const fieldType = formulaFieldType(field);
    return {
      variableKey,
      varConfig: {
        key: variableKey,
        resultType: { type: "boolean" },
        type: "Eval",
        value: `\${data.${fdVarValue}} ${term.operator} ${JSON.stringify(term.value)}`
      },
      rule: {
        fdKey: variableKey,
        metaType: "RULE",
        parentKey: groupKey,
        parentLeavel: "1-1",
        leavel: "3",
        fdVarValue,
        fdDataType: fieldType,
        fdLabel: `$${fieldLabel}$`,
        vo: formulaFieldVo(field, fieldType),
        fdSymbol: term.operator,
        fdValue: term.value
      }
    };
  });

  if (terms.some((term) => !term)) return undefined;

  return {
    result: {
      resultType: { type: "boolean" },
      type: "Eval",
      value: `(${terms.map((term) => `\${data.$VAR.${term.variableKey}}`).join(` ${parsed.operator} `)})`
    },
    type: "Batch",
    vars: terms.map((term) => term.varConfig),
    vo: {
      mode: "simple",
      modeType: "simpleRule",
      data: {
        key: "ROOT",
        fdKey: rootKey,
        leavel: "1",
        fdList: [{
          fdKey: groupKey,
          fdType: parsed.groupType,
          leavel: "1",
          parentLeavel: "1-1",
          parentKey: rootKey,
          metaType: "GROUP",
          fdList: terms.map((term) => term.rule)
        }]
      }
    }
  };
}

function parseEqualityConditionExpression(condition) {
  const text = String(condition || "").trim();
  if (!text) return undefined;

  const orParts = splitLogicalExpression(text, "||");
  if (orParts.length > 1) {
    const terms = orParts.map(parseSimpleEqualityCondition);
    if (terms.every(Boolean)) return { terms, operator: "||", groupType: "OR" };
    return undefined;
  }

  const parsed = parseSimpleEqualityCondition(text);
  return parsed ? { terms: [parsed], operator: "||", groupType: "OR" } : undefined;
}

function parseSimpleEqualityCondition(condition) {
  const text = String(condition || "").trim();
  if (!text) return undefined;

  const legacyEquals = text.match(/^["']([^"']*)["']\s*\.\s*equals\s*\(\s*\$([^$]+)\$\s*\)$/);
  if (legacyEquals) {
    return { value: legacyEquals[1], field: legacyEquals[2].trim(), operator: "==" };
  }

  const fieldMethodEquals = text.match(/^\$([^$]+)\$\s*\.\s*equals\s*\(\s*["']([^"']*)["']\s*\)$/);
  if (fieldMethodEquals) {
    return { field: fieldMethodEquals[1].trim(), value: fieldMethodEquals[2], operator: "==" };
  }

  const fieldLeftEquals = text.match(/^\$([^$]+)\$\s*={2,3}\s*["']([^"']*)["']$/);
  if (fieldLeftEquals) {
    return { field: fieldLeftEquals[1].trim(), value: fieldLeftEquals[2], operator: "==" };
  }

  const valueLeftEquals = text.match(/^["']([^"']*)["']\s*={2,3}\s*\$([^$]+)\$$/);
  if (valueLeftEquals) {
    return { value: valueLeftEquals[1], field: valueLeftEquals[2].trim(), operator: "==" };
  }

  return undefined;
}

function splitLogicalExpression(text, operator) {
  const parts = [];
  let quote = "";
  let depth = 0;
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const previous = text[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && text.startsWith(operator, index)) {
      parts.push(text.slice(start, index).trim());
      index += operator.length - 1;
      start = index + 1;
    }
  }

  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function buildFormFieldIndex(form = {}) {
  const byId = new Map();
  for (const field of form.fields || []) {
    if (field?.id) byId.set(field.id, field);
    for (const column of field?.columns || []) {
      if (column?.id) byId.set(column.id, column);
    }
  }
  return byId;
}

function buildFormFieldTitleIndex(form = {}) {
  const byTitle = new Map();
  for (const field of form.fields || []) {
    addFormFieldTitle(byTitle, field);
    for (const column of field?.columns || []) addFormFieldTitle(byTitle, column);
  }
  return byTitle;
}

function addFormFieldTitle(byTitle, field) {
  const title = normalizeBranchFieldName(field?.title);
  if (!title) return;
  if (!byTitle.has(title)) byTitle.set(title, []);
  byTitle.get(title).push(field);
}

function normalizeBranchFieldName(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function formulaVariableKey(edgeId, value) {
  const key = `${edgeId}_${value}`.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
  return /^[A-Za-z_]/.test(key) ? key : `v_${key}`;
}

function formulaFieldType(field) {
  const type = String(field?.type || "").toLowerCase();
  if (["number", "decimal", "double", "currency", "integer"].includes(type)) return "number";
  if (type.includes("date")) return "date";
  if (type.includes("boolean")) return "boolean";
  return "string";
}

function formulaFieldVo(field, fieldType) {
  if (fieldType === "number") {
    return {
      type: "number",
      required: Boolean(field?.props?.required),
      description: field?.title || field?.id || ""
    };
  }

  if (fieldType === "date") {
    return {
      type: "date",
      required: Boolean(field?.props?.required),
      description: field?.title || field?.id || ""
    };
  }

  if (fieldType === "boolean") {
    return {
      type: "boolean",
      required: Boolean(field?.props?.required),
      description: field?.title || field?.id || ""
    };
  }

  return {
    type: "string",
    required: Boolean(field?.props?.required),
    description: field?.title || field?.id || "",
    maxLength: normalizeMaxLength(field?.props?.maxLength) || 200
  };
}

function normalizeMaxLength(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : undefined;
  const text = String(value).trim();
  if (!text || !/^\d+$/.test(text)) return undefined;
  const length = Number(text);
  return Number.isSafeInteger(length) && length > 0 ? length : undefined;
}

function boundsFor(node, index, width, height) {
  const attrs = sourceAttributes(node);
  return {
    x: parseNumber(attrs.x, 400),
    y: parseNumber(attrs.y, 100 + index * 90),
    width,
    height,
    relative: false,
    TRANSLATE_CONTROL_POINTS: true,
    alternateBounds: null,
    sourcePoint: null,
    targetPoint: null,
    points: null,
    offset: null
  };
}

function handlersFromAttributes(attrs) {
  return {
    id: "handlers",
    type: "org",
    source: "1",
    ruleKey: "",
    ruleName: "",
    members: splitHandlers(attrs.handlerIds, attrs.handlerNames),
    element: "users"
  };
}

function handlersFromParticipants(participants, attrs, context = {}) {
  if (participants?.mode === "explicit" && Array.isArray(participants.members)) {
    return {
      id: "handlers",
      type: "org",
      source: "1",
      ruleKey: "",
      ruleName: "",
      members: participants.members.map((member) => ({
        id: member.id,
        name: member.name || member.id,
        element: member.element || "user",
        type: member.type === "dept" ? "2" : "1"
      })),
      element: "users"
    };
  }
  if (participants?.mode === "form_field") {
    const ruleKey = formFieldHandlerRuleKey(participants, context);
    return {
      id: "handlers",
      type: "formula",
      source: "2",
      ruleKey,
      ruleName: ruleKey.formulaName,
      ruleMode: "simple",
      formulaType: "formula",
      members: [],
      element: "users",
      migrationSource: {
        sourceExpression: participants.sourceExpression || "",
        sourceNameExpression: participants.sourceNameExpression || ""
      }
    };
  }
  if (participants?.mode === "role_line") {
    const ruleKey = roleLineHandlerRuleKey(participants, context);
    return {
      id: "handlers",
      type: "formula",
      source: "2",
      ruleKey,
      ruleName: ruleKey.formulaName,
      ruleMode: "simple",
      formulaType: "formula",
      members: [],
      element: "users",
      migrationSource: {
        sourceExpression: participants.sourceExpression || "",
        sourceNameExpression: participants.sourceNameExpression || "",
        companyRole: participants.companyRole || "",
        departmentRole: participants.departmentRole || ""
      }
    };
  }
  if (participants?.mode === "initiator_select") {
    return {
      id: "handlers",
      type: "org",
      source: "drafter",
      ruleKey: "initiator_select",
      ruleName: "发起人选择",
      members: [],
      element: "users"
    };
  }
  return handlersFromAttributes(attrs);
}

function roleLineHandlerRuleKey(participants, context = {}) {
  const fieldId = participants.fieldId || "";
  const field = context.formFieldById?.get(fieldId);
  const fdVarValue = context.templateId ? `${context.templateId}-${fieldId}` : fieldId;
  const fieldTitle = participants.fieldTitle || field?.title || fieldId;
  const formulaName = participants.sourceNameExpression ||
    `$组织架构.解释角色线$($${fieldTitle}$, ${JSON.stringify(participants.companyRole || "")}, ${JSON.stringify(participants.departmentRole || "")})`;
  const fieldRef = `\${data.${fdVarValue}}`;

  return {
    type: "Eval",
    script: `$组织架构.解释角色线$(${fieldRef}, ${JSON.stringify(participants.companyRole || "")}, ${JSON.stringify(participants.departmentRole || "")})`,
    varIds: [fdVarValue],
    vo: {
      mode: "formula",
      content: formulaName
    },
    mode: "simple",
    formulaName
  };
}

function formFieldHandlerRuleKey(participants, context = {}) {
  const fieldId = participants.fieldId || "";
  const field = context.formFieldById?.get(fieldId);
  const fdVarValue = context.templateId ? `${context.templateId}-${fieldId}` : fieldId;
  const formulaName = participants.sourceNameExpression || `$${participants.fieldTitle || field?.title || fieldId}$`;

  return {
    type: "Eval",
    script: `\${data.${fdVarValue}}`,
    varIds: [fdVarValue],
    vo: {
      mode: "formula",
      content: formulaName
    },
    mode: "simple",
    formulaName
  };
}

function splitHandlers(handlerIds = "", handlerNames = "") {
  const ids = String(handlerIds || "").split(";").map((value) => value.trim()).filter(Boolean);
  const names = String(handlerNames || "").split(";").map((value) => value.trim());
  if (ids.some((id) => id.startsWith("$"))) return [];
  return ids.map((id, index) => ({
    id,
    name: names[index] || id,
    element: "user",
    type: "1"
  }));
}

function commentAuthority() {
  return {
    viewCommentNodes: "",
    viewCommentType: "all",
    viewCommentUsers: {
      id: "viewCommentUsers",
      type: "org",
      source: "1",
      ruleKey: "",
      ruleName: "",
      element: "users",
      members: []
    }
  };
}

function groupEdgesBySource(edges) {
  const grouped = new Map();
  for (const edge of edges) {
    if (!grouped.has(edge.source)) grouped.set(edge.source, []);
    grouped.get(edge.source).push(edge);
  }
  return grouped;
}

function sourceAttributes(node) {
  return {
    ...(node?.attributes || {}),
    ...(node?.definition?.attributes || {})
  };
}

function singleRelatedNodeId(attrs) {
  const ids = splitRelatedNodeIds(attrs.relatedNodeIds || attrs.relateId);
  return ids.length === 1 ? ids[0] : "";
}

function splitRelatedNodeIds(value = "") {
  return String(value || "").split(/[;,，\s]+/).map((item) => item.trim()).filter(Boolean);
}

function migrationNodeSource(node) {
  return {
    id: node.id,
    type: node.sourceType || node.type,
    targetType: node.type,
    sourceRef: node.sourceRef || "",
    name: node.name || "",
    attributes: node.attributes || {},
    definition: summarizeDefinition(node.definition),
    sourceXml: node.sourceXml || ""
  };
}

function parseWayPoints(value) {
  if (!value) return [];
  return String(value).split(";")
    .map((pair) => pair.split(",").map((part) => Number.parseFloat(part.trim())))
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    .map(([x, y]) => ({ x, y }));
}

function parseNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSameIdentity(value) {
  if (value === "false") return "1";
  return "2";
}

function hasEdgeCondition(edge) {
  return Boolean(edge.formula || edge.condition || edge.displayCondition || edge.formulaName);
}

function edgeConditionText(edge) {
  if (edge?.condition && typeof edge.condition === "object") {
    return edge.condition.targetText || edge.condition.sourceText || edge.condition.displayText || "";
  }
  return edge?.condition || edge?.displayCondition || "";
}

function summarizeDefinition(definition) {
  if (!definition) return undefined;
  return {
    type: definition.type,
    attributes: definition.attributes || {}
  };
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}
