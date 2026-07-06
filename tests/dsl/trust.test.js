import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { sampleDraftDsl, sampleSourceDraft, sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("trust boundary", () => {
  it("creates and checks a trusted migration DSL with external Agent metadata", () => {
    const sourceDraft = sampleSourceDraft();
    const trusted = createTrustedMigrationDsl(sourceDraft, sampleDraftDsl({
      review: { warnings: [], reviewCandidates: [{ id: "candidate-1", status: "pending_review" }] }
    }), {
      externalAgentReviewed: true,
      reviewerName: "codex",
      checkedAt: "2026-07-06T00:00:00.000Z"
    });
    const result = checkTrust(sourceDraft, trusted);

    assert.equal(trusted.artifact, "migration-dsl");
    assert.equal(trusted.trust.level, "trusted");
    assert.equal(trusted.trust.executable, true);
    assert.equal(trusted.trust.reviewer.type, "agent");
    assert.equal(trusted.trust.reviewer.mode, "external-codex");
    assert.deepEqual(trusted.review.decisions, []);
    assert.equal(Object.hasOwn(trusted.review, "reviewCandidates"), false);
    assert.equal(result.ok, true);
  });

  it("fails blocked decisions, missing source refs, and pending executable review state", () => {
    const sourceDraft = sampleSourceDraft();
    const trusted = sampleTrustedDsl({
      review: {
        warnings: [],
        decisions: [{
          status: "blocked",
          decisionType: "rename",
          sourceRefs: [],
          targetRefs: [],
          rationale: "cannot decide",
          result: "blocked"
        }]
      },
      form: {
        fields: [{
          id: "fd_subject",
          title: "主题",
          type: "text",
          componentId: "xform-input",
          props: {},
          sourceProps: {},
          sourceRef: "source.form.control.missing"
        }]
      },
      workflow: {
        nodes: [
          { id: "N1", type: "generalStart", element: "startEvent", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "pending_review" },
          { id: "N2", type: "generalEnd", element: "endEvent", sourceRef: "source.workflow.node.N2", attributes: {}, translationStatus: "executable" }
        ]
      }
    });
    const result = checkTrust(sourceDraft, trusted);

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === "trust.review_decision_blocked"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "trust.source_ref_missing"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "trust.pending_review_executable"), true);
  });
});
