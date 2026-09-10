import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixture =
  "tests/fixtures/route-validation/creator-employee-number-default/route-creator-employee-number-default_SysFormTemplate.xml";
const expectedDefault = { kind: "context", source: "creator", property: "fdNo" };
const fieldIds = ["fd_employee_no", "fd_employee_no_getter"];

describe("creator employee-number context default Route case", () => {
  it("maps $docCreator$.fdNo and getFdNo() source defaults onto the creator employee number", () => {
    const source = cleanSourceFile(fixture);
    const sourceFields = new Map(source.form.controls.map((field) => [field.id, field]));

    assert.equal(
      sourceFields.get("fd_employee_no")?.sourceProps?.metadataAttributes?.defaultValue,
      "$docCreator$.fdNo"
    );
    assert.equal(
      sourceFields.get("fd_employee_no")?.sourceProps?.designerValues?.defaultValue,
      "$申请人$.fdNo"
    );
    assert.equal(
      sourceFields.get("fd_employee_no_getter")?.sourceProps?.metadataAttributes?.defaultValue,
      "$docCreator$.getFdNo()"
    );

    const dsl = draftSourceDraft(source);
    for (const fieldId of fieldIds) {
      assert.deepEqual(
        dsl.form.fields.find((field) => field.id === fieldId)?.props?.defaultValue,
        expectedDefault,
        fieldId
      );
    }
    assert.equal(
      checkDraft(dsl).ok,
      true,
      JSON.stringify(checkDraft(dsl).diagnostics)
    );

    const prepared = prepareSample(dsl);
    const main = xformConfig(prepared.update).dataModel.find((model) => model.fdType === "main");
    for (const fieldId of fieldIds) {
      const nativeField = main.fdFields.find((field) => field.fdName === fieldId);
      const controlProps = JSON.parse(nativeField.fdAttribute).config.controlProps;
      assert.equal(controlProps.defaultValueType, "formula", fieldId);
      assert.equal(controlProps.defaultValueFormulaVO?.script, "${data.biz.fdCreator.fdNo}", fieldId);
      assert.deepEqual(controlProps.defaultValueFormulaVO?.varIds, ["fdCreator.fdNo"], fieldId);
      assert.match(controlProps.defaultValueFormulaVO?.vo?.content || "", /\.创建人\.工号\$/, fieldId);
    }

    const readback = prepared.verify(structuredClone(prepared.update));
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    for (const fieldId of fieldIds) {
      assert.deepEqual(
        readback.form.fields.find((field) => field.id === fieldId)?.defaultValue,
        expectedDefault,
        fieldId
      );
    }

    const broken = structuredClone(prepared.update);
    const brokenConfig = xformConfig(broken);
    const brokenMain = brokenConfig.dataModel.find((model) => model.fdType === "main");
    const brokenField = brokenMain.fdFields.find((field) => field.fdName === "fd_employee_no");
    const brokenAttribute = JSON.parse(brokenField.fdAttribute);
    delete brokenAttribute.config.controlProps.defaultValueFormulaVO;
    brokenField.fdAttribute = JSON.stringify(brokenAttribute);
    const brokenFont = JSON.parse(brokenField.fdFontExtendData);
    delete brokenFont.defaultValueFormulaVO;
    brokenField.fdFontExtendData = JSON.stringify(brokenFont);
    broken.mechanisms["sys-xform"].fdConfig = JSON.stringify(brokenConfig);
    const mismatch = prepared.verify(broken);
    assert.equal(mismatch.ok, false);
    assert.equal(
      mismatch.diagnostics.some((diagnostic) =>
        diagnostic.invariantKey === "form.fields.fd_employee_no.props.defaultValue"
      ),
      true
    );
  });
});
