import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { draftSourceDraft } from "../../src/translator/index.js";
// These width assertions cover retained SourceDrafts and their standalone native caption layouts.
import { cleanSourceWithoutCaptionFact as cleanSourceFile } from "../helpers/retained-caption-source.js";
import { parseSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { runtimeCaptionWidthEvidence } from "../../src/translator/runtime-caption-width.js";
import { extractSysFormJspScripts } from "../../src/translator/sysform-jsp-scripts.js";
import { sourceMobileCaptionGrids } from "../../src/dsl/source-mobile-caption-grid.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { applyFormPayload } from "../../src/executor/persistence/form-writer.js";
import { mobileNumberGrid } from "../../src/executor/persistence/mobile-number-layout.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const dir = "tests/fixtures/route-validation/mobile-mixed-caption/";
const fixture = (name = "base") => `${dir}${name === "base" ? "mobile-mixed-caption" : name}_SysFormTemplate.xml`;
const sourceAndDraft = name => { const source = cleanSourceFile(fixture(name)); return { source, dsl: draftSourceDraft(source) }; };
const viewOf = update => JSON.parse(xformConfig(update).viewModel[0].fdConfig);
const rowsOf = (view, scene) => view.view.render[scene][0].children[0].children;
const gridOf = row => row.children.find(node => node.type === "@elem/layout-grid");
const project = dsl => applyFormPayload({ fdId: "template-id", fdName: "MK_TEST_MIXED_CAPTION", fdTableName: "mixed_source_table" }, dsl);
const geometry = grid => ({ rows: grid.controlProps.rows, columns: grid.controlProps.columns,
  children: grid.children.map(cell => ({ key: cell.key, props: cell.controlProps })) });
const hybrid = (styles, percentColumns = new Set([3, 4, 5])) => styles.map((style, index) => ({
  ...style, value: percentColumns.has(index) ? style.value : `minmax(max-content, ${Number.parseFloat(style.value)}fr)`
}));
const fieldOf = (dsl, id) => dsl.form.fields.find(field => field.id === id);
const walk = (node, predicate) => {
  if (predicate(node)) return node;
  for (const child of node.children || []) { const found = walk(child, predicate); if (found) return found; }
};
const textareaWrapper = grid => walk(grid.children[3], node => node.children?.some(child => child.key === "fd_reason"));
const syntheticTrust = (source, dsl) => checkTrust(source, createTrustedMigrationDsl(source, dsl, {
  externalAgentReviewed: true, reviewerName: "synthetic unreviewed mixed source-bound negative"
}));

it("starts with real XML fields, source spans, percent textarea, pure marker and stored helper", () => {
  const { source, dsl } = sourceAndDraft();
  assert.equal(source.form.layout.rows.length, 1);
  assert.equal(dsl.scripts?.actions?.length || 0, 0);
  assert.equal(fieldOf(dsl, "fd_reason").componentId, "xform-textarea");
  assert.equal(fieldOf(dsl, "fd_reason").type, "longText");
  assert.deepEqual(fieldOf(dsl, "fd_kind").props.options.map(option => option.value), ["Y", "N"]);
  const template = parseSysFormTemplateXml(readFileSync(fixture(), "utf8"));
  assert.equal(extractSysFormJspScripts(template).fragments[0].content,
    '<input type="hidden" id="opaque_state" name="opaque_state" value="retained-state"/>');
  const row = dsl.form.layout.mkTree[0];
  assert.equal(row.props.columns, 6);
  assert.deepEqual(row.children.map(cell => [cell.column, cell.colspan]), [[0, 1], [1, 1], [2, 1], [3, 3]]);
  assert.deepEqual(row.children.map(cell => cell.refIds), [["caption_kind"], ["fd_kind"], ["caption_reason"], ["fd_reason"]]);
  assert.deepEqual(row.children[3].contentFlow.items[0].width, { value: 90, unit: "%" });
  assert.equal(source.form.dataFields.find(field => field.id === "opaque_state").dataOnly, true);
  const hidden = fieldOf(dsl, "opaque_state");
  assert.equal(hidden.dataOnly, true);
  assert.deepEqual(hidden.props.defaultValue, { kind: "literal", value: "retained-state" });
  const prepared = prepareSample(dsl), config = xformConfig(prepared.update);
  const stored = config.dataModel[0].fdFields.find(field => field.fdName === "opaque_state");
  assert.equal(stored.fdDisplay, false); assert.equal(stored.fdIsStored, true);
  assert.equal(JSON.parse(stored.fdAttribute).config.controlProps.defaultValueFormulaVO.script, '"retained-state"');
  assert.equal(prepared.verify(prepared.update).ok, true, "Old native request is a valid setup, not an expected product failure");
});

for (const name of ["base", "without-marker", "fixed-input", "fixed-address", "readonly-textarea", "full-percent-textarea", "marker-no-value-no-metadata"])
  it(`preserves percent textarea tracks and all source geometry for ${name}`, () => {
    const { source, dsl } = sourceAndDraft(name), before = structuredClone(dsl);
    for (const id of ["caption_kind", "caption_reason"]) {
      assert.equal(fieldOf(dsl, id).sourceProps.runtimePlainCaption, true, "Complete raw source/runtime static proof must survive to DSL");
    }
    assert.ok(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"));
    const prepared = prepareSample(dsl), view = viewOf(prepared.update);
    const pc = gridOf(rowsOf(view, "desktop")[0]), mobile = gridOf(rowsOf(view, "mobile")[0]);
    const projection = projectNativeLayoutRows(dsl.form.layout.mkTree)[0];
    assert.deepEqual(pc.controlProps.colsStyle, projection.colsStyle);
    assert.equal(pc.controlProps.style, undefined);
    assert.deepEqual(mobile.controlProps.colsStyle, hybrid(projection.colsStyle));
    assert.deepEqual(mobile.controlProps.style, { overflowX: "auto" });
    assert.deepEqual(geometry(mobile), geometry(pc));
    assert.deepEqual(mobile.children, pc.children, "Keep every field wrapper, percent width, source span and order");
    assert.equal(textareaWrapper(mobile).controlProps.style.width, name === "full-percent-textarea" ? "100%" : "90%");
    assert.equal(fieldOf(dsl, "fd_reason").props.readOnly === true, name === "readonly-textarea");
    assert.deepEqual(dsl, before, "No source values/permissions/helper/default/rules/scripts rewrite");
    assert.equal(prepared.verify(prepared.update).ok, true);
    assert.equal(syntheticTrust(source, dsl).ok, true);
  });

it("grants multiple independent captions with all fixed ordinary controls, without admitting fixed textarea", () => {
  const { dsl } = sourceAndDraft("multiple-fixed-controls");
  assert.equal(fieldOf(dsl, "fd_reason").componentId, "xform-input");
  assert.ok(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"));
  const view = viewOf(prepareSample(dsl).update), pc = gridOf(rowsOf(view, "desktop")[0]), mobile = gridOf(rowsOf(view, "mobile")[0]);
  assert.deepEqual(mobile.controlProps.colsStyle, hybrid(pc.controlProps.colsStyle, new Set()));
  assert.deepEqual(mobile.controlProps.style, { overflowX: "auto" });
  assert.deepEqual(mobile.children, pc.children);
});

it("matches repeated hidden marker IDs per physical row without deleting the source helper", () => {
  const { source, dsl } = sourceAndDraft("repeated-marker-rows");
  const template = parseSysFormTemplateXml(readFileSync(fixture("repeated-marker-rows"), "utf8"));
  const fragments = extractSysFormJspScripts(template).fragments;
  assert.equal(fragments.length, 2);
  assert.equal(new Set(fragments.map(fragment => fragment.id)).size, 2);
  assert.equal(fragments[0].content, fragments[1].content);
  assert.equal(dsl.form.layout.mkTree.length, 2);
  const prepared = prepareSample(dsl), view = viewOf(prepared.update);
  for (let index = 0; index < 2; index++) {
    assert.ok(sourceMobileCaptionGrids(dsl.form).has(`layout.row-${index}`));
    const pc = gridOf(rowsOf(view, "desktop")[index]), mobile = gridOf(rowsOf(view, "mobile")[index]);
    assert.deepEqual(mobile.controlProps.colsStyle, hybrid(pc.controlProps.colsStyle));
    assert.deepEqual(mobile.children, pc.children);
  }
  assert.equal(dsl.form.fields.filter(field => field.id === "opaque_state").length, 1);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("does not expand the old decorative-width removal proof while adding pure marker plain evidence", () => {
  const template = parseSysFormTemplateXml(readFileSync(fixture(), "utf8"));
  assert.deepEqual([...runtimeCaptionWidthEvidence(template.fdDesignerHtml, template.fdDisplayJsp)], []);
  const { dsl } = sourceAndDraft();
  assert.equal(fieldOf(dsl, "caption_kind").sourceProps.runtimePlainCaption, true);
  assert.equal(dsl.form.layout.mkTree[0].children[0].contentFlow.items[0].width, undefined);
});

for (const name of ["marker-visible", "marker-extra-text", "marker-handler", "marker-script", "marker-extra-node", "marker-unknown-style",
  "marker-missing-fragment", "marker-runtime-missing", "marker-runtime-mismatch", "marker-same-cell-duplicate",
  "marker-wrapper-handler", "marker-icon-changed-handler", "marker-icon-extra-handler", "marker-wrapper-duplicate", "marker-metadata-mismatch", "marker-metadata-default-mismatch"])
  it(`does not grant a hidden-marker exception for ${name}`, () => {
    const { dsl } = sourceAndDraft(name);
    assert.notEqual(fieldOf(dsl, "caption_kind").sourceProps.runtimePlainCaption, true);
    assert.equal(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"), false);
    const view = viewOf(project(dsl)), pc = gridOf(rowsOf(view, "desktop")[0]), mobile = gridOf(rowsOf(view, "mobile")[0]);
    assert.deepEqual(mobile.controlProps.colsStyle, pc.controlProps.colsStyle);
    assert.deepEqual(mobile.controlProps.style, pc.controlProps.style);
  });

for (const name of ["marker-cross-row-borrow", "marker-one-counterpart-missing"])
  it(`does not borrow a marker from a different physical cell for ${name}`, () => {
    const { dsl } = sourceAndDraft(name);
    const profile = sourceMobileCaptionGrids(dsl.form);
    assert.equal(profile.has(name === "marker-cross-row-borrow" ? "layout.row-0" : "layout.row-1"), false);
    const id = name === "marker-cross-row-borrow" ? "caption_kind" : "caption_kind_second";
    assert.notEqual(fieldOf(dsl, id).sourceProps.runtimePlainCaption, true);
  });

for (const name of ["auto-textarea", "zero-percent", "excess-percent", "negative-percent", "unknown-percent", "multiple-captions-no-percent",
  "percent-input", "two-percent-textareas", "styled-caption", "rich-caption", "explicit-caption-width", "unknown-caption-appearance",
  "multi-reference", "rowspan", "overlap", "gap", "unknown-grid-weights", "nested-grid"])
  it(`keeps existing mobile policy outside the proven ${name} boundary`, () => {
    const { dsl } = sourceAndDraft(name);
    assert.equal(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"), false);
    const view = viewOf(project(dsl));
    assert.deepEqual(rowsOf(view, "mobile"), rowsOf(view, "desktop"), "Do not guess a width/minimum for an unproved source structure");
  });

it("retains real fragment script effects for public executable review instead of silently treating JSP as a marker", () => {
  const { source, dsl } = sourceAndDraft("marker-script");
  assert.ok(source.scripts.sources.some(item => item.javascript.includes("markerEffect")));
  assert.ok(dsl.scripts.actions.some(action => action.translationStatus === "needs_review"));
  const checked = syntheticTrust(source, dsl);
  assert.equal(checked.ok, false);
  assert.ok(checked.diagnostics.some(item => item.code === "dsl.scripts.needs_review"));
});

for (const [name, change] of [
  ["caption minimum", (pc, mobile) => { mobile.controlProps.colsStyle[0].value = pc.controlProps.colsStyle[0].value; }],
  ["percent textarea track", (_pc, mobile) => { mobile.controlProps.colsStyle[3].value = "minmax(max-content, 20fr)"; }],
  ["last percent track", (_pc, mobile) => { mobile.controlProps.colsStyle[5].value = "1%"; }],
  ["scroll access", (_pc, mobile) => { delete mobile.controlProps.style; }],
  ["hidden overflow", (_pc, mobile) => { mobile.controlProps.style.overflowX = "hidden"; }],
  ["source colspan", (_pc, mobile) => { mobile.children[3].controlProps.columnSpan = 2; }],
  ["source position", (_pc, mobile) => { mobile.children[2].controlProps.column = 2; }],
  ["field placement order", (_pc, mobile) => {
    const contents = mobile.children.map(cell => cell.children);
    mobile.children.forEach((cell, index) => { cell.children = contents[contents.length - 1 - index]; });
  }],
  ["textarea percent widget", (_pc, mobile) => { textareaWrapper(mobile).controlProps.style.width = "80%"; }]
]) it(`rejects native ${name} loss using the real persistence readback invariant`, () => {
  const { dsl } = sourceAndDraft(), prepared = prepareSample(dsl), changed = structuredClone(prepared.update), config = xformConfig(changed);
  const view = JSON.parse(config.viewModel[0].fdConfig), pc = gridOf(rowsOf(view, "desktop")[0]), mobile = gridOf(rowsOf(view, "mobile")[0]);
  assert.deepEqual(mobile.controlProps.colsStyle, hybrid(pc.controlProps.colsStyle), "Feature request must contain actual mixed tracks before testing its loss");
  const before = structuredClone(mobile); change(pc, mobile); assert.notDeepEqual(mobile, before);
  config.viewModel[0].fdConfig = JSON.stringify(view); changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  const checked = prepared.verify(changed);
  assert.equal(checked.ok, false);
  assert.ok(checked.diagnostics.some(item => /readback\.form\.(?:mobile_grid|layout|content_flow)/.test(item.code)), JSON.stringify(checked.diagnostics));
});

it("normalizes independent cell serialization order by explicit positions without asserting DOM or tab order", () => {
  const { dsl } = sourceAndDraft(), prepared = prepareSample(dsl), changed = structuredClone(prepared.update), config = xformConfig(changed);
  const view = JSON.parse(config.viewModel[0].fdConfig), mobile = gridOf(rowsOf(view, "mobile")[0]);
  const before = structuredClone(mobile.children);
  assert.ok(before.every(cell => Number.isInteger(cell.controlProps.row) && Number.isInteger(cell.controlProps.column)));
  mobile.children.reverse();
  assert.notDeepEqual(mobile.children, before);
  const byPosition = cells => [...cells].sort((left, right) =>
    left.controlProps.row - right.controlProps.row || left.controlProps.column - right.controlProps.column);
  assert.deepEqual(byPosition(mobile.children), byPosition(before), "Every field retains its explicit source cell and contents");
  config.viewModel[0].fdConfig = JSON.stringify(view); changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  // The existing observer sorts independent cells by their explicit positions.
  // This does not prove native DOM or keyboard traversal order is unchanged.
  assert.equal(prepared.verify(changed).ok, true);
});

for (const [name, change] of [
  ["caption proof deletion", dsl => { delete fieldOf(dsl, "caption_reason").sourceProps.runtimePlainCaption; }],
  ["caption content", dsl => { fieldOf(dsl, "caption_kind").props.content = "Changed caption"; }],
  ["caption style", dsl => { fieldOf(dsl, "caption_kind").props.style = { color: "red" }; }],
  ["ordinary field identity", dsl => { fieldOf(dsl, "fd_kind").sourceProps.designerId = "invented"; }],
  ["ordinary field options", dsl => { fieldOf(dsl, "fd_kind").props.options[0].value = "changed"; }],
  ["textarea percent", dsl => {
    fieldOf(dsl, "fd_reason").sourceProps.designerValues.width = "80%";
    dsl.form.layout.mkTree[0].children[3].contentFlow.items[0].width.value = 80;
    dsl.form.layout.sourceGrid.rows[0].cells[3].contentFlow.items[0].width.value = 80;
  }],
  ["source cell identity", dsl => {
    dsl.form.layout.mkTree[0].children[0].sourceRef += ".changed";
    dsl.form.layout.sourceGrid.rows[0].cells[0].sourceRef += ".changed";
  }],
  ["source order", dsl => { dsl.form.layout.mkTree[0].children.reverse(); dsl.form.layout.sourceGrid.rows[0].cells.reverse(); }],
  ["source weight", dsl => { dsl.form.layout.mkTree[0].children[0].widthWeight += 100; dsl.form.layout.sourceGrid.rows[0].cells[0].widthWeight += 100; }],
  ["hidden marker helper default", dsl => { fieldOf(dsl, "opaque_state").props.defaultValue.value = "changed"; }],
  ["hidden marker helper deletion", dsl => { dsl.form.fields = dsl.form.fields.filter(field => field.id !== "opaque_state"); }]
]) it(`rejects fixed-source ${name} laundering through trust and apply`, () => {
  const { source, dsl } = sourceAndDraft(), before = structuredClone(dsl);
  change(dsl); assert.notDeepEqual(dsl, before);
  const trusted = syntheticTrust(source, dsl);
  assert.equal(trusted.ok, false);
  assert.ok(trusted.diagnostics.some(item => /caption.*source|source.*caption/.test(item.code)), JSON.stringify(trusted.diagnostics));
  const applied = applyEvidenceBackedPatches(dsl, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
  assert.equal(applied.ok, false);
  assert.ok(applied.diagnostics.some(item => /caption.*source|source.*caption/.test(item.code)), JSON.stringify(applied.diagnostics));
});

it("preserves the existing numeric-first minmax policy even if a mixed caption profile is also supplied", () => {
  const { dsl } = sourceAndDraft("without-marker"), row = projectNativeLayoutRows(dsl.form.layout.mkTree)[0];
  const current = mobileNumberGrid(row, new Map([["fd_kind", 112]]), sourceMobileCaptionGrids(dsl.form));
  assert.deepEqual(current.colsStyle, hybrid(row.colsStyle, new Set()));
  assert.deepEqual(current.style, { overflowX: "auto" });
});

it("completes fake review, new-draft execution, readback and record through the registered XML route", async () => {
  const result = await runRouteCase("mobile-mixed-caption-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.transferRecord.status, "recorded");
});
