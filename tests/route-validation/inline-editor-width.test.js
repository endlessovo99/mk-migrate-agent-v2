import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { cleanSourceFile } from "../../src/translator/index.js";
// Preserve the retained source-width contract explicitly.
import { draftSourceDraft } from "../helpers/source-sized-draft.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/inline-editor-width/inline-editor-width_SysFormTemplate.xml";
const xml = readFileSync(fixture, "utf8");
const ids = ["fd_start", "fd_end", "fd_unit", "fd_code"];
const oldWidths = { fd_start: 159, fd_end: 159, fd_unit: 126, fd_code: 120 };
it("completes source review, native input-width readback and guarded transfer recording", async () => {
  const result = await runRouteCase("inline-editor-width-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.transferRecord.status, "recorded");
});
const stages = p => { const source = cleanSourceFile(p); return { source, draft: draftSourceDraft(source) }; };
function variant(change) {
  const props = parseRootHashMapStringPuts(xml);
  change(props);
  const dir = mkdtempSync(join(tmpdir(), "inline-editor-width-"));
  const esc = v => v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  try {
    const file = join(dir, "fixture_SysFormTemplate.xml");
    writeFileSync(file, '<java><object class="java.util.HashMap">' + Object.entries(props).map(([k, v]) => `<void method="put"><string>${k}</string><string>${esc(v)}</string></void>`).join("") + "</object></java>");
    return stages(file);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function parentOf(n, id) {
  if (n.children?.some(c => c.key === id)) return n;
  return (n.children || []).map(c => parentOf(c, id)).find(Boolean);
}
function projection(draft) {
  const prepared = prepareSample(draft);
  const view = JSON.parse(xformConfig(prepared.update).viewModel[0].fdConfig);
  return { prepared, view };
}
function width(view, id, platform = "desktop") {
  return parentOf(view.view.render[platform][0], id)?.controlProps.style.width;
}
function trusted(source, draft) {
  return createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true, reviewerName: "synthetic inline editor budget regression" });
}

it("reserves the distinct native label and control shells around source 120px editors", () => {
  const { source, draft } = stages(fixture), { prepared, view } = projection(draft);
  assert.equal(checkTrust(source, trusted(source, draft)).ok, true);
  for (const id of ids) {
    const field = draft.form.fields.find(f => f.id === id);
    assert.equal(field.sourceProps.inlineCaption.relation, "leading-unbound-subject-caption");
    assert.equal(field.sourceProps.designerValues.width, "120");
    assert.equal(field.props.hiddenLabel, undefined);
    // PC classic-standard horizontal: source widget120 + label8em@14px +
    // label padding32/border1 + control padding32; these are distinct elements.
    assert.equal(width(view, id), "297px", id);
    assert.equal(width(view, id, "mobile"), `${oldWidths[id]}px`, id + " mobile");
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
});
it("keeps field semantics and the original source content-flow widths", () => {
  const { source, draft } = stages(fixture), { prepared } = projection(draft);
  for (const id of ids) {
    const sourceField = source.form.controls.find(f => f.id === id), field = draft.form.fields.find(f => f.id === id);
    assert.equal(field.sourceRef, sourceField.sourceRef);
    assert.equal(field.sourceProps.designerValues._label_bind, "false");
    assert.equal(field.sourceProps.subjectLabel.content, sourceField.sourceProps.subjectLabel.content);
    const item = source.form.layout.rows.flatMap(r => r.cells.flatMap(c => c.contentFlow?.items || [])).find(i => i.referenceId === id);
    assert.deepEqual(item.width, { value: oldWidths[id], unit: "px" });
    assert.equal(field.props.required === true, id !== "fd_code");
  }
  assert.equal(draft.form.fields.find(f => f.id === "fd_start").props.displayPattern, "yyyy-MM-dd");
  assert.equal(draft.form.fields.find(f => f.id === "fd_code").title.startsWith("*"), true);
  assert.equal(prepared.verify(prepared.update).ok, true);
});
it("derives sizing after changing source identity, names and leading label text", () => {
  const { draft } = variant(p => {
    for (const k of ["fdDesignerHtml", "fdDisplayJsp", "fdMetadataXml"]) p[k] = p[k].replaceAll("fd_start", "fd_renamed_start").replaceAll("Period start", "Different beginning");
    p.fdModelId = "renamed-inline-editor-model";
  });
  assert.equal(width(projection(draft).view, "fd_renamed_start"), "297px");
});

for (const [name, change] of [
  ["source readonly value", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('id:"fd_start",width:"120",_label_bind:"false",label:"Start",_label_bind_id:"",canShow:"true",readOnly:"false"', 'id:"fd_start",width:"120",_label_bind:"false",label:"Start",_label_bind_id:"",canShow:"true",readOnly:"true"'); }],
  ["metadata readonly attribute", p => { p.fdMetadataXml = p.fdMetadataXml.replace('name="fd_start"', 'name="fd_start" readOnly="true"'); }],
  ["metadata explicit width", p => { p.fdMetadataXml = p.fdMetadataXml.replace('name="fd_start"', 'name="fd_start" width="120"'); }],
  ["metadata type mismatch", p => { p.fdMetadataXml = p.fdMetadataXml.replace('name="fd_start" label="Start" type="Date"', 'name="fd_start" label="Start" type="String"'); }],
  ["missing fixed source input width", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('id:"fd_start",width:"120",', 'id:"fd_start",'); }],
  ["percent source input width", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace('id:"fd_start",width:"120",', 'id:"fd_start",width:"100%",'); }],
  ["absent leading caption evidence", p => { p.fdDesignerHtml = p.fdDesignerHtml.replace(/<LABEL[^>]*fd_start_caption[^>]*>[\s\S]*?<\/LABEL>/, ''); }]
]) it("preserves the old date width for " + name, () => {
  const { draft } = variant(change);
  assert.equal(width(projection(draft).view, "fd_start"), "159px");
});

for (const [name, change] of [
  ["source width", f => { f.sourceProps.designerValues.width = "121"; }],
  ["source metadata width", f => { f.sourceProps.metadataAttributes.width = "120"; }],
  ["source leading relation", f => { f.sourceProps.inlineCaption.relation = "unproven"; }],
  ["source label visibility", f => { f.props.hiddenLabel = true; }],
  ["source metadata type", f => { f.sourceProps.metadataAttributes.type = "String"; }],
  ["source identity evidence", f => { delete f.sourceProps.designerId; }],
  ["source required permission", f => { f.props.required = false; }],
  ["source field title", f => { f.title = "Unrelated title"; }]
]) it("source trust rejects forged " + name, () => {
  const { source, draft } = stages(fixture), original = trusted(source, draft);
  assert.equal(checkTrust(source, original).ok, true);
  const changed = structuredClone(original); change(changed.form.fields.find(f => f.id === "fd_start"));
  assert.equal(checkTrust(source, changed).ok, false);
});
for (const [name, change] of [
  ["old collapsed width", (v, id) => { parentOf(v.view.render.desktop[0], id).controlProps.style.width = "159px"; }],
  ["label font width budget", (v, id) => { (v.controlStyle[id] ||= {}).desktop = { ...(v.controlStyle[id]?.desktop || {}), labelStyle: { fontSize: 20 } }; }],
  ["layout contract", (v, id) => { (v.controlStyle[id] ||= {}).desktop = { ...(v.controlStyle[id]?.desktop || {}), layout: "vertical" }; }],
  ["padding mode", (v, id) => { (v.controlStyle[id] ||= {}).desktop = { ...(v.controlStyle[id]?.desktop || {}), desktopPaddingMode: "compact" }; }],
  ["theme", (v, id) => { (v.controlStyle[id] ||= {}).desktop = { ...(v.controlStyle[id]?.desktop || {}), desktopTheme: "plain" }; }],
  ["dynamic padding override", (v, id) => { (v.controlStyle[id] ||= {}).desktop = { ...(v.controlStyle[id]?.desktop || {}), paddingControl: { top: "8px", right: "60px", bottom: "8px", left: "60px" } }; }]
]) it("native readback rejects changed " + name, () => {
  const { draft } = stages(fixture), { prepared, view } = projection(draft);
  assert.equal(prepared.verify(prepared.update).ok, true);
  const changed = structuredClone(prepared.update), config = xformConfig(changed);
  change(view, "fd_start"); config.viewModel[0].fdConfig = JSON.stringify(view); changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  assert.equal(prepared.verify(changed).ok, false);
});

for (const [name, change] of [
  ["desktop label defaults", config => { config.labelProps.desktop = { hiddenLabel: false, showText: true }; }],
  ["top label defaults", config => { Object.assign(config.labelProps, { hiddenLabel: false, showText: true }); }],
  ["disabled input add-ons", config => { Object.assign(config.controlProps.desktop, { enablePrefix: false, enableSuffix: false }); }],
  ["top visible label", config => { config.labelProps.visible = true; }],
  ["top unhidden label", config => { config.labelProps.hidden = false; }],
  ["desktop visible label", config => { config.labelProps.desktop.visible = true; }],
  ["desktop unhidden label", config => { config.labelProps.desktop.hidden = false; }]
]) it(`accepts equivalent ${name}`, () => {
  const { prepared } = projection(stages(fixture).draft), changed = structuredClone(prepared.update), config = xformConfig(changed);
  const field = config.dataModel[0].fdFields.find(field => field.fdName === "fd_unit");
  const attribute = JSON.parse(field.fdAttribute);
  change(attribute.config);
  field.fdAttribute = JSON.stringify(attribute);
  changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  assert.equal(prepared.verify(changed).ok, true);
});

for (const [key, value] of [["hidden", true], ["visible", false]]) it(`rejects a hidden label through labelProps.${key}`, () => {
  const { prepared } = projection(stages(fixture).draft), changed = structuredClone(prepared.update), config = xformConfig(changed);
  const field = config.dataModel[0].fdFields.find(field => field.fdName === "fd_unit");
  const attribute = JSON.parse(field.fdAttribute);
  attribute.config.labelProps.desktop[key] = value;
  field.fdAttribute = JSON.stringify(attribute);
  changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  assert.equal(prepared.verify(changed).ok, false);
});
