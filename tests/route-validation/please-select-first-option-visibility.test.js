import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { observeNativeTemplate } from "../../src/executor/persistence/observer.js";
import { prepareSample, projectTemplate, xformConfig } from "../helpers/persistence.js";

const fixture =
  "tests/fixtures/route-validation/please-select-first-option-visibility/route-please-select-first-option-visibility_SysFormTemplate.xml";

describe("please-select first-option visibility Route case", () => {
  it("keeps reimbursement type empty so the first pick of 日常运营 shows the detail table", () => {
    const source = cleanSourceFile(fixture);
    const sourceType = source.form.controls.find((field) => field.id === "bxlx");
    assert.equal(sourceType?.sourceProps?.designerValues?.defaultValue, "");
    assert.equal(sourceType?.sourceProps?.designerPleaseSelect, true);
    assert.equal(sourceType?.sourceProps?.pleaseSelectLabel, "请选择");
    assert.deepEqual(
      sourceType?.options,
      [
        { label: "日常运营", value: "rcyy" },
        { label: "宣传活动", value: "xchd" }
      ]
    );

    const dsl = draftSourceDraft(source);
    const typeField = dsl.form.fields.find((field) => field.id === "bxlx");
    assert.equal(typeField?.componentId, "xform-select");
    assert.deepEqual(typeField?.props?.defaultValue, { kind: "literal", value: "" });
    assert.equal(typeField?.props?.placeholder, "请选择");
    assert.deepEqual(typeField?.props?.options, [
      { label: "日常运营", value: "rcyy" },
      { label: "宣传活动", value: "xchd" }
    ]);

    const visibility = dsl.formRules.linkage.find((rule) =>
      rule.id === "linkage.bxlx.contains.rcyy.load"
    );
    const required = dsl.formRules.linkage.find((rule) =>
      rule.id === "linkage.bxlx.contains.rcyy"
    );
    assert.deepEqual(visibility?.effects, [
      { type: "visible", target: "rcyy_row", value: true }
    ]);
    assert.deepEqual(visibility?.else, [
      { type: "visible", target: "rcyy_row", value: false }
    ]);
    assert.deepEqual(required?.effects, [
      { type: "required", target: "rcyy_row", value: true }
    ]);
    assert.deepEqual(required?.else, [
      { type: "required", target: "rcyy_row", value: false }
    ]);

    const onChange = dsl.scripts.actions.find((action) =>
      action.event === "onChange" && action.controlId === "bxlx"
    );
    assert.equal(onChange?.translationStatus, "mapped");
    assert.match(onChange?.function || "", /setValue\("fd_rcyy", "rcyy"\)/);
    assert.match(onChange?.function || "", /setFieldAttr\("rcyy_row", 5\)/);

    const check = checkDraft(dsl);
    assert.equal(
      check.diagnostics.some((diagnostic) => diagnostic.level === "error"),
      false,
      JSON.stringify(check.diagnostics)
    );

    const prepared = prepareSample(dsl);
    const config = xformConfig(prepared.update);
    const main = config.dataModel.find((model) => model.fdType === "main");
    const nativeField = main.fdFields.find((field) => field.fdName === "bxlx");
    const controlProps = JSON.parse(nativeField.fdAttribute).config.controlProps;
    assert.equal(controlProps.placeholder, "请选择");
    assert.equal(controlProps.defaultValueType, "empty");
    assert.equal(controlProps.defaultValue, "");
    assert.deepEqual(
      controlProps.options.map((option) => ({
        label: option.label,
        value: option.value,
        checked: option.checked
      })),
      [
        { label: "日常运营", value: "rcyy", checked: false },
        { label: "宣传活动", value: "xchd", checked: false }
      ]
    );

    const nativeRules = observeNativeTemplate(projectTemplate(dsl)).rules.value.rules;
    const displayWhen = nativeRules.find((rule) =>
      rule.kind === "display" &&
      rule.nativeIdentity?.sourceRuleId === "linkage.bxlx.contains.rcyy.load" &&
      rule.nativeIdentity?.branch === "when"
    );
    const displayElse = nativeRules.find((rule) =>
      rule.kind === "display" &&
      rule.nativeIdentity?.sourceRuleId === "linkage.bxlx.contains.rcyy.load" &&
      rule.nativeIdentity?.branch === "else"
    );
    assert.equal(
      displayWhen?.effects.some((effect) =>
        effect.target === "fd_rcyy_detail" && effect.visible === true
      ),
      true
    );
    assert.equal(displayElse?.logic, "or");
    assert.equal(
      displayElse?.conditions.some((condition) =>
        condition.field === "bxlx" && condition.op === "empty" && condition.value === ""
      ),
      true
    );
    assert.equal(
      displayElse?.effects.some((effect) =>
        effect.target === "fd_rcyy_detail" && effect.visible === false
      ),
      true
    );

    const formActions = JSON.parse(config.attribute.formAttr).controlAction.control;
    const action = formActions[`${config.dataModel[0].fdTableName}.bxlx`]?.onChange?.[0];
    assert.ok(action, "reimbursement type onChange must be persisted");
    const shown = { fd_rcyy: "" };
    const setFieldAttrCalls = [];
    const onChangeFn = new Function(
      "MKXFORM",
      `${action.function}; return ${action.name};`
    )({
      viewStatus: "add",
      getValue() {
        return "";
      },
      setValue(fieldId, value) {
        shown[fieldId] = value;
      },
      setFieldAttr(fieldId, attribute) {
        setFieldAttrCalls.push([fieldId, attribute]);
      }
    });
    onChangeFn("rcyy");
    assert.equal(shown.fd_rcyy, "rcyy");
    assert.equal(
      setFieldAttrCalls.some(([fieldId, attribute]) =>
        fieldId === "fd_rcyy_detail" && attribute === 5
      ),
      true,
      JSON.stringify(setFieldAttrCalls)
    );
    assert.equal(
      setFieldAttrCalls.some(([fieldId]) => fieldId === "rcyy_row"),
      false,
      "persisted onChange must compile the layout marker to the detail table id"
    );

    const readback = prepared.verify(structuredClone(prepared.update));
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.deepEqual(
      readback.form.fields.find((field) => field.id === "bxlx")?.defaultValue,
      { kind: "literal", value: "" }
    );
    assert.equal(
      readback.form.fields.find((field) => field.id === "bxlx")?.placeholder,
      "请选择"
    );
  });
});
