import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile } from "../../src/translator/index.js";
// Preserve the retained source-width contract explicitly.
import { draftSourceDraft } from "../helpers/source-sized-draft.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/mobile-number-layout/mobile-number-layout_SysFormTemplate.xml";
const draft = () => draftSourceDraft(cleanSourceFile(fixture));
const viewOf = update => JSON.parse(xformConfig(update).viewModel[0].fdConfig);
const rowsOf = (view, scene) => view.view.render[scene][0].children[0].children;
const gridOf = row => row.children.find(node => node.type === "@elem/layout-grid");
function parentOf(node, id) {
  if (node.children?.some(child => child.key === id)) return node;
  return (node.children || []).map(child => parentOf(child, id)).find(Boolean);
}

it("keeps source value budgets in mobile native shells, including the 80px editable minimum", () => {
  const dsl = draft(), before = structuredClone(dsl);
  const prepared = prepareSample(dsl), view = viewOf(prepared.update);
  for (const [id, desktop, mobile] of [["fd_input", 72, 112], ["fd_total60", 92, 92], ["fd_total100", 132, 132], ["fd_readonly_number", 92, 92]]) {
    assert.equal(parentOf(view.view.render.desktop[0], id).controlProps.style.width, `${desktop}px`);
    assert.equal(parentOf(view.view.render.mobile[0], id).controlProps.style.width, `${mobile}px`);
  }
  assert.deepEqual(dsl, before);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("preserves rows, source column proportions, cells and desktop geometry while mobile has intrinsic minima", () => {
  const dsl = draft(), prepared = prepareSample(dsl), view = viewOf(prepared.update);
  const projections = projectNativeLayoutRows(dsl.form.layout.mkTree);
  const desktop = rowsOf(view, "desktop"), mobile = rowsOf(view, "mobile");
  assert.equal(mobile.length, desktop.length);
  for (let index = 0; index < 4; index++) {
    const pc = gridOf(desktop[index]), phone = gridOf(mobile[index]);
    assert.deepEqual(pc.controlProps.colsStyle, projections[index].colsStyle);
    assert.deepEqual(phone.controlProps.colsStyle, projections[index].colsStyle.map(style => ({ ...style, value: `minmax(max-content, ${Number.parseFloat(style.value)}fr)` })));
    assert.deepEqual(phone.controlProps.style, { overflowX: "auto" });
    assert.equal(phone.controlProps.columns, pc.controlProps.columns);
    assert.equal(phone.controlProps.rows, pc.controlProps.rows);
    assert.deepEqual(phone.children.map(cell => ({ props: cell.controlProps, key: cell.key })), pc.children.map(cell => ({ props: cell.controlProps, key: cell.key })));
  }
  // The visible-title calculation has no source-backed display-width profile.
  assert.deepEqual(gridOf(mobile[4]), gridOf(desktop[4]));
});

for (const [name, change] of [
  ["width budget", view => { parentOf(view.view.render.mobile[0], "fd_total60").controlProps.style.width = "60px"; }],
  ["editable minimum", view => { parentOf(view.view.render.mobile[0], "fd_input").controlProps.style.width = "72px"; }],
  ["column minima", view => { gridOf(rowsOf(view, "mobile")[0]).controlProps.colsStyle = gridOf(rowsOf(view, "desktop")[0]).controlProps.colsStyle; }],
  ["scroll policy", view => { delete gridOf(rowsOf(view, "mobile")[0]).controlProps.style; }],
  ["hidden overflow", view => { gridOf(rowsOf(view, "mobile")[0]).controlProps.style = { overflowX: "hidden" }; }],
  ["cell column", view => { gridOf(rowsOf(view, "mobile")[0]).children[0].controlProps.column = 2; }],
  ["cell span", view => { gridOf(rowsOf(view, "mobile")[0]).children[0].controlProps.columnSpan = 2; }],
  ["grid row count", view => { gridOf(rowsOf(view, "mobile")[0]).controlProps.rows = 2; }],
  ["oversized row tracks", view => { const grid = gridOf(rowsOf(view, "mobile")[0]); grid.controlProps.rowsStyle = [{ startIndex: 0, count: grid.controlProps.rows, value: "10000px" }]; }]
]) it(`rejects persisted mobile ${name} loss`, () => {
  const prepared = prepareSample(draft()), changed = structuredClone(prepared.update), config = xformConfig(changed);
  const view = JSON.parse(config.viewModel[0].fdConfig);
  change(view);
  config.viewModel[0].fdConfig = JSON.stringify(view);
  changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  assert.equal(prepared.verify(changed).ok, false);
});

it("completes source review, guarded execution, readback and transfer-record route", async () => {
  const result = await runRouteCase("mobile-number-layout-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.transferRecord.status, "recorded");
});

for (const value of [null, [], [{ startIndex: 0, count: 1, value: "0px" }]]) it(`accepts the equivalent natural-row default ${JSON.stringify(value)}`, () => {
  const prepared = prepareSample(draft()), changed = structuredClone(prepared.update), config = xformConfig(changed);
  const view = JSON.parse(config.viewModel[0].fdConfig);
  gridOf(rowsOf(view, "mobile")[0]).controlProps.rowsStyle = value;
  config.viewModel[0].fdConfig = JSON.stringify(view);
  changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  assert.equal(prepared.verify(changed).ok, true);
});
