import assert from "node:assert/strict";
import { it } from "node:test";
import { parse } from "acorn";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { captionBehaviorContract } from "../../src/translator/caption-behavior-contract.js";
import { captionScriptScope } from "../../src/translator/caption-script-scope.js";
import { buildDeterministicScriptBranchProof } from "../../src/dsl/deterministic-script-translations.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";

const source = cleanSourceFile("tests/fixtures/route-validation/caption-shared-scalar/covered-helper_SysFormTemplate.xml");
const form = draftSourceDraft(withoutCaptionRelations(structuredClone(source))).form;
const script = source.scripts.sources[0];
const declarations = parse(script.javascript, { ecmaVersion: "latest" }).body.filter(node => node.type === "FunctionDeclaration");
function mapped() {
  const action = { id: "covered-helpers", event: "onLoad", scope: "global", function: 'function onLoad(){MKXFORM.setValue("fd_value_0",MKXFORM.getValue("fd_value_0"));}',
    translationStatus: "mapped", coverage: { status: "translated", residuals: [] }, sourceRefs: [script.sourceRef],
    functionMappings: [{ source: "closed source value helpers", target: "native value APIs", basis: "deterministic-travel-reimbursement-lifecycle", reviewRequired: false }],
    semanticHints: { coveredCalculationRanges: declarations.map(node => ({ sourceRef: script.sourceRef, name: node.id.name, start: node.start, end: node.end })) } };
  action.deterministicBranchProof = buildDeterministicScriptBranchProof(action);
  return action;
}

it("retains covered helper declarations still referenced by an uncovered callback and their transitive dependencies", () => {
  const contract = captionBehaviorContract(source, form, { actions: [mapped()] });
  assert.equal(contract.summary.residualScope.ok, true, JSON.stringify(contract.summary.residualScope));
  assert.equal(contract.summary.coveredSourceStatements.length, 1);
  assert.equal(contract.summary.coveredSourceStatements[0].start, declarations.find(node => node.id.name === "unusedConstant").start);
  assert.deepEqual(contract.summary.residualScope.dataTargets, ["fd_value_0"]);
});

it("does not retain unused covered declarations solely because a removed helper references them", () => {
  const action = mapped();
  action.semanticHints.coveredCalculationRanges.push({ sourceRef: script.sourceRef, name: "all", start: 0, end: script.javascript.length });
  action.deterministicBranchProof = buildDeterministicScriptBranchProof(action);
  const contract = captionBehaviorContract(source, form, { actions: [action] });
  assert.equal(contract.summary.residualScope.ok, true);
  assert.ok(contract.summary.coveredSourceStatements.length >= 3);
});

it("never hides an independently changed helper body or an unknown callback effect", () => {
  for (const replacement of ['function copyCurrent(){unknownEffect();}', 'function copyCurrent(){GetXFormFieldById("fd_value_0").hide();}']) {
    const changed = structuredClone(source);
    const declaration = declarations.find(node => node.id.name === "copyCurrent");
    const prior = script.javascript.slice(declaration.start, declaration.end);
    const replace = text => text.replace(prior, replacement);
    for (const entry of changed.scripts.sources) entry.javascript = replace(entry.javascript);
    for (const field of changed.form.controls) for (const fact of [field.sourceProps?.captionStructure, field.sourceProps?.staticCaptionFact])
      if (fact?.domContext) fact.domContext.inlineScripts = fact.domContext.inlineScripts.map(replace);
    const contract = captionBehaviorContract(changed, form, { actions: [mapped()] });
    const result = contract.forPair("fd_value_0", "caption_0", { version: 1 });
    assert.equal(result.ok, false);
  }
});

it("models an omitted primitive helper parameter without promoting an unknown value to undefined", () => {
  const changed = structuredClone(source);
  const prior = script.javascript.slice(declarations.find(node => node.id.name === "readCurrent").start, declarations.find(node => node.id.name === "readCurrent").end);
  const replace = text => text.replace(prior, 'function readCurrent(type){if(type=="radio"){return GetXFormFieldValueById("fd_value_0");}return GetXFormFieldValueById("fd_value_0");}');
  for (const entry of changed.scripts.sources) entry.javascript = replace(entry.javascript);
  for (const field of changed.form.controls) for (const fact of [field.sourceProps?.captionStructure, field.sourceProps?.staticCaptionFact])
    if (fact?.domContext) fact.domContext.inlineScripts = fact.domContext.inlineScripts.map(replace);
  assert.equal(captionBehaviorContract(changed, form, { actions: [] }).summary.residualScope.issue?.reason, "unbound_source_function");
  const unknownUnion = captionScriptScope(['function choose(value){if(value){return GetXFormFieldById("fd_value_0");}return "text";}alert(choose(GetXFormFieldValueById("fd_value_0")));'], form, source.form.controls);
  assert.equal(unknownUnion.ok, false);
});
