import { nativeMessageRuntime } from "../helpers/native-message-runtime.js";
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
import {applyApprovedUnboundDiagnosticPolicies,validateApprovedUnboundDiagnosticDecisions} from '../../src/translator/approved-submit-current-values-policies.js';
import {runAgentReview} from '../../src/agent-review/index.js';
import {checkTrust} from '../../src/dsl/trust.js';
import {buildDryRunPlan} from '../../src/executor/dry-run.js';
import {executeDsl} from '../../src/executor/execute.js';
import {FakeNewoaAdapter} from './fake-newoa-adapter.js';
import {createFakeReviewProvider} from './fake-review-provider.js';
import {withNetworkGuard} from './network-guard.js';

const fixture='tests/fixtures/route-validation/approved-unbound-diagnostic';
const hash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const scope={baseUrl:'https://qas.example.invalid',targetCategoryId:'route-category-id'};
const options={...scope,confirmWrite:true,credentials:{username:'fixture',encryptedPassword:'fixture'}};
function decisionFor(source,draft){
 const script=source.scripts.sources.find(value=>value.javascript.includes('console.log('));
 const call=parse(script.javascript,{ecmaVersion:'latest'}).body[0].expression,statement=call.arguments[1].body.body.at(-1);
 const range=node=>({start:node.start,end:node.end,sha256:hash(script.javascript.slice(node.start,node.end))});
 return {kind:'omit-unbound-console-diagnostic',sourceRef:script.sourceRef,sourceJavascriptSha256:hash(script.javascript),actionId:draft.scripts.actions.find(value=>value.sourceRefs.includes(script.sourceRef)).id,
  callback:range(call),diagnostic:{...range(statement),identifier:'debugValue'}};
}
function input(source=cleanSourceFile(fixture)){
 const draft=draftSourceDraft(source),decision=decisionFor(source,draft);
 const approved=attachMigrationPolicies(source,{version:1,sourceDraftSha256:migrationPolicySourceDigest(source),scope,
  authorization:{actor:'synthetic-fixture-only',evidenceSha256:hash('Hypothetical diagnostic omission approval, not human authorization.')},decisions:[decision]});
 return {raw:source,source:approved,decision,draft:draftSourceDraft(approved)};
}
function altered(change,run){const root=fs.mkdtempSync(path.join(os.tmpdir(),'unbound-diagnostic-policy-'));try{for(const name of fs.readdirSync(fixture))fs.writeFileSync(path.join(root,name),change(fs.readFileSync(path.join(fixture,name),'utf8'),name));return run(cleanSourceFile(root));}finally{fs.rmSync(root,{recursive:true,force:true});}}
function actionFor(draft,decision){return draft.scripts.actions.find(value=>value.id===decision.actionId);}
it('accepts only the exact source/action/callback/diagnostic schema',()=>{
 const{decision}=input();assert.equal(validateApprovedUnboundDiagnosticDecisions([decision]).ok,true);
 for(const value of [null,[{...decision,extra:true}],[{...decision,kind:'unknown'}],[{...decision,diagnostic:{...decision.diagnostic,extra:true}}],[{...decision,diagnostic:{...decision.diagnostic,identifier:'value.name'}}],[{...decision,diagnostic:{...decision.diagnostic,start:0}}],[decision,decision]])assert.equal(validateApprovedUnboundDiagnosticDecisions(value).ok,false);
});
it('retains the deliberate exception difference, negative alert and all unrelated source/form/workflow content',()=>{
 const raw=cleanSourceFile(fixture),serialized=JSON.stringify(raw),before=draftSourceDraft(raw),{draft,decision}=input(raw),action=actionFor(draft,decision);
 assert.equal(JSON.stringify(raw),serialized);assert.deepEqual(draft.form,before.form);assert.deepEqual(draft.formRules,before.formRules);assert.deepEqual(draft.workflow,before.workflow);
 assert.ok(draft.workflow.edges.some(edge=>edge.condition));assert.deepEqual(draft.scripts.actions.find(value=>value.id!==decision.actionId),before.scripts.actions.find(value=>value.id!==decision.actionId));
 assert.equal(action.function.includes('getValue'),false);assert.equal(action.function.includes('setValue'),false);assert.equal(action.function.includes('debugValue'),false);
 const audit=draft.migrationPolicyAudit.audits[0];assert.match(audit.approvedDifference,/possible exception/);assert.match(audit.approvedDifference,/No source equivalence/);assert.equal(audit.retiredDiagnostic.sha256,decision.diagnostic.sha256);
 for(const value of [-1,0,1]){
  const alerts=[],runtime={MKXFORM:nativeMessageRuntime("desktop", message=>alerts.push(message)).MKXFORM};
  assert.equal(vm.runInNewContext('('+action.function+')',runtime)(value),undefined);assert.deepEqual(alerts,value<0?['Value negative']:[]);
  const callbacks={},originalAlerts=[],context={AttachXFormValueChangeEventById:(id,fn)=>callbacks[id]=fn,GetXFormFieldById:()=>[{value:7}],alert:message=>originalAlerts.push(message),console:{log(){throw Error('Unbound argument must fail before invoking console.log.');}}};
  vm.runInNewContext(raw.scripts.sources.map(source=>source.javascript).join('\n'),context);callbacks.fd_input(1);assert.equal(Object.hasOwn(context,'debugValue'),false);
  assert.throws(()=>callbacks.fd_value(value),error=>error.name==='ReferenceError');assert.deepEqual(originalAlerts,value<0?['Value negative']:[]);
 }
});
for(const[name,mutate]of[
 ['source hash',decision=>decision.sourceJavascriptSha256='sha256:'+'0'.repeat(64)],['source identity',decision=>decision.sourceRef+='other'],['action identity',decision=>decision.actionId+='other'],
 ['callback range',decision=>decision.callback.end--],['diagnostic range',decision=>decision.diagnostic.start++],['diagnostic hash',decision=>decision.diagnostic.sha256='sha256:'+'0'.repeat(64)],['identifier',decision=>decision.diagnostic.identifier='value']
])it('rejects a changed bound decision: '+name,()=>{const{raw,decision}=input();mutate(decision);assert.throws(()=>applyApprovedUnboundDiagnosticPolicies(raw,draftSourceDraft(raw),[decision]));});
for(const[name,change]of[
 ['extra argument',text=>text.replace('console.log(debugValue)','console.log(debugValue,value)')],
 ['computed callee',text=>text.replace('console.log(debugValue)','console["log"](debugValue)')],
 ['different console method',text=>text.replace('console.log(debugValue)','console.warn(debugValue)')],
 ['nontrivial argument',text=>text.replace('console.log(debugValue)','console.log(debugValue.value)')],
 ['local binding',text=>text.replace('console.log(debugValue)','var debugValue=7;console.log(debugValue)')],
 ['extra retained effect',text=>text.replace('console.log(debugValue)','unknownEffect();console.log(debugValue)')],
 ['nonterminal diagnostic',text=>text.replace('console.log(debugValue);','console.log(debugValue);alert("after");')],
 ['retained identifier use',text=>text.replace('console.log(debugValue)','if(debugValue){alert("dependent");}console.log(debugValue)')],
 ['changed business branch',text=>text.replace('if(value&lt;0){alert(&quot;Value negative&quot;);}','if(value&lt;0){alert(&quot;Value negative&quot;);return false;}')]
])it('does not retire unsupported or mixed behavior: '+name,()=>{
 altered((text,name)=>name.endsWith('_SysFormTemplate.xml')?change(text):text,raw=>{
  const draft=draftSourceDraft(raw);let decision;try{decision=decisionFor(raw,draft);}catch{return;}
  assert.throws(()=>applyApprovedUnboundDiagnosticPolicies(raw,draft,[decision]));
 });
});
it('rejects source-wide global bindings, implicit writes, API replacement and wrong event identity',()=>{
 for(const javascript of ['var debugValue=1;','debugValue=1;','globalThis.debugValue=1;','var AttachXFormValueChangeEventById=other;','console.log=other;','eval("sideEffect()");']){
  const{raw,decision}=input(),draft=draftSourceDraft(raw);raw.scripts.sources.push({id:'other',sourceRef:'source.form.jsp.other',javascript});assert.throws(()=>applyApprovedUnboundDiagnosticPolicies(raw,draft,[decision]));
 }
 const{raw,decision}=input();for(const mutate of [action=>action.controlId='fd_input',action=>action.event='onBeforeSubmit',action=>action.sourceRefs.push('other')]){const draft=draftSourceDraft(raw);mutate(actionFor(draft,decision));assert.throws(()=>applyApprovedUnboundDiagnosticPolicies(raw,draft,[decision]));}
});
it('uses normal model review/trust/dry-run/fake draft/readback/record and refuses unapproved or sealed changes',async()=>withNetworkGuard(async()=>{
 const{raw,source,draft,decision}=input(),original=draftSourceDraft(raw),noPolicy=new FakeNewoaAdapter('persist');assert.equal(actionFor(original,decision).translationStatus,'needs_review');
 const refused=await executeDsl(original,{...options,client:noPolicy});assert.equal(refused.remoteWriteAttempted,false);assert.deepEqual(noPolicy.transcript(),[]);
 const review=await runAgentReview(source,draft,{provider:createFakeReviewProvider('accept')});assert.equal(review.ok,true,JSON.stringify(review.report?.diagnostics));assert.equal(checkTrust(source,review.dsl).ok,true);assert.equal(buildDryRunPlan(review.dsl).ok,true);
 const client=new FakeNewoaAdapter('persist'),report=await executeDsl(review.dsl,{...options,client});assert.equal(report.ok,true,JSON.stringify(report.diagnostics));assert.equal(report.readback.ok,true);assert.equal(report.transferRecord.status,'recorded');assert.ok(client.workflowDraft);
 for(const mutate of [dsl=>actionFor(dsl,decision).function='function onChange(){}',dsl=>dsl.migrationPolicies.decisions[0].diagnostic.end--,dsl=>dsl.workflow.edges.find(edge=>edge.condition).condition='true',dsl=>dsl.form.fields.find(field=>field.id==='fd_value').props.required=false,dsl=>delete dsl.migrationPolicies]){
  const bad=structuredClone(review.dsl);mutate(bad);assert.equal(checkTrust(source,bad).ok,false);const blocked=new FakeNewoaAdapter('persist'),execution=await executeDsl(bad,{...options,client:blocked});assert.equal(execution.ok,false);assert.deepEqual(blocked.transcript(),[]);
 }
 const outside=new FakeNewoaAdapter('persist'),wrong=await executeDsl(review.dsl,{...options,baseUrl:'https://outside.example.invalid',client:outside});assert.equal(wrong.ok,false);assert.deepEqual(outside.transcript(),[]);
}));
