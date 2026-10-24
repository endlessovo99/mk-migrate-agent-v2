import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { test } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, formAttr, xformConfig } from "../helpers/persistence.js";
import { withDetailEventReadBridge } from "../../src/executor/persistence/detail-event-read-bridge.js";

const fixture = "tests/fixtures/route-validation/detail-event-live-table-read/route-detail-event-live-table-read_SysFormTemplate.xml";
const abi = JSON.parse(readFileSync(new URL("../fixtures/route-validation/detail-event-live-table-read/native-contract.json", import.meta.url)));
const basis = "deterministic-allowance-calculation";
const column = "fd_receipt_value";

function route() {
  const draft = draftSourceDraft(cleanSourceFile(fixture));
  return { ...draft, scripts: { ...draft.scripts, actions: draft.scripts.actions.filter(action => action.functionMappings?.some(mapping => mapping.basis === basis)) } };
}

// These are the captured native number, row-write, Ko, row formatter and queue
// functions. Only the FormBuilder publication boundary and timers are inert hosts.
function nativeEventHost(prepared, { mode = 0, amounts = [1.23, 2.34], state: overrides = {}, shared, formId = "source-form" } = {}) {
  const config = xformConfig(prepared.update);
  const table = config.dataModel.find(model => model.dynamicProps?.detailFieldName === "fd_receipts").fdTableName;
  const control = formAttr(prepared.update).controlAction.control;
  const window = shared?.window || {}, clock = shared?.clock || { timers: new Map(), sequence: 0, time: 0 };
  const timers = clock.timers, errors = [], writes = [], events = [], tableReads = [];
  let pendingPublication;
  const state = { fd_trip_mode: mode, fd_trip_start: "2026-10-22 08:00:00", fd_trip_end: "2026-10-22 18:00:00", fd_people: 1, fd_package_mode: "0", ...overrides };
  const ko = { current: amounts.map((value, index) => ({ key: index, [`${table}.${column}`]: value })) };
  const clone = value => structuredClone(value);
  const context = vm.createContext({ window, mk: { getSysConfig: () => "desktop" }, console: { log() {}, error(error) { errors.push(error); } }, setTimeout(fn, delay) { const id = ++clock.sequence; timers.set(id, { at: clock.time + delay, fn }); return id; }, clearTimeout(id) { timers.delete(id); } });
  const native = (name, bindings = {}) => vm.runInContext(`(function(${Object.keys(bindings).join(",")}){return (${abi.functions[name].text});})`, context)(...Object.values(bindings));
  const defineProperty = (object, key, value) => { object[key] = value; return object; };
  const flush = native("flush", { S: Array.from });
  const register = native("register", { O: defineProperty, du: flush });
  const debounce = native("debounce");
  const nativeBase = { actionFunsRunner: register, actionRunner: flush };
  const formatRows = native("formatRows", { c: undefined, r: table, u: {}, T: Array.from });
  const format = native("formatTable", { eo: formatRows, Ao: {}, Do: { current: [] } });
  let published = format(ko.current);
  const registry = { current: {} }, props = { name: table };
  // Execute the actual useControls reference registration and native table's
  // imperative factory, then the actual SDK initializer. No SDK registry is
  // assigned by the host; only React ref creation/commit and API transport adapt.
  const detailRef = vm.runInContext(`(function(r,eA,y,i,em){var l;${abi.functions.registerDetailRef.text};return y.$$ref;})`, context)({ createRef: () => ({ current: null }) }, registry, props, {}, false);
  const imperative = native("tableHandle", { qo: format, ko, q: table });
  const reactHost = { useImperativeHandle(ref, factory) { ref.current = factory(); } };
  reactHost.useImperativeHandle(detailRef, imperative);
  const plugin = { default: { apis: [] } };
  const init = native("initRuntime", { A: { register() {} }, v: plugin, a: plugin, c: plugin, r: plugin, i: plugin, u: plugin, o: plugin, d: plugin });
  const api = init({ $$form: { current: {} }, $$detailForms: registry, mode: "add", dataModels: config.dataModel, formId });
  Object.assign(api, { getValue(key) { if (key === table) tableReads.push(published); return key === table ? published : state[key]; }, setValue(key, value) { writes.push({ key, value }); state[key] = value; } });
  context.MKXFORM = api;
  const actions = {};
  for (const [key, byEvent] of Object.entries(control)) {
    actions[key] = Object.fromEntries(Object.entries(byEvent).map(([event, entries]) => [event, entries.map(entry => ({ ...entry, function: vm.runInContext(`(${entry.function})`, context) }))]));
  }
  const aa = { current: {} }, xo = { current: [] };
  const changed = native("changed", { ko, aa, R: (values, length) => values.slice(0, length) });
  const publish = native("publish", { qo: format, ko, De(data) { events.push("native-parent-publication-request"); pendingPublication = data; }, T: Array.from, xo, po() {}, $e: actions, q: table, n: nativeBase, aa });
  const oa = debounce(publish, 200);
  const rowWrite = native("rowWrite", { nn: { current: { [`detail-dataref-${table}`]: ko } }, q: table, ko, ia: changed, Ot: { current: {} }, Yt: "normal", la() { assert.fail("popup is outside this route"); }, xo, G: {}, na() { assert.fail("dynamic row rule is outside this route"); }, Go: null, Xo: null, Wo: null, oa });
  function input(rowIndex, value, field = column) {
    const key = ko.current[rowIndex].key;
    const handler = native("input", { oe: { current: {} }, ce() {}, ne: value => value, d(value) { rowWrite({ [`${table}.${field}`]: value }, key); }, w: actions[`${table}.${field}`], t: nativeBase, E: `${table}.${field}~${key}`, S: table, _: "detail", M: rowIndex, K: undefined });
    handler(value);
  }
  function settle(beforeDispatch) {
    let inspected = false;
    for (let step = 0; timers.size && step < 50; step++) {
      const [id, task] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!inspected && task.at > 200) { inspected = true; beforeDispatch?.(window.MXFORM_ACTIONS); }
      timers.delete(id); clock.time = task.at; task.fn();
    }
    assert.equal(timers.size, 0, "native queue must settle without an injected retry timer");
    assert.deepEqual(errors, []);
  }
  function step() {
    const [id, task] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    timers.delete(id); clock.time = task.at; task.fn();
    assert.deepEqual(errors, []);
  }
  return { table, api, registry, detailRef, errors, state, writes, events, actions, ko, tableReads, input, settle, step, get published() { return published; }, commit() { published = clone(pendingPublication); } };
}

test("the real producer and native event queue read the complete fresh Ko snapshot before public publication", () => {
  const dsl = route();
  const before = JSON.stringify(dsl);
  const prepared = prepareSample(dsl);
  const h = nativeEventHost(prepared);
  h.input(1, 4.56);
  h.settle();
  assert.deepEqual(h.published.values.map(row => row[column]), [1.23, 2.34], "the host store intentionally has not committed");
  assert.equal(h.state.fd_receipt_result, 5.79, "source receipt calculation must read the full native event snapshot");
  assert.equal(h.api.$$DETAILFORMS, h.registry, "native initRuntime binds this SDK to its registered refs");
  assert.equal(h.api.$$DETAILFORMS.current[h.table], h.detailRef);
  assert.deepEqual(Array.from(h.detailRef.current.getLatestValue().values, row => row[column]), [1.23, 4.56]);
  h.commit();
  assert.deepEqual(h.published.values.map(row => row[column]), [1.23, 4.56]);
  assert.equal(h.state.fd_receipt_result, 5.79);
  assert.equal(h.tableReads.length, 0, "success must hit the native latest-value getter, never fallback");
  assert.equal(h.writes.filter(write => write.key === "fd_receipt_result").length, 1);
  assert.equal(JSON.stringify(dsl), before, "public DSL/source calculation is immutable");
  assert.equal(prepared.verify(prepared.update).ok, true);
});

test("two pending rows use one complete native snapshot, never a scalar overlay over an old table", () => {
  const h = nativeEventHost(prepareSample(route()));
  h.input(0, 9.87); h.input(1, 4.56); h.settle();
  assert.deepEqual(h.published.values.map(row => row[column]), [1.23, 2.34]);
  assert.equal(h.state.fd_receipt_result, 14.43);
  assert.deepEqual(h.writes.filter(write => write.key === "fd_receipt_result").map(write => write.value), [14.43, 14.43]);
});

for (const commitFirst of [false, true]) {
  test(`a second-row input between native publish and old flush: first commit=${commitFirst}`, () => {
    const h = nativeEventHost(prepareSample(route()));
    h.input(0, 9.87); h.step();
    if (commitFirst) h.commit();
    h.input(1, 4.56); h.settle(); h.commit();
    assert.deepEqual(h.published.values.map(row => row[column]), [9.87, 4.56]);
    assert.equal(h.state.fd_receipt_result, 14.43, `first frame committed=${commitFirst}`);
  });
}

test("an unrelated-column first frame cannot consume the later receipt owner's only recalculation", () => {
  const h = nativeEventHost(prepareSample(route()));
  h.input(0, 7, "fd_receipt_kind"); h.step(); h.commit();
  h.input(1, 4.56); h.settle(); h.commit();
  assert.deepEqual(h.published.values.map(row => row[column]), [1.23, 4.56]);
  assert.equal(h.state.fd_receipt_result, 5.79);
});

test("the complete source body retains cap, coupled effects and their order", () => {
  for (const scenario of [
    { mode: 0, amounts: [1.23, 2.34], next: 0 },
    { mode: 1, amounts: [150, 75], next: 350 },
    { mode: 1, amounts: [150, 75], next: 5, state: { fd_package_mode: "1", fd_radiation_allowance: 7 } }
  ]) {
    const dsl = route(), h = nativeEventHost(prepareSample(dsl), scenario);
    h.input(1, scenario.next); h.settle();
    const action = dsl.scripts.actions.find(action => action.tableId === "fd_receipts" && action.controlId === column);
    const oracleWrites = [], oracle = { viewStatus: "add", getValue(key) { return key === "${table:fd_receipts}" ? { values: h.ko.current.map(row => ({ [column]: row[`${h.table}.${column}`] })) } : h.state[key]; }, setValue(key, value) { oracleWrites.push({ key, value }); } };
    vm.runInNewContext(`(${action.function})`, { MKXFORM: oracle })(scenario.next, 1);
    assert.deepEqual(h.writes, oracleWrites, "all original setters execute once in original order");
  }
});

test("the latest-value bridge and original body are independently checked without synthetic events", () => {
  const prepared = prepareSample(route());
  const config = xformConfig(prepared.update), attr = formAttr(prepared.update);
  const table = config.dataModel.find(model => model.dynamicProps?.detailFieldName === "fd_receipts").fdTableName;
  assert.equal(attr.controlAction.control[`${table}.${table}`], undefined);
  for (const mutate of [
    attr => { delete attr.controlAction.control[`${table}.${column}`].onChange; },
    attr => { const action = attr.controlAction.control[`${table}.${column}`].onChange[0]; action.function = action.function.replaceAll(table, "wrong_snapshot_table"); },
    attr => { const action = attr.controlAction.control[`${table}.${column}`].onChange[0]; action.function = action.function.replace('MKXFORM.viewStatus !== "add"', 'MKXFORM.viewStatus !== "view"'); },
    attr => { const action = attr.controlAction.control[`${table}.${column}`].onChange[0]; action.function = action.function.replace("receiptTotal + Number", "receiptTotal + 1 + Number"); },
    attr => { attr.controlAction.control[`${table}.${table}`] = { onDetailChange: [{ id: "unrelated", function: "function unrelated() {}" }] }; }
  ]) {
    const changed = structuredClone(prepared.update), nextConfig = xformConfig(changed), nextAttr = JSON.parse(nextConfig.attribute.formAttr);
    mutate(nextAttr); nextConfig.attribute.formAttr = JSON.stringify(nextAttr); changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(nextConfig);
    assert.equal(prepared.verify(changed).ok, false);
  }
});

test("captured native ABI excerpts retain their hashes", () => {
  for (const value of Object.values(abi.functions)) assert.equal(createHash("sha256").update(value.text).digest("hex"), value.sha256);
  assert.equal(abi.assets.base.sha256, "b4f4b7e2ca8a11f79542321d001853890a44c4676edbfe661466f6ebc5678d4a");
  assert.match(abi.functions.tableHandle.text, /getLatestValue:function\(\)\{return qo\(ko.current\)\}/);
  assert.match(abi.functions.initRuntime.text, /j\.\$\$DETAILFORMS=l/);
  assert.match(abi.functions.registerDetailRef.text, /\$\$ref:eA.current\[h\]/);
});

test("missing or mismatching native handle, queue owner or row cannot authorize a live read", () => {
  for (const tamper of [
    (queue, h) => { delete h.registry.current[h.table]; },
    (queue, h) => { h.detailRef.current.getTableName = () => "other_table"; },
    (queue, h) => { queue[`${h.table}.${column}~1`].actionTableName = "other_table"; },
    (queue, h) => { h.ko.current[1].key = "other_row"; },
    (queue, h) => { delete h.ko.current[1][`${h.table}.${column}`]; }
  ]) {
    const h = nativeEventHost(prepareSample(route()));
    h.input(1, 4.56); h.settle(queue => tamper(queue, h));
    assert.equal(h.state.fd_receipt_result, 3.57, "nonmatching context retains existing reads and is not a repair pass");
    assert.ok(h.tableReads.length > 0);
  }
});

test("each native-initialized SDK reads its own table when two forms share one native queue", () => {
  const shared = { window: {}, clock: { timers: new Map(), sequence: 0, time: 0 } };
  const first = nativeEventHost(prepareSample(route()), { shared, formId: "form-A" });
  const second = nativeEventHost(prepareSample(route()), { shared, formId: "form-B", amounts: [100, 200] });
  assert.notEqual(first.api.$$DETAILFORMS, second.api.$$DETAILFORMS);
  assert.equal(first.api.$$DETAILFORMS, first.registry);
  assert.equal(second.api.$$DETAILFORMS, second.registry);
  shared.window.MKXFORM = second.api;
  first.input(0, 9.87); second.input(1, 400); first.settle();
  assert.equal(first.state.fd_receipt_result, 12.21);
  assert.equal(second.state.fd_receipt_result, 500);
  assert.equal(first.tableReads.length + second.tableReads.length, 0);
  assert.deepEqual(second.errors, []);
});

test("an unrelated column event adds no business recalculation and guards still stop the source body", () => {
  const h = nativeEventHost(prepareSample(route()));
  h.input(1, 7, "fd_receipt_kind"); h.settle();
  assert.deepEqual(h.writes, []);
  const stopped = nativeEventHost(prepareSample(route()));
  stopped.api.viewStatus = "view";
  stopped.input(1, 4.56); stopped.settle();
  assert.deepEqual(stopped.writes, []);
});

test("same-control source action order, main read-after-write, this, arguments and return survive projection", () => {
  const dsl = route(), receipt = dsl.scripts.actions.find(action => action.tableId === "fd_receipts" && action.controlId === column);
  const first = { ...receipt, id: "source-before", deterministicBranchProof: undefined, function: 'function onChange(value, rowNum, parentRowNum) { MKXFORM.setValue("fd_people", 2); return this.marker; }' };
  const last = { ...receipt, id: "source-after", deterministicBranchProof: undefined, function: 'function onChange(value, rowNum, parentRowNum) { MKXFORM.setValue("fd_grand_total", MKXFORM.getValue("fd_receipt_result")); return arguments[0]; }' };
  dsl.scripts.actions = [first, receipt, last];
  const h = nativeEventHost(prepareSample(dsl), { mode: 1, amounts: [150, 75] });
  const group = h.actions[`${h.table}.${column}`].onChange;
  assert.deepEqual(group.map(action => action.id), [first.id, receipt.id, last.id]);
  group[0].marker = "original-this";
  assert.equal(group[0].function.call(group[0], 4.56, 1), "original-this");
  assert.equal(group[2].function.call(group[2], 4.56, 1), 4.56);
  h.writes.length = 0;
  h.input(1, 350); h.settle();
  assert.equal(h.state.fd_receipt_result, 200, "receipt body reads the preceding source action's new people value");
  assert.deepEqual(h.writes.map(write => write.key), ["fd_people", "fd_overnights", "fd_allowance_days", "fd_daily_rate", "fd_regular_allowance", "fd_package_allowance", "fd_allowance_total", "fd_receipt_result", "fd_grand_total"]);
  assert.equal(h.state.fd_grand_total, 200);
});

test("unproved, foreign, global or own-table-mutating groups remain byte-for-byte unchanged", () => {
  for (const change of [
    actions => { actions[0].sourceRefs = []; },
    actions => { actions[0].function = actions[0].function.replace('${table:fd_receipts}', '${table:foreign_table}'); actions[0].deterministicBranchProof.functionSha256 = createHash("sha256").update(actions[0].function).digest("hex"); },
    actions => { actions[0].scope = "global"; },
    actions => { actions.push({ ...actions[0], id: "table-mutator", function: 'function onChange(value, rowNum) { MKXFORM.setDetailValues("${table:fd_receipts}", []); }' }); }
  ]) {
    const dsl = route(), action = dsl.scripts.actions.find(action => action.tableId === "fd_receipts" && action.controlId === column);
    const scripts = { ...dsl.scripts, actions: [structuredClone(action)] };
    change(scripts.actions);
    const before = JSON.stringify(scripts);
    assert.equal(withDetailEventReadBridge(scripts, dsl.form), scripts);
    assert.equal(JSON.stringify(scripts), before);
  }
});

for (const [index, functionText] of [
    'function onChange(value, rowNum) { var api = MKXFORM; api.setDetailValues("${table:fd_receipts}", []); }',
    'function onChange(value, rowNum) { var write = MKXFORM.setDetailValues; write("${table:fd_receipts}", []); }',
    'function onChange(value, rowNum) { MKXFORM.setDetailValues.call(MKXFORM, "${table:fd_receipts}", []); }',
    'function onChange(value, rowNum) { MKXFORM.setDetailValues.apply(MKXFORM, ["${table:fd_receipts}", []]); }'
  ].entries()) {
  test(`indirect or escaped MKXFORM sibling write ${index + 1} cannot qualify`, () => {
    const dsl = route(), receipt = dsl.scripts.actions.find(action => action.tableId === "fd_receipts" && action.controlId === column);
    const scripts = { ...dsl.scripts, actions: [receipt, { ...receipt, id: "indirect-table-writer", deterministicBranchProof: undefined, function: functionText }] };
    assert.equal(withDetailEventReadBridge(scripts, dsl.form) === scripts, true, functionText);
  });
}

test("an opaque sibling constructor cannot qualify the source action group", () => {
  const dsl = route(), receipt = dsl.scripts.actions.find(action => action.tableId === "fd_receipts" && action.controlId === column);
  const scripts = { ...dsl.scripts, actions: [receipt, { ...receipt, id: "opaque-constructor", deterministicBranchProof: undefined, function: "function onChange(value, rowNum) { new TableWriter(); }" }] };
  assert.equal(withDetailEventReadBridge(scripts, dsl.form) === scripts, true);
});

for (const [name, functionText] of [
  ["dynamic constructor", "function onChange(value, rowNum) { new constructors[value](); }"],
  ["member constructor", "function onChange(value, rowNum) { new namespace.Date(); }"],
  ["parameter shadow", "function onChange(value, rowNum, Date) { var raw = MKXFORM.getValue('fd_trip_start'); var stamp = new Date(String(raw).replace(/-/g, '/')); }"],
  ["function shadow", "function onChange(value, rowNum) { function Date() {} var raw = MKXFORM.getValue('fd_trip_start'); var stamp = new Date(String(raw).replace(/-/g, '/')); }"],
  ["catch pattern shadow", "function onChange(value, rowNum) { try {} catch ({ Date }) { var raw = MKXFORM.getValue('fd_trip_start'); var stamp = new Date(String(raw).replace(/-/g, '/')); } }"],
  ["global replacement", "function onChange(value, rowNum) { Date = TableWriter; var raw = MKXFORM.getValue('fd_trip_start'); var stamp = new Date(String(raw).replace(/-/g, '/')); }"],
  ["unproved argument", "function onChange(value, rowNum) { var stamp = new Date(value); }"],
  ["unproved numeric argument", "function onChange(value, rowNum) { var stamp = new Date(0); }"],
  ["mutated raw value", "function onChange(value, rowNum) { var raw = MKXFORM.getValue('fd_trip_start'); raw = value; var stamp = new Date(String(raw).replace(/-/g, '/')); }"],
  ["dynamic replacement", "function onChange(value, rowNum) { var raw = MKXFORM.getValue('fd_trip_start'); var stamp = new Date(String(raw).replace(/-/g, value)); }"],
  ["method escape", "function onChange(value, rowNum) { var raw = MKXFORM.getValue('fd_trip_start'); var stamp = new Date(String(raw).replace(/-/g, '/')); MKXFORM.setValue('fd_people', stamp.getTime); }"],
  ["instance replacement", "function onChange(value, rowNum) { var raw = MKXFORM.getValue('fd_trip_start'); var stamp = new Date(String(raw).replace(/-/g, '/')); stamp = value; stamp.getTime(); }"],
  ["unsafe method argument", "function onChange(value, rowNum) { var raw = MKXFORM.getValue('fd_trip_start'); var stamp = new Date(String(raw).replace(/-/g, '/')); stamp.setHours(value); }"],
  ["String parameter shadow", "function onChange(value, rowNum, String) { var raw = MKXFORM.getValue('fd_trip_start'); var stamp = new Date(String(raw).replace(/-/g, '/')); }"],
  ["block shadow", "function onChange(value, rowNum) { { let Date = TableWriter; var raw = MKXFORM.getValue('fd_trip_start'); var stamp = new Date(String(raw).replace(/-/g, '/')); } }"],
  ["raw binding collision", "function onChange(value, rowNum) { var raw = MKXFORM.getValue('fd_trip_start'); { let raw = value; var stamp = new Date(String(raw).replace(/-/g, '/')); } }"],
  ["foreign function date binding", "function onChange(value, rowNum) { function nested() { var raw = MKXFORM.getValue('fd_trip_start'); var stamp = new Date(String(raw).replace(/-/g, '/')); } stamp.getTime(); }"]
]) {
  test(`an unproved Date construction or escape (${name}) cannot qualify`, () => {
    const dsl = route(), receipt = dsl.scripts.actions.find(action => action.tableId === "fd_receipts" && action.controlId === column);
    const scripts = { ...dsl.scripts, actions: [receipt, { ...receipt, id: "unproved-date", deterministicBranchProof: undefined, function: functionText }] };
    const before = JSON.stringify(scripts);
    assert.equal(withDetailEventReadBridge(scripts, dsl.form) === scripts, true, functionText);
    assert.equal(JSON.stringify(scripts), before);
  });
}

test("the unshadowed source Date recipe still qualifies without rewriting the sibling", () => {
  const dsl = route(), receipt = dsl.scripts.actions.find(action => action.tableId === "fd_receipts" && action.controlId === column);
  const sibling = { ...receipt, id: "source-date-recipe", deterministicBranchProof: undefined, function: "function onChange(value, rowNum) { var raw = MKXFORM.getValue('fd_trip_start'); var stamp = new Date(String(raw).replace(/-/g, '/')); stamp.setHours(0, 0, 0, 0); return stamp.getTime(); }" };
  const scripts = { ...dsl.scripts, actions: [receipt, sibling] }, projected = withDetailEventReadBridge(scripts, dsl.form);
  assert.notEqual(projected, scripts);
  assert.equal(projected.actions[1], sibling);
});
