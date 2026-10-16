import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { checkDraft, checkExecute } from "../../src/dsl/checks.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { buildFormRuleRefIndex, resolveEffectTarget } from "../../src/dsl/form-rules.js";
import { prepareSample } from "../helpers/persistence.js";
import { parseSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { scanHtmlTags, findMatchingCloseTag, splitDirectChildRows, splitDirectChildCells } from "../../src/translator/designer-html-tokenizer.js";
import { applyEvidenceBackedPatches } from "../../src/agent-review/review-validation.js";
import { attrValue } from "../../src/translator/xml-utils.js";
import { parseDesignerFdValues } from "../../src/translator/designer-control-values.js";

const dir = "tests/fixtures/route-validation/nested-spanned-header-grid";
const dateFace = (html, flag, editor = true) => html.replace(
  '<div fd_type="inputText" fd_values=\'{id:"fd_body_1",label:"Field fd_body_1",dataType:"String"}\'><input id="fd_body_1"/></div>',
  `<div fd_type="datetime"${editor ? ' formdesign="landray"' : ""} fd_values='{id:"fd_body_1",label:"Field fd_body_1",businessType:"Date"}'><input id="fd_body_1" thousandShow="${flag}"/></div>`
);
function rawTableRows(path) {
  const html = parseSysFormTemplateXml(readFileSync(path, "utf8")).fdDesignerHtml;
  const tables = [...scanHtmlTags(html)].filter(token => token.name === "table" && !token.closing);
  const nested = tables[1], end = findMatchingCloseTag(html, nested.end, "table");
  return splitDirectChildRows(html.slice(nested.end, end));
}

function nestedRowsAt(path, outerRow) {
  const html = parseSysFormTemplateXml(readFileSync(path, "utf8")).fdDesignerHtml;
  const body = fragment => {
    const table = [...scanHtmlTags(fragment)].find(token => token.name === "table" && !token.closing &&
      attrValue(token.raw, "fd_type") === "standardTable");
    return fragment.slice(table.end, findMatchingCloseTag(fragment, table.end, "table"));
  };
  return splitDirectChildRows(body(splitDirectChildRows(body(html))[outerRow]));
}

function withVariant(transform, run, sourcePath = `${dir}/ten-columns-two-header_SysFormTemplate.xml`) {
  const original = readFileSync(sourcePath, "utf8");
  const html = parseSysFormTemplateXml(original).fdDesignerHtml;
  const encode = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  const work = mkdtempSync(join(tmpdir(), "static-rectangle-route-"));
  try {
    const path = join(work, "variant_SysFormTemplate.xml");
    let matched = false;
    writeFileSync(path, original.replace(/(<string>fdDesignerHtml<\/string>\s*<string>)[\s\S]*?(<\/string>)/,
      (_, start, end) => { matched = true; return start + encode(transform(html)) + end; }));
    assert.equal(matched, true, "the mutated designer HTML must replace the XML property");
    run(path);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

it("accepts the same complete geometry with unrelated caption identities", () => {
  withVariant(html => html.replaceAll("h_", "renamed_caption_"), path => {
    const source = cleanSourceFile(path), draft = draftSourceDraft(source);
    const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
    assert.equal(checkTrust(source, trusted).ok, true);
    const [native] = projectNativeLayoutRows(draft.form.layout.mkTree);
    assert.equal(native.rows, 5);
    assert.equal(native.cells.filter(cell => cell.rowspan === 2).length, 6);
    assert.equal(native.cells.flatMap(cell => cell.refIds).filter(id => id.startsWith("renamed_caption_")).length, 12);
  });
});

for (const [name, transform] of [
  ["overlap", html => html.replace('row="1" column="4"', 'row="1" column="3"')],
  ["missing occupied slot", html => html.replace(/<td row="1" column="4"[\s\S]*?<\/td>/, "")],
  ["duplicate source identity", html => html.replaceAll("h_left_b", "h_left_a")],
  ["out-of-bounds rowspan", html => html.replace('row="0,1" column="0" rowspan="2"', 'row="0,1,2,3" column="0" rowspan="4"')],
  ["internal row marker", html => html.replace('row="1" column="3"', 'row="1" column="3"').replace('Caption h_left_a</label>', 'Caption h_left_a</label><input type="hidden" id="fd_inner_row" name="fd_inner_row"/>')],
  ["table alias collides with outer marker", html => html.replace('id="fd_grid_table"', 'id="fd_outer_row"')],
  ["table alias collides with field", html => html.replace('id="fd_grid_table"', 'id="fd_before"')],
  ["duplicate table alias", html => html.replace('<table fd_type="standardTable">', '<table fd_type="standardTable" id="fd_grid_table">')],
  ["unknown source widget", html => html.replace('Caption h_left_a</label>', 'Caption h_left_a</label><div fd_type="unknownWidget" fd_values=\'{id:"fd_unknown"}\'></div>')],
  ["unaccounted literal caption", html => html.replace('Caption h_left_a</label>', 'Caption h_left_a</label>Unaccounted caption')],
  ["unaccounted script subtree", html => html.replace('Caption h_left_a</label>', 'Caption h_left_a</label><script src="unverified.js"></script>')],
  ["script within declared caption", html => html.replace('Caption h_left_a</label>', 'Caption h_left_a<script src="unverified.js"></script></label>')],
  ["event within declared caption", html => html.replace('Caption h_left_a</label>', 'Caption h_left_a<span onclick="unknownCall()"></span></label>')],
  ["extra text within declared caption", html => html.replace('Caption h_left_a</label>', 'Caption h_left_a Unowned caption</label>')],
  ["event on declared caption", html => html.replace('<label fd_type="textLabel"', '<label onclick="unknownCall()" fd_type="textLabel"')],
  ["script within declared input", html => html.replace('<input id="fd_body_1"/>', '<input id="fd_body_1"/><script src="unverified.js"></script>')],
  ["unknown input property", html => html.replace('<input id="fd_body_1"/>', '<input id="fd_body_1" onchange="unknownCall()"/>')],
  ["non-boolean DateTime face flag", html => dateFace(html, "unknown")],
  ["undeclared non-editor DateTime flag", html => dateFace(html, "true", false)]
]) {
  it(`keeps ${name} fatal even after target review metadata is cleared`, () => withVariant(transform, path => {
    const source = cleanSourceFile(path), draft = draftSourceDraft(source);
    assert.ok(source.issues.some(issue => issue.code === "source.sysform.nested_geometry_unproven" && issue.level === "error"));
    draft.review.errors = [];
    const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
    trusted.review.errors = [];
    assert.equal(checkTrust(source, trusted).ok, false);
    assert.equal(applyEvidenceBackedPatches(draft, [], { sourceDraft: source }).ok, false);
  }));
}

it("consumes inert caption wrappers while preserving the exact declared caption text", () => withVariant(
  html => html.replace('Caption h_left_a</label>', '<span>Caption h_left_a</span></label>'), path => {
    const source = cleanSourceFile(path), draft = draftSourceDraft(source);
    assert.equal(checkDraft(draft).ok, true);
    assert.equal(draft.form.fields.find(field => field.id === "h_left_a").props.content, "Caption h_left_a");
  }
));

it("consumes a classic DateTime numeric-display face flag without adding a business property", () => withVariant(
  html => dateFace(html, "true"), path => {
    const source = cleanSourceFile(path), draft = draftSourceDraft(source);
    assert.equal(checkDraft(draft).ok, true);
    const field = draft.form.fields.find(field => field.id === "fd_body_1");
    assert.equal(field.componentId, "xform-datetime");
    assert.equal(Object.hasOwn(field.props, "thousandShow"), false);
    assert.equal(Object.hasOwn(field.sourceProps.designerValues || {}, "thousandShow"), false);
  }
));

for (const [name, transform] of [
  ["unknown editor title", html => html.replaceAll("权限区段1", "Unowned editor title")],
  ["unknown editor call", html => html.replaceAll("Designer_Control_Right_ShowLabelEditor(this)", "unknownCall(this)")]
]) {
  it(`keeps ${name} fatal in an otherwise declared permission editor face`, () => {
    const directory = "tests/fixtures/source4/16a8b7c0fa95aab79b5377e41929cc66";
    const sourcePath = join(directory, readdirSync(directory).find(file => file.endsWith("_SysFormTemplate.xml")));
    withVariant(html => { const changed = transform(html); assert.notEqual(changed, html); return changed; }, path => {
      const source = cleanSourceFile(path), draft = draftSourceDraft(source);
      assert.ok(source.issues.some(issue => issue.code === "source.sysform.nested_geometry_unproven" && issue.level === "error"));
      draft.review.errors = [];
      const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
      trusted.review.errors = [];
      assert.equal(checkTrust(source, trusted).ok, false);
      assert.equal(applyEvidenceBackedPatches(draft, [], { sourceDraft: source }).ok, false);
    }, sourcePath);
  });
}

it("keeps a coherent non-slicing rectangle arrangement blocked", () => {
  const source = cleanSourceFile(`${dir}/non-slicing-pinwheel_SysFormTemplate.xml`);
  assert.ok(source.issues.some(issue => issue.code === "source.sysform.nested_geometry_unproven"));
  const draft = draftSourceDraft(source);
  assert.equal(checkDraft(draft).ok, false);
});

for (const id of ["fd_grid_table", "fd_body_1"]) {
  it(`rejects metadata-only ${id} as a rendered alias or rectangle role`, () => withVariant(html => html, path => {
    const original = readFileSync(path, "utf8");
    writeFileSync(path, id === "fd_grid_table" ? original.replace("&lt;/metadata&gt;",
      `&lt;extendSimpleProperty name=&quot;${id}&quot; type=&quot;String&quot; canShow=&quot;false&quot;/&gt;&lt;/metadata&gt;`)
      : original.replace(`name=&quot;${id}&quot; type=&quot;String&quot;`, `name=&quot;${id}&quot; type=&quot;String&quot; canShow=&quot;false&quot;`));
    const source = cleanSourceFile(path), draft = draftSourceDraft(source);
    assert.ok(source.issues.some(issue => issue.code === "source.sysform.nested_geometry_unproven" && issue.level === "error"));
    draft.review.errors = [];
    const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
    trusted.review.errors = [];
    assert.equal(checkTrust(source, trusted).ok, false);
    assert.equal(applyEvidenceBackedPatches(draft, [], { sourceDraft: source }).ok, false);
  }));
}

for (const [sourceId, outerRow, height] of [
  ["16a8b7c0fa95aab79b5377e41929cc66", 9, 4],
  ["16a8b7ceb08e85444842a144b75ba94d", 11, 6],
  ["172fe2c19605b509159034b4cccad56c", 9, 4]
]) {
  it(`preserves actual sideband ${sourceId} raw cells, ordered references and table alias`, () => {
    const directory = `tests/fixtures/source4/${sourceId}`;
    const path = join(directory, readdirSync(directory).find(file => file.endsWith("_SysFormTemplate.xml")));
    const source = cleanSourceFile(directory), draft = draftSourceDraft(source);
    assert.equal(checkDraft(draft).ok, true);
    const native = projectNativeLayoutRows(draft.form.layout.mkTree).find(row => row.id === `layout.row-${outerRow}`);
    assert.equal(native.rows, height);
    assert.equal(native.columns, 4);
    const fields = new Set(draft.form.fields.map(field => field.id)), ids = [];
    nestedRowsAt(path, outerRow).forEach((rowHtml, row) => {
      for (const td of splitDirectChildCells(rowHtml)) {
        const refs = [];
        for (const token of scanHtmlTags(td.body)) {
          if (token.closing) continue;
          const type = attrValue(token.raw, "fd_type");
          if (!type) continue;
          const id = parseDesignerFdValues(token.attrs).id;
          if (type === "right") { assert.equal(fields.has(id), false); continue; }
          assert.ok(fields.has(id), `${id}: a raw scalar/caption cannot disappear from source layout`);
          refs.push(id);
        }
        const columns = td.attrs.column.split(",").map(Number);
        const [cell, ...extra] = native.cells.filter(cell => cell.refIds.some(id => refs.includes(id)));
        assert.equal(extra.length, 0);
        assert.deepEqual(cell.refIds, refs);
        assert.deepEqual([cell.row, cell.column, cell.colspan, cell.rowspan],
          [row, columns[0], columns.length, Number(td.attrs.rowspan ?? td.attrs.rowSpan ?? 1)]);
        if (refs.length > 1) assert.equal(cell.keepInline, true);
        ids.push(...refs);
      }
    });
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.equal(native.cells.flatMap(cell => cell.refIds).filter(ref => ref === id).length, 1);
    assert.deepEqual(new Set(resolveEffectTarget(buildFormRuleRefIndex(draft.form), "fd_353d2e68f4a0e4").targets.map(target => target.id)), new Set(ids));
  });
}

for (const [name, height, columns, gridFields] of [["ten-columns-two-header", 3, 10, 22], ["sideband-4", 4, 4, 12], ["sideband-6", 6, 4, 16]]) {
  it(`preserves ${name} raw rectangles, source identity, table/outer marker scopes and fake native persistence`, () => {
    const path = `${dir}/${name}_SysFormTemplate.xml`, source = cleanSourceFile(path), draft = draftSourceDraft(source);
    assert.equal(source.form.controls.length, gridFields + 2);
    assert.equal(source.issues.some(issue => issue.code === "source.sysform.nested_geometry_unproven"), false);
    const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true, reviewerName: "static rectangle source review" });
    for (const check of [checkDraft(draft), checkTrust(source, trusted), checkExecute(trusted), buildDryRunPlan(trusted)]) {
      assert.equal(check.ok, true, JSON.stringify(check.diagnostics));
    }
    const [native] = projectNativeLayoutRows(draft.form.layout.mkTree);
    assert.equal(native.rows, height + 2);
    assert.equal(native.columns, columns);
    const fields = new Set(draft.form.fields.map(field => field.id));
    const gridIds = [];
    rawTableRows(path).forEach((html, row) => {
      for (const cell of splitDirectChildCells(html)) {
        const ids = [...new Set([...cell.body.matchAll(/\bid\s*:\s*(["'])(.*?)\1/g)].map(match => match[2]).filter(id => fields.has(id)))];
        assert.ok(ids.length);
        gridIds.push(...ids);
        const coords = String(cell.attrs.column).split(",").map(Number);
        const projected = native.cells.filter(cell => cell.refIds.some(id => ids.includes(id)));
        assert.equal(projected.length, 1);
        assert.deepEqual(projected[0].refIds, ids);
        assert.deepEqual([projected[0].row, projected[0].column, projected[0].colspan, projected[0].rowspan],
          [row + 1, coords[0], coords.length, Number(cell.attrs.rowspan ?? cell.attrs.rowSpan ?? 1)], ids.join(","));
      }
    });
    assert.equal(gridIds.length, gridFields);
    for (const id of gridIds) assert.equal(native.cells.flatMap(cell => cell.refIds).filter(ref => ref === id).length, 1, id);
    const refs = buildFormRuleRefIndex(draft.form);
    assert.deepEqual(new Set(resolveEffectTarget(refs, "fd_grid_table").targets.map(target => target.id)), new Set(gridIds));
    assert.deepEqual(new Set(resolveEffectTarget(refs, "fd_outer_row").targets.map(target => target.id)), new Set([...gridIds, "fd_before", "fd_after"]));
    assert.ok(draft.form.layout.mkTree.every(row => row.props.columns <= 8));
    const prepared = prepareSample(trusted), readback = prepared.verify(prepared.update);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(readback.form.layoutRows[0].rows, height + 2);
    assert.equal(draft.form.fields.some(field => field.type === "detailTable"), false);
    if (name === "ten-columns-two-header") {
      assert.equal(draft.form.fields.filter(field => field.componentId === "xform-description").length, 13);
      assert.equal(native.cells.filter(cell => cell.rowspan === 2).length, 6);
      assert.equal(native.cells.filter(cell => cell.row === 1 && cell.colspan === 2).length, 2);
      const captions = ["h_name", "h_code", "h_left_a", "h_left_b", "h_right_a", "h_right_b", "h_date", "h_reason", "h_note"];
      captions.forEach((caption, index) => {
        const body = draft.form.fields.find(field => field.id === `fd_body_${index + 1}`);
        assert.equal(body.props.hiddenLabel, true);
        assert.deepEqual(body.sourceProps.layoutCell.captionIds, [caption]);
      });
      assert.ok(draft.form.fields.filter(field => field.componentId === "xform-description").every(field => field.props.hiddenLabel === undefined));
      const sourceContainer = source.form.layout.rows.find(row => row.sourceMarkers?.includes("fd_grid_table"));
      assert.equal(draft.form.layout.mkTree.filter(row => row.sourceRef === sourceContainer.sourceRef).length, 9);
    }
  });
}
