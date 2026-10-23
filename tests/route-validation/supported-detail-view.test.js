import assert from "node:assert/strict";
import {it} from "node:test";
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {cleanSourceFile,draftSourceDraft} from "../../src/translator/index.js";
import {buildSupportedDetailStateDecision,applySupportedDetailStatePolicies,validateSupportedDetailStateDecisions} from "../../src/translator/approved-detail-state-policy.js";
import {attachMigrationPolicies,migrationPolicySourceDigest} from "../../src/translator/approved-migration-policies.js";
import {sha256Digest} from "../../src/agent-review/digest.js";
import {runAgentReview} from "../../src/agent-review/index.js";
import {checkTrust} from "../../src/dsl/trust.js";
import {executeDsl} from "../../src/executor/execute.js";
import {createFakeReviewProvider} from "./fake-review-provider.js";
import {FakeNewoaAdapter} from "./fake-newoa-adapter.js";
import {withNetworkGuard} from "./network-guard.js";

const fixture="tests/fixtures/route-validation/supported-detail-view";
function input(enable=true,raw=cleanSourceFile(fixture)){
 const base=draftSourceDraft(raw);
 const decision=buildSupportedDetailStateDecision(raw,base,{viewInitialization:enable});
 const source=attachMigrationPolicies(raw,{version:1,sourceDraftSha256:migrationPolicySourceDigest(raw),scope:{baseUrl:"https://qas.example.invalid",targetCategoryId:"fixture-category"},authorization:{actor:"synthetic-test-only",evidenceSha256:sha256Digest("Synthetic view initialization test")},decisions:[decision]});
 return {raw,base,decision,source,draft:draftSourceDraft(source)};
}
it("restores only the selected approval detail branch without editing data or required state",()=>{
 const {draft,base}=input(),action=draft.scripts.actions.find(a=>a.event==="onLoad");
 assert.match(action.function,/MKXFORM\.setFieldAttr/);
 assert.deepEqual(draft.form,base.form);assert.deepEqual(draft.workflow,base.workflow);assert.deepEqual(draft.formRules,base.formRules);
 const tables=["fd_detail_row","fd_consumables_row","fd_repair_row","fd_maintenance_row"];
 for(const [i,selected]of ["sb","hc","wx","wb"].entries())for(const budget of ["ysn","ysw"]){
  const visible={},calls=[],data={fd_main:selected,fd_budget:budget};
  const execute=vm.runInNewContext("("+action.function+")",{MKXFORM:{viewStatus:"view",getValue:id=>data[id],setFieldAttr:(id,op)=>{calls.push([id,op]);visible[id]=op===5;}}});
  execute();assert.deepEqual(tables.filter(id=>visible[id]),[tables[i]]);
  assert.equal(visible.fd_budget_row,budget==="ysn");assert.equal(visible.fd_over_budget_row,budget==="ysw");
  assert.equal(visible.fd_service_row,selected==="wb");assert.ok(calls.every(([,op])=>[4,5].includes(op)));
 }
});
it("keeps historical omission-only decisions and default guards unchanged",()=>{
 const old=input(false),enabled=input();
 assert.equal(old.decision.viewInitialization,undefined);
 assert.equal(old.draft.scripts.actions.find(a=>a.event==="onLoad").function.includes("setFieldAttr"),false);
 const action=enabled.draft.scripts.actions.find(a=>a.event==="onLoad");
 assert.deepEqual(action.runWhen,{viewStatusIn:["view"]});
 for(const status of ["add","edit","print","unknown"]){
  vm.runInNewContext("("+action.function+")",{MKXFORM:new Proxy({viewStatus:status},{get(object,key){if(key==="viewStatus")return status;throw Error("View initialization must not run in other modes");}})})();
 }
 for(const value of ["",null,undefined,"unknown",[]]){
  const visible={};vm.runInNewContext("("+action.function+")",{MKXFORM:{viewStatus:"view",getValue:()=>value,setFieldAttr:(id,op)=>visible[id]=op===5}})();
  assert.ok(Object.values(visible).every(shown=>!shown));
 }
 const visible={};vm.runInNewContext("("+action.function+")",{MKXFORM:{viewStatus:"view",getValue:id=>[id==="fd_main"?"hc":"ysw"],setFieldAttr:(id,op)=>visible[id]=op===5}})();
 assert.equal(visible.fd_consumables_row,true);assert.equal(visible.fd_over_budget_row,true);
});
for(const [name,change]of [
 ["selection value changed after read",s=>s.replace('if(selected=="sb")','selected="hc";if(selected=="sb")')],
 ["selection alias redeclared",s=>s.replace('if(selected=="sb")','var selected="hc";if(selected=="sb")')],
 ["wrong checked index",s=>s.replace('selected=cat[i].value','selected=cat[0].value')],
 ["unknown predicate",s=>s.replace('if(selected=="sb")','if(unknown(selected))')],
 ["unbound region",s=>s.replaceAll('"fd_repair_row"','"fd_missing_row"')],
 ["value reset",s=>s.replace('"fd_detail_row",false,false,false','"fd_detail_row",false,false,true')],
 ["conditional runtime expression",s=>s.replace('"fd_detail_row",true,true,false','"fd_detail_row",Boolean(selected),true,false')]
])it("rejects unproved main view slice: "+name,()=>{
 const raw=cleanSourceFile(fixture);raw.scripts.sources[0].javascript=change(raw.scripts.sources[0].javascript);
 assert.throws(()=>buildSupportedDetailStateDecision(raw,draftSourceDraft(raw),{viewInitialization:true}));
});
it("keeps the plan source-bound across renamed fields and markers",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"supported-detail-view-"));
 try{
  for(const file of fs.readdirSync(fixture))fs.writeFileSync(path.join(dir,file),fs.readFileSync(path.join(fixture,file),"utf8").replaceAll("fd_main","fd_category").replaceAll("fd_detail_row","fd_assets_row"));
  const {draft}=input(true,cleanSourceFile(dir)),a=draft.scripts.actions.find(a=>a.event==="onLoad");
  assert.ok(a.function.includes("fd_category"));assert.ok(a.function.includes("fd_assets_row"));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
it("binds every view decision to its complete original plan and action",()=>{
 const {raw,base,decision}=input();
 for(const change of [d=>d.viewInitialization.planSha256="sha256:"+"0".repeat(64),d=>d.viewInitialization.actionId=d.stateActionId,d=>d.viewInitialization.sourceRef+=".other"]){
  const d=structuredClone(decision);change(d);assert.throws(()=>applySupportedDetailStatePolicies(raw,base,[d]));
 }
 assert.equal(validateSupportedDetailStateDecisions([{...decision,viewInitialization:{...decision.viewInitialization,extra:true}}]).ok,false);
});
it("uses saved native values when the approved source also contains checked-attribute ordinal fallback",()=>{
 const raw=cleanSourceFile(fixture);
 raw.scripts.sources[0].javascript=raw.scripts.sources[0].javascript.replace('if(selected=="sb")','var flag1=1;if(selected=="sb" || flag1==1)');
 const {draft}=input(true,raw),action=draft.scripts.actions.find(a=>a.event==="onLoad"),visible={};
 vm.runInNewContext("("+action.function+")",{MKXFORM:{viewStatus:"view",getValue:id=>id==="fd_main"?"hc":"ysn",setFieldAttr:(id,op)=>visible[id]=op===5}})();
 assert.equal(visible.fd_detail_row,false);assert.equal(visible.fd_consumables_row,true);
 const wrong=structuredClone(raw);wrong.scripts.sources[0].javascript=wrong.scripts.sources[0].javascript.replace('flag1==1','flag1==2');
 assert.throws(()=>buildSupportedDetailStateDecision(wrong,draftSourceDraft(wrong),{viewInitialization:true}));
});
it("runs through source review, trust and fake persistence/readback, rejecting view tampering before network",async()=>withNetworkGuard(async()=>{
 const {source,draft,decision}=input();
 const reviewed=await runAgentReview(source,draft,{provider:createFakeReviewProvider("accept")});
 assert.equal(reviewed.ok,true,JSON.stringify(reviewed.report?.diagnostics));assert.equal(checkTrust(source,reviewed.dsl).ok,true);
 const opts={baseUrl:"https://qas.example.invalid",targetCategoryId:"fixture-category",confirmWrite:true,credentials:{username:"fixture",encryptedPassword:"fixture"}};
 const client=new FakeNewoaAdapter("persist"),report=await executeDsl(reviewed.dsl,{...opts,client});
 assert.equal(report.ok,true,JSON.stringify(report.diagnostics));assert.equal(report.readback.ok,true);
 const config=JSON.parse(client.template.mechanisms["sys-xform"].fdConfig),native=JSON.parse(config.attribute.formAttr).controlAction.global.onLoad;
 assert.equal(native.length,1);assert.ok(native[0].function.includes('MKXFORM.viewStatus !== "view"'));
 assert.ok(native[0].function.includes('MKXFORM.setFieldAttr("fd_detail", 4)'));
 for(const mutate of [d=>d.scripts.actions.find(a=>a.id===decision.viewInitialization.actionId).function+='\nMKXFORM.setValue("fd_main", "hc");',d=>d.migrationPolicies.decisions[0].viewInitialization.planSha256="sha256:"+"0".repeat(64),d=>d.scripts.actions.find(a=>a.id===decision.viewInitialization.actionId).runWhen={viewStatusIn:["edit","view"]}]){
  const changed=structuredClone(reviewed.dsl);mutate(changed);assert.equal(checkTrust(source,changed).ok,false);
  const blocked=new FakeNewoaAdapter("persist");assert.equal((await executeDsl(changed,{...opts,client:blocked})).ok,false);assert.deepEqual(blocked.transcript(),[]);
 }
}));
