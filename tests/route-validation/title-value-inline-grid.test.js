import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

const fixture =
  "tests/fixtures/route-validation/title-value-inline-grid/route-title-value-inline-grid_SysFormTemplate.xml";

describe("four-column title/value rows and same-cell inline controls", () => {
  it("keeps title cells, hides bound labels, and does not nest same-cell controls", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const fields = new Map(draft.form.fields.map((field) => [field.id, field]));
    const rows = new Map(draft.form.layout.mkTree.map((row) => [row.id, row]));
    const validation = validateMigrationDsl(draft, { mode: "draft" });

    assert.equal(fields.get("label_fax")?.componentId, "xform-description");
    assert.equal(fields.get("label_boxes")?.componentId, "xform-description");
    assert.equal(fields.get("label_notes")?.componentId, "xform-description");
    assert.equal(fields.get("label_applicant")?.componentId, "xform-description");
    assert.equal(fields.get("label_dept")?.componentId, "xform-description");

    assert.equal(fields.get("fd_fax")?.props.hiddenLabel, true);
    assert.equal(fields.get("fd_boxes")?.props.hiddenLabel, true);
    assert.equal(fields.get("fd_notes")?.props.hiddenLabel, true);
    assert.equal(fields.get("fd_applicant.name")?.props.hiddenLabel, true);
    assert.equal(fields.get("fd_dept.name")?.props.hiddenLabel, true);
    assert.equal(fields.get("fd_dept_en")?.props.hiddenLabel, true);
    assert.equal(fields.get("fd_applicant")?.props.hiddenLabel, true);
    assert.equal(fields.get("fd_dept")?.props.hiddenLabel, true);
    assert.equal(fields.get("fd_applicant")?.sourceProps.layoutCell.hiddenLabel, true);
    assert.equal(fields.get("fd_dept")?.sourceProps.layoutCell.hiddenLabel, true);

    assert.equal(fields.get("fd_applicant.name")?.dataOnly, true);
    assert.equal(fields.get("fd_dept.name")?.dataOnly, true);
    assert.equal(
      fields.get("fd_applicant")?.sourceProps.addressDisplayCompanionId,
      "fd_applicant.name"
    );

    assert.equal(
      draft.form.layout.mkTree.some((row) => row.id.includes(".inline")),
      false
    );

    assert.deepEqual(rowShape(rows.get("layout.row-0")), {
      columns: 4,
      children: [
        { refType: "field", refIds: ["label_applicant"], column: 0, colspan: 1 },
        {
          refType: "field",
          refIds: ["fd_applicant", "label_required"],
          column: 1,
          colspan: 1,
          keepInline: true
        },
        { refType: "field", refIds: ["label_dept"], column: 2, colspan: 1 },
        {
          refType: "field",
          refIds: ["fd_dept", "label_slash", "fd_dept_en"],
          column: 3,
          colspan: 1,
          keepInline: true
        }
      ]
    });
    assert.deepEqual(rowShape(rows.get("layout.row-1")), {
      columns: 4,
      children: [
        { refType: "field", refIds: ["label_fax"], column: 0, colspan: 1 },
        { refType: "field", refIds: ["fd_fax"], column: 1, colspan: 1 },
        { refType: "field", refIds: ["label_boxes"], column: 2, colspan: 1 },
        {
          refType: "field",
          refIds: ["fd_boxes", "label_box_unit"],
          column: 3,
          colspan: 1,
          keepInline: true
        }
      ]
    });
    assert.deepEqual(rowShape(rows.get("layout.row-2")), {
      columns: 4,
      children: [
        { refType: "field", refIds: ["label_notes"], column: 0, colspan: 1 },
        { refType: "field", refIds: ["fd_notes"], column: 1, colspan: 3 }
      ]
    });

    const nativeRows = projectNativeLayoutRows(draft.form.layout.mkTree);
    assert.deepEqual(
      nativeRows.map((row) => ({
        id: row.id,
        columns: row.columns,
        cells: row.cells.map((cell) => ({
          refIds: cell.refIds,
          column: cell.column,
          colspan: cell.colspan
        }))
      })),
      [
        {
          id: "layout.row-0",
          columns: 4,
          cells: [
            { refIds: ["label_applicant"], column: 0, colspan: 1 },
            { refIds: ["fd_applicant", "label_required"], column: 1, colspan: 1 },
            { refIds: ["label_dept"], column: 2, colspan: 1 },
            { refIds: ["fd_dept", "label_slash", "fd_dept_en"], column: 3, colspan: 1 }
          ]
        },
        {
          id: "layout.row-1",
          columns: 4,
          cells: [
            { refIds: ["label_fax"], column: 0, colspan: 1 },
            { refIds: ["fd_fax"], column: 1, colspan: 1 },
            { refIds: ["label_boxes"], column: 2, colspan: 1 },
            { refIds: ["fd_boxes", "label_box_unit"], column: 3, colspan: 1 }
          ]
        },
        {
          id: "layout.row-2",
          columns: 4,
          cells: [
            { refIds: ["label_notes"], column: 0, colspan: 1 },
            { refIds: ["fd_notes"], column: 1, colspan: 3 }
          ]
        }
      ]
    );

    assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics));

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-test",
      checkedAt: "2026-09-05T00:00:00.000Z"
    });
    const prepared = prepareSample(trusted);
    const readback = prepared.verify(prepared.update);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.deepEqual(
      readback.form.layoutRows.map((row) => ({
        columns: row.columns,
        cells: row.cells.map((cell) => ({
          fieldIds: cell.fieldIds,
          column: cell.column,
          colspan: cell.colspan
        }))
      })),
      nativeRows.map((row) => ({
        columns: row.columns,
        cells: row.cells.map((cell) => ({
          fieldIds: cell.refIds,
          column: cell.column,
          colspan: cell.colspan
        }))
      }))
    );
    assert.equal(readback.form.fields.find((field) => field.id === "fd_fax")?.hiddenLabel, true);
    assert.equal(readback.form.fields.find((field) => field.id === "fd_applicant")?.hiddenLabel, true);
    assert.equal(readback.form.fields.find((field) => field.id === "fd_dept")?.hiddenLabel, true);
    assert.equal(readback.form.fields.find((field) => field.id === "fd_applicant.name")?.dataOnly, true);
  });
});

function rowShape(row) {
  return {
    columns: row?.props?.columns,
    children: (row?.children || []).map((child) => ({
      refType: child.refType,
      refIds: child.refIds,
      column: child.column,
      colspan: child.colspan,
      ...(child.keepInline === true ? { keepInline: true } : {})
    }))
  };
}
