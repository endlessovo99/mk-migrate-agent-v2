import { catalogRefs, validationPolicyRef } from "../../src/dsl/catalogs.js";

export function sampleTrustedDsl(overrides = {}) {
  return merge({
    version: "2.0-migration",
    artifact: "migration-dsl",
    derivedFrom: { sourceDraftVersion: "2.0-source-draft", sourceId: "sample-source" },
    catalogs: catalogRefs(),
    validationPolicy: validationPolicyRef(),
    trust: {
      level: "trusted",
      executable: true,
      reviewer: { type: "agent", name: "codex", mode: "external-codex" },
      external: true,
      trustCheck: { status: "passed", checkedAt: "2026-07-06T00:00:00.000Z" }
    },
    template: { name: "示例流程", sourceRef: "sample-source" },
    form: sampleForm(),
    workflow: sampleWorkflow(),
    review: { warnings: [], decisions: [] }
  }, overrides);
}

export function sampleDraftDsl(overrides = {}) {
  const draft = sampleTrustedDsl({
    artifact: "dsl-draft",
    trust: {
      level: "draft",
      executable: false,
      model: { mode: "none", reason: "external Agent trust required" }
    },
    review: { warnings: [], reviewCandidates: [] }
  });
  return merge(draft, overrides);
}

export function sampleSourceDraft(overrides = {}) {
  return merge({
    version: "2.0-source-draft",
    artifact: "source-draft",
    source: { kind: "source-directory", sourceId: "sample-source", path: "sample" },
    template: { name: "示例流程", categoryPath: "" },
    form: {
      controls: [
        { id: "fd_subject", sourceRef: "source.form.control.fd_subject" },
        { id: "fd_amount", sourceRef: "source.form.control.fd_amount" }
      ],
      detailTables: [{
        id: "fd_detail",
        sourceRef: "source.form.detailTable.fd_detail",
        columns: [{ id: "fd_name", sourceRef: "source.form.detailTable.fd_detail.column.fd_name" }]
      }],
      layout: {
        rows: [
          {
            id: "row-0",
            sourceRef: "source.form.layout.row.row-0",
            cells: [
              { id: "row-0-cell-0", sourceRef: "source.form.layout.cell.row-0-cell-0" },
              { id: "row-0-cell-1", sourceRef: "source.form.layout.cell.row-0-cell-1" }
            ]
          },
          {
            id: "row-1",
            sourceRef: "source.form.layout.row.row-1",
            cells: [{ id: "row-1-cell-0", sourceRef: "source.form.layout.cell.row-1-cell-0" }]
          }
        ]
      }
    },
    workflow: {
      nodes: [
        { id: "N1", sourceRef: "source.workflow.node.N1" },
        { id: "N2", sourceRef: "source.workflow.node.N2" }
      ],
      edges: [{ id: "L1", sourceRef: "source.workflow.edge.L1" }]
    },
    issues: []
  }, overrides);
}

export function sampleForm() {
  return {
    fields: [
      {
        id: "fd_subject",
        title: "主题",
        type: "text",
        componentId: "xform-input",
        props: { required: true },
        sourceProps: { designerType: "inputText" },
        sourceRef: "source.form.control.fd_subject"
      },
      {
        id: "fd_amount",
        title: "金额",
        type: "text",
        componentId: "xform-input",
        props: {},
        sourceProps: { designerType: "inputText" },
        sourceRef: "source.form.control.fd_amount"
      },
      {
        id: "fd_detail",
        title: "明细",
        type: "detailTable",
        componentId: "xform-detail-table",
        props: {},
        sourceProps: { designerType: "detailsTable" },
        sourceRef: "source.form.detailTable.fd_detail",
        columns: [
          {
            id: "fd_name",
            title: "名称",
            type: "text",
            componentId: "xform-input",
            props: {},
            sourceProps: { metadataKind: "simple" },
            sourceRef: "source.form.detailTable.fd_detail.column.fd_name"
          }
        ]
      }
    ],
    layout: {
      sourceGrid: {
        source: "fdDesignerHtml",
        rows: [
          {
            id: "row-0",
            sourceRef: "source.form.layout.row.row-0",
            cells: [
              { id: "row-0-cell-0", sourceRef: "source.form.layout.cell.row-0-cell-0", references: [{ referenceId: "fd_subject" }] },
              { id: "row-0-cell-1", sourceRef: "source.form.layout.cell.row-0-cell-1", references: [{ referenceId: "fd_amount" }] }
            ]
          },
          {
            id: "row-1",
            sourceRef: "source.form.layout.row.row-1",
            cells: [
              { id: "row-1-cell-0", sourceRef: "source.form.layout.cell.row-1-cell-0", references: [{ referenceId: "fd_detail" }] }
            ]
          }
        ]
      },
      mkTree: [
        {
          id: "layout.row-0",
          componentId: "xform-flex-1-2-layout",
          props: { columns: 2, sourceColumns: 2 },
          sourceRef: "source.form.layout.row.row-0",
          children: [
            { id: "layout.row-0-cell-0", refType: "field", refIds: ["fd_subject"], sourceRef: "source.form.layout.cell.row-0-cell-0", column: 0, colspan: 1 },
            { id: "layout.row-0-cell-1", refType: "field", refIds: ["fd_amount"], sourceRef: "source.form.layout.cell.row-0-cell-1", column: 1, colspan: 1 }
          ]
        },
        {
          id: "layout.row-1",
          componentId: "xform-flex-1-1-layout",
          props: { columns: 1, sourceColumns: 1 },
          sourceRef: "source.form.layout.row.row-1",
          children: [
            { id: "layout.row-1-cell-0", refType: "detailTable", refIds: ["fd_detail"], sourceRef: "source.form.layout.cell.row-1-cell-0", column: 0, colspan: 1 }
          ]
        }
      ]
    }
  };
}

export function sampleWorkflow() {
  return {
    process: { id: "process-1" },
    nodes: [
      { id: "N1", type: "generalStart", element: "startEvent", name: "开始", sourceType: "startNode", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
      { id: "N2", type: "generalEnd", element: "endEvent", name: "结束", sourceType: "endNode", sourceRef: "source.workflow.node.N2", attributes: {}, translationStatus: "executable" }
    ],
    edges: [
      {
        id: "L1",
        source: "N1",
        target: "N2",
        name: "",
        sourceRef: "source.workflow.edge.L1",
        attributes: {},
        condition: { sourceText: "", displayText: "", targetText: "", translationStatus: "executable" }
      }
    ],
    topologicalOrder: ["N1", "N2"]
  };
}

function merge(base, overrides) {
  if (Array.isArray(base) || Array.isArray(overrides)) return overrides === undefined ? base : overrides;
  if (!isRecord(base) || !isRecord(overrides)) return overrides === undefined ? base : overrides;
  const output = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    output[key] = merge(base[key], value);
  }
  return output;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
