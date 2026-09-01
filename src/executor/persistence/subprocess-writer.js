import { subProcessContract } from "../../dsl/subprocess.js";

export function buildNativeSubProcessFields(node) {
  const value = node.subProcess || {};
  const contract = subProcessContract(value);
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
    startIdentity: {
      id: "startIdentity",
      type: "org",
      source: "org",
      ruleKey: "",
      ruleName: "",
      members: [],
      element: "users",
      ...(value.startIdentity || {})
    },
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
