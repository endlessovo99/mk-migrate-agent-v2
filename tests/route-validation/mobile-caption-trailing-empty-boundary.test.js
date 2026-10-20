import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSourceFile } from "../../src/translator/index.js";
// Preserve the retained source-width contract explicitly.
import { draftSourceDraft } from "../helpers/source-sized-draft.js";
import { parseRootHashMapXmlStringPuts } from "../../src/translator/xml-utils.js";
import { sourceMobileCaptionGrids } from "../../src/dsl/source-mobile-caption-grid.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const root = "tests/fixtures/route-validation/mobile-caption-trailing-empty/";
const xml = name => readFileSync(`${root}${name}_SysFormTemplate.xml`, "utf8");
const encodeXml = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function part(text, key, edit) {
  const marker = `<string>${key}</string>`, at = text.indexOf(marker);
  assert.ok(at >= 0);
  const begin = text.indexOf("<string>", at + marker.length) + "<string>".length;
  const end = text.indexOf("</string>", begin);
  const previous = parseRootHashMapXmlStringPuts(text)[key], next = edit(previous);
  assert.notEqual(next, previous, "The source counterexample must change its intended raw part");
  return text.slice(0, begin) + encodeXml(next) + text.slice(end);
}
function load(text = xml("trailing-empty")) {
  const directory = mkdtempSync(join(tmpdir(), "tail-prefix-public-"));
  try {
    const path = join(directory, "prefix_SysFormTemplate.xml"); writeFileSync(path, text);
    const source = cleanSourceFile(path); return { source, dsl: draftSourceDraft(source) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const fact = dsl => dsl.form.layout.sourceGrid.rows[0].trailingBlankCells;
const row = dsl => dsl.form.layout.mkTree[0];
function noGrant(text) {
  const { dsl } = load(text);
  assert.equal(fact(dsl), undefined, "Ambiguous retained raw prefix cannot establish omitted-tail evidence");
  assert.equal(sourceMobileCaptionGrids(dsl.form).has(row(dsl).id), false);
}
function appendRuntime(property, tag = "xform:xtext") {
  return part(xml("trailing-empty"), "fdDisplayJsp", text => text.replace("</TBODY>",
    `<TR><TD row="1" column="0">${tag.includes("textarea") ? `<${tag} property="${property}"></${tag}>` : `<${tag} property="${property}"/>`}</TD></TR></TBODY>`));
}
const appendDesigner = markup => part(xml("trailing-empty"), "fdDesignerHtml", text =>
  text.replace("</SELECT></DIV>", "</SELECT></DIV>" + markup));
const carrier = content => `<DIV fd_type="JSP" id="local_carrier" fd_values='{id:"local_carrier",label:"Carrier"}'><INPUT type="hidden" value='${content}'/></DIV>`;
function grid(view, scene) {
  return view.view.render[scene][0].children[0].children[0].children.find(node => node.type === "@elem/layout-grid");
}

it("retains the canonical single-select prefix and its original desktop semantics", () => {
  const { source, dsl } = load(), before = structuredClone(dsl), prepared = prepareSample(dsl);
  const view = JSON.parse(xformConfig(prepared.update).viewModel[0].fdConfig);
  assert.ok(fact(dsl));
  assert.deepEqual(fact(dsl).omittedColumns, [2]);
  assert.ok(sourceMobileCaptionGrids(dsl.form).has(row(dsl).id));
  assert.deepEqual(grid(view, "desktop").controlProps.colsStyle.map(style => style.value), ["20.618556701031%", "79.381443298969%"]);
  assert.match(grid(view, "mobile").controlProps.colsStyle[0].value, /^minmax\(max-content,/);
  assert.equal(prepared.verify(prepared.update).ok, true);
  assert.equal(checkTrust(source, createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true, reviewerName: "tail prefix baseline" })).ok, true);
  assert.deepEqual(dsl, before);
});

for (const name of ["local-event", "editor-local-event"]) it(`retains the complete extracted ${name} carrier and its source action`, () => {
  const { source, dsl } = load(xml(name));
  assert.equal(source.scripts.fragments.length, 1);
  assert.equal(source.scripts.fragments[0].id, "local_event");
  assert.equal(source.scripts.sources.length, 1);
  assert.equal(source.scripts.sources[0].fragmentId, "local_event");
  assert.equal(dsl.scripts.actions.length, 1, "A genuine reachable source action is present; do not execute it in this layout test");
  assert.deepEqual(fact(dsl)?.scriptCarrierIds, ["local_event"]);
  assert.ok(sourceMobileCaptionGrids(dsl.form).has(row(dsl).id));
  const before = structuredClone(dsl), prepared = prepareSample(dsl);
  assert.equal(prepared.verify(prepared.update).ok, true);
  assert.deepEqual(dsl, before, "Layout proof must not edit fields, options, permissions, scripts or form rules");
});

for (const [name, property, tag] of [
  ["canonical", "extendDataFormInfo.value(fd_choice)", "xform:xtext"],
  ["outer whitespace", " extendDataFormInfo.value(fd_choice) ", "xform:xtext"],
  ["inner whitespace", "extendDataFormInfo.value( fd_choice )", "xform:xtext"],
  ["suffix", "extendDataFormInfo.value(fd_choice).extra", "xform:xtext"],
  ["quoted natural identity", "extendDataFormInfo.value(\'fd_choice\')", "xform:xtext"],
  ["masked xform textarea", "extendDataFormInfo.value(fd_choice)", "xform:textarea"],
  ["masked HTML textarea", "extendDataFormInfo.value(fd_choice)", "textarea"]
]) it(`withholds proof for a second ${name} main-field binding anywhere in the runtime`, () => {
  assert.ok(fact(load().dsl), "First establish the genuine source proof");
  noGrant(appendRuntime(property, tag));
});

it("does not confuse an unrelated main binding with a duplicate of the retained select", () => {
  const { dsl } = load(appendRuntime("extendDataFormInfo.value(fd_unrelated)"));
  assert.ok(fact(dsl));
  assert.ok(sourceMobileCaptionGrids(dsl.form).has(row(dsl).id));
});

for (const [name, payload] of [
  ["hidden field fragment", "&lt;input type=&quot;hidden&quot; id=&quot;fd_extra&quot;/&gt;"],
  ["property fragment", "&lt;xform:xtext property=&quot;extendDataFormInfo.value(fd_extra)&quot;/&gt;"],
  ["unknown text", "UNSUPPORTED MARKUP"],
  ["script plus hidden field", "&lt;script&gt;var unchanged=1;&lt;/script&gt;&lt;input type=&quot;hidden&quot; id=&quot;fd_extra&quot;/&gt;"]
]) it(`does not call an opaque ${name} payload a retained script carrier`, () => {
  const text = appendDesigner(carrier(payload));
  if (name !== "script plus hidden field") assert.equal(load(text).source.scripts?.sources?.length || 0, 0, "No source action exists for a script gate to validate");
  noGrant(text);
});

for (const [name, markup] of [
  ["SCRIPT", "<script>extra();</script>"], ["STYLE", "<style>.extra{color:red}</style>"],
  ["comment", "<!-- retained source content -->"], ["unknown hidden INPUT", '<input type="hidden" id="fd_extra"/>']
]) it(`does not mask source ${name} outside a proved retained carrier`, () => {
  noGrant(appendDesigner(markup));
});

for (const [name, markup] of [
  ["unmatched SCRIPT", "<script>extra();</script>"], ["STYLE", "<style>.extra{color:red}</style>"],
  ["comment", "<!-- retained runtime content -->"]
]) it(`does not mask runtime ${name} in the retained body cell`, () => {
  noGrant(part(xml("trailing-empty"), "fdDisplayJsp", text => text.replace("</xform:select>", "</xform:select>" + markup)));
});

it("requires runtime scripts to match the extracted source carrier rather than merely sharing the field ID", () => {
  noGrant(part(xml("local-event"), "fdDisplayJsp", text => text.replace('marker.value="active"', 'marker.value="changed"')));
});

it("rejects an additional raw node inside the exporter editor icon", () => {
  noGrant(part(xml("editor-local-event"), "fdDesignerHtml", text => text.replace('<INPUT type="hidden"', '<!-- hidden extra --><INPUT type="hidden"')));
});

it("does not use the new select-prefix contract to expand other typed renderers", () => {
  let text = part(xml("trailing-empty"), "fdDesignerHtml", value => value.replace('fd_type="select"', 'fd_type="inputText"'));
  text = part(text, "fdDisplayJsp", value => value.replace(/xform:select/g, "xform:xtext"));
  noGrant(text);
});

it("binds script-carrier identities through the existing fixed-source public gates", () => {
  const { source, dsl } = load();
  dsl.form.layout.sourceGrid.rows[0].trailingBlankCells.scriptCarrierIds = ["invented"];
  const trusted = checkTrust(source, createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true, reviewerName: "tail prefix mutation" }));
  const applied = applyEvidenceBackedPatches(dsl, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
  assert.equal(trusted.ok, false); assert.equal(applied.ok, false);
  for (const checked of [trusted, applied]) assert.ok(checked.diagnostics.some(item => /mobile_plain_caption_source_mismatch/.test(item.code)));
});


it("preserves the exporter raw CRLF items and nested required select decoration through the existing editor fixture", () => {
  const { dsl } = load(xml("editor-local-event"));
  const select = dsl.form.fields.find(field => field.id === "fd_choice");
  assert.equal(select.sourceProps.designerValues.items, "Ready|READY\r\nOther|OTHER");
  assert.deepEqual(select.props.options, [{ label: "Ready", value: "READY" }, { label: "Other", value: "OTHER" }]);
  assert.ok(fact(dsl));
  assert.ok(sourceMobileCaptionGrids(dsl.form).has(row(dsl).id));
  const before = structuredClone(dsl), prepared = prepareSample(dsl);
  assert.equal(prepared.verify(prepared.update).ok, true);
  assert.deepEqual(dsl, before);
});

for (const [name, edit] of [
  ["raw EOL outside items", value => value.replace('label:"Choice with tail blanks"', 'label:"Choice\r\nwith tail blanks"')],
  ["escaped line continuation", value => value.replace('items:"Ready|READY;Other|OTHER"', 'items:"Ready|READY\\\r\nOther|OTHER"')],
  ["unknown nested decoration", value => value.replace('<LABEL class="select_tag_face">', '<LABEL class="select_tag_left"><LABEL class="unknown">').replace('---请选择---</LABEL>', '---请选择---</LABEL></LABEL>')],
  ["meaningful multiline face", value => value.replace('---请选择---', '---\n请选择---')]
]) it(`does not widen complete source values or decorator grammar for ${name}`, () => {
  noGrant(part(xml("trailing-empty"), "fdDesignerHtml", edit));
});

for (const [name, edit] of [
  ["caption cell", value => value.replace('</LABEL>', '</LABEL>&nbsp;meaningful')],
  ["body cell", value => value.replace('</SELECT></DIV>', '</SELECT></DIV>&nbsp;meaningful')],
  ["tail cell", value => value.replace('&nbsp;', '&nbsp;meaningful')]
]) it(`does not call additional ${name} content empty decoration`, () => {
  noGrant(part(xml("trailing-empty"), "fdDesignerHtml", edit));
});

it("withholds the new proof when duplicate property attributes hide the natural ID behind a numeric HTML entity", () => {
  const duplicated = property => part(xml("trailing-empty"), "fdDisplayJsp", text => text.replace("</TBODY>",
    `<TR><TD row="1" column="0"><xform:xtext property="${property}" property="${property}"/></TD></TR></TBODY>`));
  const encoded = duplicated("extendDataFormInfo.value(&#102;d_choice)");
  assert.ok(encoded.includes("&amp;#102;d_choice"), "The full XML retains the extra HTML numeric-entity layer");
  noGrant(encoded);
  noGrant(duplicated("extendDataFormInfo.value(fd_choice)"));
  const unrelated = load(appendRuntime("extendDataFormInfo.value(fd_unrelated)"));
  assert.ok(fact(unrelated.dsl), "A distinct canonical field does not make the retained field ambiguous");
  assert.ok(sourceMobileCaptionGrids(unrelated.dsl.form).has(row(unrelated.dsl).id));
});
