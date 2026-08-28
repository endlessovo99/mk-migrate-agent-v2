import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample } from "../helpers/persistence.js";

const fixture =
  "tests/fixtures/source2/167017372174045e6d7c09c4d3a964fc";

describe("computer equipment form layout and node rights Route-validation", () => {
  it("uses the visible requirements caption as the rich-text title without a second control", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const fieldId = "fd_365b19d6c299ea";
    const captionId = "fd_3258ee6079d39c";
    const field = draft.form.fields.find((item) => item.id === fieldId);

    assert.equal(field?.title, "需求情况");
    assert.equal(field?.componentId, "xform-rich-text");
    assert.equal(field?.sourceProps.designerValues.label, "补充");
    assert.equal(field?.sourceProps.metadataAttributes.label, "补充");
    assert.deepEqual(field?.sourceProps.boundCaption, {
      id: captionId,
      content: "需求情况",
      relation: "adjacent-title-cell"
    });
    assert.equal(source.form.controls.some((item) => item.id === captionId), false);
    assert.deepEqual(rowRefs(source.form.layout, "row-2"), [fieldId]);
    assert.equal(
      draft.form.fields.find((item) => item.title.startsWith("关于员工领用电脑"))?.type,
      "description"
    );

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-test",
      checkedAt: "2026-08-28T00:00:00.000Z"
    });
    const prepared = prepareSample(trusted);
    const readback = prepared.verify(prepared.update);
    const nativeField = readback.form.fields.find((item) => item.id === fieldId);
    const nativeRow = readback.form.layoutRows.find((row) => row.rootNodeId === "layout.row-2");

    assert.equal(readback.partitions.form, "verified");
    assert.equal(nativeField?.title, "需求情况");
    assert.equal(nativeField?.component, "xform-rich-text");
    assert.equal(readback.form.fields.some((item) => item.id === captionId), false);
    assert.deepEqual(nativeRow?.fields, [fieldId]);
    assert.equal(nativeRow?.columns, 1);
  });

  it("preserves the five-column type grid content and source order", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const fields = new Map(draft.form.fields.map((field) => [field.id, field]));

    assert.deepEqual(source.form.layout.rows.map((row) => row.id), [
      "row-0",
      "row-1",
      "row-2",
      "row-4",
      "row-4.nested-0.row-0",
      "row-4.nested-0.row-1",
      "row-4.nested-0.row-2",
      "row-4.nested-0.row-3",
      "row-5",
      "row-6",
      "row-7",
      "row-7.nested-0.row-0",
      "row-7.nested-0.row-1"
    ]);

    assert.deepEqual(rowRefs(source.form.layout, "row-4.nested-0.row-0"), [
      "fd_3e711d312289ce",
      "fd_3e711d3650ff7a",
      "fd_3e711d4755735e",
      "fd_3e711d48a6b96a",
      "fd_3e711d49cfe7ac"
    ]);
    assert.deepEqual(rowTitles(source, "row-4.nested-0.row-0"), [
      "类型",
      "说明",
      "需求数量",
      "使用人员",
      "备注"
    ]);
    assert.deepEqual(
      source.form.layout.rows
        .find((row) => row.id === "row-4.nested-0.row-0")
        ?.cells.map((cell) => cell.widthWeight),
      [62, 524, 266, 235, 260]
    );

    for (const [rowId, expected] of [
      ["row-4.nested-0.row-1", ["A型", "（Thinkpad T14 16G内存／512G硬盘，适用于日常办公及一般开发。）", "fd_3e711d7aabd7fc", "fd_3e711d7e1c273a", "fd_3e711d7f10b104"]],
      ["row-4.nested-0.row-2", ["B型", "（Thinkpad T14 32G内存／512G硬盘，适用于重度开发。）", "fd_3e711d7c068878", "fd_3e711d80632d20", "fd_3e711d82a93ffc"]],
      ["row-4.nested-0.row-3", ["C型", "其他特殊需求的机型需提供具体要求（包含CPU、内存、硬盘等）：", "fd_3e711d7d244d20", "fd_3e711d817bfc20", "fd_3e711d83db24c8"]]
    ]) {
      const refs = rowRefs(source.form.layout, rowId);
      assert.equal(refs.length, 5, rowId);
      assert.equal(source.form.controls.find((field) => field.id === refs[0])?.title, expected[0]);
      assert.equal(source.form.controls.find((field) => field.id === refs[1])?.title, expected[1]);
      assert.deepEqual(refs.slice(2), expected.slice(2));
      for (const fieldId of refs.slice(2)) {
        assert.equal(fields.get(fieldId)?.props?.hiddenLabel, true, fieldId);
      }
    }
  });

  it("keeps the scheme recommendation rich text in layout and editable at IT administrator", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const scheme = source.form.controls.find((field) => field.id === "fd_365b19dc2d1f8c");
    const itAdministrator = draft.workflow.nodes.find((node) => node.id === "N12");

    assert.equal(scheme?.title, "方案建议");
    assert.equal(itAdministrator?.name, "IT设备管理员");
    assert.equal(
      source.form.dataFields.some((field) => field.id === "fd_365b19dc2d1f8c"),
      false
    );
    assert.deepEqual(rowRefs(source.form.layout, "row-7.nested-0.row-1"), [
      "fd_365b19dc2d1f8c"
    ]);
    assert.deepEqual(itAdministrator?.dataAuthority?.fields?.fd_365b19dc2d1f8c, {
      visible: true,
      editable: true,
      required: false,
      sourceMode: "edit",
      sourceRef:
        "source.form.dataAuthority.fdDesignerHtml.fd_365b1a0ac2aa62.N12.fd_365b19dc2d1f8c"
    });
    assert.equal(
      itAdministrator?.dataAuthority?.fields?.fd_3ba8efea20358a?.editable,
      true
    );

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-test",
      checkedAt: "2026-08-23T00:00:00.000Z"
    });
    const prepared = prepareSample(trusted);
    const readback = prepared.verify(prepared.update);
    const nativeScheme = readback.form.fields.find((field) => field.id === scheme.id);
    const nativeNode = readback.workflow.nodes.find((node) => node.id === "N12");
    const nativeTypeGrid = readback.form.layoutRows.find(
      (row) => row.rootNodeId === "layout.row-4"
    );

    assert.equal(readback.partitions.form, "verified");
    assert.equal(nativeScheme?.component, "xform-rich-text");
    assert.equal(nativeScheme?.dataOnly, false);
    assert.equal(nativeTypeGrid?.columns, 6);
    assert.deepEqual(nativeTypeGrid?.colsStyle, [
      { startIndex: 0, count: 1, value: "8.681672025723%" },
      { startIndex: 1, count: 1, value: "8.681672025723%" },
      { startIndex: 2, count: 1, value: "33.697749196141%" },
      { startIndex: 3, count: 1, value: "17.106109324759%" },
      { startIndex: 4, count: 1, value: "15.112540192926%" },
      { startIndex: 5, count: 1, value: "16.720257234727%" }
    ]);
    for (const [index, ownerNodeId] of [
      "layout.row-4.nested-0.row-0",
      "layout.row-4.nested-0.row-1",
      "layout.row-4.nested-0.row-2",
      "layout.row-4.nested-0.row-3"
    ].entries()) {
      const cells = nativeTypeGrid.cells.filter((cell) => cell.ownerNodeId === ownerNodeId);
      assert.equal(cells.length, 5, ownerNodeId);
      assert.deepEqual([...new Set(cells.map((cell) => cell.row))], [index]);
      assert.deepEqual(cells.map((cell) => cell.column), [1, 2, 3, 4, 5]);
    }
    assert.deepEqual(nativeNode?.dataAuthority?.fields?.fd_365b19dc2d1f8c, {
      visible: true,
      editable: true,
      required: false
    });
    assert.equal(
      nativeNode?.dataAuthority?.fields?.fd_3ba8efea20358a?.editable,
      true
    );
  });
});

function rowRefs(layout, rowId) {
  return layout.rows
    .find((row) => row.id === rowId)
    ?.cells.flatMap((cell) => cell.references.map((reference) => reference.referenceId)) || [];
}

function rowTitles(source, rowId) {
  const fields = new Map(source.form.controls.map((field) => [field.id, field]));
  return rowRefs(source.form.layout, rowId).map((fieldId) => fields.get(fieldId)?.title);
}
