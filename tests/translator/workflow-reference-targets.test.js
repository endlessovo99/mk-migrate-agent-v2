import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyWorkflowReferenceTargets } from "../../src/translator/workflow-reference-targets.js";

describe("workflow reference targets", () => {
  it("maps matching primary and optional positions without creating an ID-wide mapping", () => {
    const sourceWorkflow = {
      nodes: [
        {
          id: "N1",
          attributes: {
            handlerIds: "legacy-shared-id;keep-source-id",
            handlerSelectType: "org",
            optHandlerIds: "legacy-optional-id",
            optHandlerSelectType: "org"
          },
          handlerEntities: [
            { id: "legacy-shared-id", name: "旧主岗位", orgType: 4, index: 0 },
            { id: "keep-source-id", name: "保留岗位", orgType: 4, index: 1 }
          ],
          optionalHandlerEntities: [
            { id: "legacy-optional-id", name: "旧备选岗位", orgType: 4, index: 0 }
          ]
        },
        {
          id: "N2",
          attributes: { handlerIds: "legacy-shared-id" },
          handlerEntities: [{ id: "legacy-shared-id", name: "另一节点旧岗位", orgType: 4, index: 0 }]
        }
      ]
    };
    const referenceWorkflow = {
      nodes: [{
        id: "N1",
          attributes: {
            handlerIds: "legacy-shared-id;keep-source-id",
            handlerSelectType: "org",
            optHandlerIds: "legacy-optional-id",
            optHandlerSelectType: "org"
        },
        handlerEntities: [{
          id: "target-primary-id",
          name: "目标主岗位",
          orgType: 4,
          index: 0,
          directTargetId: "target-primary-id",
          directTargetOrgType: 4
        }],
        optionalHandlerEntities: [{
          id: "target-optional-id",
          name: "目标备选岗位",
          orgType: 4,
          index: 0,
          directTargetId: "target-optional-id",
          directTargetOrgType: 4
        }]
      }]
    };

    const result = applyWorkflowReferenceTargets(sourceWorkflow, referenceWorkflow);

    assert.deepEqual(result.nodes[0].handlerEntities, [
      {
        id: "target-primary-id",
        name: "目标主岗位",
        orgType: 4,
        index: 0,
        directTargetId: "target-primary-id",
        directTargetOrgType: 4,
        directTargetEvidence: "workflow-reference"
      },
      { id: "keep-source-id", name: "保留岗位", orgType: 4, index: 1 }
    ]);
    assert.deepEqual(result.nodes[0].optionalHandlerEntities, [{
      id: "target-optional-id",
      name: "目标备选岗位",
      orgType: 4,
      index: 0,
      directTargetId: "target-optional-id",
      directTargetOrgType: 4,
      directTargetEvidence: "workflow-reference"
    }]);
    assert.deepEqual(result.nodes[1].handlerEntities, [
      { id: "legacy-shared-id", name: "另一节点旧岗位", orgType: 4, index: 0 }
    ]);
  });

  it("propagates an exact matching reference ambiguity instead of resolving or falling back", () => {
    const result = applyWorkflowReferenceTargets({
      nodes: [{
        id: "N1",
        attributes: { handlerIds: "legacy-post-id", handlerSelectType: "org" },
        handlerEntities: [{ id: "legacy-post-id", name: "旧岗位", orgType: 4, index: 0 }]
      }]
    }, {
      nodes: [{
        id: "N1",
        attributes: { handlerIds: "legacy-post-id", handlerSelectType: "org" },
        directTargetAmbiguities: [{
          attribute: "handlerIds",
          index: 0,
          cachedId: "legacy-post-id",
          targetIds: ["target-a", "target-b"]
        }]
      }]
    });

    assert.equal(result.nodes[0].handlerEntities, undefined);
    assert.deepEqual(result.nodes[0].directTargetAmbiguities, [{
      attribute: "handlerIds",
      index: 0,
      cachedId: "legacy-post-id",
      targetIds: ["target-a", "target-b"]
    }]);
  });

  it("preserves a source fixed-post conflict instead of replacing it with a reference target", () => {
    const sourceWorkflow = {
      nodes: [{
        id: "N1",
        attributes: { handlerIds: "legacy-post-id", handlerSelectType: "org" },
        handlerEntities: [{ id: "legacy-post-id", name: "旧岗位", orgType: 4, index: 0 }],
        directTargetAmbiguities: [{
          attribute: "handlerIds",
          index: 0,
          cachedId: "legacy-post-id",
          targetIds: ["source-target-a", "source-target-b"]
        }]
      }]
    };
    const referenceWorkflow = {
      nodes: [{
        id: "N1",
        attributes: { handlerIds: "legacy-post-id", handlerSelectType: "org" },
        handlerEntities: [{
          id: "reference-target-post-id",
          name: "参考目标岗位",
          orgType: 4,
          index: 0,
          directTargetId: "reference-target-post-id",
          directTargetOrgType: 4
        }]
      }]
    };

    assert.deepEqual(
      applyWorkflowReferenceTargets(sourceWorkflow, referenceWorkflow),
      sourceWorkflow
    );
  });

  it("leaves non-org, non-post, and formula handlers on their original resolution path", () => {
    const referenceNode = {
      id: "N1",
      attributes: { handlerIds: "same-id", handlerSelectType: "org" },
      handlerEntities: [{
        id: "target-post-id",
        name: "目标岗位",
        orgType: 4,
        index: 0,
        directTargetId: "target-post-id",
        directTargetOrgType: 4
      }]
    };
    const formulaReferenceNode = {
      ...referenceNode,
      id: "N3",
      attributes: { handlerIds: "${handler_id}", handlerSelectType: "org" }
    };
    const sourceWorkflow = {
      nodes: [
        {
          id: "N1",
          attributes: { handlerIds: "same-id", handlerSelectType: "person" },
          handlerEntities: [{ id: "same-id", name: "处理人", orgType: 8, index: 0 }]
        },
        {
          id: "N2",
          attributes: { handlerIds: "same-id", handlerSelectType: "org" },
          handlerEntities: [{ id: "same-id", name: "非岗位实体", orgType: 8, index: 0 }]
        },
        {
          id: "N3",
          attributes: { handlerIds: "${handler_id}", handlerSelectType: "org" },
          handlerEntities: [{ id: "${handler_id}", name: "公式岗位", orgType: 4, index: 0 }]
        }
      ]
    };

    const result = applyWorkflowReferenceTargets(sourceWorkflow, {
      nodes: [referenceNode, { ...referenceNode, id: "N2" }, formulaReferenceNode]
    });

    assert.deepEqual(result, sourceWorkflow);
  });
});
