import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRouteCase } from "./run-route-case.js";

describe("Route-validation unmapped formula participants", { concurrency: false }, () => {
  it("blocks the legacy N7 role-line formula before dry-run or NewOA transport", async () => {
    const result = await runRouteCase("unmapped-formula-blocked-before-transport");
    const node = result.dsl.workflow.nodes.find((item) => item.id === "N7");

    assert.equal(result.review.ok, false);
    assert.equal(result.review.status, "blocked");
    assert.equal(result.review.stage, "agent-review.input");
    assert.equal(
      result.review.diagnostics.some((item) => item.code === "agent.input.workflow_formula_unrepairable"),
      true
    );
    assert.equal(result.dsl.artifact, "dsl-draft");
    assert.equal(node.attributes.handlerSelectType, "formula");
    assert.equal(node.participants.mode, "unmapped_formula");
    assert.equal(node.participants.sourceExpression, node.attributes.handlerIds);
    assert.match(node.participants.sourceExpression, /解释角色线/);
    assert.equal(node.participants.sourceNameExpression, node.attributes.handlerNames);
    assert.equal(node.participants.members, undefined);
    assert.equal(node.translationStatus, "pending_review");
    assert.equal(result.dryRun, undefined);
    assert.equal(result.execution, undefined);
    assert.deepEqual(result.transcript, []);
  });
});
