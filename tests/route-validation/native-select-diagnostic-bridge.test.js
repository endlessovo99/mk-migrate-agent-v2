import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { checkDraft, checkExecute } from "../../src/dsl/checks.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { runRouteCase } from "./run-route-case.js";
import vm from "node:vm";

const directory = "tests/fixtures/route-validation/native-select-empty-event/";
const xml = readFileSync(`${directory}diagnostic-map_SysFormTemplate.xml`, "utf8");
const target = JSON.parse(readFileSync(`${directory}reviewed-functions.json`, "utf8")).diagnosticMap;
const log = 'console.log("trace", value === null ? "" : value);';
function load(text = xml) {
  const dir = mkdtempSync(join(tmpdir(), "select-diagnostic-"));
  try {
    const file = join(dir, "diagnostic_SysFormTemplate.xml");
    writeFileSync(file, text);
    const source = cleanSourceFile(file);
    return { source, draft: draftSourceDraft(source) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
async function gates({ source, draft }, fn = target, editPatches = () => {}) {
  const response = await createFakeReviewProvider("native-select-diagnostic-map").review({ dslDraft: draft });
  const patches = JSON.parse(response.rawText).patches.map(patch => patch.path.endsWith("/function") ? { ...patch, value: fn } : patch);
  editPatches(patches);
  const apply = applyEvidenceBackedPatches(draft, patches, { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
  const candidate = structuredClone(draft);
  for (const patch of patches) candidate.scripts.actions[0][patch.path.split("/").at(-1)] = patch.value;
  const trusted = createTrustedMigrationDsl(source, candidate, { externalAgentReviewed: true });
  return { apply, trust: checkTrust(source, trusted), trusted };
}

it("persists the source-backed diagnostic-only bridge through the complete offline route", async () => {
  const result = await runRouteCase("native-select-diagnostic-map-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.readback.ok, true);
  assert.equal(result.dsl.scripts.actions[0].function, target);
});

it("shares the proof across apply, trust, draft, execute and dry-run without rewriting the function", async () => {
  const state = load();
  assert.equal(state.draft.scripts.actions[0].branchProvenance.status, "none");
  const result = await gates(state);
  assert.equal(result.apply.ok, true, JSON.stringify(result.apply.diagnostics));
  assert.equal(result.trust.ok, true, JSON.stringify(result.trust.diagnostics));
  assert.equal(checkDraft(result.apply.dslDraft).ok, true);
  assert.equal(checkExecute(result.trusted).ok, true);
  assert.equal(buildDryRunPlan(result.trusted).ok, true);
  assert.equal(result.trusted.scripts.actions[0].function, target);
  assert.deepEqual(result.trusted.formRules, state.draft.formRules);
});

for (const [name, edit] of [
  ["missing diagnostic", text => text.replace(log, "")],
  ["raw native event", text => text.replace('value === null ? "" : value', "value")],
  ["changed literal", text => text.replace('"trace"', '"changed"')],
  ["extra diagnostic", text => text.replace(log, `${log}${log}`)],
  ["wrong method", text => text.replace("console.log", "console.warn")],
  ["wrong phase", text => text.replace(`  ${log}\n`, "").replace(/\n}$/, `\n  ${log}\n}`)],
  ["nullish expansion", text => text.replace('value === null ? "" : value', 'value ?? ""')],
  ["falsy expansion", text => text.replace('value === null ? "" : value', 'value || ""')],
  ["loose null", text => text.replace("=== null", "== null")],
  ["wrong fallback", text => text.replace('? "" : value', '? "READY" : value')],
  ["different binding", text => text.replace('? "" : value', '? "" : rowNum')],
  ["getter argument", text => text.replace('value === null ? "" : value', 'MKXFORM.getValue("fd_choice")')],
  ["unknown call argument", text => text.replace('value === null ? "" : value', "unknownCall(value)")],
  ["unknown bridge call", text => text.replace('? "" : value', '? "" : unknownCall(value)')],
  ["computed console", text => text.replace("console.log", 'console["log"]')],
  ["optional console", text => text.replace("console.log(", "console.log?.(")],
  ["shadowed console", text => text.replace("{\n", "{\n  var console = {};\n")],
  ["rebound event", text => text.replace("{\n", '{\n  value = "READY";\n')],
  ["business ternary", text => text.replace("lookup[value]", 'lookup[value === null ? "" : value]')],
  ["invented business condition", text => text.replace("  var lookup", '  if(value === "READY") return;\n  var lookup')],
  ["changed lookup value", text => text.replace('"active"', '"altered"')],
  ["changed destination", text => text.replace('"fd_marker"', '"fd_choice"')],
  ["additional SDK getter", text => text.replace("  var lookup", '  MKXFORM.getValue("fd_choice");\n  var lookup')]
]) it(`rejects ${name} in both public patch and fixed-source trust`, async () => {
  const result = await gates(load(), edit(target));
  assert.equal(result.apply.ok, false);
  assert.equal(result.trust.ok, false);
});

for (const [name, edit] of [
  ["missing empty fact", text => text.replace(' showPleaseSelect="true"', "")],
  ["false empty fact", text => text.replace('showPleaseSelect="true"', 'showPleaseSelect="false"')],
  ["source has no diagnostic", text => text.replace('console.log("trace",value);', "")],
  ["source unknown prefix call", text => text.replace('console.log("trace",value);', 'unknownCall();console.log("trace",value);')],
  ["source unknown argument", text => text.replace('console.log("trace",value);', 'console.log("trace",unknownCall(value));')],
  ["source getter argument", text => text.replace('console.log("trace",value);', 'console.log("trace",GetXFormFieldValueById("fd_choice")[0]);')],
  ["source unknown trailing call", text => text.replace('destination.val(lookup[value]);', 'destination.val(lookup[value]);unknownCall();')],
  ["source extra getter", text => text.replace('var lookup=', 'var extra=GetXFormFieldValueById("fd_choice")[0];var lookup=')],
  ["source duplicate effect", text => text.replace('destination.val(lookup[value]);', 'destination.val(lookup[value]);destination.val(lookup[value]);')]
]) it(`requires authoritative source evidence: ${name}`, async () => {
  const result = await gates(load(edit(xml)));
  assert.equal(result.apply.ok, false);
  assert.equal(result.trust.ok, false);
});

it("does not let omission erase the source diagnostic and map write", async () => {
  const result = await gates(load(), "", patches => {
    patches.find(patch => patch.path.endsWith("/translationStatus")).value = "omitted";
  });
  assert.equal(result.apply.ok, false);
  assert.equal(result.trust.ok, false);
});

it("does not borrow a diagnostic bridge to change the empty-state business lookup", async () => {
  const state = load(xml.replace('"OTHER":"inactive"', '"OTHER":"inactive","null":"active"'));
  const fn = target.replace('"OTHER": "inactive"', '"OTHER": "inactive", "null": "active"');
  const result = await gates(state, fn);
  assert.equal(result.apply.ok, false);
  assert.equal(result.trust.ok, false);
});

it("keeps every non-null diagnostic argument identical in the persisted function", () => {
  const logged = [], context = vm.createContext({ console: { log: (...args) => logged.push(args) }, MKXFORM: { setValue() {} } });
  vm.runInContext(target, context);
  const array = ["READY"], object = {}, values = [null, undefined, false, 0, "", "READY", array, object];
  for (const value of values) context.onChange(value);
  values.forEach((value, index) => assert.equal(logged[index][1], value === null ? "" : value));
});

const literalSource = xml.replace('console.log("trace",value);', 'console.log("literal");');
const literalTarget = target.replace(log, 'console.log("literal");');
it("preserves literal-only entry diagnostics in the same map grammar", async () => {
  const result = await gates(load(literalSource), literalTarget);
  assert.equal(result.apply.ok, true, JSON.stringify(result.apply.diagnostics));
  assert.equal(result.trust.ok, true, JSON.stringify(result.trust.diagnostics));
});
for (const [name, fn] of [
  ["dropped", literalTarget.replace('console.log("literal");', "")],
  ["changed", literalTarget.replace('"literal"', '"changed"')],
  ["extra", literalTarget.replace('console.log("literal");', 'console.log("literal");console.log("extra");')],
  ["moved", literalTarget.replace('  console.log("literal");\n', "").replace(/\n}$/, '\n console.log("literal");\n}')]
]) it(`rejects ${name} literal-only diagnostics`, async () => {
  const result = await gates(load(literalSource), fn);
  assert.equal(result.apply.ok, false);
  assert.equal(result.trust.ok, false);
});

for (const [name, edit] of [
  ["unknown prefix", text => text.replace('console.log("literal");', 'unknownCall();console.log("literal");')],
  ["unknown suffix", text => text.replace('destination.val(lookup[value]);', 'destination.val(lookup[value]);unknownCall();')],
  ["console mutation", text => text.replace('console.log("literal");', 'console.log=unknownCall;console.log("literal");')],
  ["computed logger", text => text.replace('console.log("literal");', 'console["log"]("literal");')],
  ["unknown call without diagnostics", text => text.replace('console.log("literal");', 'unknownCall();')],
  ["computed map setter", text => text.replace('destination.val(lookup[value]);', 'destination["val"](lookup[value]);unknownCall();')],
  ["unknown map setter", text => text.replace('destination.val(lookup[value]);', 'destination.unknownWrite(lookup[value]);unknownCall();')],
  ["unknown source index", text => text.replace('lookup[value]', 'lookup[unknownCall(value)]')],
  ["unknown map initializer", text => text.replace('var lookup={"READY":"active","OTHER":"inactive"};', 'var lookup=unknownCall();')]
]) it(`keeps the recognized map source closed around literal-only diagnostics: ${name}`, async () => {
  const result = await gates(load(edit(literalSource)), literalTarget.replace('console.log("literal");', ""));
  assert.equal(result.apply.ok, false);
  assert.equal(result.trust.ok, false);
});

it("retains the ordinary map callback when neither side has diagnostics", async () => {
  const result = await gates(load(literalSource.replace('console.log("literal");', "")), literalTarget.replace('console.log("literal");', ""));
  assert.equal(result.apply.ok, true, JSON.stringify(result.apply.diagnostics));
  assert.equal(result.trust.ok, true, JSON.stringify(result.trust.diagnostics));
});

it("does not require an empty-state bridge for an ordinary map with no diagnostic event read", async () => {
  const state = load(literalSource.replace('console.log("literal");', "").replace(' showPleaseSelect="true"', ""));
  const result = await gates(state, literalTarget.replace('console.log("literal");', ""));
  assert.equal(result.apply.ok, true, JSON.stringify(result.apply.diagnostics));
  assert.equal(result.trust.ok, true, JSON.stringify(result.trust.diagnostics));
});

it("leaves non-map literal diagnostics under their existing source contract", async () => {
  const start = literalSource.indexOf('var fieldId='), end = literalSource.indexOf('});&lt;/script&gt;', start);
  const state = load(literalSource.slice(0, start) + literalSource.slice(end));
  const result = await gates(state, 'function onChange(value, rowNum, parentRowNum) {console.log("literal");}');
  assert.equal(result.apply.ok, true, JSON.stringify(result.apply.diagnostics));
  assert.equal(result.trust.ok, true, JSON.stringify(result.trust.diagnostics));
});

const identifierKeys = text => text.replaceAll('"READY":', 'READY:').replaceAll('"OTHER":', 'OTHER:');
it("preserves equivalent quoted and Identifier static property keys", async () => {
  for (const [source, fn] of [[identifierKeys(xml), target], [xml, identifierKeys(target)], [identifierKeys(xml), identifierKeys(target)]]) {
    const result = await gates(load(source), fn);
    assert.equal(result.apply.ok, true, JSON.stringify(result.apply.diagnostics));
    assert.equal(result.trust.ok, true, JSON.stringify(result.trust.diagnostics));
    assert.equal(checkExecute(result.trusted).ok, true);
  }
});

it("preserves equivalent numeric and string static property keys", async () => {
  const source = literalSource.replace('var lookup={"READY":', 'var lookup={1:');
  const fn = literalTarget.replace('var lookup = { "READY":', 'var lookup = { "1":');
  const result = await gates(load(source), fn);
  assert.equal(result.apply.ok, true, JSON.stringify(result.apply.diagnostics));
  assert.equal(result.trust.ok, true, JSON.stringify(result.trust.diagnostics));
});

for (const [name, editSource, fn] of [
  ["dropped diagnostic", text => text, identifierKeys(literalTarget).replace('console.log("literal");', "")],
  ["changed diagnostic", text => text, identifierKeys(literalTarget).replace('"literal"', '"changed"')],
  ["unknown source call", text => text.replace('destination.val(lookup[value]);', 'destination.val(lookup[value]);unknownCall();'), identifierKeys(literalTarget).replace('console.log("literal");', "")]
]) it(`requires the same diagnostic proof for Identifier static property keys: ${name}`, async () => {
  const result = await gates(load(editSource(identifierKeys(literalSource))), fn);
  assert.equal(result.apply.ok, false);
  assert.equal(result.trust.ok, false);
});

for (const [name, sourceMap, targetMap] of [
  ["computed key", '{["READY"]:"active",OTHER:"inactive"}', '{["READY"]:"active",OTHER:"inactive"}'],
  ["method", '{READY(){unknownCall()},OTHER:"inactive"}', '{READY(){unknownCall()},OTHER:"inactive"}'],
  ["accessor", '{get READY(){unknownCall()},OTHER:"inactive"}', '{get READY(){unknownCall()},OTHER:"inactive"}'],
  ["spread", '{...unknownCall(),OTHER:"inactive"}', '{...unknownCall(),OTHER:"inactive"}'],
  ["unknown value call", '{READY:unknownCall(),OTHER:"inactive"}', '{READY:unknownCall(),OTHER:"inactive"}'],
  ["non-string value", '{READY:1,OTHER:"inactive"}', '{READY:1,OTHER:"inactive"}'],
  ["empty object", '{}', '{}']
]) it(`rejects unsupported object map shapes instead of making their proof irrelevant: ${name}`, async () => {
  const source = literalSource.replace('{"READY":"active","OTHER":"inactive"}', sourceMap);
  const fn = literalTarget.replace('{ "READY": "active", "OTHER": "inactive" }', targetMap).replace('console.log("literal");', "");
  const result = await gates(load(source), fn);
  assert.equal(result.apply.ok, false);
  assert.equal(result.trust.ok, false);
});
