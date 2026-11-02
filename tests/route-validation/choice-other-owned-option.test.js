import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { withChoiceOtherStorageRuntime } from "../../src/dsl/choice-other-storage-runtime.js";
import { CHOICE_OTHER_STORAGE_CAPABILITY } from "../../src/dsl/choice-other-storage-capability.js";
import { runInNewContext } from "node:vm";
import { runRouteCase } from "./run-route-case.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { executeDsl } from "../../src/executor/execute.js";

it("uses the original checkbox group's native Other option", () => {
  const source = cleanSourceFile("tests/fixtures/route-validation/native-checkbox-other/native-checkbox-other_SysFormTemplate.xml");
  const form = draftSourceDraft(source).form;
  const choice = form.fields.find(field => field.id === "fd_choice");
  assert.equal(choice.props.options.filter(option => option.type === "other").length, 1);
  assert.equal(form.fields.some(field => field.sourceProps?.choiceOtherToggle), false);
  assert.equal(form.fields.find(field => field.id === "fd_other_caption").dataOnly, true);
  assert.equal(form.fields.find(field => field.id === "fd_other_text").dataOnly, true);
  assert.deepEqual(choice.props.options.at(-1), { label: "其他", value: "other_", type: "other" });
  const draft = draftSourceDraft(source);
  assert.equal(checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true })).ok, true);
  const prepared = prepareSample(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
  for (const [key, value] of [["fdLength", 199], ["fdType", "number"], ["fdDataType", "number"],
    ["fdDataType", "clob"], ["fdDictType", "other"]]) {
    const changed = structuredClone(prepared.update), config = xformConfig(changed);
    config.dataModel.flatMap(model => model.fdFields || []).find(field => field.fdName === "fd_choice")[key] = value;
    changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    assert.equal(prepared.verify(changed).ok, false, `readback must verify native Other storage ${key}`);
  }
});

it("blocks duplicate ordinary labels before a mobile native Other checkbox can be executed", async () => {
  const source = cleanSourceFile("tests/fixtures/route-validation/native-checkbox-other/native-checkbox-other_SysFormTemplate.xml");
  const choice = source.form.controls.find(field => field.id === "fd_choice");
  choice.options[1].label = choice.options[0].label;
  const draft = draftSourceDraft(source);
  assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "dsl.form.native_other_labels_unverified"));
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  let calls = 0;
  const result = await executeDsl(trusted, { baseUrl: "https://oaqas.shanghai-electric.com", targetCategoryId: "category-id",
    confirmWrite: true, credentials: { username: "test", encryptedPassword: "test" }, client: { baseUrl: "https://oaqas.shanghai-electric.com", login() { calls++; } } });
  assert.equal(result.ok, false); assert.equal(calls, 0);
});

it("writes and reads back the native Other option through the fake route", async () => {
  const result = await runRouteCase("native-checkbox-other-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.readback.partitions.form, "verified");
  assert.equal(result.execution.readback.partitions.scripts, "verified");
});

it("maps a standalone source Other option to MK and verifies it through the fake route", async () => {
  const source = cleanSourceFile("tests/fixtures/route-validation/native-standalone-other/native-standalone-other_SysFormTemplate.xml");
  const draft = draftSourceDraft(source), field = draft.form.fields.find(item => item.id === "fd_plain");
  assert.deepEqual(field.nativeOther, { version: 2, sourceOptionValue: "Q" });
  assert.deepEqual(field.props.options.at(-1), { label: "其他", value: "other_", type: "other" });
  assert.equal(checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true })).ok, true);
  const result = await runRouteCase("native-standalone-other-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.readback.partitions.form, "verified");
});

it("rejects normal option tampering even without a source alignment fact", () => {
  const source = cleanSourceFile("tests/fixtures/route-validation/native-standalone-other/native-standalone-other_SysFormTemplate.xml");
  delete source.form.controls.find(field => field.id === "fd_plain").sourceProps.designerValues.alignment;
  const draft = draftSourceDraft(source), field = draft.form.fields.find(item => item.id === "fd_plain");
  assert.ok(field.nativeOther);
  field.props.options[0].value = "tampered";
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  assert.ok(checkTrust(source, trusted).diagnostics.some(item => item.code === "trust.form.native_other_source_mismatch"));
});

it("rejects removal of a complete standalone native Other choice", () => {
  const source = cleanSourceFile("tests/fixtures/route-validation/native-standalone-other/native-standalone-other_SysFormTemplate.xml");
  delete source.form.controls.find(field => field.id === "fd_plain").sourceProps.designerValues.alignment;
  const draft = draftSourceDraft(source), field = draft.form.fields.find(item => item.id === "fd_plain");
  delete field.nativeOther; field.props.options.pop();
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  assert.ok(checkTrust(source, trusted).diagnostics.some(item => item.code === "trust.form.native_other_source_mismatch"));
});

it("blocks a standalone Other when a workflow still refers to its original code", () => {
  const source = cleanSourceFile("tests/fixtures/route-validation/native-standalone-other/native-standalone-other_SysFormTemplate.xml");
  source.workflow = { version: 1, sourceRef: "source.workflow", nodes: [], edges: [{ id: "E1", condition: 'getField("fd_plain") == "Q"' }] };
  const draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.find(item => item.id === "fd_plain").nativeOther, undefined);
  assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "source.form.native_other_option_unproven"));
  assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "dsl.form.native_other_required"));
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  assert.equal(buildDryRunPlan(trusted).ok, false);
});

it("blocks a standalone Other when dynamic script carriers may reference it", () => {
  for (const carrier of ["designer", "fragment", "action"]) {
    const source = cleanSourceFile("tests/fixtures/route-validation/native-standalone-other/native-standalone-other_SysFormTemplate.xml");
    const script = "GetXFormFieldValueById(String.fromCharCode(102,100,95,112,108,97,105,110))";
    source.scripts ||= {};
    if (carrier === "designer") source.form.controls.find(field => field.id === "fd_plain").sourceProps.designerValues.onchange = script;
    if (carrier === "fragment") source.scripts.fragments = [{ id: "dynamic", sourceRef: "source.dynamic", content: script }];
    if (carrier === "action") source.scripts.actions = [{ id: "dynamic", sourceRef: "source.dynamic", function: script }];
    const draft = draftSourceDraft(source);
    assert.equal(draft.form.fields.find(field => field.id === "fd_plain").nativeOther, undefined, carrier);
    assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "dsl.form.native_other_required"), carrier);
  }
});

it("blocks an invented detail-table native Other even when a marker is supplied", () => {
  const source = cleanSourceFile("tests/fixtures/route-validation/choice-other-companion-fidelity/detail-checkbox_SysFormTemplate.xml");
  const draft = draftSourceDraft(source), table = draft.form.fields.find(field => field.type === "detailTable");
  const choice = table.columns.find(column => column.componentId === "xform-checkbox");
  choice.nativeOther = { version: 2, sourceOptionValue: "invented" };
  assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "dsl.form.native_other_detail_unverified"));
  assert.equal(buildDryRunPlan(createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true })).ok, false);
});

it("rejects a candidate that changes the source-bound Other or reintroduces the text field", () => {
  const source = cleanSourceFile("tests/fixtures/route-validation/native-checkbox-other/native-checkbox-other_SysFormTemplate.xml");
  for (const mutate of [
    draft => { draft.form.fields.find(field => field.id === "fd_choice").props.options.at(-1).type = undefined; },
    draft => { draft.form.fields.find(field => field.id === "fd_choice").nativeOther.textSourceRef = "source.form.control.fd_plain"; },
    draft => { draft.form.fields.find(field => field.id === "fd_other_text").dataOnly = false; }
  ]) {
    const draft = draftSourceDraft(source); mutate(draft);
    assert.equal(checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true })).ok, false);
  }
});

it("blocks folding and all target calls when source workflow still depends on either field", async () => {
  const source = cleanSourceFile("tests/fixtures/route-validation/native-checkbox-other/native-checkbox-other_SysFormTemplate.xml");
  source.workflow = { version: 1, sourceRef: "source.workflow", nodes: [], edges: [], retained: "fd_other_text" };
  const draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.find(field => field.id === "fd_choice").nativeOther, undefined);
  assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "source.form.native_other_checkbox_unproven"));
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  assert.equal(buildDryRunPlan(trusted).ok, false);
  const calls = [];
  const client = new Proxy({}, { get: (_, name) => async () => { calls.push(name); } });
  const result = await executeDsl(trusted, { client, credentials: { username: "fixture", encryptedPassword: "fixture" },
    baseUrl: CHOICE_OTHER_STORAGE_CAPABILITY.origin, targetCategoryId: "category", confirmWrite: true });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
});

it("blocks robot configuration references hidden by JSON Unicode escapes or malformed content", () => {
  for (const content of [String.raw`{"formParams":[{"field":"fd_\u0063hoice"}]}`,
    String.raw`{"formParams":[{"field":"fd_other_\u0074ext"}]}`, '{"formParams":']) {
    const source = cleanSourceFile("tests/fixtures/route-validation/native-checkbox-other/native-checkbox-other_SysFormTemplate.xml");
    source.workflow = { version: 1, sourceRef: "source.workflow", nodes: [{ id: "N1", definition: { attributes: { content } } }], edges: [] };
    const draft = draftSourceDraft(source);
    assert.equal(draft.form.fields.find(field => field.id === "fd_choice").nativeOther, undefined);
    assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "dsl.form.native_other_required"));
  }
});

it("blocks field references assembled dynamically in workflow expressions", () => {
  for (const expression of [
    'getField("fd_"/* comment */+"choice")',
    'record["fd_"+"choice"]',
    'getField(`fd_${"choice"}`)',
    'getField(prefix + suffix)',
    'var g=MKXFORM.getValue;g("fd_"+suffix)',
    'getValueByAlias("fd_"+suffix)'
  ]) {
    const source = cleanSourceFile("tests/fixtures/route-validation/native-checkbox-other/native-checkbox-other_SysFormTemplate.xml");
    source.workflow = { version: 1, sourceRef: "source.workflow", nodes: [], edges: [{ id: "E1", condition: expression }] };
    const draft = draftSourceDraft(source);
    assert.equal(draft.form.fields.find(field => field.id === "fd_choice").nativeOther, undefined, expression);
    assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "dsl.form.native_other_required"), expression);
  }
});

it("does not confuse a proven unrelated native formula with an Other dependency", () => {
  const source = cleanSourceFile("tests/fixtures/route-validation/native-checkbox-other/native-checkbox-other_SysFormTemplate.xml");
  source.workflow = { version: 1, sourceRef: "source.workflow", nodes: [],
    edges: [{ id: "E1", condition: '$unrelated_field$.equals("3")' }] };
  const draft = draftSourceDraft(source);
  assert.ok(draft.form.fields.find(field => field.id === "fd_choice").nativeOther);
});

it("blocks nonempty native Other defaults until clearing persistence is proved", () => {
  const source = cleanSourceFile("tests/fixtures/route-validation/checkbox-other-compatible/compatible_SysFormTemplate.xml");
  const text = source.form.controls.find(field => field.id === "fd_other_text");
  text.required = true;
  const draft = draftSourceDraft(source), choice = draft.form.fields.find(field => field.id === "fd_choice");
  assert.equal(choice.props.defaultValue.value, "other_seed_under_score");
  assert.equal(choice.props.options.at(-1).isRequired, true);
  assert.equal(draft.form.fields.find(field => field.id === "fd_other_text").dataOnly, true);
  assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "dsl.form.native_other_default_unverified"));
  assert.equal(checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true })).ok, false);
  assert.equal(buildDryRunPlan(createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true })).ok, false);
});

it("rejects unverified nonempty native Other defaults in the storage bridge", () => {
  const form = draftSourceDraft(cleanSourceFile("tests/fixtures/route-validation/checkbox-other-compatible/compatible_SysFormTemplate.xml")).form;
  assert.throws(() => withChoiceOtherStorageRuntime({ actions: [] }, form, "mk_model_test"),
    { code: "projection.choice_other.checkbox_storage_unproven" });
});

it("saves and restores native Other with ordinary choices and embedded commas", () => {
  const form = draftSourceDraft(cleanSourceFile("tests/fixtures/route-validation/native-checkbox-other/native-checkbox-other_SysFormTemplate.xml")).form;
  const action = withChoiceOtherStorageRuntime({ actions: [] }, form, "mk_model_test").actions[0];
  const cap = CHOICE_OTHER_STORAGE_CAPABILITY, asset = `${cap.origin}/web/${cap.modules.desktop.path}/index.js?${cap.modules.desktop.release}`;
  const initial = ["other_说明,带_符号", "A"], values = { fd_choice: initial, fd_plain: [] };
  let getter = () => Object.fromEntries(Object.entries(values).map(([key, value]) => [`mk_model_test.${key}`, value]));
  const nativeForm = {};
  Object.defineProperty(nativeForm, "getFieldsValue", { configurable: true, get: () => getter, set: value => { getter = value; } });
  const callbacks = [], sdk = { $$FORM: { current: nativeForm }, MKXFORM_DATA_CONTAINER: {},
    getValue: ref => values[ref.slice("mk_model_test.".length)],
    setValue: (ref, value) => { values[ref.slice("mk_model_test.".length)] = structuredClone(value); },
    beforeSubmit: callback => callbacks.push(callback) };
  function BrowserError() { this.stack = `at Object.getXformValue (${asset}:1:1)`; }
  const initialize = () => runInNewContext(`(${action.function})`, { MKXFORM: sdk, Error: BrowserError,
    location: { origin: cap.origin }, document: { scripts: [{ src: asset }] } })({});
  initialize(); assert.equal(callbacks[0](), true);
  const stored = nativeForm.getFieldsValue()["mk_model_test.fd_choice"];
  assert.equal(stored, "A,other_说明,带_符号");
  values.fd_choice = stored; sdk.MKXFORM_DATA_CONTAINER = {}; initialize();
  assert.deepEqual(values.fd_choice, ["A", "other_说明,带_符号"]);
  values.fd_choice = ["other_甲", "other_乙"];
  assert.equal(callbacks.at(-1)(), false, "ambiguous Other selections cannot be submitted");
});
