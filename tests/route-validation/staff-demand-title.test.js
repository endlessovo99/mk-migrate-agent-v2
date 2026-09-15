import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
const source = cleanSourceFile("tests/fixtures/route-validation/staff-demand-title/route-staff-demand_SysFormTemplate.xml");
const draft = draftSourceDraft(source);
const numericIds = ["fd_3294ae6de14caa", "fd_3294ae3d897c30", "fd_3294ae40b7c302"];

describe("staff demand numeric titles", () => {
  it("keeps one salary caption and hides source-captioned numeric labels", () => {
    assert.equal(draft.form.fields.filter(f => f.props.content === "薪酬范围").length, 1);
    for (const id of numericIds) {
      const field = draft.form.fields.find(f => f.id === id);
      assert.equal(field.componentId, "xform-number");
      assert.equal(field.sourceProps.layoutCell.hiddenLabel, true);
      assert.equal(field.props.hiddenLabel, true);
    }
    assert.equal(draft.form.fields.find(f => f.id === numericIds[1]).props.unit, "到");
  });

  it("persists the numeric labels and horizontal salary range with its separator", () => {
    const prepared = prepareSample(draft);
    const config = xformConfig(prepared.update);
    for (const id of numericIds) {
      const f = config.dataModel[0].fdFields.find(f => f.fdName === id);
      const attrs = JSON.parse(f.fdAttribute).config;
      for (const device of ["desktop", "mobile"]) {
        assert.equal(attrs.controlProps[device].hiddenLabel, true);
        assert.equal(attrs.labelProps[device].hiddenLabel, true);
      }
      if (id === numericIds[1]) assert.equal(attrs.controlProps.showCount, true);
    }
    const rows = JSON.parse(config.viewModel[0].fdConfig).view.render.desktop[0].children[0].children;
    const range = rows[1].children[0].children[5].children[0];
    assert.equal(range.type, "div");
    assert.equal(range.children[0].controlProps.style.display, "flex");
    assert.deepEqual(range.children[0].children.map(item => item.controlProps.style.width), ["64px", "68px"]);
    assert.deepEqual(range.children[0].children.map(item => item.children[0].key), numericIds.slice(1));
    const result = prepared.verify(prepared.update);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  });

  it("rejects readback restoring the duplicate salary title", () => {
    const prepared = prepareSample(draft);
    const altered = structuredClone(prepared.update);
    const cfg = xformConfig(altered);
    const field = cfg.dataModel[0].fdFields.find(f => f.fdName === numericIds[1]);
    const attrs = JSON.parse(field.fdAttribute);
    attrs.config.controlProps.desktop.hiddenLabel = false;
    attrs.config.labelProps.desktop.hiddenLabel = false;
    field.fdAttribute = JSON.stringify(attrs);
    altered.mechanisms["sys-xform"].fdConfig = JSON.stringify(cfg);
    assert.equal(prepared.verify(altered).ok, false);
  });
});
