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

  it("models metadata-backed hidden helpers as data-only fields without rendering them", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const dataField = sourceDraft.form.dataFields.find((field) => field.id === "fd_shift");
    const dslField = dslDraft.form.fields.find((field) => field.id === "fd_shift");
    const layoutRefs = dslDraft.form.layout.mkTree.flatMap((row) =>
      row.children.flatMap((cell) => cell.refIds)
    );

    assert.deepEqual(sourceDraft.form.controls.map((field) => field.id), ["fd_mode"]);
    assert.equal(dataField.dataOnly, true);
    assert.equal(dataField.sourceRef, "source.form.dataField.fd_shift");
    assert.equal(dslField.dataOnly, true);
    assert.equal(dslField.sourceRef, "source.form.dataField.fd_shift");
    assert.equal(dslDraft.form.fields.some((field) => field.id === "fd_transient_marker"), false);
    assert.deepEqual(layoutRefs, ["fd_mode"]);
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
    assert.equal(editAction.coverage.status, "partial");
    assert.equal(
      editAction.coverage.residuals.some((item) =>
        item.code === "script.residual.field_value_assignment" && item.target === "fd_shift"
      ),
      true
    );
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
