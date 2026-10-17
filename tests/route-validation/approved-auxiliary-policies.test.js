import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { attachMigrationPolicies, migrationPolicySourceDigest } from "../../src/translator/approved-migration-policies.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { checkTrust } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { executeDsl } from "../../src/executor/execute.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { withNetworkGuard } from "./network-guard.js";

const directory = "tests/fixtures/route-validation/approved-auxiliary-policies/";
const scope = { baseUrl: "https://p-sit.onewo.com", targetCategoryId: "route-category-id" };
const sha = text => "sha256:" + createHash("sha256").update(text).digest("hex");
const options = client => ({ ...scope, client, confirmWrite: true, credentials: { username: "fixture", encryptedPassword: "fixture-password" },
  now: new Date("2026-10-18T00:00:00.000Z"), transferRecordIdFactory: () => "route0000000000000000000000000000000" });
function stages(name) {
  const source = cleanSourceFile(directory + "route-approved-" + name + "_SysFormTemplate.xml");
  return { source, draft: draftSourceDraft(source) };
}
function approve(name) {
  const { source: original, draft: baseline } = stages(name);
  const decisions = original.scripts.sources.map((script, i) => name.startsWith("retirement") ? {
    kind: "retire_missing_auxiliary_bindings", sourceRef: script.sourceRef, sourceJavascriptSha256: sha(script.javascript),
    retiredValueFieldIds: i ? [] : ["fd_retired_flag"], ...(i ? {} : { replacementReadFieldId: "fd_permission" }), retiredRequiredFieldIds: i ? ["fd_retired_note"] : []
  } : { kind: "current_selected_string_reads", sourceRef: script.sourceRef, sourceJavascriptSha256: sha(script.javascript), fieldIds: ["fd_unit", "fd_plan"] });
  const policy = { version: 1, sourceDraftSha256: migrationPolicySourceDigest(original), scope,
    authorization: { actor: "fixture-human", evidenceSha256: sha("Explicit fixture authorization of auxiliary retirement and current selected reads.") }, decisions };
  const source = attachMigrationPolicies(original, policy, scope);
  return { original, baseline, policy, source, draft: draftSourceDraft(source) };
}

for (const name of ["retirement", "retirement-orphan", "selected-reads"]) it("keeps " + name + " unresolved and performs no write without explicit source-bound policy", async () => withNetworkGuard(async () => {
  const { source, draft } = stages(name);
  assert.equal(draft.scripts.actions.some(action => action.translationStatus === "needs_review"), true);
  const reviewed = await runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") }); assert.equal(reviewed.ok, false);
  const client = new FakeNewoaAdapter("persist"), execution = await executeDsl(draft, options(client));
  assert.equal(execution.ok, false); assert.deepEqual(client.transcript(), []);
}));

for (const name of ["retirement", "retirement-orphan", "selected-reads"]) it("passes the approved " + name + " XML/trust/dry-run/fake execute/readback/record route", async () => withNetworkGuard(async () => {
  const { source, draft, original, baseline } = approve(name);
  assert.deepEqual(source.scripts.sources, original.scripts.sources); assert.deepEqual(draft.form, baseline.form);
  assert.deepEqual(draft.scripts.actions.map(action => [action.id, action.sourceActionKey, action.event, action.controlId]), baseline.scripts.actions.map(action => [action.id, action.sourceActionKey, action.event, action.controlId]));
  assert.equal(draft.scripts.actions.every(action => action.translationStatus === "mapped"), true);
  assert.equal(draft.migrationPolicyAudit.changedActionIds.length, name.startsWith("retirement") ? 3 : 1);
  if (name === "retirement-orphan") assert.deepEqual(draft.migrationPolicyAudit.audits[0].orphanRowNormalization.markers.map(marker => marker.rowId), ["orphan_unbound_row"]);
  if (name === "selected-reads") assert.deepEqual(draft.scripts.actions.slice(1), baseline.scripts.actions.slice(1));
  const reviewed = await runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.report?.diagnostics)); assert.equal(checkTrust(source, reviewed.dsl).ok, true);
  assert.equal(buildDryRunPlan(reviewed.dsl).ok, true);
  const client = new FakeNewoaAdapter("persist"), execution = await executeDsl(reviewed.dsl, options(client));
  assert.equal(execution.ok, true, JSON.stringify(execution.diagnostics)); assert.equal(execution.readback.ok, true);
  assert.equal(execution.transferRecord.status, "recorded"); assert.equal(client.transcript().at(-1).operation, "add-transfer-record");
  const changedId = draft.migrationPolicyAudit.changedActionIds[0];
  for (const mutate of [
    value => { value.scripts.actions.find(action => action.id === changedId).function += "\nunknownEffect();"; },
    value => { value.scripts.actions.find(action => action.id === changedId).function = value.scripts.actions.find(action => action.id === changedId).function.replace(/MKXFORM\.getValue/g, "MKXFORM.setValue"); },
    value => { value.migrationPolicies.decisions[0].sourceJavascriptSha256 = "sha256:" + "0".repeat(64); },
    value => { value.migrationPolicies.authorization.evidenceSha256 = "sha256:" + "0".repeat(64); },
    value => { value.migrationPolicyAudit.changedActionIds = []; },
    value => { delete value.migrationPolicies; },
    value => { const field = value.form.fields.find(field => field.id === (name.startsWith("retirement") ? "fd_permission" : "fd_unit")); field.props.options.pop(); }
  ]) { const forged = structuredClone(reviewed.dsl); mutate(forged); assert.equal(checkTrust(source, forged).ok, false); }
  const wrongClient = new FakeNewoaAdapter("persist"), wrong = await executeDsl(reviewed.dsl, { ...options(wrongClient), baseUrl: "https://other.example.invalid" });
  assert.equal(wrong.ok, false); assert.deepEqual(wrongClient.transcript(), []);
}));

it("rejects changed approval source/target/category/actor evidence before drafting", () => {
  const { original, policy } = approve("selected-reads");
  for (const mutate of [
    p => { p.sourceDraftSha256 = "sha256:" + "0".repeat(64); },
    p => { p.scope.baseUrl = "https://other.example.invalid"; },
    p => { p.scope.targetCategoryId = "other-category"; },
    p => { p.authorization.actor = ""; },
    p => { p.authorization.evidenceSha256 = "not-a-digest"; },
    p => { p.decisions[0].fieldIds = []; }
  ]) { const changed = structuredClone(policy); mutate(changed); assert.throws(() => attachMigrationPolicies(original, changed, scope)); }
});
