import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixture =
  "tests/fixtures/route-validation/structural-recovery/route-structural-recovery-inline-content_SysFormTemplate.xml";

describe("detail-table Route-validation", () => {
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
