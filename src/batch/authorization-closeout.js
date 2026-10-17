import fs from 'node:fs';
import path from 'node:path';
import {homedir} from 'node:os';
import {sha256Digest} from '../agent-review/digest.js';
import {runAgentReview} from '../agent-review/index.js';
import {applyEvidenceBackedPatches,collectSourceRefs} from '../agent-review/review-validation.js';
import {checkTrust} from '../dsl/trust.js';
import {compareTemplateReaderSourceEvolution} from '../dsl/source-evidence-evolution.js';
import {buildDryRunPlan} from '../executor/dry-run.js';
import {hasUnknownNativeWrite,hasUnconfirmedNativeIntent} from '../executor/authorization-closeout-evidence.js';
import {closeoutDraftAuthorization} from '../executor/authorization-closeout.js';
import {sourceSnapshot,cleanSnapshot} from './intake.js';
import {attachMigrationPolicies,migrationPolicySourceDigest} from '../translator/approved-migration-policies.js';
import {draftSourceDraft} from '../translator/index.js';
import {engineDigest,newId,now} from './contracts.js';
const copy=value=>JSON.parse(JSON.stringify(value));
const assert=(condition,code)=>{if(!condition)throw Object.assign(new Error('Authorization closeout rejected: '+code),{code:'batch.authorization_closeout.'+code});};
const hash=value=>sha256Digest(value);
const same=(a,b)=>hash(a)===hash(b);
const claimId=input=>'scoped-target-'+hash({baseUrl:input.baseUrl,targetTemplateId:input.targetTemplateId}).slice(7);
const originalLockPath=(input,testRoot)=>path.join(testRoot||path.join(homedir(),'.codex','mk-migrate-agent-v2','locked-draft-locks'),hash({baseUrl:input.baseUrl,targetTemplateId:input.targetTemplateId}).slice(7)+'.json');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));

/** Fresh ordinary source/review pipeline, without claiming or resetting an existing item. */
export async function prepareAuthorizationCloseoutReplacement(item,batch,options={}){
 assert(item.batchId===batch.id&&item.targetTemplateId,'existing_item_required');
 assert(same({snapshot:item.snapshot,templateName:item.templateName||''}, {snapshot:sourceSnapshot(item.sourcePath),templateName:item.templateName||''}),'source_bytes_changed');
 const original=cleanSnapshot(item.snapshot,item.templateName);
 const policy=item.migrationPolicies?{...copy(item.migrationPolicies),sourceDraftSha256:migrationPolicySourceDigest(original)}:undefined;
 const source=policy?attachMigrationPolicies(original,policy,{baseUrl:batch.baseUrl,targetCategoryId:batch.targetCategoryId}):original;
 let draft=draftSourceDraft(source);const candidateAudit=[];
 const retainedPresentations=[];
 if(options.retainPresentationCandidates!==false){
  const executed=item.attempts?.filter(a=>a.phase==='execute'&&a.report?.templateId===item.targetTemplateId&&a.report?.createdFdIds?.includes(item.targetTemplateId)).at(-1);
  assert(item.dslDigest===hash(item.dsl)&&item.dsl.trust?.digests?.sourceDraft===hash(item.sourceDraft)&&executed&&same(executed.dsl,item.dsl)&&same(executed.sourceDraft,item.sourceDraft),'retained_presentation_artifact_mismatch');
  assert(compareTemplateReaderSourceEvolution(source,item.sourceDraft).ok,'retained_presentation_source_changed');
  const patches=[];
  const visit=(fields,priorFields,prefix)=>fields.forEach((field,index)=>{
   const old=priorFields.find(p=>p.id===field.id);if(!old||field.generated===true)return;
   assert(old.type===field.type&&old.componentId===field.componentId&&old.sourceRef===field.sourceRef,'retained_presentation_identity_changed');
   if(typeof old.title==='string'){
    retainedPresentations.push({path:`${prefix}/${index}/title`,fieldId:field.id,title:old.title});
    if(field.title!==old.title)patches.push({op:'replace',path:`${prefix}/${index}/title`,value:old.title,sourceRefs:[field.sourceRef],confidence:1,evidence:['Unchanged original XML and retained executed presentation; preserve this existing caption choice.'],rationale:'Retained presentation candidate, not a claim that this caption is the literal metadata label; fresh review remains required.'});
   }
   if(Array.isArray(field.columns))visit(field.columns,old.columns||[],`${prefix}/${index}/columns`);
  });visit(draft.form.fields,item.dsl.form.fields,'/form/fields');
  if(patches.length){const seeded=applyEvidenceBackedPatches(draft,patches,{sourceDraft:source,sourceRefs:collectSourceRefs(source)});assert(seeded.ok,'retained_presentation_candidate_invalid');draft=seeded.dslDraft;for(const patch of patches)candidateAudit.push({kind:'retained_presentation_candidate',path:patch.path,valueDigest:hash(patch.value),priorDslDigest:item.dslDigest,originalReportDigest:hash(executed.report),providerUsedForSeed:false,freshReviewRequired:true});}
 }
 if(options.retainScriptCandidates===true){
  assert(item.dslDigest===hash(item.dsl)&&item.dsl.trust?.digests?.sourceDraft===hash(item.sourceDraft),'retained_script_artifact_mismatch');
  const executed=item.attempts?.filter(a=>a.phase==='execute'&&a.report?.templateId===item.targetTemplateId&&a.report?.createdFdIds?.includes(item.targetTemplateId)).at(-1);
  assert(executed&&hash(executed.dsl)===item.dslDigest&&same(executed.sourceDraft,item.sourceDraft),'retained_script_artifact_mismatch');
  assert(compareTemplateReaderSourceEvolution(source,item.sourceDraft).ok,'retained_script_source_changed');
  for(const [index,action] of (draft.scripts?.actions||[]).entries()){
   if(action.translationStatus!=='needs_review')continue;
   const matches=(item.dsl.scripts?.actions||[]).filter(a=>a.id===action.id&&a.sourceActionKey===action.sourceActionKey);
   assert(matches.length===1&&same(matches[0].sourceRefs,action.sourceRefs)&&same(matches[0].branchProvenance,action.branchProvenance),'retained_script_identity_unproven');
   const prior=matches[0];assert(typeof prior.function==='string'&&prior.coverage?.status==='translated'&&prior.translationStatus!=='needs_review','retained_script_not_executable');
   const patches=['function','functionMappings','coverage'].map(key=>({op:'replace',path:`/scripts/actions/${index}/${key}`,value:copy(prior[key]),sourceRefs:action.sourceRefs,confidence:1,evidence:['Exact retained implementation and unchanged source action; fresh provider review is still mandatory.'],rationale:'Source-bound retained candidate only; no model review is claimed for this seeding step.'}));
   const seeded=applyEvidenceBackedPatches(draft,patches,{sourceDraft:source,sourceRefs:collectSourceRefs(source)});assert(seeded.ok,'retained_script_candidate_invalid');draft=seeded.dslDraft;
   assert(draft.scripts.actions[index].translationStatus==='needs_review','retained_script_review_bypassed');
   candidateAudit.push({kind:'retained_source_bound_candidate',actionId:action.id,sourceActionKey:action.sourceActionKey,priorDslDigest:item.dslDigest,originalReportDigest:hash(executed.report),functionDigest:hash(prior.function),providerUsedForSeed:false,freshReviewRequired:true});
  }
 }
 const review=await runAgentReview(source,draft,{provider:options.provider,providerOptions:{env:options.env||process.env},checkpointSigningKey:options.checkpointSigningKey||process.env.AGENT_REVIEW_CHECKPOINT_KEY,...(options.resumeCheckpoint?{resumeCheckpoint:options.resumeCheckpoint}:{}),...(options.onCheckpoint?{onCheckpoint:options.onCheckpoint}:{})});
 if(review.ok)for(const expected of retainedPresentations){let observed=review.dsl;for(const key of expected.path.slice(1).split('/'))observed=observed?.[key];assert(observed===expected.title,'review_changed_existing_presentation');}
 const trust=review.ok?checkTrust(source,review.dsl):null,plan=trust?.ok?buildDryRunPlan(review.dsl):null;
 return {ok:Boolean(review.ok&&trust?.ok&&plan?.ok),itemId:item.id,expectedDslDigest:item.dslDigest,expectedSourceDigest:item.sourceDigest,sourceDraft:source,dsl:review.dsl||null,dslDraft:draft,candidateAudit,review:review.report,trust,plan,engineDigest:engineDigest()};
}

export async function previewAuthorizationCloseout(store,repair,options){
 assert(typeof options.batchId==='string'&&Array.isArray(options.itemIds)&&options.itemIds.length>0,'explicit_items_required');
 const builtinTargetId=options.everyoneTargetFdId||options.replacements?.[0]?.everyoneTargetFdId;
 assert(typeof builtinTargetId==='string'&&builtinTargetId.trim()&&(!options.replacements||options.replacements.every(r=>!r.everyoneTargetFdId||r.everyoneTargetFdId===builtinTargetId)),'builtin_mapping_required');
 const batch=await store.get('batch',options.batchId);assert(batch?.status==='paused'&&batch.executionConcurrency===1,'paused_serial_batch_required');
 const candidates=await store.list('item',{batchId:batch.id});assert(new Set(options.itemIds).size===options.itemIds.length&&options.itemIds.every(id=>candidates.some(i=>i.id===id)),'item_outside_batch');
 assert(Array.isArray(options.replacements)&&options.replacements.length===options.itemIds.length,'prepared_replacements_required');
 const replacements=new Map(options.replacements.map(r=>[r.itemId,r]));assert(replacements.size===options.replacements.length,'duplicate_replacement');
 const items=[];
 for(const item of candidates.filter(i=>options.itemIds.includes(i.id))){
  try{
   const replacement=replacements.get(item.id),input=await buildInput(store,item,batch,repair.definition.action,replacement,builtinTargetId,options.clientFactory?options.testHistoricalLockRoot:undefined,options.graphRestorationAuthorization);
   const codes=new Set([...(item.diagnostics||[]),...(input.priorExecutionReport.diagnostics||[])].map(d=>d.code));
   assert(repair.definition.selector.diagnosticCodes.some(c=>codes.has(c)),'diagnostic_not_matched');
   const preview=await invoke(input,options,false);
   items.push({itemId:item.id,binding:hash(item),applicable:preview.ok===true&&preview.status==='authorization_closeout_ready',reason:preview.ok?'applicable':'native_gate_rejected',input,preview});
  }catch(error){items.push({itemId:item.id,binding:hash(item),applicable:false,reason:error.code||'invalid_evidence',input:null,preview:null});}
 }
 const plan={kind:'scoped_authorization_closeout',repairId:repair.id,repairVersion:repair.version,repairDigest:hash(repair.definition),definition:repair.definition,batchId:batch.id,target:{baseUrl:batch.baseUrl,targetCategoryId:batch.targetCategoryId},engineDigest:engineDigest(),items,summary:{selected:items.length,applicable:items.filter(i=>i.applicable).length,skipped:items.filter(i=>!i.applicable).length}};
 return store.create('repair_run',newId('repair-run'),copy({...plan,digest:hash(plan),status:'preview',applicationIds:[],createdAt:now()}));
}

export async function applyAuthorizationCloseout(store,run,options){
 assert(options.confirmWrite===true&&options.actor&&options.expectedDigest===run.digest,'explicit_current_approval_required');
 assert(run.kind==='scoped_authorization_closeout'&&run.status==='preview'&&hash(runPlan(run))===run.digest&&engineDigest()===run.engineDigest,'stale_preview');
 assert(typeof options.artifactsRoot==='string'&&path.isAbsolute(options.artifactsRoot),'private_artifacts_root_required');fs.mkdirSync(options.artifactsRoot,{recursive:true,mode:0o700});assert((fs.statSync(options.artifactsRoot).mode&0o077)===0,'private_artifacts_root_required');
 // A run is one-use even if its first target later stops before a native write.
 await store.transaction(async tx=>{const current=await tx.get('repair_run',run.id),repair=await tx.get('repair',run.repairId);assert(current.status==='preview'&&current.version===run.version,'already_applied');assert(repair?.version===run.repairVersion&&hash(repair.definition)===run.repairDigest,'definition_changed');await tx.mutate('repair_run',run.id,v=>({...v,status:'applying',actor:options.actor,startedAt:now()}));});
 for(const planned of run.items.filter(i=>i.applicable)){
  const input=planned.input,id=claimId(input),phaseKey=input.mode==='restore_graph'?'graphRestoration':'authorizationCloseout',artifactsDir=path.join(options.artifactsRoot,newId('target-closeout'));
  const initial=await store.get('batch',run.batchId);
  await store.transaction(async tx=>{
   const target=await tx.get('target',initial.targetId),batch=await tx.get('batch',run.batchId),item=await tx.get('item',planned.itemId);
   assert(batch.targetId===target.id,'target_changed');
   assert(batch.status==='paused'&&batch.executionConcurrency===1&&target.executionConcurrency===1&&!target.authorizationCloseoutActive,'origin_busy');
   const all=await tx.list('batch',{baseUrl:batch.baseUrl},{fields:['status']});assert(all.every(b=>b.status==='paused'),'origin_batch_running');
   const active=await tx.list('item',{baseUrl:batch.baseUrl,status:'running'},{fields:[]});assert(active.length===0,'origin_worker_running');
   for(const other of all){const runs=await tx.list('repair_run',{batchId:other.id},{fields:['status']});assert(runs.every(r=>r.id===run.id||r.status!=='applying'),'origin_repair_applying');}
   assert(hash(item)===planned.binding&&item.batchId===batch.id&&item.targetTemplateId===input.targetTemplateId&&same(run.target,{baseUrl:batch.baseUrl,targetCategoryId:batch.targetCategoryId}),'item_changed');
   assert(same({snapshot:item.snapshot,templateName:item.templateName||''},{snapshot:sourceSnapshot(item.sourcePath),templateName:item.templateName||''}),'source_bytes_changed');
   const parent=await tx.get('repair_application',id);
   assert((input.retainedClaimDigest===null&&!parent)||(parent&&hash(parent)===input.retainedClaimDigest&&!parent[phaseKey]),'claim_changed');
   const phase={status:'intent',mode:input.mode,runId:run.id,repairId:run.repairId,actor:options.actor,evidenceDigest:planned.preview.evidenceDigest,input,artifactsDir,startedAt:now(),before:item,journal:[],result:null};
   if(parent)await tx.mutate('repair_application',id,v=>({...v,[phaseKey]:phase}));
   else await tx.create('repair_application',id,{kind:'scoped_authorization_closeout',batchId:batch.id,itemId:item.id,baseUrl:input.baseUrl,targetTemplateId:input.targetTemplateId,authorizationCloseout:phase,createdAt:now()});
   await tx.mutate('target',target.id,v=>({...v,authorizationCloseoutActive:{claimId:id,runId:run.id}}));
   await tx.mutate('repair_run',run.id,v=>({...v,applicationIds:[...v.applicationIds,id]}));
  });
  const journal=async event=>store.transaction(async tx=>{const claim=await tx.get('repair_application',id);assert(claim[phaseKey].runId===run.id&&claim[phaseKey].status==='intent','phase_changed');await tx.mutate('repair_application',id,v=>({...v,[phaseKey]:{...v[phaseKey],journal:[...v[phaseKey].journal,copy(event)]}}));});
  const result=await invoke(input,options,true,{artifactsDir,expectedEvidenceDigest:planned.preview.evidenceDigest,journal});
  await store.transaction(async tx=>{
   const target=await tx.get('target',initial.targetId),batch=await tx.get('batch',run.batchId),item=await tx.get('item',planned.itemId),claim=await tx.get('repair_application',id);
   assert(claim[phaseKey].runId===run.id&&claim[phaseKey].status==='intent'&&target.authorizationCloseoutActive?.claimId===id&&hash(item)===planned.binding,'phase_changed');
   const success=result.ok===true&&result.readback?.ok===true&&result.evidenceDigest===planned.preview.evidenceDigest&&result.templateId===item.targetTemplateId&&result.baseUrl===batch.baseUrl&&result.writeOutcomeUnknown===false&&result.status===(input.mode==='finalize_record'?'original_claim_record_finalized':input.mode==='restore_graph'?'exact_graph_restored':'formal_readers_repaired')&&result.transferRecord?.status===(input.mode==='finalize_record'?'recorded':'preserved');
   const completedAt=now(),attempt={id:newId('closeout-attempt'),kind:'authorization_closeout',repairApplicationId:id,repairRunId:run.id,sourceDraft:input.sourceDraft,dsl:input.dsl,dslDigest:hash(input.dsl),sourceDigest:item.sourceDigest,report:result,completedAt};
   await tx.mutate('item',item.id,v=>({...v,status:success?'succeeded':result.writeOutcomeUnknown?'outcome_unknown':'needs_repair',...(success?{sourceDraft:input.sourceDraft,sourceDraftDigest:hash(input.sourceDraft),dsl:input.dsl,dslDigest:hash(input.dsl),engineDigest:run.engineDigest,...(input.sourceDraft.migrationPolicies?{migrationPolicies:input.sourceDraft.migrationPolicies}:{})}:{}),attempts:[...v.attempts,attempt],attemptCount:(v.attemptCount||0)+1,diagnostics:result.diagnostics||[],authorizationCloseouts:[...(v.authorizationCloseouts||[]),{claimId:id,runId:run.id,status:success?'succeeded':result.status,resultDigest:hash(result),completedAt}]}));
   await tx.mutate('repair_application',id,v=>({...v,[phaseKey]:{...v[phaseKey],status:success?'succeeded':result.status,result,completedAt}}));
   await tx.mutate('target',target.id,v=>({...v,authorizationCloseoutActive:null}));
  });
 }
 return store.mutate('repair_run',run.id,v=>({...v,status:'applied',completedAt:now()}));
}

async function buildInput(store,item,batch,action,replacement,everyoneTargetFdId,testHistoricalLockRoot,graphRestorationAuthorization){
 assert(replacement?.ok===true&&replacement.engineDigest===engineDigest()&&replacement.expectedDslDigest===item.dslDigest&&replacement.expectedSourceDigest===item.sourceDigest&&replacement.sourceDraft&&replacement.dsl,'fresh_preparation_required');
 assert(!item.activeAttemptId&&!item.workerId&&!item.leaseUntil&&hash({snapshot:item.snapshot,templateName:item.templateName||''})===item.sourceDigest,'item_not_stable');
 assert(checkTrust(replacement.sourceDraft,replacement.dsl).ok&&buildDryRunPlan(replacement.dsl).ok,'prepared_dsl_invalid');
 const raw=cleanSnapshot(item.snapshot,item.templateName),policy=item.migrationPolicies?{...copy(item.migrationPolicies),sourceDraftSha256:migrationPolicySourceDigest(raw)}:undefined;
 const rebuilt=policy?attachMigrationPolicies(raw,policy,{baseUrl:batch.baseUrl,targetCategoryId:batch.targetCategoryId}):raw;
 assert(same(rebuilt,replacement.sourceDraft),'source_parser_proofs_not_reproduced');
 assert(!item.attempts.some(a=>hasUnknownNativeWrite(a.report)),'unknown_native_write');
 assert(!item.attempts.some(a=>hasUnconfirmedNativeIntent(a.steps)),'unconfirmed_native_intent');
 if(action.mode==='restore_graph')return buildGraphRestorationInput(store,item,batch,replacement,graphRestorationAuthorization);
 const original=item.attempts.filter(a=>a.phase==='execute'&&a.report?.createdFdIds?.includes(item.targetTemplateId)).at(-1);assert(original&&same(original.dsl,item.dsl)&&same(original.sourceDraft,item.sourceDraft),'original_execution_required');
 const auth=replacement.sourceDraft.template.authorization;assert(auth.readScope?.mode==='everyone','source_public_scope_required');
 const execution=copy(item.executionOptions||{});execution.templateAuthorizationOverrides=[...(execution.templateAuthorizationOverrides||[]).filter(m=>m.sourceId!==auth.allReaders[0].sourceId),{sourceId:auth.allReaders[0].sourceId,targetFdId:everyoneTargetFdId}];
 const retainedIdentityBindings=retainSingletonEditorBindings(auth,original.report,execution);
 const input={mode:action.mode,baseUrl:batch.baseUrl,targetCategoryId:batch.targetCategoryId,targetTemplateId:item.targetTemplateId,sourceDraft:replacement.sourceDraft,priorSourceDraft:item.sourceDraft,priorDsl:item.dsl,dsl:replacement.dsl,priorExecutionReport:original.report,executionOptions:execution,retainedIdentityBindings,retainedClaim:null,retainedClaimDigest:null};
 const parent=await store.get('repair_application',claimId(input));
 if(action.mode==='finalize_record'){
  assert(!item.attempts.some(a=>a.steps?.some(s=>s.operation==='addTransferRecord')||a.report?.apiStages?.some(s=>s.name==='addTransferRecord')||a.report?.transferRecord),'record_phase_already_started');
  assert(item.status==='outcome_unknown'&&item.scopedRepairClaimId===parent?.id&&parent.status==='outcome_unknown'&&parent.action?.kind==='locked_draft'&&parent.action.repairKind==='template_authorization'&&!parent.authorizationCloseout,'original_pending_claim_required');
  const state=read(path.join(parent.artifactsDir,'locked-draft-state.json')),permanent=originalLockPath(input,testHistoricalLockRoot);assert(same(read(permanent),state),'original_permanent_lock_mismatch');
  const latest=item.attempts.at(-1);assert(latest.kind==='scoped_repair'&&same(latest.report,parent.result),'recovery_receipt_mismatch');
  Object.assign(input,{retainedClaim:{id:parent.id,status:parent.status,action:parent.action,input:{baseUrl:parent.input.baseUrl,targetTemplateId:parent.input.targetTemplateId},result:parent.result},retainedClaimDigest:hash(parent),retainedRecoveryState:state,retainedPermanentLockPath:permanent,expectedPermanentLockDigest:hash(fs.readFileSync(permanent,'utf8')),retainedAfter:{template:read(path.join(parent.artifactsDir,'after.template.json')),workflow:read(path.join(parent.artifactsDir,'after.workflow.json'))}});
 }else{
  assert(item.status==='succeeded'&&original.report.ok===true&&original.report.transferRecord?.status==='recorded'&&!parent,'successful_unclaimed_target_required');
  const permanent=originalLockPath(input,testHistoricalLockRoot);if(fs.existsSync(permanent)){const state=read(permanent);assert(state.templateWriteOutcomeUnknown===false&&state.transferRecordOutcomeUnknown===false&&state.transferRecordCompleted===true,'historical_lock_not_completed');}
 }
 return input;
}
async function invoke(input,options,confirmWrite,confirmation={}){
 try{
  const client=options.clientFactory?await options.clientFactory({baseUrl:input.baseUrl,targetTemplateId:input.targetTemplateId}):undefined;
  return copy(await closeoutDraftAuthorization(copy(input.dsl),{...input,...confirmation,confirmWrite,credentials:options.credentials,expectedDslDigest:hash(input.dsl),expectedPriorDslDigest:hash(input.priorDsl),expectedPriorReportDigest:hash(input.priorExecutionReport),...(client?{client}:{}),...(options.testLockRoot&&client?{testLockRoot:options.testLockRoot}:{}),...(options.testHistoricalLockRoot&&client?{testHistoricalLockRoot:options.testHistoricalLockRoot}:{})}));
 }catch{return {ok:false,status:confirmWrite?'outcome_unknown':'blocked',writeOutcomeUnknown:confirmWrite,diagnostics:[{level:'error',code:'batch.authorization_closeout.executor_failed',message:'No automatic replay is allowed.'}]};}
}
function runPlan(run){const {kind,repairId,repairVersion,repairDigest,definition,batchId,target,engineDigest,items,summary}=run;return {kind,repairId,repairVersion,repairDigest,definition,batchId,target,engineDigest,items,summary};}

/** A retained singleton and identical source/target ID proves identity without fuzzy re-search. */
function retainSingletonEditorBindings(auth,report,execution){
 const evidence=[];
 for(const collection of ['editors','allEditors','temporaryEditors']){
  const members=auth[collection],observed=report.readback?.workflow?.templateAuthorization?.[collection];
  if(members?.length!==1||observed?.length!==1)continue;
  const m=members[0];if(!m.sourceId||Number(m.sourceOrgType)!==8||observed[0]!==m.sourceId)continue;
  const configured=execution.templateAuthorizationOverrides.filter(x=>x.sourceId===m.sourceId);
  assert(configured.length<=1&&(!configured[0]||configured[0].targetFdId===m.sourceId),'retained_editor_mapping_conflict');
  if(!configured.length)execution.templateAuthorizationOverrides.push({sourceId:m.sourceId,targetFdId:m.sourceId});
  evidence.push({basis:'retained-singleton-same-id',collection,sourceRef:m.sourceRef,sourceId:m.sourceId,targetFdId:m.sourceId,reportDigest:hash(report)});
 }
 return evidence;
}
async function buildGraphRestorationInput(store,item,batch,replacement,authorization){
 const id=claimId({baseUrl:batch.baseUrl,targetTemplateId:item.targetTemplateId}),parent=await store.get('repair_application',id),phase=parent?.authorizationCloseout;
 assert(item.status==='needs_repair'&&parent?.itemId===item.id&&parent.batchId===batch.id&&phase?.mode==='repair_readers'&&phase.status==='readback_failed'&&!parent.graphRestoration,'retained_graph_loss_phase_required');
 assert(same(item.attempts.at(-1)?.report,phase.result)&&same(phase.input.dsl,replacement.dsl)&&same(phase.input.sourceDraft,replacement.sourceDraft),'retained_graph_loss_artifact_mismatch');
 assert(authorization?.claimId===id,'explicit_graph_restoration_required');
 const artifacts=phase.artifactsDir;
 return {...copy(phase.input),mode:'restore_graph',retainedClaimDigest:hash(parent),graphRestorationEvidence:{claimId:id,authorization:copy(authorization),result:copy(phase.result),journal:copy(phase.journal),before:read(path.join(artifacts,'before.json')),after:read(path.join(artifacts,'after.json')),payload:read(path.join(artifacts,'payload.json')),receipt:read(path.join(artifacts,'receipt.json')),plan:read(path.join(artifacts,'plan.json'))}};
}
