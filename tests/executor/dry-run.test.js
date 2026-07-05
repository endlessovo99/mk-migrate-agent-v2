import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkForFieldType } from "../../src/dsl/mk-components.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";

describe("buildDryRunPlan", () => {
  it("builds a route-validation plan without external writes", () => {
    const plan = buildDryRunPlan({
      version: "2.0-draft",
      template: { name: "MK_TEST_V2_SAMPLE" },
      form: {
        fields: [{ id: "fd_subject", title: "主题", type: "text", mk: mkForFieldType("text") }],
        layout: {
          source: "fdDesignerHtml",
          rows: [
            { id: "row-0", cells: [{ id: "row-0-cell-0", fieldId: "fd_subject", column: 0, colspan: 1 }] }
          ]
        }
      }
    });

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
    assert.equal(plan.steps.find((step) => step.id === "map-fields")?.layoutRows, 1);
  });
});
