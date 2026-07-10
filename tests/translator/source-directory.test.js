import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkDraft, checkExecute } from "../../src/dsl/checks.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { localCorpusIt } from "../helpers/local-corpus.js";
import { sampleSourceDraft } from "../helpers/sample-dsl.js";

const moduleDetailColumnsSource = "tests/fixtures/source/module-detail-columns-evidence/module-detail-columns-evidence_SysFormTemplate.xml";
const moduleRightsSource = "tests/fixtures/source/module-rights-evidence";

describe("source directory stages", () => {
  localCorpusIt("cleans a paired SysFormTemplate and LbpmProcessDefinition directory into source-only facts", () => {
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

  localCorpusIt("drafts JSP source scripts into MK script actions for review", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/19bb55286bd93a6081a33e44c3791374");
    const dslDraft = draftSourceDraft(sourceDraft);
    const action = dslDraft.scripts.actions.find((item) => item.controlId === "fd_371229d0cbd2cc");
    const detailAction = dslDraft.scripts.actions.find((item) =>
      item.tableId === "fd_371228ebe5dec2" && item.controlId === "fd_371576f83b26d8"
    );
    const loadAction = dslDraft.scripts.actions.find((item) => item.event === "onLoad");

    assert.equal(dslDraft.scripts.actions.length, 4);
    assert.equal(action.scope, "control");
    assert.equal(action.event, "onChange");
    assert.equal(action.controlId, "fd_371229d0cbd2cc");
    assert.equal(action.translationStatus, "needs_review");
    assert.equal(action.coverage.status, "covered");
    assert.equal(action.functionMappings.some((mapping) => mapping.source === "GetXFormFieldById"), true);

    assert.equal(detailAction.scope, "control");
    assert.equal(detailAction.event, "onChange");
    assert.equal(detailAction.tableId, "fd_371228ebe5dec2");
    assert.equal(detailAction.controlId, "fd_371576f83b26d8");
    assert.equal(detailAction.translationStatus, "needs_review");
    assert.equal(detailAction.semanticHints.some((hint) => hint.kind === "detail_row_visibility"), true);
    assert.deepEqual(detailAction.coverage, { status: "none", nativeRules: [], residuals: [] });

    assert.equal(loadAction.scope, "global");
    assert.equal(loadAction.translationStatus, "needs_review");
    assert.equal(loadAction.semanticHints.some((hint) => hint.kind === "detail_row_load_initialization"), true);
    assert.equal(loadAction.coverage.status, "uncovered");
    assert.equal(sourceDraft.scripts.sources.some((source) => source.semanticFacts?.legacyFunctionCalls?.length), true);
  });

  localCorpusIt("drafts simple form-field formula workflow participants as executable handlers", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/19bb55286bd93a6081a33e44c3791374");
    const dslDraft = draftSourceDraft(sourceDraft);
    const nodesById = new Map(dslDraft.workflow.nodes.map((node) => [node.id, node]));

    assert.deepEqual(nodesById.get("N29").participants, {
      mode: "form_field",
      fieldId: "fd_371229badb4b1a",
      fieldTitle: "部门固资管理员",
      sourceExpression: "$fd_371229badb4b1a$",
      sourceNameExpression: "$部门固资管理员$"
    });
    assert.equal(nodesById.get("N32").participants.mode, "form_field");
    assert.equal(nodesById.get("N16").participants.mode, "form_field");
    assert.deepEqual(nodesById.get("N53").participants, {
      mode: "role_line",
      fieldId: "fd_371229badb4b1a",
      fieldTitle: "部门固资管理员",
      companyRole: "公司级相关领导",
      departmentRole: "部门相关领导",
      sourceExpression: "$组织架构.解释角色线$($fd_371229badb4b1a$, \"公司级相关领导\", \"部门相关领导\")",
      sourceNameExpression: "$组织架构.解释角色线$($部门固资管理员$, \"公司级相关领导\", \"部门相关领导\")"
    });
  });

  it("keeps subprocess workflow nodes pending review instead of counting them as process starts", () => {
    const sourceDraft = sampleSourceDraft({
      form: sampleSingleFieldSourceForm(),
      workflow: sampleSubprocessSourceWorkflow()
    });
    const dslDraft = draftSourceDraft(sourceDraft);
    const check = checkDraft(dslDraft);
    const nodesById = new Map(dslDraft.workflow.nodes.map((node) => [node.id, node]));

    assert.deepEqual(
      dslDraft.workflow.nodes
        .filter((node) => node.element === "startEvent")
        .map((node) => [node.id, node.sourceType]),
      [["N1", "startNode"]]
    );
    assert.equal(nodesById.get("N20").sourceType, "startSubProcessNode");
    assert.equal(nodesById.get("N20").translationStatus, "pending_review");
    assert.equal(nodesById.get("N23").sourceType, "recoverSubProcessNode");
    assert.equal(nodesById.get("N23").translationStatus, "pending_review");
    assert.equal(check.diagnostics.some((diagnostic) => diagnostic.code === "dsl.workflow.start_node_required"), false);
    assert.equal(check.ok, true);
  });

  localCorpusIt("drafts fixture row markers and structured native form linkage rules", () => {
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

  localCorpusIt("extracts designer-only detail table columns when metadata is missing", () => {
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

  it("keeps designer detail columns when matching metadata table has no columns", () => {
    const sourceDraft = cleanSourceFile(moduleDetailColumnsSource);
    const table = sourceDraft.form.detailTables.find((item) => item.id === "fd_detail");
    const dslDraft = draftSourceDraft(sourceDraft);
    const dslTable = dslDraft.form.fields.find((item) => item.id === "fd_detail");
    const check = checkDraft(dslDraft);

    assert.deepEqual(table.columns.map((column) => [column.id, column.title, column.sourceType, column.required]), [
      ["fd_detail_name", "名称", "text", true],
      ["fd_detail_count", "份数", "text", true]
    ]);
    assert.deepEqual(dslTable.columns.map((column) => [column.id, column.title, column.type, column.props.required]), [
      ["fd_detail_name", "名称", "text", true],
      ["fd_detail_count", "份数", "text", true]
    ]);
    assert.equal(check.diagnostics.some((diagnostic) => diagnostic.code === "dsl.detail_table.columns_required"), false);
  });

  localCorpusIt("maps legacy creator default expressions into DSL context defaults", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/14a08d7d8b8753e20198a5b4223b707e");
    const dslDraft = draftSourceDraft(sourceDraft);
    const fieldsById = new Map(dslDraft.form.fields.map((field) => [field.id, field]));
    const processTable = fieldsById.get("fd_3a0a0a2ce4c5c4");
    const processUser = processTable.columns.find((column) => column.id === "fd_3a0a0a3fc896f2");

    assert.equal(sourceDraft.issues.some((issue) => issue.code === "source.function_not_whitelisted" && issue.evidence?.functionName === "$.getFdName"), false);
    assert.deepEqual(fieldsById.get("fd_325c0266a887c4").props.defaultValue, {
      kind: "context",
      source: "creator",
      property: "fdName"
    });
    assert.deepEqual(fieldsById.get("fd_36b983442aa544").props.defaultValue, {
      kind: "context",
      source: "creatorDept",
      property: "fdName"
    });
    assert.deepEqual(processUser.props.defaultValue, {
      kind: "context",
      source: "creator"
    });
  });

  localCorpusIt("keeps hidden designer helper fields out of generated form components", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/14a08d7d8b8753e20198a5b4223b707e");
    const dslDraft = draftSourceDraft(sourceDraft);
    const hiddenHelperIds = ["fd_3a0a08a742981e", "fd_is_qtfy", "fd_is_fwq"];
    const sourceControlIds = sourceDraft.form.controls.map((control) => control.id);
    const dslFieldIds = dslDraft.form.fields.map((field) => field.id);
    const layoutRefs = dslDraft.form.layout.mkTree.flatMap((row) => row.children.flatMap((cell) => cell.refIds));
    const qtfyRow = dslDraft.form.layout.mkTree.find((row) => row.sourceMarkers?.includes("qtfy_row"));
    const fwqRow = dslDraft.form.layout.mkTree.find((row) => row.sourceMarkers?.includes("fwq_row"));
    const fwqDescription = dslDraft.form.fields.find((field) => field.id === "fwq_row__description");

    hiddenHelperIds.forEach((id) => {
      assert.equal(sourceControlIds.includes(id), false);
      assert.equal(dslFieldIds.includes(id), false);
      assert.equal(layoutRefs.includes(id), false);
    });
    assert.deepEqual(qtfyRow.children.flatMap((cell) => cell.refIds), ["fd_3a0a0903d3f91a"]);
    assert.deepEqual(fwqRow.children.flatMap((cell) => cell.refIds), ["fwq_row__description"]);
    assert.equal(fwqDescription.type, "description");
    assert.equal(fwqDescription.props.content.includes("废木质品"), true);
  });

  localCorpusIt("keeps hidden-helper JSP row scripts reviewable after extracting native row rule evidence", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/14a08d7d8b8753e20198a5b4223b707e");
    const dslDraft = draftSourceDraft(sourceDraft);
    const rule = dslDraft.formRules.linkage.find((item) => item.id === "linkage.fd_376d6cbc433bfe.contains.A");
    const actionsById = new Map(dslDraft.scripts.actions.map((action) => [action.id, action]));

    assert.deepEqual(rule.effects.map((effect) => [effect.type, effect.target, effect.value]), [
      ["visible", "qtfy_row", true],
      ["required", "qtfy_row", true],
      ["visible", "scq_row", true],
      ["required", "scq_row", true],
      ["visible", "fwq_row", true],
      ["required", "fwq_row", true]
    ]);
    assert.deepEqual(rule.else.map((effect) => [effect.type, effect.target, effect.value]), [
      ["visible", "qtfy_row", false],
      ["required", "qtfy_row", false],
      ["visible", "scq_row", false],
      ["required", "scq_row", false],
      ["visible", "fwq_row", false],
      ["required", "fwq_row", false]
    ]);

    const rowRuleAction = actionsById.get("fd_3a0a0882cb93b0.script.1.event.1");
    assert.equal(rowRuleAction.translationStatus, "needs_review");
    assert.equal(rowRuleAction.scope, "control");
    assert.equal(rowRuleAction.event, "onChange");
    assert.equal(rowRuleAction.controlId, "fd_376d6cbc433bfe");
    assert.equal(rowRuleAction.coverage.status, "partial");
    assert.deepEqual(rowRuleAction.coverage.nativeRules, ["linkage.fd_376d6cbc433bfe.contains.A"]);
    assert.equal(rowRuleAction.coverage.residuals.length > 0, true);

    assert.equal(actionsById.get("fd_3a0a0882cb93b0.script.2.event.1").translationStatus, "needs_review");
    assert.equal(actionsById.get("fd_3a0a0882cb93b0.script.2.event.1").coverage.status, "uncovered");
    assert.equal(dslDraft.scripts.actions.every((action) => action.translationStatus === "needs_review"), true);
    assert.equal(actionsById.has("fd_3a0a08bd180e76.script.1.event.1"), false);
    assert.equal(
      dslDraft.scripts.warnings.some((warning) =>
        warning.code === "script.control_unresolved" &&
        warning.controlId === "fd_seal_type" &&
        warning.sourceRefs.includes("source.form.jsp.fd_3a0a08bd180e76.script.1")
      ),
      true
    );

    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "test-reviewer",
      checkedAt: "2026-07-08T00:00:00.000Z"
    });
    const executeCheck = checkExecute(trusted);
    assert.equal(executeCheck.diagnostics.filter((item) => item.code === "dsl.scripts.needs_review").length > 0, true);
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

  it("allows non-whitelisted source functions through draft as warnings", () => {
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

    assert.equal(check.ok, true);
    assert.equal(check.diagnostics.some((item) => item.level === "warning" && item.code === "source.function_not_whitelisted"), true);
  });

  it("drafts legacy right sections into node field data authority", () => {
    const sourceDraft = cleanSourceFile(moduleRightsSource);
    const sourceNode = sourceDraft.workflow.nodes.find((node) => node.id === "N2");
    const dslDraft = draftSourceDraft(sourceDraft);
    const node = dslDraft.workflow.nodes.find((item) => item.id === "N2");

    assert.deepEqual(Object.keys(sourceNode.dataAuthority.fields), ["fd_private_note"]);
    assert.deepEqual(Object.keys(node.dataAuthority.fields), ["fd_private_note"]);
    assert.deepEqual(node.dataAuthority.fields.fd_private_note, {
      visible: false,
      editable: false,
      required: false,
      sourceMode: "hidden",
      sourceRef: "source.form.dataAuthority.fdDesignerHtml.right_section.N2.fd_private_note"
    });
    assert.equal(
      sourceDraft.issues.some((issue) => issue.code?.startsWith("source.form_right.")),
      false
    );
  });
});

function sampleSubprocessSourceWorkflow() {
  return {
    process: { id: "process-subprocess-evidence" },
    nodes: [
      { id: "N1", sourceType: "startNode", sourceRef: "source.workflow.node.N1", attributes: {} },
      { id: "N20", sourceType: "startSubProcessNode", sourceRef: "source.workflow.node.N20", attributes: {} },
      { id: "N23", sourceType: "recoverSubProcessNode", sourceRef: "source.workflow.node.N23", attributes: {} },
      { id: "N4", sourceType: "endNode", sourceRef: "source.workflow.node.N4", attributes: {} }
    ],
    edges: [
      { id: "L1", source: "N1", target: "N20", sourceRef: "source.workflow.edge.L1" },
      { id: "L2", source: "N20", target: "N23", sourceRef: "source.workflow.edge.L2" },
      { id: "L3", source: "N23", target: "N4", sourceRef: "source.workflow.edge.L3" }
    ],
    topologicalOrder: ["N1", "N20", "N23", "N4"]
  };
}

function sampleSingleFieldSourceForm() {
  return {
    controls: [{
      id: "fd_subject",
      title: "主题",
      sourceType: "text",
      required: true,
      sourceRef: "source.form.control.fd_subject"
    }],
    detailTables: [],
    layout: {
      rows: [{
        id: "row-subject",
        sourceRef: "source.form.layout.row.row-subject",
        columns: 1,
        cells: [{
          id: "row-subject-cell-0",
          sourceRef: "source.form.layout.cell.row-subject-cell-0",
          column: 0,
          colspan: 1,
          references: [{
            referenceId: "fd_subject",
            referenceType: "control",
            sourceRef: "source.form.control.fd_subject"
          }]
        }]
      }]
    }
  };
}

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
