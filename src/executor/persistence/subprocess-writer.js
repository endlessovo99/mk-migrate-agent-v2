import { subProcessContract } from "../../dsl/subprocess.js";

export function buildNativeSubProcessFields(node) {
  const value = node.subProcess || {};
  const contract = subProcessContract(value);
  if (!String(contract.templateId || "").trim()) {
    const error = new Error("Subprocess target template must be resolved before persistence.");
    error.code = "projection.workflow.subprocess_template_unresolved";
    throw error;
  }
  const name = node.name || "子流程节点";
  const subProcess = {
    modelName: value.modelName || "",
    dictBean: value.dictBean || "",
    templateId: contract.templateId,
    templateName: value.templateName || "",
    createParam: value.createParam || ""
  };
  return {
    name,
    simpleName: name,
    scope: "sub_process",
    number: node.id,
    relateId: node.id,
    startIdentity: nativeSubProcessStartIdentity(value.startIdentity),
    ignoreOnEmptyDrafters: "true",
    startCountType: contract.startCountType,
    autoSubmit: contract.autoSubmit,
    flowType: contract.flowType,
    startParamConfig: contract.startParamConfig,
    recoverParamConfig: contract.recoverParamConfig,
    abandonSubProcessOnParentNodeEnd: "false",
    notifyAdminOnError: "false",
    notifyDrafterOnError: "false",
    canViewSubProcess: "true",
    canViewParentProcess: "true",
    notifyAdminOnAbandon: "false",
    notifyDrafterOnAbandon: "false",
    abandonOtherSubAndParentOnAbandon: "false",
    config: JSON.stringify({
      subProcess,
      startCountType: contract.startCountType,
      autoSubmit: contract.autoSubmit,
      flowType: contract.flowType,
      recovery: {
        recoverNodeId: contract.recoverNodeId,
        ...contract.recovery
      }
    }),
    language: { nameCn: name, nameUs: "Subprocess Node" }
  };
}

function nativeSubProcessStartIdentity(startIdentity) {
  const base = {
    id: "startIdentity",
    type: "org",
    source: "org",
    ruleKey: "",
    ruleName: "",
    members: [],
    element: "users"
  };
  if (startIdentity?.mode !== "explicit") {
    return { ...base, ...(startIdentity || {}) };
  }
  return {
    ...base,
    members: (startIdentity.members || []).map((member, index) => {
      const id = String(member?.id || "").trim();
      const name = String(member?.name || "").trim();
      const orgType = Number(member?.targetOrgType);
      if (!id || !name || !Number.isInteger(orgType)) {
        const error = new Error(`Subprocess start identity member ${index} must be resolved before persistence.`);
        error.code = "projection.workflow.subprocess_start_identity_unresolved";
        throw error;
      }
      return {
        id,
        name,
        element: "user",
        type: nativeMemberType(orgType)
      };
    })
  };
}

function nativeMemberType(orgType) {
  if (orgType === 8 || orgType === 256) return "1";
  if (orgType === 4 || orgType === 128) return "2";
  if (orgType === 32) return "4";
  return "3";
}
