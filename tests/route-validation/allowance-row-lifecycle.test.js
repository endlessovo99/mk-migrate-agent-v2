import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { prepareSample, xformConfig, formAttr } from "../helpers/persistence.js";

const fixture = "tests/fixtures/route-validation/allowance-row-lifecycle/route-allowance-row-lifecycle_SysFormTemplate.xml";
const source = cleanSourceFile(fixture);
const contract = JSON.parse(readFileSync("tests/fixtures/route-validation/allowance-row-lifecycle/native-contract.json", "utf8"));
const scriptText = source.scripts.sources[0].javascript;
const bindingsStart = scriptText.indexOf('$("#TABLE_DL_"');
const bindingText = scriptText.slice(bindingsStart);
const addStart = bindingText.indexOf('$("#TABLE_DL_" + receiptLinesId + ",img[title=\'添加行\']")');
const deleteBinding = bindingText.slice(0, addStart);
const addBinding = bindingText.slice(addStart);

describe("source-proved allowance receipt row lifecycle Route case", () => {
  it("adds only the two evidenced table events and preserves existing calculation actions", () => {
    const dsl = draftSourceDraft(source);
    const lifecycle = lifecycleActions(dsl);
    assert.deepEqual(lifecycle.map(action => action.event), ["onAfterDel", "onAfterAdd"]);
    for (const action of lifecycle) {
      assert.equal(action.scope, "control");
      assert.equal(action.controlId, "fd_receipts");
      assert.equal(action.tableId, "fd_receipts");
      assert.deepEqual(action.runWhen, { viewStatusIn: ["add", "edit"] });
      assert.equal(action.translationStatus, "mapped");
      assert.deepEqual(action.coverage.residuals, []);
      assert.equal(action.deterministicBranchProof.basis, "deterministic-allowance-calculation");
    }

    const withoutBindings = withBindings("");
    assert.deepEqual(
      dsl.scripts.actions.filter(action => !lifecycle.includes(action)),
      withoutBindings.scripts.actions,
      "existing action identity, function, runWhen, and proof must be unchanged"
    );
  });

  it("does not invent a missing outer binding from the hashless nested delete rebind", () => {
    assert.deepEqual(lifecycleActions(withBindings("")).map(action => action.event), []);
    assert.deepEqual(lifecycleActions(withBindings(deleteBinding)).map(action => action.event), ["onAfterDel"]);
    assert.deepEqual(lifecycleActions(withBindings(addBinding)).map(action => action.event), ["onAfterAdd"]);
  });

  const unproved = [
    ["wrong table", bindingText.replaceAll("+ receiptLinesId +", '+ "fd_unrelated" +')],
    ["unrelated selector", bindingText.replaceAll("#TABLE_DL_", "#UNRELATED_")],
    ["global image only", bindingText.replaceAll('"#TABLE_DL_" + receiptLinesId + ",img', '"img')],
    ["outer hashless selector", bindingText.replaceAll("#TABLE_DL_", "TABLE_DL_")],
    ["wrong handler", bindingText.replaceAll("sumTripReceipts();", "otherReceiptTotal();")],
    ["extra handler effect", bindingText.replaceAll("sumTripReceipts();", "sumTripReceipts(); otherEffect();")],
    ["conditional handler", bindingText.replaceAll("sumTripReceipts();", "if (enabled) sumTripReceipts();")],
    ["wrong event", bindingText.replaceAll('"click"', '"mouseover"')],
    ["comment only", `/* ${bindingText} */`],
    ["string only", `var inertBinding = ${JSON.stringify(bindingText)};`],
    ["uninvoked function", `function inertBinding() { ${bindingText} }`],
    ["conditional registration", `if (enabled) { ${bindingText} }`],
    ["shadowed jquery", `var $ = otherSelector;\n${bindingText}`],
    ["assigned jquery global", `$ = otherSelector;\n${bindingText}`],
    ["mutated table", `receiptLinesId = "fd_unrelated";\n${bindingText}`],
    ["mutated handler", `sumTripReceipts = otherReceiptTotal;\n${bindingText}`],
    ["global jquery mutation", `window.$ = otherSelector;\n${bindingText}`],
    ["global handler replacement", `window.sumTripReceipts = otherReceiptTotal;\n${bindingText}`],
    ["global helper replacement", `window.sumReceiptRows = otherReceiptDetail;\n${bindingText}`]
  ];
  for (const [name, text] of unproved) {
    it(`rejects ${name} as row-lifecycle evidence`, () => {
      assert.deepEqual(lifecycleActions(withBindings(text)), []);
    });
  }

  const globalMutationAttempts = [
    ["Object.assign", 'Object.assign(window, { receiptLinesId: "fd_unrelated" });'],
    ["Object.defineProperty", 'Object.defineProperty(window, "receiptLinesId", { value: "fd_unrelated" });'],
    ["global object alias", 'var globalAlias = window; globalAlias.receiptLinesId = "fd_unrelated";'],
    ["Reflect.set", 'Reflect.set(globalThis, "receiptLinesId", "fd_unrelated");'],
    ["Object method alias", 'var redefine = Object.assign; redefine(window, { receiptLinesId: "fd_unrelated" });'],
    ["indirect mutation call", 'Object.assign.call(null, self, { receiptLinesId: "fd_unrelated" });'],
    ["global object escape", 'unknownMutation(window);'],
    ["global this alias", 'var globalAlias = this; globalAlias.receiptLinesId = "fd_unrelated";']
  ];
  for (const [name, statement] of globalMutationAttempts) {
    it(`rejects unproven global mutation through ${name}`, () => {
      const dsl = withBindings(`${bindingText}\n${statement}`);
      assert.equal(lifecycleActions(dsl).length, 0);
      assertUnprovedAllowance(dsl);
    });
  }

  const earlyProofFailures = [
    ["direct table rebinding", bindingText, 'receiptLinesId = "fd_unrelated";'],
    ["window table rebinding", bindingText, 'window.receiptLinesId = "fd_unrelated";'],
    ["receipt handler rebinding", bindingText, "sumTripReceipts = otherReceiptTotal;"],
    ["literal table selector with window rebinding", bindingText.replaceAll('"#TABLE_DL_" + receiptLinesId +',
      '"#TABLE_DL_fd_receipts" +'), 'window.receiptLinesId = "fd_unrelated";']
  ];
  for (const [name, bindings, mutation] of earlyProofFailures) {
    it(`retains review residuals for an early proof failure: ${name}`, () => {
      const dsl = withBindings(`${bindings}\n${mutation}`);
      assert.equal(lifecycleActions(dsl).length, 0);
      assertUnprovedAllowance(dsl);
    });
  }

  it("does not claim unrelated or inert click text as matching lifecycle ownership", () => {
    for (const bindings of [
      bindingText.replaceAll("+ receiptLinesId +", '+ "fd_unrelated" +'),
      bindingText.replaceAll("sumTripReceipts();", "otherReceiptTotal();"),
      `var inertBinding = ${JSON.stringify(bindingText)};`
    ]) {
      const dsl = withBindings(`${bindings}\nwindow.receiptLinesId = "fd_unrelated";`);
      assert.equal(lifecycleActions(dsl).length, 0);
      const family = dsl.scripts.actions.filter(action =>
        action.functionMappings?.some(mapping => mapping.basis === "deterministic-allowance-calculation"));
      assert.ok(family.length > 0 && family.every(action => action.translationStatus === "mapped" &&
        action.coverage.residuals.length === 0));
    }
  });

  it("keeps harmless reflective text inert instead of rejecting keywords", () => {
    const text = `${bindingText}\nvar explanation = "Object.assign(window, { receiptLinesId: 'other' })";\n// Object.defineProperty(window, 'receiptLinesId', {})`;
    assert.deepEqual(lifecycleActions(withBindings(text)).map(action => action.event), ["onAfterDel", "onAfterAdd"]);
  });

  it("rejects a receipt-function side effect outside the source calculation closure", () => {
    const next = structuredClone(source);
    next.scripts.sources[0].javascript = "var sourceSideEffectCount = 0;\n" + scriptText.replace(
      /function sumTripReceipts\(\)\s*\{/u,
      "function sumTripReceipts() { sourceSideEffectCount += 1;"
    );
    const dsl = draftSourceDraft(next);
    assert.equal(lifecycleActions(dsl).length, 0);
    assertUnprovedAllowance(dsl);
  });

  for (const effect of [
    "unknownReceiptEffect();",
    'SetXFormFieldValueById("fd_people", 99);',
    "var value = (sourceSideEffectCount += 1);",
    "function hiddenEffect() { sourceSideEffectCount += 1; } hiddenEffect();"
  ]) {
    it(`rejects an extra receipt calculation effect: ${effect}`, () => {
      const next = structuredClone(source);
      next.scripts.sources[0].javascript = "var sourceSideEffectCount = 0;\n" + scriptText.replace(
        /function sumTripReceipts\(\)\s*\{/u,
        `function sumTripReceipts() { ${effect}`
      );
      const dsl = draftSourceDraft(next);
      assert.equal(lifecycleActions(dsl).length, 0);
      assertUnprovedAllowance(dsl);
    });
  }

  for (const helper of ["receiptAllowanceCap", "trafficDays", "timeDifference"]) {
    it(`rejects a captured-state write in the reachable ${helper} helper`, () => {
      const next = structuredClone(source);
      next.scripts.sources[0].javascript = "var sourceSideEffectCount = 0;\n" + scriptText.replace(
        new RegExp(`(function ${helper}\\([^)]*\\)\\s*\\{)`, "u"),
        "$1 sourceSideEffectCount += 1;"
      );
      const dsl = draftSourceDraft(next);
      assert.equal(lifecycleActions(dsl).length, 0);
      assertUnprovedAllowance(dsl);
    });
  }

  it("delegates a receipt tail call only to the exact existing source-bound receipt-change owner", () => {
    const { combined, grouped } = delegatedSource();
    const actions = lifecycleActions(draftSourceDraft(combined));
    assert.equal(actions.length, 2);
    for (const action of actions) {
      assert.ok(action.sourceRefs.includes(grouped.sourceRef));
      assert.ok(action.semanticHints.coveredCalculationRanges.some(range =>
        range.sourceRef === grouped.sourceRef && range.name === "receipt-target-change:groupedAmount"));
      assert.deepEqual([...action.function.matchAll(/MKXFORM\.setValue\("([^"]+)"/gu)].map(match => match[1]), ["fd_receipt_result"]);
    }
  });

  it("rejects a same-named receipt tail call with an additional local source owner", () => {
    const { combined, allowance } = delegatedSource();
    allowance.javascript += "\nfunction groupedAmount() { var changed = 99; }";
    const dsl = draftSourceDraft(combined);
    assert.equal(lifecycleActions(dsl).length, 0);
    assertUnprovedAllowance(dsl);
  });

  it("rejects delegation when the existing source callback belongs to a different trigger field", () => {
    const { combined, grouped } = delegatedSource();
    grouped.javascript = grouped.javascript.replace('AttachXFormValueChangeEventById("fd_receipt_result"',
      'AttachXFormValueChangeEventById("fd_people"');
    const dsl = draftSourceDraft(combined);
    assert.equal(lifecycleActions(dsl).length, 0);
    assertUnprovedAllowance(dsl);
  });

  it("requires a unique receipt-column owner matching the source table", () => {
    const duplicate = structuredClone(source);
    const table = structuredClone(duplicate.form.detailTables[0]);
    table.id = "fd_other_receipts";
    table.sourceRef = "source.form.detailTable.fd_other_receipts";
    duplicate.form.detailTables.push(table);
    assert.deepEqual(lifecycleActions(draftSourceDraft(duplicate)), []);

    const mismatch = structuredClone(source);
    mismatch.form.detailTables[0].id = "fd_other_receipts";
    assert.deepEqual(lifecycleActions(draftSourceDraft(mismatch)), []);
  });

  it("validates and persists both native container events with exact physical-table bindings", () => {
    const dsl = draftSourceDraft(source);
    const validation = validateMigrationDsl(dsl);
    assert.deepEqual(validation.diagnostics.filter(item => item.level === "error"), []);
    const { prepared, table, native } = nativeLifecycle(dsl);
    assert.deepEqual(Object.keys(native).sort(), ["onAfterAdd", "onAfterDel"]);
    assert.equal(prepared.verify(prepared.update).ok, true);
    for (const event of ["onAfterAdd", "onAfterDel"]) {
      assert.match(native[event][0].function, new RegExp(`^function ${event}.*\\(data\\)`));
      assert.match(native[event][0].function, new RegExp(`${table.fdTableName}\\.fd_receipt_value`));
      const modified = structuredClone(prepared.update);
      const config = xformConfig(modified);
      const attr = JSON.parse(config.attribute.formAttr);
      delete attr.controlAction.control[`${table.fdTableName}.${table.fdTableName}`][event];
      config.attribute.formAttr = JSON.stringify(attr);
      modified.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
      const verification = prepared.verify(modified);
      assert.equal(verification.ok, false, event);
      assert.ok(verification.diagnostics.some(item => item.code === "readback.scripts.action_missing"), event);
    }
  });

  it("uses the complete native post-add and remaining post-delete arrays while the public store is stale", async () => {
    const { table, native } = nativeLifecycle();
    const field = `${table.fdTableName}.fd_receipt_value`;
    const before = [
      { key: 11, [field]: 1.23 },
      { key: 22, [field]: 4.56 }
    ];
    const deleted = runNativeLifecycle(native.onAfterDel[0]);
    const deleteEvidence = replayDelete(before, [11], table.fdTableName, deleted.handler);
    assert.deepEqual(deleteEvidence.data, [{ key: 22, [field]: 4.56 }]);
    assert.equal(deleted.state.fd_receipt_result, 4.56);
    assert.deepEqual(deleted.writes, [["fd_receipt_result", 4.56]]);
    assert.deepEqual(deleted.tableReads, [], "post-delete data must win over stale getValue rows");

    const added = runNativeLifecycle(native.onAfterAdd[0]);
    const addEvidence = await replayAdd(before, { [field]: 3.21 }, table.fdTableName, added.handler);
    assert.equal(addEvidence.data.length, 3, "native data includes all existing rows, not just the inserted row");
    assert.deepEqual(addEvidence.data.slice(0, 2), before);
    assert.equal(addEvidence.data[2][field], 3.21);
    assert.equal(added.state.fd_receipt_result, 9);
    assert.deepEqual(added.writes, [["fd_receipt_result", 9]]);
    assert.deepEqual(added.tableReads, []);

    const blank = runNativeLifecycle(native.onAfterAdd[0]);
    const blankEvidence = await replayAdd(before, { [field]: undefined }, table.fdTableName, blank.handler);
    assert.deepEqual(Object.keys(blankEvidence.data[2]), ["key"], "native JSON-cloned blank rows omit undefined fields");
    assert.equal(blank.state.fd_receipt_result, 5.79);

    const empty = runNativeLifecycle(native.onAfterDel[0]);
    assert.deepEqual(replayDelete(before, [11, 22], table.fdTableName, empty.handler).data, []);
    assert.equal(empty.state.fd_receipt_result, 0, "deleting the final row clears the old total");
  });

  it("preserves city exemption, domestic date/person cap, per-row rounding, and the one-field write closure", () => {
    const { native, table } = nativeLifecycle();
    const field = `${table.fdTableName}.fd_receipt_value`;
    const cases = [
      { name: "city uncapped", rows: [150, 75], mode: 0, expected: 225 },
      { name: "domestic one-day cap", rows: [150, 75], mode: 1, expected: 100 },
      { name: "domestic multi-day/person cap", rows: [500, 300], mode: 1, people: 2, end: "2026-10-24 18:00:00", expected: 600 },
      { name: "city decimals", rows: [0.1, 0.2, 0.01], mode: 0, expected: 0.31 },
      { name: "zero and empty native values", rows: [0, "", null], mode: 0, expected: 0 },
      { name: "negative date cap", rows: [99], mode: 1, end: "2026-10-21 18:00:00", expected: 0 }
    ];
    for (const event of Object.keys(native)) for (const testCase of cases) {
      const runtime = runNativeLifecycle(native[event][0], {
        fd_trip_mode: [String(testCase.mode)],
        fd_people: testCase.people || 1,
        fd_trip_end: testCase.end || "2026-10-22 18:00:00"
      });
      runtime.handler(testCase.rows.map(amount => ({ [field]: amount })));
      assert.deepEqual(runtime.writes, [["fd_receipt_result", testCase.expected]], `${event}:${testCase.name}`);
      assert.equal(runtime.state.fd_regular_allowance, "retain regular allowance");
      assert.equal(runtime.state.fd_package_allowance, "retain package allowance");
    }
    const bare = runNativeLifecycle(native.onAfterDel[0]);
    bare.handler([{ fd_receipt_value: 1.23 }, { fd_receipt_value: 4.56 }]);
    assert.deepEqual(bare.writes, [["fd_receipt_result", 5.79]], "formatted native/DSL rows retain their existing bare field contract");
  });

  it("keeps existing values when lifecycle data is absent, malformed, or bound to another table", () => {
    const { native } = nativeLifecycle();
    const invalidData = [undefined, null, {}, { values: [] }, "", 0,
      [null], [3], [[]], [{ "wrong_physical.fd_receipt_value": 99 }],
      [{ fd_receipt_value: {} }], [{ fd_receipt_value: "not a number" }]];
    for (const actions of Object.values(native)) for (const data of invalidData) {
      const runtime = runNativeLifecycle(actions[0]);
      runtime.handler(data);
      assert.deepEqual(runtime.writes, [], JSON.stringify(data));
      assert.equal(runtime.state.fd_receipt_result, "retained total");
    }
    for (const actions of Object.values(native)) {
      const runtime = runNativeLifecycle(actions[0], {}, "view");
      runtime.handler([]);
      assert.deepEqual(runtime.writes, [], "view-mode lifecycle keeps its source edit-only gate");
    }
  });

  it("retains hashes for the unchanged captured native producer callbacks", () => {
    for (const fn of Object.values(contract.functions)) {
      assert.equal(createHash("sha256").update(fn.text).digest("hex"), fn.sha256);
      assert.equal(fn.end - fn.start, fn.text.length);
    }
  });
});

function lifecycleActions(dsl) {
  return dsl.scripts.actions.filter(action => ["onAfterAdd", "onAfterDel"].includes(action.event) &&
    action.functionMappings?.some(mapping => mapping.basis === "deterministic-allowance-calculation"));
}

function withBindings(bindings) {
  const next = structuredClone(source);
  const script = next.scripts.sources[0];
  script.javascript = script.javascript.slice(0, script.javascript.indexOf('$("#TABLE_DL_"')) + bindings;
  return draftSourceDraft(next);
}

function assertUnprovedAllowance(dsl) {
  const family = dsl.scripts.actions.filter(action =>
    action.functionMappings?.some(mapping => mapping.basis === "deterministic-allowance-calculation"));
  assert.ok(family.length > 0);
  assert.ok(family.every(action => action.translationStatus === "needs_review" && action.coverage.status === "uncovered" &&
    action.coverage.residuals.some(residual => residual.code === "script.residual.allowance_receipt_lifecycle_unproven")));
  assert.ok(validateMigrationDsl(dsl, { mode: "execute" }).diagnostics.some(diagnostic =>
    diagnostic.level === "error" && diagnostic.code === "dsl.scripts.needs_review"));
}

function delegatedSource() {
  const combined = cleanSourceFile("tests/fixtures/route-validation/calculation-script-recipes/route-calculation-script-recipes_SysFormTemplate.xml");
  const allowance = combined.scripts.sources.find(candidate => candidate.id === "jsp_allowance_recipe.script.1");
  const grouped = combined.scripts.sources.find(candidate => candidate.id === "jsp_grouped_recipe.script.1");
  const start = scriptText.indexOf("function sumTripReceipts()");
  const end = scriptText.indexOf("\nfunction recalculateRegularAllowance()");
  const receipt = scriptText.slice(start, end);
  allowance.javascript = scriptText.slice(0, start) + receipt.slice(0, receipt.lastIndexOf("}")) +
    "  groupedAmount();\n}" + scriptText.slice(end);
  return { combined, allowance, grouped };
}

function nativeLifecycle(dsl = draftSourceDraft(source)) {
  const prepared = prepareSample({ ...dsl, scripts: { ...dsl.scripts, actions: lifecycleActions(dsl) } });
  const table = xformConfig(prepared.update).dataModel.find(model => model.dynamicProps?.detailFieldName === "fd_receipts");
  return { prepared, table, native: formAttr(prepared.update).controlAction.control[`${table.fdTableName}.${table.fdTableName}`] };
}

function runNativeLifecycle(action, overrides = {}, viewStatus = "edit") {
  const state = {
    fd_trip_mode: 0,
    fd_trip_start: "2026-10-22 08:00:00",
    fd_trip_end: "2026-10-22 18:00:00",
    fd_people: 1,
    fd_regular_allowance: "retain regular allowance",
    fd_package_allowance: "retain package allowance",
    fd_receipt_result: "retained total",
    ...overrides
  };
  const writes = [];
  const tableReads = [];
  const MKXFORM = {
    viewStatus,
    getValue(id) {
      if (!(id in state)) {
        tableReads.push(id);
        return { values: [{ fd_receipt_value: 999 }], dataState: {}, deleteState: [] };
      }
      return state[id];
    },
    setValue(id, value) { writes.push([id, value]); state[id] = value; }
  };
  const name = action.function.match(/^function\s+(\w+)/)[1];
  const handler = Function("MKXFORM", `${action.function}; return ${name};`)(MKXFORM);
  return { handler, state, writes, tableReads };
}

function nativeHost(rows, table, event, handler) {
  const evidence = { data: undefined, published: undefined };
  const host = {
    o: rows,
    d: table,
    m: { [`${table}.${table}`]: { [event]: true } },
    n: { actionFunsRunner(target, actions, actualEvent, data) {
      assert.equal(actualEvent, event);
      assert.deepEqual(target, { id: table, tableName: table, tableType: "detail" });
      evidence.data = data;
      handler(data);
    } },
    u(data) { evidence.published = data; }
  };
  return { host, evidence };
}

function replayDelete(rows, selected, table, handler) {
  const { host, evidence } = nativeHost(rows, table, "onAfterDel", handler);
  Object.assign(host, { N: selected, s() {}, D() {} });
  Function(...Object.keys(host), `return (${contract.functions.deleteHook.text})();`)(...Object.values(host));
  assert.deepEqual(evidence.published, evidence.data);
  return evidence;
}

async function replayAdd(rows, newRow, table, handler) {
  const { host, evidence } = nativeHost(rows, table, "onAfterAdd", handler);
  Object.assign(host, {
    r: undefined,
    l: newRow,
    g: "table",
    x: false,
    T: value => [...value],
    ii: Function(`return (${contract.functions.cloneDefaultRow.text});`)(),
    // The captured single-row state machine has one synchronous case and no
    // suspension. These inert hosts only advance that unchanged native case.
    F: { mark: fn => fn, wrap: body => ({ next: () => ({ done: true, value: body({ prev: 0, next: 0, stop() {} }) }) }) },
    $: (receiver, ignored, unused, generator) => Promise.resolve(generator().next().value)
  });
  await Function(...Object.keys(host), `return (${contract.functions.addHook.text})();`)(...Object.values(host));
  assert.deepEqual(evidence.published, evidence.data);
  return evidence;
}
