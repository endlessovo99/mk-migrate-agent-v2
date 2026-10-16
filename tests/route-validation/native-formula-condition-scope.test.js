import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { formAttr, prepareSample, projectTemplate, xformConfig } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const directory = "tests/fixtures/route-validation/native-formula-condition-scope";
const fixture = `${directory}/native-formula-condition-scope_SysFormTemplate.xml`;
// This fixture is the exact finite pure predicate at the captured Preview stack.
// It does not import or initialize a vendor bundle or access the target.
const trigger = vm.runInNewContext(readFileSync(`${directory}/native-main-choice-trigger.js`, "utf8"), {}, { timeout: 100 });
it("completes guarded native-formula execution, readback and transfer recording", async () => {
  const result = await runRouteCase("native-formula-condition-scope-success");
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.transferRecord.status, "recorded");
});
function draft() { return draftSourceDraft(cleanSourceFile(fixture)); }
function updateRules(payload, change) {
  const config = xformConfig(payload), attribute = JSON.parse(config.attribute.formAttr);
  change(attribute.formRule); config.attribute.formAttr = JSON.stringify(attribute);
  payload.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
}

it("retains a genuine source-backed formula route with both branches and both effects", () => {
  const source = cleanSourceFile(fixture), dsl = draftSourceDraft(source);
  const trusted = createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true, reviewerName: "synthetic formula scope review" });
  assert.equal(checkTrust(source, trusted).ok, true);
  assert.equal(dsl.formRules.linkage.length, 1);
  assert.equal(dsl.formRules.linkage[0].translationStatus, "executable");
  assert.deepEqual(dsl.formRules.linkage[0].meta.runWhen, { viewStatusIn: ["add", "edit"] });
  const rules = formAttr(projectTemplate(dsl)).formRule;
  assert.equal(rules.display.length, 2); assert.equal(rules.require.length, 2);
  for (const rule of [...rules.display, ...rules.require]) {
    assert.equal(rule.choices.items.length, 1);
    const item = rule.choices.items[0];
    assert.equal(item.condNodeType, "formula");
    assert.deepEqual(item.value.varIds, ["fd_selector"]);
    assert.match(item.value.script, /MKXFORM\.viewStatus/);
    assert.match(item.value.script, /\$\{data\.biz\.fd_selector\}/);
  }
});
it("uses the native creator's unbound formula condition scope", () => {
  const rules = formAttr(projectTemplate(draft())).formRule;
  for (const rule of [...rules.display, ...rules.require]) {
    assert.equal(rule.choices.items[0].type, "");
    assert.equal(rule.choices.items[0].tableType, "");
  }
});
for (const kind of ["display", "require"]) it(`${kind} formula initialization does not require an absent changed-field key`, () => {
  const rules = formAttr(projectTemplate(draft())).formRule;
  for (const rule of rules[kind]) {
    assert.doesNotThrow(() => trigger(rule.choices.items, undefined));
    assert.equal(trigger(rule.choices.items, "fd_selector"), false);
  }
});
it("reproduces the unsafe main-field formula scope without weakening the predicate", () => {
  const item = { type: "main", tableType: "main", fieldName: "", condNodeType: "formula" };
  assert.throws(() => trigger([item], undefined), /split/);
  assert.equal(trigger([{ type: "", tableType: "", condNodeType: "formula" }], undefined), false);
});
it("keeps ordinary main-field condition scope and direct change routing", () => {
  const dsl = draft();
  dsl.formRules.linkage = [{ id: "ordinary-choice", trigger: "change", source: "fd_selector", logic: "and", when: [{ field: "fd_selector", op: "eq", value: "A" }], effects: [{ type: "visible", target: "fd_value", value: true }], translationStatus: "executable" }];
  const item = formAttr(projectTemplate(dsl)).formRule.display[0].choices.items[0];
  assert.equal(item.condNodeType, "condition"); assert.equal(item.type, "main"); assert.equal(item.tableType, "main");
  assert.equal(trigger([item], "fd_selector"), true);
});
for (const kind of ["display", "require"]) for (const [key, value] of [["type", "main"], ["tableType", "single"]]) {
  it(`persisted readback rejects ${kind} formula field-bound ${key}`, () => {
    const p = prepareSample(draft()); assert.equal(p.verify(p.update).ok, true);
    const changed = structuredClone(p.update);
    updateRules(changed, rules => { rules[kind][0].choices.items[0][key] = value; });
    assert.equal(p.verify(changed).ok, false);
  });
}
it("accepts equivalent absent formula scope defaults without changing formulas or effects", () => {
  const p = prepareSample(draft()), changed = structuredClone(p.update);
  updateRules(changed, rules => { for (const rule of [...rules.display, ...rules.require]) { delete rule.choices.items[0].type; delete rule.choices.items[0].tableType; } });
  assert.equal(p.verify(changed).ok, true);
});
for (const [key, value] of [["type", "detail"], ["tableType", "main"]]) {
  it(`persisted readback rejects unsupported nonempty formula ${key}`, () => {
    const p = prepareSample(draft()), changed = structuredClone(p.update);
    updateRules(changed, rules => { rules.display[0].choices.items[0][key] = value; });
    assert.equal(p.verify(changed).ok, false);
  });
}
it("accepts equivalent null formula scope defaults", () => {
  const p = prepareSample(draft()), changed = structuredClone(p.update);
  updateRules(changed, rules => { for (const rule of [...rules.display, ...rules.require]) { rule.choices.items[0].type = null; rule.choices.items[0].tableType = null; } });
  assert.equal(p.verify(changed).ok, true);
});
