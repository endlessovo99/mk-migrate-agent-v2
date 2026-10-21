import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";
import { captionScriptScope } from "../../src/translator/caption-script-scope.js";

const fixture = "tests/fixtures/route-validation/caption-source-reader/date-data_SysFormTemplate.xml";
const source = cleanSourceFile(fixture), prior = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
const scope = text => captionScriptScope([text], prior.form, source.form.controls);

it("keeps private Date setters and numeric formatting in the data domain", () => {
  const draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.some(field => field.id === "caption_0"), false);
  assert.deepEqual(draft.scripts, prior.scripts);
});

it("models bare and fallthrough return values as primitive undefined", () => {
  const result = scope('function empty(){}function choose(){if(GetXFormFieldValueById("fd_value_0")){return;}return 3;}SetXFormFieldValueById("fd_value_0",Number(choose())+Number(empty()));');
  assert.equal(result.ok, true, JSON.stringify(result));
});

it("does not promote a node/data return union to undefined", () => {
  assert.equal(scope('function choose(){if(GetXFormFieldValueById("fd_value_0")){return GetXFormFieldById("fd_value_0");}return;}alert(choose());').ok, false);
});

for (const text of [
  'var date=GetXFormFieldById("fd_value_0");date.setHours(0);',
  'var date=new Date();Date.prototype.setHours=function(){unknownEffect();};date.setHours(0);',
  'var date=new Date();date.setHours(GetXFormFieldById("fd_value_0"));',
  'var date=new Date();date.unknownMethod();'
]) it("does not lend private-date operations to unknown receivers, methods or arguments", () => assert.equal(scope(text).ok, false));
