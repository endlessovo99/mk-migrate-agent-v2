import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { sampleDraftDsl, sampleForm, sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("buildDryRunPlan", () => {
  it("builds a route-validation plan from trusted migration DSL without external writes", () => {
    const plan = buildDryRunPlan(sampleTrustedDsl());

    assert.equal(plan.ok, true);
    assert.equal(plan.status, "passed");
    assert.deepEqual(plan.steps.map((step) => step.id), [
      "check-execute",
      "resolve-template",
      "map-form-layout",
      "map-workflow",
      "save-template-draft",
      "readback"
    ]);
    assert.equal(plan.steps.every((step) => step.status === "ok" || step.status === "planned"), true);
    assert.equal(plan.steps.find((step) => step.id === "map-form-layout")?.layoutRows, 2);
  });

  it("rejects dsl-draft before planning execution", () => {
    const plan = buildDryRunPlan(sampleDraftDsl());

    assert.equal(plan.ok, false);
    assert.equal(plan.status, "invalid");
    assert.equal(plan.diagnostics.some((item) => item.code === "dsl.trust.trusted_required"), true);
    assert.equal(plan.steps.find((step) => step.id === "resolve-template")?.status, "blocked");
  });

  it("plans JSP script control actions when trusted scripts are present", () => {
    const plan = buildDryRunPlan(sampleTrustedDsl({
      scripts: {
        actions: [{
          id: "fd_jsp.script.1",
          name: "onLoad",
          event: "onLoad",
          scope: "global",
          function: "function onLoad(context) {}",
          translationStatus: "mapped",
          coverage: { status: "translated", nativeRules: [], residuals: [] },
          functionMappings: [{
            source: "window load",
            target: "onLoad",
            basis: "semantic-translation",
            reviewRequired: false
          }]
        }]
      }
    }));
    const scriptStep = plan.steps.find((step) => step.id === "map-form-scripts");

    assert.equal(plan.ok, true);
    assert.equal(scriptStep.status, "planned");
    assert.equal(scriptStep.actions, 1);
    assert.deepEqual(scriptStep.events, ["onLoad"]);
    assert.deepEqual(scriptStep.support, { supported: 0, unsupported: 0, unknown: 0 });
  });

  it("reports control script support in the dry-run plan", () => {
    const plan = buildDryRunPlan(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [{
          id: "fd_subject.onFocus",
          name: "onFocus",
          event: "onFocus",
          scope: "control",
          controlId: "fd_subject",
          function: "function onFocus() {\n  MKXFORM.setValue('fd_amount', 'focused')\n}",
          translationStatus: "mapped",
          coverage: { status: "translated", nativeRules: [], residuals: [] },
          functionMappings: [{
            source: "focus behavior",
            target: "MKXFORM.setValue",
            basis: "semantic-translation",
            reviewRequired: false
          }]
        }]
      }
    }));
    const scriptStep = plan.steps.find((step) => step.id === "map-form-scripts");

    assert.equal(plan.ok, true);
    assert.deepEqual(scriptStep.support, { supported: 1, unsupported: 0, unknown: 0 });
    assert.deepEqual(scriptStep.components, ["xform-input"]);
    assert.equal(scriptStep.detailActions, 0);
  });

  it("plans native MK display and require form rules", () => {
    const plan = buildDryRunPlan(sampleTrustedDslWithFormRules());
    const step = plan.steps.find((item) => item.id === "map-form-rules");

    assert.equal(plan.ok, true);
    assert.equal(step.status, "planned");
    assert.equal(step.sourceRuleCount, 1);
    assert.equal(step.displayRuleCount, 2);
    assert.equal(step.requireRuleCount, 2);
    assert.deepEqual(step.targets, ["fd_detail_row"]);
    assert.deepEqual(step.conditions, ["fd_subject contains A"]);
  });
});

function sampleTrustedDslWithFormRules() {
  const form = sampleForm();
  form.layout.mkTree[1] = {
    ...form.layout.mkTree[1],
    sourceMarkers: ["fd_detail_row"]
  };

  return sampleTrustedDsl({
    form,
    workflow: undefined,
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
}
