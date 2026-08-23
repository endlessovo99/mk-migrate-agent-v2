import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import {
  resolveWorkflowParticipants,
  SIT_PARTICIPANT_FALLBACKS
} from "../../src/executor/participant-resolver.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

const fixturePath =
  "tests/fixtures/source/14b583fed3170897b4e808b45f6a58ab";

describe("Shanghai Electric 14b seal-application Route case", () => {
  it("closes the native default row, role-line participants, and conditional-parallel routes", async () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const defaultRow = dslDraft.scripts.actions.find((action) =>
      action.functionMappings?.some((mapping) =>
        mapping.target === "xform-detail-table.defaultRowNumber=1"
      )
    );
    const criticalRoutes = dslDraft.workflow.edges.filter((edge) =>
      edge.condition?.critical === true
    );
    const roleLineNodes = ["N24", "N26"].map((nodeId) => {
      const node = dslDraft.workflow.nodes.find((item) => item.id === nodeId);
      return {
        id: node.id,
        name: node.name,
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
    });

    assert.ok(defaultRow);
    assert.equal(defaultRow.translationStatus, "omitted");
    assert.equal(defaultRow.function, "");
    assert.deepEqual(
      criticalRoutes.map((edge) => edge.id),
      ["L83", "L75", "L77", "L85", "L80", "L92", "L100", "L101", "L89"]
    );
    assert.equal(
      criticalRoutes.every((edge) =>
        edge.condition.translationStatus === "executable" &&
        /^\$字符串\.包含\$/.test(edge.condition.targetText)
      ),
      true
    );
    assert.deepEqual(roleLineNodes, [
      {
        id: "N24",
        name: "输配电部门领导",
        mode: "submitter_role_line_script",
        recipe: "department_head",
        sourceRoleId: "149cb36bda232828b2168944bde8c95b",
        sourceRoleName: "部门领导",
        sourceOrgType: 32
      },
      {
        id: "N26",
        name: "输配电部门分管领导",
        mode: "explicit",
        members: [{
          name: "分管领导",
          sourceId: "149cbca19a5f9a6db33d2a74e50af173",
          sourceOrgType: 32
        }]
      }
    ]);
    assert.equal(checkDraft(dslDraft).ok, true);

    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-07-28T00:00:00.000Z"
    });
    assert.equal(checkTrust(sourceDraft, trusted).ok, true);
    assert.equal(buildDryRunPlan(trusted).ok, true);

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
    assert.equal(
      readback.diagnostics.some((diagnostic) =>
        diagnostic.path?.includes("/readback/workflow/edges/") &&
        diagnostic.path?.endsWith("/condition")
      ),
      false,
      JSON.stringify(readback.diagnostics)
    );

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
    const route = workflow.elements.find((element) => element.id === "L83");
    const formula = JSON.parse(route.formula);
    assert.equal(formula.type, "Batch");
    assert.equal(
      formula.vars.some((variable) => variable.value === "global.contains"),
      true
    );
  });
});
