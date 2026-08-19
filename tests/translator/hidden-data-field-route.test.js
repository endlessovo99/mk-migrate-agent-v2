import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkDraft } from "../../src/dsl/checks.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixture = "tests/fixtures/source/route-hidden-data-field";

describe("hidden data field route", () => {
  it("reads only current values from direct puts on the root SysFormTemplate map", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const serialized = JSON.stringify(sourceDraft);

    assert.equal(sourceDraft.source.sysFormTemplate.fdId, "route-hidden-current-sysform-id");
    assert.equal(sourceDraft.source.sysFormTemplate.fdModelId, "route-hidden-current-template-id");
    assert.equal(sourceDraft.template.name, "隐藏字段与视图门控");
    assert.equal(serialized.includes("historical-sysform-id"), false);
    assert.equal(serialized.includes("historical-template-id"), false);
    assert.equal(serialized.includes("fd_stale"), false);
  });

  it("retains hard-hidden helpers as native hidden fields at the form tail", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const sourceFields = sourceDraft.form.dataFields;
    const dslFields = dslDraft.form.fields.slice(-2);
    const layoutRefs = dslDraft.form.layout.mkTree.flatMap((row) =>
      row.children.flatMap((cell) => cell.refIds)
    );

    assert.deepEqual(sourceDraft.form.controls.map((field) => field.id), ["fd_mode"]);
    assert.deepEqual(sourceFields.map((field) => field.id), [
      "fd_shift",
      "fd_transient_marker"
    ]);
    assert.deepEqual(sourceFields.map((field) => field.sourceProps.hardHidden), [true, true]);
    assert.equal(sourceFields.every((field) => field.dataOnly !== true), true);
    assert.deepEqual(dslFields.map((field) => [field.id, field.componentId, field.dataOnly]), [
      ["fd_shift", "xform-hidden", undefined],
      ["fd_transient_marker", "xform-hidden", undefined]
    ]);
    assert.deepEqual(dslFields.map((field) => field.sourceRef), [
      "source.form.dataField.fd_shift",
      "source.form.dataField.fd_transient_marker"
    ]);
    assert.deepEqual(layoutRefs, ["fd_mode", "fd_shift", "fd_transient_marker"]);
    assert.deepEqual(
      dslDraft.form.layout.mkTree.slice(-2).map((row) => row.children[0].refIds[0]),
      ["fd_shift", "fd_transient_marker"]
    );
    assert.equal(checkDraft(dslDraft).ok, true);
  });

  it("preserves JSP gates while projecting provable gated form rules as native formulas", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const sourceGates = sourceDraft.scripts.sources.map((source) => source.displayGate);
    const editAction = dslDraft.scripts.actions.find((action) => action.event === "onChange");
    const viewAction = dslDraft.scripts.actions.find((action) => action.event === "onLoad");

    assert.deepEqual(sourceGates, ["xform:editShow", "xform:viewShow"]);
    assert.equal(sourceDraft.formRules.linkage.length, 1);
    assert.equal(sourceDraft.formRules.linkage[0].meta.displayGate, "xform:editShow");
    assert.equal(dslDraft.formRules.linkage.length, 1);
    assert.deepEqual(dslDraft.formRules.review, {});
    assert.deepEqual(dslDraft.formRules.linkage[0].meta.runWhen, { viewStatusIn: ["add", "edit"] });
    assert.equal(dslDraft.formRules.linkage[0].meta.conditionSource, "event:value");
    assert.equal(
      dslDraft.formRules.linkage[0].meta.sourceActionKey,
      editAction.sourceActionKey
    );
    assert.deepEqual(editAction.coverage.nativeRules, ["linkage.fd_mode.contains.A"]);
    assert.equal(editAction.coverage.status, "translated");
    assert.equal(
      editAction.coverage.residuals.some((item) =>
        item.code === "script.residual.field_value_assignment" && item.target === "fd_shift"
      ),
      false
    );
    assert.equal(editAction.translationStatus, "mapped");
    assert.match(editAction.function, /MKXFORM\.setValue\("fd_shift", value\)/);
    assert.deepEqual(editAction.runWhen, { viewStatusIn: ["add", "edit"] });
    assert.deepEqual(viewAction.runWhen, { viewStatusIn: ["view"] });
  });

  it("recognizes quoted hidden inputs as source row markers", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const modeRow = sourceDraft.form.layout.rows.find((row) =>
      row.sourceMarkers?.includes("mode_row")
    );

    assert.equal(modeRow?.cells[0]?.references[0]?.referenceId, "fd_mode");
    assert.equal(sourceDraft.formRules.linkage[0].effects[0].target, "mode_row");
    assert.equal(dslDraft.formRules.linkage.length, 1);
    assert.equal(dslDraft.formRules.linkage[0].translationStatus, "executable");
  });
});
