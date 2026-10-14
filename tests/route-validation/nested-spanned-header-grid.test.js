import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { prepareSample } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";
import { localCorpusIt } from "../helpers/local-corpus.js";
import { isStaticHeaderGridShape } from "../../src/translator/standard-table-grid.js";

const fixture = "tests/fixtures/route-validation/nested-spanned-header-grid/route-nested-spanned-header-grid_SysFormTemplate.xml";
const headings = ["预付款", "投料款", "进度款", "发货款", "到货款", "调试款", "质保金"];

describe("nested static header and spanned rows Route case", () => {
  it("recognizes aligned headings with a blank corner and merged footer, but not unrelated captions", () => {
    const cell = (column, description, colspan = 1) => ({ column, colspan, controls: description === null ? [] : [{ description }] });
    const header = [cell(0, null), cell(1, true), cell(2, true)];
    const values = [cell(0, true), cell(1, false), cell(2, false)];
    const footer = [cell(0, true), cell(1, false, 2)];
    assert.equal(isStaticHeaderGridShape([header, values, footer]), true);
    assert.equal(isStaticHeaderGridShape([[cell(0, true), cell(1, true)], [cell(0, false), cell(1, false)]]), false);
    assert.equal(isStaticHeaderGridShape([header, [cell(0, true), cell(1, false, 2)]]), false);
    assert.equal(isStaticHeaderGridShape([header, values, [cell(0, false)]]), false);
    assert.equal(isStaticHeaderGridShape([[cell(0, true), cell(1, false), cell(2, true)], values]), false);
  });

  it("retains headers above inline inputs and the shared eight-column geometry", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    for (let i = 1; i <= 7; i += 1) {
      assert.equal(source.form.controls.find(field => field.id === `label_header_${i}`)?.title, headings[i - 1]);
    }
    const header = draft.form.layout.mkTree.find(row => row.id === "layout.row-0.nested-0.row-0");
    const values = draft.form.layout.mkTree.find(row => row.id === "layout.row-0.nested-0.row-1");
    const deadline = draft.form.layout.mkTree.find(row => row.id === "layout.row-0.nested-0.row-2");
    assert.equal(header.props.columns, 8);
    assert.equal(values.props.columns, 8);
    assert.equal(deadline.props.columns, 8);
    assert.deepEqual(header.children.map(cell => cell.column), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(deadline.children.map(cell => cell.colspan), [1, 7]);
    assert.deepEqual(values.children[1].refIds, ["fd_ratio_1", "fd_unit_1"]);
    assert.deepEqual(values.children[1].contentFlow.lines, [["fd_ratio_1", "fd_unit_1"]]);
    const [native] = projectNativeLayoutRows(draft.form.layout.mkTree);
    assert.equal(native.rows, 3);
    assert.equal(native.columns, 9);
    const find = id => native.cells.find(cell => cell.refIds.includes(id));
    for (let i = 1; i <= 7; i += 1) {
      assert.equal(find(`label_header_${i}`).row, 0);
      assert.equal(find(`fd_ratio_${i}`).row, 1);
      assert.equal(find(`label_header_${i}`).column, find(`fd_ratio_${i}`).column);
    }
    assert.equal(find("fd_deadline_label").colspan, 1);
    assert.equal(find("fd_deadline").colspan, 7);
    assert.equal(find("fd_section").rowspan, 3);
  });

  it("preserves the independently specified positions through fake execution and readback", async () => {
    const result = await runRouteCase("nested-spanned-header-grid-success");
    const row = result.execution.readback.form.layoutRows.find(row => row.rootNodeId === "layout.row-0");
    assert.equal(result.execution.readback.ok, true);
    assert.equal(row.columns, 9);
    assert.equal(row.rows, 3);
    const find = id => row.cells.find(cell => cell.fieldIds.includes(id));
    for (let i = 1; i <= 7; i += 1) {
      assert.equal(find(`label_header_${i}`).row, 0);
      assert.equal(find(`fd_ratio_${i}`).row, 1);
      assert.equal(find(`label_header_${i}`).column, find(`fd_ratio_${i}`).column);
    }
    assert.equal(find("fd_deadline").colspan, 7);
  });

  it("leaves room for the input and unit wrappers in a weighted classic-theme grid", () => {
    const draft = draftSourceDraft(cleanSourceFile(fixture));
    const widths = [261, 211, 166, 157, 157, 151, 138, 135];
    for (const row of draft.form.layout.mkTree) {
      for (const cell of row.children) {
        if (cell.colspan !== 1) continue;
        cell.widthWeight = row.id === "layout.row-0" ? 332 : widths[cell.column];
      }
    }
    const [native] = projectNativeLayoutRows(draft.form.layout.mkTree);
    // 66px source editor, 33px classic unit wrapper, 18px grid chrome, plus rounding room.
    assert.ok(native.colsStyle.slice(2).every(style => parseFloat(style.value) * 1276 / 100 >= 118));
    assert.equal(native.columns, 9);
  });

  localCorpusIt("preserves the production-notice payment table instead of reproducing its broken screenshot", () => {
    const draft = draftSourceDraft(cleanSourceFile("tests/fixtures/source/18b940a16be81952fdd4eb64816aa02c"));
    const fields = new Map(draft.form.fields.map(field => [field.id, field]));
    const rows = projectNativeLayoutRows(draft.form.layout.mkTree);
    const row = rows.find(row => row.id === "layout.row-10");
    const headingCells = row.cells.filter(cell => cell.ownerNodeId === "layout.row-10.nested-0.row-0");
    assert.deepEqual(headingCells.flatMap(cell => cell.refIds.map(id => fields.get(id)?.title)), ["付款方式：", ...headings]);
    const inputs = row.cells.filter(cell => cell.ownerNodeId === "layout.row-10.nested-0.row-1");
    assert.equal(new Set(inputs.map(cell => cell.row)).size, 1);
    const deadline = row.cells.filter(cell => cell.ownerNodeId === "layout.row-10.nested-0.row-2");
    assert.deepEqual(deadline.map(cell => cell.colspan), [1, 7]);
    const prepared = prepareSample(draft);
    const readback = prepared.verify(prepared.update);
    assert.equal(readback.partitions.form, "verified", JSON.stringify(readback.diagnostics.filter(item => item.partition === "form")));
  });
});
