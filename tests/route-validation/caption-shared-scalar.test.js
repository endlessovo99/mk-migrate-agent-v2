import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { captionScriptScope } from "../../src/translator/caption-script-scope.js";
import { withoutCaptionRelations } from "../helpers/retained-caption-source.js";
import { prepareSample } from "../helpers/persistence.js";
import { captionBehaviorContract } from "../../src/translator/caption-behavior-contract.js";
import { buildDeterministicScriptBranchProof } from "../../src/dsl/deterministic-script-translations.js";
import { parse } from "acorn";

const fixture = "tests/fixtures/route-validation/caption-shared-scalar/shared-scalar_SysFormTemplate.xml";
const source = cleanSourceFile(fixture);
const prior = draftSourceDraft(withoutCaptionRelations(structuredClone(source)));
const scope = (...scripts) => captionScriptScope(scripts, prior.form, source.form.controls);

it("bounds source-owned shared scalar state without changing scripts or source layout", () => {
  const draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.some(field => field.id === "caption_0"), false);
  assert.deepEqual(draft.scripts, prior.scripts);
  assert.deepEqual(draft.form.layout.sourceGrid, prior.form.layout.sourceGrid);
  assert.ok(draft.form.fields.find(field => field.id === "fd_value_0").sourceProps.foldedCaption.behavior.residualImpact.sharedScalars.some(item => item.name === "sharedFlag"));
  const projection = structuredClone(draft); projection.scripts = { actions: [] }; projection.formRules = { linkage: [] };
  const prepared = prepareSample(projection);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("widens every shared scalar read and checks presentation effects in either branch", () => {
  const result = scope('var flag=0;Com_AddEventListener(window,"load",function(){if(flag){GetXFormFieldById("fd_value_0").hide();}else{flag=1;}});');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.presentationTargets, ["fd_value_0"]);
  assert.ok(result.sharedScalars.some(item => item.name === "flag" && item.abstraction === "unknown-scalar"));
});

it("does not restore a literal identity after a global assignment", () => {
  assert.equal(scope('var selected="fd_value_0";Com_AddEventListener(window,"load",function(){selected="fd_value_0";});selected="fd_value_0";GetXFormFieldById(selected);').ok, false);
});

it("does not use initial state to choose a delayed callback's field identity", () => {
  assert.equal(scope('var selected="fd_value_0";Com_AddEventListener(window,"load",function(){GetXFormFieldById(selected);});').ok, false);
});

it("retains the shared abstraction through joined branches and subsequent writes", () => {
  const result = scope('var flag=0;Com_AddEventListener(window,"load",function(){if(GetXFormFieldValueById("fd_value_0")){flag=1;}else{flag=0;}flag=2;if(flag){GetXFormFieldById("fd_value_0").hide();}});');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.presentationTargets, ["fd_value_0"]);
});

it("supports renamed scalar bindings across complete programs without selecting their order", () => {
  const result = scope('var anotherState=true;', 'Com_AddEventListener(window,"load",function(){anotherState=false;});',
    'var anotherState=0;Com_AddEventListener(window,"load",function(){if(anotherState){GetXFormFieldById("fd_value_0")[0].value="x";}});');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.dataTargets, ["fd_value_0"]);
});

for (const [name, script] of [
  ["implicit global", 'Com_AddEventListener(window,"load",function(){missing=1;});'],
  ["node handle stored in shared state", 'var flag=0;Com_AddEventListener(window,"load",function(){flag=GetXFormFieldById("fd_value_0");});'],
  ["object shared state", 'var flag={};Com_AddEventListener(window,"load",function(){flag=1;});'],
  ["nonliteral global initializer", 'var flag=GetXFormFieldValueById("fd_value_0");Com_AddEventListener(window,"load",function(){flag=1;});'],
  ["unknown effect in a false-looking branch", 'var flag=0;Com_AddEventListener(window,"load",function(){if(flag){unknownEffect();}});'],
  ["native global property access", 'var flag=0;Com_AddEventListener(window,"load",function(){window.flag=1;});'],
  ["native JSON binding replacement", 'var JSON=0;Com_AddEventListener(window,"load",function(){JSON=1;});'],
  ["native Object binding replacement", 'var Object=0;Com_AddEventListener(window,"load",function(){Object=1;});'],
  ["unknown state consumer", 'var flag=0;Com_AddEventListener(window,"load",function(){consumeState(flag);});'],
  ["dynamic evaluator", 'var flag=0;eval("flag=1");'],
  ["function and scalar collision", 'var flag=0;function flag(){}flag();'],
  ["local var used before hoisted declaration", 'var flag=0;Com_AddEventListener(window,"load",function(){flag=1;var flag;});'],
  ["conditional top-level declaration", 'if(true){var flag=0;}Com_AddEventListener(window,"load",function(){flag=1;});']
]) it(`does not close ${name}`, () => assert.equal(scope(script).ok, false));

it("does not convert a parameter or local binding into shared state", () => {
  const result = scope('var selected=0;(function(selected){GetXFormFieldById(selected)[0].value="x";})("fd_value_0");');
  assert.equal(result.ok, true, JSON.stringify(result));
});

it("retains current source ownership when mapped coverage consumes a shared declaration", () => {
  const script = source.scripts.sources[0];
  const declaration = parse(script.javascript, { ecmaVersion: "latest" }).body[0];
  const action = { id: "mapped-constant", event: "onLoad", scope: "global", function: "function onLoad(){return true;}",
    translationStatus: "mapped", coverage: { status: "translated", residuals: [] }, sourceRefs: [script.sourceRef],
    functionMappings: [{ source: "closed constant declaration", target: "literal value", basis: "deterministic-travel-reimbursement-lifecycle", reviewRequired: false }],
    semanticHints: { coveredCalculationRanges: [{ sourceRef: script.sourceRef, name: "source-constant", start: declaration.start, end: declaration.end }] } };
  action.deterministicBranchProof = buildDeterministicScriptBranchProof(action);
  const contract = captionBehaviorContract(source, prior.form, { actions: [action] });
  assert.ok(contract.summary.coveredSourceStatements.some(range => range.start === declaration.start));
  assert.equal(contract.summary.residualScope.ok, true, JSON.stringify(contract.summary.residualScope));
  assert.ok(contract.summary.residualScope.sharedScalars.some(item => item.name === "sharedFlag"));
});
