import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { observeNativeTemplate } from "../../src/executor/persistence/observer.js";
import { sampleForm, sampleTrustedDsl } from "../helpers/sample-dsl.js";
import {
  prepareSample,
  persistAndVerify,
  xformConfig
} from "../helpers/persistence.js";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/executor/persistence"
);
const capturedNativeLayout = JSON.parse(
  readFileSync(
    join(fixtureDir, "nested-3x2-column-span-native-layout.json"),
    "utf8"
  )
);

describe("nested layout persistence contract", () => {
  it("reports native roots separately from DSL layout nodes in dry-run", () => {
    const plan = buildDryRunPlan(nestedLayoutDsl());
    const mapping = plan.steps.find((step) => step.id === "map-form-layout");
    const readback = plan.steps.find((step) => step.id === "readback");

    assert.equal(plan.ok, true);
    assert.equal(mapping.layoutRows, 2);
    assert.equal(mapping.layoutRootCount, 2);
    assert.equal(mapping.layoutNodeCount, 4);
    assert.equal(mapping.nestedLayoutCount, 2);
    assert.equal(readback.expectedLayoutRows, 2);
    assert.equal(readback.expectedLayoutRootCount, 2);
    assert.equal(readback.expectedLayoutNodeCount, 4);
    assert.equal(readback.expectedNestedLayoutCount, 2);
  });

  it("does not read a nested layout id back as a field", () => {
    const { readback } = persistAndVerify(nestedLayoutDsl());

    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.form.layoutRowCount, 2);
    assert.equal(readback.form.layoutRootCount, 2);
    assert.equal(readback.form.layoutNodeCount, 4);
    assert.equal(readback.form.nestedLayoutCount, 2);
    const outer = readback.form.layoutRows.find((row) => row.rootNodeId === "layout.outer");
    const subject = outer.cells.find((cell) => cell.fieldIds.includes("fd_subject"));
    const amount = outer.cells.find((cell) => cell.fieldIds.includes("fd_amount"));
    assert.equal(subject.ownerNodeId, "layout.outer");
    assert.deepEqual(subject.ownerNodePath, ["layout.outer"]);
    assert.equal(subject.refType, "field");
    assert.equal(subject.rowspan, 2);
    assert.equal(amount.ownerNodeId, "layout.inner");
    assert.deepEqual(
      amount.ownerNodePath,
      ["layout.outer", "layout.middle", "layout.inner"]
    );
    assert.equal(amount.refType, "field");
    assert.equal(
      readback.form.layoutRows.some((row) =>
        row.cells.some((cell) => cell.fieldIds.includes("layout.inner"))
      ),
      false
    );
  });

  it("observes the user-captured native 3x2 merged grid independently of the writer", () => {
    const prepared = prepareSample(capturedNativeShapeDsl());
    const template = structuredClone(prepared.update);
    const config = xformConfig(template);
    const scene = JSON.parse(config.viewModel[0].fdConfig);
    const main = scene.view.render.desktop[0].children[0];
    main.children = [structuredClone(capturedNativeLayout.nativeLayout)];
    config.viewModel[0].fdConfig = JSON.stringify(scene);
    template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);

    const observed = observeNativeTemplate(template);
    assert.equal(
      observed.form.status,
      "verified",
      JSON.stringify(observed.form.diagnostics)
    );
    const [row] = observed.form.value.layoutRows;
    assert.deepEqual(
      { rows: row.rows, columns: row.columns, colsStyle: row.colsStyle },
      {
        rows: 2,
        columns: 3,
        colsStyle: capturedNativeLayout.nativeLayout.children[0].controlProps.colsStyle
      }
    );
    assert.deepEqual(
      row.cells.map((cell) => ({
        fieldId: cell.fieldIds[0],
        row: cell.row,
        column: cell.column,
        colspan: cell.colspan,
        rowspan: cell.rowspan
      })),
      [
        {
          fieldId: "fd_nested_left",
          row: 0,
          column: 0,
          colspan: 1,
          rowspan: 2
        },
        {
          fieldId: "fd_nested_top_middle",
          row: 0,
          column: 1,
          colspan: 1,
          rowspan: 1
        },
        {
          fieldId: "fd_nested_top_right",
          row: 0,
          column: 2,
          colspan: 1,
          rowspan: 1
        },
        {
          fieldId: "fd_nested_bottom_middle",
          row: 1,
          column: 1,
          colspan: 1,
          rowspan: 1
        },
        {
          fieldId: "fd_nested_bottom_right",
          row: 1,
          column: 2,
          colspan: 1,
          rowspan: 1
        }
      ]
    );
    assert.equal(
      capturedNativeLayout.nativeLayout.children[0].children.some((item) =>
        item.children.some((child) =>
          child.type === "layout" || child.type === "@elem/layout-grid"
        )
      ),
      false
    );

    const widened = structuredClone(template);
    const widenedConfig = xformConfig(widened);
    const widenedScene = JSON.parse(widenedConfig.viewModel[0].fdConfig);
    widenedScene.view.render.desktop[0].children[0]
      .children[0].children[0].children[1].controlProps.columnSpan = 2;
    widenedConfig.viewModel[0].fdConfig = JSON.stringify(widenedScene);
    widened.mechanisms["sys-xform"].fdConfig = JSON.stringify(widenedConfig);
    const widenedObserved = observeNativeTemplate(widened);
    assert.equal(widenedObserved.form.value.layoutRows[0].cells[1].colspan, 2);
  });

  it("fails closed when persisted nested column-width styles are removed", () => {
    const dsl = nestedLayoutDsl();
    const outerNode = dsl.form.layout.mkTree.find((row) => row.id === "layout.outer");
    outerNode.componentId = "xform-flex-1-4-layout";
    outerNode.props = { columns: 4, sourceColumns: 4 };
    outerNode.children[0].column = 0;
    outerNode.children[0].colspan = 1;
    outerNode.children[1].column = 1;
    outerNode.children[1].colspan = 3;

    const { readback } = persistAndVerify(dsl, {
      mutate(template) {
        const config = xformConfig(template);
        const scene = JSON.parse(config.viewModel[0].fdConfig);
        const main = scene.view.render.desktop[0].children[0];
        const outer = main.children.find((row) =>
          row.controlProps?.migrationRootNodeId === "layout.outer"
        );
        delete outer.children[0].controlProps.colsStyle;
        config.viewModel[0].fdConfig = JSON.stringify(scene);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) =>
        item.code === "readback.form.layout_column_styles_mismatch"
      ),
      true
    );
  });

  it("accepts a JSON-encoded persisted owner-node path", () => {
    const { readback } = persistAndVerify(nestedLayoutDsl(), {
      mutate(template) {
        const config = xformConfig(template);
        const scene = JSON.parse(config.viewModel[0].fdConfig);
        const main = scene.view.render.desktop[0].children[0];
        const outer = main.children.find((row) =>
          row.controlProps?.migrationRootNodeId === "layout.outer"
        );
        const amount = outer.children[0].children.find((item) =>
          item.controlProps?.migrationFieldId === "fd_amount"
        );
        amount.controlProps.migrationOwnerNodePath = JSON.stringify(
          amount.controlProps.migrationOwnerNodePath
        );
        config.viewModel[0].fdConfig = JSON.stringify(scene);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    const outer = readback.form.layoutRows.find((row) => row.rootNodeId === "layout.outer");
    const amount = outer.cells.find((cell) => cell.fieldIds.includes("fd_amount"));
    assert.deepEqual(
      amount.ownerNodePath,
      ["layout.outer", "layout.middle", "layout.inner"]
    );
  });

  it("detects a nested leaf promoted to an independent native root", () => {
    const { readback } = persistAndVerify(nestedLayoutDsl(), {
      mutate(template) {
        const config = xformConfig(template);
        const scene = JSON.parse(config.viewModel[0].fdConfig);
        const main = scene.view.render.desktop[0].children[0];
        const outer = main.children.find((row) =>
          row.controlProps?.migrationRootNodeId === "layout.outer"
        );
        const grid = outer.children[0];
        const nestedLeaf = grid.children.find((item) =>
          item.controlProps?.migrationOwnerNodeId === "layout.inner"
        );
        grid.children = grid.children.filter((item) => item !== nestedLeaf);
        main.children.push({
          type: "layout",
          key: "promoted-inner",
          controlProps: {
            migrationRootNodeId: "layout.inner",
            migrationRowId: "layout.inner"
          },
          children: [{
            type: "@elem/layout-grid",
            key: "promoted-inner-grid",
            controlProps: { rows: 1, columns: 1 },
            children: [{
              ...nestedLeaf,
              controlProps: {
                ...nestedLeaf.controlProps,
                row: 1,
                column: 1
              }
            }]
          }]
        });
        config.viewModel[0].fdConfig = JSON.stringify(scene);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) =>
        item.code === "readback.form.layout_row_count_mismatch" ||
        item.code === "readback.form.layout_cell_owner_mismatch"
      ),
      true
    );
  });

  it("detects native rowspan drift after nested lowering", () => {
    const { readback } = persistAndVerify(nestedLayoutDsl(), {
      mutate(template) {
        const config = xformConfig(template);
        const scene = JSON.parse(config.viewModel[0].fdConfig);
        const main = scene.view.render.desktop[0].children[0];
        const outer = main.children.find((row) =>
          row.controlProps?.migrationRootNodeId === "layout.outer"
        );
        const subject = outer.children[0].children.find((item) =>
          item.controlProps?.migrationFieldId === "fd_subject"
        );
        subject.controlProps.rowSpan = 1;
        config.viewModel[0].fdConfig = JSON.stringify(scene);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.form.layout_cell_position_mismatch"),
      true
    );
  });

  it("does not normalize a persisted rowspan of zero to one", () => {
    const { readback } = persistAndVerify(nestedLayoutDsl(), {
      mutate(template) {
        const config = xformConfig(template);
        const scene = JSON.parse(config.viewModel[0].fdConfig);
        const main = scene.view.render.desktop[0].children[0];
        const outer = main.children.find((row) =>
          row.controlProps?.migrationRootNodeId === "layout.outer"
        );
        const amount = outer.children[0].children.find((item) =>
          item.controlProps?.migrationFieldId === "fd_amount"
        );
        amount.controlProps.rowSpan = 0;
        config.viewModel[0].fdConfig = JSON.stringify(scene);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.form.layout_cell_position_mismatch"),
      true
    );
  });

  it("requires persisted topology markers for a lowered nested root", () => {
    const { readback } = persistAndVerify(nestedLayoutDsl(), {
      mutate(template) {
        const config = xformConfig(template);
        const scene = JSON.parse(config.viewModel[0].fdConfig);
        const main = scene.view.render.desktop[0].children[0];
        const outer = main.children.find((row) =>
          row.controlProps?.migrationRootNodeId === "layout.outer"
        );
        delete outer.controlProps.migrationRootNodeId;
        for (const item of outer.children[0].children) {
          delete item.controlProps.migrationOwnerNodeId;
          delete item.controlProps.migrationOwnerNodePath;
          delete item.controlProps.migrationRefType;
          for (const child of item.children || []) {
            delete child.migrationOwnerNodeId;
            delete child.migrationOwnerNodePath;
            delete child.migrationRefType;
          }
        }
        config.viewModel[0].fdConfig = JSON.stringify(scene);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.form.layout_root_owner_mismatch"),
      true
    );
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.form.layout_cell_owner_mismatch"),
      true
    );
    assert.equal(
      readback.diagnostics.some((item) =>
        item.code === "readback.form.layout_cell_owner_path_mismatch"
      ),
      true
    );
    assert.equal(
      readback.diagnostics.some((item) =>
        item.code === "readback.form.layout_cell_ref_type_marker_mismatch"
      ),
      true
    );
  });

  it("detects removal of an intermediate nested-layout owner", () => {
    const { readback } = persistAndVerify(nestedLayoutDsl(), {
      mutate(template) {
        const config = xformConfig(template);
        const scene = JSON.parse(config.viewModel[0].fdConfig);
        const main = scene.view.render.desktop[0].children[0];
        const outer = main.children.find((row) =>
          row.controlProps?.migrationRootNodeId === "layout.outer"
        );
        const amount = outer.children[0].children.find((item) =>
          item.controlProps?.migrationFieldId === "fd_amount"
        );
        const truncatedPath = ["layout.outer", "layout.inner"];
        amount.controlProps.migrationOwnerNodePath = truncatedPath;
        amount.children[0].migrationOwnerNodePath = JSON.stringify(truncatedPath);
        config.viewModel[0].fdConfig = JSON.stringify(scene);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) =>
        item.code === "readback.form.layout_cell_owner_path_mismatch"
      ),
      true
    );
  });

  it("detects owner and reference-type topology drift", () => {
    const ownerMismatch = persistAndVerify(nestedLayoutDsl(), {
      mutate(template) {
        const config = xformConfig(template);
        const scene = JSON.parse(config.viewModel[0].fdConfig);
        const main = scene.view.render.desktop[0].children[0];
        const outer = main.children.find((row) =>
          row.controlProps?.migrationRootNodeId === "layout.outer"
        );
        const amount = outer.children[0].children.find((item) =>
          item.controlProps?.migrationFieldId === "fd_amount"
        );
        amount.controlProps.migrationOwnerNodeId = "layout.outer";
        config.viewModel[0].fdConfig = JSON.stringify(scene);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    }).readback;
    assert.equal(ownerMismatch.ok, false);
    assert.equal(
      ownerMismatch.diagnostics.some((item) => item.code === "readback.form.layout_cell_owner_mismatch"),
      true
    );

    const refTypeMismatch = persistAndVerify(nestedLayoutDsl(), {
      mutate(template) {
        const config = xformConfig(template);
        const detailModel = config.dataModel.find((model) => model.fdType === "detail");
        const scene = JSON.parse(config.viewModel[0].fdConfig);
        const main = scene.view.render.desktop[0].children[0];
        const outer = main.children.find((row) =>
          row.controlProps?.migrationRootNodeId === "layout.outer"
        );
        const amount = outer.children[0].children.find((item) =>
          item.controlProps?.migrationFieldId === "fd_amount"
        );
        amount.children[0].key = detailModel.fdTableName;
        config.viewModel[0].fdConfig = JSON.stringify(scene);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    }).readback;
    assert.equal(refTypeMismatch.ok, false);
    assert.equal(
      refTypeMismatch.diagnostics.some((item) =>
        item.code === "readback.form.layout_cell_ref_type_mismatch"
      ),
      true
    );
  });
});

function nestedLayoutDsl() {
  const form = sampleForm();
  const amount = form.fields.find((field) => field.id === "fd_amount");
  form.fields.splice(form.fields.length - 1, 0, {
    ...structuredClone(amount),
    id: "fd_nested_note",
    title: "嵌套补充",
    sourceRef: "source.form.control.fd_nested_note"
  });
  form.layout.mkTree = [
    {
      id: "layout.outer",
      componentId: "xform-flex-1-2-layout",
      props: { columns: 2, sourceColumns: 2 },
      sourceRef: "source.form.layout.row.outer",
      sourceMarkers: ["fd_outer_row"],
      children: [
        {
          id: "layout.outer-cell-subject",
          refType: "field",
          refIds: ["fd_subject"],
          sourceRef: "source.form.layout.cell.outer-subject",
          column: 0,
          colspan: 1
        },
        {
          id: "layout.outer-cell-middle",
          refType: "layout",
          refIds: ["layout.middle"],
          sourceRef: "source.form.layout.cell.outer-middle",
          column: 1,
          colspan: 1
        }
      ]
    },
    {
      id: "layout.middle",
      componentId: "xform-flex-1-1-layout",
      props: { columns: 1, sourceColumns: 1 },
      sourceRef: "source.form.layout.row.middle",
      sourceMarkers: ["fd_middle_row"],
      children: [{
        id: "layout.middle-cell-inner",
        refType: "layout",
        refIds: ["layout.inner"],
        sourceRef: "source.form.layout.cell.middle-inner",
        column: 0,
        colspan: 1
      }]
    },
    {
      id: "layout.inner",
      componentId: "xform-multi-row-table-layout",
      props: { rows: 2, columns: 1 },
      sourceRef: "source.form.layout.row.inner",
      sourceMarkers: ["fd_inner_row"],
      children: [
        {
          id: "layout.inner-cell-amount",
          refType: "field",
          refIds: ["fd_amount"],
          sourceRef: "source.form.layout.cell.inner-amount",
          row: 0,
          column: 0,
          colspan: 1
        },
        {
          id: "layout.inner-cell-note",
          refType: "field",
          refIds: ["fd_nested_note"],
          sourceRef: "source.form.layout.cell.inner-note",
          row: 1,
          column: 0,
          colspan: 1
        }
      ]
    },
    {
      id: "layout.detail-root",
      componentId: "xform-flex-1-1-layout",
      props: { columns: 1, sourceColumns: 1 },
      sourceRef: "source.form.layout.row.detail-root",
      sourceMarkers: ["fd_detail_row"],
      children: [{
        id: "layout.detail-root-cell",
        refType: "detailTable",
        refIds: ["fd_detail"],
        sourceRef: "source.form.layout.cell.detail-root",
        column: 0,
        colspan: 1
      }]
    }
  ];

  return sampleTrustedDsl({ form, workflow: undefined });
}

function capturedNativeShapeDsl() {
  const form = sampleForm();
  const baseField = form.fields.find((field) => field.id === "fd_amount");
  const fieldIds = [
    "fd_nested_left",
    "fd_nested_top_middle",
    "fd_nested_top_right",
    "fd_nested_bottom_middle",
    "fd_nested_bottom_right"
  ];
  form.fields = fieldIds.map((id) => ({
    ...structuredClone(baseField),
    id,
    title: id,
    sourceRef: `source.form.control.${id}`
  }));
  form.layout = {
    sourceGrid: { source: "captured-native-evidence", rows: [] },
    mkTree: [{
      id: "layout.captured-native-scaffold",
      componentId: "xform-multi-row-table-layout",
      props: { rows: 2, columns: 3 },
      sourceRef: "source.form.layout.row.captured-native-scaffold",
      children: fieldIds.map((fieldId, index) => ({
        id: `layout.captured-native-scaffold-cell-${index}`,
        refType: "field",
        refIds: [fieldId],
        sourceRef: `source.form.layout.cell.captured-native-scaffold-cell-${index}`,
        row: Math.floor(index / 3),
        column: index % 3,
        colspan: 1
      }))
    }]
  };
  return sampleTrustedDsl({ form, workflow: null });
}
