import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixturePath = "tests/fixtures/source/1670297c984b45009eb5b1e444d9957d";

describe("Agent Review partial native assignment prompt", () => {
  it("suggests explicit residual assignments without duplicating native row effects", () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const actionIndex = dslDraft.scripts.actions.findIndex((action) => (
      action.coverage?.status === "partial" &&
      action.coverage?.nativeRules?.length > 0 &&
      action.coverage?.residuals?.some((residual) => (
        residual.code === "script.residual.field_value_assignment"
      ))
    ));
    assert.notEqual(actionIndex, -1);

    const prompt = buildAgentReviewPrompt(sourceDraft, dslDraft, {
      compact: true,
      reviewScope: {
        actionIndexes: [actionIndex],
        actionIds: [dslDraft.scripts.actions[actionIndex].id],
        includeFormTargets: true
      }
    });
    const action = prompt.context.dslDraft.scripts.actions[0];
    const opportunity = action.reviewOpportunities.find((item) => (
      item.kind === "row_marker_visibility_candidate"
    ));
    const assignmentResiduals = action.coverage.residuals.filter((residual) => (
      residual.code === "script.residual.field_value_assignment"
    ));

    assert.deepEqual(
      assignmentResiduals.map((residual) => residual.target),
      ["fd_aqxyshift", "fd_aqxyshift"]
    );
    assert.deepEqual(opportunity.nativeRules, ["linkage.fd_3268bfe94b435c.contains.A"]);
    assert.equal(opportunity.suggestedPatchShape.function.includes("MKXFORM.setFieldAttr"), false);
    assert.match(
      opportunity.suggestedPatchShape.function,
      /MKXFORM\.setValue\("fd_aqxyshift", "A"\)/
    );
    assert.match(
      opportunity.suggestedPatchShape.function,
      /MKXFORM\.setValue\("fd_aqxyshift", ""\)/
    );
    assert.doesNotMatch(
      opportunity.suggestedPatchShape.function,
      /MKXFORM\.setValue\([^\n]*\?/
    );
    assert.deepEqual(
      opportunity.suggestedPatchShape.coverage.nativeRules,
      ["linkage.fd_3268bfe94b435c.contains.A"]
    );
    assert.equal(
      prompt.system.includes("Never combine distinct evidenced assignment values into a conditional or ternary MKXFORM.setValue argument"),
      true
    );
  });
});
