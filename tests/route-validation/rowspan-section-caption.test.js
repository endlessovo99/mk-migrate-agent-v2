import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixture =
  "tests/fixtures/route-validation/rowspan-section-caption/route-rowspan-section-caption_SysFormTemplate.xml";

describe("rowspan section caption beside a nested detail table", () => {
  it("keeps the left caption visible and hides the unbound notes editor title", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const fields = new Map(draft.form.fields.map((field) => [field.id, field]));
    const validation = validateMigrationDsl(draft, { mode: "draft" });
    const notes = fields.get("fd_other_notes");
    const caption = fields.get("fd_section_caption");
    const needNotes = fields.get("fd_need_notes");
    const [nativeRow] = projectNativeLayoutRows(
      draft.form.layout.mkTree.filter((row) =>
        ["layout.row-0", "layout.row-0.rowspan-0.row-0", "layout.row-1"].includes(row.id)
      )
    );

    assert.equal(caption?.componentId, "xform-description");
    assert.equal(caption?.props.content, "申领内容");
    assert.equal(notes?.title, "其他");
    assert.equal(notes?.props.hiddenLabel, true);
    assert.equal(notes?.sourceProps.layoutCell?.relation, "unbound-editor-subject");
    assert.equal(needNotes?.title, "需求情况");
    assert.equal(needNotes?.props.hiddenLabel, true);
    assert.equal(needNotes?.sourceProps.layoutCell?.relation, "independent-bound-title-cell");
    assert.equal(fields.get("fd_need_caption")?.componentId, "xform-description");
    assert.equal(validation.ok, true);
    assert.equal(
      validation.diagnostics.some((diagnostic) =>
        diagnostic.code === "dsl.form.layout.detail_table_cell_exclusive"
      ),
      false
    );

    const captionCell = nativeRow.cells.find((cell) => cell.refIds.includes("fd_section_caption"));
    const tableCell = nativeRow.cells.find((cell) => cell.refIds.includes("fd_claim_lines"));
    const notesCell = nativeRow.cells.find((cell) => cell.refIds.includes("fd_other_notes"));
    assert.equal(nativeRow.rows, 2);
    assert.equal(nativeRow.columns, 2);
    assert.equal(captionCell?.column, 0);
    assert.equal(captionCell?.rowspan, 2);
    assert.equal(tableCell?.column, 1);
    assert.equal(notesCell?.column, 1);
    assert.ok(parseFloat(nativeRow.colsStyle[0].value) >= 20);

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-test",
      checkedAt: "2026-09-05T00:00:00.000Z"
    });
    const prepared = prepareSample(trusted);
    const readback = prepared.verify(prepared.update);
    const attribute = JSON.parse(
      xformConfig(prepared.update).dataModel
        .find((model) => model.fdType === "main")
        .fdFields
        .find((field) => field.fdName === "fd_other_notes")
        .fdAttribute
    );
    const persisted = readback.form.layoutRows.find((row) => row.rootNodeId === "layout.row-0");

    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.form.fields.find((field) => field.id === "fd_other_notes")?.hiddenLabel, true);
    assert.equal(attribute.config.controlProps.desktop.hiddenLabel, true);
    assert.equal(attribute.config.labelProps.desktop.hiddenLabel, true);
    assert.equal(persisted?.cells.some((cell) => cell.fieldIds.includes("fd_section_caption")), true);
    assert.ok(parseFloat(persisted.colsStyle[0].value) >= 20);
  });
});
