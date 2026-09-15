import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { mapAddressDisplayCompanions } from "../../src/translator/address-display-companion-mapping.js";
const draft = draftSourceDraft(cleanSourceFile("tests/fixtures/route-validation/travel-applicant-input/route-travel-applicant_SysFormTemplate.xml"));
const inputId = "fd_3293e0c29f78ac.name", addressId = "fd_3293e0c29f78ac";
describe("travel advance independently rendered applicant input", () => {
  it("retains the required input using actual xtext evidence despite inactive label binding", () => {
    const input = draft.form.fields.find(f => f.id === inputId);
    assert.equal(input.title, "申请人1");
    assert.notEqual(input.dataOnly, true);
    assert.equal(input.props.required, true);
    assert.equal(input.props.hiddenLabel, true);
    assert.equal(input.sourceProps.designerValues._label_bind, "false");
    assert.equal(input.sourceProps.layoutCell.renderer, "xform:xtext");
    assert.deepEqual(input.sourceProps.layoutCell.captionIds, ["fd_3292fc00e02d44"]);
    assert.notEqual(draft.form.fields.find(f => f.id === addressId).props.required, true);
    assert.deepEqual(draft.form.layout.mkTree[0].children[3].refIds, [inputId, addressId]);
  });
  it("persists both controls with the source input visible and required", () => {
    const p = prepareSample(draft), cfg = xformConfig(p.update);
    const input = cfg.dataModel[0].fdFields.find(f => f.fdName === inputId);
    assert.equal(input.fdDisplay, true);
    assert.equal(JSON.parse(input.fdAttribute).config.controlProps.required, true);
    assert.equal(p.verify(p.update).ok, true);
  });
  it("keeps the data-only fallback if independent rendering evidence is absent", () => {
    const fields = structuredClone(draft.form.fields);
    delete fields.find(f => f.id === inputId).sourceProps.layoutCell.renderer;
    const mapped = mapAddressDisplayCompanions(fields, draft.form.layout.sourceGrid);
    assert.equal(mapped.find(f => f.id === inputId).dataOnly, true);
    assert.equal(mapped.find(f => f.id === addressId).props.required, true);
  });
});
