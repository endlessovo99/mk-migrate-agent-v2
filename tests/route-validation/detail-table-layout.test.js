import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFormRuleRefIndex, resolveEffectTarget } from "../../src/dsl/form-rules.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixture =
  "tests/fixtures/route-validation/structural-recovery/route-structural-recovery-inline-content_SysFormTemplate.xml";

describe("detail-table Route-validation", () => {
  it("preserves nested standard-table rows instead of widening them to the eight-column limit", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const nestedSourceRows = sourceDraft.form.layout.rows.filter((row) =>
      row.id.startsWith("row-15.nested-0.row-")
    );
    const nestedTargetRows = dslDraft.form.layout.mkTree.filter((row) =>
      row.sourceRef.includes("row-15.nested-0.row-")
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
