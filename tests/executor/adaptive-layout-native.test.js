import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { ADAPTIVE_MAIN_FIELD_CLASS, adaptiveStyles, adaptiveView } from "../../src/executor/persistence/adaptive-layout.js";

const root = new URL("../fixtures/executor/persistence/adaptive-layout-native/", import.meta.url);
const read = file => readFileSync(new URL(file, root), "utf8");
const provenance = JSON.parse(read("provenance.json"));
const seams = JSON.parse(read("runtime-seams.json"));
const registration = JSON.parse(readFileSync(new URL(
  "../fixtures/executor/persistence/form-renderer-registration.json", import.meta.url
), "utf8"));

// This suite replays native JavaScript and examines emitted CSS declarations.
// It deliberately does not claim browser layout or server save/readback acceptance.
describe("adaptive layout native runtime contract", () => {
  it("retains exact current QAS sources and identical desktop/mobile HTML implementations", () => {
    for (const [file, metadata] of Object.entries(provenance.files)) {
      assert.equal(createHash("sha256").update(read(file)).digest("hex"), metadata.sha256, file);
    }
    assert.equal(read("xform-html-desktop.js"), read("xform-html-mobile.js"));
    assert.equal(read("xform-headless-desktop.js"), read("xform-headless-mobile.js"));
  });

  for (const platform of ["desktop", "mobile"]) {
    it(`${platform}: mounts persistent CSS through the native container without business fields`, () => {
      const tableName = "mk_adaptive_native_test";
      const { scope, css, carrier } = adaptiveStyles(tableName);
      const main = { key: "main", type: "main", kind: "container", controlProps: { id: "main" }, children: [] };
      const tree = { key: "appearance", type: "@elem/xform-appearance", kind: "container",
        children: adaptiveView(main, tableName) };
      const result = replayTree(tree, platform);
      const styles = findNodes(result, node => node.props?.dangerouslySetInnerHTML?.__html?.includes("<style>"));
      assert.equal(styles.length, 1);
      assert.ok(styles[0].props.dangerouslySetInnerHTML.__html.includes(css));
      assert.equal(findNodes(result, node => node.type === "main").length, 1);
      assert.equal(findNodes(result, node => node.type === "div" && node.props.className === scope).length, 1);
      assert.deepEqual(carrier.controlProps.dangerouslySetInnerHTML, { __html: `<style>${css}</style>` });
      assert.equal(carrier.kind, "container");
      assert.equal(carrier.type, "div");

      // Built-in containers do not depend on registering an unbound HTML control.
      const withoutRegistration = replayTree(tree, platform, { registerHtml: false });
      assert.equal(findNodes(withoutRegistration, node =>
        node.props?.dangerouslySetInnerHTML?.__html?.includes("<style>")
      ).length, 1);
    });

    it(`${platform}: overrides both native title widths and allows the horizontal wrapper to shrink`, () => {
      const native = renderNativeFieldset(platform);
      const labels = findNodes(native, node => hasClass(node, "ele-xform-fieldset-label"));
      assert.equal(labels.length, 1);
      const spans = findNodes(labels[0], node => node.type === "span");
      assert.ok(spans.some(node => node.props.style?.width === (platform === "desktop" ? "8em" : "6em")),
        "the retained upstream component still overwrites a requested auto width");
      assert.match(read("xform-fieldset.css"),
        platform === "desktop" ? /width:8em;max-width:8em/ : /width:6em;max-width:6em/);
      assert.match(read("xform-fieldset.css"), /flex-shrink:0/);

      const { scope, css } = adaptiveStyles("mk_adaptive_native_test");
      const fieldScope = `.${scope} ~ * .${ADAPTIVE_MAIN_FIELD_CLASS}`;
      const rules = cssRules(css);
      for (const selector of [
        `${fieldScope} .ele-xform-fieldset-label`,
        `${fieldScope} .ele-xform-fieldset-label > span`
      ]) {
        const declarations = declarationsFor(rules, selector);
        assert.equal(declarations.width, "auto!important");
        assert.equal(declarations["max-width"], "none!important");
        assert.equal(declarations["white-space"]?.replace("!important", ""), "normal");
        assert.equal(declarations["overflow-wrap"]?.replace("!important", ""), "anywhere");
      }
      const horizontal = rules.find(rule =>
        rule.selectors.some(selector => selector.includes(".ele-xform-fieldset-horizontal") &&
          selector.endsWith(".ele-xform-fieldset-label-wrap"))
      );
      assert.ok(horizontal, "horizontal title wrapper has an explicit shrinking rule");
      assert.equal(horizontal.declarations["min-width"]?.replace("!important", ""), "0");
      assert.equal(horizontal.declarations["max-width"]?.replace("!important", ""), "50%");
      assert.equal(horizontal.declarations.flex?.replace("!important", ""), "0 1 auto");
      assert.deepEqual(horizontal.selectors, [
        `${fieldScope} .ele-xform-fieldset-horizontal > .ele-xform-fieldset-label-wrap`
      ]);
      // The user-measured browser cases contain leaf fields, for which the
      // hardened child selector selects exactly the same native title wrapper.
      const wrappers = findNodes(native, node => hasClass(node, "ele-xform-fieldset-label-wrap"));
      const parents = findNodes(native, node => hasClass(node, "ele-xform-fieldset-horizontal"));
      assert.deepEqual(parents.flatMap(parent => parent.children.flat(Infinity))
        .filter(node => node && hasClass(node, "ele-xform-fieldset-label-wrap")), wrappers);
      const controls = declarationsFor(rules, `${fieldScope} .ele-xform-fieldset-control-wrap`);
      assert.equal(controls["min-width"]?.replace("!important", ""), "0");
      assert.match(controls.flex, /^1 1 0%?(?:!important)?$/);
      for (const rule of rules) {
        assert.ok(rule.selectors.every(selector => selector.startsWith(`.${scope} `)),
          `all declarations are constrained to the generated form wrapper: ${rule.selectors}`);
      }
    });

    it(`${platform}: does not cap a nested vertical title inside a horizontal outer field`, () => {
      const inner = renderNativeFieldset(platform, { title: "Inner", layout: "vertical" });
      const outer = renderNativeFieldset(platform, { children: inner });
      const wrappers = findNodes(outer, node => hasClass(node, "ele-xform-fieldset-label-wrap"));
      const horizontalParents = findNodes(outer, node => hasClass(node, "ele-xform-fieldset-horizontal"));
      const directWrappers = horizontalParents.flatMap(parent => parent.children.flat(Infinity))
        .filter(node => node && hasClass(node, "ele-xform-fieldset-label-wrap"));
      assert.equal(wrappers.length, 2);
      assert.equal(directWrappers.length, 1);
      assert.notEqual(directWrappers[0], findNodes(inner, node => hasClass(node, "ele-xform-fieldset-label-wrap"))[0]);
    });
  }
});

function replayTree(tree, platform, { registerHtml = true } = {}) {
  const react = {
    isValidElement: () => false,
    createElement: (type, props, ...children) => typeof type === "function"
      ? type({ ...props, children })
      : { type, props: props || {}, children },
    useMemo: callback => callback(),
    useEffect: () => {}
  };
  const runtime = {
    mk: { getResourcePath: path => path, getI18nInfo: key => key, emit: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {}
  };
  const headlessExports = {};
  runInNewContext(`(${read(`xform-headless-${platform}.js`)})`, runtime)(
    headlessExports, { hasWaitLoaded: () => false }
  );
  const htmlExports = {};
  runInNewContext(`(${read(`xform-html-${platform}.js`)})`, runtime)(
    htmlExports, react, { getShowStatus: status => status }, headlessExports.default
  );
  const nativeControls = runInNewContext(`(${seams.registerControls})`, {
    Q: undefined, t: platform, n: {}, v: false, ey: undefined, eE: undefined, o: {}, x: {}, N: "edit",
    es: {}, F: {}, eC: () => {}, eT: () => {}, T: { desktop: "detail", mobile: "detail-mobile" },
    c: { EPlatform: { desktop: "desktop", mobile: "mobile" } },
    f: { EKind: { appearance: "appearance", container: "container" } },
    w: value => value, M: () => undefined,
    eP: () => [],
    eS: spec => ({
      kind: spec.xform.kind, type: spec.name,
      component: spec.name === "@elem/xform-html" ? htmlExports.default : "unused-detail"
    })
  })({
    desktop: [{ name: "@elem/xform-html", xform: { kind: "control", type: "html" } }],
    mobile: [{ name: "@elem/xform-html", xform: { kind: "control", type: "html" } }]
  });
  assert.ok(nativeControls.controls.some(control => control.type === "@elem/xform-html" && control.kind === "control"));
  const preprocessContext = createContext({
    i: { FIELDSET: "fieldset", DETAIL_TABLE_DESKTOP: "detail", DETAIL_TABLE_MOBILE: "detail-mobile" },
    c: { EDataModelType: { detail: "detail" } }
  });
  const preprocess = runInContext(`var R=(${seams.treePreprocess});R`, preprocessContext);
  const preprocessed = preprocess({}, {}, {}, structuredClone(tree), platform, platform, [], {}, {});
  const ctx = createContext({
    i: react, t5: () => false, t2: runInNewContext(`(${readFileSync(new URL(
      "../fixtures/executor/persistence/native-view-save/render-props-filter.js", import.meta.url), "utf8")})`), tt: "fieldset", console,
    s: (object, key, value) => { object[key] = value; return object; }
  });
  runInContext(`var tn=${registration.builtins};var tr=${registration.errors};${registration.fallback}`, ctx);
  const engine = { registeredFormItems: {} };
  ctx.n = engine;
  engine.getFormItemComponent = runInContext(`(${registration.lookup})`, ctx);
  for (const [key, source] of Object.entries(registration.methods)) {
    engine[key] = runInContext(`(${source})`, ctx);
  }
  engine.registerFormItems([
    { type: "@elem/xform-appearance", kind: "container", component: "appearance" },
    { type: "main", kind: "container", component: "main" },
    ...nativeControls.controls.filter(control => registerHtml || control.type !== "@elem/xform-html")
  ]);
  function hydrate(node) {
    return { ...node, props: node.controlProps || {}, children: (node.children || []).map(hydrate) };
  }
  return engine.renderFormItem(hydrate(preprocessed));
}

function renderNativeFieldset(platform, overrides = {}) {
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: "fragment",
    useState: initial => [typeof initial === "function" ? initial() : initial, () => {}],
    useMemo: callback => callback(), useCallback: callback => callback,
    useRef: current => ({ current }), useEffect: () => {}
  };
  const dependencies = {
    react,
    "@elem/xform-base": {
      getShowStatus: () => "edit", useFormatValidate: () => ({}),
      isRedValidatorInfoUITypeThemes: () => false, getSeparator: () => ","
    },
    "@lui/core": {}, "@mui/core": {},
    "@ekp-infra/common": { Module: { getComponent: () => "unused" } },
    "@ekp-runtime/utils": { appendTestAttr: () => ({}), appendTestAttrWithoutCheck: () => ({}) }
  };
  const exports = {};
  runInNewContext(read("xform-fieldset.js"), {
    exports, module: { exports },
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `unexpected native dependency ${name}`);
      return dependencies[name];
    },
    mk: { getSysConfig: () => platform, on: () => {}, off: () => {} }
  });
  return exports.default({
    title: "标题", layout: "horizontal", labelStyle: { width: "auto" },
    $$platform: platform, $$controlType: "@elem/xform-input",
    currentStatus: "runtime", showStatus: "edit",
    children: react.createElement("fixture-control", { id: "input" }),
    ...overrides
  });
}

function hasClass(node, name) {
  return node.props?.className?.split(" ").includes(name);
}

function findNodes(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(child => findNodes(child, predicate));
  return [...(predicate(tree) ? [tree] : []), ...findNodes(tree.children, predicate)];
}

function cssRules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)].map(([, selectors, declarations]) => ({
    selectors: selectors.split(",").map(selector => selector.trim()),
    declarations: Object.fromEntries(declarations.split(";").filter(part => part.trim()).map(part => {
      const colon = part.indexOf(":");
      return [part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s*!important$/, "!important")];
    }))
  }));
}

function declarationsFor(rules, selector) {
  return Object.assign({}, ...rules.filter(rule => rule.selectors.includes(selector)).map(rule => rule.declarations));
}
