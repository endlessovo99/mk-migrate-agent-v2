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

  it("rejects formula evidence forgery, source identity replacement, and node removal", () => {
    const sourceExpression = "import java.util.List; return handlers;";
    const sourceDraft = sampleSourceDraft();
    sourceDraft.workflow.nodes[1].attributes = {
      handlerSelectType: "formula",
      handlerIds: sourceExpression,
      handlerNames: "复杂公式"
    };
    sourceDraft.workflow.nodes.push({
      id: "N3",
      sourceRef: "source.workflow.node.N3",
      attributes: { handlerSelectType: "formula", handlerIds: "$docCreator$", handlerNames: "$docCreator$" }
    });

    for (const attack of ["attributes", "identity", "deletion"]) {
      const trusted = sampleTrustedDsl();
      if (attack === "deletion") {
        trusted.workflow.nodes.splice(1, 1);
      } else {
        trusted.workflow.nodes[1] = {
          ...trusted.workflow.nodes[1],
          type: "review",
          element: "manualTask",
          sourceRef: attack === "identity" ? "source.workflow.node.N3" : "source.workflow.node.N2",
          attributes: {
            handlerSelectType: "formula",
            handlerIds: "$docCreator$",
            handlerNames: "$docCreator$"
          },
          participants: {
            mode: "doc_creator",
            sourceExpression: "$docCreator$",
            sourceNameExpression: "$docCreator$"
          }
        };
      }

      const result = checkTrust(sourceDraft, trusted);

      assert.equal(result.ok, false, attack);
      assert.equal(
        result.diagnostics.some((item) => item.code === "trust.workflow_formula_unmapped"),
        true,
        attack
      );
    }
  });

  it("rejects extra mapped formula claims and target field substitution", () => {
    const plainSource = sampleSourceDraft();
    const extraClaim = sampleTrustedDsl();
    extraClaim.workflow.nodes[1].participants = {
      mode: "doc_creator",
      sourceExpression: "$docCreator$",
      sourceNameExpression: "$docCreator$"
    };
    const extraClaimResult = checkTrust(plainSource, extraClaim);

    assert.equal(extraClaimResult.ok, false);
    assert.equal(
      extraClaimResult.diagnostics.some((item) => item.code === "trust.workflow_formula_provenance_mismatch"),
      true
    );

    const formula = "$组织架构.根据登录名取用户$($fd_subject$)";
    const formulaSource = sampleSourceDraft();
    formulaSource.workflow.nodes[1].attributes = {
      handlerSelectType: "formula",
      handlerIds: formula,
      handlerNames: "$组织架构.根据登录名取用户$($主题$)"
    };
    const wrongField = sampleTrustedDsl();
    const wrongTarget = wrongField.form.fields.find((field) => field.id === "fd_amount");
    const authoritativeTarget = wrongField.form.fields.find((field) => field.id === "fd_subject");
    wrongTarget.sourceProps.originalId = "fd_subject";
    wrongTarget.sourceRef = authoritativeTarget.sourceRef;
    wrongField.workflow.nodes[1] = {
      ...wrongField.workflow.nodes[1],
      type: "review",
      element: "manualTask",
      attributes: formulaSource.workflow.nodes[1].attributes,
      participants: {
        mode: "person_by_login_name",
        fieldId: "fd_amount",
        sourceFieldId: "fd_subject",
        fieldTitle: "主题",
        sourceExpression: formula,
        sourceNameExpression: "$组织架构.根据登录名取用户$($主题$)"
      }
    };
    const wrongFieldResult = checkTrust(formulaSource, wrongField);

    assert.equal(wrongFieldResult.ok, false);
    assert.equal(
      wrongFieldResult.diagnostics.some((item) => item.code === "trust.workflow_formula_provenance_mismatch"),
      true
    );
  });
});
