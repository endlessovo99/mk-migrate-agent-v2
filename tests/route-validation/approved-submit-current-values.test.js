import assert from 'node:assert/strict';
import {it} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {attachMigrationPolicies,migrationPolicySourceDigest} from '../../src/translator/approved-migration-policies.js';
import {applyApprovedSubmitCurrentValuePolicies,validateApprovedSubmitCurrentValueDecisions} from '../../src/translator/approved-submit-current-values-policies.js';
import {runAgentReview} from '../../src/agent-review/index.js';
import {checkTrust} from '../../src/dsl/trust.js';
import {buildDryRunPlan} from '../../src/executor/dry-run.js';
import {executeDsl} from '../../src/executor/execute.js';
import {FakeNewoaAdapter} from './fake-newoa-adapter.js';
import {createFakeReviewProvider} from './fake-review-provider.js';
import {withNetworkGuard} from './network-guard.js';

const fixture='tests/fixtures/route-validation/approved-submit-current-values';
const hash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const scope={baseUrl:'https://qas.example.invalid',targetCategoryId:'route-category-id'};
const options={...scope,confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}};
function decisionFor(source,draft){
 const script=source.scripts.sources.find(value=>value.javascript.includes('var sum='));
 const call=parse(script.javascript,{ecmaVersion:'latest'}).body[0].expression;
 const declarations=call.arguments[0].body.body.filter(value=>value.type==='VariableDeclaration').map(value=>value.declarations[0]);
 const range=node=>({start:node.start,end:node.end,sha256:hash(script.javascript.slice(node.start,node.end))});
 return {kind:'submit-validation-current-values',sourceRef:script.sourceRef,sourceJavascriptSha256:hash(script.javascript),actionId:draft.scripts.actions.find(value=>value.sourceRefs.includes(script.sourceRef)).id,
  callback:range(call),aggregate:{...range(declarations.find(value=>value.id.name==='sum').init),sourceFieldIds:['fd_labor','fd_missing_labor','fd_vendor','fd_missing_vendor'],fieldId:'fd_total'},
  readReplacements:[{...range(declarations.find(value=>value.id.name==='d').init),sourceFieldId:'fd_missing_vendor',fieldId:'fd_prior_vendor'}]};
}
function input(source=cleanSourceFile(fixture)){
 const draft=draftSourceDraft(source),decision=decisionFor(source,draft);
 const approved=attachMigrationPolicies(source,{version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,
  authorization:{actor:'synthetic-fixture-only',evidenceSha256:hash('Hypothetical fixture approval, not human authorization.')},decisions:[decision]});
 return {raw:source,source:approved,decision,draft:draftSourceDraft(approved)};
}
function altered(change,run){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'current-submit-policy-'));
 try{for(const name of fs.readdirSync(fixture))fs.writeFileSync(path.join(root,name),change(fs.readFileSync(path.join(fixture,name),'utf8'),name));return run(cleanSourceFile(root));}
 finally{fs.rmSync(root,{recursive:true,force:true});}
}
function evaluate(fn,values,context={}){
 const reads=[],alerts=[];
 const runtime={MKXFORM:{getValue(id){reads.push(id);return values[id];},toast(message){alerts.push(message);}}};
 const result=vm.runInNewContext('('+fn+')',runtime)(context);
 return {result,reads,alerts};
}

it('requires the complete exact approval schema and unique action/source ownership',()=>{
 const{decision}=input();assert.equal(validateApprovedSubmitCurrentValueDecisions([decision]).ok,true);
 for(const value of [null,[{...decision,extra:true}],[{...decision,kind:'unknown'}],[{...decision,callback:{...decision.callback,sha256:'bad'}}],[{...decision,aggregate:{...decision.aggregate,sourceFieldIds:['fd_labor','fd_labor']}}],[{...decision,readReplacements:[]}],[decision,decision]])assert.equal(validateApprovedSubmitCurrentValueDecisions(value).ok,false);
});
it('keeps source, formulas, field required checks and nonempty workflow conditions unchanged',()=>{
 const raw=cleanSourceFile(fixture),serialized=JSON.stringify(raw),before=draftSourceDraft(raw),{draft}=input(raw);
 assert.equal(JSON.stringify(raw),serialized);assert.deepEqual(draft.form,before.form);assert.deepEqual(draft.formRules,before.formRules);assert.deepEqual(draft.workflow,before.workflow);
 assert.ok(draft.workflow.edges.some(edge=>edge.condition));assert.equal(draft.form.fields.find(field=>field.id==='fd_budget').props.required,true);
 const audit=draft.migrationPolicyAudit.audits.find(value=>value.kind==='submit-validation-current-values');
 assert.deepEqual(audit.removedUnusedInputFieldIds,['fd_labor','fd_missing_labor']);assert.match(audit.approvedDifference,/business decision/);
 assert.equal(audit.originalSourcePreserved,true);assert.equal(audit.rewrites.length,4);assert.equal(audit.targetNumericFieldEvidence.length,2);
});
it('preserves alert priority, boolean blocking returns and the draft guard using approved current values',()=>{
 const{draft}=input(),fn=draft.scripts.actions[0].function;
 const base={fd_budget:100,fd_vendor:5,fd_prior_vendor:5,fd_total:10};
 for(const [values,result,alerts]of [
  [base,true,[]],[{...base,fd_total:101},false,['Total exceeds budget']],
  [{...base,fd_budget:-1,fd_total:-2},false,['Budget negative']],
  [{...base,fd_vendor:-1},false,['Current vendor negative']],
  [{...base,fd_prior_vendor:-1},false,['Prior vendor negative']],
  [{...base,fd_total:101,fd_vendor:-1,fd_prior_vendor:-1},false,['Total exceeds budget']],
  [{...base,fd_budget:0,fd_total:0,fd_vendor:0,fd_prior_vendor:0},true,[]]
 ]){const run=evaluate(fn,values);assert.equal(run.result,result);assert.deepEqual(run.alerts,alerts);assert.deepEqual(run.reads,['fd_budget','fd_vendor','fd_prior_vendor','fd_total']);}
 assert.deepEqual(evaluate(fn,{}, {isDraft:true}),{result:true,reads:[],alerts:[]});
 assert.equal(fn.includes('fd_missing_labor'),false);assert.equal(fn.includes('fd_missing_vendor'),false);
});
for(const[name,mutate]of[
 ['source hash',decision=>decision.sourceJavascriptSha256='sha256:'+'0'.repeat(64)],
 ['action identity',decision=>decision.actionId+='other'],['source identity',decision=>decision.sourceRef+='other'],
 ['callback range',decision=>decision.callback.end--],['aggregate range',decision=>decision.aggregate.start++],
 ['aggregate hash',decision=>decision.aggregate.sha256='sha256:'+'0'.repeat(64)],
 ['sum source order',decision=>decision.aggregate.sourceFieldIds.reverse()],
 ['unknown cumulative field',decision=>decision.aggregate.fieldId='fd_unknown'],
 ['wrong original read',decision=>decision.readReplacements[0].sourceFieldId='fd_missing_labor'],
 ['read range',decision=>decision.readReplacements[0].end--],
 ['unknown current validation value',decision=>decision.readReplacements[0].fieldId='fd_unknown']
])it('rejects a stale or changed source-bound decision: '+name,()=>{
 const{raw,decision}=input();mutate(decision);assert.throws(()=>applyApprovedSubmitCurrentValuePolicies(raw,draftSourceDraft(raw),[decision]));
});
for(const[name,change]of[
 ['unrecognized side effect',s=>s.replace('console.log(limit);','unknownEffect();console.log(limit);')],
 ['changed sum operator',s=>s.replace('Number(a)+Number(b)','Number(a)-Number(b)')],
 ['noncanonical scalar selector',s=>s.replaceAll('extendDataFormInfo.value(fd_budget)','extendDataFormInfo.value(fd_budget) extra')],
 ['shadowed Number',s=>s.replace('var limit=', 'var Number=0;var limit=')],
 ['shadowed selector',s=>s.replace('var limit=', 'var $=0;var limit=')],
 ['shared source registration',s=>s.replace('return true;','return true;});Com_Parameter.event.submit.push(function(){return true;')]
])it('does not use approval to hide unsupported original behavior: '+name,()=>{
 altered((s,name)=>name.endsWith('_SysFormTemplate.xml')?change(s):s,raw=>assert.throws(()=>input(raw)));
});
it('rejects duplicate, nonnumeric, data-only or mutated target field evidence',()=>{
 const{raw,decision}=input();
 for(const change of [
  draft=>draft.form.fields.push(structuredClone(draft.form.fields.find(field=>field.id==='fd_total'))),
  draft=>draft.form.fields.find(field=>field.id==='fd_total').type='text',
  draft=>draft.form.fields.find(field=>field.id==='fd_prior_vendor').dataOnly=true,
  draft=>draft.form.fields.find(field=>field.id==='fd_total').sourceProps.metadataAttributes.type='String',
  draft=>draft.form.fields.find(field=>field.id==='fd_total').sourceProps.mainStringValueBindingFact.metadata.count=2
 ]){const draft=draftSourceDraft(raw);change(draft);assert.throws(()=>applyApprovedSubmitCurrentValuePolicies(raw,draft,[decision]));}
});
it('rejects another source overriding platform APIs or executing dynamic source',()=>{
 for(const javascript of ['globalThis["Number"]=other;','window.Com_Parameter=other;','var $=other;','eval("sideEffect()");']){
  const{raw,decision}=input(),draft=draftSourceDraft(raw);raw.scripts.sources.push({id:'other',sourceRef:'source.form.jsp.other',javascript});
  assert.throws(()=>applyApprovedSubmitCurrentValuePolicies(raw,draft,[decision]));
 }
});
it('retains the unapproved blocker and uses normal model review, trust, dry-run, fake draft/readback/record after approval',async()=>withNetworkGuard(async()=>{
 const{raw,source,draft}=input(),original=draftSourceDraft(raw);assert.equal(original.scripts.actions[0].translationStatus,'needs_review');
 const refusedClient=new FakeNewoaAdapter('persist'),refused=await executeDsl(original,{...options,client:refusedClient});assert.equal(refused.remoteWriteAttempted,false);assert.deepEqual(refusedClient.transcript(),[]);
 const review=await runAgentReview(source,draft,{provider:createFakeReviewProvider('accept')});assert.equal(review.ok,true,JSON.stringify(review.report?.diagnostics));
 assert.equal(checkTrust(source,review.dsl).ok,true,JSON.stringify(checkTrust(source,review.dsl).diagnostics));assert.equal(buildDryRunPlan(review.dsl).ok,true);
 const client=new FakeNewoaAdapter('persist'),report=await executeDsl(review.dsl,{...options,client});assert.equal(report.ok,true,JSON.stringify(report.diagnostics));assert.equal(report.readback.ok,true);assert.equal(report.transferRecord.status,'recorded');
 assert.ok(client.workflowDraft);assert.ok(client.transcript().some(entry=>entry.operation==='save-workflow-draft'));
 for(const mutate of [
  dsl=>dsl.scripts.actions[0].function=dsl.scripts.actions[0].function.replace('return false','return true'),
  dsl=>dsl.migrationPolicies.decisions[0].aggregate.fieldId='fd_prior_vendor',
  dsl=>dsl.form.fields.find(field=>field.id==='fd_budget').props.required=false,
  dsl=>dsl.workflow.edges.find(edge=>edge.condition).condition='true',
  dsl=>delete dsl.migrationPolicies
 ]){const bad=structuredClone(review.dsl);mutate(bad);assert.equal(checkTrust(source,bad).ok,false);const blocked=new FakeNewoaAdapter('persist'),execution=await executeDsl(bad,{...options,client:blocked});assert.equal(execution.ok,false);assert.deepEqual(blocked.transcript(),[]);}
 const wrong=new FakeNewoaAdapter('persist'),outside=await executeDsl(review.dsl,{...options,baseUrl:'https://outside.example.invalid',client:wrong});assert.equal(outside.ok,false);assert.deepEqual(wrong.transcript(),[]);
}));
