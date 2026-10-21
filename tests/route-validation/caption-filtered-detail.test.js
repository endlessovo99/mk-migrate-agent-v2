import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";

const fixture = "tests/fixtures/route-validation/caption-json-impact/filtered-detail_SysFormTemplate.xml";
function draft(edit = text => text) {
  const source = cleanSourceFile(fixture);
  for (const unit of source.scripts.sources) unit.javascript = edit(unit.javascript);
  return draftSourceDraft(source);
}
it("bounds the complete filtered detail sum, conditional count and value output", () => {
  const result = draft(), prior = draftSourceDraft(withoutCaptionRelations(cleanSourceFile(fixture)));
  assert.equal(result.form.fields.some(field => field.id === "caption_0"), false);
  assert.deepEqual(result.scripts, prior.scripts);
  const impact = result.form.fields.find(field => field.id === "fd_value_0").sourceProps.foldedCaption.behavior.residualImpact;
  assert.equal(impact.detailDataReads.some(read => read.basis === "complete-source-filtered-detail-aggregate"), true);
  for (const id of ["fd_lines", "amount", "choice", "fd_count", "fd_value_0"]) assert.equal(impact.dataTargets.includes(id), true);
});
it("accepts alpha-renamed local bindings and source discriminator values", () => {
  assert.equal(draft(text => text.replaceAll("filteredValues", "calculateSubset").replace(/\bcount\b/g, "numberOfRows")
    .replaceAll("'second'", "'selectedKind'").replaceAll("'two'", "'selectedValue'")).form.fields.some(field => field.id === "caption_0"), false);
});
it("keeps an immutable table domain when a different function mutates its own hoisted local", () => {
  assert.equal(draft(text => text.replace('Com_AddEventListener',
    'function localScratch(){var readonlyTable="other";readonlyTable="local";return readonlyTable;}localScratch();Com_AddEventListener'))
    .form.fields.some(field => field.id === "caption_0"), false);
});
for (const [name, edit] of [
  ["extra effect", text => text.replace("output.val(sum)", 'unknownEffect();output.val(sum)')],
  ["caption output", text => text.replace('GetXFormFieldById("fd_value_0"),"second"', 'GetXFormFieldById("caption_0"),"second"')],
  ["caption counter", text => text.replace('SetXFormFieldValueById("fd_count",count)', 'SetXFormFieldValueById("caption_0",count)')],
  ["missing column", text => text.replace("+i+\".\"+'choice'", "+i+\".\"+'missing'")],
  ["unknown counter", text => text.replace('SetXFormFieldValueById("fd_count",count)', 'SetXFormFieldValueById("missing",count)')],
  ["changed loop bound", text => text.replaceAll("tbInfo.lastIndex-1", "unknownLength")],
  ["changed count condition", text => text.replace("if(kind==='second'){SetXForm", "if(kind==='first'){SetXForm")],
  ["mutable table identity", text => text.replace('Com_AddEventListener', 'readonlyTable=GetXFormFieldValueById("fd_value_0");Com_AddEventListener')]
]) it(`keeps ${name} outside the complete aggregate proof`, () => {
  assert.equal(draft(edit).form.fields.some(field => field.id === "caption_0"), true);
});
