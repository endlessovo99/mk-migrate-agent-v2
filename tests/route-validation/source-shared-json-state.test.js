import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sharedJsonStateCandidates, inspectSharedJsonStateModel } from "../../src/translator/source-shared-json-state.js";
import { sharedJsonStateSourceDomain } from "../../src/translator/source-shared-json-state-domain.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { analyzeScriptFunction } from "../../src/dsl/scripts.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { executeDsl } from "../../src/executor/execute.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { withNetworkGuard } from "./network-guard.js";

const fixture = "tests/fixtures/route-validation/source-shared-json-state/route-source-shared-json-state_SysFormTemplate.xml";
const native = JSON.parse(fs.readFileSync("tests/fixtures/route-validation/source-shared-json-state/native-runtime-state.json", "utf8"));
const stages = (file = fixture) => { const source = cleanSourceFile(file), draft = draftSourceDraft(source); return { source, draft }; };
const candidates = (source, form) => source.scripts.sources.flatMap(script => sharedJsonStateCandidates(script, form, source.scripts));

describe("source-bound shared JSON state", () => {
  it("proves a source-defined initialization/change/serialization cluster without GLOBALJS", () => {
    const { source, draft } = stages(), actions = candidates(source, draft.form), model = inspectSharedJsonStateModel(draft.form, source.scripts);
    assert.deepEqual(actions.map(action => action.event), ["onChange", "onLoad", "onBeforeSubmit"]);
    assert.equal(model.initializer.residuals.length, 0);
    for (const action of actions) {
      assert.equal(action.translationStatus, "mapped");
      assert.match(action.function, /MKXFORM\.MKXFORM_DATA_CONTAINER/);
      assert.doesNotMatch(action.function, /GLOBALJS|window\.|globalThis/);
      assert.ok(action.semanticHints.coveredCalculationRanges.length >= 2);
      assert.equal(action.semanticHints.sourceSharedJsonState.sourceDisplayGate, action.source.displayGate);
      const analysis = analyzeScriptFunction(action.function);
      for (const key of ["unsupportedSyntax", "disallowedCalls", "disallowedTargetCalls", "domUsages"]) assert.deepEqual(analysis[key], [], key);
    }
    assert.match(actions[1].function, /Number\(/, "the source read/Number operation must remain even when both branches are empty");
  });

  it("preserves JSON primitives, null and parse/coercion exceptions through repeated load/change/submit", () => {
    const { source, draft } = stages(), actions = candidates(source, draft.form);
    for (const json of ['{}', '{"category":"A","extra":5}', '{"item0_flag":1}', '{"item1_flag":"1"}', '{"item0_flag":{"valueOf":0,"toString":0}}', 'null', '0', 'false', '"hello"', '[]', '', 'not json', '{"__proto__":{"x":1}}']) {
      for (const value of ["A", "", ["A", "B"], null, undefined, 0, false, { selected: "A" }]) {
        const old = sourceRuntime(source, json), target = targetRuntime(actions, json);
        for (const step of [["load"], ["change", value], ["submit"], ["load"], ["submit"]]) {
          assert.deepEqual(target.step(...step), old.step(...step), JSON.stringify({ json, step }));
          assert.deepEqual(target.snapshot(), old.snapshot());
        }
      }
    }
  });

  it("keeps two simultaneously mounted forms isolated when a foreign global MKXFORM is replaced", () => {
    const { source, draft } = stages(), actions = candidates(source, draft.form);
    const left = targetRuntime(actions, '{"owner":"left"}'), right = targetRuntime(actions, '{"owner":"right"}');
    left.step("load"); right.step("load");
    left.context.MKXFORM = right.api;
    right.context.MKXFORM = left.api;
    left.step("change", ["A"]); right.step("change", ["B"]);
    left.step("submit"); right.step("submit");
    assert.equal(left.value(), '{"owner":"left","category":["A"]}');
    assert.equal(right.value(), '{"owner":"right","category":["B"]}');
    assert.notEqual(left.api.MKXFORM_DATA_CONTAINER, right.api.MKXFORM_DATA_CONTAINER);
    assert.equal(left.api.GLOBALJS, undefined); assert.equal(right.api.GLOBALJS, undefined);
  });

  it("retains the standard before-submit draft guard before accessing any shared state", () => {
    const { source, draft } = stages(), action = candidates(source, draft.form).find(action => action.event === "onBeforeSubmit");
    const result = new Function("MKXFORM", "return (" + action.function + ");")({})( { isDraft: true });
    assert.equal(result, true);
  });

  it("preserves change-before-load, repeated load overwrite, and submit-before-load", () => {
    const { source, draft } = stages(), actions = candidates(source, draft.form);
    for (const steps of [
      [["change", "A"], ["load"], ["submit"]],
      [["submit"], ["load"], ["change", "A"], ["load"], ["submit"]],
      [["change", ["A", "B"]], ["submit"], ["load"], ["submit"]]
    ]) {
      const old = sourceRuntime(source, '{"original":1}'), target = targetRuntime(actions, '{"original":1}');
      for (const step of steps) { assert.deepEqual(target.step(...step), old.step(...step)); assert.deepEqual(target.snapshot(), old.snapshot()); }
    }
  });

  it("renames field, object, property, helper, parameter, loop and local names by the same structural proof", () => {
    const { source, draft } = stages(), changed = structuredClone(source), form = structuredClone(draft.form);
    const names = { sharedDocument: "unrelatedState", loadDocument: "restoreCache", readFlag: "observeData", maximumItems: "limit", changed: "newPayload", elements: "sourceInputs", item: "rowIndex", key: "slot", category: "otherProperty", fd_json: "other_hidden", fd_choice: "other_choice" };
    for (const entry of changed.scripts.sources) for (const [from, to] of Object.entries(names)) entry.javascript = entry.javascript.replace(new RegExp("\\b" + from + "\\b", "g"), to);
    for (const field of form.fields) if (names[field.id]) { const id = names[field.id]; field.id = id; field.sourceProps.designerId = id; field.sourceProps.metadataId = id; field.sourceProps.metadataAttributes.name = id; field.sourceProps.designerValues.id = id; }
    const actions = candidates(changed, form);
    assert.equal(actions.length, 3);
    assert.ok(actions.every(action => action.semanticHints.sourceSharedJsonState.stateName === "unrelatedState"));
    assert.match(actions[0].function, /\.otherProperty = value/);
  });

  for (const [name, edit] of [
    ["state alias escape", s => { s.scripts.sources[1].javascript += "\nvar escaped=sharedDocument;"; }],
    ["state passed to unknown effect", s => { s.scripts.sources[1].javascript += "\nunknown(sharedDocument);"; }],
    ["state updated outside proven callbacks", s => { s.scripts.sources[1].javascript += "\nsharedDocument.other=1;"; }],
    ["state redefined in another script", s => { s.scripts.sources[1].javascript += "\nvar sharedDocument={};"; }],
    ["dynamic eval mutation", s => { s.scripts.sources[1].javascript += '\neval("sharedDocument.category=1");'; }],
    ["escaped evaluator mutation", s => { s.scripts.sources[1].javascript += '\nvar evaluate=eval;evaluate("sharedDocument.category=1");'; }],
    ["constructor evaluator mutation", s => { s.scripts.sources[1].javascript += '\nloadDocument.constructor("sharedDocument.category=1")();'; }],
    ["dynamic Function mutation", s => { s.scripts.sources[1].javascript += '\nFunction("sharedDocument.category=1")();'; }],
    ["global Object assignment", s => { s.scripts.sources[1].javascript += '\nObject.assign(window,{sharedDocument:{}});'; }],
    ["JSON parser mutation", s => { s.scripts.sources[0].javascript += "\nJSON.parse=custom;"; }],
    ["JSON identifier shadow", s => { s.scripts.sources[0].javascript = "var JSON=custom;\n" + s.scripts.sources[0].javascript; }],
    ["reader writes to state", s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replace("var key =", "sharedDocument.other=1; var key ="); }],
    ["callback parameter shadows state", s => { s.scripts.sources[1].javascript = s.scripts.sources[1].javascript.replace("function(changed,element)", "function(changed,sharedDocument)"); }],
    ["nonliteral state property", s => { s.scripts.sources[1].javascript = s.scripts.sources[1].javascript.replace("sharedDocument.category", "sharedDocument[element]"); }],
    ["prototype property update", s => { s.scripts.sources[1].javascript = s.scripts.sources[1].javascript.replace("sharedDocument.category", "sharedDocument.__proto__"); }],
    ["serialization writes another field", s => { s.scripts.sources[1].javascript = s.scripts.sources[1].javascript.replace('SetXFormFieldValueById("fd_json"', 'SetXFormFieldValueById("different"'); }]
  ]) it("rejects " + name, () => {
    const { source, draft } = stages(), changed = structuredClone(source); edit(changed);
    assert.equal(candidates(changed, draft.form).length, 0);
  });

  it("keeps unknown initializer effects and duplicate/modified readers pending without discarding independently closed changes", () => {
    for (const edit of [
      s => { s.scripts.sources[0].javascript += "\nfunction readFlag(x){unknown(x);}"; },
      s => { s.scripts.sources[0].javascript = s.scripts.sources[0].javascript.replace("readFlag(item); }", "readFlag(item); } unknownEffect();"); }
    ]) {
      const { source, draft } = stages(), changed = structuredClone(source); edit(changed);
      const actions = candidates(changed, draft.form);
      assert.deepEqual(actions.map(action => action.event), ["onChange", "onBeforeSubmit"]);
      assert.equal(inspectSharedJsonStateModel(draft.form, changed.scripts).initializer.residuals.length > 0, true);
    }
  });

  it("rejects missing, ambiguous, data-only and non-String hidden storage", () => {
    const { source, draft } = stages();
    for (const modify of [
      f => { f.fields = f.fields.filter(field => field.id !== "fd_json"); },
      f => { f.fields.push(structuredClone(f.fields.find(field => field.id === "fd_json"))); },
      f => { f.fields.find(field => field.id === "fd_json").dataOnly = true; },
      f => { f.fields.find(field => field.id === "fd_json").sourceProps.metadataAttributes.type = "Number"; }
    ]) { const form = structuredClone(draft.form); modify(form); assert.equal(candidates(source, form).length, 0); }
  });

  it("does not create shared state for an inactive gated source declaration", () => {
    const { source, draft } = stages();
    source.scripts.sources[0].displayGate = "xform:editShow";
    assert.equal(candidates(source, draft.form).length, 0);
  });

  it("keeps an escaped-state source out of the executor with zero fake writes", async () => {
    await withNetworkGuard(async () => {
      const { source } = stages(); source.scripts.sources[1].javascript += "\nvar escaped=sharedDocument;";
      const draft = draftSourceDraft(source), reviewed = await runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") });
      assert.equal(reviewed.ok, false);
      const client = new FakeNewoaAdapter("persist"), result = await executeDsl(draft, { client, confirmWrite: true,
        targetCategoryId: "route-category-id", credentials: { username: "fixture", encryptedPassword: "fixture-password" } });
      assert.equal(result.ok, false); assert.deepEqual(client.transcript(), []);
    });
  });

  it("resolves duplicate helpers by raw Display order and unconditional final binding, never source-array order or arity", () => {
    const file = fixture.replace("state_SysFormTemplate", "shadow_SysFormTemplate"), source = cleanSourceFile(file), draft = draftSourceDraft(source);
    const template = parseRootHashMapStringPuts(fs.readFileSync(file, "utf8")), domain = sharedJsonStateSourceDomain(template, source.scripts.sources);
    assert.ok(domain);
    source.scripts.sources[0].semanticFacts ||= {}; source.scripts.sources[0].semanticFacts.sharedJsonStateSourceDomain = domain;
    for (const sources of [source.scripts.sources, [...source.scripts.sources].reverse()]) {
      const scripts = { ...source.scripts, sources }, actions = sources.flatMap(entry => sharedJsonStateCandidates(entry, draft.form, scripts));
      assert.equal(actions.length, 3);
      assert.match(actions.find(action => action.event === "onLoad").function, /Number\(/);
      assert.doesNotMatch(actions.find(action => action.event === "onLoad").function, /SetXFormFieldValueById/);
    }
    const missing = structuredClone(source); delete missing.scripts.sources[0].semanticFacts.sharedJsonStateSourceDomain;
    assert.equal(candidates(missing, draft.form).some(action => action.event === "onLoad"), false);
  });

  it("does not use a stale/gate-mismatched order proof or a final conditional helper", () => {
    const file = fixture.replace("state_SysFormTemplate", "shadow_SysFormTemplate"), original = cleanSourceFile(file), draft = draftSourceDraft(original), template = parseRootHashMapStringPuts(fs.readFileSync(file, "utf8"));
    for (const mutate of [
      s => { s.scripts.sources[1].javascript += "\n;"; },
      s => { s.scripts.sources[1].displayGate = "xform:editShow"; }
    ]) {
      const source = structuredClone(original), domain = sharedJsonStateSourceDomain(template, source.scripts.sources);
      source.scripts.sources[0].semanticFacts ||= {}; source.scripts.sources[0].semanticFacts.sharedJsonStateSourceDomain = domain;
      mutate(source);
      assert.equal(candidates(source, draft.form).some(action => action.event === "onLoad"), false);
    }
    const conditionalTemplate = { ...template, fdDisplayJsp: template.fdDisplayJsp.replace('<script>var sharedDocument', '<xform:viewShow><script>var sharedDocument').replace('}</script><xform:editShow>', '}</script></xform:viewShow><xform:editShow>') };
    assert.equal(sharedJsonStateSourceDomain(conditionalTemplate, original.scripts.sources), undefined);
  });

  it("rejects external or dynamically evaluated Display definitions in raw order evidence", () => {
    const { source } = stages(), template = parseRootHashMapStringPuts(fs.readFileSync(fixture, "utf8"));
    for (const extra of ['<script src="external.js"></script>', '<script>eval("change()");</script>', '<script>Com_IncludeFile("unknown.js");</script>', '<script>readFlag=function(){};</script>', '<script>window["readFlag"]=function(){};</script>', '<script>window[chosenName]=function(){};</script>']) {
      assert.equal(sharedJsonStateSourceDomain({ ...template, fdDisplayJsp: template.fdDisplayJsp + extra }, source.scripts.sources), undefined);
    }
  });

  it("passes source/check/trust/dry-run/fake execute/readback/record with no network", async () => {
    await withNetworkGuard(async () => {
      for (const file of [fixture, fixture.replace("state_SysFormTemplate", "shadow_SysFormTemplate"), fixture.replace("state_SysFormTemplate", "injected_SysFormTemplate")]) {
        const { source, draft } = stages(file);
        if (file.includes("injected")) assert.ok(source.scripts.sources.some(source => source.helperJavascript?.length > 0));
        assert.equal(draft.scripts.actions.filter(action => action.translationStatus === "mapped").length, 3);
        const reviewed = await runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") });
        assert.equal(reviewed.ok, true, JSON.stringify(reviewed.report?.diagnostics));
        assert.equal(buildDryRunPlan(reviewed.dsl).ok, true);
        const client = new FakeNewoaAdapter("persist"), result = await executeDsl(reviewed.dsl, {
          client, confirmWrite: true, targetCategoryId: "route-category-id", credentials: { username: "fixture", encryptedPassword: "fixture-password" },
          now: new Date("2026-10-17T00:00:00.000Z"), transferRecordIdFactory: () => "route0000000000000000000000000000000"
        });
        assert.equal(result.ok, true, JSON.stringify(result.diagnostics)); assert.equal(result.readback.ok, true);
        assert.equal(client.transcript().at(-1).operation, "add-transfer-record");
      }
    });
  });
});

function sourceRuntime(source, initial) {
  let json = initial; const trace = [], callbacks = {}, context = vm.createContext({
    window: {}, Com_AddEventListener(_window, _event, fn) { callbacks.load = fn; }, AttachXFormValueChangeEventById(_id, fn) { callbacks.change = fn; },
    Com_Parameter: { event: { submit: { push(fn) { callbacks.submit = fn; } } } },
    GetXFormFieldById(id) { return [{ get value() { trace.push(["read", id, json]); return json; } }]; },
    SetXFormFieldValueById(id, value) { json = value; trace.push(["write", id, value]); }
  });
  for (const entry of source.scripts.sources) vm.runInContext(entry.javascript, context);
  return { step(event, value) { try { return { result: callbacks[event](value) }; } catch (error) { return { error: error.name }; } },
    snapshot() { return { json, trace: structuredClone(trace) }; } };
}
function targetRuntime(actions, initial) {
  const dependencies = ["mk", "A", "v", "a", "c", "r", "i", "u", "o", "d", "y"];
  const initialize = new Function(...dependencies, "return (" + native.initRuntime.text + ");")({ getSysConfig() { return "desktop"; } }, { register() {} }, ...Array.from({ length: 9 }, () => ({ default: {} })));
  let json = initial; const trace = [], callbacks = {}, api = Object.assign(initialize({ formId: "fixture-instance" }), {
    getValue(id) { trace.push(["read", id, json]); return json; }, setValue(id, value) { json = value; trace.push(["write", id, value]); } });
  const context = vm.createContext({ MKXFORM: api });
  const parseActions = vm.runInContext("(" + native.parseActionFun.text + ")", context);
  for (const action of actions) callbacks[{ onChange: "change", onLoad: "load", onBeforeSubmit: "submit" }[action.event]] = parseActions({ [action.event]: [{ name: action.id, function: action.function }] }, api)[action.event][0].function;
  return { api, context, value: () => json,
    step(event, value) { try { return { result: callbacks[event](event === "submit" ? { isDraft: false } : value) }; } catch (error) { return { error: error.name }; } },
    snapshot() { return { json, trace: structuredClone(trace) }; } };
}
