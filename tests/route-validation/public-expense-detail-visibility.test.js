import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import { inlineRadioRowEffectCandidates } from "../../src/translator/inline-radio-row-effects.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
const source = cleanSourceFile("tests/fixtures/route-validation/public-expense-detail-visibility/route-public-expense_SysFormTemplate.xml");
const draft = draftSourceDraft(source);
const detailId = "fd_37b058dbdb8e54";
describe("public expense detail visibility authority", () => {
  it("retains all nine tables and delegates complete load visibility to native rules", () => {
    const tables = draft.form.fields.filter(f => f.columns);
    assert.equal(tables.length, 9);
    for (const table of tables) assert.ok(JSON.stringify(draft.form.layout.mkTree).includes(table.id));
    const action = draft.scripts.actions.find(a => a.id === "fd_37b0de6f06003a.script.2.event.6");
    assert.deepEqual(action.coverage.nativeRules, ["linkage.bxlx.contains.rcyy.load"]);
    assert.doesNotMatch(action.function, /setFieldAttr\("rcyy_row", [45]\)/);
    assert.match(action.function, /setFieldAttr\("rcyy_row", 6\)/);
    const rule = draft.formRules.linkage.find(r => r.id === action.coverage.nativeRules[0]);
    assert.deepEqual(rule.when, [{field: "bxlx", op: "contains", value: "rcyy"}]);
    assert.deepEqual(rule.effects, [{type: "visible", target: "rcyy_row", value: true}]);
    assert.deepEqual(rule.else, [{type: "visible", target: "rcyy_row", value: false}]);
  });
  it("does not let empty or stale helpers override native detail visibility on load", () => {
    const p = prepareSample(draft), cfg = xformConfig(p.update);
    const load = JSON.parse(cfg.attribute.formAttr).controlAction.global.onLoad[0];
    for (const helper of ["", "rcyy", "unrelated"]) {
      const calls = [];
      const api = {viewStatus: "add", getValue: () => helper, setValue() {}, setFieldAttr: (id, attr) => calls.push([id, attr])};
      vm.runInNewContext(load.function + `;${load.name}({});`, {MKXFORM: api}, {timeout: 1000});
      assert.equal(calls.some(([id, attr]) => id === detailId && [4, 5].includes(attr)), false);
    }
    const result = p.verify(p.update);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  });
  it("retains script visibility when the native bridge lacks its complementary branch", () => {
    const sourceScript = source.scripts.sources.find(s => s.id === "fd_37b0de6f06003a.script.2");
    const incomplete = structuredClone(draft.formRules);
    incomplete.linkage.find(r => r.id === "linkage.bxlx.contains.rcyy.load").else = [];
    const candidates = inlineRadioRowEffectCandidates(sourceScript, draft.form, incomplete);
    const candidate = candidates.find(a => a.function.includes('getValue("fd_rcyy")'));
    assert.ok(candidate);
    assert.match(candidate.function, /setFieldAttr\("rcyy_row", 4\)/);
    assert.match(candidate.function, /setFieldAttr\("rcyy_row", 5\)/);
  });
});
