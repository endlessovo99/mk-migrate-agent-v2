import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { translateNewSource } from "../../src/translator/new-source-adapter.js";

describe("translateNewSource", () => {
  it("translates the bootstrap sample into valid DSL", () => {
    const source = JSON.parse(readFileSync("tests/fixtures/new-source.sample.json", "utf8"));
    const dsl = translateNewSource(source, {
      sourcePath: "tests/fixtures/new-source.sample.json"
    });
    const validation = validateMigrationDsl(dsl);

    assert.equal(dsl.template.name, "MK_TEST_V2_SAMPLE");
    assert.equal(dsl.form.fields.length, 3);
    assert.equal(dsl.form.fields[2].type, "singleSelect");
    assert.equal(validation.ok, true);
  });
});
