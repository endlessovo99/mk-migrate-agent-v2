import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

const fixture =
  "tests/fixtures/route-validation/nested-description-grid/route-nested-description-grid_SysFormTemplate.xml";

const nestedRowIds = [
  "row-1.nested-0.row-0",
  "row-1.nested-0.row-1",
  "row-1.nested-0.row-2"
];

const headerTitles = [
  "需要完成的事项",
  "新应用",
  "（高/中风险）程序修改",
  "BUG/低风险程序修改",
  "功能优化（配置文件变动）"
];

describe("nested all-text description grid Route-validation", () => {
  it("keeps the five-column Y/N checklist under the attachment row", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const fields = new Map(draft.form.fields.map((field) => [field.id, field]));

    assert.deepEqual(source.form.layout.rows.map((row) => row.id), [
      "row-0",
      "row-1",
      ...nestedRowIds
    ]);
    assert.deepEqual(rowRefs(source.form.layout, "row-0"), ["fd_attach_caption", "fd_attach"]);
    assert.deepEqual(rowTitles(source, "row-0"), ["附件上传", "附件上传"]);
    assert.deepEqual(
      source.form.layout.rows.find((row) => row.id === "row-1")?.cells.map((cell) => ({
        column: cell.column,
        colspan: cell.colspan,
        references: (cell.references || []).map((reference) => ({
          referenceType: reference.referenceType,
          referenceId: reference.referenceId
        }))
      })),
      [{
        column: 0,
        colspan: 4,
        references: nestedRowIds.map((rowId) => ({
          referenceType: "layout",
          referenceId: rowId
        }))
      }]
    );
    assert.deepEqual(rowTitles(source, "row-1.nested-0.row-0"), headerTitles);
    assert.deepEqual(rowTitles(source, "row-1.nested-0.row-1"), [
      "集成测试报告",
      "Y",
      "Y",
      "N",
      "N"
    ]);
    assert.deepEqual(rowTitles(source, "row-1.nested-0.row-2"), [
      "最终用户使用手册",
      "Y",
      "Y",
      "N",
      "N"
    ]);

    for (const fieldId of [
      "fd_h_item",
      "fd_h_new",
      "fd_r1_item",
      "fd_r1_new",
      "fd_r1_bug",
      "fd_r2_item"
    ]) {
      assert.equal(fields.get(fieldId)?.type, "description", fieldId);
      assert.equal(fields.get(fieldId)?.componentId, "xform-description", fieldId);
    }
    assert.equal(fields.get("fd_attach")?.componentId, "xform-attach");
    assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));

    const nestedNodes = nestedRowIds.map((rowId) =>
      draft.form.layout.mkTree.find((node) => node.id === `layout.${rowId}`)
    );
    for (const node of nestedNodes) {
      assert.equal(node?.componentId, "xform-multi-row-table-layout", node?.id);
      assert.deepEqual(node?.props, { rows: 1, columns: 5 }, node?.id);
      assert.equal(node?.children.length, 5, node?.id);
    }

    const parent = draft.form.layout.mkTree.find((node) => node.id === "layout.row-1");
    assert.equal(parent?.componentId, "xform-flex-1-4-layout");
    assert.deepEqual(parent?.children, [{
      id: parent.children[0].id,
      refType: "layout",
      refIds: nestedRowIds.map((rowId) => `layout.${rowId}`),
      sourceRef: parent.children[0].sourceRef,
      column: 0,
      colspan: 4
    }]);

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-test",
      checkedAt: "2026-09-07T00:00:00.000Z"
    });
    const prepared = prepareSample(trusted);
    const readback = prepared.verify(prepared.update);
    const nativeGrid = readback.form.layoutRows.find((row) => row.rootNodeId === "layout.row-1");

    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.partitions.form, "verified");
    assert.equal(nativeGrid?.rows, 3);
    assert.ok(nativeGrid?.columns >= 5, JSON.stringify(nativeGrid));
    for (const [index, ownerNodeId] of nestedRowIds.map((rowId) => `layout.${rowId}`).entries()) {
      const cells = nativeGrid.cells.filter((cell) => cell.ownerNodeId === ownerNodeId);
      assert.equal(cells.length, 5, ownerNodeId);
      assert.deepEqual([...new Set(cells.map((cell) => cell.row))], [index]);
    }
    assert.deepEqual(
      nativeGrid.cells
        .filter((cell) => cell.ownerNodeId === "layout.row-1.nested-0.row-0")
        .map((cell) => cell.fieldIds),
      headerTitles.map((_, index) => [[
        "fd_h_item",
        "fd_h_new",
        "fd_h_high",
        "fd_h_bug",
        "fd_h_opt"
      ][index]])
    );
    const headerItem = readback.form.fields.find((field) => field.id === "fd_h_item");
    const reportItem = readback.form.fields.find((field) => field.id === "fd_r1_item");
    assert.equal(headerItem?.title, "需要完成的事项");
    assert.equal(headerItem?.content, "需要完成的事项");
    assert.equal(reportItem?.title, "集成测试报告");
    assert.equal(reportItem?.content, "集成测试报告");
  });
});

function rowRefs(layout, rowId) {
  return layout.rows
    .find((row) => row.id === rowId)
    ?.cells.flatMap((cell) =>
      (cell.references || []).map((reference) => reference.referenceId)
    ) || [];
}

function rowTitles(source, rowId) {
  const fields = new Map(source.form.controls.map((field) => [field.id, field]));
  return rowRefs(source.form.layout, rowId).map((fieldId) => fields.get(fieldId)?.title || fieldId);
}
