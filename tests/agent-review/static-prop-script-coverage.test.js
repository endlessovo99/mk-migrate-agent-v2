import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAgentReview } from "../../src/agent-review/index.js";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { buildScriptBranchProvenance } from "../../src/dsl/script-branch-provenance.js";
import { sampleDraftDsl, sampleForm, sampleSourceDraft } from "../helpers/sample-dsl.js";

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

    assert.equal(result.ok, true, JSON.stringify(result.report?.diagnostics));
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

  it("accepts placeholder field props before closing matching static script coverage", async () => {
    const prompt = buildAgentReviewPrompt(
      placeholderSourceDraft(),
      placeholderDslDraft()
    );
    const opportunity = prompt.context.dslDraft.scripts.actions[0]
      .reviewOpportunities.find((item) =>
        item.kind === "static_property_coverage_candidate"
      );
    assert.equal(
      opportunity.candidatePatchPaths.includes("/form/fields/0/props"),
      false
    );
    assert.equal(prompt.system.includes("literal placeholder"), true);

    const result = await runAgentReview(
      placeholderSourceDraft(),
      placeholderDslDraft(),
      {
        provider: providerWithPatches(validPlaceholderOmissionPatches()),
        reviewedAt: "2026-07-10T00:00:00.000Z",
        maxRepairAttempts: 0
      }
    );

    assert.equal(result.ok, true, JSON.stringify(result.report?.diagnostics));
    assert.equal(
      result.dsl.form.fields.find((field) => field.id === "fd_subject").props.placeholder,
      "简述成立时间、注册资金、人员规模、主营业务等"
    );
    assert.equal(result.dsl.scripts.actions[0].translationStatus, "omitted");
    assert.equal(result.dsl.scripts.actions[0].function, "");
    assert.deepEqual(result.dsl.scripts.actions[0].coverage, placeholderCoverage());
  });

  it("rejects placeholder coverage that differs from the owning field prop", async () => {
    const patches = validPlaceholderOmissionPatches();
    patches.at(-1).value.staticProps[0].value = "不一致的占位提示";
    const result = await runAgentReview(
      placeholderSourceDraft(),
      placeholderDslDraft(),
      {
        provider: providerWithPatches(patches),
        maxRepairAttempts: 0
      }
    );

    assert.equal(result.ok, false);
    assert.equal(result.report.diagnostics.some((item) =>
      item.code === "agent.patch.static_prop_not_satisfied"
    ), true);
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
        branchProvenance: buildScriptBranchProvenance({
          event: "onLoad",
          source: sourceDraft().scripts.sources[0].javascript,
          sourceRef
        }),
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

function placeholderSourceDraft() {
  return sampleSourceDraft({
    workflow: undefined,
    scripts: {
      source: "sysform-jsp",
      sources: [{
        id: "placeholder-only.script.1",
        sourceRef: "source.form.jsp.placeholder-only.script.1",
        javascript: "Com_AddEventListener(window, 'load', function(){ var field=GetXFormFieldById('fd_subject')[0]; if(field){ field.setAttribute('placeholder','简述成立时间、注册资金、人员规模、主营业务等'); } });",
        functionAudit: { matched: [], violations: [] }
      }]
    }
  });
}

function placeholderDslDraft() {
  const form = sampleForm();
  const field = form.fields.find((candidate) => candidate.id === "fd_subject");
  Object.assign(field, {
    title: "供应商基本信息",
    type: "longText",
    componentId: "xform-textarea",
    props: {
      placeholder: "简述成立时间、注册资金、人员规模、主营业务等"
    },
    sourceProps: { designerType: "textarea" }
  });
  return sampleDraftDsl({
    workflow: undefined,
    form,
    scripts: {
      source: "sysform-jsp",
      actions: [{
        id: "placeholder-only.script.1.event.1",
        name: "onLoad",
        event: "onLoad",
        scope: "global",
        function: "function onLoad() {\n  // source placeholder-only onLoad\n}",
        sourceRefs: ["source.form.jsp.placeholder-only.script.1"],
        branchProvenance: buildScriptBranchProvenance({
          event: "onLoad",
          source: placeholderSourceDraft().scripts.sources[0].javascript,
          sourceRef: "source.form.jsp.placeholder-only.script.1"
        }),
        translationStatus: "needs_review",
        coverage: placeholderCoverage(),
        functionMappings: []
      }]
    }
  });
}

function placeholderCoverage() {
  return {
    status: "covered",
    nativeRules: [],
    staticProps: [{
      fieldId: "fd_subject",
      prop: "placeholder",
      value: "简述成立时间、注册资金、人员规模、主营业务等"
    }],
    residuals: []
  };
}

function validPlaceholderOmissionPatches() {
  const scriptRef = "source.form.jsp.placeholder-only.script.1";
  const staticProps = placeholderCoverage();
  return [
    patchWithRefs("/scripts/actions/0/function", "", [scriptRef]),
    patchWithRefs("/scripts/actions/0/translationStatus", "omitted", [scriptRef]),
    patchWithRefs("/scripts/actions/0/functionMappings", [{
      source: "setAttribute placeholder onLoad",
      target: "form.fields[].props.placeholder",
      basis: "static-form-prop",
      reviewRequired: false
    }], [scriptRef]),
    patchWithRefs("/scripts/actions/0/coverage", staticProps, [scriptRef])
  ];
}

function patch(path, value) {
  return patchWithRefs(path, value, [sourceRef]);
}

function patchWithRefs(path, value, sourceRefs) {
  return {
    op: "replace",
    path,
    value,
    sourceRefs,
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
