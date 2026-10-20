import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createNativeDetailControlBridge } from "../../src/translator/native-detail-control-bridge.js";

const fixture = name => fs.readFileSync(new URL("../fixtures/translator/native-detail-control-bridge/" + name, import.meta.url), "utf8");
function harness() {
  const instances = new Map(); let current, dirty = false, effects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    Fragment: "Fragment", createElement(type, props, ...children) { return { type, props: { ...(type?.defaultProps || {}), ...props }, children }; },
    useState(initial) { const owner = current, i = owner.index++; if (!(i in owner.hooks)) owner.hooks[i] = typeof initial === "function" ? initial() : initial; return [owner.hooks[i], value => { const next = typeof value === "function" ? value(owner.hooks[i]) : value; if (!Object.is(next, owner.hooks[i])) { owner.hooks[i] = next; dirty = true; } }]; },
    useRef(initial) { const i = current.index++; return current.hooks[i] ||= { current: initial }; },
    useMemo(fn, deps) { const i = current.index++, old = current.hooks[i]; if (!old || !same(old.deps, deps)) current.hooks[i] = { value: fn(), deps }; return current.hooks[i].value; },
    useCallback(fn, deps) { return this.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const owner = current, i = owner.index++, old = owner.hooks[i]; if (!old || !same(old.deps, deps)) { owner.hooks[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); owner.hooks[i].cleanup = fn(); }); } },
    useImperativeHandle() {}
  };
  function render(fn, props, id = fn) { const owner = instances.get(id) || { hooks: [], index: 0 }; instances.set(id, owner); owner.index = 0; current = owner; try { return fn(props); } finally { current = null; } }
  function cycle(fn) { let result; for (let n = 0; n < 15; n++) { dirty = false; result = fn(); const pending = effects; effects = []; pending.forEach(fn => fn()); if (!dirty) return result; } throw Error("Unstable native render effects."); }
  function unmount(id) { instances.get(id)?.hooks.forEach(h => h?.cleanup?.()); instances.delete(id); }
  const actions = [], EMPTY = [];
  const base = { Http: { build: () => ({}) }, getShowStatus: value => value, jsGetType: value => typeof value, SceneShowRules: { NotShowControlTip: [] }, transformLocale: value => value, getUITestDataTidPrefix: () => "", useFormatValidate: () => ({}), createDataTidObjectFromTarget: value => value, isRedValidatorInfoUITypeThemes: () => false, formatI18nOptions: value => value, transformValueForRuleOption: value => value, useCommonForRuleFormula: () => EMPTY, useOptionsForRuleFormula: () => EMPTY, useOptionsForJs: () => EMPTY, useGangedFields: () => ({}), actionFunsRunner: (...args) => actions.push(args) };
  const Radio = Object.assign(function NativeRadio() {}, { Group: "NativeRadioGroup" });
  const modules = {};
  for (const name of ["input", "textarea", "radio"]) {
    const exp = {}, dependencies = { react: React, "@elem/xform-base": base, "@elem/xform-view": "XFormView", "@lui/core": { Radio, Input: Object.assign(function Input() {}, { TextArea: "NativeTextArea" }) }, "@elem/xform-headless": "Headless", "@ekp-runtime/utils": { appendTestAttrWithoutCheck: () => ({}) }, "@ekp-infra/common": { Api: { build: () => () => { throw Error("No network in native fixtures."); } }, Module: { getComponent: () => null } }, "@ekp-infra/render": { CellComponent: "CellComponent" } };
    vm.runInNewContext(fixture("xform-" + name + ".js.txt"), { exports: exp, module: { exports: exp }, require(name) { assert.ok(name in dependencies); return dependencies[name]; }, mk: { getI18nInfo: () => "", emit() {} }, window: {} });
    modules["@elem/xform-" + name] = exp;
  }
  return { React, render, cycle, unmount, modules, Radio, actions, base };
}
function all(tree, predicate, results = []) { if (!tree || typeof tree !== "object") return results; if (Array.isArray(tree)) { tree.forEach(node => all(node, predicate, results)); return results; } if (predicate(tree)) results.push(tree); (tree.children || []).forEach(node => all(node, predicate, results)); return results; }
function setup(extra = {}) {
  const h = harness(), rows = [{ key: "a", params: "first" }, { key: "b", params: "second" }], columns = [{ key: "params-key", type: "@elem/xform-textarea", controlProps: { name: "params", placeholder: "default", editable: true }, options: { validateRules: [{ required: true }, { min: 2 }] } }], props = { columns };
  const MKXFORM = { getValue: () => rows, $: () => ({ getSelf: () => ({ props }) }), setProps: (_, next) => Object.assign(props, next) };
  const bridge = createNativeDetailControlBridge({ MKXFORM, React: h.React, getRows: () => rows, loader: { getModule: name => h.modules[name] }, ...extra });
  return { ...h, rows, columns, props, MKXFORM, bridge };
}
function cellProps(key = "a") { return { rowKey: key, rowIndex: 0, name: "items.params", id: "items.params~" + key, $$tableName: "items", $$tableType: "detail", showStatus: "edit", editable: true, value: "text", onChange() {} }; }

test("installs only runtime column component props and preserves all validators and unrelated columns", () => {
  const s = setup(); const original = s.columns[0]; s.bridge.installTable("items", ["params"]);
  assert.equal(s.props.columns[0].type, original.type); assert.equal(s.props.columns[0].options, original.options); assert.equal(s.props.columns[0].controlProps.placeholder, "default"); assert.equal(typeof s.props.columns[0].controlProps.type, "function"); assert.equal(original.controlProps.type, undefined);
});

test("unchanged native detail render selects controlProps.type and forwards stable row identity", () => {
  const s = setup(); s.bridge.installTable("items", ["params"]); const c = s.props.columns[0], records = [{ key: "b", "items.params": "second" }], updates = [], rest = (o, names) => Object.fromEntries(Object.entries(o).filter(([key]) => !names.includes(key)));
  const env = { y: (o, key, value) => (o[key] = value, o), cn: "version", t: s.React, p: s.React, md: "NativeCell", M: rest, _: "items.params", Lr: {}, l: c.controlProps, _t: "edit", Sa: false, W: {}, q: "items", Pa: () => null, Dr: {}, Mr: {}, P: c.options.validateRules, ko: { current: records }, ci: (_, value) => ({ value }), a: c.type, J: "items.params", wa: { current: 3 }, Ea: 10, Co: { current: { columnDataMap: {} } }, be: null, Ie: 0, vt: "items", L: null, j: {}, e: c, ja: null, Ta: [], Ca() {}, tr() {}, nr() {}, lt: {}, nn: {}, rn: "desktop", on: "app", an: "app", ln: "form", mt: false, $e: {}, C: "params", rt: {}, Y: "edit", un: "doc", ht: false, fe: null, X: "entity", Ge() {}, ot: {}, Oa: {}, ua: (patch, key) => updates.push({ patch, key }), Q: "edit", bn: {}, at: {}, it: null, ct() {}, Io: { current: [] }, ye() {}, o: "Encrypt", V: null, Kn: { current: false }, Ln() {} };
  const native = vm.runInNewContext("(" + fixture("detail-render.js.txt") + ")", env), node = all(native("second", records[0], 1), n => n.type === "NativeCell")[0];
  assert.equal(node.props.type, c.controlProps.type); assert.equal(node.props.$$componentID, "@elem/xform-textarea"); assert.equal(node.props.rowKey, "b"); assert.equal(node.props.rowIndex, 21); node.props.onChange("changed"); assert.equal(updates[0].key, "b"); assert.equal(updates[0].patch["items.params"], "changed");
});

test("row properties are sticky, isolated, survive reordering and remount, and never follow old indexes", () => {
  const s = setup(); s.bridge.installTable("items", ["params"]); const Wrapped = s.props.columns[0].controlProps.type;
  s.bridge.setRowProps("items", 0, "params", { placeholder: "A", display: "none" }); s.bridge.setRowProps("items", 1, "params", { placeholder: "B" });
  function input(key) { return s.cycle(() => { const outer = s.render(Wrapped, cellProps(key), key), child = outer.children[0], native = s.render(child.type, child.props, key + "-native"); return { outer, input: all(native, n => n.type === "NativeTextArea")[0] }; }); }
  assert.equal(input("a").input.props.placeholder, "A"); assert.equal(input("a").outer.props.style.display, "none"); assert.equal(input("b").input.props.placeholder, "B");
  s.rows.reverse(); s.bridge.setRowProps("items", 0, "params", { display: "" }); assert.equal(input("b").input.props.placeholder, "B"); assert.equal(input("a").outer.props.style.display, "none");
  s.unmount("b"); s.unmount("b-native"); assert.equal(input("b").input.props.placeholder, "B"); s.rows.splice(1, 1); s.bridge.prune("items"); s.rows.push({ key: "new" }); assert.deepEqual(s.bridge.getCellProps({ tableId: "items", fieldId: "params", rowKey: "new" }), {});
});

test("native textarea retains value writer, validation-related props, actions and focus events", () => {
  const s = setup(); const Wrapped = s.bridge.component({ tableId: "items", fieldId: "params", nativeType: "@elem/xform-textarea" }), changes = [], props = { ...cellProps(), extraAuth: { editable: false }, controlActions: { onFocus: [{}], onChange: [{}] }, onChange: v => changes.push(v) };
  const tree = s.cycle(() => { const child = s.render(Wrapped, props).children[0]; assert.equal(child.props.extraAuth, props.extraAuth); assert.equal(child.props.controlActions, props.controlActions); return s.render(child.type, child.props); }), input = all(tree, n => n.type === "NativeTextArea")[0], event = { target: { value: "hello" } };
  input.props.onChange(event); input.props.onFocus(event); assert.deepEqual(changes, ["hello"]); assert.equal(s.actions[0][2], "onChange"); assert.equal(s.actions[1][2], "onFocus"); assert.equal(s.actions[1][3], event);
});

test("native repeated radio toggle is normalized through its actual handler; post-click callbacks are ordered and checked state recovers", () => {
  const calls = [], s = setup({ onRadioClick: event => calls.push(["dispatch", value, event.value], ["display", value, event.value]) }); let value = "a";
  const Wrapped = s.bridge.component({ tableId: "items", fieldId: "choice", nativeType: "@elem/xform-radio" }), options = [{ label: "A", value: "a" }, { label: "B", value: "b" }];
  const props = { ...cellProps(), name: "items.choice", value, options, optionSource: "custom", serialType: "empty", onChange: next => { value = next; props.value = next; calls.push(["submit", next]); } };
  function tree() { return s.cycle(() => { const outer = s.render(Wrapped, props), child = outer.children[0]; return { outer, native: s.render(child.type, child.props) }; }); }
  for (const chosen of ["a", "b", "b", "a"]) {
    const before = tree(), event = { target: { type: "radio", name: props.name, value: chosen }, detail: chosen === "a" ? 0 : 1 }; calls.length = 0;
    before.outer.props.onClickCapture(event); all(before.native, n => n.type === s.Radio && n.props.value === chosen)[0].props.onClick(event);
    assert.equal(value, chosen); assert.deepEqual(calls, [["submit", chosen], ["dispatch", chosen, chosen], ["display", chosen, chosen]]); assert.equal(all(tree().native, n => n.type === "NativeRadioGroup")[0].props.value, chosen);
  }
});

test("radio label pre-click, readonly and unrelated targets do not create source click intents", () => {
  const calls = [], s = setup({ onRadioClick: event => calls.push(event) }), Wrapped = s.bridge.component({ tableId: "items", fieldId: "choice", nativeType: "@elem/xform-radio" });
  const props = { ...cellProps(), name: "items.choice", options: [{ label: "A", value: "a" }], optionSource: "custom" }, outer = s.render(Wrapped, props), child = outer.children[0];
  for (const target of [{ tagName: "SPAN" }, { type: "radio", name: "other", value: "a" }, { type: "radio", name: props.name, value: "a", disabled: true }]) { outer.props.onClickCapture({ target }); child.props.onChange(null); }
  assert.deepEqual(calls, []); assert.throws(() => outer.props.onClickCapture({ target: { type: "radio", name: props.name, value: "unknown" } }), /unproven/);
});

test("unsupported property mutation, missing row identity, advanced radio layout and competing native actions fail closed", () => {
  const s = setup({ onRadioClick() {} }); s.bridge.installTable("items", ["params"]);
  assert.throws(() => s.bridge.setRowProps("items", 0, "params", { required: false }), /outside/); assert.throws(() => s.bridge.setRowProps("items", 0, "params", { display: "block" }), /outside/);
  s.rows.push({ key: "a" }); assert.throws(() => s.bridge.setRowProps("items", 0, "params", { placeholder: "x" }), /ambiguous/); s.rows.pop();
  assert.throws(() => s.bridge.component({ tableId: "items", fieldId: "choice", nativeType: "@elem/xform-attach" }), /outside/);
  const Radio = s.bridge.component({ tableId: "items", fieldId: "choice", nativeType: "@elem/xform-radio" }), p = { ...cellProps(), name: "items.choice", options: [{ value: "a" }] };
  assert.throws(() => s.render(Radio, { ...p, align: "left" }), /outside/); assert.throws(() => s.render(Radio, { ...p, controlActions: { onChange: [{}] } }), /owned/);
  s.bridge.dispose(); assert.throws(() => s.bridge.setRowProps("items", 0, "params", {}), /disposed/);
});

test("requires an explicit verified row reader and rejects missing modules and unsupported runtime types", () => {
  const s = setup(), deps = { MKXFORM: s.MKXFORM, React: s.React, loader: { getModule: () => undefined } };
  assert.throws(() => createNativeDetailControlBridge(deps), /rows reader/);
  const missing = createNativeDetailControlBridge({ ...deps, getRows: () => s.rows });
  assert.throws(() => missing.installTable("items", ["params"]), /not loaded/);
  assert.equal(s.props.columns, s.columns);
  assert.throws(() => missing.component({ tableId: "items", fieldId: "params", nativeType: "@elem/xform-input" }), /not loaded/);
});

test("invalid row keys, row indexes and removed rows cannot mutate a surviving cell", () => {
  const s = setup(); s.bridge.installTable("items", ["params"]);
  for (const index of [-1, 0.5, Infinity, "0", 3]) assert.throws(() => s.bridge.setRowProps("items", index, "params", { placeholder: "invalid" }), /index/);
  for (const key of [null, undefined, "", {}, NaN]) assert.throws(() => s.bridge.setCellProps({ tableId: "items", fieldId: "params", rowKey: key }, { placeholder: "invalid" }), /identity/);
  s.rows.shift(); assert.throws(() => s.bridge.setCellProps({ tableId: "items", fieldId: "params", rowKey: "a" }, { placeholder: "invalid" }), /no longer/);
  assert.deepEqual(s.bridge.getCellProps({ tableId: "items", fieldId: "params", rowKey: "b" }), {});
  s.rows.push({}); assert.throws(() => s.bridge.setRowProps("items", 0, "params", { placeholder: "invalid" }), /identity/);
  s.rows.splice(0, s.rows.length, { key: 1 }, { key: "1" }); assert.throws(() => s.bridge.setRowProps("items", 0, "params", { placeholder: "mixed-key collision" }), /ambiguous/); assert.equal(typeof s.rows[0].key, "number"); assert.equal(typeof s.rows[1].key, "string");
});

test("failed and repeated installations revalidate all columns without allocating missing-cell state", () => {
  const s = setup(); assert.throws(() => s.bridge.installTable("items", ["params", "missing"]), /missing/);
  assert.equal(s.props.columns, s.columns); assert.throws(() => s.bridge.setRowProps("items", 0, "params", { placeholder: "not installed" }), /not installed/);
  s.bridge.installTable("items", ["params"]); const wrapper = s.props.columns[0].controlProps.type; s.bridge.installTable("items", ["params"]); assert.equal(s.props.columns[0].controlProps.type, wrapper);
  s.props.columns = []; assert.throws(() => s.bridge.installTable("items", ["params"]), /missing/); assert.deepEqual(s.props.columns, []);
});

test("radio click without native emission is cleared at bubble and does not consume a later programmatic change", () => {
  const emitted = [], events = [], s = setup({ onRadioClick: event => events.push(event) }), Wrapped = s.bridge.component({ tableId: "items", fieldId: "choice", nativeType: "@elem/xform-radio" });
  const props = { ...cellProps(), name: "items.choice", options: [{ value: "a" }], onChange: value => emitted.push(value) }, outer = s.render(Wrapped, props), child = outer.children[0], event = { target: { type: "radio", name: props.name, value: "a" } };
  outer.props.onClickCapture(event); outer.props.onClick({ ...event }); child.props.onChange("programmatic");
  assert.deepEqual(emitted, ["programmatic"]); assert.deepEqual(events, []);
});

test("radio stale rendered indexes resolve by row key, removed row clicks fail, and each native writer runs once", () => {
  const events = [], emitted = [], s = setup({ onRadioClick: event => events.push(event) }), Wrapped = s.bridge.component({ tableId: "items", fieldId: "choice", nativeType: "@elem/xform-radio" });
  const props = { ...cellProps("b"), rowIndex: 91, name: "items.choice", options: [{ value: "a" }], onChange: value => emitted.push(value) }, outer = s.render(Wrapped, props), child = outer.children[0], event = { target: { type: "radio", name: props.name, value: "a" } };
  s.rows.reverse(); outer.props.onClickCapture(event); child.props.onChange(null); outer.props.onClick(event);
  assert.deepEqual(emitted, ["a"]); assert.equal(events.length, 1); assert.equal(events[0].rowKey, "b"); assert.equal(events[0].rowIndex, 0);
  s.rows.shift(); assert.throws(() => outer.props.onClickCapture(event), /no longer/); assert.equal(events.length, 1);
});

test("unchanged native cell wrapper accepts the component override and preserves native properties", () => {
  const s = setup(); const Wrapped = s.bridge.component({ tableId: "items", fieldId: "params", nativeType: "@elem/xform-textarea" }), rest = (o, names) => Object.fromEntries(Object.entries(o).filter(([key]) => !names.includes(key)));
  const md = vm.runInNewContext("(" + fixture("detail-cell.js.txt") + ")", { t: s.React, p: s.React, n: s.base, M: rest, y: (o, key, value) => (o[key] = value, o), pd: type => s.modules[type]?.default });
  const nativeProps = { ...cellProps(), type: Wrapped, errors: {}, controlActions: { onFocus: [{}] }, extraAuth: { editable: true } }, result = s.render(md, nativeProps), child = all(result, n => n.type === Wrapped)[0];
  assert.ok(child); assert.equal(child.props.rowKey, "a"); assert.equal(child.props.controlActions, nativeProps.controlActions); assert.equal(child.props.extraAuth, nativeProps.extraAuth); assert.equal(child.props.value, nativeProps.value);
  const nativeStringResult = s.render(md, { ...nativeProps, type: "@elem/xform-textarea" }); assert.ok(all(nativeStringResult, node => node.type === s.modules["@elem/xform-textarea"].default)[0]);
  s.bridge.component({ tableId: "items", fieldId: "choice", nativeType: "@elem/xform-radio" }); assert.throws(() => s.bridge.setRowProps("items", 0, "choice", { placeholder: "ignored by native" }), /outside/);
});

test("installation preserves foreign component overrides and accepts only the proven native string or owned wrapper", () => {
  const s = setup(); function ExistingControl() {} s.columns[0].controlProps.type = ExistingControl;
  assert.throws(() => s.bridge.installTable("items", ["params"]), /unowned/); assert.equal(s.props.columns[0].controlProps.type, ExistingControl);
  assert.throws(() => s.bridge.setRowProps("items", 0, "params", { placeholder: "not installed" }), /not installed/);
  s.columns[0].controlProps.type = s.columns[0].type; s.bridge.installTable("items", ["params"]); const owned = s.props.columns[0].controlProps.type;
  s.bridge.installTable("items", ["params"]); assert.equal(s.props.columns[0].controlProps.type, owned);
  s.props.columns[0].controlProps.type = ExistingControl; assert.throws(() => s.bridge.installTable("items", ["params"]), /unowned/); assert.equal(s.props.columns[0].controlProps.type, ExistingControl);
});
