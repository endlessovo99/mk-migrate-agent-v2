import assert from "node:assert/strict";
import { it } from "node:test";
import vm from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { detailMainRowLifecycleCandidates } from "../../src/translator/detail-main-row-lifecycle.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { checkTrust } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { executeDsl } from "../../src/executor/execute.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";

const file = "tests/fixtures/route-validation/detail-main-literal-write/route-detail-main-literal-write_SysFormTemplate.xml";
const stages = () => { const source = cleanSourceFile(file); return { source, draft: draftSourceDraft(source) }; };
const candidate = (script, form, scripts) => detailMainRowLifecycleCandidates(script, form, scripts);

it("keeps Number literal loose comparisons and String storage over ordered source branches", () => {
  const { source, draft } = stages(), script = source.scripts.sources[0];
  assert.equal(draft.form.fields.find(field => field.id === "fd_state").sourceProps.mainStringValueBindingFact.status, "verified");
  const action = candidate(script, draft.form, source.scripts)[0]; assert.ok(action);
  assert.equal(action.tableId, "detailList"); assert.equal(action.controlId, "fd_choice");
  assert.match(action.function, /value == 3050100000000000000/);
  assert.match(action.function, /value == 3040502019900000000/);
  assert.equal(action.function.includes('value == "3050100000000000000"'), false);
  for (const value of [undefined, null, "", "0", 0, "3050100000000000000", "3050100000000000001", 3050100000000000000,
    "3040502019900000000", "3040502019900000001", "unmatched"]) {
    assert.deepEqual(observe(script.javascript, value, false), observe(action.function, value, true));
  }
  const rounded = { ...script, javascript: script.javascript.replaceAll("3040502019900000000", "9007199254740993") };
  const roundedAction = candidate(rounded, draft.form, source.scripts)[0]; assert.ok(roundedAction);
  const expected = observe(rounded.javascript, "9007199254740993", false);
  assert.equal(expected.find(effect => effect[0] === "value")[2], "9007199254740992");
  assert.deepEqual(observe(roundedAction.function, "9007199254740993", true), expected);
  assert.deepEqual(observe(roundedAction.function, "9007199254740992", true), expected);
});

it("does not qualify absent/duplicated main binding, source aliases, zero conditions, unknown effects or shadowed APIs", () => {
  const { source, draft } = stages(), script = source.scripts.sources[0];
  for (const javascript of [
    script.javascript.replaceAll('"fd_state"', '"missing_state"'),
    script.javascript.replace('value == 3050100000000000000', 'value == 0'),
    script.javascript.replace('value == 3050100000000000000', 'value == ""'),
    script.javascript.replace('value == 3050100000000000000', 'value == "0"'),
    script.javascript.replace('value == 3050100000000000000', 'value == 1e400'),
    script.javascript.replaceAll('"fd_state"', '"d_state"'),
    script.javascript.replace('"fd_choice"', '"d_choice"'),
    script.javascript.replace('function(value, domElement)', 'function(value, SetXFormFieldValueById)'),
    script.javascript.replace('function(value, domElement)', 'function(value, common_dom_row_set_show_required_reset)'),
    script.javascript.replace('if(value ==', 'var alias=value;if(alias =='),
    script.javascript.replace('SetXFormFieldValueById("fd_state",', 'unknownSideEffect();SetXFormFieldValueById("fd_state",')
  ]) assert.deepEqual(candidate({ ...script, javascript }, draft.form, source.scripts), [], javascript);
  for (const change of [
    form => { form.fields = form.fields.filter(field => field.id !== "fd_state"); },
    form => { form.fields.push(structuredClone(form.fields.find(field => field.id === "fd_state"))); },
    form => { form.fields.find(field => field.id === "fd_state").sourceProps.mainStringValueBindingFact.status = "unproven"; },
    form => { form.fields.find(field => field.id === "fd_state").sourceProps.mainStringValueBindingFact.surfaces.display.logicalBindingCount = 2; },
    form => { form.fields.find(field => field.id === "fd_state").type = "number"; },
    form => { form.fields.find(field => field.id === "fd_state").dataOnly = false; },
    form => { form.fields.find(field => field.id === "detailList").columns[0].componentId = "xform-address"; }
  ]) { const form = structuredClone(draft.form); change(form); assert.deepEqual(candidate(script, form, source.scripts), []); }
});

it("passes fixed-source trust, dry-run, fake persistence/readback and rejects a changed comparison", async () => withNetworkGuard(async () => {
  const { source, draft } = stages(); assert.equal(draft.scripts.actions[0].translationStatus, "mapped");
  const reviewed = await runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.diagnostics));
  assert.equal(checkTrust(source, reviewed.dsl).ok, true); assert.equal(buildDryRunPlan(reviewed.dsl).ok, true);
  const client = new FakeNewoaAdapter("persist");
  const result = await executeDsl(reviewed.dsl, { client, confirmWrite: true, targetCategoryId: "route-category-id",
    credentials: { username: "route-user", encryptedPassword: "route-password" }, transferRecordIdFactory: () => "route0000000000000000000000000000000" });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics)); assert.equal(result.readback.ok, true);
  assert.equal(result.transferRecord.status, "recorded");
  const changed = structuredClone(reviewed.dsl); changed.scripts.actions[0].function = changed.scripts.actions[0].function.replace('value == 3050100000000000000', 'value == "3050100000000000000"');
  assert.equal(checkTrust(source, changed).ok, false);
}));

it("retains a missing main setter as pending before any fake request", async () => withNetworkGuard(async () => {
  const { source } = stages(); const script = source.scripts.sources[0];
  script.javascript = script.javascript.replaceAll('"fd_state"', '"fd_missing_state"');
  const draft = draftSourceDraft(source); assert.equal(draft.scripts.actions.some(action => action.translationStatus === "needs_review"), true);
  const client = new FakeNewoaAdapter("persist"); const result = await executeDsl(draft, { client, confirmWrite: true, targetCategoryId: "route-category-id",
    credentials: { username: "route-user", encryptedPassword: "route-password" } });
  assert.equal(result.ok, false); assert.deepEqual(client.transcript(), []);
}));

function observe(javascript, value, target) {
  const effects = [], callbacks = [];
  const write = (id, value) => effects.push(["value", id, String(value)]);
  const scope = { AttachXFormValueChangeEventById(_id, fn) { callbacks.push(fn); }, SetXFormFieldValueById: write,
    common_dom_row_set_show_required_reset(id, show, required, reset) { assert.equal(reset, false); effects.push(["attr", id, show ? 5 : 4], ["attr", id, required ? 3 : 6]); },
    MKXFORM: { setValue(id, value) { effects.push(["value", id, value]); }, setFieldAttr(id, attr) { effects.push(["attr", id, attr]); } } };
  vm.runInNewContext(target ? javascript + ";onChange(input,2);" : javascript, { ...scope, input: value });
  if (!target) for (const fn of callbacks) fn(value, {});
  return effects;
}
