import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { applyApprovedAuxiliaryPolicies, validateApprovedAuxiliaryDecisions } from "../../src/translator/approved-auxiliary-policies.js";
import { canonicalRowTarget } from "../../src/dsl/layout-row-targets.js";

const directory = "tests/fixtures/route-validation/approved-auxiliary-policies/";
const sha = text => "sha256:" + createHash("sha256").update(text).digest("hex");
function stages(name = "retirement") {
  const source = cleanSourceFile(directory + "route-approved-" + name + "_SysFormTemplate.xml");
  return { source, draft: draftSourceDraft(source) };
}
function decisionsFor(source, name = "retirement") {
  return source.scripts.sources.map((script, index) => name === "selected-reads" ? {
    kind: "current_selected_string_reads", sourceRef: script.sourceRef,
    sourceJavascriptSha256: sha(script.javascript), fieldIds: ["fd_unit", "fd_plan"]
  } : { kind: "retire_missing_auxiliary_bindings", sourceRef: script.sourceRef,
    sourceJavascriptSha256: sha(script.javascript), retiredValueFieldIds: index ? [] : ["fd_retired_flag"],
    ...(index ? {} : { replacementReadFieldId: "fd_permission" }), retiredRequiredFieldIds: index ? ["fd_retired_note"] : [] });
}
function apply(source, draft, decisions) {
  const bound = { ...source, migrationPolicies: { version: 1, decisions: structuredClone(decisions) } };
  return applyApprovedAuxiliaryPolicies(bound, draft, decisions);
}
function mutateSource(edit, name = "retirement") {
  const { source, draft } = stages(name); edit(source, draft);
  const decisions = decisionsFor(source, name), result = apply(source, draft, decisions);
  return { source, draft, decisions, result };
}

it("validates only the exact declared source-bound retirement and selected-read schemas", () => {
  const { source } = stages(), good = decisionsFor(source);
  assert.equal(validateApprovedAuxiliaryDecisions(good).ok, true);
  for (const invalid of [null, [null], [{ ...good[0], kind: "anything" }], [good[0], good[0]],
    [{ ...good[0], extra: true }], [{ ...good[0], sourceJavascriptSha256: "0".repeat(64) }],
    [{ ...good[0], retiredValueFieldIds: ["fd_retired_flag", "fd_retired_flag"] }],
    [{ ...good[0], retiredRequiredFieldIds: ["fd_retired_flag"] }],
    [{ ...good[0], replacementReadFieldId: "fd_retired_flag" }],
    [{ ...good[1], replacementReadFieldId: "fd_permission" }],
    [{ ...good[1], retiredRequiredFieldIds: [] }]]) assert.equal(validateApprovedAuxiliaryDecisions(invalid).ok, false);
  const selected = decisionsFor(stages("selected-reads").source, "selected-reads")[0];
  assert.equal(validateApprovedAuxiliaryDecisions([selected]).ok, true);
  for (const fieldIds of [[], ["fd_unit", "fd_unit"], ["not-an-id"], null])
    assert.equal(validateApprovedAuxiliaryDecisions([{ ...selected, fieldIds }]).ok, false);
});

it("requires the manifest member and exact source hash without mutating either input", () => {
  const { source, draft } = stages(), original = structuredClone({ source, draft }), decisions = decisionsFor(source);
  const untouched = applyApprovedAuxiliaryPolicies(source, draft, []);
  assert.deepEqual(untouched, { draft, audits: [], changedActionIds: [] });
  const missing = applyApprovedAuxiliaryPolicies(source, draft, decisions);
  assert.deepEqual(missing.draft, draft); assert.equal(missing.changedActionIds.length, 0);
  assert.equal(missing.audits[0].reason, "approved_manifest_missing_or_changed");
  const changed = structuredClone(decisions); changed[0].sourceJavascriptSha256 = "sha256:" + "0".repeat(64);
  const mismatch = apply(source, draft, changed);
  assert.equal(mismatch.audits[0].reason, "source_sha_mismatch");
  const bound = { ...source, migrationPolicies: { version: 1, decisions } };
  const altered = applyApprovedAuxiliaryPolicies(bound, draft, [{ ...decisions[0], replacementReadFieldId: "fd_kind" }]);
  assert.equal(altered.audits[0].reason, "approved_manifest_missing_or_changed");
  assert.deepEqual({ source, draft }, original);
});

it("retires only absent declared auxiliary storage/required calls and preserves action and source identities", () => {
  const { source, draft } = stages(), before = structuredClone({ source, draft }), file = directory + "route-approved-retirement_SysFormTemplate.xml", bytes = fs.readFileSync(file);
  const result = apply(source, draft, decisionsFor(source));
  assert.deepEqual({ source, draft }, before); assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(result.changedActionIds.length, 3); assert.deepEqual(result.draft.form, draft.form);
  assert.deepEqual(result.audits.map(a => a.status), ["applied", "applied"]);
  for (const [index, action] of result.draft.scripts.actions.entries()) {
    const old = draft.scripts.actions[index];
    assert.equal(action.translationStatus, "mapped"); assert.equal(action.id, old.id);
    assert.equal(action.sourceActionKey, old.sourceActionKey); assert.deepEqual(action.sourceRefs, old.sourceRefs);
    assert.equal(action.event, old.event); assert.equal(action.controlId, old.controlId);
    assert.doesNotMatch(action.function, /fd_retired_flag|fd_retired_note|SetXFormFieldValueById|common_not_required/);
    assert.equal(action.coverage.status, "translated"); assert.deepEqual(action.coverage.residuals, []);
  }
  assert.match(result.draft.scripts.actions[0].function, /MKXFORM\.getValue\("fd_permission"\)/);
  assert.match(source.scripts.sources[0].javascript, /fd_retired_flag/);
  for (const audit of result.audits) {
    assert.equal(audit.originalSourcePreserved, true); assert.match(audit.normalizedSourceJavascriptSha256, /^sha256:/);
    for (const range of audit.originalCallbacks) assert.ok(range.end > range.start);
    for (const rewrite of audit.rewrites) assert.ok(rewrite.end > rewrite.start && rewrite.originalSha256 !== rewrite.replacementSha256);
  }
});

it("changes only the approved delayed current reads and retains both later callbacks exactly", () => {
  const { source, draft } = stages("selected-reads"), original = structuredClone(source), result = apply(source, draft, decisionsFor(source, "selected-reads"));
  assert.deepEqual(source, original); assert.deepEqual(result.draft.form, draft.form);
  assert.deepEqual(result.changedActionIds, [draft.scripts.actions[0].id]);
  assert.deepEqual(result.draft.scripts.actions.slice(1), draft.scripts.actions.slice(1));
  const load = result.draft.scripts.actions[0]; assert.equal(load.translationStatus, "mapped");
  assert.match(load.function, /510/); assert.doesNotMatch(load.function, /\.val\(/);
  assert.deepEqual(result.audits[0].approvedScalarReadFieldIds, ["fd_unit", "fd_plan"]);
  assert.equal(result.audits[0].rewrites.length, 2); assert.equal(result.audits[0].originalCallbacks.length, 3);
  assert.equal(draft.scripts.actions[0].translationStatus, "needs_review");
});

it("preserves the 510ms timer, all 13 initial hides and each later company/fund branch", () => {
  const { source, draft } = stages("selected-reads"), result = apply(source, draft, decisionsFor(source, "selected-reads")), load = result.draft.scripts.actions[0];
  const markers = [...Array.from({ length: 11 }, (_, i) => "section" + (i + 1) + "_row"), "outsideadvance_row", "serviceadvance_row"];
  for (const unit of ["S1", "S2", ...Array.from({ length: 11 }, (_, i) => "U" + (i + 1)), "", "unknown"]) for (const plan of ["P", "Q", "R", ""]) {
    let state = { fd_unit: "old", fd_plan: "old" }; const trace = [], timers = [];
    const fn = vm.runInNewContext("(" + load.function + ")", {
      MKXFORM: { getValue(id) { trace.push(["read", id]); return state[id]; }, setFieldAttr(id, attr) { trace.push(["attr", id, attr]); } },
      setTimeout(fn, delay) { trace.push(["schedule", delay]); timers.push(fn); }
    });
    fn(); assert.deepEqual(trace, [["schedule", 510]]);
    state = { fd_unit: unit, fd_plan: plan }; timers.shift()();
    const expected = [["schedule", 510], ...markers.flatMap(id => [["attr", canonicalRowTarget(draft.form, id), 4], ["attr", canonicalRowTarget(draft.form, id), 6]]), ["read", "fd_unit"], ["read", "fd_plan"]];
    if (["P", "Q"].includes(plan)) { const row = ["S1", "S2"].includes(unit) ? "serviceadvance_row" : "outsideadvance_row"; expected.push(["attr", canonicalRowTarget(draft.form, row), 5], ["attr", canonicalRowTarget(draft.form, row), 6]); }
    if (/^U(?:[1-9]|10|11)$/.test(unit)) { const row = "section" + unit.slice(1) + "_row"; expected.push(["attr", canonicalRowTarget(draft.form, row), 5], ["attr", canonicalRowTarget(draft.form, row), 3]); }
    assert.deepEqual(trace, expected, unit + "/" + plan);
  }
});

for (const [name, edit] of [
  ["new live source field", (source) => { source.form.controls.push({ id: "fd_retired_flag", sourceRef: "declared", sourceType: "inputText" }); }],
  ["new target field", (_source, draft) => { draft.form.fields.push({ id: "fd_retired_flag", type: "text", componentId: "xform-input" }); }],
  ["metadata alias", (_source, draft) => { draft.form.fields[0].sourceProps.originalId = "fd_retired_flag"; }],
  ["layout marker", (_source, draft) => { draft.form.layout.sourceGrid.rows[0].sourceMarkers = ["fd_retired_flag"]; }],
  ["unproved replacement", (_source, draft) => { draft.form.fields.find(f => f.id === "fd_permission").sourceProps.metadataAttributes.type = "Number"; }],
  ["duplicate replacement", (_source, draft) => { draft.form.fields.push(structuredClone(draft.form.fields.find(f => f.id === "fd_permission"))); }],
  ["handle escape", source => { source.scripts.sources[0].javascript = source.scripts.sources[0].javascript.replace("if(old.value", "unknown(old);if(old.value"); }],
  ["mixed read/write handle", source => { source.scripts.sources[0].javascript = source.scripts.sources[0].javascript.replace('if(old.value', 'old.value="YES";if(old.value'); }],
  ["undeclared selector", source => { source.scripts.sources[0].javascript += '\nunknown("fd_retired_flag");'; }],
  ["effectful setter", source => { source.scripts.sources[0].javascript = source.scripts.sources[0].javascript.replace('"fd_retired_flag","YES"', '"fd_retired_flag",unknown()'); }],
  ["global helper replacement", source => { source.scripts.sources.push({ id: "other", sourceRef: "other", javascript: "SetXFormFieldValueById=function(){};" }); }],
  ["cross-source row helper replacement", source => { source.scripts.sources.push({ id: "other", sourceRef: "other", javascript: "common_dom_row_set_show_required_reset=function(){};" }); }],
  ["cross-source Array replacement", source => { source.scripts.sources.push({ id: "other", sourceRef: "other", javascript: "Array=unknown;" }); }]
]) it("does not silently retire or rebind " + name, () => {
  const { draft, result } = mutateSource(edit);
  assert.equal(result.audits[0].status, "rejected", JSON.stringify(result.audits));
  assert.deepEqual(result.draft.scripts.actions.slice(0, 2), draft.scripts.actions.slice(0, 2));
});

it("keeps an unknown sibling effect pending rather than dropping it", () => {
  const { draft, result } = mutateSource(source => { source.scripts.sources[0].javascript = source.scripts.sources[0].javascript.replace("function(){var old", "function(){unknownEffect();var old"); });
  assert.equal(result.audits[0].status, "pending"); assert.equal(result.audits[0].reason, "callback_not_completely_owned");
  assert.deepEqual(result.draft.scripts.actions.slice(0, 2), draft.scripts.actions.slice(0, 2));
});

it("composes only existing audited orphan normalization after the approved auxiliary rewrite", () => {
  const { source, draft } = stages("retirement-orphan");
  const before = structuredClone({ source, draft }), result = apply(source, draft, decisionsFor(source));
  assert.equal(result.audits[0].status, "applied", JSON.stringify(result.audits));
  assert.deepEqual({ source, draft }, before);
  const audit = result.audits[0], normalized = audit.orphanRowNormalization;
  assert.deepEqual(normalized.markers.map(marker => marker.rowId), ["orphan_unbound_row"]);
  assert.equal(normalized.sourceJavascriptSha256, audit.normalizedSourceJavascriptSha256.slice(7));
  assert.equal(normalized.normalizedJavascriptSha256, audit.compilerSourceJavascriptSha256.slice(7));
  assert.notEqual(audit.sourceJavascriptSha256, audit.normalizedSourceJavascriptSha256);
  assert.doesNotMatch(result.draft.scripts.actions[0].function, /orphan_unbound_row|fd_retired_flag/);
});

for (const [name, edit] of [
  ["object field", (_source, draft) => { draft.form.fields[0].sourceProps.metadataKind = "element"; }],
  ["multi selection", (_source, draft) => { draft.form.fields[0].props.multiple = true; }],
  ["checked selector outside approved exact shape", source => { source.scripts.sources[0].javascript = source.scripts.sources[0].javascript.replace('value(fd_unit)\"]', 'value(fd_unit)\"]:checked'); }],
  ["cross-source dollar mutation", source => { source.scripts.sources.push({ id: "other", sourceRef: "other", javascript: "$=unknown;" }); }]
]) it("keeps selected String approval narrow for " + name, () => {
  const { result } = mutateSource(edit, "selected-reads");
  assert.equal(result.changedActionIds.length, 0); assert.notEqual(result.audits[0].status, "applied");
});
