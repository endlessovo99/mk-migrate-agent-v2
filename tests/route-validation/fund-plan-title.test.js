import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
const source = cleanSourceFile("tests/fixtures/route-validation/fund-plan-title/route-fund-plan_SysFormTemplate.xml");
const draft = draftSourceDraft(source);
const ids = ["fd_3768ce680734d0", "fd_3768ce737dae72", "fd_3768cea1e5ade2"];
describe("fund plan copy source titles", () => {
  it("hides date and attachment titles backed by retained captions", () => {
    for (const id of ids) assert.equal(draft.form.fields.find(f => f.id === id).props.hiddenLabel, true);
    assert.equal(draft.form.fields.find(f => f.id === "fd_3768ce0c1ce98a").props.content, "附件");
    const period = draft.form.layout.mkTree[1].children[1];
    assert.deepEqual(period.refIds, [ids[0], "fd_3768ce6b022212", ids[1]]);
    assert.equal(period.keepInline, true);
  });
  it("persists both client label settings and detects attachment label regression", () => {
    const p = prepareSample(draft), cfg = xformConfig(p.update);
    for (const id of ids) {
      const a = JSON.parse(cfg.dataModel[0].fdFields.find(f => f.fdName === id).fdAttribute).config;
      for (const device of ["desktop", "mobile"]) {
        assert.equal(a.controlProps[device].hiddenLabel, true);
        assert.equal(a.labelProps[device].hiddenLabel, true);
      }
    }
    assert.equal(p.verify(p.update).ok, true);
    const altered = structuredClone(p.update), changed = xformConfig(altered);
    const f = changed.dataModel[0].fdFields.find(f => f.fdName === ids[2]);
    const a = JSON.parse(f.fdAttribute);
    a.config.controlProps.desktop.hiddenLabel = false;
    a.config.labelProps.desktop.hiddenLabel = false;
    f.fdAttribute = JSON.stringify(a);
    altered.mechanisms["sys-xform"].fdConfig = JSON.stringify(changed);
    assert.equal(p.verify(altered).ok, false);
  });
});
