import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { buildAgentReviewPrompt } from "../../src/agent-review/prompt.js";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { executeDsl } from "../../src/executor/execute.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";
import { xformConfig } from "../helpers/persistence.js";

const fixture = "tests/fixtures/route-validation/detail-address-dot-fields/route-detail-address-dot-fields_SysFormTemplate.xml";
const ids = ["fd_sel_post", "fd_sel_in_dept", "fd_sel_in_post"];
function input() {
  const source = cleanSourceFile(fixture);
  return { source, draft: draftSourceDraft(source) };
}
const columns = draft => draft.form.fields.find(f => f.id === "fd_close_account").columns;

test("maps exact detail display pairs with stale disabled bindings to one editor and dot-free stored fields", async () => withNetworkGuard(async () => {
  const source = cleanSourceFile(fixture), before = structuredClone(source);
  const draft = draftSourceDraft(source);
  const all = draft.form.fields.flatMap(f => [f, ...f.columns || []]);
  assert.ok(all.every(f => !f.id.includes(".")));
  assert.equal(draft.form.fields.find(f => f.sourceProps.originalId === "fd_request.name").id, "fd_request_name");
  for (const id of ids) {
    const selector = columns(draft).find(f => f.id === id);
    const display = columns(draft).find(f => f.sourceProps.originalId === `${id}.name`);
    assert.equal(display.id, `${id}_name`);
    assert.equal(display.dataOnly, true);
    assert.equal(selector.title, selector.sourceProps.detailHeaderCaption.content);
    assert.deepEqual(selector.sourceProps.designerValues, source.form.detailTables[0].columns.find(f => f.id === id).sourceProps.designerValues);
  }
  assert.deepEqual(source, before);
  const reviewed = await runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.report));
  const adapter = new FakeNewoaAdapter("persist");
  const result = await executeDsl(reviewed.dsl, { client: adapter, baseUrl: "https://qas.example.invalid",
    confirmWrite: true, targetCategoryId: "route-category-id", credentials: { username: "fixture", encryptedPassword: "fixture" } });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const native = xformConfig(adapter.template), fields = native.dataModel.flatMap(m => m.fdFields || []);
  assert.ok(fields.every(f => !f.fdName.includes(".")));
  for (const id of ids) {
    assert.equal(fields.find(f => f.fdName === `${id}_name`).fdDisplay, false);
    assert.equal(fields.find(f => f.fdName === `${id}_name`).fdIsStored, true);
    assert.equal(fields.find(f => f.fdName === id).fdType, "address");
  }
  assert.equal(result.readback.ok, true);
}));

test("review blocks dotted main, table and hidden column IDs before calling the provider", async () => {
  for (const kind of ["main", "table", "column"]) {
    const { source, draft } = input();
    const field = kind === "main" ? draft.form.fields.find(f => f.type !== "detailTable")
      : kind === "table" ? draft.form.fields.find(f => f.type === "detailTable") : columns(draft)[0];
    field.id = "fd_invalid.name";
    let calls = 0;
    const result = await runAgentReview(source, draft, { provider: {
      metadata: () => ({ provider: "fixture" }),
      review: async () => { calls++; throw new Error("Invalid identities must be rejected locally"); }
    } });
    assert.equal(result.ok, false, kind);
    assert.equal(result.report.stage, "agent-review.input", kind);
    assert.ok(result.report.diagnostics.some(d => d.code === "agent.input.field_id_requires_remap"), JSON.stringify(result.report));
    assert.equal(calls, 0);
    assert.ok(validateMigrationDsl(draft, { mode: "draft" }).diagnostics.some(d => d.code === "dsl.field.id_contains_dot"));
  }
  const { source, draft } = input();
  assert.match(buildAgentReviewPrompt(source, draft).system, /field.*IDs.*must not contain.*\./i);
});

test("stale-title recovery requires an exact name/selector pair with matching physical headers", () => {
  for (const change of [
    table => { table.columns.find(c => c.id === "fd_sel_in_dept").sourceProps.detailHeaderCaption.id = "other_header"; },
    table => { table.columns.find(c => c.id === "fd_sel_in_dept").sourceProps.designerValues._label_bind = "true"; },
    table => { table.columns.find(c => c.id === "fd_sel_in_dept").sourceProps.designerValues.label = "独立选择器"; }
  ]) {
    const source = cleanSourceFile(fixture); change(source.form.detailTables[0]);
    const draft = draftSourceDraft(source), display = columns(draft).find(c => c.sourceProps.originalId === "fd_sel_in_dept.name");
    assert.notEqual(display.dataOnly, true);
    assert.equal(columns(draft).find(c => c.id === "fd_sel_in_dept").title, "调出公司及部门");
  }
});
