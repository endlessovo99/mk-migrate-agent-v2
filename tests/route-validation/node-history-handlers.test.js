import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectTemplate, verifyTemplate } from "../helpers/persistence.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { classifyWorkflowFormulaParticipant } from "../../src/translator/workflow-formula-participants.js";
import { resolveRouteFixture } from "./fixture.js";
import { runRouteCase } from "./run-route-case.js";

describe("Route-validation node-history handlers", { concurrency: false }, () => {
  it("persists one referenced node's history handlers through native readback", async () => {
    const result = await runRouteCase("node-history-handlers-success");
    const dslNode = result.dsl.workflow.nodes.find((node) => node.id === "N36");
    const nativeNode = result.execution.readback.workflow.nodes.find((node) => node.id === "N36");

    assert.deepEqual(
      {
        mode: dslNode.participants.mode,
        nodeId: dslNode.participants.nodeId,
        status: dslNode.translationStatus
      },
      {
        mode: "node_history_handlers",
        nodeId: "N5",
        status: "executable"
      }
    );
    assert.deepEqual(
      {
        mode: nativeNode.participants.mode,
        nodeId: nativeNode.participants.nodeId
      },
      {
        mode: "node_history_handlers",
        nodeId: "N5"
      }
    );
    for (const nodeId of ["N8", "N20"]) {
      const sendDslNode = result.dsl.workflow.nodes.find((node) => node.id === nodeId);
      const sendNativeNode = result.execution.readback.workflow.nodes.find((node) => node.id === nodeId);

      assert.deepEqual(
        {
          mode: sendDslNode.participants.mode,
          nodeId: sendDslNode.participants.nodeId,
          status: sendDslNode.translationStatus
        },
        {
          mode: "node_history_handlers",
          nodeId: "N4",
          status: "executable"
        }
      );
      assert.deepEqual(
        {
          mode: sendNativeNode.participants.mode,
          nodeId: sendNativeNode.participants.nodeId
        },
        {
          mode: "node_history_handlers",
          nodeId: "N4"
        }
      );
    }
    assert.equal(result.execution.readback.partitions.workflow, "verified");
  });

  it("projects the exact Script contract and rejects a changed referenced node", () => {
    const fixturePath = resolveRouteFixture({
      kind: "paired",
      relativePath: "node-history-handlers"
    });
    const draft = draftSourceDraft(cleanSourceFile(fixturePath));
    const trusted = sampleTrustedDsl({
      template: draft.template,
      form: draft.form,
      workflow: draft.workflow
    });
    const template = projectTemplate(trusted);
    const lbpm = template.mechanisms.lbpmTemplate[0];
    const content = JSON.parse(lbpm.fdContent);
    const node = content.elements.find((element) => element.id === "N36");
    const rule = JSON.parse(node.handlers.ruleKey);

    assert.equal(node.handlerIds, "");
    assert.equal(node.handlerNames, "");
    assert.equal(rule.type, "Script");
    assert.equal(rule.script, 'return ${func.lbpm.getNodeHistoryHandlers}("N5", false)');
    assert.equal(rule.vo.content, 'return #获取节点历史处理人#("N5", false)');
    assert.equal(rule.vo.mode, "script");
    assert.equal(rule.resultType.type, "array");
    assert.equal(JSON.stringify(node).includes("$流程.获取节点实际处理人$"), false);
    for (const nodeId of ["N8", "N20"]) {
      const sendNode = content.elements.find((element) => element.id === nodeId);
      const sendRule = JSON.parse(sendNode.handlers.ruleKey);
      assert.equal(sendNode.type, "send");
      assert.equal(sendRule.script, 'return ${func.lbpm.getNodeHistoryHandlers}("N4", false)');
      assert.equal(sendRule.vo.content, 'return #获取节点历史处理人#("N4", false)');
      assert.equal(sendRule.resultType.type, "array");
    }
    assert.equal(verifyTemplate(trusted, template).ok, true);

    rule.script = 'return ${func.lbpm.getNodeHistoryHandlers}("N4", false)';
    node.handlers.ruleKey = JSON.stringify(rule);
    lbpm.fdContent = JSON.stringify(content);

    const mutated = verifyTemplate(trusted, template);
    assert.equal(mutated.ok, false);
    assert.equal(
      mutated.diagnostics.some((item) => item.code === "readback.workflow.participant_mismatch"),
      true
    );
  });

  it("keeps wrappers, aggregation, mismatched evidence, and missing nodes fail-closed", () => {
    const directN4 = '$流程.获取节点实际处理人$("N4")';
    assert.deepEqual(
      classifyWorkflowFormulaParticipant({
        handlerSelectType: "formula",
        handlerIds: directN4,
        handlerNames: directN4
      }),
      {
        mode: "node_history_handlers",
        nodeId: "N4",
        sourceExpression: directN4,
        sourceNameExpression: directN4
      }
    );

    const unsupported = [
      {
        handlerIds: '$流程.获取节点实际处理人$("N5")',
        handlerNames: '$流程.获取节点实际处理人$("N4")'
      },
      {
        handlerIds: '$流程.获取节点实际处理人$("N5").get(0)',
        handlerNames: '$流程.获取节点实际处理人$("N5").get(0)'
      },
      {
        handlerIds: 'return $流程.获取节点实际处理人$("N5");',
        handlerNames: 'return $流程.获取节点实际处理人$("N5");'
      },
      {
        handlerIds: 'List values = new ArrayList(); values.add($流程.获取节点实际处理人$("N4").get(0)); return values',
        handlerNames: 'List values = new ArrayList(); values.add($流程.获取节点实际处理人$("N4").get(0)); return values'
      }
    ];
    for (const attributes of unsupported) {
      assert.equal(
        classifyWorkflowFormulaParticipant({
          handlerSelectType: "formula",
          ...attributes
        }).mode,
        "unmapped_formula"
      );
    }

    const fixturePath = resolveRouteFixture({
      kind: "paired",
      relativePath: "node-history-handlers"
    });
    const source = cleanSourceFile(fixturePath);
    const sourceNode = source.workflow.nodes.find((node) => node.id === "N36");
    for (const attributes of [sourceNode.attributes, sourceNode.definition?.attributes].filter(Boolean)) {
      attributes.handlerIds = '$流程.获取节点实际处理人$("N404")';
      attributes.handlerNames = '$流程.获取节点实际处理人$("N404")';
    }
    const draft = draftSourceDraft(source);
    const dslNode = draft.workflow.nodes.find((node) => node.id === "N36");
    const validation = validateMigrationDsl(draft, { mode: "draft" });

    assert.equal(dslNode.participants.mode, "node_history_handlers");
    assert.equal(dslNode.translationStatus, "pending_review");
    assert.equal(validation.ok, false);
    assert.equal(
      validation.diagnostics.some((item) =>
        item.code === "workflow.participants.node_history_node_missing"
      ),
      true
    );
  });
});
