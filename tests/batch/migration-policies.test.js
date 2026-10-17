import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { it } from "node:test";
import { MemoryBatchStore } from "../../src/batch/store.js";
import { createBatch, cleanSnapshot, sourceSnapshot } from "../../src/batch/intake.js";
import { createRepair, previewRepair, applyRepair } from "../../src/batch/repairs.js";
import { prepareBatch, inspectBatch, approveBatch, executeBatch } from "../../src/batch/service.js";
import { setBatchStatus } from "../../src/batch/scheduler.js";
import { itemBinding } from "../../src/batch/contracts.js";
import { attachMigrationPolicies, migrationPolicySourceDigest, validateMigrationPolicies } from "../../src/translator/approved-migration-policies.js";
import { sha256Digest } from "../../src/agent-review/digest.js";
import { draftSourceDraft } from "../../src/translator/dsl-draft.js";
import { checkTrust } from "../../src/dsl/trust.js";
import { checkExecute } from "../../src/dsl/checks.js";
import { executeDsl } from "../../src/executor/execute.js";
import { createFakeReviewProvider } from "../route-validation/fake-review-provider.js";
import { FakeNewoaAdapter } from "../route-validation/fake-newoa-adapter.js";
import { withNetworkGuard } from "../route-validation/network-guard.js";

const path = resolve("tests/fixtures/route-validation/approved-auxiliary-policies/route-approved-selected-reads_SysFormTemplate.xml");
const scope = { baseUrl: "https://policy-fixture.invalid", targetCategoryId: "policy-category" };
const policyFor = source => ({ version: 1, sourceDraftSha256: migrationPolicySourceDigest(source), scope,
  authorization: { actor: "fixture-human-authorization", evidenceSha256: sha256Digest("explicit current selected reads") },
  decisions: [{ kind: "current_selected_string_reads", sourceRef: source.scripts.sources[0].sourceRef,
    sourceJavascriptSha256: "sha256:" + createHash("sha256").update(source.scripts.sources[0].javascript).digest("hex"), fieldIds: ["fd_unit", "fd_plan"] }] });
const manifest = migrationPolicies => ({ version: 1, name: "approved policy", migrationKey: "approved-policy-fixture", ...scope, executionConcurrency: 1,
  items: [{ sourcePath: path, ...(migrationPolicies ? {migrationPolicies} : {}) }] });
const worker = { engineDigest: "policy-fixture-engine", concurrency: 1, checkpointSigningKey: "fixture-approval-policy-checkpoint-signing-key-32-bytes" };

it("permits unrelated field title review while sealing every other form property", async () => withNetworkGuard(async () => {
  const original = cleanSnapshot(sourceSnapshot(path), ""), source = attachMigrationPolicies(original, policyFor(original), scope);
  const store = new MemoryBatchStore(), batch = await createBatch(store, manifest(policyFor(original)));
  await prepareBatch(store, batch.id, { ...worker, provider: createFakeReviewProvider("accept") });
  const item = (await store.list("item", { batchId: batch.id }))[0], renamed = structuredClone(item.dsl);
  renamed.form.fields[2].title = "Reviewed section title";
  assert.equal(checkExecute(renamed).ok, true, JSON.stringify(checkExecute(renamed).diagnostics));
  assert.equal(checkTrust(source, renamed).ok, true, JSON.stringify(checkTrust(source, renamed).diagnostics));
  for (const mutate of [d => d.form.fields[0].id = "other-field", d => d.form.fields[0].props.required = !d.form.fields[0].props.required,
    d => d.form.fields.reverse()]) {
    const changed = structuredClone(renamed); mutate(changed);
    assert.ok(checkExecute(changed).diagnostics.some(d => d.code === "dsl.migration_policy_binding_mismatch"));
  }
}));

it("limits approved behavior policies to a new draft before login", async () => withNetworkGuard(async () => {
  const source = cleanSnapshot(sourceSnapshot(path), ""), store = new MemoryBatchStore();
  const batch = await createBatch(store, manifest(policyFor(source)));
  await prepareBatch(store, batch.id, { ...worker, provider: createFakeReviewProvider("accept") });
  const item = (await store.list("item", { batchId: batch.id }))[0], client = new FakeNewoaAdapter("persist");
  assert.ok(item.dsl);
  const result = await executeDsl(item.dsl, { ...scope, client, confirmWrite: true, targetTemplateId: "existing-draft-id", credentials: { username: "fixture", encryptedPassword: "fixture" } });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(d => d.code === "execute.migration_policy_new_draft_required"));
  assert.deepEqual(client.transcript(), []);
}));

it("binds policy authority, exact source values and origin/category before intake", async () => {
  const source = cleanSnapshot(sourceSnapshot(path), ""), policy = policyFor(source);
  assert.equal(validateMigrationPolicies(policy, source, scope).ok, true);
  for (const mutate of [p => {p.sourceDraftSha256=sha256Digest("other source");}, p => {p.authorization.evidenceSha256="";},
    p => {p.scope.targetCategoryId="another";}, p => {p.decisions.push(structuredClone(p.decisions[0]));}, p => {p.decisions[0].kind="accept-any-behavior";}]) {
    const changed = structuredClone(policy); mutate(changed);
    assert.equal(validateMigrationPolicies(changed, source, scope).ok, false);
    assert.throws(() => attachMigrationPolicies(source, changed, scope));
  }
  const wrong = structuredClone(policy); wrong.scope.baseUrl="https://other.invalid";
  const store = new MemoryBatchStore(); await assert.rejects(createBatch(store,manifest(wrong)));
  assert.equal((await store.list("batch")).length,0); assert.equal((await store.list("target")).length,0);
});

it("repairs only an unexecuted exact-scope item and invalidates prior DSL, checkpoint and approval", async () => {
  const store = new MemoryBatchStore(), batch = await createBatch(store, manifest());
  const original = (await store.list("item",{batchId:batch.id}))[0], policy = policyFor(original.sourceDraft);
  await store.mutate("item",original.id,item=>({...item,status:"blocked",diagnostics:[{code:"policy-needed"}],checkpoint:{old:true},attempts:[{id:"old-attempt",report:{ok:false}}]}));
  const repair = await createRepair(store,{title:"approved source behavior",rootCause:"source binding differs from authorized target behavior",reason:"Apply the explicitly authorized behavior in the original batch",evidence:["fixture approval"],version:1,selector:{diagnosticCodes:["policy-needed"]},action:{kind:"migration_policies",policies:policy}});
  const preview = await previewRepair(store,repair.id,{batchId:batch.id,itemIds:[original.id]});assert.equal(preview.summary.applicable,1);
  await applyRepair(store,preview.id,{expectedDigest:preview.digest,confirmApply:true,actor:"fixture-operator"});
  const item=await store.get("item",original.id);assert.equal(item.id,original.id);assert.equal(item.identityKey,original.identityKey);assert.equal(item.sourceDigest,original.sourceDigest);
  assert.deepEqual(item.snapshot,original.snapshot);assert.deepEqual(item.migrationPolicies,policy);assert.equal(item.status,"pending");assert.equal(item.checkpoint,null);assert.equal(item.dsl,null);assert.equal(item.attempts[0].id,"old-attempt");assert.equal((await store.get("batch",batch.id)).approval,null);
  const binding=structuredClone(itemBinding(item));item.migrationPolicies.authorization.evidenceSha256=sha256Digest("different decision");assert.notEqual(sha256Digest(binding),sha256Digest(itemBinding(item)));
});

it("registers a changed source-bound policy on a pending item without synthesizing a model or execution failure", async () => withNetworkGuard(async () => {
  const store=new MemoryBatchStore(),batch=await createBatch(store,manifest()),original=(await store.list("item",{batchId:batch.id}))[0],policy=policyFor(original.sourceDraft);
  const definition={title:"new authorized policy",rootCause:"caller approved a target behavior before preparation",reason:"Apply through the normal preview mechanism",evidence:["fixture authority"],version:1,selector:{diagnosticCodes:["BATCH_MIGRATION_POLICY_CHANGED"]},action:{kind:"migration_policies",policies:policy}};
  const repair=await createRepair(store,definition),preview=await previewRepair(store,repair.id,{batchId:batch.id,itemIds:[original.id]});assert.equal(preview.summary.applicable,1);assert.deepEqual(preview.items[0].before.diagnostics,[]);assert.equal(preview.items[0].before.attempts.length,0);
  await applyRepair(store,preview.id,{expectedDigest:preview.digest,confirmApply:true,actor:"fixture"});
  const item=await store.get("item",original.id);assert.deepEqual(item.attempts,[]);assert.deepEqual(item.diagnostics,[]);assert.equal(item.status,"pending");assert.equal(item.sourceDigest,original.sourceDigest);assert.equal(item.identityKey,original.identityKey);assert.deepEqual(item.migrationPolicies,policy);
  assert.equal((await previewRepair(store,repair.id,{batchId:batch.id,itemIds:[item.id]})).summary.applicable,0);
  const prepared=await prepareBatch(store,batch.id,{...worker,provider:createFakeReviewProvider("accept")});assert.equal(prepared.counts.ready,1);
  for(const change of [{status:"outcome_unknown"},{writeStarted:true},{targetTemplateId:"existing"},{status:"succeeded"},{status:"running"},{attempts:[{report:{remoteWriteAttempted:true}}]},{attempts:[{steps:[{outcome:"pending"}]}]}]){
    const s=new MemoryBatchStore(),b=await createBatch(s,manifest()),i=(await s.list("item",{batchId:b.id}))[0];await s.mutate("item",i.id,v=>({...v,...change}));const r=await createRepair(s,definition);assert.equal((await previewRepair(s,r.id,{batchId:b.id})).summary.applicable,0);
  }
}));

it("keeps unknown/remote-effect items and wrong-category policies outside the repair gate", async () => {
  for(const overrides of [{status:"outcome_unknown"},{writeStarted:true},{targetTemplateId:"existing"},{status:"succeeded"},
    {attempts:[{report:{writeOutcomeUnknown:true}}]}, {attempts:[{report:{remoteWriteAttempted:true}}]},
    {attempts:[{steps:[{outcome:"pending"}]}]}]) {
    const store=new MemoryBatchStore(),batch=await createBatch(store,manifest()),item=(await store.list("item",{batchId:batch.id}))[0];
    await store.mutate("item",item.id,x=>({...x,status:"blocked",diagnostics:[{code:"policy-needed"}],...overrides}));
    const repair=await createRepair(store,{title:"policy",rootCause:"fixture",reason:"fixture scope",version:1,evidence:["fixture"],selector:{diagnosticCodes:["policy-needed"]},action:{kind:"migration_policies",policies:policyFor(item.sourceDraft)}});
    assert.equal((await previewRepair(store,repair.id,{batchId:batch.id})).summary.applicable,0);
  }
  const store=new MemoryBatchStore(),batch=await createBatch(store,manifest()),item=(await store.list("item",{batchId:batch.id}))[0];
  await store.mutate("item",item.id,x=>({...x,status:"blocked",diagnostics:[{code:"policy-needed"}]}));
  const policy=policyFor(item.sourceDraft);policy.scope.targetCategoryId="wrong";
  const repair=await createRepair(store,{title:"policy",rootCause:"fixture",reason:"fixture scope",version:1,evidence:["fixture"],selector:{diagnosticCodes:["policy-needed"]},action:{kind:"migration_policies",policies:policy}});
  assert.equal((await previewRepair(store,repair.id,{batchId:batch.id})).items[0].reason,"migration_policy_invalid");
});

it("passes the public prepared/persisted policy through trust, approval, fake readback and exactly one receipt", async () => withNetworkGuard(async () => {
  const original=cleanSnapshot(sourceSnapshot(path),""),policy=policyFor(original),store=new MemoryBatchStore(),batch=await createBatch(store,manifest(policy));
  const prepared=await prepareBatch(store,batch.id,{...worker,provider:createFakeReviewProvider("accept")});
  assert.equal(prepared.counts.ready,1,JSON.stringify(prepared.items));
  const item=(await store.list("item",{batchId:batch.id}))[0];
  const reorder = v=>Array.isArray(v)?v.map(reorder):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).reverse().map(k=>[k,reorder(v[k])])):v;
  const source=JSON.parse(JSON.stringify(reorder(item.sourceDraft))),dsl=JSON.parse(JSON.stringify(reorder(item.dsl)));
  assert.equal(checkTrust(source,dsl).ok,true);assert.deepEqual(original,cleanSnapshot(item.snapshot,item.templateName));
  const forged=structuredClone(dsl);delete forged.migrationPolicies;assert.equal(checkTrust(source,forged).ok,false);
  const changed=structuredClone(dsl);changed.scripts.actions.find(a=>a.deterministicBranchProof?.basis==="deterministic-approved-migration-policy").function += "\n// tampered";assert.equal(checkTrust(source,changed).ok,false);
  const noPolicy=structuredClone(source);delete noPolicy.migrationPolicies;assert.equal(checkTrust(noPolicy,dsl).ok,false);
  const proposal=await inspectBatch(store,batch.id);await approveBatch(store,batch.id,{expectedDigest:proposal.approvalDigest,confirmWrite:true,actor:"fixture"});
  const client=new FakeNewoaAdapter("persist");const report=await executeBatch(store,batch.id,{...worker,confirmWrite:true,credentials:{username:"fixture",encryptedPassword:"fixture"},clientFactory:()=>client});
  assert.equal(report.counts.succeeded,1,JSON.stringify(report.items));
  const final=await store.get("item",item.id);assert.equal(final.attempts.at(-1).report.readback.ok,true);assert.equal(final.attempts.at(-1).report.transferRecord.status,"recorded");assert.equal(client.transcript().filter(c=>c.operation==="add-transfer-record").length,1);
  await setBatchStatus(store,batch.id,"paused");
}));

it('never resets contradictory historical write uncertainty through policy attachment or reprepare',async()=>withNetworkGuard(async()=>{
 for(const marker of [{templateWriteOutcomeUnknown:true},{transferRecordOutcomeUnknown:true},{transferRecord:{writeOutcomeUnknown:true}},{apiStages:[{name:'updateTemplate',status:'failed',writeOutcomeUnknown:true}]}]){
  for(const kind of ['migration_policies','reprepare']){
   const store=new MemoryBatchStore(),batch=await createBatch(store,manifest()),item=(await store.list('item',{batchId:batch.id}))[0];await store.mutate('item',item.id,v=>({...v,status:'blocked',diagnostics:[{code:'policy-needed'}],attempts:[{report:{writeOutcomeUnknown:false,...marker}}]}));
   const action=kind==='migration_policies'?{kind,policies:policyFor(item.sourceDraft)}:{kind},repair=await createRepair(store,{title:'reject uncertainty',rootCause:'fixture',reason:'fixture',version:1,evidence:['fixture'],selector:{diagnosticCodes:['policy-needed']},action});
   const preview=await previewRepair(store,repair.id,{batchId:batch.id});assert.equal(preview.summary.applicable,0,JSON.stringify({kind,marker}));
  }
 }
}));
