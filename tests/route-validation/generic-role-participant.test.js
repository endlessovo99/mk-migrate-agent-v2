import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

describe("Route-validation generic role participant", { concurrency: false }, () => {
  it("resolves and persists a bracketed generic role without applying the SIT fallback", async () => {
    const result = await runRouteCase("generic-role-participant-success");
    const participant = result.dsl.workflow.nodes
      .find((node) => node.id === "N2")
      .participants.members[0];
    const stage = result.execution.apiStages.find((entry) => (
      entry.name === "resolveWorkflowParticipants"
    ));

    assert.deepEqual({
      name: participant.name,
      sourceId: participant.sourceId,
      sourceOrgType: participant.sourceOrgType,
      sourceParentName: participant.sourceParentName
    }, {
      name: "<直线领导>",
      sourceId: "legacy-direct-manager-role",
      sourceOrgType: 32,
      sourceParentName: undefined
    });
    assert.equal(stage.resolvedCount, 1);
    assert.equal(stage.identityCount, 1);
    assert.equal(stage.fallbackCount ?? 0, 0);
    assert.equal(stage.fallbackIdentityCount ?? 0, 0);
    assert.equal(
      result.execution.diagnostics.some((entry) =>
        entry.code === "workflow.participant_sit_fallback_applied"
      ),
      false
    );
    assert.equal(result.execution.readback.partitions.workflow, "verified");
    assert.deepEqual(
      result.transcript.filter((entry) =>
        ["get-element-info", "search-org"].includes(entry.operation)
      ),
      [
        {
          operation: "get-element-info",
          targets: ["legacy-direct-manager-role"]
        },
        {
          operation: "search-org",
          key: "<直线领导>"
        }
      ]
    );
  });
});
