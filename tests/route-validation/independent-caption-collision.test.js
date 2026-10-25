import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { renderNativeCaption } from "../helpers/native-caption-renderer.js";
import { runFixtureRouteCase } from "./run-route-case.js";

const directory = "tests/fixtures/route-validation/independent-caption-collision";
const title = "主责部门部门领导是否认可";
const field = (draft, id) => draft.form.fields.find(item => item.id === id);
const visibleTitles = draft => draft.form.fields.flatMap(item => item.componentId === "xform-description"
  ? [item.props.content] : item.props.hiddenLabel === true ? [] : [item.title]);
const encode = text => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const runtimeCaption = '<label style="DISPLAY:inline">' + title + '</label>';
const sourceCaption = /<label style="DISPLAY:inline" fd_type="textLabel"[^>]+>[\s\S]*?<\/label>/;
function stages(name = "base") {
  const source = cleanSourceFile(`${directory}/${name}_SysFormTemplate.xml`);
  return { source, draft: draftSourceDraft(source) };
}
function variant(change) {
  const props = parseRootHashMapStringPuts(readFileSync(`${directory}/base_SysFormTemplate.xml`, "utf8"));
  const before = structuredClone(props);
  change(props);
  assert.notDeepEqual(props, before, "The source counterexample must change its XML");
  const folder = mkdtempSync(join(tmpdir(), "independent-caption-"));
  try {
    const path = join(folder, "variant_SysFormTemplate.xml");
    writeFileSync(path, '<java class="java.beans.XMLDecoder"><object class="java.util.HashMap">' +
      Object.entries(props).map(([key, value]) => `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`).join("") + '</object></java>');
    const source = cleanSourceFile(path);
    return { source, draft: draftSourceDraft(source) };
  } finally { rmSync(folder, { recursive: true, force: true }); }
}
function unwrapped(props) {
  props.fdDesignerHtml = props.fdDesignerHtml
    .replace(/<div id="right_(?:caption|choice)" fd_type="right" fd_values='[^']*'>/g, "")
    .replace(/<table><tbody><tr><td>权限区段1<\/td><\/tr><\/tbody><\/table>/, "")
    .replace(/<span mode_N[\s\S]*?<\/span><\/div>/g, "");
  props.fdDisplayJsp = props.fdDisplayJsp.replace(/<\/?xform:right\b[^>]*>/g, "");
}
function trusted(source, draft) {
  return createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true,
    reviewerName: "synthetic independent caption regression", checkedAt: "2026-10-25T00:00:00Z" });
}
function assertNativeLiteralOnce(draft, captionId = "fd_caption", editorId = "fd_choice") {
  const prepared = prepareSample(draft), config = xformConfig(prepared.update), readback = prepared.verify(prepared.update);
  assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
  for (const scene of ["desktop", "mobile"]) {
    const actual = config.dataModel[0].fdFields.flatMap(item => {
      const attribute = JSON.parse(item.fdAttribute);
      return item.fdName === captionId ? [attribute.config.controlProps.content] :
        item.fdName === editorId ? renderNativeCaption(attribute, scene).labels : [];
    });
    assert.equal(actual.filter(value => value === title).length, 1, scene);
  }
  return { prepared, config, readback };
}

it("retains the source literal when a metadata collision removes the caption beside a hidden unbound subject", () => {
  const source = cleanSourceFile(`${directory}/base_SysFormTemplate.xml`);
  const draft = draftSourceDraft(source);
  assert.equal(visibleTitles(draft).filter(value => value === title).length, 1,
    "The literal needs one independent caption or one visible folded title");
  assert.equal(source.form.controls.find(item => item.id === "fd_caption")?.title, title);
  assert.equal(field(draft, "fd_caption")?.props.content, title);
  assert.equal(field(draft, "fd_caption").props.required, undefined);
  assert.equal(field(draft, "fd_choice").props.hiddenLabel, true);
  assert.deepEqual(source.form.layout.rows[0].cells.map(cell => [cell.column, cell.colspan]), [[0, 1], [1, 3]]);
});

it("preserves the same contract after every source, table, right, caption and editor identity changes", () => {
  const { source, draft } = stages("renamed");
  assert.equal(source.source.fdId, "renamed-caption-form");
  assert.equal(field(draft, "fd_heading").props.content, title);
  assert.equal(field(draft, "fd_heading").sourceProps.rightContainer.id, "right_heading");
  assert.equal(field(draft, "fd_answer").sourceProps.rightContainer.id, "right_answer");
  assert.equal(field(draft, "fd_answer").props.hiddenLabel, true);
  assert.equal(visibleTitles(draft).filter(value => value === title).length, 1);
  assertNativeLiteralOnce(draft, "fd_heading", "fd_answer");
});

it("keeps source field semantics and renders the caption once on desktop and mobile", () => {
  const { source, draft } = stages();
  assert.equal(field(draft, "fd_caption").dataOnly, undefined);
  assert.equal(field(draft, "fd_caption").sourceProps.metadataAttributes, undefined);
  assert.equal(field(draft, "fd_choice").props.required, true);
  assert.equal(field(draft, "fd_choice").props.readOnly, undefined);
  assert.equal(field(draft, "fd_choice").props.defaultValue, undefined);
  assert.deepEqual(field(draft, "fd_choice").props.options, [{ label: "认可", value: "A" }, { label: "不认可", value: "B" }]);
  assert.equal(checkTrust(source, trusted(source, draft)).ok, true);
  const { prepared, config } = assertNativeLiteralOnce(draft);
  const changed = structuredClone(prepared.update);
  const corrupt = xformConfig(changed);
  const caption = corrupt.dataModel[0].fdFields.find(item => item.fdName === "fd_caption");
  const attribute = JSON.parse(caption.fdAttribute);
  attribute.config.controlProps.content = "Different literal";
  caption.fdAttribute = JSON.stringify(attribute);
  changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(corrupt);
  assert.equal(prepared.verify(changed).ok, false);
  assert.equal(config.dataModel[0].fdFields.filter(item => item.fdName === "fd_caption").length, 1);
});

it("keeps legitimate no-right and bound-caption folds visible instead of requiring the old entity", () => {
  for (const bound of [false, true]) {
    const { source, draft } = variant(props => {
      unwrapped(props);
      if (bound) props.fdDesignerHtml = props.fdDesignerHtml
        .replace('_label_bind:"false",_label_bind_id:""', '_label_bind:"true",_label_bind_id:"fd_caption"');
    });
    assert.equal(field(draft, "fd_caption"), undefined);
    assert.notEqual(field(draft, "fd_choice").props.hiddenLabel, true);
    assert.equal(visibleTitles(draft).filter(value => value === title).length, 1);
    assert.equal(checkTrust(source, trusted(source, draft)).ok, true);
    assertNativeLiteralOnce(draft);
  }
});

it("retains the same static independent caption beside an existing text editor", () => {
  const { draft } = variant(props => {
    props.fdDesignerHtml = props.fdDesignerHtml.replace('fd_type="inputRadio"', 'fd_type="inputText"');
    props.fdDisplayJsp = props.fdDisplayJsp.replace('xform:radio ', 'xform:xtext ');
  });
  assert.equal(field(draft, "fd_caption").props.content, title);
  assert.equal(field(draft, "fd_choice").componentId, "xform-input");
  assert.equal(field(draft, "fd_choice").props.hiddenLabel, true);
  assertNativeLiteralOnce(draft);
});

it("retains captions through known visible Designer ancestors and only static visible canShow values", () => {
  for (const canShow of [undefined, "", "true"]) {
    const { draft } = variant(props => {
      props.fdDesignerHtml = '<div style="DISPLAY:block">' + props.fdDesignerHtml
        .replace('<table id="table_review"', '<table style="WIDTH:98%" align="center" id="table_review"')
        .replace('<tr>', '<tr style="HEIGHT:24px">')
        .replace('class="td_normal_title"', 'style="WIDTH:180px;DISPLAY:table-cell" class="td_normal_title"') + '</div>';
      if (canShow !== undefined) props.fdDesignerHtml = props.fdDesignerHtml.replace('content:"' + title + '"',
        'canShow:"' + canShow + '",content:"' + title + '"');
    });
    assert.equal(field(draft, "fd_caption").props.content, title);
    assert.equal(field(draft, "fd_choice").sourceProps.layoutCell.relation, "runtime-independent-title-cell");
    assertNativeLiteralOnce(draft);
  }
});

it("rejects lost source presentation through trust and forbids Agent Review entity deletion", () => {
  const { source, draft } = stages();
  for (const change of [
    value => { value.form.fields = value.form.fields.filter(item => item.id !== "fd_caption"); },
    value => { field(value, "fd_caption").props.content = "Invented label"; },
    value => { delete field(value, "fd_choice").props.hiddenLabel; }
  ]) {
    const changed = trusted(source, structuredClone(draft));
    change(changed);
    assert.equal(checkTrust(source, changed).ok, false);
  }
  const patched = applyEvidenceBackedPatches(draft, [{ op: "remove", path: "/form/fields/0",
    sourceRefs: [source.form.controls.find(item => item.id === "fd_caption").sourceRef],
    evidence: ["The independently rendered literal is present in the source."], confidence: 1,
    rationale: "Attempt to delete the source caption." }], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
  assert.equal(patched.ok, false);
});

for (const [name, change] of [
  ["visible intrinsic label", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace('<xform:radio ', '<xform:radio showLabel="true" '); }],
  ["uncertain intrinsic label", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace('<xform:radio ', '<xform:radio showLabel="${flag}" '); }],
  ["hidden source label", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('style="DISPLAY:inline" fd_type="textLabel"', 'style="DISPLAY:none" fd_type="textLabel"'); }],
  ["hidden runtime label", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace(runtimeCaption, runtimeCaption.replace('DISPLAY:inline', 'DISPLAY:none')); }],
  ["hidden right default", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace('mode_d="view"', 'mode_d="hidden"'); }],
  ["unknown right mode", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace('mode_N3="hidden"', 'mode_N3="unknown"'); }],
  ["dynamic right default", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace('mode_g="view"', 'mode_g="${mode}"'); }],
  ["ambiguous binding", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('_label_bind:"false",_label_bind_id:""', '_label_bind:"false",_label_bind_id:"missing_caption"'); }],
  ["competing active caption", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('</tbody></table>', '</tbody></table><div fd_type="inputText" fd_values=\'{id:"fd_other",label:"Other",_label_bind:"true",_label_bind_id:"fd_caption"}\'></div>'); }],
  ["duplicate source identity", props => { const label = props.fdDesignerHtml.match(sourceCaption)[0]; props.fdDesignerHtml = props.fdDesignerHtml.replace(label, label + label); }],
  ["mismatched source DOM identity", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('<label style="DISPLAY:inline" fd_type="textLabel"', '<label id="other_caption" style="DISPLAY:inline" fd_type="textLabel"'); }],
  ["mismatched runtime DOM identity", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace(runtimeCaption, runtimeCaption.replace('<label ', '<label id="other_caption" ')); }],
  ["duplicate runtime caption", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace(runtimeCaption, runtimeCaption + runtimeCaption); }],
  ["duplicate runtime renderer", props => { const renderer = props.fdDisplayJsp.match(/<xform:radio[^>]*\/>/)[0]; props.fdDisplayJsp = props.fdDisplayJsp.replace(renderer, renderer + renderer); }],
  ["dynamic source values", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('content:"' + title + '"', 'content:captionText'); }],
  ["dynamic literal", props => { for (const key of ['fdDesignerHtml', 'fdDisplayJsp', 'fdMetadataXml']) props[key] = props[key].replaceAll(title, '${caption}'); }],
  ["conditional runtime caption", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace(runtimeCaption, '<c:if test="${allowed}">' + runtimeCaption + '</c:if>'); }],
  ["unknown source label style", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('style="DISPLAY:inline" fd_type="textLabel"', 'style="DISPLAY:inline;clip-path:circle(0)" fd_type="textLabel"'); }],
  ["unknown source ancestor style", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('<div id="right_caption"', '<div style="clip-path:circle(0)" id="right_caption"'); }],
  ["unknown Designer table style", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('<table id="table_review"', '<table style="clip-path:circle(0)" id="table_review"'); }],
  ["unknown Designer title-cell style", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('class="td_normal_title"', 'style="clip-path:circle(0)" class="td_normal_title"'); }],
  ["unknown Designer row style", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('<tr>', '<tr style="clip-path:circle(0)">'); }],
  ["unknown outer Designer style", props => { props.fdDesignerHtml = '<div style="clip-path:circle(0)">' + props.fdDesignerHtml + '</div>'; }],
  ["conditional outer Designer ancestor", props => { props.fdDesignerHtml = '<c:if test="${allowed}">' + props.fdDesignerHtml + '</c:if>'; }],
  ["dynamic caption canShow", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('content:"' + title + '"', 'canShow:"${visible}",content:"' + title + '"'); }],
  ["unknown caption canShow", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('content:"' + title + '"', 'canShow:"unknown",content:"' + title + '"'); }],
  ["unknown runtime label style", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace(runtimeCaption, runtimeCaption.replace('DISPLAY:inline', 'DISPLAY:inline;clip-path:circle(0)')); }],
  ["unknown runtime ancestor style", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace('<table id="table_review"', '<table style="clip-path:circle(0)" id="table_review"'); }],
  ["unknown caption JSP", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace(runtimeCaption, '<% renderCaption(); %>' + runtimeCaption); }],
  ["unknown caption event", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace(runtimeCaption, runtimeCaption.replace('<label ', '<label onclick="mutateCaption()" ')); }],
  ["mismatching runtime text", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace(runtimeCaption, runtimeCaption.replace(title, 'Different caption')); }],
  ["mismatching runtime geometry", props => { props.fdDisplayJsp = props.fdDisplayJsp.replace('column="1,2,3"', 'column="2,3,4"'); }],
  ["mismatching source span", props => { props.fdDesignerHtml = props.fdDesignerHtml.replace('column="1,2,3"', 'colspan="2" column="1,2,3"'); }],
  ["spanning source caption", props => { props.fdDesignerHtml = props.fdDesignerHtml.replaceAll('row="0" column=', 'rowspan="2" row="0" column='); }]
]) it(`does not acquire new caption recovery authority from ${name}`, () => {
  const { source, draft } = variant(change);
  assert.notEqual(source.form.controls.find(item => item.id === "fd_caption")?.title, title, name);
  assert.equal(field(draft, "fd_choice")?.sourceProps.foldedCaption?.id, undefined, name);
});

it("completes the network-guarded public fake-create/readback/record route", async () => {
  const result = await runFixtureRouteCase({
    id: "independent-caption-collision-success",
    source: { kind: "form-only", relativePath: "independent-caption-collision/base_SysFormTemplate.xml" },
    reviewScenario: "accept", newoaScenario: "persist", confirmWrite: true,
    expected: { reviewStatus: "passed", dryRunStatus: "passed", executionStatus: "written",
      operations: ["login", "init", "generate-table-name", "load-parent-category", "add", "get-before-update", "update", "get-readback", "add-transfer-record"] }
  });
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.transferRecord.status, "recorded");
  assert.equal(result.execution.readback.form.fields.find(item => item.id === "fd_caption").content, title);
});
