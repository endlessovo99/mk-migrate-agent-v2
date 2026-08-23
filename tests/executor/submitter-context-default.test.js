import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

describe("submitter text context defaults", () => {
  it("persists and reads back submitter and submitter-department names", () => {
    const dsl = sampleTrustedDsl({ workflow: null });
    delete dsl.workflow;
    const [submitter, submitterDept] = dsl.form.fields;
    submitter.title = "提交者姓名";
    submitter.props = {
      defaultValue: { kind: "context", source: "submitter", property: "fdName" }
    };
    submitterDept.title = "提交者部门名称";
    submitterDept.props = {
      defaultValue: { kind: "context", source: "submitterDept", property: "fdName" }
    };

    const prepared = prepareSample(dsl);
    const fields = new Map(
      xformConfig(prepared.update).dataModel
        .find((model) => model.fdType === "main")
        .fdFields
        .map((field) => [field.fdName, JSON.parse(field.fdAttribute).config.controlProps])
    );

    assert.equal(
      fields.get(submitter.id)?.defaultValueFormulaVO?.script,
      "${data._ProcessCreator.fdName}"
    );
    assert.equal(
      fields.get(submitterDept.id)?.defaultValueFormulaVO?.script,
      "${data._ProcessCreator.parent.fdName}"
    );

    const readback = prepared.verify(structuredClone(prepared.update));
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.deepEqual(
      readback.form.fields.find((field) => field.id === submitter.id)?.defaultValue,
      submitter.props.defaultValue
    );
    assert.deepEqual(
      readback.form.fields.find((field) => field.id === submitterDept.id)?.defaultValue,
      submitterDept.props.defaultValue
    );
  });
});
