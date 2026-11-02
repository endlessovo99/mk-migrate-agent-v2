import assert from "node:assert/strict";
import { it } from "node:test";
import { runInNewContext } from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { withNativeOtherDisplayRuntime } from "../../src/dsl/native-other-display-runtime.js";
import { NATIVE_OTHER_DISPLAY_CAPABILITY as capability } from "../../src/dsl/native-other-display-capability.js";
import { inspectNativeOtherDisplayRuntime } from "../../src/executor/native-other-display-capability.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";

const source = "tests/fixtures/route-validation/native-checkbox-other/native-checkbox-other_SysFormTemplate.xml";

function harness({ required = false, kind = "checkbox", mobile = false } = {}) {
  const fixture = kind === "radio" ? "tests/fixtures/route-validation/native-radio-other/native-radio-other_SysFormTemplate.xml" : source;
  const original = cleanSourceFile(fixture);
  if (required) original.form.controls.find(field => field.id === "fd_other_text").required = true;
  const form = draftSourceDraft(original).form;
  if (kind === "radio") form.fields.find(field => field.id === "fd_choice").props.options.splice(1, 0, { label: "Alternative", value: "B" });
  const action = withNativeOtherDisplayRuntime({ actions: [] }, form, "mk_model_test").actions[0];
  const values = { "mk_model_test.fd_choice": kind === "radio" ? "other_甲_乙" : ["A", "other_甲_乙"] }, callbacks = [], before = [], timers = [], listeners = {};
  const dom = { checked: null, supported: true, enabled: true, values: ["A", "B", "other_"], labels: ["Standard", "Alternative", "其他"], mounted: true };
  const selectionInputs = ["A", "B", "other_"].map((code, index) => ({
    tagName: "INPUT", type: kind,
    get value() { return dom.values[index]; },
    get checked() {
      if (dom.checked) return dom.checked[index];
      const value = values["mk_model_test.fd_choice"], parts = Array.isArray(value) ? value : [value];
      return parts.some(item => typeof item === "string" && (code === "other_" ? item.startsWith(code) : item === code));
    },
    closest: selector => selector === "[data-id]" ? root :
      selector === "label" ? { querySelector: () => ({ getAttribute: () => dom.labels[index] }) } :
      selector === `.ele-${kind}-other` && index === 2 && dom.supported ? root : null
  }));
  const input = { tagName: "INPUT", type: "text", isConnected: true, value: "甲", selectionStart: 3, selectionEnd: 3,
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    closest(selector) { return selector === "[data-id]" ? root : selector.includes("ele-checkbox-other") ? root : null; } };
  const root = { nodeType: 1, getAttribute: () => "mk_model_test.fd_choice", getClientRects: () => [{}],
    querySelector: selector => mobile && selector === `.ele-xform-m-${kind}` ? root : null,
    querySelectorAll: selector => selector.includes(":not(:disabled)") ? (dom.enabled ? selectionInputs : []) :
      selector.includes(`input[type=${kind}]`) ? selectionInputs : [input],
    closest: () => root, contains: node => node === input };
  const moduleId = mobile ? `@elem/xform-m-${kind}` : "@elem/xform-bundle-desktop";
  const script = `${capability.origin}/web/sys/artifact/elements/${moduleId.slice(6)}/index.js?${capability.releases[moduleId]}`;
  const document = { body: {}, scripts: [{ src: script }], activeElement: input,
    querySelectorAll: () => dom.mounted ? [root] : [], addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener: type => { delete listeners[type]; } };
  class Observer { constructor(fn) { this.callback = fn; } observe() {} disconnect() { this.disconnected = true; } }
  const sdk = { MKXFORM_DATA_CONTAINER: {}, $$FORM: { current: {} }, getValue: ref => values[ref], getFieldAttr: () => 2,
    setValue(ref, value) { values[ref] = structuredClone(value); callbacks.forEach(fn => fn(value)); },
    onChange: (_ref, fn) => callbacks.push(fn), beforeSubmit: fn => before.push(fn) };
  const flush = () => { while (timers.length) timers.shift()(); };
  runInNewContext(`(${action.function})`, { MKXFORM: sdk, document, navigator: { platform: "MacIntel" }, location: { origin: capability.origin },
    MutationObserver: Observer, setTimeout: fn => { timers.push(fn); return timers.length; } })({});
  return { action, sdk, document, input, root, values, callbacks, before, listeners, flush, dom, selectionInputs };
}

for (const kind of ["checkbox", "radio"]) for (const mobile of [false, true]) {
  it(`blocks stale ${mobile ? "mobile" : "desktop"} ${kind} selection until DOM and model agree`, () => {
    const h = harness({ kind, mobile }); h.flush();
    h.values["mk_model_test.fd_choice"] = kind === "radio" ? "" : [];
    h.dom.checked = [false, false, true];
    assert.equal(h.before[0](), false, "a newly checked Other must not be lost");
    h.values["mk_model_test.fd_choice"] = kind === "radio" ? "other_" : ["other_"];
    assert.equal(h.before[0](), true);
    h.dom.checked = [false, false, false];
    assert.equal(h.before[0](), false, "an unchecked Other must not be retained");
    h.values["mk_model_test.fd_choice"] = kind === "radio" ? "" : [];
    assert.equal(h.before[0](), true);
    h.dom.checked = [true, false, false];
    assert.equal(h.before[0](), false, "a stale normal option must not be saved");
    h.values["mk_model_test.fd_choice"] = kind === "radio" ? "A" : ["A"];
    assert.equal(h.before[0](), true);
    if (mobile && kind === "checkbox") h.dom.labels = ["Alternative", "Standard", "其他"];
    else h.dom.values = ["B", "A", "other_"];
    assert.equal(h.before[0](), false, "reordered options must not be accepted by position");
    h.dom.labels = ["Standard", "Alternative", "其他"]; h.dom.values = ["A", "B", "other_"];
    h.dom.checked = [false, true, false];
    assert.equal(h.before[0](), false, "switching normal options must settle too");
    h.values["mk_model_test.fd_choice"] = kind === "radio" ? "B" : ["B"];
    assert.equal(h.before[0](), true);
    h.dom.supported = false;
    assert.equal(h.before[0](), false, "an unverified aligned layout must fail closed");
    h.sdk.getFieldAttr = () => 1;
    assert.equal(h.before[0](), false, "a still-editable readonly rendering must not bypass checks");
    h.dom.enabled = false;
    assert.equal(h.before[0](), true, "disabled readonly controls do not accept a user selection");
    h.sdk.getFieldAttr = () => 4;
    assert.equal(h.before[0](), true, "hidden controls do not accept a user selection");
    h.sdk.getFieldAttr = () => 2; h.dom.supported = true; h.dom.enabled = true; h.dom.mounted = false;
    assert.equal(h.before[0](), false, "an unmounted editable field is not silently ignored");
    h.dom.mounted = true; h.values["mk_model_test.fd_choice"] = kind === "radio" ? "A" : ["A"];
    h.listeners.change({ target: h.selectionInputs[1] }); h.root.getClientRects = () => [];
    assert.equal(h.before[0](), false, "a selection pending at hide time remains blocked");
    h.values["mk_model_test.fd_choice"] = kind === "radio" ? "B" : ["B"];
    h.root.getClientRects = () => [{}]; h.flush();
    assert.equal(h.before[0](), true, "a pending selection clears only after its model and visible control agree");
    h.root.getClientRects = () => []; h.sdk.getFieldAttr = () => undefined;
    assert.equal(h.before[0](), false, "unknown effective permissions cannot be treated as hidden");
  });
}

it("blocks a DOM and model rollback after a selection event even when the field becomes hidden", () => {
  const h = harness(); h.flush();
  h.values["mk_model_test.fd_choice"] = []; h.dom.checked = [false, false, true];
  h.listeners.change({ target: h.selectionInputs[2] });
  h.dom.checked = [false, false, false]; h.root.getClientRects = () => []; h.sdk.getFieldAttr = () => 4;
  h.flush();
  assert.equal(h.before[0](), false, "matching old DOM and model values do not prove the click was saved");
});

it("tracks a repeated radio click until native deselection reaches the model", () => {
  const h = harness({ kind: "radio" }); h.flush();
  h.values["mk_model_test.fd_choice"] = "A"; h.dom.checked = [true, false, false];
  h.listeners.pointerdown({ target: h.selectionInputs[0] });
  h.listeners.click({ target: h.selectionInputs[0] });
  assert.equal(h.before[0](), false, "the old selection must not be submitted after a deselect click");
  h.dom.checked = [false, false, false]; h.values["mk_model_test.fd_choice"] = ""; h.flush();
  assert.equal(h.before[0](), true);
});

it("uses the previous DOM selection when a radio is clicked twice before the SDK settles", () => {
  const h = harness({ kind: "radio" }); h.flush();
  h.values["mk_model_test.fd_choice"] = "A"; h.dom.checked = [true, false, false];
  h.listeners.pointerdown({ target: h.selectionInputs[1] });
  h.dom.checked = [false, true, false]; h.listeners.click({ target: h.selectionInputs[1] });
  h.listeners.pointerdown({ target: h.selectionInputs[0] });
  h.dom.checked = [true, false, false]; h.listeners.click({ target: h.selectionInputs[0] });
  h.flush(); assert.equal(h.before[0](), true);
});

it("restores full text on load, input and change without changing model values", () => {
  const h = harness(); h.flush();
  assert.equal(h.input.value, "甲_乙");
  h.values["mk_model_test.fd_choice"] = ["other_甲_乙_丙"];
  h.input.value = "甲_乙_丙"; h.input.selectionStart = 6; h.input.selectionEnd = 6;
  h.listeners.input({ target: h.input }); h.input.value = "甲"; h.callbacks[0](); h.flush();
  assert.equal(h.input.value, "甲_乙_丙");
  assert.equal(h.input.selectionStart, 5);
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["other_甲_乙_丙"]);
  assert.equal(h.before[0](), true);
});

it("blocks submit if the widget asset changes and stops observing a replaced form", () => {
  const h = harness(); h.flush(); h.document.scripts[0].src += "-changed";
  assert.equal(h.before[0](), false);
  h.sdk.$$FORM.current = {};
  const state = h.sdk.MKXFORM_DATA_CONTAINER.__mkNativeOtherDisplayV1;
  state.observer.callback([]);
  assert.equal(state.observer.disconnected, true);
  assert.equal(h.listeners.input, undefined);
});

it("blocks ambiguous Other values and restores the complete text before native blur", () => {
  const h = harness(); h.flush();
  h.values["mk_model_test.fd_choice"] = ["other_甲", "other_乙"];
  assert.equal(h.before[0](), false);
  h.values["mk_model_test.fd_choice"] = ["unexpected"];
  assert.equal(h.before[0](), false);
  h.values["mk_model_test.fd_choice"] = ["other_甲_乙"];
  h.input.value = "甲";
  h.listeners.focusout({ target: h.input });
  assert.equal(h.input.value, "甲_乙", "native blur must see the complete current value synchronously");
  assert.equal(h.before[0](), true);
});

it("does not overwrite newer input when the SDK model update is delayed", () => {
  const h = harness(); h.flush();
  h.sdk.setValue = () => {}; // Simulate an unsupported asynchronous SDK.
  h.values["mk_model_test.fd_choice"] = ["other_旧"];
  h.input.value = "新_值"; h.listeners.input({ target: h.input });
  h.input.value = "新"; h.listeners.focusout({ target: h.input });
  assert.equal(h.input.value, "新_值");
  assert.equal(h.before[0](), false);
  h.values["mk_model_test.fd_choice"] = ["other_新_值"];
  h.callbacks[0](); h.flush();
  assert.equal(h.input.value, "新_值");
  assert.equal(h.before[0](), true);
});

it("retains the latest edit when earlier SDK callbacks arrive late", () => {
  const h = harness(); h.flush();
  const first = { target: h.input, eventPhase: 1 }, second = { target: h.input, eventPhase: 1 };
  h.input.value = "a"; h.listeners.input(first); first.eventPhase = 0;
  h.input.value = "ab"; h.listeners.input(second); second.eventPhase = 0;
  h.sdk.setValue("mk_model_test.fd_choice", ["A", "other_a"]); h.flush();
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["A", "other_ab"]);
  assert.equal(h.input.value, "ab"); assert.equal(h.before[0](), true);
  h.sdk.setValue("mk_model_test.fd_choice", ["A", "other_a"]); h.flush();
  assert.equal(h.before[0](), false, "a late old callback after cleanup must not silently replace the last edit");
});

it("retains prior edit history across multiple settled input cycles", () => {
  const h = harness(); h.flush();
  for (const value of ["a", "ab", "abc"]) {
    h.input.value = value; const event = { target: h.input, eventPhase: 1 };
    h.listeners.input(event); event.eventPhase = 0;
    h.sdk.setValue("mk_model_test.fd_choice", ["A", "other_" + value]); h.flush();
    assert.equal(h.before[0](), true);
  }
  h.sdk.setValue("mk_model_test.fd_choice", ["A", "other_a"]); h.flush();
  assert.equal(h.before[0](), false, "an old callback after later settled edits must be blocked");
});

for (const [typed, nativeValue] of [["a_b", "a"], ["a ", "a"]]) {
  it(`blocks a delayed native truncation after pasting ${JSON.stringify(typed)}`, () => {
    const h = harness(); h.flush();
    const event = { target: h.input, eventPhase: 1 };
    h.input.value = typed; h.listeners.input(event); event.eventPhase = 0;
    h.sdk.setValue("mk_model_test.fd_choice", ["A", "other_" + typed]); h.flush();
    assert.equal(h.before[0](), true);
    h.sdk.setValue("mk_model_test.fd_choice", ["A", "other_" + nativeValue]); h.flush();
    assert.equal(h.before[0](), false, "a stale normalized value cannot overwrite a settled user edit");
  });
}

it("does not clear a conflict that appears after cleanup was scheduled", () => {
  const h = harness(); h.flush();
  const event = { target: h.input, eventPhase: 1 };
  h.input.value = "a_b"; h.input.selectionStart = 3; h.input.selectionEnd = 3;
  h.listeners.input(event); event.eventPhase = 0;
  h.sdk.setValue("mk_model_test.fd_choice", ["A", "other_a_b"]);
  assert.equal(h.before[0](), true, "a cleanup callback is queued for the matching value");
  h.input.value = "unexpected"; h.input.selectionStart = 1; h.input.selectionEnd = 1;
  h.listeners.beforeinput({ target: h.input }); h.input.value = "partial";
  h.listeners.input({ target: h.input }); h.listeners.focusout({ target: h.input });
  assert.equal(h.before[0](), false); h.flush();
  assert.equal(h.input.value, "partial"); assert.equal(h.before[0](), false);
});

it("does not drop an unfinished edit when the SDK unexpectedly clears Other", () => {
  const h = harness(); h.flush();
  const event = { target: h.input, eventPhase: 1 };
  h.input.value = "unfinished"; h.listeners.input(event); event.eventPhase = 0;
  h.sdk.setValue("mk_model_test.fd_choice", ["A"]); h.flush();
  assert.equal(h.before[0](), false);
});

it("retains a space while the user is typing between words", () => {
  const h = harness(); h.flush();
  h.values["mk_model_test.fd_choice"] = ["other_甲"];
  h.input.value = "甲 "; h.listeners.input({ target: h.input });
  h.input.value = "甲"; h.flush();
  assert.equal(h.input.value, "甲 ");
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["other_甲 "]);
  assert.equal(h.before[0](), true);
  h.input.value = "甲 乙"; h.listeners.input({ target: h.input }); h.input.value = "甲"; h.flush();
  assert.equal(h.input.value, "甲 乙");
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["other_甲 乙"]);
});

it("restores native-truncated text before the next fast input event", () => {
  const h = harness(); h.flush();
  h.values["mk_model_test.fd_choice"] = ["other_x"];
  h.input.value = "x "; h.input.selectionStart = 2; h.input.selectionEnd = 2;
  h.listeners.input({ target: h.input, eventPhase: 1 });
  h.input.value = "x"; h.input.selectionStart = 1; h.input.selectionEnd = 1;
  h.listeners.beforeinput({ target: h.input });
  assert.equal(h.input.value, "x "); assert.equal(h.input.selectionStart, 2);
  h.input.value = "x y_"; h.input.selectionStart = 4; h.input.selectionEnd = 4;
  h.listeners.input({ target: h.input, eventPhase: 1 });
  h.input.value = "x y"; h.input.selectionStart = 3; h.input.selectionEnd = 3;
  h.listeners.beforeinput({ target: h.input });
  assert.equal(h.input.value, "x y_"); assert.equal(h.input.selectionStart, 4);
  h.input.value = "x y_z"; h.input.selectionStart = 5; h.input.selectionEnd = 5;
  h.listeners.input({ target: h.input, eventPhase: 1 }); h.flush();
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["other_x y_z"]);
  assert.equal(h.before[0](), true);
});

it("keeps ambiguous fast-input state blocked instead of accepting a partial replacement", () => {
  const h = harness(); h.flush();
  h.input.value = "a_b"; h.input.selectionStart = 3; h.input.selectionEnd = 3;
  h.listeners.input({ target: h.input, eventPhase: 1 });
  h.input.value = "unexpected"; h.input.selectionStart = 1; h.input.selectionEnd = 1;
  h.listeners.beforeinput({ target: h.input });
  h.input.value = "partial"; h.listeners.input({ target: h.input }); h.flush();
  assert.equal(h.before[0](), false);
  h.listeners.focusout({ target: h.input });
  assert.equal(h.input.value, "partial", "blur must not replace an unresolved user edit");
  h.sdk.setValue("mk_model_test.fd_choice", ["other_partial"]); h.flush();
  assert.equal(h.before[0](), false, "a delayed native callback must not clear a conflicting edit");
});

it("never writes a pending user edit after effective permissions become readonly", () => {
  const h = harness(); h.flush();
  let writes = 0; h.sdk.setValue = () => { writes++; };
  h.input.value = "unauthorized"; h.listeners.input({ target: h.input, eventPhase: 1 });
  h.sdk.getFieldAttr = () => 1; h.flush();
  assert.equal(writes, 0);
  assert.equal(h.before[0](), false);
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["A", "other_甲_乙"]);
});

it("preserves deliberate caret navigation while native text is temporarily truncated", () => {
  const h = harness(); h.flush();
  h.values["mk_model_test.fd_choice"] = ["other_abc_def"];
  h.input.value = "abc_def"; h.input.selectionStart = 7; h.input.selectionEnd = 7;
  h.listeners.input({ target: h.input, eventPhase: 1 });
  h.input.value = "abc"; h.input.selectionStart = 3; h.input.selectionEnd = 3;
  h.listeners.keydown({ target: h.input, key: "ArrowLeft", preventDefault() {} });
  assert.equal(h.input.value, "abc_def");
  assert.equal(h.input.selectionStart, 6);
  h.listeners.keyup({ target: h.input, key: "ArrowLeft" }); h.flush();
  assert.equal(h.input.selectionStart, 6);
  h.input.value = "abc_deXf"; h.input.selectionStart = 7; h.input.selectionEnd = 7;
  h.listeners.input({ target: h.input, eventPhase: 1 }); h.flush();
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["other_abc_deXf"]);
  assert.equal(h.before[0](), true);
});

it("preserves a select-all replacement across delayed native text restoration", () => {
  const h = harness(); h.flush();
  h.values["mk_model_test.fd_choice"] = ["other_abc_def"];
  h.input.value = "abc_def"; h.input.selectionStart = 7; h.input.selectionEnd = 7;
  h.listeners.input({ target: h.input, eventPhase: 1 });
  h.input.value = "abc"; h.input.selectionStart = 3; h.input.selectionEnd = 3;
  h.listeners.keydown({ target: h.input, key: "a", metaKey: true, preventDefault() {} });
  assert.equal(h.input.selectionStart, 0); assert.equal(h.input.selectionEnd, 7);
  h.listeners.keyup({ target: h.input, key: "a", metaKey: true }); h.flush();
  assert.equal(h.input.selectionStart, 0); assert.equal(h.input.selectionEnd, 7);
  h.input.value = "X"; h.input.selectionStart = 1; h.input.selectionEnd = 1;
  h.listeners.input({ target: h.input, eventPhase: 1 }); h.flush();
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["other_X"]);
  assert.equal(h.before[0](), true);
});

for (const [key, options, expected] of [["ArrowUp", {}, 0], ["ArrowDown", {}, 7], ["ArrowLeft", { altKey: true }, 0]]) {
  it(`handles ${key} during native text restoration without blocking submission`, () => {
    const h = harness(); h.flush();
    h.values["mk_model_test.fd_choice"] = ["other_abc_def"];
    h.input.value = "abc_def"; h.input.selectionStart = 7; h.input.selectionEnd = 7;
    h.listeners.input({ target: h.input, eventPhase: 1 });
    h.input.value = "abc"; h.input.selectionStart = 3; h.input.selectionEnd = 3;
    h.listeners.keydown({ target: h.input, key, ...options, preventDefault() {} }); h.flush();
    assert.equal(h.input.value, "abc_def"); assert.equal(h.input.selectionStart, expected);
    assert.equal(h.before[0](), true);
  });
}

it("restores an intentional Home-like selection after native rerender resets the caret", () => {
  const h = harness(); h.flush();
  h.values["mk_model_test.fd_choice"] = ["other_abc_def"];
  h.input.value = "abc_def"; h.input.selectionStart = 7; h.input.selectionEnd = 7;
  h.listeners.input({ target: h.input, eventPhase: 1 });
  h.input.value = "abc"; h.input.selectionStart = 3; h.input.selectionEnd = 3;
  h.listeners.keydown({ target: h.input, key: "ArrowUp", preventDefault() {} });
  h.input.value = "abc"; h.input.selectionStart = 3; h.input.selectionEnd = 3;
  h.listeners.beforeinput({ target: h.input });
  assert.equal(h.input.value, "abc_def"); assert.equal(h.input.selectionStart, 0);
  h.input.value = "Xabc_def"; h.input.selectionStart = 1; h.input.selectionEnd = 1;
  h.listeners.input({ target: h.input, eventPhase: 1 }); h.flush();
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["other_Xabc_def"]);
  assert.equal(h.before[0](), true);
});

it("allows a trusted full replacement after a navigation conflict without refocusing", () => {
  const h = harness(); h.flush();
  h.input.value = "abc_def"; h.input.selectionStart = 7; h.input.selectionEnd = 7;
  h.listeners.input({ target: h.input, eventPhase: 1 });
  h.input.value = "abc"; h.input.selectionStart = 2; h.input.selectionEnd = 2;
  h.listeners.keydown({ target: h.input, key: "ArrowLeft" });
  assert.equal(h.before[0](), false);
  h.input.selectionStart = 0; h.input.selectionEnd = h.input.value.length;
  h.listeners.beforeinput({ target: h.input, isTrusted: true, inputType: "insertText" });
  h.input.value = "repaired"; h.input.selectionStart = 8; h.input.selectionEnd = 8;
  h.listeners.input({ target: h.input, eventPhase: 1 }); h.flush();
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["A", "other_repaired"]);
  assert.equal(h.before[0](), true);
});

it("does not overwrite a later programmatic Other value", () => {
  for (const flushFirst of [false, true]) {
    const h = harness(); h.flush();
    h.input.value = "用户_值"; h.listeners.input({ target: h.input });
    h.sdk.setValue("mk_model_test.fd_choice", ["other_用户_值"]);
    if (flushFirst) h.flush();
    h.sdk.setValue("mk_model_test.fd_choice", ["other_程序_值"]);
    h.input.value = "程序"; h.flush();
    assert.deepEqual(h.values["mk_model_test.fd_choice"], ["other_程序_值"]);
    assert.equal(h.input.value, "程序_值");
    assert.equal(h.before[0](), true);
  }
});

it("fails closed on an ambiguous rollback to the prior value", () => {
  const h = harness(); h.flush();
  h.input.value = "用户新值"; const event = { target: h.input, eventPhase: 1 };
  h.listeners.input(event); event.eventPhase = 0;
  h.sdk.setValue("mk_model_test.fd_choice", ["other_甲_乙"]);
  h.flush();
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["other_甲_乙"]);
  assert.equal(h.before[0](), false);
});

it("does not write or submit during IME composition and applies its final text", () => {
  const h = harness(); h.flush();
  h.listeners.compositionstart({ target: h.input });
  assert.equal(h.before[0](), false, "submission is blocked from composition start");
  h.input.value = "拼"; h.listeners.input({ target: h.input, isComposing: true, eventPhase: 1 });
  h.flush();
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["A", "other_甲_乙"]);
  assert.equal(h.before[0](), false);
  h.input.value = "拼音 结果"; h.listeners.compositionend({ target: h.input, eventPhase: 1 }); h.flush();
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["A", "other_拼音 结果"]);
  assert.equal(h.before[0](), false, "composition must settle before submit");
  h.input.value = "拼音 结果"; h.listeners.input({ target: h.input, data: "拼音 结果", inputType: "insertFromComposition", eventPhase: 1 }); h.flush();
  assert.equal(h.before[0](), true);
});

it("handles composition end even when the IME emitted no intermediate input", () => {
  const h = harness(); h.flush();
  h.listeners.compositionstart({ target: h.input });
  h.input.value = "中文"; h.listeners.compositionend({ target: h.input, eventPhase: 1 }); h.flush();
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["A", "other_中文"]);
  assert.equal(h.before[0](), false);
  h.input.value = "中文"; h.listeners.input({ target: h.input, data: "中文", inputType: "insertFromComposition", eventPhase: 1 }); h.flush();
  assert.equal(h.before[0](), true);
});

it("allows a provably unchanged canceled composition", () => {
  for (const selected of [false, true]) {
    const h = harness(); h.flush();
    h.input.selectionStart = selected ? 0 : h.input.value.length;
    h.input.selectionEnd = h.input.value.length;
    h.listeners.compositionstart({ target: h.input });
    h.listeners.compositionend({ target: h.input, data: "", eventPhase: 1 }); h.flush();
    assert.equal(h.input.value, "甲_乙");
    assert.deepEqual(h.values["mk_model_test.fd_choice"], ["A", "other_甲_乙"]);
    assert.equal(h.before[0](), true);
  }
});

it("does not treat cancellation as safe after a programmatic change", () => {
  const h = harness(); h.flush();
  h.listeners.compositionstart({ target: h.input });
  h.input.value = "拼"; const composing = { target: h.input, isComposing: true, eventPhase: 1 };
  h.listeners.input(composing); composing.eventPhase = 0;
  h.sdk.setValue("mk_model_test.fd_choice", ["other_外部新值"]);
  h.input.value = "甲_乙"; h.listeners.compositionend({ target: h.input, data: "", eventPhase: 1 }); h.flush();
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["other_外部新值"]);
  assert.equal(h.before[0](), false);
});

it("preserves the user's insertion point when composition follows a truncated render", () => {
  const h = harness(); h.flush();
  h.values["mk_model_test.fd_choice"] = ["other_abc"];
  h.input.value = "ab_c"; h.input.selectionStart = 3; h.input.selectionEnd = 3;
  h.listeners.input({ target: h.input, eventPhase: 3 });
  h.input.value = "ab"; h.input.selectionStart = 2; h.input.selectionEnd = 2;
  h.listeners.compositionstart({ target: h.input });
  assert.equal(h.input.value, "ab_c");
  assert.equal(h.input.selectionStart, 3);
  h.input.value = "ab_中c"; h.listeners.input({ target: h.input, isComposing: true, eventPhase: 3 });
  h.input.value = "ab"; h.listeners.compositionend({ target: h.input, data: "中", eventPhase: 3 }); h.flush();
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["other_ab_中c"]);
  assert.equal(h.before[0](), false);
});

it("does not overwrite a programmatic update during IME composition", () => {
  const h = harness(); h.flush();
  h.listeners.compositionstart({ target: h.input });
  h.input.value = "拼"; const input = { target: h.input, isComposing: true, eventPhase: 1 };
  h.listeners.input(input); input.eventPhase = 0;
  h.sdk.setValue("mk_model_test.fd_choice", ["other_外部新值"]);
  h.input.value = "拼音"; h.listeners.compositionend({ target: h.input, data: "拼音", eventPhase: 1 }); h.flush();
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["other_外部新值"]);
  assert.equal(h.before[0](), false);
});

it("fails closed when composition starts without a provable start event", () => {
  const h = harness(); h.flush();
  h.input.value = "拼_音"; h.listeners.input({ target: h.input, isComposing: true, eventPhase: 1 });
  h.input.value = "拼"; h.listeners.compositionend({ target: h.input, data: "拼_音", eventPhase: 1 }); h.flush();
  assert.equal(h.before[0](), false);
});

it("blocks an ambiguous final IME input instead of accepting truncated text", () => {
  const h = harness(); h.flush();
  h.values["mk_model_test.fd_choice"] = ["other_前缀"];
  h.input.value = "前缀"; h.input.selectionStart = 2; h.input.selectionEnd = 2;
  h.listeners.compositionstart({ target: h.input });
  h.input.value = "前缀拼音_中文"; const intermediate = { target: h.input, isComposing: true, eventPhase: 1 };
  h.listeners.input(intermediate); intermediate.eventPhase = 0;
  h.values["mk_model_test.fd_choice"] = ["other_前缀拼音_中文"];
  h.input.value = "前缀拼音";
  h.listeners.compositionend({ target: h.input, data: "拼音_中文", eventPhase: 1 });
  const final = { target: h.input, data: null, inputType: "insertText", isComposing: false, eventPhase: 3 };
  h.listeners.input(final); h.sdk.setValue("mk_model_test.fd_choice", ["other_前缀拼音"]); final.eventPhase = 0; h.flush();
  assert.equal(h.before[0](), false, "ambiguous completion must never permit saving the truncated value");
});

it("blocks an edit based on an IME-truncated DOM until the user explicitly replaces it", () => {
  const h = harness(); h.flush();
  h.values["mk_model_test.fd_choice"] = ["other_前缀"];
  h.input.value = "前缀"; h.input.selectionStart = 2; h.input.selectionEnd = 2;
  h.listeners.compositionstart({ target: h.input });
  h.input.value = "前缀拼音_中文"; const intermediate = { target: h.input, isComposing: true, eventPhase: 1 };
  h.listeners.input(intermediate); intermediate.eventPhase = 0;
  h.values["mk_model_test.fd_choice"] = ["other_前缀拼音_中文"];
  h.input.value = "前缀拼音"; h.input.selectionStart = 4; h.input.selectionEnd = 4;
  h.listeners.compositionend({ target: h.input, data: "拼音_中文", eventPhase: 1 });
  h.listeners.beforeinput({ target: h.input, inputType: "deleteContentBackward" });
  h.input.value = "前缀拼"; const deletion = { target: h.input, data: null, inputType: "deleteContentBackward", eventPhase: 3 };
  h.listeners.input(deletion); h.sdk.setValue("mk_model_test.fd_choice", ["other_前缀拼"]); deletion.eventPhase = 0; h.flush();
  assert.equal(h.before[0](), false);
  h.listeners.focusin({ target: h.input, isTrusted: true });
  h.input.selectionStart = 0; h.input.selectionEnd = h.input.value.length;
  h.listeners.beforeinput({ target: h.input, inputType: "insertText", isTrusted: true });
  h.input.value = "重新输入"; const replace = { target: h.input, data: "重新输入", inputType: "insertText", eventPhase: 3 };
  h.listeners.input(replace); h.sdk.setValue("mk_model_test.fd_choice", ["other_重新输入"]); replace.eventPhase = 0; h.flush();
  assert.equal(h.before[0](), true);
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["other_重新输入"]);
});

it("does not treat a selected truncated IME final value as user replacement", () => {
  const h = harness(); h.flush();
  h.values["mk_model_test.fd_choice"] = ["other_"];
  h.input.value = ""; h.input.selectionStart = 0; h.input.selectionEnd = 0;
  h.listeners.compositionstart({ target: h.input });
  h.input.value = "拼音_中文"; h.listeners.input({ target: h.input, isComposing: true, eventPhase: 1 });
  h.values["mk_model_test.fd_choice"] = ["other_拼音_中文"];
  h.input.value = "拼音"; h.listeners.compositionend({ target: h.input, data: "拼音_中文", eventPhase: 1 });
  h.input.selectionStart = 0; h.input.selectionEnd = 2;
  h.listeners.beforeinput({ target: h.input, data: null, inputType: "insertText", isTrusted: true });
  const final = { target: h.input, data: null, inputType: "insertText", eventPhase: 3 };
  h.listeners.input(final); h.sdk.setValue("mk_model_test.fd_choice", ["other_拼音"]); final.eventPhase = 0; h.flush();
  assert.equal(h.before[0](), false);
});

it("blocks an IME final event whose data conflicts with compositionend", () => {
  const h = harness(); h.flush();
  h.values["mk_model_test.fd_choice"] = ["other_"];
  h.input.value = ""; h.input.selectionStart = 0; h.input.selectionEnd = 0;
  h.listeners.compositionstart({ target: h.input });
  h.input.value = "拼音_中文"; h.listeners.input({ target: h.input, isComposing: true, eventPhase: 1 });
  h.values["mk_model_test.fd_choice"] = ["other_拼音_中文"];
  h.input.value = "拼音"; h.listeners.compositionend({ target: h.input, data: "拼音_中文", eventPhase: 1 });
  const final = { target: h.input, data: "拼音", inputType: "insertFromComposition", eventPhase: 3 };
  h.listeners.input(final); h.sdk.setValue("mk_model_test.fd_choice", ["other_拼音"]); final.eventPhase = 0; h.flush();
  assert.equal(h.before[0](), false);
});

it("does not allow whitespace-only text for a required MK Other option", () => {
  const h = harness({ required: true }); h.flush();
  h.input.value = "  "; h.listeners.input({ target: h.input, eventPhase: 1 }); h.flush();
  assert.deepEqual(h.values["mk_model_test.fd_choice"], ["A", "other_  "]);
  assert.equal(h.before[0](), false);
  h.dom.enabled = false; h.sdk.getFieldAttr = () => 1; assert.equal(h.before[0](), true, "readonly content cannot be edited");
  h.sdk.getFieldAttr = () => 4; assert.equal(h.before[0](), true, "hidden content is not required");
  h.sdk.getFieldAttr = () => 2; h.root.getClientRects = () => [];
  assert.equal(h.before[0](), true, "a mounted but conditionally hidden control is not required");
  h.root.getClientRects = () => [{}]; h.sdk.getFieldAttr = () => undefined;
  assert.equal(h.before[0](), false, "unknown effective permissions fail closed");
});

it("guards the full encoded MK field capacity without truncating the input", () => {
  const h = harness(); h.flush();
  for (const [value, allowed] of [
    [["other_" + "x".repeat(194)], true],
    [["other_" + "x".repeat(195)], false],
    [["A", "other_" + "x".repeat(192)], true],
    [["A", "other_" + "x".repeat(193)], false],
    [["other_" + "中".repeat(64)], true],
    [["other_" + "中".repeat(65)], false]
  ]) {
    h.values["mk_model_test.fd_choice"] = value;
    const original = structuredClone(value);
    assert.equal(h.before[0](), allowed, JSON.stringify(value));
    assert.deepEqual(h.values["mk_model_test.fd_choice"], original, "the guard must not truncate model data");
  }
});

it("verifies the exact native widget releases and bytes before target writes", async () => {
  const client = new FakeNewoaAdapter("persist");
  assert.deepEqual(await inspectNativeOtherDisplayRuntime(client, capability.origin), { ok: true, issues: [] });
  client.getNativeOtherAssetSha256 = async () => "0".repeat(64);
  assert.equal((await inspectNativeOtherDisplayRuntime(client, capability.origin)).ok, false);
  assert.equal((await inspectNativeOtherDisplayRuntime(client, "https://other.invalid")).ok, false);
});

it("registers a blocking submit guard before a partial initialization fails", () => {
  const form = draftSourceDraft(cleanSourceFile(source)).form;
  const action = withNativeOtherDisplayRuntime({ actions: [] }, form, "mk_model_test").actions[0];
  const guards = [], sdk = { beforeSubmit: fn => guards.push(fn) };
  runInNewContext(`(${action.function})`, { MKXFORM: sdk })({});
  assert.equal(guards.length, 1);
  assert.equal(guards[0](), false);
});
