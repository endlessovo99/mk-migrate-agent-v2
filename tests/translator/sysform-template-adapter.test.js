import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadFunctionWhitelist } from "../../src/translator/function-whitelist.js";
import { parseSysFormTemplateXml, translateSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { localCorpusIt } from "../helpers/local-corpus.js";

const whitelistPath = "tests/fixtures/function-whitelist.json";

describe("translateSysFormTemplateXml", () => {
  it("translates a SysFormTemplate XML fixture into valid DSL", () => {
    const sourcePath = "tests/fixtures/source/route-validation-lbpm/route-validation_SysFormTemplate.xml";
    const xml = readFileSync(sourcePath, "utf8");
    const dsl = translateSysFormTemplateXml(xml, { sourcePath });
    const byId = new Map(dsl.form.fields.map((field) => [field.id, field]));

    assert.equal(dsl.source.kind, "sysform-template-xml");
    assert.equal(dsl.source.fdId, "route-validation-sysform-id");
    assert.equal(dsl.template.name, "示例流程表单");
    assert.equal(byId.get("fd_type")?.type, "singleSelect");
    assert.equal(byId.get("fd_type")?.mk.component, "xform-select");
    assert.equal(byId.get("fd_type")?.mk.itemTid, "xform-ide-sidebar-tabPane-control-@elem-xform-select");
    assert.deepEqual(byId.get("fd_type")?.options, [
      { label: "类型A", value: "A" },
      { label: "类型B", value: "B" }
    ]);

    assert.equal(byId.get("fd_subject")?.mk.component, "xform-input");
    assert.equal(byId.get("fd_org")?.type, "text");
    assert.equal(byId.get("fd_org")?.mk.component, "xform-address");

    const detailTable = byId.get("fd_detail");
    assert.equal(detailTable?.type, "detailTable");
    assert.equal(detailTable?.mk.component, "xform-detail-table");
    assert.deepEqual(detailTable.columns.map((column) => [column.id, column.title, column.type]), [
      ["fd_name", "名称", "text"],
      ["fd_amount", "数量", "number"]
    ]);
    assert.deepEqual(detailTable.columns.map((column) => [column.id, column.mk.component]), [
      ["fd_name", "xform-input"],
      ["fd_amount", "xform-number"]
    ]);
  });

  it("uses designer controls as canonical fields and preserves row-column layout", () => {
    const designerHtml = `
      <table fd_type="standardTable">
        <tbody>
          <tr>
            <td row="0" column="0"><label fd_type="textLabel" fd_values='{id:"label_subject",content:"主题"}'>主题</label></td>
            <td row="0" column="1"><div fd_type="inputText" fd_values='{id:"fd_subject",label:"主题",required:"true"}'><input id="fd_subject"/></div></td>
            <td row="0" column="2"><label fd_type="textLabel" fd_values='{id:"label_org",content:"申请单位"}'>申请单位</label></td>
            <td row="0" column="3"><label fd_type="address" fd_values='{id:"fd_sqdw",label:"申请单位",required:"true",_orgType:"ORG_TYPE_ORG|ORG_TYPE_DEPT"}'></label></td>
          </tr>
          <tr>
            <td row="1" column="0"><label fd_type="textLabel" fd_values='{id:"label_detail",content:"明细表1"}'>明细表1</label></td>
            <td row="1" column="1,2,3"><table fd_type="detailsTable" fd_values='{id:"fd_fjmx",label:"明细表1"}'></table></td>
          </tr>
        </tbody>
      </table>
    `;
    const metadataXml = `
      <metadata>
        <extendSimpleProperty name="fd_subject" label="主题" type="String" notNull="true"/>
        <extendElementProperty name="fd_meta_org" label="申请单位" type="com.landray.kmss.sys.organization.model.SysOrgElement" notNull="true"/>
        <extendSubTableProperty name="fd_meta_detail" label="明细表1">
          <extendSimpleProperty name="fd_file_name" label="文件名称" type="String"/>
        </extendSubTableProperty>
      </metadata>
    `;
    const xml = sysFormXml({ fdDesignerHtml: designerHtml, fdMetadataXml: metadataXml });
    const dsl = translateSysFormTemplateXml(xml, { sourcePath: "designer-first_SysFormTemplate.xml" });
    const byId = new Map(dsl.form.fields.map((field) => [field.id, field]));

    assert.deepEqual(dsl.form.fields.map((field) => field.id), ["fd_subject", "fd_sqdw", "fd_fjmx"]);
    assert.equal(byId.get("fd_sqdw")?.source?.designerId, "fd_sqdw");
    assert.equal(byId.get("fd_sqdw")?.source?.metadataId, "fd_meta_org");
    assert.equal(byId.get("fd_sqdw")?.mk.component, "xform-address");
    assert.equal(byId.get("fd_fjmx")?.source?.metadataId, "fd_meta_detail");
    assert.deepEqual(byId.get("fd_fjmx")?.columns.map((column) => [column.id, column.title]), [
      ["fd_file_name", "文件名称"]
    ]);
    assert.deepEqual(dsl.form.layout.rows.map((row) => row.cells.map((cell) => cell.fieldId)), [
      ["fd_subject", "fd_sqdw"],
      ["fd_fjmx"]
    ]);
    assert.deepEqual(dsl.form.layout.rows[1].cells[0], {
      id: "row-1-cell-1",
      fieldId: "fd_fjmx",
      fieldIds: ["fd_fjmx"],
      column: 1,
      colspan: 3
    });
    assert.equal(
      dsl.review.warnings.some((warning) => warning.code === "source.sysform.metadata_id_mismatch"),
      true
    );
  });

  it("keeps rows after a nested detail table body while extracting designer layout", () => {
    const designerHtml = `
      <table fd_type="standardTable">
        <tbody>
          <tr><td row="0" column="0"><div fd_type="inputText" fd_values='{id:"fd_before",label:"前置字段"}'></div></td></tr>
          <tr>
            <td row="1" column="0">
              <table fd_type="detailsTable" fd_values='{id:"fd_detail",label:"明细"}'>
                <tbody><tr><td row="0" column="0"><div fd_type="inputText" fd_values='{id:"fd_inner",label:"内部字段"}'></div></td></tr></tbody>
              </table>
            </td>
          </tr>
          <tr><td row="2" column="0"><div fd_type="inputText" fd_values='{id:"fd_after",label:"后置字段"}'></div></td></tr>
        </tbody>
      </table>
    `;
    const metadataXml = `
      <metadata>
        <extendSimpleProperty name="fd_before" label="前置字段" type="String"/>
        <extendSubTableProperty name="fd_detail" label="明细">
          <extendSimpleProperty name="fd_inner" label="内部字段" type="String"/>
        </extendSubTableProperty>
        <extendSimpleProperty name="fd_after" label="后置字段" type="String"/>
      </metadata>
    `;
    const dsl = translateSysFormTemplateXml(sysFormXml({ fdDesignerHtml: designerHtml, fdMetadataXml: metadataXml }));

    assert.deepEqual(dsl.form.layout.rows.map((row) => row.cells.map((cell) => cell.fieldId)), [
      ["fd_before"],
      ["fd_detail"],
      ["fd_after"]
    ]);
  });

  it("preserves field order inside one designer layout cell", () => {
    const designerHtml = `
      <table fd_type="standardTable">
        <tbody>
          <tr>
            <td row="0" column="0,1">
              <div fd_type="inputText" fd_values='{id:"fd_first",label:"第一字段"}'></div>
              <div fd_type="inputText" fd_values='{id:"fd_second",label:"第二字段"}'></div>
            </td>
          </tr>
        </tbody>
      </table>
    `;
    const metadataXml = `
      <metadata>
        <extendSimpleProperty name="fd_first" label="第一字段" type="String"/>
        <extendSimpleProperty name="fd_second" label="第二字段" type="String"/>
      </metadata>
    `;
    const dsl = translateSysFormTemplateXml(sysFormXml({ fdDesignerHtml: designerHtml, fdMetadataXml: metadataXml }));

    assert.deepEqual(dsl.form.layout.rows[0].cells[0].fieldIds, ["fd_first", "fd_second"]);
    assert.equal(dsl.form.layout.rows[0].cells[0].fieldId, "fd_first");
  });

  localCorpusIt("flags placeholder detail table titles for agent review", () => {
    const xml = readFileSync(
      "tests/fixtures/source/19bb55286bd93a6081a33e44c3791374/19bb557531db577cfc0bbb248719d041_SysFormTemplate.xml",
      "utf8"
    );
    const dsl = translateSysFormTemplateXml(xml, { sourcePath: "19bb557531db577cfc0bbb248719d041_SysFormTemplate.xml" });
    const detailTitles = new Map(dsl.form.fields.filter((field) => field.type === "detailTable").map((field) => [field.id, field.title]));
    const suspiciousWarnings = dsl.review.warnings
      .filter((warning) => warning.code === "source.sysform.detail_table_title_suspicious");

    assert.equal(detailTitles.get("fd_371228ebe5dec2"), "itTable");
    assert.equal(detailTitles.get("fd_3712295cc683f8"), "明细表4");
    assert.equal(detailTitles.get("fd_371229609fc872"), "明细表5");
    assert.equal(detailTitles.get("fd_371229626e4df0"), "weibaoTable");
    assert.deepEqual(suspiciousWarnings.map((warning) => warning.details.id), [
      "fd_371228ebe5dec2",
      "fd_3712295cc683f8",
      "fd_371229609fc872",
      "fd_371229626e4df0"
    ]);
    assert.deepEqual(
      suspiciousWarnings.find((warning) => warning.details.id === "fd_371229609fc872")?.details.columnTitles,
      ["维修设备名称", "维修规格", "使用人2", "维修固资编号", "维修设备编号"]
    );
  });

  localCorpusIt("extracts designer JSP snippets as MK script candidates", () => {
    const xml = readFileSync(
      "tests/fixtures/source/19bb55286bd93a6081a33e44c3791374/19bb557531db577cfc0bbb248719d041_SysFormTemplate.xml",
      "utf8"
    );
    const dsl = translateSysFormTemplateXml(xml, { sourcePath: "19bb557531db577cfc0bbb248719d041_SysFormTemplate.xml" });

    assert.equal(dsl.scripts.fragments.length, 8);
    assert.equal(dsl.scripts.sources.length, 2);
    assert.deepEqual([...new Set(dsl.scripts.sources.map((source) => source.sourceKey))], ["fdDesignerHtml"]);
    assert.equal(dsl.scripts.fragments.some((fragment) => fragment.id === "fd_37157731108fc2"), true);
    assert.equal(
      dsl.scripts.sources[0].functionAudit.matched.some((item) => item.name === "GetXFormFieldById"),
      true
    );
  });

  it("does not flag explicit business detail table titles", () => {
    const designerHtml = `
      <table fd_type="standardTable">
        <tbody>
          <tr><td row="0" column="0"><table fd_type="detailsTable" fd_values='{id:"fd_fee",label:"费用明细"}'></table></td></tr>
        </tbody>
      </table>
    `;
    const metadataXml = `
      <metadata>
        <extendSubTableProperty name="fd_fee" label="费用明细">
          <extendSimpleProperty name="fd_amount" label="金额" type="Double"/>
        </extendSubTableProperty>
      </metadata>
    `;
    const dsl = translateSysFormTemplateXml(sysFormXml({ fdDesignerHtml: designerHtml, fdMetadataXml: metadataXml }));
    const detailTable = dsl.form.fields.find((field) => field.id === "fd_fee");

    assert.equal(detailTable?.title, "费用明细");
    assert.equal(
      dsl.review.warnings.some((warning) => warning.code === "source.sysform.detail_table_title_suspicious"),
      false
    );
  });

  it("does not cross non-string put values while reading fdDesignerHtml", () => {
    const xml = `
      <java>
        <object class="java.util.HashMap">
          <void method="put">
            <string>fdDesignerHtml_extension</string>
            <object class="java.util.ArrayList"/>
          </void>
          <void method="put">
            <string>fdDesignerHtml</string>
            <string>&lt;input fd_type=&quot;textLabel&quot; fd_values=&quot;b:&amp;quot;true&amp;quot;,content:&amp;quot;测试表单&amp;quot;&quot;/&gt;</string>
          </void>
        </object>
      </java>
    `;
    const template = parseSysFormTemplateXml(xml);

    assert.equal(template.fdDesignerHtml.includes("测试表单"), true);
    assert.equal(template.fdDesignerHtml_extension, undefined);
  });

  it("keeps non-whitelisted designer script functions as review warnings", () => {
    const whitelist = loadFunctionWhitelist(whitelistPath);
    const xml = `
      <java>
        <object class="java.util.HashMap">
          <void method="put"><string>fdId</string><string>sysform-with-script</string></void>
          <void method="put"><string>fdName</string><string>含脚本表单</string></void>
          <void method="put">
            <string>fdDesignerHtml</string>
            <string>&lt;script&gt;DocList_AddRow();UnknownLegacyFunction();&lt;/script&gt;</string>
          </void>
          <void method="put">
            <string>fdMetadataXml</string>
            <string>&lt;model&gt;&lt;extendSimpleProperty name=&quot;fd_name&quot; label=&quot;名称&quot; type=&quot;String&quot; /&gt;&lt;/model&gt;</string>
          </void>
        </object>
      </java>
    `;
    const dsl = translateSysFormTemplateXml(xml, { functionWhitelist: whitelist });

    assert.equal(dsl.review.functionWhitelist.matched[0].name, "DocList_AddRow");
    assert.equal(dsl.review.functionWhitelist.violations[0].name, "UnknownLegacyFunction");
    assert.equal(dsl.review.warnings.find((item) => item.code === "source.function_not_whitelisted")?.details.functionName, "UnknownLegacyFunction");
    assert.equal(dsl.review.errors, undefined);
  });
});

function sysFormXml(values) {
  return `
    <java>
      <object class="java.util.HashMap">
        <void method="put"><string>fdId</string><string>designer-first-id</string></void>
        <void method="put"><string>fdName</string><string>设计器优先表单</string></void>
        <void method="put"><string>fdModelId</string><string>template-id</string></void>
        <void method="put"><string>fdDesignerHtml</string><string>${escapeXml(values.fdDesignerHtml)}</string></void>
        <void method="put"><string>fdMetadataXml</string><string>${escapeXml(values.fdMetadataXml)}</string></void>
      </object>
    </java>
  `;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
