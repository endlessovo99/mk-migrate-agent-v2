import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixture =
  "tests/fixtures/source2/166d3145e1817ed9b638cb34cf485c39";

describe("Source2 nested detail-table route validation", () => {
  it("projects a detail table nested beside a rowspan into its own full-width row", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const detailTableId = "fd_35a2a773484700";
    const owningRows = dslDraft.form.layout.mkTree.filter((row) =>
      row.children.some((child) => child.refIds.includes(detailTableId))
    );
    const validation = validateMigrationDsl(dslDraft, { mode: "draft" });

    assert.equal(owningRows.length, 1);
    assert.equal(owningRows[0].componentId, "xform-flex-1-1-layout");
    assert.deepEqual(owningRows[0].props, {
      columns: 1,
      sourceColumns: 3
    });
    assert.equal(owningRows[0].children.length, 1);
    assert.deepEqual(owningRows[0].children[0], {
      id: "layout.row-4-cell-1",
      refType: "detailTable",
      refIds: [detailTableId],
      sourceRef: "source.form.layout.cell.row-4-cell-1",
      column: 0,
      colspan: 1
    });
    assert.equal(
      validation.diagnostics.some((diagnostic) =>
        diagnostic.code === "dsl.form.layout.detail_table_row_exclusive"
      ),
      false
    );
    assert.equal(validation.ok, true);
  });
});
