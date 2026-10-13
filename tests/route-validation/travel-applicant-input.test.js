import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
const draft = draftSourceDraft(cleanSourceFile("tests/fixtures/route-validation/travel-applicant-input/route-travel-applicant_SysFormTemplate.xml"));
const inputId = "fd_3293e0c29f78ac.name", addressId = "fd_3293e0c29f78ac";
describe("travel advance native applicant selector", () => {
  it("folds the name companion into the selector and transfers required validation", () => {
    assert.ok(!draft.form.fields.some(f => f.id === inputId));
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
    assert.ok(draftSourceDraft(source).form.fields.some(f => f.id === inputId));
  });
});
