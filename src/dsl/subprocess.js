export function projectSubProcessWorkflow(workflow = {}) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  const recoverById = new Map(nodes
    .filter((node) => node?.type === "recoverSubProcess")
    .map((node) => [node.id, node]));
  const startByRecoverId = new Map(nodes
    .filter((node) => node?.type === "startSubProcess" && node.subProcess?.recoverNodeId)
    .map((node) => [node.subProcess.recoverNodeId, node]));

  if (!recoverById.size) return { nodes, edges, recoveries: [] };

  const projectedNodes = nodes.filter((node) => !recoverById.has(node.id));
  const projectedEdges = [];
  for (const edge of edges) {
    if (recoverById.has(edge.target) && startByRecoverId.get(edge.target)?.id === edge.source) {
      continue;
    }
    const pairedStart = startByRecoverId.get(edge.source);
    projectedEdges.push(pairedStart ? { ...edge, source: pairedStart.id } : edge);
  }

  return {
    nodes: projectedNodes,
    edges: projectedEdges,
    recoveries: [...recoverById.values()].map((recover) => ({
      recoverNodeId: recover.id,
      startNodeId: recover.subProcess?.startNodeId || ""
    }))
  };
}

export function subProcessContract(value = {}) {
  return {
    templateId: value.templateId,
    recoverNodeId: value.recoverNodeId,
    startCountType: String(value.startCountType || "1"),
    flowType: String(value.flowType || "2"),
    autoSubmit: value.autoSubmit === true,
    recovery: {
      variableScope: value.variableScope,
      recoverRule: value.recoverRule
    },
    startParamConfig: Array.isArray(value.startParamConfig) ? value.startParamConfig : [],
    recoverParamConfig: Array.isArray(value.recoverParamConfig) ? value.recoverParamConfig : []
  };
}

export function subProcessValidationIssues({ nodes = [], edges = [], mode = "draft" } = {}) {
  if (!Array.isArray(nodes)) return [];
  const issues = [];
  const nodeMap = new Map(nodes.filter(isRecord).map((node) => [node.id, node]));
  for (const [index, node] of nodes.entries()) {
    if (!isRecord(node) || !["startSubProcess", "recoverSubProcess"].includes(node.type)) continue;
    const path = `/workflow/nodes/${index}`;
    if (node.element !== "subProcess") {
      issues.push(issue("error", "dsl.workflow.subprocess.element_required", "Subprocess nodes must use element = subProcess.", `${path}/element`));
    }
    if (!isRecord(node.subProcess)) {
      issues.push(issue(
        mode === "execute" ? "error" : "warning",
        "dsl.workflow.subprocess.config_required",
        "Subprocess nodes require structured subProcess configuration before execution.",
        `${path}/subProcess`
      ));
      continue;
    }
    issues.push(...subProcessRecoveryIssues(node.subProcess, `${path}/subProcess`));
    if (node.type === "startSubProcess") {
      const recoverId = node.subProcess.recoverNodeId;
      const recover = nodeMap.get(recoverId);
      if (!nonEmptyString(node.subProcess.templateId)) {
        issues.push(issue("error", "dsl.workflow.subprocess.template_required", "Start subprocess requires a target templateId.", `${path}/subProcess/templateId`));
      }
      if (!recover || recover.type !== "recoverSubProcess" || recover.subProcess?.startNodeId !== node.id) {
        issues.push(issue("error", "dsl.workflow.subprocess.recover_pair_invalid", "Start subprocess must reference a reciprocal recoverSubProcess node.", `${path}/subProcess/recoverNodeId`));
      }
      if (mode === "execute") {
        const bridge = edges.filter((edge) => edge?.source === node.id && edge?.target === recoverId);
        if (bridge.length !== 1) {
          issues.push(issue("error", "dsl.workflow.subprocess.bridge_required", "Executable subprocess pair requires one start-to-recover bridge edge.", "/workflow/edges"));
        }
      }
    } else {
      const start = nodeMap.get(node.subProcess.startNodeId);
      if (!start || start.type !== "startSubProcess" || start.subProcess?.recoverNodeId !== node.id) {
        issues.push(issue("error", "dsl.workflow.subprocess.start_pair_invalid", "Recover subprocess must reference a reciprocal startSubProcess node.", `${path}/subProcess/startNodeId`));
      }
    }
  }
  return issues;
}

function subProcessRecoveryIssues(subProcess, path) {
  const issues = [];
  const expression = subProcess.recoverRule?.expression;
  const supportedRecovery = Number(subProcess.variableScope) === 2 &&
    Number(subProcess.recoverRule?.type) === 1 &&
    isRecord(expression) &&
    !String(expression.text || "").trim() &&
    !String(expression.value || "").trim();
  if (!supportedRecovery) {
    issues.push(issue(
      "error",
      "dsl.workflow.subprocess.recovery_unsupported",
      "Subprocess recovery must use the fixture-backed wait-for-all recovery scope and empty completion rule.",
      path
    ));
  }
  if (subProcess.flowType !== undefined && String(subProcess.flowType) !== "2") {
    issues.push(issue(
      "error",
      "dsl.workflow.subprocess.flow_type_invalid",
      "Wait-for-all subprocess recovery must project to native flowType 2.",
      `${path}/flowType`
    ));
  }
  return issues;
}

function issue(level, code, message, path) {
  return { level, code, message, path };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
