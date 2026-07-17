import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkDraft, checkExecute } from "../../src/dsl/checks.js";
import { buildFormRuleRefIndex, resolveEffectTarget } from "../../src/dsl/form-rules.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { classifyWorkflowFormulaParticipant } from "../../src/translator/workflow-formula-participants.js";
import { localCorpusIt } from "../helpers/local-corpus.js";
import { sampleSourceDraft } from "../helpers/sample-dsl.js";

const moduleFormSource = "tests/fixtures/source/module-form-evidence/module-form-evidence_SysFormTemplate.xml";
const moduleDetailColumnsSource = "tests/fixtures/source/module-detail-columns-evidence/module-detail-columns-evidence_SysFormTemplate.xml";
const moduleRightsSource = "tests/fixtures/source/module-rights-evidence";

describe("source directory stages", () => {
  it("preserves nested HTML inside JSP designer controls", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/1927955f6e544383f46970f48468a743");
    const fragment = sourceDraft.scripts.fragments.find((item) => item.id === "fd_3d7f13d18ccc00");

    assert.ok(fragment);
    assert.match(fragment.content, /onclick="buildTableContent\(\)"/);
    assert.match(fragment.content, /function buildTableContent\(\)/);
    assert.equal(sourceDraft.scripts.sources.some((source) =>
      source.fragmentId === fragment.id && source.javascript.includes("function buildTableContent()")
    ), true);
  });

  it("drafts a JSP click control as a native MK button action", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/1927955f6e544383f46970f48468a743");
    const dslDraft = draftSourceDraft(sourceDraft);
    const button = dslDraft.form.fields.find((field) => field.id === "fd_3d7f13d18ccc00");
    const action = dslDraft.scripts.actions.find((item) =>
      item.controlId === button?.id && item.event === "onClick"
    );

    assert.equal(button?.componentId, "xform-button");
    assert.equal(button?.title, "生成部件清单");
    assert.ok(dslDraft.form.layout.mkTree.some((row) =>
      row.children.some((cell) => cell.refIds.includes(button.id))
    ));
    assert.equal(action?.scope, "control");
    assert.equal(action?.translationStatus, "mapped");
    assert.match(action?.function || "", /MKXFORM\.getFormValues\(\)/);
    assert.match(action?.function || "", /formValues\['\$\{table:fd_3d69ce51f013c0\}'\]/);
    assert.match(action?.function || "", /MKXFORM\.deleteRow\('\$\{table:fd_3d69cf2b1acb52\}'\)/);
    assert.match(action?.function || "", /MKXFORM\.addRow\('\$\{table:fd_3d69cf2b1acb52\}'/);
    assert.match(action?.function || "", /fd_model_desc2/);
    assert.match(action?.function || "", /fd_quantity2/);

    const calls = { deleted: [], added: [] };
    const executable = action.function
      .replaceAll("${table:fd_3d69ce51f013c0}", "source_detail")
      .replaceAll("${table:fd_3d69cf2b1acb52}", "target_detail");
    const onClick = Function("MKXFORM", `${executable}; return onClick;`)({
      getFormValues() {
        return {
          source_detail: [
            { fd_model_desc1: "M1", fd_quantity1: 2 },
            { fd_model_desc1: "M2", fd_quantity1: 3 }
          ]
        };
      },
      deleteRow(id) { calls.deleted.push(id); },
      addRow(id, row) { calls.added.push({ id, row }); }
    });
    onClick();
    assert.deepEqual(calls.deleted, ["target_detail"]);
    assert.equal(calls.added.length, 8);
    assert.deepEqual(calls.added[0], {
      id: "target_detail",
      row: {
        fd_model_desc2: "M1",
        fd_quantity2: 2,
        fd_part_type: "STD01",
        fd_part_type2: "STD01"
      }
    });
  });

  it("maps verified node-history leader formulas independently of workflow node ids", () => {
    const sourceExpression = '$组织架构.解释角色线$($流程.获取节点实际处理人$("N654"), "公司级分管领导", "分管领导")';

    assert.deepEqual(classifyWorkflowFormulaParticipant({
      handlerSelectType: "formula",
      handlerIds: sourceExpression,
      handlerNames: sourceExpression
    }), {
      mode: "node_history_superior_department_head",
      nodeId: "N654",
      companyRole: "公司级分管领导",
      departmentRole: "分管领导",
      sourceExpression,
      sourceNameExpression: sourceExpression
    });
  });

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
    assert.equal(sourceDraft.scripts.sources[0].displayGate, "xform:editShow");
    assert.equal(sourceDraft.scripts.sources[1].displayGate, undefined);
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
    const detailActions = dslDraft.scripts.actions.filter((item) =>
      item.tableId === "fd_371228ebe5dec2" && item.controlId === "fd_371576f83b26d8"
    );
    const loadAction = dslDraft.scripts.actions.find((item) => item.event === "onLoad");

    assert.equal(dslDraft.scripts.actions.length, 4);
    assert.equal(action.scope, "control");
    assert.equal(action.event, "onChange");
    assert.equal(action.controlId, "fd_371229d0cbd2cc");
    assert.equal(action.translationStatus, "omitted");
    assert.deepEqual(action.runWhen, { viewStatusIn: ["add", "edit"] });
    assert.equal(action.coverage.status, "covered");
    assert.deepEqual(action.coverage.nativeRules, [
      "linkage.fd_371229d0cbd2cc.contains.sb",
      "linkage.fd_371229d0cbd2cc.contains.hc",
      "linkage.fd_371229d0cbd2cc.contains.wx",
      "linkage.fd_371229d0cbd2cc.contains.wb"
    ]);
    assert.equal(action.functionMappings.some((mapping) => mapping.basis === "native-form-rule"), true);

    assert.equal(detailActions.length, 1);
    assert.equal(detailActions.every((item) => item.scope === "control" && item.event === "onChange"), true);
    assert.equal(detailActions.every((item) => item.translationStatus === "needs_review"), true);
    assert.equal(detailActions.every((item) => item.semanticHints.some((hint) => hint.kind === "detail_row_visibility")), true);
    assert.deepEqual(detailActions.map((item) => item.runWhen), [{ viewStatusIn: ["add", "edit"] }]);
    assert.equal(detailActions[0].recipe.kind, "detail_row_control_state");

    assert.equal(loadAction.scope, "global");
    assert.equal(loadAction.runWhen, undefined);
    assert.equal(loadAction.translationStatus, "needs_review");
    assert.equal(loadAction.semanticHints.some((hint) => hint.kind === "detail_row_load_initialization"), true);
    assert.equal(loadAction.coverage.status, "partial");
    assert.equal(loadAction.recipe.kind, "detail_row_lifecycle");
    assert.equal(sourceDraft.scripts.sources.some((source) => source.semanticFacts?.legacyFunctionCalls?.length), true);
  });

  it("appends source data fields to the DSL without adding layout references", () => {
    const sourceDraft = sampleSourceDraft({
      form: {
        dataFields: [{
          id: "fd_hidden_state",
          title: "隐藏状态",
          sourceType: "text",
          sourceRef: "source.form.dataField.fd_hidden_state",
          sourceProps: { metadataAttributes: { canDisplay: "false" } }
        }]
      }
    });
    const dslDraft = draftSourceDraft(sourceDraft);
    const dataField = dslDraft.form.fields.at(-1);

    assert.equal(dataField.id, "fd_hidden_state");
    assert.equal(dataField.dataOnly, true);
    assert.equal(dataField.componentId, "xform-input");
    assert.equal(
      dslDraft.form.layout.mkTree.some((row) =>
        row.children.some((cell) => cell.refIds.includes("fd_hidden_state"))
      ),
      false
    );
  });

  localCorpusIt("keeps gated legacy attachment runtime omissions from blocking draft checks", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/150a3903e1f12f60503744b400195b75");
    const dslDraft = draftSourceDraft(sourceDraft);
    const result = checkDraft(dslDraft);

    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.scripts.gated_omission_forbidden"), false);
    assert.equal(dslDraft.scripts.actions.some((action) =>
      action.translationStatus === "omitted" &&
      action.runWhen?.viewStatusIn?.includes("edit") &&
      action.functionMappings?.some((mapping) => mapping.basis === "legacy-runtime-noop")
    ), true);
  });

  localCorpusIt("omits standalone JSP helper definitions while keeping callers reviewable", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/149c6e78f7c015f4c7da952411fa0cef");
    const dslDraft = draftSourceDraft(sourceDraft);
    const actions = dslDraft.scripts.actions;

    assert.equal(actions.some((action) =>
      action.translationStatus === "omitted" &&
      action.functionMappings?.some((mapping) => mapping.source === "legacy helper function definitions")
    ), true);
    assert.equal(actions.filter((action) => action.translationStatus === "needs_review").length, 5);
  });

  localCorpusIt("maps the related-leader workflow participant to the configured person fallback", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/19bb55286bd93a6081a33e44c3791374");
    const dslDraft = draftSourceDraft(sourceDraft);
    const nodesById = new Map(dslDraft.workflow.nodes.map((node) => [node.id, node]));

    assert.deepEqual(nodesById.get("N29").participants, {
      mode: "form_field",
      fieldId: "fd_371229badb4b1a",
      sourceFieldId: "fd_371229badb4b1a",
      fieldTitle: "部门固资管理员",
      sourceExpression: "$fd_371229badb4b1a$",
      sourceNameExpression: "$部门固资管理员$"
    });
    assert.equal(nodesById.get("N32").participants.mode, "form_field");
    assert.equal(nodesById.get("N16").participants.mode, "form_field");
    assert.equal(nodesById.get("N53").participants.mode, "configured_person_fallback");
    assert.equal(nodesById.get("N53").participants.fallbackKind, "person");
    assert.equal(nodesById.get("N53").translationStatus, "executable");
  });

  it("keeps incomplete subprocess workflow nodes pending review instead of counting them as process starts", () => {
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
    assert.equal(nodesById.get("N20").type, "startSubProcess");
    assert.equal(nodesById.get("N20").element, "subProcess");
    assert.equal(nodesById.get("N20").translationStatus, "pending_review");
    assert.equal(nodesById.get("N23").sourceType, "recoverSubProcessNode");
    assert.equal(nodesById.get("N23").type, "recoverSubProcess");
    assert.equal(nodesById.get("N23").element, "subProcess");
    assert.equal(nodesById.get("N23").translationStatus, "pending_review");
    assert.equal(check.diagnostics.some((diagnostic) => diagnostic.code === "dsl.workflow.start_node_required"), false);
    assert.equal(check.ok, true);
  });

  localCorpusIt("drafts current handler entities and preserves every non-draft participant selector", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/1670297c984b45009eb5b1e444d9957d");
    const dslDraft = draftSourceDraft(sourceDraft);
    const sourceNodes = new Map(sourceDraft.workflow.nodes.map((node) => [node.id, node]));
    const draftNodes = new Map(dslDraft.workflow.nodes.map((node) => [node.id, node]));

    assert.equal([...sourceNodes.values()].reduce((count, node) => count + (node.handlerEntities?.length || 0), 0), 146);
    assert.equal([...sourceNodes.values()].reduce((count, node) => count + (node.optionalHandlerEntities?.length || 0), 0), 180);

    for (const nodeId of ["N800", "N654"]) {
      assert.equal(sourceNodes.get(nodeId).attributes.handlerIds, "14912dbf4d1b75dc8e6334142da9205a");
      assert.deepEqual(sourceNodes.get(nodeId).handlerEntities, [{
        id: "18ccd439cda358f3c9fcb99495691efb",
        name: "风电工程服务分公司_分管领导",
        orgType: 4,
        class: "com.landray.kmss.sys.organization.model.SysOrgElement",
        parent: "风电工程服务公司领导",
        index: 0
      }]);
      assert.deepEqual(draftNodes.get(nodeId).handlerEntities, sourceNodes.get(nodeId).handlerEntities);
      assert.deepEqual(draftNodes.get(nodeId).participants.members, [{
        name: "风电工程服务分公司_分管领导",
        type: "user_or_org",
        sourceId: "18ccd439cda358f3c9fcb99495691efb",
        sourceOrgType: 4,
        sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgElement",
        sourceParentName: "风电工程服务公司领导"
      }]);
    }

    assert.deepEqual(dslDraft.workflow.process.privilegerEntities.map((entity) => [entity.name, entity.orgType]), [
      ["风电数字化管理部_EKP应用支持", 4],
      ["毛欣昱", 8]
    ]);

    const selectorIds = ["N385", "N810", "N811", "N62"];
    for (const targetNodeId of ["N71", "N812", "N813"]) {
      const node = draftNodes.get(targetNodeId);
      assert.equal(node.participants.mode, "initiator_select");
      assert.deepEqual(node.participantSelections.map((selection) => selection.sourceNodeId), selectorIds);
      assert.equal(node.participantSelections.every((selection) =>
        selection.attribute === "mustModifyHandlerNodeIds" && selection.targetNodeId === targetNodeId
      ), true);
      assert.equal(selectorIds.every((selectorId) => node.participants.sourceSemantics.includes(selectorId)), true);
    }

    const participantSelections = dslDraft.workflow.nodes.flatMap((node) => node.participantSelections || []);
    assert.equal(participantSelections.length, 53);
    assert.equal(participantSelections.filter((selection) => selection.sourceNodeId === "N2").length, 41);
    assert.deepEqual(
      [...new Set(participantSelections.map((selection) => selection.sourceNodeId))],
      ["N2", "N385", "N810", "N811", "N62"]
    );
    assert.equal(draftNodes.get("N71").participants.alternativeMembers.length, 6);
    assert.equal(draftNodes.get("N71").participants.useAlternativeOnly, true);
    assert.equal(draftNodes.get("N812").participants.alternativeMembers.length, 2);
    assert.equal(draftNodes.get("N812").participants.useAlternativeOnly, true);
    assert.equal(draftNodes.get("N813").participants.alternativeMembers.length, 2);
    assert.equal(draftNodes.get("N813").participants.useAlternativeOnly, true);
  });

  localCorpusIt("preserves edit-gate evidence while lowering detail-table linkage to native form rules", () => {
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

    assert.equal(sourceDraft.formRules.linkage.length, 6);
    assert.equal(dslDraft.formRules.linkage.length, 6);
    assert.equal((dslDraft.formRules.review.excludedRules || []).length, 0);
    assert.equal(sourceDraft.formRules.linkage.every((rule) => rule.meta.displayGate === "xform:editShow"), true);
    assert.equal(
      dslDraft.scripts.actions
        .filter((action) => action.sourceRefs.includes("source.form.jsp.fd_37157731108fc2.script.1"))
        .every((action) => action.runWhen?.viewStatusIn.join(",") === "add,edit"),
      true
    );
  });

  it("resolves numbered and legacy-prefixed row markers used by native form linkage rules", () => {
    const dslDraft = draftSourceDraft(sampleSourceDraft({ form: sampleMarkerSourceForm() }));
    const markerRefs = Object.fromEntries(
      dslDraft.form.layout.mkTree
        .filter((row) => Array.isArray(row.sourceMarkers) && row.sourceMarkers.length)
        .flatMap((row) => row.sourceMarkers.map((marker) => [marker, row.children.flatMap((cell) => cell.refIds)]))
    );

    assert.deepEqual(markerRefs.fd_team_row1, ["fd_team"]);

    const refIndex = buildFormRuleRefIndex(dslDraft.form);
    assert.deepEqual(resolveEffectTarget(refIndex, "prefixed_row")?.targets.map((target) => target.id), ["fd_prefixed"]);
    assert.deepEqual(resolveEffectTarget(refIndex, "detail_row")?.targets.map((target) => target.id), ["fd_detail"]);
  });

  it("keeps generated description field ids within the MK 25-character limit", () => {
    const dslDraft = draftSourceDraft(cleanSourceFile(moduleFormSource));
    const attentionRow = dslDraft.form.layout.mkTree.find((row) => row.sourceMarkers?.includes("fd_attention_row"));
    const attentionDescription = dslDraft.form.fields.find((field) => field.type === "description" && field.title === "备注");
    const allFieldIds = dslDraft.form.fields.flatMap((field) => [field.id, ...(field.columns || []).map((column) => column.id)]);

    assert.equal(dslDraft.form.fields.some((field) => field.id === "fd_attention_row__description"), false);
    assert.equal(attentionDescription?.title, "备注");
    assert.equal(attentionDescription?.id.startsWith("fd_desc_"), true);
    assert.deepEqual(attentionRow.children.flatMap((cell) => cell.refIds), [attentionDescription.id]);
    assert.equal(allFieldIds.every((id) => id.length <= 25), true);
  });

  it("maps draft-node handler selection semantics onto empty workflow participants", () => {
    const dslDraft = draftSourceDraft(sampleSourceDraft({ workflow: sampleDraftSelectionSourceWorkflow() }));
    const nodes = new Map(dslDraft.workflow.nodes.map((node) => [node.id, node]));

    assert.deepEqual(nodes.get("N16").participants, {
      mode: "initiator_select",
      sourceSemantics: "draft node N2 canModifyHandlerNodeIds includes N16"
    });
    assert.deepEqual(nodes.get("N7").participants, {
      mode: "initiator_select",
      sourceSemantics: "draft node N2 mustModifyHandlerNodeIds includes N7"
    });
    assert.equal(nodes.get("N9").participants.mode, "explicit");
    assert.equal(nodes.get("N9").participants.members.length > 0, true);
  });

  it("uses structured handler evidence before cached ids and keeps optional handler constraints", () => {
    const sourceDraft = sampleSourceDraft({ workflow: sampleDraftSelectionSourceWorkflow() });
    const sourceNode = sourceDraft.workflow.nodes.find((node) => node.id === "N9");
    sourceNode.attributes = {
      ...sourceNode.attributes,
      handlerIds: "stale-person-id",
      handlerNames: "旧人员缓存",
      optHandlerIds: "stale-optional-id",
      useOptHandlerOnly: "true"
    };
    sourceNode.handlerEntities = [{
      id: "legacy-post-id",
      name: "部门负责人岗位",
      orgType: 4,
      class: "com.landray.kmss.sys.organization.model.SysOrgPost",
      parent: "示例部门",
      index: 0
    }];
    sourceNode.optionalHandlerEntities = [{
      id: "legacy-person-id",
      name: "候选人员",
      orgType: 8,
      class: "com.landray.kmss.sys.organization.model.SysOrgPerson",
      parent: "示例部门",
      index: 0,
      loginName: "000001"
    }];

    const node = draftSourceDraft(sourceDraft).workflow.nodes.find((item) => item.id === "N9");

    assert.deepEqual(node.participants, {
      mode: "explicit",
      members: [{
        name: "部门负责人岗位",
        type: "user_or_org",
        sourceId: "legacy-post-id",
        sourceOrgType: 4,
        sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgPost",
        sourceParentName: "示例部门"
      }],
      alternativeMembers: [{
        name: "候选人员",
        type: "user_or_org",
        sourceId: "legacy-person-id",
        sourceOrgType: 8,
        sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgPerson",
        sourceParentName: "示例部门",
        sourceLoginName: "000001"
      }],
      useAlternativeOnly: true
    });
    assert.equal(node.participants.members[0].id, undefined);
    assert.equal(node.participants.alternativeMembers[0].id, undefined);
  });

  it("does not replace unsupported formula participants with draft-selection fallback", () => {
    for (const { handlerIds, handlerNames } of [
      { handlerIds: "$unsupported(formula)$" },
      {
        handlerIds: '$组织架构.解释角色线$($流程.获取节点实际处理人$("N27"), "未知公司角色", "未知部门角色")',
        handlerNames: '$组织架构.解释角色线$($流程.获取节点实际处理人$("N27"), "未知公司角色", "未知部门角色")'
      },
      { handlerIds: '$组织架构.解释角色线$($fd_subject$, "Company Lead", "Department Lead", "extra")' },
      { handlerIds: '$组织架构.解释角色线$($fd_subject$, $fd_company_role$, "Department Lead")' },
      { handlerIds: '$组织架构.解释角色线$($fd_subject$, "Company" + $fd_role$ + "Lead", "Department Lead")' },
      { handlerIds: '$组织架构.解释角色线$($fd_subject$, "Company Lead", "Department Lead",)' },
      { handlerIds: "$unsupportedParticipant$", handlerNames: "$docCreator$" }
    ]) {
      const dslDraft = draftSourceDraft(sampleSourceDraft({
        workflow: {
          process: { id: "process-handler-formula" },
          nodes: [
            {
              id: "N1",
              sourceType: "draftNode",
              sourceRef: "source.workflow.node.N1",
              attributes: {},
              definition: { attributes: { canModifyHandlerNodeIds: "N2" } }
            },
            {
              id: "N2",
              sourceType: "reviewNode",
              sourceRef: "source.workflow.node.N2",
              attributes: { handlerIds, handlerNames, handlerSelectType: "formula" }
            },
            {
              id: "N3",
              sourceType: "endNode",
              sourceRef: "source.workflow.node.N3",
              attributes: {}
            }
          ],
          edges: [
            { id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1" },
            { id: "L2", source: "N2", target: "N3", sourceRef: "source.workflow.edge.L2" }
          ],
          topologicalOrder: ["N1", "N2", "N3"]
        }
      }));

      const node = dslDraft.workflow.nodes.find((item) => item.id === "N2");
      assert.equal(node.participants.mode, "unmapped_formula", handlerIds);
      assert.equal(node.participants.sourceExpression, handlerIds, handlerIds);
      assert.equal(node.participants.sourceNameExpression, handlerNames || "", handlerIds);
      assert.equal(node.translationStatus, "pending_review", handlerIds);
    }
  });

  it("does not draft script actions for comment-only JSP sources", () => {
    const sourceDraft = cleanSourceFile(moduleFormSource);
    const dslDraft = draftSourceDraft(sourceDraft);

    assert.equal(
      sourceDraft.scripts.sources.some((source) => source.sourceRef === "source.form.jsp.fd_comment_jsp.script.1"),
      true
    );
    assert.equal(dslDraft.form.fields.some((field) => field.id === "fd_blank_row__description"), false);
    assert.equal(dslDraft.form.layout.mkTree.some((row) => row.sourceMarkers?.includes("fd_blank_row")), false);
    assert.equal(
      dslDraft.scripts.actions.some((action) =>
        action.sourceRefs.includes("source.form.jsp.fd_comment_jsp.script.1")
      ),
      false
    );
  });

  it("keeps edit-gated linkage scripts with unmarked row targets in script review", () => {
    const dslDraft = draftSourceDraft(cleanSourceFile(moduleFormSource));
    const action = dslDraft.scripts.actions.find((item) => item.controlId === "fd_trigger");
    const draftCheck = checkDraft(dslDraft);

    assert.deepEqual(dslDraft.formRules.linkage, []);
    assert.equal(dslDraft.formRules.review.excludedRules.length, 1);
    assert.equal(dslDraft.formRules.review.excludedRules[0].code, "form_rule.target_unresolved");
    assert.deepEqual(action.runWhen, { viewStatusIn: ["add", "edit"] });
    assert.deepEqual(action.coverage.nativeRules, []);
    assert.equal(action.coverage.status, "uncovered");
    assert.equal(action.coverage.residuals.some((item) => item.code === "script.residual.form_rule_needs_review"), true);
    assert.equal(draftCheck.ok, true);
  });

  localCorpusIt("uses current root metadata for detail table columns", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/14a08d7d8b8753e20198a5b4223b707e");
    const table = sourceDraft.form.detailTables.find((item) => item.id === "fd_3a0a0a2ce4c5c4");

    assert.deepEqual(table.columns.map((column) => [column.id, column.title, column.sourceType, column.required]), [
      ["fd_3a0a0a3fc896f2", "处理人", "text", true],
      ["fd_3a0a0a43fa1baa", "处理人工号", "text", true],
      ["fd_3a0a0a480caa8a", "处理日期", "date", true],
      ["fd_3a0a0a4d03a53e", "接收单位", "text", true],
      ["fd_3a0a0a52600a74", "固废类别", "singleSelect", true],
      ["fd_3a0a0a572fb3a6", "固废名称", "text", true],
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

  localCorpusIt("keeps hidden persisted helper fields data-only and out of layout", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/14a08d7d8b8753e20198a5b4223b707e");
    const dslDraft = draftSourceDraft(sourceDraft);
    const hiddenHelperIds = ["fd_3a0a08a742981e", "fd_is_qtfy", "fd_is_scq", "fd_is_fwq"];
    const sourceControlIds = sourceDraft.form.controls.map((control) => control.id);
    const sourceDataFieldIds = sourceDraft.form.dataFields.map((field) => field.id);
    const dslFieldsById = new Map(dslDraft.form.fields.map((field) => [field.id, field]));
    const layoutRefs = dslDraft.form.layout.mkTree.flatMap((row) => row.children.flatMap((cell) => cell.refIds));
    const qtfyRow = dslDraft.form.layout.mkTree.find((row) => row.sourceMarkers?.includes("qtfy_row"));
    const fwqRow = dslDraft.form.layout.mkTree.find((row) => row.sourceMarkers?.includes("fwq_row"));
    const fwqDescription = dslDraft.form.fields.find((field) => field.id === "fwq_row__description");

    hiddenHelperIds.forEach((id) => {
      assert.equal(sourceControlIds.includes(id), false);
      assert.equal(sourceDataFieldIds.includes(id), true);
      assert.equal(dslFieldsById.get(id)?.dataOnly, true);
      assert.equal(layoutRefs.includes(id), false);
    });
    assert.deepEqual(qtfyRow.children.flatMap((cell) => cell.refIds), ["fd_3a0a0903d3f91a"]);
    assert.deepEqual(fwqRow.children.flatMap((cell) => cell.refIds), ["fwq_row__description"]);
    assert.equal(fwqDescription.type, "description");
    assert.equal(fwqDescription.props.content.includes("废木质品"), true);
  });

  localCorpusIt("keeps hidden-helper JSP row scripts reviewable after native row-rule lowering", () => {
    const sourceDraft = cleanSourceFile("tests/fixtures/source/14a08d7d8b8753e20198a5b4223b707e");
    const dslDraft = draftSourceDraft(sourceDraft);
    const actionsById = new Map(dslDraft.scripts.actions.map((action) => [action.id, action]));

    assert.equal(sourceDraft.formRules.linkage.length, 1);
    assert.equal(dslDraft.formRules.linkage.length, 1);
    assert.equal(dslDraft.formRules.linkage[0].id, "linkage.fd_376d6cbc433bfe.contains.A");
    assert.equal((dslDraft.formRules.review.excludedRules || []).length, 0);

    const rowRuleAction = actionsById.get("fd_3a0a0882cb93b0.script.1.event.1");
    assert.equal(rowRuleAction.translationStatus, "needs_review");
    assert.equal(rowRuleAction.scope, "control");
    assert.equal(rowRuleAction.event, "onChange");
    assert.equal(rowRuleAction.controlId, "fd_376d6cbc433bfe");
    assert.deepEqual(rowRuleAction.runWhen, { viewStatusIn: ["add", "edit"] });
    assert.equal(rowRuleAction.coverage.status, "partial");
    assert.deepEqual(rowRuleAction.coverage.nativeRules, ["linkage.fd_376d6cbc433bfe.contains.A"]);
    assert.equal(rowRuleAction.coverage.residuals.some((item) => item.code === "script.residual.field_value_assignment"), true);
    assert.equal(rowRuleAction.coverage.residuals.some((item) => item.code === "script.residual.form_rule_needs_review"), false);

    assert.equal(actionsById.get("fd_3a0a0882cb93b0.script.2.event.1").translationStatus, "needs_review");
    assert.equal(actionsById.get("fd_3a0a0882cb93b0.script.2.event.1").runWhen, undefined);
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

  it("drafts a condition split paired with an all join as executable", () => {
    const workflow = sampleParallelGatewaySourceWorkflow();
    workflow.nodes.find((node) => node.id === "N2").definition.attributes.splitType = "condition";

    const dslDraft = draftSourceDraft(sampleSourceDraft({ workflow }));
    assert.equal(dslDraft.workflow.nodes.find((node) => node.id === "N2").translationStatus, "executable");
    assert.equal(dslDraft.workflow.nodes.find((node) => node.id === "N4").translationStatus, "executable");
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

function sampleMarkerSourceForm() {
  return {
    controls: [
      { id: "fd_team", title: "示例团队", sourceType: "text", sourceRef: "source.form.control.fd_team" },
      { id: "fd_prefixed", title: "前缀字段", sourceType: "text", sourceRef: "source.form.control.fd_prefixed" }
    ],
    detailTables: [{
      id: "fd_detail",
      title: "示例明细",
      sourceType: "detailTable",
      sourceRef: "source.form.detailTable.fd_detail",
      columns: [
        { id: "fd_detail_name", title: "名称", sourceType: "text", sourceRef: "source.form.detailTable.fd_detail.column.fd_detail_name" },
        { id: "fd_detail_count", title: "份数", sourceType: "text", sourceRef: "source.form.detailTable.fd_detail.column.fd_detail_count" }
      ]
    }],
    layout: {
      rows: [
        markerRow("row-numbered", "fd_team_row1", "fd_team", "control"),
        markerRow("row-prefixed", "fd_prefixed_row", "fd_prefixed", "control"),
        markerRow("row-detail", "fd_detail_row", "fd_detail", "detailTable")
      ]
    }
  };
}

function markerRow(id, marker, referenceId, referenceType) {
  return {
    id,
    sourceRef: `source.form.layout.row.${id}`,
    sourceMarkers: [marker],
    columns: 1,
    cells: [{
      id: `${id}-cell-0`,
      sourceRef: `source.form.layout.cell.${id}-cell-0`,
      column: 0,
      colspan: 1,
      references: [{ referenceId, referenceType, sourceRef: `source.form.${referenceType}.${referenceId}` }]
    }]
  };
}

function sampleDraftSelectionSourceWorkflow() {
  return {
    process: { id: "process-draft-selection" },
    nodes: [
      {
        id: "N2",
        sourceType: "draftNode",
        sourceRef: "source.workflow.node.N2",
        attributes: {},
        definition: { attributes: { canModifyHandlerNodeIds: "N16;N9", mustModifyHandlerNodeIds: "N7" } }
      },
      { id: "N16", sourceType: "sendNode", sourceRef: "source.workflow.node.N16", attributes: {} },
      { id: "N7", sourceType: "reviewNode", sourceRef: "source.workflow.node.N7", attributes: {} },
      {
        id: "N9",
        sourceType: "sendNode",
        sourceRef: "source.workflow.node.N9",
        attributes: { handlerIds: "handler-1", handlerNames: "示例处理人", handlerSelectType: "org" }
      }
    ],
    edges: [],
    topologicalOrder: ["N2", "N16", "N7", "N9"]
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
