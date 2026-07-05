export function applyWorkflowPayload(template, dsl) {
  if (!dsl.workflow) return template;

  const next = clone(template);
  next.mechanisms = next.mechanisms || {};
  next.mechanisms.lbpmTemplate = Array.isArray(next.mechanisms.lbpmTemplate)
    ? next.mechanisms.lbpmTemplate
    : [{}];

  const lbpm = next.mechanisms.lbpmTemplate[0] || {};
  next.mechanisms.lbpmTemplate[0] = lbpm;
  lbpm.fdContent = JSON.stringify(buildWorkflowContent(dsl.workflow));
  lbpm.fdStatus = "draft";
  lbpm.fdPublishType ||= "instant";
  lbpm.isDraft = true;
  lbpm.fdReaders = next.fdReaders || lbpm.fdReaders || [];
  lbpm.fdEditors = next.fdEditors || lbpm.fdEditors || [];

  return next;
}

export function buildWorkflowContent(workflow) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  const nodeElements = nodes.map((node, index) => ({
    id: node.id,
    type: mapNodeType(node.type),
    element: mapNodeElement(node.type),
    name: node.name || node.id,
    x: Number.parseInt(node.attributes?.x, 10) || 120,
    y: Number.parseInt(node.attributes?.y, 10) || 80 + index * 80,
    source: {
      id: node.id,
      type: node.type,
      name: node.name || "",
      attributes: node.attributes || {},
      definition: summarizeDefinition(node.definition)
    }
  }));
  const edgeElements = edges.map((edge) => ({
    id: edge.id,
    type: "sequenceFlow",
    sourceRef: edge.source,
    targetRef: edge.target,
    name: edge.name || "",
    condition: edge.condition || "",
    displayCondition: edge.displayCondition || "",
    source: {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      name: edge.name || "",
      attributes: edge.attributes || {}
    }
  }));

  return {
    process: workflow.process || {},
    elements: [...nodeElements, ...edgeElements],
    migrationDsl: {
      workflow: summarizeDslWorkflow(workflow)
    }
  };
}

export function summarizeWorkflowFromTemplate(template) {
  const content = parseJsonObject(template?.mechanisms?.lbpmTemplate?.[0]?.fdContent || "{}");
  const elements = Array.isArray(content.elements) ? content.elements : [];
  return {
    nodeCount: elements.filter((element) => element.type !== "sequenceFlow").length,
    edgeCount: elements.filter((element) => element.type === "sequenceFlow").length,
    conditionEdgeCount: elements.filter((element) => element.type === "sequenceFlow" && element.condition).length
  };
}

export function summarizeDslWorkflow(workflow = {}) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  return {
    processId: workflow.process?.id || "",
    nodeCount: nodes.length,
    edgeCount: edges.length,
    conditionEdgeCount: edges.filter((edge) => Boolean(edge.condition || edge.displayCondition)).length,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      mappedType: mapNodeType(node.type)
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      hasCondition: Boolean(edge.condition || edge.displayCondition)
    }))
  };
}

export function workflowMappingDiagnostics(workflow) {
  const diagnostics = [];
  for (const node of workflow?.nodes || []) {
    if (isKnownNodeType(node.type)) continue;
    diagnostics.push({
      level: "warning",
      code: "workflow.node_type_mapped_to_manual_task",
      message: `Workflow node ${node.id} has unsupported type ${node.type}; mapped to manualTask.`,
      path: "/workflow/nodes",
      details: {
        nodeId: node.id,
        sourceType: node.type,
        mappedType: "manualTask"
      }
    });
  }
  return diagnostics;
}

function mapNodeType(type = "") {
  const normalized = String(type).toLowerCase();
  if (normalized.includes("start")) return "startEvent";
  if (normalized.includes("end")) return "endEvent";
  if (normalized.includes("gateway") || normalized.includes("branch")) return "exclusiveGateway";
  return "manualTask";
}

function isKnownNodeType(type = "") {
  const normalized = String(type).toLowerCase();
  return normalized.includes("start") ||
    normalized.includes("end") ||
    normalized.includes("draft") ||
    normalized.includes("review") ||
    normalized.includes("manual") ||
    normalized.includes("task") ||
    normalized.includes("approval") ||
    normalized.includes("gateway") ||
    normalized.includes("branch");
}

function mapNodeElement(type = "") {
  const mapped = mapNodeType(type);
  if (mapped === "exclusiveGateway") return "exclusiveGateway";
  return mapped;
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
