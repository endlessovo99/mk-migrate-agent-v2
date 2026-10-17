import vm from "node:vm";
import { canonicalRowTarget } from "../../../src/dsl/layout-row-targets.js";
const observeValue = value => value === undefined ? { type: "undefined" } : typeof value === "symbol" ? { type: "symbol", value: value.description } : typeof value === "function" ? { type: "function" } : value !== null && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value;
const domString = value => value === null ? "" : `${value}`;
export function runtime(text, form, { target = false, state = {} } = {}) {
  const values = Object.fromEntries(Object.entries(state).map(([id, value]) => [id, domString(value)]));
  const trace = [], handlers = [], timers = [];
  const get = id => { const value = values[id] ?? ""; trace.push(["read", id, value]); return value; };
  const set = (id, value) => { values[id] = domString(value); trace.push(["write", id, values[id]]); };
  const context = vm.createContext({
    window: {},
    Com_AddEventListener(_window, event, fn) { handlers.push({ event: "onLoad", fn }); },
    AttachXFormValueChangeEventById(controlId, fn) { handlers.push({ event: "onChange", controlId, fn }); },
    GetXFormFieldById(id) { return [{ get value() { return get(id); }, set value(value) { set(id, value); } }]; },
    GetXFormFieldValueById(id) { return [get(id)]; },
    common_dom_row_set_show_required_reset(id, visible, required, reset) {
      if (reset) throw Error("Observer intentionally covers reset=false only");
      const canonical = canonicalRowTarget(form, id);
      if (!canonical) throw Error("unproven source row: " + id);
      trace.push(["attribute", canonical, visible ? 5 : 4], ["attribute", canonical, required ? 3 : 6]);
    },
    MKXFORM: { getValue: get, setValue: set, setFieldAttr(id, attr) { trace.push(["attribute", id, attr]); } },
    setTimeout(fn, delay) { trace.push(["schedule", delay]); timers.push(fn); },
    console: Object.fromEntries(["log", "info", "debug"].map(method => [method, (...args) => trace.push(["console", method, ...args.map(observeValue)])]))
  });
  let action;
  if (target) action = vm.runInContext("(" + text + ")", context);
  else vm.runInContext(text, context);
  return { values, trace, handlers, timers, action,
    invoke(fn, ...args) { try { fn(...args); return undefined; } catch (error) { return error.name; } },
    snapshot(error) { return { values: { ...values }, trace: JSON.parse(JSON.stringify(trace)), ...(error ? { error } : {}) }; }
  };
}
