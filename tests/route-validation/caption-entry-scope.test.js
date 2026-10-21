import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { captionScriptScope } from "../../src/translator/caption-script-scope.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";
import { prepareSample } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = name => `tests/fixtures/route-validation/caption-entry-scope/${name}_SysFormTemplate.xml`;
const hasCaption = draft => draft.form.fields.some(field => field.id === "caption_0");
const source = cleanSourceFile(fixture("static-submit"));
const form = draftSourceDraft(withoutCaptionRelations(structuredClone(source))).form;
const originals = [...source.form.controls, ...(source.form.dataFields || [])];
const scope = (...scripts) => captionScriptScope(scripts, form, originals);

it("completes the attachment caption route through fake review, persistence and readback", async () => {
  const result = await runRouteCase("caption-attachment-entry-success");
  assert.equal(result.execution.ok, true);
  assert.equal(hasCaption(result.dsl), false);
  assert.equal(result.dsl.form.fields.find(field => field.id === "fd_files").props.required, true);
});

for (const name of ["static-submit", "collection-condition", "source-getter", "attachment-guard"]) {
  it(`closes the ${name} caption proof with unchanged scripts and native readback`, () => {
    const source = cleanSourceFile(fixture(name)), draft = draftSourceDraft(source);
    const retained = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
    assert.equal(hasCaption(draft), false);
    assert.deepEqual(draft.scripts, retained.scripts);
    assert.deepEqual(draft.form.layout.sourceGrid, retained.form.layout.sourceGrid);
    const projection = structuredClone(draft);
    projection.scripts = { actions: [] }; projection.formRules = { linkage: [] };
    const prepared = prepareSample(projection);
    assert.equal(prepared.verify(prepared.update).ok, true);
  });
}

it("bounds the complete existing active-attachment validator to a data read", () => {
  const s = cleanSourceFile(fixture("attachment-guard"));
  const f = draftSourceDraft(withoutCaptionRelations(structuredClone(s))).form;
  const scripts = s.scripts.sources.map(script => script.javascript);
  const result = captionScriptScope(scripts, f, s.form.controls);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.dataTargets, ["fd_files"]);
  assert.deepEqual(result.presentationTargets, []);
  for (const variant of [
    scripts[0] + 'externalEffect();',
    scripts[0].replace('count++;', 'count++;externalEffect();'),
    scripts[0].replace('attachmentObject_fd_files', 'attachmentObject_missing'),
    'var attachmentObject_fd_files={};' + scripts[0]
  ]) assert.equal(captionScriptScope([variant], f, s.form.controls).ok, false);
  assert.equal(captionScriptScope([...scripts, 'var attachmentObject_fd_files={};'], f, s.form.controls).ok, false);
  assert.equal(captionScriptScope(scripts, f, s.form.controls.filter(field => field.id !== "fd_files")).ok, false);
  assert.equal(captionScriptScope(scripts, f, [...s.form.controls, s.form.controls.find(field => field.id === "fd_files")]).ok, false);
});

it("equates static dot and literal computed submit paths without losing callback effects", () => {
  const callback = 'function(){GetXFormFieldById("fd_value_0")[0].value="ok";return true;}';
  assert.deepEqual(scope(`Com_Parameter.event.submit.push(${callback});`), scope(`Com_Parameter["event"]["submit"]["push"](${callback});`));
});

for (const [name, script] of [
  ["dynamic registry key", 'var key=GetXFormFieldValueById("fd_value_0");Com_Parameter.event[key].push(function(){return true;});'],
  ["unknown registry event", 'Com_Parameter.event["click"].push(function(){return true;});'],
  ["unknown callback effect", 'Com_Parameter.event["submit"].push(function(){externalEffect();});'],
  ["registry mutation", 'Com_Parameter.event.submit=[];'],
  ["collection escaping to scalar API", 'Com_AddEventListener(window,"load",function(){var fields=GetXFormFieldById("fd_value_0");alert(fields && fields);});'],
  ["unknown effect in a boolean operand", 'if(GetXFormFieldById("fd_value_0") && externalEffect()){alert("ok");}'],
  ["unknown effect in either branch", 'if(GetXFormFieldById("fd_value_0")){externalEffect();}else{alert("ok");}'],
  ["source getter presentation effect", 'function getFormFieldValue(id){GetXFormFieldById(id).hide();return "x";}getFormFieldValue("fd_value_0");'],
  ["source getter unknown effect", 'function getFormFieldValue(id){externalEffect();return "x";}getFormFieldValue("fd_value_0");'],
  ["source getter recursion", 'function getFormFieldValue(id){return getFormFieldValue(id);}getFormFieldValue("fd_value_0");'],
  ["reserved native helper replacement", 'function GetXFormFieldValueById(id){externalEffect();}GetXFormFieldValueById("fd_value_0");']
]) it(`preserves the boundary for ${name}`, () => {
  const result = scope(script);
  if (name === "source getter presentation effect") {
    assert.equal(result.ok, true);
    assert.deepEqual(result.presentationTargets, ["fd_value_0"]);
  } else assert.equal(result.ok, false, JSON.stringify(result));
});

it("does not choose the last getter across programs", () => {
  const result = scope('function getFormFieldValue(id){externalEffect();}',
    'function getFormFieldValue(id){return GetXFormFieldValueById(id);}getFormFieldValue("fd_value_0");');
  assert.equal(result.ok, false);
});

it("retains a source getter presentation change in the real caption route", () => {
  const source = cleanSourceFile(fixture("source-getter"));
  const replace = text => text.replace('return GetXFormFieldValueById(id);', 'GetXFormFieldById(id).hide();return "x";');
  for (const script of source.scripts.sources) script.javascript = replace(script.javascript);
  for (const field of source.form.controls) for (const fact of [field.sourceProps?.staticCaptionFact, field.sourceProps?.captionStructure]) {
    if (fact?.domContext) fact.domContext.inlineScripts = fact.domContext.inlineScripts.map(replace);
  }
  assert.equal(hasCaption(draftSourceDraft(source)), true);
});
