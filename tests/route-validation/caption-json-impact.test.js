import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { inspectSharedJsonStateModel } from "../../src/translator/source-shared-json-state.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";
import { captionBehaviorContract } from "../../src/translator/caption-behavior-contract.js";
import { prepareSample } from "../helpers/persistence.js";

const fixture = "tests/fixtures/route-validation/caption-json-impact/json-state_SysFormTemplate.xml";
const editSource = edit => {
  const source = cleanSourceFile(fixture);
  for (const script of source.scripts.sources) {
    script.javascript = edit(script.javascript);
    if (script.helperJavascript) script.helperJavascript = edit(script.helperJavascript);
  }
  for (const field of source.form.controls) for (const fact of [field.sourceProps?.captionStructure, field.sourceProps?.staticCaptionFact])
    if (fact?.domContext) fact.domContext.inlineScripts = fact.domContext.inlineScripts.map(edit);
  return source;
};

it("reuses the complete source-owned JSON data proof while analyzing every residual presentation effect", () => {
  const source = cleanSourceFile(fixture);
  const prior = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
  assert.ok(inspectSharedJsonStateModel(prior.form, source.scripts));
  assert.ok(inspectSharedJsonStateModel(prior.form, source.scripts).initializer.residuals.length);
  const draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.some(field => field.id === "caption_0"), false);
  assert.deepEqual(draft.scripts, prior.scripts);
  assert.deepEqual(draft.form.layout.sourceGrid, prior.form.layout.sourceGrid);
  const projection = structuredClone(draft); projection.scripts = { actions: [] }; projection.formRules = { linkage: [] };
  const prepared = prepareSample(projection); assert.equal(prepared.verify(prepared.update).ok, true);
});

for (const [name, edit] of [
  ["unknown residual effect", text => text.replace('var available=true;', 'unknownEffect();var available=true;')],
  ["state alias escape", text => text + '\nvar escaped=sharedDocument;'],
  ["JSON parser replacement", text => text + '\nJSON.parse=otherParser;'],
  ["state reader presentation effect", text => text.replace('var key =', 'GetXFormFieldById("fd_value_0").hide();var key =')],
  ["unproved state write", text => text + '\nsharedDocument.unknown=1;'],
  ["incomplete storage identity", text => text.replace('GetXFormFieldById("fd_json")', 'GetXFormFieldById("missing")')]
]) it(`does not abstract away ${name}`, () => {
  const source = editSource(edit), draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.some(field => field.id === "caption_0"), true);
});

it("keeps field-only presentation effects fixed to the actual title/value region", () => {
  const source = editSource(text => text.replace('common_dom_row_set_show_required_reset("first_row",false,false,false)', 'GetXFormFieldById("fd_value_0").hide()'));
  const draft = draftSourceDraft(source), prior = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
  const contract = captionBehaviorContract(source, prior.form, prior.scripts);
  assert.equal(contract.summary.residualScope.ok, true, JSON.stringify(contract.summary.residualScope));
  assert.equal(contract.forPair("fd_value_0", "caption_0", { version: 1 }).ok, false);
  assert.equal(draft.form.fields.some(field => field.id === "caption_0"), true);
});

it("does not lend source-state evidence to a new runtime-only reader", () => {
  const source = cleanSourceFile(fixture);
  for (const field of source.form.controls) for (const fact of [field.sourceProps?.captionStructure, field.sourceProps?.staticCaptionFact])
    if (fact?.domContext) fact.domContext.inlineScripts.push('var escaped=sharedDocument;');
  assert.equal(draftSourceDraft(source).form.fields.some(field => field.id === "caption_0"), true);
});

it("rebuilds the source-owned model after renaming state, properties, callbacks and bounds", () => {
  const source = editSource(text => {
    for (const [from, to] of Object.entries({ sharedDocument: "sourceCache", category: "kind", loadDocument: "restoreBuffer", maximumItems: "countBound", readFlag: "inspectEntry" }))
      text = text.replace(new RegExp("\\b" + from + "\\b", "g"), to);
    return text;
  });
  assert.equal(draftSourceDraft(source).form.fields.some(field => field.id === "caption_0"), false);
});

it("treats an optional free-identifier typeof guard as an unknown type, never a fabricated value", () => {
  const source = editSource(text => text.replace('var optionalGate=1;', ''));
  assert.equal(draftSourceDraft(source).form.fields.some(field => field.id === "caption_0"), false);
});

for (const [name, extra] of [
  ["a real unknown value", 'if(typeof externalFlag!="undefined"){GetXFormFieldById(externalFlag).hide();}'],
  ["an unknown guarded call", 'if(typeof externalFlag!="undefined"){externalFlag();}'],
  ["a member getter", 'if(typeof window.externalFlag!="undefined"){alert("x");}'],
  ["a source-defined global accessor", 'Object.defineProperty(window,"externalFlag",{get:function(){GetXFormFieldById("fd_value_0").hide();}});']
]) it(`does not use typeof to waive ${name}`, () => {
  const source = editSource(text => text + extra);
  assert.equal(draftSourceDraft(source).form.fields.some(field => field.id === "caption_0"), true);
});
