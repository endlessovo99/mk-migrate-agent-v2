import assert from "node:assert/strict";
import { it } from "node:test";
import { draftSourceDraft } from "../../src/translator/index.js";
// These width assertions cover retained SourceDrafts and their standalone native caption layouts.
import { cleanSourceWithoutCaptionFact as cleanSourceFile } from "../helpers/retained-caption-source.js";
import { applyFormPayload } from "../../src/executor/persistence/form-writer.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { sourceMobileCaptionGrids } from "../../src/dsl/source-mobile-caption-grid.js";
import { readFileSync } from "node:fs";
import { parseSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { runtimeCaptionWidthEvidence } from "../../src/translator/runtime-caption-width.js";

const dir = "tests/fixtures/route-validation/mobile-plain-caption/";
const fixture = name => `${dir}${name === "base" ? "mobile-plain-caption" : name}_SysFormTemplate.xml`;
const draft = (name = "base") => draftSourceDraft(cleanSourceFile(fixture(name)));
const viewOf = template => JSON.parse(JSON.parse(template.mechanisms["sys-xform"].fdConfig).viewModel[0].fdConfig);
const rowsOf = (view, scene) => view.view.render[scene][0].children[0].children;
const gridOf = row => row.children.find(node => node.type === "@elem/layout-grid");
const geometry = grid => ({ rows: grid.controlProps.rows, columns: grid.controlProps.columns,
  children: grid.children.map(cell => ({ key: cell.key, props: cell.controlProps })) });
const project = dsl => applyFormPayload({ fdId: "template-id", fdName: "MK_TEST_PLAIN_CAPTION", fdTableName: "source_caption_table" }, dsl);

it("uses real source XML static captions and independently fixed source controls without adding DSL budgets", () => {
  const source = cleanSourceFile(fixture("base")), dsl = draft();
  assert.equal(source.form.layout.rows.length, 3);
  assert.equal(dsl.scripts?.actions?.length || 0, 0);
  const expected = [["caption_department", "fd_department", "xform-address", 200],
    ["caption_reason", "fd_reason", "xform-input", 200], ["caption_choice", "fd_choice", "xform-radio", 76]];
  for (const [captionId, fieldId, componentId, width] of expected) {
    const caption = dsl.form.fields.find(field => field.id === captionId), field = dsl.form.fields.find(field => field.id === fieldId);
    assert.equal(caption.componentId, "xform-description");
    assert.equal(caption.sourceProps.designerType, "textLabel");
    assert.equal(caption.dataOnly, undefined);
    assert.equal(field.componentId, componentId);
    const row = dsl.form.layout.mkTree.find(row => row.children.some(cell => cell.refIds.includes(captionId)));
    assert.equal(row.children.length, 2);
    assert.deepEqual(row.children[0].refIds, [captionId]);
    assert.equal(row.children[0].contentFlow.items[0].width, undefined);
    assert.deepEqual(row.children[1].contentFlow.items[0].width, { value: width, unit: "px" });
    assert.equal(row.children[1].colspan, 3);
  }
});

it("retains a fixed-source proof of the unique plain runtime-widthless captions at the DSL boundary", () => {
  const source = cleanSourceFile(fixture("base")), dsl = draft();
  for (const id of ["caption_department", "caption_reason", "caption_choice"]) {
    assert.equal(source.form.controls.find(field => field.id === id).sourceProps.runtimePlainCaption, true);
    assert.equal(dsl.form.fields.find(field => field.id === id).sourceProps.runtimePlainCaption, true);
  }
});

it("retains an already complete decorative-width proof with its real hidden helper sibling", () => {
  const path = fixture("legacy-hidden-companion"), template = parseSysFormTemplateXml(readFileSync(path, "utf8"));
  assert.equal(runtimeCaptionWidthEvidence(template.fdDesignerHtml, template.fdDisplayJsp).has("caption_department"), true,
    "The whole existing proof must hold before the new plain mode may reuse it");
  const source = cleanSourceFile(path), dsl = draftSourceDraft(source), hidden = structuredClone(dsl.form.fields.find(field => field.id === "fd_hidden"));
  assert.equal(source.form.dataFields.find(field => field.id === "fd_hidden").dataOnly, true);
  assert.equal(hidden.dataOnly, true);
  assert.deepEqual(hidden.props.defaultValue, { kind: "literal", value: "hidden-initial" });
  assert.equal(dsl.form.fields.find(field => field.id === "caption_department").sourceProps.runtimePlainCaption, true);
  assert.ok(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"));
  const prepared = prepareSample(dsl), config = xformConfig(prepared.update);
  assert.equal(config.dataModel[0].fdFields.find(field => field.fdName === "fd_hidden").fdDisplay, false);
  assert.deepEqual(dsl.form.fields.find(field => field.id === "fd_hidden"), hidden, "Do not remove or rewrite the source helper to obtain a caption proof");
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("does not reuse old decorative evidence when the additional non-rowspan boundary is unproved", () => {
  const path = fixture("legacy-hidden-rowspan"), template = parseSysFormTemplateXml(readFileSync(path, "utf8"));
  assert.equal(runtimeCaptionWidthEvidence(template.fdDesignerHtml, template.fdDisplayJsp).has("caption_department"), true);
  const dsl = draftSourceDraft(cleanSourceFile(path));
  assert.notEqual(dsl.form.fields.find(field => field.id === "caption_department").sourceProps.runtimePlainCaption, true);
  assert.equal(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"), false);
  assert.equal(dsl.form.fields.find(field => field.id === "fd_hidden").dataOnly, true);
  const view = viewOf(project(dsl)), pc = gridOf(rowsOf(view, "desktop")[0]), mobile = gridOf(rowsOf(view, "mobile")[0]);
  assert.deepEqual(mobile.controlProps.colsStyle, pc.controlProps.colsStyle);
  assert.deepEqual(mobile.controlProps.style, pc.controlProps.style);
});

for (const [index, kind] of ["address", "input", "radio"].entries()) it(`retains the ${kind} source grid and PC while mobile gains caption content minima`, () => {
  const dsl = draft(), before = structuredClone(dsl), prepared = prepareSample(dsl), view = viewOf(prepared.update);
  const projection = projectNativeLayoutRows(dsl.form.layout.mkTree)[index];
  const pc = gridOf(rowsOf(view, "desktop")[index]), mobile = gridOf(rowsOf(view, "mobile")[index]);
  assert.equal(projection.columns, 4);
  assert.deepEqual(pc.controlProps.colsStyle, projection.colsStyle);
  assert.equal(pc.controlProps.style, undefined);
  assert.deepEqual(mobile.controlProps.colsStyle, projection.colsStyle.map(style => ({
    ...style, value: `minmax(max-content, ${Number.parseFloat(style.value)}fr)`
  })));
  assert.deepEqual(mobile.controlProps.style, { overflowX: "auto" });
  assert.deepEqual(geometry(mobile), geometry(pc), "Keep source row, span3, position, owner and field order");
  assert.deepEqual(dsl, before, "No source-width, caption-content, options, permissions or script rewrite");
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("does not change existing field configurations, control styles or desktop content flow", () => {
  const dsl = draft(), prepared = prepareSample(dsl), config = xformConfig(prepared.update), view = viewOf(prepared.update);
  const sourceFields = new Map(dsl.form.fields.map(field => [field.id, field]));
  assert.deepEqual(view.controlStyle, {
    fd_reason: { desktop: { paddingControl: { top: "8px", right: "0px", bottom: "8px", left: "0px" } } },
    fd_choice: { desktop: { paddingControl: { top: "8px", right: "0px", bottom: "8px", left: "0px" } } }
  }, "Keep the existing desktop source-content padding; do not invent mobile field sizing");
  for (const id of ["fd_department", "fd_reason", "fd_choice"]) {
    const field = config.dataModel[0].fdFields.find(field => field.fdName === id), props = JSON.parse(field.fdAttribute).config.controlProps;
    assert.equal(props.readOnly === true, sourceFields.get(id).props.readOnly === true);
    assert.equal(props.required === true, sourceFields.get(id).props.required === true);
    if (id === "fd_choice") assert.deepEqual(props.options.map(option => option.value), ["Y", "N"]);
  }
  for (let index = 0; index < 3; index++) assert.deepEqual(
    rowsOf(view, "desktop")[index].children[0].children.map(cell => cell.controlProps.migrationFieldIds),
    projectNativeLayoutRows(dsl.form.layout.mkTree)[index].cells.map(cell => cell.refIds)
  );
});

for (const [name, change] of [
  ["caption minima", (pc, mobile) => { mobile.controlProps.colsStyle = structuredClone(pc.controlProps.colsStyle); }],
  ["scroll access", (_pc, mobile) => { delete mobile.controlProps.style; }],
  ["hidden overflow", (_pc, mobile) => { mobile.controlProps.style = { overflowX: "hidden" }; }],
  ["source colspan", (_pc, mobile) => { mobile.children[1].controlProps.columnSpan = 2; }],
  ["source position", (_pc, mobile) => { mobile.children[0].controlProps.column = 2; }],
  ["source row count", (_pc, mobile) => { mobile.controlProps.rows = 2; }],
  ["oversized row style", (_pc, mobile) => { mobile.controlProps.rowsStyle = [{ startIndex: 0, count: 1, value: "10000px" }]; }]
]) it(`rejects native mobile ${name} loss through the actual persistence contract`, () => {
  const prepared = prepareSample(draft()), changed = structuredClone(prepared.update), config = xformConfig(changed);
  const view = JSON.parse(config.viewModel[0].fdConfig), pc = gridOf(rowsOf(view, "desktop")[0]), mobile = gridOf(rowsOf(view, "mobile")[0]);
  const before = structuredClone(mobile); change(pc, mobile);
  assert.notDeepEqual(mobile, before, "The readback counterexample must change the native request");
  config.viewModel[0].fdConfig = JSON.stringify(view);
  changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  const checked = prepared.verify(changed);
  assert.equal(checked.ok, false);
  assert.ok(checked.diagnostics.some(item => item.code === "readback.form.mobile_grid_mismatch"));
});

it("preserves a static body heading beside its real address in the final merged cell", () => {
  const dsl = draft("multiple-captions"), before = structuredClone(dsl), prepared = prepareSample(dsl), view = viewOf(prepared.update);
  const pc = gridOf(rowsOf(view, "desktop")[0]), mobile = gridOf(rowsOf(view, "mobile")[0]);
  assert.deepEqual(mobile.controlProps.colsStyle, pc.controlProps.colsStyle.map((style, index) => index === 0
    ? { ...style, value: `minmax(max-content, ${Number.parseFloat(style.value)}fr)` } : style));
  assert.deepEqual(mobile.controlProps.colsStyle.slice(1), pc.controlProps.colsStyle.slice(1));
  assert.deepEqual(mobile.controlProps.style, { overflowX: "auto" });
  assert.deepEqual(mobile.children, pc.children);
  assert.deepEqual(geometry(mobile), geometry(pc));
  assert.deepEqual(dsl, before);
  assert.deepEqual(dsl.form.layout.mkTree[0].children[1].refIds, ["caption_extra", "fd_department"]);
  assert.equal(dsl.form.fields.find(field => field.id === "caption_extra").props.content, "附加标题");
  for (const index of [1, 2]) {
    const original = gridOf(rowsOf(view, "desktop")[index]), current = gridOf(rowsOf(view, "mobile")[index]);
    assert.deepEqual(current.controlProps.colsStyle, original.controlProps.colsStyle.map(style => ({ ...style,
      value: `minmax(max-content, ${Number.parseFloat(style.value)}fr)` })));
    assert.deepEqual(current.children, original.children);
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
});

for (const name of ["no-caption", "fixed-caption", "styled-caption", "rich-caption", "dynamic-caption", "hidden-caption",
  "mixed-caption-cell", "unknown-widths", "auto-editor", "duplicate-caption", "unknown-appearance", "metadata-width", "nested-caption", "rowspan-caption"])
  it(`keeps the existing grid for the unproved ${name} source`, () => {
    const dsl = draft(name), view = viewOf(project(dsl));
    const pc = gridOf(rowsOf(view, "desktop")[0]), mobile = gridOf(rowsOf(view, "mobile")[0]);
    assert.deepEqual(mobile.controlProps.colsStyle, pc.controlProps.colsStyle);
    assert.deepEqual(mobile.controlProps.style, pc.controlProps.style);
    assert.deepEqual(geometry(mobile), geometry(pc));
  });

it("keeps a real source DOM caption mutation reviewable rather than treating untrusted projection as execution", () => {
  const source = cleanSourceFile(fixture("script-caption")), dsl = draftSourceDraft(source);
  assert.ok(source.scripts.sources.some(item => item.javascript.includes("caption_department") && item.javascript.includes("innerHTML")));
  assert.ok(dsl.scripts.actions.some(action => action.translationStatus === "needs_review"));
  // A source draft may legitimately contain pending actions. Exercise the
  // executable public trust gate with explicit synthetic/unreviewed binding.
  const checked = checkTrust(source, createTrustedMigrationDsl(source, dsl, {
    externalAgentReviewed: true, reviewerName: "synthetic mobile caption boundary"
  }));
  assert.equal(checked.ok, false);
  assert.ok(checked.diagnostics.some(item => item.code === "dsl.scripts.needs_review"), JSON.stringify(checked.diagnostics));
});

for (const name of ["duplicate-caption", "unknown-appearance"]) it(`rejects candidate source-proof laundering for ${name}`, () => {
  const source = cleanSourceFile(fixture(name)), dsl = draftSourceDraft(source);
  const caption = dsl.form.fields.find(field => field.id === "caption_department");
  assert.notEqual(source.form.controls.find(field => field.id === caption.id).sourceProps.runtimePlainCaption, true);
  caption.sourceProps.runtimePlainCaption = true;
  const trusted = checkTrust(source, createTrustedMigrationDsl(source, dsl, {
    externalAgentReviewed: true, reviewerName: "synthetic negative source-proof probe"
  }));
  assert.equal(trusted.ok, false);
  assert.ok(trusted.diagnostics.some(item => /mobile.*caption|caption.*source/.test(item.code)), JSON.stringify(trusted.diagnostics));
  const applied = applyEvidenceBackedPatches(dsl, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
  assert.equal(applied.ok, false);
  assert.ok(applied.diagnostics.some(item => /mobile.*caption|caption.*source/.test(item.code)), JSON.stringify(applied.diagnostics));
});

for (const [name, change] of [
  ["deleted proof", dsl => { delete dsl.form.fields.find(field => field.id === "caption_department").sourceProps.runtimePlainCaption; }],
  ["false proof", dsl => { dsl.form.fields.find(field => field.id === "caption_department").sourceProps.runtimePlainCaption = false; }],
  ["caption content", dsl => { dsl.form.fields.find(field => field.id === "caption_department").props.content = "Changed caption"; }],
  ["caption metadata title", dsl => { dsl.form.fields.find(field => field.id === "caption_department").title = "Changed metadata"; }],
  ["caption appearance", dsl => { dsl.form.fields.find(field => field.id === "caption_department").props.style = { color: "red" }; }],
  ["field identity", dsl => { dsl.form.fields.find(field => field.id === "fd_department").sourceProps.designerId = "fd_reason"; }],
  ["field default", dsl => { dsl.form.fields.find(field => field.id === "fd_reason").props.defaultValue = { kind: "literal", value: "invented" }; }],
  ["source and mapped width", dsl => {
    dsl.form.fields.find(field => field.id === "fd_department").sourceProps.designerValues.width = "180";
    dsl.form.layout.sourceGrid.rows[0].cells[1].contentFlow.items[0].width.value = 180;
    dsl.form.layout.mkTree[0].children[1].contentFlow.items[0].width.value = 180;
  }],
  ["source and mapped column weights", dsl => {
    dsl.form.layout.sourceGrid.rows[0].cells[0].widthWeight += 100;
    dsl.form.layout.mkTree[0].children[0].widthWeight += 100;
  }],
  ["source and mapped order", dsl => {
    dsl.form.layout.sourceGrid.rows[0].cells.reverse(); dsl.form.layout.mkTree[0].children.reverse();
  }],
  ["source and mapped cell identity", dsl => {
    dsl.form.layout.sourceGrid.rows[0].cells[0].sourceRef += ".changed";
    dsl.form.layout.mkTree[0].children[0].sourceRef += ".changed";
  }]
]) it(`rejects ${name} washing at both fixed-source public boundaries`, () => {
  const source = cleanSourceFile(fixture("base")), dsl = draftSourceDraft(source), before = structuredClone(dsl);
  change(dsl); assert.notDeepEqual(dsl, before, "The negative must actually mutate its source-bound candidate");
  const trusted = checkTrust(source, createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true, reviewerName: "synthetic negative source row probe" }));
  assert.equal(trusted.ok, false);
  assert.ok(trusted.diagnostics.some(item => item.code === "trust.form.mobile_plain_caption_source_mismatch"), JSON.stringify(trusted.diagnostics));
  const applied = applyEvidenceBackedPatches(dsl, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
  assert.equal(applied.ok, false);
  assert.ok(applied.diagnostics.some(item => item.code === "agent.patch.form.mobile_plain_caption_source_mismatch"), JSON.stringify(applied.diagnostics));
});

it("retains ordinary equivalent false defaults without changing caption proof or layout", () => {
  const source = cleanSourceFile(fixture("base")), dsl = draftSourceDraft(source);
  for (const field of dsl.form.fields.filter(field => ["xform-input", "xform-address", "xform-radio"].includes(field.componentId))) {
    field.props.required = false; field.props.readOnly = false;
  }
  const checked = checkTrust(source, createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true, reviewerName: "synthetic equivalent defaults" }));
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
});

it("keeps source long identities reversible through the existing field-id remap", () => {
  const source = cleanSourceFile(fixture("long-caption-identity")), dsl = draftSourceDraft(source);
  const caption = dsl.form.fields.find(field => field.sourceProps.originalId === "caption_department_with_long_source_identity");
  assert.ok(caption.id.length <= 25);
  assert.equal(caption.sourceRef, "source.form.control.caption_department_with_long_source_identity");
  assert.equal(caption.sourceProps.runtimePlainCaption, true);
  assert.ok(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"));
  const prepared = prepareSample(dsl); assert.equal(prepared.verify(prepared.update).ok, true);
  assert.equal(checkTrust(source, createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true, reviewerName: "synthetic long identity" })).ok, true);
});

it("preserves source row visibility and required rules without confusing them with caption text writes", () => {
  const source = cleanSourceFile(fixture("visibility-caption")), dsl = draftSourceDraft(source), before = structuredClone(dsl.formRules);
  assert.ok(dsl.formRules.linkage.some(rule => rule.translationStatus === "executable" &&
    rule.effects.some(effect => effect.type === "visible") && rule.effects.some(effect => effect.type === "required")));
  assert.ok(dsl.scripts.actions.every(action => action.translationStatus === "omitted" && action.coverage.residuals.length === 0));
  assert.ok(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"));
  const prepared = prepareSample(dsl); assert.equal(prepared.verify(prepared.update).ok, true);
  assert.deepEqual(dsl.formRules, before);
  const checked = checkTrust(source, createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true, reviewerName: "synthetic source row rule" }));
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
});

for (const [name, change] of [
  ["data-only caption", dsl => { dsl.form.fields.find(field => field.id === "caption_department").dataOnly = true; }],
  ["missing source identity", dsl => { delete dsl.form.fields.find(field => field.id === "caption_department").sourceProps.designerId; }],
  ["single column", dsl => { const row = dsl.form.layout.mkTree[0]; row.props.columns = 1; row.children = [row.children[0]]; }],
  ["unproved source track", dsl => { delete dsl.form.layout.mkTree[0].children[0].widthWeight; }]
]) it(`does not grant mobile caption geometry to ${name}`, () => {
  const dsl = draft(); change(dsl);
  const view = viewOf(project(dsl)), pc = gridOf(rowsOf(view, "desktop")[0]), mobile = gridOf(rowsOf(view, "mobile")[0]);
  assert.deepEqual(mobile.controlProps.colsStyle, pc.controlProps.colsStyle);
  assert.deepEqual(mobile.controlProps.style, pc.controlProps.style);
});

it("completes the source review, draft-only fake write, readback and record route", async () => {
  const result = await runRouteCase("mobile-plain-caption-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.transferRecord.status, "recorded");
});
