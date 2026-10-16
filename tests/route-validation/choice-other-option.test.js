import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/choice-other-option/route-choice-other-option_SysFormTemplate.xml";
const paired = ["single_num", "multi_num", "multi_attach", "single_caption", "multi_caption"];

describe("source independent choices/text with mixed unsupported detail and reserved cases", () => {
  it("blocks the mixed source before provider/transport rather than claiming a complete migration", async () => {
    const result = await runRouteCase("choice-other-mixed-unproven-blocked-before-transport");
    assert.equal(result.review.stage, "agent-review.input");
    assert.equal(result.execution, undefined);
    assert.deepEqual(result.transcript, []);
  });
  it("preserves numbered source labels/codes and independent main text identities", () => {
    const source = cleanSourceFile(fixture), draft = draftSourceDraft(source), fields = new Map(draft.form.fields.map(field => [field.id, field]));
    for (const id of paired) {
      const original = source.form.controls.find(field => field.id === `fd_${id}`), choice = fields.get(`fd_${id}`);
      assert.equal(choice.componentId, id.startsWith("single") ? "xform-radio" : "xform-checkbox");
      assert.deepEqual(choice.props.options, original.options, id);
      assert.equal(choice.props.options.some(option => option.type === "other"), false);
      const text = fields.get(`fd_${id}_other`);
      assert.notEqual(text.dataOnly, true, id);
      assert.equal(text.props.required, true, "The fixture's original textbox is unconditionally required");
      assert.equal(JSON.stringify(draft.form.layout.mkTree).includes(`"${text.id}"`), true);
    }
    for (const id of ["plain_other", "unrelated"]) assert.equal(fields.get(`fd_${id}`).props.options.some(option => option.type === "other"), false);
    assert.notEqual(fields.get("fd_unrelated_other").dataOnly, true);
  });
  it("preserves explicit companion requirements and main caption locations without inventing conditional validation", () => {
    const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
    for (const id of paired) {
      const text = draft.form.fields.find(field => field.id === `fd_${id}_other`);
      assert.equal(text.props.required, true);
      assert.notEqual(text.dataOnly, true);
    }
    for (const originalId of ["label_single_caption_other", "label_multi_caption_other"]) {
      const caption = draft.form.fields.find(field => field.id === originalId || field.sourceProps?.originalId === originalId);
      assert.ok(caption);
      assert.notEqual(caption.dataOnly, true);
      assert.equal(JSON.stringify(draft.form.layout.mkTree).includes(`"${caption.id}"`), true);
    }
    assert.equal(draft.scripts?.actions?.length || 0, 0);
  });
  it("keeps detail source fields and codes but rejects the unproven compound column", () => {
    const source = cleanSourceFile(fixture), draft = draftSourceDraft(source), table = draft.form.fields.find(field => field.id === "fd_rows");
    const choice = table.columns.find(field => field.id === "fd_detail_choice"), text = table.columns.find(field => field.id === "fd_detail_other");
    assert.equal(choice.componentId, "xform-radio");
    assert.deepEqual(choice.props.options, source.form.detailTables[0].columns.find(field => field.id === "fd_detail_choice").options);
    assert.notEqual(text.dataOnly, true);
    assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "source.form.choice_other_detail_layout_unproven"));
  });
  it("preserves a colliding original other_ code and marks the native branch unverified", () => {
    const draft = draftSourceDraft(cleanSourceFile(fixture)), choice = draft.form.fields.find(field => field.id === "fd_reserved");
    assert.deepEqual(choice.props.options.map(option => option.value), ["normal", "other_"]);
    assert.ok(choice.props.options.every(option => option.type !== "other"));
    assert.equal(checkDraft(draft).ok, false);
    assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "source.form.choice_other_reserved_value_unproven"));
  });
});
