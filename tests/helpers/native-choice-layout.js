import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const root = new URL("../fixtures/executor/persistence/choice-other-wrap/", import.meta.url);
const read = name => readFileSync(new URL(name, root), "utf8");
const escape = value => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

// Native choice render functions own option order and row topology. React effects,
// network services and core input primitives are inert at this offline boundary.
export function nativeChoiceLayoutHtml(config, scene) {
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: "fragment",
    useState: initial => [typeof initial === "function" ? initial() : initial, () => {}],
    useMemo: callback => callback(), useCallback: callback => callback, useRef: current => ({ current }),
    useEffect() {}, useImperativeHandle() {}
  };
  const coreChoice = type => Object.assign(props => react.createElement("label", {
    className: `core-choice ${props.className || ""}`, "data-value": props.value
  }, react.createElement("input", { type }), props.children), {
    Group: props => react.createElement("div", { className: props.className }, props.children)
  });
  const base = {
    Http: { build: () => ({}) }, SceneShowRules: { NotShowControlTip: [] },
    getShowStatus: status => status, formatI18nOptions: options => options,
    useFormatValidate: () => ({}), isRedValidatorInfoUITypeThemes: () => false,
    transformValueForRuleOption: value => value, getSeparator: () => ";",
    useCommonForRuleFormula() {}, useOptionsForRuleFormula() {}, useOptionsForJs() {},
    useGangedFields: () => ({}), getUITestDataTidPrefix: () => "offline"
  };
  const dependencies = {
    react, "@elem/xform-base": base,
    "@lui/core": { Checkbox: coreChoice("checkbox"), Radio: coreChoice("radio") },
    "@mui/core": { Checkbox: coreChoice("checkbox"), Radio: coreChoice("radio") },
    "@elem/xform-headless": props => props.children,
    "@elem/xform-view": props => props.children,
    "@ekp-infra/common": { Api: { build: () => () => Promise.resolve({}) }, Module: { getComponent: () => "inert-popover" } },
    "@ekp-infra/render": {},
    "@ekp-runtime/utils": { appendTestAttrWithoutCheck: () => ({}), appendTestAttr: () => ({}) }
  };
  const modules = {};
  for (const kind of ["checkbox", "radio"]) {
    const name = `xform-${scene === "mobile" ? "m-" : ""}${kind}`, exports = {};
    const define = (_name, deps, factory) => factory(...deps.map(dep => dep === "exports" ? exports : dependencies[dep]));
    define.amd = true;
    runInNewContext(read(`${name}.js`), { define, mk: { getI18nInfo: key => key }, console }, { timeout: 1000 });
    modules[kind] = exports.default;
  }
  const fields = new Map(config.dataModel.flatMap(m => m.fdFields).filter(f => f.fdAttribute)
    .map(f => [f.fdName, JSON.parse(f.fdAttribute).config]));
  const view = JSON.parse(config.viewModel[0].fdConfig);
  const fieldsetExports = {};
  runInNewContext(readFileSync(new URL("../fixtures/executor/persistence/hidden-label-runtime/xform-fieldset.cjs", import.meta.url), "utf8"), {
    exports: fieldsetExports, module: { exports: fieldsetExports }, require: name => dependencies[name],
    mk: { getSysConfig: () => scene, on() {}, off() {} }
  }, { timeout: 1000 });
  const unitless = new Set(["flex", "flexGrow", "flexShrink", "fontWeight", "lineHeight", "order", "zIndex", "opacity"]);
  const styleText = style => Object.entries(style || {}).map(([key, value]) =>
    `${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}:${typeof value === "number" && value !== 0 && !unitless.has(key) ? `${value}px` : value}`).join(";");
  function html(node) {
    if (node == null || node === false) return "";
    if (typeof node !== "object") return escape(node);
    if (Array.isArray(node)) return node.map(html).join("");
    if (typeof node.type === "function") return html(node.type({ ...node.type.defaultProps, ...node.props, children: node.children }));
    if (node.type === "fragment") return html(node.children);
    const props = node.props || {};
    const attrs = Object.entries(props).filter(([k, v]) => v != null && k !== "children" && !k.startsWith("on") && k !== "key")
      .map(([k, v]) => `${k === "className" ? "class" : k}="${escape(k === "style" ? styleText(v) : v)}"`).join(" ");
    if (["input", "br", "hr", "img"].includes(node.type)) return `<${node.type} ${attrs}>`;
    return `<${node.type} ${attrs}>${html(node.children)}</${node.type}>`;
  }
  function project(node) {
    if (!node.type) {
      const field = fields.get(node.key);
      if (!field) return "";
      const p = { ...field.controlProps, ...field.controlProps[scene], editable: true, showStatus: "edit", scene: "Form" };
      const kind = /checkbox/.test(p.type) ? "checkbox" : /radio/.test(p.type) ? "radio" : null;
      let value = p.defaultValue ?? "";
      if (p.defaultValueFormulaVO?.script) {
        try { value = JSON.parse(p.defaultValueFormulaVO.script); } catch { /* Context/business formulas remain inert. */ }
      }
      const content = kind ? react.createElement(modules[kind], p)
        : /input/.test(p.type) ? react.createElement("input", { "data-note": node.key, value })
          : react.createElement("span", {}, field.controlProps.content || field.label || "");
      return html(fieldsetExports.default({ ...field.labelProps, ...field.labelProps[scene],
        ...view.controlStyle?.[node.key]?.[scene], $$platform: scene, $$controlType: p.type,
        currentStatus: "runtime", showStatus: "edit", children: content }));
    }
    if (node.type === "@elem/xform-html") return `<style>${node.controlProps.source.css}</style>`;
    if (node.controlProps?.dangerouslySetInnerHTML) return node.controlProps.dangerouslySetInnerHTML.__html;
    return `<div class="${escape(node.controlProps?.className || "")}" style="${escape(styleText(node.controlProps?.style))}">${(node.children || []).map(project).join("")}</div>`;
  }
  return `<style>body{font:16px Arial}.core-choice{display:inline-flex;align-items:center;white-space:nowrap;margin-right:12px;vertical-align:middle}.core-choice input{margin:0 4px 0 0}input[data-note]{width:100%;height:28px;box-sizing:border-box}</style>`
    + `<style>${readFileSync(new URL("../fixtures/executor/persistence/adaptive-layout-native/xform-fieldset.css", import.meta.url), "utf8")}</style>`
    + `<style>${read(`xform-${scene === "mobile" ? "m-" : ""}checkbox.css`)}${read(`xform-${scene === "mobile" ? "m-" : ""}radio.css`)}</style>`
    + view.view.render[scene].map(project).join("");
}
