import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDsl } from "../../src/executor/execute.js";
import { applyFormPayload, summarizeFormFromTemplate } from "../../src/executor/form-payload.js";
import { buildWorkflowContent } from "../../src/executor/workflow-payload.js";
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

  it("uses textarea height and max length only from executable props, not sourceProps", () => {
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

    assert.equal(withProps.height, 80);
    assert.equal(withProps.maxLength, 512);
    assert.equal(withPropsField.fdLength, 512);
    assert.equal(Object.hasOwn(sourceOnly, "height"), false);
    assert.equal(Object.hasOwn(sourceOnly, "maxLength"), false);
    assert.equal(Object.hasOwn(sourceOnlyField, "fdLength"), false);
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
          function: "function onLoad(context) {\n  var value = MKXFORM.getValue('fd_subject')\n}",
          translationStatus: "mapped",
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
    assert.equal(formAttr.controlAction.javascript.includes("function onLoad(context)"), true);
    assert.equal(config.migrationDsl.scripts.actionCount, 1);
    assert.deepEqual(summarizeFormFromTemplate(payload).scripts.events, ["onLoad"]);
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

function fieldControlProps(fields, fieldName) {
  return JSON.parse(fields.find((field) => field.fdName === fieldName).fdAttribute).config.controlProps;
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
