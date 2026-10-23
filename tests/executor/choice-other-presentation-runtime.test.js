import assert from "node:assert/strict";
import { it } from "node:test";
import { runInNewContext } from "node:vm";
import { choiceOtherToggleBindings, withChoiceOtherRuntime } from "../../src/dsl/choice-other-runtime.js";

const MAIN_TABLE_NAME = "mk_main_test";

const form = {
  fields: [
    { id: "fd_choice", componentId: "xform-checkbox", sourceRef: "source.choice",
      sourceProps: { otherTextCompanion: { id: "fd_note", captionId: "other_caption" } } },
    { id: "fd_note", componentId: "xform-input", sourceRef: "source.note" },
    {
      id: "other_caption", componentId: "xform-checkbox", generated: true, sourceRef: "source.caption",
      props: { options: [{ label: "其他", value: "selected" }], hiddenLabel: true },
      sourceProps: { choiceOtherToggle: { version: 1, choiceSourceRef: "source.choice", textSourceRef: "source.note" } }
    }
  ]
};

it("initializes the independent Other selection from an unchanged source explanation", () => {
  const runtime = runtimeFor(form, { fd_choice: ["code_unchanged"], fd_note: "  原始_说明  " });
  runtime.initialize();
  assert.deepEqual(runtime.values.other_caption, ["selected"]);
  assert.deepEqual(runtime.writes.map(({ id }) => id), ["other_caption"]);
  assert.deepEqual(runtime.values.fd_choice, ["code_unchanged"]);
  assert.equal(runtime.values.fd_note, "  原始_说明  ");
});

it("updates only the independent selection when explanation text actually changes", () => {
  const runtime = runtimeFor(form, { fd_choice: ["source-code"], fd_note: "initial", other_caption: [] });
  runtime.initialize();
  assert.deepEqual(runtime.values.other_caption, []);
  runtime.edit("fd_note", "initial");
  assert.deepEqual(runtime.values.other_caption, [], "same-value rewrites preserve an explicit cancellation");
  runtime.edit("fd_note", "  next_说明  ");
  assert.deepEqual(runtime.values.other_caption, ["selected"]);
  runtime.edit("fd_note", "");
  assert.deepEqual(runtime.values.other_caption, []);
  assert.deepEqual(runtime.values.fd_choice, ["source-code"]);
  assert.deepEqual(runtime.writes.map(({ id }) => id), ["other_caption", "other_caption"]);
});

it("resolves source identities after remapping and rejects incompatible or ambiguous bindings", () => {
  const remapped = structuredClone(form);
  for (const field of remapped.fields) {
    field.sourceProps = { ...field.sourceProps, originalId: field.id };
    field.id = `remapped_${field.id}`;
  }
  assert.deepEqual(choiceOtherToggleBindings(remapped), [{
    toggleId: "remapped_other_caption", choiceId: "remapped_fd_choice", textId: "remapped_fd_note"
  }]);
  const invalidCases = [
    (fields) => { fields[0].componentId = "xform-input"; },
    (fields) => { fields[1].componentId = "xform-textarea"; },
    (fields) => { fields[2].componentId = "xform-description"; },
    (fields) => { fields[2].generated = false; },
    (fields) => { fields[2].props.options = []; },
    (fields) => { fields[2].props.options.push({ label: "第二项", value: "another" }); },
    (fields) => { fields[2].props.options[0].value = "other_"; },
    (fields) => { fields[2].props.options[0].type = "other"; },
    (fields) => { fields[2].props.options[0].label = "  "; },
    (fields) => { fields[2].props.hiddenLabel = false; },
    (fields) => { fields[2].props.required = true; },
    (fields) => { fields[2].sourceProps.choiceOtherToggle.version = 2; },
    (fields) => { fields[2].sourceProps.choiceOtherToggle.textSourceRef = "missing"; },
    (fields) => { fields[2].sourceProps.choiceOtherToggle.textSourceRef = "source.choice"; },
    (fields) => { fields[0].sourceProps.otherTextCompanion.id = "unrelated-text"; },
    (fields) => { fields[0].sourceProps.otherTextCompanion.captionId = "unrelated-caption"; },
    (fields) => { fields[0].sourceProps.otherTextCompanion.optionValue = "source-other-code"; },
    (fields) => { fields.push({ id: "duplicate-note", sourceRef: "source.note" }); },
    (fields) => { fields.push({ id: "other_caption", sourceRef: "unrelated" }); }
  ];
  for (const invalidate of invalidCases) {
    const candidate = structuredClone(form);
    invalidate(candidate.fields);
    assert.throws(() => choiceOtherToggleBindings(candidate), { code: "projection.choice_other.binding_invalid" });
  }
});

it("initializes each native form and pair once while ignoring a replaced form's stale callbacks", () => {
  const runtime = runtimeFor(form, { fd_note: "saved", other_caption: [] });
  runtime.initialize();
  runtime.initialize();
  runtime.initialize();
  assert.equal(runtime.subscriptions.length, 1);
  assert.deepEqual(runtime.writes, []);
  const oldSubscription = runtime.subscriptions[0];
  runtime.MKXFORM.$$FORM.current = {};
  runtime.initialize();
  assert.equal(runtime.subscriptions.length, 2, "a new native form needs its own subscription");
  oldSubscription.callback("stale text");
  assert.deepEqual(runtime.writes, [], "the old form cannot change the new form's selection");
  runtime.edit("fd_note", "fresh text");
  assert.deepEqual(runtime.values.other_caption, ["selected"]);
  assert.equal(runtime.writes.length, 1);
});

it("fails explicitly before changing values when native runtime identity or APIs are unavailable", () => {
  for (const makeUnavailable of [
    (api) => { delete api.MKXFORM_DATA_CONTAINER; },
    (api) => { delete api.$$FORM; },
    (api) => { delete api.$$FORM.current; },
    (api) => { delete api.onChange; },
    (api) => { delete api.getValue; },
    (api) => { delete api.setValue; }
  ]) {
    const runtime = runtimeFor(form, { fd_note: "saved" });
    makeUnavailable(runtime.MKXFORM);
    assert.throws(runtime.initialize, /Choice Other runtime requires a ready native form/);
    assert.deepEqual(runtime.writes, []);
    assert.deepEqual(runtime.subscriptions, []);
  }
});

it("projects one stable action while preserving existing scripts and rejecting an occupied action identity", () => {
  const existing = {
    source: "existing-source", other: "retained",
    actions: [{ id: "source-load", event: "onLoad", scope: "global", function: "function onLoad(){return true;}" }]
  };
  assert.equal(withChoiceOtherRuntime(existing, { fields: [] }), existing);
  const projected = withChoiceOtherRuntime(existing, form, MAIN_TABLE_NAME);
  assert.equal(existing.actions.length, 1);
  assert.equal(projected.actions[0], existing.actions[0]);
  assert.equal(projected.other, "retained");
  assert.equal(projected.actions[1].id, "mk-choice-other-init-v1");
  assert.equal(projected.actions[1].event, "onLoad");
  assert.equal(projected.actions[1].scope, "global");
  assert.equal(withChoiceOtherRuntime(projected, form, MAIN_TABLE_NAME), projected);
  const collision = { actions: [{ ...projected.actions[1], function: "function occupied(){}" }] };
  assert.throws(() => withChoiceOtherRuntime(collision, form, MAIN_TABLE_NAME), { code: "projection.choice_other.action_id_collision" });
});

it("requires an explicit valid physical main table only when source bindings exist", () => {
  for (const invalid of [undefined, null, "", "1main", "main-table", "main.field", "主表", "a".repeat(101), { toString: () => MAIN_TABLE_NAME }]) {
    assert.throws(() => withChoiceOtherRuntime({}, form, invalid), { code: "projection.choice_other.main_table_invalid" });
  }
  const scripts = { actions: [] };
  assert.equal(withChoiceOtherRuntime(scripts, {}, undefined), scripts);
  assert.doesNotThrow(() => withChoiceOtherRuntime({}, form, "_main123"));
});

it("passes physically qualified current field references to every public SDK operation", () => {
  const runtime = runtimeFor(form, { fd_note: "initial" });
  runtime.initialize();
  assert.deepEqual(runtime.references, [
    { api: "getValue", ref: "mk_main_test.fd_note" },
    { api: "getValue", ref: "mk_main_test.other_caption" },
    { api: "setValue", ref: "mk_main_test.other_caption" },
    { api: "onChange", ref: "mk_main_test.fd_note" }
  ]);
  runtime.edit("fd_note", "");
  assert.deepEqual(runtime.references.at(-1), { api: "setValue", ref: "mk_main_test.other_caption" });
  assert.deepEqual(choiceOtherToggleBindings(form), [{ toggleId: "other_caption", choiceId: "fd_choice", textId: "fd_note" }]);
});

it("preserves empty selections, selected empty explanations, and every explanation character on initialization", () => {
  const texts = [undefined, null, "", " ", "  下划线_under_score  ", "甲_乙🙂\n第二行"];
  for (const text of texts) {
    for (const saved of [undefined, null, "", [], ["selected"]]) {
      const runtime = runtimeFor(form, { fd_choice: ["A_CODE", "other_legacy_code"], fd_note: text, other_caption: saved });
      runtime.initialize();
      const unset = saved === undefined || saved === null || saved === "";
      const expected = unset ? (text === undefined || text === null || text === "" ? [] : ["selected"]) : saved;
      assert.deepEqual(runtime.values.other_caption, expected, `${JSON.stringify(saved)} with ${JSON.stringify(text)}`);
      assert.equal(runtime.values.fd_note, text);
      assert.deepEqual(runtime.values.fd_choice, ["A_CODE", "other_legacy_code"]);
      assert.ok(runtime.writes.every(({ id }) => id === "other_caption"));
    }
  }
});

it("observes programmatic text updates without erasing a manual cancellation on a same-value rewrite", () => {
  const runtime = runtimeFor(form, { fd_choice: ["A_1"], fd_note: "original_text" });
  runtime.initialize();
  runtime.MKXFORM.setValue("mk_main_test.other_caption", []);
  assert.equal(runtime.values.fd_note, "original_text", "unchecking Other retains the source explanation");
  runtime.writes.length = 0;
  runtime.MKXFORM.setValue("mk_main_test.fd_note", "original_text");
  assert.deepEqual(runtime.values.other_caption, []);
  assert.deepEqual(runtime.writes.map(({ id }) => id), ["fd_note"]);
  runtime.writes.length = 0;
  runtime.MKXFORM.setValue("mk_main_test.fd_note", "  script_更新🙂  ");
  assert.deepEqual(runtime.values.other_caption, ["selected"]);
  assert.equal(runtime.values.fd_note, "  script_更新🙂  ");
  assert.deepEqual(runtime.writes.map(({ id }) => id), ["fd_note", "other_caption"]);
  assert.deepEqual(runtime.values.fd_choice, ["A_1"]);
});

it("keeps two source pairs independent with one initializer and one subscription per pair", () => {
  const second = structuredClone(form);
  for (const field of second.fields) {
    field.id += "_2";
    field.sourceRef += ".2";
  }
  second.fields[0].sourceProps.otherTextCompanion = { id: "fd_note_2", captionId: "other_caption_2" };
  second.fields[2].sourceProps.choiceOtherToggle = { version: 1, choiceSourceRef: "source.choice.2", textSourceRef: "source.note.2" };
  const combined = { fields: [...form.fields, ...second.fields] };
  const projected = withChoiceOtherRuntime({}, combined, MAIN_TABLE_NAME);
  assert.equal(projected.actions.length, 1);
  const runtime = runtimeFor(combined, {
    fd_choice: ["FIRST"], fd_note: "", other_caption: [],
    fd_choice_2: ["SECOND"], fd_note_2: "second explanation", other_caption_2: ["selected"]
  });
  runtime.initialize();
  runtime.initialize();
  assert.equal(runtime.subscriptions.length, 2);
  runtime.edit("fd_note", "first explanation");
  assert.deepEqual(runtime.values.other_caption, ["selected"]);
  assert.deepEqual(runtime.values.other_caption_2, ["selected"]);
  assert.deepEqual(runtime.writes.map(({ id }) => id), ["other_caption"]);
  runtime.edit("fd_note_2", "");
  assert.deepEqual(runtime.values.other_caption, ["selected"]);
  assert.deepEqual(runtime.values.other_caption_2, []);
  assert.deepEqual(runtime.writes.map(({ id }) => id), ["other_caption", "other_caption_2"]);
  assert.deepEqual(runtime.values.fd_choice, ["FIRST"]);
  assert.deepEqual(runtime.values.fd_choice_2, ["SECOND"]);
});

// This executes the generated projection against a fake public SDK boundary.
// Native adapter evidence is exercised separately in choice-other-native-runtime.test.js;
// neither test instantiates the complete native React form or a browser lifecycle.
function runtimeFor(currentForm, initialValues) {
  const values = structuredClone(initialValues);
  const writes = [], subscriptions = [], references = [];
  const context = {};
  const MKXFORM = {
    MKXFORM_DATA_CONTAINER: {}, $$FORM: { current: {} },
    getValue(ref) { return values[resolveReference("getValue", ref)]; },
    setValue(ref, value) {
      const id = resolveReference("setValue", ref);
      writes.push({ id, value: structuredClone(value) });
      edit(id, value);
    },
    onChange(ref, callback, receivedContext) {
      const id = resolveReference("onChange", ref);
      assert.equal(receivedContext, undefined, "main-table subscriptions use only the documented public arguments");
      subscriptions.push({ id, callback, nativeForm: MKXFORM.$$FORM.current });
    }
  };
  function resolveReference(api, ref) {
    assert.equal(typeof ref, "string");
    assert.ok(ref.startsWith(`${MAIN_TABLE_NAME}.`), `${api} requires an explicitly qualified physical field reference: ${ref}`);
    references.push({ api, ref });
    return ref.slice(MAIN_TABLE_NAME.length + 1);
  }
  function edit(id, value) {
    values[id] = structuredClone(value);
    for (const subscription of subscriptions) {
      if (subscription.id === id && subscription.nativeForm === MKXFORM.$$FORM.current) subscription.callback(value);
    }
  }
  const scripts = withChoiceOtherRuntime({}, currentForm, MAIN_TABLE_NAME);
  const action = scripts.actions.find(({ id }) => id === "mk-choice-other-init-v1");
  const initialize = runInNewContext(`(${action.function})`, { MKXFORM });
  return { values, writes, subscriptions, references, MKXFORM, edit, initialize: () => initialize(context) };
}
