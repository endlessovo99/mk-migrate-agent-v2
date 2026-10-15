// A source sign node and its explicit policy cannot be silently remapped to approval.
const OPTION_KEYS = ["sourceNodeType", "sourceOperationRefId", "targetNodeType", "targetFlowType", "targetOperationRefId", "expectedDefault", "expectedSemanticDigest"];
export const SIGN_DOCUMENT_POLICY = "form-only-audit";

export function hasSourceSignDeclaration(node) {
  return node?.sourceType === "signNode" || node?.definition?.sourceType === "signNode" ||
    Boolean(node?.signSourceIssues?.length || node?.definition?.signSourceIssues?.length);
}

export function validateWorkflowSignOptions(options = {}) {
  return inspect(() => {
    requireFact(isObject(options), "options_object_required");
    if (Object.hasOwn(options, "workflowSignDocumentPolicy")) {
      requireFact(options.workflowSignDocumentPolicy === SIGN_DOCUMENT_POLICY, "document_policy_invalid");
    }
    if (!Object.hasOwn(options, "workflowOperationSetOverrides")) return;
    const values = options.workflowOperationSetOverrides;
    requireFact(Array.isArray(values) && values.length > 0, "operation_overrides_invalid");
    const seen = new Set();
    for (const value of values) {
      exactKeys(value, OPTION_KEYS, "operation_override_keys");
      requireFact(value.sourceNodeType === "signNode" && value.targetNodeType === "sign", "operation_override_type");
      requireFact(value.targetFlowType === "0" && value.expectedDefault === true, "operation_override_scope");
      requireFact(exactText(value.sourceOperationRefId), "source_operation_ref_invalid");
      requireFact(exactText(value.targetOperationRefId) && !["default", "custom"].includes(value.targetOperationRefId), "target_operation_ref_invalid");
      requireFact(/^sha256:[a-f0-9]{64}$/.test(value.expectedSemanticDigest || ""), "operation_digest_invalid");
      requireFact(!seen.has(value.sourceOperationRefId), "operation_override_duplicate");
      seen.add(value.sourceOperationRefId);
    }
  });
}

export function inspectSourceSignNode(node) {
  requireFact(node?.sourceType === "signNode" && exactText(node.id) && exactText(node.sourceRef), "source_node_invalid");
  requireFact(!node.signSourceIssues?.length && !node.definition?.signSourceIssues?.length, "source_structure_ambiguous");
  requireFact(node.directTargetAmbiguities === undefined ||
    (Array.isArray(node.directTargetAmbiguities) && node.directTargetAmbiguities.length === 0), "source_handler_ambiguous");
  const direct = node.attributes || {}, definition = node.definition?.attributes || {};
  requireFact(isObject(direct) && isObject(definition), "source_attributes_invalid");
  if (node.definition) requireFact(node.definition.sourceType === "signNode", "source_definition_type");
  for (const key of new Set([...Object.keys(direct), ...Object.keys(definition)])) {
    if (Object.hasOwn(direct, key) && Object.hasOwn(definition, key)) {
      requireFact(stableJson(direct[key]) === stableJson(definition[key]), "source_attribute_conflict");
    }
  }
  const sourceValue = Object.hasOwn(definition, "canModifyMainDoc") ? definition.canModifyMainDoc : direct.canModifyMainDoc;
  const hasDocumentValue = Object.hasOwn(definition, "canModifyMainDoc") || Object.hasOwn(direct, "canModifyMainDoc");
  if (hasDocumentValue) requireFact(["true", "false"].includes(sourceValue), "source_document_value_invalid");
  const attrs = { ...direct, ...definition };
  requireFact(attrs.handlerSelectType === "org" && (!attrs.optHandlerSelectType || attrs.optHandlerSelectType === "org"), "source_handler_mode_unsupported");
  for (const key of ["canModifyFlow", "canModifyNotionPopedom", "ignoreOnHandlerEmpty", "ignoreOnHandlerSame", "onAdjoinHandlerSame", "recalculateHandler", "useOptHandlerOnly"]) {
    if (Object.hasOwn(attrs, key)) requireFact(["true", "false"].includes(attrs[key]), "source_flag_unsupported");
  }
  const references = [];
  for (const [location, operations] of [["operations", node.operations], ["definition/operations", node.definition?.operations]]) {
    if (operations === undefined) continue;
    requireFact(Array.isArray(operations) && operations.length === 1, "source_operation_count");
    const entry = operations[0];
    exactKeys(entry, ["sourceRef", "attributes", "childElementCount", "text"], "source_operation_shape");
    exactKeys(entry.attributes, ["refId"], "source_operation_attributes");
    requireFact(exactText(entry.sourceRef) && exactText(entry.attributes.refId), "source_operation_ref_invalid");
    requireFact(entry.childElementCount === 0 && typeof entry.text === "string" && !entry.text.trim(), "source_operation_content");
    references.push({ location, sourceRef: entry.sourceRef, refId: entry.attributes.refId });
  }
  requireFact(references.length > 0, "source_operation_missing");
  requireFact(new Set(references.map(x => x.refId)).size === 1, "source_operation_conflict");
  return {
    nodeId: node.id, sourceRef: node.sourceRef, sourceOperationRefId: references[0].refId,
    operationEvidence: references, hasDocumentValue,
    ...(hasDocumentValue ? { sourceValue, documentSourcePath: Object.hasOwn(definition, "canModifyMainDoc") ? "/definition/attributes/canModifyMainDoc" : "/attributes/canModifyMainDoc" } : {})
  };
}

export function validateSourceSignIntegrity(sourceDraft, candidateDsl, expectedWorkflow) {
  return inspect(() => {
    const sources = (sourceDraft?.workflow?.nodes || []).filter(hasSourceSignDeclaration);
    const candidates = candidateDsl?.workflow?.nodes || [];
    const ids = new Set();
    for (const source of sources) {
      inspectSourceSignNode(source);
      requireFact(!ids.has(source.id), "source_node_duplicate"); ids.add(source.id);
      const matches = candidates.filter(n => n.id === source.id);
      requireFact(matches.length === 1, "candidate_node_missing_or_duplicate");
      const candidate = matches[0];
      requireFact(candidate.type === "sign" && candidate.element === "manualTask", "candidate_node_type");
      for (const key of ["sourceType", "sourceRef", "attributes", "definition", "operations", "handlerEntities", "optionalHandlerEntities", "eSignConfig", "directTargetAmbiguities", "signSourceIssues"]) {
        requireFact(stableJson(candidate[key]) === stableJson(source[key]), "source_evidence_changed");
      }
      const expected = expectedWorkflow?.nodes?.find(node => node.id === source.id);
      if (expected) for (const key of ["participants", "participantSelections", "dataAuthority"]) {
        requireFact(stableJson(candidate[key]) === stableJson(expected[key]), "source_participant_or_authority_changed");
      }
    }
    for (const candidate of candidates.filter(n => n.type === "sign" || hasSourceSignDeclaration(n))) {
      requireFact(ids.has(candidate.id), "candidate_sign_without_source");
    }
  });
}

export function stableJson(value) {
  if (value === undefined) return undefined;
  const sorted = input => {
    if (Array.isArray(input)) return input.map(sorted);
    if (isObject(input)) return Object.fromEntries(Object.keys(input).sort().map(key => [key, sorted(input[key])]));
    return input;
  };
  return JSON.stringify(sorted(value));
}
export function requireFact(condition, code) {
  if (!condition) throw Object.assign(new Error(`Sign contract rejected: ${code}`), { code: `workflow.sign.${code}` });
}
export function exactText(value) { return typeof value === "string" && value.length > 0 && value === value.trim(); }
export function exactKeys(value, keys, code) {
  requireFact(isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), code);
}
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function inspect(callback) {
  try { callback(); return { ok: true, diagnostics: [] }; }
  catch (error) { return { ok: false, diagnostics: [{ level: "error", code: error.code || "workflow.sign.invalid", message: error.message }] }; }
}
