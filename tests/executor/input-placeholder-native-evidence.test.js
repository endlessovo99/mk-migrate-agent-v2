import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/executor/persistence");
const fieldId = "fd_subject";
const placeholder = "Example: OP-2048; enter none when no opportunity exists";

describe("xform-input placeholder native persistence", () => {
  it("writes the DSL placeholder into native control props", () => {
    const prepared = prepareSample(placeholderDsl());
    const controlProps = nativeControlProps(prepared.update, fieldId);

    assert.equal(controlProps.placeholder, placeholder);
  });

  it("does not invent a placeholder when the DSL omits it", () => {
    const dsl = sampleTrustedDsl({ workflow: null });
    delete dsl.workflow;
    const prepared = prepareSample(dsl);
    const controlProps = nativeControlProps(prepared.update, fieldId);

    assert.equal(Object.hasOwn(controlProps, "placeholder"), false);
  });

  it("keeps an explicit textarea placeholder instead of the executor default", () => {
    const dsl = placeholderDsl();
    const field = dsl.form.fields.find((candidate) => candidate.id === fieldId);
    field.type = "longText";
    field.componentId = "xform-textarea";
    const prepared = prepareSample(dsl);
    const controlProps = nativeControlProps(prepared.update, fieldId);

    assert.equal(controlProps.desktop.type, "@elem/xform-textarea");
    assert.equal(controlProps.placeholder, placeholder);
    assert.equal(prepared.verify(structuredClone(prepared.update)).ok, true);
  });

  it("restores the placeholder from independent native readback evidence", () => {
    const prepared = prepareSample(placeholderDsl());
    const readback = prepared.verify(independentNativeReadback());

    assert.equal(readback.ok, true);
    assert.equal(
      readback.form.fields.find((field) => field.id === fieldId)?.placeholder,
      placeholder
    );
  });

  for (const testCase of [
    {
      name: "changed placeholder",
      mutate(controlProps) {
        controlProps.placeholder = "Changed native prompt";
      }
    },
    {
      name: "missing placeholder",
      mutate(controlProps) {
        delete controlProps.placeholder;
      }
    }
  ]) {
    it(`rejects a ${testCase.name}`, () => {
      const prepared = prepareSample(placeholderDsl());
      const template = independentNativeReadback();
      mutateNativeControlProps(template, fieldId, testCase.mutate);

      const readback = prepared.verify(template);

      assert.equal(readback.ok, false);
      assert.equal(
        readback.diagnostics.some((item) =>
          item.code === "readback.form.prop_placeholder_mismatch" &&
          item.details?.fieldId === fieldId
        ),
        true
      );
    });
  }
});

function placeholderDsl() {
  const dsl = sampleTrustedDsl({ workflow: null });
  delete dsl.workflow;
  dsl.form.fields.find((field) => field.id === fieldId).props.placeholder = placeholder;
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
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  mutateNativeControlProps(template, fieldId, (controlProps) => {
    controlProps.placeholder = placeholder;
  });
  return template;
}

function nativeControlProps(template, targetFieldId) {
  const config = xformConfig(template);
  const mainModel = config.dataModel.find((model) => model.fdType === "main");
  const field = mainModel.fdFields.find((candidate) => candidate.fdName === targetFieldId);
  return JSON.parse(field.fdAttribute).config.controlProps;
}

function mutateNativeControlProps(template, targetFieldId, mutate) {
  const config = xformConfig(template);
  const mainModel = config.dataModel.find((model) => model.fdType === "main");
  const field = mainModel.fdFields.find((candidate) => candidate.fdName === targetFieldId);
  const attribute = JSON.parse(field.fdAttribute);
  mutate(attribute.config.controlProps);
  field.fdAttribute = JSON.stringify(attribute);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
}
