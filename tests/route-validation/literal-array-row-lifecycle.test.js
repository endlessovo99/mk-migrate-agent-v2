import assert from "node:assert/strict";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { checkTrust } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { executeDsl } from "../../src/executor/execute.js";
import { inspectDeterministicScriptBranchProof } from "../../src/dsl/deterministic-script-translations.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";

const file = "tests/fixtures/route-validation/literal-array-row-lifecycle/route-literal-array-row_SysFormTemplate.xml";
it("closes immutable membership and a source-bound pure helper through the complete fake route", async () => withNetworkGuard(async () => {
  const source = cleanSourceFile(file), draft = draftSourceDraft(source);
  assert.equal(draft.scripts.actions.length, 2);
  for (const action of draft.scripts.actions) {
    assert.equal(action.translationStatus, "mapped", action.id);
    assert.equal(inspectDeterministicScriptBranchProof(action).ok, true);
  }
  const reviewed = await runAgentReview(source, draft, { provider: createFakeReviewProvider("accept") });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.diagnostics));
  assert.equal(checkTrust(source, reviewed.dsl).ok, true);
  assert.equal(buildDryRunPlan(reviewed.dsl).ok, true);
  const client = new FakeNewoaAdapter("persist");
  const result = await executeDsl(reviewed.dsl, { client, confirmWrite: true, targetCategoryId: "route-category-id",
    credentials: { username: "route-user", encryptedPassword: "route-password" },
    transferRecordIdFactory: () => "route0000000000000000000000000000000" });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.readback.ok, true); assert.equal(result.transferRecord.status, "recorded");
  const changed = structuredClone(reviewed.dsl);
  changed.scripts.actions[0].function = changed.scripts.actions[0].function.replace('indexOf', 'lastIndexOf');
  assert.equal(checkTrust(source, changed).ok, false);
}));
