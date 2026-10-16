import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sourceNumberDisplays, sourceNumberEditors } from "../../src/dsl/source-number-editor.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixture = "tests/fixtures/route-validation/static-jsp-caption-evidence/static-jsp-caption_SysFormTemplate.xml";
const xml = readFileSync(fixture, "utf8");
const caption = '<label>Displayed total</label>';
const editor = '<xform:xtext property="extendDataFormInfo.value(fd_total)" style="WIDTH:100px;DISPLAY:inline" htmlElementProperties="readonly" showStatus="${requestScope[\'SysForm.showStatus\']}"/>';
const island = '<%if ("readOnly".equals(request.getAttribute("SysForm.base.showStatus"))) {%><script>Com_IncludeFile("calculation_script.js", "../sys/xform/designer/calculation/");</script><%}%>';
const escaped = s => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function sourceXml(text = xml) {
  const dir = mkdtempSync(join(tmpdir(), "static-jsp-caption-"));
  try { const path = join(dir, "caption_SysFormTemplate.xml"); writeFileSync(path, text); return cleanSourceFile(path); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const raw = source => source.form.controls.find(f => f.id === "fd_total");
const target = draft => draft.form.fields.find(f => f.id === "fd_total");
function replace(from, to) { assert.ok(xml.includes(escaped(from)), from); return xml.replace(escaped(from), escaped(to)); }
function parentOf(node, name) {
  if ((node.children || []).some(child => child.key === name)) return node;
  for (const child of node.children || []) { const match = parentOf(child, name); if (match) return match; }
}

it("uses a proven no-markup JSP island with the existing adjacent caption geometry", () => {
  const source = sourceXml(), field = raw(source), draft = draftSourceDraft(source);
  assert.deepEqual(field.sourceProps.layoutCell, { hiddenLabel: true, relation: "retained-source-caption", captionIds: ["total_caption"], renderer: "xform:xtext", sourceRef: "source.form.fdDisplayJsp" });
  assert.equal(field.title, "Internal subject");
  assert.equal(field.sourceProps.designerValues._label_bind_id, "missing_caption");
  assert.equal(field.sourceProps.boundCaption, undefined);
  assert.equal(source.form.controls.filter(f => f.id === "total_caption").length, 1);
  assert.equal(target(draft).props.hiddenLabel, true);
  assert.equal(sourceNumberDisplays(draft.form).get("fd_total").inputPx, 100);
  const plain = sourceXml(replace(island, ""));
  assert.deepEqual([...sourceNumberEditors(source.form)], [...sourceNumberEditors(plain.form)]);
  assert.deepEqual([...sourceNumberEditors(source.form)], []);
  assert.equal(source.issues.some(x => x.code === "source.sysform.label_visibility_unverified" && x.evidence?.fieldId === "fd_total"), false);
});
it("preserves calculations, units and metadata while recovering desktop and mobile value budgets", () => {
  const source = sourceXml(), draft = draftSourceDraft(source);
  const prepared = prepareSample(draft), config = xformConfig(prepared.update), view = JSON.parse(config.viewModel[0].fdConfig);
  assert.equal(parentOf(view.view.render.desktop[0], "fd_total").controlProps.style.width, "132px");
  assert.equal(parentOf(view.view.render.mobile[0], "fd_total").controlProps.style.width, "132px");
  assert.equal(target(draft).title, "Internal subject");
  assert.deepEqual(target(draft).props.calculation, { kind: "formula", expression: "$fd_input$ * 2", displayExpression: "$Input$ * 2", fieldIds: ["fd_input"] });
  assert.equal(target(draft).props.precision, 2);
  assert.equal(draft.form.fields.find(f => f.id === "unit_total").props.content, "元");
  assert.equal(prepared.verify(prepared.update).ok, true);
});
it("retains a genuine trusted baseline and rejects deletion of recovered evidence", () => {
  const source = sourceXml(), draft = draftSourceDraft(source);
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true, reviewerName: "synthetic JSP caption regression", checkedAt: "2026-10-15T00:00:00Z" });
  assert.equal(checkTrust(source, trusted).ok, true);
  assert.equal(target(trusted).props.hiddenLabel, true);
  const changed = structuredClone(trusted); delete target(changed).props.hiddenLabel;
  assert.equal(checkTrust(source, changed).ok, false);
});
for (const [name, from, to] of [
  ["unknown JSP output", island, '<% out.write("<div>"); %>'],
  ["unknown JSP side effect", island, '<% mutateLayout(); %>'],
  ["unknown library", island, island.replace("calculation_script.js", "other.js")],
  ["candidate inside known request condition", island + editor, island.replace('<script>Com_IncludeFile("calculation_script.js", "../sys/xform/designer/calculation/");</script>', editor)],
  ["candidate inside unknown condition", editor, '<% if(flag) { %>' + editor + '<% } %>'],
  ["unclosed JSP", island, '<% if(flag) {'],
  ["unclosed opaque body", editor, '<script>' + editor],
  ["hidden ancestor", editor, '<div style="display:none">' + editor + '</div>'],
  ["transparent ancestor", editor, '<div style="opacity:0">' + editor + '</div>'],
  ["transformed ancestor", editor, '<div style="transform:scale(0)">' + editor + '</div>'],
  ["fractional zero opacity ancestor", editor, '<div style="opacity:.0">' + editor + '</div>'],
  ["conditional candidate", editor, '<c:if test="${flag}">' + editor + '</c:if>'],
  ["unknown status", editor, editor.replace("${requestScope['SysForm.showStatus']}", "unknown")],
  ["explicit intrinsic label", editor, editor.replace('/>', ' showLabel="true"/>')],
  ["uncertain intrinsic label", editor, editor.replace('/>', ' showLabel="${flag}"/>')],
  ["duplicate renderer", editor, editor + editor],
  ["noneditor binding collision", editor, editor + '<xform:text property="extendDataFormInfo.value(fd_total)"/>'],
  ["noncanonical main binding collision", editor, editor + editor.replace("value(fd_total)", "value( fd_total )")],
  ["opaque caption", caption, '<script>"Displayed total"</script>'],
  ["conditional caption", caption, '<c:if test="${flag}">' + caption + '</c:if>'],
  ["hidden caption", caption, '<div style="display:none">' + caption + '</div>'],
  ["transparent caption", caption, '<label style="opacity:0">Displayed total</label>'],
  ["transformed caption", caption, '<label style="transform:scale(0)">Displayed total</label>'],
  ["fractional zero opacity caption", caption, '<label style="opacity:.0">Displayed total</label>'],
  ["unknown inherited style key", caption, '<label style="constructor:anything">Displayed total</label>'],
  ["duplicate visible caption", caption, caption + caption],
  ["caption substring", caption, '<label>Displayed total extra</label>'],
  ["entity-escaped renderer sample", editor, editor.replaceAll("<", "&lt;").replaceAll(">", "&gt;")],
  ["entity-escaped caption sample", caption, caption.replaceAll("<", "&lt;").replaceAll(">", "&gt;")],
  ...["script", "style", "textarea", "pre", "code"].map(tag => ["opaque candidate " + tag, editor, '<' + tag + '>' + editor + '</' + tag + '>'])
]) it(`does not acquire new caption authority from ${name}`, () => {
  const source = sourceXml(replace(from, to));
  assert.notEqual(raw(source).sourceProps.layoutCell?.hiddenLabel, true);
  assert.equal(sourceNumberDisplays(source.form).has("fd_total"), false);
});
it("applies the same source proof after renaming field, caption, subject and visible text", () => {
  const changed = xml.replaceAll("fd_total", "other_total").replaceAll("total_caption", "other_caption").replaceAll("Displayed total", "Public sum").replaceAll("Internal subject", "Stored subject");
  const source = sourceXml(changed), field = source.form.controls.find(f => f.id === "other_total");
  assert.equal(field.sourceProps.layoutCell?.hiddenLabel, true);
  assert.equal(field.title, "Stored subject");
  assert.deepEqual(field.sourceProps.layoutCell.captionIds, ["other_caption"]);
});
it("does not recover a source caption with nonadjacent geometry", () => {
  const source = sourceXml(xml.replace('row="1" column="1"', 'row="1" column="2"'));
  assert.notEqual(raw(source).sourceProps.layoutCell?.hiddenLabel, true);
});
