import fs from 'node:fs';
import path from 'node:path';
import {homedir} from 'node:os';
import {sha256Digest} from '../agent-review/digest.js';
import {checkTrust} from '../dsl/trust.js';
import {sourceReadScopeBindingIssues} from '../dsl/template-read-scope.js';
import {compareTemplateReaderSourceEvolution} from '../dsl/source-evidence-evolution.js';
import {buildDryRunPlan} from './dry-run.js';
import {NewoaClient,normalizeBaseUrl} from './newoa-client.js';
import {resolveWorkflowCooperation} from './workflow-cooperation.js';
import {resolveWorkflowParticipants} from './participant-resolver.js';
import {resolveConditionOrgs} from './condition-org-resolver.js';
import {hasStaticAddressDefaults,resolveStaticAddressDefaults} from './static-address-default-resolver.js';
import {resolveWorkflowSignPolicy,verifyWorkflowSignReadback} from './workflow-sign-policy.js';
import {requiresNativeFormRuleFormula} from '../dsl/native-form-rule-projection.js';
import {inspectNativeFormRuleRuntimeDigest,inspectNativeFormRuleRuntimeBundleHashes,NATIVE_FORM_RULE_FORMULA_RUNTIME_CAPABILITY} from './native-form-rule-runtime-capability.js';
import {hasSourceSignDeclaration} from '../dsl/workflow-sign-contract.js';
import {verifyRemoteSelectorResources} from './remote-selector-resources.js';
import {verifyTemplateReadRuntime} from './template-read-scope.js';
import {buildTransferRecordPayload,generateTransferRecordId} from './transfer-record.js';
import {withoutMechanismTokens} from './published-form-patch.js';
import {prepareAuthorizationCloseoutPlan,completeAuthorizationReadback,bundleDigest,isMissingWorkflowGraph} from './authorization-closeout-plan.js';
import {hasUnknownNativeWrite} from './authorization-closeout-evidence.js';
const clone=structuredClone;
const requireValue=(ok,reason)=>{if(!ok)throw Object.assign(new Error(reason),{code:'authorization_closeout.'+reason});};
const text=v=>typeof v==='string'&&v.trim()===v&&v.length>0;
const same=(a,b)=>sha256Digest(a)===sha256Digest(b);
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(withoutMechanismTokens(value),null,2)+'\n',{flag:'wx',mode:0o600,flush:true});

/** Explicit recovery operations. No create, publication, or new workflow content is allowed. */
export async function closeoutDraftAuthorization(input,options={}){
 let started=false,acknowledged=false,artifacts,mode=options.mode,readback,plan,evidenceDigest;
 const apiStages=[],baseUrl=options.baseUrl,targetTemplateId=options.targetTemplateId;
 const base=()=>({baseUrl,templateId:targetTemplateId,createdFdIds:[],updatedFdIds:mode!=='finalize_record'&&acknowledged?[targetTemplateId]:[],apiStages});
 const stage=async(name,operation)=>{const s={name,status:'started'};apiStages.push(s);try{const result=await operation();s.status='ok';return result;}catch(error){s.status='failed';throw error;}};
 try{
  validateArtifacts(input,options);
  const dryRun=buildDryRunPlan(input);requireValue(dryRun.ok,'dry_run_failed');
  const client=options.client||new NewoaClient({baseUrl,fetchImpl:options.fetchImpl});
  await stage('login',()=>client.login(options.credentials));
  const execution=options.executionOptions||{};
  let resolved=clone(input),signPolicy;
  if(requiresNativeFormRuleFormula(input))await stage('verifyNativeFormRuleFormulaCapability',()=>verifyFormulaCapability(client,baseUrl));
  const cooperation=await stage('resolveWorkflowCooperation',()=>resolveWorkflowCooperation(resolved,{client,targetBaseUrl:baseUrl,workflowCooperationDefault:execution.workflowCooperationDefault}));resolved=cooperation.dsl;
  if(input.workflow?.nodes?.some(n=>n.type==='sign'||hasSourceSignDeclaration(n))||execution.workflowSignDocumentPolicy||execution.workflowOperationSetOverrides){const sign=await stage('resolveWorkflowSignPolicy',()=>resolveWorkflowSignPolicy(resolved,{...execution,client}));resolved=sign.dsl;signPolicy=sign.policy;}
  if(input.migrationPolicies?.decisions?.some(d=>d.kind==='native-tic-rest-selector')){const remote=await stage('verifyRemoteSelectorResources',()=>verifyRemoteSelectorResources(resolved,{client,baseUrl}));requireValue(remote.ok,'remote_resource_unverified');}
  const people=await stage('resolveWorkflowParticipants',()=>resolveWorkflowParticipants(resolved,{...execution,client,targetBaseUrl:baseUrl}));resolved=people.dsl;
  if(hasStaticAddressDefaults(resolved))resolved=(await stage('resolveStaticAddressDefaults',()=>resolveStaticAddressDefaults(resolved,{client}))).dsl;
  const orgs=await stage('resolveConditionOrgs',()=>resolveConditionOrgs(resolved,{...execution,client,targetBaseUrl:baseUrl}));resolved=orgs.dsl;
  const before=await stage('firstStableRead',()=>readTarget(client,options)),second=await stage('secondStableRead',()=>readTarget(client,options));requireValue(bundleDigest(before)===bundleDigest(second),'snapshot_changed');
  if(mode==='finalize_record')requireValue(bundleDigest(before)===bundleDigest(options.retainedAfter),'retained_after_snapshot_changed');
  if(mode==='restore_graph')requireValue(bundleDigest(before)===options.graphRestorationEvidence.authorization.snapshotDigest&&bundleDigest(before)===bundleDigest(options.graphRestorationEvidence.after),'restore_snapshot_changed');
  const editorIds=[...new Set(before.template.fdEditors.map(m=>m.fdId))];
  const editors=await stage('validateCurrentEditors',()=>client.getElementInfo(editorIds,{builtinEvidence:true}));
  // These are existing unchanged principals, not newly selected usable accounts.
  // Retain an inactive editor only with exact typed/business identity evidence.
  requireValue(editors.length===editorIds.length&&editorIds.every(id=>editors.filter(t=>t.fdId===id&&Number(t.fdOrgType)===8&&typeof t.fdIsAvailable==='boolean'&&t.fdIsBusiness===true).length===1),'editor_identity_unverified');
  plan=prepareAuthorizationCloseoutPlan({before,dsl:resolved,mode,categoryId:options.targetCategoryId,priorReport:options.priorExecutionReport,currentTargets:editors,restoration:options.graphRestorationEvidence});
  if(signPolicy?.nodes.length)await stage('verifySignPolicy',async()=>{const t=clone(plan.proposed.template);t.mechanisms.lbpmTemplate=[clone(plan.proposed.workflow)];requireValue((await verifyWorkflowSignReadback(signPolicy,t,client)).ok,'sign_readback_failed');});
  const runtime=await stage('verifyNativeReaderRuntime',()=>verifyTemplateReadRuntime(resolved,{client,targetBaseUrl:baseUrl}));requireValue(runtime.ok,'native_reader_runtime_changed');
  const currentEditorEvidence=editors.map(t=>({id:t.fdId,name:t.fdName,orgType:t.fdOrgType,available:t.fdIsAvailable,business:t.fdIsBusiness})).sort((a,b)=>a.id.localeCompare(b.id));
  const bindings={mode,input,sourceDraft:options.sourceDraft,priorSourceDraft:options.priorSourceDraft,priorDsl:options.priorDsl,priorReport:options.priorExecutionReport,executionOptions:execution,retainedClaim:options.retainedClaim||null,retainedRecoveryState:options.retainedRecoveryState||null,permanentLockDigest:options.expectedPermanentLockDigest||null,baseUrl,targetTemplateId,targetCategoryId:options.targetCategoryId,snapshotDigest:bundleDigest(before),resolved,currentEditorEvidence,plan:plan.summary,graphRestorationEvidence:options.graphRestorationEvidence||null,payloadDigest:mode!=='finalize_record'?bundleDigest(plan.payload):null};
  evidenceDigest=sha256Digest(bindings);
  const resolutionAudit={cooperation:cooperation.nodes,participants:Object.fromEntries(Object.entries(people).filter(([k])=>k!=='dsl')),conditions:Object.fromEntries(Object.entries(orgs).filter(([k])=>k!=='dsl')),currentEditorEvidence};
  if(options.confirmWrite!==true)return {...base(),ok:true,status:'authorization_closeout_ready',evidenceDigest,snapshotDigest:bundleDigest(before),plan:plan.summary,readback:plan.readback,resolutionAudit};
  requireValue(options.expectedEvidenceDigest===evidenceDigest,'evidence_digest_mismatch');
  requireValue(text(options.artifactsDir)&&!fs.existsSync(options.artifactsDir),'unused_private_artifacts_required');
  fs.mkdirSync(options.artifactsDir,{recursive:true,mode:0o700});artifacts=options.artifactsDir;requireValue((fs.statSync(artifacts).mode&0o077)===0,'artifacts_not_private');
  save(path.join(artifacts,'before.json'),before);save(path.join(artifacts,'plan.json'),{evidenceDigest,summary:plan.summary,bindings,resolutionAudit});
  const payload=mode!=='finalize_record'?plan.payload:buildTransferRecordPayload(input,{fdId:options.transferRecordIdFactory?.()||generateTransferRecordId(),targetTemplateId,now:options.now||new Date()});
  const lockRoot=options.client&&options.testLockRoot?options.testLockRoot:path.join(homedir(),'.codex','mk-migrate-agent-v2','authorization-closeout-locks');fs.mkdirSync(lockRoot,{recursive:true,mode:0o700});
  const phaseLock=path.join(lockRoot,sha256Digest({baseUrl,targetTemplateId}).slice(7)+(mode==='restore_graph'?'.exact-graph-restore':'')+'.json');
  const intent={operation:mode,baseUrl,targetTemplateId,evidenceDigest,retainedClaimId:options.retainedClaim?.id||null,payloadDigest:bundleDigest(payload),recordId:mode==='finalize_record'?payload.fdId:null};
  save(phaseLock,intent);save(path.join(artifacts,'intent.json'),intent);save(path.join(artifacts,'payload.json'),payload);
  // A consumed phase claim and lock are never cleared, including prewrite interruptions.
  await options.journal?.({phase:'intent',intent});
  if(mode==='finalize_record')await stage('transferRecordAuthentication',()=>client.assertTransferRecordAuthentication());
  started=true;
  const receipt=await stage(mode!=='finalize_record'?'updateTemplate':'addTransferRecord',()=>mode!=='finalize_record'?client.updateTemplate(payload):client.addTransferRecord(payload));acknowledged=true;
  save(path.join(artifacts,'receipt.json'),{acknowledged:true,intent,receipt});await options.journal?.({phase:'receipt',intent,receipt:withoutMechanismTokens(receipt)});
  const after=await stage('firstAfterRead',()=>readTarget(client,options)),after2=await stage('secondAfterRead',()=>readTarget(client,options));save(path.join(artifacts,'after.json'),after2);
  requireValue(bundleDigest(after)===bundleDigest(after2),'postwrite_snapshot_changed');
  readback=plan.verify(after2);requireValue(plan.verifyProtected(after2),'protected_state_changed');requireValue(completeAuthorizationReadback(readback),'postwrite_readback_failed');
  if(signPolicy?.nodes.length){const t=clone(after2.template);t.mechanisms.lbpmTemplate=[clone(after2.workflow)];requireValue((await verifyWorkflowSignReadback(signPolicy,t,client)).ok,'postwrite_sign_readback_failed');}
  requireValue((await verifyTemplateReadRuntime(resolved,{client,targetBaseUrl:baseUrl})).ok,'postwrite_native_runtime_changed');
  const result={...base(),ok:true,status:mode==='repair_readers'?'formal_readers_repaired':mode==='restore_graph'?'exact_graph_restored':'original_claim_record_finalized',evidenceDigest,readback,plan:plan.summary,resolutionAudit,writeOutcomeUnknown:false,artifactsDir:artifacts,
   ...(mode==='finalize_record'?{transferRecord:{status:'recorded',...payload}}:{transferRecord:{status:'preserved',...options.priorExecutionReport.transferRecord}})};
  // Repair never emits or reissues a migration-record callback.
  if(mode!=='finalize_record')result.transferRecord={...options.priorExecutionReport.transferRecord,status:'preserved'};
  save(path.join(artifacts,'result.json'),result);return result;
 }catch(error){
  if(error.readback)readback=error.readback;
  const result={...base(),ok:false,status:started&&!acknowledged?'outcome_unknown':started?'readback_failed':'blocked',evidenceDigest: evidenceDigest||null,readback:readback||null,plan:plan?.summary||null,writeOutcomeUnknown:started&&!acknowledged,writeAcknowledged:acknowledged,diagnostics:[{level:'error',code:error.code||'authorization_closeout.failed',message:'Scoped authorization closeout stopped; no retry or rollback was attempted.',path:'/authorizationCloseout'}],...(artifacts?{artifactsDir:artifacts}:{})};
  if(artifacts&&!fs.existsSync(path.join(artifacts,'result.json')))save(path.join(artifacts,'result.json'),result);return result;
 }
}
async function verifyFormulaCapability(client,baseUrl){
 const capability=inspectNativeFormRuleRuntimeDigest(await client.getXFormDesktopDigest(),{baseUrl});requireValue(capability.ok,'formula_runtime_unverified');
 const contract=NATIVE_FORM_RULE_FORMULA_RUNTIME_CAPABILITY;
 const runtimeSha256=await client.getXFormDesktopModuleSha256({modulePath:contract.runtimePath,releaseHash:capability.runtimeHash});
 const ideSha256=await client.getXFormDesktopModuleSha256({modulePath:contract.idePath,releaseHash:capability.ideHash});
 requireValue(inspectNativeFormRuleRuntimeBundleHashes({runtimeSha256,ideSha256,expectedRuntimeSha256:capability.expectedRuntimeSha256,expectedIdeSha256:capability.expectedIdeSha256}).ok,'formula_runtime_content_unverified');
}

function validateArtifacts(input,o){
 requireValue(['finalize_record','repair_readers','restore_graph'].includes(o.mode),'mode_invalid');requireValue(normalizeBaseUrl(o.baseUrl)===o.baseUrl,'origin_invalid');
 requireValue(text(o.targetTemplateId)&&text(o.targetCategoryId)&&text(o.credentials?.username)&&text(o.credentials?.encryptedPassword),'target_and_credentials_required');
 requireValue(o.expectedDslDigest===sha256Digest(input)&&o.expectedPriorDslDigest===sha256Digest(o.priorDsl)&&o.expectedPriorReportDigest===sha256Digest(o.priorExecutionReport),'artifact_digest_mismatch');
 requireValue(checkTrust(o.sourceDraft,input).ok&&sourceReadScopeBindingIssues(o.sourceDraft).length===0&&o.sourceDraft.template.authorization.readScope?.mode==='everyone','source_trust_required');
 requireValue(o.priorDsl?.trust?.digests?.sourceDraft===sha256Digest(o.priorSourceDraft),'historical_source_digest_mismatch');
 requireValue(compareTemplateReaderSourceEvolution(o.sourceDraft,o.priorSourceDraft).ok,'source_evolution_outside_scope');
 const r=o.priorExecutionReport;requireValue(r?.baseUrl===o.baseUrl&&r.templateId===o.targetTemplateId&&same(r.createdFdIds,[o.targetTemplateId])&&r.writeOutcomeUnknown===false&&!hasUnknownNativeWrite(r),'prior_report_ineligible');
 requireValue(['envelope','form','rules','scripts'].every(p=>r.readback?.partitions?.[p]==='verified')&&r.readback?.numberRule?.status==='verified','prior_invariants_incomplete');
 if(o.mode!=='finalize_record')requireValue(r.ok===true&&r.readback.ok===true&&r.readback.partitions.workflow==='verified'&&r.transferRecord?.status==='recorded'&&r.transferRecord.fdTargetId===o.targetTemplateId&&r.transferRecord.fdOriginalId===input.workflow?.process?.templateId,'successful_registered_draft_required');
 else{
  requireValue(r.status==='readback_failed'&&r.failedAt==='readback'&&!r.transferRecord&&!r.apiStages.some(s=>s.name==='addTransferRecord'),'unrecorded_draft_required');
  const claim=o.retainedClaim,state=o.retainedRecoveryState,p=claim?.result;
  requireValue(claim?.id==='scoped-target-'+sha256Digest({baseUrl:o.baseUrl,targetTemplateId:o.targetTemplateId}).slice(7)&&claim.status==='outcome_unknown'&&claim.action?.kind==='locked_draft'&&claim.action.repairKind==='template_authorization'&&claim.input?.baseUrl===o.baseUrl&&claim.input.targetTemplateId===o.targetTemplateId&&!claim.authorizationCloseout,'original_claim_required');
  requireValue(p?.status==='readback_failed'&&p.failedAt==='readback'&&p.templateId===o.targetTemplateId&&p.baseUrl===o.baseUrl&&p.writeOutcomeUnknown!==true&&p.templateWriteOutcomeUnknown!==true&&p.transferRecordOutcomeUnknown!==true&&same(p.updatedFdIds,[o.targetTemplateId])&&same(p.createdFdIds,[])&&p.apiStages?.filter(s=>s.name==='updateTemplate'&&s.status==='ok').length===1&&!p.transferRecord&&p.apiStages.every(s=>s.status==='ok'&&!['addTransferRecord','saveWorkflowDraft','addTemplate','add'].includes(s.name)&&s.writeOutcomeUnknown!==true),'retained_acknowledged_repair_required');
  requireValue(state?.baseUrl===o.baseUrl&&state.targetTemplateId===o.targetTemplateId&&state.templateWriteStarted===true&&state.templateWriteCompleted===true&&state.templateWriteOutcomeUnknown===false&&state.transferRecordStarted===false&&state.transferRecordCompleted===false&&state.transferRecordOutcomeUnknown===false,'never_started_record_required');
  requireValue(text(o.retainedPermanentLockPath)&&sha256Digest(fs.readFileSync(o.retainedPermanentLockPath,'utf8'))===o.expectedPermanentLockDigest&&same(JSON.parse(fs.readFileSync(o.retainedPermanentLockPath,'utf8')),state),'permanent_lock_changed');
  requireValue(o.retainedAfter?.template?.fdId===o.targetTemplateId,'retained_after_required');
 }
 validateCanonicalHistoricalLock(o);
 if(o.mode==='restore_graph')validateGraphRestoration(input,o);
}
async function readTarget(client,o){
 const template=await client.getTemplate(o.targetTemplateId),x=template?.mechanisms?.['sys-xform'],binding=template?.mechanisms?.lbpmTemplate?.[0];
 requireValue(Array.isArray(template?.mechanisms?.lbpmTemplate)&&template.mechanisms.lbpmTemplate.length===1,'single_workflow_binding_required');
 requireValue(template?.fdId===o.targetTemplateId&&template.fdName?.startsWith('MK_TEST_')&&template.fdCategory?.fdId===o.targetCategoryId&&template.fdStatus===0&&x?.fdId===template.fdId&&x.fdStatus==='draft'&&binding?.isDraft===true,'target_draft_identity_invalid');
 const workflow=await client.getWorkflowTemplateDetail({templateId:binding.fdId,definitionId:''});
 requireValue(workflow?.fdId===binding.fdId&&workflow.isDraft===true&&workflow.fdEntityId===template.fdId,'workflow_draft_identity_invalid');return {template,workflow};
}

function validateGraphRestoration(input,o){
 const e=o.graphRestorationEvidence,a=e?.authorization,r=e?.result;
 requireValue(a?.action==='restore-exact-retained-workflow-content-only'&&a.baseUrl===o.baseUrl&&a.targetTemplateId===o.targetTemplateId&&a.categoryId===o.targetCategoryId&&a.claimId==='scoped-target-'+sha256Digest({baseUrl:o.baseUrl,targetTemplateId:o.targetTemplateId}).slice(7),'explicit_graph_restoration_required');
 requireValue(e.claimId===a.claimId&&r?.ok===false&&r.status==='readback_failed'&&r.writeAcknowledged===true&&r.writeOutcomeUnknown===false&&!hasUnknownNativeWrite(r)&&r.templateId===o.targetTemplateId&&r.baseUrl===o.baseUrl&&same(r.updatedFdIds,[o.targetTemplateId])&&same(r.createdFdIds,[])&&r.plan?.mode==='repair_readers'&&r.apiStages?.filter(s=>s.name==='updateTemplate'&&s.status==='ok').length===1&&!r.apiStages.some(s=>s.writeOutcomeUnknown===true||['addTransferRecord','addTemplate','saveWorkflowDraft'].includes(s.name))&&a.resultDigest===sha256Digest(r),'known_acknowledged_graph_loss_required');
 requireValue(e.receipt?.acknowledged===true&&same(e.receipt.intent,e.journal?.[0]?.intent)&&same(e.receipt.intent,e.journal?.[1]?.intent)&&e.receipt.intent.baseUrl===o.baseUrl&&e.receipt.intent.targetTemplateId===o.targetTemplateId&&same(e.receipt.receipt,e.journal?.[1]?.receipt)&&e.journal.length===2&&e.journal[0].phase==='intent'&&e.journal[1].phase==='receipt'&&e.receipt.intent.operation==='repair_readers'&&e.receipt.intent.evidenceDigest===r.evidenceDigest&&e.receipt.intent.payloadDigest===bundleDigest(e.payload),'restore_receipt_mismatch');
 const b=e.before,after=e.after,graph=b?.workflow?.fdContent;
 requireValue(b?.template?.fdId===o.targetTemplateId&&after?.template?.fdId===o.targetTemplateId&&b.workflow.fdId===a.workflowId&&after.workflow.fdId===a.workflowId&&b.template.mechanisms.lbpmTemplate[0].fdContent===graph&&typeof graph==='string'&&graph.length>0&&sha256Digest(graph)===a.graphDigest&&bundleDigest(after)===a.snapshotDigest,'restore_backup_mismatch');
 requireValue(isMissingWorkflowGraph(after.workflow.fdContent)&&isMissingWorkflowGraph(after.template.mechanisms.lbpmTemplate[0].fdContent)&&!Object.hasOwn(e.payload.mechanisms.lbpmTemplate[0],'fdContent')&&e.payload.fdReaders?.length===0&&e.payload.mechanisms.lbpmTemplate[0].fdReaders?.length===0,'acknowledged_omission_required');
 const bindings=e.plan?.bindings;
 requireValue(bindings&&sha256Digest(bindings)===r.evidenceDigest&&e.plan.evidenceDigest===r.evidenceDigest,'restore_plan_mismatch');
 requireValue(bindings.mode==='repair_readers'&&bindings.baseUrl===o.baseUrl&&bindings.targetTemplateId===o.targetTemplateId&&bindings.targetCategoryId===o.targetCategoryId,'restore_plan_mismatch');
 for(const [key,value] of Object.entries({input,sourceDraft:o.sourceDraft,priorSourceDraft:o.priorSourceDraft,priorDsl:o.priorDsl,priorReport:o.priorExecutionReport,executionOptions:o.executionOptions})){
  requireValue(same(bindings[key],value),'restore_plan_mismatch');
 }
 requireValue(bindings.snapshotDigest===bundleDigest(b)&&bindings.payloadDigest===bundleDigest(e.payload),'restore_plan_mismatch');
}

function validateCanonicalHistoricalLock(o){
 const root=o.client&&o.testHistoricalLockRoot?o.testHistoricalLockRoot:path.join(homedir(),'.codex','mk-migrate-agent-v2','locked-draft-locks');
 const file=path.join(root,sha256Digest({baseUrl:o.baseUrl,targetTemplateId:o.targetTemplateId}).slice(7)+'.json');
 let metadata;
 try{metadata=fs.lstatSync(file);}catch(error){
  if(error.code!=='ENOENT')throw error;
  requireValue(o.mode!=='finalize_record','canonical_historical_lock_required');return;
 }
 requireValue(metadata.isFile(),'canonical_historical_lock_invalid');
 const state=JSON.parse(fs.readFileSync(file,'utf8'));
 requireValue(state.baseUrl===o.baseUrl&&state.targetTemplateId===o.targetTemplateId&&state.templateWriteOutcomeUnknown===false&&state.transferRecordOutcomeUnknown===false,'historical_lock_unknown');
 if(o.mode==='finalize_record')requireValue(path.resolve(o.retainedPermanentLockPath)===path.resolve(file)&&same(state,o.retainedRecoveryState),'canonical_historical_lock_mismatch');
 else requireValue(!hasUnknownNativeWrite(state)&&state.templateWriteCompleted===true&&state.transferRecordCompleted===true,'historical_lock_not_completed');
}
