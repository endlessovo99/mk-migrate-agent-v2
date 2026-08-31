import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

const LIFECYCLE_BASES = new Set([
  "deterministic-travel-reimbursement-lifecycle",
  "deterministic-travel-reimbursement-submit-calculation"
]);

const EXPECTED_ACTION_IDS = [
  "fd_3e48c1f17e7e42.script.1.event.1",
  "fd_3ba9eae4151422.script.1.event.1",
  "fd_3ba9eae4151422.script.1.event.2",
  "fd_3cc17629476baa.script.1.event.1",
  "fd_3cc17629476baa.script.2.event.1",
  "fd_3cc17629476baa.script.2.event.2",
  "fd_3cc17629476baa.script.2.event.3",
  "fd_3cc17629476baa.script.2.event.4",
  "fd_3d19de502071ba.script.1.event.1"
];

describe("travel reimbursement lifecycle Route case", { concurrency: false }, () => {
  it("reviews, dry-runs, persists, and reads back every mapped lifecycle action offline", async () => {
    const result = await runRouteCase("travel-reimbursement-lifecycle-success");
    const lifecycleActions = result.dsl.scripts.actions.filter((action) =>
      action.functionMappings.some((mapping) => LIFECYCLE_BASES.has(mapping.basis))
    );
    const observedActionIds = new Set(
      [
        ...result.execution.readback.form.scripts.actions.map((action) => action.id),
        ...result.execution.readback.form.scripts.dispatchers.flatMap((dispatcher) =>
          dispatcher.actionIds
        )
      ].filter(Boolean)
    );

    assert.equal(result.review.status, "needs_manual");
    assert.equal(result.dsl.trust.executable, true);
    assert.equal(result.dryRun.ok, true);
    assert.equal(result.dryRun.status, "needs_manual");
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.status, "written_with_warnings");
    assert.deepEqual(
      lifecycleActions.map((action) => action.id).sort(),
      EXPECTED_ACTION_IDS.toSorted()
    );
    assert.equal(
      lifecycleActions.every((action) =>
        action.translationStatus === "mapped" &&
        action.coverage.status === "translated" &&
        action.coverage.residuals.length === 0
      ),
      true
    );
    assert.equal(
      EXPECTED_ACTION_IDS.every((actionId) => observedActionIds.has(actionId)),
      true
    );
    assert.equal(result.execution.readback.partitions.scripts, "verified");
    assert.deepEqual(result.transcript.map((entry) => entry.operation), [
      "login",
      "get-xform-desktop-digest",
      "get-xform-desktop-module-sha256",
      "get-xform-desktop-module-sha256",
      "init",
      "generate-table-name",
      "load-parent-category",
      "add",
      "get-before-update",
      "update",
      "get-readback",
      "add-transfer-record"
    ]);
  });
});
