import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { resolveRouteFixture } from "./fixture.js";
import { runRouteCase } from "./run-route-case.js";

describe("audited orphan row-marker Route case", { concurrency: false }, () => {
  it("proves reset-bearing missing row markers inert from complete source evidence", () => {
    const source = cleanSourceFile("tests/fixtures/source/18a8c4df333fef9872595a24f1795e71");
    const draft = draftSourceDraft(source);
    const warning = source.issues.find((issue) =>
      issue.code === "source.sysform.script_row_marker_orphan_noop" &&
      issue.evidence?.markers?.some((marker) => marker.rowId === "fd_xhqd_row")
    );

    assert.equal(warning.evidence.proof.absentFromLayout, true);
    assert.equal(warning.evidence.proof.onlyHelperTarget, true);
    assert.equal(warning.evidence.proof.resetValuesAudited, true);
    assert.equal(warning.evidence.proof.dynamicDomCreationDetected, false);

    const actionIndexes = draft.scripts.actions
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => action.sourceRefs?.includes("source.form.jsp.fd_3c342374884666.script.1") ||
        action.sourceRefs?.includes("source.form.jsp.fd_3c342374884666.script.2"))
      .map(({ index }) => index);
    assert.deepEqual(actionIndexes, [2, 3, 4]);

    const prompt = buildAgentReviewPrompt(source, draft, {
      reviewScope: { actionIndexes, includeFormTargets: false }
    });
    for (const action of prompt.context.dslDraft.scripts.actions) {
      const opportunity = action.reviewOpportunities.find((item) =>
        item.kind === "row_marker_visibility_candidate"
      );
      assert.equal(opportunity.orphanRowMarkers.includes("fd_xhqd_row"), true);
      assert.deepEqual(opportunity.unresolvedRowMarkers, []);
    }
  });

  it("promotes the two supported actions through trusted DSL and fake NewOA readback", async () => {
    const result = await runRouteCase("row-marker-orphan-noop-success");

    assert.equal(result.dsl.artifact, "migration-dsl");
    assert.equal(result.dsl.trust.executable, true);
    assert.equal(result.review.status, "needs_manual");
    assert.equal(result.review.diagnostics.some((item) =>
      item.code === "route.review.audited_orphan_marker_noop"
    ), true);

    const sourceMarkers = result.dsl.form.layout.mkTree
      .flatMap((row) => row.sourceMarkers || []);
    assert.deepEqual(sourceMarkers, ["invoice_row10", "invoice_row4"]);
    assert.deepEqual(
      result.dsl.form.fields.find((field) => field.id === "fd_way")?.props?.options,
      [{ label: "Single", value: "11" }, { label: "Batch", value: "22" }]
    );
    assert.equal(
      result.dsl.form.fields.find((field) => field.id === "wayTemp")?.dataOnly,
      true
    );

    assert.equal(result.dsl.scripts.actions.length, 2);
    assert.deepEqual(
      result.dsl.scripts.actions.map((action) => action.event),
      ["onChange", "onLoad"]
    );
    assert.equal(result.dsl.scripts.actions.every((action) =>
      action.translationStatus === "mapped" &&
      action.coverage?.status === "translated" &&
      action.coverage?.residuals?.length === 0
    ), true);

    const translatedJavascript = result.dsl.scripts.actions
      .map((action) => action.function)
      .join("\n");
    assert.match(translatedJavascript, /MKXFORM\.setFieldAttr\(["']invoice_row10["']/);
    assert.match(translatedJavascript, /MKXFORM\.setFieldAttr\(["']invoice_row4["']/);
    assert.match(translatedJavascript, /MKXFORM\.(?:getValue|setValue)\(["']wayTemp["']/);
    assert.doesNotMatch(translatedJavascript, /invoice_row11|invoice_row111/);

    assert.equal(result.dsl.review.warnings.some((item) =>
      item.code === "source.sysform.row_marker_id_name_mismatch"
    ), true);
    assert.equal(result.dsl.review.warnings.some((item) =>
      item.code === "source.sysform.script_row_marker_orphan_noop"
    ), true);
    assert.equal(result.dryRun.ok, true);
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.status, "written_with_warnings");
    assert.equal(result.execution.readback.form.scripts.persistedActionCount, 2);
    assert.deepEqual(result.transcript.map((entry) => entry.operation), [
      "login",
      "init",
      "generate-table-name",
      "load-parent-category",
      "add",
      "get-before-update",
      "update",
      "get-readback"
    ]);
  });

  it("does not close an action when any orphan no-op proof is missing", async () => {
    const provider = createFakeReviewProvider("audited-row-marker-orphan-noop");
    const sourcePath = resolveRouteFixture({
      kind: "form-only",
      relativePath: "row-marker-orphan/route-row-marker-orphan_SysFormTemplate.xml"
    });
    const sourceDraft = cleanSourceFile(sourcePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const completeProof = sourceDraft.issues.find((issue) =>
      issue.code === "source.sysform.script_row_marker_orphan_noop"
    ).evidence.proof;

    for (const proofKey of Object.keys(completeProof)) {
      const incompleteSourceDraft = structuredClone(sourceDraft);
      for (const issue of orphanIssues(incompleteSourceDraft)) {
        delete issue.evidence.proof[proofKey];
      }
      const response = await provider.review({
        sourceDraft: incompleteSourceDraft,
        dslDraft,
        reviewScope: { actionIndexes: [0, 1] }
      });
      const review = JSON.parse(response.rawText);

      assert.deepEqual(review.patches, [], `missing proof field ${proofKey}`);
      assert.deepEqual(review.diagnostics, [], `missing proof field ${proofKey}`);
    }

    const auditMutations = [{
      name: "warning level",
      apply(issue) { issue.level = "error"; }
    }, {
      name: "source ref",
      apply(issue) { issue.evidence.sourceRef = "source.form.jsp.other"; }
    }, {
      name: "helper identity",
      apply(issue) { issue.evidence.helper = "other_helper"; }
    }, {
      name: "marker evidence",
      apply(issue) { issue.evidence.markers = []; }
    }, {
      name: "reset evidence",
      apply(issue) { issue.evidence.markers[0].resetValues = [true]; }
    }, {
      name: "non-canonical reset evidence",
      apply(issue) { issue.evidence.markers[0].resetValues = [false, false]; }
    }, {
      name: "occurrence count",
      apply(issue) { issue.evidence.markers[0].occurrenceCount += 1; }
    }];
    for (const mutation of auditMutations) {
      const invalidSourceDraft = structuredClone(sourceDraft);
      for (const issue of orphanIssues(invalidSourceDraft)) mutation.apply(issue);
      const response = await provider.review({
        sourceDraft: invalidSourceDraft,
        dslDraft,
        reviewScope: { actionIndexes: [0, 1] }
      });
      const review = JSON.parse(response.rawText);

      assert.deepEqual(review.patches, [], `invalid ${mutation.name}`);
      assert.deepEqual(review.diagnostics, [], `invalid ${mutation.name}`);
    }

    const missingHelperDsl = structuredClone(dslDraft);
    missingHelperDsl.form.fields = missingHelperDsl.form.fields.filter((field) => field.id !== "wayTemp");
    const response = await provider.review({
      sourceDraft,
      dslDraft: missingHelperDsl,
      reviewScope: { actionIndexes: [0, 1] }
    });
    const review = JSON.parse(response.rawText);
    assert.deepEqual(review.patches, [], "missing helper field target");
    assert.deepEqual(review.diagnostics, [], "missing helper field target");
  });
});

function orphanIssues(sourceDraft) {
  return sourceDraft.issues.filter((issue) =>
    issue.code === "source.sysform.script_row_marker_orphan_noop"
  );
}
