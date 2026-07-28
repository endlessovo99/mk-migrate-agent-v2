import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import {
  resolveWorkflowParticipants,
  SIT_PARTICIPANT_FALLBACKS
} from "../../src/executor/participant-resolver.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

const fixturePath =
  "tests/fixtures/source/14b583fed3170897b4e808b45f6a58ab";

describe("Shanghai Electric 14b fixed role-line Route case", () => {
  it("preserves both source role ids and persists them as native member type 4", async () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    assert.deepEqual(
      ["N24", "N26"].map((nodeId) => {
        const node = dslDraft.workflow.nodes.find((item) => item.id === nodeId);
        return {
          id: node.id,
          mode: node.participants.mode,
          members: node.participants.members.map((member) => ({
            name: member.name,
            sourceId: member.sourceId,
            sourceOrgType: member.sourceOrgType
          }))
        };
      }),
      [
        {
          id: "N24",
          mode: "explicit",
          members: [{
            name: "部门领导",
            sourceId: "149cb36bda232828b2168944bde8c95b",
            sourceOrgType: 32
          }]
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

    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-07-28T00:00:00.000Z"
    });
    assert.equal(checkTrust(sourceDraft, trusted).ok, true);

    const currentRoleTargets = {
      "149cb36bda232828b2168944bde8c95b": {
        fdId: "149cb36bda232828b2168944bde8c95b",
        fdName: "部门领导",
        fdOrgType: 32
      },
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
    const participantClient = {
      async searchOrg() {
        return [];
      },
      async getElementInfo(targets) {
        return targets.flatMap((targetId) => {
          const target = currentRoleTargets[targetId] ||
            currentFallbackTargets[targetId];
          return target ? [structuredClone(target)] : [];
        });
      }
    };
    const resolved = await resolveWorkflowParticipants(trusted, {
      client: participantClient,
      targetBaseUrl: "http://oa-dev.shanghai-electric.com:8088"
    });
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
          member: node.handlers.members[0]
        };
      }),
      [
        {
          id: "N24",
          member: {
            id: "149cb36bda232828b2168944bde8c95b",
            name: "部门领导",
            element: "user",
            type: "4"
          }
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
