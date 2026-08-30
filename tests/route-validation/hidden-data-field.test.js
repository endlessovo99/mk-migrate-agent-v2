import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { checkExecute } from "../../src/dsl/checks.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { formAttr, prepareSample, summarizeProjectedForm, xformConfig } from "../helpers/persistence.js";

const fixture = "tests/fixtures/source/route-hidden-data-field";

describe("hard-hidden field Route case", () => {
  it("rejects reviewed text predicates that lose the legacy empty-string value", () => {
    const source = cleanSourceFile("tests/fixtures/route-validation/empty-text-initialization/route-empty-text-initialization_SysFormTemplate.xml");
    const draft = draftSourceDraft(source);
    const result = applyEvidenceBackedPatches(draft, initializationPatches(draft, false), {
      sourceDraft: source, sourceRefs: collectSourceRefs(source)
    });
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((item) => item.details?.reason === "legacy_text_empty_value_not_preserved"));
  });

  it("runs all initializers with unset text flags and preserves conditional external fields", () => {
    const source = cleanSourceFile("tests/fixtures/route-validation/empty-text-initialization/route-empty-text-initialization_SysFormTemplate.xml");
    const draft = draftSourceDraft(source);
    const result = applyEvidenceBackedPatches(draft, initializationPatches(draft, true), {
      sourceDraft: source, sourceRefs: collectSourceRefs(source)
    });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    const trusted = createTrustedMigrationDsl(source, result.dslDraft, { externalAgentReviewed: true });
    assert.equal(checkTrust(source, trusted).ok, true);
    assert.equal(checkExecute(trusted).ok, true);
    const forged = structuredClone(trusted);
    delete forged.scripts.actions[0].branchProvenance.conditions[0].emptyText;
    assert.equal(checkTrust(source, forged).ok, false);
    const prepared = prepareSample(trusted);
    assert.equal(prepared.verify(prepared.update).ok, true);
    const code = formAttr(prepared.update).controlAction.global.onLoad[0].function;
    const ids = ["fd_external_name", "fd_external_account", "fd_external_bank"];
    for (const value of [undefined, null, "", "internal", "external"]) {
      const states = new Map(ids.map((id) => [id, { visible: true, required: true }]));
      const onLoad = new Function("MKXFORM", `${code};return onLoad;`)({
        getValue(id) { return id === "fd_external_flag" ? value : undefined; },
        setFieldAttr(id, state) {
          if (!states.has(id)) return;
          if (state === 4) states.get(id).visible = false;
          if (state === 5) states.get(id).visible = true;
          if (state === 6) states.get(id).required = false;
          if (state === 3) states.get(id).required = true;
        }
      });
      assert.doesNotThrow(() => onLoad({}));
      for (const state of states.values()) {
        assert.deepEqual(state, { visible: value === "external", required: value === "external" });
      }
    }
  });

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

function initializationPatches(draft, safe) {
  return draft.scripts.actions.flatMap((action, index) => {
    const external = action.branchProvenance.conditions[0].origin === "field:fd_external_flag";
    const fieldId = external ? "fd_external_flag" : "fd_first_flag";
    const marker = external ? "external_row" : "internal_row";
    const read = `MKXFORM.getValue('${fieldId}')`;
    const values = {
      function: `function onLoad() {
        var text = ${safe ? `String(${read} ?? '')` : read};
        if (text.indexOf('${external ? "external" : "ready"}') >= 0) {
          MKXFORM.setFieldAttr('${marker}', 5);
          MKXFORM.setFieldAttr('${marker}', ${external ? 3 : 6});
        } else {
          MKXFORM.setFieldAttr('${marker}', 4);
          MKXFORM.setFieldAttr('${marker}', 6);
        }
      }`,
      translationStatus: "mapped",
      coverage: { status: "translated", nativeRules: [], residuals: [] },
      functionMappings: [{ source: "source text value and row states", target: "MKXFORM.getValue/setFieldAttr", basis: "semantic-translation", reviewRequired: false }]
    };
    return Object.entries(values).map(([property, value]) => ({
      op: "replace", path: `/scripts/actions/${index}/${property}`, value,
      sourceRefs: action.sourceRefs, confidence: 1,
      evidence: ["The source reads a scalar text control value and switches the same row states."],
      rationale: "Preserve initial empty-text behavior and both source branches."
    }));
  });
}
