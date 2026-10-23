import { readFileSync } from "node:fs";
import vm from "node:vm";

const contract = JSON.parse(readFileSync(new URL("../fixtures/route-validation/native-calculated-import/native-contract.json", import.meta.url)));
const big = {};
vm.runInNewContext(`var ${contract.BigFixture.text};Big=Ni;`, big);
const toFixed = vm.runInNewContext(`(${contract.toFixed.text.slice("t.toFixed=".length)})`);

// Execute the complete captured component. Only React's host and the formula
// transport/data adapters are simulated; no private request handler is replaced.
export function calculationRuntime(source) {
  const tasks = [], requests = [], callbacks = new Map(), writes = [], actions = [], errors = [];
  const table = "lines", main = "main", rows = [
    { key: "a", fd_order: 1, price: 100, qty: 0, amount: 0 },
    { key: "b", fd_order: 2, price: 25, qty: 0, amount: 0 }
  ];
  const values = { lines: { values: rows, dataState: {}, deleteState: [] }, "main.total": 0, "main.left": 100, "main.right": 0 };
  const controls = {
    lines: { key: table, type: "@elem/xform-detail-table", controlProps: { name: table, $$tableName: table, columns: ["price", "qty", "amount"].map(name => ({ key: name, type: "@elem/xform-number", controlProps: { name, $$tableName: table, $$tableType: "detail" } })) } },
    "main.left": { key: "main.left", controlProps: { name: "left", $$tableType: "main" } },
    "main.right": { key: "main.right", controlProps: { name: "right", $$tableType: "main" } }
  };
  const configFor = name => controls[name] || (name.includes(".") && controls.lines.controlProps.columns.find(col => col.controlProps.name === name.split(".").at(-1)));
  const form = { current: {
    getFormConfig: key => key ? configFor(key) : controls,
    getFieldsValue: key => key ? values[key] : values,
    customOnChange(handlers) {
      const entries = Object.entries(handlers);
      for (const [key, callback] of entries) callbacks.set(key, callback);
      return { deleteCustomEvent() { for (const [key, callback] of entries) if (callbacks.get(key) === callback) callbacks.delete(key); } };
    }
  } };
  const api = { dataModels: [{ fdType: "main", fdTableName: main, fdTableNameAlias: main }, { fdType: "detail", fdTableName: table, fdTableNameAlias: table }], docStatus: "10", businessFieldsValue: {} };
  const readVariables = (_form, rowKey, names) => Object.fromEntries(names.map(name => {
    if (name.startsWith("lines.")) return [name, rows.find(row => row.key === rowKey)?.[name.split(".")[1]] ?? 0];
    return [name, values[name.startsWith("main.") ? name : `main.${name}`] ?? 0];
  }));
  const base = {
    Big: big.Big, toFixed,
    getShowStatus: value => value === "readOnly" ? "view" : value,
    debounce(fn) { let pending = false; return () => { if (!pending) { pending = true; tasks.push(() => { pending = false; fn(); }); } }; },
    getNameByKey: (_form, key) => key,
    getConfigByName: (_form, name) => configFor(name),
    isSameTable: props => props.name.split(".")[0] === table,
    isNest: () => false,
    isDependenceEditable: () => true,
    getMainTableName: () => main,
    getVariableByFormula: (_form, formula) => [...formula.script.matchAll(/\$\{data\.biz\.([^}]+)\}/g)].map(match => match[1]),
    getFormulaVariableValue: readVariables,
    getValueByName: (_form, name) => name.startsWith("lines.") || name === "lines" ? rows : values[name.startsWith("main.") ? name : `main.${name}`],
    actionFunsRunner(info, _actions, event, value) { actions.push({ id: info.id, event, value }); },
    requestToFormulaExecute(_signature, script, input) {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      const request = { script, input: structuredClone(input), settled: false,
        complete(value) { request.settled = true; resolve({ data: { data: value } }); },
        malformed() { request.settled = true; resolve(undefined); }
      };
      requests.push(request);
      return promise;
    }
  };
  let host;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  function slot(kind, init) {
    const index = host.index++;
    if (!host.slots[index]) host.slots[index] = { kind, value: init() };
    if (host.slots[index].kind !== kind) throw new Error("Hook order changed");
    return host.slots[index];
  }
  const react = {
    useState(initial) { const item = slot("state", () => typeof initial === "function" ? initial() : initial); return [item.value, value => { item.value = typeof value === "function" ? value(item.value) : value; }]; },
    useRef(initial) { return slot("ref", () => ({ current: initial })).value; },
    useMemo(fn, deps) { const item = slot("memo", () => ({})); if (!same(item.deps, deps)) { item.value = fn(); item.deps = deps; } return item.value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const item = slot("effect", () => null); if (!same(item.deps, deps)) { item.deps = deps; item.effect = fn; host.effects.push(() => { item.cleanup?.(); item.cleanup = fn(); }); } },
    useImperativeHandle() {},
    createElement: (type, props, ...children) => ({ type, props, children })
  };
  react.default = react;
  class ObservedPromise extends Promise {
    static get [Symbol.species]() { return Promise; }
    constructor(executor) { super(executor); Promise.prototype.then.call(this, undefined, error => errors.push(error)); }
  }
  const exported = {};
  const dependencies = { exports: exported, react, "@elem/xform-base": base, "@elem/xform-view": () => null, "@elem/xform-headless": () => null };
  const define = (_name, names, factory) => factory(...names.map(name => {
    if (!(name in dependencies)) throw new Error(`Unexpected component dependency ${name}`);
    return dependencies[name];
  }));
  define.amd = true;
  vm.runInNewContext(source, { define, mk: { on() {}, off() {} }, console, Promise: ObservedPromise, Map, Set });
  function notify(key) { for (const callback of [...callbacks.values()]) callback({ [key]: values[key] }); }
  function mount(kind = "row", key = "a", overrides = {}) {
    const name = kind === "sum" ? "total" : kind === "main" ? "calculated" : "amount";
    const instance = { slots: [], effects: [], index: 0, kind, key, props: {
      id: `${kind}-${key}`, name, value: 0, valueType: { formatType: "decimal", precision: 2 },
      showStatus: "edit", currentStatus: "runtime", $$tableName: kind === "row" ? table : main,
      $$tableType: kind === "row" ? "detail" : "main", rowKey: kind === "row" ? key : undefined,
      rowIndex: kind === "row" ? rows.findIndex(row => row.key === key) : undefined,
      statisticMode: kind === "sum" ? "SUM" : "FORMULA", statisticData: kind === "sum" ? ["lines.amount"] : undefined,
      expressionFormulaVO: kind === "row" ? { type: "Eval", script: "${data.biz.lines.price} * ${data.biz.lines.qty}" } : { type: "Eval", script: "${data.biz.left} * ${data.biz.right}" },
      $$sign: { expressionFormulaVO: { value: "fixture-sign" } }, $$form: form, MKXFORM: api,
      controlActions: { onChange: [{ function() {} }] }, docId: "fixture-document", formId: "fixture-form",
      onChange(value) {
        writes.push({ id: instance.props.id, value });
        if (kind === "row") { const row = rows.find(row => row.key === instance.props.rowKey); if (row) row.amount = value; notify(table); }
        else { values[`main.${name}`] = value; notify(`main.${name}`); }
      }, ...overrides
    } };
    instance.render = changes => {
      Object.assign(instance.props, changes); host = instance; instance.index = 0;
      exported.default(instance.props); host = null;
      for (const effect of instance.effects.splice(0)) effect();
    };
    instance.unmount = () => { for (const item of instance.slots) item.cleanup?.(); };
    instance.replayEffects = () => {
      instance.unmount();
      for (const item of instance.slots) if (item.effect) item.cleanup = item.effect();
    };
    instance.render({});
    return instance;
  }
  async function flush() { for (let i = 0; i < 12; i++) { while (tasks.length) tasks.shift()(); await Promise.resolve(); } }
  async function microtasks() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
  return { rows, requests, writes, actions, errors, values, mount, flush, microtasks,
    replaceFormInstance() { form.current = { ...form.current }; },
    useHighCodeFieldGetter() {
      form.current.highCode = true;
      base.getValueByName = (_form, name) => rows[0][name.split(".").at(-1)];
    },
    edit(key, changes) { Object.assign(rows.find(row => row.key === key), changes); notify(table); },
    editMain(changes) { for (const [name, value] of Object.entries(changes)) { values[`main.${name}`] = value; notify(`main.${name}`); } },
    remove(key) { rows.splice(rows.findIndex(row => row.key === key), 1); notify(table); }
  };
}
