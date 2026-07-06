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
});
