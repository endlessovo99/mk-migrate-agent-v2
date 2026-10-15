import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { validateRowMarkerBranchSemantics } from "../../src/agent-review/script-semantic-closure.js";
import { legacySourceFromGeneratedFunction } from "../../src/agent-review/row-marker-policy.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { checkExecute } from "../../src/dsl/checks.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/timed-initialization/timed-initialization_SysFormTemplate.xml";
const functions = JSON.parse(readFileSync(new URL("../fixtures/route-validation/timed-initialization/reviewed-functions.json", import.meta.url), "utf8"));
const markers = ["fd_a_row", "fd_b_row", "fd_c_row", "fd_d_row", "fd_or_row"];
const source = cleanSourceFile(fixture);
const targetForm = draftSourceDraft(source).form;
const originals = source.scripts.sources.map(script => script.javascript);

function wrappedSource(text) {
  return `function onLoad() {\n// Source JSP JavaScript:\n${text.split("\n").map(line => `// ${line}`).join("\n")}\n}`;
}

function prove(original, target, fieldEvidence = {}) {
  return validateRowMarkerBranchSemantics({
    sourceFunction: wrappedSource(original), reviewedFunction: target,
    resolvedMarkers: markers, primaryMarkerByAlias: new Map(),
    sourceControls: source.form.controls, targetFields: targetForm.fields, ...fieldEvidence
  });
}

function review(draft, changes = functions, sourceDraft = source) {
  const patches = draft.scripts.actions.flatMap((action, index) => {
    const values = { function: changes[index === 0 ? "atomic" : "or"], translationStatus: "mapped",
      coverage: { status: "translated", nativeRules: [], residuals: [] },
      functionMappings: [{ source: "original static timer and ordered row initialization", target: "same setTimeout with MKXFORM", basis: "semantic-translation", reviewRequired: false }] };
    return Object.entries(values).map(([key, value]) => ({
      op: "replace", path: `/scripts/actions/${index}/${key}`, value, sourceRefs: action.sourceRefs,
      evidence: ["Keep the exact source callback schedule, reads, conditions and row effects."],
      rationale: "Fixture-only semantic review", confidence: 0.99
    }));
  });
  return applyEvidenceBackedPatches(draft, patches, { sourceDraft, sourceRefs: collectSourceRefs(sourceDraft) });
}

const immediate = text => text.replace(/setTimeout\(function\s*\(\)\s*\{/, "").replace(/\},\s*510\);/, "");

describe("static timed initialization Route-validation", () => {
  for (const [index, name] of ["atomic", "or"].entries()) {
    it(`accepts the ${name} schedule with its original callback and effects`, () => {
      assert.equal(prove(originals[index], functions[name]).ok, true);
    });
    for (const [label, edit] of [
      ["immediate execution", immediate],
      ["changed delay", text => text.replace(/,\s*510\)/, ",0)")],
      ["dynamic delay", text => text.replace(/,\s*510\)/, ",waitTime)")],
      ["omitted delay", text => text.replace(/,\s*510\)/, ")")],
      ["extra argument", text => text.replace(/,\s*510\)/, ',510,"extra")')],
      ["callback parameter", text => text.replace(/setTimeout\(function\s*\(\)/, "setTimeout(function (value)")],
      ["async callback", text => text.replace(/setTimeout\(function/, "setTimeout(async function")],
      ["named callback alias", text => text.replace(/setTimeout\(function\s*\(\)/, "setTimeout(function deferred()")],
      ["scheduler alias", text => text.replace("setTimeout(", "var defer=setTimeout;defer(")],
      ["scheduler shadow", text => text.replace("function onLoad()", "function onLoad(setTimeout)")],
      ["member scheduler", text => text.replace("setTimeout(", "window.setTimeout(")],
      ["two schedules", text => text.replace(/function onLoad\(\)\s*\{/, "function onLoad(){setTimeout(function(){},510);")],
      ["nested schedule", text => text.replace(/setTimeout\(function\s*\(\)\s*\{/, "setTimeout(function(){setTimeout(function(){},510);")],
      ["early read", text => text.replace(/function onLoad\(\)\s*\{/, 'function onLoad(){var early=MKXFORM.getValue("fd_mode");')],
      ["reordered read", text => text.replace(/var current\s*=\s*MKXFORM.getValue\("fd_mode"\);/, "").replace(/setTimeout\(function\s*\(\)\s*\{/, 'setTimeout(function(){var current=MKXFORM.getValue("fd_mode");')],
      ["extra property effect", text => text.replace(/setTimeout\(function\s*\(\)\s*\{/, 'setTimeout(function(){MKXFORM.setProps("fd_payload_a",{value:"changed"});')],
      ["extra field write", text => text.replace(/setTimeout\(function\s*\(\)\s*\{/, 'setTimeout(function(){MKXFORM.setValue("fd_payload_a","changed");')],
      ["return callback", text => text.replace(/setTimeout\(function\s*\(\)\s*\{/, "setTimeout(function(){return;")],
      ["duplicate effect", text => text.replace(/MKXFORM.setFieldAttr\(([^;]+)\);/, "MKXFORM.setFieldAttr($1);MKXFORM.setFieldAttr($1);")]
    ]) {
      it(`rejects ${name} ${label}`, () => {
        const target = edit(functions[name]);
        assert.notEqual(target, functions[name]);
        assert.equal(prove(originals[index], target).ok, false, label);
      });
    }
  }

  for (const [label, edit] of [
    ["source delay change", text => text.replace("},510)", "},500)")],
    ["source timer removal", immediate],
    ["source extra effect", text => text.replace('var current=', 'SetXFormFieldValueById("fd_payload_or","changed");var current=')],
    ["source reset", text => text.replace('false,false,false)', 'false,false,true)')],
    ["source alias", text => text.replace('setTimeout(', 'var defer=setTimeout;defer(')],
    ["source callback argument", text => text.replace('setTimeout(function()', 'setTimeout(function(value)')],
    ["source await", text => text.replace('setTimeout(function(){', 'setTimeout(async function(){await work();')],
    ["source extra conditional effect", text => text.replace('if(current==', 'if(false){SetXFormFieldValueById("fd_payload_or","changed");}if(current==')]
  ]) {
    it(`rejects ${label}`, () => {
      const changed = edit(originals[1]);
      assert.notEqual(changed, originals[1]);
      assert.equal(prove(changed, functions.or).ok, false);
    });
  }

  it("preserves conditional aliases while rejecting source or target row effects outside the callback", () => {
    assert.equal(prove(originals[1], functions.or.replaceAll("current", "selected")).ok, true);
    assert.equal(prove(originals[1].replace('setTimeout(', 'common_dom_row_set_show_required_reset("fd_or_row",false,false,false);setTimeout('), functions.or).ok, false);
    assert.equal(prove(originals[1], functions.or.replace('setTimeout(', 'MKXFORM.setFieldAttr("fd_or_row",4);setTimeout(')).ok, false);
  });

  it("preserves canonical row marker aliases inside the matched callback", () => {
    const result = validateRowMarkerBranchSemantics({
      sourceFunction: wrappedSource(originals[1].replaceAll("fd_or_row", "fd_alias_row")),
      reviewedFunction: functions.or,
      resolvedMarkers: ["fd_alias_row"],
      primaryMarkerByAlias: new Map([["fd_alias_row", "fd_or_row"]]),
      sourceControls: source.form.controls, targetFields: targetForm.fields
    });
    assert.equal(result.ok, true);
  });

  for (const [label, selector] of [
    ["unchecked radio", '[name="extendDataFormInfo.value(fd_mode)"]'],
    ["selector union", '[name="extendDataFormInfo.value(fd_mode)"]:checked, [name="extendDataFormInfo.value(fd_mode)"]'],
    ["additional selector filter", '[name="extendDataFormInfo.value(fd_mode)"]:checked:first'],
    ["descendant checked selector", '[name="extendDataFormInfo.value(fd_mode)"] :checked']
  ]) {
    it(`rejects ${label} through the complete patch gate and keeps trust pending`, () => {
      const changed = structuredClone(source);
      changed.scripts.sources[0].javascript = originals[0].replace(/\$\('[^']+'\)/, `$('${selector}')`);
      const draft = draftSourceDraft(changed);
      const result = review(draft, functions, changed);
      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some(item => item.code === "agent.patch.row_marker_semantics_unverified" &&
        item.details.reason === "timed_initialization_callback_unproven"));
      const trust = checkTrust(changed, createTrustedMigrationDsl(changed, draft, { externalAgentReviewed: true, decisions: [] }));
      assert.equal(trust.ok, false);
      assert.ok(trust.diagnostics.some(item => item.code === "dsl.scripts.needs_review"));
    });
  }

  it("rejects checked checkbox reads without treating their first value as the target array", () => {
    const directory = mkdtempSync(join(tmpdir(), "timed-checkbox-"));
    try {
      const file = join(directory, "checkbox_SysFormTemplate.xml");
      writeFileSync(file, readFileSync(fixture, "utf8").replaceAll('fd_type="inputRadio"', 'fd_type="inputCheckbox"'));
      const changed = cleanSourceFile(file);
      const draft = draftSourceDraft(changed);
      assert.equal(changed.form.controls.find(field => field.id === "fd_mode").sourceType, "checkbox");
      assert.equal(draft.form.fields.find(field => field.id === "fd_mode").componentId, "xform-checkbox");
      const result = review(draft, functions, changed);
      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some(item => item.details?.reason === "timed_initialization_callback_unproven"));
      const trust = checkTrust(changed, createTrustedMigrationDsl(changed, draft, { externalAgentReviewed: true, decisions: [] }));
      assert.equal(trust.ok, false);
      assert.ok(trust.diagnostics.some(item => item.code === "dsl.scripts.needs_review"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts a single quoted checked selector without widening its matching set", () => {
    const changed = structuredClone(source);
    changed.scripts.sources[0].javascript = originals[0].replace(/\$\('[^']+'\)/,
      `$( ${JSON.stringify("[name='extendDataFormInfo.value(fd_mode)']:checked")} )`);
    assert.equal(review(draftSourceDraft(changed), functions, changed).ok, true);
  });

  it("requires unambiguous source radio evidence and a single-value target component", () => {
    const original = source.form.controls.find(field => field.id === "fd_mode");
    const checkboxFields = targetForm.fields.map(field => field.id === "fd_mode"
      ? { ...field, type: "checkbox", componentId: "xform-checkbox" } : field);
    for (const evidence of [
      { sourceControls: undefined },
      { sourceControls: source.form.controls.map(field => field.id === "fd_mode" ? { ...field, sourceType: undefined } : field) },
      { sourceControls: [...source.form.controls, original] },
      { targetFields: checkboxFields }
    ]) assert.equal(prove(originals[1], functions.or, evidence).ok, false);
  });

  it("keeps untimed GetXFormFieldById value reads on their existing proof path", () => {
    const original = 'Com_AddEventListener(window,"load",function(){if(GetXFormFieldById("fd_mode")[0].value=="A"){common_dom_row_set_show_required_reset("fd_or_row",true,false,false);}else{common_dom_row_set_show_required_reset("fd_or_row",false,false,false);}});';
    const target = 'function onLoad(){if(MKXFORM.getValue("fd_mode")=="A"){MKXFORM.setFieldAttr("fd_or_row",5);MKXFORM.setFieldAttr("fd_or_row",6);}else{MKXFORM.setFieldAttr("fd_or_row",4);MKXFORM.setFieldAttr("fd_or_row",6);}}';
    assert.equal(prove(original, target).ok, true);
  });

  it("keeps the manifest accept-only route gated without target operations", async () => {
    const result = await runRouteCase("timed-initialization-retains-schedule");
    assert.equal(result.review.stage, "agent-review.incomplete");
    assert.deepEqual(result.transcript, []);
  });

  it("persists the exact scheduled fixture through the registered fake executor route", async () => {
    const result = await runRouteCase("timed-initialization-success");
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.readback.ok, true);
    assert.ok(result.dsl.scripts.actions.every(action => action.function.includes("setTimeout")));
  });

  it("does not deterministically erase the timer of a single atomic load condition", () => {
    const changed = structuredClone(source);
    changed.scripts.sources = [changed.scripts.sources[1]];
    changed.scripts.sources[0].javascript = originals[1].replace('current=="A"||current=="B"||current=="C"', 'current=="A"');
    const draft = draftSourceDraft(changed);
    assert.equal(draft.scripts.actions.length, 1);
    assert.equal(draft.scripts.actions[0].translationStatus, "needs_review");
    assert.match(legacySourceFromGeneratedFunction(draft.scripts.actions[0].function), /setTimeout/);
  });

  it("keeps an unrelated timer outside the load callback from blocking ordinary load translation", () => {
    const changed = structuredClone(source);
    changed.scripts.sources = [changed.scripts.sources[1]];
    changed.scripts.sources[0].javascript = immediate(originals[1]).replace('current=="A"||current=="B"||current=="C"', 'current=="A"') + '\nAttachXFormValueChangeEventById("fd_mode",function(value){setTimeout(function(){console.log(value);},150);});';
    const ordinary = structuredClone(changed);
    ordinary.scripts.sources[0].javascript = changed.scripts.sources[0].javascript.split('\nAttachXForm')[0];
    const a = draftSourceDraft(ordinary).scripts.actions.find(x => x.event === "onLoad");
    const b = draftSourceDraft(changed).scripts.actions.find(x => x.event === "onLoad");
    // Mixed callbacks may already require source review; the unrelated timer
    // must not turn a source load into a synthetic timed-load candidate.
    assert.equal(prove(immediate(originals[1]), immediate(functions.or)).ok, true);
    assert.equal(legacySourceFromGeneratedFunction(b.function).includes('setTimeout'), false);
    assert.ok(a && b);
  });

  it("retains ordinary and delayed load callbacks separately under one sourceRef", () => {
    const changed = structuredClone(source);
    changed.scripts.sources = [changed.scripts.sources[1]];
    const atomic = originals[1].replace('current=="A"||current=="B"||current=="C"', 'current=="A"');
    changed.scripts.sources[0].javascript = `${immediate(atomic)}\n${atomic}`;
    const draft = draftSourceDraft(changed);
    assert.equal(draft.scripts.actions.length, 2);
    assert.equal(draft.scripts.actions[0].translationStatus, "mapped");
    assert.equal(draft.scripts.actions[1].translationStatus, "needs_review");
    assert.equal(legacySourceFromGeneratedFunction(draft.scripts.actions[1].function), atomic.trim().replace(/;$/, ""));
    assert.equal(legacySourceFromGeneratedFunction(draft.scripts.actions[1].function).match(/Com_AddEventListener/g).length, 1);
  });

  it("crosses the patch, trust, execute-check and dry-run boundaries with both original timers intact", () => {
    const draft = draftSourceDraft(source);
    const result = review(draft);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.ok(result.dslDraft.scripts.actions.every(action => action.function.includes("setTimeout")));
    const trusted = createTrustedMigrationDsl(source, result.dslDraft, { externalAgentReviewed: true, decisions: [] });
    assert.equal(checkTrust(source, trusted).ok, true);
    assert.equal(checkExecute(trusted).ok, true);
    assert.equal(buildDryRunPlan(trusted).ok, true);
    for (const name of ["atomic", "or"]) {
      const rejected = review(draft, { ...functions, [name]: immediate(functions[name]) });
      assert.equal(rejected.ok, false);
    }
  });

  it("reads field values only after the queued callback fires, preserving ordered effects", () => {
    for (const [index, name] of ["atomic", "or"].entries()) {
      for (const [initial, atFire] of [["D", "A"], ["A", "D"], ["B", "C"]]) {
        assert.deepEqual(observe(originals[index], false, initial, atFire), observe(functions[name], true, initial, atFire));
      }
    }
  });
});

function observe(text, target, initial, atFire) {
  let value = initial;
  let callback;
  const queue = [], calls = [];
  const context = vm.createContext({
    window: {}, console: { log() {} },
    Com_AddEventListener(_window, _event, fn) { callback = fn; },
    setTimeout(fn, delay, ...args) { calls.push(["schedule", delay, args, fn.length]); queue.push(() => fn(...args)); return 1; },
    $() { return { val() { calls.push(["read", "fd_mode", value]); return value; } }; },
    common_dom_row_set_show_required_reset(id, visible, required, reset) {
      assert.equal(reset, false);
      calls.push(["attribute", id, visible ? 5 : 4], ["attribute", id, required ? 3 : 6]);
    },
    MKXFORM: {
      getValue(id) { calls.push(["read", id, value]); return value; },
      setFieldAttr(id, attribute) { calls.push(["attribute", id, attribute]); }
    }
  });
  vm.runInContext(text, context, { timeout: 1000 });
  if (target) context.onLoad(); else callback();
  assert.deepEqual(calls, [["schedule", 510, [], 0]]);
  value = atFire;
  for (const run of queue) run();
  return calls;
}
