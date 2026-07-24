import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyFormPayload } from "../../src/executor/persistence/form-writer.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { sampleBaseTemplate, xformConfig } from "../helpers/persistence.js";

function layoutNode(id, columns, children) {
  return {
    id,
    componentId: `xform-flex-1-${columns}-layout`,
    props: { columns, sourceColumns: columns },
    sourceRef: `source.form.layout.row.${id}`,
    sourceMarkers: [id],
    children
  };
}

function fieldCell(ownerId, index, fieldId, column, colspan = 1) {
  return {
    id: `${ownerId}.cell-${index}`,
    refType: "field",
    refIds: [fieldId],
    sourceRef: `source.form.layout.cell.${ownerId}.cell-${index}`,
    row: 0,
    column,
    colspan
  };
}

function receptionLayout() {
  const nested = [
    layoutNode("layout.inner-1", 3, [
      fieldCell("layout.inner-1", 0, "fd_a1", 0),
      fieldCell("layout.inner-1", 1, "fd_a2", 1),
      fieldCell("layout.inner-1", 2, "fd_a3", 2)
    ]),
    layoutNode("layout.inner-2", 3, [
      fieldCell("layout.inner-2", 0, "fd_b1", 0),
      fieldCell("layout.inner-2", 1, "fd_b2", 1),
      fieldCell("layout.inner-2", 2, "fd_b3", 2)
    ]),
    layoutNode("layout.inner-3", 2, [
      fieldCell("layout.inner-3", 0, "fd_c1", 0),
      fieldCell("layout.inner-3", 1, "fd_c2", 1)
    ]),
    layoutNode("layout.inner-4", 2, [
      fieldCell("layout.inner-4", 0, "fd_d1", 0),
      fieldCell("layout.inner-4", 1, "fd_d2", 1)
    ]),
    layoutNode("layout.inner-5", 1, [
      fieldCell("layout.inner-5", 0, "fd_e1", 0)
    ]),
    layoutNode("layout.inner-6", 1, [
      fieldCell("layout.inner-6", 0, "fd_f1", 0)
    ])
  ];
  const outer = layoutNode("layout.outer", 4, [
    fieldCell("layout.outer", 0, "fd_title", 0),
    {
      id: "layout.outer.cell-nested",
      refType: "layout",
      refIds: nested.map((node) => node.id),
      sourceRef: "source.form.layout.cell.layout.outer.cell-nested",
      row: 0,
      column: 1,
      colspan: 3
    }
  ]);
  return [outer, ...nested];
}

describe("nested native layout projection", () => {
  it("lowers a nested source region into one minimal proportional grid", () => {
    const [projection] = projectNativeLayoutRows(receptionLayout());

    assert.deepEqual(
      { id: projection.id, rows: projection.rows, columns: projection.columns },
      { id: "layout.outer", rows: 6, columns: 5 }
    );
    assert.deepEqual(
      projection.colsStyle,
      [
        { startIndex: 0, count: 1, value: "25%" },
        { startIndex: 1, count: 1, value: "25%" },
        { startIndex: 2, count: 1, value: "12.5%" },
        { startIndex: 3, count: 1, value: "12.5%" },
        { startIndex: 4, count: 1, value: "25%" }
      ]
    );
    assert.deepEqual(
      projection.cells.map((cell) => ({
        field: cell.refIds[0],
        owner: cell.ownerNodeId,
        row: cell.row,
        column: cell.column,
        colspan: cell.colspan,
        rowspan: cell.rowspan
      })),
      [
        {
          field: "fd_title",
          owner: "layout.outer",
          row: 0,
          column: 0,
          colspan: 1,
          rowspan: 6
        },
        { field: "fd_a1", owner: "layout.inner-1", row: 0, column: 1, colspan: 1, rowspan: 1 },
        { field: "fd_a2", owner: "layout.inner-1", row: 0, column: 2, colspan: 2, rowspan: 1 },
        { field: "fd_a3", owner: "layout.inner-1", row: 0, column: 4, colspan: 1, rowspan: 1 },
        { field: "fd_b1", owner: "layout.inner-2", row: 1, column: 1, colspan: 1, rowspan: 1 },
        { field: "fd_b2", owner: "layout.inner-2", row: 1, column: 2, colspan: 2, rowspan: 1 },
        { field: "fd_b3", owner: "layout.inner-2", row: 1, column: 4, colspan: 1, rowspan: 1 },
        { field: "fd_c1", owner: "layout.inner-3", row: 2, column: 1, colspan: 2, rowspan: 1 },
        { field: "fd_c2", owner: "layout.inner-3", row: 2, column: 3, colspan: 2, rowspan: 1 },
        { field: "fd_d1", owner: "layout.inner-4", row: 3, column: 1, colspan: 2, rowspan: 1 },
        { field: "fd_d2", owner: "layout.inner-4", row: 3, column: 3, colspan: 2, rowspan: 1 },
        { field: "fd_e1", owner: "layout.inner-5", row: 4, column: 1, colspan: 4, rowspan: 1 },
        { field: "fd_f1", owner: "layout.inner-6", row: 5, column: 1, colspan: 4, rowspan: 1 }
      ]
    );
    assert.deepEqual(projection.cells[0].ownerNodePath, ["layout.outer"]);
    assert.deepEqual(
      projection.cells.find((cell) => cell.refIds[0] === "fd_c1").ownerNodePath,
      ["layout.outer", "layout.inner-3"]
    );
  });

  it("uses one native column when every used boundary is full-span", () => {
    const inner = layoutNode("layout.inner-full", 4, [
      fieldCell("layout.inner-full", 0, "fd_inner_full", 0, 4)
    ]);
    const outer = layoutNode("layout.outer-full", 4, [{
      id: "layout.outer-full.cell-nested",
      refType: "layout",
      refIds: [inner.id],
      sourceRef: "source.form.layout.cell.layout.outer-full.cell-nested",
      row: 0,
      column: 0,
      colspan: 4
    }]);

    const [projection] = projectNativeLayoutRows([outer, inner]);

    assert.deepEqual(
      { rows: projection.rows, columns: projection.columns },
      { rows: 1, columns: 1 }
    );
    assert.deepEqual(projection.cells, [{
      id: "layout.inner-full.cell-0",
      ownerNodeId: "layout.inner-full",
      ownerNodePath: ["layout.outer-full", "layout.inner-full"],
      refType: "field",
      refIds: ["fd_inner_full"],
      row: 0,
      column: 0,
      colspan: 1,
      rowspan: 1
    }]);
  });

  it("keeps the complete owner path through a three-level projection", () => {
    const grandchild = layoutNode("layout.grandchild", 1, [
      fieldCell("layout.grandchild", 0, "fd_grandchild", 0)
    ]);
    const inner = {
      id: "layout.inner",
      componentId: "xform-multi-row-table-layout",
      props: { rows: 2, columns: 1, sourceColumns: 1 },
      sourceRef: "source.form.layout.row.layout.inner",
      sourceMarkers: ["layout.inner"],
      children: [
        fieldCell("layout.inner", 0, "fd_inner", 0),
        {
          id: "layout.inner.cell-nested",
          refType: "layout",
          refIds: [grandchild.id],
          sourceRef: "source.form.layout.cell.layout.inner.cell-nested",
          row: 1,
          column: 0,
          colspan: 1
        }
      ]
    };
    const outer = layoutNode("layout.outer-three-level", 2, [
      fieldCell("layout.outer-three-level", 0, "fd_outer", 0),
      {
        id: "layout.outer-three-level.cell-nested",
        refType: "layout",
        refIds: [inner.id],
        sourceRef: "source.form.layout.cell.layout.outer-three-level.cell-nested",
        row: 0,
        column: 1,
        colspan: 1
      }
    ]);

    const [projection] = projectNativeLayoutRows([outer, inner, grandchild]);

    assert.deepEqual(
      { rows: projection.rows, columns: projection.columns },
      { rows: 2, columns: 2 }
    );
    assert.deepEqual(
      projection.cells.map((cell) => ({
        field: cell.refIds[0],
        owner: cell.ownerNodeId,
        ownerPath: cell.ownerNodePath,
        row: cell.row,
        column: cell.column,
        colspan: cell.colspan,
        rowspan: cell.rowspan
      })),
      [
        {
          field: "fd_outer",
          owner: "layout.outer-three-level",
          ownerPath: ["layout.outer-three-level"],
          row: 0,
          column: 0,
          colspan: 1,
          rowspan: 2
        },
        {
          field: "fd_inner",
          owner: "layout.inner",
          ownerPath: ["layout.outer-three-level", "layout.inner"],
          row: 0,
          column: 1,
          colspan: 1,
          rowspan: 1
        },
        {
          field: "fd_grandchild",
          owner: "layout.grandchild",
          ownerPath: ["layout.outer-three-level", "layout.inner", "layout.grandchild"],
          row: 1,
          column: 1,
          colspan: 1,
          rowspan: 1
        }
      ]
    );
  });

  it("falls back to the root source columns when no exact grid exists up to eight", () => {
    const fifths = layoutNode(
      "layout.fifths",
      5,
      Array.from({ length: 5 }, (_, index) =>
        fieldCell("layout.fifths", index, `fd_fifth_${index + 1}`, index)
      )
    );
    const sevenths = layoutNode(
      "layout.sevenths",
      7,
      Array.from({ length: 7 }, (_, index) =>
        fieldCell("layout.sevenths", index, `fd_seventh_${index + 1}`, index)
      )
    );
    const outer = layoutNode("layout.outer-fallback", 4, [{
      id: "layout.outer-fallback.cell-nested",
      refType: "layout",
      refIds: [fifths.id, sevenths.id],
      sourceRef: "source.form.layout.cell.layout.outer-fallback.cell-nested",
      row: 0,
      column: 0,
      colspan: 4
    }]);

    const [projection] = projectNativeLayoutRows([outer, fifths, sevenths]);

    assert.equal(projection.columns, 4);
    assert.equal(hasProjectedOverlap(projection), false);
  });

  it("keeps an ordinary root byte-for-coordinate compatible with the existing projection", () => {
    const root = {
      id: "layout.plain",
      componentId: "xform-multi-row-table-layout",
      props: { rows: 2, columns: 4 },
      sourceRef: "source.form.layout.row.layout.plain",
      children: [
        fieldCell("layout.plain", 0, "fd_a", 0),
        {
          ...fieldCell("layout.plain", 1, "fd_b", 3),
          row: 1,
          colspan: 1
        }
      ]
    };

    assert.deepEqual(projectNativeLayoutRows([root]), [{
      id: "layout.plain",
      rows: 2,
      columns: 4,
      cells: [
        {
          id: "layout.plain.cell-0",
          ownerNodeId: "layout.plain",
          ownerNodePath: ["layout.plain"],
          refType: "field",
          refIds: ["fd_a"],
          row: 0,
          column: 0,
          colspan: 1,
          rowspan: 1
        },
        {
          id: "layout.plain.cell-1",
          ownerNodeId: "layout.plain",
          ownerNodePath: ["layout.plain"],
          refType: "field",
          refIds: ["fd_b"],
          row: 1,
          column: 3,
          colspan: 1,
          rowspan: 1
        }
      ]
    }]);
  });

  it("wraps a nested row when its source columns exceed the available parent region", () => {
    const inner = layoutNode(
      "layout.inner-wide",
      8,
      Array.from({ length: 8 }, (_, index) =>
        fieldCell("layout.inner-wide", index, `fd_wide_${index + 1}`, index)
      )
    );
    const outer = {
      id: "layout.outer-narrow-region",
      componentId: "xform-multi-row-table-layout",
      props: { rows: 1, columns: 8, sourceColumns: 8 },
      sourceRef: "source.form.layout.row.outer-narrow-region",
      children: [
        {
          ...fieldCell("layout.outer-narrow-region", 0, "fd_wide_title", 0, 5)
        },
        {
          id: "layout.outer-narrow-region.cell-nested",
          refType: "layout",
          refIds: [inner.id],
          sourceRef: "source.form.layout.cell.outer-narrow-region.cell-nested",
          row: 0,
          column: 5,
          colspan: 3
        }
      ]
    };

    const [projection] = projectNativeLayoutRows([outer, inner]);
    assert.deepEqual(
      { rows: projection.rows, columns: projection.columns },
      { rows: 3, columns: 4 }
    );
    assert.deepEqual(projection.colsStyle, [
      { startIndex: 0, count: 1, value: "62.5%" },
      { startIndex: 1, count: 1, value: "12.5%" },
      { startIndex: 2, count: 1, value: "12.5%" },
      { startIndex: 3, count: 1, value: "12.5%" }
    ]);
    assert.deepEqual(
      projection.cells.map((cell) => ({
        field: cell.refIds[0],
        row: cell.row,
        column: cell.column,
        colspan: cell.colspan,
        rowspan: cell.rowspan
      })),
      [
        { field: "fd_wide_title", row: 0, column: 0, colspan: 1, rowspan: 3 },
        { field: "fd_wide_1", row: 0, column: 1, colspan: 1, rowspan: 1 },
        { field: "fd_wide_2", row: 0, column: 2, colspan: 1, rowspan: 1 },
        { field: "fd_wide_3", row: 0, column: 3, colspan: 1, rowspan: 1 },
        { field: "fd_wide_4", row: 1, column: 1, colspan: 1, rowspan: 1 },
        { field: "fd_wide_5", row: 1, column: 2, colspan: 1, rowspan: 1 },
        { field: "fd_wide_6", row: 1, column: 3, colspan: 1, rowspan: 1 },
        { field: "fd_wide_7", row: 2, column: 1, colspan: 1, rowspan: 1 },
        { field: "fd_wide_8", row: 2, column: 2, colspan: 1, rowspan: 1 }
      ]
    );
    assert.equal(hasProjectedOverlap(projection), false);
  });

  it("writes the captured native columnSpan property for a minimal nested grid", () => {
    const firstInner = layoutNode("layout.inner-first", 2, [
      fieldCell("layout.inner-first", 0, "fd_inner_a", 0),
      fieldCell("layout.inner-first", 1, "fd_inner_b", 1)
    ]);
    const secondInner = layoutNode("layout.inner-second", 1, [
      fieldCell("layout.inner-second", 0, "fd_inner_c", 0)
    ]);
    const outer = layoutNode("layout.outer-minimal", 4, [
      fieldCell("layout.outer-minimal", 0, "fd_title", 0),
      {
        id: "layout.outer-minimal.cell-nested",
        refType: "layout",
        refIds: [firstInner.id, secondInner.id],
        sourceRef: "source.form.layout.cell.layout.outer-minimal.cell-nested",
        row: 0,
        column: 1,
        colspan: 3
      }
    ]);
    const fieldIds = ["fd_title", "fd_inner_a", "fd_inner_b", "fd_inner_c"];
    const form = {
      fields: fieldIds.map((id) => ({
        id,
        title: id,
        type: "text",
        componentId: "xform-input",
        props: {},
        sourceRef: `source.form.control.${id}`
      })),
      layout: {
        sourceGrid: { source: "captured-native-shape", rows: [] },
        mkTree: [outer, firstInner, secondInner]
      }
    };

    const template = applyFormPayload(sampleBaseTemplate(), { form });
    const view = JSON.parse(xformConfig(template).viewModel[0].fdConfig);
    const grid = view.view.render.desktop[0].children[0].children[0].children[0];
    const title = grid.children.find((item) => item.children[0].key === "fd_title");
    const finalInner = grid.children.find((item) =>
      item.children[0].key === "fd_inner_c"
    );

    assert.deepEqual(
      { rows: grid.controlProps.rows, columns: grid.controlProps.columns },
      { rows: 2, columns: 3 }
    );
    assert.deepEqual(grid.controlProps.colsStyle, [
      { startIndex: 0, count: 1, value: "25%" },
      { startIndex: 1, count: 1, value: "37.5%" },
      { startIndex: 2, count: 1, value: "37.5%" }
    ]);
    assert.equal(title.controlProps.rowSpan, 2);
    assert.equal(title.controlProps.columnSpan, 1);
    assert.equal(Object.hasOwn(title.controlProps, "colSpan"), false);
    assert.equal(finalInner.controlProps.rowSpan, 1);
    assert.equal(finalInner.controlProps.columnSpan, 2);
    assert.equal(Object.hasOwn(finalInner.controlProps, "colSpan"), false);
  });

  it("writes only the native root grid and never persists a layout id as a field key", () => {
    const mkTree = receptionLayout();
    const fieldIds = ["fd_title", "fd_a1", "fd_a2", "fd_a3", "fd_b1", "fd_b2", "fd_b3",
      "fd_c1", "fd_c2", "fd_d1", "fd_d2", "fd_e1", "fd_f1"];
    const form = {
      fields: fieldIds.map((id) => ({
        id,
        title: id,
        type: "text",
        componentId: "xform-input",
        props: {},
        sourceRef: `source.form.control.${id}`
      })),
      layout: { sourceGrid: { source: "test", rows: [] }, mkTree }
    };

    const template = applyFormPayload(sampleBaseTemplate(), { form });
    const view = JSON.parse(xformConfig(template).viewModel[0].fdConfig);
    for (const scene of ["desktop", "mobile"]) {
      const nativeRoots = view.view.render[scene][0].children[0].children;

      assert.equal(nativeRoots.length, 1, scene);
      assert.equal(nativeRoots[0].controlProps.migrationRootNodeId, "layout.outer", scene);
      const grid = nativeRoots[0].children[0];
      assert.deepEqual(
        { rows: grid.controlProps.rows, columns: grid.controlProps.columns },
        { rows: 6, columns: 5 },
        scene
      );
      assert.deepEqual(
        grid.controlProps.colsStyle,
        [
          { startIndex: 0, count: 1, value: "25%" },
          { startIndex: 1, count: 1, value: "25%" },
          { startIndex: 2, count: 1, value: "12.5%" },
          { startIndex: 3, count: 1, value: "12.5%" },
          { startIndex: 4, count: 1, value: "25%" }
        ],
        scene
      );
      assert.equal(
        grid.children.some((item) => item.children.some((child) => child.key.startsWith("layout."))),
        false,
        scene
      );
      assert.deepEqual(
        grid.children[0].controlProps,
        {
          ...grid.children[0].controlProps,
          rowSpan: 6,
          migrationOwnerNodeId: "layout.outer",
          migrationCellId: "layout.outer.cell-0",
          migrationRowspan: 6
        },
        scene
      );
      assert.equal(
        grid.children.find((item) => item.children[0].key === "fd_c1")
          .controlProps.migrationOwnerNodeId,
        "layout.inner-3",
        scene
      );
    }
  });
});

function hasProjectedOverlap(projection) {
  const occupied = new Set();
  for (const cell of projection.cells) {
    for (let row = cell.row; row < cell.row + (cell.rowspan || 1); row += 1) {
      for (let column = cell.column; column < cell.column + cell.colspan; column += 1) {
        const key = `${row}:${column}`;
        if (occupied.has(key)) return true;
        occupied.add(key);
      }
    }
  }
  return false;
}
