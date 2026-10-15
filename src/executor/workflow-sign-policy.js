// Explicit sign policy and immutable operation-set contracts. No write API is used.
import { createHash } from "node:crypto";
import { SIGN_DOCUMENT_POLICY, validateWorkflowSignOptions, inspectSourceSignNode, hasSourceSignDeclaration, stableJson, requireFact, exactText } from "../dsl/workflow-sign-contract.js";
const STANDARD_SIGNATURE = new Set([
  "1:drafter_retract", "1:drafter_urge", "1:drafter_abandon",
  "2:handler_sign", "2:handler_abandon", "3:historyHandler_retract", "3:historyHandler_urge"
]);

export function canonicalSignOperationSet(entity) {
  requireFact(entity && exactText(entity.fdId) && entity.fdNodeType === "sign" && entity.fdFlowType === "0" && entity.fdIsDefault === true, "operation_set_scope");
  requireFact(Array.isArray(entity.fdOperations) && entity.fdOperations.length === STANDARD_SIGNATURE.size, "operation_set_size");
  const ids = new Set(), signatures = new Set();
  const operations = entity.fdOperations.map(row => {
    requireFact(exactText(row.fdId) && !ids.has(row.fdId), "operation_id_invalid_or_duplicate"); ids.add(row.fdId);
    requireFact([1, 2, 3].includes(row.fdIdentity), "operation_identity");
    const signature = `${row.fdIdentity}:${row.fdType}`;
    requireFact(STANDARD_SIGNATURE.has(signature) && !signatures.has(signature), "operation_signature"); signatures.add(signature);
    requireFact(typeof row.fdName === "string" && Number.isSafeInteger(row.fdIndex), "operation_row_shape");
    requireFact(typeof row.fdAttributes === "string", "operation_attributes_type");
    let raw;
    try { raw = JSON.parse(row.fdAttributes); } catch { requireFact(false, "operation_attributes_json"); }
    requireFact(Array.isArray(raw), "operation_attributes_array");
    const names = new Set();
    const attributes = raw.map(attribute => {
      requireFact(attribute && !Array.isArray(attribute) && exactText(attribute.id), "operation_attribute_shape");
      requireFact(Object.keys(attribute).every(key => ["id", "value"].includes(key)), "operation_attribute_keys");
      requireFact(!names.has(attribute.id), "operation_attribute_duplicate"); names.add(attribute.id);
      if (Object.hasOwn(attribute, "value")) requireFact(finiteJsonValue(attribute.value), "operation_attribute_value_invalid");
      return Object.hasOwn(attribute, "value") ? { id: attribute.id, value: attribute.value } : { id: attribute.id };
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const attr = id => attributes.find(a => a.id === id)?.value;
    requireFact(attr("element") === "operation", "operation_element");
    if (["handler_sign", "handler_abandon", "drafter_abandon"].includes(row.fdType)) requireFact(attr("isContentRequired") === true, "operation_opinion_required");
    if (row.fdType === "handler_sign") requireFact(attr("isAlway") === true, "operation_sign_always");
    return { id: row.fdId, name: row.fdName, type: row.fdType, identity: String(row.fdIdentity), index: row.fdIndex, attributes };
  });
  return { canonicalVersion: 1, operationRefId: entity.fdId, nodeType: entity.fdNodeType, flowType: entity.fdFlowType, default: entity.fdIsDefault, operations };
}

function finiteJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finiteJsonValue);
  return Boolean(value && typeof value === "object" && Object.values(value).every(finiteJsonValue));
}

export function signOperationSetDigest(entity) {
  return `sha256:${createHash("sha256").update(stableJson(canonicalSignOperationSet(entity))).digest("hex")}`;
}

export function prepareSignPolicy(dsl, options = {}, operationEntities = []) {
  const checked = validateWorkflowSignOptions(options);
  requireFact(checked.ok, "options_invalid");
  const signNodes = (dsl?.workflow?.nodes || []).filter(n => n.type === "sign" || hasSourceSignDeclaration(n));
  if (!signNodes.length) {
    requireFact(!Object.hasOwn(options, "workflowSignDocumentPolicy") && !Object.hasOwn(options, "workflowOperationSetOverrides"), "policy_without_matching_sign");
    return { nodes: [], documentAudit: [], operationSets: [] };
  }
  const mappings = options.workflowOperationSetOverrides || [];
  const usedMappings = new Set(), sets = new Map(), nodes = [], documentAudit = [];
  for (const node of signNodes) {
    requireFact(node.type === "sign" && node.element === "manualTask", "candidate_node_type");
    const source = inspectSourceSignNode(node);
    const matches = mappings.filter(mapping => mapping.sourceNodeType === node.sourceType && mapping.sourceOperationRefId === source.sourceOperationRefId);
    requireFact(matches.length === 1, "operation_mapping_missing");
    const mapping = matches[0]; usedMappings.add(mapping.sourceOperationRefId);
    const matchesEntity = operationEntities.filter(entity => entity.fdId === mapping.targetOperationRefId);
    requireFact(matchesEntity.length === 1, "operation_entity_missing_or_duplicate");
    const entity = matchesEntity[0], canonical = canonicalSignOperationSet(entity), digest = signOperationSetDigest(entity);
    requireFact(digest === mapping.expectedSemanticDigest, "operation_digest_changed");
    if (source.hasDocumentValue) requireFact(options.workflowSignDocumentPolicy === SIGN_DOCUMENT_POLICY, "document_policy_required");
    documentAudit.push({
      nodeId: node.id, sourceRef: node.sourceRef,
      ...(source.hasDocumentValue ? { sourceValue: source.sourceValue, sourcePath: source.documentSourcePath, disposition: "audit-only", policy: SIGN_DOCUMENT_POLICY } : { disposition: "not-present" }),
      targetPermissionMapped: false
    });
    nodes.push({ nodeId: node.id, sourceRef: node.sourceRef, sourceOperationRefId: source.sourceOperationRefId, targetOperationRefId: entity.fdId, operations: [] });
    sets.set(entity.fdId, { operationRefId: entity.fdId, digest, canonical });
  }
  requireFact(usedMappings.size === mappings.length, "unused_operation_mapping");
  return { nodes, documentAudit, operationSets: [...sets.values()] };
}

export async function resolveWorkflowSignPolicy(dsl, options = {}) {
  try {
    requireFact(validateWorkflowSignOptions(options).ok, "options_invalid");
    const nodes = (dsl.workflow?.nodes || []).filter(node => node.type === "sign" || hasSourceSignDeclaration(node));
    for (const node of nodes) {
      const source = inspectSourceSignNode(node);
      if (source.hasDocumentValue) requireFact(options.workflowSignDocumentPolicy === SIGN_DOCUMENT_POLICY, "document_policy_required");
      requireFact((options.workflowOperationSetOverrides || []).some(mapping => mapping.sourceOperationRefId === source.sourceOperationRefId), "operation_mapping_missing");
    }
    const refs = [...new Set((options.workflowOperationSetOverrides || []).map(mapping => mapping.targetOperationRefId))];
    requireFact(!refs.length || typeof options.client?.getWorkflowOperationSet === "function", "operation_client_missing");
    const entities = [];
    for (const ref of refs) entities.push(await options.client.getWorkflowOperationSet(ref));
    const policy = prepareSignPolicy(dsl, options, entities);
    const next = structuredClone(dsl);
    for (const node of policy.nodes) next.workflow.nodes.find(value => value.id === node.nodeId).operationRefId = node.targetOperationRefId;
    return { dsl: next, policy };
  } catch (error) { error.stage = "resolveWorkflowSignPolicy"; throw error; }
}

export async function verifyWorkflowSignReadback(policy, template, client) {
  try {
    const content = JSON.parse(template?.mechanisms?.lbpmTemplate?.[0]?.fdContent);
    requireFact(Array.isArray(content.elements), "native_workflow_content");
    const nodes = content.elements.filter(node => node.type !== "sequenceFlow");
    const actualRefs = new Set();
    for (const expected of policy.nodes) {
      const actual = nodes.find(node => node.id === expected.nodeId);
      requireFact(actual?.operationRefId === expected.targetOperationRefId, "native_operation_ref_changed");
      actualRefs.add(actual.operationRefId);
    }
    const entities = [];
    for (const ref of actualRefs) entities.push(await client.getWorkflowOperationSet(ref));
    return { ...verifySignPolicyReadback(policy, nodes, entities), checkedReferences: [...actualRefs] };
  } catch (error) {
    return { ok: false, diagnostics: [{ level: "error", code: error.code || "workflow.sign.operation_readback_failed", message: "The observed sign operation set could not be verified." }] };
  }
}

// Native node observation is independent of the source audit/migrationSource payload.
// Full flag/participant/timeout comparisons remain the existing invariant layer's job.
export function verifySignPolicyReadback(expected, nativeNodes, operationEntities) {
  try {
    requireFact(Array.isArray(nativeNodes), "native_nodes_missing");
    const signNodes = nativeNodes.filter(n => n.type === "sign");
    requireFact(signNodes.length === expected.nodes.length, "native_sign_node_count");
    for (const node of expected.nodes) {
      const matches = nativeNodes.filter(n => n.id === node.nodeId);
      requireFact(matches.length === 1, "native_node_missing_or_duplicate");
      const actual = matches[0];
      requireFact(actual.type === "sign" && actual.element === "manualTask", "native_node_type");
      requireFact(actual.operationRefId === node.targetOperationRefId, "native_operation_ref_changed");
      requireFact(Array.isArray(actual.operations) && actual.operations.length === 0, "native_inline_operations");
      const entities = operationEntities.filter(entity => entity.fdId === actual.operationRefId);
      requireFact(entities.length === 1, "observed_operation_entity_missing_or_duplicate");
      const expectedSet = expected.operationSets.find(set => set.operationRefId === node.targetOperationRefId);
      requireFact(expectedSet && signOperationSetDigest(entities[0]) === expectedSet.digest, "effective_operation_set_changed");
      requireFact(stableJson(canonicalSignOperationSet(entities[0])) === stableJson(expectedSet.canonical), "effective_operation_fields_changed");
    }
    return { ok: true, diagnostics: [] };
  } catch (error) {
    return { ok: false, diagnostics: [{ level: "error", code: error.code || "workflow.sign.invalid", message: error.message }] };
  }
}
