import {sha256Digest} from '../agent-review/digest.js';
import {preparePersistedTemplate} from './persistence.js';
import {attachRequiredTemplateNumberRuleReadback} from './template-number-rule.js';
import {prepareRequiredTemplateTheme} from './template-theme.js';
import {withoutMechanismTokens} from './published-form-patch.js';
// Native API values are JSON trees; normalize independent paths without aliasing.
const clone=value=>JSON.parse(JSON.stringify(value));
const requireValue=(ok,reason)=>{if(!ok)throw Object.assign(new Error(reason),{code:'authorization_closeout.'+reason});};
export const bundleDigest=bundle=>sha256Digest(withoutMechanismTokens(bundle));
export const isMissingWorkflowGraph=value=>value===undefined||value===null||value==='';

/** The caller receives a bound verifier, never a generally writable patch list. */
export function prepareAuthorizationCloseoutPlan({before,dsl,mode,categoryId,priorReport,currentTargets,restoration}){
 const t=before.template,w=before.workflow,binding=t.mechanisms.lbpmTemplate[0];
 const envelope={templateId:t.fdId,templateName:t.fdName,categoryId,tableName:t.fdTableName,
  lifecycle:{draft:true,unpublished:true,fdStatus:0,xformStatus:'draft',lbpmStatus:'draft',lbpmIsDraft:true},
  bindings:{formFdId:t.mechanisms['sys-xform'].fdId,workflowFdId:w.fdId}};
 const prepared=preparePersistedTemplate({dsl,envelope,baseTemplate:t});requireValue(prepared.ok,'projection_failed');
 const verify=bundle=>{
  const inspect=template=>{
   let r=attachRequiredTemplateNumberRuleReadback(prepared.verify(template),bundle.template);
   if(priorReport.readback?.theme)r=prepareRequiredTemplateTheme(prepared.update).verify(r,bundle.template);
   return r;
  };
  const bound=inspect(clone(bundle.template)),attached=clone(bundle.template);attached.mechanisms.lbpmTemplate=[clone(bundle.workflow)];
  const detail=inspect(attached),partitions=Object.fromEntries(['envelope','form','rules','scripts','workflow'].map(key=>[key,bound.partitions?.[key]==='verified'&&detail.partitions?.[key]==='verified'?'verified':'mismatch']));
  return {...detail,ok:bound.ok===true&&detail.ok===true,partitions,diagnostics:[...(bound.diagnostics||[]),...(detail.diagnostics||[])],workflowSurfaces:{bound:bound.partitions?.workflow,detail:detail.partitions?.workflow}};
 };
 const proposed=clone(before),everyone=dsl.runtime.nativeTemplateReadScope.everyone;
 if(mode==='repair_readers'){
  requireValue(Array.isArray(t.fdReaders)&&t.fdReaders.length>0,'no_formal_reader_delta');
  requireValue(sha256Digest(t.fdReaders.map(m=>m.fdId).sort())===sha256Digest((binding.fdReaders||[]).map(m=>m.fdId).sort())&&sha256Digest(t.fdReaders.map(m=>m.fdId).sort())===sha256Digest((w.fdReaders||[]).map(m=>m.fdId).sort()),'reader_binding_mismatch');
  proposed.template.fdReaders=[];proposed.template.mechanisms.lbpmTemplate[0].fdReaders=[];proposed.workflow.fdReaders=[];
  proposed.template.fdAllReaders=[{fdId:everyone.id,fdName:everyone.name}];
 }
 if(mode==='restore_graph'){
  const graph=restoration.before.workflow.fdContent;
  requireValue(isMissingWorkflowGraph(binding.fdContent)&&isMissingWorkflowGraph(w.fdContent),'graph_not_missing');
  requireValue(typeof graph==='string'&&graph.length>0&&restoration.before.template.mechanisms.lbpmTemplate[0].fdContent===graph,'retained_graph_mismatch');
  proposed.template.mechanisms.lbpmTemplate[0].fdContent=graph;proposed.workflow.fdContent=graph;
  requireValue(protectedAuthorizationDelta(restoration.before,proposed,currentTargets),'retained_graph_not_only_loss');
 }
 const readback=verify(proposed);
 if(!completeAuthorizationReadback(readback))throw Object.assign(new Error('full_readback_required'),{code:'authorization_closeout.full_readback_required',readback});
 const payload=clone(proposed.template);
 payload.fdReaders=[];payload.mechanisms.lbpmTemplate[0].fdReaders=[];
 // Draft update replaces the workflow binding: carry the exact graph, omit only the derived aggregate.
 delete payload.fdAllReaders;
 if(mode!=='finalize_record')requireValue(typeof payload.mechanisms.lbpmTemplate[0].fdContent==='string'&&payload.mechanisms.lbpmTemplate[0].fdContent.length>0&&payload.mechanisms.lbpmTemplate[0].fdContent===proposed.workflow.fdContent,'draft_graph_transport_required');
 if(mode==='repair_readers')requireValue(protectedAuthorizationDelta(before,proposed,currentTargets),'proposal_delta_outside_scope');
 return {payload,proposed,readback,verify,verifyProtected:after=>mode==='repair_readers'?protectedAuthorizationDelta(before,after,currentTargets):mode==='restore_graph'?protectedGraphRestorationDelta(before,after,restoration.before.workflow.fdContent,currentTargets):bundleDigest(before)===bundleDigest(after),
  summary:{mode,changedPaths:mode==='repair_readers'?['/fdReaders','/mechanisms/lbpmTemplate/0/fdReaders']:mode==='restore_graph'?['/mechanisms/lbpmTemplate/0/fdContent']:[],derivedPaths:mode==='repair_readers'?['/fdAllReaders']:[],omittedTransportPaths:mode!=='finalize_record'?['/fdAllReaders']:[],unchangedGraphTransport:mode==='repair_readers',graphDigest:mode==='restore_graph'?sha256Digest(restoration.before.workflow.fdContent):null,workflowWrites:0,recordWrites:mode==='finalize_record'?1:0}};
}
export function completeAuthorizationReadback(r){return r?.ok===true&&['envelope','form','rules','scripts','workflow'].every(p=>r.partitions?.[p]==='verified')&&r.numberRule?.status==='verified';}

/** Only observed native audit paths and typed ID-only editor references normalize. */
export function protectedAuthorizationDelta(before,after,currentTargets){
 try{
  const left=withoutMechanismTokens(clone(before)),right=withoutMechanismTokens(clone(after));
  requireValue(left.template.fdId===right.template.fdId&&left.workflow.fdId===right.workflow.fdId,'identity_changed');
  for(const b of [left,right]){
   requireValue(Array.isArray(b.template.fdReaders)&&Array.isArray(b.template.fdAllReaders),'native_authorization_missing');
   delete b.template.fdReaders;delete b.template.fdAllReaders;
   delete b.template.mechanisms.lbpmTemplate[0].fdReaders;delete b.workflow.fdReaders;
  }
  requireValue(after.template.fdReaders.length===0&&(after.template.mechanisms.lbpmTemplate[0].fdReaders||[]).length===0&&(after.workflow.fdReaders||[]).length===0,'formal_readers_not_empty');
  const time=(a,b,key)=>{requireValue(validTime(a[key])&&validTime(b[key])&&b[key]>=a[key],'native_audit_invalid');delete a[key];delete b[key];};
  time(left.template,right.template,'fdAlterTime');
  const lx=left.template.mechanisms['sys-xform'],rx=right.template.mechanisms['sys-xform'];time(lx,rx,'fdAlterTime');
  const lc=JSON.parse(lx.fdConfig),rc=JSON.parse(rx.fdConfig),main=lc.dataModel.filter(m=>m.fdId===left.template.fdId&&m.fdTableName===left.template.fdTableName);
  requireValue(main.length===1,'main_model_identity_unproven');const index=lc.dataModel.indexOf(main[0]),other=rc.dataModel[index];requireValue(other?.fdId===main[0].fdId&&other.fdTableName===main[0].fdTableName,'main_model_identity_changed');time(main[0],other,'fdAlterTime');
  requireValue(lc.dataModel.length===rc.dataModel.length,'model_collection_changed');
  const identities=lc.dataModel.map(m=>m.fdId+'#'+m.fdTableName);requireValue(new Set(identities).size===identities.length,'model_identity_ambiguous');
  for(let i=0;i<lc.dataModel.length;i++)if(i!==index)normalizeDetailAudit(lc.dataModel[i],rc.dataModel[i],before,after);
  lx.fdConfig=lc;rx.fdConfig=rc;
  for(const [a,b] of [[left.template.mechanisms.lbpmTemplate[0],right.template.mechanisms.lbpmTemplate[0]],[left.workflow,right.workflow]])normalizeEditorReferences(a,b,currentTargets);
  return sha256Digest(left)===sha256Digest(right);
 }catch{return false;}
}
function validTime(t){return Number.isSafeInteger(t)&&t>=0&&new Date(t).getTime()===t;}
function normalizeEditorReferences(left,right,targets){
 requireValue(Array.isArray(left.fdEditors)&&Array.isArray(right.fdEditors)&&left.fdEditors.length===right.fdEditors.length,'editor_binding_changed');
 const ordered=members=>members.sort((a,b)=>String(a.fdId).localeCompare(String(b.fdId)));
 ordered(left.fdEditors);ordered(right.fdEditors);
 for(let i=0;i<left.fdEditors.length;i++){
  const a=left.fdEditors[i],b=right.fdEditors[i],target=targets.find(t=>t.fdId===a.fdId);
  requireValue(a.fdId===b.fdId&&target&&typeof target.fdIsAvailable==='boolean'&&target.fdIsBusiness===true&&Number(target.fdOrgType)===8,'editor_reference_unverified');
  for(const member of [a,b])requireValue(Object.keys(member).every(k=>['fdId','fdName','fdOrgType'].includes(k))&&(member.fdOrgType===undefined||Number(member.fdOrgType)===8),'editor_reference_shape_invalid');
  if(a.fdName!==undefined)requireValue(a.fdName===target.fdName,'editor_display_identity_changed');
  requireValue(b.fdName===undefined||b.fdName===a.fdName,'editor_display_identity_changed');
  delete a.fdName;delete b.fdName;delete a.fdOrgType;delete b.fdOrgType;
 }
}

function protectedGraphRestorationDelta(before,after,graph,targets){
 const expected=clone(before);expected.template.mechanisms.lbpmTemplate[0].fdContent=graph;expected.workflow.fdContent=graph;
 if(after.template.mechanisms.lbpmTemplate[0].fdContent!==graph||after.workflow.fdContent!==graph)return false;
 for(const [a,b] of [[before.template,after.template],[before.template.mechanisms.lbpmTemplate[0],after.template.mechanisms.lbpmTemplate[0]],[before.workflow,after.workflow]])if(sha256Digest(a.fdReaders)!==sha256Digest(b.fdReaders))return false;
 if(sha256Digest(before.template.fdAllReaders)!==sha256Digest(after.template.fdAllReaders))return false;
 return protectedAuthorizationDelta(expected,after,targets);
}

/** Native update initializes only audit metadata on otherwise identical detail models. */
function normalizeDetailAudit(left,right,before,after){
 requireValue(left.fdId&&left.fdTableName&&right?.fdId===left.fdId&&right.fdTableName===left.fdTableName,'detail_model_identity_changed');
 const actor=after.template.fdAlter,from=after.template.fdAlterTime,to=after.template.mechanisms['sys-xform'].fdAlterTime;
 for(const key of ['fdAlter','fdAlterTime','fdDeletedFields']){
  if(sha256Digest(left[key]??null)===sha256Digest(right[key]??null))continue;
  if(key==='fdAlter')requireValue(!Object.hasOwn(left,key)&&actor?.fdId&&sha256Digest(right[key])===sha256Digest(actor)&&sha256Digest(before.template.fdAlter)===sha256Digest(actor),'detail_audit_actor_unproven');
  if(key==='fdAlterTime')requireValue(validTime(right[key])&&right[key]>=from&&right[key]<=to&&(!Object.hasOwn(left,key)||validTime(left[key])&&right[key]>=left[key]),'detail_audit_time_invalid');
  if(key==='fdDeletedFields')requireValue(!Object.hasOwn(left,key)&&Array.isArray(right[key])&&right[key].length===0,'detail_deleted_fields_changed');
  delete left[key];delete right[key];
 }
}
