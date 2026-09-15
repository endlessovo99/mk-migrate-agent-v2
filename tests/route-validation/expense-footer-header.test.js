import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
const source = cleanSourceFile("tests/fixtures/route-validation/expense-footer-header/route-expense-header_SysFormTemplate.xml");
const draft = draftSourceDraft(source);
const tableId = "fd_37b69f78212092", columnId = "fd_37b69ffdb46782";

describe("expense footer captions do not replace column headers", () => {
  it("uses the visible header despite an aggregate footer and stale label binding", () => {
    const table = draft.form.fields.find(f => f.id === tableId);
    const column = table.columns.find(c => c.id === columnId);
    assert.equal(column.title, "内容及科目变化");
    assert.equal(column.sourceProps.detailHeaderCaption.content, "内容及科目变化");
    assert.equal(column.sourceProps.metadataAttributes.label, "人工成本相关内容及科目编号");
    for (const id of ["fd_37b69e4a1de88c", "fd_3935f7e6ae8ec4"]) {
      assert.equal(draft.form.fields.flatMap(f => f.columns || []).find(c => c.id === id).title, "内容及科目编号");
    }
    assert.equal(column.props.required, true);
    assert.equal(column.props.options.length, 22);
    const total = draft.form.fields.find(f => f.id === "fd_37b737bf68dc3e");
    assert.deepEqual(total.props.calculation, {kind: "aggregate", operation: "sum", tableId, fieldId: "fd_37b6a00391f5b6"});
  });

  it("persists the corrected title and verifies complete form readback", () => {
    const prepared = prepareSample(draft);
    const cfg = xformConfig(prepared.update);
    const field = cfg.dataModel.flatMap(m => m.fdFields).find(f => f.fdName === columnId);
    assert.equal(JSON.parse(field.fdAttribute).config.controlProps.title, "内容及科目变化");
    const result = prepared.verify(prepared.update);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  });

  it("rejects native readback restoring the internal metadata title", () => {
    const prepared = prepareSample(draft);
    const altered = structuredClone(prepared.update);
    const cfg = xformConfig(altered);
    const field = cfg.dataModel.flatMap(m => m.fdFields).find(f => f.fdName === columnId);
    const attrs = JSON.parse(field.fdAttribute);
    field.fdLabel = "人工成本相关内容及科目编号";
    attrs.config.controlProps.title = "人工成本相关内容及科目编号";
    field.fdAttribute = JSON.stringify(attrs);
    altered.mechanisms["sys-xform"].fdConfig = JSON.stringify(cfg);
    assert.equal(prepared.verify(altered).ok, false);
  });
});
