import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import {
  resolveWorkflowParticipants,
  SIT_PARTICIPANT_FALLBACKS
} from "../../src/executor/participant-resolver.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixturePath =
  "tests/fixtures/source/166d859bc79f49f5acf97474d9fa5d85";

describe("submitter defaults, compound fields, and department-leader role lines", () => {
  it("maps current-user source defaults to creator context available on the add page", () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const fields = new Map(dslDraft.form.fields.map((field) => [field.id, field]));

    assert.deepEqual(fields.get("fd_appr_dept")?.props.defaultValue, {
      kind: "context",
      source: "creatorDept"
    });
    assert.deepEqual(fields.get("fd_approver")?.props.defaultValue, {
      kind: "context",
      source: "creator"
    });

    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-08-23T00:00:00.000Z"
    });
    const prepared = prepareSample(trusted);
    const fieldsById = new Map(
      xformConfig(prepared.update).dataModel
        .find((model) => model.fdType === "main")
        .fdFields
        .map((field) => [field.fdName, JSON.parse(field.fdAttribute).config.controlProps])
    );
    const templateName = prepared.update.fdName;

    assert.deepEqual(fieldsById.get("fd_approver")?.defaultValueFormulaVO, {
      type: "Eval",
      script: "${data.biz.fdCreator}",
      vo: { mode: "formula", content: `$${templateName}.创建人$` },
      varIds: ["fdCreator"]
    });
    assert.deepEqual(fieldsById.get("fd_appr_dept")?.defaultValueFormulaVO, {
      type: "Eval",
      script: "${data.biz.fdCreatorDept}",
      vo: { mode: "formula", content: `$${templateName}.创建者部门$` },
      varIds: ["fdCreatorDept"]
    });
  });

  it("keeps every shared caption once, restores the missing qualification caption, and preserves the source cell groups", () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const fields = new Map(dslDraft.form.fields.map((field) => [field.id, field]));
    const rows = new Map(dslDraft.form.layout.mkTree.map((row) => [row.id, row]));

    assert.equal(fields.get("fd_323be79eaaff52")?.props.content, "用印类型");
    assert.equal(fields.get("fd_323be79fdd6e6c")?.props.content, "需提供的相关资质复印件");
    for (const fieldId of [
      "fd_seal_type",
      "fd_39b08d8a51c0ae",
      "fd_copy_type",
      "fd_copy_other_type"
    ]) {
      assert.equal(fields.get(fieldId)?.props.hiddenLabel, true, fieldId);
    }

    assert.deepEqual(rowShape(rows.get("layout.row-6")), {
      columns: 4,
      children: [
        { refType: "field", refIds: ["fd_323be79eaaff52"], column: 0, colspan: 1 },
        { refType: "layout", refIds: ["layout.row-6.row-6-cell-1.inline"], column: 1, colspan: 3 }
      ]
    });
    assert.deepEqual(rowShape(rows.get("layout.row-6.row-6-cell-1.inline")), {
      columns: 3,
      children: [
        { refType: "field", refIds: ["fd_seal_type"], column: 0, colspan: 2 },
        { refType: "field", refIds: ["fd_39b08d8a51c0ae"], column: 2, colspan: 1 }
      ]
    });
    assert.deepEqual(rowShape(rows.get("layout.row-7")), {
      columns: 4,
      children: [
        { refType: "field", refIds: ["fd_323be79fdd6e6c"], column: 0, colspan: 1 },
        { refType: "layout", refIds: ["layout.row-7.row-7-cell-1.inline"], column: 1, colspan: 3 }
      ]
    });
    assert.deepEqual(rowShape(rows.get("layout.row-7.row-7-cell-1.inline")), {
      columns: 3,
      children: [
        { refType: "field", refIds: ["fd_copy_type"], column: 0, colspan: 1 },
        { refType: "field", refIds: ["fd_3251f6412fa8d2"], column: 1, colspan: 1 },
        { refType: "field", refIds: ["fd_copy_other_type"], column: 2, colspan: 1 }
      ]
    });

    assert.deepEqual(
      projectNativeLayoutRows(dslDraft.form.layout.mkTree)
        .filter((row) => ["layout.row-6", "layout.row-7"].includes(row.id))
        .map((row) => ({
          id: row.id,
          columns: row.columns,
          fieldIds: row.cells.flatMap((cell) => cell.refIds)
        })),
      [
        {
          id: "layout.row-6",
          columns: 3,
          fieldIds: ["fd_323be79eaaff52", "fd_seal_type", "fd_39b08d8a51c0ae"]
        },
        {
          id: "layout.row-7",
          columns: 4,
          fieldIds: ["fd_323be79fdd6e6c", "fd_copy_type", "fd_3251f6412fa8d2", "fd_copy_other_type"]
        }
      ]
    );
    assert.equal(checkDraft(dslDraft).ok, true);
  });

  it("writes department-leader nodes as a submitter role-line formula and falls back unresolved fixed posts", async () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const departmentLeaderNodes = dslDraft.workflow.nodes.filter((node) =>
      ["N74", "N4", "N65", "N66", "N95", "N91", "N46", "N42"].includes(node.id)
    );

    assert.equal(departmentLeaderNodes.length, 8);
    for (const node of departmentLeaderNodes) {
      assert.deepEqual(node.participants, {
        mode: "submitter_role_line_script",
        recipe: "department_head",
        sourceRoleId: "149cb36bda232828b2168944bde8c95b",
        sourceRoleName: "部门领导",
        sourceOrgType: 32,
        sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgElement",
        sourceExpression: "149cb36bda232828b2168944bde8c95b",
        sourceNameExpression: "部门领导"
      }, node.id);
    }

    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-validation",
      checkedAt: "2026-08-23T00:00:00.000Z"
    });
    const fallbackTargets = new Map(
      Object.values(SIT_PARTICIPANT_FALLBACKS).map((fallback) => [fallback.fdId, fallback])
    );
    const resolved = await resolveWorkflowParticipants(trusted, {
      client: {
        async searchOrg() { return []; },
        async getElementInfo(targetIds) {
          return targetIds.flatMap((targetId) => {
            const target = fallbackTargets.get(targetId);
            return target ? [{ ...target }] : [];
          });
        }
      },
      targetBaseUrl: "http://oa-dev.shanghai-electric.com:8088"
    });
    const n31 = resolved.dsl.workflow.nodes.find((node) => node.id === "N31");
    assert.deepEqual(n31?.participants?.members.map((member) => ({
      id: member.id,
      name: member.name,
      targetOrgType: member.targetOrgType,
      sourceId: member.sourceId
    })), [{
      id: SIT_PARTICIPANT_FALLBACKS.post.fdId,
      name: SIT_PARTICIPANT_FALLBACKS.post.fdName,
      targetOrgType: 4,
      sourceId: "165fb24a33144ee84ac17fb4209bf820"
    }]);
    assert.equal(resolved.fallbackCount > 0, true);

    const prepared = prepareSample(resolved.dsl);
    const workflow = JSON.parse(prepared.update.mechanisms.lbpmTemplate[0].fdContent);
    for (const nodeId of departmentLeaderNodes.map((node) => node.id)) {
      const handlers = workflow.elements.find((node) => node.id === nodeId)?.handlers;
      const ruleKey = JSON.parse(handlers.ruleKey);
      assert.equal(handlers.type, "formula", nodeId);
      assert.deepEqual(handlers.members, [], nodeId);
      assert.equal(ruleKey.script, "return ${func.sysorg.getDepartmentHead}(${data._ProcessCreator}) || [];", nodeId);
      assert.equal(ruleKey.vo.content, "return #查找部门领导#($流程数据项.起草人$) || [];", nodeId);
    }
  });
});

function rowShape(row) {
  return {
    columns: row?.props?.columns,
    children: (row?.children || []).map((child) => ({
      refType: child.refType,
      refIds: child.refIds,
      column: child.column,
      colspan: child.colspan
    }))
  };
}
