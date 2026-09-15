import { readFileSync } from "node:fs";
import vm from "node:vm";

const evidence = JSON.parse(readFileSync(new URL(
  "../fixtures/executor/persistence/form-renderer-registration.json", import.meta.url
), "utf8"));

// Replay NewOA's registration and traversal seam; leaf controls are inert markers.
export function renderNativeFieldReferences(config, scene = "desktop") {
  const context = vm.createContext({
    i: {
      isValidElement: () => false,
      createElement: (type, props, ...children) => ({ type, props, children })
    },
    t5: () => false,
    t2: (_component, props) => props,
    s: (object, key, value) => { object[key] = value; return object; },
    tt: "fieldset",
    console
  });
  vm.runInContext(`var tn = ${evidence.builtins}; var tr = ${evidence.errors}; ${evidence.fallback}`, context);
  const engine = { registeredFormItems: {} };
  context.n = engine;
  engine.getFormItemComponent = vm.runInContext(`(${evidence.lookup})`, context);
  for (const [key, source] of Object.entries(evidence.methods)) {
    engine[key] = vm.runInContext(`(${source})`, context);
  }
  // These structural components are registered by NewOA's toCmtConfig.
  for (const type of ["@elem/xform-appearance", "@elem/layout-grid", "@elem/layout-grid.GridItem", "@elem/xform-row", "main", "layout"]) {
    engine.registeredFormItems[`container:${type}`] = type;
  }
  engine.registeredFormItems["control:field"] = "field";
  const fields = new Set(config.dataModel.flatMap(model => model.fdFields.map(field => field.fdName)));
  const expected = [];
  function hydrate(node) {
    if (!node.type && fields.has(node.key)) {
      expected.push(node.key);
      return { type: "field", kind: "control", props: { id: node.key }, children: [] };
    }
    return { ...node, props: node.controlProps || {}, children: (node.children || []).map(hydrate) };
  }
  const view = JSON.parse(config.viewModel[0].fdConfig);
  const output = engine.renderFormItem(hydrate(view.view.render[scene][0]));
  const actual = [];
  function collect(node) {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(collect);
    if (node.type === "field") actual.push(node.props.id);
    node.children?.forEach(collect);
  }
  collect(output);
  return { expected, actual, output };
}
