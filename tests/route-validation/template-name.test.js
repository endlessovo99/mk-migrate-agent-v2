import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile } from "../../src/translator/source-draft.js";
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

  it("uses KmReviewTemplate fdName when the paired source directory provides it", async () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/route-validation/kmreview-named");
    const result = await runRouteCase("kmreview-named-success");

    assert.equal(sourceDraft.template.name, "企业经营事项（其他类）审批流程");
    assert.equal(result.dsl.template.name, "企业经营事项（其他类）审批流程");
    assert.equal(result.dryRun.template.name, "企业经营事项（其他类）审批流程");
    assert.equal(
      result.transcript.find((entry) => entry.operation === "add").templateName,
      "MK_TEST_企业经营事项（其他类）审批流程_20260710000000"
    );
  });
});
