import assert from 'node:assert/strict';import {it} from 'node:test';import {createHash} from 'node:crypto';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';import {checkDraft} from '../../src/dsl/checks.js';
import {attachMigrationPolicies,migrationPolicySourceDigest} from '../../src/translator/approved-migration-policies.js';
const fixture='tests/fixtures/route-validation/approved-other-bound-caption/route-approved-other_SysFormTemplate.xml',hash=s=>'sha256:'+createHash('sha256').update(s).digest('hex');
function bind(source){const script=source.scripts.sources[0],action=draftSourceDraft(source).scripts.actions.find(a=>a.event==='onLoad'),scope={baseUrl:'https://oaqas.shanghai-electric.com',targetCategoryId:'route-category'};return attachMigrationPolicies(source,{version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture',evidenceSha256:hash('approved-empty')},decisions:[{kind:'unbound-empty-row-view',sourceRef:script.sourceRef,sourceJavascriptSha256:hash(script.javascript),actionId:action.id,fieldId:'fd_mirror',matchingCode:'5',firstRow:'fd_a_row',secondRow:'fd_b_row'}]},scope);}
it('maps an independent Other option after an approved row-view action closes its script reach',()=>{
 const source=cleanSourceFile(fixture),raw=draftSourceDraft(source);assert.equal(raw.form.fields.find(f=>f.id==='fd_payload_a').nativeOther,undefined);
 const approved=bind(source),draft=draftSourceDraft(approved),choice=draft.form.fields.find(f=>f.id==='fd_payload_a');assert.deepEqual(choice.nativeOther,{version:2,sourceOptionValue:'Q'});assert.equal(checkDraft(draft).ok,true,JSON.stringify(checkDraft(draft).diagnostics.filter(x=>x.level==='error')));
});
it('requires the real caption witness and rejects unmodeled fragment code',()=>{
 const source=cleanSourceFile(fixture);for(const mutate of [
  s=>delete s.form.controls.find(f=>f.id==='fd_a_title').sourceProps.staticCaptionFact,
  s=>s.scripts.fragments.push({id:'foreign',content:'<script>unknown()</script>'}),
  s=>s.scripts.fragments.push({id:'foreign',content:'<input type="hidden" id="x" name="x" onclick="unknown()"/>'})
 ]){let changed=structuredClone(source);mutate(changed);let d=draftSourceDraft(bind(changed));assert.equal(d.form.fields.find(f=>f.id==='fd_payload_a').nativeOther,undefined);}
});
it('retains the approved standalone option and branch through fake execution and readback',async()=>{
 const {runAgentReview}=await import('../../src/agent-review/index.js');const {checkTrust}=await import('../../src/dsl/trust.js');const {executeDsl}=await import('../../src/executor/execute.js');
 const {createFakeReviewProvider}=await import('./fake-review-provider.js');const {FakeNewoaAdapter}=await import('./fake-newoa-adapter.js');const {withNetworkGuard}=await import('./network-guard.js');
 await withNetworkGuard(async()=>{const source=bind(cleanSourceFile(fixture)),draft=draftSourceDraft(source),r=await runAgentReview(source,draft,{provider:createFakeReviewProvider('accept')});assert.equal(r.ok,true,JSON.stringify(r.diagnostics));assert.equal(checkTrust(source,r.dsl).ok,true);
  const client=new FakeNewoaAdapter('persist'),result=await executeDsl(r.dsl,{client,confirmWrite:true,targetCategoryId:'route-category',credentials:{username:'test',encryptedPassword:'test'},baseUrl:'https://oaqas.shanghai-electric.com'});assert.equal(result.ok,true,JSON.stringify(result.diagnostics));assert.equal(result.readback.partitions.form,'verified');assert.equal(result.readback.partitions.scripts,'verified');
 });
});
