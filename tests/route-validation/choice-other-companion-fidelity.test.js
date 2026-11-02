import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";
import { runAgentReview } from "../../src/agent-review/index.js";

const dir = "tests/fixtures/route-validation/choice-other-companion-fidelity";
const path = name => `${dir}/${name}_SysFormTemplate.xml`;
const stages = name => { const source = cleanSourceFile(name === "main-radio" ? "tests/fixtures/route-validation/native-radio-other/native-radio-other_SysFormTemplate.xml" : path(name)); return { source, draft: draftSourceDraft(source) }; };
const all = draft => draft.form.fields.flatMap(f => f.type === "detailTable" ? f.columns : [f]);
const field = (draft, id) => all(draft).find(f => f.id === id);
const sourceFields = source => [...source.form.controls, ...(source.form.detailTables || []).flatMap(t => t.columns)];
const old = JSON.parse(readFileSync(`${dir}/unsafe-legacy-folded-drafts.json`)).items;
const trust = (source, draft) => checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true, reviewerName: "synthetic independent choice companion fidelity" }));
const nativeField = (config, id) => config.dataModel.flatMap(m => m.fdFields || []).find(f => f.fdName === id);
function referenced(node, id) {
  if (!node || typeof node !== "object") return false;
  if (node.key === id) return true;
  return Object.values(node).some(v => Array.isArray(v) ? v.some(n => referenced(n, id)) : referenced(v, id));
}

for (const name of ["main-checkbox", "main-checkbox-existing", "main-radio"]) {
  it(`maps the source Other to the MK native option while retaining ordinary codes: ${name}`, () => {
    const { source, draft } = stages(name);
    const original = sourceFields(source).find(f => f.id === "fd_choice");
    assert.equal(original.options.length, 2, "The fixture must contain two distinct source codes");
    assert.deepEqual(original.options.map(o => o.value), name === "main-checkbox" ? ["A", "B"] : ["A", "O_CODE"]);
    const options = field(draft, "fd_choice").props.options;
    const regular = original.options.filter(option => !/^(其他|其它)[:：]?$/u.test(option.label));
    assert.deepEqual(options.slice(0, -1), regular);
    assert.equal(options.at(-1).type, "other");
    assert.equal(options.at(-1).value, "other_");
  });
  it(`uses MK Other and retains source text and caption as data-only evidence: ${name}`, () => {
    const { source, draft } = stages(name), text = field(draft, "fd_other_text"), caption = field(draft, "fd_other_caption");
    assert.equal(sourceFields(source).find(f => f.id === "fd_other_text").required, false);
    assert.ok(text && caption);
    assert.equal(text.dataOnly, true);
    assert.equal(caption.dataOnly, true);
    assert.equal(text.sourceRef, "source.form.control.fd_other_text");
    assert.notEqual(text.props.required, true);
    assert.equal(text.props.readOnly === true, false);
    assert.deepEqual(text.props.defaultValue, { kind: "literal", value: "seed_under_score" });
    assert.equal(draft.scripts?.actions?.length || 0, 0, "No new clearing, mirroring or restore handlers may be invented");
  });
  it(`projects original source fields with compatible Other presentation: ${name}`, () => {
    const { source, draft } = stages(name), prepared = prepareSample(draft), config = xformConfig(prepared.update);
    const choice = nativeField(config, "fd_choice"), text = nativeField(config, "fd_other_text"), caption = nativeField(config, "fd_other_caption");
    assert.equal(choice.fdDisplay, true);
    assert.equal(text.fdDisplay, false);
    assert.equal(text.fdIsStored, true);
    assert.equal(caption.fdDisplay, false);
    const props = JSON.parse(text.fdAttribute).config.controlProps;
    assert.equal(props.defaultValueType, "formula");
    assert.equal(JSON.parse(props.defaultValueFormulaVO.script), "seed_under_score");
    assert.equal(props.showStatus === "readOnly", false);
    assert.ok(props.required !== true);
    assert.equal(props.controlActions, undefined);
    const view = JSON.parse(config.viewModel[0].fdConfig);
    for (const platform of ["desktop", "mobile"]) {
      assert.ok(referenced(view.view.render[platform], "fd_choice"));
      assert.equal(referenced(view.view.render[platform], "fd_other_text"), false);
      assert.equal(referenced(view.view.render[platform], "fd_other_caption"), false);
    }
    assert.equal(trust(source, draft).ok, true);
    assert.equal(prepared.verify(prepared.update).ok, true);
  });
  it(`refuses the retained incomplete fold despite external reviewer metadata: ${name}`, () => {
    const { source } = stages(name), legacy = structuredClone(old.find(item => item.name === name).draft);
    assert.equal(trust(source, legacy).ok, false);
  });
  it(`refuses an option patch that restores the old invented/replaced value: ${name}`, () => {
    const { source, draft } = stages(name), original = old.find(item => item.name === name).draft;
    const index = draft.form.fields.findIndex(f => f.id === "fd_choice"), owner = draft.form.fields[index];
    const result = applyEvidenceBackedPatches(draft, [{ op: "replace", path: `/form/fields/${index}/props`, value: { options: field(original, "fd_choice").props.options }, sourceRefs: [owner.sourceRef], evidence: ["Negative only: source labels/codes and companion identity must not be replaced by a composite encoding."], confidence: .99, rationale: "Retained old fold is not source equivalence." }], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(d => d.code === "agent.patch.form.choice_other_companion_source_mismatch"));
  });
}
it("blocks an editable choice whose source Other text is readonly", () => {
  const source = cleanSourceFile(path("main-radio")), draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.find(field => field.id === "fd_choice").nativeOther, undefined);
  assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "source.form.native_other_checkbox_unproven"));
});
it("retains ordinary non-companion checkbox behavior and source codes", () => {
  const { source, draft } = stages("main-checkbox"), original = sourceFields(source).find(f => f.id === "fd_plain");
  assert.equal(original.sourceProps.otherTextCompanion, undefined);
  assert.deepEqual(field(draft, "fd_plain").props.options, original.options);
  assert.notEqual(field(draft, "fd_plain").dataOnly, true);
});
it("does not grant a native compound detail column merely because an independent input exists", () => {
  const { source, draft } = stages("detail-checkbox"), table = source.form.detailTables[0];
  assert.ok(table.columns.find(f => f.id === "fd_choice").sourceProps.otherTextCompanion);
  assert.ok(table.columns.find(f => f.id === "fd_other_text"));
  const result = checkDraft(draft);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(d => d.code === "source.form.choice_other_detail_layout_unproven"));
});
it("rebuilds the unsupported detail source even if a candidate removes its review errors", () => {
  const { source, draft } = stages("detail-checkbox"), changed = structuredClone(draft);
  delete changed.review.errors;
  const result = trust(source, changed);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(d => d.code === "trust.form.choice_other_detail_layout_unproven"));
});
it("does not accept a polluted detail input draft at public apply", () => {
  const { source, draft } = stages("detail-checkbox"), changed = structuredClone(draft);
  delete changed.review.errors;
  const result = applyEvidenceBackedPatches(changed, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(d => d.code === "agent.patch.form.choice_other_detail_layout_unproven"));
});
for (const caseId of ["choice-other-independent-main-success", "choice-other-independent-radio-success"]) {
  it("completes the guarded fake route with independent source fields: " + caseId, async () => {
    const result = await runRouteCase(caseId);
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.transferRecord.status, "recorded");
    assert.equal(field(result.dsl, "fd_other_text").dataOnly, true);
  });
}
it("blocks the existing compound detail fixture before transport", async () => {
  const result = await runRouteCase("checkbox-other-option-detail-blocked-before-transport");
  assert.equal(result.review.stage, "agent-review.input");
  assert.equal(result.execution, undefined);
  assert.deepEqual(result.transcript, []);
});

for (const [name, mutate] of [
  ["rendered source text", draft => field(draft, "fd_other_text").dataOnly = false],
  ["rendered source caption", draft => field(draft, "fd_other_caption").dataOnly = false],
  ["removed source text", draft => draft.form.fields = draft.form.fields.filter(f => f.id !== "fd_other_text")],
  ["replaced source option code", draft => field(draft, "fd_choice").props.options[1].value = "other_"],
  ["added composite option", draft => field(draft, "fd_choice").props.options.push({ label: "Other", value: "other_", type: "other" })],
  ["invented conditional requirement", draft => field(draft, "fd_other_text").props.required = true],
  ["invented readonly", draft => field(draft, "fd_other_text").props.readOnly = true],
  ["changed initial text", draft => field(draft, "fd_other_text").props.defaultValue = { kind: "literal", value: "changed" }],
  ["lost initial text", draft => delete field(draft, "fd_other_text").props.defaultValue],
  ["changed companion identity", draft => field(draft, "fd_other_text").sourceRef = "source.not-the-same-field"],
  ["removed relation metadata", draft => delete field(draft, "fd_choice").sourceProps.otherTextCompanion]
]) it("rejects fixed-source pair laundering: " + name, () => {
  const { source, draft } = stages("main-checkbox"), changed = structuredClone(draft);
  mutate(changed);
  const result = trust(source, changed);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(d => d.code === "trust.form.choice_other_companion_source_mismatch"));
});
it("rejects reinserting the consumed caption into the source presentation", () => {
  const { source, draft } = stages("main-checkbox"), changed = structuredClone(draft);
  let moved = false;
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.refIds) && node.refIds.includes("fd_choice")) {
      node.refIds.push("fd_other_caption");
      moved = true;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  }
  visit(changed.form.layout);
  assert.equal(moved, true);
  const result = trust(source, changed);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(d => d.code === "trust.form.choice_other_companion_source_mismatch"));
});
it("accepts equivalent false permission defaults without broadening source pair semantics", () => {
  const { source, draft } = stages("main-checkbox"), changed = structuredClone(draft);
  for (const id of ["fd_choice", "fd_other_text"]) {
    field(changed, id).props.required = false;
    field(changed, id).props.readOnly = false;
  }
  assert.equal(trust(source, changed).ok, true);
});
it("does not constrain unrelated non-companion permissions", () => {
  const { source, draft } = stages("main-checkbox"), changed = structuredClone(draft);
  field(changed, "fd_plain").props.readOnly = true;
  assert.equal(trust(source, changed).ok, true);
});
it("preserves a source code colliding with the native reserved branch and blocks it explicitly", () => {
  const xml = readFileSync(path("main-checkbox-existing"), "utf8").replaceAll("O_CODE", "other_");
  const temporary = mkdtempSync(join(tmpdir(), "source-choice-reserved-"));
  try {
    const file = join(temporary, "reserved_SysFormTemplate.xml"); writeFileSync(file, xml);
    const source = cleanSourceFile(file), draft = draftSourceDraft(source);
    assert.deepEqual(sourceFields(source).find(f => f.id === "fd_choice").options.map(o => o.value), ["A", "other_"]);
    assert.deepEqual(field(draft, "fd_choice").props.options.map(o => o.value), ["A", "other_"]);
    assert.equal(checkDraft(draft).ok, false);
    assert.ok(checkDraft(draft).diagnostics.some(d => d.code === "source.form.choice_other_reserved_value_unproven"));
    delete draft.review.errors;
    assert.ok(trust(source, draft).diagnostics.some(d => d.code === "trust.form.choice_other_reserved_value_unproven"));
    const applied = applyEvidenceBackedPatches(draft, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
    assert.ok(applied.diagnostics.some(d => d.code === "agent.patch.form.choice_other_reserved_value_unproven"));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

it("protects derived caption title metadata without claiming its visible content changed", () => {
  const { source, draft } = stages("main-checkbox"), changed = structuredClone(draft);
  field(changed, "fd_other_caption").title = "CHANGED_METADATA_TITLE";
  assert.equal(field(changed, "fd_other_caption").props.content, field(draft, "fd_other_caption").props.content);
  const result = trust(source, changed);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(d => d.code === "trust.form.choice_other_companion_source_mismatch"));
});
it("does not accept a metadata-only caption title patch at public apply", () => {
  const { source, draft } = stages("main-checkbox"), index = draft.form.fields.findIndex(f => f.id === "fd_other_caption");
  const applied = applyEvidenceBackedPatches(draft, [{ op: "replace", path: `/form/fields/${index}/title`, value: "CHANGED_METADATA_TITLE", sourceRefs: [draft.form.fields[index].sourceRef], evidence: ["Negative metadata integrity probe; visible content is unchanged."], confidence: .99, rationale: "Derived source title is part of the independent caption identity." }], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
  assert.equal(applied.ok, false);
  assert.ok(applied.diagnostics.some(d => d.code === "agent.patch.form.choice_other_companion_source_mismatch"));
});
for (const kind of ["detail", "reserved"]) it("blocks a known unsupported source before calling a provider: " + kind, async () => {
  let temporary, source, draft;
  if (kind === "detail") ({ source, draft } = stages("detail-checkbox"));
  else {
    temporary = mkdtempSync(join(tmpdir(), "before-provider-choice-"));
    const file = join(temporary, "reserved_SysFormTemplate.xml");
    writeFileSync(file, readFileSync(path("main-checkbox-existing"), "utf8").replaceAll("O_CODE", "other_"));
    source = cleanSourceFile(file); draft = draftSourceDraft(source);
  }
  let called = 0;
  try {
    const result = await runAgentReview(source, draft, { provider: {
      metadata() { return { provider: "source-contract-negative", baseUrl: "offline://not-called", model: "not-called" }; },
      async review() { called += 1; throw new Error("Provider must not be called for a fixed unsupported source"); }
    } });
    assert.equal(called, 0);
    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.input");
    assert.ok(result.report.diagnostics.some(d => d.code === `source.form.choice_other_${kind === "detail" ? "detail_layout" : "reserved_value"}_unproven`));
  } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
});
it("blocks the native reserved source code even on an ordinary choice without a companion", async () => {
  const xml = readFileSync(path("main-checkbox"), "utf8").replaceAll("One|P", "One|other_");
  const temporary = mkdtempSync(join(tmpdir(), "ordinary-choice-reserved-"));
  try {
    const file = join(temporary, "ordinary_SysFormTemplate.xml"); writeFileSync(file, xml);
    const source = cleanSourceFile(file), draft = draftSourceDraft(source);
    const original = sourceFields(source).find(f => f.id === "fd_plain");
    assert.equal(original.sourceProps.otherTextCompanion, undefined);
    assert.deepEqual(original.options.map(o => o.value), ["other_", "Q"]);
    assert.deepEqual(field(draft, "fd_plain").props.options.map(o => o.value), ["other_", "Q"]);
    const initial = checkDraft(draft);
    assert.equal(initial.ok, false);
    assert.ok(initial.diagnostics.some(d => d.code === "source.form.choice_other_reserved_value_unproven"));
    delete draft.review.errors;
    assert.ok(trust(source, draft).diagnostics.some(d => d.code === "trust.form.choice_other_reserved_value_unproven"));
    const applied = applyEvidenceBackedPatches(draft, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
    assert.equal(applied.ok, false);
    assert.ok(applied.diagnostics.some(d => d.code === "agent.patch.form.choice_other_reserved_value_unproven"));
    let called = false;
    const result = await runAgentReview(source, draft, { provider: { metadata: () => ({ provider: "source-negative", baseUrl: "offline://not-called", model: "not-called" }), async review() { called = true; throw new Error("Unexpected provider call"); } } });
    assert.equal(called, false);
    assert.equal(result.report.stage, "agent-review.input");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
