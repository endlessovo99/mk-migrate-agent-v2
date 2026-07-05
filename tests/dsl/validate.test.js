import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateMigrationDsl } from "../../src/dsl/schema.js";

describe("validateMigrationDsl", () => {
  it("accepts the sample DSL", () => {
    const dsl = JSON.parse(readFileSync("tests/fixtures/migration-dsl.sample.json", "utf8"));
    const result = validateMigrationDsl(dsl);

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
