import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import {
  inspectDeterministicScriptBranchProof
} from "../../src/dsl/deterministic-script-translations.js";
import { inlineRadioRowEffectCandidates } from "../../src/translator/inline-radio-row-effects.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { localCorpusIt } from "../helpers/local-corpus.js";

const fixture =
  "tests/fixtures/route-validation/main-row-reset-lifecycle/route-main-row-reset-lifecycle_SysFormTemplate.xml";
const source3 =
  "tests/fixtures/source3/17307c9e5ac655f208f04e04acea3478";
const basis = "deterministic-inline-radio-row-effects";

describe("main-field row reset lifecycle Route case", () => {
  it("preserves reset=true and the paired load branches without legacy DOM calls", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(sourceDraft);
    assertMainRowResetTranslation(dsl);

    const check = checkDraft(dsl);
    assert.equal(
      check.diagnostics.some((diagnostic) => diagnostic.level === "error"),
      false,
      JSON.stringify(check.diagnostics)
    );
  });

  it("fails closed when an alert contains a user-facing message", () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(sourceDraft);
    const loadSource = structuredClone(sourceDraft.scripts.sources.find((source) =>
      source.javascript.includes("Com_AddEventListener")
    ));
    loadSource.javascript = loadSource.javascript.replace(
      "alert(isGzSubtype.value);",
      "alert(\"Keep this message\");"
    );

    assert.deepEqual(
      inlineRadioRowEffectCandidates(loadSource, dsl.form, dsl.formRules),
      []
    );
  });

  localCorpusIt("closes all six Source3 actions for 17307", () => {
    assertMainRowResetTranslation(draftSourceDraft(cleanSourceFile(source3)));
  });
});

function assertMainRowResetTranslation(dsl) {
  const actions = dsl.scripts.actions.filter((action) =>
    action.functionMappings?.some((mapping) => mapping.basis === basis)
  );
  assert.equal(actions.length, 6, JSON.stringify(dsl.scripts));
  assert.deepEqual(
    actions.map((action) => action.event),
    ["onChange", "onChange", "onChange", "onLoad", "onLoad", "onLoad"]
  );
  assert.equal(actions.every((action) => action.translationStatus === "mapped"), true);
  assert.equal(actions.every((action) => action.coverage?.status === "translated"), true);
  assert.equal(actions.every((action) =>
    inspectDeterministicScriptBranchProof(action, {
      calculationDecisions: dsl.scripts.calculationDecisions
    }).ok
  ), true);
  assert.equal(actions.every((action) =>
    !/common_dom_row_set_show_required_reset|GetXFormFieldById|\balert\s*\(/u.test(action.function)
  ), true);

  const resetActions = actions.filter((action) =>
    action.function.includes('MKXFORM.setValue("fd_gztype", "")')
  );
  assert.deepEqual(resetActions.map((action) => action.event), [
    "onChange",
    "onChange",
    "onLoad",
    "onLoad"
  ]);

  const diagnosticLoad = actions.at(-1);
  assert.deepEqual(diagnosticLoad.semanticHints?.omittedDiagnosticAlerts, {
    count: 3,
    reason: "Every alert argument is a side-effect-free read or the same boolean predicate used by the following row-effect branch."
  });
  assert.match(
    diagnosticLoad.function,
    /\([A-Za-z_$][\w$]*\.indexOf\("ytl"\) >= 0\) && \([A-Za-z_$][\w$]*\.indexOf\("gz"\) >= 0\)/u
  );
  assert.match(diagnosticLoad.function, /MKXFORM\.getValue\("fd_is_gztype"\)/u);
  assert.match(diagnosticLoad.function, /MKXFORM\.getValue\("fd_gz"\)/u);
}
