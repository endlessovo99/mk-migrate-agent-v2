import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { executeDsl } from "../../src/executor/execute.js";
import { NEWOA_SIT_BASE_URL } from "../../src/executor/newoa-client.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { runRouteCase } from "./run-route-case.js";

const expected = JSON.parse(readFileSync(
  new URL("../fixtures/route-validation/template-number-rule/expected-number-rule.json", import.meta.url),
  "utf8"
));

describe("template number rule Route case", { concurrency: false }, () => {
  it("uses the workflow-management number rule for every template save and verifies readback", async () => {
    const { dsl } = await runRouteCase("form-only-success");
    const adapter = new NumberRuleRecordingAdapter();
    const execution = await executeWithAdapter(dsl, adapter);
    const expectedRuleId = expected.fdSysNumber.fdId;

    assert.deepEqual(adapter.addedNumberRule, expected);
    assert.deepEqual(adapter.updatedNumberRule, expected);
    assert.deepEqual(execution.readback.numberRule, {
      contractVersion: 1,
      status: "verified",
      fdId: expectedRuleId,
      fdName: expected.fdSysNumber.fdName,
      fdType: expected.fdType,
      fdEntityKey: expected.fdEntityKey
    });
  });

  it("fails readback when NewOA drops the required number rule", async () => {
    const { dsl } = await runRouteCase("form-only-success");
    const adapter = new NumberRuleLosingAdapter();
    const result = await executeWithAdapter(dsl, adapter);

    assert.equal(result.ok, false);
    assert.equal(result.status, "readback_failed");
    assert.equal(result.stage, "readback");
    assert.equal(
      result.diagnostics.some((diagnostic) =>
        diagnostic.code === "readback.number_rule.mismatch"
      ),
      true
    );
  });
});

class NumberRuleRecordingAdapter extends FakeNewoaAdapter {
  constructor() {
    super("persist");
  }

  async addTemplate(payload) {
    this.addedNumberRule = structuredClone(payload.mechanisms.sysnumber[0]);
    return super.addTemplate(payload);
  }

  async updateTemplate(payload) {
    this.updatedNumberRule = structuredClone(payload.mechanisms.sysnumber[0]);
    return super.updateTemplate(payload);
  }
}

class NumberRuleLosingAdapter extends FakeNewoaAdapter {
  constructor() {
    super("persist");
  }

  async getTemplate(templateId) {
    const template = await super.getTemplate(templateId);
    if (this.updated) delete template.mechanisms.sysnumber;
    return template;
  }
}

function executeWithAdapter(dsl, client) {
  return executeDsl(dsl, {
    client,
    credentials: {
      username: "route-test-user",
      encryptedPassword: "route-test-encrypted-password"
    },
    confirmWrite: true,
    targetCategoryId: "route-category-id",
    baseUrl: NEWOA_SIT_BASE_URL,
    now: new Date("2026-07-10T00:00:00.000Z")
  });
}
