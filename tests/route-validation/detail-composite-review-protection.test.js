import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { executeDsl } from "../../src/executor/execute.js";
import { nativeRequiredRuntime } from "../helpers/native-required-runtime.js";
import { xformConfig } from "../helpers/persistence.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";

const fixture = "tests/fixtures/route-validation/detail-composite-review/composite-required_SysFormTemplate.xml";
function input() {
  const source = cleanSourceFile(fixture);
  return { source, draft: draftSourceDraft(source) };
}
function column(draft, id) {
  return draft.form.fields.find(field => field.id === "personRows").columns.find(field => field.id === id);
}
function patch(draft, id, value) {
  const table = draft.form.fields.findIndex(field => field.id === "personRows");
  const index = draft.form.fields[table].columns.findIndex(field => field.id === id);
  return { op: "replace", path: `/form/fields/${table}/columns/${index}/props`, value,
    sourceRefs: [column(draft, id).sourceRef], confidence: 0.95,
    evidence: ["The source person selector itself has required=false."],
    rationale: "Review the selector property using the exported source evidence." };
}
function apply({ source, draft }, patches) {
  return applyEvidenceBackedPatches(draft, patches, { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
}
function trusted({ source, draft }) {
  return createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true,
    reviewerName: "composite-route-fixture", checkedAt: "2026-10-24T00:00:00.000Z" });
}
const mismatch = code => code.endsWith("detail_composite_required_source_mismatch");

test("review patch cannot lower the source-required composite selector or require its invisible shadow", () => {
  const x = input(), before = JSON.stringify(x.draft);
  for (const [id, value] of [["employee_selector", { required: false }], ["employee_text", { required: true }],
    ["reviewer_selector", { required: false }], ["optional_selector", { required: true }]]) {
    const result = apply(x, [patch(x.draft, id, value)]);
    assert.equal(result.ok, false, id);
    assert.ok(result.diagnostics.some(d => mismatch(d.code)), JSON.stringify(result.diagnostics));
    assert.equal(JSON.stringify(x.draft), before);
  }
});

test("both-optional composite stays optional and unrelated partial props remain reviewable", () => {
  const x = input();
  const result = apply(x, [patch(x.draft, "optional_selector", { required: false }),
    patch(x.draft, "employee_text", { placeholder: "Stored employee name" })]);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(column(result.dslDraft, "employee_selector").props.required, true);
  assert.equal(column(result.dslDraft, "optional_selector").props.required, false);
  assert.deepEqual(column(result.dslDraft, "employee_selector").props.orgTypes, ["ORG_TYPE_PERSON"]);
  assert.equal(checkTrust(x.source, trusted({ source: x.source, draft: result.dslDraft })).ok, true);
});

test("source rebuild defeats forged, missing and pre-tampered composite witnesses at patch and trust boundaries", () => {
  for (const mutate of [
    draft => { column(draft, "employee_selector").props.required = false; },
    draft => { delete column(draft, "employee_selector").sourceProps.legacyDetailComposite; },
    draft => { column(draft, "employee_selector").sourceProps.legacyDetailComposite.storedDisplayFieldId = "optional_text"; },
    draft => { column(draft, "employee_selector").dataOnly = true; },
    draft => { draft.form.fields.find(f => f.id === "personRows").columns.splice(1, 1); }
  ]) {
    const x = input(); mutate(x.draft);
    const reviewed = apply(x, []), checked = checkTrust(x.source, trusted(x));
    assert.equal(reviewed.ok, false);
    assert.ok(reviewed.diagnostics.some(d => mismatch(d.code)), JSON.stringify(reviewed.diagnostics));
    assert.equal(checked.ok, false);
    assert.ok(checked.diagnostics.some(d => mismatch(d.code)), JSON.stringify(checked.diagnostics));
  }
});

test("bounded public model review rejects the unsafe patch then preserves native add/edit required projection", async () => withNetworkGuard(async () => {
  const x = input(), adapter = new FakeNewoaAdapter("persist"), invalid = patch(x.draft, "employee_selector", { required: false });
  let calls = 0;
  const provider = {
    metadata: () => ({ provider: "route-validation", baseUrl: "offline://composite-required", model: "fixture" }),
    async review() {
      calls++;
      assert.equal(adapter.entries.length, 0, "Review must finish before any executor client call");
      return { ok: true, rawText: JSON.stringify({ summary: "Review source-backed composite mandatory state.",
        patches: calls === 1 ? [invalid] : [], diagnostics: [] }) };
    }
  };
  provider.repairReviewResponse = () => provider.review();
  const reviewed = await runAgentReview(x.source, x.draft, { provider, maxRepairAttempts: 1 });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.report));
  assert.equal(calls, 2);
  assert.ok(reviewed.report.repairHistory.some(h => h.diagnostics.some(d => mismatch(d.code))));
  assert.equal(checkTrust(x.source, reviewed.dsl).ok, true);
  assert.equal(buildDryRunPlan(reviewed.dsl).ok, true);
  const execution = await executeDsl(reviewed.dsl, { client: adapter, baseUrl: "https://qas.example.invalid",
    confirmWrite: true, targetCategoryId: "fixture-category",
    credentials: { username: "fixture", encryptedPassword: "fixture" },
    transferRecordIdFactory: () => "compositereview000000000000000001" });
  assert.equal(execution.ok, true, JSON.stringify(execution.diagnostics));
  const config = xformConfig(adapter.template), table = config.dataModel.find(m => m.fdCode === "personRows");
  for (const scene of ["add", "edit"]) {
    const native = nativeRequiredRuntime(structuredClone(config), scene);
    for (const id of ["employee_selector", "reviewer_selector"]) assert.equal(native.detailRequired(table.fdTableName, id), true);
    for (const id of ["employee_text", "optional_text", "optional_selector", "reviewer_text"]) assert.equal(native.detailRequired(table.fdTableName, id), false);
  }
}));

test("unsafe public model review ends before dry-run or any executor client call", async () => withNetworkGuard(async () => {
  const x = input(), adapter = new FakeNewoaAdapter("persist");
  const provider = { metadata: () => ({ provider: "route-validation", baseUrl: "offline://composite-required", model: "fixture" }),
    async review() { return { ok: true, rawText: JSON.stringify({ summary: "Unsafe optional-selector-only patch.",
      patches: [patch(x.draft, "employee_selector", { required: false })], diagnostics: [] }) }; } };
  const reviewed = await runAgentReview(x.source, x.draft, { provider, maxRepairAttempts: 0 });
  assert.equal(reviewed.ok, false);
  assert.equal(reviewed.dsl, undefined);
  assert.equal(adapter.entries.length, 0);
}));
