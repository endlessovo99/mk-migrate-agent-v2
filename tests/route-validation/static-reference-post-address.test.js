import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { executeDsl } from "../../src/executor/execute.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { xformConfig } from "../helpers/persistence.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";

const sourcePath = "tests/fixtures/source/1685490d3f8a4f7eaa68f75486ea2ff8";
const expectedReferenceContent = [
  "所在部门",
  "工作安排、资料交接、办公用品申请",
  "IT 信息管理部",
  "KOA调整、软硬件、帐号、电话分机表的更新",
  "党群工作部",
  "工会、组织关系",
  "人力资源部",
  "人事调动、薪资、档案、工卡、劳动手册等",
  "财务部",
  "借款、结算",
  "总裁办公室",
  "办公用品的发放与回收"
];

describe("static reference and post-address route projection", () => {
  it("preserves the reference table as one grid with a seven-row 处理流程 column", () => {
    const sourceDraft = cleanSourceFile(sourcePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const descriptionContent = dslDraft.form.fields
      .filter((field) => field.componentId === "xform-description")
      .map((field) => field.props.content.trim());

    for (const content of expectedReferenceContent) {
      assert.equal(
        descriptionContent.includes(content),
        true,
        `missing reference content: ${content}`
      );
    }

    const referenceGrid = projectNativeLayoutRows(dslDraft.form.layout.mkTree)
      .find((row) => row.cells.some((cell) =>
        cell.refIds.includes("fd_3271f761d0b230")
      ));
    assert.deepEqual(
      {
        rows: referenceGrid.rows,
        columns: referenceGrid.columns,
        colsStyle: referenceGrid.colsStyle
      },
      {
        rows: 7,
        columns: 3,
        colsStyle: [
          { startIndex: 0, count: 1, value: "22.268907563025%" },
          { startIndex: 1, count: 1, value: "55.46218487395%" },
          { startIndex: 2, count: 1, value: "22.268907563025%" }
        ]
      }
    );
    assert.deepEqual(
      referenceGrid.cells
        .filter((cell) => [
          "fd_3271f761d0b230",
          "fd_3271f6e6cad16a",
          "fd_3271f6e74c1a34",
          "fd_3271f703046a3e",
          "fd_3271f71e086bf0"
        ].includes(cell.refIds[0]))
        .map((cell) => ({
          fieldId: cell.refIds[0],
          row: cell.row,
          column: cell.column,
          colspan: cell.colspan,
          rowspan: cell.rowspan
        })),
      [
        {
          fieldId: "fd_3271f761d0b230",
          row: 0,
          column: 0,
          colspan: 1,
          rowspan: 7
        },
        {
          fieldId: "fd_3271f6e6cad16a",
          row: 0,
          column: 1,
          colspan: 1,
          rowspan: 1
        },
        {
          fieldId: "fd_3271f6e74c1a34",
          row: 0,
          column: 2,
          colspan: 1,
          rowspan: 1
        },
        {
          fieldId: "fd_3271f703046a3e",
          row: 6,
          column: 1,
          colspan: 1,
          rowspan: 1
        },
        {
          fieldId: "fd_3271f71e086bf0",
          row: 6,
          column: 2,
          colspan: 1,
          rowspan: 1
        }
      ]
    );
  });

  it("persists post selectors with the native 岗位 code", async () => {
    const sourceDraft = cleanSourceFile(sourcePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const detail = dslDraft.form.fields.find((field) => field.id === "fd_3242f3c67e44fc");
    for (const columnId of ["fd_out_post", "fd_in_post"]) {
      const column = detail.columns.find((entry) => entry.id === columnId);
      assert.deepEqual(column.props.orgTypes, ["ORG_TYPE_POST"]);
    }

    delete dslDraft.workflow;
    delete dslDraft.formRules;
    dslDraft.scripts.actions = [];
    const dsl = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-test-agent",
      checkedAt: "2026-07-24T00:00:00.000Z"
    });
    const adapter = new FakeNewoaAdapter("persist");
    const execution = await executeDsl(dsl, {
      client: adapter,
      confirmWrite: true,
      targetCategoryId: "route-category-id",
      credentials: {
        username: "route-test-user",
        encryptedPassword: "route-test-encrypted-password"
      },
      now: new Date("2026-07-24T00:00:00.000Z")
    });
    const config = xformConfig(adapter.template);
    const detailModel = config.dataModel.find((model) =>
      model.dynamicProps?.detailFieldName === detail.id
    );
    const referenceGrid = execution.readback.form.layoutRows.find((row) =>
      row.cells.some((cell) => cell.fieldIds.includes("fd_3271f761d0b230"))
    );
    assert.equal(referenceGrid.rows, 7);
    assert.equal(
      referenceGrid.cells.find((cell) =>
        cell.fieldIds.includes("fd_3271f761d0b230")
      ).rowspan,
      7
    );

    for (const columnId of ["fd_out_post", "fd_in_post"]) {
      const persisted = detailModel.fdFields.find((field) => field.fdName === columnId);
      const attribute = JSON.parse(persisted.fdAttribute);
      // Native evidence captured from the designer after selecting “岗位”.
      assert.deepEqual(attribute.config.controlProps.org, {
        orgTypeArr: ["4"],
        defaultValueType: "null"
      });
      assert.deepEqual(
        execution.readback.form.fields
          .find((field) => field.id === detail.id)
          .columns.find((column) => column.id === columnId)
          .orgTypes,
        ["ORG_TYPE_POST"]
      );
    }
    assert.equal(execution.readback.partitions.form, "verified");
  });

  it("does not render duplicate semantic columns in the migrated detail table", async () => {
    const sourceDraft = cleanSourceFile(sourcePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const dslDetail = dslDraft.form.fields
      .find((field) => field.id === "fd_3242f3c67e44fc");
    const dslColumnsById = new Map(
      dslDetail.columns.map((column) => [column.id, column])
    );

    assert.deepEqual(
      ["fd_name", "fd_out_post_input", "fd_in_post_input"].map((id) => ({
        id,
        dataOnly: dslColumnsById.get(id).dataOnly,
        required: dslColumnsById.get(id).props.required,
        role: dslColumnsById.get(id).sourceProps.legacyDetailComposite.role
      })),
      [
        { id: "fd_name", dataOnly: true, required: undefined, role: "stored_display_shadow" },
        { id: "fd_out_post_input", dataOnly: true, required: undefined, role: "stored_display_shadow" },
        { id: "fd_in_post_input", dataOnly: true, required: undefined, role: "stored_display_shadow" }
      ]
    );
    assert.deepEqual(
      ["fd_xz_name", "fd_out_post", "fd_in_post"].map((id) => ({
        id,
        dataOnly: dslColumnsById.get(id).dataOnly === true,
        role: dslColumnsById.get(id).sourceProps.legacyDetailComposite.role
      })),
      [
        { id: "fd_xz_name", dataOnly: false, role: "interactive_address" },
        { id: "fd_out_post", dataOnly: false, role: "interactive_address" },
        { id: "fd_in_post", dataOnly: false, role: "interactive_address" }
      ]
    );
    assert.equal(dslColumnsById.get("fd_xz_name").props.required, true);

    delete dslDraft.workflow;
    delete dslDraft.formRules;
    dslDraft.scripts.actions = [];

    const dsl = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-test-agent",
      checkedAt: "2026-07-28T00:00:00.000Z"
    });
    const adapter = new FakeNewoaAdapter("persist");
    const execution = await executeDsl(dsl, {
      client: adapter,
      confirmWrite: true,
      targetCategoryId: "route-category-id",
      credentials: {
        username: "route-test-user",
        encryptedPassword: "route-test-encrypted-password"
      },
      now: new Date("2026-07-28T00:00:00.000Z")
    });

    const detail = execution.readback.form.fields
      .find((field) => field.id === "fd_3242f3c67e44fc");
    const columnsById = new Map(detail.columns.map((column) => [column.id, column]));
    const renderedTitles = detail.columns
      .filter((column) => column.dataOnly !== true)
      .map((column) => column.title.trim().replace(/\s+/g, " "));
    const duplicateTitles = [...new Set(
      renderedTitles.filter((title, index) => renderedTitles.indexOf(title) !== index)
    )];

    assert.deepEqual(duplicateTitles, []);
    assert.deepEqual(
      ["fd_name", "fd_out_post_input", "fd_in_post_input"]
        .map((id) => columnsById.get(id).dataOnly),
      [true, true, true]
    );
    assert.deepEqual(
      ["fd_xz_name", "fd_out_post", "fd_in_post"]
        .map((id) => detail.renderedColumnIds.includes(id)),
      [true, true, true]
    );
    assert.deepEqual(
      ["fd_name", "fd_out_post_input", "fd_in_post_input"]
        .map((id) => detail.renderedColumnIds.includes(id)),
      [false, false, false]
    );
  });

  it("keeps same-header fields separate without zero-width selector evidence", () => {
    const sourceDraft = structuredClone(cleanSourceFile(sourcePath));
    const sourceDetail = sourceDraft.form.detailTables
      .find((field) => field.id === "fd_3242f3c67e44fc");
    for (const id of ["fd_xz_name", "fd_out_post", "fd_in_post"]) {
      sourceDetail.columns
        .find((column) => column.id === id)
        .sourceProps.designerValues.width = "120";
    }

    const dslDraft = draftSourceDraft(sourceDraft);
    const dslDetail = dslDraft.form.fields
      .find((field) => field.id === "fd_3242f3c67e44fc");

    assert.deepEqual(
      dslDetail.columns
        .filter((column) => [
          "fd_name",
          "fd_xz_name",
          "fd_out_post_input",
          "fd_out_post",
          "fd_in_post_input",
          "fd_in_post"
        ].includes(column.id))
        .map((column) => column.dataOnly === true),
      [false, false, false, false, false, false]
    );
  });
});
