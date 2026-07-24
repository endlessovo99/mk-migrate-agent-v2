import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

describe("workflow completion-notifications Route case", () => {
  it("preserves notifications for the drafter and participants through NewOA readback", async () => {
    const result = await runRouteCase("workflow-completion-notifications-success");

    assert.deepEqual(result.dsl.workflow.process.completionNotifications, {
      drafter: true,
      participants: true
    });
    assert.deepEqual(result.execution.readback.workflow.completionNotifications, {
      drafter: true,
      participants: true
    });
    assert.equal(result.execution.readback.partitions.workflow, "verified");
    assert.deepEqual(
      result.transcript.find((entry) => entry.operation === "save-workflow-draft"),
      {
        operation: "save-workflow-draft",
        templateId: "route-created-workflow-template",
        draft: true,
        notifyDrafterOnEnd: "true",
        notifyParticipantOnEnd: "true"
      }
    );
  });
});
