import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { localCorpusIt } from "../helpers/local-corpus.js";
import { persistAndVerify } from "../helpers/persistence.js";
import { sampleForm, sampleTrustedDsl } from "../helpers/sample-dsl.js";

const targetFixture = "tests/fixtures/source/1670297c984b45009eb5b1e444d9957d";

describe("workflow current-native readback", () => {
  it("verifies a conditional branch from its native Batch formula", () => {
    const { readback } = persistAndVerify(branchDsl());

    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.partitions.workflow, "verified");
  });

  it("distinguishes missing and corrupt native branch formulas", () => {
    const missing = persistAndVerify(branchDsl(), {
      mutate(template) {
        const content = workflowContent(template);
        delete edge(content, "L541").formula;
        persistWorkflowContent(template, content);
        return template;
      }
    }).readback;
    assert.equal(missing.ok, false);
    assert.equal(
      missing.diagnostics.some((item) => item.code === "readback.workflow.edge_condition_native_missing"),
      true
    );

    const corrupt = persistAndVerify(branchDsl(), {
      mutate(template) {
        const content = workflowContent(template);
        edge(content, "L541").formula = "{broken-json";
        persistWorkflowContent(template, content);
        return template;
      }
    }).readback;
    assert.equal(corrupt.ok, false);
    assert.equal(
      corrupt.diagnostics.some((item) => item.code === "readback.workflow.edge_condition_native_corrupt"),
      true
    );

    const invalidShape = persistAndVerify(branchDsl(), {
      mutate(template) {
        const content = workflowContent(template);
        edge(content, "L541").formula = JSON.stringify({ type: "Batch" });
        persistWorkflowContent(template, content);
        return template;
      }
    }).readback;
    assert.equal(invalidShape.ok, false);
    assert.equal(
      invalidShape.diagnostics.some((item) => item.code === "readback.workflow.edge_condition_native_corrupt"),
      true
    );
  });

  it("rejects the legacy u0021 condition token in otherwise valid native JSON", () => {
    const { readback } = persistAndVerify(branchDsl(), {
      mutate(template) {
        const content = workflowContent(template);
        const branchEdge = edge(content, "L541");
        const formula = JSON.parse(branchEdge.formula);
        formula.result.value = "u0021${data.$VAR.L541_fd_subject}";
        branchEdge.formula = JSON.stringify(formula);
        persistWorkflowContent(template, content);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.workflow.edge_condition_native_forbidden_literal"),
      true
    );
  });

  it("reports only default ownership when defaultTrend is mutated", () => {
    const { readback } = persistAndVerify(branchDsl(), {
      mutate(template) {
        const content = workflowContent(template);
        edge(content, "L544").defaultTrend = false;
        persistWorkflowContent(template, content);
        return template;
      }
    });
    const edgeDiagnostics = readback.diagnostics.filter((item) =>
      item.invariantKey?.startsWith("workflow.edges.L544")
    );

    assert.deepEqual(edgeDiagnostics.map((item) => item.code), [
      "readback.workflow.edge_default_mismatch"
    ]);
  });

  it("requires a non-empty native rule formula outside a condition branch", () => {
    const dsl = sampleTrustedDsl({
      workflow: {
        process: { id: "rule-edge" },
        nodes: [
          workflowNode("N1", "generalStart", "startEvent", "开始"),
          workflowNode("N2", "generalEnd", "endEvent", "结束")
        ],
        edges: [{
          id: "L1",
          source: "N1",
          target: "N2",
          sourceRef: "source.workflow.edge.L1",
          condition: {
            sourceText: "$fd_subject$ == \"A\"",
            targetText: "$fd_subject$ == \"A\"",
            translationStatus: "executable"
          }
        }],
        topologicalOrder: ["N1", "N2"]
      }
    });
    const { readback } = persistAndVerify(dsl, {
      mutate(template) {
        const content = workflowContent(template);
        edge(content, "L1").formula = "";
        persistWorkflowContent(template, content);
        return template;
      }
    });

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) => item.code === "readback.workflow.edge_condition_native_missing"),
      true
    );
  });

  it("verifies the current native send-node configuration", () => {
    const dsl = sampleTrustedDsl({
      workflow: {
        process: { id: "send-node" },
        nodes: [
          workflowNode("N1", "generalStart", "startEvent", "开始"),
          workflowNode("N2", "send", "manualTask", "抄送"),
          workflowNode("N3", "generalEnd", "endEvent", "结束")
        ],
        edges: [
          workflowEdge("L1", "N1", "N2"),
          workflowEdge("L2", "N2", "N3")
        ],
        topologicalOrder: ["N1", "N2", "N3"]
      }
    });
    const healthy = persistAndVerify(dsl);
    assert.equal(healthy.readback.ok, true, JSON.stringify(healthy.readback.diagnostics));

    const corrupt = persistAndVerify(dsl, {
      mutate(template) {
        const content = workflowContent(template);
        content.elements.find((element) => element.id === "N2").systemNotifyType = "1";
        persistWorkflowContent(template, content);
        return template;
      }
    }).readback;

    assert.equal(corrupt.ok, false);
    assert.equal(
      corrupt.diagnostics.some((item) => item.code === "readback.workflow.send_config_mismatch"),
      true
    );
  });

  localCorpusIt("verifies source 167 projected formulas without condition false failures", () => {
    const sourceDraft = cleanSourceFile(targetFixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const dsl = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "test-reviewer",
      checkedAt: "2026-07-10T00:00:00.000Z"
    });
    const { readback } = persistAndVerify(dsl);

    const conditionDiagnostics = readback.diagnostics.filter((item) =>
      item.code.startsWith("readback.workflow.edge_condition_")
    );
    assert.deepEqual(conditionDiagnostics, []);
  });

  it("writes a native Batch fallback when sibling conditions reference multiple fields", () => {
    const { template, readback } = persistAndVerify(multiFieldDefaultDsl());
    const content = workflowContent(template);
    const fallback = edge(content, "L4");

    assert.equal(fallback.defaultTrend, true);
    assert.equal(fallback.formulaType, "formula");
    const nativeFormula = JSON.parse(fallback.formula);
    assert.equal(nativeFormula.type, "Batch");
    assert.equal(
      nativeFormula.vo.data.fdList[0].fdList[0].fdVarValue,
      "template-id-fd_subject"
    );
    assert.equal(
      readback.diagnostics.some((item) =>
        item.code === "readback.workflow.edge_condition_native_corrupt" &&
        item.path === "/readback/workflow/edges/L4/condition"
      ),
      false
    );
  });
});

function branchDsl() {
  const form = sampleForm();
  form.fields.find((field) => field.id === "fd_subject").title = "主题";
  return sampleTrustedDsl({
    form,
    workflow: {
      process: { id: "condition-branch" },
      nodes: [
        workflowNode("N1", "generalStart", "startEvent", "开始"),
        workflowNode("N410", "conditionBranch", "exclusiveGateway", "主题"),
        workflowNode("N2", "generalEnd", "endEvent", "条件结束"),
        workflowNode("N3", "generalEnd", "endEvent", "默认结束")
      ],
      edges: [
        workflowEdge("L1", "N1", "N410"),
        {
          id: "L541",
          source: "N410",
          target: "N2",
          name: "A",
          sourceRef: "source.workflow.edge.L541",
          condition: {
            sourceText: "\"A\" .equals( $fd_subject$ )",
            displayText: "$主题$ == \"A\"",
            targetText: "\"A\" .equals( $fd_subject$ )",
            translationStatus: "executable"
          },
          attributes: { priority: "1" }
        },
        {
          ...workflowEdge("L544", "N410", "N3"),
          name: "默认",
          attributes: { priority: "2", isDefault: true }
        }
      ],
      topologicalOrder: ["N1", "N410", "N2", "N3"]
    }
  });
}

function multiFieldDefaultDsl() {
  return sampleTrustedDsl({
    workflow: {
      process: { id: "multi-field-default" },
      nodes: [
        workflowNode("N1", "generalStart", "startEvent", "开始"),
        workflowNode("N5", "conditionBranch", "exclusiveGateway", "条件分支"),
        workflowNode("N6", "generalEnd", "endEvent", "开票"),
        workflowNode("N14", "generalEnd", "endEvent", "不开票")
      ],
      edges: [
        workflowEdge("L1", "N1", "N5"),
        {
          id: "L4",
          source: "N5",
          target: "N6",
          name: "开票",
          sourceRef: "source.workflow.edge.L4",
          condition: {
            sourceText: "1==1",
            displayText: "1==1",
            targetText: "1==1",
            translationStatus: "display_only"
          },
          attributes: { priority: "1" }
        },
        {
          id: "L9",
          source: "N5",
          target: "N14",
          name: "不开票",
          sourceRef: "source.workflow.edge.L9",
          condition: {
            sourceText: "$fd_subject$ == \"A\" || $fd_amount$ > 0",
            displayText: "$主题$ == \"A\" || $金额$ > 0",
            targetText: "$fd_subject$ == \"A\" || $fd_amount$ > 0",
            translationStatus: "display_only"
          },
          attributes: { priority: "0" }
        }
      ],
      topologicalOrder: ["N1", "N5", "N6", "N14"]
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

function workflowEdge(id, source, target) {
  return {
    id,
    source,
    target,
    sourceRef: `source.workflow.edge.${id}`,
    attributes: {},
    condition: { translationStatus: "executable" }
  };
}

function workflowContent(template) {
  return JSON.parse(template.mechanisms.lbpmTemplate[0].fdContent);
}

function persistWorkflowContent(template, content) {
  template.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(content);
}

function edge(content, id) {
  return content.elements.find((element) => element.id === id);
}
