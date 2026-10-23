import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it} from 'node:test';
import {sha256Digest} from '../../src/agent-review/digest.js';
import {engineDigest} from '../../src/batch/contracts.js';
import {createTrustedMigrationDsl} from '../../src/dsl/trust.js';
import {NewoaClient} from '../../src/executor/newoa-client.js';
import {repairChoiceOther} from '../../src/executor/choice-other-repair.js';
import {applyFormPayload} from '../../src/executor/persistence/form-writer.js';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {sampleBaseTemplate,xformConfig} from '../helpers/persistence.js';

const BASE_URL='https://repair.example.test',CATEGORY='category-id',TARGET='template-id';
function fixture(){
 const sourceDraft=cleanSourceFile('tests/fixtures/route-validation/checkbox-other-compatible/compatible_SysFormTemplate.xml');
 const dsl=createTrustedMigrationDsl(sourceDraft,draftSourceDraft(sourceDraft),{externalAgentReviewed:true,sourceDraftDigest:sha256Digest(sourceDraft)}),priorDsl=structuredClone(dsl),caption=priorDsl.form.fields.find(f=>f.id==='fd_other_caption');
 Object.assign(caption,{type:'description',componentId:'xform-description',props:{content:'其他'},generated:false});delete caption.sourceProps.choiceOtherToggle;
 const template=applyFormPayload(sampleBaseTemplate(),priorDsl),workflow={...template.mechanisms.lbpmTemplate[0],fdName:template.fdName,fdEntityId:template.fdId,fdCategory:{fdFormCategoryId:CATEGORY},fdFormCategory:{fdFormCategoryId:CATEGORY},fdTemplateForms:[{fdFormKey:TARGET,fdFormCode:TARGET}],fdContent:'<process><node id="start"/></process>',fdEditors:[]};
 template.mechanisms.lbpmTemplate=[structuredClone(workflow)];template.fdAlter={fdId:'actor',fdName:'Actor'};template.fdAlterTime=100;template.mechanisms['sys-xform'].fdAlterTime=100;
 const config=xformConfig(template);config.dataModel[0].fdAlterTime=100;template.mechanisms['sys-xform'].fdConfig=JSON.stringify(config);
 const sourceId=sourceDraft.source.fdModelId;
 const priorExecutionReport={ok:true,status:'written',baseUrl:BASE_URL,templateId:TARGET,createdFdIds:[TARGET],updatedFdIds:[],writeOutcomeUnknown:false,remoteWriteAttempted:true,readback:{ok:true,partitions:Object.fromEntries(['envelope','form','rules','scripts','workflow'].map(k=>[k,'verified']))},apiStages:[{name:'add',status:'ok'},{name:'update',status:'ok'},{name:'saveWorkflowDraft',status:'ok'},{name:'addTransferRecord',status:'ok'}],transferRecord:{status:'recorded',fdId:'prior-record',fdOriginalId:sourceId,fdTargetId:TARGET}};
 const scope={version:1,operation:'source-bound-checkbox-other-draft-update',baseUrl:BASE_URL,targetCategoryId:CATEGORY,targets:[{sourceId,targetTemplateId:TARGET}],request:'Update the migrated templates affected by checkbox Other.'};
 const options={sourceDraft,priorSourceDraft:structuredClone(sourceDraft),priorDsl,priorExecutionReport,scope,baseUrl:BASE_URL,targetCategoryId:CATEGORY,targetTemplateId:TARGET,credentials:{username:'test-user',encryptedPassword:'test-encrypted'}};
 return {dsl,options,template,workflow};
}
function bind(fixture,extra={}){const o={...fixture.options,...extra};return {...o,expectedDslDigest:sha256Digest(fixture.dsl),expectedPriorDslDigest:sha256Digest(o.priorDsl),expectedSourceDigest:sha256Digest(o.sourceDraft),expectedPriorReportDigest:sha256Digest(o.priorExecutionReport),expectedScopeDigest:sha256Digest(o.scope),expectedEngineDigest:engineDigest()};}
class FakeClient{
 constructor(f){this.baseUrl=BASE_URL;this.template=structuredClone(f.template);this.workflow=structuredClone(f.workflow);this.calls=[];this.reads=0;}
 async login(){this.calls.push('login');}
 async getTemplate(){this.calls.push('getTemplate');this.reads++;this.onRead?.(this);return structuredClone(this.template);}
 async getWorkflowTemplateDetail(){this.calls.push('getWorkflowTemplateDetail');return structuredClone(this.workflow);}
 async getElementInfo(ids){this.calls.push('getElementInfo');return ids.map(fdId=>({fdId,fdName:'Person',fdOrgType:8,fdIsAvailable:true,fdIsBusiness:true}));}
 async updateTemplate(payload){this.calls.push('updateTemplate');this.write?.(payload,this);this.template=structuredClone(payload);return {success:true,fdId:TARGET};}
}
function temporary(t){const root=mkdtempSync(join(tmpdir(),'mk-choice-other-repair-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
async function prepare(t){const f=fixture(),client=new FakeClient(f),root=temporary(t),options=bind(f,{client,testLockRoot:join(root,'locks'),allowTestLockRoot:true});const preview=await repairChoiceOther(f.dsl,options);assert.equal(preview.ok,true,JSON.stringify(preview));return {f,client,root,options,preview};}

it('previews a source-bound Other update without any write endpoint',async()=>{
 const f=fixture(),client=new FakeClient(f),result=await repairChoiceOther(f.dsl,bind(f,{client}));
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.status,'choice_other_repair_ready');assert.ok(result.evidenceDigest.startsWith('sha256:'));assert.equal(client.calls.filter(c=>c==='getTemplate').length,3);assert.equal(client.calls.includes('updateTemplate'),false);assert.equal(result.plan.workflowWrites,0);assert.equal(result.plan.recordWrites,0);
});
it('updates once, keeps the complete graph and original migration record, and writes private evidence',async t=>{
 const {f,client,root,options,preview}=await prepare(t),original=structuredClone(client.template),graph=client.workflow.fdContent;
 const result=await repairChoiceOther(f.dsl,{...options,confirmWrite:true,expectedEvidenceDigest:preview.evidenceDigest,artifactsDir:join(root,'apply')});
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.status,'choice_other_repaired');assert.deepEqual(result.createdFdIds,[]);assert.deepEqual(result.updatedFdIds,[TARGET]);assert.equal(result.transferRecord.status,'preserved');assert.equal(result.transferRecord.fdId,'prior-record');assert.equal(client.calls.filter(c=>c==='updateTemplate').length,1);assert.equal(client.template.mechanisms.lbpmTemplate[0].fdContent,graph);assert.equal(client.workflow.fdContent,graph);
 const before=xformConfig(original),after=xformConfig(client.template);for(const id of ['fd_choice','fd_other_text'])assert.deepEqual(after.dataModel[0].fdFields.find(f=>f.fdName===id),before.dataModel[0].fdFields.find(f=>f.fdName===id));assert.equal(after.dataModel[0].fdFields.find(f=>f.fdName==='fd_other_caption').fdType,'checkbox');
 assert.equal(statSync(join(root,'apply')).mode&0o077,0);assert.equal(statSync(join(root,'apply','receipt.json')).mode&0o077,0);assert.equal(JSON.parse(readFileSync(join(root,'apply','receipt.json'),'utf8')).acknowledged,true);
 assert.ok(client.calls.every(name=>['login','getTemplate','getWorkflowTemplateDetail','getElementInfo','updateTemplate'].includes(name)));
});
for(const [label,mutate]of [
 ['stale input digest',(f,o)=>o.expectedDslDigest='sha256:stale'],
 ['stale prior DSL digest',(f,o)=>o.expectedPriorDslDigest='sha256:stale'],
 ['stale source digest',(f,o)=>o.expectedSourceDigest='sha256:stale'],
 ['stale prior report digest',(f,o)=>o.expectedPriorReportDigest='sha256:stale'],
 ['stale scope digest',(f,o)=>o.expectedScopeDigest='sha256:stale'],
 ['stale engine digest',(f,o)=>o.expectedEngineDigest='sha256:stale'],
 ['missing credentials',(f,o)=>o.credentials={}],
 ['wrong client origin',(f,o)=>o.client.baseUrl='https://other.example.test'],
 ['different historical source',(f,o)=>o.priorSourceDraft.template.name+=' changed'],
 ['incomplete historical invariants',(f,o)=>{o.priorExecutionReport.readback.partitions.scripts='mismatch';o.expectedPriorReportDigest=sha256Digest(o.priorExecutionReport);}],
 ['uncertain historical phase',(f,o)=>{o.priorExecutionReport.apiStages.push({name:'updateTemplate',status:'failed',writeOutcomeUnknown:true});o.expectedPriorReportDigest=sha256Digest(o.priorExecutionReport);}],
 ['wrong historical source',(f,o)=>{o.priorExecutionReport.transferRecord.fdOriginalId='another';o.expectedPriorReportDigest=sha256Digest(o.priorExecutionReport);}],
 ['wrong target scope',(f,o)=>{o.scope.targets[0].targetTemplateId='another';o.expectedScopeDigest=sha256Digest(o.scope);}],
 ['wrong category scope',(f,o)=>{o.scope.targetCategoryId='another';o.expectedScopeDigest=sha256Digest(o.scope);}],
 ['missing human request',(f,o)=>{o.scope.request='';o.expectedScopeDigest=sha256Digest(o.scope);}],
 ['untrusted input',(f,o)=>{delete f.dsl.trust;o.expectedDslDigest=sha256Digest(f.dsl);}]
])it('blocks before client access: '+label,async()=>{const f=fixture(),client=new FakeClient(f),options=bind(f,{client});mutate(f,options);const result=await repairChoiceOther(f.dsl,options);assert.equal(result.ok,false,label);assert.equal(client.calls.length,0,label);});

it('blocks a changing snapshot before approval or write',async()=>{const f=fixture(),client=new FakeClient(f);client.onRead=c=>{if(c.reads===2)c.template.fdDescription='concurrent edit';};const result=await repairChoiceOther(f.dsl,bind(f,{client}));assert.equal(result.ok,false);assert.equal(result.diagnostics[0].code,'choice_other_repair.snapshot_changed');assert.equal(client.calls.includes('updateTemplate'),false);});
it('binds approval to the current complete snapshot',async t=>{const {f,client,root,options,preview}=await prepare(t);client.template.fdDescription='after preview';const result=await repairChoiceOther(f.dsl,{...options,confirmWrite:true,expectedEvidenceDigest:preview.evidenceDigest,artifactsDir:join(root,'apply')});assert.equal(result.ok,false);assert.equal(result.diagnostics[0].code,'choice_other_repair.evidence_digest_mismatch');assert.equal(client.calls.includes('updateTemplate'),false);});
it('keeps an uncertain write permanently locked even with a new artifacts directory',async t=>{
 const {f,client,root,options,preview}=await prepare(t);client.write=()=>{throw new Error('network ended after send');};
 const first=await repairChoiceOther(f.dsl,{...options,confirmWrite:true,expectedEvidenceDigest:preview.evidenceDigest,artifactsDir:join(root,'first')});assert.equal(first.ok,false);assert.equal(first.status,'outcome_unknown');assert.equal(first.writeOutcomeUnknown,true);assert.equal(first.writeAcknowledged,false);
 const second=await repairChoiceOther(f.dsl,{...options,confirmWrite:true,expectedEvidenceDigest:preview.evidenceDigest,artifactsDir:join(root,'second')});assert.equal(second.ok,false);assert.equal(client.calls.filter(c=>c==='updateTemplate').length,1);
});
it('does not replay an acknowledged write whose protected readback differs',async t=>{
 const {f,client,root,options,preview}=await prepare(t);client.onRead=c=>{if(c.calls.includes('updateTemplate'))c.template.fdReaders=[{fdId:'injected'}];};
 const result=await repairChoiceOther(f.dsl,{...options,confirmWrite:true,expectedEvidenceDigest:preview.evidenceDigest,artifactsDir:join(root,'apply')});assert.equal(result.ok,false);assert.equal(result.status,'readback_failed');assert.equal(result.writeOutcomeUnknown,false);assert.equal(result.writeAcknowledged,true);assert.equal(client.calls.filter(c=>c==='updateTemplate').length,1);assert.equal(JSON.parse(readFileSync(join(root,'apply','receipt.json'),'utf8')).acknowledged,true);
});
it('requires explicit isolated fake-lock permission before using testLockRoot',async()=>{const f=fixture(),client=new FakeClient(f),result=await repairChoiceOther(f.dsl,bind(f,{client,testLockRoot:'/ignored/test-locks'}));assert.equal(result.ok,false);assert.equal(client.calls.length,0);});
for(const origin of ['https://repair.example.test/path','https://repair.example.test/?q=1','https://user:secret@repair.example.test','file:///tmp/repair','https://repair.example.test/'])it('rejects an unnormalized or non-root origin before client access: '+origin,async()=>{const f=fixture(),client=new FakeClient(f),options=bind(f,{client,baseUrl:origin});const result=await repairChoiceOther(f.dsl,options);assert.equal(result.ok,false);assert.equal(client.calls.length,0);});
for(const [label,mutate]of [
 ['published lifecycle',c=>{c.template.fdStatus=1;}],
 ['wrong category',c=>{c.template.fdCategory.fdId='other-category';}],
 ['wrong XForm identity',c=>{c.template.mechanisms['sys-xform'].fdId='other-form';}],
 ['versioned XForm',c=>{c.template.mechanisms['sys-xform'].fdVersionId='official-version';}],
 ['missing graph',c=>{c.workflow.fdContent='';}],
 ['different bound graph',c=>{c.template.mechanisms.lbpmTemplate[0].fdContent='<different/>';}]
])it('rejects an ineligible live draft without any write: '+label,async()=>{const f=fixture(),client=new FakeClient(f);mutate(client);const result=await repairChoiceOther(f.dsl,bind(f,{client}));assert.equal(result.ok,false);assert.equal(client.calls.includes('updateTemplate'),false);});
it('independently verifies current editors by exact typed identity before plan preparation',async()=>{
 for(const type of [8,4]){
  const f=fixture(),client=new FakeClient(f);for(const workflow of [client.workflow,client.template.mechanisms.lbpmTemplate[0]])workflow.fdEditors=[{fdId:'editor',fdName:'Person'}];
  client.getElementInfo=async(ids,options)=>{client.calls.push('getElementInfo');assert.deepEqual(ids,['editor']);assert.deepEqual(options,{builtinEvidence:true});return [{fdId:'editor',fdName:'Person',fdOrgType:type,fdIsAvailable:true,fdIsBusiness:true}];};
  const result=await repairChoiceOther(f.dsl,bind(f,{client}));assert.equal(result.ok,type===8,JSON.stringify(result));assert.equal(client.calls.includes('updateTemplate'),false);
 }
});
it('preserves the known acknowledgement when the first readback request fails',async t=>{
 const {f,client,root,options,preview}=await prepare(t);client.onRead=c=>{if(c.calls.includes('updateTemplate'))throw new Error('temporary read error');};
 const result=await repairChoiceOther(f.dsl,{...options,confirmWrite:true,expectedEvidenceDigest:preview.evidenceDigest,artifactsDir:join(root,'apply')});assert.equal(result.status,'readback_failed');assert.equal(result.writeOutcomeUnknown,false);assert.equal(result.writeAcknowledged,true);assert.equal(client.calls.filter(c=>c==='updateTemplate').length,1);assert.equal(JSON.parse(readFileSync(join(root,'apply','receipt.json'),'utf8')).acknowledged,true);
});
it('does not allow a successful consumed claim to run again after restoring old state',async t=>{
 const {f,client,root,options,preview}=await prepare(t);
 const result=await repairChoiceOther(f.dsl,{...options,confirmWrite:true,expectedEvidenceDigest:preview.evidenceDigest,artifactsDir:join(root,'apply')});assert.equal(result.ok,true,JSON.stringify(result));
 client.template=structuredClone(f.template);client.workflow=structuredClone(f.workflow);
 const again=await repairChoiceOther(f.dsl,{...options,confirmWrite:true,expectedEvidenceDigest:preview.evidenceDigest,artifactsDir:join(root,'another-directory')});assert.equal(again.ok,false);assert.equal(again.diagnostics[0].code,'choice_other_repair.permanent_lock_exists');assert.equal(client.calls.filter(c=>c==='updateTemplate').length,1);
});
it('never permits a native client to redirect permanent claims into a test lock directory',async()=>{
 const f=fixture(),client=new NewoaClient({baseUrl:BASE_URL});let loginCalled=false;client.login=async()=>{loginCalled=true;};
 const result=await repairChoiceOther(f.dsl,bind(f,{client,testLockRoot:'/tmp/native-must-not-use-test-lock',allowTestLockRoot:true}));
 assert.equal(result.ok,false);assert.equal(result.diagnostics[0].code,'choice_other_repair.test_lock_permission_required');assert.equal(loginCalled,false);
});
it('blocks a target changed while current editor identities are being queried',async t=>{
 const f=fixture(),client=new FakeClient(f),root=temporary(t);for(const workflow of [client.workflow,client.template.mechanisms.lbpmTemplate[0]])workflow.fdEditors=[{fdId:'editor',fdName:'Person'}];
 const options=bind(f,{client,testLockRoot:join(root,'locks'),allowTestLockRoot:true});
 const preview=await repairChoiceOther(f.dsl,options);assert.equal(preview.ok,true,JSON.stringify(preview));
 client.getElementInfo=async()=>{client.calls.push('getElementInfo');client.template.fdDescription='concurrent editor-query edit';return [{fdId:'editor',fdName:'Person',fdOrgType:8,fdIsAvailable:true,fdIsBusiness:true}];};
 const result=await repairChoiceOther(f.dsl,{...options,confirmWrite:true,expectedEvidenceDigest:preview.evidenceDigest,artifactsDir:join(root,'apply')});
 assert.equal(result.ok,false);assert.equal(result.diagnostics[0].code,'choice_other_repair.post_editor_snapshot_changed');assert.equal(client.calls.includes('updateTemplate'),false);assert.equal(client.template.fdDescription,'concurrent editor-query edit');
});
it('consumes the permanent claim and blocks a drift detected by the last prewrite read',async t=>{
 const {f,client,root,options,preview}=await prepare(t),stable=structuredClone(client.template);
 client.onRead=c=>{if(c.reads===7)c.template.fdDescription='concurrent prewrite edit';};
 const result=await repairChoiceOther(f.dsl,{...options,confirmWrite:true,expectedEvidenceDigest:preview.evidenceDigest,artifactsDir:join(root,'first')});
 assert.equal(result.ok,false);assert.equal(result.diagnostics[0].code,'choice_other_repair.prewrite_snapshot_changed');assert.equal(result.writeOutcomeUnknown,false);assert.equal(client.calls.includes('updateTemplate'),false);
 assert.equal(JSON.parse(readFileSync(join(root,'first','prewrite.json'),'utf8')).template.fdDescription,'concurrent prewrite edit');
 client.onRead=undefined;client.template=stable;
 const again=await repairChoiceOther(f.dsl,{...options,confirmWrite:true,expectedEvidenceDigest:preview.evidenceDigest,artifactsDir:join(root,'another-directory')});
 assert.equal(again.ok,false);assert.equal(again.diagnostics[0].code,'choice_other_repair.permanent_lock_exists');assert.equal(client.calls.includes('updateTemplate'),false);
});
function withReaders(f,client){
 const readers=[{fdId:'department-reader',fdName:'Department',fdOrgType:2},{fdId:'post-reader',fdName:'Post',fdOrgType:4}];
 client.template.fdReaders=structuredClone(readers);
 for(const workflow of [client.workflow,client.template.mechanisms.lbpmTemplate[0]])workflow.fdReaders=structuredClone(readers);
 return readers;
}
function readerTargets(){return [{fdId:'department-reader',fdName:'Department',fdOrgType:2,fdIsAvailable:true,fdIsBusiness:true},{fdId:'post-reader',fdName:'Post',fdOrgType:4,fdIsAvailable:true,fdIsBusiness:true}];}
it('verifies unchanged department and post readers independently before allowing native display-name omission',async t=>{
 const f=fixture(),client=new FakeClient(f),root=temporary(t),readers=withReaders(f,client);let queries=0;
 client.getElementInfo=async(ids,options)=>{client.calls.push('getElementInfo');queries++;assert.deepEqual(ids,['department-reader','post-reader']);assert.deepEqual(options,{builtinEvidence:true});return readerTargets();};
 const options=bind(f,{client,testLockRoot:join(root,'locks'),allowTestLockRoot:true}),preview=await repairChoiceOther(f.dsl,options);assert.equal(preview.ok,true,JSON.stringify(preview));
 client.onRead=c=>{if(c.calls.includes('updateTemplate'))for(const workflow of [c.workflow,c.template.mechanisms.lbpmTemplate[0]])for(const reader of workflow.fdReaders)delete reader.fdName;};
 const result=await repairChoiceOther(f.dsl,{...options,confirmWrite:true,expectedEvidenceDigest:preview.evidenceDigest,artifactsDir:join(root,'apply')});
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(queries,2);assert.equal(client.calls.filter(name=>name==='updateTemplate').length,1);
 for(const workflow of [client.workflow,client.template.mechanisms.lbpmTemplate[0]])assert.deepEqual(workflow.fdReaders,readers.map(({fdName,...identity})=>identity));
});
for(const [label,mutate]of [
 ['missing independent proof',targets=>targets.pop()],
 ['unknown native reader type',targets=>targets[0].fdOrgType=512],
 ['untyped string reader type',targets=>targets[0].fdOrgType='2'],
 ['unlisted role type',targets=>targets[0].fdOrgType=32],
 ['wrong referenced reader type',targets=>targets[0].fdOrgType=4],
 ['wrong display identity',targets=>targets[0].fdName='Another department'],
 ['missing availability evidence',targets=>delete targets[0].fdIsAvailable],
 ['not a business principal',targets=>targets[0].fdIsBusiness=false]
])it('rejects unproven unchanged reader metadata before any write: '+label,async()=>{
 const f=fixture(),client=new FakeClient(f);withReaders(f,client);client.getElementInfo=async()=>{client.calls.push('getElementInfo');const targets=readerTargets();mutate(targets);return targets;};
 const result=await repairChoiceOther(f.dsl,bind(f,{client}));assert.equal(result.ok,false);assert.equal(client.calls.includes('updateTemplate'),false);
});
it('includes root readers in the independent query while preserving their exact native references',async()=>{
 const f=fixture(),client=new FakeClient(f);client.template.fdReaders=[{fdId:'root-reader',fdName:'Root department',fdOrgType:2}];
 client.getElementInfo=async(ids)=>{client.calls.push('getElementInfo');assert.deepEqual(ids,['root-reader']);return [{fdId:'root-reader',fdName:'Root department',fdOrgType:2,fdIsAvailable:true,fdIsBusiness:true}];};
 const result=await repairChoiceOther(f.dsl,bind(f,{client}));assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(client.template.fdReaders,[{fdId:'root-reader',fdName:'Root department',fdOrgType:2}]);
});
