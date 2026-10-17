import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/agent-review/digest.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { applyApprovedRuntimePolicies, validateApprovedRuntimePolicyDecisions } from "../../src/translator/approved-runtime-policies.js";
import { attachMigrationPolicies, migrationPolicySourceDigest } from "../../src/translator/approved-migration-policies.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { checkTrust } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { executeDsl } from "../../src/executor/execute.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { withNetworkGuard } from "./network-guard.js";

const directory = "tests/fixtures/route-validation/approved-runtime-policies/";
const digest = value => "sha256:" + createHash("sha256").update(value).digest("hex");
const scope = { baseUrl: "https://p-sit.onewo.com", targetCategoryId: "route-category-id" };
function stages(name) { const source = cleanSourceFile(directory + "route-approved-" + name + "_SysFormTemplate.xml"); return { source, draft: draftSourceDraft(source) }; }
function decisionFor(name, source, draft) {
  const script = source.scripts.sources[0];
  return name === "ordinary" ? { kind: "shared-json-ordinary-runtime", initializerSourceRef: script.sourceRef, sourceJavascriptSha256: digest(script.javascript),
    actionIds: draft.scripts.actions.filter(action => action.event === "onLoad" && action.translationStatus === "needs_review").map(action => action.id) }
    : { kind: "detail-card-number-advice-column", sourceRef: script.sourceRef, sourceJavascriptSha256: digest(script.javascript), actionId: draft.scripts.actions.find(action => action.event === "onChange").id };
}
function approved(name) {
  const { source, draft } = stages(name), decision = decisionFor(name, source, draft);
  const policy = { version: 1, sourceDraftSha256: migrationPolicySourceDigest(source), scope, authorization: { actor: "fixture-human", evidenceSha256: digest("explicit fixture approval") }, decisions: [decision] };
  const authorized = attachMigrationPolicies(source, policy, scope);
  return { original: source, source: authorized, decision, draft: draftSourceDraft(authorized) };
}

it("requires exact typed decisions, source hashes and nonoverlapping action scopes", () => {
  const { source, draft } = stages("advice"), decision = decisionFor("advice", source, draft);
  assert.equal(validateApprovedRuntimePolicyDecisions([decision]).ok, true);
  for (const decisions of [null, [{ ...decision, threshold: 19 }], [{ ...decision, kind: "unknown" }], [{ ...decision, sourceJavascriptSha256: "0".repeat(64) }], [decision, decision]]) {
    assert.equal(validateApprovedRuntimePolicyDecisions(decisions).ok, false);
    assert.throws(() => applyApprovedRuntimePolicies(source, draft, decisions));
  }
});

for (const name of ["ordinary", "advice"]) it("keeps the original " + name + " route blocked without an approval policy", async () => {
  await withNetworkGuard(async () => {
    const { source, draft } = stages(name), original = structuredClone(draft), result = applyApprovedRuntimePolicies(source, draft, []);
    assert.deepEqual(result.draft, original); assert.deepEqual(result.audits, []); assert.deepEqual(result.changedActionIds, []);
    const reviewed = await runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") }); assert.equal(reviewed.ok, false);
    const client = new FakeNewoaAdapter("persist"), execution = await executeDsl(draft, { ...scope, client, confirmWrite: true, credentials: { username: "fixture", encryptedPassword: "fixture-password" } });
    assert.equal(execution.ok, false); assert.deepEqual(client.transcript(), []);
  });
});

it("applies only the approved optional/template and mismatched-option omissions while preserving state/Number and exported options", () => {
  const { source, draft } = stages("ordinary"), before = structuredClone(source), decision = decisionFor("ordinary", source, draft), result = applyApprovedRuntimePolicies(source, draft, [decision]);
  assert.deepEqual(source, before); assert.equal(result.changedActionIds.length, 2);
  assert.deepEqual(result.draft.form, draft.form);
  const edits = result.audits.find(audit => audit.omitted.length === 3); assert.ok(edits);
  assert.deepEqual(edits.omitted.slice(1).map(item => item.optionValue), ["4", "5"]);
  for (const id of result.changedActionIds) {
    const action = result.draft.scripts.actions.find(action => action.id === id);
    assert.equal(action.translationStatus, "mapped"); assert.match(action.function, /JSON\.parse/); assert.match(action.function, /Number\(/);
    assert.match(action.function, /index < 3|index<3/); assert.doesNotMatch(action.function, /optionalModule|waitForRows|\.remove\(/);
  }
  for (const json of ["{}", '{"item0_flag":"1"}', "null", "not-json", '{"item0_flag":{"valueOf":0,"toString":0}}']) {
    const fn = result.draft.scripts.actions.find(action => action.id === result.changedActionIds[0]).function;
    let error; try { new Function("MKXFORM", "return (" + fn + ")")({ MKXFORM_DATA_CONTAINER: {}, getValue: () => json })(); } catch (caught) { error = caught.name; }
    assert.equal(error, json === "not-json" ? "SyntaxError" : json === "null" || json.includes('"valueOf"') ? "TypeError" : undefined);
  }
});

it("retains approved ordinary source witnesses through a JSONB source and trusted DSL roundtrip", async () => {
  await withNetworkGuard(async () => {
    const { source, draft } = approved("ordinary"), sourceBefore = canonicalJson(source);
    const reviewed = await runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed.report?.diagnostics));
    const persistedSource = jsonbRoundtrip(source), persistedDsl = jsonbRoundtrip(reviewed.dsl);
    assert.equal(canonicalJson(persistedSource), sourceBefore);
    assert.equal(migrationPolicySourceDigest(persistedSource), migrationPolicySourceDigest(source));
    assert.equal(canonicalJson(draftSourceDraft(persistedSource)), canonicalJson(draft));
    const checked = checkTrust(persistedSource, persistedDsl);
    assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
    assert.equal(buildDryRunPlan(persistedDsl).ok, true);
    assert.equal(canonicalJson(source), sourceBefore);
  });
});

it("rejects witness values, reference index, script order and authored-source tampering after JSONB roundtrip", () => {
  const { source, draft } = stages("ordinary"), decision = decisionFor("ordinary", source, draft), persisted = jsonbRoundtrip(source);
  const facts = value => value.scripts.sources.find(source => source.semanticFacts?.approvedRuntimePolicies).semanticFacts.approvedRuntimePolicies;
  assert.deepEqual(applyApprovedRuntimePolicies(persisted, jsonbRoundtrip(draft), [jsonbRoundtrip(decision)]).changedActionIds, decision.actionIds);
  for (const mutate of [
    changed => { facts(changed).templateRows[0].referenceRowSha256 = "0".repeat(64); },
    changed => {
      const witness = facts(changed); witness.templateRows[0].referenceRowIndex = 0;
      const { digest: _oldDigest, ...body } = witness;
      witness.digest = createHash("sha256").update(canonicalJson(body)).digest("hex");
    },
    changed => { facts(changed).scripts.reverse(); },
    changed => { changed.scripts.sources[0].javascript += "\n// source changed"; }
  ]) {
    const changed = structuredClone(persisted); mutate(changed);
    assert.throws(() => applyApprovedRuntimePolicies(changed, jsonbRoundtrip(draft), [decision]), /witness|source.*hash/);
  }
});

it("adds one stable readonly nonrequired persisted advice column immediately after the source number", () => {
  const { source, draft } = stages("advice"), original = structuredClone(source), decision = decisionFor("advice", source, draft), result = applyApprovedRuntimePolicies(source, draft, [decision]);
  assert.deepEqual(source, original); assert.equal(result.changedActionIds.length, 1);
  const audit = result.audits[0], table = result.draft.form.fields.find(field => field.id === audit.addedField.tableId), index = table.columns.findIndex(field => field.id === audit.addedField.fieldId);
  assert.equal(table.columns[index - 1].id, "fd_number");
  assert.deepEqual(table.columns[index].props, { readOnly: true, required: false, defaultValue: { kind: "literal", value: "" } });
  assert.equal(table.columns[index].sourceProps.designerValues.width, "260"); assert.ok(table.columns[index].reason);
  assert.equal(table.columns[index].title, "卡号检查"); assert.equal(audit.addedField.derivedValuePersistence, true);
  const twice = applyApprovedRuntimePolicies(source, result.draft, [decision]); assert.deepEqual(twice.draft, result.draft);
  assert.equal(twice.draft.form.fields.find(field => field.id === table.id).columns.length, 3);
});

it("executes the actual native updateRow body for only the current row and keeps source normalization/empty/length behavior", () => {
  const { source, draft } = stages("advice"), decision = decisionFor("advice", source, draft), result = applyApprovedRuntimePolicies(source, draft, [decision]);
  const action = result.draft.scripts.actions.find(action => action.id === decision.actionId), hint = result.audits[0].addedField.fieldId;
  for (const input of ["", undefined, null, "abc", "000123", "12-34 56", "１２３", "1".repeat(15), "1".repeat(16), "1".repeat(19), "1".repeat(20), 0, 123]) {
    const rows = [{ fd_number: "left", fd_other: "unchanged-left", [hint]: "left-hint" }, { fd_number: "old", fd_other: "unchanged-right", [hint]: "previous-hint" }], before = structuredClone(rows), calls = [];
    const api = nativeRowRuntime(rows, calls), callback = new Function("MKXFORM", "return (" + action.function + ");")(api);
    let error; try { callback(input, 1); } catch (caught) { error = caught.name; }
    assert.deepEqual(rows[0], before[0]); assert.equal(rows[1].fd_other, "unchanged-right");
    if (!input) { assert.deepEqual(rows, before); assert.deepEqual(calls, []); assert.equal(error, undefined); }
    else if (typeof input !== "string") { assert.equal(error, "TypeError"); assert.deepEqual(rows, before); assert.deepEqual(calls, []); }
    else { const cleaned = input.replace(/\D/g, ""); assert.equal(rows[1].fd_number, cleaned); assert.equal(rows[1][hint], cleaned.length < 16 ? "卡号长度为16-19位，请注意检查!" : ""); assert.deepEqual(calls, ["getCurrentValues", "updateValues"]); }
  }
});

it("matches the retained source callback's value and visible advice across repeated row edits", () => {
  const { source, draft } = stages("advice"), result = applyApprovedRuntimePolicies(source, draft, [decisionFor("advice", source, draft)]), audit = result.audits[0];
  const rows = [{ fd_number: "", fd_other: "untouched", [audit.addedField.fieldId]: "" }], api = nativeRowRuntime(rows, []);
  const target = new Function("MKXFORM", "return (" + result.draft.scripts.actions.find(a => a.id === audit.actionId).function + ");")(api);
  const input = { value: "" }, parent = { children: [] }; parent.children = [input, {}]; let listener;
  const jq = element => ({ length: element ? 1 : 0, 0: element,
    next() { return jq(parent.children[parent.children.indexOf(element) + 1]); },
    parent() { return { append(node) { parent.children.push(node); } }; },
    show() { element.visible = true; }, hide() { element.visible = false; } });
  new Function("AttachXFormValueChangeEventById", "$", "document", source.scripts.sources[0].javascript)(
    (_id, callback) => { listener = callback; }, jq, { createElement() { return { visible: false, textContent: "", setAttribute() {} }; } }
  );
  for (const value of ["abc", "", "123 456", "1".repeat(16), "", "1".repeat(20), "000123"]) {
    input.value = value; rows[0].fd_number = value;
    listener(value, input); target(value, 0);
    const advice = parent.children[2];
    assert.equal(rows[0].fd_number, input.value);
    assert.equal(rows[0][audit.addedField.fieldId], advice?.visible ? advice.textContent : "");
    assert.equal(rows[0].fd_other, "untouched");
  }
});

it("executes the unchanged native input onChange runner with ordinary detail row identity", () => {
  const contract = JSON.parse(fs.readFileSync(directory + "native-input-detail-change.json", "utf8"));
  for (const row of [0, 1]) {
    const calls = [], actions = { onChange: [{ name: "policyAction" }] };
    const handler = new Function("J", "D", "_", "r", "u", "C", "P", "M", "U", "return (" + contract.text + ");")(
      () => {}, value => calls.push(["model", value]), actions, { actionFunsRunner: (...args) => calls.push(["action", ...args]) }, "native-input", "fd_payments", "detail", row, undefined
    );
    handler({ target: { value: "12-34" } });
    assert.deepEqual(calls, [["model", "12-34"], ["action", { id: "native-input", tableName: "fd_payments", tableType: "detail" }, actions, "onChange", "12-34", row, undefined]]);
  }
});

for (const [name, mutate] of [
  ["advice over-19 behavior", s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replace(".length<16", ".length<19"); }],
  ["advice unknown sibling effect", s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replace("var showAdvice=false", "unknownEffect();var showAdvice=false"); }],
  ["advice helper redefinition", s => { s.scripts.sources[0].javascript += "\nfunction lengthAdvice(a,b,c){unknown(a,b,c);}"; }],
  ["advice helper reassignment", s => { s.scripts.sources[0].javascript += "\nlengthAdvice=otherHandler;"; }],
  ["advice helper global replacement", s => { s.scripts.sources[0].javascript += '\nwindow["lengthAdvice"]=otherHandler;'; }],
  ["advice DOM global shadow", s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replaceAll("element", "document"); }],
  ["advice callee parameter shadow", s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replaceAll("input", "lengthAdvice"); }]
]) it("rejects nonmatching approved source profile: " + name, () => {
  const { source, draft } = stages("advice"), changed = structuredClone(source); mutate(changed);
  const decision = decisionFor("advice", changed, draft); assert.throws(() => applyApprovedRuntimePolicies(changed, draft, [decision]), /profile|source callback/);
});

for (const [name, mutate] of [
  ["optional row index changed", s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replace(".eq(1)", ".eq(2)"); }],
  ["optional flag authored in input", s => { s.scripts.sources[0].javascript = "var optionalModule=true;" + s.scripts.sources[0].javascript; }],
  ["optional branch unknown effect", s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replace("var enabled=true", "unknownEffect();var enabled=true"); }]
]) it("rejects nonmatching ordinary profile: " + name, () => {
  const { source, draft } = stages("ordinary"), changed = structuredClone(source); mutate(changed);
  const decision = decisionFor("ordinary", changed, draft); assert.throws(() => applyApprovedRuntimePolicies(changed, draft, [decision]));
});

it("rejects source-hash drift, witness tampering, main/detail ambiguity and existing generated-column conflicts", () => {
  for (const name of ["ordinary", "advice"]) {
    const { source, draft } = stages(name), decision = decisionFor(name, source, draft);
    assert.throws(() => applyApprovedRuntimePolicies(source, draft, [{ ...decision, sourceJavascriptSha256: "sha256:" + "0".repeat(64) }]));
  }
  const ordinary = stages("ordinary"), ordinaryDecision = decisionFor("ordinary", ordinary.source, ordinary.draft);
  ordinary.source.scripts.sources[0].semanticFacts.approvedRuntimePolicies.templateRows[0].referenceRowIndex = 0;
  assert.throws(() => applyApprovedRuntimePolicies(ordinary.source, ordinary.draft, [ordinaryDecision]), /witness/);
  const advice = stages("advice"), adviceDecision = decisionFor("advice", advice.source, advice.draft), applied = applyApprovedRuntimePolicies(advice.source, advice.draft, [adviceDecision]);
  const duplicate = structuredClone(advice.draft); duplicate.form.fields.push({ id: "fd_number", type: "text", componentId: "xform-input" });
  assert.throws(() => applyApprovedRuntimePolicies(advice.source, duplicate, [adviceDecision]), /ordinary detail/);
  const mutated = structuredClone(applied.draft), field = mutated.form.fields.find(field => field.type === "detailTable").columns.find(field => field.sourceProps?.approvedRuntimePolicy);
  field.sourceProps.designerValues.width = "500"; assert.throws(() => applyApprovedRuntimePolicies(advice.source, mutated, [adviceDecision]), /modified field/);
});

for (const name of ["ordinary", "advice"]) it("passes the approved " + name + " public trust/dry-run/fake write/readback/receipt route", async () => {
  await withNetworkGuard(async () => {
    const { source, draft } = approved(name), reviewed = await runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed.report?.diagnostics)); assert.equal(checkTrust(source, reviewed.dsl).ok, true);
    assert.equal(buildDryRunPlan(reviewed.dsl).ok, true);
    const client = new FakeNewoaAdapter("persist"), execution = await executeDsl(reviewed.dsl, { ...scope, client, confirmWrite: true,
      credentials: { username: "fixture", encryptedPassword: "fixture-password" }, now: new Date("2026-10-18T00:00:00.000Z"), transferRecordIdFactory: () => "route0000000000000000000000000000000" });
    assert.equal(execution.ok, true, JSON.stringify(execution.diagnostics)); assert.equal(execution.readback.ok, true);
    assert.equal(client.transcript().at(-1).operation, "add-transfer-record");
    if (name === "advice") {
      const audit = reviewed.dsl.migrationPolicyAudit.audits.find(audit => audit.kind === "detail-card-number-advice-column"), config = JSON.parse(client.template.mechanisms["sys-xform"].fdConfig);
      const table = config.dataModel.find(model => model.dynamicProps?.detailFieldName === audit.addedField.tableId), hint = table.fdFields.find(field => field.fdName === audit.addedField.fieldId);
      const hintProps = JSON.parse(hint.fdAttribute).config.controlProps, tableProps = JSON.parse(table.fdAttribute).config.controlProps;
      assert.equal(hintProps.showStatus, "readOnly"); assert.notEqual(hintProps.required, true);
      assert.equal(tableProps.columnWidth[hintProps.id], 260);
      assert.equal(table.fdFields.filter(field => field.fdName === audit.addedField.fieldId).length, 1);
    }
    for (const mutate of [
      d => { d.scripts.actions.find(a => d.migrationPolicyAudit.changedActionIds.includes(a.id)).function += "\nunknown();"; },
      d => { d.migrationPolicies.decisions[0].sourceJavascriptSha256 = "sha256:" + "0".repeat(64); },
      d => { const field = d.form.fields.find(f => f.type === "detailTable"); if (name === "advice") field.columns.find(c => c.sourceProps?.approvedRuntimePolicy).props.readOnly = false; else field.columns[0].props.options.pop(); }
    ]) {
      const changed = structuredClone(reviewed.dsl); mutate(changed); assert.equal(checkTrust(source, changed).ok, false);
      const blockedClient = new FakeNewoaAdapter("persist"), blocked = await executeDsl(changed, { ...scope, client: blockedClient, confirmWrite: true, credentials: { username: "fixture", encryptedPassword: "fixture-password" } });
      assert.equal(blocked.ok, false); assert.deepEqual(blockedClient.transcript(), []);
    }
    const wrongClient = new FakeNewoaAdapter("persist"), wrong = await executeDsl(reviewed.dsl, { ...scope, baseUrl: "https://other.example.invalid", client: wrongClient, confirmWrite: true, credentials: { username: "fixture", encryptedPassword: "fixture-password" } });
    assert.equal(wrong.ok, false); assert.deepEqual(wrongClient.transcript(), []);
  });
});

function nativeRowRuntime(rows, calls) {
  const contract = JSON.parse(fs.readFileSync(directory + "native-update-row.json", "utf8")), detail = { getCurrentValues() { calls.push("getCurrentValues"); return rows; }, updateValues(next) { calls.push("updateValues"); rows.splice(0, rows.length, ...next); } };
  const body = new Function("r", "o", "u", "return (" + contract.text + ");")({ getKeyByName: id => id }, { $$detailForms: () => ({ fd_payments: { current: detail } }) }, (array, length) => array.slice(0, length ?? array.length));
  const api = { updateRow(id, row, value) { return body(id, row, value, api); } }; return api;
}

function jsonbRoundtrip(value) {
  // PostgreSQL JSONB object order: UTF-8 key length, then byte-wise lexical.
  function order(value) {
    if (Array.isArray(value)) return value.map(order);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value)
      .sort((left, right) => Buffer.byteLength(left) - Buffer.byteLength(right) || Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(key => [key, order(value[key])]));
  }
  return JSON.parse(JSON.stringify(order(value)));
}
