import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile } from "../../src/translator/index.js";
// Retain the prior mixed-field width contract; adaptive coverage lives in adaptive-layout.
import { draftSourceDraft } from "../helpers/source-sized-draft.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const source = cleanSourceFile("tests/fixtures/route-validation/leader-leave-layout/route-leader-leave-layout_SysFormTemplate.xml");
const draft = draftSourceDraft(source);
const ids = ["fd_select_person.name", "fd_select_person", "fd_person_dept", "fd_3255d66ae9a53e", "fd_begin_date", "fd_end_date"];
const prepare = () => prepareSample(createTrustedMigrationDsl(source, draft, {
  externalAgentReviewed: true, reviewerName: "route-validation", checkedAt: "2026-09-10T00:00:00.000Z"
}));

describe("leader leave source layout", () => {
  it("retains independent inputs, folds the department display pair, and hides duplicate titles", () => {
    assert.equal(validateMigrationDsl(draft, { mode: "draft" }).ok, true);
    assert.ok(!draft.form.fields.some(field => field.id === "fd_person_dept.name"));
    for (const id of ids) {
      const field = draft.form.fields.find((field) => field.id === id);
      assert.notEqual(field.dataOnly, true, id);
      assert.equal(field.props.hiddenLabel, true, id);
    }
  });

  it("persists horizontal name, department, and date groups within the source grid", () => {
    const prepared = prepare();
    const config = xformConfig(prepared.update);
    const rows = JSON.parse(config.viewModel[0].fdConfig).view.render.desktop[0].children[0].children;
    for (const [rowIndex, widths] of [[0, ["198px", "32px", "5px"]], [2, ["198px"]], [3, ["148px", "24px", "332px"]]]) {
      const grid = rows[rowIndex].children[0];
      assert.equal(grid.controlProps.columns, 4);
      const inline = grid.children[1].children[0];
      assert.equal(inline.type, "div");
      assert.equal(inline.children[0].controlProps.style.display, "flex");
      assert.deepEqual(inline.children[0].children.map(item => item.controlProps.style.width), widths);
    }
    for (const field of config.dataModel[0].fdFields.filter((field) => ids.includes(field.fdName))) {
      const attrs = JSON.parse(field.fdAttribute).config;
      for (const device of ["desktop", "mobile"]) {
        assert.equal(attrs.controlProps[device].hiddenLabel, true, field.fdName);
        assert.equal(attrs.labelProps[device].hiddenLabel, true, field.fdName);
      }
    }
    const result = prepared.verify(prepared.update);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  });

  it("rejects readback restoring a duplicate date title", () => {
    const prepared = prepare();
    const mutated = structuredClone(prepared.update);
    const config = xformConfig(mutated);
    const date = config.dataModel[0].fdFields.find((field) => field.fdName === "fd_begin_date");
    const attrs = JSON.parse(date.fdAttribute);
    attrs.config.controlProps.desktop.hiddenLabel = false;
    attrs.config.labelProps.desktop.hiddenLabel = false;
    date.fdAttribute = JSON.stringify(attrs);
    mutated.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    assert.equal(prepared.verify(mutated).ok, false);
  });
});
