import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it} from 'node:test';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {sha256Digest} from '../../src/agent-review/digest.js';
import {createTrustedMigrationDsl} from '../../src/dsl/trust.js';
import {buildDryRunPlan} from '../../src/executor/dry-run.js';
import {preparePersistedTemplate} from '../../src/executor/persistence.js';
import {resolveWorkflowParticipants} from '../../src/executor/participant-resolver.js';
import {resolveWorkflowCooperation} from '../../src/executor/workflow-cooperation.js';
import {applyRequiredTemplateNumberRule,attachRequiredTemplateNumberRuleReadback} from '../../src/executor/template-number-rule.js';
import {lockedDraftEvidenceDigest,repairLockedDraft} from '../../src/executor/locked-draft-repair.js';
import {FORMAL_EDITOR_READERS_PROFILE,restoreFormalEditorReaderAuthorization,restoreFormalReaderWorkflowCooperation} from '../../src/executor/formal-editor-readers-repair.js';
import {sampleBaseTemplate,sampleEnvelope} from '../helpers/persistence.js';
import {materializeNativeTemplateAuthorization} from '../helpers/native-template-authorization.js';
const ORIGIN='https://p-sit.onewo.com',TARGET='sole-reader-target',WORKFLOW='sole-reader-workflow',CATEGORY='sole-reader-category';
const FIXTURE='tests/fixtures/route-validation/formal-editor-readers-repair';
const HASH='a'.repeat(64),CREDENTIALS={username:'fake-reader-repair',encryptedPassword:'fake-private-password'};
const clone=value=>structuredClone(value);
const ids=value=>value.map(member=>member.fdId).sort();
function options(f,client,extra={}){return {authorizationProfile:FORMAL_EDITOR_READERS_PROFILE,repairKind:'template_authorization',sourceDraft:f.source,priorExecutionReport:f.report,expectedDslDigest:lockedDraftEvidenceDigest(f.dsl),expectedPriorReportDigest:lockedDraftEvidenceDigest(f.report),expectedSnapshotDigest:f.snapshotDigest,targetTemplateId:TARGET,targetCategoryId:CATEGORY,baseUrl:ORIGIN,credentials:CREDENTIALS,client,...extra};}
async function fixture(){
 const data=JSON.parse(fs.readFileSync(FIXTURE+'/authorization.json','utf8'));
 const source=cleanSourceFile(FIXTURE);source.template.authorization=clone(data.source);
 const draft=draftSourceDraft(source);const dsl=createTrustedMigrationDsl(source,draft,{externalAgentReviewed:true,reviewerName:'synthetic-fake-route-only',checkedAt:'2026-10-17T00:00:00.000Z',sourceDraftDigest:sha256Digest(source),dslDraftDigest:sha256Digest(draft)});
 const resolveClient={getElementInfo:async wanted=>data.targets.filter(t=>wanted.includes(t.fdId)),searchOrg:async key=>data.targets.filter(t=>t.fdNo===key),getWorkflowCooperationConfig:async()=>({nodeHandlerTurningWay:'3'})};
 const cooperate=await resolveWorkflowCooperation(dsl,{client:resolveClient,workflowCooperationDefault:'3',targetBaseUrl:ORIGIN,now:new Date('2026-10-17T00:00:00.000Z')});
 const resolved=await resolveWorkflowParticipants(cooperate.dsl,{client:resolveClient,targetBaseUrl:ORIGIN,fallbackFdIds:{person:data.fallbackId},allowTemplateAuthorizationFallback:true});
 const envelope=sampleEnvelope({templateId:TARGET,templateName:'MK_TEST_SyntheticReaderRepair',categoryId:CATEGORY,tableName:'mk_model_sole_reader',bindings:{formFdId:TARGET,workflowFdId:WORKFLOW}});
 const base=sampleBaseTemplate({fdId:TARGET,fdName:envelope.templateName,fdCategory:{fdId:CATEGORY},fdTableName:envelope.tableName,fdAlterTime:1000,mechanisms:{'sys-xform':{fdId:TARGET,fdName:envelope.templateName,fdTableName:envelope.tableName,fdStatus:'draft',fdConfig:'{}',fdAlterTime:1001},lbpmTemplate:[{fdId:WORKFLOW,fdStatus:'draft',isDraft:true,fdTemplateForms:[]}]}});
 const prepared=preparePersistedTemplate({dsl:resolved.dsl,envelope,baseTemplate:base});assert.equal(prepared.ok,true,JSON.stringify(prepared.diagnostics));
 const template=applyRequiredTemplateNumberRule(clone(prepared.update));
 Object.assign(template.mechanisms.lbpmTemplate[0],{fdEntityId:TARGET,fdStatus:'draft',isDraft:true,fdSystemCode:'INNER_SYSTEM',fdRunType:'1',fdDisableBpmInit:false,fdFormCategory:{fdFormCategoryId:CATEGORY}});
 const workflow=clone(template.mechanisms.lbpmTemplate[0]);template.fdAllReaders=[{fdId:data.unintendedReaderId,fdName:'Inherited unintended reader'}];
 const attached=clone(template);attached.mechanisms.lbpmTemplate=[clone(workflow)];
 const readback=attachRequiredTemplateNumberRuleReadback(prepared.verify(attached),template);
 assert.equal(readback.ok,false);assert.deepEqual(readback.diagnostics.filter(d=>d.level==='error').map(d=>d.code),['readback.workflow.template_authorization_mismatch']);
 const typed=resolved.fallbackTargetsByOrgType;
 const stage={name:'resolveWorkflowParticipants',status:'ok',resolvedCount:resolved.resolvedCount,identityCount:resolved.identityCount,fallbackCount:resolved.fallbackCount,fallbackIdentityCount:resolved.fallbackIdentityCount,fallbackTargetId:resolved.fallbackTargetIds[0],fallbackTargetIds:resolved.fallbackTargetIds,fallbackTargetsByOrgType:typed};
 const warning={level:'warning',code:'workflow.participant_sit_fallback_applied',details:{targetFdIds:resolved.fallbackTargetIds,identityCount:resolved.fallbackIdentityCount,referenceCount:resolved.fallbackCount,targetsByOrgType:typed}};
 const report={ok:false,status:'readback_failed',stage:'readback',failedAt:'readback',baseUrl:ORIGIN,templateId:TARGET,createdFdIds:[TARGET],updatedFdIds:[],writeOutcomeUnknown:false,readback,diagnostics:[warning,...readback.diagnostics],apiStages:[{name:'resolveWorkflowCooperation',status:'ok',nodes:cooperate.nodes,config:cooperate.config,fallbackCount:cooperate.fallbackCount},stage,{name:'resolveConditionOrgs',status:'ok',resolvedCount:0,nameCount:0,fdNoCount:0},...['add','update','saveWorkflowDraft','getWorkflowTemplateDetail','readback'].map(name=>({name,status:'ok'}))],plan:buildDryRunPlan(dsl)};
 return {source,dsl,template,workflow,report,data,snapshotDigest:lockedDraftEvidenceDigest({template,workflow})};
}
class Client{
 constructor(f){this.template=clone(f.template);this.workflow=clone(f.workflow);this.targets=clone(f.data.targets);this.calls=[];}
 async login(){this.calls.push('login');}async assertTransferRecordAuthentication(){this.calls.push('record-preflight');}
 async getElementInfo(wanted){this.calls.push('elements');return this.targets.filter(t=>wanted.includes(t.fdId)).map(clone);}
 async searchOrg(){throw new Error('This profile cannot search for new identities');}
 async getTemplate(){this.calls.push('get-template');this.onGet?.(this);return clone(this.template);}
 async getWorkflowTemplateDetail(){this.calls.push('get-workflow');return clone(this.workflow);}
 async updateTemplate(payload){this.calls.push('update');if(this.unknownUpdate)throw new Error('unknown update');this.payload=clone(payload);this.template=clone(payload);this.template.fdAlterTime+=2;this.template.mechanisms['sys-xform'].fdAlterTime+=2;this.afterUpdate?.(this);return {fdId:TARGET};}
 async saveWorkflowDraft(){this.calls.push('workflow-write');throw new Error('Workflow writes forbidden');}
 async addTransferRecord(payload){this.calls.push('record');if(this.unknownRecord)throw new Error('unknown record');return {fdId:payload.fdId};}
 writes(){return this.calls.filter(c=>['update','workflow-write','record'].includes(c));}
}

it('keeps a coalesced restricted reader formal, so the native aggregate is not public',async()=>{
 const f=await fixture();assert.deepEqual(ids(f.template.fdReaders),[f.data.fallbackId]);
 const native=clone(f.template);materializeNativeTemplateAuthorization(native,{everyone:{fdId:'native-everyone',fdName:'Everyone'}});assert.deepEqual(ids(native.fdAllReaders),ids(f.template.fdEditors));
});
it('does not reinterpret the new explicit-reader projection as the obsolete editor-only aggregate shape',async()=>{
 const f=await fixture(),restored=restoreFormalEditorReaderAuthorization(f.dsl,f.source,f.report);assert.equal(restored.ok,false);assert.ok(restored.diagnostics.some(d=>d.code==='locked_draft.formal_readers_expected_editor_set_mismatch'));
});
it('retires aggregate-only preview and confirm paths before any I/O, write, record or new claim',async()=>{
 for(const confirmWrite of [false,true]){const f=await fixture(),c=new Client(f),root=mkdtempSync(join(tmpdir(),'retired-reader-'));try{const output=join(root,'unused');const r=await repairLockedDraft(f.dsl,options(f,c,{confirmWrite,expectedEvidenceDigest:HASH,artifactsDir:output,testLockRoot:join(root,'locks')}));assert.equal(r.ok,false);assert.equal(r.status,'blocked');assert.ok(r.diagnostics.some(d=>d.code==='locked_draft.derived_readers_not_writable'));assert.deepEqual(c.calls,[]);assert.equal(fs.existsSync(output),false);assert.equal(fs.existsSync(join(root,'locks')),false);}finally{rmSync(root,{recursive:true,force:true});}}
});
it('does not change an existing permanent lock when the retired profile is supplied another directory',async()=>{
 const f=await fixture(),c=new Client(f),root=mkdtempSync(join(tmpdir(),'retired-existing-lock-'));try{const locks=join(root,'locks');fs.mkdirSync(locks);const file=join(locks,'permanent.json'),content=JSON.stringify({status:'readback_failed',templateWriteCompleted:true,transferRecordStarted:false});fs.writeFileSync(file,content);const r=await repairLockedDraft(f.dsl,options(f,c,{confirmWrite:true,expectedEvidenceDigest:HASH,artifactsDir:join(root,'other'),testLockRoot:locks}));assert.equal(r.ok,false);assert.equal(fs.readFileSync(file,'utf8'),content);assert.deepEqual(fs.readdirSync(locks),['permanent.json']);assert.deepEqual(c.writes(),[]);}finally{rmSync(root,{recursive:true,force:true});}
});
it('native fake ignores both stale and five-editor aggregates when formal readers remain empty',()=>{
 const f={fdReaders:[],fdEditors:[{fdId:'person-a'},{fdId:'person-b'}],fdAllReaders:[{fdId:'person-a'},{fdId:'person-b'}]};const everyone={fdId:'native-everyone',fdName:'Everyone'};materializeNativeTemplateAuthorization(f,{everyone});assert.deepEqual(ids(f.fdAllReaders),[everyone.fdId]);f.fdAllReaders=[{fdId:'guessed-reader'}];materializeNativeTemplateAuthorization(f,{everyone});assert.deepEqual(ids(f.fdAllReaders),[everyone.fdId]);
});
it('retired aggregate capability cannot be revived with stale, success or already-recorded reports',async()=>{
 for(const change of [f=>f.report.writeOutcomeUnknown=true,f=>f.report.status='succeeded',f=>f.report.transferRecord={status:'recorded'},f=>f.report.readback.invariantVersion=39]){const f=await fixture();change(f);const c=new Client(f),r=await repairLockedDraft(f.dsl,options(f,c));assert.equal(r.ok,false);assert.deepEqual(c.calls,[]);}
});
