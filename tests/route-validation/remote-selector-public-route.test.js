import assert from 'node:assert/strict';
import {it} from 'node:test';
import {cleanSourceFile} from '../../src/translator/index.js';
const fixture='tests/fixtures/route-validation/approved-remote-policies/route-approved-remote_SysFormTemplate.xml';
it('normal XML intake retains independently built remote selector runtime witnesses',()=>{
 const source=cleanSourceFile(fixture),fields=[...source.form.controls,...source.form.dataFields,...source.form.detailTables.flatMap(v=>v.columns)];
 const remote=fields.filter(v=>v.sourceProps?.remoteSelectorSourceContract);assert.equal(remote.length,2);
 for(const field of remote)assert.equal(field.sourceProps?.approvedRemoteSelectorSourceFact?.status,'verified');
});

import {remotePublicInput,fakeRemoteClient} from '../helpers/remote-selector-public.js';
import {checkTrust} from '../../src/dsl/trust.js';
import {validateMigrationDsl} from '../../src/dsl/schema.js';
import {buildDryRunPlan} from '../../src/executor/dry-run.js';
import {executeDsl} from '../../src/executor/execute.js';
import {withNetworkGuard} from './network-guard.js';

it('normal approved GET selector policy passes trust, execute checks and dry-run',()=>{
 const {source,dsl}=remotePublicInput();
 assert.equal(checkTrust(source,dsl).ok,true,JSON.stringify(checkTrust(source,dsl).diagnostics));
 assert.equal(validateMigrationDsl(dsl,{mode:'execute'}).ok,true);
 assert.equal(buildDryRunPlan(dsl).ok,true);
});
it('full fake public route creates a new draft, verifies persisted form and resources, then records migration',async()=>withNetworkGuard(async()=>{
 const {dsl,resources}=remotePublicInput(),client=fakeRemoteClient(resources);
 const result=await executeDsl(dsl,{client,baseUrl:client.baseUrl,confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'fixture',encryptedPassword:'fixture'}});
 assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
 assert.equal(result.readback.partitions.remoteResources,'verified');
 assert.equal(result.transferRecord.status,'recorded');
 assert.equal(client.sequence.filter(v=>v==='getTicInterface').length,4);
 assert.ok(client.sequence.indexOf('getTicInterface')<client.sequence.indexOf('addTemplate'));
 assert.ok(client.sequence.lastIndexOf('getTicInterface')<client.sequence.indexOf('addTransferRecord'));
 assert.equal(client.sequence.includes('executeForAjax'),false);
}));

it('resource preflight rejects mismatched state or unavailable metadata before any draft write',async()=>withNetworkGuard(async()=>{
 for(const mutate of [
  entity=>{entity.fdAllowAjaxCall=false;},entity=>{entity.fdAjaxCallers=[];},entity=>{entity.fdStatus=0;},entity=>{entity.fdLogEnabled=true;},
  entity=>{entity.protocolData.fdRequestWay='postBody';},entity=>{entity.protocolData.fdRequestUrl+='&changed=1';},entity=>{entity.protocolData.fdBodyResponse='{"type":"object"}';}
 ]){
  const {dsl,resources}=remotePublicInput();mutate(resources[0].nativeInterface);const client=fakeRemoteClient(resources);
  const result=await executeDsl(dsl,{client,baseUrl:client.baseUrl,confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'fixture',encryptedPassword:'fixture'}});
  assert.equal(result.ok,false);assert.equal(result.status,'blocked');assert.equal(result.failedAt,'verifyRemoteSelectorResources');assert.equal(result.remoteWriteAttempted,false);assert.equal(result.writeOutcomeUnknown,false);assert.equal(client.sequence.includes('addTemplate'),false);assert.equal(client.sequence.includes('addTransferRecord'),false);
 }
 const {dsl,resources}=remotePublicInput(),client=fakeRemoteClient(resources);client.getTicInterface=async()=>{throw Error('https://private.invalid/?token=private-key');};
 const failed=await executeDsl(dsl,{client,baseUrl:client.baseUrl,confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'fixture',encryptedPassword:'fixture'}});
 assert.equal(failed.remoteWriteAttempted,false);assert.equal(JSON.stringify(failed).includes('private-key'),false);
}));

it('resource drift after confirmed draft writes prevents transfer recording and preserves the created target',async()=>withNetworkGuard(async()=>{
 const {dsl,resources}=remotePublicInput(),client=fakeRemoteClient(resources,{onReadInterface(entity,count){if(count>2)entity.fdAjaxCallers=[];return entity;}});
 const result=await executeDsl(dsl,{client,baseUrl:client.baseUrl,confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'fixture',encryptedPassword:'fixture'}});
 assert.equal(result.ok,false);assert.equal(result.status,'readback_failed');assert.equal(result.templateId,'route-created-template');assert.equal(result.remoteWriteAttempted,true);assert.equal(result.writeOutcomeUnknown,false);
 assert.equal(result.readback.partitions.remoteResources,'mismatch');assert.equal(client.sequence.includes('addTransferRecord'),false);assert.equal(client.sequence.filter(v=>v==='addTemplate').length,1);
}));

it('persisted selector script loss prevents success even when resource readbacks still match',async()=>withNetworkGuard(async()=>{
 const {dsl,resources}=remotePublicInput(),client=fakeRemoteClient(resources,{onGetReadback(entity){const x=entity.mechanisms['sys-xform'],config=JSON.parse(x.fdConfig);const form=JSON.parse(config.attribute.formAttr);form.controlAction={};config.attribute.formAttr=JSON.stringify(form);x.fdConfig=JSON.stringify(config);return entity;}});
 const result=await executeDsl(dsl,{client,baseUrl:client.baseUrl,confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'fixture',encryptedPassword:'fixture'}});
 assert.equal(result.ok,false);assert.equal(result.status,'readback_failed');assert.equal(client.sequence.includes('addTransferRecord'),false);
}));

it('missing wire/read-only contracts, scope mismatch and edited policy-owned implementations remain blocked',async()=>withNetworkGuard(async()=>{
 const {raw,source,dsl}=remotePublicInput();
 const {attachMigrationPolicies}=await import('../../src/translator/approved-migration-policies.js');
 for(const change of [d=>{delete d.wireEvidenceSha256;},d=>{delete d.request;},d=>{d.server.readOnlyVerified=false;},d=>{d.response.rowsPath=['__proto__'];},d=>{delete d.response.emptySelection;}]){const policy=structuredClone(source.migrationPolicies);change(policy.decisions[0]);assert.throws(()=>attachMigrationPolicies(raw,policy));}
 for(const change of [d=>{d.scripts.actions[0].function+='\nfetch("https://forbidden.invalid")';},d=>{d.scripts.actions[0].function=d.scripts.actions[0].function.replace('正在查询','altered');},d=>{d.form.fields[0].sourceProps.approvedRemoteSelectorSourceFact.script.javascriptSha256='sha256:'+'0'.repeat(64);},d=>{d.migrationPolicies.decisions[0].server.code='unapproved';}]){
  const changed=structuredClone(dsl);change(changed);assert.equal(checkTrust(source,changed).ok,false);const client=fakeRemoteClient(remotePublicInput().resources);const result=await executeDsl(changed,{client,baseUrl:client.baseUrl,confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'fixture',encryptedPassword:'fixture'}});assert.equal(result.ok,false);assert.deepEqual(client.sequence,[]);
 }
 for(const options of [{baseUrl:'https://different.example.invalid'},{targetCategoryId:'different'},{targetTemplateId:'existing'}]){const client=fakeRemoteClient(remotePublicInput().resources);const result=await executeDsl(dsl,{client,baseUrl:client.baseUrl,confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'fixture',encryptedPassword:'fixture'},...options});assert.equal(result.ok,false);assert.deepEqual(client.sequence,[]);}
}));

import {nativeRemoteSelectorFunction,inspectNativeRemoteSelectorFunction} from '../../src/dsl/native-remote-selector-profile.js';
import {buildDeterministicScriptBranchProof} from '../../src/dsl/deterministic-script-translations.js';
import {sha256Digest} from '../../src/agent-review/digest.js';
import {createHash} from 'node:crypto';
it('resealed runtime and audit cannot redirect source mappings to another table or field',async()=>withNetworkGuard(async()=>{
 for(const mutate of [
  spec=>{delete spec.outputMappings[0].tableId;delete spec.outputMappings[1].tableId;},
  spec=>{spec.outputMappings[2].fieldId='fd_nonexistent';},
  spec=>{spec.outputMappings[2].fieldId='fd_other';},
  spec=>{spec.inputMappings[0].fieldId='fd_region';},
  spec=>{spec.outputMappings.pop();}
 ]){
  const {source,dsl,resources}=remotePublicInput(),action=dsl.scripts.actions.find(action=>action.tableId),spec=inspectNativeRemoteSelectorFunction(action.function).spec;
  mutate(spec);action.function=nativeRemoteSelectorFunction(spec);action.deterministicBranchProof=buildDeterministicScriptBranchProof(action);
  const audit=dsl.migrationPolicyAudit.audits.find(audit=>audit.actionId===action.id);audit.inputMappings=structuredClone(spec.inputMappings);audit.outputMappings=structuredClone(spec.outputMappings);audit.functionSha256='sha256:'+createHash('sha256').update(action.function).digest('hex');dsl.migrationPolicyAudit.changedActionDigests.find(seal=>seal.id===action.id).digest=sha256Digest(action);dsl.scripts.javascript=dsl.scripts.actions.map(action=>action.function).join('\n\n');
  assert.equal(checkTrust(source,dsl).ok,false);assert.equal(validateMigrationDsl(dsl,{mode:'execute'}).ok,false);
  const client=fakeRemoteClient(resources),result=await executeDsl(dsl,{client,baseUrl:client.baseUrl,confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'fixture',encryptedPassword:'fixture'}});
  assert.equal(result.ok,false);assert.equal(result.remoteWriteAttempted,false);assert.deepEqual(client.sequence,[]);
 }
}));

it('a source callback without empty-result clearing cannot acquire clear semantics by rebuilding policy hashes',()=>{
 const {raw,decisions}=remotePublicInput(),changed=structuredClone(raw),remote=changed.form.controls.find(field=>field.sourceProps?.remoteSelectorSourceContract);
 const fact=remote.sourceProps.approvedRemoteSelectorSourceFact;fact.script.emptyResult='unchanged';const {digest:ignored,...body}=fact;fact.digest=sha256Digest(body);
 const decision={...decisions[0],runtimeFactDigest:fact.digest};
 const draft=draftSourceDraft(changed);assert.throws(()=>applyApprovedRemotePolicies(changed,draft,[decision]),/empty-result/);
});
import {draftSourceDraft} from '../../src/translator/index.js';
import {applyApprovedRemotePolicies} from '../../src/translator/approved-remote-policies.js';

import {MemoryBatchStore} from '../../src/batch/store.js';
import {createBatch,cleanSnapshot,sourceSnapshot} from '../../src/batch/intake.js';
import {prepareBatch,inspectBatch,approveBatch,executeBatch} from '../../src/batch/service.js';
import {createFakeReviewProvider} from './fake-review-provider.js';
import {migrationPolicySourceDigest} from '../../src/translator/approved-migration-policies.js';
import {resolve} from 'node:path';
it('existing durable batch path prepares, approves and records the same fixture policy with fake clients only',async()=>withNetworkGuard(async()=>{
 const {source,resources}=remotePublicInput(),path=resolve(fixture),original=cleanSnapshot(sourceSnapshot(path),'');
 const policy={...source.migrationPolicies,sourceDraftSha256:migrationPolicySourceDigest(original)},store=new MemoryBatchStore();
 const batch=await createBatch(store,{version:1,name:'synthetic remote selectors',migrationKey:'synthetic-remote-selectors',...policy.scope,executionConcurrency:1,items:[{sourcePath:path,migrationPolicies:policy}]});
 const worker={engineDigest:'fixture-remote-engine',concurrency:1,checkpointSigningKey:'fixture-remote-selector-signing-key-32-characters'};
 const prepared=await prepareBatch(store,batch.id,{...worker,provider:createFakeReviewProvider('accept')});assert.equal(prepared.counts.ready,1,JSON.stringify(prepared.items));
 const item=(await store.list('item',{batchId:batch.id}))[0];
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reorder(value[key])])):value;
 assert.equal(checkTrust(reorder(item.sourceDraft),reorder(item.dsl)).ok,true);
 const plan=await inspectBatch(store,batch.id);await approveBatch(store,batch.id,{expectedDigest:plan.approvalDigest,confirmWrite:true,actor:'fixture-only'});
 const client=fakeRemoteClient(resources),executed=await executeBatch(store,batch.id,{...worker,confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'},clientFactory:()=>client});
 assert.equal(executed.counts.succeeded,1,JSON.stringify(executed.items));
 const final=await store.get('item',item.id);assert.equal(final.attempts.at(-1).report.readback.partitions.remoteResources,'verified');assert.equal(final.attempts.at(-1).report.transferRecord.status,'recorded');assert.equal(client.sequence.filter(v=>v==='addTransferRecord').length,1);
}));
