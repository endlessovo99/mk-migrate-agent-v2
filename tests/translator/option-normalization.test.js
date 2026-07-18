import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixture =
  "tests/fixtures/route-validation/option-normalization/route-option-normalization_SysFormTemplate.xml";

describe("target option normalization", () => {
  it("preserves duplicate source facts but emits unique target values", () => {
    const source = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(source);
    const sourceColumn = source.form.detailTables[0].columns.find((column) =>
      column.id === "fd_location"
    );
    const targetColumn = dsl.form.fields
      .find((field) => field.id === "fd_items")
      .columns.find((column) => column.id === "fd_location");

    assert.deepEqual(sourceColumn.options, [
      { label: "North", value: "N" },
      { label: "South", value: "S" },
      { label: "North", value: "N" }
    ]);
    assert.deepEqual(targetColumn.props.options, [
      { label: "North", value: "N" },
      { label: "South", value: "S" }
    ]);
  });

  it("keeps an adjacent styled hint and required one-option radio as two source-backed controls", () => {
    const source = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(source);
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const row = dsl.form.layout.mkTree.find((candidate) =>
      candidate.children.some((cell) => cell.refIds.includes("confirm_hint"))
    );

    assert.equal(fields.get("confirm_hint")?.componentId, "xform-description");
    assert.deepEqual(fields.get("confirm_hint")?.props, {
      content: "Confirm the related detail value",
      style: { color: "rgba(255,0,0,1)" }
    });
    assert.equal(fields.get("fd_confirm")?.componentId, "xform-radio");
    assert.deepEqual(fields.get("fd_confirm")?.props, {
      required: true,
      options: [{ label: "Confirm", value: "confirmed" }]
    });
    assert.deepEqual(row?.children.map((cell) => cell.refIds), [
      ["confirm_hint"],
      ["fd_confirm"]
    ]);
  });
});
