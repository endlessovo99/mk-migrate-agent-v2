import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

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

  it("independently detects gateway mode, condition, and submitter readback loss", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-07-14T00:00:00.000Z"
    });
    const prepared = prepareSample(trusted);
    assert.equal(prepared.verify(prepared.update).ok, true);

    const gatewayMutation = structuredClone(prepared.update);
    mutateWorkflow(gatewayMutation, (content) => {
      content.elements.find((element) => element.id === "PX20").splitType = "0";
    });
    assert.equal(
      prepared.verify(gatewayMutation).diagnostics.some((item) => item.code === "readback.workflow.parallel_gateway_mismatch"),
      true
    );

    for (const [name, mutate] of [
      ["split related node", (content) => {
        content.elements.find((element) => element.id === "PX20").relateId = "PX99";
      }],
      ["split direction", (content) => {
        content.elements.find((element) => element.id === "PX20").gatewayDirection = "converging";
      }],
      ["join mode", (content) => {
        content.elements.find((element) => element.id === "PX50").joinType = "0";
      }],
      ["join related node", (content) => {
        content.elements.find((element) => element.id === "PX50").relateId = "PX99";
      }],
      ["join direction", (content) => {
        content.elements.find((element) => element.id === "PX50").gatewayDirection = "diverging";
      }]
    ]) {
      const mutation = structuredClone(prepared.update);
      mutateWorkflow(mutation, mutate);
      assert.equal(
        prepared.verify(mutation).diagnostics.some((item) => item.code === "readback.workflow.parallel_gateway_mismatch"),
        true,
        name
      );
    }

    const conditionMutation = structuredClone(prepared.update);
    mutateWorkflow(conditionMutation, (content) => {
      const edge = content.elements.find((element) => element.id === "PE21");
      edge.formula = "";
      edge.formulaName = "";
    });
    assert.equal(
      prepared.verify(conditionMutation).diagnostics.some((item) => item.code === "readback.workflow.edge_condition_native_missing"),
      true
    );

    const conditionSemanticMutation = structuredClone(prepared.update);
    mutateWorkflow(conditionSemanticMutation, (content) => {
      content.elements.find((element) => element.id === "PE21").formula = '$fd_route_choice$.equals("WRONG")';
    });
    assert.equal(
      prepared.verify(conditionSemanticMutation).diagnostics.some((item) =>
        item.code === "readback.workflow.edge_condition_native_semantic_mismatch"
      ),
      true
    );

    const participantMutation = structuredClone(prepared.update);
    mutateWorkflow(participantMutation, (content) => {
      const node = content.elements.find((element) => element.id === "PX60");
      node.handlers = { type: "org", source: "1", members: [] };
    });
    assert.equal(
      prepared.verify(participantMutation).diagnostics.some((item) => item.code === "readback.workflow.participant_mismatch"),
      true
    );
  });

  it("repairs only conditional-parallel and document-creator semantics on an existing workflow", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-07-14T00:00:00.000Z"
    });
    const fullyProjected = prepareSample(trusted).update;
    const baseline = structuredClone(fullyProjected);
    const baselineLbpm = baseline.mechanisms.lbpmTemplate[0];
    baselineLbpm.fdTemplateFormAuths = {
      PX31: {
        fd_route_choice: {
          isShow: true,
          isEdit: false,
          isRequire: false
        }
      }
    };
    mutateWorkflow(baseline, (content) => {
      const split = content.elements.find((element) => element.id === "PX20");
      split.splitType = "0";
      split.relateId = "legacy-split-relation";
      split.gatewayDirection = "converging";
      const join = content.elements.find((element) => element.id === "PX50");
      join.joinType = "0";
      join.relateId = "legacy-join-relation";
      join.gatewayDirection = "diverging";
      const edge = content.elements.find((element) => element.id === "PE21");
      edge.formula = "legacy-formula";
      edge.formulaName = "legacy formula";
      const creator = content.elements.find((element) => element.id === "PX60");
      creator.handlerSelectType = "org";
      creator.handlers = { type: "org", source: "1", members: [] };
      const unrelated = content.elements.find((element) => element.id === "PX31");
      unrelated.ignoreOnSameIdentity = "legacy-preserve";
      unrelated.routeValidationSentinel = { untouched: true };
    });

    const baselineContent = workflowContent(baseline);
    const prepared = prepareSample(trusted, {
      baseTemplate: baseline,
      workflowUpdateMode: "scoped-repair"
    });
    const repairedContent = workflowContent(prepared.update);

    assert.deepEqual(
      prepared.update.mechanisms.lbpmTemplate[0].fdTemplateFormAuths,
      baselineLbpm.fdTemplateFormAuths
    );
    assert.deepEqual(
      repairedContent.elements.find((element) => element.id === "PX31"),
      baselineContent.elements.find((element) => element.id === "PX31")
    );
    assert.equal(repairedContent.elements.find((element) => element.id === "PX20").splitType, "1");
    assert.equal(repairedContent.elements.find((element) => element.id === "PX50").joinType, "1");
    assert.equal(repairedContent.elements.find((element) => element.id === "PE21").formula.includes("fd_route_choice"), true);
    assert.equal(repairedContent.elements.find((element) => element.id === "PX60").handlers.type, "formula");
    const serverFilledMetadata = structuredClone(prepared.update);
    serverFilledMetadata.mechanisms.lbpmTemplate[0].fdTemplateFormAuths.PX31.fd_route_choice.fdNodeId = "PX31";
    serverFilledMetadata.mechanisms.lbpmTemplate[0].fdTemplateFormAuths.PX31.fd_route_choice.fdFieldId = "fd_route_choice";
    assert.equal(prepared.verify(serverFilledMetadata).ok, true);

    const authorityMutation = structuredClone(prepared.update);
    authorityMutation.mechanisms.lbpmTemplate[0].fdTemplateFormAuths.PX31.fd_route_choice.isEdit = true;
    assert.equal(
      prepared.verify(authorityMutation).diagnostics.some((item) =>
        item.code === "readback.workflow.scoped_repair_data_authority_changed"
      ),
      true
    );

    const unrelatedMutation = structuredClone(prepared.update);
    mutateWorkflow(unrelatedMutation, (content) => {
      content.elements.find((element) => element.id === "PX31").ignoreOnSameIdentity = "1";
    });
    assert.equal(
      prepared.verify(unrelatedMutation).diagnostics.some((item) =>
        item.code === "readback.workflow.scoped_repair_unrelated_element_changed"
      ),
      true
    );

    const conditionMutation = structuredClone(prepared.update);
    mutateWorkflow(conditionMutation, (content) => {
      content.elements.find((element) => element.id === "PE21").formula = "";
    });
    assert.equal(
      prepared.verify(conditionMutation).diagnostics.some((item) =>
        item.code === "readback.workflow.scoped_repair_target_mismatch"
      ),
      true
    );

    const overwriteMutation = structuredClone(prepared.update);
    mutateWorkflow(overwriteMutation, (content) => {
      content.elements.find((element) => element.id === "PX60").ignoreOnSameIdentity = "1";
    });
    assert.equal(
      prepared.verify(overwriteMutation).diagnostics.some((item) =>
        item.code === "readback.workflow.scoped_repair_target_overwrite"
      ),
      true
    );

    const policyMutation = structuredClone(prepared.update);
    policyMutation.mechanisms.lbpmTemplate[0].identityRepeatSkipType = "server-mutated";
    assert.equal(
      prepared.verify(policyMutation).diagnostics.some((item) =>
        item.code === "readback.workflow.scoped_repair_policy_changed"
      ),
      true
    );
  });

  it("preserves workflow policy even when a scoped repair has no supported targets", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const targetless = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-07-14T00:00:00.000Z"
    });
    for (const edge of targetless.workflow.edges) delete edge.condition.critical;
    targetless.workflow.nodes.find((node) => node.id === "PX60").participants = {
      mode: "explicit",
      members: [{ id: "submitter-person", name: "Submitter", type: "user_or_org" }]
    };
    const baseline = prepareSample(targetless).update;
    baseline.mechanisms.lbpmTemplate[0].fdTemplateFormAuths = {
      PX31: { fd_route_choice: { isShow: true, isEdit: false, isRequire: false } }
    };
    const prepared = prepareSample(targetless, {
      baseTemplate: baseline,
      workflowUpdateMode: "scoped-repair"
    });
    assert.equal(prepared.verify(prepared.update).ok, true);

    const authorityMutation = structuredClone(prepared.update);
    authorityMutation.mechanisms.lbpmTemplate[0].fdTemplateFormAuths.PX31.fd_route_choice.isEdit = true;
    assert.equal(
      prepared.verify(authorityMutation).diagnostics.some((item) =>
        item.code === "readback.workflow.scoped_repair_data_authority_changed"
      ),
      true
    );

    const contentMutation = structuredClone(prepared.update);
    mutateWorkflow(contentMutation, (content) => {
      content.elements.find((element) => element.id === "PX31").ignoreOnSameIdentity = "changed";
    });
    assert.equal(
      prepared.verify(contentMutation).diagnostics.some((item) =>
        item.code === "readback.workflow.scoped_repair_unrelated_element_changed"
      ),
      true
    );
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

function mutateWorkflow(template, mutate) {
  const lbpm = template.mechanisms.lbpmTemplate[0];
  const content = JSON.parse(lbpm.fdContent);
  mutate(content);
  lbpm.fdContent = JSON.stringify(content);
}

function workflowContent(template) {
  return JSON.parse(template.mechanisms.lbpmTemplate[0].fdContent);
}
