import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkDraft } from "../../src/dsl/checks.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { cleanSourceFile, draftSourceDraft, translateSourceFile } from "../../src/translator/index.js";
import { sampleSourceDraft } from "../helpers/sample-dsl.js";

describe("source directory stages", () => {
  it("cleans a paired SysFormTemplate and LbpmProcessDefinition directory into source-only facts", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/19bb55286bd93a6081a33e44c3791374");
    const text = JSON.stringify(sourceDraft);

    assert.equal(sourceDraft.version, "2.0-source-draft");
    assert.equal(sourceDraft.artifact, "source-draft");
    assert.equal(sourceDraft.source.sourceId, "19bb55286bd93a6081a33e44c3791374");
    assert.equal(sourceDraft.form.controls.length, 11);
    assert.equal(sourceDraft.form.detailTables.length, 4);
    assert.equal(sourceDraft.scripts.fragments.length, 8);
    assert.equal(sourceDraft.scripts.sources.length, 2);
    assert.equal(sourceDraft.workflow.nodes.length, 28);
    assert.equal(sourceDraft.workflow.edges.length, 30);
    assert.equal(text.includes("componentId"), false);
    assert.equal(text.includes("mkType"), false);
    assert.equal(text.includes("@elem/"), false);
  });

  it("drafts JSP source scripts into MK script actions for review", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/19bb55286bd93a6081a33e44c3791374");
    const dslDraft = draftSourceDraft(sourceDraft);
    const action = dslDraft.scripts.actions[0];

    assert.equal(dslDraft.scripts.actions.length, 2);
    assert.equal(action.event, "onLoad");
    assert.equal(action.translationStatus, "needs_review");
    assert.equal(action.function.includes("function onLoad(context)"), true);
    assert.equal(action.functionMappings.some((mapping) => mapping.source === "GetXFormFieldById"), true);
  });

  it("drafts fixture row markers and structured native form linkage rules", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/19bb55286bd93a6081a33e44c3791374");
    const dslDraft = draftSourceDraft(sourceDraft);
    const markerRefs = Object.fromEntries(
      dslDraft.form.layout.mkTree
        .filter((row) => Array.isArray(row.sourceMarkers) && row.sourceMarkers.length)
        .flatMap((row) => row.sourceMarkers.map((marker) => [marker, row.children.flatMap((cell) => cell.refIds)]))
    );

    assert.deepEqual(markerRefs.fd_it_row, ["fd_371228ebe5dec2"]);
    assert.deepEqual(markerRefs.fd_proverty_row, ["fd_3712295cc683f8"]);
    assert.deepEqual(markerRefs.fd_weixiu_row, ["fd_371229609fc872"]);
    assert.deepEqual(markerRefs.fd_weibao_row, ["fd_371229626e4df0"]);
    assert.deepEqual(markerRefs.fd_weibao_content_row, ["fd_37122b9411ac06"]);
    assert.deepEqual(markerRefs.fd_budget_from_row, ["fd_37122b6404ad44"]);
    assert.deepEqual(markerRefs.fd_over_budget_row, ["fd_37122b7cb12b7e"]);

    const linkage = dslDraft.formRules.linkage;
    assert.equal(linkage.length, 6);
    assert.equal(dslDraft.formRules.validations.length, 0);
    assert.equal(dslDraft.formRules.impliedRequired.length, 0);
    assert.equal(linkage.every((rule) => rule.translationStatus === "executable"), true);

    const byId = new Map(linkage.map((rule) => [rule.id, rule]));
    assert.deepEqual(byId.get("linkage.fd_371229d0cbd2cc.contains.sb")?.when, [{
      field: "fd_371229d0cbd2cc",
      op: "contains",
      value: "sb"
    }]);
    assert.deepEqual(byId.get("linkage.fd_371229d0cbd2cc.contains.wb")?.effects.map((effect) => [effect.type, effect.target, effect.value]), [
      ["visible", "fd_weibao_row", true],
      ["required", "fd_weibao_row", true],
      ["visible", "fd_weibao_content_row", true],
      ["required", "fd_weibao_content_row", true]
    ]);
    assert.deepEqual(byId.get("linkage.fd_37122a14d44caa.contains.ysn")?.else.map((effect) => [effect.type, effect.target, effect.value]), [
      ["visible", "fd_budget_from_row", false],
      ["required", "fd_budget_from_row", false]
    ]);
  });

  it("extracts designer-only detail table columns when metadata is missing", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/14a08d7d8b8753e20198a5b4223b707e");
    const table = sourceDraft.form.detailTables.find((item) => item.id === "fd_3a0a0a2ce4c5c4");

    assert.deepEqual(table.columns.map((column) => [column.id, column.title, column.sourceType, column.required]), [
      ["fd_3a0a0a3fc896f2", "处理人", "text", true],
      ["fd_3a0a0a43fa1baa", "处理人工号", "text", true],
      ["fd_3a0a0a480caa8a", "处理日期", "dateTime", true],
      ["fd_3a0a0a4d03a53e", "接收单位", "longText", true],
      ["fd_3a0a0a52600a74", "固废类别", "singleSelect", true],
      ["fd_3a0a0a572fb3a6", "固废名称", "longText", true],
      ["fd_3a0a0a5e1860c6", "重量（单位KG）", "text", true]
    ]);
    assert.equal(table.columns.some((column) => column.id === "fdId"), false);
  });

  it("drafts source facts into a non-executable dsl-draft with explicit mkTree", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/route-validation-lbpm");
    const dslDraft = draftSourceDraft(sourceDraft);
    const check = checkDraft(dslDraft);

    assert.equal(dslDraft.artifact, "dsl-draft");
    assert.equal(dslDraft.trust.level, "draft");
    assert.equal(dslDraft.trust.executable, false);
    assert.equal(Array.isArray(dslDraft.review.reviewCandidates), true);
    assert.equal(dslDraft.review.decisions, undefined);
    assert.equal(dslDraft.form.layout.mkTree.length, dslDraft.form.layout.sourceGrid.rows.length);
    assert.equal(check.ok, true);
  });

  it("drafts paired all split and join nodes as executable parallel gateways", () => {
    const dslDraft = draftSourceDraft(sampleSourceDraft({
      workflow: sampleParallelGatewaySourceWorkflow()
    }));
    const split = dslDraft.workflow.nodes.find((node) => node.id === "N2");
    const join = dslDraft.workflow.nodes.find((node) => node.id === "N4");

    assert.equal(split.type, "split");
    assert.equal(split.element, "parallelGateway");
    assert.equal(split.translationStatus, "executable");
    assert.equal(join.type, "join");
    assert.equal(join.element, "parallelGateway");
    assert.equal(join.translationStatus, "executable");
  });

  it("keeps unsupported split and join modes pending review", () => {
    const workflow = sampleParallelGatewaySourceWorkflow();
    workflow.nodes.find((node) => node.id === "N2").definition.attributes.splitType = "any";

    const dslDraft = draftSourceDraft(sampleSourceDraft({ workflow }));
    const split = dslDraft.workflow.nodes.find((node) => node.id === "N2");
    const join = dslDraft.workflow.nodes.find((node) => node.id === "N4");

    assert.equal(split.type, "split");
    assert.equal(split.element, "parallelGateway");
    assert.equal(split.translationStatus, "pending_review");
    assert.equal(join.type, "join");
    assert.equal(join.element, "parallelGateway");
    assert.equal(join.translationStatus, "pending_review");
  });

  it("carries source errors into dsl-draft validation errors", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/route-validation-lbpm");
    sourceDraft.issues.push({
      level: "error",
      code: "source.function_not_whitelisted",
      message: "Unsupported source function.",
      sourcePath: "/fdDesignerHtml",
      evidence: { functionName: "UnknownLegacyFunction" }
    });
    const dslDraft = draftSourceDraft(sourceDraft);
    const check = checkDraft(dslDraft);

    assert.equal(check.ok, false);
    assert.equal(check.diagnostics.some((item) => item.code === "source.function_not_whitelisted"), true);
  });

  it("keeps translate as a clean-plus-draft compatibility shortcut that dry-run rejects", () => {
    const dslDraft = translateSourceFile("tests/fixtures/source/route-validation-lbpm");
    const plan = buildDryRunPlan(dslDraft);

    assert.equal(dslDraft.artifact, "dsl-draft");
    assert.equal(dslDraft.trust.level, "draft");
    assert.equal(plan.ok, false);
    assert.equal(plan.diagnostics.some((item) => item.code === "dsl.trust.trusted_required"), true);
  });
});

function sampleParallelGatewaySourceWorkflow() {
  return {
    process: { id: "process-parallel" },
    nodes: [
      {
        id: "N1",
        sourceType: "startNode",
        name: "开始",
        sourceRef: "source.workflow.node.N1",
        attributes: {},
        incoming: [],
        outgoing: ["L1"]
      },
      {
        id: "N2",
        sourceType: "splitNode",
        name: "并行分支",
        sourceRef: "source.workflow.node.N2",
        attributes: { relatedNodeIds: "N4", x: "100", y: "200" },
        definition: { sourceType: "splitNode", attributes: { splitType: "all", relatedNodeIds: "N4" } },
        incoming: ["L1"],
        outgoing: ["L2"]
      },
      {
        id: "N3",
        sourceType: "reviewNode",
        name: "审批",
        sourceRef: "source.workflow.node.N3",
        attributes: { handlerIds: "handler-1", handlerNames: "审批人" },
        incoming: ["L2"],
        outgoing: ["L3"]
      },
      {
        id: "N4",
        sourceType: "joinNode",
        name: "并行分支",
        sourceRef: "source.workflow.node.N4",
        attributes: { relatedNodeIds: "N2", x: "100", y: "400" },
        definition: { sourceType: "joinNode", attributes: { joinType: "all", relatedNodeIds: "N2" } },
        incoming: ["L3"],
        outgoing: ["L4"]
      },
      {
        id: "N5",
        sourceType: "endNode",
        name: "结束",
        sourceRef: "source.workflow.node.N5",
        attributes: {},
        incoming: ["L4"],
        outgoing: []
      }
    ],
    edges: [
      { id: "L1", sourceRef: "source.workflow.edge.L1", source: "N1", target: "N2", attributes: {} },
      { id: "L2", sourceRef: "source.workflow.edge.L2", source: "N2", target: "N3", attributes: {} },
      { id: "L3", sourceRef: "source.workflow.edge.L3", source: "N3", target: "N4", attributes: {} },
      { id: "L4", sourceRef: "source.workflow.edge.L4", source: "N4", target: "N5", attributes: {} }
    ],
    topologicalOrder: ["N1", "N2", "N3", "N4", "N5"]
  };
}
