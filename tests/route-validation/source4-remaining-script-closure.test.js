import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runRouteCase } from "./run-route-case.js";
import { inspectDeterministicScriptBranchProof } from "../../src/dsl/deterministic-script-translations.js";

const SOURCE4 = "tests/fixtures/source4";
const CLOSED_IDS = [
  "177bdce608766f2502ee0714130bb55e",
  "17c8337f9b9ff6feda7f8e24cb482a75",
  "184d0e88f3949b8870a0558420682dee",
  "18a8356e42d059a3140a2644792895c3",
  "1923b93d7bcd8e63b7b743e45fba6361",
  "19a24476acdcc9ce5b708744206a2724",
  "19c9dac6eb80b3565aacdd64db6b7e34"
];

describe("Source4 remaining script-closure Route case", () => {
  it("trusts closed scripts and keeps remote lookup behavior explicitly unresolved", () => {
    for (const sourceId of CLOSED_IDS) {
      const source = cleanSourceFile(`${SOURCE4}/${sourceId}`);
      const draft = draftSourceDraft(source);
      const reviewActions = (draft.scripts?.actions || [])
        .filter((action) => action.translationStatus === "needs_review")
        .map((action) => action.id);

      const capabilityPending = draft.scripts.actions.filter(action => action.translationStatus === "needs_review" &&
        action.coverage?.residuals?.some(item => ["script.residual.remote_dialog_unbound", "script.residual.legacy_excel_import_contract_unverified"].includes(item.code)));
      assert.deepEqual(reviewActions, capabilityPending.map(action => action.id), sourceId);
      assert.equal(checkDraft(draft).ok, true, `${sourceId}: ${JSON.stringify(checkDraft(draft).diagnostics)}`);
      const trusted = createTrustedMigrationDsl(source, draft, {
        externalAgentReviewed: true,
        reviewerName: "route-validation",
        checkedAt: "2026-09-01T00:00:00.000Z"
      });
      const trust = checkTrust(source, trusted);
      const hasRemote = draft.review.warnings.some(item => item.code === "dsl.form.remote_dialog_unbound");
      const hasUnverifiedExcel=capabilityPending.some(action=>action.coverage.residuals.some(item=>item.code==="script.residual.legacy_excel_import_contract_unverified"));
      assert.equal(trust.ok, !hasRemote && !hasUnverifiedExcel, sourceId);
      if (hasRemote) assert.ok(trust.diagnostics.some(item => item.code === "trust.form.remote_dialog_unbound"));
      if (hasUnverifiedExcel) assert.ok(trust.diagnostics.some(item => item.code === "dsl.scripts.needs_review"));
    }
  });

  it("preserves the scheduled source existence guard and rejects erasing its timer or undefined check", () => {
    const source = cleanSourceFile(`${SOURCE4}/1859e7bfaa39079c5e082ab45ada2a9a`);
    const draft = draftSourceDraft(source);
    const action = draft.scripts.actions.find(action => action.id === "fd_3e74fe6f917cac.script.1.event.1");
    assert.ok(action);
    assert.deepEqual(action.sourceRefs, ["source.form.jsp.fd_3e74fe6f917cac.script.1"]);
    assert.equal(action.translationStatus, "mapped");
    assert.equal(inspectDeterministicScriptBranchProof(action).ok,true);
    assert.match(action.function, /current != undefined/);
    assert.match(action.function, /setTimeout/);
    const index = draft.scripts.actions.indexOf(action);
    const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true, reviewerName: "route-validation" });
    assert.equal(checkTrust(source,trusted).ok,true,JSON.stringify(checkTrust(source,trusted).diagnostics));
    assert.equal(buildDryRunPlan(trusted).ok,true);
    const immediate = action.function.replace("setTimeout(function() {", "").replace("}, 510);", "");
    const noExistenceGuard=action.function.replace("current != undefined","true");
    for (const functionText of [immediate,noExistenceGuard]) {
      const values = { function: functionText, translationStatus: "mapped",
        coverage: { status: "translated", nativeRules: [], residuals: [] },
        functionMappings: [{ source: "scheduled existence guard", target: "same timer and guard", basis: "semantic-translation", reviewRequired: false }] };
      const patches = Object.entries(values).map(([key, value]) => ({
        op: "replace", path: `/scripts/actions/${index}/${key}`, value, sourceRefs: action.sourceRefs,
        evidence: ["Retain the source timer, checked value read, undefined guard and row effect order."],
        rationale: "An unproved existence comparison must not borrow the equality-only timer proof.", confidence: 0.99
      }));
      assert.ok(patches.length > 0);
      assert.notEqual(functionText, action.function);
      const reviewed = applyEvidenceBackedPatches(draft, patches, { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
      const changed=reviewed.ok?reviewed.dslDraft:structuredClone(draft);
      if(!reviewed.ok){assert.ok(reviewed.diagnostics.some(item=>item.level==="error"));changed.scripts.actions[index].function=functionText;}
      assert.equal(changed.scripts.actions[index].function,functionText);
      const rejected=createTrustedMigrationDsl(source,changed,{externalAgentReviewed:true,reviewerName:"route-validation"});
      assert.equal(checkTrust(source,rejected).ok,false);
      assert.equal(buildDryRunPlan(rejected).ok,false);
    }
  });

  it("executes the supported complete timed fixture through review, trust, dry-run and fake readback", async () => {
    const result = await runRouteCase("timed-initialization-success");
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.readback.ok, true);
    assert.ok(result.dsl.scripts.actions.every(action => action.function.includes("setTimeout")));
  });
});
