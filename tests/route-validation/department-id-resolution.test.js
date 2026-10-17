import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolveWorkflowParticipants } from "../../src/executor/participant-resolver.js";
import { executeDsl } from "../../src/executor/execute.js";
import { NewoaClient } from "../../src/executor/newoa-client.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/route-validation/department-id-resolution/identity.json", import.meta.url), "utf8"));
const clone = value => structuredClone(value);

function routeDsl(source = fixture.source) {
  const dsl = sampleTrustedDsl();
  dsl.workflow.nodes.splice(1, 0, {
    id: "N-review", type: "review", element: "manualTask", name: "Fixture review",
    sourceType: "reviewNode", sourceRef: "source.workflow.node.N-review",
    attributes: {}, translationStatus: "executable",
    participants: { mode: "explicit", members: [clone(source)] }
  });
  dsl.workflow.edges = [["N1", "N-review"], ["N-review", "N2"]].map(([source, target], index) => ({
    id: `L${index + 1}`, source, target, sourceRef: `source.workflow.edge.L${index + 1}`,
    condition: { translationStatus: "executable" }
  }));
  dsl.workflow.topologicalOrder = ["N1", "N-review", "N2"];
  dsl.template.authorization = {
    readerFlag: true, readers: [clone(source)], editors: [], allReaders: [clone(source)],
    allEditors: [], temporaryReaders: [], temporaryEditors: []
  };
  return dsl;
}

function clientFor({ exact = [fixture.target], search = [fixture.target, fixture.sameNameOtherDepartment], failure } = {}) {
  return {
    exactCalls: [], searchCalls: [],
    async getElementInfo(ids, options) {
      this.exactCalls.push({ ids: clone(ids), options: clone(options) });
      if (failure) throw new Error("fixture directory unavailable");
      return clone(exact);
    },
    async searchOrg(key, type) { this.searchCalls.push({ key, type }); return clone(search); }
  };
}

function executeOptions(client, extra = {}) {
  return {
    client, credentials: { username: "fixture-user", encryptedPassword: "fixture-password" },
    baseUrl: "https://p-sit.onewo.com", targetCategoryId: "fixture-category", confirmWrite: true,
    now: new Date("2026-10-15T00:00:00Z"), transferRecordIdFactory: () => "fixture-department-record", ...extra
  };
}

class DepartmentClient extends FakeNewoaAdapter {
  constructor(options = {}) { super("persist"); this.directory = clientFor(options); }
  async getElementInfo(ids, options) {
    this.record({ operation: "get-element-info", targets: clone(ids) });
    return this.directory.getElementInfo(ids, options);
  }
  async searchOrg(key, type) {
    this.record({ operation: "search-org", key });
    return this.directory.searchOrg(key, type);
  }
}

const hasWrites = client => client.transcript().some(item => ["add", "update", "save-workflow-draft", "add-transfer-record"].includes(item.operation));

describe("source department exact-ID Route-validation", { concurrency: false }, () => {
  it("uses the exact department once across workflow and template permissions despite duplicate names", async () => {
    const dsl = routeDsl(); const before = clone(dsl); const client = clientFor();
    const result = await resolveWorkflowParticipants(dsl, { client });
    assert.equal(result.resolvedCount, 3);
    assert.equal(result.fallbackCount, 0);
    assert.equal(result.dsl.workflow.nodes[1].participants.members[0].id, fixture.target.fdId);
    assert.equal(result.dsl.template.authorization.readers[0].id, fixture.target.fdId);
    assert.equal(result.dsl.template.authorization.allReaders[0].id, fixture.target.fdId);
    assert.equal(result.departmentIdResolutions.length, 2);
    assert.deepEqual(result.departmentIdResolutions.map(item => item.referenceCount).sort(), [1, 2]);
    assert.ok(result.departmentIdResolutions.every(item => item.sourceEvidence.sourceId === fixture.source.sourceId && item.target.fdIsAvailable === true));
    assert.equal(client.exactCalls.length, 1);
    assert.deepEqual(client.exactCalls[0], { ids: [fixture.source.sourceId], options: { departmentEvidence: true } });
    assert.deepEqual(client.searchCalls, []);
    assert.deepEqual(dsl, before);
  });

  it("does not require name-search capability or a source parent when the department ID is valid", async () => {
    const source = clone(fixture.source); delete source.sourceParentName;
    const client = clientFor(); delete client.searchOrg;
    const result = await resolveWorkflowParticipants(routeDsl(source), { client });
    assert.equal(result.dsl.template.authorization.readers[0].id, fixture.target.fdId);
    assert.equal(client.exactCalls.length, 1);
  });

  it("runs the unchanged fake executor through readback and one transfer record", async () => withNetworkGuard(async () => {
    const client = new DepartmentClient();
    const result = await executeDsl(routeDsl(), executeOptions(client));
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.readback.ok, true);
    assert.equal(result.transferRecord.status, "recorded");
    const stage = result.apiStages.find(item => item.name === "resolveWorkflowParticipants");
    assert.equal(stage.departmentIdResolutions.length, 2);
    assert.deepEqual(stage.departmentIdResolutions.flatMap(item => item.paths).sort(), [
      "/template/authorization/allReaders/0", "/template/authorization/readers/0", "/workflow/nodes/1/participants/members/0"
    ]);
    assert.deepEqual(result.readback.workflow.templateAuthorization.readers, [fixture.target.fdId]);
    assert.equal(client.transcript().filter(item => item.operation === "add-transfer-record").length, 1);
    assert.equal(client.directory.searchCalls.length, 0);
  }));

  for (const [name, exact, reason] of [
    ["wrong type", [{ ...fixture.target, fdOrgType: 8 }], "source_department_id_type_mismatch"],
    ["disabled", [{ ...fixture.target, fdIsAvailable: false }], "source_department_id_unavailable"],
    ["missing availability", [{ ...fixture.target, fdIsAvailable: undefined }], "source_department_id_unavailable"],
    ["invalid availability", [{ ...fixture.target, fdIsAvailable: "true" }], "source_department_id_unavailable"],
    ["different name", [{ ...fixture.target, fdName: "Another Department" }], "source_department_id_name_mismatch"],
    ["different parent", [{ ...fixture.target, fdParentName: "Other Parent" }], "source_department_id_parent_mismatch"],
    ["wrong ID", [fixture.sameNameOtherDepartment], "source_department_id_response_invalid"],
    ["duplicate exact IDs", [fixture.target, fixture.target], "source_department_id_response_invalid"],
    ["extra candidates", [fixture.target, fixture.sameNameOtherDepartment], "source_department_id_response_invalid"],
    ["malformed record", [{}], "source_department_id_response_invalid"],
    ["malformed body", {}, "source_department_id_response_invalid"]
  ]) {
    it(`blocks ${name} without name search, fallback or writes`, async () => withNetworkGuard(async () => {
      const client = new DepartmentClient({ exact });
      const result = await executeDsl(routeDsl(), executeOptions(client, { allowTemplateAuthorizationFallback: true }));
      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some(item => item.details?.issues?.some(issue => issue.reason === reason)), JSON.stringify(result.diagnostics));
      assert.equal(client.directory.searchCalls.length, 0);
      assert.equal(client.transcript().some(item => item.operation === "init"), false);
      assert.equal(hasWrites(client), false);
    }));
  }

  it("does not hide an exact lookup failure behind a configured SIT fallback", async () => withNetworkGuard(async () => {
    const client = new DepartmentClient({ failure: true });
    const result = await executeDsl(routeDsl(), executeOptions(client, { allowTemplateAuthorizationFallback: true }));
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(item => item.details?.issues?.some(issue => issue.reason === "source_department_id_lookup_failed")));
    assert.equal(client.directory.searchCalls.length, 0);
    assert.equal(hasWrites(client), false);
  }));

  it("retains unique name resolution only after an authoritative empty exact-ID result", async () => {
    const client = clientFor({ exact: [], search: [fixture.sameNameOtherDepartment] });
    const result = await resolveWorkflowParticipants(routeDsl(), { client });
    assert.equal(result.dsl.workflow.nodes[1].participants.members[0].id, fixture.sameNameOtherDepartment.fdId);
    assert.equal(client.exactCalls.length, 1);
    assert.equal(client.searchCalls.length, 1);
  });

  it("still blocks ambiguous names when the exact department ID is absent", async () => {
    const client = clientFor({ exact: [] });
    await assert.rejects(resolveWorkflowParticipants(routeDsl(), { client }), error => error.issues?.some(item => item.reason === "ambiguous"));
    assert.equal(client.exactCalls.length, 1);
    assert.equal(client.searchCalls.length, 1);
  });

  it("blocks a missing exact-lookup capability rather than silently searching", async () => {
    const client = clientFor(); delete client.getElementInfo;
    await assert.rejects(resolveWorkflowParticipants(routeDsl(), { client }), error => error.issues?.some(item => item.reason === "source_department_validation_unavailable"));
    assert.equal(client.searchCalls.length, 0);
  });

  it("blocks missing search capability only if exact lookup actually finds no department", async () => {
    const client = clientFor({ exact: [] }); delete client.searchOrg;
    await assert.rejects(resolveWorkflowParticipants(routeDsl(), { client }), error => error.issues?.some(item => item.reason === "search_unavailable"));
    assert.equal(client.exactCalls.length, 1);
  });

  it("retains explicit mappings as the highest-priority, separately audited choice", async () => {
    const client = clientFor({ exact: [fixture.sameNameOtherDepartment] });
    const sourceId = fixture.source.sourceId; const targetFdId = fixture.sameNameOtherDepartment.fdId;
    const result = await resolveWorkflowParticipants(routeDsl(), {
      client, participantOverrides: [{ sourceId, targetFdId }], templateAuthorizationOverrides: [{ sourceId, targetFdId }]
    });
    assert.equal(result.dsl.template.authorization.readers[0].id, targetFdId);
    assert.equal(result.overrideCount, 1);
    assert.equal(result.templateAuthorizationOverrideCount, 2);
    assert.deepEqual(client.exactCalls.map(call => call.ids), [[targetFdId]]);
    assert.equal(client.searchCalls.length, 0);
  });

  for (const orgType of [1, 4, 8, 16]) {
    it(`preserves existing name resolution for non-department type ${orgType}`, async () => {
      const source = { ...fixture.source, sourceOrgType: orgType };
      const target = { ...fixture.sameNameOtherDepartment, fdOrgType: orgType, ...(orgType===8?{fdIsBusiness:true}:{}) };
      const client = clientFor({ search: [target] });
      const result = await resolveWorkflowParticipants(routeDsl(source), { client });
      assert.equal(result.dsl.workflow.nodes[1].participants.members[0].id, target.fdId);
      assert.deepEqual(client.exactCalls, []);
      assert.equal(client.searchCalls.length, 1);
      assert.equal(result.departmentIdResolutions, undefined);
    });
  }

  it("still rejects a same-name different-ID permission in actual fake readback", async () => withNetworkGuard(async () => {
    class TamperedReadback extends DepartmentClient {
      async getTemplate(id) {
        const result = await super.getTemplate(id);
        if (result.fdReaders?.length) result.fdReaders[0].fdId = fixture.sameNameOtherDepartment.fdId;
        return result;
      }
    }
    const client = new TamperedReadback();
    const result = await executeDsl(routeDsl(), executeOptions(client));
    assert.equal(result.ok, false);
    assert.equal(result.status, "readback_failed");
    assert.ok(result.readback.diagnostics.some(item => item.code === "readback.decode.workflow.template_authorization_binding_mismatch"));
    assert.equal(client.transcript().filter(item => item.operation === "add-transfer-record").length, 0);
  }));

  it("requests fixed department availability and parent evidence from the real client seam", async () => {
    let request;
    const client = new NewoaClient({ fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: [fixture.target] }) };
    } });
    const result = await client.getElementInfo([fixture.source.sourceId], { departmentEvidence: true });
    assert.deepEqual(request.body.colums, ["fdId", "fdName", "fdOrgType", "fdIsAvailable", "fdParentName"]);
    assert.deepEqual(result, [fixture.target]);
  });
});
