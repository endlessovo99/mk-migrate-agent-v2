import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detailTableNameFor } from "../../src/executor/persistence/detail-table-names.js";
import { SIT_CONDITION_ORG_FALLBACKS } from "../../src/executor/condition-org-resolver.js";
import { SIT_PARTICIPANT_FALLBACKS } from "../../src/executor/participant-resolver.js";
import { runRouteCase } from "./run-route-case.js";

const SIT_FALLBACK_PARTICIPANT_ID = SIT_PARTICIPANT_FALLBACKS.person.fdId;
const SIT_CONDITION_ORG_FALLBACK_ID = SIT_CONDITION_ORG_FALLBACKS[0].fdId;

describe("offline Route-validation", { concurrency: false }, () => {
  it("executes a form-only source through the public migration route", async () => {
    const result = await runRouteCase("form-only-success");

    assert.equal(result.caseId, "form-only-success");
    assert.equal(result.dsl.template.name, "原流程模板");
    assert.equal(result.dryRun.template.name, "原流程模板");
    assert.equal(result.dsl.artifact, "migration-dsl");
    assert.equal(result.dsl.workflow, undefined);
    assert.equal(result.dryRun.ok, true);
    assert.equal(result.dryRun.steps.some((step) => step.id === "map-workflow"), false);
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.status, "written");
    assert.equal(result.execution.readback.form.fieldCount, 2);
    const staticRequiredAction = result.dsl.scripts.actions.find((action) =>
      action.coverage?.staticProps?.some((entry) => entry.fieldId === "fd_subject")
    );
    assert.equal(staticRequiredAction.translationStatus, "omitted");
    assert.equal(staticRequiredAction.function, "");
    assert.equal(result.execution.readback.form.fields.find((field) => field.id === "fd_subject").required, true);
    assert.deepEqual(result.execution.readback.form.subjectRule, {});
    assert.deepEqual(result.dsl.form.layout.mkTree[0].children.map((cell) => cell.column), [0, 1]);
    assert.deepEqual(result.execution.readback.form.layoutRows[0].cells.map((cell) => cell.column), [0, 1]);
    assert.equal(result.dsl.form.layout.mkTree[0].props.sourceColumns, 4);
    assert.equal(result.execution.readback.form.scripts.persistedActionCount, 0);
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

  it("reviews more than one script batch before dry-run and execution", async () => {
    const result = await runRouteCase("multi-batch-review-success");

    assert.equal(result.dsl.scripts.actions.length, 13);
    assert.equal(result.review.batchCount, 2);
    assert.deepEqual(result.review.batches.map((batch) => batch.actionIndexes.length), [12, 1]);
    assert.equal(
      result.review.batches.flatMap((batch) => batch.before)
        .every((action) => action.translationStatus === "needs_review"),
      true
    );
    assert.equal(
      result.dsl.scripts.actions.every((action) => ["mapped", "omitted"].includes(action.translationStatus)),
      true
    );
    assert.equal(result.dryRun.ok, true);
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.status, "written");
    assert.equal(result.execution.readback.form.scripts.persistedActionCount, 0);
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

  it("executes a configured non-SIT origin through the public migration route", async () => {
    const result = await runRouteCase("custom-base-url-success");

    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.status, "written");
    assert.equal(result.execution.baseUrl, "http://localhost:8080");
    assert.equal(result.transcript[0].operation, "login");
  });

  it("executes a paired form and workflow source through the public migration route", async () => {
    const result = await runRouteCase("paired-success");

    assert.equal(result.dsl.artifact, "migration-dsl");
    assert.equal(result.dsl.workflow.nodes.length, 3);
    assert.equal(result.dryRun.steps.some((step) => step.id === "map-workflow"), true);
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.status, "written_with_warnings");
    assert.equal(result.execution.readback.workflow.nodeCount, 3);
    assert.equal(result.execution.readback.workflow.edgeCount, 2);
    assert.deepEqual(
      result.execution.apiStages.find((stage) => stage.name === "resolveWorkflowParticipants"),
      {
        name: "resolveWorkflowParticipants",
        status: "ok",
        resolvedCount: 1,
        identityCount: 1,
        fallbackCount: 1,
        fallbackIdentityCount: 1,
        fallbackTargetId: SIT_FALLBACK_PARTICIPANT_ID,
        fallbackTargetIds: [SIT_FALLBACK_PARTICIPANT_ID],
        fallbackTargetsByOrgType: {
          8: {
            sourceOrgType: 8,
            targetFdId: SIT_FALLBACK_PARTICIPANT_ID,
            targetOrgType: 8,
            targetName: SIT_PARTICIPANT_FALLBACKS.person.fdName
          }
        }
      }
    );
    assert.equal(
      result.execution.diagnostics.some((item) => item.code === "workflow.participant_sit_fallback_applied"),
      true
    );
    assert.deepEqual(
      result.transcript.find((entry) => entry.operation === "get-element-info"),
      { operation: "get-element-info", targets: [SIT_FALLBACK_PARTICIPANT_ID] }
    );
    assert.deepEqual(
      result.transcript.find((entry) => entry.operation === "get-workflow-detail"),
      {
        operation: "get-workflow-detail",
        templateId: "route-created-workflow-template",
        definitionId: ""
      }
    );
  });

  it("keeps a warning-only review executable", async () => {
    const result = await runRouteCase("warning-but-executable");

    assert.equal(result.review.status, "needs_manual");
    assert.equal(result.review.diagnostics.some((diagnostic) => diagnostic.code === "route.review.needs_manual"), true);
    assert.equal(result.dsl.trust.executable, true);
    assert.equal(result.dryRun.ok, true);
    assert.equal(result.dryRun.status, "needs_manual");
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.status, "written_with_warnings");
  });

  it("persists conditional organization fallback, named-other default, and detail-container rules", async () => {
    const result = await runRouteCase("conditional-detail-success");

    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.readback.partitions.form, "verified");
    assert.equal(result.execution.readback.partitions.rules, "verified");
    assert.equal(result.execution.readback.partitions.workflow, "verified");
    assert.deepEqual(result.execution.readback.form.subjectRule, {});
    assert.equal(result.execution.readback.form.persistence.mainTableName, "route_model_generated");
    assert.equal(result.execution.readback.form.persistence.detailTables.length, 1);
    const detailTable = result.execution.readback.form.persistence.detailTables[0];
    assert.equal(detailTable.fieldId, "fd_route_detail");
    assert.equal(detailTable.tableName, detailTableNameFor("route_model_generated", "fd_route_detail"));
    assert.equal(detailTable.tableName.length <= 30, true);
    assert.notEqual(detailTable.tableName, result.execution.readback.form.persistence.mainTableName);

    const hint = result.execution.readback.form.fields.find((field) => field.id === "fd_route_hint");
    assert.equal(hint.type, "desc");
    assert.equal(hint.component, "xform-description");
    assert.deepEqual(hint.style, {
      color: "rgba(255,0,0,1)",
      fontWeight: "bold"
    });
    assert.deepEqual(result.dsl.form.fields.find((field) => field.id === "fd_route_hint").props.style, {
      color: "rgba(255,0,0,1)",
      fontWeight: "bold"
    });

    assert.equal(result.execution.readback.form.formRules.displayRuleCount, 2);
    assert.equal(result.execution.readback.form.formRules.requireRuleCount, 2);
    assert.equal(
      result.execution.readback.form.formRules.displayRules.every((rule) =>
        rule.effects.length === 1 && rule.effects[0].target === "fd_route_detail"
      ),
      true
    );
    assert.equal(
      result.execution.readback.form.formRules.requireRules.every((rule) =>
        rule.effects.length === 1 && rule.effects[0].target === "fd_route_detail"
      ),
      true
    );
    assert.equal(result.dsl.scripts.actions[0].translationStatus, "omitted");
    assert.deepEqual(result.dsl.scripts.actions[0].coverage.nativeRules, ["linkage.fd_route_type.contains.A"]);

    const conditionStage = result.execution.apiStages.find((stage) => stage.name === "resolveConditionOrgs");
    assert.deepEqual(conditionStage, {
      name: "resolveConditionOrgs",
      status: "ok",
      resolvedCount: 0,
      nameCount: 1,
      fallbackCount: 1
    });
    assert.equal(
      result.execution.diagnostics.some((item) => item.code === "workflow.condition_org_sit_fallback_applied"),
      true
    );
    assert.deepEqual(
      result.transcript.filter((entry) => entry.operation === "search-org"),
      [
        { operation: "search-org", key: "Conditional Reviewer" },
        { operation: "search-org", key: "南方服务中心" }
      ]
    );

    assert.equal(
      result.execution.readback.workflow.nodes.find((node) => node.id === "N2").ignoreOnSameIdentity,
      "1"
    );
    const southEdge = result.execution.readback.workflow.edges.find((edge) => edge.id === "L3");
    assert.equal(southEdge.isDefault, false);
    assert.equal(southEdge.hasCondition, true);
    assert.deepEqual(southEdge.condition, {
      nativeKind: "batch_formula",
      nativeStatus: "ok",
      functionIds: ["sysorg.isOrganizationBelongOrIncludeAnother"],
      orgIds: [SIT_CONDITION_ORG_FALLBACK_ID]
    });
    assert.equal(result.execution.readback.workflow.conditionEdgeCount, 2);
    assert.equal(
      result.execution.readback.workflow.edges.find((edge) => edge.id === "L4").isDefault,
      true
    );
  });

  it("blocks before transport when explicit write confirmation is absent", async () => {
    const result = await runRouteCase("blocked-before-transport");

    assert.equal(result.review.ok, true);
    assert.equal(result.dsl.artifact, "migration-dsl");
    assert.equal(result.dryRun.ok, true);
    assert.equal(result.execution.ok, false);
    assert.equal(result.execution.status, "blocked");
    assert.equal(result.execution.diagnostics.some((diagnostic) => diagnostic.code === "safety.confirm_write_required"), true);
    assert.deepEqual(result.transcript, []);
  });

  it("reports readback loss while preserving the created template id", async () => {
    const result = await runRouteCase("readback-loss");

    assert.equal(result.execution.ok, false);
    assert.equal(result.execution.status, "readback_failed");
    assert.equal(result.execution.stage, "readback");
    assert.equal(result.execution.templateId, "route-created-template");
    assert.deepEqual(result.execution.createdFdIds, ["route-created-template"]);
    assert.equal(result.execution.diagnostics.some((diagnostic) => diagnostic.code === "readback.form.layout_cells_mismatch"), true);
    assert.equal(result.transcript.at(-1).operation, "get-readback");
  });

  it("fails when a tracked fixture loses its native required property on readback", async () => {
    const result = await runRouteCase("required-readback-loss");

    assert.equal(result.execution.ok, false);
    assert.equal(result.execution.status, "readback_failed");
    assert.equal(result.execution.diagnostics.some((diagnostic) => diagnostic.code === "readback.form.required_mismatch"), true);
    assert.equal(result.execution.readback.form.fields.find((field) => field.id === "fd_subject").required, false);
  });
});
