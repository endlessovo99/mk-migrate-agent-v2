import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

const fixture =
  "tests/fixtures/source2/171b42a34a50edaf52458864c6a87855";

describe("procurement form compact layout Route-validation", () => {
  it("renders the address composite and right-bound fields as two coherent columns", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const fields = new Map(draft.form.fields.map((field) => [field.id, field]));

    assert.equal(
      source.form.dataFields.some((field) => field.id === "fd_approver_slt.name"),
      true
    );
    assert.equal(fields.get("fd_approver_slt")?.title, "部门/客户");
    assert.equal(fields.get("fd_approver_slt")?.props?.required, true);
    assert.equal(fields.get("fd_approver_slt.name")?.dataOnly, true);

    assert.deepEqual(layoutRefs(draft, "layout.row-0"), [
      "fd_approver_slt",
      "fd_38698f98b41f60"
    ]);
    assert.deepEqual(layoutRefs(draft, "layout.row-5"), [
      "fd_386993e6597e9c",
      "fd_386993ed186744"
    ]);
    assert.deepEqual(layoutRefs(draft, "layout.row-6"), [
      "fd_386993ca94452e",
      "fd_386993c3e622c8"
    ]);

    for (const [rowId, expectedColumns] of [
      ["layout.row-0", 2],
      ["layout.row-5", 2],
      ["layout.row-6", 2]
    ]) {
      const row = draft.form.layout.mkTree.find((candidate) => candidate.id === rowId);
      assert.equal(row?.componentId, "xform-flex-1-2-layout", rowId);
      assert.equal(row?.props?.columns, expectedColumns, rowId);
    }

    assert.equal(fields.get("fd_386993ed186744")?.title, "采购说明");
    assert.equal(fields.get("fd_386993c3e622c8")?.title, "定价");
    assert.equal(fields.has("fd_386992fdc3aee6"), false);
    assert.equal(fields.has("fd_386992ff1d86a2"), false);
    assert.equal(
      draft.form.fields.some((field) => /^fd_[a-f0-9]+$/i.test(field.title)),
      false
    );

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-test",
      checkedAt: "2026-08-24T00:00:00.000Z"
    });
    const prepared = prepareSample(trusted);
    const readback = prepared.verify(prepared.update);

    assert.equal(
      readback.partitions.form,
      "verified",
      JSON.stringify(readback.diagnostics, null, 2)
    );
    for (const rowId of ["layout.row-0", "layout.row-5", "layout.row-6"]) {
      const row = readback.form.layoutRows.find((candidate) => candidate.rootNodeId === rowId);
      assert.equal(row?.columns, 2, rowId);
      assert.equal(row?.cells.length, 2, rowId);
    }
  });
});

function layoutRefs(dsl, rowId) {
  return dsl.form.layout.mkTree
    .find((row) => row.id === rowId)
    ?.children.flatMap((child) => child.refIds) || [];
}
