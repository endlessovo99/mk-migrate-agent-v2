import {existsSync,mkdirSync,statSync,writeFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {sha256Digest} from '../agent-review/digest.js';
import {engineDigest} from '../batch/contracts.js';
import {checkTrust} from '../dsl/trust.js';
import {buildDryRunPlan} from './dry-run.js';
import {NewoaClient,normalizeBaseUrl} from './newoa-client.js';
import {hasUnknownNativeWrite} from './authorization-closeout-evidence.js';
import {withoutMechanismTokens} from './published-form-patch.js';
import {createLockedDraftState} from './locked-draft-state.js';
import {prepareChoiceOtherRepair,CHOICE_OTHER_NATIVE_ORG_TYPES} from './choice-other-repair-plan.js';

const OPERATION='source-bound-checkbox-other-draft-update';
const same=(left,right)=>sha256Digest(left??null)===sha256Digest(right??null);
const text=value=>typeof value==='string'&&value.length>0&&value.trim()===value;
const need=(condition,reason)=>{if(!condition)throw Object.assign(new Error(reason),{code:'choice_other_repair.'+reason});};
const digest=value=>sha256Digest(withoutMechanismTokens(value));
const save=(directory,name,value)=>writeFileSync(join(directory,name),JSON.stringify(withoutMechanismTokens(value),null,2)+'\n',{flag:'wx',mode:0o600,flush:true});

/** One explicitly scoped update of a successfully migrated, registered draft. */
export async function repairChoiceOther(dsl,options={}){
 const apiStages=[];
 let started=false,acknowledged=false,artifacts,state,plan,evidenceDigest,snapshotDigest,readback;
 const base=()=>({baseUrl:options.baseUrl,templateId:options.targetTemplateId,createdFdIds:[],updatedFdIds:acknowledged?[options.targetTemplateId]:[],apiStages});
 const stage=async(name,operation)=>{const entry={name,status:'started'};apiStages.push(entry);try{const result=await operation();entry.status='ok';return result;}catch(error){entry.status='failed';throw error;}};
 const record=(status)=>state?.record(status,{templateWriteStarted:started,templateWriteCompleted:acknowledged,templateWriteOutcomeUnknown:started&&!acknowledged,transferRecordStarted:false,transferRecordCompleted:false,transferRecordOutcomeUnknown:false});
 try{
  validateArtifacts(dsl,options);
  const dryRun=buildDryRunPlan(dsl);need(dryRun.ok,'dry_run_failed');
  const client=options.client||new NewoaClient({baseUrl:options.baseUrl});
  await stage('login',()=>client.login(options.credentials));
  const before=await stage('firstStableRead',()=>readTarget(client,options));
  const second=await stage('secondStableRead',()=>readTarget(client,options));
  snapshotDigest=digest(before);need(snapshotDigest===digest(second),'snapshot_changed');
  const references=currentPrincipalReferences(before),principalIds=[...new Set(references.map(({reference})=>reference.fdId))].sort();
  const currentTargets=principalIds.length?await stage('validateCurrentEditors',()=>client.getElementInfo(principalIds,{builtinEvidence:true})):[];
  validateCurrentPrincipals(references,principalIds,currentTargets);
  currentTargets.sort((a,b)=>a.fdId.localeCompare(b.fdId));
  const afterEditors=await stage('postEditorRead',()=>readTarget(client,options));
  need(digest(afterEditors)===snapshotDigest,'post_editor_snapshot_changed');
  plan=prepareChoiceOtherRepair({priorDsl:options.priorDsl,dsl,before:afterEditors,categoryId:options.targetCategoryId,currentTargets});
  const bindings={operation:OPERATION,sourceDraft:options.sourceDraft,priorSourceDraft:options.priorSourceDraft,dsl,priorDsl:options.priorDsl,priorExecutionReport:options.priorExecutionReport,scope:options.scope,engineDigest:options.expectedEngineDigest,baseUrl:options.baseUrl,targetTemplateId:options.targetTemplateId,targetCategoryId:options.targetCategoryId,snapshotDigest,currentTargets,plan:plan.summary,payloadDigest:digest(plan.payload)};
  evidenceDigest=sha256Digest(bindings);
  if(options.confirmWrite!==true)return {...base(),ok:true,status:'choice_other_repair_ready',evidenceDigest,snapshotDigest,plan:plan.summary,diagnostics:[]};
  need(options.expectedEvidenceDigest===evidenceDigest,'evidence_digest_mismatch');
  need(text(options.artifactsDir)&&isAbsolute(options.artifactsDir)&&!existsSync(options.artifactsDir),'unused_private_artifacts_required');
  need(engineDigest()===options.expectedEngineDigest,'engine_changed');
  mkdirSync(options.artifactsDir,{recursive:true,mode:0o700});artifacts=options.artifactsDir;
  need((statSync(artifacts).mode&0o077)===0,'artifacts_not_private');
  state=createLockedDraftState({baseUrl:options.baseUrl,targetTemplateId:options.targetTemplateId,operation:OPERATION,evidenceDigest,artifactsDir:artifacts,testLockRoot:options.testLockRoot,allowTestLockRoot:Boolean(options.client)&&options.allowTestLockRoot===true});
  save(artifacts,'before.json',second);save(artifacts,'plan.json',{evidenceDigest,snapshotDigest,summary:plan.summary,bindings});
  save(artifacts,'payload.json',plan.payload);
  const intent={operation:OPERATION,baseUrl:options.baseUrl,targetTemplateId:options.targetTemplateId,targetCategoryId:options.targetCategoryId,evidenceDigest,snapshotDigest,payloadDigest:digest(plan.payload),workflowWrites:0,recordWrites:0};
  save(artifacts,'intent.json',intent);
  // Persist the permanent unknown state before sending. An interruption consumes
  // the claim; changing the directory or approved digest cannot replay it.
  const prewrite=await stage('prewriteRead',()=>readTarget(client,options));
  save(artifacts,'prewrite.json',prewrite);
  need(digest(prewrite)===snapshotDigest,'prewrite_snapshot_changed');
  need(engineDigest()===options.expectedEngineDigest,'engine_changed');
  state.record('template_write_started',{templateWriteStarted:true,templateWriteCompleted:false,templateWriteOutcomeUnknown:true,transferRecordStarted:false,transferRecordCompleted:false,transferRecordOutcomeUnknown:false});
  started=true;
  const receipt=await stage('updateTemplate',()=>client.updateTemplate(plan.payload));acknowledged=true;
  save(artifacts,'receipt.json',{acknowledged:true,intent,receipt:receipt??null});record('awaiting_readback');
  const after=await stage('firstAfterRead',()=>readTarget(client,options));save(artifacts,'after.first.json',after);
  const after2=await stage('secondAfterRead',()=>readTarget(client,options));save(artifacts,'after.json',after2);
  need(digest(after)===digest(after2),'postwrite_snapshot_changed');
  readback=plan.verify(after2);need(plan.verifyProtected(after2),'protected_state_changed');
  need(readback.ok===true&&['envelope','form','rules','scripts','workflow'].every(partition=>readback.partitions?.[partition]==='verified'),'postwrite_readback_failed');
  const result={...base(),ok:true,status:'choice_other_repaired',writeOutcomeUnknown:false,writeAcknowledged:true,evidenceDigest,snapshotDigest,readback,plan:plan.summary,transferRecord:{...options.priorExecutionReport.transferRecord,status:'preserved'},artifactsDir:artifacts,diagnostics:[]};
  save(artifacts,'result.json',result);record('verified');return result;
 }catch(error){
  // Receipt and result persistence can fail too. Keep the distinction between a
  // known acknowledgement and an ambiguous request without attempting rollback.
  const result={...base(),ok:false,status:started&&!acknowledged?'outcome_unknown':started?'readback_failed':'blocked',writeOutcomeUnknown:started&&!acknowledged,writeAcknowledged:acknowledged,evidenceDigest:evidenceDigest||null,snapshotDigest:snapshotDigest||null,readback:readback||null,plan:plan?.summary||null,diagnostics:[{level:'error',code:typeof error?.code==='string'&&error.code.startsWith('choice_other_repair.')?error.code:error?.code==='EEXIST'?'choice_other_repair.permanent_lock_exists':'choice_other_repair.failed',message:'Scoped Other repair stopped; no retry or rollback was attempted.',path:'/choiceOtherRepair'}],...(artifacts?{artifactsDir:artifacts}:{})};
  try{record(result.status);}catch{/* Preserve the original permanent intent if storage is unavailable. */}
  if(artifacts&&!existsSync(join(artifacts,'result.json')))try{save(artifacts,'result.json',result);}catch{/* The permanent lock still forbids replay. */}
  return result;
 }
}

function validateArtifacts(dsl,o){
 need(text(o.baseUrl)&&normalizeBaseUrl(o.baseUrl)===o.baseUrl,'origin_invalid');
 need(o.client?.baseUrl===undefined||o.client.baseUrl===o.baseUrl,'client_origin_mismatch');
 need(text(o.targetTemplateId)&&text(o.targetCategoryId)&&text(o.credentials?.username)&&text(o.credentials?.encryptedPassword),'target_and_credentials_required');
 need(o.testLockRoot===undefined||Boolean(o.client)&&!(o.client instanceof NewoaClient)&&o.allowTestLockRoot===true,'test_lock_permission_required');
 need(o.expectedDslDigest===sha256Digest(dsl)&&o.expectedPriorDslDigest===sha256Digest(o.priorDsl)&&o.expectedSourceDigest===sha256Digest(o.sourceDraft)&&o.expectedPriorReportDigest===sha256Digest(o.priorExecutionReport)&&o.expectedScopeDigest===sha256Digest(o.scope),'artifact_digest_mismatch');
 need(o.expectedEngineDigest===engineDigest(),'engine_digest_mismatch');
 need(same(o.sourceDraft,o.priorSourceDraft)&&o.priorDsl?.trust?.digests?.sourceDraft===sha256Digest(o.priorSourceDraft),'historical_source_mismatch');
 need(dsl?.trust?.digests?.sourceDraft===sha256Digest(o.sourceDraft)&&checkTrust(o.sourceDraft,dsl).ok,'source_trust_required');
 if(dsl.migrationPolicies)need(dsl.migrationPolicies.scope?.baseUrl===o.baseUrl&&dsl.migrationPolicies.scope?.targetCategoryId===o.targetCategoryId,'migration_policy_scope_mismatch');
 const sourceId=o.sourceDraft?.source?.sysFormTemplate?.fdModelId||o.sourceDraft?.source?.fdModelId;
 need(text(sourceId),'source_identity_required');
 const scope=o.scope;
 need(scope&&Object.keys(scope).every(key=>['version','operation','baseUrl','targetCategoryId','targets','request'].includes(key))&&scope.version===1&&scope.operation===OPERATION&&scope.baseUrl===o.baseUrl&&scope.targetCategoryId===o.targetCategoryId&&text(scope.request),'explicit_scoped_request_required');
 need(Array.isArray(scope.targets)&&scope.targets.length>0&&scope.targets.every(target=>target&&Object.keys(target).length===2&&Object.keys(target).every(key=>['sourceId','targetTemplateId'].includes(key))&&text(target.sourceId)&&text(target.targetTemplateId)),'scope_targets_invalid');
 need(new Set(scope.targets.map(target=>target.sourceId)).size===scope.targets.length&&new Set(scope.targets.map(target=>target.targetTemplateId)).size===scope.targets.length&&scope.targets.filter(target=>target.sourceId===sourceId&&target.targetTemplateId===o.targetTemplateId).length===1,'target_not_in_scope');
 const report=o.priorExecutionReport;
 need(report?.ok===true&&['written','written_with_warnings'].includes(report.status)&&report.baseUrl===o.baseUrl&&report.templateId===o.targetTemplateId&&same(report.createdFdIds,[o.targetTemplateId])&&same(report.updatedFdIds,[])&&report.writeOutcomeUnknown===false&&report.remoteWriteAttempted===true&&!hasUnknownNativeWrite(report),'successful_registered_draft_required');
 need(report.readback?.ok===true&&['envelope','form','rules','scripts','workflow'].every(partition=>report.readback.partitions?.[partition]==='verified'),'prior_invariants_incomplete');
 need(Array.isArray(report.apiStages)&&report.apiStages.every(stage=>stage.status==='ok')&&report.apiStages.filter(stage=>stage.name==='addTransferRecord').length===1&&report.transferRecord?.status==='recorded'&&text(report.transferRecord.fdId)&&report.transferRecord.fdOriginalId===sourceId&&report.transferRecord.fdTargetId===o.targetTemplateId,'prior_registration_mismatch');
}
async function readTarget(client,o){
 const template=await client.getTemplate(o.targetTemplateId),xform=template?.mechanisms?.['sys-xform'],bindings=template?.mechanisms?.lbpmTemplate;
 need(template?.fdId===o.targetTemplateId&&template.fdName?.startsWith('MK_TEST_')&&template.fdStatus===0&&template.fdCategory?.fdId===o.targetCategoryId&&xform?.fdId===template.fdId&&xform.fdStatus==='draft'&&!xform.fdVersionId,'target_draft_identity_invalid');
 need(Array.isArray(bindings)&&bindings.length===1&&text(bindings[0]?.fdId),'single_workflow_binding_required');
 const workflow=await client.getWorkflowTemplateDetail({templateId:bindings[0].fdId,definitionId:''});
 need(workflow?.fdId===bindings[0].fdId&&workflow.fdEntityId===template.fdId&&workflow.fdStatus==='draft'&&workflow.isDraft===true&&typeof workflow.fdContent==='string'&&workflow.fdContent.length>0&&workflow.fdContent===bindings[0].fdContent,'workflow_draft_identity_invalid');
 return {template,workflow};
}
function currentPrincipalReferences(bundle){
 const references=[];
 for(const owner of [bundle.template,bundle.template.mechanisms.lbpmTemplate[0],bundle.workflow]){
  for(const [key,role]of [['fdEditors','editor'],['fdReaders','reader']]){
   const members=owner[key];if(members===undefined)continue;
   need(Array.isArray(members)&&members.every(member=>text(member?.fdId)),'current_principals_invalid');
   references.push(...members.map(reference=>({reference,role})));
  }
 }
 return references;
}
function validateCurrentPrincipals(references,ids,targets){
 need(Array.isArray(targets)&&targets.length===ids.length&&ids.every(id=>targets.filter(target=>target.fdId===id).length===1),'principal_identity_unverified');
 for(const {reference,role}of references){
  const target=targets.find(candidate=>candidate.fdId===reference.fdId),type=Number(target.fdOrgType);
  need(typeof target.fdIsAvailable==='boolean'&&target.fdIsBusiness===true,'principal_identity_unverified');
  need(role==='editor'?type===8:Number.isInteger(target.fdOrgType)&&CHOICE_OTHER_NATIVE_ORG_TYPES.includes(target.fdOrgType),role+'_identity_unverified');
  need(reference.fdOrgType===undefined||Number(reference.fdOrgType)===type,'principal_reference_type_mismatch');
  need(reference.fdName===undefined||reference.fdName===target.fdName,'principal_display_identity_mismatch');
  if(role==='reader')for(const key of ['fdIsAvailable','fdIsBusiness'])need(!Object.hasOwn(reference,key)||reference[key]===target[key],'principal_reference_metadata_mismatch');
 }
}
