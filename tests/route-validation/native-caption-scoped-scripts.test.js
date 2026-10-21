import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditCaptionFolding, cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { prepareSample } from "../helpers/persistence.js";

const root = "tests/fixtures/route-validation/native-caption-scoped-scripts/";
function variant(file, change = () => {}) {
  const props = parseRootHashMapStringPuts(readFileSync(root + file, "utf8"));
  change(props);
  const dir = mkdtempSync(join(tmpdir(), "caption-scoped-"));
  const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  try {
    const path = join(dir, "variant_SysFormTemplate.xml");
    writeFileSync(path, '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(props).map(([key, value]) => `<void method="put"><string>${key}</string><string>${escape(value)}</string></void>`).join("") + "</object></java>");
    const source = cleanSourceFile(path), draft = draftSourceDraft(source);
    return { source, draft };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

it("protects every field in a statically affected row and keeps independent permissions", () => {
  const { source, draft } = variant("scoped_SysFormTemplate.xml");
  assert.deepEqual(draft.form.fields.filter(field => field.sourceProps?.foldedCaption).map(field => field.id), ["fd_c"]);
  for (const id of ["fd_a", "fd_b", "fd_d"]) assert.equal(draft.form.fields.find(field => field.id === id).props.hiddenLabel, true);
  assert.equal(auditCaptionFolding(source, draft).ok, true);
});

it("resolves a source row marker independently of a same-name hidden metadata field", () => {
  const { draft } = variant("scoped_SysFormTemplate.xml", props => {
    props.fdMetadataXml = props.fdMetadataXml.replace('</metadata>', '<extendSimpleProperty name="affected_row" label="row flag" type="String"/></metadata>');
  });
  assert.deepEqual(draft.form.fields.filter(field => field.sourceProps?.foldedCaption).map(field => field.id), ["fd_c"]);
});

it("folds eleven real seal-form titles while retaining the detail runtime and protected source regions", () => {
  const { source, draft } = variant("seal_SysFormTemplate.xml");
  assert.deepEqual(draft.form.fields.filter(field => field.sourceProps?.foldedCaption).map(field => field.title), [
    "申请单位", "申请部门", "申请人", "联系电话", "审批事项涉及部门", "用印事由", "用印类型", "需提供的相关资质复印件", "其他资质复印件", "用印内容", "附件"
  ]);
  assert.equal(auditCaptionFolding(source, draft).ok, true);
  const prepared = prepareSample(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("protects captions inside a cell read by the generated detail-width script", () => {
  const wrap = props => {
    for (const key of ["fdDesignerHtml", "fdDisplayJsp"]) props[key] = '<TABLE id="outer_scope" fd_type="standardTable"><TBODY><TR><TD row="0" column="0">' + props[key] + '</TD></TR></TBODY></TABLE>';
  };
  const protectedForm = variant("seal_SysFormTemplate.xml", wrap);
  assert.equal(protectedForm.draft.form.fields.filter(field => field.sourceProps?.foldedCaption).length, 0);
  const withoutParentRead = variant("seal_SysFormTemplate.xml", props => {
    props.fdDisplayJsp = props.fdDisplayJsp.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
      script => script.includes("tds.each") ? "" : script);
    wrap(props);
  });
  assert.equal(withoutParentRead.draft.form.fields.filter(field => field.sourceProps?.foldedCaption).length, 11);
});

for (const [name, script] of [
  ["unresolved row identity", 'common_dom_row_set_show_required_reset(value,false,false,false);'],
  ["unrecognized row ownership", 'common_dom_row_set_show_required_reset("fd_a",false,false,false);'],
  ["unknown external effect", 'changePresentation();'],
  ["DOM ancestor traversal", 'GetXFormFieldById("fd_a")[0].parentNode.previousElementSibling.hidden=true;'],
  ["source helper override", 'function common_dom_row_set_show_required_reset(){changePresentation();}'],
  ["uninvoked opaque closure", 'var callback=function(){changePresentation();};'],
  ["unmodeled asynchronous effect", 'import("./presentation.js");'],
  ["block lexical binding", 'var id="fd_a";{let id="fd_b";}document.getElementById(id).value="x";'],
  ["branch lexical binding", 'var id="fd_a";if(1){const id="fd_b";}else{let id="fd_b";}document.getElementById(id).value="x";'],
  ["assignment in a conditional expression", 'var id="fd_a";1 ? id="fd_c" : id="fd_b";document.getElementById(id).value="x";'],
  ["assignment in a short-circuit expression", 'var id="fd_c";0 && (id="fd_b");document.getElementById(id).value="x";']
]) it(`fails closed for ${name}`, () => {
  const { draft } = variant("scoped_SysFormTemplate.xml", props => { props.fdDisplayJsp += `<script>${script}</script>`; });
  assert.equal(draft.form.fields.filter(field => field.sourceProps?.foldedCaption).length, 0);
});

for (const [name, change] of [
  ["extra statement after generated width code", text => text.replace("$(tb_div).css('width','100%');", "$(tb_div).css('width','100%');changePresentation();")],
  ["changed generated traversal", text => text.replace(".parents('td')", ".parents('table')")],
  ["changed generated effect", text => text.replace(".css('width','100%')", ".css('display','none')")],
  ["extra toolbar callback", text => text.replace("DocList_MoveRow(-1);", "DocList_MoveRow(-1);changePresentation();")],
  ["toolbar builtin override", text => text + '<script>function DocList_MoveRow(){changePresentation();}</script>'],
  ["dynamic toolbar icon declaration", text => text.replace("/resource/style/default/icons/add.gif", "${dynamicIcon}")]
]) it(`does not trust a near-match detail runtime with ${name}`, () => {
  const { draft } = variant("seal_SysFormTemplate.xml", props => { props.fdDisplayJsp = change(props.fdDisplayJsp); });
  assert.equal(draft.form.fields.filter(field => field.sourceProps?.foldedCaption).length, 0);
});
