import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { packLayoutGrid, projectLayoutGrid } from "../../src/dsl/layout-pack.js";

describe("layout packing", () => {
  it("keeps a multi-row nested-layout stack as one atomic parent cell", () => {
    const sourceCell = {
      id: "row-3-cell-1",
      references: [
        { referenceType: "layout", referenceId: "row-3.nested-0.row-0" },
        { referenceType: "layout", referenceId: "row-3.nested-0.row-1" }
      ],
      column: 1,
      colspan: 3
    };
    const dslCell = {
      id: "layout.row-3-cell-1",
      refType: "layout",
      refIds: [
        "layout.row-3.nested-0.row-0",
        "layout.row-3.nested-0.row-1"
      ],
      column: 1,
      colspan: 3
    };

    assert.deepEqual(packLayoutGrid([sourceCell], { columns: 4 }).cells, [{
      ...sourceCell,
      row: 0,
      column: 0,
      colspan: 1
    }]);
    assert.deepEqual(projectLayoutGrid([dslCell], { rows: 1, columns: 4 }).cells, [{
      ...dslCell,
      row: 0,
      column: 1,
      colspan: 3
    }]);
  });

  it("keeps an inline multi-control cell as one projected cell", () => {
    const cell = {
      id: "row-0-cell-1",
      keepInline: true,
      refType: "field",
      refIds: ["fd_dept", "label_slash", "fd_dept_en"],
      column: 3,
      colspan: 1
    };

    assert.deepEqual(projectLayoutGrid([cell], { rows: 1, columns: 4 }).cells, [{
      ...cell,
      row: 0,
      column: 3,
      colspan: 1
    }]);
  });
});
