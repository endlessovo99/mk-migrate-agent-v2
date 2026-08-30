import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { inspectWorkflowFormulaProvenance } from "../../src/translator/workflow-formula-participants.js";
import { buildWorkflowContent, projectTemplate, verifyTemplate } from "../helpers/persistence.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

const ARBITRARY_FIELD_ROLE_SOURCE =
  "tests/fixtures/source2/16e24f066c3f14729bd22cb470990511";
const NODE_HISTORY_ROLE_SOURCE =
  "tests/fixtures/route-validation/arbitrary-node-history-role-line";

describe("common role-line MK syntax Route-validation", () => {
  it("preserves arbitrary role arguments for a main-form field", () => {
    const source = cleanSourceFile(ARBITRARY_FIELD_ROLE_SOURCE);
    const draft = draftSourceDraft(source);
    const node = draft.workflow.nodes.find((item) => item.id === "N6");

    assert.deepEqual({
      status: node.translationStatus,
      mode: node.participants.mode,
      subjectKind: node.participants.subjectKind,
      fieldId: node.participants.fieldId,
      fieldTitle: node.participants.fieldTitle,
      companyRole: node.participants.companyRole,
      departmentRole: node.participants.departmentRole
    }, {
      status: "executable",
      mode: "field_role_line_script",
      subjectKind: "field",
      fieldId: "fd_select_person",
      fieldTitle: "报修人",
      companyRole: "公司级IT-IT主管",
      departmentRole: "公司级IT主管"
    });
    assert.deepEqual(
      inspectWorkflowFormulaProvenance(source, draft)
        .filter((inspection) => inspection.nodeId === "N6")
        .map((inspection) => ({ status: inspection.status, expectedMode: inspection.expectedMode })),
      [{ status: "matched", expectedMode: "field_role_line_script" }]
    );

    const workflow = focusedRoleLineWorkflow(node);
    const trusted = sampleTrustedDsl({ form: draft.form, workflow });
    assert.equal(validateMigrationDsl(trusted, { mode: "execute" }).ok, true);
    const template = projectTemplate(trusted);
    const verified = verifyTemplate(trusted, template);
    assert.equal(verified.ok, true, JSON.stringify(verified.diagnostics, null, 2));
    const projected = projectFocusedRoleLine(node, draft.form);
    assert.deepEqual(nativeRoleLineProjection(projected), {
      handlerIds: "",
      handlerNames: "",
      script:
        'return ${func.sysRole.resolveRoleLine}(${data.template-id-fd_select_person}, "公司级IT-IT主管", "公司级IT主管")',
      display:
        'return #解释角色线#($内置表单.报修人$, "公司级IT-IT主管", "公司级IT主管")'
    });
  });

  it("fails closed when the id and display formulas disagree on role arguments", () => {
    for (const replacement of ['"不一致的角色"', "$无法解析的显示公式$"]) {
      const source = cleanSourceFile(ARBITRARY_FIELD_ROLE_SOURCE);
      const sourceNode = source.workflow.nodes.find((item) => item.id === "N6");
      for (const attributes of [sourceNode.attributes, sourceNode.definition?.attributes].filter(Boolean)) {
        attributes.handlerNames = replacement.startsWith("$")
          ? replacement
          : attributes.handlerNames.replace('"公司级IT主管"', replacement);
      }

      const node = draftSourceDraft(source).workflow.nodes.find((item) => item.id === "N6");
      assert.equal(node.participants.mode, "unmapped_formula");
      assert.equal(node.translationStatus, "pending_review");
    }
  });

  it("keeps a node-history subject inside the role-line function and clears legacy handlers", () => {
    const draft = draftSourceDraft(cleanSourceFile(NODE_HISTORY_ROLE_SOURCE));
    const node = draft.workflow.nodes.find((item) => item.id === "N3");
    const projected = projectFocusedRoleLine(node, draft.form);

    assert.deepEqual(nativeRoleLineProjection(projected), {
      handlerIds: "",
      handlerNames: "",
      script:
        'return ${func.sysRole.resolveRoleLine}(${func.lbpm.getNodeHistoryHandlers}("N2", false), "未知公司角色", "未知部门角色")',
      display:
        'return #解释角色线#(#获取节点历史处理人#("N2", false), "未知公司角色", "未知部门角色")'
    });
  });

  it("fails closed when a node-history display formula is present but malformed", () => {
    const source = cleanSourceFile(NODE_HISTORY_ROLE_SOURCE);
    const sourceNode = source.workflow.nodes.find((item) => item.id === "N3");
    for (const attributes of [sourceNode.attributes, sourceNode.definition?.attributes].filter(Boolean)) {
      attributes.handlerNames = "$无法解析的显示公式$";
    }

    const node = draftSourceDraft(source).workflow.nodes.find((item) => item.id === "N3");
    assert.equal(node.participants.mode, "unmapped_formula");
    assert.equal(node.translationStatus, "pending_review");
  });
});

function projectFocusedRoleLine(roleLineNode, form) {
  const workflow = focusedRoleLineWorkflow(roleLineNode);
  return buildWorkflowContent(workflow, {
    templateId: "template-id",
    form
  }).elements.find((element) => element.id === roleLineNode.id);
}

function focusedRoleLineWorkflow(roleLineNode) {
  const start = workflowNode("N_ROLE_LINE_START", "generalStart", "startEvent", "startNode");
  const end = workflowNode("N_ROLE_LINE_END", "generalEnd", "endEvent", "endNode");
  return {
    process: { id: `role-line-${roleLineNode.id}` },
    nodes: [start, roleLineNode, end],
    edges: [
      workflowEdge("L_ROLE_LINE_IN", start.id, roleLineNode.id),
      workflowEdge("L_ROLE_LINE_OUT", roleLineNode.id, end.id)
    ],
    topologicalOrder: [start.id, roleLineNode.id, end.id]
  };
}

function nativeRoleLineProjection(node) {
  const rule = JSON.parse(node.handlers.ruleKey);
  return {
    handlerIds: node.handlerIds,
    handlerNames: node.handlerNames,
    script: rule.script,
    display: rule.vo.content
  };
}

function workflowNode(id, type, element, sourceType) {
  return {
    id,
    type,
    element,
    name: id,
    sourceType,
    sourceRef: `source.workflow.node.${id}`,
    attributes: {},
    translationStatus: "executable"
  };
}

function workflowEdge(id, source, target) {
  return {
    id,
    source,
    target,
    sourceRef: `source.workflow.edge.${id}`,
    condition: { translationStatus: "executable" }
  };
}
