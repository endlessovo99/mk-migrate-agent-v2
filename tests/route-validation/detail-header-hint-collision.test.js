import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { draftSourceDraft } from "../../src/translator/index.js";
import { sourceDraftFromLegacyDsl } from "../../src/translator/source-draft.js";
import { translateSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

it("keeps a detail header when its disabled label binding points to the inline hint", () => {
  const path = "tests/fixtures/route-validation/semantic-props/route-semantic-props_SysFormTemplate.xml";
  const properties = parseRootHashMapStringPuts(readFileSync(path, "utf8"));
  const html = properties.fdDesignerHtml;
  properties.fdDesignerHtml = html
    .replace('<tr>\n        <td row="0" column="0">', '<tr type="titleRow">\n        <td row="0" column="0">')
    .replace('id:"fd_ebeln",label:"采购订单号",tableName:',
      'id:"fd_ebeln",label:"采购订单号",_label_bind:"false",_label_bind_id:"hint_ebeln",tableName:');
  assert.notEqual(properties.fdDesignerHtml, html);
  const encode = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const xml = '<java><object class="java.util.HashMap">' + Object.entries(properties)
    .map(([key, value]) => `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`)
    .join("") + "</object></java>";
  const source = sourceDraftFromLegacyDsl(translateSysFormTemplateXml(xml));
  const draft = draftSourceDraft(source);
  const sourceField = source.form.detailTables[0].columns.find(field => field.id === "fd_ebeln");
  const column = draft.form.fields.find(field => field.id === "fd_detail").columns.find(field => field.id === "fd_ebeln");
  assert.equal(sourceField.sourceProps.detailHeaderCaption.content, "采购订单号");
  assert.equal(sourceField.sourceProps.inlineHint.content, "*不超过10个字符");
  assert.equal(sourceField.title, "采购订单号");
  assert.equal(column.title, "采购订单号");
  assert.equal(column.props.placeholder, "*不超过10个字符");
  const native = xformConfig(prepareSample(draft).update).dataModel
    .find(model => model.fdCode === "fd_detail").fdFields.find(field => field.fdName === "fd_ebeln");
  assert.equal(native.fdLabel, "采购订单号");
  assert.equal(JSON.parse(native.fdAttribute).config.controlProps.title, "采购订单号");
});
