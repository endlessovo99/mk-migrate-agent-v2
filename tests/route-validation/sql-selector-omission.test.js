import assert from 'node:assert/strict';
import {it} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {attachMigrationPolicies,migrationPolicySourceDigest} from '../../src/translator/approved-migration-policies.js';
import {sha256Digest} from '../../src/agent-review/digest.js';
import {createTrustedMigrationDsl,checkTrust} from '../../src/dsl/trust.js';
import {executeDsl} from '../../src/executor/execute.js';
import {FakeNewoaAdapter} from './fake-newoa-adapter.js';
import {withNetworkGuard} from './network-guard.js';
import {MemoryBatchStore} from '../../src/batch/store.js';
import {createBatch,cleanSnapshot,sourceSnapshot} from '../../src/batch/intake.js';
import {prepareBatch,inspectBatch,approveBatch,executeBatch} from '../../src/batch/service.js';
import {createFakeReviewProvider} from './fake-review-provider.js';
const file='tests/fixtures/route-validation/sql-selector-omission/route-sql-selector-omission_SysFormTemplate.xml';
function input(raw=cleanSourceFile(path.dirname(file))){
 const field=raw.form.detailTables[0].columns.find(f=>f.id==='project');
 const decision={id:'omit-sql',kind:'omit-remote-selector',sourceRef:field.sourceRef,contractDigest:sha256Digest(field.sourceProps.remoteSelectorSourceContract),omissionFactDigest:field.sourceProps.remoteSelectorOmissionSourceFact?.digest,mode:'manual-values'};
 const source=attachMigrationPolicies(raw,{version:1,sourceDraftSha256:migrationPolicySourceDigest(raw),scope:{baseUrl:'https://qas.example.invalid',targetCategoryId:'route-category-id'},authorization:{actor:'fixture-only',evidenceSha256:'sha256:'+'1'.repeat(64)},decisions:[decision]});
 const draft=draftSourceDraft(source),dsl=createTrustedMigrationDsl(source,draft,{externalAgentReviewed:true,reviewerName:'fixture-only'});return {raw,source,draft,dsl};
}
function altered(change,run){const root=fs.mkdtempSync(path.join(os.tmpdir(),'sql-omission-test-'));try{const p=path.join(root,'fixture_SysFormTemplate.xml');fs.writeFileSync(p,change(fs.readFileSync(file,'utf8')));return run(cleanSourceFile(p));}finally{fs.rmSync(root,{recursive:true,force:true});}}
it('source-bound SQL omission preserves noncontiguous enabled outputs, row replicas, workflow and required manual fields through fake readback/record',async()=>withNetworkGuard(async()=>{
 const {raw,source,dsl}=input(),fact=raw.form.detailTables[0].columns[0].sourceProps.remoteSelectorOmissionSourceFact;
 assert.equal(fact.script.grammar,'generated-sql-selector-omission-closed-v1');assert.equal(fact.script.duplicateRowAnchors.length,1);assert.equal(fact.script.foreignReferences,false);
 assert.equal(checkTrust(source,dsl).ok,true,JSON.stringify(checkTrust(source,dsl).diagnostics));assert.ok(dsl.workflow?.nodes?.length);assert.deepEqual(dsl.workflow,draftSourceDraft(raw).workflow);
 const audit=dsl.migrationPolicyAudit.audits[0];assert.equal(audit.method,'SQL');assert.deepEqual(audit.manualFields.map(f=>f.fieldId),['project','deptCode','deptName']);
 const columns=dsl.form.fields.find(f=>f.type==='detailTable').columns;assert.equal(columns.find(c=>c.id==='project').props.required,true);assert.ok(['project','deptCode','deptName'].every(id=>columns.find(c=>c.id===id).props.readOnly===false));
 const client=new FakeNewoaAdapter('persist'),r=await executeDsl(dsl,{client,baseUrl:'https://qas.example.invalid',targetCategoryId:'route-category-id',confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}});
 assert.equal(r.ok,true,JSON.stringify(r.diagnostics));assert.equal(r.readback.ok,true);assert.equal(r.transferRecord.status,'recorded');assert.equal(r.apiStages.some(s=>s.name==='verifyRemoteSelectorResources'),false);
 assert.equal(JSON.stringify(client.template).includes('Dialog_List'),false);assert.equal(JSON.stringify(client.template).includes('source_projects'),false);
}));
it('SQL omission fails closed on query/callback/search/output/row dependency mutations',()=>{
 const changes=[
  s=>s.replaceAll("var targetSql=sql;return targetSql;","var targetSql=sql;alert('side effect');return targetSql;"),
  s=>s.replaceAll('var index=currentTR.rowIndex-1;','var index=currentTR.rowIndex-2;'),
  s=>s.replaceAll('column=code,name&amp;','column=code,other&amp;'),
  s=>s.replaceAll('hashMapArray[i].DEPTNAME','hashMapArray[i].OTHER'),
  s=>s.replaceAll('getQuery("','getQuery("changed '),
  s=>s.replaceAll("function openPicker(){","function openPicker(){alert('other behavior');"),
  s=>s.replaceAll('openPicker(\'${status.index}\')','openPicker(\'${status.other}\')'),
  s=>s.replace('function unrelatedNoop() {}','function unrelatedNoop(){openPicker();}')
 ];
 for(const change of changes)altered(s=>{const changed=change(s);assert.notEqual(changed,s);return changed;},raw=>assert.throws(()=>input(raw)));
});
it('SQL omission cannot be forged or enabled by default and supports renamed equivalent sources',async()=>withNetworkGuard(async()=>{
 const {raw,source,dsl}=input(),options={baseUrl:'https://qas.example.invalid',targetCategoryId:'route-category-id',confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}};
 const client=new FakeNewoaAdapter('persist'),refused=await executeDsl(draftSourceDraft(raw),{...options,client});assert.equal(refused.remoteWriteAttempted,false);assert.equal(refused.ok,false);assert.deepEqual(client.transcript(),[]);
 for(const change of [d=>{d.form.fields.find(f=>f.type==='detailTable').columns[0].props.required=false;},d=>{d.migrationPolicyAudit.audits[0].method='REST';},d=>{d.form.fields.find(f=>f.type==='detailTable').columns[0].sourceProps.remoteSelectorOmissionSourceFact.script.grammar='generated-rest-selector-omission-closed-v1';}]){
  const forged=structuredClone(dsl);change(forged);assert.equal(checkTrust(source,forged).ok,false);
 }
 altered(s=>s.replaceAll('entries','other_rows').replaceAll('fixture_sql_resource','another_resource').replaceAll('isLoadData=true','isLoadData=false').replaceAll('isLoadData:&amp;quot;true&amp;quot;','isLoadData:&amp;quot;false&amp;quot;'),raw=>assert.equal(checkTrust(input(raw).source,input(raw).dsl).ok,true));
}));
it('SQL omission uses normal batch review, digest approval, fake persistence verification and transfer recording',async()=>withNetworkGuard(async()=>{
 const raw=cleanSnapshot(sourceSnapshot(path.dirname(file)),''),{source}=input(raw),store=new MemoryBatchStore();
 const batch=await createBatch(store,{version:1,name:'SQL omission fixture',migrationKey:'sql-omission-fixture',...source.migrationPolicies.scope,executionConcurrency:1,items:[{sourcePath:path.resolve(path.dirname(file)),migrationPolicies:source.migrationPolicies}]});
 const options={engineDigest:'fixture-engine',concurrency:1,checkpointSigningKey:'fixture-signing-key-longer-than-32-characters'};
 const prepared=await prepareBatch(store,batch.id,{...options,provider:createFakeReviewProvider('accept')});assert.equal(prepared.counts.ready,1,JSON.stringify(prepared.items));
 const proposal=await inspectBatch(store,batch.id);await approveBatch(store,batch.id,{expectedDigest:proposal.approvalDigest,confirmWrite:true,actor:'fixture-only'});
 const client=new FakeNewoaAdapter('persist'),executed=await executeBatch(store,batch.id,{...options,confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'},clientFactory:()=>client});
 assert.equal(executed.counts.succeeded,1,JSON.stringify(executed.items));const item=(await store.list('item',{batchId:batch.id}))[0];assert.equal(item.attempts.at(-1).report.transferRecord.status,'recorded');assert.ok(item.attempts.at(-1).steps.every(s=>s.outcome==='confirmed'));
}));
