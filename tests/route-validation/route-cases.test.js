import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

describe("offline Route-validation", { concurrency: false }, () => {
  it("executes a form-only source through the public migration route", async () => {
    const result = await runRouteCase("form-only-success");

    assert.equal(result.caseId, "form-only-success");
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
