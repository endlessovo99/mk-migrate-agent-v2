import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

describe("workflow data-authority Route case", () => {
  it("persists normalized data authority through native NewOA readback", async () => {
    const result = await runRouteCase("workflow-data-authority-success");
    const dslNode = result.dsl.workflow.nodes.find((node) => node.id === "N2");
    const nativeNode = result.execution.readback.workflow.nodes.find((node) => node.id === "N2");

    assert.deepEqual(
      Object.keys(dslNode.dataAuthority.fields).sort(),
      ["exactField", "httpCode", "resultCaption"]
    );
    assert.deepEqual(nativeNode.dataAuthority, {
      enabled: true,
      fields: {
        resultCaption: { visible: false, editable: false, required: false },
        httpCode: { visible: false, editable: false, required: false },
        exactField: { visible: false, editable: false, required: false }
      }
    });
    assert.equal(result.execution.readback.partitions.workflow, "verified");
    assert.equal(
      result.review.diagnostics.some((diagnostic) => diagnostic.code === "source.form_right.node_missing"),
      true
    );
    assert.equal(
      result.review.diagnostics.some((diagnostic) => diagnostic.code === "source.form_right.fields_unresolved"),
      true
    );
  });
});
