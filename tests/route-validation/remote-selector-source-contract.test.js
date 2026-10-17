import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { executeDsl } from "../../src/executor/execute.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";
const fixture = "tests/fixtures/route-validation/remote-selector-source-contract/route-remote-source-contract_SysFormTemplate.xml";

it("carries source-only remote contracts without exposing secrets or allowing a fake target write", async () => {
  await withNetworkGuard(async () => {
    const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
    const field = draft.form.fields.find(field => field.id === "fd_lookup");
    assert.equal(field.sourceProps.remoteSelectorSourceContract.status, "static");
    const column = draft.form.fields.find(field => field.id === "fd_lines").columns.find(column => column.id === "fd_code");
    assert.equal(column.sourceProps.remoteSelectorSourceContract.tableId, "fd_lines");
    assert.equal(JSON.stringify(source).includes("SYNTHETIC_ONLY_SECRET"), false);
    assert.equal(JSON.stringify(draft).includes("SYNTHETIC_ONLY_SECRET"), false);
    const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true, reviewerName: "source-contract-fixture" });
    assert.equal(checkTrust(source, trusted).ok, false);
    assert.equal(buildDryRunPlan(trusted).ok, false);
    const client = new FakeNewoaAdapter("persist");
    const result = await executeDsl(trusted, { client, confirmWrite: true, targetCategoryId: "route-category-id",
      credentials: { username: "route-fixture", encryptedPassword: "route-fixture-password" } });
    assert.equal(result.ok, false); assert.deepEqual(client.transcript(), []);
  });
});

it("independently rejects changed, deleted and fabricated source contract facts", () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  const baseline = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true, reviewerName: "source-contract-fixture" });
  const code = "trust.form.remote_selector_contract_source_mismatch";
  assert.equal(checkTrust(source, baseline).diagnostics.some(item => item.code === code), false);
  for (const change of [
    field => { field.sourceProps.remoteSelectorSourceContract.sourceOrigin.designerSha256 = "0".repeat(64); },
    field => { delete field.sourceProps.remoteSelectorSourceContract; },
    field => { field.sourceProps.remoteSelectorSourceContract.targetResourceVerified = true; },
    field => { field.sourceProps.remoteSelectorSourceContract.outputMappings[0].targetField = "different_field"; }
  ]) {
    const changed = structuredClone(baseline); change(changed.form.fields.find(field => field.id === "fd_lookup"));
    assert.equal(checkTrust(source, changed).diagnostics.some(item => item.code === code), true);
  }
});
