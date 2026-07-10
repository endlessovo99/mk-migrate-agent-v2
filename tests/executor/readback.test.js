import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyFormPayload } from "../../src/executor/form-payload.js";
import { verifyReadback } from "../../src/executor/readback.js";
import { sampleForm, sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("verifyReadback", () => {
  it("fails when persisted native form rules are lost", () => {
    const dsl = trustedDslWithFormRules();
    const persisted = applyFormPayload(baseTemplate(), dsl);
    const baseline = verifyReadback(dsl, persisted);

    assert.equal(baseline.ok, true);
    assert.equal(baseline.form.formRules.displayRuleCount, 2);
    assert.equal(baseline.form.formRules.requireRuleCount, 2);

    const config = JSON.parse(persisted.mechanisms["sys-xform"].fdConfig);
    const formAttr = JSON.parse(config.attribute.formAttr);
    formAttr.formRule.display = [];
    formAttr.formRule.require = [];
    config.attribute.formAttr = JSON.stringify(formAttr);
    persisted.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);

    const result = verifyReadback(dsl, persisted);
    const diagnostics = new Map(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic]));

    assert.equal(result.ok, false);
    assert.equal(result.form.formRules.displayRuleCount, 0);
    assert.equal(result.form.formRules.requireRuleCount, 0);
    assert.deepEqual(diagnostics.get("readback.form_rules.displayRuleCount_missing"), {
      level: "error",
      code: "readback.form_rules.displayRuleCount_missing",
      message: "Readback form rules do not include the expected generated native rule count.",
      path: "/readback/form/formRules/displayRuleCount",
      details: { expectedAtLeast: 2, actual: 0 }
    });
    assert.deepEqual(diagnostics.get("readback.form_rules.requireRuleCount_missing"), {
      level: "error",
      code: "readback.form_rules.requireRuleCount_missing",
      message: "Readback form rules do not include the expected generated native rule count.",
      path: "/readback/form/formRules/requireRuleCount",
      details: { expectedAtLeast: 2, actual: 0 }
    });
  });
});

function trustedDslWithFormRules() {
  const form = sampleForm();
  form.layout.mkTree[1] = {
    ...form.layout.mkTree[1],
    sourceMarkers: ["fd_detail_row"]
  };
  const dsl = sampleTrustedDsl({
    form,
    formRules: {
      linkage: [{
        id: "linkage.subject.detail",
        trigger: "change",
        source: "fd_subject",
        logic: "and",
        when: [{ field: "fd_subject", op: "contains", value: "A" }],
        effects: [
          { type: "visible", target: "fd_detail_row", value: true },
          { type: "required", target: "fd_detail_row", value: true }
        ],
        else: [
          { type: "visible", target: "fd_detail_row", value: false },
          { type: "required", target: "fd_detail_row", value: false }
        ],
        translationStatus: "executable"
      }],
      validations: [],
      impliedRequired: [],
      review: {}
    }
  });
  delete dsl.workflow;
  return dsl;
}

function baseTemplate() {
  return {
    fdId: "template-id",
    fdName: "测试模板",
    fdTableName: "mk_model_test",
    mechanisms: {
      "sys-xform": {
        fdId: "template-id",
        fdName: "测试模板",
        fdTableName: "mk_model_test",
        fdConfig: "{}"
      }
    }
  };
}
