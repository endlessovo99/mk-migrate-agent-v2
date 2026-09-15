import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { mapAddressDisplayCompanions } from "../../src/translator/address-display-companion-mapping.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixture = "tests/fixtures/route-validation/business-card-layout/route-business-card-layout_SysFormTemplate.xml";
const source = cleanSourceFile(fixture);
const draft = draftSourceDraft(source);
const fields = new Map(draft.form.fields.map((field) => [field.id, field]));

function preparedForm() {
  return prepareSample(createTrustedMigrationDsl(source, draft, {
    externalAgentReviewed: true,
    reviewerName: "route-validation",
    checkedAt: "2026-09-10T00:00:00.000Z"
  }));
}

function desktopGrid(config, row = 0) {
  const scene = JSON.parse(config.viewModel[0].fdConfig);
  return scene.view.render.desktop[0].children[0].children[row].children[0];
}

describe("business-card source form layout", () => {
  it("preserves independently visible name inputs, required state, and source defaults", () => {
    assert.equal(validateMigrationDsl(draft, { mode: "draft" }).ok, true);
    for (const id of ["fd_display_name.name", "fd_person_dept.name"]) {
      assert.notEqual(fields.get(id).dataOnly, true, id);
      assert.equal(fields.get(id).componentId, "xform-input");
      assert.equal(fields.get(id).props.hiddenLabel, true);
    }
    assert.equal(fields.get("fd_display_name.name").props.required, true);
    assert.notEqual(fields.get("fd_display_name").props.required, true);
    assert.deepEqual(fields.get("fd_display_name.name").props.defaultValue,
      { kind: "context", source: "creator", property: "fdName" });
    assert.deepEqual(fields.get("fd_person_dept.name").props.defaultValue,
      { kind: "context", source: "creatorDept", property: "fdName" });
    const refs = draft.form.layout.mkTree[0].children.map((cell) => cell.refIds);
    assert.deepEqual(refs[1], ["fd_display_name.name", "fd_display_name", "fd_325680e6d2262a"]);
    assert.deepEqual(refs[3], ["fd_person_dept.name", "fd_person_dept", "fd_33965150c0040c", "fd_339651595696c2"]);
  });

  it("persists one title per group and horizontal native rows with usable input shares", () => {
    const prepared = preparedForm();
    const config = xformConfig(prepared.update);
    const nativeFields = new Map(config.dataModel[0].fdFields.map((field) => [field.fdName, field]));
    for (const id of ["fd_display_name.name", "fd_display_name", "fd_person_dept.name", "fd_person_dept", "fd_project_org", "fd_3396516a0f980c"]) {
      const field = nativeFields.get(id);
      assert.equal(field.fdDisplay, true, id);
      const attribute = JSON.parse(field.fdAttribute).config;
      assert.equal(attribute.controlProps.desktop.hiddenLabel, true, id);
      assert.equal(attribute.labelProps.desktop.hiddenLabel, true, id);
    }
    const first = desktopGrid(config);
    const second = desktopGrid(config, 1);
    assert.equal(first.controlProps.rows, 1);
    assert.equal(first.controlProps.columns, 4);
    assert.deepEqual(first.controlProps.colsStyle, second.controlProps.colsStyle);
    assert.equal(first.children[1].children[0].type, "@elem/xform-row");
    assert.deepEqual(first.children[1].children[0].controlProps.spans, [11, 11, 2]);
    assert.deepEqual(second.children[1].children[0].controlProps.spans, [11, 2, 11]);
    assert.equal(second.children[3].children[0].key, "fd_325692094a72b8");
    const readback = prepared.verify(prepared.update);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
  });

  it("keeps the stored-only mapping for hidden, zero-width, or unbound companions", () => {
    for (const values of [{ width: "0" }, { canShow: "false" }, { _label_bind: "false" }]) {
      const candidates = structuredClone(draft.form.fields);
      const name = candidates.find((field) => field.id === "fd_display_name.name");
      Object.assign(name.sourceProps.designerValues, values);
      const mapped = mapAddressDisplayCompanions(candidates, draft.form.layout.sourceGrid);
      assert.equal(mapped.find((field) => field.id === name.id).dataOnly, true);
      assert.equal(mapped.find((field) => field.id === "fd_display_name").props.required, true);
    }
  });

  it("rejects a readback which drops the horizontal row widths while preserving all field IDs", () => {
    const prepared = preparedForm();
    const mutated = structuredClone(prepared.update);
    const config = xformConfig(mutated);
    const scene = JSON.parse(config.viewModel[0].fdConfig);
    delete scene.view.render.desktop[0].children[0].children[1].children[0].children[1].children[0].controlProps.spans;
    config.viewModel[0].fdConfig = JSON.stringify(scene);
    mutated.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    const result = prepared.verify(mutated);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((item) => item.code === "readback.form.layout_inline_layout_mismatch"));
  });

  it("rejects a readback which removes the restored name input", () => {
    const prepared = preparedForm();
    const mutated = structuredClone(prepared.update);
    const config = xformConfig(mutated);
    const scene = JSON.parse(config.viewModel[0].fdConfig);
    const cell = scene.view.render.desktop[0].children[0].children[0].children[0].children[1];
    cell.children[0].children = cell.children[0].children.filter((child) => child.key !== "fd_display_name.name");
    config.viewModel[0].fdConfig = JSON.stringify(scene);
    mutated.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    const result = prepared.verify(mutated);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((item) => item.code === "readback.form.layout_cell_fields_mismatch"));
  });
});
