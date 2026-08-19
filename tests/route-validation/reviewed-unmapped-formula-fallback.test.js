import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkExecute } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixturePath =
  "tests/fixtures/source2/16e24f066c3f14729bd22cb470990511";

describe("Route-validation reviewed unmapped formula fallback", () => {
  it("allows an exact, decision-backed person fallback while rejecting an unaudited one", () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const nodeIndex = dslDraft.workflow.nodes.findIndex((node) => node.id === "N6");
    const node = dslDraft.workflow.nodes[nodeIndex];
    const sourceExpression = node.participants.sourceExpression;

    node.translationStatus = "executable";
    node.participants = {
      mode: "configured_person_fallback",
      fallbackKind: "person",
      fallbackScope: "reviewed_unmapped_formula",
      reason: "User authorized a temporary person fallback for this unmapped formula.",
      sourceExpression,
      sourceNameExpression: node.participants.sourceNameExpression
    };

    const withoutDecision = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-07-29T00:00:00.000Z"
    });
    assert.equal(
      checkTrust(sourceDraft, withoutDecision).diagnostics.some(
        (item) => item.code === "trust.workflow_formula_unmapped"
      ),
      true
    );

    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-07-29T00:00:00.000Z",
      decisions: [{
        id: "fallback-N6",
        status: "accepted",
        decisionType: "workflow_formula_person_fallback",
        sourceRefs: [node.sourceRef],
        targetRefs: [`/workflow/nodes/${nodeIndex}/participants`],
        rationale: "The user authorized a temporary person fallback for the exact source formula.",
        result: "configured_person_fallback"
      }]
    });

    assert.equal(checkTrust(sourceDraft, trusted).ok, true);
    assert.equal(checkExecute(trusted).ok, true);
  });
});
