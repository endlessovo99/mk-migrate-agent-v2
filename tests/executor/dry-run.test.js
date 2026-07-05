import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";

describe("buildDryRunPlan", () => {
  it("builds a route-validation plan without external writes", () => {
    const dsl = JSON.parse(readFileSync("tests/fixtures/migration-dsl.sample.json", "utf8"));
    const plan = buildDryRunPlan(dsl);

    assert.equal(plan.ok, true);
    assert.equal(plan.status, "ok");
    assert.deepEqual(plan.steps.map((step) => step.id), [
      "validate-dsl",
      "resolve-template",
      "map-fields",
      "save-template-draft",
      "readback"
    ]);
    assert.equal(plan.steps.every((step) => step.status === "ok" || step.status === "planned"), true);
  });
});
