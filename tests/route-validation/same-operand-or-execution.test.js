import assert from "node:assert/strict";
import { it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

it("retains OR provenance through fake review, trust, executor and readback", async () => {
  const result = await runRouteCase("same-operand-or-proof-success");
  assert.equal(result.dsl.trust.executable, true);
  assert.equal(result.dsl.scripts.actions.length, 2);
  assert.ok(result.dsl.scripts.actions.every(action => action.translationStatus === "mapped"));
  assert.equal(result.dryRun.ok, true);
  assert.equal(result.execution.readback.ok, true);
});
