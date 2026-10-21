import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";
import { prepareSample } from "../helpers/persistence.js";

const fixture = "tests/fixtures/route-validation/caption-json-impact/detail-sum_SysFormTemplate.xml";
function edited(edit) {
  const source = cleanSourceFile(fixture);
  for (const unit of source.scripts.sources) { unit.javascript = edit(unit.javascript); if (unit.helperJavascript) unit.helperJavascript = edit(unit.helperJavascript); }
  for (const field of source.form.controls) for (const fact of [field.sourceProps?.captionStructure, field.sourceProps?.staticCaptionFact])
    if (fact?.domContext) fact.domContext.inlineScripts = fact.domContext.inlineScripts.map(edit);
  return source;
}

it("bounds the complete readonly detail sum through source schema and a pure rounding dependency", () => {
  const source = cleanSourceFile(fixture), prior = draftSourceDraft(withoutCaptionRelations(structuredClone(source))), draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.some(field => field.id === "caption_0"), false);
  assert.deepEqual(draft.scripts, prior.scripts);
  const impact = draft.form.fields.find(field => field.id === "fd_value_0").sourceProps.foldedCaption.behavior.residualImpact;
  assert.deepEqual(impact.detailDataReads[0].tableDomain, ["fd_lines"]);
  assert.equal(impact.sharedScalars[0].readonlyLiterals, undefined);
  const projection = structuredClone(draft); projection.scripts = { actions: [] }; projection.formRules = { linkage: [] };
  const prepared = prepareSample(projection); assert.equal(prepared.verify(prepared.update).ok, true);
});

for (const [name, edit] of [
  ["a mutated table binding", text => text.replace('Com_AddEventListener', 'readonlyTable=GetXFormFieldValueById("fd_value_0");Com_AddEventListener')],
  ["an absent table", text => text.replace('readonlyTable="fd_lines"', 'readonlyTable="missing"')],
  ["an absent column", text => text.replace('readValues(readonlyTable,"amount")', 'readValues(readonlyTable,"missing")')],
  ["an impure rounding helper", text => text.replace('var precision=2;', 'GetXFormFieldById("fd_value_0").hide();var precision=2;')],
  ["an extra sum effect", text => text.replace("var tab_id", 'unknownEffect();var tab_id')],
  ["a missing registration", text => text.replace('DocList_Info.push("TABLE_DL_fd_lines");', '')]
]) it(`does not close ${name} as a data-only detail read`, () => {
  assert.equal(draftSourceDraft(edited(edit)).form.fields.some(field => field.id === "caption_0"), true);
});
