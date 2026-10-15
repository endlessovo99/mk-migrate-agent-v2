import assert from "node:assert/strict";
import { it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

it("does not execute a timed source without semantic review", async () => {
  const result = await runRouteCase("timed-initialization-retains-schedule");
  assert.equal(result.review.ok, false);
  assert.equal(result.execution, undefined);
  assert.deepEqual(result.transcript, []);
});

it("preserves reviewed timer functions through the fake executor and readback", async () => {
  const result = await runRouteCase("timed-initialization-success");
  assert.equal(result.dsl.trust.executable, true);
  assert.equal(result.dsl.scripts.actions.length, 2);
  for (const action of result.dsl.scripts.actions) assert.match(action.function, /setTimeout[\s\S]*510/);
  assert.equal(result.dryRun.ok, true);
  assert.equal(result.execution.readback.ok, true);
});
