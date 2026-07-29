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

  it("accepts the native generic-role member shape captured after selecting 直线领导", () => {
    const prepared = prepareSample(nativeGenericRoleParticipantDsl());
    const template = JSON.parse(readFileSync(join(fixtureDir, "form-only-native-readback.json"), "utf8"));
    const workflow = JSON.parse(readFileSync(
      join(fixtureDir, "generic-role-participant-native-workflow.json"),
      "utf8"
    ));
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

  it("verifies independently authored node-history Script handlers and rejects semantic mutations", () => {
    const prepared = prepareSample(nativeNodeHistoryHandlersDsl());
    const template = JSON.parse(readFileSync(join(fixtureDir, "form-only-native-readback.json"), "utf8"));
    const workflow = JSON.parse(readFileSync(
      join(fixtureDir, "node-history-handlers-native-workflow.json"),
      "utf8"
    ));
    const config = xformConfig(template);
    const attr = JSON.parse(config.attribute.formAttr);
    attr.subjectRule = {};
    config.attribute.formAttr = JSON.stringify(attr);
    template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    template.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(workflow);

    const readback = prepared.verify(template);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.partitions.workflow, "verified");

    const mutations = [
      ["referenced node", (rule) => {
        rule.script = rule.script.replace('"N5"', '"N4"');
      }],
      ["history flag", (rule) => {
        rule.script = rule.script.replace("false", "true");
      }],
      ["display content", (rule) => {
        rule.vo.content = rule.vo.content.replace('"N5"', '"N4"');
      }],
      ["display mode", (rule) => {
        rule.vo.mode = "formula";
      }],
      ["organization array result type", (rule) => {
        rule.resultType.type = "object";
      }]
    ];

    for (const [name, mutateRule] of mutations) {
      const mutated = structuredClone(template);
      const content = JSON.parse(mutated.mechanisms.lbpmTemplate[0].fdContent);
      const handlers = content.elements.find((element) => element.id === "N36").handlers;
      const rule = JSON.parse(handlers.ruleKey);
      mutateRule(rule);
      handlers.ruleKey = JSON.stringify(rule);
      mutated.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(content);

      const rejected = prepared.verify(mutated);
      assert.equal(rejected.ok, false, `${name} mutation must fail`);
      assert.equal(
        rejected.diagnostics.some((item) =>
          item.code === "readback.workflow.participant_mismatch"
        ),
        true,
        JSON.stringify(rejected.diagnostics)
      );
    }
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

function nativeGenericRoleParticipantDsl() {
  const nodes = [
    workflowNode("N1", "generalStart", "startEvent", "Start"),
    {
      ...workflowNode("N2", "review", "manualTask", "申请部门负责人"),
      participants: {
        mode: "explicit",
        members: [{
          id: "current-direct-manager-role",
          name: "<直线领导>",
          type: "user_or_org",
          targetOrgType: 32
        }]
      }
    },
    workflowNode("N3", "generalEnd", "endEvent", "End")
  ];
  return sampleTrustedDsl({
    workflow: {
      process: { id: "native-generic-role-participant" },
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
          sourceRef: "source.workflow.edge.L2",
          attributes: {},
          condition: { translationStatus: "executable" }
        }
      ],
      topologicalOrder: nodes.map((node) => node.id)
    }
  });
}

function nativeNodeHistoryHandlersDsl() {
  const nodes = [
    workflowNode("N1", "generalStart", "startEvent", "Start"),
    workflowNode("N4", "draft", "manualTask", "Send-node referenced node"),
    {
      ...workflowNode("N8", "send", "manualTask", "First send reusing N4 handlers"),
      participants: {
        mode: "node_history_handlers",
        nodeId: "N4",
        sourceExpression: '$流程.获取节点实际处理人$("N4")',
        sourceNameExpression: '$流程.获取节点实际处理人$("N4")'
      }
    },
    {
      ...workflowNode("N20", "send", "manualTask", "Second send reusing N4 handlers"),
      participants: {
        mode: "node_history_handlers",
        nodeId: "N4",
        sourceExpression: '$流程.获取节点实际处理人$("N4")',
        sourceNameExpression: '$流程.获取节点实际处理人$("N4")'
      }
    },
    workflowNode("N5", "draft", "manualTask", "Referenced node"),
    {
      ...workflowNode("N36", "review", "manualTask", "Reuse N5 handlers"),
      participants: {
        mode: "node_history_handlers",
        nodeId: "N5",
        sourceExpression: '$流程.获取节点实际处理人$("N5")',
        sourceNameExpression: '$流程.获取节点实际处理人$("N5")'
      }
    },
    workflowNode("N3", "generalEnd", "endEvent", "End")
  ];
  return sampleTrustedDsl({
    workflow: {
      process: { id: "native-node-history-handlers" },
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
