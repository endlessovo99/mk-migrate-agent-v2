import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Preserve the retained source-width contract explicitly.
import { draftSourceDraft } from "../helpers/source-sized-draft.js";
// These width assertions cover retained SourceDrafts and their standalone native caption layouts.
import { cleanSourceWithoutCaptionFact as cleanSourceFile } from "../helpers/retained-caption-source.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { sourceMobileCaptionGrids } from "../../src/dsl/source-mobile-caption-grid.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = (name = "base") => `tests/fixtures/route-validation/typed-hidden-caption/${name === "base" ? "typed-hidden-caption" : name}_SysFormTemplate.xml`;
const sourceAndDraft = name => { const source = cleanSourceFile(fixture(name)); return { source, dsl: draftSourceDraft(source) }; };
const field = (dsl, id) => dsl.form.fields.find(item => item.id === id);
const viewOf = update => JSON.parse(xformConfig(update).viewModel[0].fdConfig);
const gridOf = (view, scene) => view.view.render[scene][0].children[0].children[0].children.find(node => node.type === "@elem/layout-grid");
const trust = (source, dsl) => checkTrust(source, createTrustedMigrationDsl(source, dsl, {
  externalAgentReviewed: true, reviewerName: "synthetic unreviewed typed hidden source boundary"
}));
const encode = text => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function sourceVariant(change, callback) {
  const props = parseRootHashMapStringPuts(readFileSync(fixture(), "utf8")), before = structuredClone(props);
  change(props); assert.notDeepEqual(props, before, "Source counterexample must actually change the fixture");
  const folder = mkdtempSync(join(tmpdir(), "typed-hidden-caption-")), file = join(folder, "variant_SysFormTemplate.xml");
  try {
    writeFileSync(file, '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(props).map(([key, value]) => `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`).join("") + '</object></java>');
    const source = cleanSourceFile(file); return callback(source, draftSourceDraft(source));
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

it("retains the exact exporter question mark and real source hard-hidden readonly helper", () => {
  const { source, dsl } = sourceAndDraft(), props = parseRootHashMapStringPuts(readFileSync(fixture(), "utf8"));
  assert.ok(props.fdDesignerHtml.includes('readOnly ? label="Hidden state"'));
  assert.ok(props.fdDisplayJsp.includes('onValueChange="__xformDispatch"'));
  const original = source.form.dataFields.find(item => item.id === "hidden_state"), helper = field(dsl, "hidden_state");
  assert.equal(original.sourceProps.hardHidden, true);
  assert.equal(helper.componentId, "xform-hidden"); assert.equal(helper.props.readOnly, true);
  assert.equal(helper.sourceRef, "source.form.dataField.hidden_state");
  assert.equal(helper.sourceProps.designerValues.defaultValue, "");
  assert.equal(helper.props.defaultValue, undefined, "Preserve absent effective default, not an invented empty literal");
  assert.equal(dsl.scripts?.actions?.length || 0, 0);
  const prepared = prepareSample(dsl), config = xformConfig(prepared.update), stored = config.dataModel[0].fdFields.find(item => item.fdName === "hidden_state");
  assert.equal(stored.fdDisplay, true); assert.equal(stored.fdIsStored, true);
  const native = JSON.parse(stored.fdAttribute).config;
  assert.equal(native.type, "hidden"); assert.equal(native.controlProps.hidden, true);
  assert.equal(native.controlProps.showStatus, "readOnly");
  assert.equal(prepared.verify(prepared.update).ok, true, "Valid old native baseline before new qualification");
});

for (const name of ["base", "canonical-readonly"]) it(`proves the complete typed hidden pair and old single-caption mobile policy for ${name}`, () => {
  const { source, dsl } = sourceAndDraft(name), before = structuredClone(dsl);
  assert.equal(field(dsl, "caption_choice").sourceProps.runtimePlainCaption, true);
  assert.deepEqual(field(dsl, "caption_choice").sourceProps.runtimePlainCaptionMarkerIds, ["hidden_state"]);
  assert.ok(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"));
  const prepared = prepareSample(dsl), view = viewOf(prepared.update), pc = gridOf(view, "desktop"), mobile = gridOf(view, "mobile");
  assert.deepEqual(mobile.controlProps.colsStyle, pc.controlProps.colsStyle.map(style => ({
    ...style, value: `minmax(max-content, ${Number.parseFloat(style.value)}fr)`
  })));
  assert.deepEqual(mobile.controlProps.style, { overflowX: "auto" });
  assert.deepEqual(mobile.children, pc.children);
  assert.deepEqual(dsl, before, "Source hidden model, readonly/default, geometry and scripts remain exact");
  assert.equal(prepared.verify(prepared.update).ok, true);
  assert.equal(trust(source, dsl).ok, true);
});

for (const name of ["unknown-exporter-token", "extra-handler", "property-mismatch", "runtime-visible", "metadata-mismatch",
  "dynamic-default", "extra-text", "extra-script", "different-cell", "width-mismatch"])
  it(`does not treat the unproved ${name} source as a safe hidden companion`, () => {
    const { dsl } = sourceAndDraft(name);
    assert.notEqual(field(dsl, "caption_choice").sourceProps.runtimePlainCaption, true);
    assert.equal(field(dsl, "caption_choice").sourceProps.runtimePlainCaptionMarkerIds, undefined);
    assert.equal(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"), false);
    const view = viewOf(prepareSample(dsl).update);
    assert.deepEqual(gridOf(view, "mobile"), gridOf(view, "desktop"));
  });

for (const [name, change] of [
  ["inner source id", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('<INPUT id="hidden_state"', '<INPUT id="different_state"'); }],
  ["source table binding", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('tableName="typed_source_table"', 'tableName="different_table"'); }],
  ["source readonly", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('readOnly:"true"', 'readOnly:"false"'); }],
  ["source hidden state", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('canShow:"false"', 'canShow:"true"'); }],
  ["runtime noShow", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace('showStatus="noShow"', 'showStatus="edit"'); }],
  ["runtime dispatcher", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace('onValueChange="__xformDispatch"', 'onValueChange="unknownDispatch()"'); }],
  ["runtime duplicate binding", props => { const tag = /<xform:xtext\b[^>]*\/>/.exec(props.fdDisplayJsp)[0]; props.fdDisplayJsp = props.fdDisplayJsp.replace(tag, tag + tag); }]
]) it(`fully consumes and rejects conflicting ${name} facts through real XML cleaning`, () => sourceVariant(change, (_source, dsl) => {
  assert.notEqual(field(dsl, "caption_choice").sourceProps.runtimePlainCaption, true);
  assert.equal(sourceMobileCaptionGrids(dsl.form).has("layout.row-0"), false);
}));

for (const [name, change] of [
  ["caption proof", dsl => { delete field(dsl, "caption_choice").sourceProps.runtimePlainCaption; }],
  ["helper dependency", dsl => { delete field(dsl, "caption_choice").sourceProps.runtimePlainCaptionMarkerIds; }],
  ["helper deletion", dsl => { dsl.form.fields = dsl.form.fields.filter(item => item.id !== "hidden_state"); }],
  ["helper default", dsl => { field(dsl, "hidden_state").props.defaultValue = { kind: "literal", value: "invented" }; }],
  ["helper readonly", dsl => { field(dsl, "hidden_state").props.readOnly = false; }],
  ["helper hardHidden", dsl => { field(dsl, "hidden_state").sourceProps.hardHidden = false; }],
  ["helper source identity", dsl => { field(dsl, "hidden_state").sourceRef = "source.form.control.invented"; }]
]) it(`rejects ${name} washing at both fixed-source public boundaries`, () => {
  const { source, dsl } = sourceAndDraft(), before = structuredClone(dsl);
  assert.equal(field(dsl, "caption_choice").sourceProps.runtimePlainCaption, true, "Fixed source proof must exist before testing its loss");
  assert.deepEqual(field(dsl, "caption_choice").sourceProps.runtimePlainCaptionMarkerIds, ["hidden_state"]);
  change(dsl); assert.notDeepEqual(dsl, before);
  const checked = trust(source, dsl);
  assert.equal(checked.ok, false);
  assert.ok(checked.diagnostics.some(item => item.code === "trust.form.mobile_plain_caption_source_mismatch"), JSON.stringify(checked.diagnostics));
  const applied = applyEvidenceBackedPatches(dsl, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
  assert.equal(applied.ok, false);
  assert.ok(applied.diagnostics.some(item => item.code === "agent.patch.form.mobile_plain_caption_source_mismatch"), JSON.stringify(applied.diagnostics));
});

it("completes the source-backed hidden-helper fake draft/readback/record route", async () => {
  const result = await runRouteCase("typed-hidden-caption-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.transferRecord.status, "recorded");
});
