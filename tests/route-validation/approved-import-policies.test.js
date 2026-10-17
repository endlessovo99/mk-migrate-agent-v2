import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { parse } from "acorn";
import { canonicalJson } from "../../src/agent-review/digest.js";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { applyApprovedImportPolicies, validateApprovedImportDecisions, approvedImportSourceJavascriptDigest } from "../../src/translator/approved-import-policies.js";
import { attachMigrationPolicies, migrationPolicySourceDigest } from "../../src/translator/approved-migration-policies.js";
import { executeDsl } from "../../src/executor/execute.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";
const file = "tests/fixtures/route-validation/approved-import-policies/route-approved-import_SysFormTemplate.xml";
const sha = text => "sha256:" + createHash("sha256").update(text).digest("hex");
function input() {
  const source = cleanSourceFile(file), draft = draftSourceDraft(source), action = draft.scripts.actions.find(action => action.semanticHints?.legacyExcelImport);
  const original = source.scripts.sources.find(script => action.sourceRefs.includes(script.sourceRef));
  const row = draft.scripts.actions.find(action => action.controlId === "spbm");
  const rowSource = source.scripts.sources.find(script => row.sourceRefs.includes(script.sourceRef));
  const program = parse(rowSource.javascript, { ecmaVersion: "latest" }), ranges = [];
  const walk = node => { if (!node || typeof node !== "object") return; if (node.type === "ExpressionStatement" && node.expression.callee?.name === "SetXFormFieldValueById") ranges.push({ start: node.start, end: node.end, sha256: sha(rowSource.javascript.slice(node.start, node.end)) }); for (const [key, value] of Object.entries(node)) if (!["start", "end", "raw"].includes(key)) Array.isArray(value) ? value.forEach(walk) : walk(value); };
  walk(program);
  const decision = { id: "approval-native-template", kind: "native-detail-import-replace", tableId: "detailList", sourceActionId: action.id,
    sourceRef: original.sourceRef, sourceDeclarationSha256: approvedImportSourceJavascriptDigest(original), newTemplateOnly: true, legacyFiles: "reject", mode: "replace",
    retireUnboundMainWrites: [{ fieldId: "fd_retired_state", sourceActionId: row.id, callRanges: ranges }] };
  return { source, draft, action, row, rowSource, decision };
}

it("strictly validates import decisions and treats actor approval as no invented native capability", () => {
  const { decision } = input(); assert.equal(validateApprovedImportDecisions([decision]).ok, true);
  for (const changed of [{ ...decision, mode: "add" }, { ...decision, newTemplateOnly: false }, { ...decision, legacyFiles: "auto-convert" },
    { ...decision, additional: true }, { ...decision, sourceDeclarationSha256: "wrong" }]) assert.equal(validateApprovedImportDecisions([changed]).ok, false);
});

it("keeps original files and SourceDraft immutable, leaves import pending, and retires only approved literal auxiliary writes", () => {
  const { source, draft, action, row, decision } = input(), beforeSource = JSON.stringify(source), beforeDraft = JSON.stringify(draft), beforeFile = fs.readFileSync(file);
  const untouched = applyApprovedImportPolicies(source, draft, []); assert.deepEqual(untouched.draft, draft); assert.deepEqual(untouched.changedActionIds, []);
  const result = applyApprovedImportPolicies(source, draft, [decision]);
  assert.equal(JSON.stringify(source), beforeSource); assert.equal(JSON.stringify(draft), beforeDraft); assert.deepEqual(fs.readFileSync(file), beforeFile);
  assert.deepEqual(result.changedActionIds, [row.id]);
  assert.equal(result.draft.scripts.actions.find(item => item.id === action.id).translationStatus, "needs_review");
  assert.equal(result.audits[0].diagnostics.some(item => item.code === "migration.policy.import.native_replace_unproven"), true);
  assert.equal(result.audits[0].originalColumnSlots.length, 17);
  assert.equal(result.audits[0].proposedNativeTemplateFieldIds.filter(id => id === "slvno").length, 1);
  assert.equal(result.audits[0].actions[0].coveredRanges.length, 1);
  const changed = result.draft.scripts.actions.find(item => item.id === row.id);
  assert.equal(changed.sourceActionKey, row.sourceActionKey); assert.equal(changed.event, "onChange");
  assert.equal(result.draft.scripts.actions.some(item => item.event === "onLoad" && item.id !== action.id), false);
  assert.equal(changed.function.includes("fd_retired_state"), false); assert.match(changed.function, /value == 3050100000000000000/);
});

it("keeps the retained Number comparisons and ordered row effects for adjacent rounded source values", () => {
  const { source, draft, row, rowSource, decision } = input(), result = applyApprovedImportPolicies(source, draft, [decision]);
  const action = result.draft.scripts.actions.find(item => item.id === row.id);
  for (const value of ["", undefined, "3050100000000000000", "3050100000000000001", "3040502019900000000", "other"]) {
    const original = [], target = [], callbacks = [];
    vm.runInNewContext(rowSource.javascript, { AttachXFormValueChangeEventById(_id, fn) { callbacks.push(fn); }, SetXFormFieldValueById() {},
      common_dom_row_set_show_required_reset(id, visible, required) { original.push([id, visible ? 5 : 4], [id, required ? 3 : 6]); } });
    callbacks[0](value, {});
    vm.runInNewContext(action.function + ";onChange(input,0);", { input: value, MKXFORM: { setFieldAttr(id, attr) { target.push([id, attr]); }, setValue() { assert.fail("Retired state cannot be stored."); } } });
    assert.deepEqual(target, original);
  }
});

it("retirement ranges survive JSONB key reordering without changing source behavior or exact range coverage",()=>{
  const {source,draft,row,decision}=input();
  const normalized=JSON.parse(canonicalJson(decision));
  const result=applyApprovedImportPolicies(JSON.parse(canonicalJson(source)),JSON.parse(canonicalJson(draft)),[normalized]);
  assert.deepEqual(result.changedActionIds,[row.id]);
  assert.equal(result.draft.scripts.actions.find(action=>action.id===row.id).translationStatus,"mapped");
});

it("refuses stale/incomplete call ranges and retirement of any existing source binding", () => {
  const { source, draft, decision } = input();
  for (const changed of [
    { ...decision, sourceDeclarationSha256: "sha256:" + "0".repeat(64) },
    { ...decision, retireUnboundMainWrites: [{ ...decision.retireUnboundMainWrites[0], fieldId: "spbm" }] },
    { ...decision, retireUnboundMainWrites: [{ ...decision.retireUnboundMainWrites[0], callRanges: decision.retireUnboundMainWrites[0].callRanges.slice(0, 1) }] }
  ]) assert.deepEqual(applyApprovedImportPolicies(source, draft, [changed]).changedActionIds, []);
});

it("the public policy route remains blocked before fake target calls while native forced replacement is unproved", async () => withNetworkGuard(async () => {
  const { source, decision } = input();
  for (const withPolicy of [false, true]) {
    const selected = withPolicy ? attachMigrationPolicies(source, { version: 1, sourceDraftSha256: migrationPolicySourceDigest(source),
      scope: { baseUrl: "https://qas.example.invalid", targetCategoryId: "route-category-id" }, authorization: { actor: "fixture-approved-user", evidenceSha256: "sha256:" + "1".repeat(64) }, decisions: [decision] }) : source;
    const draft = draftSourceDraft(selected); const client = new FakeNewoaAdapter("persist");
    const result = await executeDsl(draft, { client, confirmWrite: true, targetCategoryId: "route-category-id", credentials: { username: "fixture", encryptedPassword: "fixture-password" } });
    assert.equal(result.ok, false); assert.deepEqual(client.transcript(), []);
  }
}));
