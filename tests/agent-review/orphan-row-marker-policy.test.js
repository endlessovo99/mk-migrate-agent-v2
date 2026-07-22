import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAgentReview } from "../../src/agent-review/index.js";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { buildScriptBranchProvenance } from "../../src/dsl/script-branch-provenance.js";
import { sampleDraftDsl, sampleSourceDraft } from "../helpers/sample-dsl.js";

const sourceRef = "source.form.jsp.invoice-way.script.1";
const warningCode = "source.sysform.script_row_marker_orphan_noop";
const resolvedMarker = "invoice_row10";
const secondResolvedMarker = "invoice_row4";
const orphanMarker = "invoice_row11";

describe("Agent Review orphan row-marker policy", () => {
  it("requires an explicit action-body boundary before treating a bare program as onLoad", () => {
    const implicit = buildScriptBranchProvenance({
      event: "onLoad",
      source: sourceJavascript(),
      sourceRef
    });
    const explicitButUnrelatedOnChange = buildScriptBranchProvenance({
      event: "onChange",
      source: "var unrelated = '11'; if (unrelated === '11') { doSomething(); }",
      sourceRef,
      programIsEntrypoint: true
    });

    assert.equal(implicit.status, "unproven");
    assert.equal(implicit.reason, "action_entrypoint_unproven");
    assert.equal(explicitButUnrelatedOnChange.status, "unproven");
  });

  it("separates resolved markers from warning-proven auditable orphan no-ops", () => {
    const prompt = buildAgentReviewPrompt(sourceDraft(), dslDraft());
    const action = prompt.context.dslDraft.scripts.actions[0];
    const opportunity = action.reviewOpportunities.find(
      (item) => item.kind === "row_marker_visibility_candidate"
    );

    assert.equal(
      prompt.system.includes("source.sysform.script_row_marker_orphan_noop"),
      true
    );
    assert.equal(
      prompt.system.includes("Never generate MKXFORM.setFieldAttr for an orphan marker"),
      true
    );
    assert.equal(prompt.context.sourceDraft.issues[0].code, warningCode);
    assert.deepEqual(opportunity.resolvedRowMarkers, [resolvedMarker, secondResolvedMarker]);
    assert.deepEqual(opportunity.orphanRowMarkers, [orphanMarker]);
    assert.deepEqual(opportunity.unresolvedRowMarkers, []);
    assert.equal(opportunity.suggestedPatchShape.function.includes(resolvedMarker), true);
    assert.equal(opportunity.suggestedPatchShape.function.includes(secondResolvedMarker), true);
    assert.equal(opportunity.suggestedPatchShape.function.includes(orphanMarker), false);
    assert.equal(opportunity.coverageDecision.includes("preserve the Source Draft warning"), true);
  });

  it("keeps a missing marker unresolved when its warning evidence is not exact", () => {
    const invalidEvidenceCases = [
      ["sourceRef mismatch", (evidence) => { evidence.sourceRef = "source.form.jsp.other"; }],
      ["incomplete proof", (evidence) => { evidence.proof.onlyHelperTarget = false; }],
      ["unaudited reset values", (evidence) => { evidence.proof.resetValuesAudited = false; }],
      ["dynamic DOM creation", (evidence) => { evidence.proof.dynamicDomCreationDetected = true; }],
      ["invalid resetValues", (evidence) => { evidence.markers[0].resetValues = [true]; }],
      ["non-canonical resetValues", (evidence) => { evidence.markers[0].resetValues = [false, false]; }],
      ["invalid occurrenceCount", (evidence) => { evidence.markers[0].occurrenceCount = 1; }]
    ];

    for (const [label, invalidate] of invalidEvidenceCases) {
      const source = sourceDraft();
      invalidate(source.issues[0].evidence);
      const prompt = buildAgentReviewPrompt(source, dslDraft());
      const opportunity = prompt.context.dslDraft.scripts.actions[0].reviewOpportunities.find(
        (item) => item.kind === "row_marker_visibility_candidate"
      );

      assert.deepEqual(opportunity.resolvedRowMarkers, [resolvedMarker, secondResolvedMarker], label);
      assert.deepEqual(opportunity.orphanRowMarkers, [], label);
      assert.deepEqual(opportunity.unresolvedRowMarkers, [orphanMarker], label);
      assert.equal(opportunity.suggestedPatchShape, undefined, label);
      assert.equal(opportunity.coverageDecision.includes("keep needs_review"), true, label);
    }
  });

  it("reports a warning-proven orphan even when the action has no resolved row marker", () => {
    const source = sourceDraft();
    const draft = dslDraft();
    const orphanOnlySource = [
      `common_dom_row_set_show_required_reset('${orphanMarker}', true, true, false);`,
      `common_dom_row_set_show_required_reset('${orphanMarker}', false, false, false);`
    ].join("\n");
    source.scripts.sources[0].javascript = orphanOnlySource;
    source.scripts.sources[0].semanticFacts = {
      rowMarkers: [
        { rowId: orphanMarker, reset: false },
        { rowId: orphanMarker, reset: false }
      ]
    };
    draft.scripts.actions[0].function = sourceBackedPlaceholder(orphanOnlySource);
    for (const row of draft.form.layout.mkTree) delete row.sourceMarkers;

    const prompt = buildAgentReviewPrompt(source, draft);
    const opportunity = prompt.context.dslDraft.scripts.actions[0].reviewOpportunities.find(
      (item) => item.kind === "row_marker_visibility_candidate"
    );

    assert.deepEqual(opportunity.resolvedRowMarkers, []);
    assert.deepEqual(opportunity.orphanRowMarkers, [orphanMarker]);
    assert.deepEqual(opportunity.unresolvedRowMarkers, []);
    assert.equal(opportunity.suggestedPatchShape, undefined);
  });

  it("accepts a residual translation that omits the auditable no-op and retains its warning", async () => {
    const result = await runAgentReview(sourceDraft(), dslDraft(), {
      provider: providerWithPatches(validResidualPatches()),
      reviewedAt: "2026-07-11T00:00:00.000Z",
      maxRepairAttempts: 0
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "needs_manual");
    assert.equal(result.dsl.trust.level, "trusted");
    assert.equal(result.dsl.scripts.actions[0].translationStatus, "mapped");
    assert.equal(result.dsl.scripts.actions[0].function.includes(resolvedMarker), true);
    assert.equal(result.dsl.scripts.actions[0].function.includes(secondResolvedMarker), true);
    assert.equal(result.dsl.scripts.actions[0].function.includes(orphanMarker), false);
    assert.equal(
      result.dsl.review.warnings.some((warning) => warning.code === warningCode),
      true
    );
  });

  it("rejects action closure when orphan evidence does not exactly match source facts", async () => {
    const source = sourceDraft();
    source.issues[0].evidence.markers[0].occurrenceCount = 1;

    const result = await runAgentReview(source, dslDraft(), {
      provider: providerWithPatches(validResidualPatches()),
      reviewedAt: "2026-07-11T00:00:00.000Z",
      maxRepairAttempts: 0
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.patch-validation");
    assert.equal(result.report.diagnostics.some((diagnostic) =>
      diagnostic.code === "agent.patch.row_marker_orphan_evidence_invalid" &&
      diagnostic.details?.unresolvedRowMarkers?.includes(orphanMarker)
    ), true);
  });
});

function sourceDraft() {
  return sampleSourceDraft({
    workflow: undefined,
    scripts: {
      source: "sysform-jsp",
      sources: [{
        id: "invoice-way.script.1",
        sourceRef,
        javascript: sourceJavascript(),
        functionAudit: { matched: [], violations: [] },
        semanticFacts: { rowMarkers: sourceRowMarkerFacts() }
      }]
    },
    issues: [sourceWarning()]
  });
}

function dslDraft() {
  const draft = sampleDraftDsl({
    workflow: undefined,
    scripts: {
      source: "sysform-jsp",
      actions: [{
        id: "invoice-way.script.1.event.1",
        name: "onLoad",
        event: "onLoad",
        scope: "global",
        function: sourceBackedPlaceholder(),
        sourceRefs: [sourceRef],
        branchProvenance: buildScriptBranchProvenance({
          event: "onLoad",
          source: sourceJavascript(),
          sourceRef,
          programIsEntrypoint: true
        }),
        translationStatus: "needs_review",
        coverage: { status: "uncovered", nativeRules: [], residuals: [] },
        functionMappings: []
      }]
    },
    review: {
      warnings: [{
        code: warningCode,
        message: "invoice_row11 has no current source layout target and is an auditable no-op.",
        path: "/scripts/sources/0/semanticFacts/rowMarkers",
        details: warningEvidence()
      }],
      reviewCandidates: []
    }
  });
  draft.form.layout.mkTree[0].sourceMarkers = [resolvedMarker];
  draft.form.layout.mkTree[1].sourceMarkers = [secondResolvedMarker];
  return draft;
}

function sourceWarning() {
  return {
    level: "warning",
    code: warningCode,
    message: "invoice_row11 has no current source layout target and is an auditable no-op.",
    sourcePath: "/scripts/sources/0/semanticFacts/rowMarkers",
    evidence: warningEvidence()
  };
}

function warningEvidence() {
  return {
    sourceRef,
    helper: "common_dom_row_set_show_required_reset",
    markers: [{ rowId: orphanMarker, occurrenceCount: 2, resetValues: [false] }],
    proof: {
      absentFromLayout: true,
      onlyHelperTarget: true,
      resetValuesAudited: true,
      dynamicDomCreationDetected: false
    }
  };
}

function sourceJavascript() {
  return [
    "var way = GetXFormFieldValueById('fd_amount')[0];",
    "if (way === '11') {",
    `  common_dom_row_set_show_required_reset('${resolvedMarker}', true, true, false);`,
    `  common_dom_row_set_show_required_reset('${secondResolvedMarker}', true, true, false);`,
    `  common_dom_row_set_show_required_reset('${orphanMarker}', true, true, false);`,
    "} else {",
    `  common_dom_row_set_show_required_reset('${resolvedMarker}', false, false, false);`,
    `  common_dom_row_set_show_required_reset('${secondResolvedMarker}', false, false, false);`,
    `  common_dom_row_set_show_required_reset('${orphanMarker}', false, false, false);`,
    "}"
  ].join("\n");
}

function sourceRowMarkerFacts() {
  return [
    { rowId: resolvedMarker, reset: false },
    { rowId: secondResolvedMarker, reset: false },
    { rowId: orphanMarker, reset: false },
    { rowId: resolvedMarker, reset: false },
    { rowId: secondResolvedMarker, reset: false },
    { rowId: orphanMarker, reset: false }
  ];
}

function sourceBackedPlaceholder(javascript = sourceJavascript()) {
  return [
    "function onLoad() {",
    "  // Source JSP JavaScript:",
    ...javascript.split("\n").map((line) => `  // ${line}`),
    "}"
  ].join("\n");
}

function translatedFunction() {
  return [
    "function onLoad() {",
    "  var rawWay = MKXFORM.getValue('fd_amount')",
    "  var way = Array.isArray(rawWay) ? rawWay[0] : rawWay",
    "  var directEntry = way === '11'",
    `  MKXFORM.setFieldAttr('${resolvedMarker}', directEntry ? 5 : 4)`,
    `  MKXFORM.setFieldAttr('${resolvedMarker}', directEntry ? 3 : 6)`,
    `  MKXFORM.setFieldAttr('${secondResolvedMarker}', directEntry ? 5 : 4)`,
    `  MKXFORM.setFieldAttr('${secondResolvedMarker}', directEntry ? 3 : 6)`,
    "}"
  ].join("\n");
}

function validResidualPatches() {
  return [
    patch("/scripts/actions/0/function", translatedFunction()),
    patch("/scripts/actions/0/translationStatus", "mapped"),
    patch("/scripts/actions/0/functionMappings", [{
      source: "GetXFormFieldValueById + common_dom_row_set_show_required_reset",
      target: "MKXFORM.getValue + MKXFORM.setFieldAttr",
      basis: "semantic-translation",
      reviewRequired: false
    }]),
    patch("/scripts/actions/0/coverage", {
      status: "translated",
      nativeRules: [],
      residuals: []
    })
  ];
}

function patch(path, value) {
  return {
    op: "replace",
    path,
    value,
    sourceRefs: [sourceRef],
    evidence: [
      "The Source Draft warning proves invoice_row11 is an auditable orphan no-op; invoice_row10 resolves in the current layout."
    ],
    confidence: 0.95,
    rationale: "Translate the resolved row behavior without inventing an MK target for the orphan marker."
  };
}

function providerWithPatches(patches) {
  const rawText = JSON.stringify({
    summary: "Translated the resolved invoice row and preserved the orphan warning.",
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
