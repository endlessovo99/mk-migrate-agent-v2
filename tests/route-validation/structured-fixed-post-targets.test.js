import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { resolveWorkflowParticipants } from "../../src/executor/participant-resolver.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixturePath = "tests/fixtures/source/14a08d7d8b8753e20198a5b4223b707e";
const TARGET_POST_ID = "19e634c586620d613af9df04841ade59";
const CACHED_SOURCE_POST_ID = "189f835a41ef38038dca2904425b55d2";
const TARGET_PERSON_ID = "14912dbee2ad4d8becd6c5a458e834e2";
const REFERENCE_SOURCE_PATH = "tests/fixtures/source/route-validation-lbpm";
const WORKFLOW_REFERENCE_DIR = "tests/fixtures/source/workflow-reference-initdata";
const REFERENCE_TARGET_POST_ID = "reference-target-post-id";
const FALLBACK_POST_ID = "current-fallback-post-id";

describe("structured fixed-post targets", () => {
  it("uses an exact matching initdata process as common direct-target evidence", async () => {
    const sourceDraft = cleanSourceFile(REFERENCE_SOURCE_PATH, {
      workflowReferenceDir: WORKFLOW_REFERENCE_DIR
    });
    const dslDraft = draftSourceDraft(sourceDraft);
    const n3 = dslDraft.workflow.nodes.find((node) => node.id === "N3");
    const searchCalls = [];
    const elementCalls = [];

    assert.equal(checkDraft(dslDraft).ok, true);
    assert.deepEqual(sourceDraft.source.workflowReference, {
      directory: WORKFLOW_REFERENCE_DIR,
      lbpmProcessDefinition: `${WORKFLOW_REFERENCE_DIR}/workflow-reference_LbpmProcessDefinition.xml`,
      processId: "route-validation-process-id",
      templateId: "route-validation-template-id"
    });
    assert.equal(n3.attributes.handlerIds, "handler-1");
    assert.deepEqual(n3.participants.members, [{
      id: REFERENCE_TARGET_POST_ID,
      name: "参考目标岗位",
      type: "user_or_org",
      targetOrgType: 4
    }]);

    const resolved = await resolveWorkflowParticipants({ workflow: { nodes: [n3] } }, {
      client: {
        async searchOrg(...args) {
          searchCalls.push(args);
          return [];
        },
        async getElementInfo(targetIds) {
          elementCalls.push(targetIds);
          return [{
            fdId: REFERENCE_TARGET_POST_ID,
            fdName: "参考目标岗位",
            fdOrgType: 4
          }];
        }
      }
    });

    assert.deepEqual(searchCalls, []);
    assert.deepEqual(elementCalls, [[REFERENCE_TARGET_POST_ID]]);
    assert.deepEqual(resolved.dsl.workflow.nodes[0].participants.members, [{
      id: REFERENCE_TARGET_POST_ID,
      name: "参考目标岗位",
      type: "user_or_org",
      targetOrgType: 4
    }]);
  });

  it("fails intake when initdata has no exact source process/template match", () => {
    assert.throws(
      () => cleanSourceFile(fixturePath, { workflowReferenceDir: WORKFLOW_REFERENCE_DIR }),
      /workflow reference has no exact process\/template match/
    );
  });

  it("uses a divergent nodeDefinitionHandlers post ID directly without using its cached handlerId", async () => {
    const dslDraft = draftSourceDraft(cleanSourceFile(fixturePath));
    const n110 = dslDraft.workflow.nodes.find((node) => node.id === "N110");
    const targetMember = n110.participants.members.find((member) => member.id === TARGET_POST_ID);
    const personMember = n110.participants.members.find((member) => member.id === TARGET_PERSON_ID);

    assert.equal(n110.attributes.handlerIds.includes(CACHED_SOURCE_POST_ID), true);
    assert.equal(checkDraft(dslDraft).ok, true);
    assert.deepEqual(targetMember, {
      id: TARGET_POST_ID,
      name: "风电工程服务分公司_运维服务中心部门领导",
      type: "user_or_org",
      targetOrgType: 4
    });
    assert.equal(targetMember.sourceId, undefined);
    assert.deepEqual(personMember, {
      id: TARGET_PERSON_ID,
      name: "梁文德",
      type: "user_or_org",
      targetOrgType: 8
    });

    const searchCalls = [];
    const elementCalls = [];
    const resolved = await resolveWorkflowParticipants({
      workflow: { nodes: [n110] }
    }, {
      client: {
        async searchOrg(name, orgType) {
          searchCalls.push([name, orgType]);
          return [];
        },
        async getElementInfo(targetIds) {
          elementCalls.push(targetIds);
          return targetIds.map((targetId) => targetId === TARGET_PERSON_ID
            ? {
                fdId: TARGET_PERSON_ID,
                fdName: "梁文德",
                fdOrgType: 8
              }
            : {
                fdId: TARGET_POST_ID,
                fdName: "风电工程服务分公司_运维服务中心部门领导",
                fdOrgType: 4
              });
        }
      }
    });

    assert.equal(resolved.fallbackCount, 0);
    assert.deepEqual(searchCalls, []);
    assert.deepEqual(elementCalls, [[TARGET_PERSON_ID], [TARGET_POST_ID]]);
    assert.deepEqual(
      resolved.dsl.workflow.nodes[0].participants.members.map((member) => member.id),
      [TARGET_PERSON_ID, TARGET_POST_ID]
    );
    assert.equal(
      JSON.stringify(resolved.dsl.workflow.nodes[0].participants.members).includes(CACHED_SOURCE_POST_ID),
      false
    );
  });

  it("fails closed when the structured fixed-post target is not a post", async () => {
    const n110 = targetOnlyNode();

    await assert.rejects(
      () => resolveWorkflowParticipants({ workflow: { nodes: [n110] } }, {
        client: {
          async getElementInfo() {
            return [{
              fdId: TARGET_POST_ID,
              fdName: "错误人员目标",
              fdOrgType: 8
            }];
          }
        }
      }),
      (error) => {
        assert.equal(error.issues?.[0]?.reason, "target_type_mismatch");
        assert.equal(error.issues?.[0]?.expectedOrgType, 4);
        assert.equal(error.issues?.[0]?.targetOrgType, 8);
        return true;
      }
    );
  });

  it("does not substitute the SIT fallback when the structured fixed-post target is missing", async () => {
    const n110 = targetOnlyNode();
    const elementCalls = [];

    await assert.rejects(
      () => resolveWorkflowParticipants({ workflow: { nodes: [n110] } }, {
        targetBaseUrl: "https://p-sit.onewo.com",
        fallbackFdIds: { post: "must-not-be-used" },
        client: {
          async getElementInfo(targetIds) {
            elementCalls.push(targetIds);
            return [];
          }
        }
      }),
      (error) => {
        assert.equal(error.issues?.[0]?.reason, "not_found");
        return true;
      }
    );
    assert.deepEqual(elementCalls, [[TARGET_POST_ID]]);
  });

  it("applies an explicitly authorized post fallback after exact target absence is confirmed", async () => {
    const n110 = targetOnlyNode();
    const elementCalls = [];
    const resolved = await resolveWorkflowParticipants({ workflow: { nodes: [n110] } }, {
      targetBaseUrl: "https://p-sit.onewo.com",
      fallbackFdIds: { post: FALLBACK_POST_ID },
      allowMissingDirectPostFallback: true,
      client: {
        async getElementInfo(targetIds) {
          elementCalls.push(targetIds);
          if (targetIds.includes(FALLBACK_POST_ID)) {
            return [{
              fdId: FALLBACK_POST_ID,
              fdName: "迁移兜底岗位",
              fdOrgType: 4
            }];
          }
          return [];
        }
      }
    });

    assert.deepEqual(elementCalls, [[TARGET_POST_ID], [FALLBACK_POST_ID]]);
    assert.equal(resolved.fallbackCount, 1);
    assert.equal(resolved.directTargetFallbackCount, 1);
    assert.deepEqual(resolved.dsl.workflow.nodes[0].participants.members, [{
      id: FALLBACK_POST_ID,
      name: "迁移兜底岗位",
      type: "user_or_org",
      targetOrgType: 4
    }]);
    assert.deepEqual(resolved.directTargetFallbacks[0].missingTarget, {
      fdId: TARGET_POST_ID,
      fdName: "风电工程服务分公司_运维服务中心部门领导",
      fdOrgType: 4
    });
  });

  it("blocks conflicting structured fixed-post targets before lookup or fallback", async () => {
    const n110 = targetOnlyNode();
    n110.directTargetAmbiguities = [{
      attribute: "handlerIds",
      index: 0,
      cachedId: CACHED_SOURCE_POST_ID,
      targetIds: [TARGET_POST_ID, "another-target-post-id"]
    }];
    const searchCalls = [];
    const elementCalls = [];

    await assert.rejects(
      () => resolveWorkflowParticipants({ workflow: { nodes: [n110] } }, {
        targetBaseUrl: "https://p-sit.onewo.com",
        fallbackFdIds: { post: "must-not-be-used" },
        client: {
          async searchOrg(...args) {
            searchCalls.push(args);
            return [];
          },
          async getElementInfo(...args) {
            elementCalls.push(args);
            return [];
          }
        }
      }),
      (error) => {
        assert.equal(error.issues?.[0]?.reason, "direct_target_ambiguous");
        return true;
      }
    );
    assert.deepEqual(searchCalls, []);
    assert.deepEqual(elementCalls, []);
  });
});

function targetOnlyNode() {
  const dslDraft = draftSourceDraft(cleanSourceFile(fixturePath));
  const n110 = structuredClone(dslDraft.workflow.nodes.find((node) => node.id === "N110"));
  n110.participants.members = n110.participants.members.filter((member) => member.id === TARGET_POST_ID);
  return n110;
}
