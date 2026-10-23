import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { nativeRequiredRuntime } from "./native-required-runtime.js";

const fixture = new URL("../fixtures/executor/persistence/scalar-form-rule-runtime/", import.meta.url);
const provenance = JSON.parse(readFileSync(new URL("provenance.json", fixture), "utf8"));

/** Run captured native scalar rule initialization/change dispatch, not a JS approximation. */
export function nativeScalarFormRules(config, scene = "add") {
  const runtime = nativeRequiredRuntime(structuredClone(config), scene);
  const byKey = new Map(), keys = {};
  for (const model of config.dataModel) for (const field of model.fdFields || []) {
    const node = JSON.parse(field.fdAttribute || "{}").config;
    if (node) { byKey.set(node.key, node); keys[field.fdName] = node.key; }
  }
  let values = {};
  const effects = [];
  const apply = (kind, result) => {
    assert.equal(result.tableType, "main", "This fixture host handles main scalar effects only");
    assert.equal(typeof result.fieldName, "string");
    effects.push({ kind, ...result });
    runtime.MKXFORM.setFieldAttr(result.fieldName, kind === "display"
      ? result.displayFlag === "hide" ? 4 : 5
      : result.required === "required" ? 3 : 6);
  };
  const unsupported = () => { throw Error("Unexpected non-scalar native rule dependency"); };
  const context = vm.createContext({
    r: { useCallback: fn => fn }, S: value => typeof value,
    eP: { current: {} }, eF: { current: keys }, eU: { current: {} },
    tA: (_condition, name) => name, t_: name => name,
    v: { FormRuleConditionNodeType: { formula: "formula" } },
    d: { getFormConfig: ({ key }) => byKey.get(key) }, z: undefined,
    tx: (state, condition) => state[condition.fieldName], N: () => false,
    tM: unsupported, tO: unsupported, tj: unsupported,
    ta: JSON.parse(config.attribute.formAttr).formRule,
    tm: result => apply("display", result), tg: result => apply("require", result),
    th: unsupported, eq: undefined,
    w: (object, key, value) => ({ ...object, [key]: value })
  });
  for (const name of ["tP", "tE", "tS", "tI", "tb"]) {
    const source = readFileSync(new URL(`${name}.js`, fixture), "utf8");
    assert.equal(createHash("sha256").update(source).digest("hex"), provenance.functions[name].sha256);
    vm.runInContext(`var ${name} = ${source};`, context);
  }
  return {
    runtime, effects,
    initialize(initial = {}) {
      values = { ...initial };
      effects.length = 0;
      context.tb({}, values, true);
    },
    change(id, value) {
      assert.ok(keys[id], `Unknown native scalar field ${id}`);
      values[id] = value;
      effects.length = 0;
      context.tb({ [keys[id]]: value }, values, false);
    },
    visible(id) { return runtime.field(id).labelProps?.hidden !== true; },
    compare(id, value, operator, expected) {
      return context.tE(value, expected, { fieldName: id, operate: operator });
    }
  };
}
