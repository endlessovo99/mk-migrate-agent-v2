import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { validateRowMarkerBranchSemantics } from "../../src/agent-review/script-semantic-closure.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { inspectDeterministicScriptBranchProof } from "../../src/dsl/deterministic-script-translations.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";

const directory = "tests/fixtures/route-validation/source-row-diagnostics/";
const functions = JSON.parse(readFileSync(`${directory}reviewed-functions.json`, "utf8"));
const fixture = name => readFileSync(`${directory}${name}_SysFormTemplate.xml`, "utf8");
const load = name => {
  const source = cleanSourceFile(`${directory}${name}_SysFormTemplate.xml`);
  return { source, draft: draftSourceDraft(source) };
};
function changedSource(name, edit) {
  const xml = fixture(name), values = parseRootHashMapStringPuts(xml);
  const source = load(name).source, old = source.scripts.sources[0].javascript;
  const next = edit(old);
  assert.notEqual(next, old);
  const display = values.fdDisplayJsp.replace(old, next);
  assert.notEqual(display, values.fdDisplayJsp);
  const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const changed = xml.replace(/(<string>fdDisplayJsp<\/string><string>)[\s\S]*?(<\/string>)/,
    (_all, before, after) => before + escape(display) + after);
  const dir = mkdtempSync(join(tmpdir(), "source-row-diagnostic-"));
  try {
    const file = join(dir, "synthetic_SysFormTemplate.xml"); writeFileSync(file, changed);
    const fixed = cleanSourceFile(file); return { source: fixed, draft: draftSourceDraft(fixed) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function valuesFor(action, fn) {
  return { function: fn, translationStatus: "mapped", coverage: { status: "translated", nativeRules: action.coverage.nativeRules || [], residuals: [] },
    functionMappings: [{ source: "Exact source diagnostics and existing ordered row recipe", target: "Same diagnostics and native row attributes", basis: "semantic-translation", reviewRequired: false }] };
}
function gates(source, draft, fn) {
  const action = draft.scripts.actions[0], values = valuesFor(action, fn);
  const patches = Object.entries(values).map(([key, value]) => ({ op: "replace", path: `/scripts/actions/0/${key}`, value,
    sourceRefs: action.sourceRefs, confidence: 0.99, evidence: ["Preserve each source diagnostic at its original timer, read and branch position"],
    rationale: "Synthetic source-backed diagnostics proof" }));
  const applied = applyEvidenceBackedPatches(draft, patches, { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
  const candidate = structuredClone(draft); Object.assign(candidate.scripts.actions[0], values);
  const trust = checkTrust(source, createTrustedMigrationDsl(source, candidate, { externalAgentReviewed: true }));
  return { applied, trust };
}
const stripLogs = text => text.replace(/console\.log\([^;]*\);/g, "");
const accepted = result => ({ apply: result.applied.ok, trust: result.trust.ok });
function assertCurrentMapping(source, draft, reviewedFunction) {
  const action=draft.scripts.actions[0];
  if(action.translationStatus!=="mapped") {
    assert.deepEqual(accepted(gates(source,draft,reviewedFunction)),{apply:true,trust:true});
    return;
  }
  assert.equal(inspectDeterministicScriptBranchProof(action).ok,true);
  for(const value of ["A","B",undefined])assert.deepEqual(observe(action.function,value),observe(reviewedFunction,value));
  const trusted=createTrustedMigrationDsl(source,draft,{externalAgentReviewed:true});
  assert.equal(checkTrust(source,trusted).ok,true);
  assert.equal(buildDryRunPlan(trusted).ok,true);
}
function observe(text,value) {
  const calls=[],queue=[];
  vm.runInNewContext(`${text}; onLoad();`,{
    setTimeout(fn,delay){calls.push(["schedule",delay]);queue.push(fn);},
    console:{log(...args){calls.push(["log",...args]);}},
    MKXFORM:{getValue(id){calls.push(["read",id,value]);return value;},setFieldAttr(id,attr){calls.push(["attribute",id,attr]);}}
  });
  for(const fn of queue)fn();return calls;
}

it("uses complete synthetic XML with one real load action and an existing source field read", () => {
  for (const name of ["timed-getter", "sync-getter", "timed-radio"]) {
    const { source, draft } = load(name);
    assert.equal(source.scripts.sources.length, 1); assert.equal(draft.scripts.actions.length, 1);
    assert.equal(draft.scripts.actions[0].event, "onLoad"); assert.equal(draft.scripts.actions[0].translationStatus, name==="timed-radio"?"mapped":"needs_review");
    assert.ok(source.scripts.sources[0].javascript.includes('console.log("value",current)'));
    assert.equal(source.form.controls[0].id, "fd_mode");
    assert.equal(source.form.layout.rows.filter(row => row.sourceMarkers?.includes("fd_panel_row")).length, 1);
    assert.equal(draft.form.layout.mkTree.filter(row => row.sourceMarkers?.includes("fd_panel_row")).length, 1);
  }
});

for (const name of ["timed-getter", "sync-getter", "timed-radio"]) it(`preserves ${name} literal and stable-local diagnostics through public gates`, () => {
  const { source, draft } = load(name), target = name === "sync-getter" ? functions.sync : functions.timed;
  assertCurrentMapping(source,draft,target);
});

it("keeps the old no-diagnostic row recipe unchanged", () => {
  for (const name of ["timed-getter", "sync-getter", "timed-radio"]) {
    const { source, draft } = changedSource(name, stripLogs);
    assertCurrentMapping(source,draft,stripLogs(name === "sync-getter" ? functions.sync : functions.timed));
  }
});

it("rejects missing, extra, changed, reordered, wrong-method and misplaced diagnostics", () => {
  const { source, draft } = load("timed-getter"), results = {};
  const edits = {
    missing: stripLogs,
    extra: text => text.replace('console.log("begin");', 'console.log("begin");console.log("invented");'),
    literal: text => text.replace('console.log("value",current)', 'console.log("changed",current)'),
    parameter: text => text.replace('console.log("value",current)', 'console.log(current,"value")'),
    method: text => text.replace('console.log("value",current)', 'console.warn("value",current)'),
    phase: text => text.replace('console.log("begin");', "").replace('function onLoad(){', 'function onLoad(){console.log("begin");'),
    branch: text => text.replace('console.log("active");', "").replace('else{', 'else{console.log("active");'),
    rawGetter: text => text.replace('console.log("value",current)', 'console.log("value",MKXFORM.getValue("fd_mode"))'),
    beforeRead: text => text.replace('console.log("value",current);', "").replace('var current=', 'console.log("value",current);var current=')
  };
  for (const [name, edit] of Object.entries(edits)) {
    const target = edit(functions.timed); assert.notEqual(target, functions.timed);
    results[name] = accepted(gates(source, draft, target));
  }
  assert.deepEqual(results, Object.fromEntries(Object.keys(edits).map(name => [name, { apply: false, trust: false }])));
});

it("requires the original explicit value read, not a cross-scope value, alias, handle, list or reassigned local", () => {
  const cases = [
    ["alias", text => text.replace('console.log("value",current);', 'var copy=current;console.log("value",copy);'), text => text.replace('console.log("value",current);', 'var copy=current;console.log("value",copy);')],
    ["reassigned", text => text.replace('console.log("value",current);', 'current="B";console.log("value",current);'), text => text.replace('console.log("value",current);', 'current="B";console.log("value",current);')],
    ["list", text => text.replace('GetXFormFieldValueById("fd_mode")[0]', 'GetXFormFieldValueById("fd_mode")'), text => text],
    ["handle", text => text.replace('GetXFormFieldValueById("fd_mode")[0]', 'GetXFormFieldById("fd_mode")[0]'), text => text],
    ["beforeRead", text => text.replace('console.log("value",current);', "").replace('var current=', 'console.log("value",current);var current='), text => text.replace('console.log("value",current);', "").replace('var current=', 'console.log("value",current);var current=')],
    ["crossScope", text => text.replace('Com_AddEventListener(', 'var external=GetXFormFieldValueById("fd_mode")[0];Com_AddEventListener(').replace('console.log("value",current);', 'console.log("value",external);'), text => text.replace('function onLoad(){', 'var external=MKXFORM.getValue("fd_mode");function onLoad(){').replace('console.log("value",current);', 'console.log("value",external);')],
    ["unknownCall", text => text.replace('console.log("value",current);', 'console.log("value",current);unknownCall();'), text => text.replace('console.log("value",current);', 'console.log("value",current);unknownCall();')]
  ];
  const results = {};
  for (const [name, editSource, editTarget] of cases) {
    const { source, draft } = changedSource("sync-getter", editSource);
    results[name] = accepted(gates(source, draft, editTarget(functions.sync)));
  }
  assert.deepEqual(results, Object.fromEntries(cases.map(([name]) => [name, { apply: false, trust: false }])));
});

it("does not let a branch-only declaration supply a later diagnostic local", () => {
  const { source, draft } = changedSource("sync-getter", text => text.replace('var current=GetXFormFieldValueById("fd_mode")[0];', 'if(true){var current=GetXFormFieldValueById("fd_mode")[0];}'));
  const target = functions.sync.replace('var current=MKXFORM.getValue("fd_mode");', 'if(true){var current=MKXFORM.getValue("fd_mode");}');
  assert.deepEqual(accepted(gates(source, draft, target)), { apply: false, trust: false });
});

it("refuses ambiguous two-read snapshots instead of equating locals only by their field origin", () => {
  const { source, draft } = changedSource("sync-getter", text => text.replace('var current=GetXFormFieldValueById("fd_mode")[0];',
    'var first=GetXFormFieldValueById("fd_mode")[0];SetXFormFieldValueById("fd_mode","B",false);var current=GetXFormFieldValueById("fd_mode")[0];')
    .replace('console.log("value",current);', 'console.log("value",first);'));
  const target = functions.sync.replace('var current=MKXFORM.getValue("fd_mode");',
    'var first=MKXFORM.getValue("fd_mode");MKXFORM.setValue("fd_mode","B");var current=MKXFORM.getValue("fd_mode");');
  const script = source.scripts.sources[0].javascript;
  const wrapped = `function onLoad(){\n// Source JSP JavaScript:\n${script.split("\n").map(line => `// ${line}`).join("\n")}\n}`;
  const proof = validateRowMarkerBranchSemantics({ sourceFunction: wrapped, reviewedFunction: target,
    resolvedMarkers: ["fd_panel_row"], primaryMarkerByAlias: new Map(), sourceControls: source.form.controls,
    sourceForm: source.form, sourceScripts: source.scripts, sourceRefs: draft.scripts.actions[0].sourceRefs,
    targetFields: draft.form.fields });
  assert.equal(proof.ok, false);
});

it("retains diagnostics from an already ordered main hidden String value getter", () => {
  const { source, draft } = load("sync-hidden-string");
  const original = source.form.dataFields.filter(field => field.id === "fd_mode");
  assert.equal(original.length, 1); assert.equal(original[0].sourceType, "text");
  assert.equal(original[0].sourceProps.hardHidden, true);
  assert.equal(original[0].sourceProps.metadataAttributes.type, "String");
  assert.equal(draft.form.fields.find(field => field.id === "fd_mode").componentId, "xform-hidden");
  assert.equal(source.form.layout.rows.filter(row => row.sourceMarkers?.includes("fd_panel_row")).length, 1);
  const noLogs = changedSource("sync-hidden-string", stripLogs);
  assert.deepEqual(accepted(gates(noLogs.source, noLogs.draft, stripLogs(functions.sync))), { apply: true, trust: true });
  assert.deepEqual(accepted(gates(source, draft, functions.sync)), { apply: true, trust: true });
});

it("does not admit a handle, list, different index or extra property as the hidden String diagnostic snapshot", () => {
  const changes = [
    'GetXFormFieldById("fd_mode")[0]',
    'GetXFormFieldValueById("fd_mode")',
    'GetXFormFieldValueById("fd_mode")[1]',
    'GetXFormFieldValueById("fd_mode")[0].unknown'
  ];
  const results = changes.map(expression => {
    const { source, draft } = changedSource("sync-hidden-string", text => text.replace('GetXFormFieldValueById("fd_mode")[0]', expression));
    return accepted(gates(source, draft, functions.sync));
  });
  assert.deepEqual(results, changes.map(() => ({ apply: false, trust: false })));
});
