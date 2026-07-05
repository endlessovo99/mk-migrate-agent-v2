import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { loadFunctionWhitelist } from "../../src/translator/function-whitelist.js";
import { translateSourceFile } from "../../src/translator/index.js";

describe("translateSourceFile", () => {
  it("translates a paired SysFormTemplate and LbpmProcessDefinition directory", () => {
    const dsl = translateSourceFile("tests/fixtures/source/route-validation-lbpm", {
      functionWhitelist: loadFunctionWhitelist("tests/fixtures/function-whitelist.json")
    });
    const validation = validateMigrationDsl(dsl);
    const plan = buildDryRunPlan(dsl);

    assert.equal(dsl.source.kind, "km-review-template-source-directory");
    assert.equal(dsl.source.sysFormTemplate.fdModelId, "route-validation-template-id");
    assert.equal(dsl.source.lbpmProcessDefinition.templateId, "route-validation-template-id");
    assert.equal(dsl.workflow.nodes.length, 4);
    assert.equal(dsl.workflow.edges.length, 3);
    assert.deepEqual(dsl.workflow.topologicalOrder, ["N1", "N2", "N3", "N4"]);
    assert.equal(dsl.review.functionWhitelist.violations.length, 0);
    assert.equal(validation.ok, true);
    assert.equal(plan.steps.find((step) => step.id === "map-workflow")?.nodes, 4);
    assert.equal(plan.steps.find((step) => step.id === "map-workflow")?.edges, 3);
  });
});
