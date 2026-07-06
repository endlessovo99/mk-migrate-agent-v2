import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkForFieldType } from "../../src/dsl/mk-components.js";
import { executeDsl } from "../../src/executor/execute.js";
import { applyFormPayload } from "../../src/executor/form-payload.js";

describe("executeDsl", () => {
  it("writes one draft template through an injected NewOA client and verifies readback", async () => {
    const dsl = sampleDsl();
    const client = new FakeNewoaClient();
    const result = await withNewoaEnv(() => executeDsl(dsl, {
      client,
      confirmWrite: true,
      targetCategoryId: "category-1",
      now: new Date("2026-07-05T01:02:03.000Z")
    }));

    assert.equal(result.ok, true);
    assert.equal(result.status, "written");
    assert.equal(result.templateId, "created-template-id");
    assert.deepEqual(result.apiStages.map((stage) => stage.name), [
      "login",
      "init",
      "generateTableName",
      "loadParentCategory",
      "add",
      "get",
      "update",
      "readback"
    ]);
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
    assert.equal(addPayload.mechanisms.lbpmTemplate[0].fdCategory, undefined);
    assert.equal(addPayload.mechanisms.lbpmTemplate[0].fdFormCategory.fdFormCategoryId, "category-1");
    assert.equal(addPayload.mechanisms.lbpmTemplate[0].fdTemplateForms[0].fdModuleCode, "km-review");

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
    assert.equal(firstLayout.type, "layout");
    assert.equal(firstLayout.controlProps.migrationLayoutType, "@elem/xform-flex-1-2-layout");
    assert.equal(firstLayout.children[0].type, "@elem/layout-grid");
    assert.equal(firstLayout.children[0].controlProps.columns, 2);
    assert.equal(firstLayout.children[0].children[0].type, "@elem/layout-grid.GridItem");

    const flowContent = JSON.parse(updatePayload.mechanisms.lbpmTemplate[0].fdContent);
    assert.equal(flowContent.elements.filter((element) => element.type !== "sequenceFlow").length, 2);
    assert.equal(flowContent.elements.filter((element) => element.type === "sequenceFlow").length, 1);
    assert.equal(flowContent.elements.find((element) => element.id === "N1").type, "generalStart");
    assert.equal(flowContent.elements.find((element) => element.id === "N2").type, "generalEnd");
    assert.equal(flowContent.elements.find((element) => element.id === "L1").sourceRef, "N1");
    assert.equal(flowContent.elements.find((element) => element.id === "L1").targetRef, "N2");
    assert.equal(result.readback.form.fieldCount, 3);
    assert.equal(result.readback.workflow.nodeCount, 2);
    assert.equal(result.readback.workflow.edgeCount, 1);
    assert.equal(result.readback.workflow.invalidEdgeCount, 0);
  });

  it("fails readback when persisted designer structure loses layout cells", async () => {
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

    const result = await withNewoaEnv(() => executeDsl(sampleDsl(), {
      client,
      confirmWrite: true,
      targetCategoryId: "category-1",
      now: new Date("2026-07-05T01:02:03.000Z")
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, "readback_failed");
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

    const result = await withNewoaEnv(() => executeDsl(sampleDsl(), {
      client,
      confirmWrite: true,
      targetCategoryId: "category-1",
      now: new Date("2026-07-05T01:02:03.000Z")
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, "readback_failed");
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "readback.workflow.invalidEdgeCount_mismatch"), true);
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "readback.workflow.edge_endpoint_mismatch"), true);
  });

  it("reports warnings when unknown workflow nodes are mapped conservatively", async () => {
    const dsl = sampleDsl();
    dsl.workflow.nodes[1].type = "unexpectedNode";
    const result = await withNewoaEnv(() => executeDsl(dsl, {
      client: new FakeNewoaClient(),
      confirmWrite: true,
      targetCategoryId: "category-1",
      now: new Date("2026-07-05T01:02:03.000Z")
    }));

    assert.equal(result.templateId, "created-template-id");
    assert.equal(result.status, "written_with_warnings");
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "workflow.node_type_mapped_to_review"), true);
  });

  it("allows warning-only DSL execution and reports written_with_warnings", async () => {
    const dsl = {
      ...sampleDsl(),
      review: {
        warnings: [{ code: "source.sysform.metadata_missing", message: "metadata missing", path: "/fdMetadataXml" }]
      }
    };
    const result = await withNewoaEnv(() => executeDsl(dsl, {
      client: new FakeNewoaClient(),
      confirmWrite: true,
      targetCategoryId: "category-1",
      now: new Date("2026-07-05T01:02:03.000Z")
    }));

    assert.equal(result.ok, true);
    assert.equal(result.status, "written_with_warnings");
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "source.sysform.metadata_missing"), true);
  });

  it("blocks before login when write safety inputs are missing", async () => {
    const client = new FakeNewoaClient();
    const result = await executeDsl(sampleDsl(), {
      client,
      confirmWrite: true,
      targetCategoryId: "category-1"
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.diagnostics[0].code, "safety.username_required");
    assert.deepEqual(client.calls, []);
  });

  it("uses textarea height and max length only when the DSL explicitly carries them", () => {
    const payload = applyFormPayload(baseTemplate(), {
      form: {
        fields: [
          {
            id: "fd_with_height",
            title: "带高度和最大长度",
            type: "longText",
            mk: mkForFieldType("longText"),
            source: {
              designerValues: { height: "80", maxlength: "512" }
            }
          },
          {
            id: "fd_without_height",
            title: "无高度和最大长度",
            type: "longText",
            mk: mkForFieldType("longText"),
            source: {
              designerValues: { maxlength: "" },
              metadataAttributes: { length: "" }
            }
          },
          {
            id: "fd_zero_length",
            title: "最大长度为零",
            type: "longText",
            mk: mkForFieldType("longText"),
            maxLength: 0
          }
        ],
        layout: {
          rows: [
            { id: "row-0", cells: [{ id: "cell-0", fieldId: "fd_with_height", column: 0, colspan: 1 }] },
            { id: "row-1", cells: [{ id: "cell-1", fieldId: "fd_without_height", column: 0, colspan: 1 }] },
            { id: "row-2", cells: [{ id: "cell-2", fieldId: "fd_zero_length", column: 0, colspan: 1 }] }
          ]
        }
      }
    });
    const fields = JSON.parse(payload.mechanisms["sys-xform"].fdConfig)
      .dataModel.find((model) => model.fdType === "main").fdFields;
    const withHeight = fieldControlProps(fields, "fd_with_height");
    const withoutHeight = fieldControlProps(fields, "fd_without_height");
    const zeroLength = fieldControlProps(fields, "fd_zero_length");
    const withHeightField = fields.find((field) => field.fdName === "fd_with_height");
    const withoutHeightField = fields.find((field) => field.fdName === "fd_without_height");
    const zeroLengthField = fields.find((field) => field.fdName === "fd_zero_length");

    assert.equal(withHeight.height, 80);
    assert.equal(withHeight.maxLength, 512);
    assert.equal(withHeightField.fdLength, 512);
    assert.equal(Object.hasOwn(withoutHeight, "height"), false);
    assert.equal(Object.hasOwn(withoutHeight, "maxLength"), false);
    assert.equal(Object.hasOwn(withoutHeightField, "fdLength"), false);
    assert.equal(Object.hasOwn(zeroLength, "maxLength"), false);
    assert.equal(Object.hasOwn(zeroLengthField, "fdLength"), false);
  });
});

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

function sampleDsl() {
  return {
    version: "2.0-draft",
    template: { name: "示例流程" },
    form: {
      fields: [
        { id: "fd_subject", title: "主题", type: "text", required: true, mk: mkForFieldType("text") },
        { id: "fd_amount", title: "金额", type: "text", required: false, mk: mkForFieldType("text") },
        {
          id: "fd_detail",
          title: "明细",
          type: "detailTable",
          mk: mkForFieldType("detailTable"),
          columns: [{ id: "fd_name", title: "名称", type: "text", mk: mkForFieldType("text") }]
        }
      ],
      layout: {
        source: "fdDesignerHtml",
        rows: [
          {
            id: "row-0",
            cells: [
              { id: "row-0-cell-0", fieldId: "fd_subject", column: 0, colspan: 1 },
              { id: "row-0-cell-1", fieldId: "fd_amount", column: 1, colspan: 1 }
            ]
          },
          { id: "row-1", cells: [{ id: "row-1-cell-0", fieldId: "fd_detail", column: 0, colspan: 1 }] }
        ]
      }
    },
    workflow: {
      process: { id: "process-1" },
      nodes: [
        { id: "N1", type: "startNode", name: "开始", attributes: {} },
        { id: "N2", type: "endNode", name: "结束", attributes: {} }
      ],
      edges: [
        { id: "L1", source: "N1", target: "N2", name: "", condition: "", attributes: {} }
      ],
      topologicalOrder: ["N1", "N2"]
    }
  };
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
