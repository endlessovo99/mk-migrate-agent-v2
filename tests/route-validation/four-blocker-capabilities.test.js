import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { buildWorkflowContent } from "../../src/executor/persistence/workflow-writer.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { persistAndVerify } from "../helpers/persistence.js";
import { resolveRouteFixture } from "./fixture.js";

describe("four blocking route capabilities", () => {
  it("extracts dependent-select, attachment, and detail-lifecycle facts for Agent Review", () => {
    const fixturePath = resolveRouteFixture({
      kind: "form-only",
      relativePath: "script-review-recipes/route-script-review-recipes_SysFormTemplate.xml"
    });
    const source = cleanSourceFile(fixturePath);
    const draft = draftSourceDraft(source);
    const recipeActions = draft.scripts.actions.filter((action) => action.recipe);
    const actionFor = (kind, event) => recipeActions.find((action) =>
      action.recipe.kind === kind && (!event || action.event === event)
    );

    assert.deepEqual([...new Set(recipeActions.map((action) => action.recipe.kind))].sort(), [
      "attachment_non_empty",
      "dependent_select_options",
      "detail_row_control_state",
      "detail_row_lifecycle"
    ]);
    assert.equal(recipeActions.every((action) =>
      !action.functionMappings?.some((mapping) => mapping.basis === "semantic-recipe")
    ), true);

    const dependent = actionFor("dependent_select_options", "onChange");
    assert.equal(dependent.translationStatus, "needs_review");
    assert.equal(dependent.controlId, "fd_trigger");
    assert.equal(dependent.recipe.targetFieldId, "fd_target");
    assert.deepEqual(dependent.recipe.cases[0].options.map((option) => option.value), ["1", "2", "3"]);
    assert.deepEqual(dependent.recipe.defaultOptions.map((option) => option.value), ["1", "2", "3", "4"]);

    const attachment = actionFor("attachment_non_empty");
    assert.equal(attachment.translationStatus, "needs_review");
    assert.equal(attachment.event, "onBeforeSubmit");
    assert.equal(attachment.recipe.fieldId, "fd_attach");
    assert.equal(attachment.recipe.message, "Attachment is required");

    const detail = actionFor("detail_row_control_state");
    assert.equal(detail.translationStatus, "mapped");
    assert.equal(detail.coverage.status, "translated");
    assert.equal(detail.tableId, "fd_detail");
    assert.equal(detail.controlId, "fd_detail_trigger");
    assert.equal(detail.recipe.targetControlId, "fd_target_detail");
    assert.equal(detail.recipe.hiddenControlId, "fd_hidden");
    assert.equal(
      detail.functionMappings?.some((mapping) => mapping.basis === "deterministic-detail-row-control-state"),
      true
    );

    const lifecycle = actionFor("detail_row_lifecycle");
    assert.equal(lifecycle.translationStatus, "mapped");
    assert.equal(lifecycle.coverage.status, "translated");
    assert.deepEqual(lifecycle.coverage.nativeRules, []);
    assert.deepEqual(lifecycle.coverage.residuals, []);
    assert.equal(lifecycle.recipe.reviewRuleIds == null, true);
    assert.deepEqual(lifecycle.recipe.rowLifecycle, {
      existingRows: "on_load_initialization",
      addedRows: "native_detail_control_event",
      deletedRows: "native_detail_runtime",
      legacyDomCleanup: "not_applicable_native_runtime"
    });
    assert.equal(
      lifecycle.functionMappings?.some((mapping) => mapping.basis === "deterministic-detail-row-lifecycle"),
      true
    );

    const actionIndexes = draft.scripts.actions
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => action.translationStatus === "needs_review")
      .map(({ index }) => index);
    const prompt = buildAgentReviewPrompt(source, draft, {
      reviewScope: { actionIndexes, includeFormTargets: false }
    });
    const opportunities = prompt.context.dslDraft.scripts.actions.flatMap((action) =>
      action.reviewOpportunities?.map((item) => item.kind) || []
    );
    assert.equal(opportunities.includes("dependent_select_options_candidate"), true);
    assert.equal(opportunities.includes("attachment_non_empty_candidate"), true);
    assert.equal(opportunities.includes("detail_row_visibility_candidate"), false);
    assert.equal(opportunities.includes("detail_row_load_initialization_candidate"), false);
    const gatedRowAction = draft.scripts.actions.find((action) =>
      action.coverage?.nativeRules?.includes("linkage.fd_trigger.contains.restricted")
    );
    assert.equal(gatedRowAction?.translationStatus, "omitted");
    assert.deepEqual(gatedRowAction?.runWhen, { viewStatusIn: ["add", "edit"] });
  });

  it("maps a minimal start/recover pair to one executable native subprocess node", () => {
    const fixturePath = resolveRouteFixture({
      kind: "paired",
      relativePath: "subprocess"
    });
    const source = cleanSourceFile(fixturePath);
    const draft = draftSourceDraft(source);
    const nodes = new Map(draft.workflow.nodes.map((node) => [node.id, node]));

    assert.equal(nodes.get("N20").type, "startSubProcess");
    assert.equal(nodes.get("N20").translationStatus, "executable");
    assert.equal(nodes.get("N20").subProcess.recoverNodeId, "N23");
    assert.equal(nodes.get("N20").subProcess.templateId, "route-child-template");
    assert.equal(nodes.get("N20").subProcess.startParamConfig.length, 1);
    assert.equal(nodes.get("N20").subProcess.recoverParamConfig.length, 1);
    assert.equal(nodes.get("N20").subProcess.variableScope, 2);
    assert.equal(nodes.get("N23").type, "recoverSubProcess");
    assert.equal(nodes.get("N23").subProcess.startNodeId, "N20");

    const native = buildWorkflowContent(draft.workflow, { form: draft.form });
    const nativeNodes = native.elements.filter((element) => element.type !== "sequenceFlow");
    const nativeEdges = native.elements.filter((element) => element.type === "sequenceFlow");
    const subprocess = nativeNodes.find((node) => node.id === "N20");
    assert.equal(nativeNodes.some((node) => node.id === "N23"), false);
    assert.equal(subprocess.type, "startSubProcess");
    assert.equal(JSON.parse(subprocess.config).subProcess.templateId, "route-child-template");
    assert.equal(nativeEdges.some((edge) => edge.sourceRef === "N20" && edge.targetRef === "N3"), true);

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation-agent",
      decisions: [{
        id: "subprocess-native-projection",
        status: "accepted",
        decisionType: "subprocess_native_projection",
        sourceRefs: ["source.workflow.node.N20", "source.workflow.node.N23"],
        targetRefs: ["workflow.nodes.N20", "workflow.nodes.N23"],
        rationale: "Structured start/recover evidence maps to one native NewOA subprocess node.",
        result: "accepted"
      }]
    });
    assert.equal(checkTrust(source, trusted).ok, true);
    assert.equal(persistAndVerify(trusted).readback.ok, true);

    const mutated = persistAndVerify(trusted, {
      mutate(template) {
        const lbpm = template.mechanisms.lbpmTemplate[0];
        const content = JSON.parse(lbpm.fdContent);
        const node = content.elements.find((element) => element.id === "N20");
        const config = JSON.parse(node.config);
        config.subProcess.templateId = "wrong-template-id";
        node.config = JSON.stringify(config);
        lbpm.fdContent = JSON.stringify(content);
        return template;
      }
    }).readback;
    assert.equal(mutated.ok, false);
    assert.equal(mutated.diagnostics.some((item) =>
      item.code === "readback.workflow.subprocess_mismatch"
    ), true);
  });
});
