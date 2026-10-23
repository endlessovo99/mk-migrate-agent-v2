import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { sourceMobileCaptionGrids } from "../../src/dsl/source-mobile-caption-grid.js";
import { mobileNumberGrid } from "../../src/executor/persistence/mobile-number-layout.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";
import { cleanSourceWithoutCaptionFact } from "../helpers/retained-caption-source.js";

const directory = "tests/fixtures/route-validation/radio-source-presentation/";
const load = (name = "radio-source-presentation") => {
  const source = cleanSourceFile(`${directory}${name}_SysFormTemplate.xml`);
  return { source, draft: draftSourceDraft(source) };
};
const fields = dsl => dsl.form.fields.flatMap(field => [field, ...(field.columns || [])]);
const field = (dsl, id) => fields(dsl).find(item => item.id === id);
const native = (payload, id) => {
  const model = xformConfig(payload).dataModel.flatMap(model => model.fdFields || []).find(item => item.fdName === id);
  assert.ok(model, id); return JSON.parse(model.fdAttribute).config.controlProps;
};
const updateNative = (payload, id, change) => {
  const config = xformConfig(payload), model = config.dataModel.flatMap(model => model.fdFields || []).find(item => item.fdName === id);
  const attributes = JSON.parse(model.fdAttribute); change(attributes.config.controlProps);
  model.fdAttribute = JSON.stringify(attributes); payload.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
};
// Radio-specific PC/mobile AST: row or effective count1 => single-option groups.
// Each group is a horizontal CSS flex-wrap row; column does not mean vertical.
const logicalRows = (props, platform = "desktop") => {
  const effective = { ...props, ...props[platform] }, count = effective.rowCount || 3;
  const size = effective.direction === "row" || count === 1 ? 1 : count, rows = [];
  assert.ok(Number.isInteger(size) && size > 0);
  for (let index = 0; index < effective.options.length; index += size) rows.push(effective.options.slice(index, index + size).map(option => option.value));
  return rows;
};
const sourceFlow = (draft, id) => {
  const items = [];
  const walk = object => {
    if (!object || typeof object !== "object") return;
    if (object.contentFlow?.items?.some(item => item.referenceId === id)) items.push(object.contentFlow.items.find(item => item.referenceId === id));
    for (const value of Object.values(object)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === "object") walk(value);
  };
  walk(draft.form.layout.mkTree);
  assert.equal(items.length, 1, "Main radio needs one actual source-flow item");
  return items[0];
};
const trust = (source, draft) => checkTrust(source, createTrustedMigrationDsl(source, draft, {
  externalAgentReviewed: true, reviewerName: "synthetic unreviewed radio presentation regression"
}));
const viewOf = payload => JSON.parse(xformConfig(payload).viewModel[0].fdConfig);
const gridOf = row => row.children.find(node => node.type === "@elem/layout-grid");

it("starts with genuine source controls, literal original options/defaults and valid native39/trust baselines", () => {
  for (const name of ["radio-source-presentation", "detail-direction", "explicit-widths", "unproven-runtime", "multiple-widthless-radios"]) {
    const { source, draft } = load(name), prepared = prepareSample(draft);
    assert.equal(draft.scripts?.actions?.length || 0, 0);
    assert.ok(fields(draft).filter(item => item.componentId === "xform-radio").every(item => item.type === "radio" && item.props.options.length >= 2));
    assert.equal(prepared.verify(prepared.update).ok, true);
    assert.equal(prepared.verify(prepared.update).invariantVersion, 41);
    assert.equal(trust(source, draft).ok, true);
  }
  const { draft } = load();
  assert.deepEqual(field(draft, "fd_h2").props.options.map(option => option.value), ["A", "B"]);
  assert.deepEqual(field(draft, "fd_h4").props.options.map(option => option.value), ["A", "B", "C", "D"]);
  assert.deepEqual(field(draft, "fd_h4").props.defaultValue, { kind: "literal", value: "C" });
  assert.equal(field(draft, "fd_h4").props.required, true);
  assert.equal(field(draft, "fd_v4").props.readOnly, true);
  assert.deepEqual(field(draft, "fd_v4").props.defaultValue, { kind: "literal", value: "D" });
});

it("consumes only fully source-proven designer radio hint widths while preserving actual field semantics", () => {
  const { draft } = load(), before = structuredClone(draft);
  for (const id of ["fd_h2", "fd_h4", "fd_v4"]) {
    assert.equal(Object.hasOwn(field(draft, id).sourceProps.designerValues, "width"), false);
    assert.equal(sourceFlow(draft, id).width, undefined, "Runtime radio has no explicit width; TABLE editor width must not constrain the real widget");
  }
  const prepared = prepareSample(draft), config = xformConfig(prepared.update);
  for (const id of ["fd_h2", "fd_h4", "fd_v4"]) {
    assert.deepEqual(native(prepared.update, id).options.map(option => [option.label, option.value]), field(draft, id).props.options.map(option => [option.label, option.value]));
    assert.equal(config.dataModel[0].fdFields.find(item => item.fdName === id).fdIsStored, true);
  }
  assert.equal(native(prepared.update, "fd_h4").required, true);
  assert.equal(native(prepared.update, "fd_v4").showStatus, "readOnly");
  assert.deepEqual(draft, before);
});

it("uses the radio's own H/V rowSizes without misclassifying the already-horizontal two-option default", () => {
  assert.deepEqual(logicalRows({ options: [{ value: "A" }, { value: "B" }] }), [["A", "B"]]);
  const prepared = prepareSample(load().draft);
  for (const platform of ["desktop", "mobile"]) {
    assert.deepEqual(logicalRows(native(prepared.update, "fd_h2"), platform), [["A", "B"]]);
    assert.deepEqual(logicalRows(native(prepared.update, "fd_h4"), platform), [["A", "B", "C", "D"]]);
    assert.deepEqual(logicalRows(native(prepared.update, "fd_v4"), platform), [["A"], ["B"], ["C"], ["D"]]);
  }
});

it("preserves main/detail identity while mapping explicit detail H/V independently of unproved detail width", () => {
  const { draft } = load("detail-direction"), before = structuredClone(draft), prepared = prepareSample(draft);
  assert.equal(field(draft, "fd_rows").columns.length, 2);
  for (const platform of ["desktop", "mobile"]) {
    assert.deepEqual(logicalRows(native(prepared.update, "fd_detail_h"), platform), [["A", "B", "C", "D"]]);
    assert.deepEqual(logicalRows(native(prepared.update, "fd_detail_v"), platform), [["A"], ["B"], ["C"], ["D"]]);
  }
  for (const id of ["fd_detail_h", "fd_detail_v"]) assert.equal(native(prepared.update, id).$$tableType, "detail");
  assert.equal(prepared.verify(prepared.update).ok, true);
  assert.deepEqual(draft, before, "Do not invent a detail runtime counterpart or modify its editor width/field scope");
});

it("preserves explicit runtime, designer-value and metadata widths while keeping genuine H/V grouping", () => {
  const { draft } = load("explicit-widths"), prepared = prepareSample(draft);
  for (const [id, width, rows] of [["fd_runtime", 76, [["A", "B", "C", "D"]]], ["fd_values", 120, [["A", "B", "C", "D"]]], ["fd_metadata", 140, [["A"], ["B"], ["C"], ["D"]]]]) {
    assert.deepEqual(sourceFlow(draft, id).width, { value: width, unit: "px" });
    for (const platform of ["desktop", "mobile"]) assert.deepEqual(logicalRows(native(prepared.update, id), platform), rows);
  }
});

it("keeps designer width when runtime matching/appearance or explicit source direction is unproved", () => {
  const { draft } = load("unproven-runtime"), prepared = prepareSample(draft);
  for (const id of ["fd_dup", "fd_missing", "fd_css", "fd_unknown"]) assert.deepEqual(sourceFlow(draft, id).width, { value: 76, unit: "px" });
  for (const platform of ["desktop", "mobile"]) {
    assert.deepEqual(logicalRows(native(prepared.update, "fd_dup"), platform), [["A", "B", "C", "D"]]);
    assert.deepEqual(logicalRows(native(prepared.update, "fd_css"), platform), [["A"], ["B"], ["C"], ["D"]]);
    assert.deepEqual(logicalRows(native(prepared.update, "fd_unknown"), platform), [["A", "B", "C"], ["D"]]);
  }
});

it("retains existing standalone caption width policies for saved Source Drafts", () => {
  for (const name of ["radio-source-presentation", "multiple-widthless-radios"]) {
    const draft = draftSourceDraft(cleanSourceWithoutCaptionFact(`${directory}${name}_SysFormTemplate.xml`), { layoutSizing: "source" });
    const prepared = prepareSample(draft), view = viewOf(prepared.update), profiles = sourceMobileCaptionGrids(draft.form);
    assert.equal(profiles.size, draft.form.layout.mkTree.length);
    for (const [index, row] of view.view.render.mobile[0].children[0].children.entries()) {
      const pc = gridOf(view.view.render.desktop[0].children[0].children[index]), mobile = gridOf(row);
      assert.deepEqual(mobile.controlProps.colsStyle, pc.controlProps.colsStyle.map(style => ({ ...style, value: `minmax(max-content, ${Number.parseFloat(style.value)}fr)` })));
      assert.deepEqual(mobile.controlProps.style, { overflowX: "auto" });
      assert.deepEqual(mobile.children, pc.children);
      const geometry = grid => grid.children.map(cell => ({ key: cell.key, props: cell.controlProps }));
      assert.deepEqual(geometry(mobile), geometry(pc));
    }
  }
});

it("rejects fixed-source direction, width, identity, field props and options laundering through trust and empty apply", () => {
  for (const [name, id, mutate] of [
    ["detail-direction", "fd_detail_h", f => { f.sourceProps.designerValues.alignment = "V"; }],
    ["detail-direction", "fd_detail_v", f => { delete f.sourceProps.designerValues.alignment; }],
    ["detail-direction", "fd_detail_h", f => { f.props.options[0].value = "changed"; }],
    ["radio-source-presentation", "fd_h4", f => { f.props.required = false; }],
    ["radio-source-presentation", "fd_v4", f => { f.props.readOnly = false; }],
    ["radio-source-presentation", "fd_h2", f => { f.sourceProps.designerValues.width = "999"; }],
    ["radio-source-presentation", "fd_h2", f => { f.sourceProps.designerId = "invented"; }]
  ]) {
    const { source, draft } = load(name), changed = structuredClone(draft); mutate(field(changed, id)); assert.notDeepEqual(changed, draft);
    const checked = trust(source, changed); assert.equal(checked.ok, false);
    assert.ok(checked.diagnostics.some(item => /radio.*source|source.*radio|mobile_plain_caption_source_mismatch/.test(item.code)), JSON.stringify(checked.diagnostics));
    const applied = applyEvidenceBackedPatches(changed, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
    assert.equal(applied.ok, false);
    assert.ok(applied.diagnostics.some(item => /radio.*source|source.*radio|mobile_plain_caption_source_mismatch/.test(item.code)), JSON.stringify(applied.diagnostics));
  }
  const { source, draft } = load(), changed = structuredClone(draft);
  for (const collection of [changed.form.layout.mkTree, changed.form.layout.sourceGrid.rows]) {
    const row = collection[0], cell = (row.children || row.cells).find(cell =>
      cell.contentFlow.items.some(item => item.referenceId === "fd_h2"));
    cell.contentFlow.items[0].width = { value: 999, unit: "px" };
  }
  assert.equal(trust(source, changed).ok, false);
  assert.equal(applyEvidenceBackedPatches(changed, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) }).ok, false);
});

it("rejects actual native grouping loss, scene overrides and platform option mutations", () => {
  for (const mutate of [
    p => { p.direction = "row"; p.rowCount = 1; },
    p => { delete p.direction; delete p.rowCount; },
    p => { p.desktop = { ...p.desktop, rowCount: 2 }; },
    p => { p.mobile = { ...p.mobile, rowCount: 1 }; },
    p => { p.mobile = { ...p.mobile, options: p.options.map((o, i) => ({ ...o, value: i ? o.value : "changed" })) }; }
  ]) {
    const prepared = prepareSample(load().draft);
    assert.deepEqual(logicalRows(native(prepared.update, "fd_h4")), [["A", "B", "C", "D"]], "Require the correct H4 request before corrupting it");
    const changed = structuredClone(prepared.update); updateNative(changed, "fd_h4", mutate); assert.notDeepEqual(changed, prepared.update);
    const checked = prepared.verify(changed); assert.equal(checked.ok, false);
    assert.ok(checked.diagnostics.some(item => /readback\.form\./.test(item.code)), JSON.stringify(checked.diagnostics));
  }
});

it("accepts only native grouping aliases with identical effective options and source semantics", () => {
  const prepared = prepareSample(load().draft), changed = structuredClone(prepared.update);
  updateNative(changed, "fd_h2", p => { delete p.direction; delete p.rowCount; });
  updateNative(changed, "fd_h4", p => { p.direction = "column"; p.rowCount = 6; });
  updateNative(changed, "fd_v4", p => { p.direction = "column"; p.rowCount = 1; });
  for (const platform of ["desktop", "mobile"]) {
    assert.deepEqual(logicalRows(native(changed, "fd_h2"), platform), [["A", "B"]]);
    assert.deepEqual(logicalRows(native(changed, "fd_h4"), platform), [["A", "B", "C", "D"]]);
    assert.deepEqual(logicalRows(native(changed, "fd_v4"), platform), [["A"], ["B"], ["C"], ["D"]]);
  }
  assert.equal(prepared.verify(changed).ok, true);
});

it("rejects consumed mobile option widths and padding in top, platform and final scene overlays", () => {
  for (const key of ["optionWidth", "optionPadding"]) for (const level of ["top", "mobile", "scene"]) {
    const prepared = prepareSample(load().draft), changed = structuredClone(prepared.update);
    if (level === "scene") {
      const config = xformConfig(changed), view = JSON.parse(config.viewModel[0].fdConfig);
      view.controlStyle ||= {}; view.controlStyle.fd_h4 ||= {}; view.controlStyle.fd_h4.mobile = { [key]: 10000 };
      config.viewModel[0].fdConfig = JSON.stringify(view); changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    } else updateNative(changed, "fd_h4", props => { (level === "top" ? props : props.mobile)[key] = 10000; });
    assert.equal(prepared.verify(changed).ok, false, `${level}.${key}`);
  }
});

it("accepts proven mobile auto/zero decorations and ignores unconsumed PC option sizing without align", () => {
  const prepared = prepareSample(load().draft), changed = structuredClone(prepared.update);
  updateNative(changed, "fd_h4", props => {
    props.desktop.optionWidth = 10000; props.desktop.optionPadding = 10000;
    props.mobile.optionWidth = "auto"; props.mobile.optionPadding = "0px";
  });
  assert.equal(prepared.verify(changed).ok, true);
});

it("preserves prior checkbox/numeric/mixed-policy precedence without inferring radio from checkbox", () => {
  const checkbox = draftSourceDraft(cleanSourceFile("tests/fixtures/route-validation/checkbox-source-direction/checkbox-direction_SysFormTemplate.xml"));
  const pc = prepareSample(checkbox);
  assert.deepEqual(logicalRows(native(pc.update, "fd_h4")), [["v0", "v1", "v2", "v3"]]);
  assert.deepEqual(logicalRows(native(pc.update, "fd_v5")), [["v0"], ["v1"], ["v2"], ["v3"], ["v4"]]);
  const mixed = draftSourceDraft(cleanSourceFile("tests/fixtures/route-validation/mobile-mixed-caption/mobile-mixed-caption_SysFormTemplate.xml"));
  const projection = projectNativeLayoutRows(mixed.form.layout.mkTree)[0], profiles = sourceMobileCaptionGrids(mixed.form);
  const numeric = mobileNumberGrid(projection, new Map([["fd_kind", 112]]), profiles);
  assert.deepEqual(numeric.colsStyle, projection.colsStyle.map(style => ({ ...style, value: `minmax(max-content, ${Number.parseFloat(style.value)}fr)` })));
  assert.equal(prepareSample(mixed).verify(prepareSample(mixed).update).ok, true);
});

it("completes fake review/new draft/readback/record with the registered genuine radio XML", async () => {
  const result = await runRouteCase("radio-source-presentation-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.transferRecord.status, "recorded");
});
