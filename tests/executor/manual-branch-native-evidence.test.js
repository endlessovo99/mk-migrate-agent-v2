import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/executor/persistence");

describe("independent manual-branch native evidence", () => {
  it("projects previous-artificial-node selection as decisionType 1", () => {
    const prepared = prepareSample(manualBranchDsl(false));
    const content = workflowContent(prepared.update);
    const branch = content.elements.find((element) => element.id === "N35");
    const routes = content.elements.filter((element) => ["L44", "L45", "L46"].includes(element.id));

    assert.equal(branch.type, "manualBranch");
    assert.equal(branch.element, "exclusiveGateway");
    assert.equal(branch.decisionType, "1");
    assert.equal(branch.conditionType, undefined);
    assert.equal(branch.conditionValue, undefined);
    assert.equal(branch.resultSetMapping, undefined);
    assert.deepEqual(routes.map((route) => route.formulaName), ["上汽", "上发", "上辅"]);
    assert.equal(routes.every((route) => route.formulaType === "rule"), true);
    assert.equal(routes.every((route) => route.formula === undefined), true);
  });

  it("projects drafter selection as decisionType 2", () => {
    const prepared = prepareSample(manualBranchDsl(true));
    const branch = workflowContent(prepared.update).elements.find((element) => element.id === "N35");

    assert.equal(branch.type, "manualBranch");
    assert.equal(branch.decisionType, "2");
  });

  it("verifies the sanitized native shape captured from the example CURL", () => {
    const prepared = prepareSample(manualBranchDsl(false));
    const readback = prepared.verify(independentNativeReadback());

    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.partitions.workflow, "verified");
    assert.equal(readback.workflow.nodes.find((node) => node.id === "N35").type, "manualBranch");
  });

  for (const testCase of [
    {
      name: "branch type",
      code: "readback.workflow.node_type_mismatch",
      mutate(branch) {
        branch.type = "conditionBranch";
      }
    },
    {
      name: "decision type",
      code: "readback.workflow.manual_branch_mismatch",
      mutate(branch) {
        branch.decisionType = "2";
      }
    }
  ]) {
    it(`rejects a changed native ${testCase.name}`, () => {
      const prepared = prepareSample(manualBranchDsl(false));
      const template = independentNativeReadback();
      const content = workflowContent(template);
      testCase.mutate(content.elements.find((element) => element.id === "N35"));
      template.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(content);
      const readback = prepared.verify(template);

      assert.equal(readback.ok, false);
      assert.equal(readback.diagnostics.some((item) => item.code === testCase.code), true);
    });
  }
});

function manualBranchDsl(decidedBranchOnDraft) {
  return sampleTrustedDsl({
    workflow: {
      process: { id: "manual-branch-evidence" },
      nodes: [
        workflowNode("N1", "generalStart", "startEvent", "开始", "startNode"),
        {
          ...workflowNode("N35", "manualBranch", "exclusiveGateway", "人工分支", "manualBranchNode"),
          decisionType: decidedBranchOnDraft ? "2" : "1",
          attributes: { decidedBranchOnDraft: String(decidedBranchOnDraft) }
        },
        workflowNode("N44", "generalEnd", "endEvent", "上汽", "endNode"),
        workflowNode("N45", "generalEnd", "endEvent", "上发", "endNode"),
        workflowNode("N46", "generalEnd", "endEvent", "上辅", "endNode")
      ],
      edges: [
        workflowEdge("L29", "N1", "N35", ""),
        workflowEdge("L44", "N35", "N44", "上汽", "1"),
        workflowEdge("L45", "N35", "N45", "上发", "2"),
        workflowEdge("L46", "N35", "N46", "上辅", "3")
      ],
      topologicalOrder: ["N1", "N35", "N44", "N45", "N46"]
    }
  });
}

function workflowNode(id, type, element, name, sourceType) {
  return {
    id,
    type,
    element,
    name,
    sourceType,
    sourceRef: `source.workflow.node.${id}`,
    attributes: {},
    translationStatus: "executable"
  };
}

function workflowEdge(id, source, target, name, priority = "") {
  return {
    id,
    source,
    target,
    name,
    sourceRef: `source.workflow.edge.${id}`,
    condition: {
      sourceText: "",
      displayText: "",
      targetText: "",
      translationStatus: "executable"
    },
    attributes: priority ? { priority } : {}
  };
}

function independentNativeReadback() {
  const template = JSON.parse(
    readFileSync(join(fixtureDir, "form-only-native-readback.json"), "utf8")
  );
  const config = xformConfig(template);
  const formAttr = JSON.parse(config.attribute.formAttr);
  formAttr.subjectRule = {};
  config.attribute.formAttr = JSON.stringify(formAttr);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  template.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(
    JSON.parse(readFileSync(join(fixtureDir, "manual-branch-native-workflow.json"), "utf8"))
  );
  return template;
}

function workflowContent(template) {
  return JSON.parse(template.mechanisms.lbpmTemplate[0].fdContent);
}
