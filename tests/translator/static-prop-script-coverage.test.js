import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { draftMkScriptsFromSourceScripts } from "../../src/translator/sysform-jsp-scripts.js";
import { localCorpusIt } from "../helpers/local-corpus.js";

const targetFixture = "tests/fixtures/source/1670297c984b45009eb5b1e444d9957d";

describe("static form-property script coverage", () => {
  it("recognizes an exact required-only onLoad when the DSL field is already required", () => {
    const scripts = draftMkScriptsFromSourceScripts(sourceScripts("fd_required"), {
      form: formWithRequired("fd_required", true),
      formRules: { linkage: [] }
    });

    assert.equal(scripts.actions.length, 1);
    assert.deepEqual(scripts.actions[0].coverage, {
      status: "covered",
      nativeRules: [],
      staticProps: [{ fieldId: "fd_required", prop: "required", value: true }],
      residuals: []
    });
    assert.equal(scripts.actions[0].translationStatus, "needs_review");
  });

  it("does not claim static coverage when the field is not statically required", () => {
    const scripts = draftMkScriptsFromSourceScripts(sourceScripts("fd_optional"), {
      form: formWithRequired("fd_optional", false),
      formRules: { linkage: [] }
    });

    assert.equal(scripts.actions[0].coverage.status, "uncovered");
    assert.deepEqual(scripts.actions[0].coverage.nativeRules, []);
    assert.equal(scripts.actions[0].coverage.staticProps, undefined);
    assert.equal(scripts.actions[0].coverage.residuals.some((item) => item.code === "script.residual.window_load_listener"), true);
  });

  it("does not broaden gated source behavior into an unconditional static property", () => {
    const scripts = draftMkScriptsFromSourceScripts(sourceScripts("fd_required", "xform:viewShow"), {
      form: formWithRequired("fd_required", true),
      formRules: { linkage: [] }
    });

    assert.equal(scripts.actions[0].coverage.status, "uncovered");
    assert.equal(scripts.actions[0].coverage.staticProps, undefined);
    assert.deepEqual(scripts.actions[0].runWhen, { viewStatusIn: ["view"] });
  });

  localCorpusIt("finds exactly five required-only onLoad actions in the target fixture", () => {
    const dsl = draftSourceDraft(cleanSourceFile(targetFixture));
    const actions = dsl.scripts.actions.filter((action) => action.coverage?.staticProps?.length);

    assert.deepEqual(actions.map((action) => ({
      id: action.id,
      coverage: action.coverage
    })), [
      coveredAction("fd_3e6f78ef1163f0.script.1.event.1", "fd_3da33437ef5bfc"),
      coveredAction("fd_3e6f78f6fef7ee.script.1.event.1", "fd_38e47377ddcd7e"),
      coveredAction("fd_3e6f78f84b9dcc.script.1.event.1", "fd_38e4741c029f44"),
      coveredAction("fd_3f3165d1b6193e.script.1.event.1", "fd_3f3165cdddb2cc"),
      coveredAction("fd_3e6f78fa592064.script.1.event.1", "fd_3e24177a9d94b4")
    ]);
  });
});

function sourceScripts(fieldId, displayGate) {
  return {
    source: "sysform-jsp",
    sources: [{
      id: "required-only.script.1",
      sourceRef: "source.form.jsp.required-only.script.1",
      displayGate,
      javascript: `Com_AddEventListener(window, "load", function(){
  $("[name='extendDataFormInfo.value(${fieldId})']").attr("validate", "required");
});`,
      functionAudit: { matched: [], violations: [] }
    }]
  };
}

function formWithRequired(fieldId, required) {
  return {
    fields: [{
      id: fieldId,
      title: "目标字段",
      type: "text",
      componentId: "xform-input",
      props: required ? { required: true } : {}
    }]
  };
}

function coveredAction(id, fieldId) {
  return {
    id,
    coverage: {
      status: "covered",
      nativeRules: [],
      staticProps: [{ fieldId, prop: "required", value: true }],
      residuals: []
    }
  };
}
