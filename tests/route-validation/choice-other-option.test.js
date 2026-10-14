import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/choice-other-option/route-choice-other-option_SysFormTemplate.xml";
const folded = ["single_num", "multi_num", "multi_attach", "single_caption", "multi_caption"];

describe("single and multiple choice native other Route-validation", () => {
  it("executes the complete source/review/trust/fake-write/readback route", async () => {
    const result = await runRouteCase("choice-other-option-success");
    assert.equal(result.execution.readback.ok, true);
  });
  it("replaces numbered other choices and folds source-backed companions without duplicate choices", () => {
    const source = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(source);
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    for (const id of folded) {
      const choice = fields.get(`fd_${id}`);
      assert.equal(choice.componentId, id.startsWith("single") ? "xform-radio" : "xform-checkbox");
      assert.deepEqual(choice.props.options, [
        { label: "正常", value: "normal" },
        { label: "其他", value: "other_", type: "other", isRequired: true }
      ], id);
      const companion = fields.get(`fd_${id}_other`);
      assert.equal(companion.dataOnly, true, id);
      assert.equal(companion.props.required, undefined, id);
      assert.equal(JSON.stringify(dsl.form.layout.mkTree).includes(`"fd_${id}_other"`), false, id);
    }
    for (const id of ["plain_other", "unrelated"]) {
      assert.equal(fields.get(`fd_${id}`).props.options.some((option) => option.type === "other"), false);
    }
    assert.notEqual(fields.get("fd_unrelated_other").dataOnly, true);
    assert.equal(checkDraft(dsl).ok, true);
  });

  it("persists conditional native-other requiredness for radio and checkbox and verifies readback", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const prepared = prepareSample(dsl);
    const model = xformConfig(prepared.update).dataModel.find((entry) => entry.fdType === "main");
    for (const id of folded) {
      const choice = model.fdFields.find((field) => field.fdName === `fd_${id}`);
      const props = JSON.parse(choice.fdAttribute).config.controlProps;
      assert.deepEqual(props.options.at(-1), {
        label: "其他", value: "other_", type: "other", colorSwitch: false, isRequired: true
      });
      const companion = model.fdFields.find((field) => field.fdName === `fd_${id}_other`);
      assert.equal(companion.fdIsStored, true);
      assert.equal(companion.fdDisplay, false);
    }
    assert.equal(prepared.verify(prepared.update).ok, true);
    const mutated = structuredClone(prepared.update);
    const config = xformConfig(mutated);
    const radio = config.dataModel.find((entry) => entry.fdType === "main")
      .fdFields.find((field) => field.fdName === "fd_single_num");
    const attr = JSON.parse(radio.fdAttribute);
    attr.config.controlProps.options.at(-1).isRequired = false;
    radio.fdAttribute = JSON.stringify(attr);
    mutated.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    assert.equal(prepared.verify(mutated).ok, false);
  });

  it("folds a numbered single-choice companion inside detail rows", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const detail = dsl.form.fields.find((field) => field.id === "fd_rows");
    const choice = detail.columns.find((field) => field.id === "fd_detail_choice");
    assert.equal(choice.componentId, "xform-radio");
    assert.deepEqual(choice.props.options.at(-1), {
      label: "其他", value: "other_", type: "other", isRequired: true
    });
    assert.equal(detail.columns.find((field) => field.id === "fd_detail_other").dataOnly, true);
    const prepared = prepareSample(dsl);
    const model = xformConfig(prepared.update).dataModel.find((entry) => entry.fdType === "detail");
    assert.equal(model.fdFields.find((field) => field.fdName === "fd_detail_other").fdDisplay, false);
    assert.equal(prepared.verify(prepared.update).ok, true);
  });

  it("converts a source other_ value into a typed required option", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const choice = dsl.form.fields.find((field) => field.id === "fd_reserved");
    assert.deepEqual(choice.props.options.at(-1), {
      label: "其他", value: "other_", type: "other", isRequired: true
    });
    assert.equal(choice.props.options.length, 2);
  });
});
