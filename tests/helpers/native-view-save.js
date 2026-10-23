import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const fixture = new URL("../fixtures/executor/persistence/native-view-save/", import.meta.url);
const read = name => readFileSync(new URL(name, fixture), "utf8");
const provenance = JSON.parse(read("provenance.json"));
const pick = (object, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));

export function verifyNativeSaveSources() {
  for (const [file, metadata] of Object.entries(provenance.files)) {
    assert.equal(createHash("sha256").update(read(file)).digest("hex"), metadata.sha256, file);
  }
}

/** Replay the real native save/reassembly boundary; no UI, network or field effects. */
export function nativeViewSaveRoundTrip(config) {
  const next = structuredClone(config);
  const cache = new Map();
  const stubs = {
    2543: { pick },
    80536: { EScenePresetCode: { SCENE_DEFAULT: "default", SCENE_CREATE: "create", SCENE_APPROVE: "approve", SCENE_PUBLISH: "publish" } },
    8655: { fmtMsg: (_key, fallback) => fallback },
    27997: {}, 73604: {}
  };
  function nativeModule(id) {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    if (cache.has(id)) return cache.get(id);
    assert.ok([35908,53016,90405,39929].includes(id), `Unexpected native dependency ${id}`);
    const exports = {};
    cache.set(id, exports);
    runInNewContext(`(${read(`ide-module-${id}.js`)})`, {})(null, exports, nativeModule);
    return exports;
  }
  const layout = nativeModule(35908), constants = nativeModule(90405), retained = nativeModule(53016);
  const fieldConfigs = {};
  for (const model of next.dataModel) for (const field of model.fdFields) {
    const attribute = JSON.parse(field.fdAttribute);
    if (attribute.uuid && attribute.config) fieldConfigs[attribute.uuid] = attribute.config;
  }
  const types = new Set(["form", "div", "span", "fieldset", "main", "layout", "@elem/xform-appearance", "@elem/layout-grid", "@elem/layout-grid.GridItem"]);
  for (const field of Object.values(fieldConfigs)) for (const scene of ["desktop", "mobile"]) {
    types.add(field.type);
    if (field.controlProps?.[scene]?.type) types.add(field.controlProps[scene].type);
  }
  // The old unbound HTML carrier is a registered control too; registration alone
  // must not make the save test pass.
  types.add("@elem/xform-html");
  const getTypeByName = type => types.has(type) ? type : undefined;
  const reassembly = {};
  reassembly.injectRenderLayoutControl = runInNewContext(`(${read("inject-render-layout.js")})`, {
    l: constants, p: { clone: value => structuredClone(value) }, h: { pick }, v: retained,
    o: { syncApis: { elements: { getNameByTypeAndPlatform: (type, scene) => {
      const field = Object.values(fieldConfigs).find(field => field.type === type);
      return field?.controlProps?.[scene]?.type || type;
    } } } }, C: reassembly
  });
  for (const viewModel of next.viewModel) {
    const view = JSON.parse(viewModel.fdConfig);
    const save = () => layout.getViewRenderLayout({ view: view.view, getRenderLayout: args => layout.getRenderLayout({
      ...args, getTypeByName, dataModel: next.dataModel
    }) });
    save();
    const serialized = JSON.parse(JSON.stringify(view));
    for (const scene of ["desktop", "mobile"]) for (const root of serialized.view.render[scene]) {
      reassembly.injectRenderLayoutControl(fieldConfigs, root, scene, serialized.controlStyle || {});
    }
    Object.assign(view, serialized);
    save();
    viewModel.fdConfig = JSON.stringify(view);
  }
  return next;
}
