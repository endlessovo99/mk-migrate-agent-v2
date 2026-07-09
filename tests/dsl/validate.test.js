import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { sampleDraftDsl, sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("validateMigrationDsl", () => {
  it("accepts the sample trusted migration DSL", () => {
    const result = validateMigrationDsl(sampleTrustedDsl(), { mode: "execute" });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.diagnostics, []);
  });

  it("accepts a non-executable dsl-draft only at the draft boundary", () => {
    const draft = sampleDraftDsl();
    const draftCheck = validateMigrationDsl(draft, { mode: "draft" });
    const executeCheck = validateMigrationDsl(draft, { mode: "execute" });

    assert.equal(draftCheck.ok, true);
    assert.equal(draftCheck.status, "ok");
    assert.equal(executeCheck.ok, false);
    assert.equal(executeCheck.diagnostics.some((item) => item.code === "dsl.trust.trusted_required"), true);
  });

  it("rejects missing template names", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({ template: { name: "" } }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.template.name_required"), true);
  });

  it("rejects unknown components, unknown props, invalid prop values, and unsupported functions", () => {
    const dsl = sampleTrustedDsl({
      form: {
        fields: [
          {
            id: "fd_subject",
            title: "主题",
            type: "longText",
            componentId: "xform-textarea",
            props: { maxLength: 0, unknownProp: true },
            sourceProps: {},
            sourceRef: "source.form.control.fd_subject"
          },
          {
            id: "fd_detail",
            title: "明细",
            type: "detailTable",
            componentId: "xform-detail-table",
            props: {},
            sourceProps: {},
            sourceRef: "source.form.detailTable.fd_detail",
            columns: [
              {
                id: "fd_name",
                title: "名称",
                type: "text",
                componentId: "xform-not-real",
                props: {},
                sourceProps: {},
                sourceRef: "source.form.detailTable.fd_detail.column.fd_name"
              }
            ]
          }
        ]
      },
      review: {
        warnings: [],
        decisions: [],
        functionWhitelist: {
          violations: [{ name: "UnknownLegacyFunction", occurrences: [] }]
        }
      }
    });
    const result = validateMigrationDsl(dsl, { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === "catalog.props.unknown"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "catalog.props.value_invalid"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "catalog.component_unknown"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "catalog.function_unsupported"), true);
  });

  it("rejects trusted layouts without mkTree and invalid child references", () => {
    const missingTree = validateMigrationDsl(sampleTrustedDsl({ form: { layout: { mkTree: [] } } }), { mode: "execute" });
    const missingField = validateMigrationDsl(sampleTrustedDsl({
      form: {
        layout: {
          mkTree: [{
            id: "layout.row-0",
            componentId: "xform-flex-1-1-layout",
            props: { columns: 1 },
            sourceRef: "source.form.layout.row.row-0",
            children: [{ id: "child", refType: "field", refIds: ["fd_missing"], sourceRef: "source.form.layout.cell.row-0-cell-0" }]
          }]
        }
      }
    }), { mode: "execute" });

    assert.equal(missingTree.ok, false);
    assert.equal(missingTree.diagnostics.some((item) => item.code === "dsl.form.layout.mk_tree_required"), true);
    assert.equal(missingField.ok, false);
    assert.equal(missingField.diagnostics.some((item) => item.code === "dsl.form.layout.field_missing"), true);
  });

  it("requires JSP script actions to be reviewed before execution", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({
      scripts: {
        actions: [{
          id: "fd_jsp.script.1",
          name: "onLoad",
          event: "onLoad",
          function: "function onLoad(context) {}",
          translationStatus: "needs_review"
        }]
      }
    }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.scripts.needs_review"), true);
  });

  it("accepts supported global after-submit scripts and blocks DOM-based mapped scripts", () => {
    const accepted = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [{
          id: "after-submit.1",
          name: "onAfterSubmit",
          event: "onAfterSubmit",
          scope: "global",
          function: "function onAfterSubmit() {\n  MKXFORM.setValue('fd_subject', 'done')\n}",
          translationStatus: "mapped",
          coverage: { status: "none", nativeRules: [], residuals: [] },
          functionMappings: []
        }]
      }
    }), { mode: "execute" });
    const rejected = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [{
          id: "change.1",
          name: "onChange",
          event: "onChange",
          scope: "control",
          controlId: "fd_subject",
          function: "function onChange(value) {\n  document.getElementById('fd_subject').value = value\n}",
          translationStatus: "mapped",
          coverage: { status: "none", nativeRules: [], residuals: [] },
          functionMappings: []
        }]
      }
    }), { mode: "execute" });

    assert.equal(accepted.ok, true);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.diagnostics.some((item) => item.code === "dsl.scripts.dom_api_forbidden"), true);
  });

  it("accepts detail-table onChange scripts that use row-scoped MK style APIs", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [{
          id: "fd_detail.fd_name.onChange.1",
          name: "onChange",
          event: "onChange",
          scope: "control",
          tableId: "fd_detail",
          controlId: "fd_name",
          function: "function onChange(value, rowNum, parentRowNum) {\n  MKXFORM.updateControlStyle(\"${table:fd_detail}.fd_name\", rowNum, { display: value === \"gh\" ? \"block\" : \"none\" })\n}",
          translationStatus: "mapped",
          coverage: { status: "none", nativeRules: [], residuals: [] },
          functionMappings: []
        }]
      }
    }), { mode: "execute" });

    assert.equal(result.ok, true);
    assert.deepEqual(result.diagnostics, []);
  });

  it("requires before-submit scripts to handle draft saves and return explicitly", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({
      workflow: undefined,
      scripts: {
        actions: [{
          id: "before-submit.1",
          name: "onBeforeSubmit",
          event: "onBeforeSubmit",
          scope: "global",
          function: "function onBeforeSubmit(context) {\n  MKXFORM.validateFields()\n}",
          translationStatus: "mapped",
          coverage: { status: "none", nativeRules: [], residuals: [] },
          functionMappings: []
        }]
      }
    }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.scripts.before_submit_return_required"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.scripts.before_submit_draft_guard_required"), true);
  });

  it("rejects executable form linkage rules with unresolved condition fields or effect targets", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({
      formRules: {
        linkage: [
          {
            id: "linkage.missing.condition",
            trigger: "change",
            source: "fd_missing",
            logic: "and",
            when: [{ field: "fd_missing", op: "contains", value: "A" }],
            effects: [{ type: "visible", target: "fd_subject", value: true }],
            else: [{ type: "visible", target: "fd_subject", value: false }],
            translationStatus: "executable"
          },
          {
            id: "linkage.missing.target",
            trigger: "change",
            source: "fd_subject",
            logic: "and",
            when: [{ field: "fd_subject", op: "eq", value: "A" }],
            effects: [{ type: "required", target: "fd_missing_row", value: true }],
            else: [{ type: "required", target: "fd_missing_row", value: false }],
            translationStatus: "executable"
          }
        ],
        validations: [],
        impliedRequired: [],
        review: {}
      }
    }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.form_rules.condition_field_unresolved"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.form_rules.effect_target_unresolved"), true);
  });

  it("rejects invalid workflow DAGs and initiator selection without source semantics", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({
      workflow: {
        nodes: [
          { id: "N1", type: "generalStart", element: "startEvent", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
          { id: "N2", type: "review", element: "manualTask", sourceRef: "source.workflow.node.N2", attributes: {}, participants: { mode: "initiator_select" }, translationStatus: "executable" },
          { id: "N3", type: "generalEnd", element: "endEvent", sourceRef: "source.workflow.node.N3", attributes: {}, translationStatus: "executable" }
        ],
        edges: [{ id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1", condition: { translationStatus: "executable" } }],
        topologicalOrder: ["N1", "N2", "N3"]
      }
    }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.workflow.node_cannot_reach_end"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "workflow.participants.initiator_select_without_source"), true);
  });

  it("accepts form-field workflow participants only when the field exists", () => {
    const workflow = {
      process: { id: "process-form-field-handler" },
      nodes: [
        { id: "N1", type: "generalStart", element: "startEvent", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
        {
          id: "N2",
          type: "review",
          element: "manualTask",
          sourceRef: "source.workflow.node.N2",
          attributes: { handlerIds: "$fd_subject$", handlerNames: "$主题$", handlerSelectType: "formula" },
          participants: {
            mode: "form_field",
            fieldId: "fd_subject",
            fieldTitle: "主题",
            sourceExpression: "$fd_subject$",
            sourceNameExpression: "$主题$"
          },
          translationStatus: "executable"
        },
        { id: "N3", type: "generalEnd", element: "endEvent", sourceRef: "source.workflow.node.N3", attributes: {}, translationStatus: "executable" }
      ],
      edges: [
        { id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1", condition: { translationStatus: "executable" } },
        { id: "L2", source: "N2", target: "N3", sourceRef: "source.workflow.edge.L2", condition: { translationStatus: "executable" } }
      ],
      topologicalOrder: ["N1", "N2", "N3"]
    };
    const accepted = validateMigrationDsl(sampleTrustedDsl({ workflow }), { mode: "execute" });
    const rejected = validateMigrationDsl(sampleTrustedDsl({
      workflow: {
        ...workflow,
        nodes: workflow.nodes.map((node) => node.id === "N2"
          ? { ...node, participants: { ...node.participants, fieldId: "fd_missing", sourceExpression: "$fd_missing$" } }
          : node)
      }
    }), { mode: "execute" });

    assert.equal(accepted.ok, true);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.diagnostics.some((item) => item.code === "workflow.participants.form_field_missing"), true);
  });

  it("accepts role-line workflow participants only when the field exists", () => {
    const workflow = {
      process: { id: "process-role-line-handler" },
      nodes: [
        { id: "N1", type: "generalStart", element: "startEvent", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
        {
          id: "N2",
          type: "review",
          element: "manualTask",
          sourceRef: "source.workflow.node.N2",
          attributes: {
            handlerIds: "$组织架构.解释角色线$($fd_subject$, \"公司级部门领导\", \"部门领导\")",
            handlerNames: "$组织架构.解释角色线$($主题$, \"公司级部门领导\", \"部门领导\")",
            handlerSelectType: "formula"
          },
          participants: {
            mode: "role_line",
            fieldId: "fd_subject",
            fieldTitle: "主题",
            companyRole: "公司级部门领导",
            departmentRole: "部门领导",
            sourceExpression: "$组织架构.解释角色线$($fd_subject$, \"公司级部门领导\", \"部门领导\")",
            sourceNameExpression: "$组织架构.解释角色线$($主题$, \"公司级部门领导\", \"部门领导\")"
          },
          translationStatus: "executable"
        },
        { id: "N3", type: "generalEnd", element: "endEvent", sourceRef: "source.workflow.node.N3", attributes: {}, translationStatus: "executable" }
      ],
      edges: [
        { id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1", condition: { translationStatus: "executable" } },
        { id: "L2", source: "N2", target: "N3", sourceRef: "source.workflow.edge.L2", condition: { translationStatus: "executable" } }
      ],
      topologicalOrder: ["N1", "N2", "N3"]
    };
    const accepted = validateMigrationDsl(sampleTrustedDsl({ workflow }), { mode: "execute" });
    const rejected = validateMigrationDsl(sampleTrustedDsl({
      workflow: {
        ...workflow,
        nodes: workflow.nodes.map((node) => node.id === "N2"
          ? { ...node, participants: { ...node.participants, fieldId: "fd_missing", sourceExpression: "$组织架构.解释角色线$($fd_missing$, \"公司级部门领导\", \"部门领导\")" } }
          : node)
      }
    }), { mode: "execute" });

    assert.equal(accepted.ok, true);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.diagnostics.some((item) => item.code === "workflow.participants.role_line_field_missing"), true);
  });

  it("accepts executable all parallel split and join gateways", () => {
    const result = validateMigrationDsl(sampleTrustedDsl({
      workflow: sampleParallelGatewayWorkflow()
    }), { mode: "execute" });

    assert.equal(result.ok, true);
  });

  it("rejects executable parallel gateways without a single reciprocal related node", () => {
    const workflow = sampleParallelGatewayWorkflow();
    workflow.nodes.find((node) => node.id === "N2").attributes.relatedNodeIds = "N4;N5";
    workflow.nodes.find((node) => node.id === "N2").definition.attributes.relatedNodeIds = "N4;N5";
    const result = validateMigrationDsl(sampleTrustedDsl({ workflow }), { mode: "execute" });

    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === "dsl.workflow.parallel_gateway.related_single_required"), true);
  });
});

function sampleParallelGatewayWorkflow() {
  return {
    process: { id: "process-parallel" },
    nodes: [
      { id: "N1", type: "generalStart", element: "startEvent", name: "开始", sourceType: "startNode", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
      { id: "N2", type: "split", element: "parallelGateway", name: "并行分支", sourceType: "splitNode", sourceRef: "source.workflow.node.N2", attributes: { relatedNodeIds: "N4" }, definition: { attributes: { splitType: "all", relatedNodeIds: "N4" } }, translationStatus: "executable" },
      { id: "N3", type: "review", element: "manualTask", name: "审批", sourceType: "reviewNode", sourceRef: "source.workflow.node.N3", attributes: { handlerIds: "handler-1", handlerNames: "审批人" }, participants: { mode: "explicit", members: [{ id: "handler-1", name: "审批人", type: "user_or_org" }] }, translationStatus: "executable" },
      { id: "N4", type: "join", element: "parallelGateway", name: "并行分支", sourceType: "joinNode", sourceRef: "source.workflow.node.N4", attributes: { relatedNodeIds: "N2" }, definition: { attributes: { joinType: "all", relatedNodeIds: "N2" } }, translationStatus: "executable" },
      { id: "N5", type: "generalEnd", element: "endEvent", name: "结束", sourceType: "endNode", sourceRef: "source.workflow.node.N5", attributes: {}, translationStatus: "executable" }
    ],
    edges: [
      { id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1", condition: { translationStatus: "executable" } },
      { id: "L2", source: "N2", target: "N3", sourceRef: "source.workflow.edge.L2", condition: { translationStatus: "executable" } },
      { id: "L3", source: "N3", target: "N4", sourceRef: "source.workflow.edge.L3", condition: { translationStatus: "executable" } },
      { id: "L4", source: "N4", target: "N5", sourceRef: "source.workflow.edge.L4", condition: { translationStatus: "executable" } }
    ],
    topologicalOrder: ["N1", "N2", "N3", "N4", "N5"]
  };
}
