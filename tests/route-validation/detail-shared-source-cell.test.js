import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { runAgentReview } from "../../src/agent-review/runner.js";
import { checkDraft, checkExecute } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { executeDsl } from "../../src/executor/execute.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sourceDraftFromLegacyDsl } from "../../src/translator/source-draft.js";
import { translateSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";

const fixture = "tests/fixtures/route-validation/detail-shared-source-cell/shared-source-cell_SysFormTemplate.xml";
const actual = "tests/fixtures/source/19bb55286bd93a6081a33e44c3791374/19bb557531db577cfc0bbb248719d041_SysFormTemplate.xml";
const code = "source.form.detail_cell_layout_unproven";

function variant(change) {
  const properties = parseRootHashMapStringPuts(readFileSync(fixture, "utf8"));
  const before = properties.fdDesignerHtml;
  properties.fdDesignerHtml = change(before);
  assert.notEqual(properties.fdDesignerHtml, before);
  const encode = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const xml = '<java><object class="java.util.HashMap">' + Object.entries(properties)
    .map(([key, value]) => `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`)
    .join("") + "</object></java>";
  return sourceDraftFromLegacyDsl(translateSysFormTemplateXml(xml));
}

it("blocks unproved line-broken detail cells before they become separate native columns", async () => {
  const source = variant(html => html.replace('</select></div><div style="display:inline" fd_type="inputText"', '</select></div><br/><div style="display:inline" fd_type="inputText"'));
  const draft = draftSourceDraft(source);
  const table = source.form.detailTables.find(item => item.id === "fd_rows");
  assert.deepEqual(table.columns.map(item => item.id), ["fd_choice", "fd_other_text", "fd_note"]);
  const diagnostic = checkDraft(draft).diagnostics.find(item => item.code === code);
  assert.ok(diagnostic, "the source has one physical header but the native writer would emit two");
  assert.deepEqual(diagnostic.details.fieldIds, ["fd_choice", "fd_other_text"]);
  let calls = 0;
  const review = await runAgentReview(source, draft, { provider: { review: async () => { calls++; throw Error("unexpected model call"); } } });
  assert.equal(review.status, "blocked");
  assert.equal(review.report.stage, "agent-review.input");
  assert.equal(calls, 0);
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  const trust = checkTrust(source, trusted);
  assert.ok(trust.diagnostics.some(item => item.code === "trust.form.detail_cell_layout_unproven"));

  const tampered = structuredClone(draft);
  delete tampered.review.errors;
  const second = tampered.form.fields.find(field => field.id === "fd_rows").columns.find(field => field.id === "fd_other_text");
  delete second.sourceProps.detailCell;
  second.dataOnly = true;
  const tamperedReview = await runAgentReview(source, tampered, { provider: { review: async () => { calls++; throw Error("unexpected model call"); } } });
  assert.equal(tamperedReview.status, "blocked");
  assert.equal(calls, 0);
  const tamperedTrust = checkTrust(source, createTrustedMigrationDsl(source, tampered, { externalAgentReviewed: true }));
  assert.ok(tamperedTrust.diagnostics.some(item => item.code === "trust.form.detail_cell_layout_unproven"));
});

it("records the three reported physical source cells and the hidden member", () => {
  const source = cleanSourceFile(actual), table = source.form.detailTables.find(item => item.id === "fd_371228ebe5dec2");
  const groups = table.columns.filter(column => column.sourceProps.detailCell &&
    column.sourceProps.detailCell.fieldIds[0] === column.id).map(column => column.sourceProps.detailCell.fieldIds);
  assert.deepEqual(groups, [
    ["fd_3715777bd2a30c", "fd_387ad60b48223c"],
    ["fd_37157808135860", "fd_387c6cd088b024"],
    ["fd_371576f83b26d8", "fd_37157738c61224", "fd_isout_val"]
  ]);
  assert.ok(table.columns.filter(column => column.sourceProps.detailCell).every(column => column.sourceProps.detailCell.inline === true));
});

it("blocks a retained trusted DSL before dry-run or any target client call", async () => {
  const source = variant(html => html.replace('</select></div><div style="display:inline" fd_type="inputText"', '</select></div><br/><div style="display:inline" fd_type="inputText"'));
  const draft = draftSourceDraft(source);
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  assert.ok(checkExecute(trusted).diagnostics.some(item => item.code === "dsl.form.detail_cell_layout_unproven"));
  const legacy = structuredClone(trusted);
  for (const column of legacy.form.fields.find(field => field.id === "fd_rows").columns) delete column.sourceProps.detailCell;
  assert.ok(checkExecute(legacy).diagnostics.some(item => item.code === "dsl.form.detail_cell_layout_unproven"));
  let calls = 0;
  const result = await executeDsl(trusted, { client: { login: async () => { calls++; } } });
  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid");
  assert.equal(calls, 0);
});

it("checks source cell identities after detail field IDs are remapped", () => {
  const xml = readFileSync(fixture, "utf8").replaceAll("fd_other_text", "fd_other.text");
  const source = sourceDraftFromLegacyDsl(translateSysFormTemplateXml(xml));
  const draft = draftSourceDraft(source), table = draft.form.fields.find(field => field.type === "detailTable");
  assert.ok(table.columns.some(field => field.id === "fd_other_text" && field.sourceProps.originalId === "fd_other.text"));
  const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  assert.equal(checkExecute(trusted).ok, true);
  assert.deepEqual(table.detailCellGroups[0].fieldIds, ["fd_choice", "fd_other_text"]);
  assert.equal(table.detailCellGroups[0].sourceRefs[1], "source.form.detailTable.fd_rows.column.fd_other.text");
});

it("does not group equally named controls in distinct physical detail cells", () => {
  const source = variant(html => html.replace(
    '</select></div><div style="display:inline" fd_type="inputText"',
    '</select></div></td><td row="1" column="2"><div style="display:inline" fd_type="inputText"'
  ));
  const table = source.form.detailTables.find(item => item.id === "fd_rows");
  assert.equal(table.columns.find(item => item.id === "fd_choice").title,
    table.columns.find(item => item.id === "fd_other_text").title);
  assert.equal(checkDraft(draftSourceDraft(source)).diagnostics.some(item => item.code === code), false);
});

it("does not treat a source-hidden data field as a second visible editor", () => {
  const source = variant(html => html.replace('id:"fd_other_text",label:', 'id:"fd_other_text",canShow:"false",label:'));
  const hidden = source.form.detailTables[0].columns.find(item => item.id === "fd_other_text");
  assert.equal(hidden.dataOnly === true || hidden.sourceProps.hardHidden === true, true);
  assert.equal(checkDraft(draftSourceDraft(source)).diagnostics.some(item => item.code === code), false);
});

it("fails closed on retained source drafts with a shared physical header but no cell inventory", () => {
  const source = cleanSourceFile(fixture);
  for (const column of source.form.detailTables[0].columns) delete column.sourceProps.detailCell;
  const draft = draftSourceDraft(source);
  const issue = checkDraft(draft).diagnostics.find(item => item.code === code);
  assert.deepEqual(issue?.details.fieldIds, ["fd_choice", "fd_other_text"]);
  assert.equal(issue.details.reason, "source_cell_membership_unavailable");
  assert.ok(checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true }))
    .diagnostics.some(item => item.code === "trust.form.detail_cell_layout_unproven"));
});

it("keeps the existing proven address and stored-display composite executable", () => {
  const source = cleanSourceFile("tests/fixtures/route-validation/detail-composite-review/composite-required_SysFormTemplate.xml");
  const draft = draftSourceDraft(source);
  assert.equal(checkDraft(draft).diagnostics.some(item => item.code === code), false);
  assert.equal(checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true })).ok, true);
});

it("reports an invalid source version without attempting a source rebuild or provider call", async () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  source.version = "invalid";
  let calls = 0;
  const result = await runAgentReview(source, draft, { provider: { review: async () => { calls++; } } });
  assert.equal(result.status, "blocked");
  assert.ok(result.report.diagnostics.some(item => item.code === "agent.input.source_draft_required"));
  assert.equal(calls, 0);
});
