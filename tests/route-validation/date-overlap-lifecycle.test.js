import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {it} from 'node:test';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {dateOverlapLifecycleCandidates,verifiedDateOverlapReadyAction} from '../../src/translator/date-overlap-lifecycle.js';
import {runAgentReview} from '../../src/agent-review/index.js';
import {checkTrust,createTrustedMigrationDsl} from '../../src/dsl/trust.js';
import {buildDryRunPlan} from '../../src/executor/dry-run.js';
import {executeDsl} from '../../src/executor/execute.js';
import {applyEvidenceBackedPatches,collectSourceRefs} from '../../src/agent-review/review-validation.js';
import {FakeNewoaAdapter} from './fake-newoa-adapter.js';
import {createFakeReviewProvider} from './fake-review-provider.js';
import {withNetworkGuard} from './network-guard.js';

const fixture='tests/fixtures/route-validation/date-overlap-lifecycle';
const ids=['fd_curr_begin','fd_curr_finish','fd_prior_begin','fd_prior_finish','fd_current_days','fd_prior_days'];
const output='fd_total_days';
function input(){const source=cleanSourceFile(fixture),draft=draftSourceDraft(source);return{source,draft,script:source.scripts.sources[0]};}
function altered(change,run){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'date-overlap-'));try{for(const name of fs.readdirSync(fixture))fs.writeFileSync(path.join(dir,name),change(fs.readFileSync(path.join(fixture,name),'utf8'),name));return run(cleanSourceFile(dir));}finally{fs.rmSync(dir,{recursive:true,force:true});}}
function harness(source,draft,values,native,rawPoints={}){
 const store={...values},events=[],timers=[],callbacks={};
 const runtime={Date,console:{log:(...args)=>events.push(['console',...args])},setTimeout(fn,delay){events.push(['timer',delay]);timers.push(fn);},
  MKXFORM:{getValue(id){events.push(['read',id]);return Object.hasOwn(rawPoints,id)?rawPoints[id]:store[id];},getValueText(key){return store[key.split('.').at(-1)];},setValue(id,value){events.push(['write',id,value]);store[id]=value;}},
  AttachXFormValueChangeEventById(id,fn){events.push(['register',id]);callbacks[id]=fn;},
  $(query){if(typeof query==='function')return query();const id=/extendDataFormInfo.value\(([^)]+)\)/.exec(query)?.[1];return{val(...args){if(args.length){events.push(['write',id,args[0]]);store[id]=args[0];}else{events.push(['read',id]);return store[id];}}};}
 };
 vm.createContext(runtime);
 if(native){for(const action of draft.scripts.actions.filter(action=>action.event==='onChange')){callbacks[action.controlId]=vm.runInContext('('+action.function+')',runtime);events.push(['register',action.controlId]);}const load=draft.scripts.actions.find(action=>action.event==='onLoad');vm.runInContext('('+load.function+')',runtime)({});}
 else vm.runInContext(source.scripts.sources[0].javascript,runtime);
 return{events,store,timers,callbacks,flush(){while(timers.length)timers.shift()();}};
}
it('owns all six changes and initial ready execution with unchanged source identities and complete deterministic proof',()=>{
 const{source,draft,script}=input();assert.equal(draft.scripts.actions.length,7);
 assert.ok(draft.scripts.actions.every(action=>action.translationStatus==='mapped'&&action.deterministicBranchProof?.basis==='deterministic-date-overlap-lifecycle'&&action.unmappedFunctions.length===0));
 assert.deepEqual(draft.scripts.actions.filter(action=>action.event==='onChange').map(action=>action.controlId),ids);
 const ready=draft.scripts.actions.find(action=>action.event==='onLoad');assert.equal(ready.id,script.id+'.ready.1');assert.ok(ready.semanticHints.jqueryReadyInitialization);assert.equal(verifiedDateOverlapReadyAction(source,draft.form,ready),true);
 assert.equal(draft.scripts.actions[0].semanticHints.dateOverlapLifecycle.consoleCalls,15);assert.equal(script.javascript.includes('MKXFORM'),false);
});
it('preserves every console, standard Date algorithm, read/write order and immediate initial calculation',()=>{
 const{source,draft}=input(),base={fd_curr_begin:'2024-01-01',fd_curr_finish:'2024-01-10',fd_prior_begin:'2024-01-05',fd_prior_finish:'2024-01-15',fd_current_days:10,fd_prior_days:'11'};
 for(const changes of [{},{fd_prior_begin:'2024-02-01',fd_prior_finish:'2024-02-02'},{fd_prior_begin:'2024-01-10'},{fd_curr_begin:'2024-01-10',fd_curr_finish:'2024-01-01'},{fd_curr_begin:''},{fd_curr_begin:'not-a-date'},{fd_prior_days:'not-a-number'},{fd_current_days:'',fd_prior_days:''}]){
  const values={...base,...changes},legacy=harness(source,draft,values,false),target=harness(source,draft,values,true);
  assert.deepEqual(target.events,legacy.events);assert.equal(target.store[output],legacy.store[output]);assert.equal(target.timers.length,0);
 }
});
it('keeps six independent 150ms schedules and reads current values at timer fire without debouncing',()=>{
 const{source,draft}=input(),values={fd_curr_begin:'2024-01-01',fd_curr_finish:'2024-01-10',fd_prior_begin:'2024-01-05',fd_prior_finish:'2024-01-15',fd_current_days:10,fd_prior_days:'11'};
 const legacy=harness(source,draft,values,false),target=harness(source,draft,values,true);legacy.events.length=0;target.events.length=0;
 for(const id of ids)for(let count=0;count<2;count++){legacy.callbacks[id]('ignored');target.callbacks[id]('ignored');}
 assert.deepEqual(target.events,Array.from({length:12},()=>['timer',150]));assert.deepEqual(target.events,legacy.events);
 legacy.store.fd_prior_days='40';target.store.fd_prior_days='40';legacy.flush();target.flush();assert.deepEqual(target.events,legacy.events);assert.equal(target.store[output],legacy.store[output]);
});
it('preserves the full calculation and diagnostics when native dates are epoch zero, Date objects or points across DST',()=>{
 const{source,draft}=input(),oldTZ=process.env.TZ;
 try{for(const zone of ['UTC','Asia/Shanghai','America/New_York']){
  process.env.TZ=zone;
  for(const dates of [['1970-01-01','1970-01-03','1970-01-01','1970-01-02'],['2024-03-09','2024-03-12','2024-03-10','2024-03-11'],['2024-11-01','2024-11-04','2024-11-02','2024-11-03']]){
   const values={...Object.fromEntries(ids.slice(0,4).map((id,index)=>[id,dates[index]])),fd_current_days:4,fd_prior_days:'2'};
   for(const kind of ['number','Date']){
    const rawPoints=Object.fromEntries(ids.slice(0,4).map((id,index)=>[id,kind==='Date'?new Date(dates[index]+'T00:00:00'):new Date(dates[index]+'T00:00:00').getTime()]));
    const sourceRun=harness(source,draft,values,false),nativeRun=harness(source,draft,values,true,rawPoints);
    assert.deepEqual(nativeRun.events,sourceRun.events);assert.equal(nativeRun.store[output],sourceRun.store[output]);
   }
  }
 }}finally{if(oldTZ===undefined)delete process.env.TZ;else process.env.TZ=oldTZ;}
});
it('passes malformed native display strings into the original invalid-Date-to-zero branch without new business validation',()=>{
 const{source,draft}=input(),values={fd_curr_begin:'malformed-display',fd_curr_finish:'2024-01-10',fd_prior_begin:'2024-01-05',fd_prior_finish:'2024-01-15',fd_current_days:10,fd_prior_days:'11'};
 const legacy=harness(source,draft,values,false),target=harness(source,draft,values,true,{fd_curr_begin:Date.UTC(2024,0,1)});
 assert.deepEqual(target.events,legacy.events);assert.equal(target.store[output],21);
});
for(const[name,change]of[
 ['changed overlap arithmetic',s=>s.replace('Math.floor(diffMs / oneDayMs) + 1','Math.floor(diffMs / oneDayMs) + 2')],
 ['extra business side effect',s=>s.replace('const sumTotal =','unknownEffect();const sumTotal =')],
 ['removed source diagnostic',s=>s.replace('console.log(&quot;两数求和 =&quot;, sumTotal);','')],
 ['unclosed ready effect',s=>s.replace('bindPeriods();','bindPeriods();unknownEffect();')],
 ['lost initial execution',s=>s.replace('bindPeriods();\n    updatePeriods();','bindPeriods();')],
 ['wrong listener field',s=>s.replace('ById(&quot;fd_curr_begin&quot;','ById(&quot;fd_unknown&quot;')],
 ['unknown timer callback',s=>s.replace('setTimeout(updatePeriods, 150)','setTimeout(otherFunction, 150)')],
 ['source API shadow',s=>s.replace('function printDay','var Date=other;function printDay')]
])it('rejects incomplete or altered source grammar: '+name,()=>{
 altered((s,n)=>n.endsWith('_SysFormTemplate.xml')?change(s):s,source=>{const draft=draftSourceDraft(source),candidates=dateOverlapLifecycleCandidates(source.scripts.sources[0],draft.form,source.scripts);assert.equal(candidates.length,0);});
});
it('rejects source helper escapes, global overrides and ambiguous field bindings',()=>{
 const{source,draft,script}=input();for(const javascript of ['var Date=other;','Date=other;','var log=console;log.log=business;','updatePeriods();','eval("sideEffect()");']){
  const changed=structuredClone(source.scripts);changed.sources.push({id:'other',sourceRef:'source.form.jsp.other',javascript});assert.equal(dateOverlapLifecycleCandidates(script,draft.form,changed).length,0);
 }
 for(const mutate of [form=>form.fields.push(structuredClone(form.fields[0])),form=>form.fields.find(field=>field.id===output).props.calculation={kind:'formula',expression:'1'},form=>form.fields.find(field=>field.id===ids[0]).type='text',form=>form.fields.find(field=>field.id===ids[0]).dataOnly=true,form=>form.fields.find(field=>field.id===ids[0]).props.displayPattern='yyyy/MM/dd']){
  const form=structuredClone(draft.form);mutate(form);assert.equal(dateOverlapLifecycleCandidates(script,form,source.scripts).length,0);
 }
});
it('uses normal fake model review, trust, dry-run, draft readback and transfer recording',async()=>withNetworkGuard(async()=>{
 const{source,draft}=input(),review=await runAgentReview(source,draft,{provider:createFakeReviewProvider('accept')});assert.equal(review.ok,true,JSON.stringify(review.report?.diagnostics));
 assert.equal(checkTrust(source,review.dsl).ok,true,JSON.stringify(checkTrust(source,review.dsl).diagnostics));assert.equal(buildDryRunPlan(review.dsl).ok,true);
 const client=new FakeNewoaAdapter('persist'),report=await executeDsl(review.dsl,{client,baseUrl:'https://qas.example.invalid',targetCategoryId:'route-category-id',confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}});
 assert.equal(report.ok,true,JSON.stringify(report.diagnostics));assert.equal(report.readback.ok,true);assert.equal(report.transferRecord.status,'recorded');
 const native=client.template.mechanisms['sys-xform'],config=JSON.parse(native.fdConfig),main=config.dataModel.find(model=>model.fdType==='main')||config.dataModel[0];
 assert.ok(JSON.stringify(config).includes(main.fdTableName+'.'+ids[0]));assert.equal(JSON.stringify(config).includes('${table:@main}'),false);
 for(const mutate of [dsl=>dsl.scripts.actions.splice(0,1),dsl=>dsl.scripts.actions.at(-1).function='function onLoad(){}',dsl=>delete dsl.scripts.actions.at(-1).semanticHints.jqueryReadyInitialization,dsl=>dsl.scripts.actions[0].function=dsl.scripts.actions[0].function.replace('150','151'),dsl=>dsl.scripts.actions[0].semanticHints.dateOverlapLifecycle.sourceJavascriptSha256='sha256:'+'0'.repeat(64)]){
  const changed=structuredClone(review.dsl);mutate(changed);assert.equal(checkTrust(source,changed).ok,false);
 }
}));
it('permits only the exact reconstructed ready contract through the ordinary patch boundary',()=>{
 const{source,draft}=input(),index=draft.scripts.actions.findIndex(action=>action.event==='onLoad'),ready=draft.scripts.actions[index];
 const patch=value=>[{op:'replace',path:'/scripts/actions/'+index+'/function',value,sourceRefs:ready.sourceRefs,evidence:['Synthetic fixture only.'],rationale:'Verify exact ready closure.',confidence:1}];
 assert.equal(applyEvidenceBackedPatches(draft,patch(ready.function),{sourceDraft:source,sourceRefs:collectSourceRefs(source)}).ok,true);
 assert.equal(applyEvidenceBackedPatches(draft,patch('function onLoad(){}'),{sourceDraft:source,sourceRefs:collectSourceRefs(source)}).ok,false);
 const unclosed=structuredClone(source);unclosed.scripts.sources[0].javascript=unclosed.scripts.sources[0].javascript.replace('bindPeriods();','bindPeriods();unknownEffect();');
 const pending=draftSourceDraft(unclosed),trusted=createTrustedMigrationDsl(unclosed,pending,{externalAgentReviewed:true,reviewerName:'synthetic-fixture-only'});assert.equal(checkTrust(unclosed,trusted).ok,false);
});
it('does not record migration when readback loses the materialized native main-field display address',async()=>withNetworkGuard(async()=>{
 const{source,draft}=input(),review=await runAgentReview(source,draft,{provider:createFakeReviewProvider('accept')});assert.equal(review.ok,true);
 class LoseMainAddress extends FakeNewoaAdapter{
  async getTemplate(id){const template=await super.getTemplate(id);if(this.updated){
   const native=template.mechanisms['sys-xform'],config=JSON.parse(native.fdConfig),main=config.dataModel.find(model=>model.fdType==='main')||config.dataModel[0];
   let changed=0;const visit=value=>{if(!value||typeof value!=='object')return;for(const[key,item]of Object.entries(value)){if(typeof item==='string'&&item.includes('getValueText')){const next=item.replaceAll(main.fdTableName+'.'+ids[0],ids[0]);if(next!==item)changed++;value[key]=next;}else visit(item);}};visit(config);assert.ok(changed>0);native.fdConfig=JSON.stringify(config);
  }return template;}
 }
 const client=new LoseMainAddress('persist'),report=await executeDsl(review.dsl,{client,baseUrl:'https://qas.example.invalid',targetCategoryId:'route-category-id',confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}});
 assert.equal(report.ok,false);assert.equal(report.readback.ok,false);assert.notEqual(report.transferRecord?.status,'recorded');assert.equal(client.transcript().some(entry=>entry.operation==='add-transfer-record'),false);
}));
