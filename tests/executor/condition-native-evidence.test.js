import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/executor/persistence");

describe("native Batch condition evidence", () => {
  it("loads an independently authored Batch condition workflow", () => {
    const prepared = prepareSample(nativeBatchConditionDsl());
    const template = JSON.parse(readFileSync(join(fixtureDir, "form-only-native-readback.json"), "utf8"));
    const workflow = JSON.parse(readFileSync(join(fixtureDir, "batch-conditions-native-workflow.json"), "utf8"));
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

function nativeBatchConditionDsl() {
  const nodes = [
    workflowNode("N1", "generalStart", "startEvent", "Start"),
    workflowNode("N2", "conditionBranch", "exclusiveGateway", "Condition"),
    workflowNode("N3", "generalEnd", "endEvent", "Amount End"),
    workflowNode("N4", "generalEnd", "endEvent", "Never End")
  ];
  return sampleTrustedDsl({
    workflow: {
      process: { id: "native-batch-conditions" },
      nodes,
      edges: [
        {
          id: "L1",
          source: "N1",
          target: "N2",
          sourceRef: "source.workflow.edge.L1",
          attributes: {},
          condition: { translationStatus: "executable" }
        },
        {
          id: "L2",
          source: "N2",
          target: "N3",
          name: "Amount Route",
          sourceRef: "source.workflow.edge.L2",
          attributes: { priority: "1" },
          condition: {
            sourceText: "($fd_subject$+$fd_amount$) < 300000",
            displayText: "($主题$+$金额$) < 300000",
            targetText: "($fd_subject$+$fd_amount$) < 300000",
            translationStatus: "display_only"
          }
        },
        {
          id: "L3",
          source: "N2",
          target: "N4",
          name: "Never Route",
          sourceRef: "source.workflow.edge.L3",
          attributes: { priority: "2" },
          condition: {
            sourceText: "1==2",
            displayText: "1==2",
            targetText: "1==2",
            translationStatus: "display_only"
          }
        }
      ],
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
