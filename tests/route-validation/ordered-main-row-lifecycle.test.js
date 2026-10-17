import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { conditionalFieldResetCandidates } from "../../src/translator/conditional-field-reset.js";
import { inlineRadioRowEffectCandidates, compileStaticRowEffect } from "../../src/translator/inline-radio-row-effects.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { executeDsl } from "../../src/executor/execute.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { withNetworkGuard } from "./network-guard.js";

const root = "tests/fixtures/route-validation/ordered-main-row-lifecycle/";
const fixture = name => `${root}route-${name}_SysFormTemplate.xml`;
const stages = name => {
  const source = cleanSourceFile(fixture(name));
  return { source, dsl: draftSourceDraft(source) };
};

describe("ordered main-row lifecycle Route-validation", () => {
  it("preserves row effects before the later source read", () => {
    const { source, dsl } = stages("ordered-main-row-lifecycle");
    const action = dsl.scripts.actions[0];
    assert.equal(action.translationStatus, "mapped");
    assert.ok(action.function.indexOf("setFieldAttr") < action.function.indexOf("getValue"), action.function);
    for (const value of ["A", "", undefined]) {
      assert.deepEqual(observeLoad(source.scripts.sources[0].javascript, value, false), observeLoad(action.function, value, true));
    }
    assert.equal(checkDraft(dsl).ok, true);
  });

  it("keeps explicit scalar and field-object reads at their original statement position", () => {
    const { source, dsl } = stages("ordered-main-row-lifecycle");
    const original = source.scripts.sources[0];
    for (const javascript of [
      original.javascript,
      original.javascript.replace('GetXFormFieldById("fd_state")[0];', 'GetXFormFieldById("fd_state")[0].value;').replace("state.value", "state")
    ]) {
      const actions = inlineRadioRowEffectCandidates({ ...original, javascript }, dsl.form);
      assert.equal(actions.length, 1);
      assert.equal(actions[0].translationStatus, "mapped");
      for (const value of ["A", "", undefined]) {
        assert.deepEqual(observeLoad(javascript, value, false), observeLoad(actions[0].function, value, true));
      }
    }
  });

  it("does not reinterpret an unindexed source value list as a scalar or field object", () => {
    const { source, dsl } = stages("ordered-main-row-lifecycle");
    const original = source.scripts.sources[0];
    const listAlias = original.javascript.replace('GetXFormFieldById("fd_state")[0];', 'GetXFormFieldValueById("fd_state");');
    const directList = original.javascript.replace('var state = GetXFormFieldById("fd_state")[0];', "")
      .replace("state.value", 'GetXFormFieldValueById("fd_state")').replace('=="A"','==="A"');
    for (const javascript of [listAlias, listAlias.replace("state.value", "state"), directList]) {
      const actions = inlineRadioRowEffectCandidates({ ...original, javascript }, dsl.form);
      assert.equal(actions.some(action => action.translationStatus === "mapped"), false, javascript);
      assert.ok(actions.every(action => action.translationStatus === "needs_review"));
    }
    for (const javascript of [listAlias, listAlias.replace("state.value", "state"), directList]) {
      assert.deepEqual(observeLoad(javascript, ["A", "B"], false), [
        ["attribute", "fd_A_row", 4], ["attribute", "fd_A_row", 6], ["read", "fd_state"]
      ]);
    }
    const listContract = 'Com_AddEventListener(window,"load",function(){if(Array.isArray(GetXFormFieldValueById("fd_state"))){common_dom_row_set_show_required_reset("fd_A_row",true,false,false);}});';
    assert.deepEqual(observeLoad(listContract, "A", false), [
      ["read", "fd_state"], ["attribute", "fd_A_row", 5], ["attribute", "fd_A_row", 6]
    ]);
  });

  it("retains reset=true writes, source branch priority, and explicit later resets", () => {
    const { source, dsl } = stages("conditional-row-reset");
    const action = dsl.scripts.actions[0];
    assert.equal(action.translationStatus, "mapped");
    for (const value of ["A", "B", ""]) {
      assert.deepEqual(observeChange(source.scripts.sources[0].javascript, value, false), observeChange(action.function, value, true));
    }
    assert.equal(checkDraft(dsl).ok, true);
  });

  it("uses the event argument when the source callback names it differently", () => {
    const { source, dsl } = stages("event-value-alias");
    const action = dsl.scripts.actions[0];
    assert.equal(action.translationStatus, "mapped");
    for (const value of ["A", "B", ""]) {
      assert.deepEqual(observeChange(source.scripts.sources[0].javascript, value, false), observeChange(action.function, value, true));
    }
    assert.equal(checkDraft(dsl).ok, true);
  });

  it("does not accept unknown conditions, side effects, shadowed APIs, or missing reset targets", () => {
    const { source, dsl } = stages("conditional-row-reset");
    const original = source.scripts.sources[0];
    for (const javascript of [
      original.javascript.replace('value.indexOf("A")>=0', "unknownPredicate(value)"),
      original.javascript.replace('mirror.value="A";', 'mirror.value="A"; unknownSideEffect();'),
      original.javascript.replace("function(value,domElement)", "function(value,common_dom_row_set_show_required_reset)"),
      original.javascript.replaceAll('"fd_A_row"', '"missing_row"')
    ]) assert.deepEqual(conditionalFieldResetCandidates({ ...original, javascript }, dsl.form), []);
  });

  it("rejects detail-table resets and a reset row containing only descriptions", () => {
    const { source, dsl } = stages("conditional-row-reset");
    const effect = { target: "fd_A_row", visible: true, required: true, reset: true };
    const descriptions = structuredClone(dsl.form);
    descriptions.fields.find(field => field.id === "fd_value").componentId = "xform-description";
    assert.equal(compileStaticRowEffect(effect, descriptions), undefined);
    assert.deepEqual(conditionalFieldResetCandidates(source.scripts.sources[0], descriptions), []);
    const detail = structuredClone(dsl.form);
    detail.fields.push({ id: "fd_lines", type: "detailTable", columns: [{ id: "fd_line", type: "text" }] });
    const row = detail.layout.mkTree.find(row => row.sourceMarkers?.includes("fd_A_row"));
    row.children[0].refIds.push("fd_lines");
    assert.equal(compileStaticRowEffect(effect, detail), undefined);
    assert.deepEqual(conditionalFieldResetCandidates(source.scripts.sources[0], detail), []);
  });

  it("verifies repaired lifecycle forms through review, trust, dry-run, fake write and readback", async () => {
    await withNetworkGuard(async () => {
      for (const name of ["ordered-main-row-lifecycle", "conditional-row-reset", "event-value-alias", "colliding-row-marker"]) {
        const { source, dsl } = stages(name);
        const reviewed = await runAgentReview(source, dsl, {
          provider: createFakeReviewProvider("accept"),
          reviewedAt: "2026-10-17T00:00:00.000Z"
        });
        assert.equal(reviewed.ok, true, JSON.stringify(reviewed.diagnostics));
        assert.equal(buildDryRunPlan(reviewed.dsl).ok, true);
        const client = new FakeNewoaAdapter("persist");
        const executed = await executeDsl(reviewed.dsl, {
          client,
          credentials: { username: "route-fixture", encryptedPassword: "route-fixture-password" },
          confirmWrite: true,
          targetCategoryId: "route-category-id",
          now: new Date("2026-10-17T00:00:00.000Z"),
          transferRecordIdFactory: () => "route0000000000000000000000000000000"
        });
        assert.equal(executed.ok, true, JSON.stringify(executed.diagnostics));
        assert.equal(executed.readback.ok, true);
        assert.equal(client.transcript().at(-1).operation, "add-transfer-record");
      }
    });
  });
  it("keeps a collision fixture's unindexed list load pending before any fake writes", async () => {
    await withNetworkGuard(async () => {
      const original = stages("colliding-row-marker").source;
      const source = structuredClone(original);
      const script = source.scripts.sources.find(script => script.javascript.includes('GetXFormFieldById("fd_state")[0].value'));
      assert.ok(script);
      script.javascript = script.javascript.replace('GetXFormFieldById("fd_state")[0].value', 'GetXFormFieldValueById("fd_state")');
      const dsl = draftSourceDraft(source);
      assert.equal(dsl.scripts.actions.find(action => action.event === "onLoad").translationStatus, "needs_review");
      const reviewed = await runAgentReview(source, dsl, { provider: createFakeReviewProvider("accept") });
      assert.equal(reviewed.ok, false);
      assert.equal(buildDryRunPlan(dsl).ok, false);
      const client = new FakeNewoaAdapter("persist");
      const result = await executeDsl(dsl, { client, confirmWrite: true, targetCategoryId: "route-category-id",
        credentials: { username: "route-fixture", encryptedPassword: "route-fixture-password" } });
      assert.equal(result.ok, false);
      assert.deepEqual(client.transcript(), []);
    });
  });

});

function observeLoad(text, value, target) {
  const calls = [];
  const read = id => { calls.push(["read", id]); return value; };
  const attributes = (id, attribute) => calls.push(["attribute", id, attribute]);
  let callback;
  if (target) {
    new Function("MKXFORM", `${text}; onLoad();`)({ getValue: read, setFieldAttr: attributes });
  } else {
    new Function("Com_AddEventListener", "window", "GetXFormFieldById", "GetXFormFieldValueById", "common_dom_row_set_show_required_reset", text)(
      (_window, _event, fn) => { callback = fn; }, {}, id => [{ value: read(id) }],
      id => { const current = read(id); return Array.isArray(current) ? current : [current]; },
      (id, visible, required) => { attributes(id, visible ? 5 : 4); attributes(id, required ? 3 : 6); }
    );
    callback();
  }
  return calls;
}

function observeChange(text, value, target) {
  const calls = [];
  const values = { fd_state: "before", fd_value: "before" };
  const read = id => values[id];
  const write = (id, value) => { values[id] = value; calls.push(["set", id, value]); };
  const attributes = (id, attribute) => calls.push(["attribute", id, attribute]);
  let callback;
  if (target) {
    new Function("MKXFORM", `${text}; onChange(${JSON.stringify(value)});`)({ getValue: read, setValue: write, setFieldAttr: attributes });
  } else {
    new Function("AttachXFormValueChangeEventById", "GetXFormFieldById", "$", "common_dom_row_set_show_required_reset", text)(
      (_id, fn) => { callback = fn; },
      id => [{ get value() { return read(id); }, set value(value) { write(id, value); } }],
      selector => ({ val: value => write(selector.match(/value\(([^)]+)\)/)[1], value) }),
      (id, visible, required, reset) => { attributes(id, visible ? 5 : 4); attributes(id, required ? 3 : 6); if (reset) write("fd_value", ""); }
    );
    callback(value, {});
  }
  return calls;
}
