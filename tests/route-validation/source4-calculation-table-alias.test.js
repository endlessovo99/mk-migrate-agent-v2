import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { persistAndVerify } from "../helpers/persistence.js";

const sourcePath = "tests/fixtures/source4/188d28d4a52c772acda09c04a739f0c0";

describe("Source4 calculation table alias Route case", () => {
  it("rebinds legacy aggregate and row formulas to the recovered detail table", () => {
    const sourceDraft = cleanSourceFile(sourcePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const detail = dslDraft.form.fields.find((field) =>
      field.type === "detailTable" &&
      field.columns.some((column) => column.id === "fd_35523eceb856e4")
    );
    const rowTotal = detail?.columns.find((column) =>
      column.id === "fd_35523eceb856e4"
    );
    const aggregate = dslDraft.form.fields.find((field) =>
      field.id === "fd_35523eca33541a"
    );

    assert.ok(detail);
    assert.deepEqual(rowTotal?.props.calculation, {
      kind: "formula",
      expression: "$fd_353dcf33199452$*$fd_353dcf34336cb2$",
      displayExpression: "$数量$*$金额(含税)$",
      fieldIds: ["fd_353dcf33199452", "fd_353dcf34336cb2"]
    });
    assert.deepEqual(aggregate?.props.calculation, {
      kind: "aggregate",
      operation: "sum",
      tableId: detail.id,
      fieldId: rowTotal.id
    });

    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-09-01T00:00:00.000Z"
    });
    const result = persistAndVerify(trusted);

    assert.equal(result.readback.ok, true, JSON.stringify(result.readback.diagnostics));
    assert.deepEqual(result.readback.form.calculationOrder, [
      `${detail.id}.${rowTotal.id}`,
      aggregate.id
    ]);
  });
});
