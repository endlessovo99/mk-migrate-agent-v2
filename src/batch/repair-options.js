import { validateWorkflowSignOptions, inspectSourceSignNode, hasSourceSignDeclaration } from "../dsl/workflow-sign-contract.js";
const KEYS = {
  participantOverrides: "sourceId",
  templateAuthorizationOverrides: "sourceId",
  directParticipantOverrides: "sourceTargetId"
};
const AUTHORIZATION_COLLECTIONS = [
  "readers", "editors", "allReaders", "allEditors", "temporaryReaders", "temporaryEditors"
];

export function validateRepairOptions(options) {
  exactKeys(options, [...Object.keys(KEYS), "workflowCooperationDefault", "workflowSignDocumentPolicy", "workflowOperationSetOverrides"], "action.options");
  if (!validateWorkflowSignOptions(options).ok) throw new Error("Invalid explicit sign repair policy.");
  if (!Object.keys(options).length) throw new Error("Repair execution options must contain explicit mappings or a cooperation default.");
  for (const [key, entries] of Object.entries(options)) {
    if (["workflowSignDocumentPolicy", "workflowOperationSetOverrides"].includes(key)) continue;
    if (key === "workflowCooperationDefault") {
      if (!["1", "2", "3"].includes(entries)) throw new Error("workflowCooperationDefault must be an explicit string 1, 2, or 3.");
      continue;
    }
    if (!Array.isArray(entries) || !entries.length) throw new Error(`${key} must be a non-empty mapping array.`);
    const ids = new Set();
    for (const entry of entries) {
      exactKeys(entry, [KEYS[key], "targetFdId"], key);
      for (const field of [KEYS[key], "targetFdId"]) {
        if (typeof entry[field] !== "string" || !entry[field].trim() || entry[field] !== entry[field].trim()) {
          throw new Error(`${key}.${field} must be a non-empty trimmed string.`);
        }
      }
      if (ids.has(entry[KEYS[key]])) throw new Error(`${key} contains a duplicate source identity.`);
      ids.add(entry[KEYS[key]]);
    }
  }
}

// Only mappings evidenced by this item's DSL are selected. The executor still
// verifies that each target exists and has the required organization type.
export function applicableRepairOptions(dsl, current, proposed) {
  const workflow = (dsl?.workflow?.nodes || []).flatMap((node) => [
    ...(node.participants?.members || []), ...(node.participants?.alternativeMembers || [])
  ]);
  const authorization = AUTHORIZATION_COLLECTIONS.flatMap((key) => dsl?.template?.authorization?.[key] || []);
  const result = structuredClone(current || {});
  const diagnostics = [];
  let matchingMappings = 0;
  for (const [key, entries] of Object.entries(proposed)) {
    if (["workflowSignDocumentPolicy", "workflowOperationSetOverrides"].includes(key)) {
      const contracts = (dsl?.workflow?.nodes || []).filter(node => hasSourceSignDeclaration(node) || node.type === "sign").flatMap(node => {
        try { return [inspectSourceSignNode(node)]; }
        catch { diagnostics.push({ level: "error", code: "batch.repair.sign_source_ambiguous", nodeId: node.id }); return []; }
      });
      if (key === "workflowSignDocumentPolicy") {
        const applicable = contracts.filter(contract => contract.hasDocumentValue);
        if (applicable.length) { result[key] = entries; matchingMappings += applicable.length; }
      } else {
        const applicable = entries.filter(entry => contracts.some(contract => contract.sourceOperationRefId === entry.sourceOperationRefId));
        const merged = new Map((result[key] || []).map(entry => [entry.sourceOperationRefId, entry]));
        for (const entry of applicable) merged.set(entry.sourceOperationRefId, structuredClone(entry));
        if (applicable.length) { result[key] = [...merged.values()]; matchingMappings += applicable.length; }
      }
      continue;
    }
    if (key === "workflowCooperationDefault") {
      const candidates = (dsl?.workflow?.nodes || []).filter(node => {
        if (!["review", "send", "sign"].includes(node.type)) return false;
        const direct = node.attributes?.processType;
        const defined = node.definition?.attributes?.processType;
        if (direct !== undefined && defined !== undefined && direct !== defined) {
          diagnostics.push({ level: "error", code: "batch.repair.cooperation_source_ambiguous", nodeId: node.id });
          return false;
        }
        return (defined ?? direct) === "0";
      });
      if (candidates.length) {
        result.workflowCooperationDefault = entries;
        matchingMappings += candidates.length;
      }
      continue;
    }
    const sourceKey = KEYS[key];
    const direct = key === "directParticipantOverrides";
    const members = key === "templateAuthorizationOverrides" ? authorization : workflow;
    const selected = entries.filter((entry) => {
      const matches = members.filter((member) => direct
        ? !hasSourceEvidence(member) && member.id === entry.sourceTargetId
        : hasSourceEvidence(member) && member.sourceId === entry.sourceId);
      if (!matches.length) return false;
      const identities = new Set(matches.map((member) => identityKey(member, direct)));
      if (identities.size !== 1 || (direct && !String(matches[0].targetOrgType || "").trim())) {
        diagnostics.push({ level: "error", code: "batch.repair.mapping_identity_ambiguous", mapping: key, sourceId: entry[sourceKey] });
        return false;
      }
      return true;
    });
    matchingMappings += selected.length;
    if (!selected.length) continue;
    const merged = new Map((result[key] || []).map((entry) => [entry[sourceKey], entry]));
    for (const entry of selected) merged.set(entry[sourceKey], structuredClone(entry));
    result[key] = [...merged.values()];
  }
  return { options: result, matchingMappings, diagnostics };
}

function hasSourceEvidence(member) {
  return ["sourceId", "sourceOrgType", "sourceOrgClass", "sourceParentName", "sourceLoginName"]
    .some((key) => Object.hasOwn(member, key));
}

function identityKey(member, direct) {
  const normalize = (value) => String(value ?? "").trim();
  if (direct) return JSON.stringify([normalize(member.id), normalize(member.targetOrgType)]);
  const type = normalize(member.sourceOrgType);
  const login = normalize(member.sourceLoginName);
  return JSON.stringify([member.sourceId, type === "8" && login ? "" : normalize(member.name),
    type, normalize(member.sourceOrgClass), normalize(member.sourceParentName), login]);
}

export function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${label} contains unsupported field: ${unexpected}`);
}
