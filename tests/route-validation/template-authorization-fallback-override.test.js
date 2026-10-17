import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolveWorkflowParticipants } from "../../src/executor/participant-resolver.js";
import { executeDsl } from "../../src/executor/execute.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";

const fixture = JSON.parse(readFileSync(new URL(
  "../fixtures/route-validation/template-authorization-fallback-override/identity.json",
  import.meta.url
), "utf8"));
const clone = value => structuredClone(value);
const origin = "https://oaqas.shanghai-electric.com";

function routeDsl() {
  const dsl = sampleTrustedDsl();
  dsl.template.authorization = {
    readerFlag: true, readers: [clone(fixture.source)], editors: [],
    allReaders: [clone(fixture.source)], allEditors: [], temporaryReaders: [], temporaryEditors: []
  };
  return dsl;
}

function options(extra = {}) {
  return {
    targetBaseUrl: origin,
    fallbackFdIds: { organization: fixture.fallback.fdId },
    allowTemplateAuthorizationFallback: true,
    templateAuthorizationOverrides: [{
      sourceId: fixture.source.sourceId, targetFdId: fixture.fallback.fdId
    }],
    ...extra
  };
}

class DirectoryClient extends FakeNewoaAdapter {
  constructor({ target = fixture.fallback, fail = false } = {}) {
    super("persist");
    this.target = target;
    this.fail = fail;
    this.exactCalls = [];
  }

  async getElementInfo(ids, requestOptions) {
    this.record({ operation: "get-element-info", targets: clone(ids) });
    this.exactCalls.push({ ids: clone(ids), options: clone(requestOptions) });
    if (this.fail) throw new Error("fixture directory unavailable");
    if (ids.includes(fixture.source.sourceId)) return [clone(fixture.inactiveSourceTarget)];
    return clone(Array.isArray(this.target) ? this.target : [this.target]);
  }

  async searchOrg() { throw new Error("Explicit identity resolution must not fuzzy search"); }
}

const writes = client => client.transcript().filter(item => (
  ["add", "update", "save-workflow-draft", "add-transfer-record"].includes(item.operation)
));

async function execute(client, extra = {}, dsl = routeDsl()) {
  return executeDsl(dsl, {
    ...options(), client, baseUrl: origin,
    credentials: { username: "fixture-user", encryptedPassword: "fixture-password" },
    targetCategoryId: "fixture-category", confirmWrite: true,
    now: new Date("2026-10-17T00:00:00Z"),
    transferRecordIdFactory: () => "fixture-explicit-fallback-record",
    ...extra
  });
}

describe("template authorization configured fallback override Route-validation", { concurrency: false }, () => {
  it("applies an explicit typed configured fallback and retains the original source evidence", async () => {
    const dsl = routeDsl();
    const before = clone(dsl);
    const client = new DirectoryClient();
    const result = await resolveWorkflowParticipants(dsl, { ...options(), client });
    assert.deepEqual(dsl, before);
    assert.equal(result.templateAuthorizationOverrideCount, 2);
    assert.equal(result.templateAuthorizationOverrideIdentityCount, 1);
    const audit = result.templateAuthorizationOverrides[0];
    assert.equal(audit.sourceEvidence.sourceId, fixture.source.sourceId);
    assert.equal(audit.sourceEvidence.name, fixture.source.name);
    assert.equal(audit.sourceEvidence.sourceOrgType, 2);
    assert.equal(audit.confirmedFallbackOverride, true);
    assert.equal(audit.target.fdId, fixture.fallback.fdId);
    assert.equal(audit.target.fdName, fixture.fallback.fdName);
    assert.equal(audit.target.fdIsAvailable, true);
    assert.equal(result.dsl.template.authorization.readers[0].id, fixture.fallback.fdId);
    assert.deepEqual(client.exactCalls, [{
      ids: [fixture.fallback.fdId], options: { departmentEvidence: true }
    }]);
  });

  it("completes native fake readback and one transfer record with an explicit fallback audit", async () => withNetworkGuard(async () => {
    const client = new DirectoryClient();
    const result = await execute(client);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.readback.ok, true);
    assert.equal(result.readback.status, "verified");
    assert.equal(result.transferRecord.status, "recorded");
    assert.equal(writes(client).filter(item => item.operation === "add-transfer-record").length, 1);
    const audit = result.apiStages.find(item => item.name === "resolveWorkflowParticipants")
      .templateAuthorizationOverrides[0];
    assert.equal(audit.confirmedFallbackOverride, true);
    assert.equal(audit.sourceEvidence.name, fixture.source.name);
    assert.equal(audit.target.fdIsAvailable, true);
    assert.deepEqual(result.readback.workflow.templateAuthorization.readers, [fixture.fallback.fdId]);
  }));

  for (const [name, extra, target, reason] of [
    ["disabled permission fallback", { allowTemplateAuthorizationFallback: false }, fixture.fallback, "template_authorization_override_target_name_mismatch"],
    ["unconfigured fallback target", { fallbackFdIds: { organization: "fixture-other-fallback" } }, fixture.fallback, "template_authorization_override_target_name_mismatch"],
    ["forbidden fallback origin", { baseUrl: "https://production.example.com" }, fixture.fallback, "template_authorization_override_target_name_mismatch"],
    ["wrong target type", {}, { ...fixture.fallback, fdOrgType: 8 }, "template_authorization_override_target_type_mismatch"],
    ["disabled target", {}, { ...fixture.fallback, fdIsAvailable: false }, "template_authorization_override_target_unavailable"],
    ["missing target availability", {}, { ...fixture.fallback, fdIsAvailable: undefined }, "template_authorization_override_target_unavailable"],
    ["string target availability", {}, { ...fixture.fallback, fdIsAvailable: "true" }, "template_authorization_override_target_unavailable"],
    ["duplicate exact target IDs", {}, [fixture.fallback, fixture.fallback], "template_authorization_override_target_ambiguous"],
    ["wrong target ID", {}, { ...fixture.fallback, fdId: "fixture-other-target" }, "template_authorization_override_target_not_found"]
  ]) {
    it(`blocks ${name} before initialization or writes`, async () => withNetworkGuard(async () => {
      const client = new DirectoryClient({ target });
      const result = await execute(client, extra);
      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some(item => item.details?.issues?.some(issue => issue.reason === reason)), JSON.stringify(result.diagnostics));
      assert.equal(client.transcript().some(item => item.operation === "init"), false);
      assert.deepEqual(writes(client), []);
    }));
  }

  it("keeps an inactive exact source department blocked when no override is provided", async () => withNetworkGuard(async () => {
    const client = new DirectoryClient();
    const result = await execute(client, { templateAuthorizationOverrides: [] });
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(item => item.details?.issues?.some(issue => issue.reason === "source_department_id_unavailable")));
    assert.deepEqual(writes(client), []);
  }));

  it("does not hide an explicit target lookup failure behind automatic fallback", async () => withNetworkGuard(async () => {
    const client = new DirectoryClient({ fail: true });
    const result = await execute(client);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(item => item.details?.issues?.some(issue => issue.reason === "template_authorization_override_target_validation_failed")));
    assert.deepEqual(writes(client), []);
  }));

  it("rejects an override that ambiguously refers to distinct source identities", async () => withNetworkGuard(async () => {
    const dsl = routeDsl();
    dsl.template.authorization.readers.push({ ...fixture.source, name: "Conflicting Source Name" });
    const client = new DirectoryClient();
    const result = await execute(client, {}, dsl);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(item => item.details?.issues?.some(issue => issue.reason === "template_authorization_override_source_ambiguous")));
    assert.deepEqual(writes(client), []);
  }));
});
