import { summarizeDslForm, summarizeFormFromTemplate } from "./form-payload.js";
import { summarizeDslWorkflow, summarizeWorkflowFromTemplate } from "./workflow-payload.js";

export function verifyReadback(dsl, template) {
  const diagnostics = [];
  const expectedForm = summarizeDslForm(dsl.form || {}, dsl.formRules);
  const actualForm = summarizeFormFromTemplate(template);
  compareFormSummary(expectedForm, actualForm, diagnostics);

  let expectedWorkflow;
  let actualWorkflow;
  if (dsl.workflow) {
    expectedWorkflow = summarizeDslWorkflow(dsl.workflow);
    actualWorkflow = summarizeWorkflowFromTemplate(template);
    compareWorkflowSummary(expectedWorkflow, actualWorkflow, diagnostics);
  }

  return {
    ok: diagnostics.every((diagnostic) => diagnostic.level !== "error"),
    diagnostics,
    form: actualForm,
    workflow: actualWorkflow
  };
}

function compareFormSummary(expected, actual, diagnostics) {
  if (expected.fieldCount !== actual.fieldCount) {
    diagnostics.push(error("readback.form.field_count_mismatch", "Readback form field count does not match DSL.", "/readback/form/fieldCount", {
      expected: expected.fieldCount,
      actual: actual.fieldCount
    }));
  }

  if (expected.layoutRowCount !== actual.layoutRowCount) {
    diagnostics.push(error("readback.form.layout_row_count_mismatch", "Readback form layout row count does not match DSL.", "/readback/form/layoutRowCount", {
      expected: expected.layoutRowCount,
      actual: actual.layoutRowCount
    }));
  }
  compareLayoutRows(expected.layoutRows || [], actual.layoutRows || [], diagnostics);
  compareFormRuleSummary(expected.formRules, actual.formRules, diagnostics);

  const actualFields = new Map((actual.fields || []).map((field) => [field.id, field]));
  for (const expectedField of expected.fields || []) {
    const actualField = actualFields.get(expectedField.id);
    if (!actualField) {
      diagnostics.push(error("readback.form.field_missing", "Readback form is missing a DSL field.", "/readback/form/fields", {
        fieldId: expectedField.id
      }));
      continue;
    }
    if (actualField.component !== expectedField.component) {
      diagnostics.push(error("readback.form.component_mismatch", "Readback form component does not match DSL.", "/readback/form/fields", {
        fieldId: expectedField.id,
        expected: expectedField.component,
        actual: actualField.component
      }));
    }
    if ((actualField.columns || []).length !== (expectedField.columns || []).length) {
      diagnostics.push(error("readback.form.detail_columns_mismatch", "Readback detail table column count does not match DSL.", "/readback/form/fields", {
        fieldId: expectedField.id,
        expected: (expectedField.columns || []).length,
        actual: (actualField.columns || []).length
      }));
    }
  }
}

function compareFormRuleSummary(expected = {}, actual = {}, diagnostics) {
  if (!expected.sourceRuleCount) return;
  for (const key of ["displayRuleCount", "requireRuleCount"]) {
    if ((actual[key] || 0) < expected[key]) {
      diagnostics.push(error(`readback.form_rules.${key}_missing`, "Readback form rules do not include the expected generated native rule count.", `/readback/form/formRules/${key}`, {
        expectedAtLeast: expected[key],
        actual: actual[key] || 0
      }));
    }
  }
}

function compareLayoutRows(expectedRows, actualRows, diagnostics) {
  expectedRows.forEach((expectedRow, rowIndex) => {
    const actualRow = actualRows[rowIndex];
    if (!actualRow) return;
    if (expectedRow.id !== actualRow.id) {
      diagnostics.push(error("readback.form.layout_row_id_mismatch", "Readback form layout row id does not match DSL.", `/readback/form/layoutRows/${rowIndex}/id`, {
        expected: expectedRow.id,
        actual: actualRow.id
      }));
    }
    if ((expectedRow.cells || []).length !== (actualRow.cells || []).length) {
      diagnostics.push(error("readback.form.layout_cells_mismatch", "Readback form layout cell count does not match DSL.", `/readback/form/layoutRows/${rowIndex}/cells`, {
        expected: (expectedRow.cells || []).length,
        actual: (actualRow.cells || []).length
      }));
      return;
    }
    (expectedRow.cells || []).forEach((expectedCell, cellIndex) => {
      const actualCell = actualRow.cells[cellIndex];
      if (!actualCell) return;
      const expectedFieldIds = expectedCell.fieldIds || [expectedCell.fieldId].filter(Boolean);
      const actualFieldIds = actualCell.fieldIds || [actualCell.fieldId].filter(Boolean);
      if (JSON.stringify(expectedFieldIds) !== JSON.stringify(actualFieldIds)) {
        diagnostics.push(error("readback.form.layout_cell_fields_mismatch", "Readback form layout cell fields do not match DSL.", `/readback/form/layoutRows/${rowIndex}/cells/${cellIndex}/fieldIds`, {
          expected: expectedFieldIds,
          actual: actualFieldIds
        }));
      }
      if (expectedCell.column !== actualCell.column || expectedCell.colspan !== actualCell.colspan) {
        diagnostics.push(error("readback.form.layout_cell_position_mismatch", "Readback form layout cell position does not match DSL.", `/readback/form/layoutRows/${rowIndex}/cells/${cellIndex}`, {
          expected: { column: expectedCell.column, colspan: expectedCell.colspan },
          actual: { column: actualCell.column, colspan: actualCell.colspan }
        }));
      }
    });
  });
}

function compareWorkflowSummary(expected, actual, diagnostics) {
  if (!actual) {
    diagnostics.push(error("readback.workflow.missing", "Readback workflow content is missing.", "/readback/workflow"));
    return;
  }
  for (const key of ["nodeCount", "edgeCount", "conditionEdgeCount", "invalidEdgeCount"]) {
    if (expected[key] !== actual[key]) {
      diagnostics.push(error(`readback.workflow.${key}_mismatch`, "Readback workflow structure does not match DSL.", `/readback/workflow/${key}`, {
        expected: expected[key],
        actual: actual[key]
      }));
    }
  }
  compareWorkflowEdges(expected.edges || [], actual.edges || [], diagnostics);
}

function compareWorkflowEdges(expectedEdges, actualEdges, diagnostics) {
  const actualById = new Map(actualEdges.map((edge) => [edge.id, edge]));
  for (const expectedEdge of expectedEdges) {
    const actualEdge = actualById.get(expectedEdge.id);
    if (!actualEdge) {
      diagnostics.push(error("readback.workflow.edge_missing", "Readback workflow is missing a DSL edge.", "/readback/workflow/edges", {
        edgeId: expectedEdge.id
      }));
      continue;
    }
    if (actualEdge.source !== expectedEdge.source || actualEdge.target !== expectedEdge.target) {
      diagnostics.push(error("readback.workflow.edge_endpoint_mismatch", "Readback workflow edge endpoints do not match DSL.", "/readback/workflow/edges", {
        edgeId: expectedEdge.id,
        expected: { source: expectedEdge.source, target: expectedEdge.target },
        actual: { source: actualEdge.source, target: actualEdge.target }
      }));
    }
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
