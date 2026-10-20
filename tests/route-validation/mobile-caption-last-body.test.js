import assert from "node:assert/strict";
import { it } from "node:test";
import { draftSourceDraft } from "../../src/translator/index.js";
// These width assertions cover retained SourceDrafts and their standalone native caption layouts.
import { cleanSourceWithoutCaptionFact as cleanSourceFile } from "../helpers/retained-caption-source.js";
import { sourceMobileCaptionGrids } from "../../src/dsl/source-mobile-caption-grid.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { mobileNumberGrid } from "../../src/executor/persistence/mobile-number-layout.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const root = "tests/fixtures/route-validation/mobile-caption-last-body/";
const names = ["mobile-caption-last-body", "styled-description", "checkbox-text", "percent-input"];
const load = (name = names[0]) => {
  const source = cleanSourceFile(`${root}${name}_SysFormTemplate.xml`);
  return { source, dsl: draftSourceDraft(source) };
};
const field = (dsl, id) => dsl.form.fields.find(item => item.id === id);
const grid = (view, scene) => view.view.render[scene][0].children[0].children[0].children.find(node => node.type === "@elem/layout-grid");
const view = prepared => JSON.parse(xformConfig(prepared.update).viewModel[0].fdConfig);
const row = dsl => dsl.form.layout.mkTree[0];
const sourceRow = dsl => dsl.form.layout.sourceGrid.rows[0];
const hybrid = styles => styles.map((style, index) => index === 0
  ? { ...style, value: `minmax(max-content, ${Number.parseFloat(style.value)}fr)` } : style);
const trusted = (source, dsl) => checkTrust(source, createTrustedMigrationDsl(source, dsl, {
  externalAgentReviewed: true, reviewerName: "synthetic unreviewed last-body source-bound test"
}));
const sourceBoundReject = (source, dsl, name) => {
  const check = trusted(source, dsl);
  assert.equal(check.ok, false, name);
  assert.ok(check.diagnostics.some(item => /mobile_plain_caption_source_mismatch/.test(item.code)), JSON.stringify(check.diagnostics));
  const apply = applyEvidenceBackedPatches(dsl, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
  assert.equal(apply.ok, false, name);
  assert.ok(apply.diagnostics.some(item => /mobile_plain_caption_source_mismatch/.test(item.code)), JSON.stringify(apply.diagnostics));
};

it("starts from real canonical XML and a valid existing native request for all four body roles", () => {
  for (const name of names) {
    const { source, dsl } = load(name), prepared = prepareSample(dsl);
    assert.equal(source.form.layout.rows.length, 1);
    assert.equal(dsl.scripts?.actions?.length || 0, 0);
    assert.equal(field(dsl, "caption_main").sourceProps.runtimePlainCaption, true);
    assert.equal(row(dsl).props.columns, 4);
    assert.deepEqual(row(dsl).children.map(cell => [cell.column, cell.colspan]), [[0, 1], [1, 3]]);
    assert.equal(prepared.verify(prepared.update).ok, true, "Existing request is a valid baseline, not an expected setup error");
    assert.equal(trusted(source, dsl).ok, true);
  }
  const two = load().dsl;
  assert.deepEqual(row(two).children[1].refIds, ["fd_summary", "fd_review"]);
  assert.equal(field(two, "fd_review").props.readOnly, true);
  assert.deepEqual(field(two, "fd_review").props.defaultValue, { kind: "literal", value: "Review default" });
  const notice = field(load("styled-description").dsl, "body_notice");
  assert.equal(notice.props.content, "Notice:\r\nKeep the original text.");
  assert.equal(notice.props.content, notice.sourceProps.designerValues.content);
  assert.deepEqual(notice.props.style, { color: "rgba(255,0,0,1)" });
  assert.notEqual(notice.sourceProps.runtimePlainCaption, true);
  const choice = load("checkbox-text").dsl;
  assert.deepEqual(field(choice, "fd_choices").props.options.map(option => [option.label, option.value, option.type]), [["One", "A", undefined], ["Two", "B", undefined]]);
  assert.equal(field(choice, "state_marker").dataOnly, true);
  assert.deepEqual(field(choice, "caption_main").sourceProps.runtimePlainCaptionMarkerIds, ["state_marker"]);
  assert.deepEqual(field(choice, "state_marker").props.defaultValue, { kind: "literal", value: "retained-state" });
});

for (const name of names) it(`keeps the final body tracks and every source field unchanged for ${name}`, () => {
  const { source, dsl } = load(name), before = structuredClone(dsl), prepared = prepareSample(dsl), current = view(prepared);
  assert.ok(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"), "Complete source-bound last-body row must receive a profile");
  const pc = grid(current, "desktop"), mobile = grid(current, "mobile");
  const projection = projectNativeLayoutRows(dsl.form.layout.mkTree)[0];
  assert.deepEqual(pc.controlProps.colsStyle, projection.colsStyle);
  assert.deepEqual(mobile.controlProps.colsStyle, hybrid(projection.colsStyle));
  assert.deepEqual(mobile.controlProps.colsStyle.slice(1), pc.controlProps.colsStyle.slice(1), "The entire body span keeps its original percent tracks");
  assert.deepEqual(mobile.controlProps.style, { overflowX: "auto" });
  assert.deepEqual(mobile.children, pc.children, "Do not change body widgets, content, fixed/percent widths, line breaks, defaults, permissions or source positions");
  assert.equal(mobile.controlProps.columns, pc.controlProps.columns);
  assert.equal(mobile.controlProps.rows, pc.controlProps.rows);
  assert.deepEqual(dsl, before);
  assert.equal(prepared.verify(prepared.update).ok, true);
  assert.equal(trusted(source, dsl).ok, true);
});

it("rejects unproved source geometry and a body containing only another plain heading", () => {
  const mutations = [
    dsl => { row(dsl).children[1].column = 0; sourceRow(dsl).cells[1].column = 0; },
    dsl => { row(dsl).children[1].colspan = 2; sourceRow(dsl).cells[1].colspan = 2; },
    dsl => { row(dsl).children[1].rowspan = 2; sourceRow(dsl).cells[1].rowspan = 2; },
    dsl => { row(dsl).children[1].refType = "layout"; },
    dsl => { sourceRow(dsl).preserveSourceGeometry = false; },
    dsl => { row(dsl).children.reverse(); sourceRow(dsl).cells.reverse(); },
    dsl => {
      const body = field(dsl, "body_notice");
      delete body.props.style; body.props.content = "Second heading";
      body.sourceProps.runtimePlainCaption = true; body.sourceProps.designerValues.content = "Second heading";
      delete body.sourceProps.designerValues.color;
    }
  ];
  for (const mutate of mutations) {
    const { dsl } = load("styled-description"), before = structuredClone(dsl); mutate(dsl);
    assert.notDeepEqual(dsl, before);
    assert.equal(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"), false);
  }
});

it("requires complete unique body references, flow items and lines in both source and mapped cells", () => {
  for (const mutate of [
    dsl => { row(dsl).children[1].refIds.pop(); },
    dsl => { sourceRow(dsl).cells[1].references.pop(); },
    dsl => { row(dsl).children[1].contentFlow.items.pop(); sourceRow(dsl).cells[1].contentFlow.items.pop(); },
    dsl => { row(dsl).children[1].contentFlow.lines[0].reverse(); },
    dsl => { row(dsl).children[1].refIds.push("caption_main"); },
    dsl => { row(dsl).children[1].contentFlow.items[1].referenceId = "fd_summary"; }
  ]) {
    const { dsl } = load(), before = structuredClone(dsl); mutate(dsl); assert.notDeepEqual(dsl, before);
    assert.equal(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"), false);
  }
});

it("rejects actual mobile minima, body percent, scroll and field-placement readback losses", () => {
  for (const mutate of [
    (pc, mobile) => { mobile.controlProps.colsStyle = structuredClone(pc.controlProps.colsStyle); },
    (_pc, mobile) => { mobile.controlProps.colsStyle[1].value = "minmax(max-content, 30fr)"; },
    (_pc, mobile) => { delete mobile.controlProps.style; },
    (_pc, mobile) => { mobile.children[1].controlProps.columnSpan = 2; },
    (_pc, mobile) => { [mobile.children[0].children, mobile.children[1].children] = [mobile.children[1].children, mobile.children[0].children]; }
  ]) {
    const prepared = prepareSample(load().dsl), changed = structuredClone(prepared.update), config = xformConfig(changed);
    const current = JSON.parse(config.viewModel[0].fdConfig), pc = grid(current, "desktop"), mobile = grid(current, "mobile");
    assert.deepEqual(mobile.controlProps.colsStyle, hybrid(pc.controlProps.colsStyle), "The requested policy must exist before loss testing");
    const before = structuredClone(mobile); mutate(pc, mobile); assert.notDeepEqual(mobile, before);
    config.viewModel[0].fdConfig = JSON.stringify(current); changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    const result = prepared.verify(changed);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(item => /readback\.form\.(?:mobile_grid|layout|content_flow)/.test(item.code)), JSON.stringify(result.diagnostics));
  }
});

it("binds body content, appearance, widths, permissions, identities and source order through public trust and apply", () => {
  for (const [name, mutate] of [
    ["content", dsl => { field(dsl, "body_notice").props.content = "Changed"; }],
    ["style", dsl => { field(dsl, "body_notice").props.style.color = "blue"; }],
    ["source body", dsl => { field(dsl, "body_notice").sourceProps.designerValues.content = "Changed"; }],
    ["body identity", dsl => { field(dsl, "body_notice").sourceProps.designerId = "invented"; }],
    ["source order", dsl => { row(dsl).children.reverse(); sourceRow(dsl).cells.reverse(); }],
    ["source cell", dsl => { row(dsl).children[1].sourceRef += ".invented"; sourceRow(dsl).cells[1].sourceRef += ".invented"; }]
  ]) {
    const { source, dsl } = load("styled-description"), before = structuredClone(dsl); mutate(dsl); assert.notDeepEqual(dsl, before);
    sourceBoundReject(source, dsl, name);
  }
  for (const mutate of [
    dsl => { field(dsl, "fd_review").props.readOnly = false; },
    dsl => { row(dsl).children[1].contentFlow.items[0].width.value = 1; sourceRow(dsl).cells[1].contentFlow.items[0].width.value = 1; },
    dsl => { row(dsl).children[1].refIds.reverse(); sourceRow(dsl).cells[1].references.reverse(); }
  ]) {
    const { source, dsl } = load(); mutate(dsl); sourceBoundReject(source, dsl, "source fixed textarea semantics");
  }
});

it("retains caption proof and its exact hidden helper dependency without inventing a new body source fact", () => {
  for (const mutate of [
    dsl => { delete field(dsl, "caption_main").sourceProps.runtimePlainCaption; },
    dsl => { delete field(dsl, "caption_main").sourceProps.runtimePlainCaptionMarkerIds; },
    dsl => { field(dsl, "state_marker").props.defaultValue.value = "changed"; },
    dsl => { dsl.form.fields = dsl.form.fields.filter(item => item.id !== "state_marker"); }
  ]) {
    const { source, dsl } = load("checkbox-text"); mutate(dsl); sourceBoundReject(source, dsl, "source proof/helper");
  }
});

it("preserves existing numeric, single and mixed precedence and source row visibility/required behavior", () => {
  const previous = [
    "mobile-plain-caption/mobile-plain-caption",
    "mobile-mixed-caption/mobile-mixed-caption",
    "mobile-plain-caption/visibility-caption"
  ];
  for (const path of previous) {
    const dsl = draftSourceDraft(cleanSourceFile(`tests/fixtures/route-validation/${path}_SysFormTemplate.xml`));
    const before = structuredClone(dsl), projection = projectNativeLayoutRows(dsl.form.layout.mkTree)[0];
    const profiles = sourceMobileCaptionGrids(dsl.form);
    assert.ok(profiles.has(projection.id));
    const expected = mobileNumberGrid(projection, new Map(), profiles);
    const mixed = path.startsWith("mobile-mixed-caption");
    assert.deepEqual(expected.colsStyle, projection.colsStyle.map((style, index) => ({ ...style,
      value: mixed && index >= 3 ? style.value : `minmax(max-content, ${Number.parseFloat(style.value)}fr)` })));
    const numeric = mobileNumberGrid(projection, new Map([[projection.cells[1].refIds[0], 112]]), profiles);
    assert.deepEqual(numeric.colsStyle, projection.colsStyle.map(style => ({ ...style, value: `minmax(max-content, ${Number.parseFloat(style.value)}fr)` })));
    if (path.endsWith("visibility-caption")) assert.ok(dsl.formRules.linkage.some(rule => rule.translationStatus === "executable" &&
      rule.effects.some(effect => effect.type === "visible") && rule.effects.some(effect => effect.type === "required")));
    assert.equal(prepareSample(dsl).verify(prepareSample(dsl).update).ok, true);
    assert.deepEqual(dsl, before);
  }
});

it("executes the registered canonical XML through fake review, new draft, native readback and record", async () => {
  const result = await runRouteCase("mobile-caption-last-body-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.transferRecord.status, "recorded");
});

it("preserves the real four-cell fixed input/address plus static hint family with intrinsic tracks", () => {
  const { source, dsl } = load("fixed-value-hint"), before = structuredClone(dsl);
  assert.equal(field(dsl, "caption_main").sourceProps.runtimePlainCaption, true);
  assert.equal(field(dsl, "caption_owner").sourceProps.runtimePlainCaption, true);
  assert.deepEqual(row(dsl).children.map(cell => cell.refIds), [["caption_main"], ["fd_topic"], ["caption_owner"], ["fd_owner", "body_hint"]]);
  assert.deepEqual(row(dsl).children[3].contentFlow.lines, [["fd_owner"], ["body_hint"]]);
  assert.equal(field(dsl, "body_hint").props.content, field(dsl, "body_hint").sourceProps.designerValues.content);
  assert.equal(field(dsl, "body_hint").props.style, undefined, "Actual source hint has no translated color/style; do not invent one");
  assert.equal(row(dsl).children[3].contentFlow.items[1].width, undefined);
  const prepared = prepareSample(dsl), current = view(prepared), pc = grid(current, "desktop"), mobile = grid(current, "mobile");
  assert.equal(prepared.verify(prepared.update).ok, true);
  assert.equal(trusted(source, dsl).ok, true);
  assert.ok(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"));
  assert.deepEqual(mobile.controlProps.colsStyle, pc.controlProps.colsStyle.map(style => ({ ...style, value: `minmax(max-content, ${Number.parseFloat(style.value)}fr)` })));
  assert.deepEqual(mobile.controlProps.style, { overflowX: "auto" });
  assert.deepEqual(mobile.children, pc.children);
  assert.deepEqual(dsl, before);
});

it("does not turn a dynamic or incomplete value-cell hint into complete fixed source evidence", () => {
  for (const mutate of [
    dsl => { field(dsl, "body_hint").props.content = "${dynamicHint}"; field(dsl, "body_hint").sourceProps.designerValues.content = "${dynamicHint}"; },
    dsl => { row(dsl).children[3].contentFlow.items.pop(); sourceRow(dsl).cells[3].contentFlow.items.pop(); },
    dsl => { row(dsl).children[3].contentFlow.items[0].width = { value: 90, unit: "%" }; sourceRow(dsl).cells[3].contentFlow.items[0].width = { value: 90, unit: "%" }; }
  ]) {
    const { dsl } = load("fixed-value-hint"); mutate(dsl);
    assert.equal(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"), false);
  }
  const { source, dsl } = load("fixed-value-hint");
  field(dsl, "body_hint").props.content = "Changed hint";
  sourceBoundReject(source, dsl, "static hint body");
});
