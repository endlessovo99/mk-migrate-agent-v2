import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixture = "tests/fixtures/route-validation/checkbox-source-direction/checkbox-direction_SysFormTemplate.xml";
const xml = readFileSync(fixture, "utf8");
const fields = draft => draft.form.fields.flatMap(f => [f, ...(f.columns || [])]);
const field = (draft, id) => fields(draft).find(f => f.id === id);
function stages(text) {
  if (text === undefined) { const source = cleanSourceFile(fixture); return { source, draft: draftSourceDraft(source) }; }
  const dir = mkdtempSync(join(tmpdir(), "checkbox-direction-"));
  try { const p = join(dir, "direction_SysFormTemplate.xml"); writeFileSync(p, text); const source = cleanSourceFile(p); return { source, draft: draftSourceDraft(source) }; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
function trustedStages() {
  const { source, draft } = stages();
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true, reviewerName: "synthetic checkbox direction regression", checkedAt: "2026-10-15T00:00:00Z" });
  const result = checkTrust(source, trusted);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return { source, trusted };
}
function nativeField(payload, id) {
  const f = xformConfig(payload).dataModel.flatMap(m => m.fdFields || []).find(f => f.fdName === id);
  assert.ok(f, id);
  return JSON.parse(f.fdAttribute).config.controlProps;
}
function updateNative(payload, id, change) {
  const config = xformConfig(payload), f = config.dataModel.flatMap(m => m.fdFields || []).find(f => f.fdName === id), attribute = JSON.parse(f.fdAttribute);
  change(attribute.config.controlProps);
  f.fdAttribute = JSON.stringify(attribute);
  payload.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
}
// Exact current PC/mobile SDK partition contract, independently bound in task evidence.
function logicalRows(props, platform = "desktop") {
  const p = { ...props, ...props[platform] }, count = p.rowCount || 3, size = (p.direction ?? "column") === "row" || count === 1 ? 1 : count;
  const rows = [];
  for (let i = 0; i < p.options.length; i += size) rows.push(p.options.slice(i, i + size).map(o => o.value));
  return rows;
}

it("maps explicit source H/V to the actual PC/mobile logical option rows", () => {
  const { draft } = stages(), p = prepareSample(draft);
  for (const platform of ["desktop", "mobile"]) {
    assert.deepEqual(logicalRows(nativeField(p.update, "fd_h4"), platform), [["v0", "v1", "v2", "v3"]]);
    assert.deepEqual(logicalRows(nativeField(p.update, "fd_v5"), platform), [["v0"], ["v1"], ["v2"], ["v3"], ["v4"]]);
    assert.deepEqual(logicalRows(nativeField(p.update, "fd_detail_h"), platform), [["v0", "v1", "v2", "v3"]]);
    assert.deepEqual(logicalRows(nativeField(p.update, "fd_detail_v"), platform), [["v0"], ["v1"], ["v2"]]);
  }
  assert.equal(p.verify(p.update).ok, true);
});
function flowLines(form, id) {
  const found = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.contentFlow?.lines) && node.contentFlow.lines.flat().includes(id)) found.push(node.contentFlow.lines);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(form.layout?.sourceGrid || form.layout);
  assert.equal(found.length, 1, "The source control must have one unambiguous content-flow cell");
  return found[0];
}
it("preserves ordinary choice codes and independent Other text with the original line topology", () => {
  const { source, draft } = stages(), p = prepareSample(draft);
  for (const id of ["fd_append", "fd_break", "fd_replace"]) {
    const original = source.form.controls.find(f => f.id === id);
    assert.equal(original.options.length, 3);
    assert.deepEqual(field(draft, id).props.options, original.options);
    assert.ok(field(draft, id).props.options.every(option => option.type !== "other"));
    assert.notEqual(field(draft, id + "_text").dataOnly, true);
    const native = xformConfig(p.update).dataModel.flatMap(model => model.fdFields || []).find(f => f.fdName === id + "_text");
    assert.equal(native.fdDisplay, true);
    assert.equal(native.fdIsStored, true);
    assert.deepEqual(flowLines(draft.form, id), flowLines(source.form, id));
  }
  for (const platform of ["desktop", "mobile"]) {
    assert.deepEqual(logicalRows(nativeField(p.update, "fd_append"), platform), [["v0", "v1", "v2"]]);
    assert.deepEqual(logicalRows(nativeField(p.update, "fd_break"), platform), [["v0", "v1", "v2"]]);
    assert.deepEqual(logicalRows(nativeField(p.update, "fd_replace"), platform), [["v0", "v1", "OT"]]);
  }
  const append = flowLines(draft.form, "fd_append"), broken = flowLines(draft.form, "fd_break");
  assert.equal(append.findIndex(line => line.includes("fd_append")), append.findIndex(line => line.includes("fd_append_text")));
  assert.ok(broken.findIndex(line => line.includes("fd_break_text")) > broken.findIndex(line => line.includes("fd_break")));
  assert.equal(field(draft, "fd_replace").sourceProps.otherTextCompanion.optionValue, "OT");
  assert.equal(p.verify(p.update).ok, true);
});
it("preserves options, values, readonly/required, source identity, field scope and unrelated controls", () => {
  const { source, draft } = stages(), p = prepareSample(draft);
  assert.equal(field(draft, "fd_h4").sourceRef, source.form.controls.find(f => f.id === "fd_h4").sourceRef);
  assert.deepEqual(nativeField(p.update, "fd_h4").options.map(o => [o.label, o.value]), field(draft, "fd_h4").props.options.map(o => [o.label, o.value]));
  assert.equal(nativeField(p.update, "fd_h4").multi, true);
  assert.equal(nativeField(p.update, "fd_radio").multi, undefined);
  assert.equal(field(draft, "fd_rows").columns.length, 2);
  assert.equal(nativeField(p.update, "fd_detail_h").$$tableType, "detail");
});
it("keeps unknown/default source alignment on the existing contract", () => {
  const p = prepareSample(stages().draft);
  for (const id of ["fd_unknown", "fd_default"]) {
    assert.equal(nativeField(p.update, id).direction, "row");
    assert.equal(nativeField(p.update, id).rowCount, undefined);
  }
});
it("retains a genuine trusted source baseline", () => { trustedStages(); });
it("applies the source contract after renaming fields, labels and model identity", () => {
  const { draft } = stages(xml.replaceAll("fd_h4", "fd_renamed").replaceAll("Horizontal four", "Renamed caption").replaceAll("checkbox-direction-model", "renamed-model"));
  const p = prepareSample(draft);
  assert.deepEqual(logicalRows(nativeField(p.update, "fd_renamed")), [["v0", "v1", "v2", "v3"]]);
});

for (const [name, id, change] of [
  ["H alignment flipped", "fd_h4", f => { f.sourceProps.designerValues.alignment = "V"; }],
  ["V alignment flipped", "fd_v5", f => { f.sourceProps.designerValues.alignment = "H"; }],
  ["alignment deleted", "fd_h4", f => { delete f.sourceProps.designerValues.alignment; }],
  ["source designerValues deleted", "fd_h4", f => { delete f.sourceProps.designerValues; }],
  ["sourceProps erased", "fd_h4", f => { f.sourceProps = {}; }],
  ["designer type erased", "fd_h4", f => { delete f.sourceProps.designerType; }],
  ["one option deleted", "fd_h4", f => { f.props.options.pop(); }],
  ["option value changed", "fd_h4", f => { f.props.options[0].value = "changed"; }],
  ["option label changed", "fd_h4", f => { f.props.options[0].label = "Changed"; }],
  ["other source relation deleted", "fd_append", f => { delete f.sourceProps.otherTextCompanion; }],
  ["replacement other disguised as appended", "fd_replace", f => { delete f.sourceProps.otherTextCompanion.optionValue; }],
  ["unknown source promoted into H", "fd_unknown", f => { f.sourceProps.designerValues.alignment = "H"; }]
]) it(`source trust rejects ${name}`, () => {
  const { source, trusted } = trustedStages(), c = structuredClone(trusted); change(field(c, id));
  const result = checkTrust(source, c);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(d => d.code === "trust.form.checkbox_layout_source_mismatch"), JSON.stringify(result.diagnostics));
});

for (const [name, id, change] of [
  ["H direction", "fd_h4", p => { p.direction = "row"; }],
  ["H effective row capacity", "fd_h4", p => { p.rowCount = 2; }],
  ["V direction with multi-item capacity", "fd_v5", p => { p.direction = "column"; p.rowCount = 4; }],
  ["unsupported native direction", "fd_h4", p => { p.direction = "unknown-direction"; }],
  ["desktop direction override", "fd_h4", p => { p.desktop.direction = "row"; }],
  ["mobile direction override", "fd_h4", p => { p.mobile.direction = "row"; }],
  ["desktop align override", "fd_h4", p => { p.desktop.align = "vertical"; }],
  ["mobile align override", "fd_h4", p => { p.mobile.align = "vertical"; }],
  ["dynamic option source", "fd_h4", p => { p.optionSource = "JavaScript"; }]
]) it(`native readback rejects ${name}`, () => {
  const p = prepareSample(stages().draft); assert.equal(p.verify(p.update).ok, true);
  const changed = structuredClone(p.update); updateNative(changed, id, change);
  assert.equal(p.verify(changed).ok, false);
});
for (const [name, id, change] of [
  ["irrelevant V rowCount", "fd_v5", p => { p.rowCount = 99; }],
  ["absent V rowCount", "fd_v5", p => { delete p.rowCount; }],
  ["V equivalent column single-item alias", "fd_v5", p => { p.direction = "column"; p.rowCount = 1; }],
  ["equivalent H platform defaults", "fd_h3", p => { delete p.direction; delete p.rowCount; }],
  ["equivalent custom optionSource default", "fd_h4", p => { delete p.optionSource; }]
]) it(`native readback accepts ${name} without false metadata failures`, () => {
  const p = prepareSample(stages().draft); const changed = structuredClone(p.update); updateNative(changed, id, change);
  assert.equal(p.verify(changed).ok, true);
});

for (const platform of ["desktop", "mobile"]) {
  for (const [name, id, change] of [
    ["one option", "fd_h4", options => options.slice(0, 1)],
    ["empty options", "fd_h4", () => []],
    ["changed option value", "fd_h4", options => { options[0].value = "changed"; return options; }],
    ["changed option label", "fd_h4", options => { options[0].label = "Changed"; return options; }],
    ["ordinary option promoted to other type", "fd_append", options => { options.at(-1).type = "other"; return options; }]
  ]) it(`native readback rejects ${platform} effective ${name} override`, () => {
    const p = prepareSample(stages().draft); assert.equal(p.verify(p.update).ok, true);
    const changed = structuredClone(p.update);
    updateNative(changed, id, props => {
      const original = structuredClone(props.options), altered = change(structuredClone(props.options));
      assert.notDeepEqual(altered, original, "The counterexample must alter effective option semantics");
      props[platform].options = altered;
    });
    assert.equal(p.verify(changed).ok, false);
  });
  it(`native readback accepts ${platform} identical option clone`, () => {
    const p = prepareSample(stages().draft), changed = structuredClone(p.update);
    updateNative(changed, "fd_append", props => { props[platform].options = structuredClone(props.options); });
    assert.deepEqual(logicalRows(nativeField(changed, "fd_append"), platform), [["v0", "v1", "v2"]]);
    assert.equal(p.verify(changed).ok, true);
  });
}
