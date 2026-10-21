import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapXmlStringPuts } from "../../src/translator/xml-utils.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { renderNativeCaption } from "../helpers/native-caption-renderer.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = name => `tests/fixtures/route-validation/caption-source-normalization/${name}_SysFormTemplate.xml`;
function variant(name, change) {
  const props = parseRootHashMapXmlStringPuts(readFileSync(fixture(name), "utf8"));
  change(props);
  const directory = mkdtempSync(join(tmpdir(), "caption-normalization-"));
  const encode = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  try {
    const file = join(directory, "variant_SysFormTemplate.xml");
    writeFileSync(file, '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(props).map(([key, value]) => `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`).join("") + "</object></java>");
    const source = cleanSourceFile(file);
    return { source, draft: draftSourceDraft(source) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const name of ["terminal-nbsp", "disjoint-rowspan", "table-default"]) {
  it(`merges ${name} through the public route and fake readback`, async () => {
    const result = await runRouteCase(`caption-source-${name}-success`);
    assert.equal(result.execution.ok, true);
    assert.equal(result.dsl.form.fields.some(field => field.id === "caption"), false);
    assert.notEqual(result.dsl.form.fields.find(field => field.id === "fd_value").props.hiddenLabel, true);
  });
  it(`preserves ${name} source geometry and data while rendering one native title`, () => {
    const source = cleanSourceFile(fixture(name)), draft = draftSourceDraft(source);
    const retained = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
    assert.equal(draft.form.fields.some(field => field.id === "caption"), false);
    const field = draft.form.fields.find(field => field.id === "fd_value");
    assert.equal(field.title, "Title");
    const { hiddenLabel: ignored, ...props } = retained.form.fields.find(field => field.id === "fd_value").props;
    assert.deepEqual(field.props, props);
    assert.deepEqual(draft.form.layout.sourceGrid, retained.form.layout.sourceGrid);
    assert.deepEqual(draft.scripts, retained.scripts);
    assert.deepEqual(draft.formRules, retained.formRules);
    const prepared = prepareSample(draft), native = xformConfig(prepared.update);
    const attribute = JSON.parse(native.dataModel.flatMap(model => model.fdFields || []).find(field => field.fdName === "fd_value").fdAttribute);
    for (const scene of ["desktop", "mobile"]) assert.deepEqual(renderNativeCaption(attribute, scene).labels, ["Title"]);
    assert.equal(prepared.verify(prepared.update).ok, true);
  });
}

for (const [name, change] of [
  ["missing literal newline", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('content:"Title&#13;&#10; "', 'content:"Title"'); }],
  ["substantive trailing text", props => { for (const key of ["fdDesignerHtml", "fdDisplayJsp"]) props[key] = props[key].replace('<BR>&nbsp;', '<BR>Other'); }],
  ["styled terminal break", props => { for (const key of ["fdDesignerHtml", "fdDisplayJsp"]) props[key] = props[key].replace('<BR>', '<BR style="color:red">'); }],
  ["two terminal breaks", props => { for (const key of ["fdDesignerHtml", "fdDisplayJsp"]) props[key] = props[key].replace('<BR>', '<BR><BR>'); }]
]) it(`protects a terminal caption with ${name}`, () => {
  const { draft } = variant("terminal-nbsp", change);
  assert.ok(draft.form.fields.some(field => field.id === "caption"));
});

for (const [name, change] of [
  ["a spanning caption itself", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('class="td_normal_title"', 'class="td_normal_title" rowspan="2"'); }],
  ["a runtime column mismatch", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace('row="1" column="1"', 'row="1" column="0"'); }],
  ["an overlapping declared source column", props => { for (const key of ["fdDesignerHtml", "fdDisplayJsp"]) props[key] = props[key].replace('row="1" column="1"', 'row="1" column="0"'); }],
  ["an invalid preceding rowspan", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('rowspan="2"', 'rowspan="many"'); }]
]) it(`protects a rowspan region with ${name}`, () => {
  const { draft } = variant("disjoint-rowspan", change);
  assert.ok(draft.form.fields.some(field => field.id === "caption"));
});

for (const [name, change] of [
  ["dynamic mode", text => text.replace('layout2col="default"', 'layout2col="${mode}"')],
  ["unknown mode", text => text.replaceAll('default', 'custom')],
  ["conflicting mode mirrors", text => text.replace('layout2col:"default"', 'layout2col:"true"')],
  ["an extra metadata property", text => text.replace('label:"Main",', 'label:"Main",onLoad:"changePresentation()",')]
]) it(`protects table metadata with ${name}`, () => {
  const { draft } = variant("table-default", props => { props.fdDesignerHtml = change(props.fdDesignerHtml); });
  assert.ok(draft.form.fields.some(field => field.id === "caption"));
});

it("does not treat an unused local submit-button scratch read as a field-title dependency", () => {
  const source = cleanSourceFile(fixture("submit-scratch")), draft = draftSourceDraft(source);
  const retained = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
  assert.ok(source.scripts.sources.some(item => item.javascript.includes("window.event.target.innerText")));
  assert.equal(draft.form.fields.some(field => field.id === "caption"), false);
  assert.ok(draft.form.fields.find(field => field.id === "fd_value").sourceProps.foldedCaption.behavior.residualImpact.inertSubmitScratch
    .every(proof => proof.basis === "unused-local-submit-button-scratch"));
  assert.deepEqual(draft.scripts, retained.scripts, "The source/migrated validation program is not removed or rewritten");
  const projection = structuredClone(draft);
  projection.scripts = { actions: [] };
  const prepared = prepareSample(projection);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

for (const [name, change] of [
  ["a value read outside the scratch", text => text.replace('var value=', 'SetXFormFieldValueById("fd_value",buttonName,false);var value=')],
  ["a captured scratch value", text => text.replace('return true;', 'AttachXFormValueChangeEventById("fd_value",function(){alert(buttonName);});return true;')],
  ["an unknown event property", text => text.replace('target.innerText', 'target.parentNode.innerText')],
  ["a callback with extra fallback effects", text => text.replace('buttonName=window.event.target.value;', 'buttonName=window.event.target.value;changePresentation();')],
  ["a scratch redeclaration", text => text.replace('var value=', 'var buttonName="other";var value=')],
  ["a fallback before the declaration", text => text.replace('var buttonName=window.event.target.innerText;', '').replace('if(value==', 'var buttonName=window.event.target.innerText;if(value==')],
  ["a non-submit registry", text => text.replace('event.submit.push', 'event.afterSubmit.push')]
]) it(`keeps event-target evidence unbounded for ${name}`, () => {
  const { draft } = variant("submit-scratch", props => { props.fdDisplayJsp = change(props.fdDisplayJsp); });
  assert.ok(draft.form.fields.some(field => field.id === "caption"));
});
