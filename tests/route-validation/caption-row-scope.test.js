import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";
import { resolveSourceRowEffectTarget } from "../../src/dsl/form-rules.js";
import { buildFormRuleRefIndex } from "../../src/dsl/form-rules.js";
import { captionRowRegion } from "../../src/translator/caption-row-scope.js";
import { prepareSample } from "../helpers/persistence.js";

const fixture = name => `tests/fixtures/route-validation/caption-row-scope/${name}_SysFormTemplate.xml`;
const folded = draft => draft.form.fields.filter(field => field.sourceProps?.foldedCaption).map(field => field.id);

it("the retained source helper operates every same-name row and no absent row", () => {
  const touched = [], rows = [{ tagName: "TR", style: {} }, { tagName: "TR", style: {} }];
  const markers = rows.map(row => ({ parentNode: { tagName: "TD", parentNode: row } }));
  const context = { document: { getElementsByName: name => name === "shared_row" ? markers : [] },
    common_set_dom_clilds_required_reset: (row, required, reset) => touched.push({ row, required, reset }) };
  runInNewContext(readFileSync(new URL("../fixtures/route-validation/caption-row-scope/source-row-helper.js.txt", import.meta.url), "utf8"), context, { timeout: 1000 });
  context.common_dom_row_set_show_required_reset("shared_row", false, false, false);
  assert.deepEqual(rows.map(row => row.style.display), ["none", "none"]);
  assert.equal(touched.length, 2);
  for (const reset of [true, false]) for (const required of [true, false]) context.common_dom_row_set_show_required_reset("missing_row", true, required, reset);
  assert.equal(touched.length, 2);
});

for (const [name, expected] of [["shared-markers", ["fd_value_0", "fd_value_1"]], ["orphan-noop", ["fd_value_0"]]]) {
  it(`merges titles under a source-proven ${name} region without changing scripts or canonical write resolution`, () => {
    const source = cleanSourceFile(fixture(name)), draft = draftSourceDraft(source);
    const prior = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
    assert.deepEqual(folded(draft), expected);
    assert.deepEqual(draft.scripts, prior.scripts);
    assert.deepEqual(draft.form.layout.sourceGrid, prior.form.layout.sourceGrid);
    if (name === "shared-markers") assert.equal(resolveSourceRowEffectTarget(draft.form, "shared_row"), undefined);
    const projection = structuredClone(draft);
    projection.scripts = { actions: [] }; projection.formRules = { linkage: [] };
    const prepared = prepareSample(projection);
    assert.equal(prepared.verify(prepared.update).ok, true);
  });
}

it("does not infer a no-op without matching source semantic facts", () => {
  const source = cleanSourceFile(fixture("orphan-noop"));
  for (const script of source.scripts.sources) delete script.semanticFacts.rowMarkers;
  assert.deepEqual(folded(draftSourceDraft(source)), []);
});

it("keeps unknown dynamic DOM creation opaque even beside an audited orphan", () => {
  const source = cleanSourceFile(fixture("orphan-noop"));
  source.scripts.sources[0].javascript += 'document.createElement("input");';
  assert.deepEqual(folded(draftSourceDraft(source)), []);
});

it("does not reuse reset-false evidence for a changed runtime reset-true call", () => {
  const source = cleanSourceFile(fixture("orphan-noop"));
  for (const field of source.form.controls) for (const fact of [field.sourceProps?.staticCaptionFact, field.sourceProps?.captionStructure]) {
    if (fact?.domContext) fact.domContext.inlineScripts = fact.domContext.inlineScripts.map(script => script.replace('false,false,false', 'false,false,true'));
  }
  assert.deepEqual(folded(draftSourceDraft(source)), []);
});

it("keeps an incomplete shared region unresolved", () => {
  const source = cleanSourceFile(fixture("shared-markers"));
  const form = draftSourceDraft(withoutCaptionRelations(source)).form;
  form.layout.mkTree[0].children[0].refIds.push("fd_not_exported");
  assert.equal(captionRowRegion(form, buildFormRuleRefIndex(form), "shared_row"), undefined);
});

it("does not treat a shadowed row helper as the captured native helper", () => {
  const source = cleanSourceFile(fixture("orphan-noop"));
  source.scripts.sources[0].javascript += 'function common_dom_row_set_show_required_reset(){changePresentation();}';
  assert.deepEqual(folded(draftSourceDraft(source)), []);
});

it("reports the originating effect rather than the final unrelated script for an unresolved target", () => {
  const source = cleanSourceFile(fixture("effect-diagnostic")), draft = draftSourceDraft(source);
  const issue = draft.review.captionFolding.decisions.find(item => item.reason === "dynamic_script_unproven").evidence;
  assert.equal(issue.reason, "target_outside_export_domain");
  assert.equal(issue.scriptIndex, 0);
  assert.equal(issue.offset, source.scripts.sources[0].javascript.indexOf("SetXFormFieldValueById"));
  assert.match(issue.sourceSnippet, /fd_not_exported/);
});
