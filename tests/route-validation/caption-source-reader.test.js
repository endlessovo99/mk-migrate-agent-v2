import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";
import { parse } from "acorn";
import { sourceFormValueReader, SOURCE_FORM_VALUE_READER } from "../../src/translator/source-form-value-reader.js";
import { prepareSample } from "../helpers/persistence.js";

const fixture = "tests/fixtures/route-validation/caption-source-reader/reader_SysFormTemplate.xml";
function changeProgram(source, edit) {
  for (const script of source.scripts.sources) {
    script.javascript = edit(script.javascript);
    if (script.helperJavascript) script.helperJavascript = edit(script.helperJavascript);
  }
  for (const field of source.form.controls) for (const fact of [field.sourceProps?.captionStructure, field.sourceProps?.staticCaptionFact])
    if (fact?.domContext) fact.domContext.inlineScripts = fact.domContext.inlineScripts.map(edit);
  return source;
}

it("bounds a complete source data reader without treating its DOM handles as scalar values", () => {
  const source = cleanSourceFile(fixture);
  const draft = draftSourceDraft(source), prior = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
  assert.equal(draft.form.fields.some(field => field.id === "caption_0"), false);
  assert.deepEqual(draft.scripts, prior.scripts);
  assert.deepEqual(draft.form.layout.sourceGrid, prior.form.layout.sourceGrid);
  const projection = structuredClone(draft); projection.scripts = { actions: [] }; projection.formRules = { linkage: [] };
  const prepared = prepareSample(projection); assert.equal(prepared.verify(prepared.update).ok, true);
});

it("recognizes the complete algorithm by binding structure rather than helper/local names", () => {
  let text = SOURCE_FORM_VALUE_READER;
  for (const [from, to] of Object.entries({ getFormFieldValue: "arbitraryReader", elementId: "identity", type: "mode", containSelectText: "withText", doms: "elements", field: "selection", text: "label", val: "value", elementVal: "fallback" }))
    text = text.replace(new RegExp("\\b" + from + "\\b", "g"), to);
  // The property names/type attributes are part of the source ABI, not bindings.
  text = text.replace('elements[0].mode', 'elements[0].type').replaceAll('.value()', '.val()').replaceAll('.label()', '.text()');
  assert.equal(sourceFormValueReader(parse(text, { ecmaVersion: "latest" }).body[0]), true);
});

for (const [name, edit] of [
  ["unknown effect", text => text.replace("if (type == 'radio')", "unknownEffect();if (type == 'radio')")],
  ["data setter", text => text.replace(".val();", '.val("changed");')],
  ["returning a DOM collection", text => text.replace("return ((text ? text : '')", "return field;return ((text ? text : '')")],
  ["reading arbitrary descendants", text => text.replace('find("option:selected")', 'find("*")')],
  ["parent text", text => text.replace('field.find("option:selected").text()', 'field.parent().text()')],
  ["changed field lookup", text => text.replace('GetXFormFieldValueById(elementId)', 'unknownGetter(elementId)')]
]) it(`does not give the closed reader contract to ${name}`, () => {
  const text = edit(SOURCE_FORM_VALUE_READER); assert.notEqual(text, SOURCE_FORM_VALUE_READER);
  assert.equal(sourceFormValueReader(parse(text, { ecmaVersion: "latest" }).body[0]), false);
});

it("retains directly referenced caption nodes and refuses an unresolved lookup token", () => {
  for (const target of ["caption_0", "missing_field"]) {
    const source = changeProgram(cleanSourceFile(fixture), text => text.replace('readExportValue("fd_value_0")', `readExportValue("${target}")`));
    assert.equal(draftSourceDraft(source).form.fields.some(field => field.id === "caption_0"), true);
  }
});

it("bounds source-owned immutable lookup domains without granting generic dynamic node lookup", () => {
  const edit = text => 'var readerIdentity="fd_value_0";'+text.replace('readExportValue("fd_value_0")', 'readExportValue(readerIdentity)');
  assert.equal(draftSourceDraft(changeProgram(cleanSourceFile(fixture), edit)).form.fields.some(field => field.id === "caption_0"), false);
  for (const suffix of ['readerIdentity=GetXFormFieldValueById("fd_value_0");', 'function mutate(){readerIdentity="other";}mutate();']) {
    assert.equal(draftSourceDraft(changeProgram(cleanSourceFile(fixture), text => edit(text)+suffix))
      .form.fields.some(field => field.id === "caption_0"), true);
  }
});

it("does not lend a data-reader domain to a registration that passes a DOM handle", () => {
  for (const extra of ["", 'eventIdentity=GetXFormFieldValueById("fd_value_0");']) {
    const edit = text => 'var eventIdentity="fd_value_0";'+text+extra+
      'Com_AddEventListener(window,"load",function(){AttachXFormValueChangeEventById(eventIdentity,function(value,dom){dom[0].value=value;});});';
    assert.equal(draftSourceDraft(changeProgram(cleanSourceFile(fixture), edit)).form.fields.some(field => field.id === "caption_0"), true);
  }
});
