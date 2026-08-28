import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { draftSourceDraft, cleanSourceFile } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixturePath = "tests/fixtures/source/18aac2e235a65c382f6fe264e1dba521";
const boundCaptionFixturePath =
  "tests/fixtures/source/189438c54dee44ba9869deb439dbc163";
const boundAttachmentFixturePath =
  "tests/fixtures/source/16541cb5efe50b7a6848c5e434c8e6f7";
const explanatoryCaptionFixturePath =
  "tests/fixtures/source/149c6e78f7c015f4c7da952411fa0cef";
const boundCaptionRouteFixturePath =
  "tests/fixtures/route-validation/bound-subject-caption/route-bound-subject-caption_SysFormTemplate.xml";
const cellCaptionFixturePath =
  "tests/fixtures/route-validation/structural-recovery/route-structural-recovery-cell-captions_SysFormTemplate.xml";
const retainedCaptionFixturePath =
  "tests/fixtures/route-validation/structural-recovery/route-retained-editor-captions_SysFormTemplate.xml";

describe("retained source text and editor title visibility", () => {
  it("retains independent text and hides only source-proven editor labels across component families", () => {
    const source = cleanSourceFile(retainedCaptionFixturePath);
    const draft = draftSourceDraft(source);
    const fields = new Map(draft.form.fields.map((field) => [field.id, field]));
    for (const [id, captionId, title] of [
      ["fd_first", "first_caption", "审批内容"],
      ["fd_second", "second_caption", "付款内容"],
      ["fd_note", "note_caption", "内部说明"],
      ["fd_code", "code_caption", "内部编码"]
    ]) {
      assert.equal(fields.get(captionId)?.componentId, "xform-description", captionId);
      assert.equal(fields.get(id)?.title, title, id);
      assert.equal(fields.get(id)?.props.hiddenLabel, true, id);
      assert.equal(fields.get(id)?.sourceProps.layoutCell.relation, "retained-source-caption", id);
    }
    assert.equal(fields.get("fd_conditional")?.props.hiddenLabel, undefined);
    assert.equal(fields.get("fd_merged")?.title, "实际标题");
    assert.equal(fields.get("fd_merged")?.props.hiddenLabel, undefined);
    assert.equal(fields.has("merged_caption"), false);
    assert.ok(source.issues.some((issue) => issue.code === "source.sysform.label_visibility_unverified"));

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true, reviewerName: "route-test"
    });
    const prepared = prepareSample(trusted);
    const readback = prepared.verify(prepared.update);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    for (const id of ["fd_first", "fd_second", "fd_note", "fd_code"]) {
      assert.equal(readback.form.fields.find((field) => field.id === id)?.hiddenLabel, true, id);
    }
    for (const rowId of ["row-0", "row-1"]) {
      const row = readback.form.layoutRows.find((item) => item.id === rowId);
      assert.equal(row?.columns, 4);
      assert.deepEqual(row.cells.map((cell) => [cell.column, cell.colspan]), [[0, 1], [1, 3]]);
      assert.equal(row.colsStyle[0].value, "20%");
    }
    const mixedUnits = readback.form.layoutRows.find((row) => row.id === "row-3");
    assert.equal(mixedUnits.colsStyle, undefined);
    assert.deepEqual(mixedUnits.cells.map((cell) => cell.colspan), [1, 3]);

    const corrupt = structuredClone(prepared.update);
    const config = xformConfig(corrupt);
    const scene = JSON.parse(config.viewModel[0].fdConfig);
    const firstRow = scene.view.render.desktop[0].children[0].children.find(
      (row) => row.controlProps?.migrationRootNodeId === "layout.row-0"
    );
    delete firstRow.children[0].controlProps.colsStyle;
    config.viewModel[0].fdConfig = JSON.stringify(scene);
    corrupt.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    assert.equal(prepared.verify(corrupt).partitions.form, "mismatch");
  });

  it("preserves the payment form's two numbered texts, hidden rich-text headings, and source widths", () => {
    const source = cleanSourceFile("tests/fixtures/source2/168e0707391cd798757474c4670a79eb");
    const draft = draftSourceDraft(source);
    const fields = new Map(draft.form.fields.map((field) => [field.id, field]));
    for (const [captionId, fieldId, rowId] of [
      ["fd_327d2d8ebcaf38", "fd_3352cba9e70d9c", "row-11"],
      ["fd_327d2d8f0912c6", "fd_3352cabd660662", "row-12"]
    ]) {
      assert.equal(fields.get(captionId)?.componentId, "xform-description");
      assert.equal(fields.get(fieldId)?.props.hiddenLabel, true);
      const row = draft.form.layout.mkTree.find((item) => item.id === `layout.${rowId}`);
      assert.deepEqual(row.children.map((cell) => cell.colspan), [1, 3]);
      assert.deepEqual(row.children.map((cell) => cell.widthWeight), [257, 1105]);
    }
  });
});

describe("unbound cross-cell captions", () => {
  it("renders the S2 detail caption once without dropping an unrelated numeric-titled field", () => {
    const source = cleanSourceFile(
      "tests/fixtures/source2/168e5c210af398348bdcf0f4d9b941f9/168e5da7d6f22aed78f58a4427b8f971_SysFormTemplate.xml"
    );
    const draft = draftSourceDraft(source);
    const table = draft.form.fields.find((field) => field.id === "fd_3711909a622e14");
    assert.deepEqual(table?.sourceProps.boundCaption, {
      id: "fd_3711916bbbcc5e",
      content: "客户干系人",
      relation: "adjacent-title-cell"
    });
    assert.equal(draft.form.fields.some((field) => field.id === "fd_3711916bbbcc5e"), false);

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-test"
    });
    const prepared = prepareSample(trusted);
    const readback = prepared.verify(prepared.update);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.deepEqual(
      readback.form.fields.filter((field) => field.title === "客户干系人").map((field) => field.id),
      ["fd_3711909a622e14"]
    );
    const retainedField = readback.form.fields.find((field) => field.id === "fd_3717daae84932a");
    assert.equal(retainedField?.title, "13");
    assert.equal(retainedField?.component, "xform-input");
  });

  it("recovers a unique title-cell caption for rich text, text, and a detail table through native persistence", () => {
    const source = cleanSourceFile(cellCaptionFixturePath);
    const draft = draftSourceDraft(source);
    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-test",
      checkedAt: "2026-08-28T00:00:00.000Z"
    });
    const prepared = prepareSample(trusted);
    const readback = prepared.verify(prepared.update);

    for (const [fieldId, captionId, title, subject, component] of [
      ["fd_brief", "brief_caption", "需求概述", "内部备注", "xform-rich-text"],
      ["fd_applicant", "label_applicant", "申请人", "申请者姓名", "xform-input"],
      ["fd_items", "items_caption", "申请明细", "明细表1", "xform-detail-table"]
    ]) {
      const field = draft.form.fields.find((item) => item.id === fieldId);
      assert.equal(field?.title, title, fieldId);
      assert.equal(field?.componentId, component, fieldId);
      assert.equal(field?.sourceProps.designerValues.label, subject, fieldId);
      assert.equal(field?.sourceProps.metadataAttributes.label, subject, fieldId);
      assert.deepEqual(field?.sourceProps.boundCaption, {
        id: captionId,
        content: title,
        relation: "adjacent-title-cell"
      });
      assert.equal(draft.form.fields.some((item) => item.id === captionId), false, captionId);
      assert.equal(readback.form.fields.find((item) => item.id === fieldId)?.title, title, fieldId);
      assert.equal(readback.form.fields.some((item) => item.id === captionId), false, captionId);
      const row = readback.form.layoutRows.find((item) => item.fields.includes(fieldId));
      assert.deepEqual(row?.fields, [fieldId]);
      assert.equal(row?.columns, 1);
    }
    assert.equal(readback.partitions.form, "verified");
  });

  it("preserves explanations, grouped captions, existing bindings, and hidden field identities", () => {
    const draft = draftSourceDraft(cleanSourceFile(cellCaptionFixturePath));
    const fields = new Map(draft.form.fields.map((field) => [field.id, field]));

    for (const captionId of [
      "plain_note", "warning_note", "group_caption", "range_caption",
      "conflicting_caption", "hidden_caption", "shared_caption"
    ]) {
      assert.equal(fields.get(captionId)?.componentId, "xform-description", captionId);
    }
    for (const [fieldId, title] of [
      ["fd_note_value", "说明内容"], ["fd_warning_value", "处理意见"],
      ["fd_project_name", "项目名称"], ["fd_project_code", "项目编码"],
      ["fd_start", "开始"], ["fd_end", "结束"],
      ["fd_explicit", "正式字段名"], ["fd_hidden", "隐藏值"],
      ["fd_recipient", "收件人"], ["fd_phone", "电话"]
    ]) {
      assert.equal(fields.get(fieldId)?.title, title, fieldId);
      assert.equal(fields.get(fieldId)?.sourceProps.boundCaption, undefined, fieldId);
    }
    assert.equal(fields.get("fd_hidden")?.dataOnly, true);
  });
});

describe("leading visible subject captions", () => {
  it("uses visible textLabel captions as titles for unbound invoice subjects", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixturePath));
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));

    assert.equal(fields.get("fd_3c539454d0fdf6")?.title, "建筑服务发生省市");
    assert.deepEqual(fields.get("fd_3c539454d0fdf6")?.sourceProps.inlineCaption, {
      id: "fd_3c5394120cadc8",
      content: "建筑服务发生省市",
      relation: "leading-unbound-subject-caption"
    });
    assert.deepEqual(fields.get("fd_3c539454d0fdf6")?.sourceProps.subjectLabel, {
      content: "建筑服务省市",
      relation: "unbound-control-subject-distinct-from-visible-caption"
    });
    assert.equal(fields.has("fd_3c5394120cadc8"), false);

    assert.equal(fields.get("fd_3c539457ff1db0")?.title, "建筑服务发生所在详细地址");
    assert.deepEqual(fields.get("fd_3c539457ff1db0")?.sourceProps.subjectLabel, {
      content: "建筑服务详细地址",
      relation: "unbound-control-subject-distinct-from-visible-caption"
    });
    assert.equal(fields.has("fd_3c53941e6eb7ba"), false);
  });

  it("uses a directly leading visible caption over a distinct bound field subject", () => {
    const source = cleanSourceFile(boundCaptionFixturePath);
    const sourceControls = new Map(source.form.controls.map((control) => [control.id, control]));
    const sourceInvoiceNumber = sourceControls.get("fphm");
    const sourceInvoiceRow = source.form.layout.rows.find((row) =>
      row.cells.some((cell) =>
        cell.references.some((reference) => reference.referenceId === "fphm")
      )
    );

    assert.equal(sourceInvoiceNumber?.title, "发票号码");
    assert.deepEqual(sourceInvoiceNumber?.sourceProps.inlineCaption, {
      id: "fd_3bd82e69a15a7a",
      content: "发票号码",
      relation: "leading-bound-subject-caption"
    });
    assert.deepEqual(sourceInvoiceNumber?.sourceProps.subjectLabel, {
      content: "发票信息",
      relation: "bound-control-subject-distinct-from-visible-caption"
    });
    assert.deepEqual(
      sourceInvoiceRow?.cells.flatMap((cell) =>
        cell.references.map((reference) => reference.referenceId)
      ),
      ["fphm", "fd_3c23c063629a08"]
    );
    assert.equal(sourceControls.has("fd_3bd82e69a15a7a"), false);

    const dsl = draftSourceDraft(source);
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const invoiceNumber = fields.get("fphm");
    const invoiceRow = dsl.form.layout.mkTree.find((row) =>
      row.children.some((cell) => cell.refIds.includes("fphm"))
    );

    assert.equal(invoiceNumber?.title, "发票号码");
    assert.deepEqual(invoiceNumber?.sourceProps.inlineCaption, {
      id: "fd_3bd82e69a15a7a",
      content: "发票号码",
      relation: "leading-bound-subject-caption"
    });
    assert.deepEqual(invoiceNumber?.sourceProps.subjectLabel, {
      content: "发票信息",
      relation: "bound-control-subject-distinct-from-visible-caption"
    });
    assert.deepEqual(invoiceNumber?.sourceProps.boundCaption, {
      id: "fd_3bd82e63125682",
      content: "发票信息",
      relation: "explicit-label-bind-id"
    });
    assert.equal(fields.has("fd_3bd82e69a15a7a"), false);
    assert.deepEqual(
      invoiceRow?.children.flatMap((cell) => cell.refIds),
      ["fphm", "fd_3c23c063629a08"]
    );
  });

  it("keeps a numbered leading caption separate from a bound attachment", () => {
    const dsl = draftSourceDraft(cleanSourceFile(boundAttachmentFixturePath));
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const attachment = fields.get("fd_3688ac02807566");
    const attachmentRow = dsl.form.layout.mkTree.find((row) =>
      row.children.some((cell) => cell.refIds.includes("fd_3688ac02807566"))
    );

    assert.equal(fields.get("fd_3688abf410c754")?.componentId, "xform-description");
    assert.equal(attachment?.title, "附件明细");
    assert.equal(attachment?.sourceProps.inlineCaption, undefined);
    assert.deepEqual(
      attachmentRow?.children.flatMap((cell) => cell.refIds),
      ["fd_3688abf410c754", "fd_3688ac02807566"]
    );
  });

  it("keeps unpunctuated explanatory text separate from bound text inputs", () => {
    const dsl = draftSourceDraft(cleanSourceFile(explanatoryCaptionFixturePath));
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));

    assert.equal(fields.get("fd_3ded0cd58049b4")?.componentId, "xform-description");
    assert.equal(fields.get("fd_3dedc36797efc8")?.title, "具体影响");
    assert.equal(fields.get("fd_3ded0d12880086")?.componentId, "xform-description");
    assert.equal(fields.get("fd_3dedc36b55fd78")?.title, "具体影响");
  });

  it("keeps a punctuated explanation when it lacks subject-caption affinity", () => {
    const source = cleanSourceFile(boundCaptionRouteFixturePath);
    const controls = new Map(source.form.controls.map((control) => [control.id, control]));

    assert.equal(controls.get("label_instruction")?.sourceType, "description");
    assert.equal(controls.get("label_instruction")?.title, "填写说明：");
    assert.equal(controls.get("fd_impact")?.title, "具体影响");
    assert.equal(controls.get("fd_impact")?.sourceProps.inlineCaption, undefined);
  });

  it("prioritizes a cross-cell visible caption over a matching bound-title segment", () => {
    const source = cleanSourceFile(boundCaptionRouteFixturePath);
    const contractNumber = source.form.controls.find(
      (control) => control.id === "fd_contract_number"
    );

    assert.equal(contractNumber?.title, "号码");
    assert.deepEqual(contractNumber?.sourceProps.inlineCaption, {
      id: "label_number",
      content: "号码",
      relation: "leading-bound-subject-caption"
    });
    assert.deepEqual(contractNumber?.sourceProps.subjectLabel, {
      content: "合同-号码",
      relation: "bound-control-subject-distinct-from-visible-caption"
    });
  });
});
