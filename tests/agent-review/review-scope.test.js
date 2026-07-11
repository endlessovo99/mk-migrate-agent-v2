import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEvidenceBackedPatches, runAgentReview } from "../../src/agent-review/index.js";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { OpenAIResponsesReviewProvider } from "../../src/agent-review/provider.js";
import { sampleDraftDsl, sampleSourceDraft } from "../helpers/sample-dsl.js";

const actionIds = ["script-1.event-1", "script-2.event-1"];
const sourceRefs = ["source.form.jsp.script-1", "source.form.jsp.script-2"];
const reviewScope = {
  actionIndexes: [1],
  actionIds: [actionIds[1]],
  includeFormTargets: false
};
const expectedPatchPaths = [
  "/scripts/actions/1/function",
  "/scripts/actions/1/translationStatus",
  "/scripts/actions/1/functionMappings",
  "/scripts/actions/1/coverage"
];

describe("Agent Review prompt scope", () => {
  it("exposes only the selected script action as a concrete patch target", () => {
    const prompt = buildAgentReviewPrompt(sourceDraft(), dslDraft(), { reviewScope });

    assert.deepEqual(prompt.context.reviewScope, reviewScope);
    assert.deepEqual(prompt.context.allowedConcretePatchPaths, expectedPatchPaths);
    assert.deepEqual(prompt.context.dslDraft.scripts.focusedActionIndexes, [1]);
    assert.equal(prompt.context.allowedConcretePatchPaths.some((path) => path.startsWith("/form/")), false);
    assert.equal(expectedPatchPaths.includes(prompt.context.responseContract.validPatchExample.path), true);
    assert.equal(prompt.context.responseContract.validPatchExample.path.endsWith("/title"), false);
  });

  it("passes the selected review scope into the OpenAI request prompt", async () => {
    let submittedContext;
    const provider = new OpenAIResponsesReviewProvider({
      env: {
        OPENAI_BASE_URL: "https://example.test",
        OPENAI_API_KEY: "sk-test-secret",
        OPENAI_MODEL: "fake-review-model"
      },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        submittedContext = JSON.parse(body.input.find((item) => item.role === "user").content);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            output_text: JSON.stringify({
              summary: "Reviewed the selected action.",
              patches: [],
              diagnostics: []
            })
          })
        };
      }
    });

    const result = await provider.review({
      sourceDraft: sourceDraft(),
      dslDraft: dslDraft(),
      reviewScope
    });

    assert.equal(result.ok, true);
    assert.deepEqual(submittedContext.reviewScope, reviewScope);
    assert.deepEqual(submittedContext.allowedConcretePatchPaths, expectedPatchPaths);
    assert.deepEqual(submittedContext.dslDraft.scripts.focusedActionIndexes, [1]);
  });

  it("does not expand script source windows for an explicitly form-only scope", () => {
    const prompt = buildAgentReviewPrompt(sourceDraft(), dslDraft(), {
      reviewScope: {
        actionIndexes: [],
        actionIds: [],
        includeFormTargets: true
      }
    });

    assert.deepEqual(prompt.context.dslDraft.scripts.focusedActionIndexes, []);
    assert.equal(
      prompt.context.sourceDraft.scripts.sources.every((source) => source.javascriptWindows === undefined),
      true
    );
  });

  it("rejects a valid patch that targets an action outside the current review batch", async () => {
    const provider = new OutOfScopeReviewProvider();

    const result = await runAgentReview(sourceDraft(), dslDraft(), {
      provider,
      batchSize: 1,
      maxRepairAttempts: 0,
      reviewedAt: "2026-07-11T00:00:00.000Z"
    });

    assert.deepEqual(provider.calls[0].reviewScope.actionIndexes, [0]);
    assert.deepEqual(provider.calls[0].reviewScope.actionIds, [actionIds[0]]);
    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.patch-validation");
    assert.equal(result.dsl, undefined);
    assert.equal(
      result.report.diagnostics.some((diagnostic) => diagnostic.code === "agent.patch.path_outside_review_scope"),
      true
    );
  });

  it("rejects script patches evidenced only by a different action's source refs", async () => {
    const result = await runAgentReview(sourceDraft(), dslDraft(), {
      provider: new CrossActionEvidenceProvider(),
      batchSize: 1,
      maxReviewRounds: 1,
      maxRepairAttempts: 0,
      reviewedAt: "2026-07-11T00:00:00.000Z"
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.patch-validation");
    assert.equal(
      result.report.diagnostics.some((diagnostic) => diagnostic.code === "agent.patch.source_refs_outside_target"),
      true
    );
  });

  it("rejects mixed target-owned and unrelated source refs", async () => {
    const result = await runAgentReview(sourceDraft(), dslDraft(), {
      provider: new CrossActionEvidenceProvider([sourceRefs[0], sourceRefs[1]]),
      batchSize: 1,
      maxReviewRounds: 1,
      maxRepairAttempts: 0,
      reviewedAt: "2026-07-11T00:00:00.000Z"
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.patch-validation");
    assert.equal(
      result.report.diagnostics.some((diagnostic) => diagnostic.code === "agent.patch.source_refs_outside_target"),
      true
    );
  });

  it("rejects patches when the target has no source refs of its own", () => {
    const draft = dslDraft();
    draft.scripts.actions[0].sourceRefs = [];
    const result = applyEvidenceBackedPatches(draft, [{
      op: "replace",
      path: "/scripts/actions/0/translationStatus",
      value: "mapped",
      sourceRefs: [sourceRefs[0]],
      evidence: [`${sourceRefs[0]} exists globally but is not owned by the target.`],
      confidence: 0.95,
      rationale: "Attempt to patch a target without target-owned provenance."
    }], {
      sourceRefs: new Set(sourceRefs)
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.diagnostics.some((diagnostic) => diagnostic.code === "agent.patch.target_source_refs_missing"),
      true
    );
  });
});

class OutOfScopeReviewProvider {
  constructor() {
    this.calls = [];
  }

  metadata() {
    return {
      provider: "fake-review-scope",
      baseUrl: "fake://agent-review",
      model: "fake-model"
    };
  }

  async review(input) {
    this.calls.push({
      reviewScope: structuredClone(input.reviewScope)
    });
    const rawText = JSON.stringify({
      summary: "Attempted to review a script outside the selected batch.",
      patches: [{
        op: "replace",
        path: "/scripts/actions/1/translationStatus",
        value: "mapped",
        sourceRefs: [sourceRefs[1]],
        evidence: [`${sourceRefs[1]} contains the source script behavior.`],
        confidence: 0.95,
        rationale: "Mark the second action as translated."
      }],
      diagnostics: []
    });

    return {
      ok: true,
      status: "received",
      stage: "agent-review.provider",
      provider: "fake-review-scope",
      baseUrl: "fake://agent-review",
      model: "fake-model",
      promptVersion: "test-review-scope-v1",
      rawText,
      rawResponsePreview: rawText
    };
  }
}

class CrossActionEvidenceProvider extends OutOfScopeReviewProvider {
  constructor(patchSourceRefs = [sourceRefs[1]]) {
    super();
    this.patchSourceRefs = patchSourceRefs;
  }

  async review(input) {
    this.calls.push({ reviewScope: structuredClone(input.reviewScope) });
    const patch = (property, value) => ({
      op: "replace",
      path: `/scripts/actions/0/${property}`,
      value,
      sourceRefs: this.patchSourceRefs,
      evidence: [`${this.patchSourceRefs.join(", ")} includes evidence outside the target action.`],
      confidence: 0.95,
      rationale: "Attempt to use cross-action evidence."
    });
    const rawText = JSON.stringify({
      summary: "Used evidence from another action.",
      patches: [
        patch("function", "function onLoad() {\n  MKXFORM.setValue('fd_subject', 'wrong-source')\n}"),
        patch("translationStatus", "mapped"),
        patch("functionMappings", [{
          source: "SetXFormFieldValueById",
          target: "MKXFORM.setValue",
          basis: "function-catalog",
          reviewRequired: false
        }]),
        patch("coverage", { status: "translated", nativeRules: [], residuals: [] })
      ],
      diagnostics: []
    });
    return {
      ok: true,
      status: "received",
      stage: "agent-review.provider",
      provider: "fake-review-scope",
      baseUrl: "fake://agent-review",
      model: "fake-model",
      promptVersion: "test-review-scope-v1",
      rawText,
      rawResponsePreview: rawText
    };
  }
}

function sourceDraft() {
  return sampleSourceDraft({
    workflow: undefined,
    scripts: {
      source: "sysform-jsp",
      sources: sourceRefs.map((sourceRef, index) => ({
        id: `script-${index + 1}`,
        sourceRef,
        javascript: `SetXFormFieldValueById('fd_subject', 'value-${index + 1}')`,
        functionAudit: { matched: [], violations: [] }
      }))
    }
  });
}

function dslDraft() {
  return sampleDraftDsl({
    workflow: undefined,
    scripts: {
      source: "sysform-jsp",
      actions: actionIds.map((id, index) => ({
        id,
        name: "onLoad",
        event: "onLoad",
        scope: "global",
        function: `function onLoad() {\n  // review script-${index + 1}\n}`,
        translationStatus: "needs_review",
        sourceRefs: [sourceRefs[index]],
        coverage: { status: "uncovered", nativeRules: [], residuals: [] },
        functionMappings: []
      }))
    }
  });
}
