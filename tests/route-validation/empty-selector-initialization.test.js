import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { inspectDeterministicScriptBranchProof } from "../../src/dsl/deterministic-script-translations.js";
import { inlineRadioRowEffectCandidates } from "../../src/translator/inline-radio-row-effects.js";
import { formAttr, projectTemplate } from "../helpers/persistence.js";

const fixture = "tests/fixtures/route-validation/empty-selector-initialization/route-empty-selector-initialization_SysFormTemplate.xml";
const source = cleanSourceFile(fixture);
const draft = draftSourceDraft(source);
const loads = draft.scripts.actions.filter(action => action.event === "onLoad");
const persistedLoad = formAttr(projectTemplate(draft)).controlAction.global.onLoad[0].function;

function initialize(value) {
  const calls = [];
  const MKXFORM = {
    getValue(id) {
      assert.equal(id, "fd_fkfs");
      return value;
    },
    setFieldAttr(id, attr) { calls.push([id, attr]); }
  };
  runInNewContext(`(${persistedLoad})`, { MKXFORM })({});
  return calls;
}

describe("empty selector initialization Route case", () => {
  it("retains both source-backed row-initialization actions and their deterministic proofs", () => {
    assert.equal(loads.length, 2);
    assert.equal(loads.every(action => action.translationStatus === "mapped"), true);
    assert.equal(loads.every(action => action.functionMappings.some(mapping =>
      mapping.basis === "deterministic-inline-radio-row-effects" && mapping.reviewRequired === false)), true);
    assert.equal(loads.every(action => inspectDeterministicScriptBranchProof(action, {
      calculationDecisions: draft.scripts.calculationDecisions
    }).ok), true);
    const original = source.scripts.sources.find(entry => entry.javascript.includes('is_ywzd.value.indexOf("B")'));
    assert.ok(original);
    assert.equal(loads.every(action => action.sourceRefs.includes(original.sourceRef)), true);
    assert.deepEqual(checkDraft(draft).diagnostics.filter(item => item.level === "error"), []);
  });

  for (const [label, value, visible] of [
    ["undefined", undefined, false], ["null", null, false], ["empty selection array", [], false],
    ["empty string", "", false], ["selected empty String", [""], false], ["electronic transfer", "A", false],
    ["selected electronic transfer array", ["A"], false],
    ["ticket", "B", true], ["selected ticket array", ["B"], true]
  ]) it(`initializes both persisted row permissions for ${label}`, () => {
    const calls = initialize(value);
    assert.equal(calls.filter(([, attr]) => attr === (visible ? 5 : 4)).length, 2);
    assert.deepEqual(calls.filter(([, attr]) => attr === 4 || attr === 5).map(([id]) => id), [
      "fd_pjlx", "fd_zffs"
    ]);
    assert.equal(calls.filter(([, attr]) => attr === 6).length, 2);
  });

  for (const [label, value] of [
    ["number", 0], ["boolean", false], ["object", { value: "B" }], ["non-String selection", [null]],
    ["multiple selections", ["B", "A"]]
  ]) it(`rejects ${label} instead of guessing a String selection`, () => {
    assert.throws(() => initialize(value), /Expected one selected String value/u);
  });

  it("keeps the adaptation scoped to the source-proven empty single String select", () => {
    const original = source.scripts.sources.find(entry => entry.javascript.includes('is_ywzd.value.indexOf("B")'));
    for (const change of [
      field => { field.type = "number"; field.componentId = "xform-number"; },
      field => { field.type = "person"; field.componentId = "xform-person"; },
      field => { field.props.multiple = true; },
      field => { field.sourceProps.metadataAttributes.type = "Double"; },
      field => { field.sourceProps.runtimeSelectEmpty.status = "unsupported"; },
      field => { field.sourceProps.runtimeSelectEmpty.showPleaseSelect = false; },
      field => { field.sourceProps.runtimeSelectEmpty.options[0].value = "changed"; }
    ]) {
      const form = structuredClone(draft.form);
      change(form.fields.find(field => field.id === "fd_fkfs"));
      const candidates = inlineRadioRowEffectCandidates(original, form, draft.formRules);
      assert.equal(candidates.length, 2);
      assert.equal(candidates.every(action => !action.function.includes("__selectionValue")), true);
    }
  });
});
