import {draftSourceDraft} from "../translator/dsl-draft.js";
import {canonicalJson} from "./digest.js";

/** Rebuild ownership; never let reviewed DSL metadata choose the protected set. */
export function buildMigrationPolicyReviewProtection(sourceDraft, dslDraft) {
  const empty = {ok:true,targets:[],diagnostics:[]};
  if (!sourceDraft?.migrationPolicies && !dslDraft?.migrationPolicies && !dslDraft?.migrationPolicyAudit) return empty;
  try {
    if (!sourceDraft?.migrationPolicies || canonicalJson(sourceDraft.migrationPolicies) !== canonicalJson(dslDraft?.migrationPolicies)) throw new Error("The original approved source policy is required.");
    const rebuilt = draftSourceDraft(sourceDraft), audit = rebuilt.migrationPolicyAudit;
    if (audit?.version !== 2 || !Array.isArray(audit.fixedFields) || !Array.isArray(audit.audits)) throw new Error("The approved source policy audit cannot be rebuilt.");
    const targets = new Map();
    function add(scope, fieldId, columnId, actionId, reason) {
      const key = JSON.stringify([scope,fieldId,columnId,actionId]);
      const target = targets.get(key) || {scope,...(fieldId?{fieldId}:{}),...(columnId?{columnId}:{}),...(actionId?{actionId}:{}),reasons:[]};
      if (!target.reasons.includes(reason)) target.reasons.push(reason);
      targets.set(key,target);
    }
    for (const field of rebuilt.form?.fields || []) {
      if (audit.fixedFields.some(item=>item.key===field.id)) add("field",field.id,undefined,undefined,"approved-policy-fixed-field");
      for (const column of field.columns || []) if (audit.fixedFields.some(item=>item.key===field.id+"."+column.id)) add("column",field.id,column.id,undefined,"approved-policy-fixed-column");
    }
    for (const actionId of audit.changedActionIds || []) add("scriptAction",undefined,undefined,actionId,"approved-policy-fixed-action");
    for (const item of audit.audits) {
      if (item.kind !== "native-detail-import-replace" || item.status !== "applied" || !item.nativeImport) continue;
      const native = item.nativeImport;
      if (native.nativeEntranceFieldId) add("field",native.nativeEntranceFieldId,undefined,undefined,"approved-native-import-entrance");
      const decisions = rebuilt.migrationPolicies.decisions.filter(decision=>decision.id===item.decisionId&&decision.kind===item.kind);
      if (decisions.length !== 1) throw new Error("Native import decision ownership is ambiguous.");
      for (const fieldId of native.importFieldIds || []) add("column",decisions[0].tableId,fieldId,undefined,"approved-native-import-template-field");
      for (const effect of native.calculationPlan?.currencyEffects || []) add("scriptAction",undefined,undefined,effect.actionId,"approved-native-import-pure-calculation-source");
    }
    return {ok:true,targets:[...targets.values()],diagnostics:[]};
  } catch {
    return {ok:false,targets:[],diagnostics:[{level:"error",code:"agent.policy_review_protection_unavailable",path:"/migrationPolicyAudit",message:"Policy-owned review targets require an independently rebuilt original source policy."}]};
  }
}

export function isMigrationPolicyProtectedReviewTarget(protection, dslDraft, target) {
  if (!target?.ok && target?.ok !== undefined) return false;
  if (target?.scope === "scriptAction") {
    const id = dslDraft?.scripts?.actions?.[target.actionIndex]?.id;
    return protection.targets.some(item=>item.scope==="scriptAction"&&item.actionId===id);
  }
  const field = dslDraft?.form?.fields?.[target?.fieldIndex];
  if (!field) return false;
  if (protection.targets.some(item=>item.scope==="field"&&item.fieldId===field.id)) return true;
  const column = target.scope === "column" ? field.columns?.[target.columnIndex] : undefined;
  return Boolean(column && protection.targets.some(item=>item.scope==="column"&&item.fieldId===field.id&&item.columnId===column.id));
}
