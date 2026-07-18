import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/executor/persistence");

describe("independent conditional-parallel native evidence", () => {
  it("projects condition-matching parallel splits as native conditional gateways", () => {
    const prepared = prepareSample(conditionalParallelDsl());
    const workflow = JSON.parse(prepared.update.mechanisms.lbpmTemplate[0].fdContent);
    const split = workflow.elements.find((element) => element.id === "QC20");
    const routes = JSON.parse(split.conditionValue).formulas;

    assert.equal(split.splitType, "3");
    assert.equal(split.conditionType, "1");
    assert.deepEqual(routes.map((route) => route.lineId), ["QE21", "QE22"]);
    assert.equal(routes.every((route) => route.formula?.type === "Batch"), true);
    for (const edgeId of ["QE21", "QE22"]) {
      const edge = workflow.elements.find((element) => element.id === edgeId);
      assert.equal(edge.formulaType, "formula");
      assert.equal(JSON.parse(edge.formula).type, "Batch");
    }
  });

  it("verifies native gateway, condition, and document-creator semantics", () => {
    const prepared = prepareSample(conditionalParallelDsl());
    const template = independentReadback();

    const readback = prepared.verify(template);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.partitions.workflow, "verified");
  });

  it("detects independent native mutations without using writer output as evidence", () => {
    const prepared = prepareSample(conditionalParallelDsl());
    const cases = [
      {
        name: "split mode",
        code: "readback.workflow.parallel_gateway_mismatch",
        mutate(content) {
          content.elements.find((element) => element.id === "QC20").splitType = "0";
        }
      },
      {
        name: "join relation",
        code: "readback.workflow.parallel_gateway_mismatch",
        mutate(content) {
          content.elements.find((element) => element.id === "QC50").relateId = "QC99";
        }
      },
      {
        name: "conditional route index",
        code: "readback.workflow.parallel_gateway_mismatch",
        mutate(content) {
          delete content.elements.find((element) => element.id === "QC20").conditionValue;
        }
      },
      {
        name: "branch condition",
        code: "readback.workflow.edge_condition_native_semantic_mismatch",
        mutate(content) {
          const edge = content.elements.find((element) => element.id === "QE21");
          const formula = JSON.parse(edge.formula);
          formula.result.value = "false";
          edge.formula = JSON.stringify(formula);
        }
      },
      {
        name: "document creator",
        code: "readback.workflow.participant_mismatch",
        mutate(content) {
          content.elements.find((element) => element.id === "QC60").handlers = {
            type: "org",
            source: "1",
            members: []
          };
        }
      }
    ];

    for (const testCase of cases) {
      const mutation = independentReadback();
      mutateWorkflow(mutation, testCase.mutate);
      const diagnostics = prepared.verify(mutation).diagnostics;
      assert.equal(
        diagnostics.some((item) => item.code === testCase.code),
        true,
        `${testCase.name}: ${JSON.stringify(diagnostics)}`
      );
    }
  });
});

function conditionalParallelDsl() {
  const nodes = [
    workflowNode("QC10", "generalStart", "startEvent", "Start"),
    {
      ...workflowNode("QC20", "split", "parallelGateway", "Conditional split"),
      attributes: { splitType: "condition", relatedNodeIds: "QC50" }
    },
    workflowNode("QC31", "review", "manualTask", "Alpha review"),
    workflowNode("QC32", "review", "manualTask", "Gamma review"),
    {
      ...workflowNode("QC50", "join", "parallelGateway", "Conditional join"),
      attributes: { joinType: "all", relatedNodeIds: "QC20" }
    },
    {
      ...workflowNode("QC60", "review", "manualTask", "Submitter confirmation"),
      participants: {
        mode: "doc_creator",
        sourceExpression: "<提交人>",
        sourceNameExpression: "<提交人>"
      }
    },
    workflowNode("QC90", "generalEnd", "endEvent", "End")
  ];
  const edges = [
    workflowEdge("QE10", "QC10", "QC20"),
    workflowEdge("QE21", "QC20", "QC31", {
      sourceText: '$fd_subject$.equals("A") || $fd_subject$.equals("B")',
      displayText: '$主题$ is Alpha or Beta',
      targetText: '$fd_subject$.equals("A") || $fd_subject$.equals("B")',
      translationStatus: "executable",
      critical: true
    }, { priority: "1" }),
    workflowEdge("QE22", "QC20", "QC32", {
      sourceText: '$fd_subject$.equals("C")',
      displayText: '$主题$ is Gamma',
      targetText: '$fd_subject$.equals("C")',
      translationStatus: "executable",
      critical: true
    }, { priority: "2" }),
    workflowEdge("QE31", "QC31", "QC50"),
    workflowEdge("QE32", "QC32", "QC50"),
    workflowEdge("QE50", "QC50", "QC60"),
    workflowEdge("QE60", "QC60", "QC90")
  ];
  return sampleTrustedDsl({
    workflow: {
      process: { id: "independent-conditional-parallel" },
      nodes,
      edges,
      topologicalOrder: nodes.map((node) => node.id)
    }
  });
}

function independentReadback() {
  const template = JSON.parse(readFileSync(join(fixtureDir, "form-only-native-readback.json"), "utf8"));
  const workflow = JSON.parse(readFileSync(join(fixtureDir, "conditional-parallel-native-workflow.json"), "utf8"));
  const config = xformConfig(template);
  const attr = JSON.parse(config.attribute.formAttr);
  attr.subjectRule = {};
  config.attribute.formAttr = JSON.stringify(attr);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  template.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(workflow);
  return template;
}

function mutateWorkflow(template, mutate) {
  const lbpm = template.mechanisms.lbpmTemplate[0];
  const content = JSON.parse(lbpm.fdContent);
  mutate(content);
  lbpm.fdContent = JSON.stringify(content);
}

function workflowNode(id, type, element, name) {
  return {
    id,
    type,
    element,
    name,
    sourceType: type,
    sourceRef: `source.workflow.node.${id}`,
    attributes: {},
    translationStatus: "executable"
  };
}

function workflowEdge(id, source, target, condition = { translationStatus: "executable" }, attributes = {}) {
  return {
    id,
    source,
    target,
    name: "",
    sourceRef: `source.workflow.edge.${id}`,
    attributes,
    condition
  };
}
