import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapXmlStringPuts } from "../../src/translator/xml-utils.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { renderNativeCaption } from "../helpers/native-caption-renderer.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/native-caption-empty-tail/empty-tail_SysFormTemplate.xml";
const captionId = "caption_value", fieldId = "fd_value";
const breakControl = '<DIV fd_type="brcontrol" fd_values=\'{id:"caption_break"}\'></DIV>';
const placeholder = '<DIV id="brcontrol-caption_break"></DIV>';
const titleCell = source => source.form.layout.rows[0].cells[0];

function variant(change = () => {}) {
  const props = parseRootHashMapXmlStringPuts(readFileSync(fixture, "utf8"));
  change(props);
  const directory = mkdtempSync(join(tmpdir(), "caption-empty-tail-"));
  const encode = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  try {
    const file = join(directory, "variant_SysFormTemplate.xml");
    writeFileSync(file, '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(props).map(([key, value]) => `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`).join("") + "</object></java>");
    const source = cleanSourceFile(file);
    return { source, draft: draftSourceDraft(source) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

it("folds a title followed by one empty line through review, trust and fake execution", async () => {
  const result = await runRouteCase("native-caption-empty-tail-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.dsl.form.fields.some(field => field.id === captionId), false);
  assert.notEqual(result.dsl.form.fields.find(field => field.id === fieldId).props.hiddenLabel, true);
});

it("keeps source lines and business semantics while rendering exactly one native title on both scenes", () => {
  const { source, draft } = variant();
  assert.deepEqual(titleCell(source).contentFlow.lines, [[captionId], []]);
  const retained = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
  assert.equal(retained.form.fields.find(field => field.id === fieldId).props.hiddenLabel, true);
  assert.ok(retained.form.fields.some(field => field.id === captionId));
  const legacySource = structuredClone(source);
  delete legacySource.form.captionRelations;
  assert.ok(draftSourceDraft(legacySource).form.fields.some(field => field.id === captionId),
    "Older source artifacts do not gain the new empty-tail relation implicitly");
  assert.equal(draft.form.fields.some(field => field.id === captionId), false);
  const field = draft.form.fields.find(field => field.id === fieldId);
  assert.equal(field.title, "申请部门");
  const { hiddenLabel: ignored, ...props } = retained.form.fields.find(field => field.id === fieldId).props;
  assert.deepEqual(field.props, props);
  assert.deepEqual(draft.form.layout.sourceGrid, retained.form.layout.sourceGrid);
  assert.deepEqual(draft.scripts, retained.scripts);
  assert.deepEqual(draft.formRules, retained.formRules);
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  assert.equal(checkTrust(source, trusted).ok, true);
  const prepared = prepareSample(trusted), native = xformConfig(prepared.update);
  const fields = native.dataModel.flatMap(model => model.fdFields || []);
  assert.equal(fields.some(field => field.fdName === captionId), false);
  const attribute = JSON.parse(fields.find(field => field.fdName === fieldId).fdAttribute);
  for (const scene of ["desktop", "mobile"]) assert.deepEqual(renderNativeCaption(attribute, scene).labels, ["申请部门"]);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("preserves a hidden data companion after the empty caption line", () => {
  const { source, draft } = variant(props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace(placeholder, placeholder +
      '<DIV fd_type="inputText" canShow="false" fd_values=\'{id:"fd_hidden",label:"Internal",dataType:"String",canShow:"false",defaultValue:"keep"}\'><INPUT id="fd_hidden"/></DIV>');
    props.fdDisplayJsp = props.fdDisplayJsp.replace(placeholder, placeholder +
      '<DIV canShow="false" style="display:none"><xform:xtext property="extendDataFormInfo.value(fd_hidden)" showStatus="noShow"/></DIV>');
    props.fdMetadataXml = props.fdMetadataXml.replace("</metadata>",
      '<extendSimpleProperty name="fd_hidden" label="Internal" type="String" defaultValue="keep"/></metadata>');
  });
  assert.deepEqual(titleCell(source).contentFlow.lines, [[captionId], []]);
  assert.equal(draft.form.fields.some(field => field.id === captionId), false);
  const hidden = draft.form.fields.find(field => field.id === "fd_hidden");
  assert.equal(hidden.dataOnly, true);
  assert.deepEqual(hidden.props.defaultValue, { kind: "literal", value: "keep" });
  const prepared = prepareSample(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

for (const [name, change] of [
  ["two empty trailing lines", props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace(breakControl, breakControl + breakControl.replace("caption_break", "second_break"));
  }],
  ["a leading empty line", props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace(breakControl, "").replace('<LABEL fd_type="textLabel"', breakControl + '<LABEL fd_type="textLabel"');
  }],
  ["a second visible control", props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace(placeholder, placeholder +
      '<DIV fd_type="inputText" fd_values=\'{id:"fd_other",label:"Other",dataType:"String"}\'><INPUT id="fd_other"/></DIV>');
    props.fdDisplayJsp = props.fdDisplayJsp.replace(placeholder, placeholder + '<xform:xtext property="extendDataFormInfo.value(fd_other)"/>');
  }],
  ["an empty tail on the editor instead of the caption", props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace(breakControl, "");
    props.fdDesignerHtml = props.fdDesignerHtml.replace('<INPUT id="fd_value" type="text"/></DIV>', '<INPUT id="fd_value" type="text"/></DIV>' + breakControl);
  }],
  ["an independent caption permission", props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace('<LABEL fd_type="textLabel"', '<DIV fd_type="right" fd_values=\'{id:"right_caption"}\'><LABEL fd_type="textLabel"').replace('</LABEL>', '</LABEL></DIV>');
    props.fdDisplayJsp = props.fdDisplayJsp.replace('<LABEL>', '<xform:right mode_N1="hidden"><LABEL>').replace('</LABEL>', '</LABEL></xform:right>');
  }],
  ["a script reference to the break marker", props => {
    props.fdDisplayJsp += '<script>document.getElementById("brcontrol-caption_break").hidden=true;</script>';
  }]
]) it(`protects ${name}`, () => {
  const { draft } = variant(change);
  assert.ok(draft.form.fields.some(field => field.id === captionId));
  assert.equal(draft.form.fields.find(field => field.id === fieldId).props.hiddenLabel, true);
});
