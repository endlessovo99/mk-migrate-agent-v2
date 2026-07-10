import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { sampleForm, sampleTrustedDsl } from "../helpers/sample-dsl.js";

function formWithDataOnlyField() {
  const form = sampleForm();
  form.fields.push({
    id: "fd_shift",
    title: "脚本状态",
    type: "text",
    componentId: "xform-input",
    props: {},
    sourceProps: { metadataAttributes: { canDisplay: "false" } },
    sourceRef: "source.form.dataField.fd_shift",
    dataOnly: true
  });
  return form;
}

function mappedGlobalAction(overrides = {}) {
  return {
    id: "gate.onLoad.1",
    name: "onLoad",
    event: "onLoad",
    scope: "global",
    function: "function onLoad() { MKXFORM.getValue('fd_shift') }",
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "GetXFormFieldById",
      target: "MKXFORM.getValue",
      basis: "semantic-translation",
      reviewRequired: false
    }],
    ...overrides
  };
}

describe("data-only fields and view-status gates", () => {
  it("accepts an unrendered main data-only field and canonical edit/view gates", () => {
    const editResult = validateMigrationDsl(sampleTrustedDsl({
      form: formWithDataOnlyField(),
      scripts: {
        actions: [mappedGlobalAction({ runWhen: { viewStatusIn: ["add", "edit"] } })]
      }
    }), { mode: "execute" });
    const viewResult = validateMigrationDsl(sampleTrustedDsl({
      form: formWithDataOnlyField(),
      scripts: {
        actions: [mappedGlobalAction({ runWhen: { viewStatusIn: ["view"] } })]
      }
    }), { mode: "execute" });

    assert.equal(editResult.ok, true);
    assert.equal(viewResult.ok, true);
  });

  it("rejects rendering or control-event binding for a data-only field", () => {
    const renderedForm = formWithDataOnlyField();
    renderedForm.layout.mkTree[0].children[0].refIds.push("fd_shift");
    const rendered = validateMigrationDsl(sampleTrustedDsl({ form: renderedForm }), { mode: "execute" });
    const controlBound = validateMigrationDsl(sampleTrustedDsl({
      form: formWithDataOnlyField(),
      scripts: {
        actions: [{
          ...mappedGlobalAction(),
          id: "shift.onChange.1",
          name: "onChange",
          event: "onChange",
          scope: "control",
          controlId: "fd_shift",
          function: "function onChange(value) { MKXFORM.setValue('fd_shift', value) }"
        }]
      }
    }), { mode: "execute" });

    assert.equal(rendered.ok, false);
    assert.equal(rendered.diagnostics.some((item) => item.code === "dsl.form.layout.data_only_field_rendered"), true);
    assert.equal(controlBound.ok, false);
    assert.equal(controlBound.diagnostics.some((item) => item.code === "dsl.scripts.data_only_control_action_forbidden"), true);
  });

  it("rejects malformed data-only declarations and non-canonical gates", () => {
    const malformedForm = formWithDataOnlyField();
    malformedForm.fields.at(-1).dataOnly = "true";
    malformedForm.fields[2].dataOnly = true;
    malformedForm.fields[2].columns[0].dataOnly = true;
    const malformed = validateMigrationDsl(sampleTrustedDsl({ form: malformedForm }), { mode: "execute" });
    const malformedGate = validateMigrationDsl(sampleTrustedDsl({
      form: formWithDataOnlyField(),
      scripts: { actions: [mappedGlobalAction({ runWhen: { viewStatusIn: ["edit", "add"] } })] }
    }), { mode: "execute" });
    const omittedGate = validateMigrationDsl(sampleTrustedDsl({
      form: formWithDataOnlyField(),
      scripts: {
        actions: [mappedGlobalAction({
          function: "",
          translationStatus: "omitted",
          coverage: { status: "covered", nativeRules: ["rule-1"], residuals: [] },
          runWhen: { viewStatusIn: ["view"] }
        })]
      }
    }), { mode: "execute" });

    assert.equal(malformed.ok, false);
    assert.equal(malformed.diagnostics.some((item) => item.code === "dsl.field.data_only_type"), true);
    assert.equal(malformed.diagnostics.some((item) => item.code === "dsl.field.data_only_scope"), true);
    assert.equal(malformedGate.ok, false);
    assert.equal(malformedGate.diagnostics.some((item) => item.code === "dsl.scripts.run_when_invalid"), true);
    assert.equal(omittedGate.ok, false);
    assert.equal(omittedGate.diagnostics.some((item) => item.code === "dsl.scripts.gated_omission_forbidden"), true);
  });

  it("allows a gated action to remain as audit evidence when an executable native rule fully covers it", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({
      form: formWithDataOnlyField(),
      formRules: executableFormRules(),
      scripts: {
        actions: [mappedGlobalAction({
          function: "",
          translationStatus: "omitted",
          coverage: { status: "covered", nativeRules: ["rule-1"], residuals: [] },
          runWhen: { viewStatusIn: ["add", "edit"] }
        })]
      }
    }), { mode: "execute" });

    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.scripts.gated_omission_forbidden"), false);
  });

  it("still rejects gated omission when native coverage is missing or incomplete", () => {
    const missingRule = validateMigrationDsl(sampleTrustedDsl({
      form: formWithDataOnlyField(),
      formRules: executableFormRules(),
      scripts: {
        actions: [mappedGlobalAction({
          function: "",
          translationStatus: "omitted",
          coverage: { status: "covered", nativeRules: ["rule-missing"], residuals: [] },
          runWhen: { viewStatusIn: ["view"] }
        })]
      }
    }), { mode: "execute" });
    const residual = validateMigrationDsl(sampleTrustedDsl({
      form: formWithDataOnlyField(),
      formRules: executableFormRules(),
      scripts: {
        actions: [mappedGlobalAction({
          function: "",
          translationStatus: "omitted",
          coverage: {
            status: "covered",
            nativeRules: ["rule-1"],
            residuals: [{ code: "still-uncovered" }]
          },
          runWhen: { viewStatusIn: ["view"] }
        })]
      }
    }), { mode: "execute" });

    assert.equal(missingRule.diagnostics.some((item) => item.code === "dsl.scripts.gated_omission_forbidden"), true);
    assert.equal(residual.diagnostics.some((item) => item.code === "dsl.scripts.gated_omission_forbidden"), true);
  });
});

function executableFormRules() {
  return {
    linkage: [{
      id: "rule-1",
      trigger: "change",
      source: "fd_subject",
      logic: "and",
      when: [{ field: "fd_subject", op: "eq", value: "A" }],
      effects: [{ type: "visible", target: "fd_amount", value: true }],
      else: [{ type: "visible", target: "fd_amount", value: false }],
      translationStatus: "executable"
    }],
    validations: [],
    impliedRequired: [],
    review: {}
  };
}
