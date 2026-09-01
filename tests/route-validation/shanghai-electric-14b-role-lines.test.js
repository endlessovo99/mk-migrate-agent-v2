import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import {
  ParticipantResolutionError,
  resolveWorkflowParticipants,
  SIT_PARTICIPANT_FALLBACKS
} from "../../src/executor/participant-resolver.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

const fixturePath =
  "tests/fixtures/source/14b583fed3170897b4e808b45f6a58ab";

describe("Shanghai Electric 14b fixed role-line Route case", () => {
  it("keeps an unresolved fixed role line blocking instead of replacing it with a person fallback", async () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    omitTemplateAuthorization(sourceDraft, dslDraft);
    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-08-23T00:00:00.000Z"
    });

    await assert.rejects(
      resolveWorkflowParticipants(trusted, {
        client: {
          async searchOrg() { return []; },
          async getElementInfo() { return []; }
        },
        targetBaseUrl: "http://oa-dev.shanghai-electric.com:8088"
      }),
      (error) => error instanceof ParticipantResolutionError &&
        error.issues.some((issue) => (
          issue.sourceId === "149cbca19a5f9a6db33d2a74e50af173" &&
          issue.sourceOrgType === 32 &&
          issue.reason === "not_found"
        ))
    );
  });

  it("preserves the department-leader role source as a submitter role-line formula", async () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    assert.deepEqual(
      ["N24", "N26"].map((nodeId) => {
        const node = dslDraft.workflow.nodes.find((item) => item.id === nodeId);
        return {
          id: node.id,
          mode: node.participants.mode,
          ...(node.participants.mode === "submitter_role_line_script"
            ? {
                recipe: node.participants.recipe,
                sourceRoleId: node.participants.sourceRoleId,
                sourceRoleName: node.participants.sourceRoleName,
                sourceOrgType: node.participants.sourceOrgType
              }
            : {
                members: node.participants.members.map((member) => ({
                  name: member.name,
                  sourceId: member.sourceId,
                  sourceOrgType: member.sourceOrgType
                }))
              })
        };
      }),
      [
        {
          id: "N24",
          mode: "submitter_role_line_script",
          recipe: "department_head",
          sourceRoleId: "149cb36bda232828b2168944bde8c95b",
          sourceRoleName: "部门领导",
          sourceOrgType: 32
        },
        {
          id: "N26",
          mode: "explicit",
          members: [{
            name: "分管领导",
            sourceId: "149cbca19a5f9a6db33d2a74e50af173",
            sourceOrgType: 32
          }]
        }
      ]
    );

    omitTemplateAuthorization(sourceDraft, dslDraft);
    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-07-28T00:00:00.000Z"
    });
    assert.equal(checkTrust(sourceDraft, trusted).ok, true);

    const currentRoleTargets = {
      "149cbca19a5f9a6db33d2a74e50af173": {
        fdId: "149cbca19a5f9a6db33d2a74e50af173",
        fdName: "分管领导",
        fdOrgType: 32
      }
    };
    const currentFallbackTargets = Object.fromEntries(
      Object.values(SIT_PARTICIPANT_FALLBACKS).map((target) => [
        target.fdId,
        target
      ])
    );
    const directTargets = collectDirectTargets(dslDraft);
    const searchCalls = [];
    const elementCalls = [];
    const participantClient = {
      async searchOrg(...args) {
        searchCalls.push(args);
        return [];
      },
      async getElementInfo(targets) {
        elementCalls.push(targets);
        return targets.flatMap((targetId) => {
          const target = currentRoleTargets[targetId] ||
            directTargets.get(targetId) ||
            currentFallbackTargets[targetId];
          return target ? [structuredClone(target)] : [];
        });
      }
    };
    const resolved = await resolveWorkflowParticipants(trusted, {
      client: participantClient,
      targetBaseUrl: "http://oa-dev.shanghai-electric.com:8088"
    });
    const validatedIds = new Set(elementCalls.flat());
    assert.equal([...directTargets.keys()].every((targetId) => validatedIds.has(targetId)), true);
    assert.equal(
      searchCalls.some(([key]) => [...directTargets.values()].some((target) => target.fdName === key)),
      false
    );
    const prepared = prepareSample(resolved.dsl);
    const readback = prepared.verify(prepared.update);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));

    const workflow = JSON.parse(
      prepared.update.mechanisms.lbpmTemplate[0].fdContent
    );
    assert.deepEqual(
      ["N24", "N26"].map((nodeId) => {
        const node = workflow.elements.find((element) => element.id === nodeId);
        return {
          id: node.id,
          ...(nodeId === "N24"
            ? {
                script: JSON.parse(node.handlers.ruleKey).script,
                content: JSON.parse(node.handlers.ruleKey).vo.content,
                members: node.handlers.members
              }
            : { member: node.handlers.members[0] })
        };
      }),
      [
        {
          id: "N24",
          script: "return ${func.sysorg.getDepartmentHead}(${data._ProcessCreator}) || [];",
          content: "return #查找部门领导#($流程数据项.起草人$) || [];",
          members: []
        },
        {
          id: "N26",
          member: {
            id: "149cbca19a5f9a6db33d2a74e50af173",
            name: "分管领导",
            element: "user",
            type: "4"
          }
        }
      ]
    );
  });
});

function omitTemplateAuthorization(sourceDraft, dsl) {
  delete sourceDraft.template.authorization;
  delete dsl.template.authorization;
}

function collectDirectTargets(dsl) {
  return new Map((dsl.workflow?.nodes || []).flatMap((node) =>
    [
      ...(node.participants?.members || []),
      ...(node.participants?.alternativeMembers || [])
    ].flatMap((member) => member.id && Number.isFinite(Number(member.targetOrgType))
      ? [[member.id, {
          fdId: member.id,
          fdName: member.name,
          fdOrgType: Number(member.targetOrgType)
        }]]
      : [])
  ));
}
