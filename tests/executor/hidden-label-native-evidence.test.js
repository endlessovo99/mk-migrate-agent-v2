import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { checkExecute } from "../../src/dsl/checks.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/executor/persistence");
const fieldId = "fd_subject";

describe("xform-input hidden-label native persistence", () => {
  it("writes every native desktop/mobile control and label flag", () => {
    const prepared = prepareSample(hiddenLabelDsl());
    const attribute = nativeAttribute(prepared.update, fieldId);

    assert.deepEqual(hiddenLabelEvidence(attribute), {
      controlDesktop: true,
      controlMobile: true,
      controlShowText: false,
      labelDesktop: true,
      labelMobile: true,
      labelShowText: false
    });
  });

  it("does not hide an ordinary input when the DSL omits hiddenLabel", () => {
    const dsl = sampleTrustedDsl({ workflow: null });
    delete dsl.workflow;
    const prepared = prepareSample(dsl);
    const attribute = nativeAttribute(prepared.update, fieldId);

    assert.deepEqual(hiddenLabelEvidence(attribute), {
      controlDesktop: undefined,
      controlMobile: undefined,
      controlShowText: undefined,
      labelDesktop: undefined,
      labelMobile: undefined,
      labelShowText: undefined
    });
  });

  it("writes the shared hidden-label contract for a textarea", () => {
    const dsl = hiddenLabelDsl();
    const field = dsl.form.fields.find((candidate) => candidate.id === fieldId);
    field.type = "longText";
    field.componentId = "xform-textarea";
    const prepared = prepareSample(dsl);
    const attribute = nativeAttribute(prepared.update, fieldId);

    assert.equal(attribute.config.controlProps.desktop.type, "@elem/xform-textarea");
    assert.deepEqual(hiddenLabelEvidence(attribute), {
      controlDesktop: true,
      controlMobile: true,
      controlShowText: false,
      labelDesktop: true,
      labelMobile: true,
      labelShowText: false
    });
    assert.equal(prepared.verify(structuredClone(prepared.update)).ok, true);
  });

  it("writes and verifies the common native label contract for rich text", () => {
    const dsl = hiddenLabelDsl();
    const field = dsl.form.fields.find((candidate) => candidate.id === fieldId);
    field.type = "longText";
    field.componentId = "xform-rich-text";
    assert.equal(checkExecute(dsl).ok, true);
    const prepared = prepareSample(dsl);
    const attribute = nativeAttribute(prepared.update, fieldId);
    assert.equal(attribute.config.controlProps.desktop.type, "@elem/xform-rich-text");
    assert.deepEqual(hiddenLabelEvidence(attribute), {
      controlDesktop: true, controlMobile: true, controlShowText: false,
      labelDesktop: true, labelMobile: true, labelShowText: false
    });
    assert.equal(prepared.verify(prepared.update).form.fields.find((item) => item.id === fieldId)?.hiddenLabel, true);
    const corrupt = structuredClone(prepared.update);
    mutateNativeAttribute(corrupt, fieldId, (value) => { delete value.config.labelProps.desktop.hiddenLabel; });
    assert.equal(prepared.verify(corrupt).partitions.form, "mismatch");
  });

  for (const testCase of [
    {
      name: "radio",
      type: "radio",
      componentId: "xform-radio",
      desktopType: "@elem/xform-radio"
    },
    {
      name: "checkbox",
      type: "checkbox",
      componentId: "xform-checkbox",
      desktopType: "@elem/xform-checkbox"
    },
    {
      name: "single-select",
      type: "singleSelect",
      componentId: "xform-select",
      desktopType: "@elem/xform-select"
    },
    {
      name: "multi-select",
      type: "multiSelect",
      componentId: "xform-select~multi",
      desktopType: "@elem/xform-select"
    }
  ]) {
    it(`writes and reads back the shared hidden-label contract for ${testCase.name}`, () => {
      const dsl = hiddenLabelDslForOption(testCase);
      const prepared = prepareSample(dsl);
      const attribute = nativeAttribute(prepared.update, fieldId);

      assert.equal(attribute.config.controlProps.desktop.type, testCase.desktopType);
      assert.deepEqual(hiddenLabelEvidence(attribute), {
        controlDesktop: true,
        controlMobile: true,
        controlShowText: false,
        labelDesktop: true,
        labelMobile: true,
        labelShowText: false
      });
      assert.equal(prepared.verify(structuredClone(prepared.update)).ok, true);
    });
  }

  it("restores hiddenLabel only from complete independent native evidence", () => {
    const prepared = prepareSample(hiddenLabelDsl());
    const readback = prepared.verify(independentNativeReadback());

    assert.equal(readback.ok, true);
    assert.equal(
      readback.form.fields.find((field) => field.id === fieldId)?.hiddenLabel,
      true
    );
  });

  for (const testCase of [
    {
      name: "desktop control flag",
      mutate(attribute) {
        delete attribute.config.controlProps.desktop.hiddenLabel;
      }
    },
    {
      name: "mobile control flag",
      mutate(attribute) {
        delete attribute.config.controlProps.mobile.hiddenLabel;
      }
    },
    {
      name: "control showText flag",
      mutate(attribute) {
        attribute.config.controlProps.showText = true;
      }
    },
    {
      name: "desktop label flag",
      mutate(attribute) {
        delete attribute.config.labelProps.desktop.hiddenLabel;
      }
    },
    {
      name: "mobile label flag",
      mutate(attribute) {
        delete attribute.config.labelProps.mobile.hiddenLabel;
      }
    },
    {
      name: "label showText flag",
      mutate(attribute) {
        attribute.config.labelProps.showText = true;
      }
    }
  ]) {
    it(`rejects incomplete ${testCase.name} evidence`, () => {
      const prepared = prepareSample(hiddenLabelDsl());
      const template = independentNativeReadback();
      mutateNativeAttribute(template, fieldId, testCase.mutate);

      const readback = prepared.verify(template);

      assert.equal(readback.ok, false);
      assert.equal(
        readback.diagnostics.some((item) =>
          item.code === "readback.form.prop_hiddenLabel_mismatch" &&
          item.details?.fieldId === fieldId
        ),
        true
      );
    });
  }
});

function hiddenLabelDsl() {
  const dsl = sampleTrustedDsl({ workflow: null });
  delete dsl.workflow;
  dsl.form.fields.find((field) => field.id === fieldId).props.hiddenLabel = true;
  return dsl;
}

function hiddenLabelDslForOption({ type, componentId }) {
  const dsl = hiddenLabelDsl();
  const field = dsl.form.fields.find((candidate) => candidate.id === fieldId);
  field.type = type;
  field.componentId = componentId;
  field.props = {
    hiddenLabel: true,
    options: [{ label: "选项 A", value: "A" }]
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
  const mainModel = config.dataModel.find((model) => model.fdType === "main");
  const field = mainModel.fdFields.find((candidate) => candidate.fdName === fieldId);
  const attribute = JSON.parse(field.fdAttribute);
  applyHiddenLabelEvidence(attribute);
  field.fdAttribute = JSON.stringify(attribute);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  return template;
}

function applyHiddenLabelEvidence(attribute) {
  attribute.config.controlProps.desktop.hiddenLabel = true;
  attribute.config.controlProps.mobile.hiddenLabel = true;
  attribute.config.controlProps.showText = false;
  attribute.config.labelProps.desktop.hiddenLabel = true;
  attribute.config.labelProps.mobile.hiddenLabel = true;
  attribute.config.labelProps.showText = false;
}

function hiddenLabelEvidence(attribute) {
  return {
    controlDesktop: attribute.config.controlProps.desktop.hiddenLabel,
    controlMobile: attribute.config.controlProps.mobile.hiddenLabel,
    controlShowText: attribute.config.controlProps.showText,
    labelDesktop: attribute.config.labelProps.desktop.hiddenLabel,
    labelMobile: attribute.config.labelProps.mobile.hiddenLabel,
    labelShowText: attribute.config.labelProps.showText
  };
}

function nativeAttribute(template, targetFieldId) {
  const config = xformConfig(template);
  const mainModel = config.dataModel.find((model) => model.fdType === "main");
  const field = mainModel.fdFields.find((candidate) => candidate.fdName === targetFieldId);
  return JSON.parse(field.fdAttribute);
}

function mutateNativeAttribute(template, targetFieldId, mutate) {
  const config = xformConfig(template);
  const mainModel = config.dataModel.find((model) => model.fdType === "main");
  const field = mainModel.fdFields.find((candidate) => candidate.fdName === targetFieldId);
  const attribute = JSON.parse(field.fdAttribute);
  mutate(attribute);
  field.fdAttribute = JSON.stringify(attribute);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
}
