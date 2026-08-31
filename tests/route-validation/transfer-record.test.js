import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

const EXPECTED_RECORD_ID = "route0000000000000000000000000000000";
const EXPECTED_TARGET_TEMPLATE_ID = "route-created-template";
const EXPECTED_CREATE_TIME = 1783641600000;

describe("transfer-record Route-validation", { concurrency: false }, () => {
  it("records the form-only source template identity after verified migration", async () => {
    const result = await runRouteCase("form-only-success");
    const transferRecord = result.transcript.at(-1);

    assert.deepEqual(transferRecord, {
      operation: "add-transfer-record",
      recordId: EXPECTED_RECORD_ID,
      sourceTemplateId: "route-form-only-template",
      targetTemplateId: EXPECTED_TARGET_TEMPLATE_ID,
      templateName: "原流程模板",
      createTime: EXPECTED_CREATE_TIME
    });
  });

  it("records the paired workflow template id instead of the source-directory name", async () => {
    const result = await runRouteCase("paired-success");
    const transferRecord = result.transcript.at(-1);

    assert.equal(result.dsl.derivedFrom.sourceId, "paired");
    assert.deepEqual(transferRecord, {
      operation: "add-transfer-record",
      recordId: EXPECTED_RECORD_ID,
      sourceTemplateId: "route-paired-template",
      targetTemplateId: EXPECTED_TARGET_TEMPLATE_ID,
      templateName: "Route Paired Form",
      createTime: EXPECTED_CREATE_TIME
    });
  });
});
