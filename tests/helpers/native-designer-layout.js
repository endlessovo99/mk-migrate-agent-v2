import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const fixture = new URL("../fixtures/executor/persistence/adaptive-layout-native/designer/", import.meta.url);

/** Replay native designer structure; editor values, drag effects and network are inert. */
export function renderNativeDesignerLayout(config, scene = "desktop") {
  const view = JSON.parse(config.viewModel[0].fdConfig);
  const models = new Map(config.dataModel.map(model => [model.fdTableName, model]));
  const react = {
    __esModule: true, Fragment: "fragment",
    createElement: (type, props, ...children) => ({ type, key: props?.key,
      props: { ...props, children: children.length === 1 ? children[0] : children } }),
    useMemo: fn => fn(), useCallback: fn => fn, useRef: current => ({ current }),
    isValidElement: value => Boolean(value?.type)
  };
  react.default = react;
  const box = props => react.createElement("div", props, props.children);
  const pass = props => props.children;
  const exportsOf = value => ({ __esModule: true, default: value });
  const constants = { MAIN: "main", className: "sys-xform-ide",
    DETAIL_TABLE_DESKTOP: "@elem/xform-detail-table", FIX_RECEIVER_CLASSNAME: "fix-receiver" };
  const classes = (...args) => args.flatMap(arg => typeof arg === "string" ? [arg]
    : Object.entries(arg || {}).filter(([, value]) => value).map(([key]) => key)).join(" ");
  const store = { ...exportsOf({ getState: () => ({}) }), syncApis: {
    datamodel: { getOriginalDataModelByTableName: name => models.get(name) },
    i18n: { translateDefault: value => value }, view: {}
  } };
  const dependencies = {
    39155: react, 90405: constants, 32400: store,
    12148: { connect: () => fn => fn }, 34096: exportsOf("div"),
    21905: exportsOf(() => null), 94473: exportsOf(box), 64407: exportsOf(pass),
    81267: exportsOf(box), 40985: exportsOf({ Provider: pass }),
    64097: exportsOf(() => ({})), 46942: exportsOf(classes),
    46294: { usePopupChange() {} }, 15481: { useShortcut() {} },
    80536: { EDataModelType: { detail: "detail" } }, 8655: { fmtMsg: (_key, text) => text },
    67120: { Checkbox: () => react.createElement("input", { type: "checkbox" }) }
  };
  const cache = new Map();
  function nativeModule(id) {
    if (dependencies[id]) return dependencies[id];
    if (cache.has(id)) return cache.get(id);
    if (![49296, 51478, 60562].includes(id)) return {};
    const exports = {};
    cache.set(id, exports);
    const source = readFileSync(new URL(`ide-module-${id}.js`, fixture), "utf8");
    runInNewContext(`(${source})`, { console })(null, exports, nativeModule);
    return exports;
  }
  const Main = nativeModule(49296).default.component;
  const Table = nativeModule(60562).default.component;
  function project(node) {
    if (models.get(node.key)?.fdType === "detail") {
      const model = models.get(node.key);
      return react.createElement(Table, JSON.parse(model.fdAttribute).config.controlProps,
        (node.children || []).map(child => react.createElement("div", { key: child.key }, field())));
    }
    const children = (node.children || []).map(project);
    if (node.type === "main") return react.createElement(Main, {
      currentForm: { $form: { current: { getFormConfig: () => node } } }, snapshot: {}
    }, ...children);
    if (node.type === "@elem/xform-appearance") return react.createElement("div", { className: "ele-xform-appearance" }, ...children);
    if (node.type === "@elem/xform-html") return null;
    return node.type ? react.createElement("div", node.controlProps, ...children) : field();
  }
  function field() {
    return react.createElement("div", { className: "ele-xform-fieldset-horizontal" },
      react.createElement("div", { className: "ele-xform-fieldset-label-wrap" },
        react.createElement("label", { className: "ele-xform-fieldset-label" }, react.createElement("span", {}))),
      react.createElement("div", { className: "ele-xform-fieldset-control-wrap" },
        react.createElement("div", { className: "ele-xform-fieldset-control" },
          react.createElement("div", { className: "ele-xform-fieldset-control-main" }))));
  }
  function render(node) {
    if (node == null || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(render);
    if (typeof node.type === "function") return render(node.type(node.props));
    if (node.type === "fragment") return render(node.props.children);
    return [{ type: node.type, props: node.props, children: render(node.props.children) }];
  }
  return render(react.createElement("div", { className: scene === "desktop"
    ? "sys-xform-ide-editor-desktop" : "sys-xform-ide-editor-mobile2desktop" },
  react.createElement("form", {}, ...view.view.render[scene].map(project))))[0];
}

export function nativeDesignerNodes(tree, predicate) {
  return [tree, ...(tree.children || []).flatMap(child => nativeDesignerNodes(child, () => true))].filter(predicate);
}

/** Match the simple native/generated CSS selectors used by this contract. */
export function matchingDesignerNodes(tree, selector) {
  const parents = new Map();
  const all = nativeDesignerNodes(tree, () => true);
  for (const node of all) for (const child of node.children || []) parents.set(child, node);
  const tokens = selector.replace(/([>~])/g, " $1 ").trim().split(/\s+/);
  const simple = (node, token) => {
    const [tag, ...classes] = token.split(".");
    return (!tag || tag === "*" || node.type === tag) && classes.every(name =>
      String(node.props?.className || "").split(/\s+/).includes(name));
  };
  function matches(node, index) {
    if (!node || !simple(node, tokens[index])) return false;
    if (index === 0) return true;
    const operator = tokens[index - 1];
    if (operator === ">") return matches(parents.get(node), index - 2);
    if (operator === "~") {
      const siblings = parents.get(node)?.children || [];
      return siblings.slice(0, siblings.indexOf(node)).some(sibling => matches(sibling, index - 2));
    }
    for (let parent = parents.get(node); parent; parent = parents.get(parent)) {
      if (matches(parent, index - 1)) return true;
    }
    return false;
  }
  return all.filter(node => matches(node, tokens.length - 1));
}
