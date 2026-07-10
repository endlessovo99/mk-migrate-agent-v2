import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAgentReview } from "../../src/agent-review/index.js";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { sampleDraftDsl, sampleSourceDraft } from "../helpers/sample-dsl.js";

const sourceRef = "source.form.jsp.required-only.script.1";

describe("Agent Review static form-property coverage", () => {
  it("presents required static coverage as an omitted-action closure candidate", () => {
    const prompt = buildAgentReviewPrompt(sourceDraft(), dslDraft());
    const action = prompt.context.dslDraft.scripts.actions[0];

    assert.equal(prompt.system.includes("coverage.staticProps"), true);
    assert.equal(prompt.context.jspTranslationPlaybook.coverageStandards.covered.includes("static form properties"), true);
    assert.deepEqual(action.coverage.staticProps, [
      { fieldId: "fd_subject", prop: "required", value: true }
    ]);
    assert.equal(action.reviewOpportunities[0].kind, "static_property_coverage_candidate");
    assert.equal(action.reviewOpportunities[0].requiredDecision.includes("omitted"), true);
  });

  it("accepts a reviewed omission backed by the existing required prop", async () => {
    const result = await runAgentReview(sourceDraft(), dslDraft(), {
      provider: providerWithPatches(validOmissionPatches()),
      reviewedAt: "2026-07-10T00:00:00.000Z",
      maxRepairAttempts: 0
    });

    assert.equal(result.ok, true);
    assert.equal(result.dsl.scripts.actions[0].translationStatus, "omitted");
    assert.equal(result.dsl.scripts.actions[0].function, "");
    assert.deepEqual(result.dsl.scripts.actions[0].coverage, staticCoverage());
  });

  it("rejects Agent coverage patches that claim an unsatisfied static prop", async () => {
    const invalidCoverage = staticCoverage();
    invalidCoverage.staticProps[0].fieldId = "fd_amount";
    const result = await runAgentReview(sourceDraft(), dslDraft(), {
      provider: providerWithPatches([patch("/scripts/actions/0/coverage", invalidCoverage)]),
      maxRepairAttempts: 0
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.diagnostics.some((item) => item.code === "agent.patch.static_prop_not_satisfied"), true);
  });

  it("rejects replacing deterministic static coverage with a different required field", async () => {
    const draft = dslDraft();
    draft.form.fields.find((field) => field.id === "fd_amount").props.required = true;
    const changedCoverage = staticCoverage();
    changedCoverage.staticProps[0].fieldId = "fd_amount";
    const result = await runAgentReview(sourceDraft(), draft, {
      provider: providerWithPatches([patch("/scripts/actions/0/coverage", changedCoverage)]),
      maxRepairAttempts: 0
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.diagnostics.some((item) => item.code === "agent.patch.static_props_changed"), true);
  });

  it("rejects dropping deterministic static coverage from the audit record", async () => {
    const result = await runAgentReview(sourceDraft(), dslDraft(), {
      provider: providerWithPatches([patch("/scripts/actions/0/coverage", {
        status: "covered",
        nativeRules: [],
        residuals: []
      })]),
      maxRepairAttempts: 0
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.diagnostics.some((item) => item.code === "agent.patch.static_props_changed"), true);
  });
});

function sourceDraft() {
  return sampleSourceDraft({
    workflow: undefined,
    scripts: {
      source: "sysform-jsp",
      sources: [{
        id: "required-only.script.1",
        sourceRef,
        javascript: "Com_AddEventListener(window, 'load', function(){ $('[name=\\\"extendDataFormInfo.value(fd_subject)\\\"]').attr('validate', 'required'); });",
        functionAudit: { matched: [], violations: [] }
      }]
    }
  });
}

function dslDraft() {
  return sampleDraftDsl({
    workflow: undefined,
    scripts: {
      source: "sysform-jsp",
      actions: [{
        id: "required-only.script.1.event.1",
        name: "onLoad",
        event: "onLoad",
        scope: "global",
        function: "function onLoad() {\n  // source required-only onLoad\n}",
        sourceRefs: [sourceRef],
        translationStatus: "needs_review",
        coverage: staticCoverage(),
        functionMappings: []
      }]
    }
  });
}

function staticCoverage() {
  return {
    status: "covered",
    nativeRules: [],
    staticProps: [{ fieldId: "fd_subject", prop: "required", value: true }],
    residuals: []
  };
}

function validOmissionPatches() {
  return [
    patch("/scripts/actions/0/function", ""),
    patch("/scripts/actions/0/translationStatus", "omitted"),
    patch("/scripts/actions/0/functionMappings", [{
      source: "jQuery validate=required onLoad",
      target: "form.fields[].props.required",
      basis: "static-form-prop",
      reviewRequired: false
    }]),
    patch("/scripts/actions/0/coverage", staticCoverage())
  ];
}

function patch(path, value) {
  return {
    op: "replace",
    path,
    value,
    sourceRefs: [sourceRef],
    evidence: ["The source only sets required and fd_subject already has props.required=true."],
    confidence: 0.95,
    rationale: "The static form property fully covers the source onLoad behavior."
  };
}

function providerWithPatches(patches) {
  const rawText = JSON.stringify({
    summary: "Reviewed static required coverage.",
    patches,
    diagnostics: []
  });
  return {
    metadata() {
      return { provider: "test", baseUrl: "fake://review", model: "fake-model" };
    },
    async review() {
      return {
        ok: true,
        provider: "test",
        baseUrl: "fake://review",
        model: "fake-model",
        promptVersion: "test-prompt",
        rawText
      };
    }
  };
}
