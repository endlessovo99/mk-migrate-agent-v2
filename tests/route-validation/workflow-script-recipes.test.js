import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowContent, projectTemplate, verifyTemplate } from "../helpers/persistence.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { translateLegacyConditionContextReferences } from "../../src/dsl/condition-context.js";

const ROLE_LINE_SOURCE = "tests/fixtures/source/19ca1bf6a201d607679a76d4609a3e87";
const CREATOR_PATH_SOURCE = "tests/fixtures/source/195023f8389d40797436b304835a3525";
const CREATOR_DEPT_SOURCE = "tests/fixtures/source/191e3d177105738cef50e6545cd8c01f";

describe("workflow Script recipes", () => {
  it("translates legacy fdDepartment conditions to the NewOA creator-department context", () => {
    const sourceDraft = cleanSourceFile(CREATOR_DEPT_SOURCE);
    const dslDraft = draftSourceDraft(sourceDraft);

    assert.equal(dslDraft.form.fields.some((field) => field.id === "fdDepartment"), false);

    for (const edgeId of ["L57", "L587"]) {
      const edge = dslDraft.workflow.edges.find((item) => item.id === edgeId);
      assert.match(edge.condition.sourceText, /\$fdDepartment\$/);
      assert.doesNotMatch(edge.condition.targetText, /\$fdDepartment\$/);
      assert.match(edge.condition.targetText, /\$context\.creatorDept\.fdName\$/);

      const content = buildWorkflowContent(focusedConditionWorkflow(edge), {
        templateId: "template-id",
        form: dslDraft.form
      });
      const projected = content.elements.find((element) => element.id === edgeId);
      const formula = JSON.parse(projected.formula);
      const creatorDeptContains = formula.vars.find((variable) =>
        variable.value === "global.contains" &&
        variable.arguments?.some((argument) =>
          argument.type === "Var" && argument.value === "template-id-fdCreatorDept.fdName"
        )
      );

      assert.equal(formula.type, "Batch");
      assert.ok(creatorDeptContains, `${edgeId} should read NewOA fdCreatorDept.fdName`);
      assert.match(formula.result.value, /&&/);
      assert.match(formula.result.value, /\|\|/);
    }
  });

  it("verifies the creator-department context binding through native readback", () => {
    const dslDraft = draftSourceDraft(cleanSourceFile(CREATOR_DEPT_SOURCE));

    for (const edgeId of ["L57", "L587"]) {
      const sourceEdge = dslDraft.workflow.edges.find((item) => item.id === edgeId);
      const workflow = focusedConditionWorkflow(sourceEdge);
      const trusted = sampleTrustedDsl({ form: dslDraft.form, workflow });
      const template = projectTemplate(trusted);
      const verified = verifyTemplate(trusted, template);

      assert.equal(verified.ok, true, JSON.stringify(verified.diagnostics, null, 2));

      const lbpm = template.mechanisms.lbpmTemplate[0];
      const content = JSON.parse(lbpm.fdContent);
      const edge = content.elements.find((element) => element.id === edgeId);
      const formula = JSON.parse(edge.formula);
      const contains = formula.vars.find((variable) =>
        variable.value === "global.contains" && variable.arguments?.some((argument) =>
          argument.type === "Var" && argument.value === "template-id-fdCreatorDept.fdName"
        )
      );
      contains.arguments.find((argument) => argument.type === "Var").value = "template-id-wrong-field";
      edge.formula = JSON.stringify(formula);
      lbpm.fdContent = JSON.stringify(content);

      const mutated = verifyTemplate(trusted, template);
      assert.equal(mutated.ok, false, edgeId);
      assert.equal(mutated.diagnostics.some((item) =>
        item.code === "readback.workflow.edge_condition_native_semantic_mismatch"
      ), true, edgeId);
    }
  });

  it("does not rewrite real form fields or quoted legacy-looking text", () => {
    const condition = '$字符串.包含$($fdDepartment$, "literal $fdDepartment$")';

    assert.equal(
      translateLegacyConditionContextReferences(condition, new Set(["fdDepartment"])),
      condition
    );
    assert.equal(
      translateLegacyConditionContextReferences(condition),
      '$字符串.包含$($context.creatorDept.fdName$, "literal $fdDepartment$")'
    );
  });

  it("maps common field role lines and routes related leaders to the configured person fallback", () => {
    const sourceDraft = cleanSourceFile(ROLE_LINE_SOURCE);
    const dslDraft = draftSourceDraft(sourceDraft);
    const formulaNodes = dslDraft.workflow.nodes.filter((node) =>
      node.attributes?.handlerSelectType === "formula"
    );
    const common = formulaNodes.filter((node) =>
      node.participants?.mode === "field_role_line_script"
    );
    const configuredFallbacks = formulaNodes.filter((node) =>
      node.participants?.mode === "configured_person_fallback"
    );

    assert.equal(common.filter((node) => node.participants.recipe === "department_head").length, 39);
    assert.equal(common.filter((node) => node.participants.recipe === "superior_department_head").length, 47);
    assert.equal(configuredFallbacks.length, 25);
    assert.equal(configuredFallbacks.every((node) =>
      node.participants.sourceExpression.includes("公司级相关领导")
    ), true);
    assert.equal(common.every((node) => node.translationStatus === "executable"), true);
    assert.equal(configuredFallbacks.every((node) => node.translationStatus === "executable"), true);
    assert.equal(formulaNodes.some((node) => node.participants?.mode === "unmapped_formula"), false);

    const departmentNode = dslDraft.workflow.nodes.find((node) => node.id === "N560");
    const superiorNode = dslDraft.workflow.nodes.find((node) => node.id === "N175");
    const focusedWorkflow = {
      process: { id: "field-role-line-script" },
      nodes: [
        { id: "N_TEST_START", type: "generalStart", element: "startEvent", name: "开始", sourceType: "startNode", sourceRef: "source.workflow.node.N_TEST_START", attributes: {}, translationStatus: "executable" },
        departmentNode,
        superiorNode,
        { id: "N_TEST_END", type: "generalEnd", element: "endEvent", name: "结束", sourceType: "endNode", sourceRef: "source.workflow.node.N_TEST_END", attributes: {}, translationStatus: "executable" }
      ],
      edges: [
        { id: "L_TEST_1", source: "N_TEST_START", target: departmentNode.id, sourceRef: "source.workflow.edge.L_TEST_1", condition: { translationStatus: "executable" } },
        { id: "L_TEST_2", source: departmentNode.id, target: superiorNode.id, sourceRef: "source.workflow.edge.L_TEST_2", condition: { translationStatus: "executable" } },
        { id: "L_TEST_3", source: superiorNode.id, target: "N_TEST_END", sourceRef: "source.workflow.edge.L_TEST_3", condition: { translationStatus: "executable" } }
      ],
      topologicalOrder: ["N_TEST_START", departmentNode.id, superiorNode.id, "N_TEST_END"]
    };
    const content = buildWorkflowContent(focusedWorkflow, {
      templateId: "template-id",
      form: dslDraft.form
    });
    const departmentHead = content.elements.find((element) => element.id === "N560");
    const superiorHead = content.elements.find((element) => element.id === "N175");
    const departmentRule = JSON.parse(departmentHead.handlers.ruleKey);
    const superiorRule = JSON.parse(superiorHead.handlers.ruleKey);
    assert.equal(departmentRule.type, "Script");
    assert.match(departmentRule.script, /func\.sysorg\.getDepartmentHead/);
    assert.match(departmentRule.script, /template-id-fd_38c40aef38e5d8/);
    assert.equal(superiorRule.type, "Script");
    assert.match(superiorRule.script, /func\.sysorg\.getSuperiorDepartmenthead/);
    assert.match(superiorRule.script, /template-id-fd_38c40af374c0ee/);
  });

  it("projects creator parent-path contains on L34 as a boolean Script condition", () => {
    const sourceDraft = cleanSourceFile(CREATOR_PATH_SOURCE);
    const dslDraft = draftSourceDraft(sourceDraft);
    const content = buildWorkflowContent(dslDraft.workflow, {
      templateId: "template-id",
      form: dslDraft.form
    });
    const edge = content.elements.find((element) => element.id === "L34");
    const formula = JSON.parse(edge.formula);

    assert.equal(edge.formulaType, "formula");
    assert.equal(formula.type, "Script");
    assert.equal(formula.vo.mode, "script");
    assert.match(formula.script, /func\.sysorg\.getDepartmentAllPath/);
    assert.match(formula.script, /data\._ProcessCreator/);
    assert.match(formula.script, /上海电气电站设备有限公司发电机厂/);
    assert.equal(formula.resultType.type, "boolean");

    const branch = content.elements.find((element) => element.id === "N26");
    const route = JSON.parse(branch.conditionValue).formulas.find((item) => item.lineId === "L34");
    assert.equal(route.mode, "script");
    assert.equal(route.formula.type, "Script");
    assert.equal(route.conditionSimpleData, undefined);
  });

  it("verifies creator parent-path Script conditions through native readback", () => {
    const condition = '$字符串.包含$($docCreator$.getFdParentsName("/"), "上海电气电站设备有限公司发电机厂")';
    const node = (id, type, element, sourceType) => ({
      id,
      type,
      element,
      name: id,
      sourceType,
      sourceRef: `source.workflow.node.${id}`,
      attributes: {},
      translationStatus: "executable"
    });
    const workflow = {
      process: { id: "creator-path-script" },
      nodes: [
        node("N1", "generalStart", "startEvent", "startNode"),
        node("N2", "conditionBranch", "exclusiveGateway", "autoBranchNode"),
        node("N3", "review", "manualTask", "reviewNode"),
        node("N4", "review", "manualTask", "reviewNode"),
        node("N5", "generalEnd", "endEvent", "endNode")
      ],
      edges: [
        { id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1", condition: { translationStatus: "executable" } },
        { id: "L2", source: "N2", target: "N3", sourceRef: "source.workflow.edge.L2", name: "上发", condition: { sourceText: condition, displayText: condition, targetText: condition, translationStatus: "display_only" } },
        { id: "L3", source: "N2", target: "N4", sourceRef: "source.workflow.edge.L3", name: "其他", condition: { sourceText: "1==1", displayText: "其他", targetText: "1==1", translationStatus: "display_only" } },
        { id: "L4", source: "N3", target: "N5", sourceRef: "source.workflow.edge.L4", condition: { translationStatus: "executable" } },
        { id: "L5", source: "N4", target: "N5", sourceRef: "source.workflow.edge.L5", condition: { translationStatus: "executable" } }
      ],
      topologicalOrder: ["N1", "N2", "N3", "N4", "N5"]
    };
    const trusted = sampleTrustedDsl({ workflow });
    const template = projectTemplate(trusted);
    const verified = verifyTemplate(trusted, template);

    assert.equal(verified.ok, true, JSON.stringify(verified.diagnostics, null, 2));

    const lbpm = template.mechanisms.lbpmTemplate[0];
    const content = JSON.parse(lbpm.fdContent);
    const edge = content.elements.find((element) => element.id === "L2");
    const formula = JSON.parse(edge.formula);
    formula.script = 'var creator = ${data._ProcessCreator}; var path = ${func.sysorg.getDepartmentAllPath}("wrong-input"); return "上海电气电站设备有限公司发电机厂".indexOf("上海电气电站设备有限公司发电机厂") !== -1;';
    edge.formula = JSON.stringify(formula);
    lbpm.fdContent = JSON.stringify(content);

    const mutated = verifyTemplate(trusted, template);
    assert.equal(mutated.ok, false);
    assert.equal(mutated.diagnostics.some((item) =>
      item.code === "readback.workflow.edge_condition_native_corrupt"
    ), true);
  });

  it("validates and verifies field role-line Script handlers through native readback", () => {
    const sourceExpression = '$组织架构.解释角色线$($fd_subject$, "公司级部门领导", "部门领导")';
    const workflow = {
      process: { id: "field-role-line-readback" },
      nodes: [
        { id: "N1", type: "generalStart", element: "startEvent", name: "开始", sourceType: "startNode", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
        {
          id: "N2",
          type: "review",
          element: "manualTask",
          name: "部门领导",
          sourceType: "reviewNode",
          sourceRef: "source.workflow.node.N2",
          attributes: { handlerSelectType: "formula", handlerIds: sourceExpression, handlerNames: sourceExpression },
          participants: {
            mode: "field_role_line_script",
            recipe: "department_head",
            subjectKind: "field",
            fieldId: "fd_subject",
            sourceFieldId: "fd_subject",
            fieldTitle: "主题",
            companyRole: "公司级部门领导",
            departmentRole: "部门领导",
            sourceExpression,
            sourceNameExpression: sourceExpression
          },
          translationStatus: "executable"
        },
        { id: "N3", type: "generalEnd", element: "endEvent", name: "结束", sourceType: "endNode", sourceRef: "source.workflow.node.N3", attributes: {}, translationStatus: "executable" }
      ],
      edges: [
        { id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1", condition: { translationStatus: "executable" } },
        { id: "L2", source: "N2", target: "N3", sourceRef: "source.workflow.edge.L2", condition: { translationStatus: "executable" } }
      ],
      topologicalOrder: ["N1", "N2", "N3"]
    };
    const trusted = sampleTrustedDsl({ workflow });
    assert.equal(validateMigrationDsl(trusted, { mode: "execute" }).ok, true);
    const template = projectTemplate(trusted);
    const verified = verifyTemplate(trusted, template);
    assert.equal(verified.ok, true, JSON.stringify(verified.diagnostics, null, 2));
  });
});

function focusedConditionWorkflow(edge) {
  const condition = edge.condition || {
    sourceText: edge.sourceText,
    displayText: edge.displayText,
    targetText: edge.targetText,
    translationStatus: "display_only"
  };
  const route = {
    ...edge,
    source: "N_CONTEXT_BRANCH",
    target: "N_CONTEXT_MATCH",
    condition
  };
  return {
    process: { id: `creator-dept-${edge.id}` },
    nodes: [
      workflowNode("N_CONTEXT_START", "generalStart", "startEvent", "startNode"),
      workflowNode("N_CONTEXT_BRANCH", "conditionBranch", "exclusiveGateway", "autoBranchNode"),
      workflowNode("N_CONTEXT_MATCH", "review", "manualTask", "reviewNode"),
      workflowNode("N_CONTEXT_OTHER", "review", "manualTask", "reviewNode"),
      workflowNode("N_CONTEXT_END", "generalEnd", "endEvent", "endNode")
    ],
    edges: [
      workflowEdge("L_CONTEXT_IN", "N_CONTEXT_START", "N_CONTEXT_BRANCH"),
      route,
      {
        ...workflowEdge("L_CONTEXT_OTHER", "N_CONTEXT_BRANCH", "N_CONTEXT_OTHER"),
        name: "其他",
        condition: {
          sourceText: "1==1",
          displayText: "其他",
          targetText: "1==1",
          translationStatus: "display_only"
        }
      },
      workflowEdge("L_CONTEXT_MATCH_END", "N_CONTEXT_MATCH", "N_CONTEXT_END"),
      workflowEdge("L_CONTEXT_OTHER_END", "N_CONTEXT_OTHER", "N_CONTEXT_END")
    ],
    topologicalOrder: [
      "N_CONTEXT_START",
      "N_CONTEXT_BRANCH",
      "N_CONTEXT_MATCH",
      "N_CONTEXT_OTHER",
      "N_CONTEXT_END"
    ]
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
    name: "",
    sourceRef: `source.workflow.edge.${id}`,
    attributes: {},
    condition: {
      sourceText: "",
      displayText: "",
      targetText: "",
      translationStatus: "executable"
    }
  };
}
