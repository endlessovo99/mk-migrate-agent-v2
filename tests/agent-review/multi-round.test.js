import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAgentReview } from "../../src/agent-review/index.js";
import { draftSourceDraft } from "../../src/translator/dsl-draft.js";
import { sampleDraftDsl, sampleSourceDraft } from "../helpers/sample-dsl.js";

const actionIds = [
  "script-1.event.1",
  "script-2.event.1",
  "script-3.event.1"
];

const sourceRefs = [
  "source.form.jsp.script-1",
  "source.form.jsp.script-2",
  "source.form.jsp.script-3"
];

describe("Agent Review multi-round script closure", () => {
  it("continues after a valid partial response until every script action is trusted", async () => {
    const provider = new PartialThenCompleteReviewProvider();

    const result = await runAgentReview(sourceDraft(), dslDraft(), {
      provider,
      batchSize: 2,
      maxAttemptsPerAction: 2,
      reviewedAt: "2026-07-11T00:00:00.000Z"
    });

    assert.equal(result.ok, true);
    assert.equal(result.dsl.trust.level, "trusted");
    assert.equal(result.dsl.trust.executable, true);
    assert.equal(provider.calls.length >= 2, true);

    assert.deepEqual(provider.calls[0].reviewScope.actionIndexes, [0, 1]);
    assert.deepEqual(provider.calls[0].reviewScope.actionIds, actionIds.slice(0, 2));
    assert.deepEqual(provider.calls[1].reviewScope.actionIndexes, [1, 2]);
    assert.deepEqual(provider.calls[1].reviewScope.actionIds, actionIds.slice(1));
    assert.equal(
      provider.calls.slice(1).some((call) => call.reviewScope.actionIds.includes(actionIds[0])),
      false
    );

    assert.equal(result.report.acceptedPatchCount, 12);
    assert.equal(result.dsl.review.agentReview.patchCount, 12);
    assert.equal(result.report.batches.length, 2);
    assert.deepEqual(result.report.batches.map(batchHistoryView), [
      {
        actionIndexes: [0, 1],
        actionIds: actionIds.slice(0, 2),
        acceptedPatchCount: 4,
        before: [
          actionState(0, "needs_review"),
          actionState(1, "needs_review")
        ],
        after: [
          actionState(0, "mapped"),
          actionState(1, "needs_review")
        ]
      },
      {
        actionIndexes: [1, 2],
        actionIds: actionIds.slice(1),
        acceptedPatchCount: 8,
        before: [
          actionState(1, "needs_review"),
          actionState(2, "needs_review")
        ],
        after: [
          actionState(1, "mapped"),
          actionState(2, "mapped")
        ]
      }
    ]);
    assert.deepEqual(
      result.dsl.scripts.actions.map((action) => action.translationStatus),
      ["mapped", "mapped", "mapped"]
    );
  });

  it("blocks after bounded attempts when valid responses make no review progress", async () => {
    const provider = new AlwaysEmptyReviewProvider();

    const result = await runAgentReview(sourceDraft(), dslDraft(), {
      provider,
      batchSize: 2,
      maxAttemptsPerAction: 2,
      reviewedAt: "2026-07-11T00:00:00.000Z"
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.incomplete");
    assert.equal(result.dsl, undefined);
    assert.equal(result.report.remainingReviewCount > 0, true);
    assert.equal(provider.calls.length, 3);
  });

  it("accepts a later batch revision of a path patched by an earlier attempt", async () => {
    const provider = new OverlappingRetryReviewProvider();

    const result = await runAgentReview(sourceDraft(), dslDraft(), {
      provider,
      batchSize: 3,
      maxAttemptsPerAction: 2,
      reviewedAt: "2026-07-11T00:00:00.000Z"
    });

    assert.equal(result.ok, true);
    assert.equal(provider.calls.length, 2);
    assert.deepEqual(result.report.batches.map((batch) => batch.acceptedPatchCount), [1, 12]);
    assert.deepEqual(result.report.batches[1].supersededPatchPaths, ["/scripts/actions/0/function"]);
    assert.equal(result.report.batches[1].supersededPatches.length, 1);
    assert.deepEqual(result.report.batches[1].supersededPatches[0], {
      path: "/scripts/actions/0/function",
      previous: scriptClosurePatches(0)[0],
      replacement: scriptClosurePatches(0)[0]
    });
    assert.equal(result.report.batches[1].effectivePatchCount, 12);
    assert.equal(result.report.acceptedPatchCount, 12);
    assert.equal(result.dsl.review.agentReview.patchCount, 12);
  });

  it("tracks bounded attempts by immutable action index when ids are duplicated", async () => {
    const provider = new AlwaysEmptyReviewProvider();
    const draft = dslDraft();
    draft.scripts.actions[1].id = draft.scripts.actions[0].id;

    const result = await runAgentReview(sourceDraft(), draft, {
      provider,
      batchSize: 1,
      maxAttemptsPerAction: 1,
      reviewedAt: "2026-07-11T00:00:00.000Z"
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.incomplete");
    assert.deepEqual(
      provider.calls.map((call) => call.reviewScope.actionIndexes),
      [[0], [1], [2]]
    );
  });

  it("deduplicates repeated model warnings while preserving them per batch", async () => {
    const result = await runAgentReview(sourceDraft(), dslDraft(), {
      provider: new RepeatedWarningReviewProvider(),
      batchSize: 2,
      maxAttemptsPerAction: 2,
      reviewedAt: "2026-07-11T00:00:00.000Z"
    });

    assert.equal(result.ok, true);
    assert.equal(
      result.dsl.review.warnings.filter((warning) => warning.code === "agent.test.repeated_warning").length,
      1
    );
    assert.deepEqual(result.report.batches.map((batch) => batch.warnings.length), [1, 1]);
    assert.equal(result.report.reviewers.length, 1);
  });
});

class PartialThenCompleteReviewProvider {
  constructor() {
    this.calls = [];
  }

  metadata() {
    return {
      provider: "fake-multi-round",
      baseUrl: "fake://agent-review",
      model: "fake-model"
    };
  }

  async review(input) {
    const fallbackScope = {
      actionIndexes: [0, 1, 2],
      actionIds,
      includeFormTargets: true
    };
    const reviewScope = input.reviewScope || fallbackScope;
    this.calls.push({
      reviewScope: structuredClone(reviewScope)
    });

    const actionIndexes = this.calls.length === 1
      ? reviewScope.actionIndexes.slice(0, 1)
      : reviewScope.actionIndexes;
    const rawText = reviewResponse(actionIndexes.flatMap(scriptClosurePatches));

    return {
      ok: true,
      status: "received",
      stage: "agent-review.provider",
      provider: "fake-multi-round",
      baseUrl: "fake://agent-review",
      model: "fake-model",
      promptVersion: "test-multi-round-v1",
      rawText,
      rawResponsePreview: rawText.slice(0, 2_000)
    };
  }
}

class AlwaysEmptyReviewProvider {
  constructor() {
    this.calls = [];
  }

  metadata() {
    return {
      provider: "fake-no-progress",
      baseUrl: "fake://agent-review",
      model: "fake-model"
    };
  }

  async review(input) {
    this.calls.push({
      reviewScope: structuredClone(input.reviewScope)
    });
    const rawText = reviewResponse([]);

    return {
      ok: true,
      status: "received",
      stage: "agent-review.provider",
      provider: "fake-no-progress",
      baseUrl: "fake://agent-review",
      model: "fake-model",
      promptVersion: "test-no-progress-v1",
      rawText,
      rawResponsePreview: rawText
    };
  }
}

class OverlappingRetryReviewProvider extends AlwaysEmptyReviewProvider {
  async review(input) {
    this.calls.push({ reviewScope: structuredClone(input.reviewScope) });
    const patches = this.calls.length === 1
      ? scriptClosurePatches(0).slice(0, 1)
      : input.reviewScope.actionIndexes.flatMap(scriptClosurePatches);
    const rawText = reviewResponse(patches);
    return {
      ok: true,
      status: "received",
      stage: "agent-review.provider",
      provider: "fake-overlapping-retry",
      baseUrl: "fake://agent-review",
      model: "fake-model",
      promptVersion: "test-overlapping-retry-v1",
      rawText,
      rawResponsePreview: rawText
    };
  }
}

class RepeatedWarningReviewProvider extends PartialThenCompleteReviewProvider {
  async review(input) {
    const result = await super.review(input);
    const response = JSON.parse(result.rawText);
    response.diagnostics = [{
      level: "warning",
      code: "agent.test.repeated_warning",
      path: "/workflow",
      message: "The same display-only workflow warning was observed in each batch."
    }];
    result.rawText = JSON.stringify(response);
    result.rawResponsePreview = result.rawText;
    return result;
  }
}

function sourceDraft() {
  return sampleSourceDraft({
    scripts: {
      source: "sysform-jsp",
      sources: sourceRefs.map((sourceRef, index) => ({
        id: `script-${index + 1}`,
        sourceRef,
        javascript: [
          "AttachXFormValueChangeEventById('fd_amount', function(value) {",
          `  SetXFormFieldValueById('fd_subject', 'value-${index + 1}');`,
          "  value = String(value);",
          "});"
        ].join("\n"),
        functionAudit: {
          matched: [{
            name: "SetXFormFieldValueById",
            description: "set field value",
            mkFunction: "MKXFORM.setValue('controlId', 'value')",
            occurrences: []
          }],
          violations: []
        }
      }))
    }
  });
}

function dslDraft() {
  const rebuiltScripts = draftSourceDraft(sourceDraft()).scripts;
  return sampleDraftDsl({
    scripts: rebuiltScripts
  });
}

function scriptClosurePatches(actionIndex) {
  const sourceRef = sourceRefs[actionIndex];
  const patch = (property, value, rationale) => ({
    op: "replace",
    path: `/scripts/actions/${actionIndex}/${property}`,
    value,
    sourceRefs: [sourceRef],
    evidence: [`${sourceRef} contains one SetXFormFieldValueById assignment.`],
    confidence: 0.95,
    rationale
  });

  return [
    patch(
      "function",
      `function onChange(value) {\n  MKXFORM.setValue('fd_subject', 'value-${actionIndex + 1}')\n}`,
      "Translate the source assignment to the cataloged MK API."
    ),
    patch(
      "translationStatus",
      "mapped",
      "The only source behavior is translated with no residuals."
    ),
    patch(
      "functionMappings",
      [{
        source: "SetXFormFieldValueById",
        target: "MKXFORM.setValue",
        basis: "function-catalog",
        reviewRequired: false
      }],
      "Record the catalog-backed function mapping."
    ),
    patch(
      "coverage",
      { status: "translated", nativeRules: [], residuals: [] },
      "Record complete source behavior coverage."
    )
  ];
}

function reviewResponse(patches) {
  return JSON.stringify({
    summary: "Reviewed the current script-action batch.",
    patches,
    diagnostics: []
  });
}

function actionState(actionIndex, translationStatus) {
  return {
    actionIndex,
    actionId: actionIds[actionIndex],
    translationStatus
  };
}

function batchHistoryView(batch) {
  return {
    actionIndexes: batch.actionIndexes,
    actionIds: batch.actionIds,
    acceptedPatchCount: batch.acceptedPatchCount,
    before: batch.before?.map(actionHistoryView),
    after: batch.after?.map(actionHistoryView)
  };
}

function actionHistoryView(action) {
  return {
    actionIndex: action.actionIndex,
    actionId: action.actionId,
    translationStatus: action.translationStatus
  };
}
