import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixture = "tests/fixtures/route-validation/conditional-parallel";

describe("conditional-parallel route semantics", () => {
  it("carries conditional fan-out and dynamic submitter semantics through trust and dry-run", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const split = draft.workflow.nodes.find((node) => node.id === "PX20");
    const join = draft.workflow.nodes.find((node) => node.id === "PX50");
    const conditionalEdges = draft.workflow.edges.filter((edge) => edge.source === "PX20");

    assert.equal(split.type, "split");
    assert.equal(split.attributes.splitType, "condition");
    assert.equal(join.type, "join");
    assert.equal(join.attributes.joinType, "all");
    assert.equal(conditionalEdges.every((edge) => edge.condition.translationStatus === "executable"), true);
    assert.equal(conditionalEdges.every((edge) => edge.condition.critical === true), true);
    assert.equal(draft.workflow.nodes.find((node) => node.id === "PX60").participants.mode, "doc_creator");
    assert.equal(draft.workflow.nodes.find((node) => node.id === "PX70").participants.mode, "explicit");

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-07-14T00:00:00.000Z"
    });
    assert.equal(checkTrust(source, trusted).ok, true);
    assert.equal(buildDryRunPlan(trusted).ok, true);
  });

  it("keeps ordinary parallel and exclusive-branch semantics distinct", () => {
    const ordinarySource = cleanSourceFile(fixture);
    ordinarySource.workflow.nodes.find((node) => node.id === "PX20").attributes.splitType = "all";
    for (const edge of ordinarySource.workflow.edges.filter((edge) => edge.source === "PX20")) {
      edge.condition = "";
      edge.displayCondition = "";
    }
    const ordinary = draftSourceDraft(ordinarySource);
    assert.equal(ordinary.workflow.nodes.find((node) => node.id === "PX20").translationStatus, "executable");
    assert.equal(
      ordinary.workflow.edges.filter((edge) => edge.source === "PX20")
        .every((edge) => edge.condition.critical === undefined && edge.condition.translationStatus === "executable"),
      true
    );

    const exclusiveSource = cleanSourceFile("tests/fixtures/route-validation/conditional-detail");
    const exclusive = draftSourceDraft(exclusiveSource);
    const exclusiveEdges = exclusive.workflow.edges.filter((edge) => edge.source === "N3" && edge.condition.sourceText);
    assert.equal(exclusiveEdges.length > 0, true);
    assert.equal(exclusiveEdges.every((edge) => edge.condition.translationStatus === "display_only"), true);
    assert.equal(exclusiveEdges.every((edge) => edge.condition.critical === undefined), true);
  });

  it("requires bracketed virtual-role evidence before treating a dynamic name as the document creator", () => {
    const source = cleanSourceFile(fixture);
    const ordinary = source.workflow.nodes.find((node) => node.id === "PX70");
    ordinary.attributes.handlerNames = "<申请人>";
    ordinary.handlerEntities = [{
      id: "ordinary-person-91",
      name: "<申请人>",
      orgType: 8,
      class: "com.landray.kmss.sys.organization.model.SysOrgElement"
    }];

    const draft = draftSourceDraft(source);
    assert.equal(draft.workflow.nodes.find((node) => node.id === "PX60").participants.mode, "doc_creator");
    assert.equal(draft.workflow.nodes.find((node) => node.id === "PX70").participants.mode, "explicit");
  });

  it("fails closed when a conditional-parallel formula is outside the supported structure", () => {
    const source = cleanSourceFile(fixture);
    source.workflow.edges.find((edge) => edge.id === "PE21").condition = "$legacy.custom$($fd_route_choice$)";
    const draft = draftSourceDraft(source);
    const edge = draft.workflow.edges.find((item) => item.id === "PE21");
    assert.equal(edge.condition.translationStatus, "display_only");
    assert.equal(edge.condition.critical, true);

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-07-14T00:00:00.000Z"
    });
    const trust = checkTrust(source, trusted);
    assert.equal(trust.ok, false);
    assert.equal(trust.diagnostics.some((item) => item.code === "dsl.workflow.condition_not_executable"), true);
  });

  it("fails closed when a non-default conditional-parallel route loses its condition", () => {
    const source = cleanSourceFile(fixture);
    const sourceEdge = source.workflow.edges.find((edge) => edge.id === "PE21");
    sourceEdge.condition = "";
    sourceEdge.displayCondition = "";
    const draft = draftSourceDraft(source);
    const edge = draft.workflow.edges.find((item) => item.id === "PE21");
    assert.equal(edge.condition.translationStatus, "pending_review");
    assert.equal(edge.condition.critical, true);

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-07-14T00:00:00.000Z"
    });
    assert.equal(checkTrust(source, trusted).ok, false);
  });

  it("supports OR expressions wrapped in balanced outer parentheses", () => {
    const source = cleanSourceFile(fixture);
    source.workflow.edges.find((edge) => edge.id === "PE21").condition =
      '((($fd_route_choice$.equals("A"))) || (($fd_route_choice$ == "B")))';
    const draft = draftSourceDraft(source);
    const edge = draft.workflow.edges.find((item) => item.id === "PE21");
    assert.equal(edge.condition.translationStatus, "executable");
    assert.equal(edge.condition.critical, true);
  });

  it("does not treat a named other route as executable without native default evidence", () => {
    const source = cleanSourceFile(fixture);
    const sourceEdge = source.workflow.edges.find((edge) => edge.id === "PE21");
    sourceEdge.name = "其他";
    sourceEdge.condition = "$legacy.custom$($fd_route_choice$)";
    const draft = draftSourceDraft(source);
    const edge = draft.workflow.edges.find((item) => item.id === "PE21");
    assert.equal(edge.condition.translationStatus, "display_only");
    assert.equal(edge.condition.critical, true);
  });
});
