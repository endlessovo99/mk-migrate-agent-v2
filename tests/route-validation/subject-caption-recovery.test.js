import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { draftSourceDraft, cleanSourceFile } from "../../src/translator/index.js";

const fixturePath = "tests/fixtures/source/18aac2e235a65c382f6fe264e1dba521";
const boundCaptionFixturePath =
  "tests/fixtures/source/189438c54dee44ba9869deb439dbc163";
const boundAttachmentFixturePath =
  "tests/fixtures/source/16541cb5efe50b7a6848c5e434c8e6f7";
const explanatoryCaptionFixturePath =
  "tests/fixtures/source/149c6e78f7c015f4c7da952411fa0cef";
const boundCaptionRouteFixturePath =
  "tests/fixtures/route-validation/bound-subject-caption/route-bound-subject-caption_SysFormTemplate.xml";

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
