import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { buildScriptBranchProvenance } from "../../src/dsl/script-branch-provenance.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixture = "tests/fixtures/route-validation/typed-condition-coercion/numeric_SysFormTemplate.xml";
const stringFixture = "tests/fixtures/route-validation/typed-condition-coercion/string_SysFormTemplate.xml";

describe("typed condition coercion Route case", () => {
  it("keeps the source literal types through the deterministic candidate", () => {
    for (const [path, predicate, literal] of [
      [fixture, "loose-numeric-equality", "11"], [stringFixture, "loose-equality", '"11"']
    ]) {
      const { draft } = scenario(path);
      const action = draft.scripts.actions[0];
      assert.equal(action.translationStatus, "needs_review");
      assert.ok(action.function.includes(`current==${literal}`));
      assert.deepEqual(action.branchProvenance.conditions.map(condition => condition.predicate), [predicate, predicate]);
    }
  });

  it("rejects a model patch that narrows numeric loose equality on an unproven String field", () => {
    const { source, draft } = scenario();
    const result = applyEvidenceBackedPatches(draft, mappedPatches(draft.scripts.actions[0], mappedFunction("'11'", "'22'")), {
      sourceDraft: source, sourceRefs: collectSourceRefs(source)
    });
    assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
    assert.ok(result.diagnostics.some(item => item.code === "agent.patch.condition_operand_provenance_unverified"));
  });

  it("rejects the same narrowed function at the independent production trust boundary", () => {
    const { source, draft } = scenario();
    const trusted = trustedCandidate(source, draft, mappedFunction("'11'", "'22'"));
    const result = checkTrust(source, trusted);
    assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
    assert.ok(result.diagnostics.some(item => item.code.includes("condition_operand_provenance_unverified")));
  });

  it("accepts preserved numeric coercion with either stable nullish String normalization", () => {
    for (const normalization of ["raw == null ? '' : String(raw)", "String(raw ?? '')"]) {
      const { source, draft } = scenario();
      const functionText = mappedFunction("11", "22", normalization);
      const patched = applyEvidenceBackedPatches(draft, mappedPatches(draft.scripts.actions[0], functionText), {
        sourceDraft: source, sourceRefs: collectSourceRefs(source)
      });
      assert.equal(patched.ok, true, JSON.stringify(patched.diagnostics));
      const result = checkTrust(source, trustedCandidate(source, patched.dslDraft, functionText));
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    }
  });

  it("preserves noncanonical numeric Strings rather than proving a domain from canonical samples", () => {
    const { source } = scenario();
    const javascript = source.scripts.sources[0].javascript;
    const preserved = mappedFunction("11", "22");
    const narrowed = mappedFunction("'11'", "'22'");
    for (const value of ["11", "011", "11.0", " 11 ", "22", "022", "22.0", " 22 ", "", "0", "x11"]) {
      const expected = sourceEffect(javascript, value);
      assert.equal(mappedEffect(preserved, value), expected, value);
      if (["011", "11.0", " 11 ", "022", "22.0", " 22 "].includes(value)) {
        assert.notEqual(mappedEffect(narrowed, value), expected, value);
      }
    }
    assert.equal(mappedEffect(preserved, undefined), sourceEffect(javascript, ""));
    assert.equal(mappedEffect(preserved, null), sourceEffect(javascript, ""));
  });

  it("keeps source string comparisons as strings and rejects changing equality coercion", () => {
    for (const [path, functionText, expectedOk] of [
      [stringFixture, mappedFunction("'11'", "'22'"), true],
      [stringFixture, mappedFunction("11", "22"), false],
      [fixture, mappedFunction("11", "22").replaceAll("current ==", "current ==="), false]
    ]) {
      const { source, draft } = scenario(path);
      const patched = applyEvidenceBackedPatches(draft, mappedPatches(draft.scripts.actions[0], functionText), {
        sourceDraft: source, sourceRefs: collectSourceRefs(source)
      });
      assert.equal(patched.ok, expectedOk, JSON.stringify(patched.diagnostics));
      assert.equal(checkTrust(source, trustedCandidate(source, draft, functionText)).ok, expectedOk);
    }
  });

  it("rejects a forged string predicate rebuilt from the narrowed target instead of the source", () => {
    const { source, draft } = scenario();
    const trusted = trustedCandidate(source, draft, mappedFunction("'11'", "'22'"));
    const action = trusted.scripts.actions[0];
    action.branchProvenance = buildScriptBranchProvenance({ event: action.event, source: action.function,
      sourceRef: action.branchProvenance.sourceRef, sourceActionKey: action.sourceActionKey });
    const result = checkTrust(source, trusted);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(item => item.code === "trust.script_branch_source_mismatch"));
  });
});

function scenario(path = fixture) {
  const source = cleanSourceFile(path);
  const draft = draftSourceDraft(source);
  assert.equal(draft.scripts.actions.length, 1);
  assert.equal(draft.scripts.actions[0].branchProvenance.status, "proven");
  assert.equal(draft.form.fields.find(field => field.id === "fd_mode").sourceProps.mainStringValueBindingFact.status, "unproven");
  return { source, draft };
}

function mappedFunction(first, second, normalization = "raw == null ? '' : String(raw)") {
  return `function onLoad() {
  var raw = MKXFORM.getValue('fd_mode');
  var current = ${normalization};
  if (current == ${first}) MKXFORM.setValue('fd_payload', 'matched');
  else if (current == ${second}) MKXFORM.setValue('fd_payload', 'second');
  else MKXFORM.setValue('fd_payload', 'other');
}`;
}

function trustedCandidate(source, draft, functionText) {
  const candidate = structuredClone(draft);
  Object.assign(candidate.scripts.actions[0], { function: functionText, translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] }, functionMappings: mappings() });
  return createTrustedMigrationDsl(source, candidate, { externalAgentReviewed: true, decisions: [] });
}

function sourceEffect(javascript, value) {
  let effect;
  new Function("Com_AddEventListener", "window", "GetXFormFieldById", "legacySet", javascript)(
    (_window, _event, callback) => callback(), {}, () => [{ value }], result => { effect = result; }
  );
  return effect;
}

function mappedEffect(javascript, value) {
  let effect;
  new Function("MKXFORM", `${javascript}; onLoad();`)({ getValue: () => value,
    setValue: (_field, result) => { effect = result; } });
  return effect;
}

function mappings() {
  return [{ source: "legacySet", target: "MKXFORM.setValue", basis: "semantic-translation", reviewRequired: false }];
}

function mappedPatches(action, functionText) {
  return Object.entries({ function: functionText, translationStatus: "mapped", functionMappings: mappings(),
    coverage: { status: "translated", nativeRules: [], residuals: [] } }).map(([property, value]) => ({
    op: "replace", path: `/scripts/actions/0/${property}`, value, sourceRefs: action.sourceRefs,
    evidence: ["The original numeric comparison uses the action-local hidden String value."], confidence: 0.99,
    rationale: "Preserve the source branch domain using supported target calls."
  }));
}
