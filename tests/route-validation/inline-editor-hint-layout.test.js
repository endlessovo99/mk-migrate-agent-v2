import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { renderNativeFieldReferences } from "../helpers/native-form-renderer.js";
import { nativeViewSaveRoundTrip, verifyNativeSaveSources } from "../helpers/native-view-save.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/inline-editor-hint-layout/inline-editor-hint_SysFormTemplate.xml";
const xml = readFileSync(fixture, "utf8");
const hint = "如已取得相关证明，请填写对方提供的完整申请表编号";
const scenes = ["desktop", "mobile"];
const nodes = node => [node, ...(node.children || []).flatMap(nodes)];
const viewOf = config => JSON.parse(config.viewModel[0].fdConfig);
const parentOf = (root, id) => nodes(root).find(node => node.children?.some(child => child.key === id));
const itemOf = (config, scene, id = "fd_reference") => parentOf(viewOf(config).view.render[scene][0], id);

function project(source) {
  const draft = draftSourceDraft(source), prepared = prepareSample(draft);
  return { source, draft, prepared, config: xformConfig(prepared.update) };
}

function variant(change = () => {}) {
  const props = parseRootHashMapStringPuts(xml);
  change(props);
  const directory = mkdtempSync(join(tmpdir(), "inline-editor-hint-"));
  const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  try {
    const path = join(directory, "variant_SysFormTemplate.xml");
    writeFileSync(path, '<java><object class="java.util.HashMap">' + Object.entries(props)
      .map(([key, value]) => `<void method="put"><string>${key}</string><string>${escape(value)}</string></void>`)
      .join("") + "</object></java>");
    return project(cleanSourceFile(path));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function persisted(prepared, config) {
  const update = structuredClone(prepared.update);
  update.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  return update;
}

function changed(prepared, mutate) {
  const config = xformConfig(prepared.update), view = viewOf(config);
  mutate(view);
  config.viewModel[0].fdConfig = JSON.stringify(view);
  return persisted(prepared, config);
}

// Check the actual rendered flex item's hypothetical basis, which the browser
// uses before collecting wrapping lines. A zero basis admits a full-width hint
// onto that line and leaves only its small remainder for the editor.
function assertSourceBasis(config, scene, sourceOuterPx) {
  const item = itemOf(config, scene);
  const style = item.controlProps.style;
  assert.equal(style.flex, `1 1 ${sourceOuterPx}px`, "editor must enter wrapping with its source width, not zero");
  assert.equal(style.minWidth, 0, "a viewport narrower than source must still shrink");
  assert.equal(style.maxWidth, "100%", "source basis must remain bounded by the available cell");
  assert.equal(style.width, "auto");
  const line = parentOf(viewOf(config).view.render[scene][0], item.key);
  assert.equal(line.controlProps.style.flexWrap, "wrap");
  assert.deepEqual(line.children.map(child => child.children[0].key), ["fd_reference", "reference_hint"]);
  assert.equal(itemOf(config, scene, "reference_hint").controlProps.style.flex, "0 1 auto");
  const rendered = renderNativeFieldReferences(config, scene);
  assert.deepEqual(rendered.actual, rendered.expected);
  const flattened = value => Array.isArray(value) ? value.flatMap(flattened)
    : value && typeof value === "object" ? [value, ...(value.children || []).flatMap(flattened)] : [];
  const renderedItem = flattened(rendered.output).find(node => node.props?.id === item.controlProps.id);
  assert.deepEqual(renderedItem.props.style, style, "native registered div must transport the responsive basis");
}

it("carries source width through XML review, fake execution, readback and transfer recording", async () => {
  const route = await runRouteCase("inline-editor-hint-layout-success");
  assert.equal(route.execution.ok, true);
  assert.equal(route.execution.readback.ok, true);
  assert.equal(route.execution.transferRecord.status, "recorded");
  const { prepared, config, draft } = project(cleanSourceFile(fixture));
  assert.equal(draft.form.fields.find(field => field.id === "fd_reference").props.hiddenLabel, true);
  for (const scene of scenes) assertSourceBasis(config, scene, 246);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("survives real native save, reassembly and a second save on both scenes", () => {
  verifyNativeSaveSources();
  const { prepared, config, source, draft } = project(cleanSourceFile(fixture));
  const retainedSource = structuredClone(source), retainedDraft = structuredClone(draft);
  const saved = nativeViewSaveRoundTrip(config);
  for (const scene of scenes) assertSourceBasis(saved, scene, 246);
  assert.equal(prepared.verify(persisted(prepared, saved)).ok, true);
  assert.deepEqual(source, retainedSource);
  assert.deepEqual(draft, retainedDraft);
});

it("derives the basis from renamed source widths, including a small 60px editor", () => {
  for (const inputPx of [60, 185, 410]) {
    const { config, prepared } = variant(props => {
      for (const key of ["fdDesignerHtml", "fdDisplayJsp"]) props[key] = props[key]
        .replaceAll("240", String(inputPx)).replaceAll("246", String(inputPx + 6));
    });
    for (const scene of scenes) assertSourceBasis(config, scene, inputPx + 6);
    assert.equal(prepared.verify(prepared.update).ok, true);
  }
});

it("uses the same rule after changing all editor, caption and hint identities", () => {
  const { config, prepared } = variant(props => {
    for (const key of ["fdDesignerHtml", "fdDisplayJsp", "fdMetadataXml"]) props[key] = props[key]
      .replaceAll("fd_reference", "fd_unrelated_code").replaceAll("reference_hint", "unrelated_hint")
      .replaceAll("reference_caption", "unrelated_caption").replaceAll("Reference number", "Another source code");
  });
  for (const scene of scenes) {
    assert.equal(itemOf(config, scene), undefined);
    assert.equal(itemOf(config, scene, "fd_unrelated_code").controlProps.style.flex, "1 1 246px");
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
});

for (const [name, change] of [
  ["short unit", props => { props.fdDesignerHtml = props.fdDesignerHtml.replaceAll(hint, "元"); }],
  ["explicit line break", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('<LABEL fd_type="textLabel" style="WIDTH:auto', '<BR/><LABEL fd_type="textLabel" style="WIDTH:auto'); }],
  ["hint in a different cell", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('<LABEL fd_type="textLabel" style="WIDTH:auto', '</TD><TD row="0" column="2" width="420"><LABEL fd_type="textLabel" style="WIDTH:auto'); }],
  ["no source width", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('WIDTH:246px;DISPLAY:inline', 'DISPLAY:inline').replace('width:"240",', ''); }],
  ["percentage source width", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('WIDTH:246px;', 'WIDTH:60%;').replace('width:"240"', 'width:"60%"'); }],
  ["zero source width", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('WIDTH:246px;', 'WIDTH:0px;').replace('width:"240"', 'width:"0"'); }]
]) it(`preserves the existing adaptive policy for ${name}`, () => {
  const { config, prepared } = variant(change);
  for (const scene of scenes) {
    const style = itemOf(config, scene).controlProps.style;
    assert.equal(style.flex, name === "zero source width" ? "0 0 auto" : "1 1 0");
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("does not apply the text-editor policy to a date control beside the same hint", () => {
  const { config, prepared, draft } = variant(props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace('fd_type="inputText"', 'fd_type="datetime"')
      .replace('dataType:"String"', 'dataType:"Date",businessType:"dateDialog"');
    props.fdDisplayJsp = props.fdDisplayJsp.replace("xform:xtext", "xform:datetime");
    props.fdMetadataXml = props.fdMetadataXml.replace('type="String"', 'type="Date"');
  });
  assert.equal(draft.form.fields.find(field => field.id === "fd_reference").componentId, "xform-datetime");
  for (const scene of scenes) assert.equal(itemOf(config, scene).controlProps.style.flex, "1 1 0");
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("does not allocate source bases to multiple editors sharing a hint", () => {
  const { config, prepared } = variant(props => {
    const widget = props.fdDesignerHtml.match(/<DIV fd_type="inputText"[\s\S]*?<\/DIV>/)[0];
    props.fdDesignerHtml = props.fdDesignerHtml.replace(widget, widget + widget.replaceAll("fd_reference", "fd_second"));
    props.fdMetadataXml = props.fdMetadataXml.replace("</metadata>", '<extendSimpleProperty name="fd_second" label="Reference number" type="String" notNull="true"/></metadata>');
  });
  for (const scene of scenes) for (const id of ["fd_reference", "fd_second"]) {
    assert.equal(itemOf(config, scene, id).controlProps.style.flex, "1 1 0");
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("preserves readonly state and its independent source caption", () => {
  const { draft, config, prepared } = variant(props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace('readOnly:"false"', 'readOnly:"true"');
  });
  const field = draft.form.fields.find(field => field.id === "fd_reference");
  assert.equal(field.props.readOnly, true);
  assert.equal(field.props.hiddenLabel, true);
  assert.ok(draft.form.fields.some(field => field.id === "reference_caption"));
  for (const scene of scenes) assertSourceBasis(config, scene, 246);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("does not promote a source-hidden value into a visible editor", () => {
  const { draft, config, prepared } = variant(props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace('canShow:"true"', 'canShow:"false"');
  });
  assert.equal(draft.form.fields.find(field => field.id === "fd_reference").dataOnly, true);
  for (const scene of scenes) assert.equal(itemOf(config, scene), undefined);
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("does not change retained DSL source sizing", () => {
  const draft = draftSourceDraft(cleanSourceFile(fixture), { layoutSizing: "source" });
  const prepared = prepareSample(draft), config = xformConfig(prepared.update);
  for (const scene of scenes) {
    const style = itemOf(config, scene).controlProps.style;
    assert.equal(style.width, "246px");
    assert.equal(style.flex, "0 0 auto");
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
});

for (const scene of scenes) for (const [name, mutate] of [
  ["zero editor basis", style => { style.flex = "1 1 0"; }],
  ["a different positive basis", style => { style.flex = "1 1 120px"; }],
  ["a fixed minimum that overflows narrow cells", style => { style.minWidth = "246px"; }],
  ["an unbounded maximum", style => { style.maxWidth = "none"; }]
]) it(`rejects ${scene} readback with ${name}`, () => {
  const { prepared } = project(cleanSourceFile(fixture));
  const payload = changed(prepared, view => mutate(parentOf(view.view.render[scene][0], "fd_reference").controlProps.style));
  assert.equal(prepared.verify(payload).ok, false);
});
