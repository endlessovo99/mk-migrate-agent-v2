import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

const fixture = "tests/fixtures/source4/16701bbaa305ce4b28588b34ee681173";

describe("detail-table keepInline projection", () => {
  it("keeps side-by-side mixed detail-table cells as exclusive stacked columns", () => {
    const source = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(source);
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const rows = dsl.form.layout.mkTree.filter((row) =>
      row.sourceRef === "source.form.layout.row.row-4"
    );
    const check = checkDraft(dsl);

    assert.equal(fields.get("fd_use_dept")?.componentId, "xform-address");
    assert.equal(fields.get("fd_use_dept")?.props.hiddenLabel, true);
    assert.equal(fields.get("fd_use_dept.name")?.dataOnly, true);
    assert.equal(fields.get("fd_use_group")?.props.hiddenLabel, true);

    assert.deepEqual(
      rows.map((row) => ({
        id: row.id,
        componentId: row.componentId,
        props: row.props,
        children: row.children.map((child) => ({
          refType: child.refType,
          refIds: child.refIds,
          row: child.row,
          column: child.column,
          colspan: child.colspan,
          keepInline: child.keepInline
        }))
      })),
      [
        {
          id: "layout.row-4",
          componentId: "xform-multi-row-table-layout",
          props: { rows: 2, columns: 4 },
          children: [
            {
              refType: "detailTable",
              refIds: ["fd_33ea7c5c845292"],
              row: 0,
              column: 0,
              colspan: 2,
              keepInline: undefined
            },
            {
              refType: "detailTable",
              refIds: ["fd_33ea7c2c568124"],
              row: 0,
              column: 2,
              colspan: 2,
              keepInline: undefined
            },
            {
              refType: "field",
              refIds: ["fd_365b1835312ec2"],
              row: 1,
              column: 0,
              colspan: 2,
              keepInline: undefined
            },
            {
              refType: "field",
              refIds: ["fd_365b183f162f56"],
              row: 1,
              column: 2,
              colspan: 2,
              keepInline: undefined
            }
          ]
        }
      ]
    );
    assert.equal(check.ok, true);
    assert.equal(
      check.diagnostics.some((item) => item.code === "dsl.form.layout.detail_table_cell_exclusive"),
      false
    );

    const nativeRow = projectNativeLayoutRows(rows)[0];
    assert.equal(nativeRow.columns, 4);
    assert.equal(nativeRow.rows, 2);
    assert.deepEqual(
      nativeRow.cells.map((cell) => ({
        refIds: cell.refIds,
        row: cell.row,
        column: cell.column,
        colspan: cell.colspan
      })),
      [
        { refIds: ["fd_33ea7c5c845292"], row: 0, column: 0, colspan: 2 },
        { refIds: ["fd_33ea7c2c568124"], row: 0, column: 2, colspan: 2 },
        { refIds: ["fd_365b1835312ec2"], row: 1, column: 0, colspan: 2 },
        { refIds: ["fd_365b183f162f56"], row: 1, column: 2, colspan: 2 }
      ]
    );

    const trusted = createTrustedMigrationDsl(source, dsl, {
      externalAgentReviewed: true,
      reviewerName: "route-test",
      checkedAt: "2026-09-05T00:00:00.000Z"
    });
    const prepared = prepareSample(trusted);
    const readback = prepared.verify(prepared.update);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.form.fields.find((field) => field.id === "fd_use_dept")?.hiddenLabel, true);
    const persisted = readback.form.layoutRows.find((row) => row.rootNodeId === "layout.row-4");
    assert.deepEqual(
      persisted.cells.map((cell) => ({
        fieldIds: cell.fieldIds,
        row: cell.row,
        column: cell.column,
        colspan: cell.colspan
      })),
      nativeRow.cells.map((cell) => ({
        fieldIds: cell.refIds,
        row: cell.row,
        column: cell.column,
        colspan: cell.colspan
      }))
    );
  });
});
