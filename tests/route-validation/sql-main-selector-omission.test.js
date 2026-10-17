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
const root='tests/fixtures/route-validation/sql-main-selector-omission',file=root+'/route-sql-main-omission_SysFormTemplate.xml';
function input(raw=cleanSourceFile(root)){
 const field=raw.form.controls.find(f=>f.id==='project'),contract=field.sourceProps.remoteSelectorSourceContract,fact=field.sourceProps.remoteSelectorOmissionSourceFact;
 const source=attachMigrationPolicies(raw,{version:1,sourceDraftSha256:migrationPolicySourceDigest(raw),scope:{baseUrl:'https://qas.example.invalid',targetCategoryId:'route-category-id'},authorization:{actor:'fixture-only',evidenceSha256:'sha256:'+'1'.repeat(64)},decisions:[{id:'omit-main',kind:'omit-remote-selector',sourceRef:field.sourceRef,contractDigest:sha256Digest(contract),omissionFactDigest:fact?.digest,mode:'manual-values'}]});
 const dsl=createTrustedMigrationDsl(source,draftSourceDraft(source),{externalAgentReviewed:true,reviewerName:'fixture-only'});return {raw,source,dsl,contract,fact};
}
function altered(change,run){const temp=fs.mkdtempSync(path.join(os.tmpdir(),'sql-main-omission-'));try{const p=path.join(temp,'source_SysFormTemplate.xml'),old=fs.readFileSync(file,'utf8'),updated=change(old);assert.notEqual(updated,old);fs.writeFileSync(p,updated);return run(cleanSourceFile(p));}finally{fs.rmSync(temp,{recursive:true,force:true});}}
it('explicit main SQL retirement needs no legacy connection and preserves inert hidden/absent guarded outputs without inventing fields',async()=>withNetworkGuard(async()=>{
 const {raw,source,dsl,contract,fact}=input();assert.equal(contract.status,'unproven');assert.deepEqual(contract.reasons,['SQL_resource_or_query_unproven']);assert.ok(contract.requestResource.exportedQuerySha256);assert.equal(fact.status,'verified');assert.deepEqual(fact.missingOutputFields,['absentField']);assert.equal(checkTrust(source,dsl).ok,true,JSON.stringify(checkTrust(source,dsl).diagnostics));
 const audit=dsl.migrationPolicyAudit.audits[0];assert.deepEqual(audit.manualFields.map(f=>f.fieldId),['project','projectName','deptName']);assert.deepEqual(audit.missingGuardedOutputs,['absentField']);assert.deepEqual(audit.inactiveHiddenOutputs.map(f=>f.fieldId),['hiddenCode']);
 assert.equal(dsl.form.fields.some(f=>f.id==='absentField'),false);assert.equal(dsl.form.fields.find(f=>f.id==='hiddenCode').componentId,'xform-hidden');assert.equal(dsl.form.fields.find(f=>f.id==='hiddenCode').props.readOnly,true);assert.deepEqual(dsl.workflow,draftSourceDraft(raw).workflow);assert.ok(dsl.workflow.nodes.length);
 const client=new FakeNewoaAdapter('persist'),r=await executeDsl(dsl,{client,baseUrl:'https://qas.example.invalid',targetCategoryId:'route-category-id',confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}});assert.equal(r.ok,true,JSON.stringify(r.diagnostics));assert.equal(r.readback.partitions.workflow,'verified');assert.equal(r.transferRecord.status,'recorded');assert.equal(r.apiStages.some(s=>s.name==='verifyRemoteSelectorResources'),false);
}));
it('unbound SQL remains blocked by default and hidden/absent outputs with retained consumers cannot be retired',async()=>withNetworkGuard(async()=>{
 const {raw,dsl,source}=input(),client=new FakeNewoaAdapter('persist'),r=await executeDsl(draftSourceDraft(raw),{client,baseUrl:'https://qas.example.invalid',targetCategoryId:'route-category-id',confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}});assert.equal(r.ok,false);assert.equal(r.remoteWriteAttempted,false);assert.deepEqual(client.transcript(),[]);
 for(const id of ['hiddenCode','absentField'])altered(s=>s.replace('function unrelatedNoop() {}',`function unrelatedNoop(){return GetXFormFieldValueById('${id}');}`),raw=>assert.throws(()=>input(raw)));
 altered(s=>s.replace('function unrelatedNoop() {}',"function unrelatedNoop(){return 'a'.replaceAll('a','b');}"),raw=>assert.throws(()=>input(raw)));
 for(const change of [d=>{d.migrationPolicyAudit.audits[0].missingGuardedOutputs=[];},d=>{d.migrationPolicyAudit.audits[0].inactiveHiddenOutputs=[];},d=>{delete d.form.fields.find(f=>f.id==='project').sourceProps.remoteSelectorOmissionSourceFact.missingOutputFields;}]){const forged=structuredClone(dsl);change(forged);assert.equal(checkTrust(source,forged).ok,false);}
}));
it('main SQL retirement rejects changed query, sorting, callback effects and nonempty invalid resources',()=>{
 for(const change of [s=>s.replaceAll('orderby=code asc','orderby=code desc'),s=>s.replaceAll('getQuery("select','getQuery("altered select'),s=>s.replaceAll("var targetSql=sql;return targetSql;","var targetSql=sql;alert('other');return targetSql;"),s=>s.replace('sqlResource:&amp;quot;&amp;quot;','sqlResource:&amp;quot;bad resource&amp;quot;')])altered(change,raw=>assert.throws(()=>input(raw)));
});
it('a generated-looking SQL unit cannot retire a declaration that shadows a shared builtin or platform API',()=>{
 for(const name of ['String','Object','Array','Number','RegExp','Dialog_List'])altered(s=>s.replaceAll('getQuery',name),raw=>assert.throws(()=>input(raw)));
});
