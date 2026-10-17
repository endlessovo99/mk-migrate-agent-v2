import assert from "node:assert/strict";
import {it} from "node:test";
import {literalArrayRowLifecycleCandidates as candidates} from "../../src/translator/literal-array-row-lifecycle.js";
import {runtime} from "../helpers/literal-array-row/observe.js";
import {form,row,membership,load,timer,change,helper,helperLifecycle,source} from "../helpers/literal-array-row/fixtures.js";
const actual=javascript=>candidates(source(javascript),form);
const rejects=javascript=>assert.equal(actual(javascript).length,0,javascript);
it("preserves event operand types instead of string-coercing array membership", () => {
  const javascript = change('var allowed=["A","B"];var mirror=GetXFormFieldById("memo")[0];mirror.value=changed;if(allowed.indexOf(changed)>=0){' + row(true) + '}else{' + row(false) + '}');
  const action = actual(javascript)[0];
  assert.ok(action);
  for (const value of ["A", "B", "", "AB", ["A"], ["A", "B"], null, undefined, 0, false, { value: "A" }, Symbol("s")]) {
    const old = runtime(javascript, form), migrated = runtime(action.function, form, { target: true });
    assert.deepEqual(migrated.snapshot(migrated.invoke(migrated.action, value)), old.snapshot(old.invoke(old.handlers[0].fn, value)), String(value));
  }
});
it("reads helpers freshly after writes and only when a deferred load fires", () => {
  const actions = actual(helperLifecycle);
  assert.equal(actions.length, 2);
  const old = runtime(helperLifecycle, form, { state: { memo: "B" } }), migrated = runtime(actions[0].function, form, { state: { memo: "B" }, target: true });
  assert.deepEqual(old.trace, []); assert.deepEqual(migrated.trace, []);
  old.handlers[0].fn(); migrated.action();
  assert.deepEqual(old.trace, [["schedule", 510]]); assert.deepEqual(migrated.trace, old.trace);
  old.values.memo = "A"; migrated.values.memo = "A";
  old.timers.shift()(); migrated.timers.shift()(); assert.deepEqual(migrated.snapshot(), old.snapshot());
  const fresh = runtime(helperLifecycle, form, { state: { memo: "A" } }), changed = runtime(actions[1].function, form, { state: { memo: "A" }, target: true });
  for (const value of ["B", "unknown", "A"]) { fresh.handlers[1].fn(value); changed.action(value); assert.deepEqual(changed.snapshot(), fresh.snapshot()); }
  assert.ok(changed.trace.findIndex(entry => entry[0] === "write") < changed.trace.findIndex(entry => entry[0] === "read"));
});
it("separates helper/caller scopes and reruns repeated helper reads", () => {
  const javascript = helper + change('var current=GetXFormFieldById("alternate")[0].value;var allowed=["C"];if(allowed.indexOf(current)>=0){' + row(true, "second_row") + '}synchronizeRows();synchronizeRows();');
  const action = actual(javascript)[0]; assert.ok(action);
  for (const memo of ["A", "C"]) {
    const state = { memo, alternate: "C" }, old = runtime(javascript, form, { state }), migrated = runtime(action.function, form, { state, target: true });
    assert.deepEqual(migrated.snapshot(migrated.invoke(migrated.action, "B")), old.snapshot(old.invoke(old.handlers[0].fn, "B")));
    assert.equal(migrated.trace.filter(entry => entry[0] === "read" && entry[1] === "memo").length, 2);
  }
});
it("renames arbitrary bindings, including generated-global collisions", () => {
  for (const [arrayName, scalarName, helperName, parameter] of [["Array", "String", "unrelatedName", "newValue"], ["MKXFORM", "console", "Array", "String"], ["a", "b", "rowCalculation", "MKXFORM"]]) {
    const javascript = helperLifecycle.replaceAll("synchronizeRows", helperName).replaceAll("allowed", arrayName).replaceAll("current", scalarName).replaceAll("changed", parameter), actions = actual(javascript);
    assert.equal(actions.length, 2, javascript);
    const state = { memo: "A" }, old = runtime(javascript, form, { state }), migrated = runtime(actions[1].function, form, { state, target: true });
    assert.deepEqual(migrated.snapshot(migrated.invoke(migrated.action, "B")), old.snapshot(old.invoke(old.handlers[1].fn, "B")));
  }
});
it("requires all sibling callbacks for ownership and leaves Source Draft immutable", () => {
  const original = source(load(membership) + change("unknownEffect();")), before = structuredClone(original), actions = candidates(original, form);
  assert.equal(actions.length, 1); assert.equal(actions[0].semanticHints.pendingSourceCallbackOffsets.length, 1);
  assert.equal(actions[0].semanticHints.ownsLegacyRowEffects, undefined); assert.deepEqual(original, before);
  assert.equal(actual(load(membership))[0].semanticHints.ownsLegacyRowEffects, true);
});
it("preserves empty arrays, duplicate literals and empty-string members", () => {
  for (const initializer of ['[]', '["","A","A"]']) {
    const javascript = load(membership.replace('["A","B"]', initializer)), action = actual(javascript)[0];
    assert.ok(action);
    for (const memo of ["A", "B", ""]) {
      const state = { memo }, old = runtime(javascript, form, { state }), migrated = runtime(action.function, form, { state, target: true });
      assert.deepEqual(migrated.snapshot(migrated.invoke(migrated.action)), old.snapshot(old.invoke(old.handlers[0].fn)));
    }
  }
});
for (const [name, replacement] of Object.entries({
  push: 'var allowed=["A","B"];allowed.push("C");', splice: 'var allowed=["A","B"];allowed.splice(0,1);',
  sort: 'var allowed=["A","B"];allowed.sort();', indexWrite: 'var allowed=["A","B"];allowed[0]="C";',
  lengthWrite: 'var allowed=["A","B"];allowed.length=0;', replace: 'var allowed=["A","B"];allowed=["C"];',
  alias: 'var allowed=["A","B"];var escaped=allowed;', escape: 'var allowed=["A","B"];unknown(allowed);',
  return: 'var allowed=["A","B"];return allowed;', sparse: 'var allowed=["A",,"B"];', spread: 'var allowed=[...other];',
  expression: 'var allowed=[current];', regexp: 'var allowed=[/A/];', numeric: 'var allowed=[1];',
  duplicate: 'var allowed=["A","B"];var allowed=["C"];'
})) it("rejects nonliteral or mutable array: " + name, () => rejects(load(membership.replace('var allowed=["A","B"];', replacement))));

for (const [name, predicate] of Object.entries({
  fromIndex: 'allowed.indexOf(current,1)>=0', computed: 'allowed["indexOf"](current)>=0', optional: 'allowed?.indexOf(current)>=0',
  comparison: 'allowed.indexOf(current)>0', boundary: 'allowed.indexOf(current)>=1', direction: '0<=allowed.indexOf(current)', dynamic: 'allowed[method](current)>=0'
})) it("rejects unproven membership predicate: " + name, () => rejects(load(membership.replace('allowed.indexOf(current)>=0', predicate))));

for (const [name, javascript] of Object.entries({
  parameterShadow: helper + 'AttachXFormValueChangeEventById("choice",function(synchronizeRows){synchronizeRows();});',
  variableShadow: helper + change('var synchronizeRows=changed;synchronizeRows();'),
  duplicateDefinition: helper + helper + load('synchronizeRows();'), reassigned: helper + change('synchronizeRows=changed;synchronizeRows();'),
  receiverCall: helper + load('synchronizeRows.call(null);'), arguments: helper + load('synchronizeRows("A");'),
  observedReturn: helper + load('var result=synchronizeRows();'),
  recursion: helper.replace(membership, membership + 'synchronizeRows();') + load('synchronizeRows();'),
  mutualRecursion: helper.replace(membership, membership + 'otherHelper();') + 'function otherHelper(){synchronizeRows();}' + load('synchronizeRows();'),
  nested: helper.replace(membership, 'function nested(){}' + membership) + load('synchronizeRows();'),
  closure: 'var outside="A";' + helper.replace('var current=GetXFormFieldById("memo")[0].value;', 'var current=outside;') + load('synchronizeRows();'),
  unknownEffect: helper.replace(membership, membership + 'unknownEffect();') + load('synchronizeRows();'),
  valueWrite: helper.replace(membership, membership + 'var mirror=GetXFormFieldById("memo")[0];mirror.value="A";') + load('synchronizeRows();'),
  rowReset: helper.replaceAll(',false,false);', ',false,true);') + load('synchronizeRows();'),
  externalMutation: helper + load('synchronizeRows();') + change('synchronizeRows=changed;'),
  unused: helper + load(membership)
})) it("rejects unproven helper identity, scope or effect: " + name, () => rejects(javascript));

for (const [name, javascript] of Object.entries({
  prototypeMutation: load(membership + 'Array.prototype.indexOf=unknown;'), dynamicGlobals: load(membership + 'globalThis.synchronizeRows=unknown;'),
  uncheckedRadio: timer('var current=$(\'[name="extendDataFormInfo.value(choice)"]\').val();var allowed=["A"];if(allowed.indexOf(current)>=0){' + row(true) + '}'),
  valueList: load(membership.replace('GetXFormFieldById("memo")[0].value', 'GetXFormFieldValueById("memo")')),
  missingField: load(membership.replaceAll('"memo"', '"absent"')), missingRow: load(membership.replaceAll('"first_row"', '"absent_row"')),
  unknownSibling: load(membership.replace('}else{', '}else{unknownEffect();')),
  branchVar: load('if(GetXFormFieldById("memo")[0].value=="A"){' + membership + '}'),
  conditionalTimer: load('if(GetXFormFieldById("memo")[0].value=="A"){setTimeout(function(){' + membership + '},510);}')
})) it("leaves unsupported source behavior pending: " + name, () => rejects(javascript));

it("rejects ambiguous, data-only, mismatched and unsupported field/control contracts", () => {
  const forms = [
    { ...form, fields: [...form.fields, structuredClone(form.fields.find(field => field.id === "memo"))] },
    { ...form, fields: form.fields.map(field => field.id === "memo" ? { ...field, dataOnly: true } : field) },
    { ...form, fields: form.fields.map(field => field.id === "memo" ? { ...field, sourceProps: { ...field.sourceProps, metadataId: "different" } } : field) },
    { ...form, fields: form.fields.map(field => field.id === "memo" ? { ...field, sourceProps: { ...field.sourceProps, metadataAttributes: { type: "Number" } } } : field) },
    { ...form, fields: form.fields.map(field => field.id === "memo" ? { ...field, sourceProps: { ...field.sourceProps, metadataAttributes: undefined } } : field) },
    { ...form, fields: form.fields.map(field => field.id === "choice" ? { ...field, componentId: "xform-unknown" } : field) },
    { ...form, fields: form.fields.map(field => field.id === "memo" ? { ...field, type: "number", componentId: "xform-number" } : field) }
  ];
  for (const candidateForm of forms) assert.equal(candidates(source(helperLifecycle), candidateForm).some(action => action.event === "onChange"), false);
});
