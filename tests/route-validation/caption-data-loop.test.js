import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { captionScriptScope } from "../../src/translator/caption-script-scope.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";

const fixture = "tests/fixtures/route-validation/caption-source-reader/data-loop_SysFormTemplate.xml";
const source = cleanSourceFile(fixture), prior = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
const loop = 'var parts=GetXFormFieldValueById("fd_value_0").split("、");var count=0;for(var cursor=0;cursor<parts.length;cursor++){if(parts[cursor].length>0){count++;}}SetXFormFieldValueById("fd_value_0",count);';
const scope = text => captionScriptScope([text], prior.form, source.form.controls);

it("bounds a complete primitive split/count loop through the public source route", () => {
  const draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.some(field => field.id === "caption_0"), false);
  assert.deepEqual(draft.scripts, prior.scripts);
  assert.deepEqual(draft.form.layout.sourceGrid, prior.form.layout.sourceGrid);
});

it("joins zero and repeated iteration effects without selecting an element or count", () => {
  const result = scope(loop);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.dataTargets, ["fd_value_0"]);
  assert.deepEqual(result.presentationTargets, []);
});

for (const [name, edit] of [
  ["a DOM collection", text => text.replace('GetXFormFieldValueById("fd_value_0").split("、")', 'GetXFormFieldById("fd_value_0")')],
  ["a mutated index", text => text.replace('count++;', 'count++;cursor++;')],
  ["a replaced collection", text => text.replace('count++;', 'count++;parts=GetXFormFieldById("fd_value_0");')],
  ["an element mutation", text => text.replace('count++;', 'parts[cursor]=GetXFormFieldById("fd_value_0");')],
  ["an unknown consumer", text => text.replace('count++;', 'externalEffect(parts);')],
  ["an unknown iteration target", text => text.replace('count++;', 'GetXFormFieldById(parts[cursor]).hide();')],
  ["an unbounded step", text => text.replace('cursor++', 'cursor+=step')]
]) it(`does not bound ${name} as a primitive data loop`, () => assert.equal(scope(edit(loop)).ok, false));
