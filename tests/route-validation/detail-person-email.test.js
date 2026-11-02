import assert from 'node:assert/strict';
import {it} from 'node:test';
import {runInNewContext} from 'node:vm';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
const fixture='tests/fixtures/route-validation/detail-person-email/route-detail-email_SysFormTemplate.xml';
it('binds email and name hydration to the selected detail row with an authenticated native request',()=>{
 const source=cleanSourceFile(fixture),draft=draftSourceDraft(source);
 const action=draft.scripts.actions.find(a=>a.controlId==='fd_xz_name'&&a.event==='onChange');
 assert.ok(action);assert.equal(action.translationStatus,'mapped');
 assert.match(action.function,/sysOrgPersonInfo\/getPersonInfo/);
 const writes=[],requests=[],table='${table:fd_3242f3c67e44fc}',row=2,selected={fdId:'person-a'};let current=selected;
 const api={getValue:()=>[current],updateControl:(...args)=>writes.push(args),ajax:(options,callback)=>requests.push({options,callback})};
 const fn=runInNewContext('('+action.function+')',{MKXFORM:api});fn([selected],row);
 assert.equal(requests.length,1);assert.equal(requests[0].options.method,'POST');
 assert.equal(requests[0].options.data.fdId,'person-a');
 requests[0].callback(null,{data:{success:true,data:{fdId:'person-a',fdName:'Example',fdEmail:'person@example.test'}}});
 assert.deepEqual(writes.map(x=>[x[0],x[1],x[2]]),[[table+'.fd_job_number',2,'person@example.test'],[table+'.fd_name',2,'Example']]);
});
it('does not overwrite a row on stale identity, hidden email, missing email or request failure',()=>{
 const draft=draftSourceDraft(cleanSourceFile(fixture)),action=draft.scripts.actions.find(a=>a.controlId==='fd_xz_name'&&a.event==='onChange');
 assert.ok(action);const writes=[],requests=[];let current={fdId:'person-a'};
 const api={getValue:()=>[current],updateControl:(...args)=>writes.push(args),ajax:(options,callback)=>requests.push({options,callback})};
 const fn=runInNewContext('('+action.function+')',{MKXFORM:api});
 for(const [value,stale,error] of [[{fdId:'person-a',fdName:'A',fdEmail:'x'},true,null],[{fdId:'person-a',fdName:'A',fdEmail:'secret'},false,null],[{fdId:'person-a',fdName:'A',fdEmail:'x***@example.test'},false,null],[{fdId:'person-a',fdName:'A'},false,null],[{fdId:'person-a',fdEmail:'x'},false,null],[{fdId:'person-a',fdName:'A',fdEmail:'x'},false,new Error('failed')]]){
   current={fdId:'person-a'};fn([current],2);const req=requests.pop();if(stale)current={fdId:'person-b'};req.callback(error,{data:{success:true,data:value}});
 }
 assert.equal(writes.length,0);
});

it('keeps the mapped row action through review, target capability gates, fake persistence, and readback',async()=>{
 const {runAgentReview}=await import('../../src/agent-review/index.js');
 const {checkTrust}=await import('../../src/dsl/trust.js');
 const {buildDryRunPlan}=await import('../../src/executor/dry-run.js');
 const {executeDsl}=await import('../../src/executor/execute.js');
 const {FakeNewoaAdapter}=await import('./fake-newoa-adapter.js');
 const {createFakeReviewProvider}=await import('./fake-review-provider.js');
 const {withNetworkGuard}=await import('./network-guard.js');
 await withNetworkGuard(async()=>{
  const source=cleanSourceFile(fixture),draft=draftSourceDraft(source),review=await runAgentReview(source,draft,{provider:createFakeReviewProvider('accept')});
  assert.equal(review.ok,true,JSON.stringify(review.diagnostics));assert.equal(checkTrust(source,review.dsl).ok,true);assert.equal(buildDryRunPlan(review.dsl).ok,true);
  const options={confirmWrite:true,targetCategoryId:'route-category-id',credentials:{username:'test',encryptedPassword:'test'},baseUrl:'https://oaqas.shanghai-electric.com'};
  const foreign=new FakeNewoaAdapter('persist',{detailVisibilityRuntime:true,personEmailRuntime:true});
  const outside=await executeDsl(review.dsl,{...options,baseUrl:'https://p-sit.onewo.com',client:foreign});
  assert.equal(outside.ok,false);assert.ok(outside.diagnostics.some(d=>d.code==='safety.detail_person_email_origin_unverified'));
  assert.equal(foreign.entries.some(e=>e.operation==='login'),false);
  const rejected=new FakeNewoaAdapter('persist',{detailVisibilityRuntime:true});
  let blocked=await executeDsl(review.dsl,{...options,client:rejected});
  assert.equal(blocked.ok,false);assert.equal(blocked.remoteWriteAttempted,false);assert.ok(blocked.diagnostics.some(d=>d.code==='safety.detail_person_email_runtime_unverified'));
  const client=new FakeNewoaAdapter('persist',{detailVisibilityRuntime:true,personEmailRuntime:true});
  const result=await executeDsl(review.dsl,{...options,client});assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.equal(result.readback.partitions.scripts,'verified');assert.equal(result.transferRecord.status,'recorded');
 });
});

it('rejects a source callback with an additional side effect',()=>{
 const source=cleanSourceFile(fixture),script=source.scripts.sources[0];
 script.javascript=script.javascript.replace('var pId=value[0];','unknownSideEffect();var pId=value[0];');
 assert.equal(draftSourceDraft(source).scripts.actions.some(a=>a.controlId==='fd_xz_name'&&a.translationStatus==='mapped'),false);
});
