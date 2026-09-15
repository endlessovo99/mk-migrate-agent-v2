import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile } from "../../src/translator/source-draft.js";

const fixture = "tests/fixtures/translator/content-flow/content-flow_SysFormTemplate.xml";

describe("source cell content flow", () => {
  it("preserves mixed controls, explicit breaks and measured widths without target decisions", () => {
    const source = cleanSourceFile(fixture);
    const cell = source.form.layout.rows[0].cells[0];

    assert.deepEqual(cell.contentFlow, {
      lines: [
        ["lead", "fd_start", "middle", "fd_end", "tail"],
        ["fd_code", "suffix"],
        [],
        ["note", "fd_last", "after"]
      ],
      items: [
        { referenceId: "lead" },
        { referenceId: "fd_start", width: { value: 120, unit: "px" } },
        { referenceId: "middle" },
        { referenceId: "fd_end", width: { value: 40, unit: "%" } },
        { referenceId: "tail" },
        { referenceId: "fd_code", width: { value: 80, unit: "px" } },
        { referenceId: "suffix" },
        { referenceId: "note" },
        { referenceId: "fd_last", width: { value: 75.5, unit: "px" } },
        { referenceId: "after" }
      ]
    });
    // The fixture also contains editor-internal BR, raw script markup and JSP
    // markup. None creates a line between source controls.
    assert.equal(cell.contentFlow.lines.length, 4);
    assert.equal(cell.widthWeight, 600);
    assertFlowReferences(cell);
  });

  it("excludes folded captions and hidden controls while retaining explicit line boundaries", () => {
    const source = cleanSourceFile(fixture);
    const cell = source.form.layout.rows[1].cells[0];

    assert.deepEqual(cell.contentFlow.lines, [["fd_name"], [], ["fd_remaining"]]);
    assert.deepEqual(cell.contentFlow.items, [
      { referenceId: "fd_name" },
      { referenceId: "fd_remaining" }
    ]);
    assertFlowReferences(cell);
  });

  it("keeps numeric unit entities and their source relationships for both input and calculation controls", () => {
    const source = cleanSourceFile(fixture);
    const fields = new Map(source.form.controls.map((field) => [field.id, field]));
    const cell = source.form.layout.rows[2].cells[0];

    for (const [fieldId, unitId, content] of [
      ["fd_amount", "amount_unit", "元"],
      ["fd_total", "total_unit", "天"]
    ]) {
      assert.equal(fields.get(unitId)?.sourceType, "description");
      assert.equal(fields.get(unitId)?.title, content);
      assert.deepEqual(fields.get(fieldId)?.sourceProps.inlineUnit, {
        id: unitId,
        content,
        relation: "immediately-adjacent-plain-text-in-same-cell"
      });
    }
    assert.deepEqual(cell.contentFlow.lines, [
      ["fd_amount", "amount_unit"],
      ["fd_total", "total_unit"]
    ]);
    assertFlowReferences(cell);
  });

  it("does not fold duplicate captions across BR while ignoring an editor-internal BR", () => {
    const source = cleanSourceFile(fixture);
    assert.deepEqual(source.form.layout.rows[3].cells[0].contentFlow.lines, [
      ["fd_repeated"], ["repeated_caption"]
    ]);
    assert.deepEqual(source.form.layout.rows[4].cells[0].contentFlow.lines, [["fd_internal"]]);
    assertFlowReferences(source.form.layout.rows[3].cells[0]);
    assertFlowReferences(source.form.layout.rows[4].cells[0]);
  });

  it("removes metadata-only fields from flow and never attaches a unit across BR", () => {
    const source = cleanSourceFile(fixture);
    const cell = source.form.layout.rows[5].cells[0];
    assert.equal(source.form.dataFields.find((field) => field.id === "fd_data_only")?.dataOnly, true);
    assert.deepEqual(cell.contentFlow.lines, [[], ["fd_metric"], ["metric_unit"]]);
    assert.equal(source.form.controls.find((field) => field.id === "fd_metric")?.sourceProps.inlineUnit, undefined);
    assertFlowReferences(cell);
  });

  it("treats presentation and rights wrappers as transparent while isolating nested tables", () => {
    const source = cleanSourceFile(fixture);
    const cell = source.form.layout.rows[6].cells[0];
    assert.deepEqual(cell.contentFlow.lines, [
      ["wrapped_caption", "fd_wrapped_a"],
      ["fd_wrapped_b"],
      ["wrapped_note", "fd_wrapped_tail"]
    ]);
    const widths = Object.fromEntries(cell.contentFlow.items.map((item) => [item.referenceId, item.width]));
    assert.deepEqual(widths.fd_wrapped_a, { value: 100, unit: "px" });
    assert.deepEqual(widths.fd_wrapped_b, { value: 50, unit: "%" });
    assert.deepEqual(widths.fd_wrapped_tail, { value: 0, unit: "px" });
    assertFlowReferences(cell);
  });
});

function assertFlowReferences(cell) {
  const references = cell.references.map((reference) => reference.referenceId);
  assert.deepEqual(cell.contentFlow.lines.flat(), references);
  assert.deepEqual(cell.contentFlow.items.map((item) => item.referenceId), references);
  assert.equal(new Set(references).size, references.length);
}
