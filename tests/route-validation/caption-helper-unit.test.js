import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";

const fixture = "tests/fixtures/route-validation/caption-source-reader/helper-unit_SysFormTemplate.xml";

it("uses the existing designer-owned helper-only omission contract for non-entry declarations", () => {
  const source = cleanSourceFile(fixture), prior = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
  const unit = source.scripts.sources.find(unit => unit.fragmentId === "source_helpers");
  assert.ok(unit);
  assert.ok(prior.scripts.actions.some(action => action.sourceRefs.includes(unit.sourceRef) && action.translationStatus === "omitted"));
  const draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.some(field => field.id === "caption_0"), false);
  assert.deepEqual(draft.scripts, prior.scripts);
});

it("checks a library body as soon as a residual runtime entry calls it", () => {
  const source = cleanSourceFile(fixture);
  for (const field of source.form.controls) for (const fact of [field.sourceProps?.captionStructure, field.sourceProps?.staticCaptionFact])
    if (fact?.domContext) fact.domContext.inlineScripts.push('Com_AddEventListener(window,"load",unusedLibrary);');
  assert.equal(draftSourceDraft(source).form.fields.some(field => field.id === "caption_0"), true);
});

it("does not lend the designer omission contract to a changed runtime definition", () => {
  const source = cleanSourceFile(fixture);
  for (const field of source.form.controls) for (const fact of [field.sourceProps?.captionStructure, field.sourceProps?.staticCaptionFact])
    if (fact?.domContext) fact.domContext.inlineScripts.push('function unusedLibrary(){differentUnknownEffect();}');
  assert.equal(draftSourceDraft(source).form.fields.some(field => field.id === "caption_0"), true);
});

it("does not mistake a bare native callback reference for an unused declaration", () => {
  const source = cleanSourceFile(fixture);
  source.form.controls.find(field => field.id === "fd_value_0").sourceProps.designerValues.onClick = "unusedLibrary";
  assert.equal(draftSourceDraft(source).form.fields.some(field => field.id === "caption_0"), true);
});

it("keeps a designer declaration that replaces a host binding unproven", () => {
  const source = cleanSourceFile(fixture);
  for (const unit of source.scripts.sources) unit.javascript = unit.javascript.replaceAll("unusedLibrary", "Object");
  for (const field of source.form.controls) for (const fact of [field.sourceProps?.captionStructure, field.sourceProps?.staticCaptionFact])
    if (fact?.domContext) fact.domContext.inlineScripts = fact.domContext.inlineScripts.map(text => text.replaceAll("unusedLibrary", "Object"));
  assert.equal(draftSourceDraft(source).form.fields.some(field => field.id === "caption_0"), true);
});
