import assert from 'node:assert/strict';
import {it} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {runAgentReview} from '../../src/agent-review/index.js';
import {checkTrust} from '../../src/dsl/trust.js';
import {buildDryRunPlan} from '../../src/executor/dry-run.js';
import {executeDsl} from '../../src/executor/execute.js';
import {createFakeReviewProvider} from './fake-review-provider.js';
import {FakeNewoaAdapter} from './fake-newoa-adapter.js';
import {withNetworkGuard} from './network-guard.js';
import {prepareSample} from '../helpers/persistence.js';
import {materializeNativeTemplateAuthorization} from '../helpers/native-template-authorization.js';

const fixture='tests/fixtures/route-validation/everyone-template-authorization';
const source=()=>cleanSourceFile(fixture);
const options={baseUrl:'https://qas.example.invalid',targetCategoryId:'route-category-id',confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}};
const everyone={fdId:'native-all-users',fdName:'Native Everyone',fdOrgType:8,fdIsAvailable:true,fdIsBusiness:false,fdAccount:{fdLoginName:'everyone'}};
const editor={fdId:'native-editor',fdName:'Native Editor',fdOrgType:8,fdIsAvailable:true,fdIsBusiness:true,fdNo:'editor-01'};
const mappings=[{sourceId:'legacy-everyone',targetFdId:everyone.fdId}];
async function trusted(){const s=source(),r=await runAgentReview(s,draftSourceDraft(s),{provider:createFakeReviewProvider('accept')});assert.equal(r.ok,true,JSON.stringify(r.report?.diagnostics));return{s,dsl:r.dsl};}
function client(extra={}){return new FakeNewoaAdapter('persist',{organizationCandidates:structuredClone([everyone,editor]),nativeTemplateAuthorization:true,...extra});}
async function altered(change,run){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'everyone-source-'));try{fs.cpSync(fixture,dir,{recursive:true});const p=path.join(dir,'route-everyone_KmReviewTemplate.xml');fs.writeFileSync(p,change(fs.readFileSync(p,'utf8')));return await run(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}}

it('binds source everyone mode to paired root identities, exact raw XML and normalized authorization',()=>{
 const s=source(),scope=s.template.authorization.readScope;
 assert.equal(scope.mode,'everyone');assert.equal(scope.evidence.templateId,'route-everyone-template');assert.equal(scope.evidence.readersPresence,'absent');assert.match(scope.evidence.xmlSha256,/^sha256:[a-f0-9]{64}$/);assert.match(scope.digest,/^sha256:/);
 assert.deepEqual(draftSourceDraft(s).template.authorization.readScope,scope);
});
it('trust rejects forged or removed source read scope',async()=>{
 const{s,dsl}=await trusted();for(const change of [d=>delete d.template.authorization.readScope,d=>d.template.authorization.readScope.mode='explicit',d=>d.template.authorization.readScope.evidence.xmlSha256='sha256:'+'0'.repeat(64)]){const d=structuredClone(dsl);change(d);assert.equal(checkTrust(s,d).ok,false);}
});
it('uses the real pipeline with a verified builtin mapping and native derived readback, never the person fallback',async()=>withNetworkGuard(async()=>{
 const{dsl}=await trusted(),c=client();const r=await executeDsl(dsl,{...options,client:c,templateAuthorizationOverrides:mappings,allowTemplateAuthorizationFallback:true});
 assert.equal(r.ok,true,JSON.stringify(r.diagnostics));assert.equal(r.readback.ok,true);assert.equal(r.transferRecord.status,'recorded');assert.deepEqual(c.template.fdReaders,[]);assert.deepEqual(c.template.fdAllReaders.map(m=>m.fdId),[everyone.fdId]);assert.deepEqual(c.template.fdEditors.map(m=>m.fdId),[editor.fdId]);assert.equal(r.diagnostics.some(d=>d.code==='workflow.participant_sit_fallback_applied'),false);
}));
it('blocks missing builtin discovery before add even when temporary fallbacks are allowed',async()=>withNetworkGuard(async()=>{
 const{dsl}=await trusted(),c=client();const r=await executeDsl(dsl,{...options,client:c,allowTemplateAuthorizationFallback:true});assert.equal(r.ok,false);assert.equal(c.transcript().some(e=>e.operation==='add'),false);
}));
it('blocks unproven empty reader modes before login or add and at persistence projection',async()=>withNetworkGuard(async()=>{
 await altered(xml=>xml.replace(/^<void method="put"><string>authAllReaders<\/string>.*\n/m,'').replace('<boolean>true</boolean>','<boolean>false</boolean>'),async dir=>{
  const s=cleanSourceFile(dir),d=draftSourceDraft(s),c=client();
  assert.equal(buildDryRunPlan(d).ok,false);
  const r=await executeDsl(d,{...options,client:c,allowTemplateAuthorizationFallback:true});assert.equal(r.ok,false);assert.deepEqual(c.transcript(),[]);
 });
 const{dsl}=await trusted();delete dsl.template.authorization.readScope;dsl.template.authorization.readers=[];dsl.template.authorization.allReaders=[];
 assert.throws(()=>prepareSample(dsl),error=>error.diagnostics.some(d=>d.code==='projection.template.empty_read_scope_unproven'));
}));
it('native fake derives from formal readers and ignores an attempted aggregate-only overwrite',async()=>withNetworkGuard(async()=>{
 const c=client();c.template={fdId:'fake-only',fdReaders:[],fdEditors:[editor],fdAllReaders:[editor],mechanisms:{}};
 await c.updateTemplate(c.template);assert.deepEqual((await c.getTemplate('fake-only')).fdAllReaders.map(m=>m.fdId),[everyone.fdId]);
 await c.updateTemplate({...c.template,fdReaders:[editor],fdAllReaders:[everyone]});assert.deepEqual((await c.getTemplate('fake-only')).fdAllReaders.map(m=>m.fdId),[editor.fdId]);
}));
it('native fake reproduces all 35 independently captured nonempty permission cases',()=>{
 const captured=JSON.parse(fs.readFileSync(fixture+'/native-nonempty-reader-cases.json'));
 assert.equal(captured.cases.length,35);
 const members=ids=>ids.map(fdId=>({fdId})),ids=members=>members.map(m=>m.fdId).sort();
 for(const row of captured.cases){
  assert.ok(row.readers.length>0);const template={fdReaders:members(row.readers),fdEditors:members(row.editors),fdAllReaders:[{fdId:'unrelated-aggregate'}]};
  materializeNativeTemplateAuthorization(template,{everyone});
  assert.deepEqual(ids(template.fdAllReaders),[...row.expectedAllReaders].sort(),`case ${row.case}`);assert.deepEqual(ids(template.fdAllEditors),[...row.expectedAllEditors].sort(),`case ${row.case}`);
 }
});
it('rejects native configuration, module and builtin identity drift before the first template write',async()=>withNetworkGuard(async()=>{
 const{dsl}=await trusted();const cases=[{templateEmptyNotUse:'true'},{templateReaderRelease:'unknown'},{templateReaderSha256:'0'.repeat(64)},{organizationCandidates:[{...everyone,fdOrgType:16},editor]},{organizationCandidates:[{...everyone,fdIsBusiness:true},editor]},{organizationCandidates:[{...everyone,fdIsAvailable:false},editor]},{organizationCandidates:[{...everyone,fdAccount:{fdLoginName:'ordinary'}},editor]}];
 for(const extra of cases){const c=client(extra),r=await executeDsl(dsl,{...options,client:c,templateAuthorizationOverrides:mappings,allowTemplateAuthorizationFallback:true});assert.equal(r.ok,false,JSON.stringify(extra));assert.equal(c.transcript().some(e=>e.operation==='add'),false);}
}));
it('does not lose a restricted reader when the same resolved identity is an editor',async()=>withNetworkGuard(async()=>{
 await altered(xml=>xml.replace('legacy-everyone','legacy-editor').replace('<string>everyone</string>','<string>editor-01</string>'),async dir=>{
  const s=cleanSourceFile(dir),review=await runAgentReview(s,draftSourceDraft(s),{provider:createFakeReviewProvider('accept')});assert.equal(review.ok,true);assert.equal(checkTrust(s,review.dsl).ok,true);
  const c=client(),r=await executeDsl(review.dsl,{...options,client:c});assert.equal(r.ok,true,JSON.stringify(r.diagnostics));assert.deepEqual(c.template.fdReaders.map(m=>m.fdId),[editor.fdId]);assert.deepEqual(c.template.fdAllReaders.map(m=>m.fdId),[editor.fdId]);
 });
}));
it('derives effective permissions from formal readers and editors even when source aggregates are absent',async()=>withNetworkGuard(async()=>{
 await altered(xml=>xml.replace('authAllReaders','authReaders').replace('legacy-everyone','legacy-editor').replace('<string>everyone</string>','<string>editor-01</string>').replace(/^<void method="put"><string>authAllEditors<\/string>.*\n/m,''),async dir=>{
  const s=cleanSourceFile(dir);
  const review=await runAgentReview(s,draftSourceDraft(s),{provider:createFakeReviewProvider('accept')});assert.equal(review.ok,true);
  const c=client(),r=await executeDsl(review.dsl,{...options,client:c});assert.equal(r.ok,true,JSON.stringify(r.diagnostics));assert.deepEqual(c.template.fdReaders.map(m=>m.fdId),[editor.fdId]);assert.deepEqual(c.template.fdAllReaders.map(m=>m.fdId),[editor.fdId]);assert.deepEqual(c.template.fdAllEditors.map(m=>m.fdId),[editor.fdId]);
 });
}));

it('blocks duplicate source root/member assignments and incomplete everyone combinations',async()=>{
 const mutations=[
  xml=>xml.replace('</object></java>','<void method="put"><string>authReaderFlag</string><boolean>true</boolean></void></object></java>'),
  xml=>xml.replace('<string>everyone</string>','<string>everyone</string></void><void method="put"><string>fdLoginName</string><string>everyone</string>'),
  xml=>xml.replace('<boolean>true</boolean>','<boolean>false</boolean>'),
  xml=>xml.replaceAll('legacy-editor','legacy-everyone'),
  xml=>xml.replace('<string>hbmParent.fdName</string><string></string>','<string>hbmParent.fdName</string><string>Business Department</string>')
 ];
 for(const mutate of mutations)await altered(mutate,async dir=>{const s=cleanSourceFile(dir),draft=draftSourceDraft(s);assert.equal(buildDryRunPlan(draft).ok,false);assert.ok(draft.review.errors.length>0);});
});
it('does not special-case source UUID or process name and rejects source hash/pair drift',async()=>{
 const s=source();for(const mutate of [x=>x.source.kmReviewTemplate.xmlSha256='sha256:'+'a'.repeat(64),x=>x.source.sysFormTemplate.fdModelId='other',x=>x.source.lbpmProcessDefinition.templateId='other']){const changed=structuredClone(s);mutate(changed);const draft=draftSourceDraft(s),review=await runAgentReview(s,draft,{provider:createFakeReviewProvider('accept')});assert.equal(checkTrust(changed,review.dsl).ok,false);}
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'everyone-renamed-'));try{fs.cpSync(fixture,dir,{recursive:true});for(const name of fs.readdirSync(dir)){const p=path.join(dir,name);fs.writeFileSync(p,fs.readFileSync(p,'utf8').replaceAll('route-everyone-template','unrelated-pair-identity').replaceAll('legacy-everyone','another-source-builtin').replaceAll('Everyone permission fixture','Another business process'));}const changed=cleanSourceFile(dir);assert.equal(changed.template.authorization.readScope.mode,'everyone');assert.equal(changed.template.authorization.readScope.evidence.templateId,'unrelated-pair-identity');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
it('refuses duplicate mappings, same-name non-builtin candidates and no raw source scope even with fallbacks',async()=>withNetworkGuard(async()=>{
 const{dsl}=await trusted();for(const maps of [[...mappings,...mappings],[{sourceId:'legacy-everyone',targetFdId:editor.fdId}]]){const c=client(),r=await executeDsl(dsl,{...options,client:c,templateAuthorizationOverrides:maps,allowTemplateAuthorizationFallback:true});assert.equal(r.ok,false);assert.equal(c.transcript().some(e=>e.operation==='add'),false);}
 const changed=structuredClone(dsl);delete changed.template.authorization.readScope;const c=client(),r=await executeDsl(changed,{...options,client:c,allowTemplateAuthorizationFallback:true});assert.equal(r.ok,false);assert.equal(c.transcript().length,0);
}));
it('withholds the record on postwrite configuration or permission readback drift',async()=>withNetworkGuard(async()=>{
 const{dsl}=await trusted();for(const kind of ['configuration','aggregate','formal-readers']){
  const c=client(),get=c.getTemplate.bind(c);c.getTemplate=async id=>{const t=await get(id);if(c.updated){if(kind==='configuration')c.readerOptions.templateEmptyNotUse='true';else if(kind==='aggregate')t.fdAllReaders=[editor];else t.fdReaders=[editor];}return t;};
  const r=await executeDsl(dsl,{...options,client:c,templateAuthorizationOverrides:mappings});assert.equal(r.ok,false);assert.equal(r.status,'readback_failed');assert.equal(c.transcript().some(e=>e.operation==='add-transfer-record'),false);
 }
}));
