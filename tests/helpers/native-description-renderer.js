import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const root = new URL("../fixtures/executor/persistence/description-runtime/", import.meta.url);
const read = name => readFileSync(new URL(name, root), "utf8");

export function verifyNativeDescriptionSources() {
  for (const [name, evidence] of Object.entries(JSON.parse(read("provenance.json")).files)) {
    assert.equal(createHash("sha256").update(read(name)).digest("hex"), evidence.sha256, name);
  }
}

export function renderNativeDescription(config, id, platform) {
  const field = config.dataModel.flatMap(model => model.fdFields).find(field => field.fdName === id);
  const attribute = JSON.parse(field.fdAttribute).config;
  const view = JSON.parse(config.viewModel[0].fdConfig);
  const react = {
    createRef: () => ({ current: null }), useMemo: fn => fn(), useCallback: fn => fn,
    isValidElement: value => Boolean(value?.type),
    createElement: (type, props, ...children) => {
      const p = { ...type?.defaultProps, ...props, children: children.length === 1 ? children[0] : children };
      return typeof type === "function" ? type(p) : { type, props: p };
    }
  };
  const runtime = { mk: { getI18nInfo: key => key, getResourcePath: path => path, getSysConfig: () => platform },
    setTimeout: () => 0, clearTimeout() {} };
  const headless = {};
  runInNewContext(`(${readFileSync(new URL(
    "../fixtures/executor/persistence/adaptive-layout-native/xform-headless-desktop.js", import.meta.url), "utf8")})`, runtime)(headless, {});
  const View = {}, Description = {};
  const dependencies = {
    react, "@elem/xform-base": { getUITestDataTidPrefix: () => id },
    "@elem/xform-headless": headless,
    "@ekp-runtime/utils": { appendTestAttrWithoutCheck: () => ({}) }
  };
  const load = (name, exports) => runInNewContext(read(name), { ...runtime, exports, module: { exports }, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected native dependency ${name}`);
    return dependencies[name];
  } });
  load("xform-view.js", View);
  dependencies["@elem/xform-view"] = View;
  load(platform === "mobile" ? "xform-m-description.js" : "xform-description.js", Description);
  const props = { ...attribute.controlProps, ...attribute.controlProps[platform],
    ...view.controlStyle[id]?.[platform], currentStatus: "runtime", scene: "Form" };
  const tree = Description.default(props);
  const all = [];
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    all.push(value);visit(value.props?.children);
  };
  visit(tree);
  return all;
}
