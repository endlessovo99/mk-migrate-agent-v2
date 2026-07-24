import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

const fixturePath = "tests/fixtures/source/149c6e78f7c015f4c7da952411fa0cef";
const reportTimeFieldId = "fd_appr_time";
const reportTimePattern = "yyyy-MM-dd hh:mm";

describe("date-time current default Route case", () => {
  it("persists the report time current-time default and output format", () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const sourceField = sourceDraft.form.controls.find((field) => field.id === reportTimeFieldId);
    assert.equal(sourceField.sourceProps.designerValues.defaultValue, "nowTime");
    assert.equal(
      sourceField.sourceProps.metadataAttributes.defaultValue,
      "DateTimeFunction.getNow()"
    );

    const dsl = draftSourceDraft(sourceDraft);
    delete dsl.workflow;
    const dslField = dsl.form.fields.find((field) => field.id === reportTimeFieldId);
    assert.deepEqual(dslField.props, {
      defaultValue: { kind: "currentTime" },
      displayPattern: reportTimePattern
    });
    assert.equal(
      checkDraft(dsl).diagnostics.some((diagnostic) => diagnostic.level === "error"),
      false
    );

    const prepared = prepareSample(dsl);
    const config = JSON.parse(prepared.update.mechanisms["sys-xform"].fdConfig);
    const fields = config.dataModel.flatMap((model) => model.fdFields || []);
    const nativeField = fields.find((field) => field.fdName === reportTimeFieldId);
    const controlProps = JSON.parse(nativeField.fdAttribute).config.controlProps;
    const fontExtendData = JSON.parse(nativeField.fdFontExtendData);

    assert.equal(controlProps.defaultValueType, "now");
    assert.equal(controlProps.dataPattern, "yyyy-MM-dd HH/mm");
    assert.equal(controlProps.displayPattern, "yyyy年MM月DD日 HH点mm分");
    assert.equal(
      controlProps.$$init,
      'function(e){var t=(e||{}).controlProps||{},r=t.defaultValueType,n=t.value;if("now"===r&&void 0===n){var o=(new Date).valueOf();return e.controlProps.value=o,o}}'
    );
    assert.deepEqual(fontExtendData, {
      passValue: false,
      trace: false,
      dataPattern: "yyyy-MM-dd HH/mm",
      defaultValueType: "now",
      recalculate: false,
      displayPattern: "yyyy年MM月DD日 HH点mm分"
    });

    const readback = prepared.verify(prepared.update);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics, null, 2));

    delete controlProps.defaultValueType;
    delete controlProps.dataPattern;
    nativeField.fdAttribute = JSON.stringify({
      ...JSON.parse(nativeField.fdAttribute),
      config: {
        ...JSON.parse(nativeField.fdAttribute).config,
        controlProps
      }
    });
    const lossyReadback = structuredClone(prepared.update);
    lossyReadback.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    const failedReadback = prepared.verify(lossyReadback);
    assert.equal(failedReadback.ok, false);
    assert.deepEqual(
      failedReadback.diagnostics.map((diagnostic) => diagnostic.invariantKey).sort(),
      [
        "form.fields.fd_appr_time.props.defaultValue",
        "form.fields.fd_appr_time.props.displayPattern"
      ]
    );
  });
});
