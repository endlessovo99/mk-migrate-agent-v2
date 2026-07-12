import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/executor/persistence");

describe("native participant evidence", () => {
  it("loads an independently authored formula-participant workflow", () => {
    const prepared = prepareSample(nativeFormulaParticipantDsl());
    const template = JSON.parse(readFileSync(join(fixtureDir, "form-only-native-readback.json"), "utf8"));
    const workflow = JSON.parse(readFileSync(join(fixtureDir, "formula-participants-native-workflow.json"), "utf8"));
    const config = xformConfig(template);
    const attr = JSON.parse(config.attribute.formAttr);
    attr.subjectRule = {};
    config.attribute.formAttr = JSON.stringify(attr);
    template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    template.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(workflow);

    const readback = prepared.verify(template);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.partitions.workflow, "verified");
  });
});

function nativeFormulaParticipantDsl() {
  const nodes = [
    workflowNode("N1", "generalStart", "startEvent", "Start"),
    {
      ...workflowNode("N2", "review", "manualTask", "Login Review"),
      participants: {
        mode: "person_by_login_name",
        fieldId: "fd_subject",
        fieldTitle: "主题",
        sourceExpression: "$组织架构.根据登录名取用户$($fd_subject$)",
        sourceNameExpression: "$组织架构.根据登录名取用户$($主题$)"
      }
    },
    {
      ...workflowNode("N3", "review", "manualTask", "Department Review"),
      participants: {
        mode: "dept_leader_by_no",
        fieldId: "fd_subject",
        fieldTitle: "主题",
        sourceExpression: "$部门领导.根据部门编号获取部门领导$($fd_subject$)",
        sourceNameExpression: "$部门领导.根据部门编号获取部门领导$($主题$)"
      }
    },
    {
      ...workflowNode("N4", "review", "manualTask", "Creator Review"),
      participants: {
        mode: "doc_creator",
        sourceExpression: "$docCreator$",
        sourceNameExpression: "$docCreator$"
      }
    },
    workflowNode("N5", "generalEnd", "endEvent", "End")
  ];
  return sampleTrustedDsl({
    workflow: {
      process: { id: "native-formula-participants" },
      nodes,
      edges: nodes.slice(0, -1).map((node, index) => ({
        id: `L${index + 1}`,
        source: node.id,
        target: nodes[index + 1].id,
        sourceRef: `source.workflow.edge.L${index + 1}`,
        attributes: {},
        condition: { translationStatus: "executable" }
      })),
      topologicalOrder: nodes.map((node) => node.id)
    }
  });
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
