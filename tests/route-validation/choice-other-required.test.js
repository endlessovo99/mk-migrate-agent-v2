import assert from "node:assert/strict";
import { it } from "node:test";
import vm from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { prepareSample, formAttr, xformConfig } from "../helpers/persistence.js";
import { nativeRequiredRuntime } from "../helpers/native-required-runtime.js";

const fixture = "tests/fixtures/route-validation/choice-other-required/choice-other-required_SysFormTemplate.xml";

it("allows only a normal qualification after repeated row-required changes without requiring auxiliary Other", () => {
  const draft = draftSourceDraft(cleanSourceFile(fixture));
  assert.equal(checkDraft(draft).ok, true);
  assert.equal(draft.form.fields.find(field => field.id === "fd_other_caption").componentId, "xform-checkbox");
  const prepared = prepareSample(draft), config = xformConfig(prepared.update);
  const main = config.dataModel.find(model => model.fdType === "main").fdTableName;
  const action = formAttr(prepared.update).controlAction.control[`${main}.fd_mode`].onChange[0];

  for (const scene of ["add", "edit"]) {
    const runtime = nativeRequiredRuntime(structuredClone(config), scene);
    runtime.MKXFORM.setValue("fd_choice", ["A"]);
    runtime.MKXFORM.setValue("fd_other_caption", []);
    runtime.MKXFORM.setValue("fd_other_text", "");
    const change = vm.runInNewContext(`(${action.function})`, { MKXFORM: runtime.MKXFORM });
    for (const value of ["YES", "NO", "YES"]) {
      change(value);
      assert.equal(runtime.required("fd_choice"), value === "YES", "The original business checkbox retains its source requirement");
      assert.equal(runtime.required("fd_other_caption"), false, "A generated Other toggle must not make an optional selection mandatory");
      assert.equal(runtime.required("fd_other_text"), false);
      assert.equal(runtime.required("fd_choice_title"), false);
      assert.deepEqual(runtime.MKXFORM.getValue("fd_choice"), ["A"]);
      assert.deepEqual(runtime.MKXFORM.getValue("fd_other_caption"), []);
      assert.equal(runtime.MKXFORM.getValue("fd_other_text"), "");
    }
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("preserves a real source Other option code and the original required checkbox", () => {
  const draft = draftSourceDraft(cleanSourceFile("tests/fixtures/route-validation/choice-other-companion-fidelity/main-checkbox-existing_SysFormTemplate.xml"));
  const choice = draft.form.fields.find(field => field.id === "fd_choice");
  assert.deepEqual(choice.props.options.map(option => option.value), ["A", "O_CODE"]);
  assert.equal(choice.props.required, true);
  assert.equal(draft.form.fields.find(field => field.id === "fd_other_caption").dataOnly, true);
  const prepared = prepareSample(draft), config = xformConfig(prepared.update);
  for (const scene of ["add", "edit"]) {
    const runtime = nativeRequiredRuntime(structuredClone(config), scene);
    for (const selected of [["A"], ["O_CODE"], ["A", "O_CODE"]]) {
      runtime.MKXFORM.setValue("fd_choice", selected);
      assert.equal(runtime.required("fd_choice"), true);
      assert.deepEqual(runtime.MKXFORM.getValue("fd_choice"), selected);
      assert.equal(runtime.required("fd_other_text"), false);
    }
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
});
