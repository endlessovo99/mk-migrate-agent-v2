const TYPES = new Set(["1", "2", "3"]);
const ENDPOINT = "/data/sys-lbpm/lbpmConfig/getConfigs";

export async function resolveWorkflowCooperation(dsl, {
  client, workflowCooperationDefault, targetBaseUrl, now = new Date()
} = {}) {
  if (workflowCooperationDefault !== undefined && !TYPES.has(workflowCooperationDefault)) {
    throw failure("policy_invalid");
  }
  const nodes = [];
  for (const [index, node] of (dsl?.workflow?.nodes || []).entries()) {
    if (!["review", "send", "sign"].includes(node.type)) continue;
    const path = `/workflow/nodes/${index}`;
    const definitionHasValue = Object.hasOwn(node.definition?.attributes || {}, "processType");
    if (definitionHasValue && Object.hasOwn(node.attributes || {}, "processType") &&
        node.definition.attributes.processType !== node.attributes.processType) {
      throw failure("source_value_conflict", { nodeId: node.id, path });
    }
    const attributes = definitionHasValue ? node.definition.attributes : node.attributes || {};
    const sourceValue = attributes.processType;
    const sourcePath = `${path}/${definitionHasValue ? "definition/attributes" : "attributes"}/processType`;
    if (sourceValue !== undefined && sourceValue !== "0" && !TYPES.has(sourceValue)) {
      throw failure("source_value_unsupported", { nodeId: node.id, sourcePath, sourceValue });
    }
    if (sourceValue === "0" && workflowCooperationDefault === undefined) {
      throw failure("explicit_policy_required", { nodeId: node.id, sourcePath, sourceValue });
    }
    const targetValue = sourceValue === "0" ? workflowCooperationDefault : sourceValue ?? "2";
    if (node.cooperateType !== undefined && node.cooperateType !== targetValue) {
      throw failure("runtime_value_conflict", { nodeId: node.id, sourcePath, sourceValue, targetValue });
    }
    nodes.push({
      nodeId: node.id, sourceRef: node.sourceRef, path: `${path}/cooperateType`, sourcePath,
      sourceValue: sourceValue ?? null, targetValue,
      basis: sourceValue === "0" ? "explicit-current-default" : sourceValue === undefined ? "existing-missing-value-default" : "native-value-preserved"
    });
  }

  let config;
  if (workflowCooperationDefault !== undefined) {
    if (typeof client?.getWorkflowCooperationConfig !== "function") throw failure("config_client_missing");
    let current;
    try { current = await client.getWorkflowCooperationConfig(); }
    catch { throw failure("config_request_failed"); }
    if (!current || typeof current !== "object" || Array.isArray(current) || !TYPES.has(current.nodeHandlerTurningWay)) {
      throw failure("current_default_invalid");
    }
    if (current.nodeHandlerTurningWay !== workflowCooperationDefault) {
      throw failure("current_default_changed", { expected: workflowCooperationDefault, actual: current.nodeHandlerTurningWay });
    }
    config = {
      endpoint: ENDPOINT, baseUrl: targetBaseUrl, checkedAt: now.toISOString(),
      nodeHandlerTurningWay: current.nodeHandlerTurningWay
    };
  }
  const next = structuredClone(dsl);
  for (const audit of nodes) {
    const index = Number(audit.path.split("/")[3]);
    next.workflow.nodes[index].cooperateType = audit.targetValue;
  }
  return { dsl: next, nodes, fallbackCount: nodes.filter(node => node.basis === "explicit-current-default").length, config };
}

function failure(reason, details = {}) {
  const error = new Error("Workflow cooperation requires an explicit, current target policy for unsupported source values.");
  error.stage = "resolveWorkflowCooperation";
  error.code = "workflow.cooperation_resolution_failed";
  error.issues = [{ reason, ...details }];
  return error;
}
