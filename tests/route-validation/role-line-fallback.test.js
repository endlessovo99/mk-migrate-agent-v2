import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { executeDsl } from "../../src/executor/execute.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { runRouteCase } from "./run-route-case.js";

const contract = JSON.parse(readFileSync(
  new URL("../fixtures/route-validation/role-line-fallback/contract.json", import.meta.url), "utf8"
));

describe("configured role-line fallback route", { concurrency: false }, () => {
  it("persists a validated role fallback without changing the trusted source identity", async () => {
    const { dsl } = await runRouteCase(contract.sourceCase);
    const original = structuredClone(dsl);
    const client = new MissingRoleAdapter();
    const result = await execute(dsl, client);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.readback.ok, true);
    assert.equal(result.transferRecord.status, "recorded");
    assert.ok(JSON.stringify(client.workflowDraft).includes(contract.fallback.fdId));
    assert.ok(result.diagnostics.some((item) => item.code === "workflow.participant_sit_fallback_applied"));
    assert.deepEqual(dsl, original);
  });

  for (const name of ["", "   "]) {
    it(`blocks a missing source role name before any template write: ${JSON.stringify(name)}`, async () => {
      const { dsl } = await runRouteCase(contract.sourceCase);
      const role = dsl.workflow.nodes.flatMap((node) => node.participants?.members || [])
        .find((member) => String(member.sourceOrgType) === "32");
      assert.ok(role);
      role.name = name;
      const client = new MissingRoleAdapter();
      const result = await execute(dsl, client);
      assertBlocked(result, client);
      assert.ok(JSON.stringify(result.diagnostics).includes("missing_source_evidence"));
    });
  }

  for (const scenario of ["unconfigured", "wrong-type", "unregistered-origin"]) {
    it(`blocks an invalid fallback before any template write: ${scenario}`, async () => {
      const { dsl } = await runRouteCase(contract.sourceCase);
      const client = new MissingRoleAdapter(scenario === "wrong-type" ? 16 : 32);
      const options = scenario === "unconfigured" ? { fallbackFdIds: {} }
        : scenario === "unregistered-origin" ? { baseUrl: "https://example.com" } : {};
      assertBlocked(await execute(dsl, client, options), client);
    });
  }
});

class MissingRoleAdapter extends FakeNewoaAdapter {
  constructor(orgType = 32) { super("persist"); this.orgType = orgType; }
  async searchOrg(key) { this.record({ operation: "search-org", key }); return []; }
  async getElementInfo(targets) {
    this.record({ operation: "get-element-info", targets });
    return targets.filter((id) => id === contract.fallback.fdId)
      .map(() => ({ ...contract.fallback, fdOrgType: this.orgType }));
  }
}

function execute(dsl, client, options = {}) {
  return executeDsl(dsl, {
    client,
    credentials: { username: "route-test-user", encryptedPassword: "route-test-encrypted-password" },
    confirmWrite: true,
    targetCategoryId: "route-category-id",
    baseUrl: contract.baseUrl,
    fallbackFdIds: { role: contract.fallback.fdId },
    ...options
  });
}

function assertBlocked(result, client) {
  assert.equal(result.ok, false);
  assert.equal(result.remoteWriteAttempted, false);
  assert.equal(client.entries.some((entry) => ["add", "update", "save-workflow-draft", "add-transfer-record"].includes(entry.operation)), false);
}
