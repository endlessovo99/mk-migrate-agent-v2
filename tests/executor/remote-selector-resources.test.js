import assert from "node:assert/strict";
import { it } from "node:test";
import { ticConnectionSemanticDigest, ticInterfaceSemanticDigest, verifyRemoteSelectorResources } from "../../src/executor/remote-selector-resources.js";
import { remoteSelectorFixture } from "../fixtures/executor/remote-selector-resources.js";
import { withNetworkGuard } from "../route-validation/network-guard.js";

const verify = fixture => verifyRemoteSelectorResources(fixture.dsl, { client: fixture.client, baseUrl: fixture.decision.scopeOrigin });
const resealInterface = fixture => { fixture.decision.server.semanticDigest = ticInterfaceSemanticDigest(fixture.nativeInterface); };
const resealConnection = fixture => { fixture.decision.server.connectionSemanticDigest = ticConnectionSemanticDigest(fixture.connection); };

it("validates authenticated metadata, native typed schema and active exact caller ACL without executing an upstream interface", async () => withNetworkGuard(async () => {
  const fixture = remoteSelectorFixture({ inputs: ["project"] });
  const result = await verify(fixture);
  assert.equal(result.ok, true);
  assert.deepEqual(fixture.calls, [
    { method: "getTicInterface", fdId: "fixture_lookup" }, { method: "getTicConnection", fdId: "fixture_connection" },
    { method: "getElementInfo", ids: ["fixture_caller"], options: { departmentEvidence: true } }
  ]);
  assert.deepEqual(result.resources, [{ fdId: fixture.decision.server.fdId, code: fixture.decision.server.code, semanticDigest: fixture.decision.server.semanticDigest,
    connectionId: fixture.connection.fdId, connectionSemanticDigest: fixture.decision.server.connectionSemanticDigest, callerIds: ["fixture_caller"] }]);
  for (const secret of ["synthetic-private-server-secret", "synthetic-source-secret", "upstream.example.invalid", "fdRequestUrl", "protocolData"]) assert.equal(JSON.stringify(result).includes(secret), false);
}));

it("does not require a metadata client or make calls when no remote selector is selected", async () => {
  for (const dsl of [{}, { migrationPolicies: { decisions: [{ kind: "other-approved-kind" }] } }]) {
    assert.deepEqual(await verifyRemoteSelectorResources(dsl), { ok: true, resources: [], diagnostics: [] });
  }
});

it("accepts native load without derived fdOutParam, checks a returned matching save schema and rejects a conflicting one", async () => {
  const omitted = remoteSelectorFixture();
  assert.equal(Object.hasOwn(omitted.nativeInterface, "fdOutParam"), false);
  assert.equal((await verify(omitted)).ok, true);
  const matching = remoteSelectorFixture();
  matching.nativeInterface.fdOutParam = JSON.stringify(matching.outputSchema, null, 2); resealInterface(matching);
  assert.equal((await verify(matching)).ok, true);
  const conflict = remoteSelectorFixture();
  conflict.nativeInterface.fdOutParam = JSON.stringify({ type: "object", properties: {} }); resealInterface(conflict);
  assert.equal((await verify(conflict)).ok, false);
});

it("deduplicates matching interface/connection reads and rejects conflicting specs before metadata calls", async () => {
  const same = remoteSelectorFixture();
  same.dsl.migrationPolicies.decisions.push({ ...structuredClone(same.decision), id: "another_decision", sourceRef: "other-source" });
  assert.equal((await verify(same)).ok, true);
  assert.equal(same.calls.filter(call => call.method === "getTicInterface").length, 1);
  assert.equal(same.calls.filter(call => call.method === "getTicConnection").length, 1);
  for (const mutate of [
    decision => { decision.server.code = "conflicting_code"; },
    decision => { decision.response.rowsPath = ["different"]; },
    decision => { decision.request.searchParameter = "different"; },
    decision => { decision.server.connectionSemanticDigest = "sha256:" + "0".repeat(64); }
  ]) {
    const fixture = remoteSelectorFixture(), changed = structuredClone(fixture.decision); mutate(changed); fixture.dsl.migrationPolicies.decisions.push(changed);
    const result = await verify(fixture);
    assert.equal(result.ok, false); assert.deepEqual(fixture.calls, []); assert.equal(result.diagnostics[0].code, "executor.remote_selector.binding_invalid");
  }
  const left = remoteSelectorFixture(), right = remoteSelectorFixture({ id: "fixture_second" });
  left.dsl.migrationPolicies.decisions.push(right.decision);
  left.client.getTicInterface = async fdId => { left.calls.push({ method: "getTicInterface", fdId }); return structuredClone(fdId === left.nativeInterface.fdId ? left.nativeInterface : right.nativeInterface); };
  assert.equal((await verify(left)).ok, true);
  assert.equal(left.calls.filter(call => call.method === "getTicConnection").length, 1);
});

it("rejects missing wire/read-only evidence, invalid scope, conflicting input names and missing client methods before any metadata read", async () => {
  for (const mutate of [
    fixture => { delete fixture.decision.wireEvidenceSha256; },
    fixture => { fixture.decision.server.readOnlyVerified = false; },
    fixture => { fixture.decision.server.readOnlyEvidenceSha256 = "unproved"; },
    fixture => { delete fixture.decision.server.connectionSemanticDigest; },
    fixture => { fixture.decision.server.callerIds = []; },
    fixture => { fixture.decision.scopeOrigin = "https://different.example.invalid"; },
    fixture => { fixture.dsl.migrationPolicies.scope.baseUrl = "https://different.example.invalid"; },
    fixture => { fixture.decision.request.inputParameters.push({ sourceParameter: "x", targetParameter: "keyword" }); },
    fixture => { fixture.decision.response.rowsPath = ["__proto__"]; },
    fixture => { delete fixture.decision.response.emptySelection; },
    fixture => { fixture.decision.response.emptySelection = "invented-default"; },
    fixture => { fixture.decision.server.callerIds.push("fixture_caller"); },
    fixture => { fixture.client.getTicConnection = undefined; },
    fixture => { fixture.client.baseUrl = "https://different.example.invalid"; }
  ]) {
    const fixture = remoteSelectorFixture(); mutate(fixture); assert.equal((await verify(fixture)).ok, false); assert.deepEqual(fixture.calls, []);
  }
});

it("enforces native GET-only, active REST, disabled logs, explicit Ajax caller ACL and simple response mode even after resealing", async () => {
  for (const mutate of [
    entity => { entity.fdId = "wrong_id"; }, entity => { entity.fdCode = "wrong_code"; }, entity => { entity.fdStatus = 0; }, entity => { entity.fdType = "JDBC"; },
    entity => { entity.fdUsageScene = "write"; }, entity => { entity.protocolData.fdRequestWay = "postBody"; }, entity => { entity.fdAllowAjaxCall = false; },
    entity => { entity.fdLogEnabled = true; }, entity => { entity.fdSupportPage = true; }, entity => { entity.fdFunctionType = 2; },
    entity => { entity.fdAjaxCallers = []; }, entity => { entity.fdAjaxCallers[0].fdOrgType = 4; }, entity => { entity.fdAjaxCallers[0].fdId = "other_caller"; },
    entity => { entity.fdConnection.fdType = "JDBC"; }, entity => { entity.fdConnection.fdId = "different_connection"; }, entity => { delete entity.fdSystem; },
    entity => { entity.protocolData.fdResponseWay = "mix"; }, entity => { entity.protocolData.fdEnableErrorHandle = true; },
    entity => { entity.protocolData.fdEnableIgnoreException = true; }, entity => { entity.protocolData.fdDownloadStream = true; },
    entity => { entity.protocolData.fdRequestUrl = "https://unapproved.example.invalid"; }, entity => { entity.protocolData.fdRequestUrl = "//unapproved.example.invalid"; },
    entity => { entity.protocolData.fdBodyParam = JSON.stringify({ type: "object", properties: {} }); },
    entity => { entity.fdInterfaceAbilityList = [{ fdId: "hidden_ability" }]; }
  ]) {
    const fixture = remoteSelectorFixture(); mutate(fixture.nativeInterface); resealInterface(fixture);
    const result = await verify(fixture); assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, "executor.remote_selector.interface_invalid");
    assert.equal(fixture.calls.length, 1);
  }
});

it("rejects incomplete or mismatched request/output wire schemas after resealing without guessing response paths or columns", async () => {
  for (const mutate of [
    fixture => { fixture.inputSchema.properties.undeclared = { type: "string" }; },
    fixture => { fixture.inputSchema.properties.keyword.type = "number"; },
    fixture => { delete fixture.inputSchema.properties.keyword; },
    fixture => { fixture.inputSchema.properties.keyword.type = ["string", "null"]; },
    fixture => { fixture.inputSchema.properties.keyword.$ref = "#/private"; },
    fixture => { fixture.outputSchema.properties = { wrongRows: fixture.outputSchema.properties.rows }; },
    fixture => { fixture.outputSchema.properties.rows.type = "object"; },
    fixture => { delete fixture.outputSchema.properties.rows.items.properties.description; },
    fixture => { fixture.outputSchema.properties.rows.items.properties.name.type = "object"; },
    fixture => { fixture.outputSchema.properties.rows.items.properties.id.oneOf = [{ type: "string" }]; }
  ]) {
    const fixture = remoteSelectorFixture(); mutate(fixture);
    fixture.nativeInterface.fdInParam = fixture.nativeInterface.protocolData.fdQueryParam = JSON.stringify(fixture.inputSchema);
    fixture.nativeInterface.fdOutParam = fixture.nativeInterface.protocolData.fdBodyResponse = JSON.stringify(fixture.outputSchema);
    resealInterface(fixture); assert.equal((await verify(fixture)).ok, false);
  }
  for (const key of ["fdQueryParam", "fdBodyResponse"]) {
    const fixture = remoteSelectorFixture(); fixture.nativeInterface.protocolData[key] = JSON.stringify({ type: "object", properties: {} }); resealInterface(fixture);
    assert.equal((await verify(fixture)).ok, false);
  }
});

it("supports proved nested/root arrays, nullable scalar outputs and all declared scalar types while allowing ignored upstream columns", async () => {
  const columns = [{ name: "id", title: "Code", type: "String" }, { name: "name", title: "Name", type: "String" },
    { name: "amount", title: "Amount", type: "Number" }, { name: "active", title: "Active", type: "Boolean" }, { name: "date", title: "Date", type: "Date" }];
  for (const rowsPath of [[], ["data", "rows"]]) {
    const fixture = remoteSelectorFixture({ rowsPath, columns });
    let rows = fixture.outputSchema; for (const part of rowsPath) rows = rows.properties[part];
    rows.items.properties.name.type = ["string", "null"]; rows.items.properties.amount.type = "integer";
    rows.items.properties.extra = { type: "object", properties: { ignored: { type: "string" } } };
    fixture.nativeInterface.fdOutParam = fixture.nativeInterface.protocolData.fdBodyResponse = JSON.stringify(fixture.outputSchema); resealInterface(fixture);
    assert.equal((await verify(fixture)).ok, true);
  }
});

it("checks connection identity/status/type/system and independently active typed callers", async () => {
  for (const mutate of [
    connection => { connection.fdId = "other_connection"; }, connection => { connection.fdStatus = 0; }, connection => { connection.fdType = "JDBC"; },
    connection => { connection.fdSystem.fdId = "other_system"; }, connection => { connection.protocolData.fdServiceAddress = "//relative.example.invalid"; },
    connection => { connection.protocolData.fdServiceAddress = "https://user:secret@upstream.example.invalid"; }
  ]) {
    const fixture = remoteSelectorFixture(); mutate(fixture.connection); resealConnection(fixture);
    const result = await verify(fixture); assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, "executor.remote_selector.connection_invalid");
  }
  for (const response of [[], [{ fdId: "fixture_caller", fdOrgType: 8 }], [{ fdId: "fixture_caller", fdOrgType: 8, fdIsAvailable: false }],
    [{ fdId: "fixture_caller", fdOrgType: 4, fdIsAvailable: true }], [{ fdId: "other_caller", fdOrgType: 8, fdIsAvailable: true }],
    [{ fdId: "fixture_caller", fdOrgType: 8, fdIsAvailable: true }, { fdId: "fixture_caller", fdOrgType: 8, fdIsAvailable: true }]]) {
    const fixture = remoteSelectorFixture(); fixture.client.getElementInfo = async () => response;
    const result = await verify(fixture); assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, "executor.remote_selector.caller_invalid");
  }
});

it("seals complete auth/protocol/configuration, normalizes JSON schemas/caller order and excludes documented root display/audit metadata only", () => {
  const fixture = remoteSelectorFixture(), base = ticInterfaceSemanticDigest(fixture.nativeInterface), connectionBase = ticConnectionSemanticDigest(fixture.connection);
  const changed = structuredClone(fixture.nativeInterface);
  changed.fdName = "Changed display"; changed.fdCreateTime = "later"; changed.mechanisms = { load: "*" }; changed.fdAjaxCallers[0].fdName = "Changed caller name";
  changed.fdInParam = JSON.stringify(JSON.parse(changed.fdInParam), null, 2);
  assert.equal(ticInterfaceSemanticDigest(changed), base);
  for (const mutate of [entity => { entity.protocolData.fdRequestUrl += "&changed=1"; }, entity => { entity.unknownConfiguration = { auth: "secret" }; }, entity => { entity.fdAjaxCallers[0].fdOrgType = 4; }]) {
    const entity = structuredClone(fixture.nativeInterface); mutate(entity); assert.notEqual(ticInterfaceSemanticDigest(entity), base);
  }
  const connection = structuredClone(fixture.connection); connection.protocolData.fdHeaderFixedValue = "different-server-secret";
  assert.notEqual(ticConnectionSemanticDigest(connection), connectionBase);
  const ordered = structuredClone(fixture.nativeInterface); ordered.fdAjaxCallers.push({ fdId: "another_person", fdOrgType: 8 });
  const orderedDigest = ticInterfaceSemanticDigest(ordered); ordered.fdAjaxCallers.reverse(); assert.equal(ticInterfaceSemanticDigest(ordered), orderedDigest);
});

it("detects resource drift at a later read and sanitizes thrown metadata and invalid schema errors", async () => {
  const drift = remoteSelectorFixture(); assert.equal((await verify(drift)).ok, true); drift.connection.protocolData.fdHeaderFixedValue = "changed";
  assert.equal((await verify(drift)).ok, false);
  for (const method of ["getTicInterface", "getTicConnection", "getElementInfo"]) {
    const fixture = remoteSelectorFixture(); fixture.client[method] = async () => { throw new Error("private-password=https://secret.example.invalid/?token=secret"); };
    const result = await verify(fixture); assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes("secret"), false); assert.equal(JSON.stringify(result).includes("password"), false);
  }
  const invalid = remoteSelectorFixture(); invalid.nativeInterface.fdInParam = "private invalid schema secret";
  const result = await verify(invalid); assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes("private invalid"), false);
});
