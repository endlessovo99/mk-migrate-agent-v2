import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { buildScriptBranchProvenance } from "../../src/dsl/script-branch-provenance.js";
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
  const action = {
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
  if (["onChange", "onLoad"].includes(action.event) && action.branchProvenance === undefined) {
    action.branchProvenance = buildScriptBranchProvenance({
      event: action.event,
      source: action.function || `function ${action.event}(${action.event === "onChange" ? "value" : ""}) {}`,
      sourceRef: action.sourceRefs?.[0],
      sourceActionKey: action.sourceActionKey
    });
  }
  return action;
}

function mappedControlAction(sourceRef, overrides = {}) {
  const action = {
    ...mappedGlobalAction(),
    id: "fd_subject.onChange.1",
    name: "onChange",
    event: "onChange",
    scope: "control",
    controlId: "fd_subject",
    sourceRefs: [sourceRef],
    sourceActionKey: `${sourceRef}#onChange@0`,
    function: "function onChange(value) { MKXFORM.getValue('fd_subject') }",
    runWhen: { viewStatusIn: ["add", "edit"] },
    ...overrides
  };
  action.branchProvenance = buildScriptBranchProvenance({
    event: "onChange",
    source: action.function,
    sourceRef,
    sourceActionKey: action.sourceActionKey
  });
  return action;
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

  it("allows an ungated control onChange omission with matching native-rule evidence", () => {
    const sourceRef = "source.form.jsp.fd_shift.script.1";
    const formRules = executableFormRules();
    formRules.linkage[0].meta = { sourceJsp: sourceRef };
    const result = validateMigrationDsl(sampleTrustedDsl({
      form: formWithDataOnlyField(),
      formRules,
      scripts: {
        actions: [mappedGlobalAction({
          id: "fd_subject.onChange.1",
          name: "onChange",
          event: "onChange",
          scope: "control",
          controlId: "fd_subject",
          function: "",
          translationStatus: "omitted",
          sourceRefs: [sourceRef],
          coverage: { status: "covered", nativeRules: ["rule-1"], residuals: [] }
        })]
      }
    }), { mode: "execute" });

    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.scripts.native_rule_action_mismatch"), false);
  });

  it("rejects a view onLoad omission that borrows an unrelated control-change native rule", () => {
    const sourceRef = "source.form.jsp.fd_view.script.1";
    const formRules = executableFormRules();
    formRules.linkage[0].meta = { sourceJsp: sourceRef };
    const result = validateMigrationDsl(sampleTrustedDsl({
      form: formWithDataOnlyField(),
      formRules,
      scripts: {
        actions: [mappedGlobalAction({
          function: "",
          translationStatus: "omitted",
          sourceRefs: [sourceRef],
          coverage: { status: "covered", nativeRules: ["rule-1"], residuals: [] },
          runWhen: { viewStatusIn: ["view"] }
        })]
      }
    }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(
      result.diagnostics.some((item) => item.code === "dsl.scripts.native_rule_action_mismatch"),
      true
    );
  });

  it("rejects native-rule omission when control or source evidence is missing", () => {
    const sourceRef = "source.form.jsp.fd_shift.script.1";
    const action = {
      id: "fd_subject.onChange.1",
      name: "onChange",
      event: "onChange",
      scope: "control",
      controlId: "fd_subject",
      function: "",
      translationStatus: "omitted",
      sourceRefs: [sourceRef],
      coverage: { status: "covered", nativeRules: ["rule-1"], residuals: [] }
    };
    const wrongControlRules = executableFormRules();
    wrongControlRules.linkage[0].source = "fd_amount";
    wrongControlRules.linkage[0].when[0].field = "fd_amount";
    wrongControlRules.linkage[0].meta = { sourceJsp: sourceRef };
    const wrongControl = validateMigrationDsl(sampleTrustedDsl({
      form: formWithDataOnlyField(),
      formRules: wrongControlRules,
      scripts: { actions: [action] }
    }), { mode: "execute" });

    const missingSourceEvidence = validateMigrationDsl(sampleTrustedDsl({
      form: formWithDataOnlyField(),
      formRules: executableFormRules(),
      scripts: { actions: [action] }
    }), { mode: "execute" });

    assert.equal(
      wrongControl.diagnostics.some((item) => item.code === "dsl.scripts.native_rule_action_mismatch"),
      true
    );
    assert.equal(
      missingSourceEvidence.diagnostics.some((item) => item.code === "dsl.scripts.native_rule_action_mismatch"),
      true
    );
  });

  it("rejects executable native linkage that carries an unpersistable view-status gate", () => {
    const formRules = executableFormRules();
    formRules.linkage[0].meta = { runWhen: { viewStatusIn: ["add", "edit"] } };
    const result = validateMigrationDsl(sampleTrustedDsl({
      form: formWithDataOnlyField(),
      formRules,
      scripts: {
        actions: [mappedGlobalAction({
          function: "",
          translationStatus: "omitted",
          coverage: { status: "covered", nativeRules: ["rule-1"], residuals: [] },
          runWhen: { viewStatusIn: ["add", "edit"] }
        })]
      }
    }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(
      result.diagnostics.some((item) => item.code === "dsl.form_rules.run_when_not_persistable"),
      true
    );
    assert.equal(
      result.diagnostics.some((item) => item.code === "dsl.scripts.gated_omission_forbidden"),
      true
    );
  });

  it("accepts an edit-gated native linkage only with matching event-input formula evidence", () => {
    const formRules = executableFormRules();
    formRules.linkage[0].meta = {
      sourceJsp: "source.form.jsp.fd_subject",
      displayGate: "xform:editShow",
      runWhen: { viewStatusIn: ["add", "edit"] },
      conditionSource: "event:value",
      sourceActionKey: "source.form.jsp.fd_subject#onChange@0",
      nativeProjection: { kind: "view-status-formula", version: 1 },
      conditionSemantics: [{
        origin: "event:value",
        transforms: [],
        predicate: "strict-equality"
      }]
    };
    const result = validateMigrationDsl(sampleTrustedDsl({
      form: formWithDataOnlyField(),
      formRules,
      scripts: { actions: [mappedControlAction("source.form.jsp.fd_subject")] }
    }), { mode: "execute" });

    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(
      result.diagnostics.some((item) => item.code === "dsl.form_rules.native_projection_unproven"),
      false
    );
  });

  it("rejects forged formula evidence when the condition source is not the action input", () => {
    const formRules = executableFormRules();
    formRules.linkage[0].meta = {
      sourceJsp: "source.form.jsp.fd_subject",
      displayGate: "xform:editShow",
      runWhen: { viewStatusIn: ["add", "edit"] },
      conditionSource: "field:fd_other",
      sourceActionKey: "source.form.jsp.fd_subject#onChange@0",
      nativeProjection: { kind: "view-status-formula", version: 1 },
      conditionSemantics: [{
        origin: "field:fd_other",
        transforms: [],
        predicate: "strict-equality"
      }]
    };
    const result = validateMigrationDsl(sampleTrustedDsl({
      form: formWithDataOnlyField(),
      formRules,
      scripts: { actions: [mappedControlAction("source.form.jsp.fd_subject")] }
    }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(
      result.diagnostics.some((item) => item.code === "dsl.form_rules.native_projection_unproven"),
      true
    );
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
