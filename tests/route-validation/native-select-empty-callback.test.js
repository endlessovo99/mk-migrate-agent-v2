import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "acorn";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runAgentReview } from "../../src/agent-review/runner.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { checkExecute } from "../../src/dsl/checks.js";
import { proveSelectEmptySourceCallback } from "../../src/dsl/source-select-empty-callback.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";

const directory = "tests/fixtures/route-validation/native-select-empty-event/";
const original = readFileSync(`${directory}select-empty_SysFormTemplate.xml`, "utf8");
const originalTarget = JSON.parse(readFileSync(`${directory}reviewed-functions.json`, "utf8")).onChange;
const load = name => {
  const source = cleanSourceFile(`${directory}${name}_SysFormTemplate.xml`);
  return { source, draft: draftSourceDraft(source) };
};
function changedSource(text) {
  const dir = mkdtempSync(join(tmpdir(), "select-empty-source-closure-"));
  try {
    const file = join(dir, "synthetic_SysFormTemplate.xml");
    writeFileSync(file, text);
    const source = cleanSourceFile(file);
    return { source, draft: draftSourceDraft(source) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const provider = () => createFakeReviewProvider("native-select-empty-event");
async function patchesFor(source, draft) {
  const response = await provider().review({ sourceDraft: source, dslDraft: draft, reviewScope: { actionIndexes: [0] } });
  return JSON.parse(response.rawText).patches;
}
function directTrusted(source, draft, patches) {
  const changed = structuredClone(draft);
  for (const patch of patches) changed.scripts.actions[0][patch.path.split("/").at(-1)] = structuredClone(patch.value);
  return createTrustedMigrationDsl(source, changed, { externalAgentReviewed: true, reviewerName: "synthetic fixed-source callback closure test" });
}
const selectDiagnostic = result => result.diagnostics.some(item => item.code === "agent.patch.select_empty_event_unverified");

it("preserves the existing complete source callback, assignments and exact native linkage", async () => {
  const { source, draft } = load("select-empty");
  const reviewed = await runAgentReview(source, draft, { provider: provider() });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.report));
  assert.deepEqual(reviewed.dsl.formRules, draft.formRules);
  assert.deepEqual(reviewed.dsl.scripts.actions[0].coverage.nativeRules, draft.scripts.actions[0].coverage.nativeRules);
  assert.equal(checkTrust(source, reviewed.dsl).ok, true);
  assert.equal(checkExecute(reviewed.dsl).ok, true);
});

it("puts the extra call in the real first synchronous onChange statement, independently of layout", () => {
  const { source, draft } = load("extra-call");
  assert.equal(source.scripts.sources.length, 1);
  assert.equal(draft.scripts.actions.length, 1);
  const program = parse(source.scripts.sources[0].javascript, { ecmaVersion: "latest" });
  const registration = program.body[0].expression;
  assert.equal(registration.callee.name, "AttachXFormValueChangeEventById");
  assert.equal(registration.arguments[0].value, "fd_choice");
  const first = registration.arguments[1].body.body[0];
  assert.equal(first.type, "ExpressionStatement");
  assert.equal(first.expression.callee.name, "unknownCall");
  assert.ok(source.scripts.sources[0].functionAudit.violations.some(item => item.name === "unknownCall"));
  assert.ok(draft.scripts.actions[0].coverage.residuals.some(item => item.evidence?.includes("unknownCall();")));
  assert.equal(draft.form.layout.sourceGrid.rows.some(row => Object.hasOwn(row, "trailingBlankCells")), false);
});

it("blocks a fake semantic review that drops the additional source call", async () => {
  const { source, draft } = load("extra-call");
  const reviewed = await runAgentReview(source, draft, { provider: provider() });
  assert.equal(reviewed.ok, false);
  assert.ok(reviewed.report.diagnostics.some(item => ["agent.patch.select_empty_event_unverified", "trust.script_select_empty_source_mismatch"].includes(item.code)), JSON.stringify(reviewed.report));
});

it("rejects clearing the source call through public evidence-backed patches", async () => {
  const { source, draft } = load("extra-call"), patches = await patchesFor(source, draft);
  const result = applyEvidenceBackedPatches(draft, patches, { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
  assert.equal(result.ok, false);
  assert.ok(selectDiagnostic(result), JSON.stringify(result.diagnostics));
});

it("rebuilds callback effects from fixed source even when candidate coverage and mappings claim completion", async () => {
  const { source, draft } = load("extra-call"), patches = await patchesFor(source, draft);
  const trusted = directTrusted(source, draft, patches);
  assert.equal(trusted.scripts.actions[0].coverage.residuals.length, 0);
  assert.equal(trusted.scripts.actions[0].function.includes("unknownCall"), false);
  const result = checkTrust(source, trusted);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(item => item.code === "trust.script_select_empty_source_mismatch"), JSON.stringify(result.diagnostics));
});

it("keeps comments and unused literal locals inert while preserving the actual source branches", async () => {
  for (const prefix of ["/* unknownCall(); */", 'const inert = "unknownCall()";']) {
    const { source, draft } = changedSource(original.replace("var marker=", `${prefix}var marker=`));
    const result = await runAgentReview(source, draft, { provider: provider() });
    assert.equal(result.ok, true, JSON.stringify(result.report));
    assert.deepEqual(result.dsl.formRules, draft.formRules);
  }
});

it("does not treat known side effects or computed calls as an inert local declaration", async () => {
  for (const extra of ['alert("extra");', 'window["unknownCall"]();']) {
    const { source, draft } = changedSource(original.replace("var marker=", `${extra}var marker=`));
    const result = applyEvidenceBackedPatches(draft, await patchesFor(source, draft), { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
    assert.equal(result.ok, false);
    assert.ok(selectDiagnostic(result), JSON.stringify(result.diagnostics));
  }
});

const listGetterXml = () => original.replace('var marker=GetXFormFieldById("fd_marker")[0];', 'var marker=GetXFormFieldById("fd_marker");')
  .replaceAll("marker.value", "marker[0].value");

it("preserves the equivalent stable getter list with its literal zero index at each write", async () => {
  const xml = listGetterXml();
  assert.notEqual(xml, original);
  const { source, draft } = changedSource(xml);
  assert.match(source.scripts.sources[0].javascript, /marker\[0\]\.value/);
  const result = await runAgentReview(source, draft, { provider: provider() });
  assert.equal(result.ok, true, JSON.stringify(result.report));
  assert.deepEqual(result.dsl.formRules, draft.formRules);
  assert.deepEqual(result.dsl.scripts.actions[0].coverage.nativeRules, draft.scripts.actions[0].coverage.nativeRules);
});

it("rejects other list indexes, escaping the list, or an additional list read in the callback proof", () => {
  for (const edit of [
    text => text.replaceAll("marker[0].value", "marker[1].value"),
    text => text.replace("if(value.indexOf", "consume(marker);if(value.indexOf"),
    text => text.replace("if(value.indexOf", "marker.length;if(value.indexOf")
  ]) {
    const xml = edit(listGetterXml());
    assert.notEqual(xml, listGetterXml());
    const { source, draft } = changedSource(xml);
    const result = proveSelectEmptySourceCallback({ action: draft.scripts.actions[0], sources: source.scripts.sources,
      form: source.form, formRules: draft.formRules, needle: "READY",
      writes: [{ target: "fd_marker", value: "active" }, { target: "fd_marker", value: "inactive" }] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "source_callback_effect_unproven");
  }
});

const sourceLog = 'console.log("source trace", value);';
const targetLog = 'console.log("source trace", (value === null ? "" : value));';
function loggedCase(position) {
  let xml = original, target = originalTarget;
  if (position === "before") {
    xml = xml.replace("var marker=", `${sourceLog}var marker=`);
    target = target.replace("  if (", `  ${targetLog}\n  if (`);
  } else if (position === "branches") {
    for (const value of ["active", "inactive"]) {
      xml = xml.replace(`marker.value="${value}";`, `marker.value="${value}";${sourceLog}`);
      target = target.replace(`MKXFORM.setValue("fd_marker", "${value}");`, `MKXFORM.setValue("fd_marker", "${value}");\n    ${targetLog}`);
    }
  } else {
    xml = xml.replace("});&lt;/script&gt;", `${sourceLog}});&lt;/script&gt;`);
    target = target.replace(/\n}$/, `\n  ${targetLog}\n}`);
  }
  assert.notEqual(xml, original); assert.notEqual(target, originalTarget);
  return { ...changedSource(xml), target };
}
async function mappedPatches(source, draft, fn) {
  return (await patchesFor(source, draft)).map(patch => patch.path.endsWith("/function") ? { ...patch, value: fn } : patch);
}

it("preserves console diagnostics before, within and after the branches with the original event empty-value semantics", async () => {
  for (const position of ["before", "branches", "after"]) {
    const { source, draft, target } = loggedCase(position), patches = await mappedPatches(source, draft, target);
    assert.ok(source.scripts.sources[0].javascript.includes(sourceLog));
    const applied = applyEvidenceBackedPatches(draft, patches, { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
    assert.equal(applied.ok, true, JSON.stringify(applied.diagnostics));
    const trusted = directTrusted(source, draft, patches), check = checkTrust(source, trusted);
    assert.equal(check.ok, true, JSON.stringify(check.diagnostics));
    assert.equal(checkExecute(trusted).ok, true);
    assert.deepEqual(trusted.formRules, draft.formRules);
  }
});

it("rejects erased, extra, changed, reordered or bare-native-event console diagnostics", async () => {
  const before = loggedCase("before"), inside = loggedCase("branches"), base = load("select-empty");
  const cases = [
    { ...before, fn: originalTarget },
    { ...before, fn: before.target.replace("source trace", "changed trace") },
    { ...before, fn: before.target.replace(targetLog, 'console.log("source trace", value);') },
    { ...before, fn: before.target.replace(`  ${targetLog}\n`, "").replace(/\n}$/, `\n  ${targetLog}\n}`) },
    { ...base, fn: before.target },
    { ...inside, fn: inside.target.replace(`MKXFORM.setValue("fd_marker", "active");\n    ${targetLog}`, `${targetLog}\n    MKXFORM.setValue("fd_marker", "active");`) }
  ];
  for (const { source, draft, fn } of cases) {
    const patches = await mappedPatches(source, draft, fn);
    const applied = applyEvidenceBackedPatches(draft, patches, { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
    assert.equal(applied.ok, false);
    assert.ok(selectDiagnostic(applied), JSON.stringify(applied.diagnostics));
    const check = checkTrust(source, directTrusted(source, draft, patches));
    assert.equal(check.ok, false);
    assert.ok(check.diagnostics.some(item => item.code === "trust.script_select_empty_source_mismatch"), JSON.stringify(check.diagnostics));
  }
});

it("binds the source diagnostic trace and its literal arguments independently of reviewer metadata", () => {
  const { source, draft } = loggedCase("before");
  const log = { type: "console.log", args: [{ kind: "literal", value: "source trace" }, { kind: "event" }] };
  const writes = [{ target: "fd_marker", value: "active" }, { target: "fd_marker", value: "inactive" }];
  const trace = { before: [log], branches: writes.map(write => [{ type: "setValue", ...write }]), after: [] };
  const args = { action: draft.scripts.actions[0], sources: source.scripts.sources, form: source.form,
    formRules: draft.formRules, needle: "READY", writes };
  assert.equal(proveSelectEmptySourceCallback({ ...args, targetTrace: trace }).ok, true);
  assert.equal(proveSelectEmptySourceCallback(args).ok, false, "A source diagnostic must not disappear through the legacy writes-only view");
  for (const mutate of [
    value => { value.before = []; },
    value => { value.before[0].args[0].value = "changed"; },
    value => { value.after = value.before; value.before = []; },
    value => { value.before[0].args[1] = { kind: "event", unchecked: true }; }
  ]) {
    const changed = structuredClone(trace); mutate(changed);
    assert.equal(proveSelectEmptySourceCallback({ ...args, targetTrace: changed }).ok, false);
  }
});

it("permits genuine native-only omission but refuses to erase a non-assignment source residual", () => {
  const nativeOnly = original.replace('var marker=GetXFormFieldById("fd_marker")[0];', "")
    .replaceAll('marker.value="active";', "").replaceAll('marker.value="inactive";', "");
  assert.notEqual(nativeOnly, original);
  for (const extra of [false, true]) {
    const { source, draft } = changedSource(extra ? nativeOnly.replace("if(value.indexOf", "unknownCall();if(value.indexOf") : nativeOnly);
    const action = draft.scripts.actions[0];
    assert.equal(action.coverage.residuals.some(item => item.code === "script.residual.field_value_assignment"), false);
    assert.equal(action.coverage.residuals.length > 0, extra);
    assert.equal(action.coverage.nativeRules.length, 1);
    const values = { function: "", translationStatus: "omitted",
      functionMappings: action.functionMappings.map(mapping => ({ ...mapping, basis: "semantic-translation", reviewRequired: false })),
      coverage: { status: "covered", nativeRules: action.coverage.nativeRules, residuals: [] } };
    const patches = Object.entries(values).map(([key, value]) => ({ op: "replace", path: `/scripts/actions/0/${key}`, value,
      sourceRefs: action.sourceRefs, confidence: 0.99, evidence: ["Synthetic source-owned native-only closure check"],
      rationale: "An omitted callback must have no unaccounted source behavior." }));
    const applied = applyEvidenceBackedPatches(draft, patches, { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
    const check = checkTrust(source, directTrusted(source, draft, patches));
    assert.equal(applied.ok, !extra, JSON.stringify(applied.diagnostics));
    assert.equal(check.ok, !extra, JSON.stringify(check.diagnostics));
    if (extra) {
      assert.ok(selectDiagnostic(applied), JSON.stringify(applied.diagnostics));
      assert.ok(check.diagnostics.some(item => item.code === "trust.script_select_empty_source_mismatch"), JSON.stringify(check.diagnostics));
    }
  }
});

it("preserves a zero-argument source diagnostic while rejecting one invented by the target", async () => {
  const logged = changedSource(original.replace("var marker=", "console.log();var marker="));
  const target = originalTarget.replace("  if (", "  console.log();\n  if (");
  const patches = await mappedPatches(logged.source, logged.draft, target);
  const applied = applyEvidenceBackedPatches(logged.draft, patches, { sourceDraft: logged.source, sourceRefs: collectSourceRefs(logged.source) });
  assert.equal(applied.ok, true, JSON.stringify(applied.diagnostics));
  assert.equal(checkTrust(logged.source, directTrusted(logged.source, logged.draft, patches)).ok, true);
  const base = load("select-empty"), invented = await mappedPatches(base.source, base.draft, target);
  assert.equal(applyEvidenceBackedPatches(base.draft, invented, { sourceDraft: base.source, sourceRefs: collectSourceRefs(base.source) }).ok, false);
  assert.equal(checkTrust(base.source, directTrusted(base.source, base.draft, invented)).ok, false);
});

it("keeps the source-owned native-only condition and effects when its action is omitted", () => {
  const nativeOnly = original.replace('var marker=GetXFormFieldById("fd_marker")[0];', "")
    .replaceAll('marker.value="active";', "").replaceAll('marker.value="inactive";', "");
  const { source, draft } = changedSource(nativeOnly), action = draft.scripts.actions[0];
  assert.equal(action.translationStatus, "omitted");
  assert.deepEqual(action.coverage.residuals, []);
  assert.equal(action.coverage.nativeRules.length, 1);
  const results = {};
  for (const [name, mutate] of [
    ["unchanged", () => {}],
    ["effects", value => { value.formRules.linkage[0].effects[0].value = !value.formRules.linkage[0].effects[0].value; }],
    ["condition", value => { value.formRules.linkage[0].when[0].value = "OTHER"; }]
  ]) {
    const changed = structuredClone(draft); mutate(changed);
    assert.deepEqual(changed.scripts.actions[0].coverage.nativeRules, action.coverage.nativeRules);
    const trusted = createTrustedMigrationDsl(source, changed, { externalAgentReviewed: true });
    results[name] = checkTrust(source, trusted).ok;
  }
  assert.deepEqual(results, { unchanged: true, effects: false, condition: false });
});
