import {
  edgeConditionText as sharedEdgeConditionText,
  isExplicitDefaultEdge,
  isNamedOtherEdge,
  isTautologyCondition as sharedIsTautologyCondition,
  selectDefaultBranchEdge
} from "./branch-defaults.js";
import { isAddressField } from "../condition-org-resolver.js";

export function applyWorkflowPayload(template, dsl) {
  if (!dsl.workflow) return template;

  const next = clone(template);
  next.mechanisms = next.mechanisms || {};
  next.mechanisms.lbpmTemplate = Array.isArray(next.mechanisms.lbpmTemplate)
    ? next.mechanisms.lbpmTemplate
    : [{}];

  const lbpm = next.mechanisms.lbpmTemplate[0] || {};
  next.mechanisms.lbpmTemplate[0] = lbpm;
  lbpm.fdContentType ||= "json";
  lbpm.fdSystemCode ||= "INNER_SYSTEM";
  lbpm.fdRunType ??= "1";
  lbpm.fdDisableBpmInit ??= false;
  if (!lbpm.fdFormCategory && next.fdCategory?.fdId) {
    lbpm.fdFormCategory = { fdFormCategoryId: next.fdCategory.fdId };
  }
  lbpm.fdContent = JSON.stringify(buildWorkflowContent(dsl.workflow, {
    templateId: next.fdId || next.mechanisms["sys-xform"]?.fdId || "",
    form: dsl.form,
    conditionOrgByName: dsl.runtime?.conditionOrgByName || {}
  }));
  lbpm.fdStatus = "draft";
  lbpm.fdPublishType ||= "instant";
  lbpm.isDraft = true;
  lbpm.fdReaders = next.fdReaders || lbpm.fdReaders || [];
  lbpm.fdEditors = next.fdEditors || lbpm.fdEditors || [];
  const templateFormAuths = buildTemplateFormAuths(dsl.workflow);
  if (Object.keys(templateFormAuths).length) {
    lbpm.fdTemplateFormAuths = templateFormAuths;
  }

  return next;
}

const WORKFLOW_DRAFT_FIELDS = Object.freeze([
  "fdId",
  "fdName",
  "dynamicProps",
  "fdTemplateCode",
  "fdCategory",
  "fdLabelContent",
  "fdNotifyCategoryCode",
  "fdDesc",
  "fdOrder",
  "fdEditors",
  "fdReaders",
  "fdEnable",
  "fdPcEnable",
  "fdEntityId",
  "fdEntityKey",
  "fdEntityName",
  "fdContentType",
  "fdSystemCode",
  "fdRunType",
  "fdDisableBpmInit",
  "fdFormCategory",
  "fdMobileEnable",
  "fdMessageNotifyType",
  "summaryFields",
  "scheduleStrategy",
  "fdTemplateTip",
  "fdDirectorList",
  "fdTempVariables",
  "fdTempVariableMappings",
  "businessMethodList",
  "fdTemplateForms",
  "events",
  "operSubmitValidators",
  "aiCheckConfig",
  "fdIntelliApprovalRuleList",
  "signalCatchers",
  "fdReviewMailContent",
  "fdAllowInit",
  "fdTemplateFormAuths",
  "fdTimeoutStrategiesOfNode",
  "fdTimeoutStrategiesOfProcess",
  "fdFlowType",
  "notifyDrafterOnEnd",
  "notifyDrafterOnException",
  "notifyAdminOnException",
  "notifyCurrentHandlerOnDraftRetract",
  "notifyParticipantOnEnd",
  "maxTransferTimes",
  "fdCommonId",
  "fdCommonSubject",
  "privilegeData",
  "adminFormAuth",
  "identityRepeatSkipType",
  "operatorBackList",
  "operatorScope",
  "processEndIsCirculated",
  "rejectDenyRetract",
  "canCirculationIdentity",
  "expandPostToPerson",
  "circulationScope",
  "urgeCoolingTimeLimit",
  "fdHighLights",
  "groupChat",
  "triggerBpmnNodeIds",
  "fdDetailsSystemCode",
  "fdModuleCode",
  "fdUseModuleDefault",
  "fdModuleTempId",
  "fdMainEntityName",
  "dataAuths",
  "extra",
  "fdContent"
]);

const WORKFLOW_CONTENT_BACKED_DRAFT_FIELDS = Object.freeze([
  ["events", "events"],
  ["operSubmitValidators", "operSubmitValidators"],
  ["aiCheckConfig", "aiCheckConfig"],
  ["signalCatchers", "signalCatchers"],
  ["notifyDrafterOnEnd", "notifyDrafterOnEnd"],
  ["notifyParticipantOnEnd", "notifyParticipantOnEnd"],
  ["notifyDrafterOnException", "notifyDrafterOnException"],
  ["notifyAdminOnException", "notifyAdminOnException"],
  ["notifyCurrentHandlerOnDraftRetract", "notifyCurrentHandlerOnDraftRetract"],
  ["adminFormAuth", "adminFormAuth"],
  ["processEndIsCirculated", "processEndIsCirculated"],
  ["rejectDenyRetract", "rejectDenyRetract"],
  ["canCirculationIdentity", "canCirculationIdentity"],
  ["fdHighLights", "fdHighLights"],
  ["groupChat", "groupChat"],
  ["fdFlowType", "flowType"]
]);

export function buildWorkflowDraftPayload(template) {
  const lbpm = clone(template?.mechanisms?.lbpmTemplate?.[0]);
  if (!nonEmptyString(lbpm.fdId)) {
    throw workflowDraftError("Workflow draft save requires the LBPM mechanism fdId.");
  }
  if (!nonEmptyString(lbpm.fdContent)) {
    throw workflowDraftError("Workflow draft save requires serialized designer content.");
  }

  const payload = {};
  for (const key of WORKFLOW_DRAFT_FIELDS) {
    if (lbpm[key] !== undefined) payload[key] = lbpm[key];
  }
  const content = parseJsonObject(lbpm.fdContent);
  for (const [payloadKey, contentKey] of WORKFLOW_CONTENT_BACKED_DRAFT_FIELDS) {
    if (payload[payloadKey] === undefined && content[contentKey] !== undefined) {
      payload[payloadKey] = content[contentKey];
    }
  }
  payload.isDraft = true;
  return payload;
}

export function buildWorkflowContent(workflow, context = {}) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  const outgoingEdges = groupEdgesBySource(edges);
  const workflowContext = {
    ...context,
    formFieldById: context.formFieldById || buildFormFieldIndex(context.form),
    formFieldsByTitle: context.formFieldsByTitle || buildFormFieldTitleIndex(context.form),
    initiatorSelectTargetNodeIds: collectInitiatorSelectTargetNodeIds(nodes),
    canModifyHandlerTargetNodeIds: collectCanModifyHandlerTargetNodeIds(nodes)
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
    initiatorSelectNodeIds: [...collectPersistedInitiatorSelectTargetNodeIds(nodes)].sort(),
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
    initiatorSelectNodeIds: [...collectInitiatorSelectTargetNodeIds(nodes)].sort(),
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

function buildTemplateFormAuths(workflow = {}) {
  const auths = {};
  for (const node of workflow.nodes || []) {
    if (!hasDataAuthority(node)) continue;
    auths[node.id] = Object.fromEntries(
      Object.entries(node.dataAuthority.fields || {}).map(([fieldId, value]) => [fieldId, {
        isShow: Boolean(value.visible),
        isEdit: Boolean(value.editable),
        isRequire: Boolean(value.required)
      }])
    );
  }
  return auths;
}

function hasDataAuthority(node) {
  return Boolean(
    node?.dataAuthority?.enabled !== false &&
      Object.keys(node?.dataAuthority?.fields || {}).length
  );
}

const EXECUTABLE_NODE_TYPES = new Set([
  "generalStart",
  "generalEnd",
  "draft",
  "review",
  "send",
  "robot",
  "conditionBranch",
  "split",
  "join"
]);

export function workflowMappingDiagnostics(workflow) {
  const diagnostics = [];
  for (const node of workflow?.nodes || []) {
    if (EXECUTABLE_NODE_TYPES.has(node.type)) continue;
    diagnostics.push({
      level: "error",
      code: "projection.workflow.node_type_unsupported",
      message: `Workflow node ${node.id} has unsupported type ${node.type}; Executor does not heuristically remap node types.`,
      path: "/workflow/nodes",
      details: {
        nodeId: node.id,
        sourceType: node.type
      }
    });
  }
  return diagnostics;
}

function mapNodeType(type = "") {
  if (!EXECUTABLE_NODE_TYPES.has(type)) {
    const error = new Error(`Unsupported workflow node type for projection: ${type}`);
    error.code = "projection.workflow.node_type_unsupported";
    error.details = { type };
    throw error;
  }
  return type;
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
  return {
    ...baseNode(node, index, "draft", "manualTask", 160, 40),
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
  const isSend = type === "send";
  return {
    ...baseNode(node, 0, type, "manualTask", 160, 40),
    name,
    required: true,
    emptyHandlerType: resolveEmptyHandlerType(node, attrs, context),
    formKey: "default",
    operationRefId: "default",
    openModifyProcessAuthority: "true",
    openNodeAuthority: "true",
    modifyProcessAuthority: isSend ? "0" : "1",
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
    ignoreOnSameIdentity: resolveIgnoreOnSameIdentity(node, attrs),
    handlerIds: nativeHandlerIds(node.participants, attrs),
    handlerNames: nativeHandlerNames(node.participants, attrs),
    handlerSelectType: node.participants?.mode === "form_field" || node.participants?.mode === "role_line"
      ? "formula"
      : attrs.handlerSelectType,
    recalculateHandler: attrs.recalculateHandler,
    nodeNotifyTypeMethod: [],
    handlers: handlersFromParticipants(node.participants, attrs, {
      ...context,
      initiatorSelectTarget: context.initiatorSelectTargetNodeIds?.has(node.id) === true
    }),
    ...alternativeHandlerFields(node.participants),
    ...(isSend ? { systemNotifyType: "2" } : {}),
    fdScene: { fdMode: 0 },
    language: { nameCn: name, nameUs: isSend ? "CC node" : "Approval Node" },
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
    robotType: robotTypeFromAttributes(attrs, node),
    robotConfig: robotConfigFromAttributes(attrs),
    events: [],
    language: { nameCn: node.name || "机器人节点", nameUs: "Robot Node" }
  };
}

function robotTypeFromAttributes(attrs, node) {
  if (attrs.robotType && typeof attrs.robotType === "object" && !Array.isArray(attrs.robotType)) {
    return attrs.robotType;
  }

  const sourceUnid = normalizeText(attrs.unid);
  const key = legacyRobotKey(sourceUnid) || normalizeText(attrs.robotKey) || "legacyRobot";
  const name = normalizeText(attrs.robotName) || normalizeText(attrs.name) || node.name || key;
  const robotType = {
    key,
    name,
    controlId: "LBPMExtendComponent"
  };

  if (sourceUnid) {
    robotType.sourceUnid = sourceUnid;
    robotType.unid = sourceUnid;
  }

  return robotType;
}

function robotConfigFromAttributes(attrs) {
  const content = normalizeText(attrs.content);
  return content || "{}";
}

function legacyRobotKey(sourceUnid) {
  const match = sourceUnid.match(/@Robot@(.+)$/);
  return match ? match[1] : sourceUnid;
}

function isManualConditionBranch(node) {
  return String(node?.sourceType || "").toLowerCase().includes("manualbranch");
}

function buildConditionBranchNode(node, routes) {
  const attrs = sourceAttributes(node);
  const defaultRoute = routes.find((route) => route.defaultTrend);
  const manual = isManualConditionBranch(node) || routes.some((route) => route.manual);
  const displayName = node.name || attrs.name || (manual ? "人工决策" : "条件分支");
  const element = {
    ...baseNode(node, 0, "conditionBranch", "exclusiveGateway", 34, 34),
    conditionType: manual ? "2" : "1",
    simpleName: displayName,
    number: node.id,
    relateId: node.id,
    scope: "branch",
    operations: [],
    language: { nameCn: displayName, nameUs: manual ? "Manual Decision" : "Conditional Branch" }
  };
  if (routes.length) {
    element.resultSetMapping = JSON.stringify(routes.map((route) => ({
      id: route.lineId,
      resultCode: route.resultCode || route.lineName || route.lineId
    })));
    if (defaultRoute) {
      element.default = defaultRoute.lineId;
      element.conditionId = defaultRoute.lineId;
    }
    element.conditionValue = JSON.stringify(
      manual
        ? {
          rules: routes.map((route) => route.conditionValue),
          ruleConfig: buildManualBranchRuleConfig(node, routes)
        }
        : {
          formulas: routes.map((route) => route.conditionValue)
        }
    );
  }
  return element;
}

function buildManualBranchRuleConfig(node, routes) {
  const firstRoute = routes[0];
  const routeValue = firstRoute?.resultCode || firstRoute?.lineName || node?.id || "manualBranch";
  return {
    vo: { mode: "rule" },
    type: "Batch",
    vars: [],
    result: {
      vo: {
        fdDataType: "any",
        fdType: "any",
        enableArray: false,
        fdValueType: "Var",
        fdValue: routeValue
      },
      type: "Var",
      value: routeValue,
      resultType: { type: "any" }
    }
  };
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
  const attrs = sourceAttributes(node);
  const mustModifyHandlerNodes = normalizeRelatedNodeIds(attrs.mustModifyHandlerNodeIds);
  const canModifyHandlerNodes = normalizeRelatedNodeIds(attrs.canModifyHandlerNodeIds);
  return {
    type,
    id: node.id,
    element,
    name,
    bounds: boundsFor(node, index, width, height),
    openDataAuthority: hasDataAuthority(node),
    operations: [],
    timeoutStrategies: "[]",
    config: "{}",
    componentOriginalValue: "{}",
    migrationSource: migrationNodeSource(node),
    ...(mustModifyHandlerNodes ? { mustModifyHandlerNodes } : {}),
    ...(canModifyHandlerNodes ? { canModifyHandlerNodes } : {})
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
    const ruleText = branchRoute.manual
      ? (displayText || branchRoute.resultCode || branchRoute.lineName || edge.name || "")
      : (displayText || branchRoute.resultCode || "");
    const rulePayload = branchRoute.manual
      ? ruleText
      : (branchRoute.resultCode || "");
    element.priority = branchRoute.priority;
    element.formulaName = hasFormulaConfig ? "" : ruleText;
    element.formulaType = hasFormulaConfig ? "formula" : rulePayload ? "rule" : "formula";
    element.defaultTrend = branchRoute.defaultTrend;
    element.language = { nameCn: edge.name || "" };
    element.formula = hasFormulaConfig ? JSON.stringify(branchRoute.formulaConfig) : rulePayload;
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

    const sourceEdges = (outgoingEdges.get(node.id) || [])
      .filter((edge) => edgeConditionText(edge) || edge.name || isExplicitDefaultRoute(edge));
    const routes = sourceEdges.map((edge, index) => buildBranchRoute(node, edge, index, context, sourceEdges));
    const defaultEdge = selectDefaultBranchEdge(sourceEdges);
    const defaultRoute = defaultEdge
      ? routes.find((route) => route.lineId === defaultEdge.id)
      : undefined;
    if (defaultRoute) defaultRoute.defaultTrend = true;
    for (const route of routes) {
      route.conditionValue.defaultTrend = route.defaultTrend;
      byEdge.set(route.lineId, route);
    }
    bySource.set(node.id, routes);
  }

  return { bySource, byEdge };
}

function buildBranchRoute(node, edge, index, context, siblingEdges = []) {
  const manual = isManualConditionBranch(node);
  const conditionText = edgeConditionText(edge);
  const lineName = edge.name || edge.id;
  const resultCode = manual
    ? (conditionText || lineName)
    : conditionText;
  const explicitDefault = isExplicitDefaultRoute(edge);
  const namedOther = isOtherRoute(edge);
  const tautologicalDefault = isTautologyCondition(conditionText);
  const parsedFormula = manual ? undefined : buildFormulaDesignerConfig(edge, context);
  const needsSyntheticDefaultFormula = !manual && !parsedFormula && (
    tautologicalDefault || (namedOther && !String(conditionText || "").trim())
  );
  const formulaConfig = parsedFormula ||
    (needsSyntheticDefaultFormula
      ? buildOtherDefaultFormulaDesignerConfig(node, edge, context, siblingEdges)
      : undefined);
  const conditionValue = manual
    ? {
      lineId: edge.id,
      lineName,
      priority: parseInteger(edge.priority || edge.attributes?.priority, index + 1),
      formula: resultCode,
      formulaName: edge.condition?.displayText || edge.displayCondition || resultCode,
      formulaType: "rule",
      mode: "simple",
      defaultTrend: false,
      type: "rules"
    }
    : {
      lineId: edge.id,
      lineName,
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
    lineName,
    priority: conditionValue.priority,
    resultCode,
    formulaConfig,
    manual,
    defaultTrend: false,
    explicitDefault,
    namedOther,
    tautologicalDefault,
    conditionValue
  };
}

function buildOtherDefaultFormulaDesignerConfig(node, edge, context, siblingEdges = []) {
  const field = branchFieldForOtherRoute(node, edge, siblingEdges, context);
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

function isOtherRoute(edge) {
  return isNamedOtherEdge(edge);
}

function isExplicitDefaultRoute(edge) {
  return isExplicitDefaultEdge(edge);
}

function isTautologyCondition(condition) {
  return sharedIsTautologyCondition(condition);
}

function edgeConditionText(edge) {
  return sharedEdgeConditionText(edge);
}

function branchFieldForOtherRoute(node, edge, siblingEdges, context) {
  const direct = branchFieldForNode(node, context);
  if (direct) return direct;

  const keys = new Set();
  for (const sibling of siblingEdges || []) {
    if (!sibling || sibling.id === edge.id || isOtherRoute(sibling)) continue;
    for (const key of collectConditionFieldKeys(edgeConditionText(sibling))) {
      keys.add(key);
    }
  }

  const resolved = [];
  for (const key of keys) {
    const byId = context.formFieldById?.get(key);
    if (byId) {
      resolved.push(byId);
      continue;
    }
    const byTitle = context.formFieldsByTitle?.get(normalizeBranchFieldName(key)) || [];
    if (byTitle.length === 1) resolved.push(byTitle[0]);
  }
  const unique = [...new Map(resolved.map((field) => [field.id, field])).values()];
  // A defaultTrend route still needs one native Batch field binding for the
  // NewOA formula designer. The binding is structural; default ownership, not
  // this placeholder predicate, decides the fallback route at runtime.
  return unique[0];
}

function collectConditionFieldKeys(condition) {
  const keys = new Set();
  for (const match of String(condition || "").matchAll(/\$([^$]+)\$/g)) {
    const key = String(match[1] || "").trim();
    if (!key || key.includes(".")) continue;
    keys.add(key);
  }
  return keys;
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
  const parsedAst = parseConditionExpression(edgeConditionText(edge));
  if (!parsedAst) return undefined;

  const templateId = context.templateId || "";
  const rootKey = formulaVariableKey(edge.id, "ROOT");
  if (!templateId) return undefined;

  const sourceTerms = collectConditionTerms(parsedAst);
  const terms = sourceTerms.map((term, index) => {
    const field = context.formFieldById?.get(term.field);
    const upgraded = upgradeAddressConditionTerm(term, field, context);
    const fieldId = field?.id || upgraded.field;
    if (!fieldId) return undefined;
    const variableKey = formulaVariableKey(
      edge.id,
      sourceTerms.length === 1 ? fieldId : `${fieldId}_${index + 1}`
    );
    const fdVarValue = `${templateId}-${fieldId}`;
    const fieldLabel = field?.title || fieldId;
    const fieldType = formulaFieldType(field, upgraded);
    const rule = {
      fdKey: variableKey,
      metaType: "RULE",
      fdVarValue,
      fdDataType: fieldType,
      fdLabel: `$${fieldLabel}$`,
      vo: formulaFieldVo(field, fieldType),
      fdSymbol: upgraded.symbol
    };
    if (upgraded.value !== undefined && upgraded.expressionType !== "orgBelong") {
      // NewOA simple-rule UI stores numeric relational thresholds as JSON numbers.
      rule.fdValue = formulaRuleValue(upgraded, fieldType);
    }
    if (upgraded.expressionType === "orgBelong") {
      rule.fdValue = JSON.stringify(upgraded.orgValue || []);
      rule.fdFunctionId = upgraded.functionId;
      rule.fdSymbolAndOrgType = `${upgraded.symbol}.${upgraded.orgTypeKey}.${upgraded.through ? "true" : "false"}`;
      rule.fdOrgType = upgraded.fdOrgType;
      rule.fdThrough = upgraded.through ? "true" : "false";
    } else if (upgraded.functionId) {
      rule.fdFunctionId = upgraded.functionId;
    }

    return {
      variableKey,
      negateResult: Boolean(upgraded.negateResult),
      varConfig: termVarConfig(upgraded, variableKey, fdVarValue),
      rule
    };
  });

  if (terms.some((term) => !term)) return undefined;
  const conditionAst = attachConditionTerms(parsedAst, terms);

  return {
    result: {
      resultType: { type: "boolean" },
      type: "Eval",
      value: conditionResultExpression(conditionAst)
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
        fdList: [conditionVoGroup(conditionAst, {
          edgeId: edge.id,
          parentKey: rootKey,
          parentLeavel: "1-1",
          groupPath: "",
          level: 1
        })]
      }
    }
  };
}

function upgradeAddressConditionTerm(term, field, context) {
  if (!term || term.expressionType !== "contains" || !isAddressField(field)) return term;
  const org = lookupConditionOrg(context, term.value);
  if (!org) return term;

  const negated = Boolean(term.negateResult);
  return {
    ...term,
    expressionType: "orgBelong",
    symbol: negated ? "notbelong" : "belongany",
    functionId: "sysorg.isOrganizationBelongOrIncludeAnother",
    orgValue: [org],
    orgTypeKey: "ORG_DEPT",
    fdOrgType: 3,
    through: true,
    relationType: 4,
    negateResult: negated
  };
}

function lookupConditionOrg(context, name) {
  const key = String(name || "");
  if (!key) return undefined;
  const byName = context.conditionOrgByName || {};
  const hit = byName instanceof Map ? byName.get(key) : byName[key];
  if (!hit || typeof hit !== "object" || !hit.fdId || !hit.fdName) return undefined;
  return {
    fdId: String(hit.fdId),
    fdName: String(hit.fdName),
    fdOrgType: Number(hit.fdOrgType) || 2,
    ...(hit.fdNo ? { fdNo: String(hit.fdNo) } : {})
  };
}

function parseConditionExpression(condition) {
  const text = stripEnclosingParentheses(String(condition || "").trim());
  if (!text) return undefined;

  const negatedGroup = parseNegatedGroup(text);
  if (negatedGroup) return negatedGroup;

  const orParts = splitLogicalExpression(text, "||");
  if (orParts.length > 1) {
    const children = orParts.map(parseConditionExpression);
    if (children.every(Boolean)) return { type: "group", children, operator: "||", groupType: "OR" };
    return undefined;
  }

  const andParts = splitLogicalExpression(text, "&&");
  if (andParts.length > 1) {
    const children = andParts.map(parseConditionExpression);
    if (children.every(Boolean)) return { type: "group", children, operator: "&&", groupType: "AND" };
    return undefined;
  }

  const parsed = parseSimpleCondition(text);
  return parsed ? { type: "term", term: parsed } : undefined;
}

function parseSimpleCondition(condition) {
  const text = String(condition || "").trim();
  if (!text) return undefined;

  const contains = text.match(/^(!\s*)?\$(?:字符串|列表)\.包含\$\(\s*\$([^$]+)\$\s*,\s*(["'])([\s\S]*?)\3\s*\)$/);
  if (contains) {
    const negated = Boolean(contains[1]);
    return {
      field: contains[2].trim(),
      value: contains[4],
      symbol: negated ? "notcontain" : "contain",
      expressionType: "contains",
      functionId: "global.contains",
      negateResult: negated
    };
  }

  const legacyEquals = text.match(/^["']([^"']*)["']\s*\.\s*equals\s*\(\s*\$([^$]+)\$\s*\)$/);
  if (legacyEquals) {
    return { value: legacyEquals[1], field: legacyEquals[2].trim(), symbol: "==", expressionType: "==" };
  }

  const fieldMethodEquals = text.match(/^\$([^$]+)\$\s*\.\s*equals\s*\(\s*["']([^"']*)["']\s*\)$/);
  if (fieldMethodEquals) {
    return { field: fieldMethodEquals[1].trim(), value: fieldMethodEquals[2], symbol: "==", expressionType: "==" };
  }

  const fieldLeftEquals = text.match(/^\$([^$]+)\$\s*={2,3}\s*["']([^"']*)["']$/);
  if (fieldLeftEquals) {
    return { field: fieldLeftEquals[1].trim(), value: fieldLeftEquals[2], symbol: "==", expressionType: "==" };
  }

  const fieldLeftNotEquals = text.match(/^\$([^$]+)\$\s*!={1,2}\s*["']([^"']*)["']$/);
  if (fieldLeftNotEquals) {
    return {
      field: fieldLeftNotEquals[1].trim(),
      value: fieldLeftNotEquals[2],
      symbol: "!=",
      expressionType: "!="
    };
  }

  const valueLeftEquals = text.match(/^["']([^"']*)["']\s*={2,3}\s*\$([^$]+)\$$/);
  if (valueLeftEquals) {
    return { value: valueLeftEquals[1], field: valueLeftEquals[2].trim(), symbol: "==", expressionType: "==" };
  }

  const valueLeftNotEquals = text.match(/^["']([^"']*)["']\s*!={1,2}\s*\$([^$]+)\$$/);
  if (valueLeftNotEquals) {
    return {
      value: valueLeftNotEquals[1],
      field: valueLeftNotEquals[2].trim(),
      symbol: "!=",
      expressionType: "!="
    };
  }

  // Unquoted numeric literals from EKP (e.g. $fd_way$ == 33). Keep the digits as a
  // string value so radio/option comparisons still emit == "33" in Batch formulas.
  const fieldLeftNumber = text.match(/^\$([^$]+)\$\s*={2,3}\s*(-?\d+(?:\.\d+)?)$/);
  if (fieldLeftNumber) {
    return {
      field: fieldLeftNumber[1].trim(),
      value: fieldLeftNumber[2],
      symbol: "==",
      expressionType: "=="
    };
  }

  const fieldLeftNotNumber = text.match(/^\$([^$]+)\$\s*!={1,2}\s*(-?\d+(?:\.\d+)?)$/);
  if (fieldLeftNotNumber) {
    return {
      field: fieldLeftNotNumber[1].trim(),
      value: fieldLeftNotNumber[2],
      symbol: "!=",
      expressionType: "!="
    };
  }

  const valueLeftNumber = text.match(/^(-?\d+(?:\.\d+)?)\s*={2,3}\s*\$([^$]+)\$$/);
  if (valueLeftNumber) {
    return {
      value: valueLeftNumber[1],
      field: valueLeftNumber[2].trim(),
      symbol: "==",
      expressionType: "=="
    };
  }

  const valueLeftNotNumber = text.match(/^(-?\d+(?:\.\d+)?)\s*!={1,2}\s*\$([^$]+)\$$/);
  if (valueLeftNotNumber) {
    return {
      value: valueLeftNotNumber[1],
      field: valueLeftNotNumber[2].trim(),
      symbol: "!=",
      expressionType: "!="
    };
  }

  // Numeric relational comparisons from EKP amount thresholds.
  const fieldLeftCompareNumber = text.match(/^\$([^$]+)\$\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (fieldLeftCompareNumber) {
    return {
      field: fieldLeftCompareNumber[1].trim(),
      value: fieldLeftCompareNumber[3],
      symbol: fieldLeftCompareNumber[2],
      expressionType: fieldLeftCompareNumber[2]
    };
  }

  const valueLeftCompareNumber = text.match(/^(-?\d+(?:\.\d+)?)\s*(>=|<=|>|<)\s*\$([^$]+)\$$/);
  if (valueLeftCompareNumber) {
    return {
      value: valueLeftCompareNumber[1],
      field: valueLeftCompareNumber[3].trim(),
      symbol: flipCompareSymbol(valueLeftCompareNumber[2]),
      expressionType: flipCompareSymbol(valueLeftCompareNumber[2])
    };
  }

  const emptyFunction = text.match(/^(!\s*)?\$字符串\.为空\$\(\s*\$([^$]+)\$\s*\)$/);
  if (emptyFunction) {
    const negated = Boolean(emptyFunction[1]);
    return {
      field: emptyFunction[2].trim(),
      symbol: negated ? "notempty" : "empty",
      expressionType: "empty",
      functionId: "global.isEmpty",
      negateResult: negated
    };
  }

  // EKP null/length idioms for non-empty checks, e.g. null!=$fd_x$ or $fd_x$.length()>0.
  const nullNotEqualsField = text.match(/^null\s*!=\s*\$([^$]+)\$$/i);
  if (nullNotEqualsField) {
    return {
      field: nullNotEqualsField[1].trim(),
      symbol: "notempty",
      expressionType: "empty",
      functionId: "global.isEmpty",
      negateResult: true
    };
  }
  const fieldNotEqualsNull = text.match(/^\$([^$]+)\$\s*!=\s*null$/i);
  if (fieldNotEqualsNull) {
    return {
      field: fieldNotEqualsNull[1].trim(),
      symbol: "notempty",
      expressionType: "empty",
      functionId: "global.isEmpty",
      negateResult: true
    };
  }
  const nullEqualsField = text.match(/^null\s*==\s*\$([^$]+)\$$/i);
  if (nullEqualsField) {
    return {
      field: nullEqualsField[1].trim(),
      symbol: "empty",
      expressionType: "empty",
      functionId: "global.isEmpty",
      negateResult: false
    };
  }
  const fieldEqualsNull = text.match(/^\$([^$]+)\$\s*==\s*null$/i);
  if (fieldEqualsNull) {
    return {
      field: fieldEqualsNull[1].trim(),
      symbol: "empty",
      expressionType: "empty",
      functionId: "global.isEmpty",
      negateResult: false
    };
  }
  const fieldLengthGreaterZero = text.match(/^\$([^$]+)\$\s*\.\s*length\s*\(\s*\)\s*>\s*0$/);
  if (fieldLengthGreaterZero) {
    return {
      field: fieldLengthGreaterZero[1].trim(),
      symbol: "notempty",
      expressionType: "empty",
      functionId: "global.isEmpty",
      negateResult: true
    };
  }
  const fieldLengthEqualsZero = text.match(/^\$([^$]+)\$\s*\.\s*length\s*\(\s*\)\s*={1,3}\s*0$/);
  if (fieldLengthEqualsZero) {
    return {
      field: fieldLengthEqualsZero[1].trim(),
      symbol: "empty",
      expressionType: "empty",
      functionId: "global.isEmpty",
      negateResult: false
    };
  }

  return undefined;
}

function flipCompareSymbol(symbol) {
  if (symbol === ">") return "<";
  if (symbol === "<") return ">";
  if (symbol === ">=") return "<=";
  if (symbol === "<=") return ">=";
  return symbol;
}

function parseNegatedGroup(text) {
  if (!text.startsWith("!")) return undefined;
  const rest = text.slice(1).trim();
  if (!isFullyWrappedInParentheses(rest)) return undefined;
  const parsed = parseConditionExpression(rest);
  return parsed ? negateConditionAst(parsed) : undefined;
}

function negateConditionAst(ast) {
  if (ast.type === "term") {
    return {
      type: "term",
      term: negateConditionTerm(ast.term)
    };
  }

  const operator = ast.operator === "&&" ? "||" : "&&";
  return {
    type: "group",
    children: ast.children.map(negateConditionAst),
    operator,
    groupType: operator === "&&" ? "AND" : "OR"
  };
}

function negateConditionTerm(term) {
  if (term.expressionType === "contains") {
    const negated = !term.negateResult;
    return {
      ...term,
      symbol: negated ? "notcontain" : "contain",
      negateResult: negated
    };
  }

  if (term.expressionType === "orgBelong") {
    const negated = !term.negateResult;
    return {
      ...term,
      symbol: negated ? "notbelong" : "belongany",
      negateResult: negated
    };
  }

  if (term.expressionType === "empty") {
    const negated = !term.negateResult;
    return {
      ...term,
      symbol: negated ? "notempty" : "empty",
      negateResult: negated
    };
  }

  if (term.expressionType === "!=") {
    return {
      ...term,
      symbol: "==",
      expressionType: "=="
    };
  }

  return {
    ...term,
    symbol: "!=",
    expressionType: "!="
  };
}

function termVarConfig(term, variableKey, fdVarValue) {
  if (term.expressionType === "contains") {
    return {
      key: variableKey,
      resultType: { type: "boolean" },
      type: "Function",
      value: "global.contains",
      arguments: [
        {
          key: "X",
          resultType: { type: "any" },
          type: "Var",
          value: fdVarValue
        },
        {
          key: "Y",
          resultType: { type: "any" },
          type: "Fixed",
          value: term.value
        }
      ]
    };
  }

  if (term.expressionType === "orgBelong") {
    return {
      key: variableKey,
      resultType: { type: "boolean" },
      type: "Function",
      value: "sysorg.isOrganizationBelongOrIncludeAnother",
      arguments: [
        {
          key: "firstOrgs",
          resultType: { $ref: "ORG_ALL", type: "object" },
          type: "Var",
          value: fdVarValue
        },
        {
          key: "secondOrgs",
          resultType: { $ref: "ORG_ALL", type: "object" },
          type: "Fixed",
          value: term.orgValue || []
        },
        {
          key: "relationType",
          resultType: { type: "any" },
          type: "Fixed",
          value: term.relationType ?? 4
        },
        {
          key: "isCross",
          resultType: { type: "boolean" },
          type: "Fixed",
          value: Boolean(term.through)
        }
      ]
    };
  }

  if (term.expressionType === "empty") {
    return {
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
    };
  }

  return {
    key: variableKey,
    resultType: { type: "boolean" },
    type: "Eval",
    value: termExpression(term, fdVarValue)
  };
}

function termExpression(term, fdVarValue) {
  const dataRef = `\${data.${fdVarValue}}`;
  const value = JSON.stringify(term.value);
  if (["!=", ">=", "<=", ">", "<"].includes(term.expressionType)) {
    return `${dataRef} ${term.expressionType} ${value}`;
  }
  return `${dataRef} == ${value}`;
}

function termResultExpression(term) {
  const valueRef = `\${data.$VAR.${term.variableKey}}`;
  return term.negateResult ? `!${valueRef}` : valueRef;
}

function conditionResultExpression(ast) {
  if (ast.type === "term") return `(${termResultExpression(ast.term)})`;
  return `(${ast.children.map((child) => {
    const value = child.type === "term" ? termResultExpression(child.term) : conditionResultExpression(child);
    return value;
  }).join(` ${ast.operator} `)})`;
}

function collectConditionTerms(ast) {
  if (ast.type === "term") return [ast.term];
  return ast.children.flatMap(collectConditionTerms);
}

function attachConditionTerms(ast, terms, state = { index: 0 }) {
  if (ast.type === "term") {
    const term = terms[state.index];
    state.index += 1;
    return {
      type: "term",
      term
    };
  }

  return {
    ...ast,
    children: ast.children.map((child) => attachConditionTerms(child, terms, state))
  };
}

function conditionVoGroup(ast, options) {
  const groupKey = formulaVariableKey(options.edgeId, options.groupPath ? `group_${options.groupPath}` : "group");
  const children = ast.type === "group" ? ast.children : [ast];
  return {
    fdKey: groupKey,
    fdType: ast.type === "group" ? ast.groupType : "OR",
    leavel: String(options.level || 1),
    parentLeavel: options.parentLeavel,
    parentKey: options.parentKey,
    metaType: "GROUP",
    fdList: children.map((child, index) => conditionVoNode(child, {
      edgeId: options.edgeId,
      parentKey: groupKey,
      parentLeavel: options.groupPath ? `1-${options.groupPath}` : "1-1",
      groupPath: options.groupPath ? `${options.groupPath}_${index + 1}` : String(index + 1),
      level: (options.level || 1) + 1
    }))
  };
}

function conditionVoNode(ast, options) {
  if (ast.type === "group") return conditionVoGroup(ast, options);
  return {
    ...ast.term.rule,
    parentKey: options.parentKey,
    parentLeavel: options.parentLeavel,
    leavel: "3"
  };
}

function stripEnclosingParentheses(text) {
  let result = text;
  while (isFullyWrappedInParentheses(result)) {
    result = result.slice(1, -1).trim();
  }
  return result;
}

function isFullyWrappedInParentheses(text) {
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  let quote = "";
  let depth = 0;
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
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && index < text.length - 1) return false;
  }
  return depth === 0;
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

function formulaFieldType(field, term) {
  if (term?.expressionType === "orgBelong") return "object";
  if (isAddressField(field) && (!term || term.expressionType === "empty")) return "object";
  const type = String(field?.type || "").toLowerCase();
  if (["number", "decimal", "double", "currency", "integer"].includes(type)) return "number";
  if (type.includes("date")) return "date";
  if (type.includes("boolean")) return "boolean";
  return "string";
}

function formulaRuleValue(term, fieldType) {
  if (
    fieldType === "number"
    && [">=", "<=", ">", "<"].includes(term.expressionType)
    && term.value !== undefined
    && term.value !== ""
  ) {
    const numeric = Number(term.value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return term.value;
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

  if (fieldType === "object") {
    return {
      type: "object",
      $ref: "ORG_DEPT",
      required: Boolean(field?.props?.required),
      description: field?.title || field?.id || "",
      properties: {
        fdId: { type: "string", required: true, description: "ID", maxLength: 36 },
        fdName: { type: "string", required: true, description: "名称", maxLength: 200 }
      }
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
  if (context.initiatorSelectTarget === true) {
    return emptyOrgHandlers();
  }
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
        element: "user",
        type: nativeExplicitMemberType(member)
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
    return emptyOrgHandlers();
  }
  return handlersFromAttributes(attrs);
}

function nativeHandlerIds(participants, attrs) {
  if (participants?.mode === "explicit" && Array.isArray(participants.members)) {
    return participants.members.map((member) => member.id).filter(Boolean).join(";");
  }
  return attrs.handlerIds || participants?.sourceExpression || "";
}

function nativeHandlerNames(participants, attrs) {
  if (participants?.mode === "explicit" && Array.isArray(participants.members)) {
    return participants.members.map((member) => member.name || member.id).filter(Boolean).join(";");
  }
  return attrs.handlerNames || participants?.sourceNameExpression || "";
}

function nativeExplicitMemberType(member = {}) {
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
  if (existingType === "3") return "3";
  return "3";
}

function alternativeHandlerFields(participants) {
  const hasAlternativeConfig = Array.isArray(participants?.alternativeMembers) ||
    participants?.useAlternativeOnly !== undefined;
  if (!hasAlternativeConfig) return {};

  return {
    alternativeHandlers: {
      id: "alternativeHandlers",
      element: "users",
      type: "org",
      source: "1",
      ruleKey: "",
      ruleName: "",
      members: (participants?.alternativeMembers || []).map((member) => ({
        id: member.id,
        name: member.name || member.id,
        element: "user",
        type: nativeExplicitMemberType(member)
      }))
    },
    isUseAlternativeHandlerOnly: nativeBooleanString(participants?.useAlternativeOnly)
  };
}

function nativeBooleanString(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return value === true || value === 1 || normalized === "true" || normalized === "1"
    ? "true"
    : "false";
}

function emptyOrgHandlers() {
  return {
    id: "handlers",
    type: "org",
    source: "1",
    ruleKey: "",
    ruleName: "",
    members: [],
    element: "users"
  };
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

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function singleRelatedNodeId(attrs) {
  const ids = splitRelatedNodeIds(attrs.relatedNodeIds || attrs.relateId);
  return ids.length === 1 ? ids[0] : "";
}

function splitRelatedNodeIds(value = "") {
  return String(value || "").split(/[;,，\s]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizeRelatedNodeIds(value = "") {
  return [...new Set(splitRelatedNodeIds(value))].join(",");
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

function collectCanModifyHandlerTargetNodeIds(nodes = []) {
  const targetNodeIds = new Set();
  for (const node of nodes) {
    for (const targetNodeId of splitRelatedNodeIds(sourceAttributes(node).canModifyHandlerNodeIds)) {
      targetNodeIds.add(targetNodeId);
    }
  }
  return targetNodeIds;
}

function collectPersistedInitiatorSelectTargetNodeIds(nodes = []) {
  const targetNodeIds = new Set();
  for (const node of nodes) {
    for (const attribute of ["mustModifyHandlerNodes", "canModifyHandlerNodes"]) {
      for (const targetNodeId of splitRelatedNodeIds(node?.[attribute])) {
        targetNodeIds.add(targetNodeId);
      }
    }
  }
  return targetNodeIds;
}

// NewOA EEmptyType: JUMP(1)=自动跳过, ERROR(2)=流程报异常, POINT_HANDLER(3)=指定处理人.
// Source ignoreOnHandlerEmpty=true maps to JUMP; optional canModify* targets default to JUMP.
function resolveEmptyHandlerType(node, attrs = {}, context = {}) {
  const ignoreEmpty = attrs.ignoreOnHandlerEmpty ?? attrs.ignoreOnEmptyHandlers;
  if (ignoreEmpty === true || ignoreEmpty === "true") return 1;
  if (ignoreEmpty === false || ignoreEmpty === "false") return 2;
  if (context.canModifyHandlerTargetNodeIds?.has(node.id) === true) return 1;
  return 2;
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

// NewOA: "1"=不跳过 "2"=跳过 "3"=仅相邻相同身份跳过.
// Nodes with required form auth / mustModifyHandlerNodes / canModifyHandlerNodes / e-sign cannot use skip.
function resolveIgnoreOnSameIdentity(node, attrs = {}) {
  if (nodeForbidsSameIdentitySkip(node, attrs)) {
    return "1";
  }
  return normalizeSameIdentity(attrs.ignoreOnHandlerSame);
}

function nodeForbidsSameIdentitySkip(node, attrs = {}) {
  const fields = node?.dataAuthority?.fields || {};
  if (Object.values(fields).some((field) => field?.required === true)) {
    return true;
  }
  if (normalizeRelatedNodeIds(attrs.mustModifyHandlerNodeIds || attrs.mustModifyHandlerNodes)) {
    return true;
  }
  if (normalizeRelatedNodeIds(attrs.canModifyHandlerNodeIds || attrs.canModifyHandlerNodes)) {
    return true;
  }
  const eSign = attrs.eSignConfig || node?.eSignConfig;
  if (eSign && (eSign.enable === true || eSign.enable === "true")) {
    return true;
  }
  return false;
}

function hasEdgeCondition(edge) {
  return Boolean(edge.formula || edge.condition || edge.displayCondition || edge.formulaName);
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

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function workflowDraftError(message) {
  const error = new Error(message);
  error.stage = "saveWorkflowDraft";
  return error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}
