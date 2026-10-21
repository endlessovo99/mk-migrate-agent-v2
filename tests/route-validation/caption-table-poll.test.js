import assert from "node:assert/strict";
import { it } from "node:test";
import { parse } from "acorn";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sourceTablePollEffect } from "../../src/translator/source-table-poll.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";

const fixture = "tests/fixtures/route-validation/caption-json-impact/table-poll_SysFormTemplate.xml";
const helper = 'function waitForTable(tableId){var table=document.getElementById("TABLE_DL_"+tableId);if(!table){setTimeout(waitForTable,600);}else{$("#TABLE_DL_fd_lines > tbody > tr").eq(1).remove();}}';

it("bounds every poll recurrence to a registered table without repairing its missing timer argument", () => {
  const source = cleanSourceFile(fixture), prior = draftSourceDraft(withoutCaptionRelations(structuredClone(source))), draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.some(field => field.id === "caption_0"), false);
  assert.deepEqual(draft.scripts, prior.scripts);
  const effect = draft.form.fields.find(field => field.id === "fd_value_0").sourceProps.foldedCaption.behavior.residualImpact.tablePollEffects[0];
  assert.equal(effect.tableId, "fd_lines");
  assert.equal(effect.parameterTransport, "source-no-argument-delayed-callback");
});

for (const [name, edit] of [
  ["another callback", text => text.replace('setTimeout(waitForTable,600)', 'setTimeout(otherCallback,600)')],
  ["an additional effect", text => text.replace('var table=', 'unknownEffect();var table=')],
  ["a parent traversal", text => text.replace('.eq(1).remove()', '.parents().remove()')],
  ["a relayed timer argument", text => text.replace('setTimeout(waitForTable,600)', 'setTimeout(function(){waitForTable(tableId);},600)')],
  ["a dynamic delay", text => text.replace(',600)', ',delay)')]
]) it(`does not reuse the fixed polling proof for ${name}`, () => {
  assert.equal(sourceTablePollEffect(parse(edit(helper), { ecmaVersion: "latest" }).body[0]), undefined);
});

it("requires the exact native table registration", () => {
  const source = cleanSourceFile(fixture);
  for (const unit of source.scripts.sources) unit.javascript = unit.javascript.replace('DocList_Info.push("TABLE_DL_fd_lines");', '');
  for (const field of source.form.controls) for (const fact of [field.sourceProps?.captionStructure, field.sourceProps?.staticCaptionFact])
    if (fact?.domContext) fact.domContext.inlineScripts = fact.domContext.inlineScripts.map(text => text.replace('DocList_Info.push("TABLE_DL_fd_lines");', ''));
  assert.equal(draftSourceDraft(source).form.fields.some(field => field.id === "caption_0"), true);
});
