import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { CHOICE_OTHER_STORAGE_CAPABILITY as contract } from "../../src/dsl/choice-other-storage-capability.js";
import { inspectChoiceOtherStorageRuntime } from "../../src/executor/choice-other-storage-capability.js";
import { executeDsl } from "../../src/executor/execute.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";

const fixture=JSON.parse(readFileSync(new URL("../fixtures/route-validation/choice-other-submit-contract/native-contract.json",import.meta.url),"utf8"));

it("binds both runtime releases and exact bundle digests to the recorded QAS evidence", async () => {
  assert.equal(contract.origin,fixture.origin);
  for(const platform of ["desktop","mobile"]){assert.equal(contract.modules[platform].release,fixture[platform].release);assert.equal(contract.modules[platform].sha256,fixture[platform].sha256);}
  assert.deepEqual(await inspectChoiceOtherStorageRuntime(new FakeNewoaAdapter("persist"),contract.origin),{ok:true,issues:[]});
});

for(const [name,mutate,issue] of [
  ["other origin",()=>{},"origin_unverified"],
  ["changed desktop release",client=>{client.getXFormDesktopDigest=async()=>({});},"desktop_release_unverified"],
  ["changed mobile release",client=>{client.getXFormMobileDigest=async()=>({});},"mobile_release_unverified"],
  ["changed bundle",client=>{client.getXFormDesktopModuleSha256=async()=>"0".repeat(64);},"desktop_bundle_unverified"],
  ["missing client API",client=>{client.getXFormMobileDigest=undefined;},"runtime_read_api_missing"]
]) it(`fails closed for ${name}`,async()=>{
  const client=new FakeNewoaAdapter("persist");mutate(client);
  const result=await inspectChoiceOtherStorageRuntime(client,name==="other origin"?"https://other.example":contract.origin);
  assert.equal(result.ok,false);assert.ok(result.issues.includes(issue));
});

it("blocks the migration before template creation when the runtime changed",async()=>{
  const source=cleanSourceFile("tests/fixtures/route-validation/checkbox-other-compatible/compatible_SysFormTemplate.xml"),draft=draftSourceDraft(source);
  const dsl=createTrustedMigrationDsl(source,draft,{externalAgentReviewed:true}),client=new FakeNewoaAdapter("persist");
  client.getXFormMobileDigest=async()=>({});
  const result=await executeDsl(dsl,{client,baseUrl:contract.origin,credentials:{username:"test",encryptedPassword:"test"},confirmWrite:true,targetCategoryId:"category"});
  assert.equal(result.status,"blocked");assert.equal(result.stage,"verifyChoiceOtherStorageRuntime");
  assert.ok(result.diagnostics.some(item=>item.code==="safety.choice_other_storage_runtime_unverified"));
  assert.equal(client.transcript().some(item=>["init","add","update","save-workflow-draft"].includes(item.operation)),false);
});
