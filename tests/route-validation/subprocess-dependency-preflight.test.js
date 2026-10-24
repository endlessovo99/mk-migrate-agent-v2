import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { runFixtureRouteCase } from "./run-route-case.js";

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/route-validation/subprocess-dependency/${name}`, import.meta.url), "utf8"));
const native = fixture("native-reads.json");
const cases = fixture("route-cases.json").cases;

class DependencyAdapter extends FakeNewoaAdapter {
  constructor(scenario, options) { super("persist", options); this.dependencyScenario = scenario; }

  async getWorkflowTemplateDetail({ templateId }) {
    this.record({ operation: "get-workflow-detail", templateId, definitionId: "" });
    if (this.dependencyScenario === "dependency-absent") {
      const error = new Error("Structured fixture noRecord.");
      error.stage = "getWorkflowTemplateDetail";
      error.response = structuredClone(native.missingDetailResponse);
      throw error;
    }
    return { ...structuredClone(native.detailResponse.data), fdContent: JSON.stringify(native.repositoryDefinitionGraph) };
  }

  async getWorkflowSubProcessParams({ templateId }) {
    // A fixture-only read operation; no application runtime or native response
    // body is placed in the semantic transcript.
    this.entries.push({ operation: "get-subprocess-params", templateId });
    return structuredClone(native.paramsResponse.data);
  }
}

describe("subprocess dependency preflight Route-validation", () => {
  for (const routeCase of cases) it(`runs ${routeCase.id} through review, trust and production executeDsl with zero target writes`, async () => {
    const result = await runFixtureRouteCase(routeCase, {
      adapterFactory: (scenario, options) => new DependencyAdapter(scenario, options)
    });
    assert.equal(result.execution.status, "blocked");
    assert.equal(result.execution.remoteWriteAttempted, false);
    assert.equal(result.execution.writeOutcomeUnknown, false);
    assert.deepEqual(result.execution.createdFdIds, []);
    assert.deepEqual(result.execution.updatedFdIds, []);
    assert.deepEqual(result.transcript.map(entry => entry.operation), routeCase.expected.operations);
    assert.equal(result.execution.diagnostics.some(diagnostic => diagnostic.code === (
      routeCase.newoaScenario === "dependency-absent"
        ? "workflow.subprocess.dependency_read_failed"
        : "workflow.subprocess.parameter_contract_unverified"
    )), true);
    assert.equal(result.dsl.workflow.nodes.find(node => node.id === "N20").subProcess.templateId, "route-child-template");
  });
});
