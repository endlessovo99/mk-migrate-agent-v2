const record = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const identity = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
const exactKeys = (value, expected) => record(value) &&
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));

/** Exact native LBPM reads only. Never resolves business identities or changes DSL. */
export async function verifyWorkflowSubProcessDependencies(dsl, { client } = {}) {
  const nodes = Array.isArray(dsl?.workflow?.nodes) ? dsl.workflow.nodes : [];
  const unique = new Map();
  for (const [index, node] of nodes.entries()) {
    if (node?.type !== "startSubProcess") continue;
    const templateId = node.subProcess?.templateId;
    if (!unique.has(templateId)) unique.set(templateId, []);
    unique.get(templateId).push({ node, index });
  }
  const dependencies = [], diagnostics = [];
  if (!unique.size) return { ok: true, dependencies, diagnostics };

  for (const [templateId, references] of unique) {
    const dependency = { templateId, nodeIds: references.map(({ node }) => node.id), status: "failed", reads: [] };
    dependencies.push(dependency);
    const path = `/workflow/nodes/${references[0].index}/subProcess/templateId`;
    const fail = (code, message, details = {}, failurePath = path) => diagnostics.push({
      level: "error", code: `workflow.subprocess.${code}`, message, path: failurePath,
      details: { templateId, nodeIds: dependency.nodeIds, ...details }
    });
    const methods = ["getWorkflowTemplateDetail", "getWorkflowSubProcessParams"];
    const missing = methods.filter(method => typeof client?.[method] !== "function");
    if (missing.length) {
      fail("dependency_client_unavailable", "Subprocess dependency metadata reads are unavailable; no target write was attempted.", { methods: missing });
      continue;
    }
    if (!identity(templateId)) {
      fail("dependency_identity_mismatch", "Subprocess dependency requires an exact internal LBPM template identity.");
      continue;
    }

    let detail, params;
    try {
      dependency.reads.push({ name: "getWorkflowTemplateDetail", status: "started" });
      detail = await client.getWorkflowTemplateDetail({ templateId });
      dependency.reads.at(-1).status = "ok";
    } catch (error) {
      const failure = classifyReadFailure(error, "getWorkflowTemplateDetail");
      Object.assign(dependency.reads.at(-1), { status: "failed", ...failure });
      fail("dependency_read_failed", "The exact subprocess dependency detail could not be verified; no target write was attempted.", failure);
      continue;
    }
    if (!record(detail) || detail.fdId !== templateId) {
      fail("dependency_identity_mismatch", "Subprocess dependency detail did not confirm the requested internal LBPM identity.");
      continue;
    }
    if (detail.isDraft !== false || detail.fdStatus !== "published" || detail.latestDefinitionStatus !== 9) {
      fail("dependency_not_published", "Subprocess dependency must confirm a published current definition.");
      continue;
    }
    if (detail.fdEnable !== true) {
      fail("dependency_disabled", "Subprocess dependency must explicitly be enabled.");
      continue;
    }
    if (!identity(detail.fdDefinitionId)) {
      fail("dependency_definition_unverified", "Subprocess dependency detail did not include a usable definition identity.");
      continue;
    }
    if (detail.fdContentType !== "json" || !validDefinitionGraph(detail.fdContent)) {
      fail("dependency_graph_invalid", "Subprocess dependency did not contain a complete JSON definition graph with valid identities and connected endpoints.");
      continue;
    }
    dependency.definitionId = detail.fdDefinitionId;
    try {
      dependency.reads.push({ name: "getWorkflowSubProcessParams", status: "started" });
      params = await client.getWorkflowSubProcessParams({ templateId });
      dependency.reads.at(-1).status = "ok";
    } catch (error) {
      const failure = classifyReadFailure(error, "getWorkflowSubProcessParams");
      Object.assign(dependency.reads.at(-1), { status: "failed", ...failure });
      fail("dependency_read_failed", "The exact subprocess dependency parameter metadata could not be verified; no target write was attempted.", failure);
      continue;
    }
    if (!record(params) || !identity(params.processTemplateInfo?.latestDefinitionId) ||
        params.processTemplateInfo.latestDefinitionId !== detail.fdDefinitionId) {
      fail("dependency_definition_unverified", "Subprocess details and parameter metadata must confirm the same latest definition identity.");
      continue;
    }

    // The observed params contract proves only the empty process-variable case.
    // It does not prove form fields, required inputs, types or legacy expressions.
    const metadataVerified = exactKeys(params, ["processTemplateInfo", "processTempVars"]) &&
      exactKeys(params.processTemplateInfo, ["latestDefinitionId"]) &&
      exactKeys(params.processTempVars, ["_all"]) &&
      Array.isArray(params.processTempVars._all) && params.processTempVars._all.length === 0;
    if (!metadataVerified) {
      fail("parameter_contract_unverified", "Subprocess parameter metadata is outside the evidenced complete empty-variable contract.", { reason: "parameter_metadata_unverified" });
      continue;
    }
    const before = diagnostics.length;
    for (const { node, index } of references) {
      const recoverIndex = nodes.findIndex(candidate => candidate?.id === node.subProcess?.recoverNodeId);
      const related = [{ node, index }, ...(recoverIndex < 0 ? [] : [{ node: nodes[recoverIndex], index: recoverIndex }])];
      for (const reference of related) {
        const value = reference.node.subProcess || {};
        for (const key of ["modelName", "dictBean", "createParam", "startParamConfig", "recoverParamConfig"]) {
          const empty = key.endsWith("ParamConfig")
            ? value[key] === undefined || Array.isArray(value[key]) && value[key].length === 0
            : value[key] === undefined || value[key] === "";
          if (!empty) fail("parameter_contract_unverified", "Subprocess business bindings and parameter mappings require target metadata and expression compatibility that have not been proved.",
            { reason: "business_or_parameter_binding_unverified", nodeId: reference.node.id }, `/workflow/nodes/${reference.index}/subProcess/${key}`);
        }
      }
    }
    if (diagnostics.length === before) dependency.status = "ok";
  }
  return { ok: diagnostics.length === 0, dependencies, diagnostics };
}

function classifyReadFailure(error, readStage) {
  const response = error?.response;
  // Preserve the evidenced error codes, never upstream free text or arbitrary
  // code-shaped strings that could contain session or credential material.
  const codes = [response?.body?.code, ...(Array.isArray(response?.body?.errStacks) ? response.body.errStacks.map(item => item?.code) : [])]
    .filter(code => ["errors.noRecord", "error.params"].includes(code));
  const upstreamCodes = [...new Set(codes)];
  const invalidResponse = ["newoa.workflow_template_detail_invalid", "newoa.workflow_subprocess_params_invalid"].includes(error?.code);
  const transportFailure = !response && !invalidResponse;
  return {
    readStage, transportFailure,
    reason: invalidResponse ? "invalid_response"
      : response?.status === 401 ? "authentication_failed"
        : response?.status === 403 ? "authorization_failed"
          : upstreamCodes.includes("errors.noRecord") ? "no_record"
            : transportFailure ? "transport_failure" : "native_api_failed",
    ...(Number.isInteger(response?.status) ? { httpStatus: response.status } : {}),
    ...(upstreamCodes.length ? { upstreamCodes } : {})
  };
}

function validDefinitionGraph(content) {
  let graph;
  try { graph = typeof content === "string" ? JSON.parse(content) : undefined; } catch { return false; }
  const elements = graph?.elements;
  if (!record(graph) || !Array.isArray(elements) || !elements.length ||
      elements.some(element => !record(element) || !identity(element.id) || typeof element.type !== "string" || !element.type)) return false;
  if (new Set(elements.map(element => element.id)).size !== elements.length) return false;
  const nodes = elements.filter(element => element.type !== "sequenceFlow");
  const edges = elements.filter(element => element.type === "sequenceFlow");
  const ids = new Set(nodes.map(node => node.id));
  const starts = nodes.filter(node => node.type === "generalStart" && node.element === "startEvent");
  const ends = nodes.filter(node => node.type === "generalEnd" && node.element === "endEvent");
  if (!starts.length || !ends.length || !edges.length || edges.some(edge => !ids.has(edge.sourceRef) || !ids.has(edge.targetRef))) return false;
  const reachable = (seeds, from, to) => {
    const seen = new Set(seeds.map(node => node.id)), pending = [...seen];
    while (pending.length) {
      const id = pending.pop();
      for (const edge of edges) if (edge[from] === id && !seen.has(edge[to])) { seen.add(edge[to]); pending.push(edge[to]); }
    }
    return seen;
  };
  const forward = reachable(starts, "sourceRef", "targetRef"), backward = reachable(ends, "targetRef", "sourceRef");
  return nodes.every(node => forward.has(node.id) && backward.has(node.id));
}
