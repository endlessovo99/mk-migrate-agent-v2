import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";

const fixture = "tests/fixtures/route-validation/caption-native-currency-scope/scalar-converter_SysFormTemplate.xml";
function source(edit = text => text) {
  const result = cleanSourceFile(fixture);
  for (const unit of result.scripts.sources) unit.javascript = edit(unit.javascript);
  for (const field of result.form.controls) for (const fact of [field.sourceProps?.captionStructure, field.sourceProps?.staticCaptionFact])
    if (fact?.domContext) fact.domContext.inlineScripts = fact.domContext.inlineScripts.map(edit);
  return result;
}
const folded = result => Boolean(result.form.fields.find(field => field.id === "fd_note")?.sourceProps.foldedCaption);
it("bounds a scalar native currency conversion under the complete typed runtime binding", () => {
  const original = source(), draft = draftSourceDraft(original);
  assert.equal(folded(draft), true);
  assert.deepEqual(draft.scripts, draftSourceDraft(withoutCaptionRelations(structuredClone(original))).scripts);
});
for (const [name, edit] of [
  ["unknown include", text => text.replace("../sys/xform/designer/chinaValue/", "../unknown/")],
  ["node argument", text => text.replace('GetXFormFieldValueById("fd_amount")', 'GetXFormFieldById("fd_amount")')],
  ["extra argument", text => text.replace('XForm_GetChinaValue(GetXFormFieldValueById("fd_amount"))', 'XForm_GetChinaValue(1,2)')],
  ["source override", text => text.includes('Com_AddEventListener') ? 'function XForm_GetChinaValue(v){unknownEffect();return v;}'+text : text]
]) it(`does not trust the native scalar contract with ${name}`, () => assert.equal(folded(draftSourceDraft(source(edit))), false));
