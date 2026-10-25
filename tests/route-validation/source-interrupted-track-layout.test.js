import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import vm from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { nativeViewSaveRoundTrip } from "../helpers/native-view-save.js";

const fixture = "tests/fixtures/route-validation/source-shared-track-layout/source-interrupted-shared-tracks_SysFormTemplate.xml";
const native = JSON.parse(readFileSync("tests/fixtures/executor/persistence/shared-source-tracks-native.json", "utf8"));
const expand = vm.runInNewContext(`(${native.functions.expandColsStyle.text})`);
const tracks = vm.runInNewContext(`(${native.functions.getColsStyle.text})`, { h: expand, o: value => typeof value });
const nodes = node => [node, ...(node.children || []).flatMap(nodes)];
const view = prepared => JSON.parse(xformConfig(prepared.update).viewModel[0].fdConfig);
const grid = (root, row) => nodes(root).find(node => node.type === "layout" && node.controlProps?.migrationRootNodeId === `layout.row-${row}`).children[0];
const wrapper = (root, id) => nodes(root).find(node => node.controlProps?.className === "mk-adaptive-main-field" && node.children?.some(child => child.key === id));
const stages = () => { const source = cleanSourceFile(fixture), draft = draftSourceDraft(source); return { source, draft, prepared: prepareSample(draft) }; };
const automatic = node => node.controlProps.colsStyle.every(style => style.value === "auto");

it("retains matching source columns after an intervening merged row through the native renderer", () => {
  const { source, prepared } = stages(), rendered = view(prepared);
  assert.deepEqual(source.form.layout.rootTable, { version: 1, kind: "standard-table", rowCount: 4 });
  for (const row of [0, 1, 3]) {
    const actual = [...tracks(grid(rendered.view.render.desktop[0], row).controlProps.colsStyle, 4)].map(parseFloat);
    assert.ok(actual.every(Number.isFinite), `row${row} must retain the source lattice instead of auto tracks`);
    // The native renderer rounds only its final remainder column to 2 places.
    for (const [column, expected] of [332 / 1516 * 100, 430 / 1516 * 100, 323 / 1516 * 100, 28.43].entries())
      assert.ok(Math.abs(actual[column] - expected) < 1e-8, `row${row} column${column} must keep its proved source width`);
    assert.ok(Math.abs(parseFloat(wrapper(rendered.view.render.desktop[0], `fd_left_${row}`).controlProps.style["--mk-adaptive-caption-width"]) - 332 / 762 * 100) < 1e-8);
    assert.ok(Math.abs(parseFloat(wrapper(rendered.view.render.desktop[0], `fd_right_${row}`).controlProps.style["--mk-adaptive-caption-width"]) - 323 / 754 * 100) < 1e-8);
  }
  assert.equal(automatic(grid(rendered.view.render.desktop[0], 2)), true, "The merged row does not borrow the incompatible four-column signature");
  for (const row of [0, 1, 2, 3]) assert.equal(automatic(grid(rendered.view.render.mobile[0], row)), true);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("shares the complete physical axis when a separated row has consistent but conflicting source weights", () => {
  const { draft } = stages();
  draft.form.layout.sourceGrid.rows[3].cells[0].widthWeight++;
  draft.form.layout.sourceGrid.rows[3].cells[0].evidence.widthWeight++;
  draft.form.layout.mkTree[3].children[0].widthWeight++;
  const prepared = prepareSample(draft), rendered = view(prepared);
  for (const row of [0, 1, 2, 3]) {
    const node = grid(rendered.view.render.desktop[0], row);
    assert.equal(node.controlProps.columns, 4);
    assert.deepEqual([...tracks(node.controlProps.colsStyle, 4)], Array(4).fill("minmax(0, 1fr)"));
    assert.equal(automatic(grid(rendered.view.render.mobile[0], row)), true);
  }
  for (const row of [0, 1, 3]) for (const side of ["left", "right"]) {
    assert.equal(wrapper(rendered.view.render.desktop[0], `fd_${side}_${row}`)
      .controlProps.style["--mk-adaptive-caption-width"], "50%");
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("does not extend a shared signature to an unproved separated row", () => {
  for (const alter of [
    draft => { draft.form.layout.mkTree[3].children[0].widthWeight++; },
    draft => { draft.form.layout.mkTree[3].sourceRef = "source.form.layout.row.unknown"; },
    draft => { draft.form.layout.sourceGrid.rows[3].sourceRow = "nested.3"; },
    draft => { delete draft.form.layout.sourceGrid.rootTable; }
  ]) {
    const { draft } = stages(); alter(draft);
    const prepared = prepareSample(draft), root = view(prepared).view.render.desktop[0];
    assert.equal(automatic(grid(root, 3)), true);
    assert.equal(wrapper(root, "fd_left_3").controlProps.style["--mk-adaptive-caption-width"], undefined);
  }
});

it("preserves separated-row tracks through native save and detects losing their alignment", () => {
  const { prepared } = stages(), before = xformConfig(prepared.update), saved = nativeViewSaveRoundTrip(before);
  for (const key of ["dataModel", "auth", "authFilter", "attribute"]) assert.deepEqual(saved[key], before[key], key);
  const target = structuredClone(prepared.update);
  target.mechanisms["sys-xform"].fdConfig = JSON.stringify(saved);
  assert.equal(prepared.verify(target).ok, true);
  const savedView = JSON.parse(saved.viewModel[0].fdConfig);
  for (const alter of [
    root => { grid(root, 3).controlProps.colsStyle = [{ startIndex: 0, count: 4, value: "auto" }]; },
    root => { delete wrapper(root, "fd_left_3").controlProps.style["--mk-adaptive-caption-width"]; }
  ]) {
    const changed = structuredClone(saved), rendered = structuredClone(savedView); alter(rendered.view.render.desktop[0]);
    changed.viewModel[0].fdConfig = JSON.stringify(rendered); target.mechanisms["sys-xform"].fdConfig = JSON.stringify(changed);
    assert.equal(prepared.verify(target).ok, false);
  }
});
