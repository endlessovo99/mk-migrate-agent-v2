import assert from "node:assert/strict";
import {it} from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {cleanSourceFile,draftSourceDraft} from "../../src/translator/index.js";
import {attachMigrationPolicies,migrationPolicySourceDigest} from "../../src/translator/approved-migration-policies.js";
import {buildSupportedDetailStateDecision,applySupportedDetailStatePolicies,validateSupportedDetailStateDecisions,DETAIL_STATE_OMISSIONS} from "../../src/translator/approved-detail-state-policy.js";
import {sha256Digest} from "../../src/agent-review/digest.js";
import {runAgentReview} from "../../src/agent-review/index.js";
import {applyEvidenceBackedPatches,collectSourceRefs} from "../../src/agent-review/review-validation.js";
import {checkTrust} from "../../src/dsl/trust.js";
import {buildDryRunPlan} from "../../src/executor/dry-run.js";
import {executeDsl} from "../../src/executor/execute.js";
import {createFakeReviewProvider} from "./fake-review-provider.js";
import {FakeNewoaAdapter} from "./fake-newoa-adapter.js";
import {withNetworkGuard} from "./network-guard.js";

const fixture="tests/fixtures/route-validation/approved-detail-state";
const scope={baseUrl:"https://qas.example.invalid",targetCategoryId:"fixture-category"};
const options={...scope,confirmWrite:true,credentials:{username:"fixture",encryptedPassword:"fixture"}};
function input(raw=cleanSourceFile(fixture)) {
  const base=draftSourceDraft(raw),decision=buildSupportedDetailStateDecision(raw,base);
  const source=attachMigrationPolicies(raw,{version:1,sourceDraftSha256:migrationPolicySourceDigest(raw),scope,
    authorization:{actor:"synthetic-test-only",evidenceSha256:sha256Digest("Synthetic supported-only decision, not human approval.")},decisions:[decision]});
  return {raw,base,decision,source,draft:draftSourceDraft(source)};
}
function altered(change,run) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"detail-state-policy-"));
  try {for (const file of fs.readdirSync(fixture)) fs.writeFileSync(path.join(dir,file),change(fs.readFileSync(path.join(fixture,file),"utf8"),file));return run(cleanSourceFile(dir));}
  finally {fs.rmSync(dir,{recursive:true,force:true});}
}
it("requires exact original program/action hashes and all explicitly acknowledged differences",()=>{
  const {decision}=input();assert.equal(validateSupportedDetailStateDecisions([decision]).ok,true);
  for (const value of [null,[],[decision,decision],[{...decision,extra:true}],[{...decision,omissions:[]}],
    [{...decision,sourceScripts:[{...decision.sourceScripts[0],sha256:"wrong"}]}],
    [{...decision,actions:[...decision.actions,decision.actions[0]]}]]) assert.equal(validateSupportedDetailStateDecisions(value).ok,false);
});
it("keeps source, fields, workflow and native rules unchanged while explicitly recording the omitted runtime",()=>{
  const raw=cleanSourceFile(fixture),before=JSON.stringify(raw),{base,draft,decision}=input(raw);
  assert.equal(JSON.stringify(raw),before);
  assert.deepEqual(draft.form,base.form);assert.deepEqual(draft.formRules,base.formRules);assert.deepEqual(draft.workflow,base.workflow);
  assert.ok(base.formRules.linkage.length);assert.ok(base.workflow.edges.some(edge=>edge.condition));
  assert.deepEqual(draft.migrationPolicyAudit.nativeRuleOwnership.sourceRefs,[]);
  for (const audit of draft.migrationPolicyAudit.audits) {
    assert.deepEqual(audit.omissions,DETAIL_STATE_OMISSIONS);assert.match(audit.approvedDifference,/No complete source equivalence/);
    assert.equal(audit.workflowBefore,sha256Digest(base.workflow));assert.ok(audit.originalCoverage.residuals.length);
  }
  const core=draft.scripts.actions.find(action=>action.id===decision.stateActionId);
  assert.equal(core.function.includes("placeholder"),false);assert.equal(core.function.includes("document."),false);
  const calls=[],api={viewStatus:"edit",updateControl:(...args)=>calls.push(["value",...args]),updateControlStyle:(...args)=>calls.push(["style",...args]),setDetailFieldItemAttr:(...args)=>calls.push(["attr",...args])};
  const execute=vm.runInNewContext("("+core.function+")",{MKXFORM:api});execute("gh",2);execute("xg",2);
  assert.deepEqual(calls.filter(call=>call[0]==="value").map(call=>[call[2],call[3]]),[[2,"true"],[2,""]]);
  api.viewStatus="view";const count=calls.length;execute("gh",0);assert.equal(calls.length,count);
  for (const action of draft.scripts.actions.filter(action=>action.id!==decision.stateActionId)) {
    if (action.translationStatus==="mapped") vm.runInNewContext("("+action.function+")",{MKXFORM:new Proxy({},{get(){throw Error("Excluded runtime must not invoke target APIs");}})})("sb",0);
  }
});
it("uses renamed source fields and option values instead of flow-specific identities",()=>{
  altered(text=>text.replaceAll("fd_detail","fd_rows").replaceAll("fd_notes","fd_comment").replaceAll("fd_hidden","fd_flag").replaceAll("gh","swap").replaceAll("xg","buy"),raw=>{
    const {draft,decision}=input(raw),core=draft.scripts.actions.find(action=>action.id===decision.stateActionId);
    assert.ok(core.function.includes("swap"));assert.ok(core.function.includes("fd_rows"));assert.ok(core.function.includes("fd_flag"));
  });
});
for (const [name,change] of [
  ["hash",decision=>decision.sourceScripts[0].sha256="sha256:"+"0".repeat(64)],
  ["action hash",decision=>decision.actions[0].sha256="sha256:"+"0".repeat(64)],
  ["source owner",decision=>decision.sourceScripts[0].sourceRef+=".other"],
  ["partial action scope",decision=>decision.actions.pop()],
  ["wrong core",decision=>decision.stateActionId=decision.actions.at(-1).id]
]) it("rejects changed approved scope: "+name,()=>{const {raw,base,decision}=input();change(decision);assert.throws(()=>applySupportedDetailStatePolicies(raw,base,[decision]));});
for (const [name,append] of [
  ["foreign persistent write",'var other=document.getElementsByName("extendDataFormInfo.value(fd_main)")[0];other.value="changed";'],
  ["network",'fetch("https://outside.invalid");'],
  ["unknown handler",'var other=document.getElementById("x");other.setAttribute("onclick","fetch(\\"https://outside.invalid\\");");'],
  ["source veto",'Com_AddEventListener(window,"load",function(){return false;});'],
  ["row reset",'common_dom_row_set_show_required_reset("fd_detail_row",false,false,true);'],
  ["automatic row creation",'DocList_AddRow("TABLE_DL_fd_detail");'],
  ["submit registration",'Com_AddEventListener(window,"submit",function(){});'],
  ["helper replacement",'controlDisplay=function(value,i){};']
]) it("does not accept newly authorized but out-of-profile effects: "+name,()=>{
  const raw=cleanSourceFile(fixture);raw.scripts.sources[0].javascript+="\n"+append;
  assert.throws(()=>buildSupportedDetailStateDecision(raw,draftSourceDraft(raw)));
});
it("rejects a conflicting later global helper instead of choosing an earlier declaration",()=>{
  const raw=cleanSourceFile(fixture),first=raw.scripts.sources[0],end=first.javascript.indexOf("function wireRows");
  raw.scripts.sources.push({...first,id:"later",sourceRef:"source.form.jsp.later",javascript:first.javascript.slice(0,end).replace('value=="gh"','value=="xg"')});
  assert.throws(()=>buildSupportedDetailStateDecision(raw,draftSourceDraft(raw)));
});
it("default guards still reject source-effect erasure without policy",()=>{
  const {raw,base}=input(),index=base.scripts.actions.findIndex(action=>action.translationStatus==="needs_review"),action=structuredClone(base.scripts.actions[index]);
  action.function="function onChange(){}";action.translationStatus="mapped";action.coverage={status:"translated",nativeRules:[],residuals:[]};
  const result=applyEvidenceBackedPatches(base,[{op:"replace",path:"/scripts/actions/"+index,value:action,sourceRefs:action.sourceRefs,evidence:["Synthetic attempt to erase unsupported effects"],confidence:1,rationale:"Test rejection"}],{sourceDraft:raw,sourceRefs:collectSourceRefs(raw)});
  assert.equal(result.ok,false);
});
it("runs model review, trust, dry-run, fake draft/readback/record and blocks policy or workflow tampering before network",async()=>withNetworkGuard(async()=>{
  const {raw,base,source,draft,decision}=input();
  const blocked=new FakeNewoaAdapter("persist");assert.equal((await executeDsl(base,{...options,client:blocked})).ok,false);assert.deepEqual(blocked.transcript(),[]);
  const review=await runAgentReview(source,draft,{provider:createFakeReviewProvider("accept")});
  assert.equal(review.ok,true,JSON.stringify(review.report?.diagnostics));assert.equal(checkTrust(source,review.dsl).ok,true);assert.equal(buildDryRunPlan(review.dsl).ok,true);
  const client=new FakeNewoaAdapter("persist"),report=await executeDsl(review.dsl,{...options,client});
  assert.equal(report.ok,true,JSON.stringify(report.diagnostics));assert.equal(report.readback.ok,true);assert.equal(report.transferRecord.status,"recorded");
  assert.equal(checkTrust(raw,review.dsl).ok,false);
  for (const mutate of [dsl=>dsl.scripts.actions.find(action=>action.id===decision.stateActionId).function="function onChange(){}",
    dsl=>dsl.migrationPolicies.decisions[0].omissions.pop(),dsl=>delete dsl.migrationPolicies,
    dsl=>dsl.form.fields[0].props.required=!dsl.form.fields[0].props.required,
    dsl=>dsl.formRules.linkage=[],dsl=>dsl.workflow.edges.find(edge=>edge.condition).condition="true"]) {
    const changed=structuredClone(review.dsl);mutate(changed);assert.equal(checkTrust(source,changed).ok,false);
    const denied=new FakeNewoaAdapter("persist");assert.equal((await executeDsl(changed,{...options,client:denied})).ok,false);assert.deepEqual(denied.transcript(),[]);
  }
  const outside=new FakeNewoaAdapter("persist");assert.equal((await executeDsl(review.dsl,{...options,baseUrl:"https://outside.invalid",client:outside})).ok,false);assert.deepEqual(outside.transcript(),[]);
}));
for (const [name,transform] of [
  ["injected row string",text=>text+'\nvar i="0);fetch(\'https://outside.invalid\');//";var foreign=document.getElementById("foreign");foreign.setAttribute("onclick","controlDisplay(this.value,"+i+");");'],
  ["fixed target row",text=>text.replace('"controlDisplay(this.value,"+i+")"','"controlDisplay(this.value,0)"')],
  ["mutated loop index",text=>text.replace('trigger.setAttribute(', 'i="0);fetch(\'https://outside.invalid\');//";trigger.setAttribute(')],
  ["foreign value interpolation",text=>text.replace('"controlDisplay(this.value,"+i+")"','"__xformDispatch(this.value,document.getElementsByName(this.name));controlDisplay(\'"+foreign.value+"\',"+i+");"').replace('var trigger=', 'var foreign=document.getElementById("foreign");var trigger=')],
  ["constant option sentinel",text=>text.replace('"controlDisplay(this.value,"+i+")"','"__xformDispatch(this.value,document.getElementsByName(this.name));controlDisplay(\'__PROVEN_OPTION__\',"+i+");"')],
  ["foreign receiver lookup",text=>text.replace('fd_detail."+i+".fd_choice','fd_detail."+i+".fd_notes')],
  ["shadowed loop parameter",text=>text.replace('function wireRows()', 'function wireRows(i)')],
  ["nested closure counter write",text=>text.replace('function wireRows(){', 'function wireRows(){function mutate(){i="bad";}')]
]) it("rejects unproved inline binding: "+name,()=>{
  const raw=cleanSourceFile(fixture);raw.scripts.sources[0].javascript=transform(raw.scripts.sources[0].javascript);
  assert.throws(()=>buildSupportedDetailStateDecision(raw,draftSourceDraft(raw)));
});
it("accepts static radio option interpolation with its own numeric row binding",()=>{
  const raw=cleanSourceFile(fixture);
  raw.scripts.sources[0].javascript=raw.scripts.sources[0].javascript.replace('"controlDisplay(this.value,"+i+")"',
    '"__xformDispatch(this.value,document.getElementsByName(this.name));controlDisplay(\'"+trigger.value+"\',"+i+");"');
  assert.ok(input(raw).decision);
});
for (const [name,handler] of [
  ['row interpolation hidden in comment','"controlDisplay(this.value,__PROVEN_ROW__);/*"+i+"*/"'],
  ['option interpolation hidden in comment','"__xformDispatch(this.value,document.getElementsByName(this.name));controlDisplay(\'__PROVEN_OPTION__\',"+i+");/*"+trigger.value+"*/"']
]) it('rejects placeholder collision: '+name,()=>{
  const raw=cleanSourceFile(fixture);
  raw.scripts.sources[0].javascript=raw.scripts.sources[0].javascript.replace('"controlDisplay(this.value,"+i+")"',handler)+'\nvar __PROVEN_ROW__=0;';
  assert.throws(()=>buildSupportedDetailStateDecision(raw,draftSourceDraft(raw)));
});
