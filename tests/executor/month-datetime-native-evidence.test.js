import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/executor/persistence");
const nativeEvidence = JSON.parse(
  readFileSync(join(fixtureDir, "month-datetime-native-evidence.json"), "utf8")
);

describe("independent native month-only datetime evidence", () => {
  it("does not add month dataPattern semantics to other date-time fields", () => {
    const dsl = sampleTrustedDsl({ workflow: null });
    delete dsl.workflow;
    const field = dsl.form.fields.find((candidate) => candidate.id === nativeEvidence.fieldId);
    field.type = "dateTime";
    field.componentId = "xform-datetime";
    field.props = {};

    const native = nativeMonthField(prepareSample(dsl).update);
    assert.equal(native.controlProps.dataPattern, undefined);
    assert.equal(native.fontExtendData.dataPattern, undefined);
  });

  it("writes and restores the mirrored yyyy-MM data and display patterns", () => {
    const prepared = prepareSample(monthDsl());
    const written = nativeMonthField(prepared.update);

    assert.equal(written.controlProps.dataPattern, nativeEvidence.dataPattern);
    assert.equal(written.controlProps.displayPattern, nativeEvidence.displayPattern);
    assert.equal(written.fontExtendData.dataPattern, nativeEvidence.dataPattern);
    assert.equal(written.fontExtendData.displayPattern, nativeEvidence.displayPattern);

    const readback = prepared.verify(independentNativeReadback());
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    const observed = readback.form.fields.find((field) => field.id === nativeEvidence.fieldId);
    assert.equal(observed.dataPattern, nativeEvidence.dataPattern);
    assert.equal(observed.displayPattern, nativeEvidence.displayPattern);
  });

  for (const testCase of [
    {
      name: "control dataPattern",
      prop: "dataPattern",
      mutate({ controlProps }) { controlProps.dataPattern = "yyyy-MM-dd"; }
    },
    {
      name: "font dataPattern mirror",
      prop: "dataPattern",
      mutate({ fontExtendData }) { fontExtendData.dataPattern = "yyyy-MM-dd"; }
    },
    {
      name: "control displayPattern",
      prop: "displayPattern",
      mutate({ controlProps }) { controlProps.displayPattern = "yyyy/MM"; }
    },
    {
      name: "font displayPattern mirror",
      prop: "displayPattern",
      mutate({ fontExtendData }) { fontExtendData.displayPattern = "yyyy/MM"; }
    }
  ]) {
    it(`rejects changed ${testCase.name}`, () => {
      const template = independentNativeReadback();
      const native = nativeMonthField(template);
      testCase.mutate(native);
      native.commit();

      const readback = prepareSample(monthDsl()).verify(template);
      assert.equal(readback.ok, false);
      assert.equal(readback.diagnostics.some((diagnostic) => (
        diagnostic.code === `readback.form.prop_${testCase.prop}_mismatch` &&
        diagnostic.details?.fieldId === nativeEvidence.fieldId
      )), true, JSON.stringify(readback.diagnostics));
    });
  }
});

function monthDsl() {
  const dsl = sampleTrustedDsl({ workflow: null });
  delete dsl.workflow;
  const field = dsl.form.fields.find((candidate) => candidate.id === nativeEvidence.fieldId);
  field.title = "所属年月";
  field.type = "dateTime";
  field.componentId = "xform-datetime";
  field.props = {
    dataPattern: nativeEvidence.dataPattern,
    displayPattern: nativeEvidence.displayPattern
  };
  return dsl;
}

function independentNativeReadback() {
  const template = JSON.parse(
    readFileSync(join(fixtureDir, "form-only-native-readback.json"), "utf8")
  );
  const config = xformConfig(template);
  const formAttr = JSON.parse(config.attribute.formAttr);
  formAttr.subjectRule = {};
  config.attribute.formAttr = JSON.stringify(formAttr);

  const field = config.dataModel.find((model) => model.fdType === "main")
    .fdFields.find((candidate) => candidate.fdName === nativeEvidence.fieldId);
  const attribute = JSON.parse(field.fdAttribute);
  field.fdLabel = "所属年月";
  field.fdType = "timestamp";
  field.fdDataType = "timestamp";
  field.fdDictType = "dateDict";
  attribute.config.type = "@elem/xform-datetime";
  attribute.config.label = "所属年月";
  attribute.config.controlProps.title = "所属年月";
  attribute.config.controlProps.desktop.type = "@elem/xform-datetime";
  attribute.config.controlProps.mobile.type = "@elem/xform-m-datetime";
  attribute.config.controlProps.dataPattern = nativeEvidence.dataPattern;
  attribute.config.controlProps.displayPattern = nativeEvidence.displayPattern;
  field.fdAttribute = JSON.stringify(attribute);
  field.fdFontExtendData = JSON.stringify({
    dataPattern: nativeEvidence.dataPattern,
    displayPattern: nativeEvidence.displayPattern
  });
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  return template;
}

function nativeMonthField(template) {
  const config = xformConfig(template);
  const field = config.dataModel.find((model) => model.fdType === "main")
    .fdFields.find((candidate) => candidate.fdName === nativeEvidence.fieldId);
  const attribute = JSON.parse(field.fdAttribute);
  const controlProps = attribute.config.controlProps;
  const fontExtendData = JSON.parse(field.fdFontExtendData || "{}");
  return {
    controlProps,
    fontExtendData,
    commit() {
      attribute.config.controlProps = controlProps;
      field.fdAttribute = JSON.stringify(attribute);
      field.fdFontExtendData = JSON.stringify(fontExtendData);
      template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    }
  };
}
