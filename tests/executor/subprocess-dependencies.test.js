import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { executeDsl } from "../../src/executor/execute.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { FakeNewoaAdapter } from "../route-validation/fake-newoa-adapter.js";
import { withNetworkGuard } from "../route-validation/network-guard.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/route-validation/subprocess-dependency/native-reads.json", import.meta.url), "utf8"));
const stageName = "verifyWorkflowSubProcessDependencies";
const forbidden = new Set(["init", "generate-table-name", "add", "update", "save-workflow-draft", "publish", "add-transfer-record"]);

function dependencyDsl({ parameterized = false } = {}) {
  const draft = draftSourceDraft(cleanSourceFile("tests/fixtures/route-validation/subprocess"));
  if (!parameterized) {
    for (const node of draft.workflow.nodes.filter(node => node.subProcess)) {
      for (const key of ["modelName", "dictBean", "createParam"]) delete node.subProcess[key];
      node.subProcess.startParamConfig = [];
      node.subProcess.recoverParamConfig = [];
    }
  }
  return sampleTrustedDsl({ form: draft.form, workflow: draft.workflow });
}

function nativeDetail() {
  return { ...structuredClone(fixture.detailResponse.data), fdContent: JSON.stringify(fixture.repositoryDefinitionGraph) };
}

function readError(response, stage) {
  const error = new Error("Native read failed with fixture-only private text.");
  error.stage = stage;
  error.response = structuredClone(response);
  return error;
}

class Client extends FakeNewoaAdapter {
  constructor(options = {}) {
    super("persist");
    this.options = options;
    this.reads = [];
    this.sequence = [];
  }

  record(entry) { super.record(entry); this.sequence?.push(entry.operation); }

  async getWorkflowTemplateDetail(payload) {
    if (payload.templateId !== "route-child-template") return super.getWorkflowTemplateDetail(payload);
    this.reads.push({ name: "getWorkflowTemplateDetail", payload: structuredClone(payload) });
    this.sequence.push("getWorkflowTemplateDetail");
    if (this.options.detailError) throw this.options.detailError;
    return structuredClone(Object.hasOwn(this.options, "detail") ? this.options.detail : nativeDetail());
  }

  async getWorkflowSubProcessParams(payload) {
    this.reads.push({ name: "getWorkflowSubProcessParams", payload: structuredClone(payload) });
    this.sequence.push("getWorkflowSubProcessParams");
    if (this.options.paramsError) throw this.options.paramsError;
    return structuredClone(Object.hasOwn(this.options, "params") ? this.options.params : fixture.paramsResponse.data);
  }
}

async function execute(input = dependencyDsl(), client = new Client()) {
  const journal = [];
  const result = await withNetworkGuard(() => executeDsl(input, {
    client,
    credentials: { username: "subprocess-test-user", encryptedPassword: "subprocess-test-password" },
    confirmWrite: true,
    targetCategoryId: "route-category-id",
    now: new Date("2026-10-24T10:00:00.000Z"),
    transferRecordIdFactory: () => "subprocess-test-record",
    journal: { beforeWrite: event => journal.push(event), afterWrite: event => journal.push(event) }
  }));
  return { result, client, journal };
}

function assertBlocked({ result, client, journal }, code, path) {
  assert.equal(result.status, "blocked", JSON.stringify(result.diagnostics));
  assert.equal(result.ok, false);
  assert.equal(result.stage, stageName);
  assert.equal(result.failedAt, stageName);
  assert.equal(result.remoteWriteAttempted, false);
  assert.equal(result.writeOutcomeUnknown, false);
  assert.deepEqual(result.createdFdIds, []);
  assert.deepEqual(result.updatedFdIds, []);
  assert.deepEqual(journal, []);
  assert.deepEqual(client.transcript().map(entry => entry.operation), ["login"]);
  assert.equal(client.transcript().some(entry => forbidden.has(entry.operation)), false);
  assert.equal(result.apiStages.at(-1).status, "failed");
  const diagnostic = result.diagnostics.find(entry => entry.code === code);
  assert.ok(diagnostic, JSON.stringify(result.diagnostics));
  if (path) assert.equal(diagnostic.path, path);
  return diagnostic;
}

describe("subprocess dependencies before every target write", () => {
  it("blocks the fixture-backed missing internal LBPM dependency before init or name allocation", async () => {
    const client = new Client({ detailError: readError(fixture.missingDetailResponse, "getWorkflowTemplateDetail") });
    const outcome = await execute(dependencyDsl({ parameterized: true }), client);
    const diagnostic = assertBlocked(outcome, "workflow.subprocess.dependency_read_failed", "/workflow/nodes/1/subProcess/templateId");
    assert.equal(diagnostic.details.reason, "no_record");
    assert.equal(diagnostic.details.readStage, "getWorkflowTemplateDetail");
    assert.equal(diagnostic.details.transportFailure, false);
    assert.equal(diagnostic.details.httpStatus, 500);
    assert.deepEqual(diagnostic.details.upstreamCodes, ["errors.noRecord"]);
    assert.deepEqual(client.reads, [{ name: "getWorkflowTemplateDetail", payload: { templateId: "route-child-template" } }]);
  });

  it("preserves params noRecord classification after an otherwise available dependency detail", async () => {
    const client = new Client({ paramsError: readError(fixture.missingParamsResponse, "getWorkflowSubProcessParams") });
    const diagnostic = assertBlocked(await execute(dependencyDsl(), client), "workflow.subprocess.dependency_read_failed");
    assert.equal(diagnostic.details.reason, "no_record");
    assert.equal(diagnostic.details.readStage, "getWorkflowSubProcessParams");
    assert.equal(diagnostic.details.transportFailure, false);
    assert.deepEqual(diagnostic.details.upstreamCodes, ["error.params", "errors.noRecord"]);
    assert.equal(client.reads.length, 2);
  });

  for (const method of ["getWorkflowTemplateDetail", "getWorkflowSubProcessParams"]) {
    it(`requires the ${method} read capability before writes`, async () => {
      const client = new Client();
      client[method] = undefined;
      assertBlocked(await execute(dependencyDsl(), client), "workflow.subprocess.dependency_client_unavailable");
    });
  }

  for (const readStage of ["getWorkflowTemplateDetail", "getWorkflowSubProcessParams"]) {
    for (const [label, response, expected] of [
      ["transport", undefined, "transport_failure"],
      ["authentication", { status: 401, body: { code: "auth.denied" } }, "authentication_failed"],
      ["authorization", { status: 403, body: { code: "auth.denied" } }, "authorization_failed"]
    ]) it(`blocks ${label} failure in ${readStage} without exposing upstream text`, async () => {
      const error = new Error("subprocess-test-password private upstream text");
      error.stage = readStage;
      if (response) error.response = response;
      const client = new Client({ [readStage === "getWorkflowTemplateDetail" ? "detailError" : "paramsError"]: error });
      const { result, ...rest } = await execute(dependencyDsl(), client);
      const diagnostic = assertBlocked({ result, ...rest }, "workflow.subprocess.dependency_read_failed");
      assert.equal(diagnostic.details.reason, expected);
      assert.equal(diagnostic.details.transportFailure, response === undefined);
      assert.equal(JSON.stringify(result).includes(error.message), false);
      assert.equal(JSON.stringify(result).includes("subprocess-test-password"), false);
    });
  }

  for (const [label, mutate, code] of [
    ["wrong identity", detail => { detail.fdId = "another-child"; }, "dependency_identity_mismatch"],
    ["draft", detail => { detail.isDraft = true; detail.fdStatus = "draft"; }, "dependency_not_published"],
    ["missing draft flag", detail => { delete detail.isDraft; }, "dependency_not_published"],
    ["disabled", detail => { detail.fdEnable = false; }, "dependency_disabled"],
    ["untyped enable", detail => { detail.fdEnable = "true"; }, "dependency_disabled"],
    ["missing definition", detail => { delete detail.fdDefinitionId; }, "dependency_definition_unverified"],
    ["missing published definition status", detail => { delete detail.latestDefinitionStatus; }, "dependency_not_published"],
    ["non-JSON content type", detail => { detail.fdContentType = "xml"; }, "dependency_graph_invalid"],
    ["invalid graph JSON", detail => { detail.fdContent = "{"; }, "dependency_graph_invalid"],
    ["empty graph", detail => { detail.fdContent = '{"elements":[]}'; }, "dependency_graph_invalid"],
    ["dangling graph edge", detail => { const graph = JSON.parse(detail.fdContent); graph.elements.at(-1).targetRef = "missing"; detail.fdContent = JSON.stringify(graph); }, "dependency_graph_invalid"],
    ["duplicate graph identity", detail => { const graph = JSON.parse(detail.fdContent); graph.elements[1].id = graph.elements[0].id; detail.fdContent = JSON.stringify(graph); }, "dependency_graph_invalid"]
  ]) it(`blocks a dependency with ${label}`, async () => {
    const detail = nativeDetail(); mutate(detail);
    assertBlocked(await execute(dependencyDsl(), new Client({ detail })), `workflow.subprocess.${code}`);
  });

  for (const [label, params, code] of [
    ["missing response", undefined, "dependency_definition_unverified"],
    ["missing definition", { processTemplateInfo: {}, processTempVars: { _all: [] } }, "dependency_definition_unverified"],
    ["different definition", { processTemplateInfo: { latestDefinitionId: "another-definition" }, processTempVars: { _all: [] } }, "dependency_definition_unverified"],
    ["missing variable metadata", { processTemplateInfo: { latestDefinitionId: "route-child-definition" } }, "parameter_contract_unverified"],
    ["malformed variable metadata", { processTemplateInfo: { latestDefinitionId: "route-child-definition" }, processTempVars: { _all: {} } }, "parameter_contract_unverified"],
    ["unknown variable format", { processTemplateInfo: { latestDefinitionId: "route-child-definition" }, processTempVars: { _all: [{ name: "fdSubject", type: "String", required: true }] } }, "parameter_contract_unverified"],
    ["unknown parameter metadata", { processTemplateInfo: { latestDefinitionId: "route-child-definition", guessedInputs: [] }, processTempVars: { _all: [] } }, "parameter_contract_unverified"]
  ]) it(`blocks ${label}`, async () => {
    assertBlocked(await execute(dependencyDsl(), new Client({ params })), `workflow.subprocess.${code}`);
  });

  it("does not use an empty processTempVars list as proof of parameterized business bindings", async () => {
    const input = dependencyDsl({ parameterized: true });
    const before = JSON.stringify(input);
    const outcome = await execute(input);
    assertBlocked(outcome, "workflow.subprocess.parameter_contract_unverified");
    assert.equal(JSON.stringify(input), before);
    assert.equal(outcome.client.reads.length, 2);
  });

  for (const key of ["modelName", "dictBean", "createParam", "startParamConfig", "recoverParamConfig"]) {
    it(`requires proven semantics for ${key}, including legacy expressions`, async () => {
      const input = dependencyDsl();
      input.workflow.nodes[1].subProcess[key] = key.endsWith("ParamConfig")
        ? [{ source: { value: '$docSubject$ + " old expression"' }, target: { value: "fdSubject", type: "String", required: true } }]
        : "legacy-business-namespace";
      assertBlocked(await execute(input), "workflow.subprocess.parameter_contract_unverified", `/workflow/nodes/1/subProcess/${key}`);
    });
  }

  it("checks recover-node mappings as well as the projected start-node mappings", async () => {
    const input = dependencyDsl();
    input.workflow.nodes[2].subProcess.recoverParamConfig = [{ source: { value: "$missingChildField$" }, target: { value: "fd_subject" } }];
    assertBlocked(await execute(input), "workflow.subprocess.parameter_contract_unverified", "/workflow/nodes/2/subProcess/recoverParamConfig");
  });

  it("passes only the empty-parameter internal dependency contract, reading it before init", async () => {
    const { result, client } = await execute();
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.readback.ok, true);
    assert.equal(result.apiStages[1].name, stageName);
    assert.equal(result.apiStages[1].status, "ok");
    assert.deepEqual(client.sequence.slice(0, 4), ["login", "getWorkflowTemplateDetail", "getWorkflowSubProcessParams", "init"]);
    assert.deepEqual(client.reads, [
      { name: "getWorkflowTemplateDetail", payload: { templateId: "route-child-template" } },
      { name: "getWorkflowSubProcessParams", payload: { templateId: "route-child-template" } }
    ]);
    assert.equal(result.remoteWriteAttempted, true);
    assert.equal(result.writeOutcomeUnknown, false);
  });

  it("deduplicates two pairs using the same exact internal dependency identity", async () => {
    const input = dependencyDsl();
    const start = structuredClone(input.workflow.nodes[1]);
    const recover = structuredClone(input.workflow.nodes[2]);
    start.id = "N21"; start.sourceRef = "source.workflow.node.N21"; start.subProcess.recoverNodeId = "N24";
    recover.id = "N24"; recover.sourceRef = "source.workflow.node.N24"; recover.subProcess.startNodeId = "N21";
    input.workflow.nodes.splice(3, 0, start, recover);
    input.workflow.edges = input.workflow.nodes.slice(1).map((node, index) => ({
      ...structuredClone(input.workflow.edges[0]), id: `L${index}`, source: input.workflow.nodes[index].id, target: node.id, sourceRef: `source.workflow.edge.L${index}`
    }));
    input.workflow.topologicalOrder = input.workflow.nodes.map(node => node.id);
    const { result, client } = await execute(input);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(client.reads.length, 2);
    assert.deepEqual(result.apiStages[1].dependencies[0].nodeIds, ["N20", "N21"]);
  });

  it("leaves workflows without subprocesses on the original execution path without extra reads", async () => {
    const input = dependencyDsl();
    input.workflow.nodes = input.workflow.nodes.filter(node => !node.subProcess);
    input.workflow.edges = [{ ...input.workflow.edges[0], source: "N1", target: "N3" }];
    input.workflow.topologicalOrder = ["N1", "N3"];
    const client = new Client();
    client.getWorkflowSubProcessParams = undefined;
    const { result } = await execute(input, client);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(client.reads, []);
    assert.equal(result.apiStages.some(stage => stage.name === stageName), false);
  });
});
