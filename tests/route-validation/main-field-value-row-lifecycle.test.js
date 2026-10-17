import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { inspectDeterministicScriptBranchProof } from "../../src/dsl/deterministic-script-translations.js";
import { inlineRadioRowEffectCandidates } from "../../src/translator/inline-radio-row-effects.js";
import { runRouteCase } from "./run-route-case.js";
import { localCorpusIt } from "../helpers/local-corpus.js";
import vm from "node:vm";

const fixture = "tests/fixtures/route-validation/main-field-value-row-lifecycle/route-main-field-value-row-lifecycle_SysFormTemplate.xml";
const corpus = "tests/fixtures/source/18b940a16be81952fdd4eb64816aa02c";

describe("main-field value API row lifecycle Route case", () => {
  it("preserves independent change and load branches with a single owner for row effects", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    assertClosed(dsl, 6);
    const values = {};
    const rows = {};
    const api = {
      getValue(id) { return values[id]; },
      setValue(id, value) { values[id] = value; },
      setFieldAttr(id, attribute) {
        rows[id] ||= {};
        if (attribute === 3 || attribute === 6) rows[id].required = attribute === 3;
        if (attribute === 4 || attribute === 5) rows[id].visible = attribute === 5;
      }
    };
    const run = (action, value) => new Function("MKXFORM", `${action.function}; return ${action.name};`)(api)(value);
    const changes = dsl.scripts.actions.filter(a => a.event === "onChange");
    const loads = dsl.scripts.actions.filter(a => a.event === "onLoad");
    assert.equal(changes.length, 3);
    assert.equal(loads.length, 3);
    assert.ok(changes.every(a => JSON.stringify(a.runWhen) === JSON.stringify({ viewStatusIn: ["add", "edit"] })));
    assert.ok(loads.every(a => a.runWhen === undefined));
    for (const token of ["A", "B", "", "C"]) {
      for (const action of changes) run(action, token);
      for (const option of ["A", "B", "C"]) {
        assert.equal(values[`fd_state_${option}`], token === option ? option : "");
        assert.deepEqual(rows[option === "A" ? "fd_A_primary_row" : `fd_${option}_row`], { visible: token === option, required: token === option });
      }
      for (const action of loads) run(action);
      for (const option of ["A", "B", "C"]) {
        assert.deepEqual(rows[option === "A" ? "fd_A_primary_row" : `fd_${option}_row`], { visible: token === option, required: false });
      }
    }
    delete values.fd_state_A;
    run(loads[0]);
    assert.deepEqual(rows.fd_A_primary_row, { visible: false, required: false });
  });

  it("trusts and verifies persisted scripts through the guarded fake executor", async () => {
    const result = await runRouteCase("main-field-value-row-lifecycle-success");
    assert.equal(result.dsl.trust.executable, true);
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.readback.ok, true);
    assert.equal(result.execution.readback.form.scripts.actions.length, 6);
  });

  it("limits a direct legacy value list to loose nonempty-string comparisons of hidden String controls", () => {
    const source=cleanSourceFile(fixture),draft=draftSourceDraft(source);
    const original=source.scripts.sources.find(item=>item.javascript.includes('GetXFormFieldValueById("fd_state_A")'));
    const mapped=inlineRadioRowEffectCandidates(original,draft.form,draft.formRules);
    assert.equal(mapped.length,2);
    for(const value of [undefined,"","A","B","A,B"]){
      const observed=[],expected=[],loads=[];
      vm.runInNewContext(original.javascript,{window:{},Com_AddEventListener(_w,_e,fn){loads.push(fn);},
        GetXFormFieldValueById(id){const current=id==="fd_state_A"?value:undefined;return current===undefined?[]:[current];},
        common_dom_row_set_show_required_reset(id,show,required,reset){assert.equal(reset,false);expected.push([id,show?5:4],[id,required?3:6]);}});
      for(const fn of loads)fn();
      for(const action of mapped)vm.runInNewContext(`${action.function};onLoad();`,{MKXFORM:{getValue(id){return id==="fd_state_A"?value:undefined;},setFieldAttr(id,attr){observed.push([id,attr]);}}});
      // The compiler canonicalizes a secondary source marker before persistence.
      for(const effect of expected)if(effect[0]==="fd_A_row")effect[0]="fd_A_primary_row";
      assert.deepEqual(observed,expected);
    }
    for(const javascript of [original.javascript.replaceAll(')==',')==='),original.javascript.replaceAll('=="A"','==""')]){
      assert.notEqual(javascript,original.javascript);
      assert.equal(inlineRadioRowEffectCandidates({...original,javascript},draft.form,draft.formRules).some(action=>action.translationStatus==="mapped"),false);
    }
    const visible=structuredClone(draft.form);visible.fields.find(field=>field.id==="fd_state_A").dataOnly=false;
    assert.equal(inlineRadioRowEffectCandidates(original,visible,draft.formRules).some(action=>action.translationStatus==="mapped"),false);
  });

  it("does not accept a source with an unhandled side effect or a shadowed platform API", () => {
    const source = cleanSourceFile(fixture);
    const dsl = draftSourceDraft(source);
    const original = source.scripts.sources.find(s => s.javascript.includes("SetXFormFieldValueById"));
    for (const javascript of [
      original.javascript.replace('SetXFormFieldValueById("fd_state_A","A");', 'SetXFormFieldValueById("fd_state_A","A"); unknownSideEffect();'),
      original.javascript.replace('function(value, domElement)', 'function(value, common_dom_row_set_show_required_reset)'),
      original.javascript.replace('"fd_state_A","A"', '"fd_unknown","A"')
    ]) {
      assert.deepEqual(inlineRadioRowEffectCandidates({ ...original, javascript }, dsl.form, dsl.formRules), []);
    }
  });

  localCorpusIt("closes the sixteen real production-notice actions", () => {
    assertClosed(draftSourceDraft(cleanSourceFile(corpus)), 16);
  });
});

function assertClosed(dsl, count) {
  assert.equal(dsl.scripts.actions.length, count);
  for (const action of dsl.scripts.actions) {
    assert.equal(action.translationStatus, "mapped", action.id);
    assert.deepEqual(action.coverage, { status: "translated", nativeRules: [], residuals: [] });
    assert.equal(inspectDeterministicScriptBranchProof(action).ok, true, action.id);
  }
  assert.equal(dsl.formRules?.linkage?.length || 0, 0, "native rules must not compete with complete script translations");
  const check = checkDraft(dsl);
  assert.equal(check.ok, true, JSON.stringify(check.diagnostics));
}
