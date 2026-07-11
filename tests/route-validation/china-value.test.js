import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

describe("chinaValue Route-validation", { concurrency: false }, () => {
  it("persists a tracked chinaValue control as an xform-input text field", async () => {
    const result = await runRouteCase("form-only-success");

    const dslField = result.dsl.form.fields.find((field) => field.id === "fd_cny_upper");
    assert.ok(dslField);
    assert.equal(dslField.title, "CNY Uppercase");
    assert.equal(dslField.type, "text");
    assert.equal(dslField.componentId, "xform-input");
    assert.equal(dslField.sourceProps.designerType, "chinaValue");
    assert.equal(dslField.sourceProps.designerValues.relatedid, "fd_amount");
    assert.equal(dslField.sourceProps.metadataId, "fd_cny_upper");

    const readbackField = result.execution.readback.form.fields.find(
      (field) => field.id === "fd_cny_upper"
    );
    assert.ok(readbackField);
    assert.equal(readbackField.title, "CNY Uppercase");
    assert.equal(readbackField.type, "text");
    assert.equal(readbackField.component, "xform-input");
    assert.equal(readbackField.required, false);
    assert.equal(result.execution.readback.ok, true);
  });
});
