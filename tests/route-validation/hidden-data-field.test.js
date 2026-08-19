import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, summarizeProjectedForm, xformConfig } from "../helpers/persistence.js";

const fixture = "tests/fixtures/source/route-hidden-data-field";

describe("hard-hidden field Route case", () => {
  it("writes retained hidden helpers as stored native hidden fields at the form tail", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
      externalAgentReviewed: true,
      reviewerName: "route-test",
      checkedAt: "2026-08-16T00:00:00.000Z"
    });
    const prepared = prepareSample(trusted);
    const config = xformConfig(prepared.update);
    const model = config.dataModel.find((entry) => entry.fdType === "main");
    const fields = model.fdFields.filter((field) =>
      ["fd_mode", "fd_shift", "fd_transient_marker"].includes(field.fdName)
    );
    const hiddenFields = fields.filter((field) =>
      ["fd_shift", "fd_transient_marker"].includes(field.fdName)
    );
    const readback = prepared.verify(prepared.update);
    const summary = summarizeProjectedForm(prepared.update);

    assert.deepEqual(fields.map((field) => field.fdName), [
      "fd_mode",
      "fd_shift",
      "fd_transient_marker"
    ]);
    assert.deepEqual(hiddenFields.map((field) => [
      field.fdName,
      field.fdType,
      field.fdIsStored,
      field.fdDisplay
    ]), [
      ["fd_shift", "hidden", true, true],
      ["fd_transient_marker", "hidden", true, true]
    ]);
    for (const field of hiddenFields) {
      const attribute = JSON.parse(field.fdAttribute);
      const fontExtendData = JSON.parse(field.fdFontExtendData);
      assert.equal(attribute.config.type, "hidden");
      assert.equal(attribute.config.controlProps.type, undefined);
      assert.equal(attribute.config.controlProps.controlType.value, "@elem/xform-input");
      assert.equal(attribute.config.controlProps.hidden, true);
      assert.equal(attribute.config.controlProps.passValue, true);
      assert.equal(attribute.config.controlProps.span, 12);
      assert.equal(attribute.config.controlProps.desktop.hiddenLabel, true);
      assert.equal(attribute.config.controlProps.mobile.hiddenLabel, true);
      assert.equal(attribute.config.labelProps.hidden, true);
      assert.equal(attribute.config.labelProps.visible, false);
      assert.equal(fontExtendData.hidden, true);
      assert.equal(fontExtendData.passValue, true);
    }
    assert.deepEqual(readback.form.layoutRows[0].fields, ["fd_mode"]);
    assert.deepEqual(
      readback.form.layoutRows.flatMap((row) => row.fields).slice(-2),
      ["fd_shift", "fd_transient_marker"]
    );
    assert.deepEqual(
      readback.form.fields.filter((field) => field.id.startsWith("fd_")).slice(-2)
        .map((field) => [field.id, field.component, field.type, field.dataOnly]),
      [
        ["fd_shift", "xform-hidden", "text", false],
        ["fd_transient_marker", "xform-hidden", "text", false]
      ]
    );
    assert.deepEqual(
      summary.fields.filter((field) => ["fd_shift", "fd_transient_marker"].includes(field.id))
        .map((field) => [field.id, field.component, field.dataOnly]),
      [
        ["fd_shift", "xform-hidden", false],
        ["fd_transient_marker", "xform-hidden", false]
      ]
    );
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));

    const mutated = structuredClone(prepared.update);
    const mutatedConfig = xformConfig(mutated);
    const mutatedField = mutatedConfig.dataModel
      .find((entry) => entry.fdType === "main")
      .fdFields.find((field) => field.fdName === "fd_shift");
    mutatedField.fdDisplay = false;
    mutated.mechanisms["sys-xform"].fdConfig = JSON.stringify(mutatedConfig);
    const failedReadback = prepared.verify(mutated);
    assert.equal(failedReadback.ok, false);
  });
});
