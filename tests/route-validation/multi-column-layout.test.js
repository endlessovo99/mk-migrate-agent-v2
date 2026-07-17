import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMPONENTS_BY_ID } from "../../src/dsl/catalogs.js";
import { runRouteCase } from "./run-route-case.js";

const markerId = "fd_overflow_row";
const fieldIds = [
  "fd_slot_alpha",
  "fd_slot_bravo",
  "fd_slot_charlie",
  "fd_slot_delta",
  "fd_slot_echo"
];
const designerItemTid =
  "xform-ide-sidebar-tabPane-control-tablelayout-multiLineColumn";

describe("multi-column layout Route-validation", () => {
  it("carries a source-wide row through review, execution, and native readback as 1×5", async () => {
    const result = await runRouteCase("five-column-layout-success");
    const targetRow = result.dsl.form.layout.mkTree.find((row) =>
      row.sourceMarkers?.includes(markerId)
    );
    const observedRow = result.execution.readback.form.layoutRows.find((row) =>
      row.cells.some((cell) => cell.fieldIds.includes(fieldIds[0]))
    );
    const catalogTarget = COMPONENTS_BY_ID.get("xform-multi-row-table-layout")?.target;

    assert.equal(result.execution.readback.partitions.form, "verified");
    assert.equal(targetRow?.componentId, "xform-multi-row-table-layout");
    assert.deepEqual(targetRow?.props, { rows: 1, columns: 5 });
    assert.deepEqual(targetRow?.children.map((cell) => [cell.row, cell.column]), [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4]
    ]);
    assert.equal(catalogTarget?.designerItemTid, designerItemTid);
    assert.equal(catalogTarget?.desktop, "@elem/layout-grid");
    assert.equal(observedRow?.rows, 1);
    assert.equal(observedRow?.columns, 5);
    assert.deepEqual(observedRow?.cells.flatMap((cell) => cell.fieldIds), fieldIds);
    assert.deepEqual(observedRow?.cells.map((cell) => [cell.row, cell.column]), [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4]
    ]);
  });
});
