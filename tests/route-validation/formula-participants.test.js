import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

describe("Route-validation formula participants", { concurrency: false }, () => {
  it("tracks formula participant semantics through DSL and NewOA readback", async () => {
    const result = await runRouteCase("paired-success");
    const dslNodes = new Map(result.dsl.workflow.nodes.map((node) => [node.id, node]));

    assert.equal(dslNodes.get("N2").participants.mode, "explicit");
    assert.deepEqual(
      dslNodes.get("N2").participants.members.map((member) => member.sourceId),
      ["legacy-route-reviewer"]
    );
    assert.deepEqual(
      ["N4", "N5", "N6", "N7"].map((nodeId) =>
        participantProjection(nodeId, dslNodes.get(nodeId).participants, { includeSubjectKind: true })
      ),
      [
        { id: "N4", mode: "person_by_login_name", fieldId: "fd_login_name" },
        { id: "N5", mode: "dept_leader_by_no", fieldId: "fd_department_no" },
        { id: "N6", mode: "doc_creator" },
        { id: "N7", mode: "node_history_superior_department_head", nodeId: "N2" }
      ]
    );

    assert.equal(result.execution.readback.partitions.workflow, "verified");
    const readbackNodes = new Map(
      result.execution.readback.workflow.nodes.map((node) => [node.id, node])
    );
    assert.equal(readbackNodes.get("N4").participants.nativeFormula, undefined);
    assert.equal(readbackNodes.get("N2").participants.members, undefined);
    assert.deepEqual(
      ["N2", "N4", "N5", "N6", "N7"].map((nodeId) =>
        participantProjection(nodeId, readbackNodes.get(nodeId).participants)
      ),
      [
        { id: "N2", mode: "explicit" },
        { id: "N4", mode: "person_by_login_name", fieldId: "fd_login_name" },
        { id: "N5", mode: "dept_leader_by_no", fieldId: "fd_department_no" },
        { id: "N6", mode: "doc_creator" },
        { id: "N7", mode: "node_history_superior_department_head", nodeId: "N2" }
      ]
    );
  });
});

function participantProjection(id, participants, options = {}) {
  return {
    id,
    mode: participants?.mode,
    ...(participants?.fieldId ? { fieldId: participants.fieldId } : {}),
    ...(options.includeSubjectKind && participants?.subjectKind
      ? { subjectKind: participants.subjectKind }
      : {}),
    ...(participants?.nodeId ? { nodeId: participants.nodeId } : {})
  };
}
