import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const sourcePath = "tests/fixtures/source4/171c8749ebd216a1fb60d0f4fec80df4";

describe("Source4 conditional multi-select Route case", () => {
  it("normalizes static membership routes for a condition-parallel split", () => {
    const sourceDraft = cleanSourceFile(sourcePath);
    const dsl = draftSourceDraft(sourceDraft);
    const routes = dsl.workflow.edges.filter((edge) => edge.source === "N4");

    assert.equal(routes.length, 3);
    assert.deepEqual(
      routes.map((edge) => edge.condition.targetText),
      ["采购", "维修", "报废"].map((value) =>
        `$列表.包含$($fd_386ca65b7e25f6$, ${JSON.stringify(value)})`
      )
    );
    assert.equal(routes.every((edge) => (
      edge.condition.critical === true &&
      edge.condition.translationStatus === "executable"
    )), true);
    assert.equal(
      validateMigrationDsl(dsl, { mode: "draft" }).ok,
      true
    );
  });
});
