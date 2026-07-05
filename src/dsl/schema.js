import { MK_COMPONENTS } from "./mk-components.js";

export const DSL_VERSION = "2.0-draft";

export const FIELD_TYPES = new Set([
  "text",
  "longText",
  "number",
  "date",
  "dateTime",
  "singleSelect",
  "multiSelect",
  "radio",
  "checkbox",
  "attachment",
  "description",
  "detailTable"
]);

export function validateMigrationDsl(input) {
  const diagnostics = [];
  const root = isRecord(input) ? input : {};

  if (!isRecord(input)) {
    diagnostics.push(error("dsl.root_type", "DSL must be a JSON object.", "/"));
  }

  if (root.version !== DSL_VERSION) {
    diagnostics.push(error("dsl.version_unsupported", `DSL version must be ${DSL_VERSION}.`, "/version", {
      current: root.version,
      supported: [DSL_VERSION]
    }));
  }

  const template = isRecord(root.template) ? root.template : {};
  if (!nonEmptyString(template.name)) {
    diagnostics.push(error("dsl.template.name_required", "template.name is required.", "/template/name"));
  }

  const form = isRecord(root.form) ? root.form : {};
  let fieldIds = new Set();
  if (!Array.isArray(form.fields) || form.fields.length === 0) {
    diagnostics.push(error("dsl.form.fields_required", "form.fields must contain at least one field.", "/form/fields"));
  } else {
    fieldIds = validateFields(form.fields, diagnostics);
  }

  validateFormLayout(form.layout, fieldIds, diagnostics);

  const warnings = Array.isArray(root.review?.warnings) ? root.review.warnings : [];
  for (const warning of warnings) {
    diagnostics.push({
      level: "warning",
      code: warning.code || "dsl.review.warning",
      message: warning.message || "DSL contains a review warning.",
      path: warning.path || "/review/warnings",
      details: warning.details
    });
  }

  const reviewErrors = Array.isArray(root.review?.errors) ? root.review.errors : [];
  for (const reviewError of reviewErrors) {
    diagnostics.push({
      level: "error",
      code: reviewError.code || "dsl.review.error",
      message: reviewError.message || "DSL contains a review error.",
      path: reviewError.path || "/review/errors",
      details: reviewError.details
    });
  }

  if (root.workflow !== undefined) {
    validateWorkflow(root.workflow, diagnostics);
  }

  const hasErrors = diagnostics.some((item) => item.level === "error");
  const hasWarnings = diagnostics.some((item) => item.level === "warning");

  return {
    ok: !hasErrors,
    status: hasErrors ? "invalid" : hasWarnings ? "needs_manual" : "ok",
    diagnostics,
    dsl: root
  };
}

function validateFields(fields, diagnostics) {
  const ids = new Set();

  fields.forEach((field, index) => {
    const path = `/form/fields/${index}`;
    if (!isRecord(field)) {
      diagnostics.push(error("dsl.field.type", "Field must be a JSON object.", path));
      return;
    }

    if (!nonEmptyString(field.id)) {
      diagnostics.push(error("dsl.field.id_required", "Field id is required.", `${path}/id`));
    } else if (ids.has(field.id)) {
      diagnostics.push(error("dsl.field.id_duplicate", "Field id must be unique.", `${path}/id`, { id: field.id }));
    } else {
      ids.add(field.id);
    }

    if (!nonEmptyString(field.title)) {
      diagnostics.push(error("dsl.field.title_required", "Field title is required.", `${path}/title`));
    }

    if (!FIELD_TYPES.has(field.type)) {
      diagnostics.push(error("dsl.field.type_unsupported", "Field type is not supported by the v2 draft DSL.", `${path}/type`, {
        current: field.type,
        supported: Array.from(FIELD_TYPES)
      }));
    }

    validateMkComponent(field.mk, diagnostics, `${path}/mk`);

    if (field.options !== undefined) {
      if (!Array.isArray(field.options)) {
        diagnostics.push(error("dsl.field.options_type", "Field options must be an array.", `${path}/options`));
      } else if (["singleSelect", "multiSelect", "radio", "checkbox"].includes(field.type)) {
        field.options.forEach((option, optionIndex) => {
          if (!nonEmptyString(option?.label) || !nonEmptyString(option?.value)) {
            diagnostics.push(error("dsl.field.option_invalid", "Option label and value are required.", `${path}/options/${optionIndex}`));
          }
        });
      }
    }

    if (field.type === "detailTable") {
      validateDetailColumns(field.columns, diagnostics, `${path}/columns`);
    }
  });

  return ids;
}

function validateFormLayout(layout, fieldIds, diagnostics) {
  if (!isRecord(layout)) {
    diagnostics.push(error("dsl.form.layout_required", "form.layout is required.", "/form/layout"));
    return;
  }

  if (!nonEmptyString(layout.source)) {
    diagnostics.push(error("dsl.form.layout.source_required", "form.layout.source is required.", "/form/layout/source"));
  }

  if (!Array.isArray(layout.rows) || layout.rows.length === 0) {
    diagnostics.push(error("dsl.form.layout.rows_required", "form.layout.rows must contain at least one row.", "/form/layout/rows"));
    return;
  }

  const rowIds = new Set();
  layout.rows.forEach((row, rowIndex) => {
    const rowPath = `/form/layout/rows/${rowIndex}`;
    if (!isRecord(row)) {
      diagnostics.push(error("dsl.form.layout.row_type", "Layout row must be a JSON object.", rowPath));
      return;
    }
    if (!nonEmptyString(row.id)) {
      diagnostics.push(error("dsl.form.layout.row_id_required", "Layout row id is required.", `${rowPath}/id`));
    } else if (rowIds.has(row.id)) {
      diagnostics.push(error("dsl.form.layout.row_id_duplicate", "Layout row id must be unique.", `${rowPath}/id`, { id: row.id }));
    } else {
      rowIds.add(row.id);
    }

    if (!Array.isArray(row.cells) || row.cells.length === 0) {
      diagnostics.push(error("dsl.form.layout.cells_required", "Layout row must contain at least one cell.", `${rowPath}/cells`));
      return;
    }

    const cellIds = new Set();
    row.cells.forEach((cell, cellIndex) => {
      const cellPath = `${rowPath}/cells/${cellIndex}`;
      if (!isRecord(cell)) {
        diagnostics.push(error("dsl.form.layout.cell_type", "Layout cell must be a JSON object.", cellPath));
        return;
      }
      if (!nonEmptyString(cell.id)) {
        diagnostics.push(error("dsl.form.layout.cell_id_required", "Layout cell id is required.", `${cellPath}/id`));
      } else if (cellIds.has(cell.id)) {
        diagnostics.push(error("dsl.form.layout.cell_id_duplicate", "Layout cell id must be unique within a row.", `${cellPath}/id`, { id: cell.id }));
      } else {
        cellIds.add(cell.id);
      }
      validateLayoutCellFields(cell, fieldIds, diagnostics, cellPath);
      if (!Number.isInteger(cell.column) || cell.column < 0) {
        diagnostics.push(error("dsl.form.layout.column_invalid", "Layout cell column must be a non-negative integer.", `${cellPath}/column`));
      }
      if (!Number.isInteger(cell.colspan) || cell.colspan < 1) {
        diagnostics.push(error("dsl.form.layout.colspan_invalid", "Layout cell colspan must be a positive integer.", `${cellPath}/colspan`));
      }
    });
  });
}

function validateLayoutCellFields(cell, fieldIds, diagnostics, path) {
  const references = Array.isArray(cell.fieldIds) ? cell.fieldIds : [cell.fieldId];
  if (!references.length || references.every((fieldId) => !nonEmptyString(fieldId))) {
    diagnostics.push(error("dsl.form.layout.field_required", "Layout cell must contain fieldId or fieldIds.", `${path}/fieldId`));
    return;
  }

  references.forEach((fieldId, index) => {
    const fieldPath = Array.isArray(cell.fieldIds) ? `${path}/fieldIds/${index}` : `${path}/fieldId`;
    if (!nonEmptyString(fieldId)) {
      diagnostics.push(error("dsl.form.layout.field_required", "Layout cell field reference is required.", fieldPath));
      return;
    }
    if (!fieldIds.has(fieldId)) {
      diagnostics.push(error("dsl.form.layout.field_missing", "Layout cell field reference must reference a form field.", fieldPath, {
        fieldId
      }));
    }
  });

  if (cell.fieldId !== undefined && Array.isArray(cell.fieldIds) && cell.fieldIds[0] !== cell.fieldId) {
    diagnostics.push(error("dsl.form.layout.field_id_mismatch", "Layout cell fieldId must match the first fieldIds entry.", `${path}/fieldId`, {
      fieldId: cell.fieldId,
      firstFieldId: cell.fieldIds[0]
    }));
  }
}

function validateWorkflow(workflow, diagnostics) {
  if (!isRecord(workflow)) {
    diagnostics.push(error("dsl.workflow.type", "workflow must be a JSON object.", "/workflow"));
    return;
  }

  const process = isRecord(workflow.process) ? workflow.process : {};
  if (!isRecord(workflow.process)) {
    diagnostics.push(error("dsl.workflow.process_required", "workflow.process is required.", "/workflow/process"));
  } else if (!nonEmptyString(process.id)) {
    diagnostics.push(error("dsl.workflow.process.id_required", "workflow.process.id is required.", "/workflow/process/id"));
  }

  const nodeIds = validateWorkflowNodes(workflow.nodes, diagnostics);
  const edges = validateWorkflowEdges(workflow.edges, nodeIds, diagnostics);
  validateTopologicalOrder(workflow.topologicalOrder, nodeIds, edges, diagnostics);
}

function validateWorkflowNodes(nodes, diagnostics) {
  const ids = new Set();

  if (!Array.isArray(nodes) || nodes.length === 0) {
    diagnostics.push(error("dsl.workflow.nodes_required", "workflow.nodes must contain at least one node.", "/workflow/nodes"));
    return ids;
  }

  nodes.forEach((node, index) => {
    const path = `/workflow/nodes/${index}`;
    if (!isRecord(node)) {
      diagnostics.push(error("dsl.workflow.node.type", "Workflow node must be a JSON object.", path));
      return;
    }

    if (!nonEmptyString(node.id)) {
      diagnostics.push(error("dsl.workflow.node.id_required", "Workflow node id is required.", `${path}/id`));
    } else if (ids.has(node.id)) {
      diagnostics.push(error("dsl.workflow.node.id_duplicate", "Workflow node id must be unique.", `${path}/id`, { id: node.id }));
    } else {
      ids.add(node.id);
    }

    if (!nonEmptyString(node.type)) {
      diagnostics.push(error("dsl.workflow.node.type_required", "Workflow node type is required.", `${path}/type`));
    }

    if (!isRecord(node.attributes)) {
      diagnostics.push(error("dsl.workflow.node.attributes_required", "Workflow node attributes must preserve source attributes.", `${path}/attributes`));
    }
  });

  return ids;
}

function validateWorkflowEdges(edges, nodeIds, diagnostics) {
  const ids = new Set();
  const validEdges = [];

  if (!Array.isArray(edges)) {
    diagnostics.push(error("dsl.workflow.edges_required", "workflow.edges must be an array.", "/workflow/edges"));
    return validEdges;
  }

  edges.forEach((edge, index) => {
    const path = `/workflow/edges/${index}`;
    if (!isRecord(edge)) {
      diagnostics.push(error("dsl.workflow.edge.type", "Workflow edge must be a JSON object.", path));
      return;
    }

    if (!nonEmptyString(edge.id)) {
      diagnostics.push(error("dsl.workflow.edge.id_required", "Workflow edge id is required.", `${path}/id`));
    } else if (ids.has(edge.id)) {
      diagnostics.push(error("dsl.workflow.edge.id_duplicate", "Workflow edge id must be unique.", `${path}/id`, { id: edge.id }));
    } else {
      ids.add(edge.id);
    }

    if (!nonEmptyString(edge.source)) {
      diagnostics.push(error("dsl.workflow.edge.source_required", "Workflow edge source is required.", `${path}/source`));
    } else if (!nodeIds.has(edge.source)) {
      diagnostics.push(error("dsl.workflow.edge.source_missing", "Workflow edge source must reference an existing node.", `${path}/source`, { source: edge.source }));
    }

    if (!nonEmptyString(edge.target)) {
      diagnostics.push(error("dsl.workflow.edge.target_required", "Workflow edge target is required.", `${path}/target`));
    } else if (!nodeIds.has(edge.target)) {
      diagnostics.push(error("dsl.workflow.edge.target_missing", "Workflow edge target must reference an existing node.", `${path}/target`, { target: edge.target }));
    }

    if (!isRecord(edge.attributes)) {
      diagnostics.push(error("dsl.workflow.edge.attributes_required", "Workflow edge attributes must preserve source attributes.", `${path}/attributes`));
    }

    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      validEdges.push(edge);
    }
  });

  return validEdges;
}

function validateTopologicalOrder(order, nodeIds, edges, diagnostics) {
  if (!Array.isArray(order)) {
    diagnostics.push(error("dsl.workflow.topological_order_required", "workflow.topologicalOrder is required.", "/workflow/topologicalOrder"));
    return;
  }

  const positions = new Map();
  order.forEach((nodeId, index) => {
    if (!nonEmptyString(nodeId)) {
      diagnostics.push(error("dsl.workflow.topological_order.item_type", "workflow.topologicalOrder entries must be node ids.", `/workflow/topologicalOrder/${index}`));
      return;
    }
    if (positions.has(nodeId)) {
      diagnostics.push(error("dsl.workflow.topological_order.duplicate", "workflow.topologicalOrder must not contain duplicate ids.", `/workflow/topologicalOrder/${index}`, { id: nodeId }));
      return;
    }
    if (!nodeIds.has(nodeId)) {
      diagnostics.push(error("dsl.workflow.topological_order.unknown_node", "workflow.topologicalOrder must only contain workflow node ids.", `/workflow/topologicalOrder/${index}`, { id: nodeId }));
      return;
    }
    positions.set(nodeId, index);
  });

  if (positions.size !== nodeIds.size) {
    diagnostics.push(error("dsl.workflow.topological_order.incomplete", "workflow.topologicalOrder must include every workflow node exactly once.", "/workflow/topologicalOrder", {
      expected: nodeIds.size,
      current: positions.size
    }));
  }

  for (const edge of edges) {
    if ((positions.get(edge.source) ?? Number.POSITIVE_INFINITY) >= (positions.get(edge.target) ?? Number.NEGATIVE_INFINITY)) {
      diagnostics.push(error("dsl.workflow.cycle_or_bad_order", "workflow edges must follow topologicalOrder.", "/workflow/topologicalOrder", {
        edge: edge.id,
        source: edge.source,
        target: edge.target
      }));
      return;
    }
  }
}

function validateDetailColumns(columns, diagnostics, path) {
  if (!Array.isArray(columns) || columns.length === 0) {
    diagnostics.push(error("dsl.detail_table.columns_required", "Detail table fields must contain at least one column.", path));
    return;
  }

  const ids = new Set();
  columns.forEach((column, index) => {
    const columnPath = `${path}/${index}`;
    if (!isRecord(column)) {
      diagnostics.push(error("dsl.detail_table.column_type", "Detail table column must be a JSON object.", columnPath));
      return;
    }
    if (!nonEmptyString(column.id)) {
      diagnostics.push(error("dsl.detail_table.column_id_required", "Detail table column id is required.", `${columnPath}/id`));
    } else if (ids.has(column.id)) {
      diagnostics.push(error("dsl.detail_table.column_id_duplicate", "Detail table column id must be unique within the table.", `${columnPath}/id`, { id: column.id }));
    } else {
      ids.add(column.id);
    }
    if (!nonEmptyString(column.title)) {
      diagnostics.push(error("dsl.detail_table.column_title_required", "Detail table column title is required.", `${columnPath}/title`));
    }
    if (!FIELD_TYPES.has(column.type) || column.type === "detailTable") {
      diagnostics.push(error("dsl.detail_table.column_type_unsupported", "Detail table column type is not supported.", `${columnPath}/type`, {
        current: column.type,
        supported: Array.from(FIELD_TYPES).filter((type) => type !== "detailTable")
      }));
    }
    validateMkComponent(column.mk, diagnostics, `${columnPath}/mk`);
  });
}

function validateMkComponent(mk, diagnostics, path) {
  if (!isRecord(mk)) {
    diagnostics.push(error("dsl.field.mk_required", "Field mk component metadata is required.", path));
    return;
  }

  if (!nonEmptyString(mk.component)) {
    diagnostics.push(error("dsl.field.mk.component_required", "Field mk.component is required.", `${path}/component`));
    return;
  }

  const expected = MK_COMPONENTS.get(mk.component);
  if (!expected) {
    diagnostics.push(error("dsl.field.mk.component_unsupported", "Field mk.component is not supported.", `${path}/component`, {
      current: mk.component,
      supported: [...MK_COMPONENTS.keys()]
    }));
    return;
  }

  if (mk.group !== expected.group) {
    diagnostics.push(error("dsl.field.mk.group_mismatch", "Field mk.group must match the MK component mapping.", `${path}/group`, {
      current: mk.group,
      expected: expected.group
    }));
  }

  if (mk.itemTid !== expected.itemTid) {
    diagnostics.push(error("dsl.field.mk.item_tid_mismatch", "Field mk.itemTid must match the MK component mapping.", `${path}/itemTid`, {
      current: mk.itemTid,
      expected: expected.itemTid
    }));
  }

  if (mk.sourceComponent !== expected.sourceComponent) {
    diagnostics.push(error("dsl.field.mk.source_component_mismatch", "Field mk.sourceComponent must match the MK component mapping.", `${path}/sourceComponent`, {
      current: mk.sourceComponent,
      expected: expected.sourceComponent
    }));
  }
}

function error(code, message, path, details) {
  return {
    level: "error",
    code,
    message,
    path,
    details
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
