import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { runInNewContext } from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { contentFlowFieldPadding } from "../../src/executor/persistence/inline-cell-layout.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { nativeViewSaveRoundTrip, verifyNativeSaveSources } from "../helpers/native-view-save.js";

const directory = "tests/fixtures/route-validation/narrow-caption-padding";
const cases = [
  { name: "base", caption: "phone_caption", editor: "phone_value", start: "start_date", end: "end_date" },
  { name: "renamed", caption: "contact_heading", editor: "contact_number", start: "begin_date", end: "finish_date" }
];
function stages(ids = cases[0]) {
  const source = cleanSourceFile(`${directory}/${ids.name}_SysFormTemplate.xml`);
  const draft = draftSourceDraft(source), form = draft.form;
  const row = form.layout.mkTree.find(row => row.children.some(cell => cell.refIds.includes(ids.caption)));
  return { source, draft, form, row,
    cell: row.children.find(cell => cell.refIds.includes(ids.caption)),
    field: form.fields.find(field => field.id === ids.caption),
    editor: form.fields.find(field => field.id === ids.editor) };
}
const expectedPadding = right => ({ top: "8px", right: `${right}px`, bottom: "8px", left: "16px" });
const project = form => projectNativeLayoutRows(form.layout.mkTree, {
  sizing: form.layout.sizing, sourceGrid: form.layout.sourceGrid, fields: form.fields
});

for (const ids of cases) it(`budgets a declared narrow caption without changing source or executable semantics (${ids.name})`, () => {
  const { source, draft, form, cell } = stages(ids), sourceBefore = structuredClone(source), before = structuredClone(draft);
  assert.deepEqual(cell.contentFlow.items[0].width, { value: 84, unit: "px" });
  assert.deepEqual(contentFlowFieldPadding(form).get(ids.caption), expectedPadding(0));
  const rows = project(form), prepared = prepareSample(draft), config = xformConfig(prepared.update);
  const view = JSON.parse(config.viewModel[0].fdConfig);
  assert.deepEqual(view.controlStyle[ids.caption].desktop.paddingControl, expectedPadding(0));
  assert.equal(view.controlStyle[ids.caption].mobile?.paddingControl, undefined);
  assert.deepEqual(project(form), rows);
  const dates = form.layout.mkTree.flatMap(row => row.children).find(cell => cell.refIds.includes(ids.start));
  assert.deepEqual(dates.contentFlow.lines, [[ids.start], [ids.end]]);
  assert.equal(prepared.verify(prepared.update).ok, true);
  assert.deepEqual(draft, before, "Padding projection must not alter field widths, lines, fields, rules or scripts");
  assert.deepEqual(source, sourceBefore);
});

it("uses one capped budget while retaining the unavoidable native left inset", () => {
  for (const [width, right] of [[1, 0], [40, 0], [79, 0], [80, 0], [84, 0], [100, 4], [159, 15], [160, null], [240, null]]) {
    const { form, cell } = stages();
    cell.contentFlow.items[0].width.value = width;
    const padding = contentFlowFieldPadding(form).get("phone_caption");
    assert.deepEqual(padding, right === null ? undefined : expectedPadding(right), String(width));
    if (right !== null && width >= 80) assert.ok(16 + right <= width * 0.2);
    if (width < 80) assert.equal(padding.left, "16px", "The native left inset prevents a 20% guarantee below 80px");
  }
});

for (const [name, mutate] of [
  ["wide caption", x => { x.cell.contentFlow.items[0].width.value = 200; }],
  ["percentage width", x => { x.cell.contentFlow.items[0].width.unit = "%"; }],
  ["absent width with a unitless widthWeight", x => { delete x.cell.contentFlow.items[0].width; x.cell.widthWeight = 84; }],
  ["zero width", x => { x.cell.contentFlow.items[0].width.value = 0; }],
  ["non-finite width", x => { x.cell.contentFlow.items[0].width.value = Infinity; }],
  ["multiple references", x => { x.cell.refIds.push("phone_value"); x.cell.contentFlow.lines[0].push("phone_value"); x.cell.contentFlow.items.push({ referenceId: "phone_value" }); }],
  ["explicit empty second line", x => { x.cell.contentFlow.lines.push([]); }],
  ["multiple flow items", x => { x.cell.contentFlow.items.push({ referenceId: "phone_value" }); }],
  ["link enabled", x => { x.field.props.hasLink = true; x.field.props.link = "https://example.invalid/guide"; }],
  ["latent link", x => { x.field.props.link = "https://example.invalid/guide"; }],
  ["multiline description", x => { x.field.props.content += "\n说明"; }],
  ["markup description", x => { x.field.props.content = "<b>说明</b>"; }],
  ["ordinary field", x => { x.field.componentId = "xform-input"; }],
  ["data-only caption", x => { x.field.dataOnly = true; }],
  ["non-adaptive sizing", x => { x.form.layout.sizing = "source"; }],
  ["legacy sizing", x => { delete x.form.layout.sizing; }],
  ["whole-row heading", x => { x.cell.colspan = x.row.props.columns; x.row.children = [x.cell]; }],
  ["unrelated next field", x => { x.editor.title = "Different field"; }],
  ["next field retains its own title", x => { x.editor.props.hiddenLabel = false; }],
  ["non-input neighbor", x => { x.editor.componentId = "xform-address"; }],
  ["different grid row", x => { x.row.children[1].row = 1; }]
]) it(`does not add caption padding for ${name}`, () => {
  const x = stages(); mutate(x);
  assert.equal(contentFlowFieldPadding(x.form).has("phone_caption"), false);
});

it("uses only executable DSL structure, never source audit hints or unitless weights", () => {
  const { form, cell } = stages();
  for (const field of form.fields) delete field.sourceProps;
  delete cell.widthWeight;
  assert.deepEqual(contentFlowFieldPadding(form).get("phone_caption"), expectedPadding(0));
  cell.widthWeight = 100000;
  assert.deepEqual(contentFlowFieldPadding(form).get("phone_caption"), expectedPadding(0));
});

it("persists the native padding and rejects its removal or override on readback", () => {
  const { draft } = stages(), prepared = prepareSample(draft);
  for (const change of [style => { delete style.paddingControl; }, style => { style.paddingControl.right = "16px"; }]) {
    const changed = structuredClone(prepared.update), config = xformConfig(changed), view = JSON.parse(config.viewModel[0].fdConfig);
    change(view.controlStyle.phone_caption.desktop);
    config.viewModel[0].fdConfig = JSON.stringify(view);
    changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    assert.equal(prepared.verify(changed).ok, false);
  }
});

it("retains padding and explicit date lines through native save and reassembly", () => {
  verifyNativeSaveSources();
  const { draft } = stages(), prepared = prepareSample(draft), changed = structuredClone(prepared.update);
  const config = nativeViewSaveRoundTrip(xformConfig(changed));
  changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  const result = prepared.verify(changed);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

it("replays actual native fieldset padding, including its unchanged left inset", () => {
  const { draft } = stages(), config = xformConfig(prepareSample(draft).update);
  const padding = JSON.parse(config.viewModel[0].fdConfig).controlStyle.phone_caption.desktop.paddingControl;
  assert.deepEqual(padding, expectedPadding(0));
  const baseline = nativeControlPadding(undefined), actual = nativeControlPadding(padding);
  assert.equal(baseline.padding, "8px 16px");
  assert.equal(actual.padding, "8px 16px", "Native keeps the left inset from its shorthand");
  assert.equal(actual.paddingLeft, undefined, "paddingControl.left does not override this native control wrapper");
  assert.equal(actual.paddingRight, "0px");
  assert.equal(actual.paddingTop, "8px");
  assert.equal(actual.paddingBottom, "8px");
  // This is native style consumption, not measured browser text wrapping.
});

function nativeControlPadding(paddingControl) {
  const directory = new URL("../fixtures/executor/persistence/hidden-label-runtime/", import.meta.url);
  const source = readFileSync(new URL("xform-fieldset.cjs", directory), "utf8");
  const proof = JSON.parse(readFileSync(new URL("provenance.json", directory), "utf8"));
  assert.equal(createHash("sha256").update(source).digest("hex"), proof.sources.find(source => source.platform === "desktop").moduleSha256);
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: "fragment",
    useState: initial => [typeof initial === "function" ? initial() : initial, () => {}],
    useMemo: fn => fn(), useCallback: fn => fn, useRef: current => ({ current }), useEffect() {} };
  const dependencies = { react,
    "@elem/xform-base": { getShowStatus: () => "edit", useFormatValidate: () => ({}), isRedValidatorInfoUITypeThemes: () => false, getSeparator: () => "," },
    "@lui/core": {}, "@mui/core": {}, "@ekp-infra/common": { Module: { getComponent: () => "inert-popover" } },
    "@ekp-runtime/utils": { appendTestAttr: () => ({}), appendTestAttrWithoutCheck: () => ({}) } };
  const exports = {};
  runInNewContext(source, { exports, module: { exports }, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected native dependency ${name}`); return dependencies[name];
  }, mk: { getSysConfig: () => "desktop", on() {}, off() {} } }, { timeout: 1000 });
  const tree = exports.default({ compose: true, hiddenLabel: true, title: "Fixture caption", $$platform: "desktop",
    $$controlType: "@elem/xform-description", currentStatus: "runtime", showStatus: "edit", layout: "vertical",
    desktopTheme: "classic", desktopPaddingMode: "standard", paddingControl, children: react.createElement("inert-description", {}) });
  const styles = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node.props?.className === "ele-xform-fieldset-control-wrap") styles.push(node.props.style);
    node.children?.forEach(visit);
  }
  visit(tree); assert.equal(styles.length, 1); return styles[0];
}
