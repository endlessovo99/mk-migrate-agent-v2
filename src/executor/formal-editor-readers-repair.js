import {createHash} from "node:crypto";
import {stableStringify} from "./persistence/normalize.js";
import {preparePersistedTemplate, INVARIANT_VERSION} from "./persistence.js";
import {attachRequiredTemplateNumberRuleReadback} from "./template-number-rule.js";
import {resolveWorkflowCooperation} from "./workflow-cooperation.js";
import {withoutMechanismTokens} from "./published-form-patch.js";

export const FORMAL_EDITOR_READERS_PROFILE = "formal-editor-readers-only";
const COLLECTIONS = ["readers", "editors", "allReaders", "allEditors", "temporaryReaders", "temporaryEditors"];
const NATIVE = {readers:"fdReaders",editors:"fdEditors",allReaders:"fdAllReaders",allEditors:"fdAllEditors",temporaryReaders:"fdTmpReaders",temporaryEditors:"fdTmpEditors"};
const SOURCE_KEYS = ["sourceId","sourceOrgType","sourceOrgClass","sourceParentName","sourceLoginName","sourceRef"];
const MISMATCH = "readback.workflow.template_authorization_mismatch";
const PERSON = "com.landray.kmss.sys.organization.model.SysOrgPerson";
const text = value => typeof value === "string" && value.length > 0 && value.trim() === value;
const same = (left,right) => stableStringify(left) === stableStringify(right);
const hash = value => createHash("sha256").update(stableStringify(value)).digest("hex");
const requireValue = (condition,reason) => {if (!condition) throw Object.assign(new Error(reason),{code:`locked_draft.formal_readers_${reason}`});};
const ids = members => members.map(member=>member.fdId).sort();
const set = values => [...new Set(values)].sort();
const errorEntries = report => (report?.diagnostics||[]).filter(entry=>entry?.level === "error");

/** Rebuild only previously retained same-ID/person-fallback bindings; never search or choose a fallback. */
export function restoreFormalEditorReaderAuthorization(dsl,sourceDraft,report) {
 try {
  const {expected,actual}=retainedMismatch(report);
  const auth=dsl?.template?.authorization;
  requireValue(auth && same(auth,sourceDraft?.template?.authorization),"source_authorization_mismatch");
  requireValue(typeof auth.readerFlag === "boolean" && COLLECTIONS.every(key=>Array.isArray(auth[key])),"source_shape");
  requireValue(["readers","temporaryReaders","temporaryEditors"].every(key=>auth[key].length===0) && auth.editors.length>0 && auth.allEditors.length>0 && auth.allReaders.length>0,"source_shape");
  const stage=oneStage(report,"resolveWorkflowParticipants");
  const typed=stage.fallbackTargetsByOrgType;
  requireValue(typed && same(Object.keys(typed),["8"]),"typed_fallback_required");
  const fallback=typed["8"];
  requireValue(same(Object.keys(fallback).sort(),["sourceOrgType","targetFdId","targetOrgType","targetName"].sort()) && fallback.sourceOrgType===8 && fallback.targetOrgType===8 && text(fallback.targetFdId) && text(fallback.targetName),"typed_fallback_required");
  requireValue(expected.editors.includes(fallback.targetFdId) && stage.fallbackTargetId===fallback.targetFdId && same(stage.fallbackTargetIds,[fallback.targetFdId]),"typed_fallback_mismatch");
  for(const key of ["overrides","templateAuthorizationOverrides","directOverrides","directTargetFallbacks","departmentIdResolutions"])
   requireValue(stage[key]===undefined || Array.isArray(stage[key])&&stage[key].length===0,"mixed_resolution_scope");
  for(const key of ["overrideCount","overrideIdentityCount","templateAuthorizationOverrideCount","templateAuthorizationOverrideIdentityCount","directOverrideCount","directOverrideIdentityCount","directTargetFallbackCount","directTargetFallbackIdentityCount"])
   requireValue(stage[key]===undefined || stage[key]===0,"mixed_resolution_scope");
  const sourceById=new Map(),bindings=[],missingIds=new Set();
  for(const key of COLLECTIONS){
   const seen=new Set();
   for(const [index,member] of auth[key].entries()){
    requireValue(member?.type==="user_or_org" && !member.id && text(member.sourceId) && text(member.name) && text(member.sourceRef) && member.sourceOrgType===8 && member.sourceOrgClass===PERSON && (text(member.sourceLoginName)||text(member.sourceParentName)) && !seen.has(member.sourceId),"source_identity_unproven");
    seen.add(member.sourceId);
    const sourceIdentity=Object.fromEntries(["sourceId","name","sourceOrgType","sourceOrgClass","sourceParentName","sourceLoginName"].filter(k=>Object.hasOwn(member,k)).map(k=>[k,member[k]]));
    requireValue(!sourceById.has(member.sourceId)||same(sourceById.get(member.sourceId),sourceIdentity),"source_identity_conflict");
    sourceById.set(member.sourceId,sourceIdentity);
    const sameId=expected.editors.includes(member.sourceId);
    const targetId=sameId?member.sourceId:fallback.targetFdId;
    if(!sameId)missingIds.add(member.sourceId);
    requireValue(text(member.sourceLoginName),"source_login_required");
    bindings.push({path:`/template/authorization/${key}/${index}`,collection:key,index,sourceId:member.sourceId,sourceLoginName:member.sourceLoginName,sourceRef:member.sourceRef,targetId,targetOrgType:8,basis:sameId?"retained-same-id":"retained-typed-person-fallback"});
   }
  }
  requireValue(!sourceById.has(fallback.targetFdId),"fallback_source_collision");
  const directTargets=workflowTargets(dsl);
  const fallbackReferences=bindings.filter(binding=>binding.basis==="retained-typed-person-fallback").length;
  requireValue(missingIds.size>0 && stage.fallbackIdentityCount===missingIds.size && stage.fallbackCount===fallbackReferences && stage.resolvedCount===bindings.length && stage.identityCount===sourceById.size+directTargets.size,"resolution_counts_mismatch");
  const warnings=(report.diagnostics||[]).filter(entry=>entry?.code==="workflow.participant_sit_fallback_applied");
  const detail=warnings[0]?.details;
  requireValue(warnings.length===1 && warnings[0].level==="warning" && detail && detail.referenceCount===fallbackReferences && detail.identityCount===missingIds.size && same(detail.targetFdIds,[fallback.targetFdId]) && same(detail.targetsByOrgType,typed) && !["directTargetReferenceCount","directTargetIdentityCount","directTargetFallbacks"].some(key=>Object.hasOwn(detail,key)),"fallback_warning_mismatch");
  requireValue(!(report.diagnostics||[]).some(entry=>["workflow.participant_explicit_override_applied","template.authorization_explicit_override_applied","workflow.participant_direct_override_applied","workflow.condition_org_sit_fallback_applied"].includes(entry?.code)),"mixed_resolution_scope");
  const condition=oneStage(report,"resolveConditionOrgs");
  requireValue(["resolvedCount","nameCount","fdNoCount"].every(key=>condition[key]===0) && noFallback(condition),"condition_resolution_scope");
  const next=structuredClone(dsl);
  for(const binding of bindings){
   const member=next.template.authorization[binding.collection][binding.index];
   Object.assign(member,{id:binding.targetId,targetOrgType:8,...(binding.basis==="retained-typed-person-fallback"?{name:fallback.targetName}:{})});
   for(const key of SOURCE_KEYS)delete member[key];
  }
  for(const key of COLLECTIONS)next.template.authorization[key]=next.template.authorization[key].filter((member,index,members)=>members.findIndex(other=>other.id===member.id)===index);
  const projected=projectAuthorization(next.template.authorization);
  requireValue(same(projected,expected),"source_projection_mismatch");
  const targets=new Map(directTargets);
  for(const id of expected.editors){requireValue(!targets.has(id)||targets.get(id)===8,"target_type_conflict");targets.set(id,8);}
  return {ok:true,dsl:next,context:{expected,actual,fallback,targets:[...targets].sort(([a],[b])=>a.localeCompare(b)),bindings},audit:[{profile:FORMAL_EDITOR_READERS_PROFILE,priorReportDigest:hash(report),sourceAuthorizationDigest:hash(auth),bindings,fallbackIdentityCount:missingIds.size,fallbackReferenceCount:fallbackReferences,workflowParticipantsPreserved:true}]};
 }catch(error){return {ok:false,diagnostics:[{level:"error",code:error.code||"locked_draft.formal_readers_evidence_invalid",message:"Retained formal-editor reading authorization cannot be reconstructed without changing identities.",path:"/priorExecutionReport"}]};}
}

export async function validateFormalReaderCurrentTargets(client,context){
 requireValue(typeof client?.getElementInfo==="function","identity_lookup_required");
 const expectedIds=context.targets.map(([id])=>id),elements=await client.getElementInfo(expectedIds);
 requireValue(Array.isArray(elements)&&elements.length===expectedIds.length&&same(set(elements.map(member=>member?.fdId)),[...expectedIds].sort()),"current_identity_mismatch");
 const current=[];
 for(const [id,type] of context.targets){
  const matches=elements.filter(member=>member?.fdId===id),member=matches[0];
  requireValue(matches.length===1&&text(member.fdName)&&Number(member.fdOrgType)===type&&member.fdIsAvailable===true,"current_identity_mismatch");
  current.push({fdId:id,fdName:member.fdName,fdOrgType:type,fdIsAvailable:true,...(text(member.fdNo)?{fdNo:member.fdNo}:{})});
 }
 for(const binding of context.bindings){
  const matches=elements.filter(member=>context.expected.editors.includes(member.fdId)&&Number(member.fdOrgType)===8&&member.fdNo===binding.sourceLoginName);
  requireValue(binding.basis==="retained-same-id"?matches.length===1&&matches[0].fdId===binding.targetId:matches.length===0,"current_source_identity_mismatch");
 }
 return current;
}

/** Replay the recorded projection through its original compiler with retained configuration only. */
export async function restoreFormalReaderWorkflowCooperation(dsl,report){
 const prior=oneStage(report,"resolveWorkflowCooperation"),config=prior.config;
 requireValue(config&&config.endpoint==="/data/sys-lbpm/lbpmConfig/getConfigs"&&config.baseUrl===report.baseUrl&&["1","2","3"].includes(config.nodeHandlerTurningWay)&&text(config.checkedAt)&&new Date(config.checkedAt).toISOString()===config.checkedAt,"cooperation_evidence_invalid");
 const restored=await resolveWorkflowCooperation(dsl,{client:{getWorkflowCooperationConfig:async()=>({nodeHandlerTurningWay:config.nodeHandlerTurningWay})},workflowCooperationDefault:config.nodeHandlerTurningWay,targetBaseUrl:report.baseUrl,now:new Date(config.checkedAt)});
 requireValue(same(restored.nodes,prior.nodes)&&restored.fallbackCount===prior.fallbackCount&&same(restored.config,config),"cooperation_evidence_mismatch");
 return {dsl:restored.dsl,audit:{profile:FORMAL_EDITOR_READERS_PROFILE,kind:"retained-workflow-cooperation",nodes:restored.nodes,config:restored.config,priorReportDigest:hash(report)}};
}

/** All content except the exact top-level collection is protected, including the workflow detail. */
export function prepareFormalEditorReadersRepair({before,dsl,priorExecutionReport,envelope,retainedAuthorization}){
 const evidence=retainedMismatch(priorExecutionReport),expected=evidence.expected;
 requireValue(retainedAuthorization&&same(retainedAuthorization.expected,expected),"restoration_context_required");
 const current=Object.fromEntries(COLLECTIONS.map(key=>[key,nativeIds(before.template?.[NATIVE[key]])]));
 requireValue(auditTimes(before).every(validAuditTime),"native_audit_time_unproven");
 requireValue(same(current,evidence.actual),"snapshot_authorization_mismatch");
 requireValue(same(current.editors,expected.allReaders)&&same(current.allEditors,expected.allReaders),"current_editor_set_mismatch");
 const projection=preparePersistedTemplate({dsl,envelope,baseTemplate:before.template});
 requireValue(projection.ok,"projection_failed");
 const prior=numberedReadback(projection,before);
 const errors=errorEntries(prior);
 requireValue(errors.length===1&&errors[0].code===MISMATCH&&same(errors[0].details?.expected,expected)&&same(errors[0].details?.actual,evidence.actual)&&same(prior.partitions,priorExecutionReport.readback.partitions)&&prior.numberRule?.status==="verified","current_invariant_mismatch");
 const template=structuredClone(before.template);
 const targetById=new Map(retainedAuthorization.currentTargets.map(member=>[member.fdId,member]));
 template.fdAllReaders=expected.allReaders.map(id=>{const member=targetById.get(id);requireValue(member?.fdOrgType===8&&member.fdIsAvailable===true,"current_identity_mismatch");return {fdId:id,fdName:member.fdName,fdOrgType:8};});
 const proposed={template,workflow:structuredClone(before.workflow)};
 requireValue(!same(nativeIds(before.template.fdAllReaders),nativeIds(template.fdAllReaders))&&hash(protectedBundle(before))===hash(protectedBundle(proposed)),"delta_outside_scope");
 const complete=numberedReadback(projection,proposed);
 requireValue(complete.ok===true&&["envelope","form","rules","scripts","workflow"].every(key=>complete.partitions?.[key]==="verified")&&complete.numberRule?.status==="verified","proposed_invariant_mismatch");
 // Mechanism tokens are transport capabilities and are omitted only from evidence fingerprints.
 return {before,template,plan:{repairKind:"template_authorization",authorizationProfile:FORMAL_EDITOR_READERS_PROFILE,targetTemplateId:template.fdId,changedPaths:["/fdAllReaders"],expectedIds:expected.allReaders,protectedBundleDigest:hash(withoutMechanismTokens(protectedBundle(before))),priorReportDigest:hash(priorExecutionReport)},verify(after){
  const authorizationOk=same(Object.fromEntries(COLLECTIONS.map(key=>[key,nativeIds(after.template?.[NATIVE[key]])])),expected);
  const previous=auditTimes(before),current=auditTimes(after);
  const nativeAuditTimesOk=previous.every((value,index)=>validAuditTime(value)&&validAuditTime(current[index])&&current[index]>=value);
  const protectedOk=nativeAuditTimesOk&&hash(afterProtectedBundle(before))===hash(afterProtectedBundle(after));
  return {ok:authorizationOk&&protectedOk,checks:{authorizationOk,protectedOk,nativeAuditTimesOk}};
 }};
}

function retainedMismatch(report){
 const errors=errorEntries(report),mismatch=errors[0],readback=report?.readback,readErrors=errorEntries(readback);
 requireValue(report?.ok===false&&report.status==="readback_failed"&&report.stage==="readback"&&report.failedAt==="readback"&&report.writeOutcomeUnknown===false&&report.transferRecord==null&&!report.apiStages?.some(stage=>stage.writeOutcomeUnknown===true||stage.status!=="ok"),"prior_execution_ineligible");
 requireValue(errors.length===1&&mismatch?.code===MISMATCH&&readback?.ok===false&&readback.invariantVersion===INVARIANT_VERSION&&readErrors.length===1&&readErrors[0].code===MISMATCH&&same(mismatch.details,readErrors[0].details)&&same(readback.workflow?.templateAuthorization,mismatch.details?.actual),"prior_readback_inconsistent");
 requireValue(readback.numberRule?.status==="verified"&&same(readback.partitions,{envelope:"verified",form:"verified",rules:"verified",scripts:"verified",workflow:"mismatch"}),"prior_readback_incomplete");
 const expected=mismatch.details?.expected,actual=mismatch.details?.actual;
 for(const value of [expected,actual])requireValue(value&&same(Object.keys(value).sort(),[...COLLECTIONS].sort())&&COLLECTIONS.every(key=>Array.isArray(value[key])&&value[key].every(text)&&same(value[key],set(value[key]))),"prior_collection_shape");
 requireValue(expected.editors.length>0&&same(expected.editors,expected.allEditors)&&same(expected.editors,expected.allReaders)&&["readers","temporaryReaders","temporaryEditors"].every(key=>expected[key].length===0),"expected_editor_set_mismatch");
 requireValue(COLLECTIONS.filter(key=>key!=="allReaders").every(key=>same(expected[key],actual[key]))&&!same(expected.allReaders,actual.allReaders),"prior_delta_outside_scope");
 return {expected,actual};
}
function workflowTargets(dsl){
 const targets=new Map();
 for(const node of dsl?.workflow?.nodes||[]){
  const participants=node?.participants;
  requireValue(participants&&["empty","explicit"].includes(participants.mode),"workflow_resolution_scope");
  for(const collection of ["members","alternativeMembers"])for(const member of participants[collection]||[]){
   requireValue(member&&text(member.id)&&text(member.name)&&Number.isInteger(member.targetOrgType)&&!SOURCE_KEYS.some(key=>Object.hasOwn(member,key)),"workflow_resolution_scope");
   requireValue(!targets.has(member.id)||targets.get(member.id)===member.targetOrgType,"workflow_resolution_scope");
   targets.set(member.id,member.targetOrgType);
  }
 }
 return targets;
}
function projectAuthorization(auth){const editors=set([...auth.editors,...auth.allEditors].map(member=>member.id)),editorSet=new Set(editors);return {readers:set([...auth.readers,...auth.allReaders.filter(member=>!editorSet.has(member.id))].map(member=>member.id)),editors,allReaders:set([...auth.allReaders.map(member=>member.id),...editors]),allEditors:set(auth.allEditors.map(member=>member.id)),temporaryReaders:set(auth.temporaryReaders.map(member=>member.id)),temporaryEditors:set(auth.temporaryEditors.map(member=>member.id))};}
function noFallback(stage){return Object.entries(stage).filter(([key])=>key.startsWith("fallback")).every(([key,value])=>["fallbackCount","fallbackIdentityCount"].includes(key)?value===0:key==="fallbackTargetId"?value==="":["fallbackTargetIds","fallbackNames","fallbackFdNos","fallbackOrgs"].includes(key)?Array.isArray(value)&&value.length===0:key==="fallbackTargetsByOrgType"?same(value,{}):false);}
function oneStage(report,name){const stages=(report.apiStages||[]).filter(stage=>stage.name===name);requireValue(stages.length===1&&stages[0].status==="ok","resolution_stage");return stages[0];}
function nativeIds(value){requireValue(Array.isArray(value)&&value.every(member=>text(member?.fdId))&&new Set(value.map(member=>member.fdId)).size===value.length,"snapshot_collection_shape");return ids(value);}
function protectedBundle(bundle){const copy=structuredClone(bundle);delete copy.template.fdAllReaders;return copy;}
function auditTimes(bundle){return [bundle?.template?.fdAlterTime,bundle?.template?.mechanisms?.["sys-xform"]?.fdAlterTime];}
function validAuditTime(value){return typeof value==="number"&&Number.isSafeInteger(value)&&value>=0&&new Date(value).getTime()===value;}
function afterProtectedBundle(bundle){const copy=withoutMechanismTokens(protectedBundle(bundle));delete copy.template.fdAlterTime;delete copy.template.mechanisms["sys-xform"].fdAlterTime;return copy;}
function numberedReadback(projection,bundle){const attached=structuredClone(bundle.template);attached.mechanisms.lbpmTemplate=[structuredClone(bundle.workflow)];return attachRequiredTemplateNumberRuleReadback(projection.verify(attached),bundle.template);}
