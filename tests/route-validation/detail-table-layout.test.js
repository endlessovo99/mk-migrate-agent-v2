import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFormRuleRefIndex, resolveEffectTarget } from "../../src/dsl/form-rules.js";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixture =
  "tests/fixtures/route-validation/structural-recovery/route-structural-recovery-inline-content_SysFormTemplate.xml";
const receptionFixture =
  "tests/fixtures/source/160de1c3bc9590b8b2ce02a4b4a95845/160de1ed5abb6ea650271de4549a11ed_SysFormTemplate.xml";
const nestedEmptyRowsFixture =
  "tests/fixtures/source/1684f9b552170cab50d0cd04231954b9/1684fa994ca99291085162b4f8781908_SysFormTemplate.xml";

describe("detail-table Route-validation", () => {
  it("preserves nested standard-table rows instead of widening them to the eight-column limit", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const nestedSourceRows = sourceDraft.form.layout.rows.filter((row) =>
      row.id.startsWith("row-16.nested-0.row-")
    );
    const nestedTargetRows = dslDraft.form.layout.mkTree.filter((row) =>
      row.sourceRef.includes("row-16.nested-0.row-")
    );
    const refs = (row) => row.children.flatMap((child) => child.refIds);
    const sourceRefs = (row) => row.cells.flatMap((cell) =>
      cell.references.map((reference) => reference.referenceId)
    );

    assert.equal(nestedSourceRows.length, 4);
    assert.deepEqual(nestedSourceRows.map(sourceRefs), [
      ["nested_layout_heading"],
      ["fd_nested_detail"],
      ["fd_nested_alpha", "fd_nested_bravo"],
      ["fd_nested_charlie"]
    ]);
    assert.equal(nestedTargetRows.length, 4);
    assert.deepEqual(nestedTargetRows.map(refs), [
      ["nested_layout_heading"],
      ["fd_nested_detail"],
      ["fd_nested_alpha", "fd_nested_bravo"],
      ["fd_nested_charlie"]
    ]);
    assert.deepEqual(
      nestedTargetRows.map((row) => ({ componentId: row.componentId, props: row.props })),
      [
        { componentId: "xform-flex-1-1-layout", props: { columns: 1, sourceColumns: 4 } },
        { componentId: "xform-flex-1-1-layout", props: { columns: 1, sourceColumns: 4 } },
        { componentId: "xform-flex-1-2-layout", props: { columns: 2, sourceColumns: 4 } },
        { componentId: "xform-flex-1-1-layout", props: { columns: 1, sourceColumns: 4 } }
      ]
    );
    assert.equal(
      nestedTargetRows.some((row) => row.componentId === "xform-multi-row-table-layout"),
      false
    );
    const nestedSourceParent = sourceDraft.form.layout.rows.find((row) => row.id === "row-16");
    const nestedTargetParent = dslDraft.form.layout.mkTree.find((row) => row.id === "layout.row-16");
    assert.deepEqual(
      nestedSourceParent?.cells.map((cell) => ({
        referenceTypes: cell.references.map((reference) => reference.referenceType),
        referenceIds: cell.references.map((reference) => reference.referenceId),
        column: cell.column,
        colspan: cell.colspan
      })),
      [{
        referenceTypes: ["layout", "layout", "layout", "layout"],
        referenceIds: [
          "row-16.nested-0.row-0",
          "row-16.nested-0.row-1",
          "row-16.nested-0.row-2",
          "row-16.nested-0.row-3"
        ],
        column: 0,
        colspan: 4
      }]
    );
    assert.deepEqual(nestedTargetParent?.children.map((child) => ({
      refType: child.refType,
      refIds: child.refIds,
      column: child.column,
      colspan: child.colspan
    })), [{
      refType: "layout",
      refIds: [
        "layout.row-16.nested-0.row-0",
        "layout.row-16.nested-0.row-1",
        "layout.row-16.nested-0.row-2",
        "layout.row-16.nested-0.row-3"
      ],
      column: 0,
      colspan: 4
    }]);

    const nestedSourceDetail = sourceDraft.form.detailTables.find((table) =>
      table.id === "fd_nested_detail"
    );
    const nestedTargetDetail = dslDraft.form.fields.find((field) =>
      field.id === "fd_nested_detail"
    );
    assert.deepEqual(
      nestedSourceDetail?.columns.map((column) => ({
        id: column.id,
        sourceType: column.sourceType,
        designerType: column.sourceProps?.designerType
      })),
      [{ id: "fd_nested_detail_mode", sourceType: "radio", designerType: "inputRadio" }]
    );
    assert.deepEqual(
      nestedTargetDetail?.columns.map((column) => ({
        id: column.id,
        type: column.type,
        componentId: column.componentId
      })),
      [{ id: "fd_nested_detail_mode", type: "radio", componentId: "xform-radio" }]
    );

    const markerTarget = resolveEffectTarget(
      buildFormRuleRefIndex(dslDraft.form),
      "nested_layout_row"
    );
    assert.deepEqual(
      markerTarget?.targets.map((target) => target.id),
      ["fd_nested_alpha", "fd_nested_bravo", "fd_nested_charlie"]
    );
  });

  it("preserves nested rows inside a spanning content cell instead of packing them into eight columns", () => {
    const sourceDraft = cleanSourceFile(receptionFixture);
    const dslDraft = draftSourceDraft(sourceDraft);

    assert.equal(sourceDraft.source.fdTemplateEdition, "55");

    assert.deepEqual(
      [
        { id: "fd_334989a4ab701a", title: "来访信息", outerRowId: "row-3" },
        { id: "fd_33498a369b1152", title: "接待需求信息", outerRowId: "row-5" }
      ].map(({ id, title, outerRowId }) => {
        const sourceField = sourceDraft.form.controls.find((field) => field.id === id);
        const targetField = dslDraft.form.fields.find((field) => field.id === id);
        const sourceRow = sourceDraft.form.layout.rows.find((row) =>
          row.id === outerRowId
        );
        const targetRow = dslDraft.form.layout.mkTree.find((row) =>
          row.id === `layout.${outerRowId}`
        );
        return {
          id,
          title,
          sourceType: sourceField?.sourceType,
          targetType: targetField?.type,
          targetComponentId: targetField?.componentId,
          targetContent: targetField?.props?.content?.trim(),
          sourceColumns: sourceRow?.columns,
          sourceCells: sourceRow?.cells.map((cell) => ({
            referenceType: cell.references[0]?.referenceType,
            referenceIds: cell.references.map((reference) => reference.referenceId),
            column: cell.column,
            colspan: cell.colspan
          })),
          targetComponent: targetRow?.componentId,
          targetProps: targetRow?.props,
          targetCells: targetRow?.children.map((child) => ({
            refType: child.refType,
            refIds: child.refIds,
            column: child.column,
            colspan: child.colspan
          }))
        };
      }),
      [
        {
          id: "fd_334989a4ab701a",
          title: "来访信息",
          sourceType: "description",
          targetType: "description",
          targetComponentId: "xform-description",
          targetContent: "来访信息",
          sourceColumns: 4,
          sourceCells: [
            {
              referenceType: "control",
              referenceIds: ["fd_334989a4ab701a"],
              column: 0,
              colspan: 1
            },
            {
              referenceType: "layout",
              referenceIds: [
                "row-3.nested-0.row-0",
                "row-3.nested-0.row-1",
                "row-3.nested-0.row-2",
                "row-3.nested-0.row-3",
                "row-3.nested-0.row-4",
                "row-3.nested-0.row-5"
              ],
              column: 1,
              colspan: 3
            }
          ],
          targetComponent: "xform-flex-1-4-layout",
          targetProps: { columns: 4, sourceColumns: 4 },
          targetCells: [
            {
              refType: "field",
              refIds: ["fd_334989a4ab701a"],
              column: 0,
              colspan: 1
            },
            {
              refType: "layout",
              refIds: [
                "layout.row-3.nested-0.row-0",
                "layout.row-3.nested-0.row-1",
                "layout.row-3.nested-0.row-2",
                "layout.row-3.nested-0.row-3",
                "layout.row-3.nested-0.row-4",
                "layout.row-3.nested-0.row-5"
              ],
              column: 1,
              colspan: 3
            }
          ]
        },
        {
          id: "fd_33498a369b1152",
          title: "接待需求信息",
          sourceType: "description",
          targetType: "description",
          targetComponentId: "xform-description",
          targetContent: "接待需求信息",
          sourceColumns: 4,
          sourceCells: [
            {
              referenceType: "control",
              referenceIds: ["fd_33498a369b1152"],
              column: 0,
              colspan: 1
            },
            {
              referenceType: "layout",
              referenceIds: [
                "row-5.nested-0.row-0",
                "row-5.nested-0.row-1",
                "row-5.nested-0.row-2",
                "row-5.nested-0.row-3",
                "row-5.nested-0.row-4",
                "row-5.nested-0.row-5",
                "row-5.nested-0.row-6",
                "row-5.nested-0.row-7"
              ],
              column: 1,
              colspan: 3
            }
          ],
          targetComponent: "xform-flex-1-4-layout",
          targetProps: { columns: 4, sourceColumns: 4 },
          targetCells: [
            {
              refType: "field",
              refIds: ["fd_33498a369b1152"],
              column: 0,
              colspan: 1
            },
            {
              refType: "layout",
              refIds: [
                "layout.row-5.nested-0.row-0",
                "layout.row-5.nested-0.row-1",
                "layout.row-5.nested-0.row-2",
                "layout.row-5.nested-0.row-3",
                "layout.row-5.nested-0.row-4",
                "layout.row-5.nested-0.row-5",
                "layout.row-5.nested-0.row-6",
                "layout.row-5.nested-0.row-7"
              ],
              column: 1,
              colspan: 3
            }
          ]
        }
      ]
    );
    assert.equal(
      sourceDraft.form.layout.rows.some((row) => row.id.endsWith(".partition-title")),
      false
    );

    assert.deepEqual(
      ["row-3", "row-5"].map((outerRowId) => {
        const sourcePrefix = `${outerRowId}.nested-0.row-`;
        const targetSourcePrefix = `source.form.layout.row.${sourcePrefix}`;
        const sourceRows = sourceDraft.form.layout.rows.filter((row) =>
          row.id.startsWith(sourcePrefix)
        );
        const targetRows = dslDraft.form.layout.mkTree.filter((row) =>
          row.sourceRef.startsWith(targetSourcePrefix)
        );
        return {
          outerRowId,
          sourceRows: sourceRows.map((row) =>
            row.cells.flatMap((cell) =>
              cell.references.map((reference) => reference.referenceId)
            )
          ),
          targetRows: targetRows.map((row) =>
            row.children.flatMap((child) => child.refIds)
          ),
          targetRowShapes: targetRows.map((row) => ({
            componentId: row.componentId,
            columns: row.props?.columns,
            sourceColumns: row.props?.sourceColumns
          })),
          targetEightColumnRows: targetRows
            .filter((row) => row.props?.columns === 8)
            .map((row) => row.id)
        };
      }),
      [
        {
          outerRowId: "row-3",
          sourceRows: [
            ["fd_334989b1248a00", "fd_334989b800c6ce", "fd_334989bc465d90"],
            ["fd_334989cda7faf4", "fd_334989d85276e0"],
            ["fd_334989fa630fa2"],
            ["fd_the_visit_str"],
            ["fd_the_visit_num"],
            ["fd_34d576b31dfc72"]
          ],
          targetRows: [
            ["fd_334989b1248a00", "fd_334989b800c6ce", "fd_334989bc465d90"],
            ["fd_334989cda7faf4", "fd_334989d85276e0"],
            ["fd_334989fa630fa2"],
            ["fd_the_visit_str"],
            ["fd_the_visit_num"],
            ["fd_34d576b31dfc72"]
          ],
          targetRowShapes: [
            { componentId: "xform-flex-1-3-layout", columns: 3, sourceColumns: 4 },
            { componentId: "xform-flex-1-2-layout", columns: 2, sourceColumns: 4 },
            { componentId: "xform-flex-1-1-layout", columns: 1, sourceColumns: 4 },
            { componentId: "xform-flex-1-1-layout", columns: 1, sourceColumns: 4 },
            { componentId: "xform-flex-1-1-layout", columns: 1, sourceColumns: 4 },
            { componentId: "xform-flex-1-1-layout", columns: 1, sourceColumns: 4 }
          ],
          targetEightColumnRows: []
        },
        {
          outerRowId: "row-5",
          sourceRows: [
            ["fd_33498ad903ca80", "fd_33498a996588f4"],
            ["fd_33498e62d0a4dc", "fd_334993a083710c", "fd_33498e7e8a94fc"],
            ["fd_33498f7e056e2e", "fd_334993af8d6ece", "fd_334993bdca328e"],
            ["fd_37f866e5e63e96", "fd_37f866e72d66ce"],
            ["fd_33498fb95f5afa", "fd_3e1159533fe5a8"],
            ["fd_the_resive_table"],
            ["fd_3e1164aaeb850a", "fd_the_food_address"],
            ["fd_334990c7f071b0"]
          ],
          targetRows: [
            ["fd_33498ad903ca80", "fd_33498a996588f4"],
            ["fd_33498e62d0a4dc", "fd_334993a083710c", "fd_33498e7e8a94fc"],
            ["fd_33498f7e056e2e", "fd_334993af8d6ece", "fd_334993bdca328e"],
            ["fd_37f866e5e63e96", "fd_37f866e72d66ce"],
            ["fd_33498fb95f5afa", "fd_3e1159533fe5a8"],
            ["fd_the_resive_table"],
            ["fd_3e1164aaeb850a", "fd_the_food_address"],
            ["fd_334990c7f071b0"]
          ],
          targetRowShapes: [
            { componentId: "xform-flex-1-2-layout", columns: 2, sourceColumns: 6 },
            { componentId: "xform-flex-1-3-layout", columns: 3, sourceColumns: 6 },
            { componentId: "xform-flex-1-3-layout", columns: 3, sourceColumns: 6 },
            { componentId: "xform-flex-1-2-layout", columns: 2, sourceColumns: 6 },
            { componentId: "xform-flex-1-2-layout", columns: 2, sourceColumns: 6 },
            { componentId: "xform-flex-1-1-layout", columns: 1, sourceColumns: 6 },
            { componentId: "xform-flex-1-2-layout", columns: 2, sourceColumns: 6 },
            { componentId: "xform-flex-1-1-layout", columns: 1, sourceColumns: 6 }
          ],
          targetEightColumnRows: []
        }
      ]
    );

    const nativeLayouts = new Map(
      projectNativeLayoutRows(dslDraft.form.layout.mkTree)
        .map((row) => [row.id, row])
    );
    assert.deepEqual(
      ["layout.row-3", "layout.row-5", "layout.row-7"].map((id) => {
        const row = nativeLayouts.get(id);
        return {
          id,
          rows: row?.rows,
          columns: row?.columns,
          colsStyle: row?.colsStyle,
          firstCell: row?.cells[0] && {
            column: row.cells[0].column,
            colspan: row.cells[0].colspan,
            rowspan: row.cells[0].rowspan
          }
        };
      }),
      [
        {
          id: "layout.row-3",
          rows: 6,
          columns: 5,
          colsStyle: [
            { startIndex: 0, count: 1, value: "25%" },
            { startIndex: 1, count: 1, value: "25%" },
            { startIndex: 2, count: 1, value: "12.5%" },
            { startIndex: 3, count: 1, value: "12.5%" },
            { startIndex: 4, count: 1, value: "25%" }
          ],
          firstCell: { column: 0, colspan: 1, rowspan: 6 }
        },
        {
          id: "layout.row-5",
          rows: 8,
          columns: 5,
          colsStyle: [
            { startIndex: 0, count: 1, value: "25%" },
            { startIndex: 1, count: 1, value: "25%" },
            { startIndex: 2, count: 1, value: "12.5%" },
            { startIndex: 3, count: 1, value: "12.5%" },
            { startIndex: 4, count: 1, value: "25%" }
          ],
          firstCell: { column: 0, colspan: 1, rowspan: 8 }
        },
        {
          id: "layout.row-7",
          rows: 2,
          columns: 1,
          colsStyle: undefined,
          firstCell: { column: 0, colspan: 1, rowspan: 1 }
        }
      ]
    );
  });

  it("drops nested references whose empty source rows were not materialized", () => {
    const sourceDraft = cleanSourceFile(nestedEmptyRowsFixture);
    const sourceRowIds = new Set(
      sourceDraft.form.layout.rows.map((row) => row.id)
    );
    const layoutReferences = sourceDraft.form.layout.rows.flatMap((row) =>
      row.cells.flatMap((cell) =>
        cell.references
          .filter((reference) => reference.referenceType === "layout")
          .map((reference) => reference.referenceId)
      )
    );

    assert.equal(
      layoutReferences.every((layoutRowId) => sourceRowIds.has(layoutRowId)),
      true
    );
    assert.deepEqual(
      sourceDraft.form.layout.rows
        .find((row) => row.id === "row-16")
        ?.cells.flatMap((cell) =>
          cell.references
            .filter((reference) => reference.referenceType === "layout")
            .map((reference) => reference.referenceId)
        ),
      ["row-16.nested-0.row-2"]
    );

    const dslDraft = draftSourceDraft(sourceDraft);
    const validation = validateMigrationDsl(dslDraft, { mode: "draft" });
    assert.equal(
      validation.diagnostics.some((item) =>
        item.code === "dsl.form.layout.layout_ref_missing"
      ),
      false
    );
  });

  it("merges only an owned hint and projects every detail table into exactly one full-width row", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const detail = sourceDraft.form.detailTables.find((field) => field.id === "fd_parts_table");
    const dslDetail = dslDraft.form.fields.find((field) => field.id === "fd_parts_table");
    const title = "Assembly parts(Copyflowthenregenerateparts)";

    assert.equal(detail?.title, "Assembly parts");
    assert.equal(dslDetail?.title, title);
    assert.deepEqual(detail?.sourceProps.detailTitleHint, {
      id: "parts_table_hint",
      content: "Copy flow then regenerate parts",
      rawContent: " Copy flow then regenerate parts ",
      designerValues: {
        id: "parts_table_hint",
        content: " Copy flow then regenerate parts ",
        color: "#FF0000",
        b: "false"
      },
      relation: "post-heading-break-styled-text-before-detail-table"
    });
    assert.deepEqual(dslDetail?.sourceProps.detailTitleHint, detail?.sourceProps.detailTitleHint);

    const detailIds = new Set(
      dslDraft.form.fields
        .filter((field) => field.type === "detailTable")
        .map((field) => field.id)
    );
    for (const detailId of detailIds) {
      const rows = dslDraft.form.layout.mkTree.filter((row) =>
        row.children.some((child) => child.refIds.includes(detailId))
      );
      assert.equal(rows.length, 1, detailId);
      assert.equal(rows[0].componentId, "xform-flex-1-1-layout", detailId);
      assert.equal(rows[0].props.columns, 1, detailId);
      assert.equal(rows[0].children.length, 1, detailId);
      assert.deepEqual(rows[0].children[0].refIds, [detailId], detailId);
      assert.equal(rows[0].children[0].refType, "detailTable", detailId);
      assert.equal(rows[0].children[0].column, 0, detailId);
      assert.equal(rows[0].children[0].colspan, 1, detailId);
    }

    assert.equal(
      dslDraft.form.fields.some((field) => field.id === "parts_table_hint"),
      false
    );
    assert.equal(
      dslDraft.form.fields.find((field) => field.id === "post_detail_hint")?.type,
      "description"
    );
  });
});
