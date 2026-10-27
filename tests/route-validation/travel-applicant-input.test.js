import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
const draft = draftSourceDraft(cleanSourceFile("tests/fixtures/route-validation/travel-applicant-input/route-travel-applicant_SysFormTemplate.xml"));
const inputId = "fd_3293e0c29f78ac.name", addressId = "fd_3293e0c29f78ac";
describe("travel advance native applicant selector", () => {
  it("folds the name companion into the selector and transfers required validation", () => {
    assert.ok(!draft.form.fields.some(f => (f.sourceProps?.originalId || f.id) === inputId));
    const address = draft.form.fields.find(f => f.id === addressId);
    assert.equal(address.props.required, true);
    assert.equal(address.props.hiddenLabel, true);
    assert.equal(address.sourceProps.consumedAddressDisplayCompanionId, inputId);
    assert.deepEqual(draft.form.layout.mkTree[0].children[3].refIds, [addressId]);
  });
  it("persists one required address field without the redundant name column", () => {
    const p = prepareSample(draft), cfg = xformConfig(p.update);
    assert.ok(!cfg.dataModel[0].fdFields.some(f => f.fdName === inputId));
    const address = cfg.dataModel[0].fdFields.find(f => f.fdName === addressId);
    assert.equal(address.fdType, "address");
    assert.equal(JSON.parse(address.fdAttribute).config.controlProps.required, true);
    assert.equal(p.verify(p.update).ok, true);
  });
  it("retains a name field that scripts reference instead of dropping its semantics", () => {
    const source = cleanSourceFile("tests/fixtures/route-validation/travel-applicant-input/route-travel-applicant_SysFormTemplate.xml");
    source.scripts.evidence = inputId;
    assert.ok(draftSourceDraft(source).form.fields.some(f => (f.sourceProps?.originalId || f.id) === inputId));
  });

  it("folds despite another radio's DOM inventory and retains the complete observational fact", () => {
    const source = cleanSourceFile("tests/fixtures/route-validation/travel-applicant-input/route-travel-applicant_SysFormTemplate.xml");
    const carrier = source.form.controls.find(f => f.sourceProps?.radioReadOnlySourceFact?.kind === "static-main-radio-group" &&
      JSON.stringify(f.sourceProps.radioReadOnlySourceFact).includes(inputId));
    assert.ok(carrier, "The real radio observation must inventory the companion ID");
    const before = structuredClone(source), result = draftSourceDraft(source);
    assert.equal(result.form.fields.some(f => (f.sourceProps?.originalId || f.id) === inputId), false);
    assert.deepEqual(source, before, "Dependency projection must not delete source evidence");
    assert.deepEqual(result.form.fields.find(f => f.sourceRef === carrier.sourceRef).sourceProps.radioReadOnlySourceFact,
      carrier.sourceProps.radioReadOnlySourceFact);
  });

  it("still blocks the fold for real script, workflow, rule and other-field dependencies", () => {
    const source = cleanSourceFile("tests/fixtures/route-validation/travel-applicant-input/route-travel-applicant_SysFormTemplate.xml");
    for (const [name, edit] of [
      ["source script read", s => { s.scripts.sources[0].javascript += `\nGetXFormFieldValueById(${JSON.stringify(inputId)});`; }],
      ["workflow field operand", s => { s.workflow = { nodes: [{ id: "N1", condition: { fieldId: inputId, operator: "notEmpty" } }] }; }],
      ["form rule operand", s => { s.formRules = { linkage: [{ id: "dependent-rule", when: { fieldId: inputId, operator: "notEmpty" }, effects: [] }] }; }],
      ["other-field source formula", s => { s.form.controls.find(x => x.sourceType === "radio").sourceProps.designerValues.formula = `$${inputId}$`; }],
      ["unknown same-named property", s => { s.form.controls.find(x => x.sourceType === "radio").sourceProps.radioReadOnlySourceFact = { version: 1, kind: "business-dependency", fieldId: inputId }; }]
    ]) {
      const s = structuredClone(source); edit(s);
      const before = structuredClone(s), result = draftSourceDraft(s);
      assert.ok(result.form.fields.some(x => (x.sourceProps?.originalId || x.id) === inputId), name);
      assert.deepEqual(s, before, name + " must not mutate its source");
    }
  });
});
