import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { runRouteCase } from "./run-route-case.js";

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

      const remotePending = draft.scripts.actions.filter(action => action.translationStatus === "needs_review" &&
        action.coverage?.residuals?.some(item => item.code === "script.residual.remote_dialog_unbound"));
      assert.deepEqual(reviewActions, remotePending.map(action => action.id), sourceId);
      assert.equal(checkDraft(draft).ok, true, `${sourceId}: ${JSON.stringify(checkDraft(draft).diagnostics)}`);
      const trusted = createTrustedMigrationDsl(source, draft, {
        externalAgentReviewed: true,
        reviewerName: "route-validation",
        checkedAt: "2026-09-01T00:00:00.000Z"
      });
      const trust = checkTrust(source, trusted);
      const hasRemote = draft.review.warnings.some(item => item.code === "dsl.form.remote_dialog_unbound");
      assert.equal(trust.ok, !hasRemote, sourceId);
      if (hasRemote) assert.ok(trust.diagnostics.some(item => item.code === "trust.form.remote_dialog_unbound"));
    }
  });

  it("keeps the scheduled source existence guard blocked instead of erasing its timer or undefined check", () => {
    const source = cleanSourceFile(`${SOURCE4}/1859e7bfaa39079c5e082ab45ada2a9a`);
    const draft = draftSourceDraft(source);
    const pending = draft.scripts.actions.filter(action => action.translationStatus === "needs_review");
    assert.deepEqual(pending.map(action => action.id), ["fd_3e74fe6f917cac.script.1.event.1"]);
    const action = pending[0];
    assert.match(action.function, /current!=undefined/);
    assert.match(action.function, /setTimeout/);
    const index = draft.scripts.actions.indexOf(action);
    const complete = `function onLoad() {
      setTimeout(function () {
        MKXFORM.setFieldAttr("fd_first_row", 4);
        MKXFORM.setFieldAttr("fd_first_row", 6);
        MKXFORM.setFieldAttr("fd_second_row", 4);
        MKXFORM.setFieldAttr("fd_second_row", 6);
        var current = MKXFORM.getValue("fd_3e74eb5ed69b34");
        if (current == "6") {
          MKXFORM.setFieldAttr("fd_second_row", 5);
          MKXFORM.setFieldAttr("fd_second_row", 3);
        } else {
          if (current != undefined) {
            MKXFORM.setFieldAttr("fd_first_row", 5);
            MKXFORM.setFieldAttr("fd_first_row", 3);
          }
        }
      }, 510);
    }`;
    const immediate = complete.replace("setTimeout(function () {", "").replace("}, 510);", "");
    for (const [functionText, reason] of [[complete, "timed_initialization_callback_unproven"], [immediate, "source_or_scheduling_unproven"]]) {
      const values = { function: functionText, translationStatus: "mapped",
        coverage: { status: "translated", nativeRules: [], residuals: [] },
        functionMappings: [{ source: "scheduled existence guard", target: "same timer and guard", basis: "semantic-translation", reviewRequired: false }] };
      const patches = Object.entries(values).map(([key, value]) => ({
        op: "replace", path: `/scripts/actions/${index}/${key}`, value, sourceRefs: action.sourceRefs,
        evidence: ["Retain the source timer, checked value read, undefined guard and row effect order."],
        rationale: "An unproved existence comparison must not borrow the equality-only timer proof.", confidence: 0.99
      }));
      const reviewed = applyEvidenceBackedPatches(draft, patches, { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
      assert.equal(reviewed.ok, false);
      assert.ok(reviewed.diagnostics.some(item => item.code === "agent.patch.row_marker_semantics_unverified" && item.details.reason === reason), JSON.stringify(reviewed.diagnostics));
    }
    const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true, reviewerName: "route-validation" });
    const trust = checkTrust(source, trusted);
    assert.equal(trust.ok, false);
    assert.ok(trust.diagnostics.some(item => item.code === "dsl.scripts.needs_review"));
    assert.equal(buildDryRunPlan(trusted).ok, false);
  });

  it("executes the supported complete timed fixture through review, trust, dry-run and fake readback", async () => {
    const result = await runRouteCase("timed-initialization-success");
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.readback.ok, true);
    assert.ok(result.dsl.scripts.actions.every(action => action.function.includes("setTimeout")));
  });
});
