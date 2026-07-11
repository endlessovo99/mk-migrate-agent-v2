import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

describe("Route-validation template naming", { concurrency: false }, () => {
  it("preserves an explicit source name through the created test template", async () => {
    const result = await runRouteCase("form-only-success");

    assert.equal(result.dsl.template.name, "原流程模板");
    assert.equal(result.dryRun.template.name, "原流程模板");
    assert.equal(
      result.transcript.find((entry) => entry.operation === "add").templateName,
      "MK_TEST_原流程模板_20260710000000"
    );
  });
});
