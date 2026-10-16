import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { buildFormRuleRefIndex, resolveEffectTarget } from "../../src/dsl/form-rules.js";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { inlineRadioRowEffectCandidates } from "../../src/translator/inline-radio-row-effects.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { scanHtmlTags, findMatchingCloseTag, splitDirectChildRows, splitDirectChildCells } from "../../src/translator/designer-html-tokenizer.js";
import { prepareSample } from "../helpers/persistence.js";

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
    assertSourceCaptions(sourceDraft, dslDraft, ["nested_alpha_label", "nested_bravo_label", "nested_charlie_label"]);
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
      ["nested_alpha_label", "fd_nested_alpha", "nested_bravo_label", "fd_nested_bravo"],
      ["nested_charlie_label", "fd_nested_charlie"]
    ]);
    assert.equal(nestedTargetRows.length, 4);
    assert.deepEqual(nestedTargetRows.map(refs), [
      ["nested_layout_heading"],
      ["fd_nested_detail"],
      ["nested_alpha_label", "fd_nested_alpha", "nested_bravo_label", "fd_nested_bravo"],
      ["nested_charlie_label", "fd_nested_charlie"]
    ]);
    assert.deepEqual(
      nestedTargetRows.map((row) => ({ componentId: row.componentId, props: row.props })),
      [
        { componentId: "xform-flex-1-4-layout", props: { columns: 4, sourceColumns: 4 } },
        { componentId: "xform-flex-1-4-layout", props: { columns: 4, sourceColumns: 4 } },
        { componentId: "xform-flex-1-4-layout", props: { columns: 4, sourceColumns: 4 } },
        { componentId: "xform-flex-1-4-layout", props: { columns: 4, sourceColumns: 4 } }
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
      ["nested_alpha_label", "fd_nested_alpha", "nested_bravo_label", "fd_nested_bravo", "nested_charlie_label", "fd_nested_charlie"]
    );
    assertRawNestedRectangles(fixture, sourceDraft, dslDraft, 16, 0);
  });

  it("preserves nested rows inside a spanning content cell instead of packing them into eight columns", () => {
    const sourceDraft = cleanSourceFile(receptionFixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    assertSourceCaptions(sourceDraft, dslDraft, [
      "fd_334989ac8b28f2", "fd_334989c5511d26", "fd_334989db472a4a",
      "fd_334989f4cdd4a6", "fd_33498a010afd18", "fd_334989e37cc4ac",
      "fd_38fc8e3830cdf6", "fd_34d5769b9617de", "fd_33498e6b128046",
      "fd_33498e76755d2c", "fd_33498f856d4800", "fd_33498f8e50b90e",
      "fd_33498f969cac9a", "fd_33498fa03d7428", "fd_3349908c790140"
    ]);

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
                "row-5.nested-0.row-4",
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
                "layout.row-5.nested-0.row-4",
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
          row.id.startsWith(sourcePrefix) && !row.id.includes(".rowspan-")
        );
        const targetRows = dslDraft.form.layout.mkTree.filter((row) =>
          row.sourceRef.startsWith(targetSourcePrefix) && !row.id.includes(".rowspan-")
        );
        return {
          outerRowId,
          sourceRows: sourceRows.map((row) =>
            firstPhysicalRowRefs(row, sourceDraft.form.layout.rows, false)
          ),
          targetRows: targetRows.map((row) =>
            firstPhysicalRowRefs(row, dslDraft.form.layout.mkTree, true)
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
            ["fd_334989ac8b28f2", "fd_334989b1248a00", "fd_334989b800c6ce", "fd_334989bc465d90"],
            ["fd_334989c5511d26", "fd_334989cda7faf4", "fd_334989db472a4a", "fd_334989d85276e0"],
            ["fd_334989f4cdd4a6", "fd_334989fa630fa2"],
            ["fd_33498a010afd18", "fd_the_visit_str"],
            ["fd_334989e37cc4ac", "fd_the_visit_num", "fd_38fc8e3830cdf6"],
            ["fd_34d5769b9617de", "fd_34d576b31dfc72"]
          ],
          targetRows: [
            ["fd_334989ac8b28f2", "fd_334989b1248a00", "fd_334989b800c6ce", "fd_334989bc465d90"],
            ["fd_334989c5511d26", "fd_334989cda7faf4", "fd_334989db472a4a", "fd_334989d85276e0"],
            ["fd_334989f4cdd4a6", "fd_334989fa630fa2"],
            ["fd_33498a010afd18", "fd_the_visit_str"],
            ["fd_334989e37cc4ac", "fd_the_visit_num", "fd_38fc8e3830cdf6"],
            ["fd_34d5769b9617de", "fd_34d576b31dfc72"]
          ],
          targetRowShapes: [
            { componentId: "xform-flex-1-4-layout", columns: 4, sourceColumns: 4 },
            { componentId: "xform-flex-1-4-layout", columns: 4, sourceColumns: 4 },
            { componentId: "xform-flex-1-4-layout", columns: 4, sourceColumns: 4 },
            { componentId: "xform-flex-1-4-layout", columns: 4, sourceColumns: 4 },
            { componentId: "xform-flex-1-4-layout", columns: 4, sourceColumns: 4 },
            { componentId: "xform-flex-1-4-layout", columns: 4, sourceColumns: 4 }
          ],
          targetEightColumnRows: []
        },
        {
          outerRowId: "row-5",
          sourceRows: [
            ["fd_33498ad903ca80", "fd_33498a996588f4"],
            ["fd_33498e62d0a4dc", "fd_33498e6b128046", "fd_334993a083710c", "fd_33498e76755d2c", "fd_33498e7e8a94fc"],
            ["fd_33498f7e056e2e", "fd_33498f856d4800", "fd_334993af8d6ece", "fd_33498f8e50b90e", "fd_334993bdca328e"],
            ["fd_33498f969cac9a", "fd_37f866e5e63e96", "fd_33498fa03d7428", "fd_37f866e72d66ce"],
            ["fd_33498fb95f5afa", "fd_3e1159533fe5a8"],
            ["fd_the_resive_table"],
            ["fd_3e1164aaeb850a", "fd_the_food_address"],
            ["fd_3349908c790140", "fd_334990c7f071b0"]
          ],
          targetRows: [
            ["fd_33498ad903ca80", "fd_33498a996588f4"],
            ["fd_33498e62d0a4dc", "fd_33498e6b128046", "fd_334993a083710c", "fd_33498e76755d2c", "fd_33498e7e8a94fc"],
            ["fd_33498f7e056e2e", "fd_33498f856d4800", "fd_334993af8d6ece", "fd_33498f8e50b90e", "fd_334993bdca328e"],
            ["fd_33498f969cac9a", "fd_37f866e5e63e96", "fd_33498fa03d7428", "fd_37f866e72d66ce"],
            ["fd_33498fb95f5afa", "fd_3e1159533fe5a8"],
            ["fd_the_resive_table"],
            ["fd_3e1164aaeb850a", "fd_the_food_address"],
            ["fd_3349908c790140", "fd_334990c7f071b0"]
          ],
          targetRowShapes: [
            { componentId: "xform-multi-row-table-layout", columns: 6, sourceColumns: undefined },
            { componentId: "xform-multi-row-table-layout", columns: 6, sourceColumns: undefined },
            { componentId: "xform-multi-row-table-layout", columns: 6, sourceColumns: undefined },
            { componentId: "xform-multi-row-table-layout", columns: 5, sourceColumns: undefined },
            { componentId: "xform-multi-row-table-layout", columns: 6, sourceColumns: undefined },
            { componentId: "xform-multi-row-table-layout", columns: 5, sourceColumns: undefined },
            { componentId: "xform-multi-row-table-layout", columns: 5, sourceColumns: undefined },
            { componentId: "xform-multi-row-table-layout", columns: 6, sourceColumns: undefined }
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
          colsStyle: expectedWidthStyles([135, 135, 513, 135, 135]),
          firstCell: { column: 0, colspan: 1, rowspan: 6 }
        },
        {
          id: "layout.row-5",
          rows: 8,
          columns: 7,
          colsStyle: expectedWidthStyles([135, 135, 433, 506, 160, 135, 135]),
          firstCell: { column: 0, colspan: 1, rowspan: 8 }
        },
        {
          id: "layout.row-7",
          rows: 2,
          columns: 1,
          colsStyle: [{ startIndex: 0, count: 1, value: "100%" }],
          firstCell: { column: 0, colspan: 1, rowspan: 1 }
        }
      ]
    );
    assertRawNestedRectangles(receptionFixture, sourceDraft, dslDraft, 3, 1);
    assertRawNestedRectangles(receptionFixture, sourceDraft, dslDraft, 5, 1);
  });

  it("retains all visible nested headers and separates table alias from outer row marker ownership", () => {
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
      ["row-16.cell-0.before", "row-16.nested-0"]
    );
    assert.deepEqual(
      sourceDraft.form.layout.rows
        .find((row) => row.id === "row-16.cell-0.before")
        ?.cells.flatMap((cell) => cell.references.map((reference) => reference.referenceId)),
      ["fd_384596230af2e0", "fd_3845963b9cb07e"]
    );

    const dslDraft = draftSourceDraft(sourceDraft);
    const validation = validateMigrationDsl(dslDraft, { mode: "draft" });
    const headerRows = rawNestedRows(nestedEmptyRowsFixture, 16).slice(0, 2);
    assert.equal(headerRows.flatMap(row => splitDirectChildCells(row))
      .filter(cell => Number(cell.attrs.rowspan ?? cell.attrs.rowSpan ?? 1) === 2).length, 6);
    for (const caption of ["序号", "姓名", "工号", "变动日期", "变动原因", "备注"]) {
      assert.ok(headerRows.join("").includes(caption));
    }
    assert.deepEqual(validation.diagnostics.filter(item => item.level === "error"), []);
    const tableRows = sourceDraft.form.layout.rows.filter(row => /^row-16\.nested-0\.row-\d+$/.test(row.id));
    assert.equal(tableRows.length, 3);
    const gridIds = tableRows.flatMap(row => row.cells.flatMap(cell => cell.references.map(ref => ref.referenceId)));
    assert.equal(gridIds.length, 22);
    assert.equal(new Set(gridIds).size, 22);
    const headerIds = tableRows.slice(0, 2).flatMap(row => row.cells.flatMap(cell => cell.references.map(ref => ref.referenceId)));
    assert.equal(headerIds.length, 12);
    assertSourceCaptions(sourceDraft, dslDraft, headerIds);
    assert.deepEqual(sourceDraft.form.layout.rows.find(row => row.id === "row-16").sourceMarkers, ["fd_adjust_row"]);
    assert.deepEqual(sourceDraft.form.layout.rows.find(row => row.id === "row-16.nested-0").sourceMarkers, ["fd_38458ab557b0d0"]);
    assert.ok(tableRows.every(row => !row.sourceMarkers?.length));
    const refIndex = buildFormRuleRefIndex(dslDraft.form);
    assert.deepEqual(new Set(resolveEffectTarget(refIndex, "fd_38458ab557b0d0").targets.map(target => target.id)), new Set(gridIds));
    assert.deepEqual(new Set(resolveEffectTarget(refIndex, "fd_adjust_row").targets.map(target => target.id)),
      new Set([...gridIds, "fd_384596230af2e0", "fd_3845963b9cb07e"]));
    assertRawNestedRectangles(nestedEmptyRowsFixture, sourceDraft, dslDraft, 16, 0, 1, 1);
    const nameInput = dslDraft.form.fields.find(field => field.id === "fd_384591cceaf58c");
    assert.deepEqual(nameInput.sourceProps.layoutCell.captionIds, ["fd_38458b02f44df6"]);
    assert.equal(nameInput.props.hiddenLabel, true);
    const prefix = dslDraft.form.fields.find(field => field.id === "fd_384596230af2e0");
    assert.equal(prefix.title, "人资调字 第");
    assert.notEqual(prefix.props.hiddenLabel, true);
    assert.equal(dslDraft.form.fields.find(field => field.id === "fd_3845963b9cb07e").props.content, "号");
    assert.equal(dslDraft.form.fields.some(field => field.id === "fd_38458abbc7e8a6"), false);
    const prepared = prepareSample(dslDraft), readback = prepared.verify(prepared.update);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.form.fields.find(field => field.id === prefix.id).title, "人资调字 第");
    assert.notEqual(readback.form.fields.find(field => field.id === prefix.id).hiddenLabel, true);
    assert.equal(readback.form.scripts.actionCount, 3);
  });

  it("deterministically translates employee-notice radio row effects without legacy DOM access", () => {
    const sourceDraft = cleanSourceFile(nestedEmptyRowsFixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const actions = dslDraft.scripts.actions;
    const validation = validateMigrationDsl(dslDraft, { mode: "draft" });

    assert.equal(actions.length, 3);
    assert.deepEqual(
      actions.map((action) => action.event),
      ["onChange", "onChange", "onLoad"]
    );
    assert.equal(actions.every((action) => action.translationStatus === "mapped"), true);
    assert.equal(actions.every((action) => action.coverage?.status === "translated"), true);
    assert.equal(actions.every((action) =>
      action.deterministicBranchProof?.basis === "deterministic-inline-radio-row-effects"
    ), true);
    assert.equal(actions.every((action) =>
      action.function.includes("MKXFORM.setFieldAttr(") &&
      !/common_dom_row_set_show_required_reset|GetXFormFieldById|document\./u.test(action.function)
    ), true);
    assert.equal(
      validation.diagnostics.some((item) =>
        item.code.startsWith("dsl.scripts.deterministic_branch_")
      ),
      false
    );
    assert.deepEqual(validation.diagnostics.filter(item => item.level === "error"), []);

    const loadSource = sourceDraft.scripts.sources.find((source) =>
      source.sourceRef.endsWith(".script.2")
    );
    const unsafeLoadSource = {
      ...loadSource,
      javascript: loadSource.javascript.replace(
        "function(){",
        "function(){\nwindow.unknownSideEffect = true;"
      )
    };
    assert.deepEqual(
      inlineRadioRowEffectCandidates(unsafeLoadSource, dslDraft.form),
      []
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
      const cells = rows.flatMap((row) =>
        row.children.filter((child) => child.refIds.includes(detailId))
      );
      assert.equal(rows.length, 1, detailId);
      assert.equal(cells.length, 1, detailId);
      assert.deepEqual(cells[0].refIds, [detailId], detailId);
      assert.equal(cells[0].refType, "detailTable", detailId);
      assert.equal(cells[0].keepInline, undefined, detailId);
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

function assertSourceCaptions(source, dsl, ids) {
  for (const id of ids) {
    const original = source.form.controls.find(field => field.id === id);
    const label = dsl.form.fields.find(field => field.id === id);
    assert.equal(original.sourceProps.designerType, "textLabel");
    assert.equal(label.componentId, "xform-description");
    assert.equal(label.sourceRef, original.sourceRef);
    assert.equal(label.props.content, original.sourceProps.designerValues.content);
  }
}

function firstPhysicalRowRefs(row, rows, target) {
  return (target ? row.children : row.cells).flatMap(cell => {
    const refs = target ? cell.refIds : cell.references.map(ref => ref.referenceId);
    if (refs[0]?.includes(".rowspan-")) {
      return firstPhysicalRowRefs(rows.find(candidate => candidate.id === refs[0]), rows, target);
    }
    return refs;
  });
}

function expectedWidthStyles(weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight, startIndex) => ({
    startIndex, count: 1, value: `${Number((weight / total * 100).toFixed(12))}%`
  }));
}

// The oracle reads raw TD rectangles, independently of normalized source rows
// and mkTree nesting. Native may merge unused boundaries but cannot move the
// remaining physical intervals or lose the source's occupied rows.
function assertRawNestedRectangles(path, source, dsl, outerRow, outerColumns, rowOffset = 0, extraRows = 0) {
  const rawRows = rawNestedRows(path, outerRow);
  const native = projectNativeLayoutRows(dsl.form.layout.mkTree).find(row => row.id === `layout.row-${outerRow}`);
  assert.equal(native.rows, rawRows.length + extraRows);
  const fieldIds = new Set([...source.form.controls, ...source.form.detailTables].map(field => field.id));
  const expectedRefs = [];
  rawRows.forEach((html, row) => {
    for (const td of splitDirectChildCells(html, { includeUnquotedWidth: true })) {
      const columns = String(td.attrs.column).split(",").map(Number);
      const ids = [...new Set([...td.body.matchAll(/\bid\s*:\s*(["'])(.*?)\1/g)]
        .map(match => match[2]).filter(id => fieldIds.has(id)))];
      if (!ids.length) continue;
      expectedRefs.push(...ids);
      const cells = native.cells.filter(cell => cell.refIds.some(id => ids.includes(id)));
      assert.equal(cells.length, 1, ids.join(","));
      const cell = cells[0];
      assert.deepEqual(cell.refIds, ids);
      assert.deepEqual([cell.row, cell.column, cell.colspan, cell.rowspan], [
        row + rowOffset, outerColumns + columns[0], columns.length, Number(td.attrs.rowspan ?? td.attrs.rowSpan ?? 1)
      ], `${ids.join(",")} must keep its raw source rectangle`);
    }
  });
  assert.deepEqual(native.cells.filter(cell => cell.column >= outerColumns && cell.row >= rowOffset && cell.row < rowOffset + rawRows.length)
    .flatMap(cell => cell.refIds), expectedRefs);
}

function rawNestedRows(path, outerRow) {
  const html = parseSysFormTemplateXml(readFileSync(path, "utf8")).fdDesignerHtml;
  const tableBody = fragment => {
    const table = [...scanHtmlTags(fragment)].find(token => token.name === "table" && !token.closing &&
      /\bfd_type\s*=\s*(["'])standardTable\1/i.test(token.raw));
    assert.ok(table);
    const end = findMatchingCloseTag(fragment, table.end, "table");
    return fragment.slice(table.end, end);
  };
  return splitDirectChildRows(tableBody(splitDirectChildRows(tableBody(html))[outerRow]));
}
