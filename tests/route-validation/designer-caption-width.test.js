import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixture = "tests/fixtures/route-validation/designer-caption-width/designer-caption-width_SysFormTemplate.xml";
const sourceXml = readFileSync(fixture, "utf8");
const caption = '<label style="TEXT-DECORATION:none;FONT-WEIGHT:normal;FONT-STYLE:normal;DISPLAY:inline">Caption</label>';
const libraryIsland = '<% if("readOnly".equals(request.getAttribute("SysForm.base.showStatus"))){ %><script>Com_IncludeFile("calculation_script.js","../sys/xform/designer/calculation/");</script><% } %>';
const stages = path => { const source = cleanSourceFile(path); return { source, dsl: draftSourceDraft(source) }; };
function variant(change) {
  const properties = parseRootHashMapStringPuts(sourceXml);
  change(properties);
  const directory = mkdtempSync(join(tmpdir(), "designer-caption-width-"));
  const path = join(directory, "variant_SysFormTemplate.xml");
  const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  try {
    writeFileSync(path, '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(properties).map(([key, value]) => `<void method="put"><string>${key}</string><string>${escape(value)}</string></void>`).join("") +
      "</object></java>");
    return stages(path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function sourceItem(source) {
  const items = source.form.layout.rows.flatMap(row => row.cells.flatMap(cell => cell.contentFlow?.items || []))
    .filter(item => item.referenceId === "caption_fixed");
  assert.equal(items.length, 1);
  return items[0];
}
function parentOf(node, id) {
  if (node.children?.some(child => child.key === id)) return node;
  return (node.children || []).map(child => parentOf(child, id)).find(Boolean);
}
function assertWidthless({ source, dsl }) {
  assert.equal(sourceItem(source).width, undefined, "A runtime-widthless source LABEL must not inherit its designer decoration width");
  const description = dsl.form.fields.find(field => field.id === "caption_fixed");
  const owner = dsl.form.fields.find(field => field.id === "fd_value");
  assert.equal(description.componentId, "xform-description");
  assert.equal(description.props.content, "Caption");
  assert.equal(description.sourceRef, "source.form.control.caption_fixed");
  assert.equal(description.generated, false);
  assert.equal(owner.sourceProps.designerValues._label_bind_id, "caption_fixed");
  assert.equal(owner.props.required, true);
  assert.deepEqual(owner.props.defaultValue, { kind: "literal", value: "seed" });
  const prepared = prepareSample(dsl);
  const view = JSON.parse(xformConfig(prepared.update).viewModel[0].fdConfig);
  for (const scene of ["desktop", "mobile"]) {
    assert.equal(parentOf(view.view.render[scene][0], "caption_fixed").controlProps.style.width, undefined);
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
}

describe("designer-only fixed width on a static source caption", () => {
  it("keeps a runtime-widthless caption and its cell without imposing the designer width", () => {
    assertWidthless(stages(fixture));
  });

  it("accepts an explicit runtime auto width while preserving text and field semantics", () => {
    assertWidthless(variant(p => { p.fdDisplayJsp = p.fdDisplayJsp.replace(caption, caption.replace("DISPLAY:inline", "WIDTH:auto;DISPLAY:inline")); }));
  });

  it("accepts only the existing known calculation-library JSP island around unrelated markup", () => {
    assertWidthless(variant(p => { p.fdDisplayJsp = p.fdDisplayJsp.replace("<tbody>", "<tbody>" + libraryIsland); }));
  });

  it("preserves a separate hidden value in the caption cell while removing only the caption hint", () => {
    const result = variant(p => {
      const hidden = '<DIV style="WIDTH:120px;DISPLAY:inline" canShow="false" fd_type="inputText" fd_values=\'{id:"fd_hidden",label:"Internal",dataType:"String",width:"120",canShow:"false",defaultValue:"keep"}\'><INPUT id="fd_hidden" type="text"/></DIV>';
      p.fdDesignerHtml = p.fdDesignerHtml.replace("</LABEL>", "</LABEL>" + hidden);
      p.fdDisplayJsp = p.fdDisplayJsp.replace(caption, caption + '<div canShow="false" style="display:none"><xform:xtext property="extendDataFormInfo.value(fd_hidden)" style="WIDTH:120px"/></div>');
      p.fdMetadataXml = p.fdMetadataXml.replace("</metadata>", '<extendSimpleProperty name="fd_hidden" label="Internal" type="String" defaultValue="keep"/></metadata>');
    });
    assertWidthless(result);
    const hidden = result.dsl.form.fields.find(field => field.id === "fd_hidden");
    assert.equal(hidden.dataOnly, true);
    assert.deepEqual(hidden.props.defaultValue, { kind: "literal", value: "keep" });
  });

  for (const [name, change] of [
    ["runtime fixed width", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace(caption, caption.replace("DISPLAY:inline", "WIDTH:48px;DISPLAY:inline-block")); }],
    ["explicit designer fd_values width", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('id:"caption_fixed",', 'id:"caption_fixed",width:"48",'); }],
    ["explicit numeric fd_values width", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('id:"caption_fixed",', 'id:"caption_fixed",width:48,'); }],
    ["unparsed fd_values boolean property", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('id:"caption_fixed",', 'id:"caption_fixed",unknown:true,'); }],
    ["fd_values prototype property", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('id:"caption_fixed",', 'id:"caption_fixed",__proto__:"ignored",'); }],
    ["quoted numeric width property", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('id:"caption_fixed",', 'id:"caption_fixed","width":48,'); }],
    ["quoted property ignored by legacy mapping", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('font:""', '"font":""'); }],
    ["comment-like fd_values facts", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('id:"caption_fixed",', 'id:"caption_fixed",/* unknown:42 */'); }],
    ["unconsumed fd_values expression suffix", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('underline:"false"}', 'underline:"false"}; unknownCall()'); }],
    ["duplicate fd_values property", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('id:"caption_fixed",', 'id:"caption_fixed",id:"caption_fixed",'); }],
    ["spread fd_values properties", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('id:"caption_fixed",', 'id:"caption_fixed",...{width:48},'); }],
    ["computed fd_values property", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('id:"caption_fixed",', 'id:"caption_fixed",["width"]:48,'); }],
    ["getter fd_values property", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('id:"caption_fixed",', 'id:"caption_fixed",get width(){return 48},'); }],
    ["method fd_values property", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('id:"caption_fixed",', 'id:"caption_fixed",unknown(){return 1},'); }],
    ["incomplete fd_values object", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('underline:"false"}', 'underline:"false"'); }],
    ["explicit caption XML metadata width", p => { p.fdMetadataXml = p.fdMetadataXml.replace("</metadata>", '<extendSimpleProperty name="caption_fixed" label="Caption" type="String" width="48"/></metadata>'); }],
    ["duplicate caption metadata identity", p => { p.fdMetadataXml = p.fdMetadataXml.replace("</metadata>", '<extendSimpleProperty name="caption_fixed" label="Caption" type="String"/><extendSimpleProperty name="caption_fixed" label="Caption" type="String"/></metadata>'); }],
    ["duplicate designer natural identity", p => { const start = p.fdDesignerHtml.indexOf("<LABEL"), end = p.fdDesignerHtml.indexOf("</LABEL>", start) + "</LABEL>".length; p.fdDesignerHtml = p.fdDesignerHtml.slice(0, end) + p.fdDesignerHtml.slice(start, end) + p.fdDesignerHtml.slice(end); }],
    ["duplicate real runtime caption", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace(caption, caption + caption); }],
    ["duplicate runtime table identity", p => { p.fdDisplayJsp += p.fdDisplayJsp; }],
    ["runtime table identity mismatch", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('id="table_caption_width"', 'id="other_table"'); }],
    ["missing runtime table identity", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace(' id="table_caption_width"', ""); }],
    ["runtime row mismatch", p => { p.fdDisplayJsp = p.fdDisplayJsp.replaceAll('row="0"', 'row="1"'); }],
    ["runtime cell coordinates overlapping a different physical row", p => {
      p.fdDisplayJsp = p.fdDisplayJsp
        .replace('row="0" column="0"', 'column="0"')
        .replace(caption, caption.replace("DISPLAY:inline", "WIDTH:48px;DISPLAY:inline"))
        .replace("</tbody>", '<tr><td row="0" column="0">' + caption + '</td><td row="1" column="1">Other row</td></tr></tbody>');
    }],
    ["runtime cell mismatch", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace('column="0"', 'column="2"'); }],
    ["missing runtime cell coordinates", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace(' row="0" column="0"', ""); }],
    ["malformed runtime markup", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace("</label>", ""); }],
    ["unknown JSP side effect outside the caption row", p => { p.fdDisplayJsp = '<% unknownEffect(); %>' + p.fdDisplayJsp; }],
    ["conditional runtime caption", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace(caption, '<c:if test="${flag}">' + caption + "</c:if>"); }],
    ["hidden runtime caption", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace(caption, '<div style="display:none">' + caption + "</div>"); }],
    ["unknown runtime appearance", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace(caption, '<div style="transform:scale(0)">' + caption + "</div>"); }],
    ["styled designer caption", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('b:"false"', 'b:"true"').replace("FONT-WEIGHT:normal", "FONT-WEIGHT:bold"); p.fdDisplayJsp = p.fdDisplayJsp.replace("FONT-WEIGHT:normal", "FONT-WEIGHT:bold"); }],
    ["HTML entity text resembling a caption", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace(caption, caption.replaceAll("<", "&lt;").replaceAll(">", "&gt;")); }],
    ...["script", "style", "textarea", "pre", "code"].map(tag => ["opaque " + tag + " caption text", p => { p.fdDisplayJsp = p.fdDisplayJsp.replace(caption, `<${tag}>${caption}</${tag}>`); }])
  ]) {
    it("preserves the existing width for " + name, () => {
      const result = variant(change);
      assert.deepEqual(sourceItem(result.source).width, { value: 48, unit: "px" });
      assert.ok(result.dsl.form.fields.some(field => field.id === "caption_fixed"));
    });
  }

  it("rejects a forged caption flow width at trust and persisted readback", () => {
    const { source, dsl } = stages(fixture);
    const trusted = createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true, reviewerName: "synthetic caption-width regression" });
    assert.equal(checkTrust(source, trusted).ok, true);
    const forged = structuredClone(dsl);
    const change = object => {
      if (!object || typeof object !== "object") return;
      if (object.referenceId === "caption_fixed") object.width = { value: 49, unit: "px" };
      for (const value of Object.values(object)) change(value);
    };
    change(forged.form.layout);
    assert.equal(checkTrust(source, createTrustedMigrationDsl(source, forged, { externalAgentReviewed: true, reviewerName: "synthetic forged width" })).ok, false);
    const prepared = prepareSample(dsl), corrupt = structuredClone(prepared.update), config = xformConfig(corrupt), view = JSON.parse(config.viewModel[0].fdConfig);
    parentOf(view.view.render.desktop[0], "caption_fixed").controlProps.style.width = "49px";
    config.viewModel[0].fdConfig = JSON.stringify(view); corrupt.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    assert.equal(prepared.verify(corrupt).ok, false);
  });
});
