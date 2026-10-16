import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sourceMobileCaptionGrids } from "../../src/dsl/source-mobile-caption-grid.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";

const root = "tests/fixtures/route-validation/mobile-caption-trailing-empty/";
const load = (name = "trailing-empty") => {
  const source = cleanSourceFile(`${root}${name}_SysFormTemplate.xml`);
  return { source, dsl: draftSourceDraft(source) };
};
const row = dsl => dsl.form.layout.mkTree[0];
const sourceRow = dsl => dsl.form.layout.sourceGrid.rows[0];
const grid = (view, scene) => view.view.render[scene][0].children[0].children[0].children.find(node => node.type === "@elem/layout-grid");
const view = prepared => JSON.parse(xformConfig(prepared.update).viewModel[0].fdConfig);
const trust = (source, dsl) => checkTrust(source, createTrustedMigrationDsl(source, dsl, {
  externalAgentReviewed: true, reviewerName: "synthetic trailing-empty source-bound test"
}));
const xml = readFileSync(`${root}trailing-empty_SysFormTemplate.xml`, "utf8");
const escapeXml = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function fromXml(text) {
  const directory = mkdtempSync(join(tmpdir(), "caption-tail-"));
  try {
    const file = join(directory, "tail_SysFormTemplate.xml"); writeFileSync(file, text);
    const source = cleanSourceFile(file); return { source, dsl: draftSourceDraft(source) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function part(text, key, edit) {
  const marker = `<string>${key}</string>`, at = text.indexOf(marker);
  assert.ok(at >= 0); const start = text.indexOf("<string>", at + marker.length) + "<string>".length;
  const end = text.indexOf("</string>", start), original = text.slice(start, end), next = edit(original);
  assert.notEqual(next, original, "The XML counterexample must actually change its intended part");
  return text.slice(0, start) + next + text.slice(end);
}
function tailBody(text, body, side = "both") {
  let next = text;
  for (const key of ["fdDesignerHtml", "fdDisplayJsp"]) if (side === "both" || side === key) {
    next = part(next, key, value => value.replace("&amp;nbsp;", escapeXml(body)));
  }
  return next;
}
function noTailGrant(text) {
  const { dsl } = fromXml(text);
  assert.equal(sourceMobileCaptionGrids(dsl.form).has(row(dsl).id), false);
  assert.equal(sourceRow(dsl).trailingBlankCells, undefined);
}

it("starts from valid XML and retains the original packed desktop row", () => {
  for (const name of ["trailing-empty", "local-event"]) {
    const { dsl } = load(name), before = structuredClone(dsl), prepared = prepareSample(dsl);
    assert.equal(sourceRow(dsl).columns, name === "trailing-empty" ? 3 : 4);
    assert.equal(sourceRow(dsl).preserveSourceGeometry, undefined);
    assert.equal(row(dsl).props.columns, 2);
    assert.deepEqual(row(dsl).children.map(cell => [cell.column, cell.colspan]), [[0, 1], [1, 1]]);
    assert.equal(prepared.verify(prepared.update).ok, true, "The original native request is valid before adding a mobile policy");
    assert.deepEqual(grid(view(prepared), "desktop").controlProps.colsStyle, projectNativeLayoutRows(dsl.form.layout.mkTree)[0].colsStyle);
    assert.deepEqual(dsl, before);
  }
});

it("gives the proven packed caption its intrinsic minimum and horizontal reach", () => {
  const { source, dsl } = load(), before = structuredClone(dsl), prepared = prepareSample(dsl), current = view(prepared);
  assert.ok(sourceMobileCaptionGrids(dsl.form).has(row(dsl).id), "Pure trailing source blanks must not leave a proved caption on a narrow percent track");
  const pc = grid(current, "desktop"), mobile = grid(current, "mobile");
  assert.match(mobile.controlProps.colsStyle[0].value, /^minmax\(max-content,/);
  assert.deepEqual(mobile.controlProps.colsStyle.slice(1), pc.controlProps.colsStyle.slice(1));
  assert.equal(mobile.controlProps.style.overflowX, "auto");
  assert.deepEqual(mobile.children, pc.children);
  assert.deepEqual(dsl, before);
  assert.equal(trust(source, dsl).ok, true);
});

it("accepts inert exporter cell hints and a retained JSP editor surrogate", async () => {
  const { dsl } = load("editor-local-event");
  assert.equal(dsl.scripts.actions.length, 1);
  const prepared = prepareSample(dsl);
  assert.equal(prepared.verify(prepared.update).ok, true);
  assert.ok(sourceMobileCaptionGrids(dsl.form).has(row(dsl).id));
  assert.match(grid(view(prepared), "mobile").controlProps.colsStyle[0].value, /^minmax\(max-content,/);
  const result = await runRouteCase("mobile-caption-trailing-empty-editor-event-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.transferRecord.status, "recorded");
  assert.equal(result.dsl.scripts.actions.length, 1);
  assert.deepEqual(result.dsl.formRules, dsl.formRules);
});

it("rejects losing the requested caption minimum, body track or scroll at readback", () => {
  for (const mutate of [
    (pc, mobile) => { mobile.controlProps.colsStyle = structuredClone(pc.controlProps.colsStyle); },
    (_pc, mobile) => { mobile.controlProps.colsStyle[1].value = "50%"; },
    (_pc, mobile) => { delete mobile.controlProps.style; }
  ]) {
    const prepared = prepareSample(load().dsl), changed = structuredClone(prepared.update), config = xformConfig(changed);
    const current = JSON.parse(config.viewModel[0].fdConfig), pc = grid(current, "desktop"), mobile = grid(current, "mobile");
    assert.match(mobile.controlProps.colsStyle[0].value, /^minmax\(max-content,/, "Only damage a policy that is really present");
    mutate(pc, mobile);
    config.viewModel[0].fdConfig = JSON.stringify(current); changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    const check = prepared.verify(changed);
    assert.equal(check.ok, false);
    assert.ok(check.diagnostics.some(item => /readback\.form\.(?:mobile_grid|layout)/.test(item.code)), JSON.stringify(check.diagnostics));
  }
});

it("binds the new source fact even if a mutation also removes layout eligibility", () => {
  for (const mutate of [
    dsl => { delete sourceRow(dsl).trailingBlankCells; },
    dsl => { sourceRow(dsl).trailingBlankCells.sourceColumns++; },
    dsl => { delete sourceRow(dsl).trailingBlankCells; row(dsl).props.columns = 1; }
  ]) {
    const { source, dsl } = load();
    assert.ok(sourceRow(dsl).trailingBlankCells, "The source must first carry the real trailing-blank fact");
    const before = structuredClone(dsl); mutate(dsl); assert.notDeepEqual(dsl, before);
    const check = trust(source, dsl);
    assert.equal(check.ok, false);
    assert.ok(check.diagnostics.some(item => /mobile_plain_caption_source_mismatch/.test(item.code)), JSON.stringify(check.diagnostics));
    const applied = applyEvidenceBackedPatches(dsl, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
    assert.equal(applied.ok, false);
    assert.ok(applied.diagnostics.some(item => /mobile_plain_caption_source_mismatch/.test(item.code)), JSON.stringify(applied.diagnostics));
  }
});

it("keeps the existing reviewed local event through complete fake routes", async () => {
  const raw = load("local-event").dsl;
  assert.equal(raw.scripts.actions.length, 1, "A real reachable source action must exist before testing preservation");
  for (const name of ["mobile-caption-trailing-empty-success", "mobile-caption-trailing-empty-event-success"]) {
    const result = await runRouteCase(name);
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.transferRecord.status, "recorded");
    if (name.endsWith("-event-success")) {
      assert.equal(result.dsl.scripts.actions.length, 1);
      assert.deepEqual(result.dsl.formRules, raw.formRules);
      assert.equal(result.dsl.scripts.actions[0].sourceRefs[0], raw.scripts.actions[0].sourceRefs[0]);
    }
    assert.ok(sourceMobileCaptionGrids(result.dsl.form).has(row(result.dsl).id));
  }
});

for (const [name, body] of [
  ["unknown text", "must retain"], ["BR", "<br/>"], ["comment", "<!-- retain -->"],
  ["script", "<script>localOnly();</script>"], ["style", "<style>.x{color:red}</style>"],
  ["hidden binding", '<input type="hidden" id="fd_extra"/>'],
  ["double encoded nbsp", "&amp;nbsp;"], ["numeric encoded amp", "&#38;nbsp;"],
  ["hex encoded amp", "&#x26;nbsp;"], ["unknown entity", "&unknown;"]
]) it(`does not erase a tail containing ${name}`, () => {
  assert.ok(sourceMobileCaptionGrids(load().dsl.form).has("layout.row-0"));
  noTailGrant(tailBody(xml, body));
});

for (const [name, edit] of [
  ["event attribute", value => value.replace('column="2"', 'column="2" onclick="noop()"')],
  ["duplicate attribute", value => value.replace('column="2"', 'column="2" column="2"')],
  ["unknown class", value => value.replace('column="2"', 'column="2" class="unknown"')],
  ["unknown exporter metadata", value => value.replace('column="2"', 'column="2" style_unknown="null"')],
  ["nonempty border metadata", value => value.replace('column="2"', 'column="2" style_borderleftwidth="2"')],
  ["column gap", value => value.replace('column="2"', 'column="4"')],
  ["tail colspan", value => value.replace('column="2"', 'column="2" colspan="2"')],
  ["tail rowspan", value => value.replace('column="2"', 'column="2" rowspan="2"')],
  ["mixed declared row", value => value.replace('row="0" column="2"', 'row="9" column="2"')]
]) it(`rejects a tail with ${name}`, () => {
  noTailGrant(part(xml, "fdDesignerHtml", edit));
});

it("requires both sides, effective widths and a globally unique body binding", () => {
  noTailGrant(tailBody(xml, "x", "fdDisplayJsp"));
  noTailGrant(part(xml, "fdDisplayJsp", value => value.replace("WIDTH:539px", "WIDTH:540px")));
  noTailGrant(part(xml, "fdDisplayJsp", value => value.replace("&lt;/TBODY&gt;", '&lt;TR&gt;&lt;TD&gt;&lt;xform:xtext property="extendDataFormInfo.value(fd_choice)"/&gt;&lt;/TD&gt;&lt;/TR&gt;&lt;/TBODY&gt;')));
  const permitted = part(xml, "fdDisplayJsp", value => value.replace('width="746"', 'width="999"'));
  assert.ok(sourceMobileCaptionGrids(fromXml(permitted).dsl.form).has("layout.row-0"), "The existing CSS width priority must remain intact");
});

it("keeps the complete raw JSP carrier and refuses content hidden by a markup masker", () => {
  const editorXml = readFileSync(`${root}editor-local-event_SysFormTemplate.xml`, "utf8");
  const rawCarrier = part(editorXml, "fdDesignerHtml", value => value.replace(/&amp;lt;/g, "&lt;").replace(/&amp;gt;/g, "&gt;"));
  const { dsl } = fromXml(rawCarrier), prepared = prepareSample(dsl);
  assert.equal(dsl.scripts.actions.length, 1);
  assert.ok(sourceMobileCaptionGrids(dsl.form).has(row(dsl).id));
  assert.match(grid(view(prepared), "mobile").controlProps.colsStyle[0].value, /^minmax\(max-content,/);
  for (const hidden of ["<script>extra();</script>", "<style>.extra{color:red}</style>", "<!-- extra -->"]) {
    const changed = part(editorXml, "fdDesignerHtml", value => value.replace('&lt;LABEL class="button_img"', escapeXml(hidden) + '&lt;LABEL class="button_img"'));
    noTailGrant(changed);
  }
  noTailGrant(part(editorXml, "fdDesignerHtml", value => value.replace("Designer_Control_JSP_ShowEditFrame(event, this);", "Designer_Control_JSP_ShowEditFrame(event, this); extra();")));
});

it("does not launder row, field or origin changes through a copied fact", () => {
  for (const mutate of [
    dsl => { sourceRow(dsl).trailingBlankCells.bodyId = "invented"; },
    dsl => { sourceRow(dsl).trailingBlankCells.keptWidthWeights[0]++; row(dsl).children[0].widthWeight++; sourceRow(dsl).cells[0].widthWeight++; },
    dsl => { row(dsl).children.reverse(); sourceRow(dsl).cells.reverse(); },
    dsl => { row(dsl).children[1].sourceRef += ".changed"; sourceRow(dsl).cells[1].sourceRef += ".changed"; },
    dsl => { dsl.form.fields.find(field => field.id === "fd_choice").props.readOnly = true; },
    dsl => { delete sourceRow(dsl).trailingBlankCells; dsl.form.fields.find(field => field.id === "fd_choice").dataOnly = true; }
  ]) {
    const { source, dsl } = load(), before = structuredClone(dsl); mutate(dsl); assert.notDeepEqual(dsl, before);
    const check = trust(source, dsl), applied = applyEvidenceBackedPatches(dsl, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
    assert.equal(check.ok, false); assert.equal(applied.ok, false);
    for (const result of [check, applied]) assert.ok(result.diagnostics.some(item => /mobile_plain_caption_source_mismatch/.test(item.code)), JSON.stringify(result.diagnostics));
  }
  const { source, dsl } = fromXml(tailBody(xml, "nonblank source"));
  assert.equal(sourceMobileCaptionGrids(dsl.form).has(row(dsl).id), false);
  sourceRow(dsl).trailingBlankCells = structuredClone(sourceRow(load().dsl).trailingBlankCells);
  assert.ok(sourceMobileCaptionGrids(dsl.form).has(row(dsl).id), "The forged fact really would grant the policy without fixed-source validation");
  assert.equal(trust(source, dsl).ok, false);
  assert.equal(applyEvidenceBackedPatches(dsl, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) }).ok, false);
});

it("uses natural source identities when long control IDs are remapped", () => {
  const captionId = `caption_${"long_".repeat(16)}`, bodyId = `field_${"long_".repeat(16)}`;
  const { source, dsl } = fromXml(xml.replace(/caption_choice/g, captionId).replace(/fd_choice/g, bodyId));
  const caption = dsl.form.fields.find(field => field.sourceProps?.originalId === captionId);
  const body = dsl.form.fields.find(field => field.sourceProps?.originalId === bodyId);
  assert.ok(caption && body); assert.notEqual(caption.id, captionId); assert.notEqual(body.id, bodyId);
  assert.ok(sourceMobileCaptionGrids(dsl.form).has(row(dsl).id));
  assert.equal(trust(source, dsl).ok, true);
  const prepared = prepareSample(dsl); assert.equal(prepared.verify(prepared.update).ok, true);
});

it("does not turn a layout fact into permission to delete or omit source actions", async () => {
  const { source, dsl: original } = load("local-event"), result = await runRouteCase("mobile-caption-trailing-empty-event-success");
  assert.equal(checkTrust(source, result.dsl).ok, true);
  const reviewedDraft = structuredClone(original);
  reviewedDraft.scripts = structuredClone(result.dsl.scripts);
  reviewedDraft.formRules = structuredClone(result.dsl.formRules);
  assert.equal(trust(source, reviewedDraft).ok, true);
  for (const mutate of [
    dsl => { dsl.scripts.actions = []; },
    dsl => { dsl.scripts.actions[0].function = "function onChange(value, rowNum, parentRowNum) {}"; }
  ]) {
    const changed = structuredClone(reviewedDraft); mutate(changed);
    assert.ok(sourceMobileCaptionGrids(changed.form).has(row(changed).id), "The layout grant remains, so the script gate must carry its own responsibility");
    assert.equal(trust(source, changed).ok, false);
    assert.equal(applyEvidenceBackedPatches(changed, [], { sourceDraft: source, sourceRefs: collectSourceRefs(source) }).ok, false);
  }
  const eventXml = readFileSync(`${root}local-event_SysFormTemplate.xml`, "utf8");
  const unknown = fromXml(eventXml.replace(/var marker=/g, "unknownCall();var marker="));
  assert.ok(sourceMobileCaptionGrids(unknown.dsl.form).has(row(unknown.dsl).id));
  const reviewed = await runAgentReview(unknown.source, unknown.dsl, { provider: createFakeReviewProvider("native-select-empty-event") });
  assert.equal(reviewed.ok, false, "The known fixture bridge cannot claim an additional unknown call was translated");
});

it("accepts literal whitespace entities but refuses active spans, nested rows and markers", () => {
  for (const blank of [" ", "\t\n", "&#160;", "&#xA0;"]) {
    assert.ok(sourceMobileCaptionGrids(fromXml(tailBody(xml, blank)).dsl.form).has("layout.row-0"));
  }
  let priorSpan = xml;
  for (const key of ["fdDesignerHtml", "fdDisplayJsp"]) priorSpan = part(priorSpan, key, value => value.replace("&lt;TR&gt;", '&lt;TR&gt;&lt;TD row="99" column="0" rowspan="2"&gt;retained&lt;/TD&gt;&lt;/TR&gt;&lt;TR&gt;'));
  noTailGrant(priorSpan);
  noTailGrant(part(xml, "fdDisplayJsp", value => value.replace("tail_table", "other_table")));
  noTailGrant(part(xml, "fdDesignerHtml", value => value.replace('&lt;LABEL fd_type="textLabel"', '&lt;INPUT type="hidden" id="row_marker" name="row_marker"/&gt;&lt;LABEL fd_type="textLabel"')));
  let nested = xml;
  for (const key of ["fdDesignerHtml", "fdDisplayJsp"]) nested = part(nested, key, value =>
    '&lt;TABLE fd_type="standardTable" id="outer_table"&gt;&lt;TBODY&gt;&lt;TR&gt;&lt;TD row="0" column="0"&gt;' + value + '&lt;/TD&gt;&lt;/TR&gt;&lt;/TBODY&gt;&lt;/TABLE&gt;');
  const nestedDsl = fromXml(nested).dsl;
  assert.equal(nestedDsl.form.layout.sourceGrid.rows.some(row => row.trailingBlankCells), false);
});
