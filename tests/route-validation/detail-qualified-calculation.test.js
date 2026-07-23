import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { draftSourceDraft, cleanSourceFile } from "../../src/translator/index.js";

const fixturePath = "tests/fixtures/source/18aac2e235a65c382f6fe264e1dba521";

describe("invoice detail qualified calculations", () => {
  it("maps 计算单价 and 计算总价 formulas from detailList-qualified expression_id", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixturePath));
    const table = dsl.form.fields.find((field) => field.id === "detailList");
    const columns = new Map((table?.columns || []).map((column) => [column.id, column]));

    assert.equal(columns.get("dj")?.componentId, "xform-calculate");
    assert.deepEqual(columns.get("dj")?.props.calculation, {
      kind: "formula",
      expression: "$je$ / $spsl$",
      displayExpression: "$金额$ / $数量$",
      fieldIds: ["je", "spsl"]
    });

    assert.equal(columns.get("fd_3c538ec2aab886")?.componentId, "xform-calculate");
    assert.deepEqual(columns.get("fd_3c538ec2aab886")?.props.calculation, {
      kind: "formula",
      expression: "$spsl$ * $dj$",
      displayExpression: "$数量$ * $计算单价$",
      fieldIds: ["spsl", "dj"]
    });

    // 金额 remains a normal editable number in the source, not a calculation control.
    assert.equal(columns.get("je")?.componentId, "xform-number");
    assert.equal(columns.get("je")?.props.calculation, undefined);
  });
});
