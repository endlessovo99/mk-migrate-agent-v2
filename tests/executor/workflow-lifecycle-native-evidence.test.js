import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/executor/persistence");

describe("independent native workflow lifecycle evidence", () => {
  it("accepts omitted fdStatus only with native draft markers", () => {
    const readback = prepareSample(sampleTrustedDsl()).verify(independentLifecycleReadback());
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.partitions.envelope, "verified");
  });

  for (const testCase of [
    {
      name: "published fdStatus",
      code: "readback.envelope.lbpm_status",
      mutate(lbpm) {
        lbpm.fdStatus = "published";
      }
    },
    {
      name: "false isDraft",
      code: "readback.envelope.lbpm_is_draft",
      mutate(lbpm) {
        lbpm.isDraft = false;
      }
    },
    {
      name: "missing native status",
      code: "readback.envelope.lbpm_status",
      mutate(lbpm) {
        delete lbpm.fdStatus;
        delete lbpm.latestDefinitionStatus;
      }
    }
  ]) {
    it(`rejects ${testCase.name}`, () => {
      const template = independentLifecycleReadback();
      testCase.mutate(template.mechanisms.lbpmTemplate[0]);
      const readback = prepareSample(sampleTrustedDsl()).verify(template);
      assert.equal(readback.ok, false);
      assert.equal(readback.partitions.envelope, "mismatch");
      assert.equal(readback.diagnostics.some((item) => item.code === testCase.code), true);
    });
  }
});

function independentLifecycleReadback() {
  const template = JSON.parse(readFileSync(join(fixtureDir, "form-only-native-readback.json"), "utf8"));
  const native = JSON.parse(readFileSync(join(fixtureDir, "workflow-draft-lifecycle-native.json"), "utf8"));
  const config = xformConfig(template);
  const attr = JSON.parse(config.attribute.formAttr);
  attr.subjectRule = {};
  config.attribute.formAttr = JSON.stringify(attr);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  template.mechanisms.lbpmTemplate = [{
    ...native,
    fdContent: JSON.stringify(native.content)
  }];
  delete template.mechanisms.lbpmTemplate[0].content;
  return template;
}
