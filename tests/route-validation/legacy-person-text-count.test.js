import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { legacyPersonTextCountCandidates } from "../../src/translator/legacy-detail-aggregate-effects.js";

const fixture = "tests/fixtures/route-validation/legacy-detail-aggregate-effects/route-person-text-count_SysFormTemplate.xml";
function stages() {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  return { source, draft, event: source.scripts.sources[1] };
}
function mapped(source, draft, event = source.scripts.sources[1]) {
  return legacyPersonTextCountCandidates(event, draft.form, source.scripts);
}

describe("source-proven delimited main text count", () => {
  it("preserves all literal regex replacements and non-empty segment counting", () => {
    const { source, draft } = stages(), [action] = mapped(source, draft);
    assert.ok(action);
    for (const value of ["", "甲", "甲，乙", "甲,乙", "甲/乙", "甲\\乙", "甲\n乙", "甲、乙", "、、甲、、、、乙、、、",
      " ", " 甲 、 乙 ", "甲;乙", "\r", "甲\r\n乙", "🙂、乙", ",，/\\\n、"]) {
      assert.deepEqual(observeSource(source, value), observeTarget(action, value), JSON.stringify(value));
    }
    for (const value of [undefined, null, 2, ["甲", "乙"]]) {
      assert.throws(() => observeSource(source, value));
      assert.throws(() => observeTarget(action, value));
    }
  });

  it("accepts arbitrary helper, parameter and local names", () => {
    const { source, draft } = stages(), renamed = structuredClone(source);
    for (const script of renamed.scripts.sources) {
      for (const [before, after] of [["countSeparatedNames", "customCounter"], ["updatePeopleCount", "applyTotal"],
        ["paramsStrArr", "message"], ["fdNameArr", "parts"], ["relCount", "total"], ["elementId", "destination"], ["index", "cursor"]]) {
        script.javascript = script.javascript.replaceAll(before, after);
      }
    }
    const [action] = mapped(renamed, draft);
    assert.ok(action);
    assert.deepEqual(observeSource(renamed, "甲，乙/丙\\丁"), observeTarget(action, "甲，乙/丙\\丁"));
  });

  for (const [label, edit] of [
    ["changed regex flag", s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replace("/，/g", "/，/i"); }],
    ["changed replacement sequence", s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replace('.replace(/,/g, "、")', '.replace(/,/g, ";")'); }],
    ["extra helper effect", s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replace("var relCount = 0", "unknownSideEffect(); var relCount = 0"); }],
    ["count mutation", s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replace("return relCount;", "return relCount + 1;"); }],
    ["missing dependency", s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replace("function countSeparatedNames(", "function unavailableCounter("); }],
    ["cross-source definitions", s => { s.scripts.sources.push({ id: "second", sourceRef: "second", javascript: "function countSeparatedNames(value){return 1;}" }); }],
    ["external helper replacement", s => { s.scripts.sources[1].javascript += "\ncountSeparatedNames = otherCounter;"; }],
    ["shadowed callback helper", s => { s.scripts.sources[1].javascript = s.scripts.sources[1].javascript.replace("function(value, domElement)", "function(updatePeopleCount, domElement)"); }],
    ["overridden target API", s => { s.scripts.sources[0].javascript += "\nSetXFormFieldValueById = replacement;"; }],
    ["RegExp shadow", s => { s.scripts.sources[0].javascript = "var RegExp = replacement;\n" + s.scripts.sources[0].javascript; }],
    ["RegExp prototype mutation", s => { s.scripts.sources[0].javascript += "\nRegExp.prototype.test = replacement;"; }],
    ["String method mutation", s => { s.scripts.sources[0].javascript += "\nString.prototype.split = replacement;"; }],
    ["last conflicting declaration", s => { s.scripts.sources[0].javascript += "\nfunction countSeparatedNames(value){return 42;}"; }]
  ]) {
    it("rejects " + label, () => {
      const { source, draft } = stages(), changed = structuredClone(source); edit(changed);
      assert.deepEqual(mapped(changed, draft), []);
    });
  }

  it("uses the last same-script function declaration without treating a superseded body as executed", () => {
    const { source, draft } = stages(), changed = structuredClone(source);
    changed.scripts.sources[0].javascript = "function countSeparatedNames(value){return 42;}\n" + changed.scripts.sources[0].javascript;
    const [action] = mapped(changed, draft);
    assert.ok(action);
    assert.deepEqual(observeSource(changed, "甲、乙"), observeTarget(action, "甲、乙"));
  });

  it("rejects non-text triggers, non-number destinations and detail-only fields", () => {
    const { source, draft } = stages();
    for (const edit of [
      form => { form.fields.find(field => field.id === "fd_people_text").type = "radio"; },
      form => { form.fields.find(field => field.id === "fd_people_count").type = "text"; },
      form => { form.fields.find(field => field.id === "fd_people_count").props.calculation = { kind: "formula", expression: "1" }; },
      form => { const count = form.fields.find(field => field.id === "fd_people_count"); form.fields = form.fields.filter(field => field !== count);
        form.fields.push({ id: "fd_lines", type: "detailTable", columns: [count] }); }
    ]) {
      const changed = structuredClone(draft); edit(changed.form);
      assert.deepEqual(mapped(source, changed), []);
    }
  });

  it("completes review, trust, dry-run, fake write, readback and transfer receipt", async () => {
    const { runAgentReview } = await import("../../src/agent-review/index.js");
    const { createFakeReviewProvider } = await import("./fake-review-provider.js");
    const { FakeNewoaAdapter } = await import("./fake-newoa-adapter.js");
    const { executeDsl } = await import("../../src/executor/execute.js");
    const { buildDryRunPlan } = await import("../../src/executor/dry-run.js");
    const { withNetworkGuard } = await import("./network-guard.js");
    await withNetworkGuard(async () => {
      const { source, draft } = stages();
      assert.equal(draft.scripts.actions.filter(action => action.translationStatus === "mapped").length, 1);
      const reviewed = await runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") });
      assert.equal(reviewed.ok, true, JSON.stringify(reviewed.report?.diagnostics));
      assert.equal(buildDryRunPlan(reviewed.dsl).ok, true);
      const client = new FakeNewoaAdapter("persist");
      const result = await executeDsl(reviewed.dsl, { client, confirmWrite: true, targetCategoryId: "route-category-id",
        credentials: { username: "fixture", encryptedPassword: "fixture-password" }, now: new Date("2026-10-17T00:00:00.000Z"),
        transferRecordIdFactory: () => "route0000000000000000000000000000000" });
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(result.readback.ok, true);
      assert.equal(client.transcript().at(-1).operation, "add-transfer-record");
    });
  });
});

function observeSource(source, value) {
  const writes = [];
  let callback;
  const context = vm.createContext({
    AttachXFormValueChangeEventById(_id, fn) { callback = fn; },
    SetXFormFieldValueById(field, value) { writes.push({ field, value }); }
  });
  for (const script of source.scripts.sources) vm.runInContext(script.javascript, context, { timeout: 1000 });
  callback(value, {});
  return writes;
}
function observeTarget(action, value) {
  const writes = [];
  new Function("MKXFORM", action.function + "; return onChange;")({ setValue(field, value) { writes.push({ field, value }); } })(value);
  return writes;
}
