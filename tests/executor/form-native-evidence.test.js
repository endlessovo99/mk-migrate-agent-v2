import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/executor/persistence");

describe("independent native form mutation evidence", () => {
  for (const testCase of [
    {
      name: "missing main field",
      code: "readback.form.field_missing",
      mutate(config) {
        const main = config.dataModel.find((model) => model.fdType === "main");
        main.fdFields = main.fdFields.filter((field) => field.fdName !== "fd_subject");
      }
    },
    {
      name: "changed detail title",
      code: "readback.form.field_title",
      mutate(config) {
        config.dataModel.find((model) => model.fdType === "detail").fdName = "被篡改的明细标题";
      }
    }
  ]) {
    it(`detects ${testCase.name}`, () => {
      const prepared = prepareSample(sampleTrustedDsl({ workflow: null }));
      const template = independentFormReadback();
      const config = xformConfig(template);
      testCase.mutate(config);
      template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);

      const readback = prepared.verify(template);
      assert.equal(readback.ok, false);
      assert.equal(readback.diagnostics.some((item) => item.code === testCase.code), true);
    });
  }
});

function independentFormReadback() {
  const template = JSON.parse(readFileSync(join(fixtureDir, "form-only-native-readback.json"), "utf8"));
  const config = xformConfig(template);
  const attr = JSON.parse(config.attribute.formAttr);
  attr.subjectRule = {};
  config.attribute.formAttr = JSON.stringify(attr);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  return template;
}
