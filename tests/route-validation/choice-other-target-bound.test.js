import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { prepareChoiceOtherRevealConfig } from "../../src/executor/choice-other-reveal-update-plan.js";
import { prepareTargetBoundOtherForm } from "../../src/executor/choice-other-target-bound.js";

const fixture = "tests/fixtures/route-validation/choice-other-target-bound/choice-other-target-bound_SysFormTemplate.xml";
const pairs = [{ choiceId: "fd_kind", triggerId: "fd_kind", textId: "fd_note", optionValue: "OT" }];
function setup() {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  const prior = structuredClone(draft); prior.scripts = { actions: [] };
  const prepared = prepareSample(prior), config = xformConfig(prepared.update);
  return { source, draft, config, tableName: prepared.update.fdTableName, pairs: structuredClone(pairs) };
}
it("plans a target-bound Other reveal only after inspecting the current target actions", () => {
  const input = setup();
  assert.equal(input.draft.form.fields.some(field => field.otherPresentation), false);
  const result = prepareTargetBoundOtherForm(input);
  assert.equal(result.form.fields.find(field => field.id === "fd_kind").otherPresentation.optionValue, "OT");
  assert.ok(result.evidence.sourcePair && result.evidence.targetActionsDigest);
  const plan = prepareChoiceOtherRevealConfig({ ...input, form: result.form });
  assert.equal(plan.changes.length, 2);
  const forged = createTrustedMigrationDsl(input.source, { ...input.draft, form: result.form }, { externalAgentReviewed: true });
  assert.equal(checkTrust(input.source, forged).ok, false, "a current-target proof must not widen ordinary migration trust");
});
for (const [name, action] of [
  ["DOM access", 'function onLoad(){document.body.style.display="none";}'],
  ["dynamic global", 'function onLoad(){globalThis["x"]();}'],
  ["constructor indirection", 'function onLoad(){var x=({}).constructor; x();}'],
  ["unbounded function", 'function onLoad(){unknownEffect();}'],
  ["explanation mutation", 'function onLoad(){MKXFORM.setValue("fd_note","changed");}'],
  ["dynamic field identity", 'function onLoad(){MKXFORM.setValue(externalId,"changed");}'],
  ["unproved native property", 'function onLoad(){var x=MKXFORM.$$FORM;}'],
  ["whole-form alias escape", 'function onLoad(){var x=MKXFORM.getFormValues()||{};unknownEffect(x);}'],
  ["whole-form dynamic access", 'function onLoad(){var x=MKXFORM.getFormValues()||{};var y=x[someId];}']
]) it(`blocks target-bound reveal for ${name}`, () => {
  const input = setup(), attr = JSON.parse(input.config.attribute.formAttr);
  attr.controlAction.global.onLoad = [{ id: "unsafe", name: "onLoad", function: action }];
  input.config.attribute.formAttr = JSON.stringify(attr);
  assert.throws(() => prepareTargetBoundOtherForm(input));
});

it("blocks replacing or reading the whole main model", () => {
  for (const method of ["getValue", "setValue"]) {
    const input = setup(), attr = JSON.parse(input.config.attribute.formAttr);
    attr.controlAction.global.onLoad = [{ id: "unsafe", name: "onLoad", function: `function onLoad(){MKXFORM.${method}(\"${input.tableName}\",{});}` }];
    input.config.attribute.formAttr = JSON.stringify(attr);
    assert.throws(() => prepareTargetBoundOtherForm(input));
  }
});

it("blocks target rules or native field formulas that could inspect the DOM", () => {
  for (const mutate of [
    input => { const attr = JSON.parse(input.config.attribute.formAttr); attr.formRule = { display: [{ condition: "document.body" }] }; input.config.attribute.formAttr = JSON.stringify(attr); },
    input => { input.config.dataModel[0].fdFields[0].fdAttribute += " window.parentNode "; }
  ]) {
    const input = setup(); mutate(input);
    assert.throws(() => prepareTargetBoundOtherForm(input));
  }
});

it("blocks a target that independently requires the explanation", () => {
  const input = setup(); input.config.auth[0].add[input.tableName].fields.fd_note.required = true;
  assert.throws(() => prepareTargetBoundOtherForm(input), /must remain optional/);
});
