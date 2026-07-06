import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { sampleDraftDsl, sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("buildDryRunPlan", () => {
  it("builds a route-validation plan from trusted migration DSL without external writes", () => {
    const plan = buildDryRunPlan(sampleTrustedDsl());

    assert.equal(plan.ok, true);
    assert.equal(plan.status, "passed");
    assert.deepEqual(plan.steps.map((step) => step.id), [
      "check-execute",
      "resolve-template",
      "map-form-layout",
      "map-workflow",
      "save-template-draft",
      "readback"
    ]);
    assert.equal(plan.steps.every((step) => step.status === "ok" || step.status === "planned"), true);
    assert.equal(plan.steps.find((step) => step.id === "map-form-layout")?.layoutRows, 2);
  });

  it("rejects dsl-draft before planning execution", () => {
    const plan = buildDryRunPlan(sampleDraftDsl());

    assert.equal(plan.ok, false);
    assert.equal(plan.status, "invalid");
    assert.equal(plan.diagnostics.some((item) => item.code === "dsl.trust.trusted_required"), true);
    assert.equal(plan.steps.find((step) => step.id === "resolve-template")?.status, "blocked");
  });
});
