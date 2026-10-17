import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { legacyDetailAggregateEffectCandidates } from "../../src/translator/legacy-detail-aggregate-effects.js";

const fixture = "tests/fixtures/route-validation/legacy-detail-aggregate-effects/route-legacy-detail-aggregate-effects_SysFormTemplate.xml";
function stages() {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  const eventSource = source.scripts.sources.find(item => item.javascript.includes("AttachXFormValueChangeEventById"));
  return { source, draft, eventSource };
}
function candidates(source, draft, eventSource) {
  return legacyDetailAggregateEffectCandidates(eventSource, draft.form, source.scripts);
}

describe("source-proven numeric row and existential aggregate effects", () => {
  it("compiles only the three callbacks by structure with exact helper evidence", () => {
    const { source, draft, eventSource } = stages();
    const actions = candidates(source, draft, eventSource);
    assert.deepEqual(actions.map(action => action.controlId), ["fd_external", "fd_internal", "fd_place"]);
    assert.ok(actions.every(action => action.translationStatus === "mapped" && action.sourceActionKey));
    assert.ok(actions.every(action => action.semanticHints.coveredCalculationRanges.length >= 3));
    assert.ok(actions.every(action => !action.function.includes("GetXForm") && !action.function.includes("DocList")));
    assert.ok(actions.every(action => action.event === "onChange"));
  });

  it("preserves Number, addition order, Math.round precision, clamp branch and row scope", () => {
    const { source, draft, eventSource } = stages();
    const actions = candidates(source, draft, eventSource);
    const pairs = [["", ""], ["0", "0"], ["", "5"], ["-3", "2"], ["2", "-1"],
      ["0.1", "0.2"], ["1.005", "0"], ["1.115", "0"], ["-0.004", "0"], ["abc", "2"],
      [undefined, "2"], [null, 0], [1.005, 0], ["1234567.125", "0.25"]];
    for (const controlId of ["fd_external", "fd_internal"]) {
      const action = actions.find(item => item.controlId === controlId);
      for (const [external, internal] of pairs) {
        const state = [{ fd_external: "untouched", fd_internal: "untouched" }, { fd_external: external, fd_internal: internal }];
        assert.deepEqual(observeSource(source, state, controlId, 1), observeTarget(action, state, 1));
      }
    }
    const changed = structuredClone(source);
    changed.scripts.sources[0].javascript = changed.scripts.sources[0].javascript.replace("var precision = 2", "var precision = 3");
    const revised = candidates(changed, draft, changed.scripts.sources[1])[0];
    assert.ok(revised);
    assert.deepEqual(observeSource(changed, [{ fd_external: "1.2345", fd_internal: "0" }], "fd_external", 0), observeTarget(revised, [{ fd_external: "1.2345", fd_internal: "0" }], 0));
  });

  it("reads the current live rows including zero values, empty tables, insertions and deletions", () => {
    const { source, draft, eventSource } = stages();
    const action = candidates(source, draft, eventSource).find(item => item.controlId === "fd_place");
    for (const values of [[], ["2"], ["0"], ["1"], [0], [1], [""], [null], [undefined], ["x", "1"], [2, 2], [true]]) {
      const rows = values.map(value => ({ fd_place: value }));
      assert.deepEqual(observeSource(source, rows, "fd_place", 0), observeTarget(action, rows, 0));
      assert.deepEqual(observeSource(source, rows, "fd_place", 0), observeTarget(action, rows, 0, true));
    }
    const sourceState = makeSourceRuntime(source, []), targetState = makeTargetRuntime(action, []);
    const results = [];
    for (const values of [[], [2], [2, 1], [2], [], [0]]) {
      sourceState.rows = values.map(value => ({ fd_place: value }));
      targetState.rows = structuredClone(sourceState.rows);
      sourceState.run("fd_place", 0); targetState.run(0);
      assert.deepEqual(sourceState.writes.at(-1), targetState.writes.at(-1));
      results.push(targetState.writes.at(-1).value);
    }
    assert.deepEqual(results, ["0", "0", "1", "0", "0", "1"]);
  });

  for (const [label, edit, expected] of [
    ["extra numeric side effect", (s, event) => { event.javascript = event.javascript.replace("var cusNum =", 'unknownSideEffect(); var cusNum ='); }, ["fd_place"]],
    ["unproven rounding", s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replace("Math.round", "Math.ceil"); }, ["fd_place"]],
    ["non-finite power", s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replace("var precision = 2", "var precision = 309"); }, ["fd_place"]],
    ["shadowed numeric API", (s, event) => { event.javascript = "var Number=customNumber;\n" + event.javascript; }, ["fd_place"]],
    ["mutated Math method", (s, event) => { event.javascript = "Math.round=customRound;\n" + event.javascript; }, ["fd_place"]],
    ["reused numeric variable", (s, event) => { event.javascript = event.javascript.replaceAll("comNum", "cusNum"); }, ["fd_place"]],
    ["extra numeric branch write", (s, event) => { event.javascript = event.javascript.replace("tempObj.value = sumNum;", "tempObj.value = sumNum + 1;"); }, ["fd_place"]],
    ["callback helper shadow", (s, event) => { event.javascript = event.javascript.replace("function(value, domElement)", "function(computeLineAmount, domElement)"); }, ["fd_internal", "fd_place"]],
    ["changed row getter", s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replace("rowFieldValue ? rowFieldValue : ''", "rowFieldValue ? rowFieldValue : 'changed'"); }, ["fd_external", "fd_internal"]],
    ["missing row dependency", s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replace("function fieldAddress(", "function missingFieldAddress("); }, ["fd_external", "fd_internal"]],
    ["different row predicate", (s, event) => { event.javascript = event.javascript.replace("|| trafficRow[fieldId]", "&& trafficRow[fieldId]"); }, ["fd_external", "fd_internal"]],
    ["extra aggregate side effect", (s, event) => { event.javascript = event.javascript.replace("var isFoodAdd =", "unknownSideEffect(); var isFoodAdd ="); }, ["fd_external", "fd_internal"]],
    ["wrong row source context", (s, event) => { event.javascript = event.javascript.replaceAll("computeLineAmount(domElement)", "computeLineAmount(value)"); }, ["fd_place"]],
    ["cross-source helper redefinition", s => { s.scripts.sources.push({ id: "second", sourceRef: "second", javascript: "function roundAmount(value){return value;}" }); }, ["fd_place"]]
  ]) {
    it("rejects " + label + " while preserving independent proven callbacks", () => {
      const { source, draft } = stages(), changed = structuredClone(source), event = changed.scripts.sources[1];
      edit(changed, event);
      assert.deepEqual(candidates(changed, draft, event).map(action => action.controlId), expected);
    });
  }

  it("rejects ambiguous tables, unsupported cell types and invented target fields", () => {
    const { source, draft, eventSource } = stages();
    for (const change of [
      form => { form.fields.push({ ...structuredClone(form.fields.find(field => field.type === "detailTable")), id: "fd_duplicate" }); },
      form => { form.fields.find(field => field.type === "detailTable").columns.find(field => field.id === "fd_place").type = "checkbox"; },
      form => { form.fields = form.fields.filter(field => field.id !== "fd_has_place"); }
    ]) {
      const form = structuredClone(draft.form); change(form);
      const actions = legacyDetailAggregateEffectCandidates(eventSource, form, source.scripts);
      assert.equal(actions.some(action => action.controlId === "fd_place"), false);
    }
  });

  it("does not absorb an unrelated shared-state callback", () => {
    const { source, draft } = stages(), changed = structuredClone(source), event = changed.scripts.sources[1];
    event.javascript += '\nAttachXFormValueChangeEventById("fd_place",function(value,domElement){sharedState.place=value;});';
    assert.equal(candidates(changed, draft, event).length, 3);
    assert.ok(candidates(changed, draft, event).every(action => !action.function.includes("sharedState")));
    const nextDraft = draftSourceDraft(changed);
    assert.equal(nextDraft.scripts.actions.filter(action => action.translationStatus === "mapped").length, 3);
    assert.ok(nextDraft.scripts.actions.some(action => action.translationStatus === "needs_review" && action.sourceActionKey?.endsWith("@" + event.javascript.lastIndexOf("AttachXFormValueChangeEventById"))));
  });
});

function observeSource(source, rows, controlId, rowIndex) {
  const state = makeSourceRuntime(source, rows); state.run(controlId, rowIndex);
  return { reads: state.reads, writes: state.writes };
}
function observeTarget(action, rows, rowIndex, valuesEnvelope = false) {
  const state = makeTargetRuntime(action, rows, valuesEnvelope); state.run(rowIndex);
  return { reads: state.reads, writes: state.writes };
}
function domValue(value) {
  const scalar = Array.isArray(value) ? value[0] : value;
  return scalar === undefined || scalar === null ? "" : String(scalar);
}
function makeSourceRuntime(source, rows) {
  const state = { rows: structuredClone(rows), reads: [], writes: [], callbacks: new Map() };
  const tables = {};
  const read = (field, index) => {
    const value = domValue(state.rows[index]?.[field]); state.reads.push({ field, index, value }); return value;
  };
  const context = vm.createContext({
    AttachXFormValueChangeEventById(id, fn) { state.callbacks.set(id, fn); },
    GetXFormSameRowFieldById(dom, field) { return [{
      get value() { return read(field, dom.index); },
      set value(value) { state.writes.push({ field, index: dom.index, value }); state.rows[dom.index][field] = value; }
    }]; },
    SetXFormFieldValueById(field, value) { state.writes.push({ field, value }); },
    GetXFormFieldValueById() { throw new Error("Fallback value branch is not part of the table getter"); },
    DocList_TableInfo: tables,
    $(selector) {
      const id = selector.match(/extendDataFormInfo\.value\(([^)]+)\)/)?.[1];
      const parts = id?.split(".") || [], index = Number(parts[1]), field = parts[2];
      if (parts[0] !== "fd_lines" || !field) throw new Error("Unsupported fixture selector " + selector);
      const isChecked = selector.includes(":checked");
      return { length: 1, 0: { type: field === "fd_place" ? "radio" : "text", tagName: "INPUT" },
        val() { if (field === "fd_place" && !isChecked) throw new Error("Radio reads must use the checked branch"); return read(field, index); } };
    }
  });
  for (const script of source.scripts.sources) vm.runInContext(script.javascript, context, { timeout: 1000 });
  state.run = (id, index) => {
    tables.TABLE_DL_fd_lines = { lastIndex: state.rows.length + 1 };
    state.callbacks.get(id)(undefined, { index });
  };
  return state;
}
function makeTargetRuntime(action, rows, valuesEnvelope = false) {
  const state = { rows: structuredClone(rows), reads: [], writes: [] };
  const prefix = "$" + "{table:fd_lines}";
  const api = {
    getValue(id, options) {
      if (id === prefix) {
        state.rows.forEach((row, index) => state.reads.push({ field: "fd_place", index, value: domValue(row.fd_place) }));
        return valuesEnvelope ? { values: state.rows } : state.rows;
      }
      const field = id.slice(prefix.length + 1), index = options.detailRowIndex;
      state.reads.push({ field, index, value: domValue(state.rows[index]?.[field]) }); return state.rows[index]?.[field];
    },
    updateControl(id, index, value) { const field = id.slice(prefix.length + 1); state.writes.push({ field, index, value }); state.rows[index][field] = value; },
    setValue(field, value) { state.writes.push({ field, value }); }
  };
  const run = new Function("MKXFORM", action.function + "; return onChange;")(api);
  state.run = index => run(undefined, index);
  return state;
}


it("passes the public source-to-trust and fake executor route with all three proven callbacks", async () => {
  const { runAgentReview } = await import("../../src/agent-review/index.js");
  const { createFakeReviewProvider } = await import("./fake-review-provider.js");
  const { FakeNewoaAdapter } = await import("./fake-newoa-adapter.js");
  const { executeDsl } = await import("../../src/executor/execute.js");
  const { buildDryRunPlan } = await import("../../src/executor/dry-run.js");
  const { withNetworkGuard } = await import("./network-guard.js");
  await withNetworkGuard(async () => {
    const { source, draft } = stages();
    const mapped = draft.scripts.actions.filter(action => action.translationStatus === "mapped");
    assert.equal(mapped.length, 3);
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
