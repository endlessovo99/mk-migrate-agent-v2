import assert from 'node:assert/strict';import {it} from 'node:test';import {createHash} from 'node:crypto';import {runInNewContext} from 'node:vm';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {attachMigrationPolicies,migrationPolicySourceDigest} from '../../src/translator/approved-migration-policies.js';
const fixture='tests/fixtures/route-validation/approved-empty-row-view/route-empty-row-view_SysFormTemplate.xml';const hash=s=>'sha256:'+createHash('sha256').update(s).digest('hex');
function authorized(){const source=cleanSourceFile(fixture),script=source.scripts.sources[0],draft=draftSourceDraft(source),action=draft.scripts.actions.find(a=>a.event==='onLoad');const scope={baseUrl:'https://oaqas.shanghai-electric.com',targetCategoryId:'route-category'};const decision={kind:'unbound-empty-row-view',sourceRef:script.sourceRef,sourceJavascriptSha256:hash(script.javascript),actionId:action.id,fieldId:'fd_mirror',matchingCode:'5',firstRow:'fd_a_row',secondRow:'fd_b_row'};const policy={version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'fixture',evidenceSha256:hash('explicit choice')},decisions:[decision]};return{source:attachMigrationPolicies(source,policy,scope),decision};}
it('applies the explicitly approved empty-value interpretation only to the bound view callback',()=>{
 const {source}=authorized(),draft=draftSourceDraft(source),a=draft.scripts.actions.find(a=>a.event==='onLoad');assert.equal(a.translationStatus,'mapped');
 for(const [value,expected] of [['5',{fd_a_row:true,fd_b_row:true}],['',{fd_a_row:false,fd_b_row:true}],['x',{}]]){
  const rows={},MKXFORM={getValue:()=>value,setFieldAttr:(id,flag)=>{if(flag===4||flag===5)rows[id]=flag===5}};runInNewContext('('+a.function+')',{MKXFORM})();assert.deepEqual(rows,expected);
 }
});

it('rejects changed source, forged authorization scope and global mutation',()=>{
 const {source,decision}=authorized();
 for(const mutate of [
  s=>s.scripts.sources[0].javascript=s.scripts.sources[0].javascript.replace('if(!value)','if(!another)'),
  s=>s.scripts.sources[0].javascript+=';window.GetXFormFieldById=function(){};',
  s=>s.migrationPolicies.decisions[0].firstRow='different_row'
 ]){const changed=structuredClone(source);mutate(changed);assert.throws(()=>draftSourceDraft(changed));}
});

it('keeps the approved interpretation through fake review and trusted persistence',async()=>{
 const {runAgentReview}=await import('../../src/agent-review/index.js');const {checkTrust}=await import('../../src/dsl/trust.js');const {executeDsl}=await import('../../src/executor/execute.js');
 const {createFakeReviewProvider}=await import('./fake-review-provider.js');const {FakeNewoaAdapter}=await import('./fake-newoa-adapter.js');const {withNetworkGuard}=await import('./network-guard.js');
 await withNetworkGuard(async()=>{const {source}=authorized(),draft=draftSourceDraft(source),review=await runAgentReview(source,draft,{provider:createFakeReviewProvider('accept')});
  assert.equal(review.ok,true,JSON.stringify(review.diagnostics));assert.equal(checkTrust(source,review.dsl).ok,true);
  const wrong=new FakeNewoaAdapter('persist'),blocked=await executeDsl(review.dsl,{client:wrong,confirmWrite:true,targetCategoryId:'wrong-category',credentials:{username:'test',encryptedPassword:'test'},baseUrl:'https://oaqas.shanghai-electric.com'});assert.equal(blocked.ok,false);assert.equal(wrong.entries.some(e=>e.operation==='login'),false);
  const c=new FakeNewoaAdapter('persist'),r=await executeDsl(review.dsl,{client:c,confirmWrite:true,targetCategoryId:'route-category',credentials:{username:'test',encryptedPassword:'test'},baseUrl:'https://oaqas.shanghai-electric.com'});
  assert.equal(r.ok,true,JSON.stringify(r.diagnostics));assert.equal(r.readback.partitions.scripts,'verified');assert.equal(r.transferRecord.status,'recorded');
 });
});

it('rejects global alias escape even when the decision is bound to the altered source',()=>{
 const original=cleanSourceFile(fixture);original.scripts.sources.push({id:'extra',sourceRef:'source.form.extra',javascript:'var alias=window;alias.GetXFormFieldById=function(){};'});
 const prior=authorized().source.migrationPolicies;prior.sourceDraftSha256=migrationPolicySourceDigest(original);
 const source=attachMigrationPolicies(original,prior,prior.scope);assert.throws(()=>draftSourceDraft(source),/mutates a protected/);
});
