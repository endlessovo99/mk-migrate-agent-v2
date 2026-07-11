import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { executeDsl } from "../../src/executor/execute.js";
import {
  buildWorkflowContent,
  buildWorkflowDraftPayload,
  projectTemplate,
  summarizeProjectedForm,
  verifyTemplate
} from "../helpers/persistence.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { localCorpusIt } from "../helpers/local-corpus.js";
import { sampleDraftDsl, sampleForm, sampleTrustedDsl } from "../helpers/sample-dsl.js";

const TEST_CREDENTIALS = Object.freeze({
  username: "route-test-user",
  encryptedPassword: "route-test-encrypted-password"
});

describe("executeDsl", () => {
  it("uses caller-provided credentials without recording them", async () => {
    const client = new FakeNewoaClient({ expectedCredentials: TEST_CREDENTIALS });
    const result = await executeDsl(sampleTrustedDsl(), {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1",
      now: new Date("2026-07-05T01:02:03.000Z")
    });

    assert.equal(result.ok, true);
    assert.deepEqual(client.calls[0], { name: "login", payload: {} });
    assert.equal(JSON.stringify({ calls: client.calls, result }).includes(TEST_CREDENTIALS.username), false);
    assert.equal(JSON.stringify({ calls: client.calls, result }).includes(TEST_CREDENTIALS.encryptedPassword), false);
  });

  it("redacts caller credentials from adapter failure reports", async () => {
    const loginError = new Error(`login rejected ${TEST_CREDENTIALS.username} ${TEST_CREDENTIALS.encryptedPassword}`);
    loginError.stage = "login";
    const client = new FakeNewoaClient({
      expectedCredentials: TEST_CREDENTIALS,
      loginError
    });
    const result = await executeDsl(sampleTrustedDsl(), {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1",
      baseUrl: " HTTP://LOCALHOST:8080/ "
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.ok, false);
    assert.equal(result.stage, "login");
    assert.equal(result.baseUrl, "http://localhost:8080");
    assert.equal(serialized.includes(TEST_CREDENTIALS.username), false);
    assert.equal(serialized.includes(TEST_CREDENTIALS.encryptedPassword), false);
    assert.equal(result.diagnostics.at(-1).message, "login rejected [REDACTED] [REDACTED]");
  });

  it("updates an existing MK_TEST_ draft template without creating a new one", async () => {
    const client = new FakeNewoaClient({
      existingTemplate: {
        fdId: "existing-template-id",
        fdName: "MK_TEST_预算追加_20260711010203",
        fdStatus: 0,
        fdTableName: "existing_table_name",
        fdCategory: { fdId: "category-1" },
        mechanisms: {
          "sys-xform": { fdId: "existing-template-id", fdName: "MK_TEST_预算追加_20260711010203", fdConfig: "{}", fdTableName: "existing_table_name" },
          lbpmTemplate: [{
            fdId: "lbpm-template-id",
            fdName: "MK_TEST_预算追加_20260711010203",
            fdTemplateCode: "template_existing",
            fdEntityId: "existing-template-id",
            fdEntityKey: "KmReviewMain",
            fdEntityName: "com.landray.km.review.core.entity.KmReviewTemplate",
            fdMainEntityName: "com.landray.km.review.core.entity.KmReviewMain",
            fdModuleCode: "km-review",
            fdContentType: "json",
            fdSystemCode: "INNER_SYSTEM",
            fdSystemName: "MK-PaaS内部系统",
            fdTemplateForms: [{ fdFormKey: "existing-template-id" }],
            fdReaders: [{ fdId: "reader-1" }],
            fdEditors: [{ fdId: "editor-1" }],
            isDraft: true,
            fdContent: "{\"elements\":[]}"
          }]
        }
      }
    });
    const result = await executeDsl(sampleTrustedDsl(), {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1",
      existingTemplateId: "existing-template-id"
    });

    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.templateId, "existing-template-id");
    assert.deepEqual(result.createdFdIds, []);
    assert.equal(client.calls.some((call) => call.name === "addTemplate"), false);
    assert.equal(client.calls.some((call) => call.name === "initTemplate"), false);
    assert.deepEqual(client.calls.map((call) => call.name), [
      "login",
      "getTemplate",
      "updateTemplate",
      "saveWorkflowDraft",
      "getWorkflowTemplateDetail",
      "getTemplate"
    ]);
    const updatePayload = client.calls.find((call) => call.name === "updateTemplate").payload;
    assert.equal(updatePayload.fdId, "existing-template-id");
    assert.equal(updatePayload.fdName, "MK_TEST_预算追加_20260711010203");
  });

  it("writes an initial same-id workflow draft and verifies readback", async () => {
    const client = new FakeNewoaClient();
    const result = await executeDsl(sampleTrustedDsl(), {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1",
      now: new Date("2026-07-05T01:02:03.000Z")
    });

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
      "saveWorkflowDraft",
      "getWorkflowTemplateDetail",
      "getTemplate"
    ]);
    assert.equal(result.apiStages.some((stage) => stage.name === "saveWorkflowDraft" && stage.status === "ok"), true);
    assert.equal(result.apiStages.some((stage) => stage.name === "getWorkflowTemplateDetail" && stage.status === "ok"), true);

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
    const workflowDraftPayload = client.calls.find((call) => call.name === "saveWorkflowDraft").payload;
    assert.equal(workflowDraftPayload.fdId, "lbpm-template-id");
    assert.equal(workflowDraftPayload.isDraft, true);
    assert.equal(JSON.parse(workflowDraftPayload.fdContent).elements.length, 3);
    assert.deepEqual(
      client.calls.find((call) => call.name === "getWorkflowTemplateDetail").payload,
      { templateId: "lbpm-template-id", definitionId: "" }
    );
    const workflowDraftStage = result.apiStages.find((stage) => stage.name === "saveWorkflowDraft");
    assert.equal(workflowDraftStage.draftId, "lbpm-template-id");
    assert.equal(workflowDraftStage.definitionId, undefined);
    const workflowDetailStage = result.apiStages.find((stage) => stage.name === "getWorkflowTemplateDetail");
    assert.equal(workflowDetailStage.draftId, "lbpm-template-id");
    assert.equal(workflowDetailStage.definitionId, undefined);
    assert.equal(result.readback.form.fieldCount, 3);
    assert.equal(result.readback.workflow.invalidEdgeCount, 0);
  });

  it("keeps form-only execution off the LBPM definition save path", async () => {
    const client = new FakeNewoaClient();
    const dsl = sampleTrustedDsl();
    delete dsl.workflow;
    const result = await executeDsl(dsl, {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1"
    });

    assert.equal(result.ok, true);
    assert.equal(client.calls.some((call) => call.name === "saveWorkflowDraft"), false);
    assert.equal(client.calls.some((call) => call.name === "getWorkflowTemplateDetail"), false);
    assert.equal(result.apiStages.some((stage) => stage.name === "saveWorkflowDraft"), false);
    assert.equal(result.apiStages.some((stage) => stage.name === "getWorkflowTemplateDetail"), false);
  });

  it("fails the workflow draft stage when publish returns no draft id", async () => {
    const client = new FakeNewoaClient({ workflowDraftResult: {} });
    const result = await executeDsl(sampleTrustedDsl(), {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1"
    });

    assert.equal(result.ok, false);
    assert.equal(result.stage, "saveWorkflowDraft");
    assert.equal(result.apiStages.find((stage) => stage.name === "saveWorkflowDraft").status, "failed");
    assert.equal(client.calls.some((call) => call.name === "getWorkflowTemplateDetail"), false);
  });

  it("reads only the current workflow detail when publish returns a separate audit id", async () => {
    const client = new FakeNewoaClient({ workflowDraftResult: { fdId: "workflow-definition-id" } });
    const result = await executeDsl(sampleTrustedDsl(), {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1"
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      client.calls.find((call) => call.name === "getWorkflowTemplateDetail").payload,
      { templateId: "lbpm-template-id", definitionId: "" }
    );
    const saveStage = result.apiStages.find((stage) => stage.name === "saveWorkflowDraft");
    assert.equal(saveStage.draftId, "workflow-definition-id");
    assert.equal(saveStage.definitionId, undefined);
  });

  it("accepts current workflow readback without a historical definition id", async () => {
    const client = new FakeNewoaClient({
      workflowDraftResult: { fdId: "workflow-definition-id" },
      corruptWorkflowReadback(detail) {
        const next = structuredClone(detail);
        delete next.fdDefinitionId;
        return next;
      }
    });
    const result = await executeDsl(sampleTrustedDsl(), {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1"
    });

    assert.equal(result.ok, true);
    assert.equal(result.apiStages.find((stage) => stage.name === "getWorkflowTemplateDetail").status, "ok");
  });

  it("ignores historical definition metadata on a current-only workflow readback", async () => {
    const client = new FakeNewoaClient({
      workflowDraftResult: { fdId: "workflow-definition-id" },
      corruptWorkflowReadback(detail) {
        return { ...detail, fdDefinitionId: "different-definition-id" };
      }
    });
    const result = await executeDsl(sampleTrustedDsl(), {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1"
    });

    assert.equal(result.ok, true);
  });

  it("fails workflow readback when details belongs to a different workflow template", async () => {
    const client = new FakeNewoaClient({
      corruptWorkflowReadback(detail) {
        return { ...detail, fdId: "different-lbpm-template-id" };
      }
    });
    const result = await executeDsl(sampleTrustedDsl(), {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1"
    });

    assert.equal(result.ok, false);
    assert.equal(result.stage, "getWorkflowTemplateDetail");
  });

  it("fails workflow readback when details returns no designer content", async () => {
    const client = new FakeNewoaClient({
      corruptWorkflowReadback(detail) {
        return { ...detail, fdContent: "" };
      }
    });
    const result = await executeDsl(sampleTrustedDsl(), {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1"
    });

    assert.equal(result.ok, false);
    assert.equal(result.stage, "getWorkflowTemplateDetail");
  });

  for (const [label, corruptReadback] of [
    ["different top-level workflow id", (template) => {
      template.mechanisms.lbpmTemplate[0].fdId = "different-lbpm-template-id";
      return template;
    }],
    ["missing top-level workflow id", (template) => {
      delete template.mechanisms.lbpmTemplate[0].fdId;
      return template;
    }],
    ["missing top-level workflow content", (template) => {
      template.mechanisms.lbpmTemplate[0].fdContent = "";
      return template;
    }],
    ["stale top-level workflow content", (template) => {
      template.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify({ elements: [] });
      return template;
    }]
  ]) {
    it(`fails current readback on ${label}`, async () => {
      const client = new FakeNewoaClient({ corruptReadback });
      const result = await executeDsl(sampleTrustedDsl(), {
        client,
        credentials: TEST_CREDENTIALS,
        confirmWrite: true,
        targetCategoryId: "category-1"
      });

      assert.equal(result.ok, false);
      assert.equal(result.stage, "readback");
      assert.equal(result.apiStages.find((stage) => stage.name === "readback").status, "failed");
    });
  }

  it("fails workflow readback unless details confirms both draft markers", async () => {
    for (const corruptWorkflowReadback of [
      (detail) => ({ ...detail, isDraft: false }),
      (detail) => ({ ...detail, fdStatus: "published" })
    ]) {
      const result = await executeDsl(sampleTrustedDsl(), {
        client: new FakeNewoaClient({ corruptWorkflowReadback }),
        credentials: TEST_CREDENTIALS,
        confirmWrite: true,
        targetCategoryId: "category-1"
      });

      assert.equal(result.ok, false);
      assert.equal(result.stage, "getWorkflowTemplateDetail");
    }
  });

  for (const [label, corruptWorkflowReadback] of [
    ["fdContentType", (detail) => ({ ...detail, fdContentType: "xml" })],
    ["fdSystemCode", (detail) => ({ ...detail, fdSystemCode: "OTHER_SYSTEM" })],
    ["fdRunType", (detail) => ({ ...detail, fdRunType: "2" })],
    ["fdDisableBpmInit", (detail) => ({ ...detail, fdDisableBpmInit: true })],
    ["fdFormCategory", (detail) => ({
      ...detail,
      fdFormCategory: { ...(detail.fdFormCategory || {}), fdFormCategoryId: "wrong-category-id" }
    })]
  ]) {
    it(`fails current workflow readback when ${label} is not native`, async () => {
      const client = new FakeNewoaClient({ corruptWorkflowReadback });
      const result = await executeDsl(sampleTrustedDsl(), {
        client,
        credentials: TEST_CREDENTIALS,
        confirmWrite: true,
        targetCategoryId: "category-1"
      });

      assert.equal(result.ok, false);
      assert.equal(result.stage, "getWorkflowTemplateDetail");
      assert.equal(result.apiStages.find((stage) => stage.name === "getWorkflowTemplateDetail").status, "failed");
    });
  }

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

  it("writes send nodes with the native NewOA CC shape", () => {
    const workflow = {
      process: { id: "process-send" },
      nodes: [
        { id: "N1", type: "generalStart", element: "startEvent", name: "开始", attributes: {} },
        { id: "N2", type: "send", element: "manualTask", name: "抄送财务", attributes: {} },
        { id: "N3", type: "generalEnd", element: "endEvent", name: "结束", attributes: {} }
      ],
      edges: [
        { id: "L1", source: "N1", target: "N2" },
        { id: "L2", source: "N2", target: "N3" }
      ]
    };

    const content = buildWorkflowContent(workflow);
    const send = content.elements.find((element) => element.id === "N2");

    assert.equal(send.modifyProcessAuthority, "0");
    assert.equal(send.systemNotifyType, "2");
    assert.equal(send.language.nameUs, "CC node");
  });

  it("keeps the native LBPM draft envelope required by the designer", () => {
    const template = {
      fdId: "km-review-template-id",
      fdName: "top-level form template",
      mechanisms: {
        lbpmTemplate: [{
          fdId: "lbpm-template-id",
          fdName: "workflow template",
          fdEntityId: "km-review-template-id",
          fdContentType: "json",
          fdDisableBpmInit: false,
          fdFormCategory: { fdFormCategoryId: "category-1" },
          fdRunType: "1",
          fdSystemCode: "INNER_SYSTEM",
          fdTemplateForms: [{ fdFormKey: "km-review-template-id" }],
          fdContent: "{\"elements\":[]}",
          fdStatus: "published",
          fdDefinitionId: "stale-definition-id",
          latestDefinitionStatus: 9,
          serverOnlyValue: "must-not-leak"
        }]
      }
    };

    const payload = buildWorkflowDraftPayload(template);

    assert.deepEqual(Object.keys(payload).sort(), [
      "fdContent",
      "fdContentType",
      "fdDisableBpmInit",
      "fdEntityId",
      "fdFormCategory",
      "fdId",
      "fdName",
      "fdRunType",
      "fdSystemCode",
      "fdTemplateForms",
      "isDraft"
    ]);
    assert.equal(payload.fdId, "lbpm-template-id");
    assert.deepEqual(payload.fdFormCategory, { fdFormCategoryId: "category-1" });
    assert.equal(payload.fdContentType, "json");
    assert.equal(payload.fdDisableBpmInit, false);
    assert.equal(payload.fdRunType, "1");
    assert.equal(payload.fdSystemCode, "INNER_SYSTEM");
    assert.equal(payload.isDraft, true);
    assert.equal(template.mechanisms.lbpmTemplate[0].isDraft, undefined);
  });

  it("defaults the native LBPM envelope before workflow draft serialization", () => {
    const projected = projectTemplate(sampleTrustedDsl(), baseTemplate());
    const lbpm = projected.mechanisms.lbpmTemplate[0];

    assert.equal(lbpm.fdContentType, "json");
    assert.equal(lbpm.fdSystemCode, "INNER_SYSTEM");
    assert.equal(lbpm.fdRunType, "1");
    assert.equal(lbpm.fdDisableBpmInit, false);
    assert.deepEqual(lbpm.fdFormCategory, { fdFormCategoryId: "category-id" });
  });

  it("backs designer submit settings with fdContent without overriding mechanism fields", () => {
    const content = {
      elements: [],
      events: [{ id: "content-event" }],
      operSubmitValidators: [{ id: "validator-1" }],
      aiCheckConfig: [{ id: "ai-check-1" }],
      signalCatchers: [{ id: "signal-1" }],
      notifyDrafterOnEnd: "false",
      notifyParticipantOnEnd: "true",
      notifyDrafterOnException: "false",
      notifyAdminOnException: "true",
      notifyCurrentHandlerOnDraftRetract: "false",
      adminFormAuth: "{\"view\":true}",
      processEndIsCirculated: "true",
      rejectDenyRetract: "false",
      canCirculationIdentity: "draft",
      fdHighLights: { N1: true },
      groupChat: { isEnabled: true },
      flowType: "0"
    };
    const payload = buildWorkflowDraftPayload({
      mechanisms: {
        lbpmTemplate: [{
          fdId: "lbpm-template-id",
          fdContent: JSON.stringify(content),
          events: [{ id: "mechanism-event" }]
        }]
      }
    });

    assert.deepEqual(payload.events, [{ id: "mechanism-event" }]);
    for (const key of [
      "operSubmitValidators",
      "aiCheckConfig",
      "signalCatchers",
      "notifyDrafterOnEnd",
      "notifyParticipantOnEnd",
      "notifyDrafterOnException",
      "notifyAdminOnException",
      "notifyCurrentHandlerOnDraftRetract",
      "adminFormAuth",
      "processEndIsCirculated",
      "rejectDenyRetract",
      "canCirculationIdentity",
      "fdHighLights",
      "groupChat"
    ]) {
      assert.deepEqual(payload[key], content[key], key);
    }
    assert.equal(payload.fdFlowType, "0");
    assert.equal(payload.fdContent, JSON.stringify(content));
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
    const payload = projectTemplate(sampleTrustedDsl({
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
    }, baseTemplate(), baseTemplate()));
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

  it("writes person-by-login-name formula participants as sysorg.getPersonByLoginName handlers", () => {
    const form = sampleForm();
    form.fields.push({
      id: "fd_login",
      title: "处理人工号",
      type: "text",
      componentId: "xform-input",
      props: {},
      sourceProps: {},
      sourceRef: "source.form.control.fd_login"
    });
    const payload = projectTemplate(sampleTrustedDsl({
      form,
      workflow: {
        process: { id: "process-person-by-login-name" },
        nodes: [
          { id: "N1", type: "generalStart", element: "startEvent", name: "开始", sourceType: "startNode", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
          {
            id: "N2",
            type: "review",
            element: "manualTask",
            name: "项目经理",
            sourceType: "reviewNode",
            sourceRef: "source.workflow.node.N2",
            attributes: {
              handlerIds: "$组织架构.根据登录名取用户$($fd_login$)",
              handlerNames: "$组织架构.根据登录名取用户$($处理人工号$)",
              handlerSelectType: "formula"
            },
            participants: {
              mode: "person_by_login_name",
              fieldId: "fd_login",
              fieldTitle: "处理人工号",
              sourceExpression: "$组织架构.根据登录名取用户$($fd_login$)",
              sourceNameExpression: "$组织架构.根据登录名取用户$($处理人工号$)"
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
    }, baseTemplate(), baseTemplate()));
    const content = JSON.parse(payload.mechanisms.lbpmTemplate[0].fdContent);
    const node = content.elements.find((element) => element.id === "N2");

    assert.equal(node.handlerSelectType, "formula");
    assert.equal(node.handlerIds, "$组织架构.根据登录名取用户$($fd_login$)");
    assert.equal(node.handlerNames, "$组织架构.根据登录名取用户$($处理人工号$)");
    assert.equal(node.handlers.type, "formula");
    assert.equal(node.handlers.source, "2");
    assert.equal(node.handlers.ruleMode, "formula");
    assert.equal(node.handlers.ruleName, "#根据登录名查找人员#($内置表单.处理人工号$)");
    assert.equal(node.handlers.ruleKey.script, "${func.sysorg.getPersonByLoginName}(${data.template-id-fd_login})");
    assert.deepEqual(node.handlers.ruleKey.varIds, ["template-id-fd_login"]);
    assert.equal(node.handlers.ruleKey.vo.content, "#根据登录名查找人员#($内置表单.处理人工号$)");
    assert.equal(node.handlers.ruleKey.resultType.type, "array");
  });

  it("rejects readback when formula participant scripts are mutated", () => {
    const trusted = sampleFormulaParticipantDsl();
    const template = projectTemplate(trusted, baseTemplate());
    const baseline = verifyTemplate(trusted, template);

    assert.equal(baseline.ok, true, JSON.stringify(baseline.diagnostics));

    const mutations = [
      ["N2", '${func.sysorg.getPersonByLoginName}("hardcoded")'],
      ["N3", '$部门领导.根据部门编号获取部门领导$("hardcoded")'],
      ["N4", "${data._ProcessCreatorWrong}"],
      ["N5", '$组织架构.解释角色线$($流程.获取节点实际处理人$("N3"), "Company Lead", "Department Lead")']
    ];
    for (const [nodeId, script] of mutations) {
      const mutated = structuredClone(template);
      const content = JSON.parse(mutated.mechanisms.lbpmTemplate[0].fdContent);
      content.elements.find((element) => element.id === nodeId).handlers.ruleKey.script = script;
      mutated.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(content);
      const verification = verifyTemplate(trusted, mutated);

      assert.equal(verification.ok, false, `${nodeId}: ${JSON.stringify(verification.diagnostics)}`);
      assert.equal(
        verification.diagnostics.some((item) => item.code === "readback.workflow.participant_mismatch"),
        true,
        nodeId
      );
    }

    const shapeMutations = [
      ["handler type", "N2", (node) => { node.handlers.type = "org"; }],
      ["handler source", "N2", (node) => { node.handlers.source = "1"; }],
      ["handler select type", "N2", (node) => { node.handlerSelectType = "org"; }],
      ["formula type", "N2", (node) => { node.handlers.formulaType = "rule"; }],
      ["rule key type", "N2", (node) => { node.handlers.ruleKey.type = "Constant"; }],
      ["rule vo mode", "N2", (node) => { node.handlers.ruleKey.vo.mode = "simple"; }],
      ["person result type", "N2", (node) => { delete node.handlers.ruleKey.resultType; }],
      ["creator result type", "N4", (node) => { delete node.handlers.ruleKey.resultType; }],
      ["formula members", "N2", (node) => {
        node.handlers.members = [{ id: "unexpected", element: "user", type: "1" }];
      }]
    ];
    for (const [label, nodeId, mutate] of shapeMutations) {
      const mutated = structuredClone(template);
      const content = JSON.parse(mutated.mechanisms.lbpmTemplate[0].fdContent);
      mutate(content.elements.find((element) => element.id === nodeId));
      mutated.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(content);
      const verification = verifyTemplate(trusted, mutated);

      assert.equal(verification.ok, false, `${label}: ${JSON.stringify(verification.diagnostics)}`);
      assert.equal(
        verification.diagnostics.some((item) => item.code === "readback.workflow.participant_mismatch"),
        true,
        label
      );
    }
  });

  it("maps explicit participant org types to the current native member shape", () => {
    const workflow = sampleInitiatorSelectWorkflow();
    const node = workflow.nodes.find((item) => item.id === "N9");
    node.participants.members = [
      { id: "person-1", name: "人员", sourceOrgType: "8", type: "3", element: "org" },
      { id: "post-1", name: "岗位", fdOrgType: 4, type: "1", element: "post" },
      { id: "other-1", name: "其他组织", sourceOrgType: "2", type: "1", element: "org" },
      { id: "legacy-2", name: "兼容岗位", type: "2", element: "post" }
    ];

    const content = buildWorkflowContent(workflow);
    const members = content.elements.find((element) => element.id === "N9").handlers.members;

    assert.deepEqual(members.map((member) => ({ id: member.id, element: member.element, type: member.type })), [
      { id: "person-1", element: "user", type: "1" },
      { id: "post-1", element: "user", type: "2" },
      { id: "other-1", element: "user", type: "3" },
      { id: "legacy-2", element: "user", type: "2" }
    ]);
  });

  it("rejects readback when an explicit post is persisted as a person", () => {
    const workflow = sampleInitiatorSelectWorkflow();
    const explicitNode = workflow.nodes.find((node) => node.id === "N9");
    explicitNode.participants.members = [{
      id: "post-1",
      name: "审批岗位",
      sourceOrgType: 4,
      type: "user_or_org"
    }];
    const trusted = sampleTrustedDsl({ workflow });
    const template = projectTemplate(trusted, baseTemplate());

    const initialVerification = verifyTemplate(trusted, template);
    assert.equal(initialVerification.ok, true, JSON.stringify(initialVerification.diagnostics));

    const content = JSON.parse(template.mechanisms.lbpmTemplate[0].fdContent);
    content.elements.find((element) => element.id === "N9").handlers.members[0].type = "1";
    template.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(content);
    const rejected = verifyTemplate(trusted, template);

    assert.equal(rejected.ok, false);
    assert.equal(
      rejected.diagnostics.some((item) => item.code === "readback.workflow.participant_mismatch"),
      true
    );
  });

  it("writes and verifies the native alternative-handler candidate range", () => {
    const workflow = sampleInitiatorSelectWorkflow();
    const n16 = workflow.nodes.find((node) => node.id === "N16");
    n16.participants.alternativeMembers = [
      { id: "person-1", name: "人员", sourceOrgType: "8" },
      { id: "post-1", name: "岗位", fdOrgType: 4 },
      { id: "other-1", name: "其他组织", sourceOrgType: "2" }
    ];
    n16.participants.useAlternativeOnly = true;
    const n7 = workflow.nodes.find((node) => node.id === "N7");
    n7.participants.alternativeMembers = [{ id: "legacy-post", name: "兼容岗位", type: "2" }];
    n7.participants.useAlternativeOnly = false;
    const trusted = sampleTrustedDsl({ workflow });
    const template = projectTemplate(trusted, baseTemplate());
    const content = JSON.parse(template.mechanisms.lbpmTemplate[0].fdContent);
    const persistedN16 = content.elements.find((element) => element.id === "N16");
    const persistedN7 = content.elements.find((element) => element.id === "N7");

    assert.deepEqual(persistedN16.alternativeHandlers, {
      id: "alternativeHandlers",
      element: "users",
      type: "org",
      source: "1",
      ruleKey: "",
      ruleName: "",
      members: [
        { id: "person-1", name: "人员", element: "user", type: "1" },
        { id: "post-1", name: "岗位", element: "user", type: "2" },
        { id: "other-1", name: "其他组织", element: "user", type: "3" }
      ]
    });
    assert.equal(persistedN16.isUseAlternativeHandlerOnly, "true");
    assert.equal(persistedN7.isUseAlternativeHandlerOnly, "false");
    assert.equal(verifyTemplate(trusted, template).ok, true);

    persistedN16.alternativeHandlers.members.pop();
    template.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(content);
    const rejected = verifyTemplate(trusted, template);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.diagnostics.some((item) => item.code === "readback.workflow.participant_mismatch"), true);

    const flagTemplate = projectTemplate(trusted, baseTemplate());
    const flagContent = JSON.parse(flagTemplate.mechanisms.lbpmTemplate[0].fdContent);
    flagContent.elements.find((element) => element.id === "N16").isUseAlternativeHandlerOnly = "false";
    flagTemplate.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(flagContent);
    assert.equal(verifyTemplate(trusted, flagTemplate).ok, false);

    const shapeTemplate = projectTemplate(trusted, baseTemplate());
    const shapeContent = JSON.parse(shapeTemplate.mechanisms.lbpmTemplate[0].fdContent);
    shapeContent.elements.find((element) => element.id === "N16").alternativeHandlers.type = "formula";
    shapeTemplate.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(shapeContent);
    assert.equal(verifyTemplate(trusted, shapeTemplate).ok, false);
  });

  it("writes draft-selected participants and verifies them on readback", () => {
    const trusted = sampleTrustedDsl({ workflow: sampleInitiatorSelectWorkflow() });
    const content = buildWorkflowContent(trusted.workflow, {
      templateId: "template-id",
      form: trusted.form
    });
    const n16 = content.elements.find((element) => element.id === "N16");
    const n7 = content.elements.find((element) => element.id === "N7");
    const n9 = content.elements.find((element) => element.id === "N9");

    const draft = content.elements.find((element) => element.id === "N2");
    assert.equal(draft.mustModifyHandlerNodes, "N7");
    assert.equal(draft.canModifyHandlerNodes, "N16");
    assert.equal(n16.handlers.source, "1");
    assert.equal(n16.handlers.ruleKey, "");
    assert.equal(n16.handlers.ruleName, "");
    assert.deepEqual(n16.handlers.members, []);
    assert.equal(n16.emptyHandlerType, 1);
    assert.equal(n7.handlers.source, "1");
    assert.equal(n7.emptyHandlerType, 2);
    assert.equal(n9.handlers.source, "1");
    assert.equal(n9.handlers.members.length > 0, true);

    const template = projectTemplate(trusted, baseTemplate());
    const verified = verifyTemplate(trusted, template);
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.workflow.initiatorSelectNodeIds, ["N16", "N7"]);

    const readbackContent = JSON.parse(template.mechanisms.lbpmTemplate[0].fdContent);
    readbackContent.elements.find((element) => element.id === "N2").mustModifyHandlerNodes = "N7";
    delete readbackContent.elements.find((element) => element.id === "N2").canModifyHandlerNodes;
    template.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(readbackContent);
    const rejected = verifyTemplate(trusted, template);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.diagnostics.some((item) => item.code === "readback.workflow.participant_mismatch"), true);
  });

  it("persists draft-selection linkage from any workflow node with comma delimiters", () => {
    const workflow = sampleInitiatorSelectWorkflow();
    workflow.nodes.find((node) => node.id === "N1").attributes.mustModifyHandlerNodeIds = "N16; N7，N16";
    workflow.nodes.find((node) => node.id === "N1").attributes.canModifyHandlerNodeIds = "N16";
    delete workflow.nodes.find((node) => node.id === "N2").attributes.mustModifyHandlerNodeIds;
    delete workflow.nodes.find((node) => node.id === "N2").attributes.canModifyHandlerNodeIds;
    const trusted = sampleTrustedDsl({ workflow });
    const template = projectTemplate(trusted, baseTemplate());
    const content = JSON.parse(template.mechanisms.lbpmTemplate[0].fdContent);

    assert.equal(content.elements.find((element) => element.id === "N1").mustModifyHandlerNodes, "N16,N7");
    assert.equal(content.elements.find((element) => element.id === "N1").canModifyHandlerNodes, "N16");
    assert.equal(content.elements.find((element) => element.id === "N2").mustModifyHandlerNodes, undefined);
    assert.equal(content.elements.find((element) => element.id === "N2").canModifyHandlerNodes, undefined);
    assert.equal(verifyTemplate(trusted, template).ok, true);

    content.elements.find((element) => element.id === "N1").mustModifyHandlerNodes = "N7";
    template.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(content);
    const rejected = verifyTemplate(trusted, template);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.diagnostics.some((item) => item.code === "readback.workflow.participant_mismatch"), true);
  });

  localCorpusIt("writes role-line formula participants as dynamic handler formulas", () => {
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

  localCorpusIt("writes legacy robot nodes with selectable robot type and preserved config", () => {
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
    const expectedFields = ["fd_private_note"];
    const trusted = trustedDslFromFixture("tests/fixtures/source/module-rights-evidence");
    const payload = projectTemplate(trusted, baseTemplate());
    const lbpm = payload.mechanisms.lbpmTemplate[0];
    const auth = lbpm.fdTemplateFormAuths.N2;
    const content = JSON.parse(lbpm.fdContent);

    assert.deepEqual(Object.keys(auth).sort(), expectedFields);
    assert.deepEqual(auth.fd_private_note, {
      isShow: false,
      isEdit: false,
      isRequire: false
    });
    assert.equal(content.elements.find((element) => element.id === "N2").openDataAuthority, true);
    assert.equal(content.elements.find((element) => element.id === "N1").openDataAuthority, false);
  });

  it("forces ignoreOnSameIdentity=1 when node form auth has required fields", () => {
    const workflow = {
      process: { id: "process-same-identity-required" },
      nodes: [
        { id: "N1", type: "generalStart", element: "startEvent", name: "开始", attributes: {} },
        {
          id: "N387",
          type: "review",
          element: "manualTask",
          name: "执行采购主管（叶片）",
          attributes: {},
          definition: {
            attributes: {
              ignoreOnHandlerSame: "true",
              onAdjoinHandlerSame: "true"
            }
          },
          dataAuthority: {
            enabled: true,
            fields: {
              fd_subject: {
                visible: true,
                editable: true,
                required: true,
                sourceMode: "edit",
                sourceRef: "source.form.dataAuthority.fd_subject"
              }
            }
          },
          participants: {
            mode: "explicit",
            members: [{ id: "handler-1", name: "审批人", type: "user_or_org" }]
          }
        },
        { id: "N3", type: "generalEnd", element: "endEvent", name: "结束", attributes: {} }
      ],
      edges: [
        { id: "L1", source: "N1", target: "N387" },
        { id: "L2", source: "N387", target: "N3" }
      ]
    };

    const content = buildWorkflowContent(workflow);
    const node = content.elements.find((element) => element.id === "N387");
    assert.equal(node.ignoreOnSameIdentity, "1");
  });

  it("maps ignoreOnHandlerSame=true to ignoreOnSameIdentity=2 when skip is allowed", () => {
    const workflow = {
      process: { id: "process-same-identity-skip" },
      nodes: [
        { id: "N1", type: "generalStart", element: "startEvent", name: "开始", attributes: {} },
        {
          id: "N378",
          type: "review",
          element: "manualTask",
          name: "区域经理",
          attributes: {},
          definition: {
            attributes: {
              ignoreOnHandlerSame: "true",
              onAdjoinHandlerSame: "true"
            }
          },
          participants: {
            mode: "explicit",
            members: [{ id: "handler-1", name: "审批人", type: "user_or_org" }]
          }
        },
        { id: "N3", type: "generalEnd", element: "endEvent", name: "结束", attributes: {} }
      ],
      edges: [
        { id: "L1", source: "N1", target: "N378" },
        { id: "L2", source: "N378", target: "N3" }
      ]
    };

    const content = buildWorkflowContent(workflow);
    const node = content.elements.find((element) => element.id === "N378");
    assert.equal(node.ignoreOnSameIdentity, "2");
  });

  it("writes conditional branch routes through the MK formula designer config", () => {
    const payload = projectTemplate(sampleTrustedDsl({
      form: sampleConditionBranchForm(),
      workflow: sampleConditionBranchWorkflow()
    }), baseTemplate());
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

  it("verifies the persisted NewOA defaultTrend field independently on readback", () => {
    const trusted = sampleTrustedDsl({
      form: sampleConditionBranchForm(),
      workflow: sampleConditionBranchWorkflow()
    });
    const template = projectTemplate(trusted, baseTemplate());

    const initialVerification = verifyTemplate(trusted, template);
    assert.equal(initialVerification.ok, true, JSON.stringify(initialVerification.diagnostics));

    const content = JSON.parse(template.mechanisms.lbpmTemplate[0].fdContent);
    const defaultSequence = content.elements.find((element) => element.id === "L544");
    defaultSequence.defaultTrend = false;
    template.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(content);

    const rejected = verifyTemplate(trusted, template);
    assert.equal(rejected.ok, false);
    assert.equal(
      rejected.diagnostics.some((item) => item.code === "readback.workflow.edge_default_mismatch"),
      true
    );
  });

  it("marks named other routes as default even without isDefault or tautology", () => {
    const workflow = sampleConditionBranchWorkflow();
    const finalRoute = workflow.edges.find((edge) => edge.id === "L544");
    finalRoute.name = "其他";
    finalRoute.condition = {
      sourceText: "!(\"1689\" .equals( $fd_seller$ ) || \"1694\" .equals( $fd_seller$))",
      displayText: "!($合同卖方$ == \"1689\" || $合同卖方$ == \"1694\")",
      targetText: "!(\"1689\" .equals( $fd_seller$ ) || \"1694\" .equals( $fd_seller$))",
      translationStatus: "display_only"
    };
    delete finalRoute.attributes.isDefault;

    const content = buildWorkflowContent(workflow, {
      templateId: "template-id",
      form: sampleConditionBranchForm()
    });
    const branch = content.elements.find((element) => element.id === "N410");
    const routes = JSON.parse(branch.conditionValue).formulas;
    const defaultRoute = routes.find((route) => route.lineId === "L544");
    const sequence = content.elements.find((element) => element.id === "L544");

    assert.equal(branch.default, "L544");
    assert.equal(branch.conditionId, "L544");
    assert.equal(defaultRoute.defaultTrend, true);
    assert.equal(sequence.defaultTrend, true);
    assert.equal(sequence.style, "sequenceFlow;marker");
    assert.equal(sequence.formulaType, "formula");
    assert.equal(Boolean(defaultRoute.formulaConfig || defaultRoute.conditionSimpleData), true);
  });

  it("prefers named other over a sibling tautology when choosing the default route", () => {
    const workflow = sampleConditionBranchWorkflow();
    delete workflow.edges.find((edge) => edge.id === "L544").attributes.isDefault;
    workflow.edges.find((edge) => edge.id === "L544").name = "其他";
    workflow.edges.find((edge) => edge.id === "L544").condition = {
      sourceText: "!(\"1689\" .equals( $fd_seller$ ))",
      displayText: "!($合同卖方$ == \"1689\")",
      targetText: "!(\"1689\" .equals( $fd_seller$ ))",
      translationStatus: "display_only"
    };
    workflow.edges.splice(1, 0, {
      id: "L549",
      source: "N410",
      target: "N412",
      name: "兜底业务",
      sourceRef: "source.workflow.edge.L549",
      condition: {
        sourceText: "1 == 1",
        displayText: "1 == 1",
        targetText: "1 == 1",
        translationStatus: "display_only"
      },
      attributes: { priority: "20" }
    });

    const content = buildWorkflowContent(workflow, {
      templateId: "template-id",
      form: sampleConditionBranchForm()
    });
    const branch = content.elements.find((element) => element.id === "N410");
    const routes = JSON.parse(branch.conditionValue).formulas;
    assert.equal(branch.default, "L544");
    assert.equal(routes.find((route) => route.lineId === "L544").defaultTrend, true);
    assert.equal(routes.find((route) => route.lineId === "L549").defaultTrend, false);
  });

  it("infers synthetic other formulas from sibling route fields when branch title is generic", () => {
    const workflow = sampleConditionBranchWorkflow();
    workflow.nodes.find((node) => node.id === "N410").name = "条件分支";
    workflow.nodes.find((node) => node.id === "N410").attributes.name = "条件分支";
    delete workflow.edges.find((edge) => edge.id === "L544").attributes.isDefault;
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

    const content = buildWorkflowContent(workflow, {
      templateId: "template-id",
      form: sampleConditionBranchForm()
    });
    const branch = content.elements.find((element) => element.id === "N410");
    const route = JSON.parse(branch.conditionValue).formulas.find((item) => item.lineId === "L542");
    const sequence = content.elements.find((element) => element.id === "L542");
    assert.equal(branch.default, "L542");
    assert.equal(route.defaultTrend, true);
    assert.equal(route.formula.result.value, "(!${data.$VAR.L542_fd_seller_notempty})");
    assert.equal(sequence.formulaType, "formula");
  });

  localCorpusIt("marks only the four true default routes in source 167 and keeps N384 on L1028", () => {
    const trusted = trustedDslFromFixture("tests/fixtures/source/1670297c984b45009eb5b1e444d9957d");
    const content = buildWorkflowContent(trusted.workflow, {
      templateId: "template-id",
      form: trusted.form
    });
    const defaultSequences = content.elements.filter((element) => element.type === "sequenceFlow" && element.defaultTrend === true);
    const n384 = content.elements.find((element) => element.id === "N384");
    const n344 = content.elements.find((element) => element.id === "N344");

    assert.equal(defaultSequences.length >= 4, true);
    assert.equal(n384.default, "L1028");
    assert.equal(n384.conditionId, "L1028");
    assert.equal(n344.default, "L444");
  });

  localCorpusIt("writes N344 address-field contains routes as belongany org predicates", () => {
    const trusted = trustedDslFromFixture("tests/fixtures/source/1670297c984b45009eb5b1e444d9957d");
    const conditionOrgByName = {
      南方服务中心: { fdId: "org-south", fdName: "南方服务中心", fdOrgType: 2, fdNo: "S001" },
      北方服务中心: { fdId: "org-north", fdName: "北方服务中心", fdOrgType: 2, fdNo: "N001" },
      海外服务中心: { fdId: "org-overseas", fdName: "海外服务中心", fdOrgType: 2, fdNo: "O001" },
      海外业务中心: { fdId: "org-overseas-biz", fdName: "海外业务中心", fdOrgType: 2, fdNo: "OB01" },
      海外销售事业部: { fdId: "org-overseas-sales", fdName: "海外销售事业部", fdOrgType: 2, fdNo: "OS01" }
    };
    const content = buildWorkflowContent(trusted.workflow, {
      templateId: "template-id",
      form: trusted.form,
      conditionOrgByName
    });
    const branch = content.elements.find((element) => element.id === "N344");
    const conditionValue = JSON.parse(branch.conditionValue);
    const southRoute = conditionValue.formulas.find((item) => item.lineId === "L443");
    const overseasRoute = conditionValue.formulas.find((item) => item.lineId === "L1020");
    const otherRoute = conditionValue.formulas.find((item) => item.lineId === "L444");
    const southRules = southRoute.formula.vo.data.fdList[0].fdList;
    const otherRules = otherRoute.formula.vo.data.fdList[0].fdList;

    assert.equal(southRoute.formula.vars[0].value, "sysorg.isOrganizationBelongOrIncludeAnother");
    assert.equal(southRules[0].fdSymbol, "belongany");
    assert.equal(southRules[0].fdFunctionId, "sysorg.isOrganizationBelongOrIncludeAnother");
    assert.equal(southRules[0].fdSymbolAndOrgType, "belongany.ORG_DEPT.true");
    assert.equal(southRules[0].fdOrgType, 3);
    assert.equal(southRules[0].fdThrough, "true");
    assert.equal(southRules[0].vo.$ref, "ORG_DEPT");
    assert.deepEqual(JSON.parse(southRules[0].fdValue), [conditionOrgByName.南方服务中心]);
    assert.equal(overseasRoute.formula.vars[0].value, "sysorg.isOrganizationBelongOrIncludeAnother");
    assert.equal(overseasRoute.formula.vo.data.fdList[0].fdList[0].fdSymbol, "belongany");
    assert.equal(otherRoute.formula.vo.data.fdList[0].fdType, "AND");
    assert.equal(otherRules.every((rule) => rule.fdSymbol === "notbelong"), true);
    assert.equal(otherRules.every((rule) => rule.fdFunctionId === "sysorg.isOrganizationBelongOrIncludeAnother"), true);
    assert.match(otherRoute.formula.result.value, /!\$\{data\.\$VAR\./);
  });

  it("writes address-field contains conditions as belongany when org is resolved", () => {
    const workflow = sampleConditionBranchWorkflow();
    workflow.edges[1] = {
      ...workflow.edges[1],
      condition: {
        sourceText: "$字符串.包含$($fd_req_dept$, \"南方服务中心\")",
        displayText: "$需求人部门$ 包含 \"南方服务中心\"",
        targetText: "$字符串.包含$($fd_req_dept$, \"南方服务中心\")",
        translationStatus: "display_only"
      }
    };
    const form = sampleConditionBranchForm();
    form.fields.push({
      id: "fd_req_dept",
      title: "需求人部门",
      type: "text",
      componentId: "xform-address",
      props: { required: true },
      sourceProps: { designerType: "address" },
      sourceRef: "source.form.control.fd_req_dept"
    });
    const org = { fdId: "org-south", fdName: "南方服务中心", fdOrgType: 2, fdNo: "S001" };
    const content = buildWorkflowContent(workflow, {
      templateId: "template-id",
      form,
      conditionOrgByName: { 南方服务中心: org }
    });
    const branch = content.elements.find((element) => element.id === "N410");
    const route = JSON.parse(branch.conditionValue).formulas.find((item) => item.lineId === "L541");
    const rule = route.formula.vo.data.fdList[0].fdList[0];

    assert.equal(route.formula.vars[0].value, "sysorg.isOrganizationBelongOrIncludeAnother");
    assert.deepEqual(route.formula.vars[0].arguments[1].value, [org]);
    assert.equal(route.formula.vars[0].arguments[2].value, 4);
    assert.equal(route.formula.vars[0].arguments[3].value, true);
    assert.equal(rule.fdSymbol, "belongany");
    assert.equal(rule.fdDataType, "object");
    assert.equal(rule.fdSymbolAndOrgType, "belongany.ORG_DEPT.true");
    assert.deepEqual(JSON.parse(rule.fdValue), [org]);
  });

  it("writes mixed equals-and-numeric OR branch routes through formula config", () => {
    const form = sampleConditionBranchForm();
    form.fields.push({
      id: "fd_way",
      title: "开票录入方式",
      type: "radio",
      componentId: "xform-radio",
      props: {},
      sourceProps: { designerType: "inputRadio" },
      sourceRef: "source.form.control.fd_way"
    });
    form.fields.push({
      id: "fd_qr_1",
      title: "是否确认收入1",
      type: "text",
      componentId: "xform-input",
      dataOnly: true,
      props: {},
      sourceProps: { designerType: "inputText" },
      sourceRef: "source.form.control.fd_qr_1"
    });
    const workflow = sampleConditionBranchWorkflow();
    workflow.nodes[1] = {
      ...workflow.nodes[1],
      id: "N23",
      name: "是否开票",
      attributes: { id: "N23", name: "是否开票" },
      sourceRef: "source.workflow.node.N23"
    };
    workflow.edges[0] = { ...workflow.edges[0], target: "N23" };
    workflow.edges[1] = {
      id: "L109",
      source: "N23",
      target: "N411",
      name: "开票",
      sourceRef: "source.workflow.edge.L109",
      condition: {
        sourceText: "\"er\" .equals($fd_qr_1$ )  || \"ui\" .equals($fd_qr_1$ )  || \"ty\" .equals( $fd_qr_1$) ",
        displayText: "\"er\" .equals($是否确认收入1$ )  || \"ui\" .equals($是否确认收入1$ )  || \"ty\" .equals( $是否确认收入1$) ",
        targetText: "\"er\" .equals($fd_qr_1$ )  || \"ui\" .equals($fd_qr_1$ )  || \"ty\" .equals( $fd_qr_1$) ",
        translationStatus: "display_only"
      },
      attributes: { priority: "1" }
    };
    workflow.edges[2] = {
      id: "L99",
      source: "N23",
      target: "N413",
      name: "不开票",
      sourceRef: "source.workflow.edge.L99",
      condition: {
        sourceText: "\"qw\" .equals( $fd_qr_1$) || $fd_way$ == 33",
        displayText: "\"qw\" .equals( $是否确认收入1$) || $开票录入方式$ == 33",
        targetText: "\"qw\" .equals( $fd_qr_1$) || $fd_way$ == 33",
        translationStatus: "display_only"
      },
      attributes: { priority: "2" }
    };
    workflow.edges[3] = {
      ...workflow.edges[3],
      id: "L544",
      source: "N23",
      target: "N412",
      name: "默认",
      attributes: { priority: "3", isDefault: true }
    };

    const payload = projectTemplate(sampleTrustedDsl({ form, workflow }), baseTemplate());
    const content = JSON.parse(payload.mechanisms.lbpmTemplate[0].fdContent);
    const branch = content.elements.find((element) => element.id === "N23");
    const conditionValue = JSON.parse(branch.conditionValue);
    const invoiceRoute = conditionValue.formulas.find((item) => item.lineId === "L109");
    const noInvoiceRoute = conditionValue.formulas.find((item) => item.lineId === "L99");
    const noInvoiceSequence = content.elements.find((element) => element.id === "L99");

    assert.equal(invoiceRoute.formula.type, "Batch");
    assert.equal(noInvoiceRoute.formula.type, "Batch");
    assert.equal(noInvoiceSequence.formulaType, "formula");
    assert.equal(
      noInvoiceRoute.formula.result.value,
      "(${data.$VAR.L99_fd_qr_1_1} || ${data.$VAR.L99_fd_way_2})"
    );
    assert.deepEqual(noInvoiceRoute.formula.vars.map((item) => item.value), [
      "${data.template-id-fd_qr_1} == \"qw\"",
      "${data.template-id-fd_way} == \"33\""
    ]);
    assert.equal(noInvoiceRoute.formula.vo.data.fdList[0].fdList[1].fdValue, "33");
    assert.equal(noInvoiceRoute.formula.vo.data.fdList[0].fdList[1].fdVarValue, "template-id-fd_way");
  });

  it("writes manualBranchNode gateways as conditionType 2 named rules", () => {
    const workflow = sampleConditionBranchWorkflow();
    workflow.nodes[1] = {
      ...workflow.nodes[1],
      id: "N35",
      name: "人工决策",
      sourceType: "manualBranchNode",
      attributes: { decidedBranchOnDraft: "false", id: "N35", name: "人工决策" },
      sourceRef: "source.workflow.node.N35"
    };
    workflow.edges[0] = { ...workflow.edges[0], target: "N35" };
    workflow.edges[1] = {
      id: "L44",
      source: "N35",
      target: "N411",
      name: "上汽",
      sourceRef: "source.workflow.edge.L44",
      condition: { sourceText: "", displayText: "", targetText: "", translationStatus: "executable" },
      attributes: { priority: "1" }
    };
    workflow.edges[2] = {
      id: "L45",
      source: "N35",
      target: "N413",
      name: "上发",
      sourceRef: "source.workflow.edge.L45",
      condition: { sourceText: "", displayText: "", targetText: "", translationStatus: "executable" },
      attributes: { priority: "2" }
    };
    workflow.edges[3] = {
      id: "L46",
      source: "N35",
      target: "N412",
      name: "上辅",
      sourceRef: "source.workflow.edge.L46",
      condition: { sourceText: "", displayText: "", targetText: "", translationStatus: "executable" },
      attributes: { priority: "3" }
    };

    const payload = projectTemplate(sampleTrustedDsl({
      form: sampleConditionBranchForm(),
      workflow
    }), baseTemplate());
    const content = JSON.parse(payload.mechanisms.lbpmTemplate[0].fdContent);
    const branch = content.elements.find((element) => element.id === "N35");
    const conditionValue = JSON.parse(branch.conditionValue);
    const edge = content.elements.find((element) => element.id === "L44");

    assert.equal(branch.conditionType, "2");
    assert.equal(conditionValue.formulas, undefined);
    assert.equal(conditionValue.rules.length, 3);
    assert.deepEqual(conditionValue.rules.map((rule) => rule.lineName), ["上汽", "上发", "上辅"]);
    assert.equal(conditionValue.rules[0].type, "rules");
    assert.equal(conditionValue.rules[0].formulaType, "rule");
    assert.equal(conditionValue.rules[0].formula, "上汽");
    assert.equal(conditionValue.ruleConfig.vo.mode, "rule");
    assert.equal(edge.formulaType, "rule");
    assert.equal(edge.formula, "上汽");
    assert.equal(JSON.parse(branch.resultSetMapping)[0].resultCode, "上汽");
  });

  it("writes numeric relational comparisons through formula config", () => {
    const form = sampleConditionBranchForm();
    form.fields.push({
      id: "fd_total",
      title: "合计金额A",
      type: "number",
      componentId: "xform-number",
      props: {},
      sourceProps: { designerType: "calculation" },
      sourceRef: "source.form.control.fd_total"
    });
    const workflow = sampleConditionBranchWorkflow();
    workflow.edges[1] = {
      ...workflow.edges[1],
      condition: {
        sourceText: "$fd_total$ >= 100000",
        displayText: "$合计金额A$ >= 100000",
        targetText: "$fd_total$ >= 100000",
        translationStatus: "display_only"
      }
    };
    workflow.edges[2] = {
      ...workflow.edges[2],
      condition: {
        sourceText: "$fd_total$  <  100000",
        displayText: "$合计金额A$  <  100000",
        targetText: "$fd_total$  <  100000",
        translationStatus: "display_only"
      }
    };

    const content = buildWorkflowContent(workflow, {
      templateId: "template-id",
      form
    });
    const high = content.elements.find((element) => element.id === "L541");
    const low = content.elements.find((element) => element.id === "L546");
    const branch = content.elements.find((element) => element.id === "N410");
    const routes = JSON.parse(branch.conditionValue).formulas;
    const highRoute = routes.find((route) => route.lineId === "L541");
    const lowRoute = routes.find((route) => route.lineId === "L546");

    assert.equal(high.formulaType, "formula");
    assert.equal(low.formulaType, "formula");
    assert.equal(highRoute.formula.type, "Batch");
    assert.equal(lowRoute.formula.type, "Batch");
    assert.equal(highRoute.formula.vars[0].value, "${data.template-id-fd_total} >= \"100000\"");
    assert.equal(lowRoute.formula.vars[0].value, "${data.template-id-fd_total} < \"100000\"");
    assert.equal(highRoute.formula.vo.data.fdList[0].fdList[0].fdSymbol, ">=");
    assert.equal(lowRoute.formula.vo.data.fdList[0].fdList[0].fdSymbol, "<");
    assert.equal(highRoute.formula.vo.data.fdList[0].fdList[0].fdDataType, "number");
    assert.equal(lowRoute.formula.vo.data.fdList[0].fdList[0].fdDataType, "number");
    assert.strictEqual(highRoute.formula.vo.data.fdList[0].fdList[0].fdValue, 100000);
    assert.strictEqual(lowRoute.formula.vo.data.fdList[0].fdList[0].fdValue, 100000);
    assert.equal(typeof highRoute.formula.vo.data.fdList[0].fdList[0].fdValue, "number");
    assert.equal(typeof lowRoute.formula.vo.data.fdList[0].fdList[0].fdValue, "number");
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
    const payload = projectTemplate(sampleTrustedDsl({
      form: sampleConditionBranchForm(),
      workflow
    }), baseTemplate());
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
    const payload = projectTemplate(sampleTrustedDsl({
      form: sampleConditionBranchForm(),
      workflow
    }, baseTemplate()));
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
    assert.equal(notEquals.vars[0].value, "${data.template-id-fd_seller} != \"1689\"");
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
    assert.equal(notContains.result.value, "(!${data.$VAR.L541_fd_seller})");
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
    assert.equal(notEmpty.result.value, "(!${data.$VAR.L541_fd_seller})");
    assert.equal(notEmpty.vo.data.fdList[0].fdList[0].fdSymbol, "notempty");
    assert.equal(notEmpty.vo.data.fdList[0].fdList[0].fdFunctionId, "global.isEmpty");
  });

  localCorpusIt("writes N437 contains department routes into editable simple conditions", () => {
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
    assert.equal(otherRoute.formula.result.value, "(!${data.$VAR.L570_fd_36b983442aa544})");
    assert.equal(otherRule.fdSymbol, "notcontain");
    assert.equal(otherRule.fdFunctionId, "global.contains");
    assert.equal(otherRule.fdValue, "计划项目");
  });

  localCorpusIt("writes N415 other seller route with editable not-equals predicates", () => {
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
    assert.equal(branch.default, "L548");
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

  localCorpusIt("writes N257 mixed and/or routes into editable simple conditions", () => {
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

  localCorpusIt("writes every fixture branch condition into editable formula configs", () => {
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

  localCorpusIt("marks only explicit, named-other, or tautological fixture routes as defaults", () => {
    const { content, trusted } = buildRouteValidationWorkflowContent();
    const edgeById = new Map(trusted.workflow.edges.map((edge) => [edge.id, edge]));
    const sequenceById = new Map(content.elements.filter((element) => element.type === "sequenceFlow").map((edge) => [edge.id, edge]));
    const invalidDefaultRoutes = [];

    for (const branch of content.elements.filter((element) => element.type === "conditionBranch")) {
      const conditionValue = JSON.parse(branch.conditionValue || "{}");
      for (const route of conditionValue.formulas || []) {
        if (route.defaultTrend !== true) continue;
        const edge = edgeById.get(route.lineId);
        const sequence = sequenceById.get(route.lineId);
        const isExplicit = edge?.isDefault === true || edge?.attributes?.isDefault === true ||
          edge?.isDefault === "true" || edge?.attributes?.isDefault === "true";
        const isNamedOther = String(edge?.name || "").trim() === "其他";
        const isTautology = isTautologyConditionForTest(edgeConditionTextForTest(edge));
        if ((!isExplicit && !isNamedOther && !isTautology) || sequence?.defaultTrend !== true || sequence?.style !== "sequenceFlow;marker") {
          invalidDefaultRoutes.push({
            branchId: branch.id,
            lineId: route.lineId,
            lineName: route.lineName,
            isExplicit,
            isNamedOther,
            isTautology,
            sequenceDefaultTrend: sequence?.defaultTrend,
            style: sequence?.style
          });
        }
      }
    }

    assert.deepEqual(invalidDefaultRoutes, []);
  });

  it("writes tautological other routes as not-empty alternate routes for the branch field", () => {
    const workflow = sampleConditionBranchWorkflow();
    delete workflow.edges.find((edge) => edge.id === "L544").attributes.isDefault;
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
    const payload = projectTemplate(sampleTrustedDsl({
      form: sampleConditionBranchForm(),
      workflow
    }, baseTemplate()));
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
    assert.equal(routeFormula.result.value, "(!${data.$VAR.L542_fd_seller_notempty})");
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

  it("writes a non-named tautological default as a native Batch formula", () => {
    const form = sampleConditionBranchForm();
    const workflow = sampleConditionBranchWorkflow();
    const branch = workflow.nodes.find((node) => node.id === "N410");
    branch.name = "条件分支";
    branch.attributes.name = "条件分支";
    const fallback = workflow.edges.find((edge) => edge.id === "L544");
    fallback.name = "除系统开具外的线下路径";
    fallback.condition = {
      sourceText: "1==1",
      displayText: "1==1",
      targetText: "1==1",
      translationStatus: "display_only"
    };
    delete fallback.attributes.isDefault;

    const trusted = sampleTrustedDsl({ form, workflow });
    const template = projectTemplate(trusted, baseTemplate());
    const content = JSON.parse(template.mechanisms.lbpmTemplate[0].fdContent);
    const sequence = content.elements.find((element) => element.id === "L544");
    const verification = verifyTemplate(trusted, template);

    assert.equal(
      verification.diagnostics.some((item) => item.code === "readback.workflow.edge_condition_native_corrupt"),
      false,
      JSON.stringify(verification.diagnostics)
    );
    assert.equal(sequence.defaultTrend, true);
    assert.equal(sequence.formulaType, "formula");
    const nativeFormula = JSON.parse(sequence.formula);
    assert.equal(nativeFormula.type, "Batch");
    assert.equal(verification.ok, true, JSON.stringify(verification.diagnostics));

    const corrupt = structuredClone(template);
    const corruptContent = JSON.parse(corrupt.mechanisms.lbpmTemplate[0].fdContent);
    const corruptSequence = corruptContent.elements.find((element) => element.id === "L544");
    corruptSequence.formulaType = "rule";
    corruptSequence.formula = "1==1";
    corrupt.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(corruptContent);
    const rejected = verifyTemplate(trusted, corrupt);
    assert.equal(rejected.ok, false);
    assert.equal(
      rejected.diagnostics.some((item) => item.code === "readback.workflow.edge_condition_native_corrupt"),
      true
    );
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

    const result = await executeDsl(sampleTrustedDsl(), {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1"
    });

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
        const workflow = next.mechanisms.lbpmTemplate[0];
        const content = JSON.parse(workflow.fdContent);
        content.elements.find((element) => element.id === "L1").targetRef = "missing-node";
        workflow.fdContent = JSON.stringify(content);
        return next;
      },
      corruptWorkflowReadback(template) {
        const next = JSON.parse(JSON.stringify(template));
        const content = JSON.parse(next.fdContent);
        content.elements.find((element) => element.id === "L1").targetRef = "missing-node";
        next.fdContent = JSON.stringify(content);
        return next;
      }
    });

    const result = await executeDsl(sampleTrustedDsl(), {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1"
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "readback_failed");
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "readback.workflow.edge_endpoint_mismatch"), true);
  });

  it("rejects draft inputs before any NewOA login or write call", async () => {
    const client = new FakeNewoaClient();
    const result = await executeDsl(sampleDraftDsl(), {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1"
    });

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
    const result = await executeDsl(dsl, {
      client: new FakeNewoaClient(),
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1"
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "written_with_warnings");
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "source.sysform.metadata_missing"), true);
  });

  it("blocks before login when write safety inputs are missing", async () => {
    const client = new FakeNewoaClient();
    const result = await executeDsl(sampleTrustedDsl(), {
      client,
      confirmWrite: true,
      targetCategoryId: "category-1",
      baseUrl: " http://LOCALHOST:8080/ "
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.baseUrl, "http://localhost:8080");
    assert.equal(result.diagnostics[0].code, "safety.username_required");
    assert.deepEqual(client.calls, []);
  });

  it("executes against a normalized caller-provided NewOA origin", async () => {
    const client = new FakeNewoaClient();
    const result = await executeDsl(sampleTrustedDsl(), {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1",
      baseUrl: " http://LOCALHOST:8080/ "
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "written");
    assert.equal(result.baseUrl, "http://localhost:8080");
    assert.equal(client.calls[0].name, "login");
  });

  it("blocks an invalid NewOA base URL before login", async () => {
    const client = new FakeNewoaClient();
    const result = await executeDsl(sampleTrustedDsl(), {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1",
      baseUrl: "https://oa.example.com/api"
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "safety.base_url_invalid"), true);
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
    const payload = projectTemplate(dsl, baseTemplate());
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
    const payload = projectTemplate(dsl, baseTemplate());
    const config = JSON.parse(payload.mechanisms["sys-xform"].fdConfig);
    const subject = config.dataModel.find((model) => model.fdType === "main").fdFields.find((field) => field.fdName === "fd_subject");
    const attribute = JSON.parse(subject.fdAttribute);
    const summary = summarizeProjectedForm(payload);

    assert.equal(subject.fdType, "subject");
    assert.equal(attribute.config.type, "@elem/xform-subject");
    assert.equal(attribute.config.controlProps.desktop.type, "@elem/xform-subject");
    assert.equal(attribute.config.controlProps.mobile.type, "@elem/xform-m-subject");
    assert.equal(summary.fields.find((field) => field.id === "fd_subject").component, "xform-subject");
  });

  it("summarizes persisted select controls with multi flag as multi-select readback", () => {
    const dsl = sampleTrustedDsl({
      workflow: undefined,
      form: {
        fields: [{
          id: "fd_multi_select",
          title: "多选字段",
          type: "multiSelect",
          componentId: "xform-select~multi",
          props: {
            required: true,
            options: [
              { label: "选项 A", value: "A" },
              { label: "选项 B", value: "B" }
            ]
          },
          sourceProps: { designerType: "multiSelect" },
          sourceRef: "source.form.control.fd_multi_select"
        }],
        layout: {
          sourceGrid: { rows: [] },
          mkTree: [{
            id: "layout.row-0",
            componentId: "xform-flex-1-1-layout",
            props: { columns: 1 },
            sourceRef: "source.form.layout.row.row-0",
            children: [{
              id: "c1",
              refType: "field",
              refIds: ["fd_multi_select"],
              sourceRef: "source.form.layout.cell.c1",
              column: 0,
              colspan: 1
            }]
          }]
        }
      }
    });
    const payload = projectTemplate(dsl, baseTemplate());
    const readback = verifyTemplate(dsl, payload);

    assert.equal(readback.form.fields.find((field) => field.id === "fd_multi_select").component, "xform-select~multi");
    assert.equal(
      readback.diagnostics.some((diagnostic) => diagnostic.code === "readback.form.component_mismatch"),
      false
    );
    assert.equal(readback.ok, true);
  });

  localCorpusIt("writes fixture fields with registered MK control types and no textarea heights", () => {
    const trusted = trustedDslFromFixture("tests/fixtures/source/14a08d7d8b8753e20198a5b4223b707e");
    const dslFields = trusted.form.fields.flatMap((field) => field.type === "detailTable" ? field.columns || [] : [field]);
    const payload = projectTemplate(trusted, baseTemplate());
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
        .filter(({ attribute }) => {
          const type = String(attribute.config?.type || "");
          return type !== "desc" && !type.startsWith("@elem/xform-");
        })
        .map(({ name, attribute }) => [name, attribute.config?.type]),
      []
    );
    assert.deepEqual(
      attributes
        .filter(({ attribute }) => {
          const type = attribute.config?.type;
          const desktopType = attribute.config?.controlProps?.desktop?.type;
          return type === "desc"
            ? desktopType !== "@elem/xform-description"
            : type !== desktopType;
        })
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
    const creatorBase = {
      ...baseTemplate(),
      fdName: "MK_TEST_测试模板",
      mechanisms: {
        ...baseTemplate().mechanisms,
        "sys-xform": {
          ...baseTemplate().mechanisms["sys-xform"],
          fdName: "MK_TEST_测试模板"
        }
      }
    };
    const payload = projectTemplate(dsl, creatorBase);
    const fields = JSON.parse(payload.mechanisms["sys-xform"].fdConfig)
      .dataModel.find((model) => model.fdType === "main").fdFields;
    const creatorText = fieldControlProps(fields, "fd_creator_text");
    const creatorDeptText = fieldControlProps(fields, "fd_creator_dept_text");
    const creatorAddress = fieldControlProps(fields, "fd_creator_address");
    const creatorDeptAddress = fieldControlProps(fields, "fd_creator_dept_address");

    assert.equal(creatorText.defaultValueType, "formula");
    assert.equal(creatorText.defaultValueFormulaVO.script, "${data.biz.fdCreator.fdName}");
    assert.deepEqual(creatorText.defaultValueFormulaVO.varIds, ["fdCreator.fdName"]);
    assert.equal(creatorText.defaultValueFormulaVO.vo.content, "$MK_TEST_测试模板.创建人.名称$");
    assert.equal(creatorDeptText.defaultValueFormulaVO.script, "${data.biz.fdCreatorDept.fdName}");
    assert.deepEqual(creatorDeptText.defaultValueFormulaVO.varIds, ["fdCreatorDept.fdName"]);
    assert.equal(creatorDeptText.defaultValueFormulaVO.vo.content, "$MK_TEST_测试模板.创建者部门.名称$");

    assert.deepEqual(creatorAddress.org.orgTypeArr, ["8"]);
    assert.equal(creatorAddress.org.defaultValueType, "formula");
    assert.equal(creatorAddress.defaultValueFormulaVO.script, "${data.biz.fdCreator}");
    assert.deepEqual(creatorAddress.defaultValueFormulaVO.varIds, ["fdCreator"]);
    assert.equal(creatorAddress.defaultValueFormulaVO.vo.content, "$MK_TEST_测试模板.创建人$");
    assert.deepEqual(creatorDeptAddress.org.orgTypeArr, ["2"]);
    assert.equal(creatorDeptAddress.defaultValueFormulaVO.script, "${data.biz.fdCreatorDept}");
    assert.equal(creatorDeptAddress.defaultValueFormulaVO.vo.content, "$MK_TEST_测试模板.创建者部门$");

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
    const payload = projectTemplate(dsl, baseTemplate());
    const config = JSON.parse(payload.mechanisms["sys-xform"].fdConfig);
    const formAttr = JSON.parse(config.attribute.formAttr);

    assert.equal(formAttr.controlAction.global.onLoad.length, 1);
    assert.equal(formAttr.controlAction.global.onLoad[0].function.includes("MKXFORM.getValue('fd_subject')"), true);
    assert.equal(formAttr.controlAction.javascript, undefined);
    assert.equal(config.migrationDsl.scripts.actionCount, 1);
    assert.deepEqual(summarizeProjectedForm(payload).scripts.events, ["onLoad"]);
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
    const payload = projectTemplate(dsl, baseTemplate());
    const config = JSON.parse(payload.mechanisms["sys-xform"].fdConfig);
    const formAttr = JSON.parse(config.attribute.formAttr);
    const mainModel = config.dataModel.find((model) => model.fdType === "main");
    const controlKey = `${mainModel.fdTableName}.fd_amount`;

    assert.equal(formAttr.controlAction.control[controlKey].onChange.length, 1);
    assert.equal(formAttr.controlAction.control[controlKey].onChange[0].function.includes("MKXFORM.setValue('fd_subject'"), true);
    assert.deepEqual(summarizeProjectedForm(payload).scripts.controlEvents, [{
      controlKey,
      event: "onChange",
      count: 1
    }]);
  });

  it("persists onChange actions with deterministic unique names without changing control bindings", () => {
    const dsl = sampleTrustedDsl({
      workflow: null,
      scripts: {
        actions: [
          mappedControlChangeAction("amount-change-1", "fd_amount", "first", { viewStatusIn: ["add", "edit"] }),
          mappedControlChangeAction("amount-change-2", "fd_amount", "second"),
          mappedControlChangeAction("subject-change-1", "fd_subject", "third")
        ]
      }
    });
    const payload = projectTemplate(dsl, baseTemplate());
    const repeatedPayload = projectTemplate(dsl, baseTemplate());
    const config = JSON.parse(payload.mechanisms["sys-xform"].fdConfig);
    const repeatedConfig = JSON.parse(repeatedPayload.mechanisms["sys-xform"].fdConfig);
    const formAttr = JSON.parse(config.attribute.formAttr);
    const repeatedFormAttr = JSON.parse(repeatedConfig.attribute.formAttr);
    const mainModel = config.dataModel.find((model) => model.fdType === "main");
    const amountKey = `${mainModel.fdTableName}.fd_amount`;
    const subjectKey = `${mainModel.fdTableName}.fd_subject`;
    const amountActions = formAttr.controlAction.control[amountKey].onChange;
    const subjectActions = formAttr.controlAction.control[subjectKey].onChange;

    assert.deepEqual(amountActions.map((action) => [action.id, action.name]), [
      ["amount-change-1", "onChange_1"],
      ["amount-change-2", "onChange_2"]
    ]);
    assert.deepEqual(subjectActions.map((action) => [action.id, action.name]), [
      ["subject-change-1", "onChange_3"]
    ]);
    assert.equal(amountActions[0].function.startsWith("function onChange_1(value)"), true);
    assert.equal(amountActions[1].function.startsWith("function onChange_2(value)"), true);
    assert.equal(subjectActions[0].function.startsWith("function onChange_3(value)"), true);
    assert.deepEqual(amountActions[0].migrationRunWhen, { viewStatusIn: ["add", "edit"] });
    assert.equal(amountActions[0].function.includes("/* mk-migrate:view-status=add,edit */"), true);
    assert.deepEqual(
      Object.values(repeatedFormAttr.controlAction.control)
        .flatMap((events) => events.onChange || [])
        .map((action) => action.name),
      ["onChange_1", "onChange_2", "onChange_3"]
    );
    assert.equal(verifyTemplate(dsl, payload).ok, true);
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
    const payload = projectTemplate(dsl, baseTemplate());
    const config = JSON.parse(payload.mechanisms["sys-xform"].fdConfig);
    const formAttr = JSON.parse(config.attribute.formAttr);
    const detailModel = config.dataModel.find((model) => model.fdType === "detail" && model.dynamicProps?.detailFieldName === "fd_detail");
    const controlKey = `${detailModel.fdTableName}.fd_name`;
    const action = formAttr.controlAction.control[controlKey].onChange[0];

    assert.equal(detailModel.fdTableName.startsWith("mk_model_test_d_"), true);
    assert.equal(action.function.includes(`MKXFORM.updateControlStyle("${detailModel.fdTableName}.fd_name", rowNum`), true);
    assert.equal(action.function.includes("${table:"), false);
    assert.deepEqual(summarizeProjectedForm(payload).scripts.controlEvents, [{
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
    const payload = projectTemplate(dsl, baseTemplate());
    const config = JSON.parse(payload.mechanisms["sys-xform"].fdConfig);
    const formAttr = JSON.parse(config.attribute.formAttr);
    const detailModel = config.dataModel.find((model) =>
      model.fdType === "detail" && model.dynamicProps?.detailFieldName === "fd_detail"
    );
    const action = formAttr.controlAction.global.onLoad[0];

    assert.equal(action.function.includes(`MKXFORM.getValue("${detailModel.fdTableName}")`), true);
    assert.equal(action.function.includes("${table:"), false);
  });

  it("writes native MK formRule display and require entries through the fake client", async () => {
    const client = new FakeNewoaClient();
    const result = await executeDsl(sampleTrustedDslWithFormRules(), {
      client,
      credentials: TEST_CREDENTIALS,
      confirmWrite: true,
      targetCategoryId: "category-1"
    });

    assert.equal(result.ok, true);
    const updatePayload = client.calls.find((call) => call.name === "updateTemplate").payload;
    const config = JSON.parse(updatePayload.mechanisms["sys-xform"].fdConfig);
    const formAttr = JSON.parse(config.attribute.formAttr);
    const detailModel = config.dataModel.find((model) =>
      model.fdType === "detail" && model.dynamicProps?.detailFieldName === "fd_detail"
    );
    const displayRules = formAttr.formRule.display;
    const requireRules = formAttr.formRule.require;

    assert.equal(displayRules.length, 2);
    assert.equal(requireRules.length, 2);
    assert.deepEqual(displayRules.map((rule) => rule.result[0].displayFlag), ["display", "hide"]);
    assert.deepEqual(requireRules.map((rule) => rule.result[0].required), ["required", "non-required"]);
    for (const rule of displayRules) {
      const result = rule.result[0];
      assert.equal(result.tableType, "detail");
      assert.equal(result.type, detailModel.fdTableName);
      assert.equal(Array.isArray(result.fieldName) && result.fieldName[0], "all");
      assert.equal(result.fieldName.includes("fd_name"), true);
      assert.equal(result.fieldKey[0], null);
      assert.equal(result.label[0], "----");
    }
    assert.deepEqual([...new Set(requireRules.flatMap((rule) => rule.result.map((item) => item.fieldName)))], ["fd_detail"]);
    assert.equal(JSON.stringify(formAttr.formRule).includes("fd_detail_row"), false);
    assert.equal(result.readback.form.formRules.displayRuleCount, 2);
    assert.equal(result.readback.form.formRules.requireRuleCount, 2);
  });

  it("preserves manual form rules while replacing generated native rules", () => {
    const payload = projectTemplate(sampleTrustedDslWithFormRules(), baseTemplateWithExistingFormRules());
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

function mappedControlChangeAction(id, controlId, value, runWhen) {
  return {
    id,
    name: "onChange",
    event: "onChange",
    scope: "control",
    controlId,
    function: `function onChange(value) {\n  MKXFORM.setValue('fd_subject', '${value}')\n}`,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "AttachXFormValueChangeEventById",
      target: "control onChange",
      basis: "semantic-translation",
      reviewRequired: false
    }],
    ...(runWhen ? { runWhen } : {})
  };
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

function sampleFormulaParticipantDsl() {
  const form = sampleForm();
  form.fields.push(
    {
      id: "fd_login_name",
      title: "Login Name",
      type: "text",
      componentId: "xform-input",
      props: {},
      sourceProps: {},
      sourceRef: "source.form.control.fd_login_name"
    },
    {
      id: "fd_department_no",
      title: "Department No",
      type: "text",
      componentId: "xform-input",
      props: {},
      sourceProps: {},
      sourceRef: "source.form.control.fd_department_no"
    }
  );
  const nodes = [
    { id: "N1", type: "generalStart", element: "startEvent", name: "Start", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
    {
      id: "N2",
      type: "review",
      element: "manualTask",
      name: "Login-name Review",
      sourceRef: "source.workflow.node.N2",
      attributes: { handlerSelectType: "formula" },
      participants: {
        mode: "person_by_login_name",
        fieldId: "fd_login_name",
        fieldTitle: "Login Name",
        sourceExpression: "$组织架构.根据登录名取用户$($fd_login_name$)",
        sourceNameExpression: "$组织架构.根据登录名取用户$($Login Name$)"
      },
      translationStatus: "executable"
    },
    {
      id: "N3",
      type: "review",
      element: "manualTask",
      name: "Department-leader Review",
      sourceRef: "source.workflow.node.N3",
      attributes: { handlerSelectType: "formula" },
      participants: {
        mode: "dept_leader_by_no",
        fieldId: "fd_department_no",
        fieldTitle: "Department No",
        sourceExpression: "$部门领导.根据部门编号获取部门领导$($fd_department_no$)",
        sourceNameExpression: "$部门领导.根据部门编号获取部门领导$($Department No$)"
      },
      translationStatus: "executable"
    },
    {
      id: "N4",
      type: "review",
      element: "manualTask",
      name: "Document-creator Review",
      sourceRef: "source.workflow.node.N4",
      attributes: { handlerSelectType: "formula" },
      participants: {
        mode: "doc_creator",
        sourceExpression: "$docCreator$",
        sourceNameExpression: "$docCreator$"
      },
      translationStatus: "executable"
    },
    {
      id: "N5",
      type: "review",
      element: "manualTask",
      name: "Role-line Review",
      sourceRef: "source.workflow.node.N5",
      attributes: { handlerSelectType: "formula" },
      participants: {
        mode: "role_line",
        subjectKind: "node_handlers",
        nodeId: "N2",
        subjectExpression: "$流程.获取节点实际处理人$(\"N2\")",
        companyRole: "Company Lead",
        departmentRole: "Department Lead",
        sourceExpression: "$组织架构.解释角色线$($流程.获取节点实际处理人$(\"N2\"), \"Company Lead\", \"Department Lead\")",
        sourceNameExpression: "$组织架构.解释角色线$($流程.获取节点实际处理人$(\"N2\"), \"Company Lead\", \"Department Lead\")"
      },
      translationStatus: "executable"
    },
    { id: "N6", type: "generalEnd", element: "endEvent", name: "End", sourceRef: "source.workflow.node.N6", attributes: {}, translationStatus: "executable" }
  ];
  return sampleTrustedDsl({
    form,
    workflow: {
      process: { id: "process-formula-participants" },
      nodes,
      edges: nodes.slice(0, -1).map((node, index) => ({
        id: `L${index + 1}`,
        source: node.id,
        target: nodes[index + 1].id,
        sourceRef: `source.workflow.edge.L${index + 1}`,
        condition: { translationStatus: "executable" }
      })),
      topologicalOrder: nodes.map((node) => node.id)
    }
  });
}

function sampleInitiatorSelectWorkflow() {
  return {
    process: { id: "process-initiator-select" },
    nodes: [
      { id: "N1", type: "generalStart", element: "startEvent", name: "开始", sourceType: "startNode", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
      {
        id: "N2",
        type: "draft",
        element: "manualTask",
        name: "起草",
        sourceType: "draftNode",
        sourceRef: "source.workflow.node.N2",
        attributes: { canModifyHandlerNodeIds: "N16", mustModifyHandlerNodeIds: "N7" },
        translationStatus: "executable"
      },
      {
        id: "N16",
        type: "review",
        element: "manualTask",
        name: "发起人选择一",
        sourceType: "reviewNode",
        sourceRef: "source.workflow.node.N16",
        attributes: { ignoreOnHandlerEmpty: "false" },
        participants: { mode: "initiator_select", sourceSemantics: "draft node selects N16" },
        translationStatus: "executable"
      },
      {
        id: "N7",
        type: "review",
        element: "manualTask",
        name: "发起人选择二",
        sourceType: "reviewNode",
        sourceRef: "source.workflow.node.N7",
        attributes: { ignoreOnHandlerEmpty: "false" },
        participants: { mode: "initiator_select", sourceSemantics: "draft node selects N7" },
        translationStatus: "executable"
      },
      {
        id: "N9",
        type: "review",
        element: "manualTask",
        name: "固定审批人",
        sourceType: "reviewNode",
        sourceRef: "source.workflow.node.N9",
        attributes: { handlerIds: "route-reviewer", handlerNames: "Route Reviewer" },
        participants: {
          mode: "explicit",
          members: [{ id: "route-reviewer", name: "Route Reviewer", type: "user_or_org" }]
        },
        translationStatus: "executable"
      },
      { id: "N4", type: "generalEnd", element: "endEvent", name: "结束", sourceType: "endNode", sourceRef: "source.workflow.node.N4", attributes: {}, translationStatus: "executable" }
    ],
    edges: [
      { id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1", condition: { translationStatus: "executable" } },
      { id: "L2", source: "N2", target: "N16", sourceRef: "source.workflow.edge.L2", condition: { translationStatus: "executable" } },
      { id: "L3", source: "N16", target: "N7", sourceRef: "source.workflow.edge.L3", condition: { translationStatus: "executable" } },
      { id: "L4", source: "N7", target: "N9", sourceRef: "source.workflow.edge.L4", condition: { translationStatus: "executable" } },
      { id: "L5", source: "N9", target: "N4", sourceRef: "source.workflow.edge.L5", condition: { translationStatus: "executable" } }
    ],
    topologicalOrder: ["N1", "N2", "N16", "N7", "N9", "N4"]
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
      { id: "L544", source: "N410", target: "N412", name: "默认", sourceRef: "source.workflow.edge.L544", condition: { translationStatus: "executable" }, attributes: { priority: "24", isDefault: true } },
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
    this.savedWorkflowDraft = undefined;
    this.corruptReadback = options.corruptReadback;
    this.corruptWorkflowReadback = options.corruptWorkflowReadback;
    this.workflowDraftResult = options.workflowDraftResult ?? { fdId: "lbpm-template-id" };
    this.expectedCredentials = options.expectedCredentials;
    this.loginError = options.loginError;
    this.existingTemplate = options.existingTemplate;
  }

  async login(credentials) {
    if (this.expectedCredentials) {
      assert.deepEqual(credentials, this.expectedCredentials);
    }
    this.calls.push({ name: "login", payload: {} });
    if (this.loginError) throw this.loginError;
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
    if (this.savedTemplate) return this.savedTemplate;
    if (this.existingTemplate && this.existingTemplate.fdId === fdId) {
      return JSON.parse(JSON.stringify(this.existingTemplate));
    }
    return {
      fdId,
      fdName: "created",
      mechanisms: {
        "sys-xform": { fdId, fdName: "created", fdConfig: "{}" },
        lbpmTemplate: [{
          fdId: "lbpm-template-id",
          fdName: "created",
          fdTemplateCode: "template_created",
          fdEntityId: fdId,
          fdEntityKey: "KmReviewMain",
          fdEntityName: "com.landray.km.review.core.entity.KmReviewTemplate",
          fdMainEntityName: "com.landray.km.review.core.entity.KmReviewMain",
          fdModuleCode: "km-review",
          fdTemplateForms: [],
          fdContent: "{}"
        }]
      }
    };
  }

  async updateTemplate(payload) {
    this.calls.push({ name: "updateTemplate", payload });
    this.savedTemplate = payload;
    return { fdId: payload.fdId };
  }

  async saveWorkflowDraft(payload) {
    this.calls.push({ name: "saveWorkflowDraft", payload });
    this.savedWorkflowDraft = payload;
    return structuredClone(this.workflowDraftResult);
  }

  async getWorkflowTemplateDetail(payload) {
    this.calls.push({ name: "getWorkflowTemplateDetail", payload });
    const detail = {
      ...this.savedWorkflowDraft,
      isDraft: true,
      fdStatus: "draft"
    };
    return this.corruptWorkflowReadback ? this.corruptWorkflowReadback(detail) : detail;
  }

  async searchOrg(key) {
    this.calls.push({ name: "searchOrg", payload: { key } });
    return [];
  }

  async getElementInfo(targets) {
    this.calls.push({ name: "getElementInfo", payload: { targets } });
    return [];
  }
}
