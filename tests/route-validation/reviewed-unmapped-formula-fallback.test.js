import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkExecute } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixturePath =
  "tests/fixtures/route-validation/unmapped-formula";
const roleLineFixturePath =
  "tests/fixtures/source2/16e24f066c3f14729bd22cb470990511";

describe("Route-validation reviewed unmapped formula fallback", () => {
  it("allows an exact, decision-backed person fallback while rejecting an unaudited one", () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const nodeIndex = dslDraft.workflow.nodes.findIndex((node) => node.id === "N7");
    const node = dslDraft.workflow.nodes[nodeIndex];
    const sourceExpression = node.participants.sourceExpression;

    node.translationStatus = "executable";
    node.participants = {
      mode: "configured_person_fallback",
      fallbackKind: "person",
      fallbackScope: "reviewed_unmapped_formula",
      formulaFamily: node.participants.formulaFamily,
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

  it("never replaces a malformed role-line formula with a reviewed person fallback", () => {
    for (const handlerPrefix of ["", "return "]) {
      const sourceDraft = cleanSourceFile(roleLineFixturePath);
      const sourceNode = sourceDraft.workflow.nodes.find((node) => node.id === "N6");
      for (const attributes of [sourceNode.attributes, sourceNode.definition?.attributes].filter(Boolean)) {
        attributes.handlerIds = `${handlerPrefix}${attributes.handlerIds}`;
        attributes.handlerNames = "$无法解析的显示公式$";
      }
      const dslDraft = draftSourceDraft(sourceDraft);
      const nodeIndex = dslDraft.workflow.nodes.findIndex((node) => node.id === "N6");
      const node = dslDraft.workflow.nodes[nodeIndex];
      const sourceExpression = node.participants.sourceExpression;

      assert.equal(node.participants.formulaFamily, "role_line");
      node.translationStatus = "executable";
      node.participants = {
        mode: "configured_person_fallback",
        fallbackKind: "person",
        fallbackScope: "reviewed_unmapped_formula",
        formulaFamily: "role_line",
        reason: "A person fallback must not erase role-line semantics.",
        sourceExpression,
        sourceNameExpression: "$无法解析的显示公式$"
      };
      const candidate = createTrustedMigrationDsl(sourceDraft, dslDraft, {
        externalAgentReviewed: true,
        reviewerName: "route-validation",
        checkedAt: "2026-08-30T00:00:00.000Z",
        decisions: [{
          id: `forbidden-role-line-fallback-N6-${handlerPrefix ? "wrapped" : "direct"}`,
          status: "accepted",
          decisionType: "workflow_formula_person_fallback",
          sourceRefs: [node.sourceRef],
          targetRefs: [`/workflow/nodes/${nodeIndex}/participants`],
          rationale: "Attempted fallback for a malformed role-line display formula.",
          result: "configured_person_fallback"
        }]
      });
      const trust = checkTrust(sourceDraft, candidate);

      assert.equal(trust.ok, false);
      assert.equal(
        trust.diagnostics.some((item) => item.code === "trust.workflow_formula_unmapped"),
        true
      );
      assert.equal(checkExecute(candidate).ok, false);
    }
  });
});
