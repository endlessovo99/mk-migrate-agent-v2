import assert from "node:assert/strict";
import { it } from "node:test";
import vm from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { formAttr, prepareSample, projectTemplate } from "../helpers/persistence.js";
import { runFixtureRouteCase } from "./run-route-case.js";

const relativePath="script-owned-row-effects/base_SysFormTemplate.xml";
const source=()=>cleanSourceFile("tests/fixtures/route-validation/"+relativePath);
const draft=()=>draftSourceDraft(source());

it("gives a complete source callback one row-effect writer and retains native-only siblings",()=>{
  const d=draft(),action=d.scripts.actions.find(a=>a.controlId==="fd_selector");
  assert.equal(action.translationStatus,"mapped");
  assert.deepEqual(action.coverage.nativeRules,[]);
  assert.match(action.function,/setFieldAttr/);
  assert.deepEqual(d.formRules.linkage.map(r=>r.source),["fd_other"]);
  const native=formAttr(projectTemplate(d)).formRule;
  assert.equal(native.display.length,2);
  assert.equal(native.require.length,2);
  for(const rule of [...native.display,...native.require])assert.equal(rule.meta.sourceRuleId,"linkage.fd_other.contains.Y");
  const sibling=d.scripts.actions.find(a=>a.controlId==="fd_other");
  assert.equal(sibling.translationStatus,"omitted");
  assert.deepEqual(sibling.coverage.nativeRules,["linkage.fd_other.contains.Y"]);
});

it("retains source value clearing, both visibility branches and optional row members",()=>{
  const d=draft(),a=formAttr(projectTemplate(d)).controlAction.control["mk_model_test.fd_selector"].onChange[0];
  const state={},values={fd_shift:""};
  const MKXFORM={viewStatus:"add",getValue:id=>values[id],setValue:(id,v)=>{values[id]=v;},setFieldAttr:(id,attr)=>{
    state[id]||={};if(attr===4||attr===5)state[id].visible=attr===5;if(attr===3||attr===6)state[id].required=attr===3;
  }};
  const fn=vm.runInNewContext("("+a.function+")",{MKXFORM});
  for(const value of ["A",["A"],"B",[],""]){
    fn(value);
    const active=value.indexOf("A")>=0;
    assert.equal(state.fd_value.visible,active);
    assert.equal(state.fd_value.required,active);
    assert.equal(state.fd_optional.visible,active);
    assert.equal(state.fd_optional.required,false);
    assert.equal(values.fd_shift,active?"A":"");
  }
});

it("retains source trust and rejects a missing direct effect",()=>{
  const s=source(),d=draftSourceDraft(s);
  const trusted=createTrustedMigrationDsl(s,d,{externalAgentReviewed:true,reviewerName:"synthetic owned callback review"});
  assert.equal(checkTrust(s,trusted).ok,true);
  const p=prepareSample(d);assert.equal(p.ok,true);assert.equal(p.verify(p.update).ok,true);
  const changed=structuredClone(trusted),a=changed.scripts.actions.find(a=>a.controlId==="fd_selector");
  a.function=a.function.replace('MKXFORM.setFieldAttr("fd_value_row", 5);',"");
  assert.equal(checkTrust(s,changed).ok,false);
});

it("completes review, guarded API execution, readback and transfer with fake clients",async()=>{
  const r=await runFixtureRouteCase({id:"script-owned-row-effects",source:{kind:"form-only",relativePath},reviewScenario:"accept",newoaScenario:"persist",confirmWrite:true,
    expected:{reviewStatus:"passed",dryRunStatus:"passed",executionStatus:"written",operations:["login","get-xform-desktop-digest","get-xform-desktop-module-sha256","get-xform-desktop-module-sha256","init","generate-table-name","load-parent-category","add","get-before-update","update","get-readback","add-transfer-record"]}});
  assert.equal(r.execution.ok,true);assert.equal(r.execution.transferRecord.status,"recorded");
});
