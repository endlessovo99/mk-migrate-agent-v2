import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAgentReview } from "../../src/agent-review/index.js";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const SOURCE_DIR = "tests/fixtures/source4/178671ba7493e3a9d35d8f740e28fd89";
const FIELD_ID = "fd_year_month";
const FIELD_SOURCE_REF = `source.form.control.${FIELD_ID}`;

describe("Agent Review deterministic month fields", () => {
  it("does not expose source-proven yyyy-MM type and component paths", () => {
    const { source, draft, fieldIndex } = fixtureStages();
    const prompt = buildAgentReviewPrompt(source, draft, {
      reviewScope: {
        actionIndexes: [],
        actionIds: [],
        includeFormTargets: true
      }
    });

    assert.equal(
      prompt.context.allowedConcretePatchPaths.includes(`/form/fields/${fieldIndex}/type`),
      false
    );
    assert.equal(
      prompt.context.allowedConcretePatchPaths.includes(`/form/fields/${fieldIndex}/componentId`),
      false
    );
    assert.equal(
      prompt.context.allowedConcretePatchPaths.includes(`/form/fields/${fieldIndex}/props`),
      true
    );
  });

  for (const testCase of [
    { property: "type", value: "text" },
    { property: "componentId", value: "xform-input" }
  ]) {
    it(`rejects a provider attempt to downgrade month ${testCase.property}`, async () => {
      const { source, draft, fieldIndex } = fixtureStages();
      const patchPath = `/form/fields/${fieldIndex}/${testCase.property}`;
      const result = await runAgentReview(source, draft, {
        provider: providerWithPatches([patch(patchPath, testCase.value)]),
        maxRepairAttempts: 0
      });

      assert.equal(result.ok, false);
      assert.equal(result.report.stage, "agent-review.patch-validation");
      assert.equal(result.report.diagnostics.length, 1);
      assert.equal(
        result.report.diagnostics[0].code,
        "agent.patch.deterministic_month_component_changed"
      );
      assert.equal(result.report.rejectedPatches[0].path, patchPath);
    });
  }
});

function fixtureStages() {
  const source = cleanSourceFile(SOURCE_DIR);
  const draft = draftSourceDraft(source);
  const fieldIndex = draft.form.fields.findIndex((field) => field.id === FIELD_ID);
  assert.notEqual(fieldIndex, -1);
  assert.equal(draft.form.fields[fieldIndex].type, "dateTime");
  assert.equal(draft.form.fields[fieldIndex].componentId, "xform-datetime");
  return { source, draft, fieldIndex };
}

function patch(path, value) {
  return {
    op: "replace",
    path,
    value,
    sourceRefs: [FIELD_SOURCE_REF],
    evidence: ["The source metadata stores the field as a string."],
    confidence: 0.95,
    rationale: "Mirror the source metadata type."
  };
}

function providerWithPatches(patches) {
  const rawText = JSON.stringify({
    summary: "Reviewed the deterministic month field.",
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
