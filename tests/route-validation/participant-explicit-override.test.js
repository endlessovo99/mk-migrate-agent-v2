import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

describe("Route-validation explicit participant override", { concurrency: false }, () => {
  it("keeps workflow override audit separate from template authorization resolution", async () => {
    const sourceId = "legacy-companion-reviewer";
    const targetFdId = "route-explicit-person-override";
    const result = await runRouteCase("participant-explicit-override-success");
    const sourceMember = result.dsl.workflow.nodes
      .find((node) => node.id === "N2")
      .participants.members[0];
    const stage = result.execution.apiStages.find((entry) => (
      entry.name === "resolveWorkflowParticipants"
    ));
    const warning = result.execution.diagnostics.find((entry) => (
      entry.code === "workflow.participant_explicit_override_applied"
    ));

    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.status, "written_with_warnings");
    assert.equal(sourceMember.sourceId, sourceId);
    assert.equal(sourceMember.name, "Companion Reviewer");
    assert.equal(sourceMember.sourceOrgType, 8);
    assert.equal(stage.overrideCount, 1);
    assert.equal(stage.overrideIdentityCount, 1);
    assert.deepEqual(stage.overrideTargetIds, [targetFdId]);
    assert.equal(stage.overrides[0].sourceEvidence.sourceId, sourceId);
    assert.equal(stage.overrides[0].sourceEvidence.name, "Companion Reviewer");
    assert.equal(stage.overrides[0].sourceEvidence.sourceLoginName, "legacy.companion");
    assert.equal(stage.overrides[0].target.fdId, targetFdId);
    assert.equal(warning.details.referenceCount, 1);
    assert.equal(warning.details.overrides[0].sourceEvidence.sourceId, sourceId);
    assert.deepEqual(stage.overrides[0].paths, [
      "/workflow/nodes/1/participants/members/0"
    ]);
    assert.deepEqual(
      result.execution.readback.workflow.templateAuthorization.readers,
      [sourceId]
    );
    assert.equal(result.execution.readback.partitions.workflow, "verified");
    assert.deepEqual(
      result.transcript.filter((entry) => entry.operation === "get-element-info"),
      [{ operation: "get-element-info", targets: [targetFdId] }]
    );
    assert.deepEqual(
      result.transcript.filter((entry) => entry.operation === "search-org"),
      [{ operation: "search-org", key: "legacy.companion" }]
    );
  });
});
