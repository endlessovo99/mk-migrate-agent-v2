import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample } from "../helpers/persistence.js";
import { executeDsl } from "../../src/executor/execute.js";
import { checkExecute } from "../../src/dsl/checks.js";
import { NewoaClient } from "../../src/executor/newoa-client.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/route-validation/workflow-cooperation/cooperation.json", import.meta.url), "utf8"));
const writes = ["add", "update", "save-workflow-draft", "add-transfer-record"];
const origin = "https://oaqas.shanghai-electric.com";
const opts = client => ({ client, baseUrl: origin, credentials: { username: "route-user", encryptedPassword: "route-password" }, targetCategoryId: "route-category-id", confirmWrite: true, now: new Date("2026-10-15T00:00:00Z"), transferRecordIdFactory: () => "cooperation-record" });

class Client extends FakeNewoaAdapter {
  constructor(config = { nodeHandlerTurningWay: fixture.default }) { super("persist"); this.config = config; this.configCalls = []; }
  async getWorkflowCooperationConfig() { this.configCalls.push(this.transcript().map(call => call.operation)); if (this.config instanceof Error) throw this.config; return structuredClone(this.config); }
}

function dsl() {
  const nodes = [
    { id: "N_start", type: "generalStart", element: "startEvent" },
    ...fixture.nodes.map(({ id, type, processType }) => ({ id, type, element: "manualTask", attributes: processType === undefined ? {} : { processType }, definition: { sourceType: type === "send" ? "sendNode" : "reviewNode", attributes: processType === undefined ? {} : { processType } } })),
    { id: "N_end", type: "generalEnd", element: "endEvent" }
  ].map(node => ({ name: node.id, sourceRef: `source.workflow.node.${node.id}`, attributes: {}, translationStatus: "executable", ...node }));
  const edges = nodes.slice(1).map((node, index) => ({ id: `L${index}`, source: nodes[index].id, target: node.id, sourceRef: `source.workflow.edge.L${index}`, attributes: {}, condition: { sourceText: "", displayText: "", targetText: "", translationStatus: "executable" } }));
  return sampleTrustedDsl({ workflow: { process: { id: "cooperation-process" }, nodes, edges, topologicalOrder: nodes.map(n => n.id) } });
}
const nativeNodes = template => JSON.parse(template.mechanisms.lbpmTemplate[0].fdContent).elements.filter(n => ["review", "send"].includes(n.type));

describe("explicit workflow cooperation Route-validation", () => {
  it("validates the current default and persists source zero without numeric shifting or source mutation", async () => {
    await withNetworkGuard(async () => {
      for (const selected of ["2", "3"]) {
        const input = dsl(), before = JSON.stringify(input), client = new Client({ nodeHandlerTurningWay: selected });
        const result = await executeDsl(input, { ...opts(client), workflowCooperationDefault: selected });
        assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
        assert.equal(result.readback.ok, true);
        assert.equal(result.transferRecord.status, "recorded");
        assert.equal(JSON.stringify(input), before);
        assert.deepEqual(nativeNodes(client.template).map(n => n.cooperateType), fixture.nodes.map(n => n.processType === "0" ? selected : n.expected));
        const stage = result.apiStages.find(s => s.name === "resolveWorkflowCooperation");
        assert.equal(stage.config.nodeHandlerTurningWay, selected);
        assert.equal(stage.fallbackCount, 2);
        assert.equal(stage.nodes.length, fixture.nodes.length);
        assert.deepEqual(stage.nodes.filter(n => n.basis === "explicit-current-default").map(n => n.nodeId), ["N_zero", "N_send"]);
        assert.ok(stage.nodes.every(n => n.path.startsWith("/workflow/nodes/") && n.targetValue));
        const operations = client.transcript().map(c => c.operation);
        assert.equal(client.configCalls.length, 1);
        assert.equal(client.configCalls[0].some(operation => writes.includes(operation)), false);
        assert.equal(operations.filter(c => c === "add-transfer-record").length, 1);
      }
    });
  });

  for (const [label, config, policy, edit] of [
    ["no policy", undefined, undefined],
    ["prepopulated target without policy", undefined, undefined, input => { input.workflow.nodes[1].cooperateType = "3"; }],
    ["missing current default", {}, "3"],
    ["illegal current default", { nodeHandlerTurningWay: "0" }, "3"],
    ["numeric current default", { nodeHandlerTurningWay: 3 }, "3"],
    ["current default drift", { nodeHandlerTurningWay: "2" }, "3"],
    ["read failure", new Error("offline config failure"), "3"],
    ["illegal policy", undefined, "0"],
    ["numeric policy", undefined, 3],
    ["unknown source", undefined, "3", input => { input.workflow.nodes[1].definition.attributes.processType = input.workflow.nodes[1].attributes.processType = "4"; }],
    ["numeric source", undefined, "3", input => { input.workflow.nodes[1].definition.attributes.processType = input.workflow.nodes[1].attributes.processType = 0; }],
    ["conflicting source definitions", undefined, "3", input => { input.workflow.nodes[1].definition.attributes.processType = "1"; }],
    ["conflicting runtime field", undefined, "3", input => { input.workflow.nodes[2].cooperateType = "2"; }]
  ]) it(`rejects ${label} before all writes`, async () => {
    const input = dsl(); edit?.(input);
    const client = new Client(config);
    const result = await executeDsl(input, { ...opts(client), ...(policy === undefined ? {} : { workflowCooperationDefault: policy }) });
    assert.equal(result.ok, false, label);
    assert.equal(result.diagnostics.at(-1).details.issues[0].reason, {
      "no policy": "explicit_policy_required", "prepopulated target without policy": "explicit_policy_required",
      "missing current default": "current_default_invalid", "illegal current default": "current_default_invalid",
      "numeric current default": "current_default_invalid", "current default drift": "current_default_changed",
      "read failure": "config_request_failed", "illegal policy": "policy_invalid", "numeric policy": "policy_invalid",
      "unknown source": "source_value_unsupported", "numeric source": "source_value_unsupported",
      "conflicting source definitions": "source_value_conflict", "conflicting runtime field": "runtime_value_conflict"
    }[label]);
    assert.equal(result.remoteWriteAttempted, false);
    assert.equal(client.transcript().some(call => writes.includes(call.operation)), false);
  });

  it("requires a successful current lookup for any explicit policy, even without zero nodes", async () => {
    const input = dsl();
    for (const node of input.workflow.nodes) if (node.definition?.attributes.processType === "0") node.definition.attributes.processType = node.attributes.processType = "1";
    const client = new Client({ nodeHandlerTurningWay: "2" });
    assert.equal((await executeDsl(input, { ...opts(client), workflowCooperationDefault: "3" })).ok, false);
    assert.equal(client.transcript().some(call => writes.includes(call.operation)), false);
    const noPolicy = new Client(new Error("must not query"));
    assert.equal((await executeDsl(input, opts(noPolicy))).ok, true);
    assert.equal(noPolicy.configCalls.length, 0);
  });

  it("refuses an explicit policy when the client cannot verify current configuration", async () => {
    const client = new Client(); client.getWorkflowCooperationConfig = undefined;
    const result = await executeDsl(dsl(), { ...opts(client), workflowCooperationDefault: "3" });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.at(-1).details.issues[0].reason, "config_client_missing");
    assert.equal(client.transcript().some(call => writes.includes(call.operation)), false);
  });

  it("strictly observes every review/send value without converting wrong types or filling missing values", () => {
    const input = dsl();
    for (const node of input.workflow.nodes) if (["review", "send"].includes(node.type)) node.cooperateType = node.definition.attributes.processType === "0" ? "3" : node.definition.attributes.processType || "2";
    const prepared = prepareSample(input);
    assert.equal(prepared.verify(prepared.update).ok, true);
    for (const nodeId of ["N_zero", "N_send"]) for (const value of ["1", "0", "unknown", 3, null, undefined]) {
      const changed = structuredClone(prepared.update), lbpm = changed.mechanisms.lbpmTemplate[0], content = JSON.parse(lbpm.fdContent), node = content.elements.find(n => n.id === nodeId);
      if (value === undefined) delete node.cooperateType; else node.cooperateType = value;
      lbpm.fdContent = JSON.stringify(content);
      const result = prepared.verify(changed);
      assert.equal(result.ok, false, `${nodeId}:${value}`);
      assert.ok(result.diagnostics.some(d => d.code === "readback.workflow.cooperation_type_mismatch"));
    }
  });

  it("retains the created draft and never records when native cooperation changes during readback", async () => {
    class ChangedReadback extends Client {
      async getTemplate(id) {
        const template = await super.getTemplate(id);
        if (this.updated) this.change(template.mechanisms.lbpmTemplate[0]);
        return template;
      }
      async getWorkflowTemplateDetail(args) {
        const result = await super.getWorkflowTemplateDetail(args);
        this.change(result);
        return result;
      }
      change(result) {
        const content = JSON.parse(result.fdContent);
        content.elements.find(node => node.id === "N_zero").cooperateType = "1";
        result.fdContent = JSON.stringify(content);
      }
    }
    const client = new ChangedReadback();
    const result = await executeDsl(dsl(), { ...opts(client), workflowCooperationDefault: "3" });
    assert.equal(result.status, "readback_failed");
    assert.equal(result.createdFdIds.length, 1);
    assert.equal(result.writeOutcomeUnknown, false);
    assert.ok(result.diagnostics.some(item => item.code === "readback.workflow.cooperation_type_mismatch"));
    assert.equal(client.transcript().some(call => call.operation === "add-transfer-record"), false);
  });

  it("keeps policy fields and audits on artificial nodes through paired subprocess projection", async () => {
    const input = dsl();
    const common = { element: "subProcess", translationStatus: "executable", attributes: {} };
    const recovery = { variableScope: 2, recoverRule: { type: 1, expression: { text: "", value: "" } } };
    input.workflow.nodes.splice(1, 0,
      { ...common, id: "N_child", name: "Child", type: "startSubProcess", sourceRef: "source.workflow.node.N_child", subProcess: { templateId: "child-template", recoverNodeId: "N_recover", ...recovery } },
      { ...common, id: "N_recover", name: "Recover", type: "recoverSubProcess", sourceRef: "source.workflow.node.N_recover", subProcess: { startNodeId: "N_child", ...recovery } });
    input.workflow.edges = input.workflow.nodes.slice(1).map((node, index) => ({ id: `L${index}`, source: input.workflow.nodes[index].id, target: node.id, sourceRef: `source.workflow.edge.L${index}`, attributes: {}, condition: { sourceText: "", displayText: "", targetText: "", translationStatus: "executable" } }));
    input.workflow.topologicalOrder = input.workflow.nodes.map(node => node.id);
    const client = new Client();
    const result = await executeDsl(input, { ...opts(client), workflowCooperationDefault: "3" });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    const audit = result.apiStages.find(stage => stage.name === "resolveWorkflowCooperation").nodes;
    assert.deepEqual(audit.map(node => node.nodeId), fixture.nodes.map(node => node.id));
    assert.deepEqual(nativeNodes(client.template).map(node => node.cooperateType), fixture.nodes.map(node => node.expected));
  });

  it("retains exact historical zero projection without applying a new policy during readback", () => {
    const prepared = prepareSample(dsl());
    assert.equal(nativeNodes(prepared.update)[0].cooperateType, "0");
    assert.equal(prepared.verify(prepared.update).ok, true);
    const changed = structuredClone(prepared.update), lbpm = changed.mechanisms.lbpmTemplate[0], content = JSON.parse(lbpm.fdContent);
    content.elements.find(n => n.id === "N_zero").cooperateType = "3";
    lbpm.fdContent = JSON.stringify(content);
    assert.equal(prepared.verify(changed).ok, false);
  });

  it("validates the optional runtime field type and restricts it to artificial nodes", () => {
    for (const [index, value] of [[1, "0"], [1, 3], [1, null], [0, "3"]]) {
      const input = dsl(); input.workflow.nodes[index].cooperateType = value;
      assert.equal(checkExecute(input).ok, false, `${index}:${value}`);
    }
  });

  it("uses the authenticated read-only config route and refuses unsuccessful or malformed envelopes", async () => {
    for (const body of [{ success: true, data: { nodeHandlerTurningWay: "3" } }, { success: false, data: { nodeHandlerTurningWay: "3" } }, { data: { nodeHandlerTurningWay: "3" } }, { success: true, data: [] }]) {
      const requests = [];
      const client = new NewoaClient({ baseUrl: origin, fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body) }; } });
      client.cookie = "route-cookie=value";
      if (body.success === true && !Array.isArray(body.data)) assert.deepEqual(await client.getWorkflowCooperationConfig(), body.data);
      else await assert.rejects(client.getWorkflowCooperationConfig());
      assert.equal(requests[0].url, origin + "/data/sys-lbpm/lbpmConfig/getConfigs");
      assert.equal(requests[0].options.method, "POST");
      assert.equal(requests[0].options.headers.cookie, "route-cookie=value");
    }
  });
});
