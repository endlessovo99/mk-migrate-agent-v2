import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkForFieldType } from "../../src/dsl/mk-components.js";
import { validateMigrationDsl } from "../../src/dsl/schema.js";

describe("validateMigrationDsl", () => {
  it("accepts the sample DSL", () => {
    const result = validateMigrationDsl({
      version: "2.0-draft",
      template: { name: "MK_TEST_V2_SAMPLE" },
      form: {
        fields: [
          { id: "fd_subject", title: "主题", type: "text", required: true, mk: mkForFieldType("text") },
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
            { id: "row-0", cells: [{ id: "row-0-cell-0", fieldId: "fd_subject", column: 0, colspan: 1 }] },
            { id: "row-1", cells: [{ id: "row-1-cell-0", fieldId: "fd_detail", column: 0, colspan: 1 }] }
          ]
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.diagnostics, []);
  });

  it("rejects missing template names", () => {
    const result = validateMigrationDsl({
      version: "2.0-draft",
      template: {},
      form: {
        fields: [{ id: "fd_subject", title: "主题", type: "text", mk: mkForFieldType("text") }]
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.template.name_required"), true);
  });

  it("rejects DSL with review errors", () => {
    const result = validateMigrationDsl({
      version: "2.0-draft",
      template: { name: "含未知函数表单" },
      form: {
        fields: [{ id: "fd_subject", title: "主题", type: "text", mk: mkForFieldType("text") }]
      },
      review: {
        errors: [{
          code: "source.function_not_whitelisted",
          message: "Source function UnknownLegacyFunction is not in the translation whitelist.",
          path: "/fdDesignerHtml"
        }]
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.diagnostics.some((item) => item.code === "source.function_not_whitelisted"), true);
  });

  it("rejects fields without MK component metadata", () => {
    const result = validateMigrationDsl({
      version: "2.0-draft",
      template: { name: "缺 MK 组件字段" },
      form: {
        fields: [{ id: "fd_subject", title: "主题", type: "text" }]
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.field.mk_required"), true);
  });

  it("rejects mismatched MK component metadata", () => {
    const result = validateMigrationDsl({
      version: "2.0-draft",
      template: { name: "错误 MK 组件字段" },
      form: {
        fields: [{
          id: "fd_subject",
          title: "主题",
          type: "text",
          mk: {
            component: "xform-input",
            group: "basic",
            itemTid: "wrong",
            sourceComponent: "@elem/xform-input"
          }
        }]
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.field.mk.item_tid_mismatch"), true);
  });

  it("rejects layout cells that reference missing fields", () => {
    const result = validateMigrationDsl({
      version: "2.0-draft",
      template: { name: "布局引用错误" },
      form: {
        fields: [{ id: "fd_subject", title: "主题", type: "text", mk: mkForFieldType("text") }],
        layout: {
          source: "fdDesignerHtml",
          rows: [
            { id: "row-0", cells: [{ id: "row-0-cell-0", fieldId: "fd_missing", column: 0, colspan: 1 }] }
          ]
        }
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.form.layout.field_missing"), true);
  });
});
