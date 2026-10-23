import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { patchNativeCalculationResponseOrder } from "../../patches/newoa/calculation-response-order.js";
import { calculationRuntime } from "../helpers/native-calculation-response-order.js";

const original = readFileSync(new URL("../fixtures/route-validation/native-calculation-response-order/xform-calculate.original.js", import.meta.url), "utf8");

async function completeMatching(h, predicate, value) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const pending = h.requests.filter(request => !request.settled && predicate(request.input));
    if (!pending.length) return;
    for (const request of pending) request.complete(value);
    await h.flush();
  }
  assert.fail("Native component did not settle after matching responses");
}

test("late zero response cannot overwrite a newer row amount or SUM in the native component", async () => {
  const h = calculationRuntime(patchNativeCalculationResponseOrder(original));
  h.mount(); h.mount("sum"); await h.flush();
  assert.equal(h.requests.length, 1);
  h.edit("a", { qty: 1 }); await h.flush();
  assert.equal(h.requests.length, 2);
  h.requests[1].complete(100); await h.flush();
  assert.equal(h.rows[0].amount, 100);
  assert.equal(h.values["main.total"], 100);
  const count = h.writes.length, actions = h.actions.length;
  h.requests[0].complete(0); await h.flush();
  assert.equal(h.rows[0].amount, 100);
  assert.equal(h.values["main.total"], 100);
  assert.equal(h.writes.length, count);
  assert.equal(h.actions.length, actions);
});

test("normal completion order and a latest genuine zero retain their native behavior", async () => {
  const h = calculationRuntime(patchNativeCalculationResponseOrder(original));
  h.rows[0].qty = 1;
  h.mount(); h.mount("sum"); await h.flush();
  await completeMatching(h, input => input["lines.qty"] === 1, 100);
  assert.equal(h.values["main.total"], 100);
  h.edit("a", { qty: 0 }); await h.flush();
  await completeMatching(h, input => input["lines.qty"] === 0, 0);
  assert.equal(h.rows[0].amount, 0);
  assert.equal(h.values["main.total"], 0);
});

test("only the latest of several overlapping requests can write, even after inputs return to the same value", async () => {
  const h = calculationRuntime(patchNativeCalculationResponseOrder(original));
  h.mount(); h.mount("sum"); await h.flush();
  for (const qty of [1, 2, 0]) { h.edit("a", { qty }); await h.flush(); }
  assert.equal(h.requests.length, 4);
  h.requests[3].complete(0); await h.flush();
  const count = h.writes.length;
  h.requests[2].complete(200); h.requests[1].complete(100); h.requests[0].complete(0); await h.flush();
  assert.equal(h.rows[0].amount, 0);
  assert.equal(h.values["main.total"], 0);
  assert.equal(h.writes.length, count);
});

test("a changed input invalidates the old result before the next debounced request starts", async () => {
  const h = calculationRuntime(patchNativeCalculationResponseOrder(original));
  h.rows[0].amount = 50;
  h.mount("row", "a", { value: 50 }); h.mount("sum"); await h.flush();
  h.edit("a", { qty: 1 });
  const count = h.writes.length;
  h.requests[0].complete(0); await h.microtasks();
  assert.equal(h.requests.length, 1);
  assert.equal(h.rows[0].amount, 50);
  assert.equal(h.writes.length, count);
  await h.flush();
  h.requests[1].complete(100); await h.flush();
  assert.equal(h.values["main.total"], 100);
});

test("requests belonging to different rows do not cancel each other", async () => {
  const h = calculationRuntime(patchNativeCalculationResponseOrder(original));
  h.mount("row", "a"); h.mount("row", "b"); h.mount("sum"); await h.flush();
  h.edit("a", { qty: 1 }); await h.flush();
  h.edit("b", { qty: 2 }); await h.flush();
  await completeMatching(h, input => input["lines.price"] === 25 && input["lines.qty"] === 2, 50);
  await completeMatching(h, input => input["lines.price"] === 100 && input["lines.qty"] === 1, 100);
  const count = h.writes.length;
  await completeMatching(h, input => input["lines.qty"] === 0, 0);
  assert.deepEqual(h.rows.map(row => row.amount), [100, 50]);
  assert.equal(h.values["main.total"], 150);
  assert.equal(h.writes.length, count);
});

test("unmounted controls cannot write state, SUM, or actions when their requests return", async () => {
  const h = calculationRuntime(patchNativeCalculationResponseOrder(original));
  const control = h.mount(); h.mount("sum"); await h.flush();
  h.edit("a", { qty: 1 }); await h.flush();
  const count = h.writes.length, actions = h.actions.length;
  control.unmount();
  h.requests[1].complete(100); h.requests[0].complete(0); await h.flush();
  assert.equal(h.writes.length, count);
  assert.equal(h.actions.length, actions);
});

test("a deleted zero-valued row rejects its response even if the control has not unmounted yet", async () => {
  const h = calculationRuntime(patchNativeCalculationResponseOrder(original));
  h.mount(); h.mount("sum"); await h.flush();
  h.remove("a"); await h.flush();
  const count = h.writes.length;
  h.requests[0].complete(0); await h.flush();
  assert.equal(h.writes.length, count);
  assert.equal(h.rows.some(row => row.key === "a"), false);
});

test("numeric zero row keys work and unrelated rerenders do not invalidate a current response", async () => {
  const h = calculationRuntime(patchNativeCalculationResponseOrder(original));
  h.rows[0].key = 0; h.rows[0].qty = 1;
  const control = h.mount("row", 0);
  await h.flush();
  control.render({ expressionFormulaVO: { ...control.props.expressionFormulaVO } });
  h.requests[0].complete(100); await h.flush();
  assert.equal(h.rows[0].amount, 100);
});

test("reusing a control for another row rejects callbacks captured by the previous owner", async () => {
  const h = calculationRuntime(patchNativeCalculationResponseOrder(original));
  h.rows[0].qty = 1; h.rows[1].qty = 2;
  const control = h.mount(); await h.flush();
  control.render({ rowKey: "b", rowIndex: 1, id: "row-b" }); await h.flush();
  assert.equal(h.requests.length, 2);
  h.requests[1].complete(50); await h.flush();
  const count = h.writes.length;
  h.requests[0].complete(100); await h.flush();
  assert.equal(h.rows[1].amount, 50);
  assert.equal(h.writes.length, count);
});

test("main-table formulas receive the same stale-result protection", async () => {
  const h = calculationRuntime(patchNativeCalculationResponseOrder(original));
  h.mount("main"); await h.flush();
  h.editMain({ right: 1 }); await h.flush();
  assert.equal(h.requests.length, 2);
  h.requests[1].complete(100); await h.flush();
  h.requests[0].complete(0); await h.flush();
  assert.equal(h.values["main.calculated"], 100);
});

test("effect cleanup and reactivation cannot revive an earlier request", async () => {
  const h = calculationRuntime(patchNativeCalculationResponseOrder(original));
  h.rows[0].qty = 1;
  const control = h.mount(); await h.flush();
  control.replayEffects(); await h.flush();
  assert.equal(h.requests.length, 2);
  h.requests[1].complete(100); await h.flush();
  const count = h.writes.length;
  h.requests[0].complete(100); await h.flush();
  assert.equal(h.writes.length, count);
});

test("a current failed response stays visible and does not authorize an old result as fallback", async () => {
  const h = calculationRuntime(patchNativeCalculationResponseOrder(original));
  h.mount(); await h.flush();
  h.edit("a", { qty: 1 }); await h.flush();
  h.requests[1].malformed(); await h.flush();
  assert.equal(h.errors.length, 1);
  const count = h.writes.length;
  h.requests[0].complete(0); await h.flush();
  assert.equal(h.writes.length, count);
  assert.equal(h.errors.length, 1);
});

test("a stale malformed response is discarded before parsing and cannot trigger actions", async () => {
  const h = calculationRuntime(patchNativeCalculationResponseOrder(original));
  h.mount(); await h.flush();
  h.edit("a", { qty: 1 }); await h.flush();
  h.requests[1].complete(100); await h.flush();
  const count = h.writes.length, actions = h.actions.length;
  h.requests[0].malformed(); await h.flush();
  assert.equal(h.errors.length, 0);
  assert.equal(h.writes.length, count);
  assert.equal(h.actions.length, actions);
});

test("the offline patch refuses unknown versions and double application", () => {
  assert.throws(() => patchNativeCalculationResponseOrder(`${original}\n`), /Unsupported native calculation asset/);
  assert.throws(() => patchNativeCalculationResponseOrder(patchNativeCalculationResponseOrder(original)), /Unsupported native calculation asset/);
});

test("current response formatting and native callback/action behavior match the original component", async () => {
  for (const [price, expected] of [[100.125, 100.13], [-25, -25], [0, 0]]) {
    const outcomes = [];
    for (const source of [original, patchNativeCalculationResponseOrder(original)]) {
      const h = calculationRuntime(source);
      h.rows[0].price = price; h.rows[0].qty = 1;
      h.mount(); await h.flush();
      await completeMatching(h, input => input["lines.qty"] === 1, price);
      assert.equal(h.rows[0].amount, expected);
      outcomes.push({ writes: h.writes, actions: h.actions, errors: h.errors.map(error => error.message) });
    }
    assert.deepEqual(outcomes[1], outcomes[0]);
  }
});

test("replacement of the live form instance invalidates an in-flight response without waiting for a rerender", async () => {
  const h = calculationRuntime(patchNativeCalculationResponseOrder(original));
  h.rows[0].qty = 1;
  h.mount(); await h.flush();
  h.replaceFormInstance();
  const count = h.writes.length;
  h.requests[0].complete(100); await h.flush();
  assert.equal(h.writes.length, count);
});

test("a formula object edited in place cannot receive the result of its former expression", async () => {
  const h = calculationRuntime(patchNativeCalculationResponseOrder(original));
  h.rows[0].qty = 1;
  const control = h.mount(); await h.flush();
  control.props.expressionFormulaVO.script += " + 5";
  const count = h.writes.length;
  h.requests[0].complete(100); await h.flush();
  assert.equal(h.writes.length, count);
});

test("the existing highCode scalar field getter is not mistaken for a deleted detail row", async () => {
  const h = calculationRuntime(patchNativeCalculationResponseOrder(original));
  h.useHighCodeFieldGetter(); h.rows[0].qty = 1;
  h.mount(); await h.flush();
  await completeMatching(h, input => input["lines.qty"] === 1, 100);
  assert.equal(h.rows[0].amount, 100);
});

test("the unmodified captured component reproduces the same late-response zero overwrite", async () => {
  const h = calculationRuntime(original);
  h.mount(); h.mount("sum"); await h.flush();
  h.edit("a", { qty: 1 }); await h.flush();
  h.requests[1].complete(100); await h.flush();
  assert.equal(h.rows[0].amount, 100);
  assert.equal(h.values["main.total"], 100);
  h.requests[0].complete(0); await h.flush();
  assert.equal(h.rows[0].price, 100);
  assert.equal(h.rows[0].qty, 1);
  assert.equal(h.rows[0].amount, 0);
  assert.equal(h.values["main.total"], 0);
});
