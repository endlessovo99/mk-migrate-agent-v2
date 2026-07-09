import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { executeDsl } from "../../src/executor/execute.js";
import { applyFormPayload, summarizeFormFromTemplate } from "../../src/executor/form-payload.js";
import { applyWorkflowPayload, buildWorkflowContent } from "../../src/executor/workflow-payload.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sampleDraftDsl, sampleForm, sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("executeDsl", () => {
  it("writes one draft template through an injected NewOA client and verifies readback", async () => {
    const client = new FakeNewoaClient();
    const result = await withNewoaEnv(() => executeDsl(sampleTrustedDsl(), {
      client,
      confirmWrite: true,
      targetCategoryId: "category-1",
      now: new Date("2026-07-05T01:02:03.000Z")
    }));

    assert.equal(result.ok, true);
    assert.equal(result.status, "written");
    assert.equal(result.templateId, "created-template-id");
    assert.deepEqual(result.createdFdIds, ["created-template-id"]);
    assert.deepEqual(client.calls.map((call) => call.name), [
      "login",
      "initTemplate",
      "generateTableName",
      "loadParentCategory",
      "addTemplate",
      "getTemplate",
      "updateTemplate",
      "getTemplate"
    ]);

    const addPayload = client.calls.find((call) => call.name === "addTemplate").payload;
    assert.equal(addPayload.fdName.startsWith("MK_TEST_示例流程_20260705010203"), true);
    assert.deepEqual(addPayload.fdCategory, { fdId: "category-1" });
    assert.equal(addPayload.fdTableName, "generated_table_name");
    assert.equal(addPayload.mechanisms.lbpmTemplate[0].isDraft, true);

    const updatePayload = client.calls.find((call) => call.name === "updateTemplate").payload;
    const xformConfig = JSON.parse(updatePayload.mechanisms["sys-xform"].fdConfig);
    assert.equal(xformConfig.migrationDsl.form.fieldCount, 3);
    assert.equal(xformConfig.migrationDsl.form.layoutRowCount, 2);
    assert.deepEqual(xformConfig.migrationDsl.form.layoutRows.map((row) => row.fields), [
      ["fd_subject", "fd_amount"],
      ["fd_detail"]
    ]);
    const viewConfig = JSON.parse(xformConfig.viewModel[0].fdConfig);
    const firstLayout = viewConfig.view.render.desktop[0].children[0].children[0];
    assert.equal(firstLayout.controlProps.migrationLayoutComponentId, "xform-flex-1-2-layout");
    assert.equal(firstLayout.children[0].controlProps.columns, 2);

    const flowContent = JSON.parse(updatePayload.mechanisms.lbpmTemplate[0].fdContent);
    const sequence = flowContent.elements.find((element) => element.id === "L1");
    assert.equal(flowContent.elements.find((element) => element.id === "N1").type, "generalStart");
    assert.equal(flowContent.elements.find((element) => element.id === "N2").type, "generalEnd");
    assert.equal(sequence.sourceRef, "N1");
    assert.equal(sequence.targetRef, "N2");
    assert.equal(sequence.migrationSource.sourceRef, "source.workflow.edge.L1");
    assert.equal(result.readback.form.fieldCount, 3);
    assert.equal(result.readback.workflow.invalidEdgeCount, 0);
  });

  it("writes all parallel split and join gateways into MK workflow content", () => {
    const content = buildWorkflowContent(sampleParallelGatewayWorkflow());
    const split = content.elements.find((element) => element.id === "N2");
    const join = content.elements.find((element) => element.id === "N4");
    const splitFlow = content.elements.find((element) => element.id === "L2");

    assert.equal(split.type, "split");
    assert.equal(split.element, "parallelGateway");
    assert.equal(split.splitType, "1");
    assert.equal(split.gatewayDirection, "diverging");
    assert.equal(split.scope, "branch");
    assert.equal(split.relateId, "N4");
    assert.equal(join.type, "join");
    assert.equal(join.element, "parallelGateway");
    assert.equal(join.joinType, "1");
    assert.equal(join.gatewayDirection, "converging");
    assert.equal(join.hidden, true);
    assert.equal(join.relateId, "N2");
    assert.equal(splitFlow.sourceRef, "N2");
    assert.equal(splitFlow.targetRef, "N3");
  });

  it("writes form-field formula participants as dynamic handler formulas", () => {
    const form = sampleForm();
    form.fields.push({
      id: "fd_handler",
      title: "处理人字段",
      type: "text",
      componentId: "xform-address",
      props: {},
      sourceProps: { designerType: "address" },
      sourceRef: "source.form.control.fd_handler"
    });
    const payload = applyWorkflowPayload(baseTemplate(), sampleTrustedDsl({
      form,
      workflow: {
        process: { id: "process-form-field-handler" },
        nodes: [
          { id: "N1", type: "generalStart", element: "startEvent", name: "开始", sourceType: "startNode", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
          {
            id: "N2",
            type: "review",
            element: "manualTask",
            name: "字段处理人审批",
            sourceType: "reviewNode",
            sourceRef: "source.workflow.node.N2",
            attributes: { handlerIds: "$fd_handler$", handlerNames: "$处理人字段$", handlerSelectType: "formula" },
            participants: {
              mode: "form_field",
              fieldId: "fd_handler",
              fieldTitle: "处理人字段",
              sourceExpression: "$fd_handler$",
              sourceNameExpression: "$处理人字段$"
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
      }
    }));
    const content = JSON.parse(payload.mechanisms.lbpmTemplate[0].fdContent);
    const node = content.elements.find((element) => element.id === "N2");

    assert.equal(node.handlerSelectType, "formula");
    assert.equal(node.handlerIds, "$fd_handler$");
    assert.equal(node.handlerNames, "$处理人字段$");
    assert.equal(node.handlers.id, "handlers");
    assert.equal(node.handlers.type, "formula");
    assert.equal(node.handlers.source, "2");
    assert.equal(node.handlers.element, "users");
    assert.deepEqual(node.handlers.members, []);
    assert.equal(node.handlers.ruleMode, "simple");
    assert.equal(node.handlers.formulaType, "formula");
    assert.equal(node.handlers.ruleName, "$处理人字段$");
    assert.equal(node.handlers.ruleKey.type, "Eval");
    assert.equal(node.handlers.ruleKey.script, "${data.template-id-fd_handler}");
    assert.deepEqual(node.handlers.ruleKey.varIds, ["template-id-fd_handler"]);
    assert.equal(node.handlers.ruleKey.vo.content, "$处理人字段$");
    assert.equal(node.handlers.ruleKey.mode, "simple");
    assert.equal(node.handlers.ruleKey.formulaName, "$处理人字段$");
  });

  it("writes role-line formula participants as dynamic handler formulas", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/19bb55286bd93a6081a33e44c3791374");
    const dslDraft = draftSourceDraft(sourceDraft);
    const content = buildWorkflowContent(dslDraft.workflow, {
      templateId: "template-id",
      form: dslDraft.form
    });
    const node = content.elements.find((element) => element.id === "N53");

    assert.equal(node.name, "申请部门相关领导");
    assert.equal(node.handlerSelectType, "formula");
    assert.equal(node.handlers.type, "formula");
    assert.equal(node.handlers.source, "2");
    assert.equal(node.handlers.ruleName, "$组织架构.解释角色线$($部门固资管理员$, \"公司级相关领导\", \"部门相关领导\")");
    assert.equal(node.handlers.ruleKey.type, "Eval");
    assert.equal(
      node.handlers.ruleKey.script,
      "$组织架构.解释角色线$(${data.template-id-fd_371229badb4b1a}, \"公司级相关领导\", \"部门相关领导\")"
    );
    assert.deepEqual(node.handlers.ruleKey.varIds, ["template-id-fd_371229badb4b1a"]);
    assert.equal(
      node.handlers.ruleKey.vo.content,
      "$组织架构.解释角色线$($部门固资管理员$, \"公司级相关领导\", \"部门相关领导\")"
    );
    assert.deepEqual(node.handlers.members, []);
  });

  it("writes legacy robot nodes with selectable robot type and preserved config", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/19bb55286bd93a6081a33e44c3791374");
    const dslDraft = draftSourceDraft(sourceDraft);
    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "test-reviewer",
      checkedAt: "2026-07-09T00:00:00.000Z"
    });
    const content = buildWorkflowContent(trusted.workflow, {
      templateId: "template-id",
      form: trusted.form
    });
    const node = content.elements.find((element) => element.id === "N65");

    assert.equal(node.type, "robot");
    assert.equal(node.element, "robot");
    assert.equal(node.robotType.controlId, "LBPMExtendComponent");
    assert.equal(node.robotType.key, "restRobotNode");
    assert.equal(node.robotType.sourceUnid, "*@Robot@restRobotNode");

    const robotConfig = JSON.parse(node.robotConfig);
    assert.equal(
      robotConfig.restfulUrl,
      "https://owork.shanghai-electric.com/api/workflow/hooks/Njc5MDhkYTEyNDdlM2E2OTUwMjYxY2Fi"
    );
    assert.equal(robotConfig.successParam.successFieldName, "success");
    assert.equal(
      robotConfig.formParams.find((param) => param.fieldName === "repDeviceId").fieldText,
      "$明细表5.维修设备编号$"
    );
  });

  it("writes legacy right sections into NewOA template form auths", () => {
    const expectedFields = [
      "fd_3ea698a0fa7c78",
      "fd_3ea698a261c666",
      "fd_3ea8c4b09da4fe",
      "fd_3ea8c511ffc138",
      "fd_3ea8c5326b3754",
      "fd_3ea8c5b2213ef2"
    ];
    const trusted = trustedDslFromFixture("tests/fixtures/source/16a8c7e6740bd9caad821ba447dbf330");
    const payload = applyWorkflowPayload(baseTemplate(), trusted);
    const lbpm = payload.mechanisms.lbpmTemplate[0];
    const auth = lbpm.fdTemplateFormAuths.N2;
    const content = JSON.parse(lbpm.fdContent);

    assert.deepEqual(Object.keys(auth).sort(), expectedFields);
    assert.deepEqual(auth.fd_3ea698a261c666, {
      isShow: false,
      isEdit: false,
      isRequire: false
    });
    assert.equal(content.elements.find((element) => element.id === "N2").openDataAuthority, true);
    assert.equal(content.elements.find((element) => element.id === "N1").openDataAuthority, false);
  });

  it("writes conditional branch routes through the MK formula designer config", () => {
    const payload = applyWorkflowPayload(baseTemplate(), sampleTrustedDsl({
      form: sampleConditionBranchForm(),
      workflow: sampleConditionBranchWorkflow()
    }));
    const content = JSON.parse(payload.mechanisms.lbpmTemplate[0].fdContent);
    const branch = content.elements.find((element) => element.id === "N410");
    const conditionValue = JSON.parse(branch.conditionValue);
    const formulaRoute = conditionValue.formulas.find((route) => route.lineId === "L541");
    const orRoute = conditionValue.formulas.find((route) => route.lineId === "L546");
    const defaultRoute = conditionValue.formulas.find((route) => route.lineId === "L544");
    const sequence = content.elements.find((element) => element.id === "L541");
    const orSequence = content.elements.find((element) => element.id === "L546");
    const defaultSequence = content.elements.find((element) => element.id === "L544");
    const sequenceFormula = JSON.parse(sequence.formula);
    const orSequenceFormula = JSON.parse(orSequence.formula);

    assert.equal(branch.conditionType, "1");
    assert.equal(conditionValue.rules, undefined);
    assert.equal(conditionValue.ruleConfig, undefined);
    assert.equal(formulaRoute.type, "formulas");
    assert.equal(formulaRoute.formulaName, "");
    assert.deepEqual(formulaRoute.conditionSimpleData, formulaRoute.formula);
    assert.deepEqual(formulaRoute.formulaConfig, formulaRoute.formula);
    assert.equal(formulaRoute.formula.type, "Batch");
    assert.equal(formulaRoute.formula.result.value, "(${data.$VAR.L541_fd_seller})");
    assert.equal(formulaRoute.formula.vars[0].value, "${data.template-id-fd_seller} == \"1689\"");
    assert.deepEqual(formulaRoute.formula.vo, {
      mode: "simple",
      modeType: "simpleRule",
      data: {
        key: "ROOT",
        fdKey: "L541_ROOT",
        leavel: "1",
        fdList: [{
          fdKey: "L541_group",
          fdType: "OR",
          leavel: "1",
          parentLeavel: "1-1",
          parentKey: "L541_ROOT",
          metaType: "GROUP",
          fdList: [{
            fdKey: "L541_fd_seller",
            metaType: "RULE",
            parentKey: "L541_group",
            parentLeavel: "1-1",
            leavel: "3",
            fdVarValue: "template-id-fd_seller",
            fdDataType: "string",
            fdLabel: "$合同卖方$",
            vo: { type: "string", required: false, description: "合同卖方", maxLength: 200 },
            fdSymbol: "==",
            fdValue: "1689"
          }]
        }]
      }
    });
    assert.equal(orRoute.lineName, "辽宁、东营");
    assert.equal(orRoute.formula.result.value, "(${data.$VAR.L546_fd_seller_1} || ${data.$VAR.L546_fd_seller_2})");
    assert.deepEqual(orRoute.formula.vars.map((item) => item.value), [
      "${data.template-id-fd_seller} == \"1694\"",
      "${data.template-id-fd_seller} == \"1695\""
    ]);
    assert.deepEqual(orRoute.formula.vo.data.fdList[0].fdList.map((rule) => ({
      fdKey: rule.fdKey,
      fdVarValue: rule.fdVarValue,
      fdLabel: rule.fdLabel,
      fdSymbol: rule.fdSymbol,
      fdValue: rule.fdValue,
      parentKey: rule.parentKey
    })), [
      {
        fdKey: "L546_fd_seller_1",
        fdVarValue: "template-id-fd_seller",
        fdLabel: "$合同卖方$",
        fdSymbol: "==",
        fdValue: "1694",
        parentKey: "L546_group"
      },
      {
        fdKey: "L546_fd_seller_2",
        fdVarValue: "template-id-fd_seller",
        fdLabel: "$合同卖方$",
        fdSymbol: "==",
        fdValue: "1695",
        parentKey: "L546_group"
      }
    ]);
    assert.equal(defaultRoute.defaultTrend, true);
    assert.equal(sequence.formulaType, "formula");
    assert.equal(sequence.formulaName, "");
    assert.deepEqual(sequenceFormula, formulaRoute.formula);
    assert.equal(orSequence.formulaType, "formula");
    assert.deepEqual(orSequenceFormula, orRoute.formula);
    assert.equal(defaultSequence.defaultTrend, true);
    assert.equal(defaultSequence.formulaType, "formula");
    assert.equal(defaultSequence.formula, "");
    assert.equal(defaultSequence.style, "sequenceFlow;marker");
  });

  it("writes field-left equals conditional branch routes through formula config", () => {
    const workflow = sampleConditionBranchWorkflow();
    workflow.edges[1] = {
      ...workflow.edges[1],
      condition: {
        sourceText: "$fd_seller$ .equals(\"1689\") ",
        displayText: "$合同卖方$ .equals(\"1689\") ",
        targetText: "$fd_seller$ .equals(\"1689\") ",
        translationStatus: "display_only"
      }
    };
    const payload = applyWorkflowPayload(baseTemplate(), sampleTrustedDsl({
      form: sampleConditionBranchForm(),
      workflow
    }));
    const content = JSON.parse(payload.mechanisms.lbpmTemplate[0].fdContent);
    const branch = content.elements.find((element) => element.id === "N410");
    const conditionValue = JSON.parse(branch.conditionValue);
    const route = conditionValue.formulas.find((item) => item.lineId === "L541");
    const sequence = content.elements.find((element) => element.id === "L541");

    assert.equal(route.formulaName, "");
    assert.deepEqual(route.conditionSimpleData, route.formula);
    assert.deepEqual(route.formulaConfig, route.formula);
    assert.equal(route.formula.vars[0].value, "${data.template-id-fd_seller} == \"1689\"");
    assert.equal(route.formula.vo.data.fdList[0].fdList[0].fdVarValue, "template-id-fd_seller");
    assert.equal(route.formula.vo.data.fdList[0].fdList[0].fdValue, "1689");
    assert.equal(sequence.formulaType, "formula");
    assert.deepEqual(JSON.parse(sequence.formula), route.formula);
  });

  it("writes contains conditional branch routes through formula config", () => {
    const workflow = sampleConditionBranchWorkflow();
    const rawCondition = "$字符串.包含$($fd_seller$, \"欧洲\")";
    workflow.edges[1] = {
      ...workflow.edges[1],
      condition: {
        sourceText: rawCondition,
        displayText: "$合同卖方$ 包含 \"欧洲\"",
        targetText: rawCondition,
        translationStatus: "display_only"
      }
    };
    const payload = applyWorkflowPayload(baseTemplate(), sampleTrustedDsl({
      form: sampleConditionBranchForm(),
      workflow
    }));
    const content = JSON.parse(payload.mechanisms.lbpmTemplate[0].fdContent);
    const branch = content.elements.find((element) => element.id === "N410");
    const conditionValue = JSON.parse(branch.conditionValue);
    const route = conditionValue.formulas.find((item) => item.lineId === "L541");
    const sequence = content.elements.find((element) => element.id === "L541");

    assert.equal(route.formulaName, "");
    assert.deepEqual(route.conditionSimpleData, route.formula);
    assert.deepEqual(route.formulaConfig, route.formula);
    assert.equal(route.formula.vars[0].type, "Function");
    assert.equal(route.formula.vars[0].value, "global.contains");
    assert.deepEqual(route.formula.vars[0].arguments, [
      {
        key: "X",
        resultType: { type: "any" },
        type: "Var",
        value: "template-id-fd_seller"
      },
      {
        key: "Y",
        resultType: { type: "any" },
        type: "Fixed",
        value: "欧洲"
      }
    ]);
    assert.equal(route.formula.vo.data.fdList[0].fdList[0].fdVarValue, "template-id-fd_seller");
    assert.equal(route.formula.vo.data.fdList[0].fdList[0].fdSymbol, "contain");
    assert.equal(route.formula.vo.data.fdList[0].fdList[0].fdFunctionId, "global.contains");
    assert.equal(route.formula.vo.data.fdList[0].fdList[0].fdValue, "欧洲");
    assert.equal(sequence.formulaType, "formula");
    assert.deepEqual(JSON.parse(sequence.formula), route.formula);
    assert.equal(sequence.formulaName, "");
  });

  it("writes NewOA simple condition option shapes for editable branch rules", () => {
    const routeForCondition = (rawCondition) => {
      const workflow = sampleConditionBranchWorkflow();
      workflow.edges[1] = {
        ...workflow.edges[1],
        condition: {
          sourceText: rawCondition,
          displayText: rawCondition,
          targetText: rawCondition,
          translationStatus: "display_only"
        }
      };
      const content = buildWorkflowContent(workflow, {
        templateId: "template-id",
        form: sampleConditionBranchForm()
      });
      const branch = content.elements.find((element) => element.id === "N410");
      return JSON.parse(branch.conditionValue).formulas.find((item) => item.lineId === "L541").formula;
    };

    const equals = routeForCondition("$fd_seller$ == \"1689\"");
    assert.equal(equals.vars[0].type, "Eval");
    assert.equal(equals.vars[0].value, "${data.template-id-fd_seller} == \"1689\"");
    assert.equal(equals.vo.data.fdList[0].fdList[0].fdSymbol, "==");

    const notEquals = routeForCondition("$fd_seller$ != \"1689\"");
    assert.equal(notEquals.vars[0].type, "Eval");
    assert.equal(notEquals.vars[0].value, "${data.template-id-fd_seller} u0021= \"1689\"");
    assert.equal(notEquals.vo.data.fdList[0].fdList[0].fdSymbol, "!=");

    const contains = routeForCondition("$字符串.包含$($fd_seller$, \"欧洲\")");
    assert.equal(contains.vars[0].type, "Function");
    assert.equal(contains.vars[0].value, "global.contains");
    assert.equal(contains.result.value, "(${data.$VAR.L541_fd_seller})");
    assert.equal(contains.vo.data.fdList[0].fdList[0].fdSymbol, "contain");
    assert.equal(contains.vo.data.fdList[0].fdList[0].fdFunctionId, "global.contains");

    const notContains = routeForCondition("!$字符串.包含$($fd_seller$, \"欧洲\")");
    assert.equal(notContains.vars[0].type, "Function");
    assert.equal(notContains.vars[0].value, "global.contains");
    assert.equal(notContains.result.value, "(u0021${data.$VAR.L541_fd_seller})");
    assert.equal(notContains.vo.data.fdList[0].fdList[0].fdSymbol, "notcontain");
    assert.equal(notContains.vo.data.fdList[0].fdList[0].fdFunctionId, "global.contains");

    const empty = routeForCondition("$字符串.为空$($fd_seller$)");
    assert.equal(empty.vars[0].type, "Function");
    assert.equal(empty.vars[0].value, "global.isEmpty");
    assert.equal(empty.result.value, "(${data.$VAR.L541_fd_seller})");
    assert.equal(empty.vo.data.fdList[0].fdList[0].fdSymbol, "empty");
    assert.equal(empty.vo.data.fdList[0].fdList[0].fdFunctionId, "global.isEmpty");

    const notEmpty = routeForCondition("!$字符串.为空$($fd_seller$)");
    assert.equal(notEmpty.vars[0].type, "Function");
    assert.equal(notEmpty.vars[0].value, "global.isEmpty");
    assert.equal(notEmpty.result.value, "(u0021${data.$VAR.L541_fd_seller})");
    assert.equal(notEmpty.vo.data.fdList[0].fdList[0].fdSymbol, "notempty");
    assert.equal(notEmpty.vo.data.fdList[0].fdList[0].fdFunctionId, "global.isEmpty");
  });

  it("writes N437 contains department routes into editable simple conditions", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/14a08d7d8b8753e20198a5b4223b707e");
    const dslDraft = draftSourceDraft(sourceDraft);
    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "test-reviewer",
      checkedAt: "2026-07-09T00:00:00.000Z"
    });
    const content = buildWorkflowContent(trusted.workflow, {
      templateId: "template-id",
      form: trusted.form
    });
    const branch = content.elements.find((element) => element.id === "N437");
    const conditionValue = JSON.parse(branch.conditionValue);
    const planRoute = conditionValue.formulas.find((item) => item.lineId === "L571");
    const otherRoute = conditionValue.formulas.find((item) => item.lineId === "L570");
    const planRule = planRoute.formula.vo.data.fdList[0].fdList[0];
    const otherRule = otherRoute.formula.vo.data.fdList[0].fdList[0];

    assert.deepEqual(planRoute.conditionSimpleData, planRoute.formula);
    assert.deepEqual(planRoute.formulaConfig, planRoute.formula);
    assert.equal(planRule.fdVarValue, "template-id-fd_36b983442aa544");
    assert.equal(planRule.fdLabel, "$申请部门$");
    assert.equal(planRule.fdSymbol, "contain");
    assert.equal(planRule.fdFunctionId, "global.contains");
    assert.equal(planRule.fdValue, "计划项目");
    assert.equal(planRoute.formula.vars[0].type, "Function");
    assert.equal(planRoute.formula.vars[0].value, "global.contains");
    assert.deepEqual(otherRoute.conditionSimpleData, otherRoute.formula);
    assert.equal(otherRoute.formula.result.value, "(u0021${data.$VAR.L570_fd_36b983442aa544})");
    assert.equal(otherRule.fdSymbol, "notcontain");
    assert.equal(otherRule.fdFunctionId, "global.contains");
    assert.equal(otherRule.fdValue, "计划项目");
  });

  it("writes N415 other seller route with editable not-equals predicates", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/14a08d7d8b8753e20198a5b4223b707e");
    const dslDraft = draftSourceDraft(sourceDraft);
    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "test-reviewer",
      checkedAt: "2026-07-09T00:00:00.000Z"
    });
    const content = buildWorkflowContent(trusted.workflow, {
      templateId: "template-id",
      form: trusted.form
    });
    const branch = content.elements.find((element) => element.id === "N415");
    const conditionValue = JSON.parse(branch.conditionValue);
    const route = conditionValue.formulas.find((item) => item.lineId === "L548");
    const sequence = content.elements.find((element) => element.id === "L548");
    const routeFormula = route.formula;
    const rootGroup = routeFormula.vo.data.fdList[0];

    assert.equal(route.lineName, "其他");
    assert.equal(route.defaultTrend, true);
    assert.equal(route.formulaName, "");
    assert.deepEqual(route.conditionSimpleData, route.formula);
    assert.deepEqual(route.formulaConfig, route.formula);
    assert.equal(routeFormula.result.value, "(${data.$VAR.L548_fd_3580be5d4717ea_1} && ${data.$VAR.L548_fd_3580be5d4717ea_2})");
    assert.equal(rootGroup.fdType, "AND");
    assert.deepEqual(rootGroup.fdList.map((rule) => ({
      fdVarValue: rule.fdVarValue,
      fdLabel: rule.fdLabel,
      fdSymbol: rule.fdSymbol,
      fdValue: rule.fdValue,
      parentKey: rule.parentKey
    })), [
      {
        fdVarValue: "template-id-fd_3580be5d4717ea",
        fdLabel: "$合同卖方$",
        fdSymbol: "!=",
        fdValue: "1683",
        parentKey: "L548_group"
      },
      {
        fdVarValue: "template-id-fd_3580be5d4717ea",
        fdLabel: "$合同卖方$",
        fdSymbol: "!=",
        fdValue: "1684",
        parentKey: "L548_group"
      }
    ]);
    assert.equal(sequence.formulaType, "formula");
    assert.equal(sequence.formulaName, "");
    assert.deepEqual(JSON.parse(sequence.formula), routeFormula);
  });

  it("writes N257 mixed and/or routes into editable simple conditions", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/14a08d7d8b8753e20198a5b4223b707e");
    const dslDraft = draftSourceDraft(sourceDraft);
    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "test-reviewer",
      checkedAt: "2026-07-09T00:00:00.000Z"
    });
    const content = buildWorkflowContent(trusted.workflow, {
      templateId: "template-id",
      form: trusted.form
    });
    const branch = content.elements.find((element) => element.id === "N257");
    const conditionValue = JSON.parse(branch.conditionValue);
    const route = conditionValue.formulas.find((item) => item.lineId === "L406");
    const sequence = content.elements.find((element) => element.id === "L406");
    const routeFormula = route.formula;
    const rootGroup = routeFormula.vo.data.fdList[0];
    const incomeRule = rootGroup.fdList[0];
    const businessGroup = rootGroup.fdList[1];

    assert.equal(route.lineName, "已确认过收入仅开票---整体对外销售、材料销售及其他");
    assert.deepEqual(route.conditionSimpleData, route.formula);
    assert.deepEqual(route.formulaConfig, route.formula);
    assert.equal(route.formulaName, "");
    assert.equal(routeFormula.result.value, "(${data.$VAR.L406_fd_36d39121a4bbb2_1} && (${data.$VAR.L406_fd_376d6cbc433bfe_2} || ${data.$VAR.L406_fd_376d6cbc433bfe_3} || ${data.$VAR.L406_fd_376d6cbc433bfe_4}))");
    assert.equal(rootGroup.fdType, "AND");
    assert.equal(incomeRule.fdVarValue, "template-id-fd_36d39121a4bbb2");
    assert.equal(incomeRule.fdLabel, "$是否确认收入$");
    assert.equal(incomeRule.fdSymbol, "==");
    assert.equal(incomeRule.fdValue, "E");
    assert.equal(businessGroup.fdType, "OR");
    assert.deepEqual(businessGroup.fdList.map((rule) => ({
      fdVarValue: rule.fdVarValue,
      fdLabel: rule.fdLabel,
      fdSymbol: rule.fdSymbol,
      fdValue: rule.fdValue,
      parentKey: rule.parentKey
    })), [
      {
        fdVarValue: "template-id-fd_376d6cbc433bfe",
        fdLabel: "$业务类型$",
        fdSymbol: "==",
        fdValue: "B",
        parentKey: "L406_group_2"
      },
      {
        fdVarValue: "template-id-fd_376d6cbc433bfe",
        fdLabel: "$业务类型$",
        fdSymbol: "==",
        fdValue: "F",
        parentKey: "L406_group_2"
      },
      {
        fdVarValue: "template-id-fd_376d6cbc433bfe",
        fdLabel: "$业务类型$",
        fdSymbol: "==",
        fdValue: "G",
        parentKey: "L406_group_2"
      }
    ]);
    assert.equal(sequence.formulaType, "formula");
    assert.equal(sequence.formulaName, "");
    assert.deepEqual(JSON.parse(sequence.formula), routeFormula);
  });

  it("writes every fixture branch condition into editable formula configs", () => {
    const { content, trusted } = buildRouteValidationWorkflowContent();
    const edgeById = new Map(trusted.workflow.edges.map((edge) => [edge.id, edge]));
    const sequenceById = new Map(content.elements.filter((element) => element.type === "sequenceFlow").map((edge) => [edge.id, edge]));
    const rawRoutes = [];

    for (const branch of content.elements.filter((element) => element.type === "conditionBranch")) {
      const conditionValue = JSON.parse(branch.conditionValue || "{}");
      for (const route of conditionValue.formulas || []) {
        const edge = edgeById.get(route.lineId);
        const sequence = sequenceById.get(route.lineId);
        const condition = edgeConditionTextForTest(edge);
        if (!condition || isTautologyConditionForTest(condition)) continue;
        if (!isEditableFormulaRouteForTest(route, sequence)) {
          rawRoutes.push({
            branchId: branch.id,
            lineId: route.lineId,
            lineName: route.lineName,
            condition
          });
        }
      }
    }

    assert.deepEqual(rawRoutes, []);
  });

  it("marks every fixture route named other as fallback", () => {
    const { content } = buildRouteValidationWorkflowContent();
    const sequenceById = new Map(content.elements.filter((element) => element.type === "sequenceFlow").map((edge) => [edge.id, edge]));
    const nonFallbackOtherRoutes = [];

    for (const branch of content.elements.filter((element) => element.type === "conditionBranch")) {
      const conditionValue = JSON.parse(branch.conditionValue || "{}");
      for (const route of conditionValue.formulas || []) {
        if (String(route.lineName || "").trim() !== "其他") continue;
        const sequence = sequenceById.get(route.lineId);
        if (route.defaultTrend !== true || sequence?.defaultTrend !== true || sequence?.style !== "sequenceFlow;marker") {
          nonFallbackOtherRoutes.push({
            branchId: branch.id,
            lineId: route.lineId,
            lineName: route.lineName,
            routeDefaultTrend: route.defaultTrend,
            sequenceDefaultTrend: sequence?.defaultTrend,
            style: sequence?.style
          });
        }
      }
    }

    assert.deepEqual(nonFallbackOtherRoutes, []);
  });

  it("writes tautological other routes as not-empty alternate routes for the branch field", () => {
    const workflow = sampleConditionBranchWorkflow();
    workflow.edges.splice(1, 0, {
      id: "L542",
      source: "N410",
      target: "N412",
      name: "其他",
      sourceRef: "source.workflow.edge.L542",
      condition: {
        sourceText: "1 == 1",
        displayText: "1 == 1",
        targetText: "1 == 1",
        translationStatus: "display_only"
      },
      attributes: { priority: "21" }
    });
    const payload = applyWorkflowPayload(baseTemplate(), sampleTrustedDsl({
      form: sampleConditionBranchForm(),
      workflow
    }));
    const content = JSON.parse(payload.mechanisms.lbpmTemplate[0].fdContent);
    const branch = content.elements.find((element) => element.id === "N410");
    const conditionValue = JSON.parse(branch.conditionValue);
    const route = conditionValue.formulas.find((item) => item.lineId === "L542");
    const sequence = content.elements.find((element) => element.id === "L542");
    const routeFormula = route.formula;
    const rule = routeFormula.vo.data.fdList[0].fdList[0];

    assert.equal(branch.default, "L542");
    assert.equal(branch.conditionId, "L542");
    assert.equal(route.defaultTrend, true);
    assert.equal(route.formulaName, "");
    assert.deepEqual(route.conditionSimpleData, route.formula);
    assert.deepEqual(route.formulaConfig, route.formula);
    assert.equal(routeFormula.type, "Batch");
    assert.equal(routeFormula.result.value, "(u0021${data.$VAR.L542_fd_seller_notempty})");
    assert.equal(routeFormula.vars[0].type, "Function");
    assert.equal(routeFormula.vars[0].value, "global.isEmpty");
    assert.equal(routeFormula.vars[0].arguments[0].value, "template-id-fd_seller");
    assert.equal(rule.fdVarValue, "template-id-fd_seller");
    assert.equal(rule.fdLabel, "$合同卖方$");
    assert.equal(rule.fdSymbol, "notempty");
    assert.equal(rule.fdFunctionId, "global.isEmpty");
    assert.equal(sequence.defaultTrend, true);
    assert.equal(sequence.formulaType, "formula");
    assert.equal(sequence.formulaName, "");
    assert.deepEqual(JSON.parse(sequence.formula), routeFormula);
    assert.equal(sequence.style, "sequenceFlow;marker");
  });

  it("fails readback when persisted designer structure loses layout cells and keeps the partial fdId", async () => {
    const client = new FakeNewoaClient({
      corruptReadback(template) {
        const next = JSON.parse(JSON.stringify(template));
        const config = JSON.parse(next.mechanisms["sys-xform"].fdConfig);
        const sceneConfig = JSON.parse(config.viewModel[0].fdConfig);
        sceneConfig.view.render.desktop[0].children[0].children[1].children[0].children = [];
        config.viewModel[0].fdConfig = JSON.stringify(sceneConfig);
        next.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
        return next;
      }
    });

    const result = await withNewoaEnv(() => executeDsl(sampleTrustedDsl(), {
      client,
      confirmWrite: true,
      targetCategoryId: "category-1"
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, "readback_failed");
    assert.equal(result.failedAt, "readback");
    assert.deepEqual(result.createdFdIds, ["created-template-id"]);
    assert.equal(result.cleanup.attempted, false);
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "readback.form.layout_cells_mismatch"), true);
  });

  it("fails readback when persisted workflow edges lose connected endpoints", async () => {
    const client = new FakeNewoaClient({
      corruptReadback(template) {
        const next = JSON.parse(JSON.stringify(template));
        const content = JSON.parse(next.mechanisms.lbpmTemplate[0].fdContent);
        content.elements.find((element) => element.id === "L1").targetRef = "missing-node";
        next.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(content);
        return next;
      }
    });

    const result = await withNewoaEnv(() => executeDsl(sampleTrustedDsl(), {
      client,
      confirmWrite: true,
      targetCategoryId: "category-1"
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, "readback_failed");
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "readback.workflow.invalidEdgeCount_mismatch"), true);
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "readback.workflow.edge_endpoint_mismatch"), true);
  });

  it("rejects draft inputs before any NewOA login or write call", async () => {
    const client = new FakeNewoaClient();
    const result = await withNewoaEnv(() => executeDsl(sampleDraftDsl(), {
      client,
      confirmWrite: true,
      targetCategoryId: "category-1"
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "dsl.trust.trusted_required"), true);
    assert.deepEqual(client.calls, []);
  });

  it("rejects unresolved form rule targets before any NewOA login or write call", async () => {
    const client = new FakeNewoaClient();
    const result = await executeDsl(sampleTrustedDsl({
      workflow: undefined,
      formRules: {
        linkage: [{
          id: "linkage.missing.target",
          trigger: "change",
          source: "fd_subject",
          logic: "and",
          when: [{ field: "fd_subject", op: "contains", value: "A" }],
          effects: [{ type: "visible", target: "fd_missing_row", value: true }],
          else: [{ type: "visible", target: "fd_missing_row", value: false }],
          translationStatus: "executable"
        }],
        validations: [],
        impliedRequired: [],
        review: {}
      }
    }), {
      client,
      confirmWrite: true,
      targetCategoryId: "category-1"
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "dsl.form_rules.effect_target_unresolved"), true);
    assert.deepEqual(client.calls, []);
  });

  it("allows warning-only trusted DSL execution and reports written_with_warnings", async () => {
    const dsl = sampleTrustedDsl({
      review: {
        warnings: [{ code: "source.sysform.metadata_missing", message: "metadata missing", path: "/fdMetadataXml" }],
        decisions: []
      }
    });
    const result = await withNewoaEnv(() => executeDsl(dsl, {
      client: new FakeNewoaClient(),
      confirmWrite: true,
      targetCategoryId: "category-1"
    }));

    assert.equal(result.ok, true);
    assert.equal(result.status, "written_with_warnings");
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "source.sysform.metadata_missing"), true);
  });

  it("blocks before login when write safety inputs are missing", async () => {
    const client = new FakeNewoaClient();
    const result = await executeDsl(sampleTrustedDsl(), {
      client,
      confirmWrite: true,
      targetCategoryId: "category-1"
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.diagnostics[0].code, "safety.username_required");
    assert.deepEqual(client.calls, []);
  });

  it("blocks before login when the base URL is not NewOA SIT", async () => {
    const client = new FakeNewoaClient();
    const result = await withNewoaEnv(() => executeDsl(sampleTrustedDsl(), {
      client,
      confirmWrite: true,
      targetCategoryId: "category-1",
      baseUrl: "https://p.onewo.com"
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "safety.base_url_not_allowed"), true);
    assert.deepEqual(client.calls, []);
  });

  it("omits textarea height while keeping max length only from executable props", () => {
    const dsl = sampleTrustedDsl({
      form: {
        fields: [
          {
            id: "fd_with_props",
            title: "带高度和最大长度",
            type: "longText",
            componentId: "xform-textarea",
            props: { height: 80, maxLength: 512 },
            sourceProps: { designerValues: { height: "10", maxlength: "1" } },
            sourceRef: "source.form.control.fd_with_props"
          },
          {
            id: "fd_source_only",
            title: "只有源属性",
            type: "longText",
            componentId: "xform-textarea",
            props: {},
            sourceProps: { designerValues: { height: "90", maxlength: "1000" } },
            sourceRef: "source.form.control.fd_source_only"
          }
        ],
        layout: {
          sourceGrid: { rows: [] },
          mkTree: [{
            id: "layout.row-0",
            componentId: "xform-flex-1-2-layout",
            props: { columns: 2 },
            sourceRef: "source.form.layout.row.row-0",
            children: [
              { id: "c1", refType: "field", refIds: ["fd_with_props"], sourceRef: "source.form.layout.cell.c1", column: 0, colspan: 1 },
              { id: "c2", refType: "field", refIds: ["fd_source_only"], sourceRef: "source.form.layout.cell.c2", column: 1, colspan: 1 }
            ]
          }]
        }
      },
      workflow: undefined
    });
    const payload = applyFormPayload(baseTemplate(), dsl);
    const fields = JSON.parse(payload.mechanisms["sys-xform"].fdConfig)
      .dataModel.find((model) => model.fdType === "main").fdFields;
    const withProps = fieldControlProps(fields, "fd_with_props");
    const sourceOnly = fieldControlProps(fields, "fd_source_only");
    const withPropsField = fields.find((field) => field.fdName === "fd_with_props");
    const sourceOnlyField = fields.find((field) => field.fdName === "fd_source_only");

    assert.equal(Object.hasOwn(withProps, "height"), false);
    assert.equal(withProps.maxLength, 512);
    assert.equal(withPropsField.fdLength, 512);
    assert.equal(Object.hasOwn(sourceOnly, "height"), false);
    assert.equal(Object.hasOwn(sourceOnly, "maxLength"), false);
    assert.equal(Object.hasOwn(sourceOnlyField, "fdLength"), false);
  });

  it("preserves xform-subject as the native subject control in form payloads", () => {
    const dsl = sampleTrustedDsl({
      workflow: undefined,
      form: {
        fields: [{
          id: "fd_subject",
          title: "主题",
          type: "text",
          componentId: "xform-subject",
          props: { required: true },
          sourceProps: { designerType: "subject" },
          sourceRef: "source.form.control.fd_subject"
        }],
        layout: {
          sourceGrid: { rows: [] },
          mkTree: [{
            id: "layout.row-0",
            componentId: "xform-flex-1-1-layout",
            props: { columns: 1 },
            sourceRef: "source.form.layout.row.row-0",
            children: [{ id: "c1", refType: "field", refIds: ["fd_subject"], sourceRef: "source.form.layout.cell.c1", column: 0, colspan: 1 }]
          }]
        }
      }
    });
    const payload = applyFormPayload(baseTemplate(), dsl);
    const config = JSON.parse(payload.mechanisms["sys-xform"].fdConfig);
    const subject = config.dataModel.find((model) => model.fdType === "main").fdFields.find((field) => field.fdName === "fd_subject");
    const attribute = JSON.parse(subject.fdAttribute);
    const summary = summarizeFormFromTemplate(payload);

    assert.equal(subject.fdType, "subject");
    assert.equal(attribute.config.type, "@elem/xform-subject");
    assert.equal(attribute.config.controlProps.desktop.type, "@elem/xform-subject");
    assert.equal(attribute.config.controlProps.mobile.type, "@elem/xform-m-subject");
    assert.equal(summary.fields.find((field) => field.id === "fd_subject").component, "xform-subject");
  });

  it("writes fixture fields with registered MK control types and no textarea heights", () => {
    const trusted = trustedDslFromFixture("tests/fixtures/source/14a08d7d8b8753e20198a5b4223b707e");
    const dslFields = trusted.form.fields.flatMap((field) => field.type === "detailTable" ? field.columns || [] : [field]);
    const payload = applyFormPayload(baseTemplate(), trusted);
    const config = JSON.parse(payload.mechanisms["sys-xform"].fdConfig);
    const fields = config.dataModel
      .flatMap((model) => model.fdFields || [])
      .filter((field) => !field.fdIsSystem);
    const attributes = fields.map((field) => ({
      name: field.fdName,
      attribute: JSON.parse(field.fdAttribute)
    }));

    assert.deepEqual(
      dslFields
        .filter((field) => Object.hasOwn(field.props || {}, "height"))
        .map((field) => [field.id, field.props.height]),
      []
    );
    assert.deepEqual(
      attributes
        .filter(({ attribute }) => Object.hasOwn(attribute.config?.controlProps || {}, "height"))
        .map(({ name, attribute }) => [name, attribute.config.controlProps.height]),
      []
    );
    assert.deepEqual(
      attributes
        .filter(({ attribute }) => !String(attribute.config?.type || "").startsWith("@elem/xform-"))
        .map(({ name, attribute }) => [name, attribute.config?.type]),
      []
    );
    assert.deepEqual(
      attributes
        .filter(({ attribute }) => attribute.config?.type !== attribute.config?.controlProps?.desktop?.type)
        .map(({ name, attribute }) => [name, attribute.config?.type, attribute.config?.controlProps?.desktop?.type]),
      []
    );
  });

  it("writes creator context defaults as MK formula defaults", () => {
    const dsl = sampleTrustedDsl({
      workflow: undefined,
      form: {
        fields: [
          { id: "fd_creator_text", title: "起草人姓名-文本", type: "text", componentId: "xform-input", props: { defaultValue: { kind: "context", source: "creator", property: "fdName" } }, sourceProps: {}, sourceRef: "source.form.control.fd_creator_text" },
          { id: "fd_creator_dept_text", title: "起草部门-文本", type: "text", componentId: "xform-input", props: { defaultValue: { kind: "context", source: "creatorDept", property: "fdName" } }, sourceProps: {}, sourceRef: "source.form.control.fd_creator_dept_text" },
          { id: "fd_creator_address", title: "起草人地址本", type: "text", componentId: "xform-address", props: { defaultValue: { kind: "context", source: "creator" } }, sourceProps: {}, sourceRef: "source.form.control.fd_creator_address" },
          { id: "fd_creator_dept_address", title: "起草部门地址本", type: "text", componentId: "xform-address", props: { defaultValue: { kind: "context", source: "creatorDept" } }, sourceProps: {}, sourceRef: "source.form.control.fd_creator_dept_address" }
        ],
        layout: {
          sourceGrid: { rows: [] },
          mkTree: [{
            id: "layout.row-0",
            componentId: "xform-flex-1-4-layout",
            props: { columns: 4 },
            sourceRef: "source.form.layout.row.row-0",
            children: [
              { id: "c1", refType: "field", refIds: ["fd_creator_text"], sourceRef: "source.form.layout.cell.c1", column: 0, colspan: 1 },
              { id: "c2", refType: "field", refIds: ["fd_creator_dept_text"], sourceRef: "source.form.layout.cell.c2", column: 1, colspan: 1 },
              { id: "c3", refType: "field", refIds: ["fd_creator_address"], sourceRef: "source.form.layout.cell.c3", column: 2, colspan: 1 },
              { id: "c4", refType: "field", refIds: ["fd_creator_dept_address"], sourceRef: "source.form.layout.cell.c4", column: 3, colspan: 1 }
            ]
          }]
        }
      }
    });
    const payload = applyFormPayload(baseTemplate(), dsl);
    const fields = JSON.parse(payload.mechanisms["sys-xform"].fdConfig)
      .dataModel.find((model) => model.fdType === "main").fdFields;
    const creatorText = fieldControlProps(fields, "fd_creator_text");
    const creatorDeptText = fieldControlProps(fields, "fd_creator_dept_text");
    const creatorAddress = fieldControlProps(fields, "fd_creator_address");
    const creatorDeptAddress = fieldControlProps(fields, "fd_creator_dept_address");

    assert.equal(creatorText.defaultValueType, "formula");
    assert.equal(creatorText.defaultValueFormulaVO.script, "${data.biz.fdCreator.fdName}");
    assert.deepEqual(creatorText.defaultValueFormulaVO.varIds, ["fdCreator.fdName"]);
    assert.equal(creatorText.defaultValueFormulaVO.vo.content, "$测试模板.创建人.名称$");
    assert.equal(creatorDeptText.defaultValueFormulaVO.script, "${data.biz.fdCreatorDept.fdName}");
    assert.deepEqual(creatorDeptText.defaultValueFormulaVO.varIds, ["fdCreatorDept.fdName"]);
    assert.equal(creatorDeptText.defaultValueFormulaVO.vo.content, "$测试模板.创建者部门.名称$");

    assert.deepEqual(creatorAddress.org.orgTypeArr, ["8"]);
    assert.equal(creatorAddress.org.defaultValueType, "formula");
    assert.equal(creatorAddress.defaultValueFormulaVO.script, "${data.biz.fdCreator}");
    assert.deepEqual(creatorAddress.defaultValueFormulaVO.varIds, ["fdCreator"]);
    assert.equal(creatorAddress.defaultValueFormulaVO.vo.content, "$测试模板.创建人$");
    assert.deepEqual(creatorDeptAddress.org.orgTypeArr, ["2"]);
    assert.equal(creatorDeptAddress.defaultValueFormulaVO.script, "${data.biz.fdCreatorDept}");
    assert.equal(creatorDeptAddress.defaultValueFormulaVO.vo.content, "$测试模板.创建者部门$");

    assert.equal(fieldFontExtendData(fields, "fd_creator_text").defaultValueFormulaVO.script, "${data.biz.fdCreator.fdName}");
    assert.deepEqual(fieldFontExtendData(fields, "fd_creator_address").orgTypeArr, ["8"]);
    assert.deepEqual(fieldFontExtendData(fields, "fd_creator_dept_address").relation, []);
  });

  it("writes translated JSP scripts into MK xform control actions", () => {
    const dsl = sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        source: "sysform-jsp",
        actions: [{
          id: "fd_jsp.script.1",
          name: "onLoad",
          event: "onLoad",
          scope: "global",
          function: "function onLoad(context) {\n  var value = MKXFORM.getValue('fd_subject')\n}",
          translationStatus: "mapped",
          coverage: { status: "translated", nativeRules: [], residuals: [] },
          sourceRefs: ["source.form.jsp.fd_jsp.script.1"],
          functionMappings: [{
            source: "GetXFormFieldValueById",
            target: "MKXFORM.getValue('控件ID')",
            reviewRequired: false
          }]
        }]
      }
    });
    const payload = applyFormPayload(baseTemplate(), dsl);
    const config = JSON.parse(payload.mechanisms["sys-xform"].fdConfig);
    const formAttr = JSON.parse(config.attribute.formAttr);

    assert.equal(formAttr.controlAction.global.onLoad.length, 1);
    assert.equal(formAttr.controlAction.global.onLoad[0].function.includes("MKXFORM.getValue('fd_subject')"), true);
    assert.equal(formAttr.controlAction.javascript, undefined);
    assert.equal(config.migrationDsl.scripts.actionCount, 1);
    assert.deepEqual(summarizeFormFromTemplate(payload).scripts.events, ["onLoad"]);
  });

  it("writes translated control onChange scripts into field control actions", () => {
    const dsl = sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        source: "sysform-jsp",
        actions: [{
          id: "fd_amount.onChange.1",
          name: "onChange",
          event: "onChange",
          scope: "control",
          controlId: "fd_amount",
          function: "function onChange(value) {\n  MKXFORM.setValue('fd_subject', String(value || ''))\n}",
          translationStatus: "mapped",
          coverage: { status: "translated", nativeRules: [], residuals: [] },
          functionMappings: [{
            source: "AttachXFormValueChangeEventById",
            target: "control onChange",
            basis: "function-catalog"
          }]
        }]
      }
    });
    const payload = applyFormPayload(baseTemplate(), dsl);
    const config = JSON.parse(payload.mechanisms["sys-xform"].fdConfig);
    const formAttr = JSON.parse(config.attribute.formAttr);
    const mainModel = config.dataModel.find((model) => model.fdType === "main");
    const controlKey = `${mainModel.fdTableName}.fd_amount`;

    assert.equal(formAttr.controlAction.control[controlKey].onChange.length, 1);
    assert.equal(formAttr.controlAction.control[controlKey].onChange[0].function.includes("MKXFORM.setValue('fd_subject'"), true);
    assert.deepEqual(summarizeFormFromTemplate(payload).scripts.controlEvents, [{
      controlKey,
      event: "onChange",
      count: 1
    }]);
  });

  it("writes translated detail control onChange scripts with MK detail table names", () => {
    const dsl = sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        source: "sysform-jsp",
        actions: [{
          id: "fd_detail.fd_name.onChange.1",
          name: "onChange",
          event: "onChange",
          scope: "control",
          tableId: "fd_detail",
          controlId: "fd_name",
          function: "function onChange(value, rowNum, parentRowNum) {\n  MKXFORM.updateControlStyle(\"${table:fd_detail}.fd_name\", rowNum, { display: value === \"gh\" ? \"block\" : \"none\" })\n}",
          translationStatus: "mapped",
          coverage: { status: "translated", nativeRules: [], residuals: [] },
          functionMappings: [{
            source: "detail-row DOM display toggle",
            target: "detail column onChange + MKXFORM.updateControlStyle",
            basis: "deterministic-pattern"
          }]
        }]
      }
    });
    const payload = applyFormPayload(baseTemplate(), dsl);
    const config = JSON.parse(payload.mechanisms["sys-xform"].fdConfig);
    const formAttr = JSON.parse(config.attribute.formAttr);
    const detailModel = config.dataModel.find((model) => model.fdType === "detail" && model.dynamicProps?.detailFieldName === "fd_detail");
    const controlKey = `${detailModel.fdTableName}.fd_name`;
    const action = formAttr.controlAction.control[controlKey].onChange[0];

    assert.equal(detailModel.fdTableName, "mk_model_fd_detail");
    assert.equal(action.function.includes("MKXFORM.updateControlStyle(\"mk_model_fd_detail.fd_name\", rowNum"), true);
    assert.equal(action.function.includes("${table:"), false);
    assert.deepEqual(summarizeFormFromTemplate(payload).scripts.controlEvents, [{
      controlKey,
      event: "onChange",
      count: 1
    }]);
  });

  it("renders source detail table placeholders inside global script functions", () => {
    const dsl = sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        source: "sysform-jsp",
        actions: [{
          id: "fd_detail.onLoad.1",
          name: "onLoad",
          event: "onLoad",
          scope: "global",
          function: "function onLoad() {\n  var rows = MKXFORM.getValue(\"${table:fd_detail}\") || []\n  console.log(rows.length)\n}",
          translationStatus: "mapped",
          coverage: { status: "translated", nativeRules: [], residuals: [] },
          functionMappings: [{
            source: "detail table load inspection",
            target: "MKXFORM.getValue",
            basis: "semantic-translation",
            reviewRequired: false
          }]
        }]
      }
    });
    const payload = applyFormPayload(baseTemplate(), dsl);
    const config = JSON.parse(payload.mechanisms["sys-xform"].fdConfig);
    const formAttr = JSON.parse(config.attribute.formAttr);
    const action = formAttr.controlAction.global.onLoad[0];

    assert.equal(action.function.includes("MKXFORM.getValue(\"mk_model_fd_detail\")"), true);
    assert.equal(action.function.includes("${table:"), false);
  });

  it("writes native MK formRule display and require entries through the fake client", async () => {
    const client = new FakeNewoaClient();
    const result = await withNewoaEnv(() => executeDsl(sampleTrustedDslWithFormRules(), {
      client,
      confirmWrite: true,
      targetCategoryId: "category-1"
    }));

    assert.equal(result.ok, true);
    const updatePayload = client.calls.find((call) => call.name === "updateTemplate").payload;
    const config = JSON.parse(updatePayload.mechanisms["sys-xform"].fdConfig);
    const formAttr = JSON.parse(config.attribute.formAttr);
    const displayRules = formAttr.formRule.display;
    const requireRules = formAttr.formRule.require;

    assert.equal(displayRules.length, 2);
    assert.equal(requireRules.length, 2);
    assert.deepEqual(displayRules.map((rule) => rule.result[0].displayFlag), ["display", "hide"]);
    assert.deepEqual(requireRules.map((rule) => rule.result[0].required), ["required", "non-required"]);
    assert.deepEqual([...new Set(displayRules.flatMap((rule) => rule.result.map((item) => item.fieldName)))], ["fd_name"]);
    assert.equal(JSON.stringify(formAttr.formRule).includes("fd_detail_row"), false);
    assert.equal(result.readback.form.formRules.displayRuleCount, 2);
    assert.equal(result.readback.form.formRules.requireRuleCount, 2);
  });

  it("preserves manual form rules while replacing generated native rules", () => {
    const payload = applyFormPayload(baseTemplateWithExistingFormRules(), sampleTrustedDslWithFormRules());
    const config = JSON.parse(payload.mechanisms["sys-xform"].fdConfig);
    const formRule = JSON.parse(config.attribute.formAttr).formRule;

    assert.deepEqual(formRule.pattern, { enabled: true });
    assert.equal(formRule.display.some((rule) => rule.ruleName === "manual-display"), true);
    assert.equal(formRule.display.some((rule) => rule.ruleName === "mk-migrate-agent-v2:old-generated"), false);
    assert.equal(formRule.display.length, 3);
    assert.equal(formRule.require.length, 3);
  });
});

function buildRouteValidationWorkflowContent() {
  const sourceDraft = cleanSourceFile("tests/fixtures/source/14a08d7d8b8753e20198a5b4223b707e");
  const dslDraft = draftSourceDraft(sourceDraft);
  const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
    externalAgentReviewed: true,
    reviewerName: "test-reviewer",
    checkedAt: "2026-07-09T00:00:00.000Z"
  });
  return {
    trusted,
    content: buildWorkflowContent(trusted.workflow, {
      templateId: "template-id",
      form: trusted.form
    })
  };
}

function isEditableFormulaRouteForTest(route, sequence) {
  return Boolean(
    route.conditionSimpleData &&
    route.formulaConfig &&
    route.formula &&
    typeof route.formula === "object" &&
    sequence?.formulaType === "formula" &&
    String(sequence?.formula || "").trim().startsWith("{")
  );
}

function edgeConditionTextForTest(edge) {
  if (!edge) return "";
  if (edge.condition && typeof edge.condition === "object") {
    return edge.condition.targetText || edge.condition.sourceText || edge.condition.displayText || "";
  }
  return edge.condition || edge.displayCondition || "";
}

function isTautologyConditionForTest(condition) {
  return /^(?:1\s*={2,3}\s*1|true)$/i.test(String(condition || "").trim());
}

function sampleParallelGatewayWorkflow() {
  return {
    process: { id: "process-parallel" },
    nodes: [
      { id: "N1", type: "generalStart", element: "startEvent", name: "开始", sourceType: "startNode", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
      { id: "N2", type: "split", element: "parallelGateway", name: "并行分支", sourceType: "splitNode", sourceRef: "source.workflow.node.N2", attributes: { relatedNodeIds: "N4" }, definition: { attributes: { splitType: "all", relatedNodeIds: "N4" } }, translationStatus: "executable" },
      { id: "N3", type: "review", element: "manualTask", name: "审批", sourceType: "reviewNode", sourceRef: "source.workflow.node.N3", attributes: { handlerIds: "handler-1", handlerNames: "审批人" }, participants: { mode: "explicit", members: [{ id: "handler-1", name: "审批人", type: "user_or_org" }] }, translationStatus: "executable" },
      { id: "N4", type: "join", element: "parallelGateway", name: "并行分支", sourceType: "joinNode", sourceRef: "source.workflow.node.N4", attributes: { relatedNodeIds: "N2" }, definition: { attributes: { joinType: "all", relatedNodeIds: "N2" } }, translationStatus: "executable" },
      { id: "N5", type: "generalEnd", element: "endEvent", name: "结束", sourceType: "endNode", sourceRef: "source.workflow.node.N5", attributes: {}, translationStatus: "executable" }
    ],
    edges: [
      { id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1", condition: { translationStatus: "executable" } },
      { id: "L2", source: "N2", target: "N3", sourceRef: "source.workflow.edge.L2", condition: { translationStatus: "executable" } },
      { id: "L3", source: "N3", target: "N4", sourceRef: "source.workflow.edge.L3", condition: { translationStatus: "executable" } },
      { id: "L4", source: "N4", target: "N5", sourceRef: "source.workflow.edge.L4", condition: { translationStatus: "executable" } }
    ],
    topologicalOrder: ["N1", "N2", "N3", "N4", "N5"]
  };
}

function sampleConditionBranchForm() {
  const form = sampleForm();
  form.fields = [
    ...form.fields,
    {
      id: "fd_seller",
      title: "合同卖方",
      type: "text",
      componentId: "xform-input",
      props: {},
      sourceProps: { designerType: "inputText" },
      sourceRef: "source.form.control.fd_seller"
    }
  ];
  return form;
}

function sampleConditionBranchWorkflow() {
  return {
    process: { id: "process-branch" },
    nodes: [
      { id: "N1", type: "generalStart", element: "startEvent", name: "开始", sourceType: "startNode", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
      { id: "N410", type: "conditionBranch", element: "exclusiveGateway", name: "合同卖方", sourceType: "autoBranchNode", sourceRef: "source.workflow.node.N410", attributes: { id: "N410", name: "合同卖方" }, translationStatus: "executable" },
      { id: "N411", type: "review", element: "manualTask", name: "海南", sourceType: "reviewNode", sourceRef: "source.workflow.node.N411", attributes: { handlerIds: "handler-hainan", handlerNames: "海南审批人" }, participants: { mode: "explicit", members: [{ id: "handler-hainan", name: "海南审批人", type: "user_or_org" }] }, translationStatus: "executable" },
      { id: "N413", type: "review", element: "manualTask", name: "辽宁、东营", sourceType: "reviewNode", sourceRef: "source.workflow.node.N413", attributes: { handlerIds: "handler-liaoning-dongying", handlerNames: "辽宁东营审批人" }, participants: { mode: "explicit", members: [{ id: "handler-liaoning-dongying", name: "辽宁东营审批人", type: "user_or_org" }] }, translationStatus: "executable" },
      { id: "N412", type: "review", element: "manualTask", name: "默认", sourceType: "reviewNode", sourceRef: "source.workflow.node.N412", attributes: { handlerIds: "handler-default", handlerNames: "默认审批人" }, participants: { mode: "explicit", members: [{ id: "handler-default", name: "默认审批人", type: "user_or_org" }] }, translationStatus: "executable" },
      { id: "N999", type: "generalEnd", element: "endEvent", name: "结束", sourceType: "endNode", sourceRef: "source.workflow.node.N999", attributes: {}, translationStatus: "executable" }
    ],
    edges: [
      { id: "L1", source: "N1", target: "N410", sourceRef: "source.workflow.edge.L1", condition: { translationStatus: "executable" } },
      {
        id: "L541",
        source: "N410",
        target: "N411",
        name: "海南",
        sourceRef: "source.workflow.edge.L541",
        condition: {
          sourceText: "\"1689\" .equals( $fd_seller$ )",
          displayText: "$合同卖方$ == \"1689\"",
          targetText: "\"1689\" .equals( $fd_seller$ )",
          translationStatus: "executable"
        },
        attributes: { priority: "6" }
      },
      {
        id: "L546",
        source: "N410",
        target: "N413",
        name: "辽宁、东营",
        sourceRef: "source.workflow.edge.L546",
        condition: {
          sourceText: "\"1694\" .equals( $fd_seller$) || \"1695\" .equals( $fd_seller$)",
          displayText: "\"1694\" .equals( $合同卖方$) || \"1695\" .equals( $合同卖方$)",
          targetText: "\"1694\" .equals( $fd_seller$) || \"1695\" .equals( $fd_seller$)",
          translationStatus: "executable"
        },
        attributes: { priority: "3" }
      },
      { id: "L544", source: "N410", target: "N412", name: "默认", sourceRef: "source.workflow.edge.L544", condition: { translationStatus: "executable" }, attributes: { priority: "24" } },
      { id: "L545", source: "N411", target: "N999", sourceRef: "source.workflow.edge.L545", condition: { translationStatus: "executable" } },
      { id: "L547", source: "N413", target: "N999", sourceRef: "source.workflow.edge.L547", condition: { translationStatus: "executable" } },
      { id: "L548", source: "N412", target: "N999", sourceRef: "source.workflow.edge.L548", condition: { translationStatus: "executable" } }
    ],
    topologicalOrder: ["N1", "N410", "N411", "N413", "N412", "N999"]
  };
}

function fieldControlProps(fields, fieldName) {
  return fieldAttribute(fields, fieldName).config.controlProps;
}

function fieldAttribute(fields, fieldName) {
  return JSON.parse(fields.find((field) => field.fdName === fieldName).fdAttribute);
}

function fieldFontExtendData(fields, fieldName) {
  return JSON.parse(fields.find((field) => field.fdName === fieldName).fdFontExtendData);
}

function baseTemplate() {
  return {
    fdId: "template-id",
    fdName: "测试模板",
    fdTableName: "mk_model_test",
    mechanisms: {
      "sys-xform": {
        fdId: "template-id",
        fdName: "测试模板",
        fdTableName: "mk_model_test",
        fdConfig: "{}"
      }
    }
  };
}

function baseTemplateWithExistingFormRules() {
  const template = baseTemplate();
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify({
    attribute: {
      formAttr: JSON.stringify({
        formRule: {
          pattern: { enabled: true },
          display: [
            { ruleName: "manual-display", result: [], meta: { author: "human" } },
            { ruleName: "mk-migrate-agent-v2:old-generated", result: [], meta: { generatedBy: "mk-migrate-agent-v2" } }
          ],
          require: [
            { ruleName: "manual-require", result: [], meta: { author: "human" } },
            { ruleName: "mk-migrate-agent-v2:old-generated", result: [], meta: { generatedBy: "mk-migrate-agent-v2" } }
          ]
        }
      })
    }
  });
  return template;
}

function trustedDslFromFixture(path) {
  const sourceDraft = cleanSourceFile(path);
  const dslDraft = draftSourceDraft(sourceDraft);
  return createTrustedMigrationDsl(sourceDraft, dslDraft, {
    externalAgentReviewed: true,
    reviewerName: "test-reviewer",
    checkedAt: "2026-07-08T00:00:00.000Z"
  });
}

function sampleTrustedDslWithFormRules() {
  const form = sampleForm();
  form.layout.mkTree[1] = {
    ...form.layout.mkTree[1],
    sourceMarkers: ["fd_detail_row"]
  };

  return sampleTrustedDsl({
    form,
    workflow: undefined,
    formRules: {
      linkage: [{
        id: "linkage.subject.detail",
        trigger: "change",
        source: "fd_subject",
        logic: "and",
        when: [{ field: "fd_subject", op: "contains", value: "A" }],
        effects: [
          { type: "visible", target: "fd_detail_row", value: true },
          { type: "required", target: "fd_detail_row", value: true }
        ],
        else: [
          { type: "visible", target: "fd_detail_row", value: false },
          { type: "required", target: "fd_detail_row", value: false }
        ],
        translationStatus: "executable"
      }],
      validations: [],
      impliedRequired: [],
      review: {}
    }
  });
}

class FakeNewoaClient {
  constructor(options = {}) {
    this.calls = [];
    this.savedTemplate = undefined;
    this.corruptReadback = options.corruptReadback;
  }

  async login(credentials) {
    this.calls.push({ name: "login", payload: { username: credentials.username } });
    return { ok: true };
  }

  async initTemplate() {
    this.calls.push({ name: "initTemplate", payload: {} });
    return {
      fdId: "init-template-id",
      fdName: "初始化模板",
      fdCode: "template_base",
      fdStatus: 0,
      mechanisms: {
        "sys-xform": { fdId: "init-template-id", fdName: "初始化模板", fdConfig: "{}" },
        lbpmTemplate: [{ fdTemplateForms: [] }]
      }
    };
  }

  async generateTableName() {
    this.calls.push({ name: "generateTableName", payload: {} });
    return "generated_table_name";
  }

  async loadParentCategory(fdId) {
    this.calls.push({ name: "loadParentCategory", payload: { fdId } });
    return {
      fdFormCategoryId: fdId,
      fdName: "测试分类"
    };
  }

  async addTemplate(payload) {
    this.calls.push({ name: "addTemplate", payload });
    return { fdId: "created-template-id", fdName: payload.fdName };
  }

  async getTemplate(fdId) {
    this.calls.push({ name: "getTemplate", payload: { fdId } });
    if (this.savedTemplate && this.corruptReadback && this.calls.filter((call) => call.name === "getTemplate").length > 1) {
      return this.corruptReadback(this.savedTemplate);
    }
    return this.savedTemplate || {
      fdId,
      fdName: "created",
      mechanisms: {
        "sys-xform": { fdId, fdName: "created", fdConfig: "{}" },
        lbpmTemplate: [{ fdContent: "{}" }]
      }
    };
  }

  async updateTemplate(payload) {
    this.calls.push({ name: "updateTemplate", payload });
    this.savedTemplate = payload;
    return { fdId: payload.fdId };
  }
}

async function withNewoaEnv(fn) {
  const previousUsername = process.env.NEWOA_USERNAME;
  const previousPassword = process.env.NEWOA_ENCRYPTED_PASSWORD;
  process.env.NEWOA_USERNAME = "01025344";
  process.env.NEWOA_ENCRYPTED_PASSWORD = "encrypted-password";
  try {
    return await fn();
  } finally {
    restoreEnv("NEWOA_USERNAME", previousUsername);
    restoreEnv("NEWOA_ENCRYPTED_PASSWORD", previousPassword);
  }
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
