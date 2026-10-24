import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { it } from "node:test";
import vm from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { nativeViewSaveRoundTrip } from "../helpers/native-view-save.js";
import { renderNativeDesignerLayout, matchingDesignerNodes } from "../helpers/native-designer-layout.js";
import { adaptiveStyles } from "../../src/executor/persistence/adaptive-layout.js";

const fixture = "tests/fixtures/route-validation/source-shared-track-layout/source-shared-track_SysFormTemplate.xml";
const attachmentFixture = "tests/fixtures/route-validation/source-shared-track-layout/source-attachment-hints_SysFormTemplate.xml";
const native = JSON.parse(readFileSync("tests/fixtures/executor/persistence/shared-source-tracks-native.json", "utf8"));
for (const part of Object.values(native.functions)) assert.equal(createHash("sha256").update(part.text).digest("hex"), part.sha256);
const expand = vm.runInNewContext(`(${native.functions.expandColsStyle.text})`);
const tracks = vm.runInNewContext(`(${native.functions.getColsStyle.text})`, { h: expand, o: value => typeof value });
const nodes = node => [node, ...(node.children || []).flatMap(nodes)];
const config = prepared => xformConfig(prepared.update);
const scene = (prepared, name = "desktop") => JSON.parse(config(prepared).viewModel[0].fdConfig).view.render[name][0];
const grid = (prepared, row, name = "desktop") => nodes(scene(prepared, name)).find(n => n.controlProps?.migrationRootNodeId === `layout.row-${row}` && n.type === "layout").children[0];
const wrapper = (prepared, id, name = "desktop") => nodes(scene(prepared, name)).find(n => n.controlProps?.className?.includes("mk-adaptive-main-field") && n.children?.some(c => c.key === id));
const stages = (path = fixture) => { const source = cleanSourceFile(path), draft = draftSourceDraft(source); return { source, draft, prepared: prepareSample(draft) }; };

it("retains source track boundaries through the actual native percentage renderer after caption folding", () => {
  const { prepared } = stages();
  const boundaries = [];
  for (const row of [1, 2, 3, 4]) {
    const node = grid(prepared, row), actual = [...tracks(node.controlProps.colsStyle, node.controlProps.columns)];
    assert.ok(actual.every(track => track.endsWith("%")), "Independent auto tracks cannot retain the shared source boundaries");
    // Source cells have widths 168, 420, 127, 733; folding must not replace
    // their six-column lattice with equal shares inside the merged cells.
    assert.ok(Math.abs(parseFloat(actual[0]) - 168 / 1448 * 100) < 1e-8);
    assert.ok(Math.abs(parseFloat(actual[1]) - 420 / 1448 * 100) < 1e-8);
    const labelStart = actual.slice(0, 2).reduce((sum, value) => sum + parseFloat(value), 0);
    const style = wrapper(prepared, `fd_right_${row}`).controlProps.style;
    const captionShare = parseFloat(style["--mk-adaptive-caption-width"]);
    assert.ok(Math.abs(captionShare - 127 / 860 * 100) < 1e-8);
    const valueStart = labelStart + (100 - labelStart) * captionShare / 100;
    boundaries.push({ labelStart, valueStart });
  }
  assert.ok(boundaries.every(b => Math.abs(b.labelStart - 588 / 1448 * 100) < 1e-8));
  assert.ok(boundaries.every(b => Math.abs(b.valueStart - 715 / 1448 * 100) < 1e-8));
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("aligns three complete source attachment columns without squeezing their upload or hint into the same line", () => {
  const { source, draft, prepared } = stages(attachmentFixture);
  assert.deepEqual(source.form.layout.rootTable, { version: 1, kind: "standard-table", rowCount: 3 });
  for (const row of [0, 1, 2]) {
    const node = grid(prepared, row), actual = [...tracks(node.controlProps.colsStyle, node.controlProps.columns)];
    assert.ok(actual.every(track => track.endsWith("%")), "Source-owned upload and hint must retain the repeated source column boundaries");
    assert.ok(Math.abs(actual.slice(0, 4).reduce((sum, value) => sum + parseFloat(value), 0) - 811 / 1209 * 100) < 1e-8);
    assert.ok(Math.abs(actual.slice(0, 5).reduce((sum, value) => sum + parseFloat(value), 0) - 966 / 1209 * 100) < 1e-8);
    const cell = node.children.find(cell => cell.children?.some(flow => nodes(flow).some(n => n.key === `fd_files_${row}`)));
    const flow = cell.children[0];
    assert.deepEqual(flow.children.map(line => line.children.map(item => item.children[0].key)), [[`fd_files_${row}`], [`attachment_hint_${row}`]]);
    for (const id of [`fd_files_${row}`, `attachment_hint_${row}`]) {
      assert.equal(wrapper(prepared, id).controlProps.style.flex, "1 1 0");
      assert.equal(wrapper(prepared, id).controlProps.style.minWidth, 0);
      assert.equal(wrapper(prepared, id).controlProps.style.maxWidth, "100%");
    }
    const sourceCell = source.form.layout.rows[row].cells.at(-1), dslCell = draft.form.layout.mkTree[row].children.at(-1);
    assert.deepEqual(sourceCell.contentFlow.lines, [[`fd_files_${row}`, `attachment_hint_${row}`]], "Source evidence remains the original inline pair");
    assert.deepEqual(dslCell.contentFlow.lines, sourceCell.contentFlow.lines, "DSL keeps the source ownership and flow");
    assert.deepEqual([...tracks(grid(prepared, row, "mobile").controlProps.colsStyle, 6)], Array(6).fill("auto"));
    const mobileCell = grid(prepared, row, "mobile").children.find(cell => nodes(cell).some(n => n.key === `fd_files_${row}`));
    assert.deepEqual(mobileCell.children[0].children.map(line => line.children.map(item => item.children[0].key)), sourceCell.contentFlow.lines);
    assert.equal(wrapper(prepared, `attachment_hint_${row}`, "mobile").controlProps.style.flex, "0 1 auto");
  }
  assert.equal(prepared.verify(prepared.update).ok, true);
});

it("preserves attachment and hint ownership through native save and rejects losing their separate readable lines", () => {
  const { prepared } = stages(attachmentFixture), before = config(prepared), saved = nativeViewSaveRoundTrip(before);
  for (const key of ["dataModel", "auth", "authFilter", "attribute"]) assert.deepEqual(saved[key], before[key], key);
  const target = structuredClone(prepared.update);
  target.mechanisms["sys-xform"].fdConfig = JSON.stringify(saved);
  assert.equal(prepared.verify(target).ok, true);
  const savedView = JSON.parse(saved.viewModel[0].fdConfig);
  const attachmentCell = root => nodes(root).find(node => node.type === "@elem/layout-grid.GridItem" &&
    nodes(node).some(child => child.key === "fd_files_0"));
  for (const mutate of [
    root => { const row = nodes(root).find(node => node.type === "layout" && node.controlProps.migrationRootNodeId === "layout.row-0"); row.children[0].controlProps.colsStyle = [{ startIndex: 0, count: 6, value: "auto" }]; },
    root => { const flow = attachmentCell(root).children[0]; flow.children[0].children.push(...flow.children.pop().children); },
    root => { attachmentCell(root).children[0].children.pop(); },
    root => { attachmentCell(root).children[0].children[1].children[0].controlProps.style.flex = "0 1 auto"; },
    root => { attachmentCell(root).controlProps.column = 5; }
  ]) {
    const changed = structuredClone(saved), view = structuredClone(savedView);
    mutate(view.view.render.desktop[0]); changed.viewModel[0].fdConfig = JSON.stringify(view);
    target.mechanisms["sys-xform"].fdConfig = JSON.stringify(changed);
    assert.equal(prepared.verify(target).ok, false, "Native readback must retain each upload, its source cell and its readable hint");
  }
});

it("fills only the source full-cell centered heading while leaving inline captions, units and Other intrinsic", () => {
  const { prepared } = stages();
  for (const platform of ["desktop", "mobile"]) {
    assert.equal(wrapper(prepared, "heading", platform).controlProps.style.flex, "1 1 0");
    for (const id of ["inline_caption", "inline_unit", "other_caption"]) {
      const item = wrapper(prepared, id, platform);
      assert.ok(item, id);
      assert.equal(item.controlProps.style.flex, "0 1 auto");
      assert.equal(item.controlProps.style["--mk-adaptive-caption-width"], undefined);
    }
  }
});

it("keeps mobile shared-row tracks adaptive until their proportional layout is separately evidenced", () => {
  const { prepared } = stages();
  for (const row of [1, 2, 3, 4]) {
    const node = grid(prepared, row, "mobile");
    assert.deepEqual([...tracks(node.controlProps.colsStyle, node.controlProps.columns)], Array(6).fill("auto"));
    assert.equal(wrapper(prepared, `fd_right_${row}`, "mobile").controlProps.style["--mk-adaptive-caption-width"], undefined);
  }
});

it("applies caption-width CSS only to proved folded-caption wrappers in the native designer structure", () => {
  const { prepared } = stages(), data = config(prepared);
  const { scope } = adaptiveStyles(data.dataModel.find(model => model.fdType === "main").fdTableName);
  const selector = `.${scope} ~ * .mk-adaptive-main-field[style*="--mk-adaptive-caption-width"] .ele-xform-fieldset-horizontal > .ele-xform-fieldset-label-wrap`;
  assert.equal(matchingDesignerNodes(renderNativeDesignerLayout(data, "desktop"), selector).length, 8);
  assert.equal(matchingDesignerNodes(renderNativeDesignerLayout(data, "mobile"), selector).length, 0);
});

it("retains the native desktop title budget for narrow proved caption cells through save and readback", () => {
  const { prepared } = stages(), root = scene(prepared);
  const carrier = nodes(root).find(node => node.controlProps?.dangerouslySetInnerHTML);
  const css = carrier.controlProps.dangerouslySetInnerHTML.__html;
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  const guarded = rules.filter(rule => rule[1].includes('[style*="--mk-adaptive-caption-width"]'));
  assert.equal(guarded.length, 1);
  assert.match(guarded[0][2], /min-width:\s*min\(50%,\s*145px\)\s*!important/);
  assert.ok(rules.filter(rule => !rule[1].includes('[style*="--mk-adaptive-caption-width"]'))
    .every(rule => !rule[2].includes("145px")), "Inline, mobile and unproved titles retain their existing behavior");
  const nativeCss = readFileSync("tests/fixtures/executor/persistence/adaptive-layout-native/xform-fieldset.css", "utf8");
  assert.match(nativeCss, /\.ele-xform-fieldset-desktop\.ele-xform-fieldset-horizontal[^{}]+\{width:8em;max-width:8em;/);
  assert.equal(145, 8 * 14 + 32 + 1, "Reuse the existing native desktop title, padding and border budget");
  const saved = nativeViewSaveRoundTrip(config(prepared)), target = structuredClone(prepared.update);
  target.mechanisms["sys-xform"].fdConfig = JSON.stringify(saved);
  assert.equal(prepared.verify(target).ok, true);
  const view = JSON.parse(saved.viewModel[0].fdConfig);
  const savedCarrier = nodes(view.view.render.desktop[0]).find(node => node.controlProps?.dangerouslySetInnerHTML);
  savedCarrier.controlProps.dangerouslySetInnerHTML.__html = savedCarrier.controlProps.dangerouslySetInnerHTML.__html
    .replace(/\s*min-width:\s*min\(50%,\s*145px\)\s*!important;/, "");
  saved.viewModel[0].fdConfig = JSON.stringify(view); target.mechanisms["sys-xform"].fdConfig = JSON.stringify(saved);
  assert.equal(prepared.verify(target).ok, false, "Discarding the readability floor must be detected on actual saved CSS");
});

function modifiedXml(change, run, path = fixture) {
  const dir = mkdtempSync(join(tmpdir(), "source-tracks-"));
  try { const target = join(dir, "source_SysFormTemplate.xml"); writeFileSync(target, change(readFileSync(path, "utf8"))); return run(cleanSourceFile(target)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function modifiedHtml(change, run, path = fixture) {
  return modifiedXml(xml => {
    const values = parseRootHashMapStringPuts(xml);
    values.fdDesignerHtml = change(values.fdDesignerHtml);
    const encode = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return '<java><object class="java.util.HashMap">' + Object.entries(values).map(([key, value]) =>
      `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`).join("") + "</object></java>";
  }, run, path);
}

const assertAutoTracks = (prepared, message = "Source outside the proved group keeps automatic tracks") => {
  const grids = nodes(scene(prepared)).filter(node => node.type === "@elem/layout-grid");
  assert.ok(grids.length);
  assert.ok(grids.every(node => node.controlProps.colsStyle.every(style => style.value === "auto")), message);
};

it("marks only a closed explicit standard-table direct-row parse as root table evidence", () => {
  assert.deepEqual(stages().source.form.layout.rootTable, { version: 1, kind: "standard-table", rowCount: 6 });
  for (const change of [
    xml => xml.replace('fd_type="standardTable"', 'fd_type="ordinaryTable"'),
    xml => xml.replace('&lt;/tbody&gt;&lt;/table&gt;', '&lt;/tbody&gt;')
  ]) modifiedXml(change, source => {
    assert.equal(source.form.layout.rootTable, undefined);
    const prepared = prepareSample(draftSourceDraft(source));
    for (const row of [1, 2, 3, 4]) assert.ok(grid(prepared, row).controlProps.colsStyle.every(style => style.value === "auto"));
  });
});

it("does not upgrade raw-text, attribute impersonation or ambiguous fallback markup into root evidence", () => {
  for (const change of [
    html => `<script>const template = '${html}';</script>`,
    html => `<textarea>${html}</textarea>`,
    html => `<noscript>${html}</noscript>`,
    html => `<template>${html}</template>`,
    html => html.replace('fd_type="standardTable"', 'data-note="fd_type=\'standardTable\'"'),
    html => html.replace("<tbody>", "<tbody><div>").replace("</tbody>", "</div></tbody>"),
    html => html.replaceAll('column="1" colspan="1" width="420">', 'column="1" colspan="1" width="420"><td>'),
    html => html.replaceAll('column="0" width="168"', 'column="0" width="168" rowspan="0"'),
    html => html.replaceAll('column="3,4,5" colspan="3"', 'column="3,4,5" colspan="1"'),
    html => html.replace("</tbody>", "</tbody><tbody></tbody>"),
    html => html + "<table><tr><td>second root</td></tr></table>",
    html => `<table><tr><td>${html}</td></tr></table>`
  ]) modifiedHtml(change, source => {
    assert.equal(source.form.layout.rootTable, undefined);
    assertAutoTracks(prepareSample(draftSourceDraft(source)));
  });
});

it("retains auto tracks for nested, compressed, incomplete and mixed inline source cells", () => {
  for (const [name, change] of Object.entries({
    nested: html => html.replace('<tbody>', '<tbody><tr><td colspan="6"><table><tbody>').replace('</tbody></table>', '</tbody></table></td></tr></tbody></table>'),
    percentage: html => html.replaceAll('width="733"', 'width="733%"'),
    em: html => html.replaceAll('width="733"', 'width="733em"'),
    gap: html => html.replaceAll('column="3,4,5" colspan="3"', 'column="4,5" colspan="2"'),
    rowspan: html => html.replaceAll('column="0" width="168"', 'column="0" width="168" rowspan="2"'),
    inline: html => { let index = 0; return html.replaceAll('width="733">', () =>
      `width="733"><label fd_type="textLabel" fd_values='{id:"inline_extra_${index++}",content:"另行说明",b:"true"}'>另行说明</label>`); }
  })) modifiedHtml(change, source => assertAutoTracks(prepareSample(draftSourceDraft(source)), name));
});

it("keeps other inline editors and unproved attachment hints on their existing automatic tracks", () => {
  for (const [name, change] of Object.entries({
    editorAndText: html => html.replaceAll('fd_type="attachment"', 'fd_type="inputText"'),
    reversed: html => html.replace(/(<div fd_type="attachment"[^>]+><\/div>)(<label fd_type="textLabel"[^>]+>[^<]+<\/label>)/g, "$2$1"),
    explicitBreak: html => html.replaceAll('</div><label fd_type="textLabel"', '</div><br/><label fd_type="textLabel"'),
    percentage: html => html.replaceAll('style="width:235px"', 'style="width:100%"'),
    zero: html => html.replaceAll('style="width:235px"', 'style="width:0px"'),
    extraHint: html => { let index = 0; return html.replaceAll('</label></td></tr>', () =>
      `</label><label fd_type="textLabel" fd_values='{id:"extra_hint_${index++}",content:"额外说明"}'>额外说明</label></td></tr>`); },
    shortUnit: html => html.replace(/(id:"attachment_hint_\d",content:")[^"]+("[^>]*>)[^<]+(<\/label>)/g, "$1MB$2MB$3"),
    otherCaption: html => html.replace(/(id:"attachment_hint_\d",content:")[^"]+("[^>]*>)[^<]+(<\/label>)/g, "$1其他$2其他$3")
  })) modifiedHtml(change, source => assertAutoTracks(prepareSample(draftSourceDraft(source)), name), attachmentFixture);
  for (const alter of [
    draft => { draft.form.fields.find(field => field.id === "attachment_hint_0").props.content = "changed hint"; },
    draft => { draft.form.fields.find(field => field.id === "fd_files_0").sourceRef = "source.form.control.unrelated"; },
    draft => { draft.form.layout.mkTree[0].children.at(-1).contentFlow.items[0].width.value = 200; },
    draft => { draft.form.layout.mkTree[0].children.at(-1).sourceRef = "source.form.layout.cell.unrelated"; },
    draft => { draft.form.layout.mkTree[0].children.at(-1).refIds.reverse(); }
  ]) {
    const { draft } = stages(attachmentFixture); alter(draft);
    assert.ok(grid(prepareSample(draft), 0).controlProps.colsStyle.every(style => style.value === "auto"), "A mismatching row must stay outside the proved run");
  }
  const { source, draft } = stages(attachmentFixture);
  const trusted = createTrustedMigrationDsl(source, draft, {
    externalAgentReviewed: true, reviewerName: "synthetic source attachment regression", checkedAt: "2026-10-24T00:00:00Z"
  });
  assert.equal(checkTrust(source, trusted).ok, true);
  trusted.form.layout.sourceGrid.rows[0].cells.at(-1).contentFlow.lines[0].reverse();
  assert.equal(checkTrust(source, trusted).ok, false, "The upload/hint source flow remains bound by complete sourceGrid trust");
});

it("keeps source-bound uploads with an independent caption outside the proved native-label attachment group", () => {
  modifiedHtml(html => html.replace(/id:"fd_files_(\d)",label:"附件[1-3]",_label_bind:"false",_label_bind_id:"former_caption_\d"/g,
    'id:"fd_files_$1",label:"附件",_label_bind:"true",_label_bind_id:"attachment_caption_$1"'), source => {
    const draft = draftSourceDraft(source);
    assert.ok(draft.form.fields.filter(field => field.componentId === "xform-attach").every(field => field.props.hiddenLabel === true));
    assertAutoTracks(prepareSample(draft), "An independently bound caption has no native upload-label geometry evidence");
  }, attachmentFixture);
});

it("preserves the real native save and reassembly boundary", () => {
  const { prepared } = stages(), before = config(prepared), after = nativeViewSaveRoundTrip(before);
  assert.deepEqual(after.dataModel, before.dataModel);
  const target = structuredClone(prepared.update);
  target.mechanisms["sys-xform"].fdConfig = JSON.stringify(after);
  assert.equal(prepared.verify(target).ok, true);
});

it("source-binds root evidence and every consumed grid fact even without folded captions", () => {
  const plain = '<table fd_type="standardTable"><tbody>' + [0, 1].map(row => '<tr>' + [0, 1].map(column =>
    `<td row="${row}" column="${column}" width="${column ? 75 : 25}"><div fd_type="inputText" fd_values='{id:"plain_${row}_${column}",label:"field",dataType:"String"}'><input/></div></td>`).join("") + '</tr>').join("") + '</tbody></table>';
  const trusted = source => createTrustedMigrationDsl(source, draftSourceDraft(source), {
    externalAgentReviewed: true, reviewerName: "synthetic source track regression", checkedAt: "2026-10-23T00:00:00Z"
  });
  modifiedHtml(() => plain, source => {
    const baseline = trusted(source);
    assert.equal(baseline.form.fields.some(field => field.sourceProps?.foldedCaption), false);
    assert.equal(checkTrust(source, baseline).ok, true);
    for (const alter of [
      grid => { delete grid.rootTable; },
      grid => { grid.rootTable.rowCount++; },
      grid => { grid.rows[0].sourceRow = 1; },
      grid => { grid.rows[0].cells[0].widthWeight = 40; grid.rows[0].cells[0].evidence.widthWeight = 40; },
      grid => { grid.source = "invented"; }
    ]) {
      const changed = structuredClone(baseline); alter(changed.form.layout.sourceGrid);
      const check = checkTrust(source, changed);
      assert.equal(check.ok, false);
      assert.ok(check.diagnostics.some(item => item.code === "trust.layout.source_grid_mismatch"));
    }
  });
  modifiedHtml(() => plain.replace('fd_type="standardTable"', 'fd_type="ordinaryTable"'), source => {
    const baseline = trusted(source);
    assert.equal(source.form.layout.rootTable, undefined);
    assert.equal(checkTrust(source, baseline).ok, true);
    baseline.form.layout.sourceGrid.rootTable = { version: 1, kind: "standard-table", rowCount: 2 };
    assert.equal(checkTrust(source, baseline).ok, false);
  });
});

it("rejects readback that loses a shared track, a folded-title boundary or full-cell stretch", () => {
  for (const mutate of [
    root => { const node = nodes(root).find(n => n.type === "layout" && n.controlProps.migrationRootNodeId === "layout.row-1").children[0]; node.controlProps.colsStyle = [{ startIndex: 0, count: 6, value: "auto" }]; },
    root => { const field = nodes(root).find(n => n.children?.some(c => c.key === "fd_right_1") && n.controlProps?.className?.includes("mk-adaptive-main-field")); delete field.controlProps.style["--mk-adaptive-caption-width"]; },
    root => { const field = nodes(root).find(n => n.children?.some(c => c.key === "heading") && n.controlProps?.className?.includes("mk-adaptive-main-field")); field.controlProps.style.flex = "0 1 auto"; }
  ]) {
    const { prepared } = stages(), changed = structuredClone(prepared.update), data = xformConfig(changed), view = JSON.parse(data.viewModel[0].fdConfig);
    mutate(view.view.render.desktop[0]); data.viewModel[0].fdConfig = JSON.stringify(view); changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(data);
    assert.equal(prepared.verify(changed).ok, false);
  }
});
