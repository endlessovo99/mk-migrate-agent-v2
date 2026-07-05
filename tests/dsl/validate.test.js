import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateMigrationDsl } from "../../src/dsl/schema.js";

describe("validateMigrationDsl", () => {
  it("accepts the sample DSL", () => {
    const result = validateMigrationDsl({
      version: "2.0-draft",
      template: { name: "MK_TEST_V2_SAMPLE" },
      form: {
        fields: [
          { id: "fd_subject", title: "主题", type: "text", required: true },
          {
            id: "fd_detail",
            title: "明细",
            type: "detailTable",
            columns: [{ id: "fd_name", title: "名称", type: "text" }]
          }
        ]
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
        fields: [{ id: "fd_subject", title: "主题", type: "text" }]
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.template.name_required"), true);
  });
});
