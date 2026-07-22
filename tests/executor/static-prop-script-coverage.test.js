import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { persistAndVerify, projectTemplate, verifyTemplate, xformConfig } from "../helpers/persistence.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { localCorpusIt } from "../helpers/local-corpus.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

const targetFixture = "tests/fixtures/source/1670297c984b45009eb5b1e444d9957d";

describe("static form-property execution and readback", () => {
  it("skips an omitted required-only onLoad and verifies native required persistence", () => {
    const dsl = dslWithStaticRequiredOmission();
    const baseline = persistAndVerify(dsl).readback;

    assert.equal(baseline.ok, true);
    assert.equal(baseline.form.fields.find((field) => field.id === "fd_subject").required, true);
    assert.equal(baseline.form.scripts.actions.length, 0);
    assert.equal(baseline.form.scripts.events.includes("onLoad"), false);

    const lost = persistAndVerify(dsl, {
      mutate(template) {
        removeNativeRequired(template, "fd_subject");
        return template;
      }
    }).readback;

    assert.equal(lost.ok, false);
    assert.equal(lost.diagnostics.some((item) => item.code === "readback.form.required_mismatch"), true);

    const malformed = persistAndVerify(dsl, {
      mutate(template) {
        corruptNativeAttribute(template, "fd_subject");
        return template;
      }
    }).readback;
    assert.equal(malformed.ok, false);
    assert.equal(malformed.diagnostics.some((item) =>
      item.code === "readback.form.required_mismatch" && item.details?.fieldId === "fd_subject"
    ), true);
  });

  localCorpusIt("verifies all five target-fixture static required fields from native readback", () => {
    const draft = draftSourceDraft(cleanSourceFile(targetFixture));
    const staticActions = draft.scripts.actions
      .filter((action) => action.coverage?.staticProps?.length)
      .map((action) => ({ ...action, function: "", translationStatus: "omitted" }));
    const dsl = {
      form: draft.form,
      // Keep this regression scoped to static required props. The fixture also
      // contains independently tested gated native rules whose source actions
      // are intentionally absent from this reduced DSL.
      formRules: { linkage: [] },
      scripts: { source: draft.scripts.source, actions: staticActions }
    };
    const result = verifyTemplate(dsl, projectTemplate(dsl));
    const requiredIds = result.form.fields.filter((field) => field.required).map((field) => field.id);

    assert.equal(result.ok, true);
    assert.equal(staticActions.length, 5);
    assert.deepEqual(requiredIds.filter((fieldId) => staticActions.some((action) =>
      action.coverage.staticProps.some((entry) => entry.fieldId === fieldId)
    )).sort(), [
      "fd_3da33437ef5bfc",
      "fd_3e24177a9d94b4",
      "fd_3f3165cdddb2cc",
      "fd_38e47377ddcd7e",
      "fd_38e4741c029f44"
    ].sort());
  });
});

function dslWithStaticRequiredOmission() {
  const dsl = sampleTrustedDsl({
    scripts: {
      source: "sysform-jsp",
      actions: [{
        id: "required-only.script.1.event.1",
        name: "onLoad",
        event: "onLoad",
        scope: "global",
        function: "",
        sourceRefs: ["source.form.jsp.required-only.script.1"],
        translationStatus: "omitted",
        coverage: {
          status: "covered",
          nativeRules: [],
          staticProps: [{ fieldId: "fd_subject", prop: "required", value: true }],
          residuals: []
        },
        functionMappings: [{
          source: "jQuery validate=required onLoad",
          target: "form.fields[].props.required",
          basis: "static-form-prop",
          reviewRequired: false
        }]
      }]
    }
  });
  delete dsl.workflow;
  return dsl;
}

function removeNativeRequired(template, fieldId) {
  const config = xformConfig(template);
  const main = config.dataModel.find((model) => model.fdType === "main");
  const field = main.fdFields.find((candidate) => candidate.fdName === fieldId);
  const attribute = JSON.parse(field.fdAttribute);
  delete attribute.config.controlProps.required;
  field.fdAttribute = JSON.stringify(attribute);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
}

function corruptNativeAttribute(template, fieldId) {
  const config = xformConfig(template);
  const main = config.dataModel.find((model) => model.fdType === "main");
  main.fdFields.find((candidate) => candidate.fdName === fieldId).fdAttribute = "{malformed";
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
}
