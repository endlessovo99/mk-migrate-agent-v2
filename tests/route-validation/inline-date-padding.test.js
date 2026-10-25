import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { contentFlowFieldPadding } from "../../src/executor/persistence/inline-cell-layout.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { nativeViewSaveRoundTrip, verifyNativeSaveSources } from "../helpers/native-view-save.js";

const directory = new URL("../fixtures/route-validation/inline-date-padding/", import.meta.url);
const read = name => readFileSync(new URL(name, directory), "utf8");
const hash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const digest = value => hash(canonical(value));
const provenance = JSON.parse(read("provenance.json"));
for (const [name, sha256] of Object.entries(provenance.inputs)) assert.equal(hash(read(name)), sha256, name);
const baselineBytes = read(provenance.baseline.file);
assert.equal(hash(baselineBytes), provenance.baseline.sha256);
const baseline = JSON.parse(baselineBytes), ids = JSON.parse(read("ids.json"));
const budget = JSON.parse(read("readability-budget.json"));
assert.equal(baseline.baselineHead, provenance.baselineHead);
const expectedPadding = { top: "8px", right: "0px", bottom: "8px", left: "16px" };

function stage(name = "base") {
  const source = cleanSourceFile(fileURLToPath(new URL(name + "_SysFormTemplate.xml", directory)));
  const draft = draftSourceDraft(source), selected = ids[name], row = draft.form.layout.mkTree[0];
  const cell = row.children.find(entry => entry.refIds.includes(selected.from));
  const field = id => draft.form.fields.find(entry => entry.id === id);
  return { source, draft, selected, row, cell, caption: field(selected.fromLabel), date: field(selected.from) };
}
function members(selected) {
  return [selected.fromLabel, selected.from, selected.toLabel, selected.to];
}
function geometry(form, mobile = false) {
  return projectNativeLayoutRows(form.layout.mkTree, { ...form.layout, fields: form.fields, mobile });
}

for (const name of ["base", "renamed"]) {
  it(name + ": preserves source, BR lines and geometry while reclaiming only native right insets", () => {
    const x = stage(name), sourceBefore = structuredClone(x.source), draftBefore = structuredClone(x.draft);
    const prepared = prepareSample(x.draft), config = xformConfig(prepared.update);
    const view = JSON.parse(config.viewModel[0].fdConfig), map = contentFlowFieldPadding(x.draft.form);
    const expected = baseline.cases[name], restoredStyles = structuredClone(view.controlStyle);
    for (const id of members(x.selected)) {
      assert.deepEqual(map.get(id), expectedPadding);
      assert.deepEqual(view.controlStyle[id].desktop.paddingControl, expectedPadding);
      assert.equal(view.controlStyle[id].mobile?.paddingControl, undefined);
      delete restoredStyles[id].desktop.paddingControl;
      if (Object.keys(restoredStyles[id].desktop).length === 0) delete restoredStyles[id].desktop;
      if (Object.keys(restoredStyles[id]).length === 0) delete restoredStyles[id];
    }
    const protectedNative = Object.fromEntries(Object.entries(config).filter(([key]) => key !== "viewModel")
      .map(([key, value]) => [key, digest(value)]));
    assert.deepEqual(protectedNative, expected.protectedNative, "data, actions, rules, defaults and permissions stay unchanged");
    assert.equal(digest(view.view), expected.viewTree, "desktop/mobile tree and member identities stay unchanged");
    assert.equal(digest(restoredStyles), expected.controlStyle, "only the four expected desktop padding additions are permitted");
    assert.equal(digest(view.theme), expected.theme);
    assert.equal(digest(geometry(x.draft.form)), expected.desktopGeometry);
    assert.equal(digest(geometry(x.draft.form, true)), expected.mobileGeometry);
    assert.deepEqual(x.cell.contentFlow.lines, [[x.selected.fromLabel, x.selected.from], [x.selected.toLabel, x.selected.to]]);
    assert.deepEqual(x.draft, draftBefore);
    assert.deepEqual(x.source, sourceBefore);
    assert.equal(prepared.verify(prepared.update).ok, true);
  });
}

it("rejects incomplete and unrelated inline cells instead of trimming broad caption/date families", () => {
  const cases = [
    ["nonadaptive", x => { x.draft.form.layout.sizing = "source"; }],
    ["whole-row", x => { x.row.props.columns = 1; }],
    ["spanning cell", x => { x.cell.colspan = 2; }],
    ["not explicit inline", x => { x.cell.keepInline = false; }],
    ["reversed line", x => { x.cell.contentFlow.lines[0].reverse(); }],
    ["separate lines", x => { x.cell.contentFlow.lines = [[x.selected.fromLabel], [x.selected.from], [x.selected.toLabel], [x.selected.to]]; }],
    ["extra line", x => { x.cell.contentFlow.lines.push([]); }],
    ["extra member", x => { x.cell.refIds.push(x.selected.other); x.cell.contentFlow.items.push({ referenceId: x.selected.other }); }],
    ["long description", x => { x.caption.props.content = "long explanation"; }],
    ["markup", x => { x.caption.props.content = "<b>x</b>"; }],
    ["link", x => { x.caption.props.link = "https://example.invalid"; }],
    ["data-only date", x => { x.date.dataOnly = true; }],
    ["data-only caption", x => { x.caption.dataOnly = true; }],
    ["explicit caption width", x => { x.cell.contentFlow.items[0].width = { unit: "px", value: 84 }; }],
    ["own date title", x => { x.date.props.hiddenLabel = false; }],
    ["time format", x => { x.date.props.displayPattern = "yyyy-MM-dd HH:mm"; }],
    ["non-date", x => { x.date.componentId = "xform-input"; }],
    ["no explicit width", x => { delete x.cell.contentFlow.items[1].width; }],
    ["percent width", x => { x.cell.contentFlow.items[1].width.unit = "%"; }],
    ["zero width", x => { x.cell.contentFlow.items[1].width.value = 0; }],
    ["duplicate occurrence", x => { x.row.children.push({ ...structuredClone(x.cell), id: "another-occurrence" }); }]
  ];
  for (const [name, mutate] of cases) {
    const x = stage();
    mutate(x);
    const padding = contentFlowFieldPadding(x.draft.form);
    assert.equal(padding.has(x.selected.fromLabel), false, name);
    assert.equal(padding.has(x.selected.toLabel), false, name);
  }
});

it("uses executable contentFlow rather than source audit metadata, field names or unitless weights", () => {
  const x = stage();
  for (const field of x.draft.form.fields) delete field.sourceProps;
  x.cell.widthWeight = 1;
  assert.deepEqual(contentFlowFieldPadding(x.draft.form).get(x.selected.from), expectedPadding);
  delete x.cell.contentFlow.items[1].width;
  x.cell.widthWeight = 152;
  assert.equal(contentFlowFieldPadding(x.draft.form).has(x.selected.fromLabel), false);
});

it("native save/reassembly retains padding and rejects padding removal or override", () => {
  const x = stage(), prepared = prepareSample(x.draft);
  verifyNativeSaveSources();
  const config = nativeViewSaveRoundTrip(xformConfig(prepared.update)), saved = structuredClone(prepared.update);
  saved.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  assert.equal(prepared.verify(saved).ok, true);
  for (const id of [x.selected.fromLabel, x.selected.from]) {
    for (const mutate of [style => { delete style.paddingControl; }, style => { style.paddingControl.right = "16px"; }]) {
      const changed = structuredClone(prepared.update), bad = xformConfig(changed), view = JSON.parse(bad.viewModel[0].fdConfig);
      mutate(view.controlStyle[id].desktop);
      bad.viewModel[0].fdConfig = JSON.stringify(view);
      changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(bad);
      assert.equal(prepared.verify(changed).ok, false);
    }
  }
});

it("actual native fieldset consumes right/top/bottom padding for both members and retains the left inset", () => {
  for (const type of ["@elem/xform-description", "@elem/xform-datetime"]) {
    const before = nativePadding(undefined, type), actual = nativePadding(expectedPadding, type);
    assert.equal(before.style.padding, "8px 16px");
    assert.equal(actual.style.padding, "8px 16px");
    assert.equal(actual.style.paddingLeft, undefined, "paddingControl.left does not override the native control wrapper");
    assert.equal(actual.style.paddingRight, "0px");
    assert.equal(actual.style.paddingTop, "8px");
    assert.equal(actual.style.paddingBottom, "8px");
    assert.ok(actual.classes.includes("ele-xform-fieldset-control-wrap"));
  }
});

it("the generic measured-width deficit needs both right insets; the resulting budget is not a live pass", () => {
  const x = stage(), padding = contentFlowFieldPadding(x.draft.form);
  assert.equal(budget.candidateMeasured, false);
  assert.ok(budget.inputClientWidthPx < budget.dateTextWidthPx);
  assert.ok(budget.inputClientWidthPx + budget.nativeRightInsetPerMemberPx < budget.dateTextWidthPx);
  let reclaimed = 0;
  for (const id of [x.selected.fromLabel, x.selected.from]) {
    const actual = nativePadding(padding.get(id), id === x.selected.fromLabel ? "@elem/xform-description" : "@elem/xform-datetime");
    reclaimed += budget.nativeRightInsetPerMemberPx - parseFloat(actual.style.paddingRight ?? budget.nativeRightInsetPerMemberPx);
  }
  assert.equal(reclaimed, budget.totalReclaimBudgetPx);
  assert.equal(reclaimed, budget.memberCount * budget.nativeRightInsetPerMemberPx);
  assert.ok(budget.inputClientWidthPx + reclaimed >= budget.dateTextWidthPx);
});

function nativePadding(paddingControl, type) {
  const nativeDirectory = new URL("../fixtures/executor/persistence/hidden-label-runtime/", import.meta.url);
  const source = readFileSync(new URL("xform-fieldset.cjs", nativeDirectory), "utf8");
  const proof = JSON.parse(readFileSync(new URL("provenance.json", nativeDirectory), "utf8"));
  assert.equal(hash(source), proof.sources.find(entry => entry.platform === "desktop").moduleSha256);
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: "fragment",
    useState: initial => [typeof initial === "function" ? initial() : initial, () => {}],
    useMemo: fn => fn(), useCallback: fn => fn, useRef: current => ({ current }), useEffect() {}
  };
  const dependencies = {
    react,
    "@elem/xform-base": { getShowStatus: () => "edit", useFormatValidate: () => ({}), isRedValidatorInfoUITypeThemes: () => false, getSeparator: () => "," },
    "@lui/core": {}, "@mui/core": {}, "@ekp-infra/common": { Module: { getComponent: () => "inert-popover" } },
    "@ekp-runtime/utils": { appendTestAttr: () => ({}), appendTestAttrWithoutCheck: () => ({}) }
  };
  const exports = {};
  runInNewContext(source, { exports, module: { exports }, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), name);
    return dependencies[name];
  }, mk: { getSysConfig: () => "desktop", on() {}, off() {} } }, { timeout: 1000 });
  const tree = exports.default({ compose: true, hiddenLabel: true, title: "Generic date line", $$platform: "desktop", $$controlType: type,
    currentStatus: "runtime", showStatus: "edit", layout: type.endsWith("description") ? "vertical" : "horizontal",
    desktopTheme: "classic", desktopPaddingMode: "standard", paddingControl, children: react.createElement("inert-control", {}) });
  const styles = [], classes = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node.props?.className) {
      classes.push(node.props.className);
      if (node.props.className === "ele-xform-fieldset-control-wrap") styles.push(node.props.style);
    }
    node.children?.forEach(visit);
  }
  visit(tree);
  assert.equal(styles.length, 1);
  return { style: styles[0], classes };
}
