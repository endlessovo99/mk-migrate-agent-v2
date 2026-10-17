import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {it} from 'node:test';
import {parse} from 'acorn';
const root=process.cwd(),directory='tests/fixtures/route-validation/approved-main-string-current-policy';
const {cleanSourceFile,draftSourceDraft}=await import(root+'/src/translator/index.js');
const {attachMigrationPolicies,migrationPolicySourceDigest}=await import(root+'/src/translator/approved-migration-policies.js');
const {validateApprovedMainStringLoadDecisions,applyApprovedMainStringLoadPolicies}=await import(root+'/src/translator/approved-main-string-load-policies.js');
const {runAgentReview}=await import(root+'/src/agent-review/index.js');
const {checkTrust}=await import(root+'/src/dsl/trust.js');
const {buildDryRunPlan}=await import(root+'/src/executor/dry-run.js');
const {executeDsl}=await import(root+'/src/executor/execute.js');
const {createFakeReviewProvider}=await import(root+'/tests/route-validation/fake-review-provider.js');
const {FakeNewoaAdapter}=await import(root+'/tests/route-validation/fake-newoa-adapter.js');
const {withNetworkGuard}=await import(root+'/tests/route-validation/network-guard.js');
const {canonicalRowTarget}=await import(root+'/src/dsl/layout-row-targets.js');
const sha=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const scope={baseUrl:'https://p-sit.onewo.com',targetCategoryId:'route-category-id'};
function input(){const source=cleanSourceFile(directory+'/route-approved-current-main-string_SysFormTemplate.xml');return{source,draft:draftSourceDraft(source)};}
function decisions(source,draft){return source.scripts.sources.map((entry,index)=>{
 const callback=parse(entry.javascript,{ecmaVersion:'latest'}).body.find(n=>n.expression?.callee?.name==='Com_AddEventListener').expression,getter=callback.arguments[2].body.body.find(n=>n.type==='VariableDeclaration').declarations[0].init;
 return{kind:'main-string-current-value-load',sourceRef:entry.sourceRef,sourceJavascriptSha256:sha(entry.javascript),actionId:draft.scripts.actions[index].id,fieldId:getter.arguments[0].value,
  callback:{start:callback.start,end:callback.end,sha256:sha(entry.javascript.slice(callback.start,callback.end))},getter:{start:getter.start,end:getter.end,sha256:sha(entry.javascript.slice(getter.start,getter.end))}};
 });}
function envelope(source,typed){return{version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,authorization:{actor:'hypothetical-fixture-only',evidenceSha256:sha('Hypothetical sanitized fixture approval; not real human authorization.')},decisions:typed};}
function approved(){const {source,draft}=input(),typed=decisions(source,draft),authorized=attachMigrationPolicies(source,envelope(source,typed),scope);return{source:authorized,draft:draftSourceDraft(authorized),typed};}
function trace(code,form,value,source){
 const result=[],listeners=[];
 const read=id=>{result.push(['read',id]);return value;};
 const context={window:{},Com_AddEventListener(_w,_e,fn){listeners.push(fn);},GetXFormFieldValueById(id){const v=read(id);return Array.isArray(v)?v:v===undefined?[]:[v];},common_dom_row_set_show_required_reset(id,show,required,reset){assert.equal(reset,false);result.push(['attr',canonicalRowTarget(form,id),show?5:4],['attr',canonicalRowTarget(form,id),required?3:6]);},MKXFORM:{getValue:read,setFieldAttr:(id,attr)=>result.push(['attr',id,attr])}};
 if(source){vm.runInNewContext(code,context);listeners.forEach(fn=>fn());}else vm.runInNewContext('('+code+')()',context);
 return result;
}
it('does not promote unproven facts and keeps the original no-policy route pending',async()=>withNetworkGuard(async()=>{
 const{source,draft}=input();assert.ok(draft.scripts.actions.every(a=>a.translationStatus==='needs_review'));
 for(const id of ['fd_state_A','fd_state_B'])assert.equal(draft.form.fields.find(f=>f.id===id).sourceProps.mainStringValueBindingFact.status,'unproven');
 const reviewed=await runAgentReview(source,draft,{provider:createFakeReviewProvider('accept')});assert.equal(reviewed.ok,false);
 const client=new FakeNewoaAdapter('persist'),execution=await executeDsl(draft,{...scope,client,confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}});assert.equal(execution.ok,false);assert.deepEqual(client.transcript(),[]);
}));
it('accepts only the exact typed policy/action/source/range schema',()=>{
 const{source,draft}=input(),typed=decisions(source,draft);assert.equal(validateApprovedMainStringLoadDecisions(typed).ok,true);
 for(const candidate of [null,[{...typed[0],extra:true}],[{...typed[0],kind:'unknown'}],[{...typed[0],sourceJavascriptSha256:'0'.repeat(64)}],[{...typed[0],callback:{...typed[0].callback,start:-1}}],[typed[0],typed[0]]])assert.equal(validateApprovedMainStringLoadDecisions(candidate).ok,false);
});
it('preserves all ordered row effects, reads only at the original statement, and records the approved difference',()=>{
 const before=input(),original=JSON.stringify(before.source),result=applyApprovedMainStringLoadPolicies(before.source,before.draft,decisions(before.source,before.draft));
 assert.equal(JSON.stringify(before.source),original);assert.deepEqual(result.draft.form,before.draft.form);assert.equal(result.changedActionIds.length,2);
 for(const value of ['A','B','H','','A,B',undefined,null])for(const[index,entry]of before.source.scripts.sources.entries())assert.deepEqual(trace(result.draft.scripts.actions[index].function,result.draft.form,value,false),trace(entry.javascript,result.draft.form,value,true));
 const fn=result.draft.scripts.actions[0].function;assert.ok(fn.indexOf('setFieldAttr')<fn.indexOf('getValue'));assert.equal((fn.match(/setFieldAttr/g)||[]).length,12);
 assert.match(result.audits[0].approvedDifference,/duplicate\/injected/);assert.equal(result.audits[0].sourceBindingFactStatus,'unproven');
 for(const invalid of [['A'],['A','B'],4,false,{value:'A'}])assert.throws(()=>trace(fn,result.draft.form,invalid,false),error=>error==='Expected one current main String value.');
});
it('exposes the deliberately different duplicate-list versus current scalar branch',()=>{
 const {source,draft}=input(),result=applyApprovedMainStringLoadPolicies(source,draft,decisions(source,draft));
 const old=trace(source.scripts.sources[0].javascript,draft.form,['A','A'],true),current=trace(result.draft.scripts.actions[0].function,draft.form,'A',false);
 assert.notDeepEqual(old,current);assert.equal(old.filter(e=>e[0]==='attr'&&e[2]===5).length,0);assert.equal(current.filter(e=>e[0]==='attr'&&e[2]===5).length,1);
});
for(const[name,mutate]of[
 ['wrong source hash',d=>d.sourceJavascriptSha256='sha256:'+'0'.repeat(64)],
 ['wrong source reference',d=>d.sourceRef+='-other'],
 ['wrong action',d=>d.actionId+='-other'],
 ['wrong field',d=>d.fieldId='fd_state_B'],
 ['shifted callback',d=>d.callback.start++],
 ['shifted getter',d=>d.getter.end--],
 ['getter content hash',d=>d.getter.sha256='sha256:'+'0'.repeat(64)]
])it('rejects source-bound policy tampering: '+name,()=>{
 const{source,draft}=input(),typed=decisions(source,draft);mutate(typed[0]);assert.throws(()=>applyApprovedMainStringLoadPolicies(source,draft,typed));
});
for(const[name,mutate]of[
 ['visible target',f=>f.componentId='xform-input'],['data-only target',f=>f.dataOnly=true],
 ['multi-valued target',f=>f.props.multiple=true],
 ['Number metadata',f=>f.sourceProps.mainStringValueBindingFact.metadata.type='Number'],
 ['duplicate metadata',f=>f.sourceProps.mainStringValueBindingFact.metadata.count=2],
 ['wrong designer identity',f=>f.sourceProps.designerId='fd_other'],
 ['contradictory metadata',f=>f.sourceProps.metadataAttributes.type='Double']
])it('rejects nonmatching native/metadata contract: '+name,()=>{
 const{source,draft}=input(),typed=decisions(source,draft);mutate(draft.form.fields.find(f=>f.id==='fd_state_A'));assert.throws(()=>applyApprovedMainStringLoadPolicies(source,draft,typed),/hidden native|source-bound metadata/);
});
it('rejects duplicate native main IDs',()=>{
 const{source,draft}=input();draft.form.fields.push(structuredClone(draft.form.fields.find(f=>f.id==='fd_state_A')));assert.throws(()=>applyApprovedMainStringLoadPolicies(source,draft,decisions(source,draft)),/hidden native|source-bound metadata/);
});
for(const statement of ['var window={};','function window(){}','window={};','globalThis.window={};','self["window"]={};','window.window={};'])
it('rejects another source overriding the original load registration global: '+statement,()=>{
 const{source,draft}=input(),typed=decisions(source,draft);
 // Approve only source 0 so source 1's registration validator cannot hide a
 // missing source-wide protection for its window declaration/assignment.
 source.scripts.sources[1].javascript+='\n'+statement;
 assert.throws(()=>applyApprovedMainStringLoadPolicies(source,draft,[typed[0]]),/source-owned API/);
});
for(const[name,replace]of[
 ['strict comparison',text=>text.replaceAll('cached==','cached===')],
 ['empty comparison',text=>text.replace('cached=="A"','cached==""')],
 ['member read',text=>text.replace('cached=="A"','cached.length=="A"')],
 ['alias escape',text=>text.replace('if(cached==','unknown(cached);if(cached==')],
 ['alias mutation',text=>text.replace('if(cached==','cached="A";if(cached==')],
 ['unknown sibling',text=>text.replace('var cached =','unknownEffect();var cached =')],
 ['getter shadow',text=>text.replace('function(){','function(GetXFormFieldValueById){')],
 ['row helper reassignment',text=>'common_dom_row_set_show_required_reset=other;'+text],
 ['unknown row target',text=>text.replaceAll('fd_A_row','missing_row')]
 ,['reserved runtime alias',text=>text.replaceAll('cached','Array')]
])it('keeps unsupported source behavior rejected: '+name,()=>{
 const{source,draft}=input();source.scripts.sources[0].javascript=replace(source.scripts.sources[0].javascript);
 let typed;try{typed=decisions(source,draft);}catch{return;}
 assert.throws(()=>applyApprovedMainStringLoadPolicies(source,draft,typed));
});
it('passes public source-policy/draft/trust/dry-run/fake-create/readback/record and rejects sealed changes',async()=>withNetworkGuard(async()=>{
 const{source,draft}=approved();assert.ok(draft.scripts.actions.every(a=>a.translationStatus==='mapped'));
 const reviewed=await runAgentReview(source,draft,{provider:createFakeReviewProvider('accept')});assert.equal(reviewed.ok,true,JSON.stringify(reviewed.report?.diagnostics));assert.equal(checkTrust(source,reviewed.dsl).ok,true);assert.equal(buildDryRunPlan(reviewed.dsl).ok,true);
 const jsonb=value=>Array.isArray(value)?value.map(jsonb):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort((a,b)=>a.length-b.length||a.localeCompare(b)).map(k=>[k,jsonb(value[k])])):value;
 assert.equal(checkTrust(jsonb(source),jsonb(reviewed.dsl)).ok,true);
 assert.ok(reviewed.dsl.form.fields.filter(f=>['fd_state_A','fd_state_B'].includes(f.id)).every(f=>f.sourceProps.mainStringValueBindingFact.status==='unproven'));
 const client=new FakeNewoaAdapter('persist'),out=await executeDsl(reviewed.dsl,{...scope,client,confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}});assert.equal(out.ok,true,JSON.stringify(out.diagnostics));assert.equal(out.readback.ok,true);assert.equal(out.transferRecord.status,'recorded');
 for(const mutate of [d=>d.scripts.actions[0].function+='\nunknown();',d=>d.migrationPolicies.decisions[0].getter.start++,d=>d.form.fields.find(f=>f.id==='fd_state_A').sourceProps.mainStringValueBindingFact.status='verified',d=>delete d.migrationPolicies]){
  const bad=structuredClone(reviewed.dsl);mutate(bad);assert.equal(checkTrust(source,bad).ok,false);const blockedClient=new FakeNewoaAdapter('persist'),blocked=await executeDsl(bad,{...scope,client:blockedClient,confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}});assert.equal(blocked.ok,false);assert.deepEqual(blockedClient.transcript(),[]);
 }
 const wrong=new FakeNewoaAdapter('persist'),scopeMismatch=await executeDsl(reviewed.dsl,{...scope,baseUrl:'https://other.example.invalid',client:wrong,confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}});assert.equal(scopeMismatch.ok,false);assert.deepEqual(wrong.transcript(),[]);
}));
