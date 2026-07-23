import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleForm, sampleTrustedDsl, sampleWorkflow } from "../helpers/sample-dsl.js";
import {
  formAttr,
  persistAndVerify,
  prepareSample,
  sampleBaseTemplate,
  sampleEnvelope,
  xformConfig
} from "../helpers/persistence.js";
import { preparePersistedTemplate } from "../../src/executor/persistence.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/executor/persistence");

function loadIndependentFormFixture() {
  const fixture = JSON.parse(
    readFileSync(join(fixtureDir, "form-only-native-readback.json"), "utf8")
  );
  const config = xformConfig(fixture);
  const attr = JSON.parse(config.attribute.formAttr);
  // The checked-in native fixture predates the empty-subject default. Keep its
  // native form structure independent while normalizing only that retired rule.
  attr.subjectRule = {};
  config.attribute.formAttr = JSON.stringify(attr);
  fixture.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  return fixture;
}

describe("preparePersistedTemplate interface", () => {
  it("verifies a healthy projected template", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl());
    assert.equal(readback.ok, true);
    assert.equal(readback.status, "verified");
    assert.equal(readback.invariantVersion, 14);
    assert.deepEqual(readback.partitions, {
      envelope: "verified",
      form: "verified",
      rules: "verified",
      scripts: "verified",
      workflow: "verified"
    });
  });

  it("reports workflow as not_expected for form-only DSL", () => {
    const dsl = sampleTrustedDsl({ workflow: null });
    delete dsl.workflow;
    const { readback } = persistAndVerify(dsl);
    assert.equal(readback.ok, true);
    assert.equal(readback.partitions.workflow, "not_expected");
    assert.equal(readback.workflow, undefined);
  });

  it("rejects native control identity collisions across main and detail fields", () => {
    const form = sampleForm();
    form.fields.find((field) => field.id === "fd_detail").columns.push({
      id: "fd_amount",
      title: "明细金额",
      type: "text",
      componentId: "xform-input",
      props: {},
      sourceProps: { metadataKind: "simple" },
      sourceRef: "source.form.detailTable.fd_detail.column.fd_amount"
    });

    const prepared = preparePersistedTemplate({
      dsl: sampleTrustedDsl({ form, workflow: null }),
      envelope: sampleEnvelope(),
      baseTemplate: sampleBaseTemplate()
    });

    assert.equal(prepared.ok, false);
    assert.equal(
      prepared.diagnostics.some((item) =>
        item.code === "projection.form.native_control_id_collision" &&
        item.details?.fieldRefs?.includes("fd_amount") &&
        item.details?.fieldRefs?.includes("fd_detail.fd_amount")
      ),
      true
    );
  });
});

describe("envelope mutations", () => {
  for (const [name, mutate] of [
    ["wrong fdId", (template) => {
      template.fdId = "other-id";
      return template;
    }],
    ["missing name", (template) => {
      template.fdName = "";
      return template;
    }],
    ["wrong category", (template) => {
      template.fdCategory = { fdId: "wrong-category" };
      return template;
    }],
    ["wrong table name", (template) => {
      template.mechanisms["sys-xform"].fdTableName = "wrong_table";
      return template;
    }],
    ["wrong lifecycle", (template) => {
      template.fdStatus = 1;
      return template;
    }]
  ]) {
    it(`fails on ${name}`, () => {
      const { readback } = persistAndVerify(sampleTrustedDsl({ workflow: null }), { mutate });
      assert.equal(readback.ok, false);
      assert.equal(readback.partitions.envelope, "mismatch");
    });
  }
});

describe("form field and detail mutations", () => {
  it("persists and reads back a detail title from all native title locations", () => {
    const title = "子表2-机型部件清单(复制的流程需重新点击“生成部件清单”按钮)";
    const form = sampleForm();
    form.fields.find((field) => field.type === "detailTable").title = title;
    const { template, readback } = persistAndVerify(sampleTrustedDsl({ form, workflow: null }));
    const config = xformConfig(template);
    const detail = config.dataModel.find((model) => model.fdType === "detail");
    const attribute = JSON.parse(detail.fdAttribute);

    assert.equal(detail.fdName, title);
    assert.equal(attribute.config.controlProps.title, title);
    assert.equal(attribute.config.label, title);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(
      readback.form.fields.find((field) => field.type === "detailTable").title,
      title
    );
  });

  it("fails when a field title changes", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        const field = config.dataModel[0].fdFields.find((item) => item.fdName === "fd_subject");
        field.fdLabel = "被篡改";
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.form.field_title"), true);
  });

  it("fails when data-only visibility is lost", () => {
    const form = sampleForm();
    form.fields.push({
      id: "fd_hidden",
      title: "隐藏",
      type: "text",
      componentId: "xform-input",
      props: {},
      dataOnly: true,
      sourceRef: "source.form.dataField.fd_hidden"
    });
    const { readback } = persistAndVerify(sampleTrustedDsl({ form, workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        const field = config.dataModel[0].fdFields.find((item) => item.fdName === "fd_hidden");
        field.fdDisplay = true;
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.form.data_only_flag_mismatch"), true);
  });

  for (const testCase of [
    {
      name: "detail model fdName changes",
      code: "readback.form.field_title",
      mutate(detail) {
        detail.fdName = "被篡改的明细模型标题";
      }
    },
    {
      name: "detail controlProps.title changes",
      code: "readback.form.detail_control_title_mismatch",
      mutate(detail) {
        const attribute = JSON.parse(detail.fdAttribute);
        attribute.config.controlProps.title = "被篡改的明细控件标题";
        detail.fdAttribute = JSON.stringify(attribute);
      }
    },
    {
      name: "detail container label changes",
      code: "readback.form.detail_control_label_mismatch",
      mutate(detail) {
        const attribute = JSON.parse(detail.fdAttribute);
        attribute.config.label = "被篡改的明细容器标签";
        detail.fdAttribute = JSON.stringify(attribute);
      }
    }
  ]) {
    it(`fails when ${testCase.name}`, () => {
      const dsl = sampleTrustedDsl({ workflow: null });
      const prepared = prepareSample(dsl);
      const fixture = loadIndependentFormFixture();
      const config = xformConfig(fixture);
      const detail = config.dataModel.find((model) => model.fdType === "detail");
      testCase.mutate(detail);
      fixture.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
      const readback = prepared.verify(fixture);

      assert.equal(readback.ok, false);
      assert.equal(readback.partitions.form, "mismatch");
      assert.equal(readback.diagnostics.some((item) => item.code === testCase.code), true);
    });
  }

  it("fails when a detail column is missing or unexpected", () => {
    const missing = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        const detail = config.dataModel.find((model) => model.fdType === "detail");
        detail.fdFields = detail.fdFields.filter((field) => field.fdIsSystem);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(missing.readback.ok, false);
    assert.equal(missing.readback.diagnostics.some((item) => item.code === "readback.form.detail_column_missing"), true);

    const unexpected = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        const detail = config.dataModel.find((model) => model.fdType === "detail");
        const clone = JSON.parse(JSON.stringify(detail.fdFields.find((field) => !field.fdIsSystem)));
        clone.fdName = "fd_extra";
        clone.fdLabel = "额外";
        detail.fdFields.unshift(clone);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(unexpected.readback.ok, false);
    assert.equal(unexpected.readback.diagnostics.some((item) => item.code === "readback.form.unexpected_detail_column"), true);
  });

  it("fails when native layout placement changes while migration markers stay correct", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        const view = JSON.parse(config.viewModel[0].fdConfig);
        const main = view.view.render.desktop[0].children[0];
        const row = main.children[0];
        const grid = row.children[0];
        const first = grid.children[0];
        const second = grid.children[1];
        // Keep migration markers, swap native child keys (placement).
        const firstRef = first.children[0];
        const secondRef = second.children[0];
        const firstKey = firstRef.key;
        firstRef.key = secondRef.key;
        secondRef.key = firstKey;
        config.viewModel[0].fdConfig = JSON.stringify(view);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.form.layout_cell_fields_mismatch"), true);
  });

  it("splits a multi-field DSL cell into adjacent one-control native cells", () => {
    const form = sampleForm();
    form.layout.mkTree[0] = {
      id: "layout.row-pack",
      componentId: "xform-flex-1-2-layout",
      props: { columns: 2, sourceColumns: 4 },
      sourceRef: "source.form.layout.row.row-pack",
      sourceMarkers: ["fd_pack_row"],
      children: [{
        id: "layout.row-pack-cell-0",
        refType: "field",
        refIds: ["fd_subject", "fd_amount"],
        sourceRef: "source.form.layout.cell.row-pack-cell-0",
        column: 0,
        colspan: 1
      }]
    };
    const prepared = prepareSample(sampleTrustedDsl({ form, workflow: null }));
    assert.equal(prepared.ok, true);
    const view = JSON.parse(xformConfig(prepared.update).viewModel[0].fdConfig);
    const packRow = view.view.render.desktop[0].children[0].children[0];
    const grid = packRow.children[0];
    assert.equal(grid.controlProps.columns, 2);
    assert.deepEqual(
      grid.children.map((item) => ({
        column: item.controlProps.column,
        fields: item.children.map((child) => child.key)
      })),
      [
        { column: 1, fields: ["fd_subject"] },
        { column: 2, fields: ["fd_amount"] }
      ]
    );

    const { readback } = persistAndVerify(sampleTrustedDsl({ form, workflow: null }));
    assert.equal(readback.ok, true);
    assert.deepEqual(
      readback.form.layoutRows[0].cells.map((cell) => cell.fieldIds),
      [["fd_subject"], ["fd_amount"]]
    );
  });

  it("persists a one-row five-column table layout in desktop and mobile views", () => {
    const form = sampleForm();
    const baseField = form.fields.find((field) => field.id === "fd_amount");
    const ids = [
      "fd_slot_alpha",
      "fd_slot_bravo",
      "fd_slot_charlie",
      "fd_slot_delta",
      "fd_slot_echo"
    ];
    for (const id of ids) {
      form.fields.splice(form.fields.length - 1, 0, {
        ...structuredClone(baseField),
        id,
        title: id,
        sourceRef: `source.form.control.${id}`
      });
    }
    form.layout.mkTree[0] = {
      id: "layout.row-five-columns",
      componentId: "xform-multi-row-table-layout",
      props: { rows: 1, columns: 5 },
      sourceRef: "source.form.layout.row.row-five-columns",
      sourceMarkers: ["fd_five_column_row"],
      children: ids.map((id, index) => ({
        id: `layout.row-five-columns-cell-${index}`,
        refType: "field",
        refIds: [id],
        sourceRef: `source.form.layout.cell.row-five-columns-cell-${index}`,
        row: 0,
        column: index,
        colspan: 1
      }))
    };

    const dsl = sampleTrustedDsl({ form, workflow: null });
    const prepared = prepareSample(dsl);
    assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
    const view = JSON.parse(xformConfig(prepared.update).viewModel[0].fdConfig);

    for (const mode of ["desktop", "mobile"]) {
      const main = view.view.render[mode][0].children[0];
      const row = main.children.find((candidate) =>
        candidate.controlProps?.migrationRowId === "fd_five_column_row"
      );
      const grid = row.children[0];
      assert.equal(
        row.controlProps.migrationLayoutType,
        "@elem/xform-multi-row-table-layout",
        mode
      );
      assert.equal(grid.controlProps.columns, 5, mode);
      assert.equal(grid.controlProps.rows, 1, mode);
      assert.deepEqual(
        grid.children.map((item) => [
          item.controlProps.row,
          item.controlProps.column,
          item.children[0].key
        ]),
        ids.map((id, index) => [1, index + 1, id]),
        mode
      );
    }

    const nativeEvidence = JSON.parse(
      readFileSync(join(fixtureDir, "multi-line-column-1x5-native-layout.json"), "utf8")
    );
    const independentReadback = structuredClone(prepared.update);
    const independentConfig = xformConfig(independentReadback);
    const independentView = JSON.parse(independentConfig.viewModel[0].fdConfig);
    const independentMain = independentView.view.render.desktop[0].children[0];
    const independentRowIndex = independentMain.children.findIndex((candidate) =>
      candidate.controlProps?.migrationRowId === "fd_five_column_row"
    );
    independentMain.children[independentRowIndex] = structuredClone(nativeEvidence.nativeLayout);
    independentConfig.viewModel[0].fdConfig = JSON.stringify(independentView);
    independentReadback.mechanisms["sys-xform"].fdConfig = JSON.stringify(independentConfig);

    const readback = prepared.verify(independentReadback);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.form.layoutRows[0].rows, 1);
    assert.equal(readback.form.layoutRows[0].columns, 5);
    assert.deepEqual(
      readback.form.layoutRows[0].cells.map((cell) => [cell.row, cell.column]),
      [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]]
    );

    const wrongGridSize = structuredClone(independentReadback);
    const wrongConfig = xformConfig(wrongGridSize);
    const wrongView = JSON.parse(wrongConfig.viewModel[0].fdConfig);
    const wrongRow = wrongView.view.render.desktop[0].children[0].children.find((candidate) =>
      candidate.children?.[0]?.children?.some((item) => item.children?.[0]?.key === ids[0])
    );
    wrongRow.children[0].controlProps.columns = 4;
    wrongRow.children[0].controlProps.rows = 2;
    wrongConfig.viewModel[0].fdConfig = JSON.stringify(wrongView);
    wrongGridSize.mechanisms["sys-xform"].fdConfig = JSON.stringify(wrongConfig);
    const mismatch = prepared.verify(wrongGridSize);
    assert.equal(mismatch.ok, false);
    assert.equal(
      mismatch.diagnostics.some((item) => item.code === "readback.form.layout_grid_size_mismatch"),
      true
    );
  });

  it("projects the eight-column boundary and ninth-control overflow equally to desktop and mobile", () => {
    const form = sampleForm();
    const baseField = form.fields.find((field) => field.id === "fd_amount");
    const eightIds = Array.from({ length: 8 }, (_, index) => `fd_cap_eight_${index + 1}`);
    const nineIds = Array.from({ length: 9 }, (_, index) => `fd_cap_nine_${index + 1}`);
    for (const id of [...eightIds, ...nineIds]) {
      form.fields.splice(form.fields.length - 1, 0, {
        ...structuredClone(baseField),
        id,
        title: id,
        sourceRef: `source.form.control.${id}`
      });
    }
    form.layout.mkTree.splice(
      0,
      1,
      tableLayoutRow("layout.row-eight-columns", "fd_eight_column_row", eightIds, 1),
      tableLayoutRow("layout.row-nine-controls", "fd_nine_control_row", nineIds, 2)
    );

    const prepared = prepareSample(sampleTrustedDsl({ form, workflow: null }));
    assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
    const view = JSON.parse(xformConfig(prepared.update).viewModel[0].fdConfig);

    for (const mode of ["desktop", "mobile"]) {
      const main = view.view.render[mode][0].children[0];
      assertNativeGrid(
        main.children.find((row) => row.controlProps?.migrationRowId === "fd_eight_column_row"),
        eightIds,
        { rows: 1, columns: 8 },
        mode
      );
      assertNativeGrid(
        main.children.find((row) => row.controlProps?.migrationRowId === "fd_nine_control_row"),
        nineIds,
        { rows: 2, columns: 8 },
        mode
      );
    }
  });

  it("persists overflow as one multi-row grid with one runtime row marker", () => {
    const form = sampleForm();
    const baseField = form.fields.find((field) => field.id === "fd_amount");
    for (const id of ["fd_extra_1", "fd_extra_2", "fd_extra_3"]) {
      form.fields.splice(form.fields.length - 1, 0, {
        ...structuredClone(baseField),
        id,
        title: id,
        sourceRef: `source.form.control.${id}`
      });
    }
    const ids = ["fd_subject", "fd_amount", "fd_extra_1", "fd_extra_2", "fd_extra_3"];
    form.layout.mkTree[0] = {
      id: "layout.row-multi",
      componentId: "xform-multi-row-table-layout",
      props: { rows: 2, columns: 4 },
      sourceRef: "source.form.layout.row.row-multi",
      sourceMarkers: ["fd_multi_row"],
      children: ids.map((id, index) => ({
        id: `layout.row-multi-cell-${index}`,
        refType: "field",
        refIds: [id],
        sourceRef: `source.form.layout.cell.row-multi-cell-${index}`,
        row: Math.floor(index / 4),
        column: index === 4 ? 3 : index % 4,
        colspan: 1
      }))
    };

    const dsl = sampleTrustedDsl({ form, workflow: null });
    const prepared = prepareSample(dsl);
    assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
    const view = JSON.parse(xformConfig(prepared.update).viewModel[0].fdConfig);
    const main = view.view.render.desktop[0].children[0];
    const multiRows = main.children.filter((row) => row.controlProps?.migrationRowId === "fd_multi_row");
    const grid = multiRows[0].children[0];

    assert.equal(multiRows.length, 1);
    assert.equal(grid.controlProps.columns, 4);
    assert.equal(grid.controlProps.rows, 2);
    assert.deepEqual(
      grid.children.map((item) => [item.controlProps.row, item.controlProps.column]),
      [[1, 1], [1, 2], [1, 3], [1, 4], [2, 4]]
    );

    const { readback } = persistAndVerify(dsl);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.deepEqual(
      readback.form.layoutRows[0].cells.map((cell) => [cell.row, cell.column]),
      [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3]]
    );

    const changed = prepared.verify(structuredClone(prepared.update));
    assert.equal(changed.ok, true);
    const wrongGridSize = structuredClone(prepared.update);
    const wrongGridConfig = xformConfig(wrongGridSize);
    const wrongGridView = JSON.parse(wrongGridConfig.viewModel[0].fdConfig);
    wrongGridView.view.render.desktop[0].children[0].children[0].children[0].controlProps.rows = 1;
    wrongGridConfig.viewModel[0].fdConfig = JSON.stringify(wrongGridView);
    wrongGridSize.mechanisms["sys-xform"].fdConfig = JSON.stringify(wrongGridConfig);
    const gridMismatch = prepared.verify(wrongGridSize);
    assert.equal(gridMismatch.ok, false);
    assert.equal(
      gridMismatch.diagnostics.some((item) => item.code === "readback.form.layout_grid_size_mismatch"),
      true
    );

    const mutated = structuredClone(prepared.update);
    const mutatedConfig = xformConfig(mutated);
    const mutatedView = JSON.parse(mutatedConfig.viewModel[0].fdConfig);
    mutatedView.view.render.desktop[0].children[0].children[0].children[0].children[4].controlProps.row = 1;
    mutatedConfig.viewModel[0].fdConfig = JSON.stringify(mutatedView);
    mutated.mechanisms["sys-xform"].fdConfig = JSON.stringify(mutatedConfig);
    const mismatch = prepared.verify(mutated);
    assert.equal(mismatch.ok, false);
    assert.equal(
      mismatch.diagnostics.some((item) => item.code === "readback.form.layout_cell_position_mismatch"),
      true
    );
  });
});

function tableLayoutRow(id, markerId, fieldIds, rows) {
  return {
    id,
    componentId: "xform-multi-row-table-layout",
    props: { rows, columns: 8 },
    sourceRef: `source.form.layout.row.${id}`,
    sourceMarkers: [markerId],
    children: fieldIds.map((fieldId, index) => ({
      id: `${id}-cell-${index}`,
      refType: "field",
      refIds: [fieldId],
      sourceRef: `source.form.layout.cell.${id}-cell-${index}`,
      row: Math.floor(index / 8),
      column: index % 8,
      colspan: 1
    }))
  };
}

function assertNativeGrid(row, fieldIds, expected, mode) {
  const grid = row?.children?.[0];
  assert.equal(row?.type, "layout", mode);
  assert.equal(grid?.type, "@elem/layout-grid", mode);
  assert.equal(grid?.controlProps?.rows, expected.rows, mode);
  assert.equal(grid?.controlProps?.columns, expected.columns, mode);
  assert.deepEqual(
    grid?.children?.map((item) => [
      item.controlProps.row,
      item.controlProps.column,
      item.children[0].key
    ]),
    fieldIds.map((fieldId, index) => [Math.floor(index / 8) + 1, (index % 8) + 1, fieldId]),
    mode
  );
}

describe("marker independence", () => {
  it("writes layout sourceMarkers as migrationRowId for runtime setFieldAttr", () => {
    const form = sampleForm();
    form.layout.mkTree[1] = {
      ...form.layout.mkTree[1],
      sourceMarkers: ["fd_detail_row"]
    };
    const prepared = prepareSample(sampleTrustedDsl({ form, workflow: null }));
    assert.equal(prepared.ok, true);
    const view = JSON.parse(xformConfig(prepared.update).viewModel[0].fdConfig);
    const main = view.view.render.desktop[0].children[0];
    const detailRow = main.children[1];
    assert.equal(detailRow.controlProps.migrationRowId, "fd_detail_row");
    assert.equal(detailRow.children[0].children[0].controlProps.migrationRowId, "fd_detail_row");
  });

  it("passes when native semantics are intact but migration markers are corrupt", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        delete config.migrationDsl;
        const attr = JSON.parse(config.attribute.formAttr);
        delete attr.migrationDsl;
        const view = JSON.parse(config.viewModel[0].fdConfig);
        const main = view.view.render.desktop[0].children[0];
        for (const row of main.children) {
          if (row.controlProps) {
            delete row.controlProps.migrationRowId;
            delete row.controlProps.migrationLayoutComponentId;
          }
          const grid = row.children?.[0];
          for (const item of grid?.children || []) {
            if (item.controlProps) {
              delete item.controlProps.migrationFieldIds;
              delete item.controlProps.migrationFieldId;
              delete item.controlProps.migrationRowId;
              delete item.controlProps.migrationColumn;
              delete item.controlProps.migrationColspan;
            }
            if (item.children?.[0]) {
              delete item.children[0].migrationFieldIds;
              delete item.children[0].migrationFieldId;
            }
          }
        }
        config.viewModel[0].fdConfig = JSON.stringify(view);
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, true);
  });

  it("fails when markers are correct but a native field component is wrong", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        const field = config.dataModel[0].fdFields.find((item) => item.fdName === "fd_subject");
        const attribute = JSON.parse(field.fdAttribute);
        attribute.config.controlProps.desktop = { type: "@elem/xform-textarea" };
        attribute.config.type = "@elem/xform-textarea";
        field.fdAttribute = JSON.stringify(attribute);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.form.component_mismatch"), true);
  });
});

describe("form layout projection", () => {
  it("preserves dense DSL positions while retaining wider source-column evidence", () => {
    const form = sampleForm();
    form.layout.mkTree = [{
      id: "layout.row-wide",
      componentId: "xform-flex-1-2-layout",
      props: { columns: 2, sourceColumns: 4 },
      sourceRef: "source.form.layout.row.row-wide",
      children: [
        {
          id: "layout.row-wide-cell-1",
          refType: "field",
          refIds: ["fd_subject"],
          sourceRef: "source.form.layout.cell.row-wide-cell-1",
          column: 0,
          colspan: 1
        },
        {
          id: "layout.row-wide-cell-3",
          refType: "field",
          refIds: ["fd_amount"],
          sourceRef: "source.form.layout.cell.row-wide-cell-3",
          column: 1,
          colspan: 1
        }
      ]
    }];
    const prepared = prepareSample(sampleTrustedDsl({ form, workflow: null }));
    assert.equal(prepared.ok, true);
    const view = JSON.parse(xformConfig(prepared.update).viewModel[0].fdConfig);
    const row = view.view.render.desktop[0].children[0].children[0];
    const grid = row.children[0];
    assert.equal(row.controlProps.migrationSourceColumns, 4);
    assert.equal(row.controlProps.migrationDisplayColumns, 2);
    assert.equal(grid.controlProps.columns, 2);
    assert.deepEqual(
      grid.children.map((item) => ({
        column: item.controlProps.column,
        colSpan: item.controlProps.colSpan,
        field: item.controlProps.migrationFieldId
      })),
      [
        { column: 1, colSpan: 1, field: "fd_subject" },
        { column: 2, colSpan: 1, field: "fd_amount" }
      ]
    );
  });

  it("leaves subjectRule empty and projects description content with style", () => {
    const form = sampleForm();
    form.fields.push({
      id: "fd_hint_red",
      title: "此流程近期改动较大",
      type: "description",
      componentId: "xform-description",
      props: {
        content: "此流程近期改动较大",
        style: { color: "rgba(255,0,0,1)", fontWeight: "bold" }
      },
      sourceProps: { designerType: "textLabel" },
      sourceRef: "source.form.control.fd_hint_red"
    });
    form.layout.mkTree.unshift({
      id: "layout.row-hint",
      componentId: "xform-flex-1-1-layout",
      props: { columns: 1, sourceColumns: 1 },
      sourceRef: "source.form.layout.row.row-hint",
      children: [{
        id: "layout.row-hint-cell-0",
        refType: "field",
        refIds: ["fd_hint_red"],
        sourceRef: "source.form.layout.cell.row-hint-cell-0",
        column: 0,
        colspan: 1
      }]
    });

    const prepared = prepareSample(sampleTrustedDsl({ form, workflow: null }));
    assert.equal(prepared.ok, true);
    const config = xformConfig(prepared.update);
    const attr = formAttr(prepared.update);
    const descField = config.dataModel[0].fdFields.find((field) => field.fdName === "fd_hint_red");
    const descAttribute = JSON.parse(descField.fdAttribute);
    const view = JSON.parse(config.viewModel[0].fdConfig);

    assert.deepEqual(attr.subjectRule, {});
    assert.equal(descField.fdType, "desc");
    assert.equal(descField.fdIsStored, false);
    assert.equal(descField.fdLength, 0);
    assert.equal(descAttribute.config.controlProps.content, "此流程近期改动较大");
    assert.equal(descAttribute.config.controlProps.defaultTextValue, "此流程近期改动较大");
    assert.equal(descAttribute.config.controlProps.alignDesc, "left");
    assert.equal(descAttribute.config.type, "desc");
    assert.deepEqual(descAttribute.config.labelProps.desktop, { hiddenLabel: true });
    assert.deepEqual(view.controlStyle.fd_hint_red, {
      desktop: {
        layout: "vertical",
        controlValueStyle: { color: "rgba(255,0,0,1)", fontWeight: "bold" }
      }
    });
    assert.equal(config.auth[0].add.mk_model_test.fields.fd_hint_red.editable, false);

    const healthyReadback = prepared.verify(prepared.update);
    assert.equal(healthyReadback.ok, true);
    assert.deepEqual(
      healthyReadback.form.fields.find((field) => field.id === "fd_hint_red").style,
      { color: "rgba(255,0,0,1)", fontWeight: "bold" }
    );

    const withoutStyle = structuredClone(prepared.update);
    const withoutStyleConfig = xformConfig(withoutStyle);
    const withoutStyleView = JSON.parse(withoutStyleConfig.viewModel[0].fdConfig);
    delete withoutStyleView.controlStyle.fd_hint_red;
    withoutStyleConfig.viewModel[0].fdConfig = JSON.stringify(withoutStyleView);
    withoutStyle.mechanisms["sys-xform"].fdConfig = JSON.stringify(withoutStyleConfig);
    const missingStyleReadback = prepared.verify(withoutStyle);
    assert.equal(missingStyleReadback.ok, false);
    assert.equal(
      missingStyleReadback.diagnostics.some((item) => item.code === "readback.form.prop_style_mismatch"),
      true
    );
  });

  it("nests detail-table field auth and row operations under fdConfig.auth", () => {
    const detailTable = "mk_model_test_d_a47d94a5";
    const prepared = prepareSample(sampleTrustedDsl({ workflow: null }));
    assert.equal(prepared.ok, true);
    const config = xformConfig(prepared.update);
    const auth = config.auth[0];

    assert.ok(auth.add[detailTable]);
    assert.ok(auth.add[detailTable].fields.fd_name);
    assert.equal(auth.add[detailTable].fields.fd_name.visible, true);
    assert.equal(auth.add[detailTable].fields.fd_name.editable, true);
    assert.deepEqual(
      auth.add[detailTable].operations.map((operation) => operation.id),
      ["canAddRow", "canDeleteRow", "canImport"]
    );
    assert.deepEqual(
      auth.view[detailTable].operations.map((operation) => operation.id),
      ["canExport"]
    );
    assert.ok(auth.add.mk_model_test.fields[detailTable]);
    assert.equal(auth.add.mk_model_test.fields[detailTable].editable, true);
    assert.ok(auth.add.mk_model_test.fields.fd_name);
  });

  it("fails readback when the empty subjectRule is replaced", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        attr.subjectRule = {
          script: "${data.biz.fdSubject}",
          type: "Eval",
          vo: { content: "$标题$", mode: "formula" }
        };
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.form.subject_rule_mismatch"), true);
  });
});

describe("form rules mutations", () => {
  function dslWithRules() {
    const form = sampleForm();
    form.layout.mkTree[1] = {
      ...form.layout.mkTree[1],
      sourceMarkers: ["fd_detail_row"]
    };
    return sampleTrustedDsl({
      form,
      workflow: null,
      formRules: {
        linkage: [{
          id: "linkage.subject.detail",
          trigger: "change",
          source: "fd_subject",
          logic: "and",
          when: [{ field: "fd_subject", op: "contains", value: "A" }],
          effects: [
            { type: "visible", target: "fd_detail_row", value: true },
            { type: "required", target: "fd_detail_row", value: true }
          ],
          else: [
            { type: "visible", target: "fd_detail_row", value: false },
            { type: "required", target: "fd_detail_row", value: false }
          ],
          translationStatus: "executable"
        }],
        validations: [],
        impliedRequired: [],
        review: {}
      }
    });
  }

  function gatedDslWithRules() {
    const dsl = dslWithRules();
    dsl.formRules.linkage[0].meta = {
      sourceJsp: "source.form.jsp.subject",
      sourceActionKey: "source.form.jsp.subject#onChange@0",
      displayGate: "xform:editShow",
      runWhen: { viewStatusIn: ["add", "edit"] },
      conditionSource: "event:value",
      nativeProjection: { kind: "view-status-formula", version: 1 },
      conditionSemantics: [{
        origin: "event:value",
        transforms: [],
        predicate: "indexOf"
      }]
    };
    dsl.scripts = {
      actions: [{
        id: "fd_subject.onChange.1",
        name: "onChange",
        event: "onChange",
        scope: "control",
        controlId: "fd_subject",
        sourceRefs: ["source.form.jsp.subject"],
        sourceActionKey: "source.form.jsp.subject#onChange@0",
        function: "function onChange(value) { MKXFORM.getValue('fd_subject') }",
        translationStatus: "mapped",
        coverage: { status: "translated", nativeRules: [], residuals: [] },
        functionMappings: [{
          source: "GetXFormFieldById",
          target: "MKXFORM.getValue",
          basis: "semantic-translation",
          reviewRequired: false
        }],
        runWhen: { viewStatusIn: ["add", "edit"] }
      }]
    };
    return dsl;
  }

  it("verifies equivalent row markers that resolve to the same native targets", () => {
    const dsl = dslWithRules();
    dsl.form.layout.mkTree[1].sourceMarkers.push("fd_detail_row_alias");
    dsl.formRules.linkage[0].effects.push(
      { type: "visible", target: "fd_detail_row_alias", value: true },
      { type: "required", target: "fd_detail_row_alias", value: true }
    );
    dsl.formRules.linkage[0].else.push(
      { type: "visible", target: "fd_detail_row_alias", value: false },
      { type: "required", target: "fd_detail_row_alias", value: false }
    );

    const { template, readback } = persistAndVerify(dsl);
    const rules = formAttr(template).formRule;

    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(rules.display.every((rule) => rule.result.length === 1), true);
    assert.equal(rules.require.every((rule) => rule.result.length === 1), true);
  });

  it("refuses to project a gated linkage without a statically proven native projection", () => {
    const dsl = dslWithRules();
    dsl.formRules.linkage[0].meta = { runWhen: { viewStatusIn: ["add", "edit"] } };
    const prepared = preparePersistedTemplate({
      dsl,
      envelope: sampleEnvelope(),
      baseTemplate: sampleBaseTemplate()
    });

    assert.equal(prepared.ok, false);
    assert.equal(
      prepared.diagnostics.some((item) => item.code === "projection.form_rule.run_when_not_persistable"),
      true
    );
  });

  it("persists a proven edit-gated linkage as one formula condition per branch", () => {
    const dsl = dslWithRules();
    dsl.formRules.linkage[0].meta = {
      sourceJsp: "source.form.jsp.subject",
      displayGate: "xform:editShow",
      runWhen: { viewStatusIn: ["add", "edit"] },
      conditionSource: "event:value",
      sourceActionKey: "source.form.jsp.subject#onChange@0",
      nativeProjection: { kind: "view-status-formula", version: 1 },
      conditionSemantics: [{
        origin: "event:value",
        transforms: [],
        predicate: "indexOf"
      }]
    };
    dsl.scripts = {
      actions: [{
        id: "fd_subject.onChange.1",
        name: "onChange",
        event: "onChange",
        scope: "control",
        controlId: "fd_subject",
        sourceRefs: ["source.form.jsp.subject"],
        sourceActionKey: "source.form.jsp.subject#onChange@0",
        function: "function onChange(value) { MKXFORM.getValue('fd_subject') }",
        translationStatus: "mapped",
        coverage: { status: "translated", nativeRules: [], residuals: [] },
        functionMappings: [{
          source: "GetXFormFieldById",
          target: "MKXFORM.getValue",
          basis: "semantic-translation",
          reviewRequired: false
        }],
        runWhen: { viewStatusIn: ["add", "edit"] }
      }]
    };
    const prepared = preparePersistedTemplate({
      dsl,
      envelope: sampleEnvelope(),
      baseTemplate: sampleBaseTemplate()
    });

    assert.equal(prepared.ok, true);
    const formRule = formAttr(prepared.update).formRule;
    assert.equal(formRule.display.length, 2);
    assert.equal(formRule.require.length, 2);
    for (const rule of [...formRule.display, ...formRule.require]) {
      assert.equal(rule.choices.items.length, 1);
      assert.equal(rule.choices.items[0].condNodeType, "formula");
      assert.deepEqual(rule.choices.items[0].value.varIds, ["fd_subject"]);
      assert.match(rule.choices.items[0].value.script, /MKXFORM\.viewStatus/);
      assert.match(rule.choices.items[0].value.script, /\$\{data\.biz\.fd_subject\}/);
    }
    const whenFormula = formRule.display.find((rule) => rule.meta.branch === "when").choices.items[0].value.script;
    const elseFormula = formRule.display.find((rule) => rule.meta.branch === "else").choices.items[0].value.script;
    assert.match(whenFormula, /^\(MKXFORM\.viewStatus/);
    assert.match(elseFormula, /^\(MKXFORM\.viewStatus/);
    assert.doesNotMatch(elseFormula, /^!\(\(MKXFORM\.viewStatus/);
  });

  it("fails when rule counts match but conditions are wrong", () => {
    const { readback } = persistAndVerify(dslWithRules(), {
      mutate(template) {
        const attr = formAttr(template);
        attr.formRule.display[0].choices.items[0].operate = "!=";
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify({
          ...xformConfig(template),
          attribute: {
            ...xformConfig(template).attribute,
            formAttr: JSON.stringify(attr)
          }
        });
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.form_rules.semantic_missing"), true);
  });

  it("fails readback when an expected native rule is inactive", () => {
    const { readback } = persistAndVerify(dslWithRules(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        attr.formRule.display[0].active = false;
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.form_rules.semantic_missing"),
      true
    );
  });

  it("preserves an explicitly inactive DSL rule", () => {
    const dsl = dslWithRules();
    dsl.formRules.linkage[0].active = false;
    const { template, readback } = persistAndVerify(dsl);
    const attr = formAttr(template);

    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal([...attr.formRule.display, ...attr.formRule.require].every((rule) => rule.active === false), true);
  });

  it("fails readback when a persisted formula loses its view-status gate", () => {
    const { readback } = persistAndVerify(gatedDslWithRules(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        for (const rule of [...attr.formRule.display, ...attr.formRule.require]) {
          const formula = rule.choices.items[0].value;
          formula.script = formula.script.replace(
            /^\(MKXFORM\.viewStatus === "add" \|\| MKXFORM\.viewStatus === "edit"\) && /,
            ""
          );
          formula.vo.content = formula.script;
        }
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.form_rules.semantic_missing"),
      true
    );
  });

  it("fails readback when a formula condition valueType is no longer formula", () => {
    const { readback } = persistAndVerify(gatedDslWithRules(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        attr.formRule.display[0].choices.items[0].valueType = "fixed";
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.form_rules.semantic_missing"),
      true
    );
  });

  it("fails readback when a formula condition value is no longer Eval", () => {
    const { readback } = persistAndVerify(gatedDslWithRules(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        attr.formRule.display[0].choices.items[0].value.type = "Literal";
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.form_rules.semantic_missing"),
      true
    );
  });

  it("fails readback when a formula condition vo mode is no longer formula", () => {
    const { readback } = persistAndVerify(gatedDslWithRules(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        attr.formRule.display[0].choices.items[0].value.vo.mode = "script";
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.form_rules.semantic_missing"),
      true
    );
  });

  it("fails readback when formula vo content diverges from its script", () => {
    const { readback } = persistAndVerify(gatedDslWithRules(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        attr.formRule.display[0].choices.items[0].value.vo.content = "true";
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.form_rules.semantic_missing"),
      true
    );
  });

  it("fails readback when formula variable bindings change", () => {
    const { readback } = persistAndVerify(gatedDslWithRules(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        attr.formRule.display[0].choices.items[0].value.varIds = ["fd_amount"];
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.form_rules.semantic_missing"),
      true
    );
  });

  it("fails readback when a detail-table display result loses its complete fieldName list", () => {
    const { readback } = persistAndVerify(dslWithRules(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        attr.formRule.display[0].result[0].fieldName = ["all"];
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.form_rules.semantic_missing"),
      true
    );
  });

  it("passes when unrelated manual rules coexist", () => {
    const { readback } = persistAndVerify(dslWithRules(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        attr.formRule.display.push({
          id: "manual-rule",
          ruleName: "manual",
          active: true,
          condition: "1",
          choices: { items: [] },
          result: [{
            fieldName: "fd_amount",
            fieldKey: "fd_amount",
            tableType: "main",
            type: "main",
            displayFlag: "hide"
          }]
        });
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, true);
  });

  it("fails when a stale generated native rule remains after current rules match", () => {
    const { readback } = persistAndVerify(dslWithRules(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        attr.formRule.display.push({
          id: "stale-generated-rule",
          ruleName: "retired rule",
          active: true,
          condition: "1",
          choices: { items: [] },
          result: [],
          meta: {
            generatedBy: "mk-migrate-agent-v2",
            sourceRuleId: "retired-linkage",
            branch: "when",
            ruleType: "display"
          }
        });
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.form_rules.unexpected_generated"),
      true
    );
  });

  it("fails when an extra rule retains the generator ruleName prefix", () => {
    const { readback } = persistAndVerify(dslWithRules(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        attr.formRule.display.push({
          id: "stale-generated-name",
          ruleName: "mk-migrate-agent-v2:retired:when:display",
          active: true,
          condition: "1",
          choices: { items: [] },
          result: []
        });
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.form_rules.unexpected_generated"),
      true
    );
  });

  it("fails when a stale generated rule retains only its stable generated id", () => {
    const { readback } = persistAndVerify(dslWithRules(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        attr.formRule.display.push({
          id: "rule-0123456789abcdef",
          ruleName: "renamed retired rule",
          active: true,
          condition: "1",
          choices: { items: [] },
          result: []
        });
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.form_rules.unexpected_generated"),
      true
    );
  });

  it("fails when an extra manual rule conflicts with an expected target and dimension", () => {
    const { readback } = persistAndVerify(dslWithRules(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        const expectedResult = attr.formRule.display[0].result[0];
        attr.formRule.display.push({
          id: "manual-conflict",
          ruleName: "manual conflict",
          active: true,
          condition: "1",
          choices: { items: [] },
          result: [{ ...expectedResult, displayFlag: "hide" }]
        });
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.form_rules.unexpected_target_conflict"),
      true
    );
  });

  it("passes when a semantically equivalent rule lacks provenance markers", () => {
    const { readback } = persistAndVerify(dslWithRules(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        for (const rule of [...attr.formRule.display, ...attr.formRule.require]) {
          delete rule.meta;
          rule.ruleName = "manual-equivalent";
        }
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, true);
  });
});

describe("script mutations", () => {
  function dslWithScripts() {
    return sampleTrustedDsl({
      workflow: null,
      scripts: {
        actions: [{
          id: "load-edit",
          name: "onLoad",
          event: "onLoad",
          scope: "global",
          function: "function onLoad() { MKXFORM.setValue('fd_subject', 'x') }",
          translationStatus: "mapped",
          coverage: { status: "translated", nativeRules: [], residuals: [] },
          functionMappings: [],
          runWhen: { viewStatusIn: ["add", "edit"] }
        }, {
          id: "omit-me",
          name: "onLoad",
          event: "onLoad",
          scope: "global",
          function: "function onLoad() { return true }",
          translationStatus: "omitted",
          coverage: { status: "native-covered", nativeRules: ["required"], residuals: [] },
          functionMappings: []
        }]
      }
    });
  }

  it("fails when the canonical view-status guard is removed", () => {
    const { readback } = persistAndVerify(dslWithScripts(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        const action = attr.controlAction.global.onLoad[0];
        action.function = action.function
          .replace(/\/\*\s*mk-migrate:view-status=[^*]+?\*\//g, "")
          .replace(/if \(MKXFORM\.viewStatus !== "add" && MKXFORM\.viewStatus !== "edit"\) return;?\s*/g, "");
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.scripts.run_when_mismatch"), true);
  });

  for (const [scenario, relocateGuard] of [
    [
      "inside an unreachable branch",
      (functionText, guardBlock) => functionText.replace(
        guardBlock,
        `if (false) {\n${guardBlock}\n}`
      )
    ],
    [
      "after a side effect",
      (functionText, guardBlock) => functionText
        .replace(guardBlock, "")
        .replace(
          "MKXFORM.setValue('fd_subject', 'x')",
          `MKXFORM.setValue('fd_subject', 'x')\n${guardBlock}`
        )
    ]
  ]) {
    it(`rejects a canonical-looking view-status guard ${scenario}`, () => {
      const { readback } = persistAndVerify(dslWithScripts(), {
        mutate(template) {
          const config = xformConfig(template);
          const attr = JSON.parse(config.attribute.formAttr);
          const action = attr.controlAction.global.onLoad[0];
          const guardMatch = action.function.match(
            /\/\*\s*mk-migrate:view-status=add,edit\s*\*\/\s*if \(MKXFORM\.viewStatus !== "add" && MKXFORM\.viewStatus !== "edit"\) return;/
          );
          assert.ok(guardMatch);
          action.function = relocateGuard(action.function, guardMatch[0]);
          config.attribute.formAttr = JSON.stringify(attr);
          template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
          return template;
        }
      });

      assert.equal(readback.ok, false);
      assert.equal(readback.diagnostics.some((item) => item.code === "readback.scripts.run_when_mismatch"), true);
    });
  }

  it("fails when an omitted action is unexpectedly present as a top-level id", () => {
    const { readback } = persistAndVerify(dslWithScripts(), {
      mutate(template) {
        const config = xformConfig(template);
        const attr = JSON.parse(config.attribute.formAttr);
        attr.controlAction.global.onChange = [{
          id: "omit-me",
          name: "onChange",
          function: "function onChange() { return true }"
        }];
        config.attribute.formAttr = JSON.stringify(attr);
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) =>
      item.code === "readback.scripts.omitted_action_present" ||
      item.code === "readback.scripts.unexpected_action"
    ), true);
  });
});

describe("workflow mutations", () => {
  it("fails when the same-identity policy changes", () => {
    const workflow = sampleWorkflow();
    workflow.nodes = [
      workflow.nodes[0],
      {
        id: "N2",
        type: "review",
        element: "manualTask",
        name: "审批",
        sourceType: "reviewNode",
        sourceRef: "source.workflow.node.N2",
        attributes: { ignoreOnHandlerSame: "true" },
        participants: {
          mode: "explicit",
          members: [{ id: "person-1", name: "审批人", targetOrgType: 8 }]
        },
        translationStatus: "executable"
      },
      { ...workflow.nodes[1], id: "N3", sourceRef: "source.workflow.node.N3" }
    ];
    workflow.edges = [
      { ...workflow.edges[0], id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1" },
      { ...workflow.edges[0], id: "L2", source: "N2", target: "N3", sourceRef: "source.workflow.edge.L2" }
    ];
    workflow.topologicalOrder = ["N1", "N2", "N3"];

    const { readback } = persistAndVerify(sampleTrustedDsl({ workflow }), {
      mutate(template) {
        const lbpm = template.mechanisms.lbpmTemplate[0];
        const content = JSON.parse(lbpm.fdContent);
        content.elements.find((element) => element.id === "N2").ignoreOnSameIdentity = "1";
        lbpm.fdContent = JSON.stringify(content);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.workflow.same_identity_policy_mismatch"), true);
  });

  it("fails on unexpected nodes and edges", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl(), {
      mutate(template) {
        const lbpm = template.mechanisms.lbpmTemplate[0];
        const content = JSON.parse(lbpm.fdContent);
        content.elements.push({ id: "N999", type: "review", element: "manualTask", name: "额外" });
        content.elements.push({ id: "L999", type: "sequenceFlow", sourceRef: "N1", targetRef: "N999" });
        lbpm.fdContent = JSON.stringify(content);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.workflow.unexpected_node"), true);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.workflow.unexpected_edge"), true);
  });

  it("fails on edge endpoint mutation", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl(), {
      mutate(template) {
        const lbpm = template.mechanisms.lbpmTemplate[0];
        const content = JSON.parse(lbpm.fdContent);
        const edge = content.elements.find((element) => element.type === "sequenceFlow");
        edge.targetRef = "missing";
        lbpm.fdContent = JSON.stringify(content);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.workflow.edge_endpoint_mismatch"), true);
  });

  it("tolerates coordinate and waypoint presentation differences", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl(), {
      mutate(template) {
        const lbpm = template.mechanisms.lbpmTemplate[0];
        const content = JSON.parse(lbpm.fdContent);
        for (const element of content.elements) {
          element.x = (element.x || 0) + 50;
          element.y = (element.y || 0) + 50;
          if (element.type === "sequenceFlow") {
            element.waypoints = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
          }
        }
        lbpm.fdContent = JSON.stringify(content);
        return template;
      }
    });
    assert.equal(readback.ok, true);
  });

  it("rejects unknown workflow node types at projection time", () => {
    const workflow = sampleWorkflow();
    workflow.nodes[0] = {
      ...workflow.nodes[0],
      type: "legacyManualTask"
    };
    const prepared = preparePersistedTemplate({
      dsl: sampleTrustedDsl({ workflow }),
      envelope: sampleEnvelope(),
      baseTemplate: sampleBaseTemplate()
    });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.diagnostics.some((item) => item.code === "projection.workflow.node_type_unsupported"), true);
  });

  it("rejects an unmapped source formula at projection time", () => {
    const workflow = sampleWorkflow();
    workflow.nodes = [
      workflow.nodes[0],
      {
        id: "N2",
        type: "review",
        element: "manualTask",
        name: "公式审批",
        sourceType: "reviewNode",
        sourceRef: "source.workflow.node.N2",
        attributes: {},
        participants: {
          mode: "unmapped_formula",
          reason: "source formula requires ES5 script translation",
          sourceExpression: "import java.util.List; return handlers;",
          sourceNameExpression: "复杂公式"
        },
        translationStatus: "executable"
      },
      { ...workflow.nodes[1], id: "N3", sourceRef: "source.workflow.node.N3" }
    ];
    workflow.edges = [
      { ...workflow.edges[0], id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1" },
      { ...workflow.edges[0], id: "L2", source: "N2", target: "N3", sourceRef: "source.workflow.edge.L2" }
    ];
    workflow.topologicalOrder = ["N1", "N2", "N3"];

    const prepared = preparePersistedTemplate({
      dsl: sampleTrustedDsl({ workflow }),
      envelope: sampleEnvelope(),
      baseTemplate: sampleBaseTemplate()
    });

    assert.equal(prepared.ok, false);
    assert.equal(
      prepared.diagnostics.some((item) => item.code === "projection.workflow.formula_participant_unmapped"),
      true
    );
  });

  it("rejects a configured formula fallback that was not materialized by participant resolution", () => {
    const workflow = sampleWorkflow();
    workflow.nodes[0].participants = {
      mode: "configured_person_fallback",
      fallbackKind: "person",
      reason: "related leader formula has no verified target recipe",
      sourceExpression: '$组织架构.解释角色线$($fd_department$, "公司级相关领导", "相关领导")'
    };

    const prepared = preparePersistedTemplate({
      dsl: sampleTrustedDsl({ workflow }),
      envelope: sampleEnvelope(),
      baseTemplate: sampleBaseTemplate()
    });

    assert.equal(prepared.ok, false);
    assert.equal(
      prepared.diagnostics.some((item) => item.code === "projection.workflow.configured_fallback_unresolved"),
      true
    );
  });
});

describe("decode failures", () => {
  it("reports one precise fdConfig decode diagnostic without cascaded count noise", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        template.mechanisms["sys-xform"].fdConfig = "{not-json";
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.partitions.form, "decode_failed");
    const decodeDiagnostics = readback.diagnostics.filter((item) => item.code.startsWith("readback.decode."));
    assert.equal(decodeDiagnostics.length, 1);
    assert.equal(decodeDiagnostics[0].code, "readback.decode.fdConfig.invalid_json");
    assert.equal(readback.diagnostics.every((item) => !String(item.code).includes("field_count")), true);
  });

  it("reports malformed formAttr without cascading script count mismatches", () => {
    const { readback } = persistAndVerify(sampleTrustedDsl({ workflow: null }), {
      mutate(template) {
        const config = xformConfig(template);
        config.attribute.formAttr = "{bad";
        template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return template;
      }
    });
    assert.equal(readback.ok, false);
    assert.equal(readback.partitions.rules, "decode_failed");
    assert.equal(readback.partitions.scripts, "decode_failed");
    assert.equal(readback.diagnostics.some((item) => item.code === "readback.decode.formAttr.invalid_json"), true);
    assert.equal(readback.diagnostics.every((item) => !String(item.code).includes("action_count")), true);
  });

  it("loads an independently authored native fixture for successful readback", () => {
    const dsl = sampleTrustedDsl({ workflow: null });
    const prepared = prepareSample(dsl);
    const fixture = loadIndependentFormFixture();
    // Fixture is authored from a sanitized projection snapshot checked into the repo,
    // not cloned inside the test from the live writer output.
    const readback = prepared.verify(fixture);
    assert.equal(readback.ok, true);
  });
});
