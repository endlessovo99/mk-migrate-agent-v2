import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const runtime = readFileSync(new URL("../fixtures/executor/persistence/hidden-label-runtime/xform-fieldset.cjs", import.meta.url), "utf8");
const wrappers = new Map();

/** Replay the retained upstream wrapper offline. Leaf editors and React hooks
 * are inert. This proves wrapper title rendering, not browser CSS or business
 * behavior, and never executes any source or migrated user script. */
export function renderNativeCaption(attribute, scene) {
  if (!wrappers.has(scene)) {
    const react = {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: "fragment",
      useState: initial => [typeof initial === "function" ? initial() : initial, () => {}],
      useMemo: callback => callback(), useCallback: callback => callback, useRef: current => ({ current }), useEffect() {}
    };
    const dependencies = { react,
      "@elem/xform-base": { getShowStatus: () => "edit", useFormatValidate: () => ({}),
        isRedValidatorInfoUITypeThemes: () => false, getSeparator: () => "," },
      "@lui/core": {}, "@mui/core": {}, "@ekp-infra/common": { Module: { getComponent: () => "inert-popover" } },
      "@ekp-runtime/utils": { appendTestAttr: () => ({}), appendTestAttrWithoutCheck: () => ({}) } };
    const exports = {};
    runInNewContext(runtime, { exports, module: { exports },
      require(name) { if (!Object.hasOwn(dependencies, name)) throw new Error(`Unknown native wrapper dependency: ${name}`); return dependencies[name]; },
      mk: { getSysConfig: () => scene, on() {}, off() {} } }, { timeout: 1000 });
    wrappers.set(scene, { render: exports.default, react });
  }
  const { render, react } = wrappers.get(scene), { labelProps, controlProps } = attribute.config;
  const output = render({ ...labelProps, ...labelProps[scene], $$platform: scene,
    $$controlType: controlProps[scene]?.type, currentStatus: "runtime", showStatus: "edit",
    children: react.createElement("inert-editor", { id: controlProps.id }) });
  const labels = [];
  const text = node => typeof node === "string" || typeof node === "number" ? String(node) :
    Array.isArray(node) ? node.map(text).join("") : node?.children?.map(text).join("") || "";
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node.props?.className?.split(" ").includes("ele-xform-fieldset-label")) labels.push(text(node));
    node.children?.forEach(visit);
  };
  visit(output);
  return { labels };
}
