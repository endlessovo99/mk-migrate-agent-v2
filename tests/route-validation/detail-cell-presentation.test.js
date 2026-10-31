import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { checkDraft, checkExecute } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { DETAIL_CELL_PRESENTATION_CAPABILITY } from "../../src/dsl/detail-cell-presentation-capability.js";
import { inspectDetailCellPresentationRuntime, inspectRegistry } from "../../src/executor/detail-cell-presentation-capability.js";
import { executeDsl } from "../../src/executor/execute.js";
import { NewoaClient } from "../../src/executor/newoa-client.js";
import { withDetailCellPresentation } from "../../src/executor/persistence/detail-cell-presentation.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sourceDraftFromLegacyDsl } from "../../src/translator/source-draft.js";
import { translateSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { runAgentReview } from "../../src/agent-review/runner.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";

const fixture = "tests/fixtures/route-validation/detail-shared-source-cell/shared-source-cell_SysFormTemplate.xml";
const fullFixture = "tests/fixtures/route-validation/detail-cell-presentation-full/full_SysFormTemplate.xml";
const otherFixture = "tests/fixtures/route-validation/choice-other-select-detail/choice-other-select-detail_SysFormTemplate.xml";
const actual = "tests/fixtures/source/19bb55286bd93a6081a33e44c3791374/19bb557531db577cfc0bbb248719d041_SysFormTemplate.xml";
function variant(change, path = fixture, key = "fdDesignerHtml") {
  const properties = parseRootHashMapStringPuts(readFileSync(path, "utf8")), before = properties[key];
  properties[key] = change(before);
  assert.notEqual(properties[key], before);
  const encode = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const xml = '<java><object class="java.util.HashMap">' + Object.entries(properties)
    .map(([key, value]) => `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`).join("") + "</object></java>";
  return sourceDraftFromLegacyDsl(translateSysFormTemplateXml(xml));
}

it("projects a source-proven two-field detail cell as one visible title with independent native fields", () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  const table = draft.form.fields.find(field => field.id === "fd_rows");
  assert.deepEqual(table.detailCellGroups, [{
    version: 1,
    fieldIds: ["fd_choice", "fd_other_text"],
    sourceRefs: ["source.form.detailTable.fd_rows.column.fd_choice", "source.form.detailTable.fd_rows.column.fd_other_text"],
    headerId: "fd_choice_title",
    sourceCell: { row: 1, column: 0, cell: 0 }
  }]);
  assert.equal(checkDraft(draft).diagnostics.some(item => item.code === "source.form.detail_cell_layout_unproven"), false);
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  assert.equal(checkTrust(source, trusted).ok, true);
  assert.equal(checkExecute(trusted).ok, true);
  const prepared = prepareSample(trusted), config = xformConfig(prepared.update);
  const model = config.dataModel.find(item => item.fdCode === "fd_rows");
  assert.deepEqual(model.fdFields.filter(field => !field.fdIsSystem).map(field => field.fdName),
    ["fd_choice", "fd_other_text", "fd_note"]);
  assert.ok(model.fdFields.filter(field => ["fd_choice", "fd_other_text"].includes(field.fdName)).every(field => field.fdIsStored));
  const actions = JSON.parse(config.attribute.formAttr).controlAction.global.onLoad || [];
  assert.ok(actions.some(action => action.migrationActions?.some(item => item.id === "mk-detail-cell-presentation-v1")));
  const controlActions = JSON.parse(config.attribute.formAttr).controlAction.control["fd_rows.fd_rows"].onLoad;
  assert.ok(controlActions.some(action => action.id === "mk-detail-cell-presentation-v1.fd_rows"));
  assert.equal(prepared.verify(prepared.update).ok, true);
  const changed = structuredClone(prepared.update), altered = xformConfig(changed), attrs = JSON.parse(altered.attribute.formAttr);
  attrs.controlAction.global.onLoad[0].function += "\n/* altered presentation */";
  altered.attribute.formAttr = JSON.stringify(attrs);
  changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(altered);
  assert.equal(prepared.verify(changed).partitions.scripts, "mismatch");
  const changedDetail = structuredClone(prepared.update), alteredDetail = xformConfig(changedDetail), attrsDetail = JSON.parse(alteredDetail.attribute.formAttr);
  attrsDetail.controlAction.control["fd_rows.fd_rows"].onLoad[0].function += "\n/* altered detail presentation */";
  alteredDetail.attribute.formAttr = JSON.stringify(attrsDetail);
  changedDetail.mechanisms["sys-xform"].fdConfig = JSON.stringify(alteredDetail);
  assert.equal(prepared.verify(changedDetail).partitions.scripts, "mismatch");
});

it("keeps an existing detail onLoad and generates idempotent form and table hooks", () => {
  const form = draftSourceDraft(cleanSourceFile(fixture)).form;
  const prior = { id: "source-detail-load", name: "onLoad", event: "onLoad", scope: "control", tableId: "fd_rows", controlId: "fd_rows", translationStatus: "mapped", function: "function onLoad() {}" };
  const scripts = withDetailCellPresentation({ actions: [prior] }, form, "mk_model_test");
  assert.equal(scripts.actions[0], prior);
  assert.equal(scripts.actions.length, 3);
  assert.equal(scripts.actions[1].scope, "global");
  assert.equal(scripts.actions[2].scope, "control");
  assert.equal(scripts.actions[2].tableId, "fd_rows");
  assert.equal(scripts.actions[2].controlId, "fd_rows");
  assert.equal(scripts.actions[1].function, scripts.actions[2].function);
  assert.equal(withDetailCellPresentation(scripts, form, "mk_model_test"), scripts);
  const changed = structuredClone(scripts); changed.actions[2].function += " ";
  assert.throws(() => withDetailCellPresentation(changed, form, "mk_model_test"));
});

it("recognizes all three reported IT cells without rendering the hidden data field", () => {
  const source = cleanSourceFile(actual), draft = draftSourceDraft(source);
  const table = draft.form.fields.find(field => field.id === "fd_371228ebe5dec2");
  assert.deepEqual(table.detailCellGroups.map(group => group.fieldIds), [
    ["fd_3715777bd2a30c", "fd_387ad60b48223c"],
    ["fd_37157808135860", "fd_387c6cd088b024"],
    ["fd_371576f83b26d8", "fd_37157738c61224"]
  ]);
  assert.equal(table.columns.find(column => column.id === "fd_isout_val").componentId, "xform-hidden");
  assert.equal(checkDraft(draft).diagnostics.some(item => /detail_cell_layout_unproven|choice_other_detail_layout_unproven/.test(item.code)), false);
});

it("retains an Other option and its independent explanation as two native data fields", () => {
  const source = variant(html => html.replace('<div fd_type="select"', '<div style="display:inline" fd_type="select"')
    .replace('<div fd_type="inputText" fd_values=\'{id:"fd_other_text"', '<div style="display:inline" fd_type="inputText" fd_values=\'{id:"fd_other_text"'), otherFixture);
  const draft = draftSourceDraft(source);
  const table = draft.form.fields.find(field => field.id === "fd_rows"), choice = table.columns.find(field => field.id === "fd_choice");
  assert.equal(choice.props.options.at(-1).value, "O_CODE");
  assert.equal(table.columns.find(field => field.id === "fd_other_text").componentId, "xform-input");
  assert.equal(checkDraft(draft).ok, true);
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  assert.equal(checkTrust(source, trusted).ok, true);
  const changed = structuredClone(draft);
  changed.form.fields.find(field => field.id === "fd_rows").columns.find(field => field.id === "fd_choice").props.options.at(-1).value = "other_";
  assert.ok(checkTrust(source, createTrustedMigrationDsl(source, changed, { externalAgentReviewed: true })).diagnostics
    .some(item => item.code === "trust.form.choice_other_companion_source_mismatch"));
});

it("keeps line breaks, extra text and unproved headers blocked instead of inventing a group", () => {
  for (const change of [
    html => html.replace('</select></div><div style="display:inline" fd_type="inputText"', '</select></div><br/><div style="display:inline" fd_type="inputText"'),
    html => html.replace('</select></div><div style="display:inline" fd_type="inputText"', '</select></div>额外说明<div style="display:inline" fd_type="inputText"'),
    html => html.replace('<label fd_type="textLabel" fd_values=\'{id:"fd_choice_title",content:"设备类别"}\'>设备类别</label>', '设备类别')
  ]) {
    const source = variant(change), draft = draftSourceDraft(source), table = draft.form.fields.find(field => field.id === "fd_rows");
    assert.equal(table.detailCellGroups, undefined);
    assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "source.form.detail_cell_layout_unproven"));
  }
});

it("keeps separate same-named cells separate and leaves a hidden companion data-only", () => {
  const separated = variant(html => html.replace('</select></div><div style="display:inline" fd_type="inputText"',
    '</select></div></td><td row="1" column="2"><div style="display:inline" fd_type="inputText"'));
  const separateDraft = draftSourceDraft(separated), separateTable = separateDraft.form.fields.find(field => field.id === "fd_rows");
  assert.equal(separateTable.detailCellGroups, undefined);
  assert.equal(checkDraft(separateDraft).diagnostics.some(item => item.code === "source.form.detail_cell_layout_unproven"), false);
  const hidden = variant(html => html.replace('id:"fd_other_text",label:', 'id:"fd_other_text",canShow:"false",label:'));
  assert.equal(draftSourceDraft(hidden).form.fields.find(field => field.id === "fd_rows").detailCellGroups, undefined);
});

it("does not infer a single inline line from block-level controls", () => {
  const source = variant(html => html.replaceAll(' style="display:inline"', ''));
  const draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.find(field => field.id === "fd_rows").detailCellGroups, undefined);
  assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "source.form.detail_cell_layout_unproven"));
});

it("blocks a reused physical header identity across independent source columns", () => {
  const source = variant(html => html.replace('id:"fd_note_title"', 'id:"fd_choice_title"'));
  const draft = draftSourceDraft(source);
  assert.equal(draft.form.fields.find(field => field.id === "fd_rows").detailCellGroups, undefined);
  assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "source.form.detail_cell_layout_unproven"));
});

it("blocks when the rendered source separates the fields or binds them to different detail rows", () => {
  const target = '<xform:xtext property="extendDataFormInfo.value(fd_rows.0.fd_other_text)"';
  const fullTarget = '<xform:xtext property="extendDataFormInfo.value(fd_rows.0.fd_other_text)" required="false" style="WIDTH: 120px"/>';
  for (const change of [
    html => html.replace(target, `</td><td>${target}`),
    html => html.replace('fd_rows.0.fd_other_text', 'fd_rows.1.fd_other_text'),
    html => html.replace(target, `<br/>${target}`),
    html => html.replace(fullTarget, `<c:if test="\${condition}">${fullTarget}</c:if>`),
    html => html.replace(fullTarget, `${fullTarget}${fullTarget}`),
    html => html.replace(fullTarget, `${fullTarget}${fullTarget.replace("fd_rows.0.", "fd_rows.${unknown}.")}`),
    html => html.replace(target, `<xform:xtext property="unsafe" property="extendDataFormInfo.value(fd_rows.0.fd_other_text)"`)
  ]) {
    const source = variant(change, fixture, "fdDisplayJsp"), draft = draftSourceDraft(source);
    assert.equal(draft.form.fields.find(field => field.id === "fd_rows").detailCellGroups, undefined);
    assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "source.form.detail_cell_layout_unproven"));
  }
});

it("does not borrow an unrelated runtime repeat loop for the reported IT cells", () => {
  const source = variant(html => html.replace(
    'items="${_xformForm.extendDataFormInfo.formData.fd_371228ebe5dec2}"',
    'items="${_xformForm.extendDataFormInfo.formData.other_table}"'
  ), actual, "fdDisplayJsp");
  const draft = draftSourceDraft(source), table = draft.form.fields.find(field => field.id === "fd_371228ebe5dec2");
  assert.equal(table.detailCellGroups, undefined);
  assert.equal(checkDraft(draft).diagnostics.filter(item => item.code === "source.form.detail_cell_layout_unproven" &&
    item.details.tableId === table.id).length, 3);
});

it("rejects forged presentation groups before a provider call and in trusted execution", async () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source), tableIndex = draft.form.fields.findIndex(field => field.id === "fd_rows");
  for (const mutate of [
    value => { value.form.fields[tableIndex].detailCellGroups[0].fieldIds.reverse(); },
    value => { value.form.fields[tableIndex].detailCellGroups[0].sourceRefs[1] = value.form.fields[tableIndex].detailCellGroups[0].sourceRefs[0]; },
    value => { delete value.form.fields[tableIndex].detailCellGroups; },
    value => { value.form.fields[tableIndex].columns[0].sourceProps.detailCell.inline = false; },
    value => { value.form.fields[tableIndex].columns[1].props.required = true; }
  ]) {
    const changed = structuredClone(draft); mutate(changed);
    const trusted = createTrustedMigrationDsl(source, changed, { externalAgentReviewed: true });
    assert.equal(checkTrust(source, trusted).ok, false);
    if (changed.form.fields[tableIndex].columns[1].props.required !== true) assert.equal(checkExecute(trusted).ok, false);
    let calls = 0;
    const reviewed = await runAgentReview(source, changed, { provider: { review: async () => { calls++; throw Error("unexpected provider call"); } } });
    assert.equal(reviewed.status, "blocked");
    assert.equal(reviewed.report.stage, "agent-review.input");
    assert.equal(calls, 0);
  }
  const patch = { op: "replace", path: `/form/fields/${tableIndex}/detailCellGroups`, value: [],
    sourceRefs: [draft.form.fields[tableIndex].sourceRef], confidence: 0.99, evidence: ["Do not separate a source cell."], rationale: "Test presentation integrity." };
  assert.equal(applyEvidenceBackedPatches(draft, [patch], { sourceDraft: source, sourceRefs: collectSourceRefs(source) }).ok, false);
});

it("requires exact QAS native registry, SDK and assets before a template write", async () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  const dsl = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  const options = { credentials: { username: "fixture", encryptedPassword: "fixture" }, confirmWrite: true, targetCategoryId: "route-category-id" };
  const other = new FakeNewoaAdapter("persist", { detailCellRuntime: true });
  const origin = await executeDsl(dsl, { ...options, client: other, baseUrl: "https://p-sit.onewo.com" });
  assert.equal(origin.status, "blocked");
  assert.ok(origin.diagnostics.some(item => item.code === "safety.detail_cell_presentation_origin_unverified"));
  assert.deepEqual(other.transcript(), []);
  const client = new FakeNewoaAdapter("persist", { detailCellRuntime: true });
  const get = client.getDetailCellAssetSha256.bind(client);
  client.getDetailCellAssetSha256 = async args => args.assetPath.endsWith("xform-m-detail-table/index.css") ? "changed" : get(args);
  const failed = await executeDsl(dsl, { ...options, client, baseUrl: DETAIL_CELL_PRESENTATION_CAPABILITY.origin });
  assert.equal(failed.status, "blocked");
  assert.equal(failed.stage, "verifyDetailCellPresentationRuntime");
  assert.equal(client.transcript().some(item => ["init", "add", "update", "save-workflow-draft"].includes(item.operation)), false);
  assert.ok(failed.diagnostics.some(item => item.code === "safety.detail_cell_presentation_runtime_unverified"));
});

it("rejects missing or ambiguous native registry entries and accepts the exact fake capability", async () => {
  const client = new FakeNewoaAdapter("persist", { detailCellRuntime: true }), origin = DETAIL_CELL_PRESENTATION_CAPABILITY.origin;
  assert.deepEqual(await inspectDetailCellPresentationRuntime(client, origin), { ok: true, issues: [] });
  client.getDetailCellElementRegistry = async () => 'APP_CONFIG["moduleDigest"]["sys/artifact"]={"@elem/xform-detail-table":{hash:"8fch0oB37j"},"@elem/xform-detail-table":{hash:"8fch0oB37j"}};';
  assert.deepEqual(await inspectDetailCellPresentationRuntime(client, origin), { ok: false, issues: ["native_asset_read_failed"] });
  for (const registry of [
    'APP_CONFIG["moduleDigest"]["sys/artifact"]={...unknown,"@elem/xform-detail-table":{hash:"8fch0oB37j"}};',
    'APP_CONFIG["moduleDigest"]["sys/artifact"]={"@elem/xform-detail-table":{hash:"8fch0oB37j"}};APP_CONFIG["moduleDigest"]["sys/artifact"]=unknown;',
    'APP_CONFIG["moduleDigest"]["sys/artifact"]={"@elem/xform-detail-table":{hash:"8fch0oB37j"}};APP_CONFIG["moduleDigest"]["sys/artifact"]["@elem/xform-detail-table"].hash="bad";',
    'window.unrelated={"@elem/xform-detail-table":{hash:"8fch0oB37j"}};'
  ]) assert.throws(() => inspectRegistry(registry));
  let calls = 0;
  const real = new NewoaClient({ baseUrl: origin, fetchImpl: async () => { calls++; throw Error("unexpected fetch"); } });
  await assert.rejects(real.getDetailCellAssetSha256({ assetPath: "../data/unsafe" }));
  assert.equal(calls, 0);
});

it("persists and reads back the verified native presentation through the fake QAS route", async () => {
  const source = cleanSourceFile(fullFixture), draft = draftSourceDraft(source);
  assert.deepEqual(draft.form.fields.find(field => field.id === "fd_rows").detailCellGroups.map(group => group.fieldIds), [
    ["fd_kind", "fd_kind_note"], ["fd_person", "fd_person_role"], ["fd_purchase", "fd_asset"]
  ]);
  const dsl = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  assert.equal(checkTrust(source, dsl).ok, true, JSON.stringify(checkTrust(source, dsl).diagnostics.filter(item => item.level === "error")));
  const client = new FakeNewoaAdapter("persist", { detailCellRuntime: true, templateAuthorization: dsl.template?.authorization });
  const result = await executeDsl(dsl, { client, baseUrl: DETAIL_CELL_PRESENTATION_CAPABILITY.origin,
    credentials: { username: "fixture", encryptedPassword: "fixture" }, confirmWrite: true, targetCategoryId: "route-category-id" });
  assert.equal(result.ok, true, JSON.stringify({ status: result.status, stage: result.stage, diagnostics: result.diagnostics }));
  assert.equal(result.apiStages.find(stage => stage.name === "verifyDetailCellPresentationRuntime")?.status, "ok");
  assert.equal(result.readback.partitions.scripts, "verified");
});
