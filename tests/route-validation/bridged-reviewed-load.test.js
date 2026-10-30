import assert from "node:assert/strict";
import { it } from "node:test";
import vm from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { reconcileBridgedRowOwnership } from "../../src/agent-review/bridged-row-ownership.js";
import { bridgedInitialVisibilityIssues } from "../../src/dsl/bridged-row-visibility.js";
import { runAgentReview } from "../../src/agent-review/index.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { checkExecute } from "../../src/dsl/checks.js";
import { executeDsl } from "../../src/executor/execute.js";
import { formAttr, prepareSample, xformConfig } from "../helpers/persistence.js";
import { nativeScalarFormRules } from "../helpers/native-scalar-form-rules.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";

const fixture = "tests/fixtures/route-validation/bridged-reviewed-load/route-bridged-reviewed-load_SysFormTemplate.xml";
const selectFixture = "tests/fixtures/route-validation/bridged-reviewed-load-select/route-bridged-reviewed-load-select_SysFormTemplate.xml";

function reviewedLoad(draft, token, target) {
  const index = draft.scripts.actions.findIndex(action => action.event === "onLoad" &&
    action.branchProvenance?.conditions?.some(condition => condition.value === token));
  assert.notEqual(index, -1);
  const action = draft.scripts.actions[index];
  const fn = `function onLoad() {
    MKXFORM.setFieldAttr("${target}", 4);
    MKXFORM.setFieldAttr("${target}", 6);
    var current = MKXFORM.getValue("fd_state_${token}");
    if (current == "${token}") {
      MKXFORM.setFieldAttr("${target}", 5);
      MKXFORM.setFieldAttr("${target}", 6);
    } else {
      MKXFORM.setFieldAttr("${target}", 4);
      MKXFORM.setFieldAttr("${target}", 6);
    }
  }`;
  const patch = (property, value) => ({
    op: "replace", path: `/scripts/actions/${index}/${property}`, value,
    sourceRefs: action.sourceRefs, evidence: ["Preserve the source load callback and row effects."],
    confidence: 0.99, rationale: "Retain the original load behavior."
  });
  return [
    patch("function", fn), patch("translationStatus", "mapped"),
    patch("coverage", { status: "translated", nativeRules: [], residuals: [] }),
    patch("functionMappings", [{ source: "legacy load row lifecycle", target: "MKXFORM.getValue/setFieldAttr", basis: "semantic-translation", reviewRequired: false }])
  ];
}

it("removes only a fully reviewed bridged load rule that competes with a proven change action", () => {
  const source = cleanSourceFile(fixture);
  const draft = draftSourceDraft(source);
  assert.deepEqual(draft.formRules.linkage.map(rule => rule.id), [
    "linkage.fd_type.contains.A.load", "linkage.fd_type.contains.B.load", "linkage.fd_other.contains.C.load"
  ]);
  const result = applyEvidenceBackedPatches(draft, reviewedLoad(draft, "A", "fd_A_primary_row"), {
    sourceRefs: collectSourceRefs(source), sourceDraft: source
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.dslDraft.formRules.linkage.map(rule => rule.id), [
    "linkage.fd_type.contains.B.load", "linkage.fd_other.contains.C.load", "initial.linkage.fd_type.contains.A.load"
  ]);
  assert.equal(result.decisions.some(decision => decision.decisionType === "deterministic_script_ownership"), true);
});

it("retains the native rule until the exact source-backed load and change actions are proven", () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  const reviewed = applyEvidenceBackedPatches(draft, reviewedLoad(draft, "A", "fd_A_primary_row"), {
    sourceRefs: collectSourceRefs(source), sourceDraft: source
  });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.diagnostics));
  const originalRule = draft.formRules.linkage[0];
  for (const mutate of [
    value => { value.scripts.actions.find(action => action.event === "onLoad").translationStatus = "needs_review"; },
    value => { value.scripts.actions.find(action => action.event === "onLoad").function =
      'function onLoad() { var current = MKXFORM.getValue("fd_state_A"); if (current == "A") {} else {} }'; },
    value => { value.scripts.actions.find(action => action.event === "onLoad").runWhen = { viewStatusIn: ["add"] }; },
    value => { value.scripts.actions.find(action => action.event === "onChange").runWhen = { viewStatusIn: ["edit"] }; },
    value => { value.scripts.actions.find(action => action.event === "onChange").function += "\nunknown();"; },
    value => { value.form.fields.find(field => field.id === "fd_state_A").props.defaultValue = { kind: "literal", value: "A" }; },
    value => { value.form.fields.find(field => field.id === "fd_type").props.defaultValue = { kind: "literal", value: "A" }; },
    value => { value.scripts.actions.push({ translationStatus: "mapped", function: 'function f() { MKXFORM.setValue(target, "x"); }' }); },
    value => { value.form.fields.find(field => field.sourceProps?.generatedInitialVisibilityAnchor).reason = "conflicting field"; },
    value => { value.formRules.linkage.push(structuredClone(originalRule)); },
    value => { value.formRules.linkage[0].effects[0].target = "fd_B_row"; }
  ]) {
    const candidate = structuredClone(reviewed.dslDraft);
    candidate.formRules.linkage.unshift(structuredClone(originalRule));
    mutate(candidate);
    const reconciled = reconcileBridgedRowOwnership(source, draft, candidate);
    assert.equal(reconciled.draft.formRules.linkage.some(rule => rule.id === originalRule.id), true);
  }
  for (const mutate of [
    field => { field.sourceProps.metadataAttributes.defaultValue = "A"; },
    field => { field.sourceProps.designerValues.formula = "nonempty"; },
    field => { field.sourceProps.designerValues.reCalculate = "true"; }
  ]) {
    const alteredDraft = structuredClone(draft), candidate = structuredClone(reviewed.dslDraft);
    mutate(alteredDraft.form.fields.find(field => field.id === "fd_state_A"));
    mutate(candidate.form.fields.find(field => field.id === "fd_state_A"));
    candidate.formRules.linkage.unshift(structuredClone(originalRule));
    const reconciled = reconcileBridgedRowOwnership(source, alteredDraft, candidate);
    assert.equal(reconciled.draft.formRules.linkage.some(rule => rule.id === originalRule.id), true);
  }
  const safeAnonymousAction = structuredClone(reviewed.dslDraft);
  safeAnonymousAction.formRules.linkage.unshift(structuredClone(originalRule));
  safeAnonymousAction.scripts.actions.push({ translationStatus: "mapped", function: 'function (key) { return MKXFORM.getValue(key); }' });
  assert.equal(reconcileBridgedRowOwnership(source, draft, safeAnonymousAction).removed.length, 1);
});

it("initializes source-hidden rows once and never reapplies that initialization on selector changes", () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  const patches = [
    ...reviewedLoad(draft, "A", "fd_A_primary_row"), ...reviewedLoad(draft, "B", "fd_B_row"),
    ...reviewedLoad(draft, "C", "fd_C_row")
  ];
  const reviewed = applyEvidenceBackedPatches(draft, patches, { sourceRefs: collectSourceRefs(source), sourceDraft: source });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.diagnostics));
  const prepared = prepareSample(reviewed.dslDraft), config = xformConfig(prepared.update);
  const native = nativeScalarFormRules(config), attr = formAttr(prepared.update);
  const key = Object.keys(attr.controlAction.control).find(name => name.endsWith(".fd_type"));
  const changes = attr.controlAction.control[key].onChange.map(action =>
    vm.runInNewContext(`(${action.function})`, { MKXFORM: native.runtime.MKXFORM }));
  native.initialize();
  for (const id of ["fd_value_A", "fd_value_B", "fd_value_C"]) assert.equal(native.visible(id), false, id);
  for (const selection of ["A", "B", "A", ""]) {
    changes.forEach(change => change(selection));
    native.change("fd_type", selection);
    assert.equal(native.effects.length, 0, "initialization must not run on selector changes");
    assert.equal(native.visible("fd_value_A"), selection === "A");
    assert.equal(native.visible("fd_value_B"), selection === "B");
  }
  changes.forEach(change => change("A"));
  native.changeWithSnapshot("fd_type", "A", { fd_type: "" });
  assert.equal(native.effects.length, 0, "a stale selector snapshot must not trigger initialization");
  assert.equal(native.visible("fd_value_A"), true);
  native.initialize({ fd_state_A: "A" });
  native.runtime.MKXFORM.setValue("fd_state_A", "A");
  vm.runInNewContext(`(${attr.controlAction.global.onLoad[0].function})`, { MKXFORM: native.runtime.MKXFORM })();
  assert.equal(native.visible("fd_value_A"), true, "the source load action restores an existing selection");
  assert.equal(native.visible("fd_value_B"), false);
  const damaged = structuredClone(prepared.update), damagedConfig = xformConfig(damaged);
  const damagedAttr = JSON.parse(damagedConfig.attribute.formAttr);
  damagedAttr.formRule.display.shift();
  damagedConfig.attribute.formAttr = JSON.stringify(damagedAttr);
  damaged.mechanisms["sys-xform"].fdConfig = JSON.stringify(damagedConfig);
  assert.equal(prepared.verify(damaged).ok, false, "readback must detect a missing initialization rule");
  for (const mutate of [
    props => { props.defaultValueType = "fixed"; props.defaultValue = "changed"; },
    props => { props.defaultValueFormulaVO = { script: '"changed"' }; },
    props => { props.hidden = false; },
    props => { props.passValue = false; }
  ]) {
    const changed = structuredClone(prepared.update), changedConfig = xformConfig(changed);
    const anchorId = reviewed.dslDraft.formRules.review.bridgedInitialVisibility.anchorId;
    const field = changedConfig.dataModel.flatMap(model => model.fdFields || []).find(item => item.fdName === anchorId);
    assert.ok(field, "generated initialization anchor must persist in the data model");
    const attribute = JSON.parse(field.fdAttribute);
    mutate(attribute.config.controlProps);
    field.fdAttribute = JSON.stringify(attribute);
    changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(changedConfig);
    assert.equal(prepared.verify(changed).ok, false, "readback must detect a mutable or visible initialization anchor");
  }
});

it("does not reopen the previous category when native dispatch receives its stale snapshot", () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  const patches = [
    ...reviewedLoad(draft, "A", "fd_A_primary_row"), ...reviewedLoad(draft, "B", "fd_B_row"),
    ...reviewedLoad(draft, "C", "fd_C_row")
  ];
  const reviewed = applyEvidenceBackedPatches(draft, patches, { sourceRefs: collectSourceRefs(source), sourceDraft: source });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.diagnostics));
  const old = structuredClone(reviewed.dslDraft);
  old.formRules.linkage = structuredClone(draft.formRules.linkage);
  delete old.formRules.review.bridgedInitialVisibility;

  function run(dsl) {
    const prepared = prepareSample(dsl), config = xformConfig(prepared.update), attr = formAttr(prepared.update);
    const native = nativeScalarFormRules(config), actions = attr.controlAction.control;
    const changeFor = id => actions[Object.keys(actions).find(name => name.endsWith(`.${id}`))].onChange.map(action =>
      vm.runInNewContext(`(${action.function})`, { MKXFORM: native.runtime.MKXFORM }));
    const typeChange = changeFor("fd_type"), otherChange = changeFor("fd_other");
    native.initialize();
    typeChange.forEach(change => change("A"));
    native.change("fd_type", "A");
    assert.equal(native.visible("fd_value_A"), true);
    typeChange.forEach(change => change("X"));
    assert.equal(native.visible("fd_value_A"), false, "the new selection's script hides the old category");
    native.changeWithSnapshot("fd_type", "X", { fd_type: "A" });
    const afterUnknown = native.visible("fd_value_A");
    typeChange.forEach(change => change("B"));
    native.changeWithSnapshot("fd_type", "B", { fd_type: "A" });
    const afterSwitch = [native.visible("fd_value_A"), native.visible("fd_value_B")];
    otherChange.forEach(change => change("C"));
    native.changeWithSnapshot("fd_other", "C", { fd_other: "" });
    return { afterUnknown, afterSwitch, other: native.visible("fd_value_C"), effects: native.effects.length };
  }

  const before = run(old), after = run(reviewed.dslDraft);
  assert.equal(before.afterUnknown, true, "the old competing rule reproduces the visible previous category");
  assert.deepEqual(before.afterSwitch, [true, false], "the old rule can also hide the newly selected category");
  assert.equal(after.afterUnknown, false);
  assert.deepEqual(after.afterSwitch, [false, true]);
  assert.equal(after.other, true, "a second independent selector retains its own visible row");
  assert.equal(after.effects, 0, "selector snapshots do not re-run initialization rules");
});

it("treats a native null clear as the source-proven blank select event", () => {
  const source = cleanSourceFile(selectFixture), draft = draftSourceDraft(source);
  const patches = [
    ...reviewedLoad(draft, "A", "fd_A_primary_row"), ...reviewedLoad(draft, "B", "fd_B_row"),
    ...reviewedLoad(draft, "C", "fd_C_row")
  ];
  const reviewed = applyEvidenceBackedPatches(draft, patches, { sourceRefs: collectSourceRefs(source), sourceDraft: source });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.diagnostics));
  const trusted = createTrustedMigrationDsl(source, reviewed.dslDraft, { externalAgentReviewed: true, decisions: reviewed.decisions });
  assert.equal(checkTrust(source, trusted).ok, true);
  const prepared = prepareSample(trusted), native = nativeScalarFormRules(xformConfig(prepared.update)), attr = formAttr(prepared.update);
  assert.equal(prepared.verify(prepared.update).ok, true);
  const key = Object.keys(attr.controlAction.control).find(name => name.endsWith(".fd_type"));
  const actions = attr.controlAction.control[key].onChange.map(action => vm.runInNewContext(`(${action.function})`, { MKXFORM: native.runtime.MKXFORM }));
  assert.ok(attr.controlAction.control[key].onChange.every(action => action.function.includes('value === null ? "" : value')));
  assert.ok(trusted.scripts.actions.filter(action => action.controlId === "fd_type").every(action => !action.function.includes("value === null")));
  native.initialize();
  for (const selected of ["A", "B"]) {
    actions.forEach(action => action(selected));
    native.change("fd_type", selected);
    assert.equal(native.visible(`fd_value_${selected}`), true);
    assert.doesNotThrow(() => actions.forEach(action => action(null)), "native null must follow the source blank branch");
    native.changeWithSnapshot("fd_type", null, { fd_type: selected });
    assert.equal(native.effects.length, 0);
    assert.equal(native.visible("fd_value_A"), false);
    assert.equal(native.visible("fd_value_B"), false);
    assert.equal(native.runtime.MKXFORM.getValue("fd_state_A"), "");
    assert.equal(native.runtime.MKXFORM.getValue("fd_state_B"), "");
  }
  assert.throws(() => actions[0](undefined), /indexOf/u, "only the source-backed null representation is adapted");
  const damaged = structuredClone(prepared.update), config = xformConfig(damaged);
  const altered = JSON.parse(config.attribute.formAttr);
  altered.controlAction.control[key].onChange[0].function = altered.controlAction.control[key].onChange[0].function
    .replace('(value === null ? "" : value)', "value");
  config.attribute.formAttr = JSON.stringify(altered);
  damaged.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  assert.equal(prepared.verify(damaged).ok, false, "readback must detect a removed native empty-select bridge");
  for (const mutate of [
    value => { delete value.form.fields.find(field => field.id === "fd_type").sourceProps.runtimeSelectEmpty; },
    value => { value.form.fields.find(field => field.id === "fd_type").sourceProps.runtimeSelectEmpty.status = "unsupported"; },
    value => { value.form.fields.find(field => field.id === "fd_type").props.options[0].value = "other"; },
    value => { value.form.fields.find(field => field.id === "fd_type").props.defaultValue.value = "A"; },
    value => { value.scripts.actions.find(action => action.controlId === "fd_type").function += "\nunknown();"; }
  ]) {
    const invalid = structuredClone(trusted); mutate(invalid);
    assert.equal(checkExecute(invalid).ok, false);
    assert.equal(checkTrust(source, invalid).ok, false);
  }
  const unprovenSource = structuredClone(source);
  delete unprovenSource.form.controls.find(field => field.id === "fd_type").sourceProps.runtimeSelectEmpty;
  const unprovenDraft = draftSourceDraft(unprovenSource);
  const unproven = applyEvidenceBackedPatches(unprovenDraft, [
    ...reviewedLoad(unprovenDraft, "A", "fd_A_primary_row"), ...reviewedLoad(unprovenDraft, "B", "fd_B_row"),
    ...reviewedLoad(unprovenDraft, "C", "fd_C_row")
  ], { sourceRefs: collectSourceRefs(unprovenSource), sourceDraft: unprovenSource });
  assert.equal(unproven.ok, true);
  assert.equal(unproven.dslDraft.formRules.linkage.filter(rule => rule.source === "fd_type").length, 2,
    "unproven empty semantics must retain and block the competing rules");
  const unsafe = createTrustedMigrationDsl(unprovenSource, unproven.dslDraft, { externalAgentReviewed: true, decisions: unproven.decisions });
  assert.equal(checkExecute(unsafe).ok, false);
});

it("allows an independently resolved detail-row update while keeping the initialization anchor protected", () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  const reviewed = applyEvidenceBackedPatches(draft, reviewedLoad(draft, "A", "fd_A_primary_row"), {
    sourceRefs: collectSourceRefs(source), sourceDraft: source
  });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.diagnostics));
  const detailSource = cleanSourceFile("tests/fixtures/route-validation/detail-main-row-lifecycle/route-detail-main-row-lifecycle_SysFormTemplate.xml");
  const detailDraft = draftSourceDraft(detailSource);
  const table = detailDraft.form.fields.find(field => field.type === "detailTable");
  const detailAction = detailDraft.scripts.actions.find(action => action.function?.includes("MKXFORM.updateControl("));
  assert.ok(table && detailAction && detailAction.translationStatus === "mapped");
  const match = detailAction.function.match(/MKXFORM\.updateControl\("(\$\{table:[^}]+\}\.[^"]+)"/u);
  assert.ok(match);
  const target = match[1], expected = structuredClone(draft);
  expected.form.fields.push(structuredClone(table));

  function candidate(fn, modifyTable = () => {}) {
    const value = structuredClone(reviewed.dslDraft);
    value.formRules.linkage.unshift(structuredClone(draft.formRules.linkage[0]));
    const detailTable = structuredClone(table);
    modifyTable(detailTable);
    value.form.fields.push(detailTable);
    value.scripts.actions.push({ ...structuredClone(detailAction), id: "unrelated-detail-action", function: fn });
    return value;
  }
  for (const fn of [detailAction.function, detailAction.function.replace("MKXFORM.updateControl(", "MKXFORM.updateControlStyle(")]) {
    const value = candidate(fn);
    assert.deepEqual(bridgedInitialVisibilityIssues(value.formRules, value.scripts, value.form, value.review), []);
    assert.equal(reconcileBridgedRowOwnership(source, expected, value).removed.length, 1,
      fn.includes("MKXFORM.updateControlStyle(") ? "style update" : "value update");
  }
  for (const fn of [
    detailAction.function.replace(JSON.stringify(target), "dynamicTarget"),
    detailAction.function.replace(JSON.stringify(target), JSON.stringify("${table:missing}.unknown")),
    detailAction.function.replace(JSON.stringify(target), JSON.stringify("fd_vinit_unresolved"))
  ]) {
    assert.equal(reconcileBridgedRowOwnership(source, expected, candidate(fn)).removed.length, 0);
  }
  assert.equal(reconcileBridgedRowOwnership(source, expected, candidate(detailAction.function,
    table => { table.columns.push(structuredClone(table.columns.find(column => target.endsWith(`.${column.id}`)))); })).removed.length, 0);
});

it("closes review, trust, fake persistence and the selected/reloaded row lifecycle", async () => withNetworkGuard(async () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  const provider = {
    metadata: () => ({ provider: "route-validation", baseUrl: "offline://route-review", model: "fixture" }),
    async review({ dslDraft, reviewScope }) {
      const targets = { A: "fd_A_primary_row", B: "fd_B_row", C: "fd_C_row" };
      const patches = (reviewScope.actionIndexes || []).flatMap(index => {
        const action = dslDraft.scripts.actions[index];
        const token = action?.branchProvenance?.conditions?.[0]?.value;
        return targets[token] && action.event === "onLoad" ? reviewedLoad(dslDraft, token, targets[token]) : [];
      });
      return { ok: true, status: "received", stage: "agent-review.provider", provider: "route-validation",
        baseUrl: "offline://route-review", model: "fixture", promptVersion: "route-review-v1",
        rawText: JSON.stringify({ summary: "Preserve the source load actions.", patches, diagnostics: [] }) };
    }
  };
  const checkpointSigningKey = "fixture-bridged-row-ownership-signing-key";
  let firstCheckpoint;
  const reviewed = await runAgentReview(source, draft, { provider, batchSize: 1, checkpointSigningKey,
    onCheckpoint: checkpoint => { firstCheckpoint ||= checkpoint; } });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.report?.diagnostics));
  assert.equal(reviewed.dsl.formRules.linkage.length, 3);
  assert.ok(reviewed.dsl.formRules.linkage.every(rule => rule.id.startsWith("initial.")));
  assert.equal(checkTrust(source, reviewed.dsl).ok, true);
  const resumed = await runAgentReview(source, draft, { provider, batchSize: 1, checkpointSigningKey,
    resumeCheckpoint: firstCheckpoint });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.report?.diagnostics));
  assert.deepEqual(resumed.dsl.formRules.linkage, reviewed.dsl.formRules.linkage);
  const adapter = new FakeNewoaAdapter("persist");
  const execution = await executeDsl(reviewed.dsl, { client: adapter, credentials: { username: "fixture", encryptedPassword: "fixture" },
    confirmWrite: true, targetCategoryId: "route-category-id", baseUrl: "https://p-sit.onewo.com" });
  assert.equal(execution.ok, true, JSON.stringify(execution.diagnostics));
  assert.equal(execution.readback.ok, true);
  const native = formAttr(adapter.template);
  assert.equal(native.formRule.display.length, 3);
  assert.ok(native.formRule.display.every(rule => rule.meta.sourceRuleId.startsWith("initial.")));
  const key = Object.keys(native.controlAction.control).find(name => name.endsWith(".fd_type"));
  const changes = native.controlAction.control[key].onChange;
  const load = native.controlAction.global.onLoad[0];
  const values = {}, fields = {};
  const MKXFORM = { viewStatus: "add", getValue: id => values[id], setValue: (id, value) => { values[id] = value; },
    setFieldAttr: (id, value) => { fields[id] ||= {}; if (value === 4 || value === 5) fields[id].visible = value === 5; } };
  const call = (action, value) => vm.runInNewContext(`(${action.function})`, { MKXFORM })(value);
  for (const value of ["A", "B", "A"]) {
    for (const action of changes) call(action, value);
    assert.equal(fields.fd_value_A.visible, value === "A");
    assert.equal(fields.fd_value_B.visible, value === "B");
  }
  fields.fd_value_A.visible = false;
  call(load);
  assert.equal(fields.fd_value_A.visible, true, "a persisted helper restores the selected row on load");
}));

it("persists and reads back the null-clear bridge through a fake NewOA execution", async () => withNetworkGuard(async () => {
  const source = cleanSourceFile(selectFixture), draft = draftSourceDraft(source);
  const patches = [
    ...reviewedLoad(draft, "A", "fd_A_primary_row"), ...reviewedLoad(draft, "B", "fd_B_row"),
    ...reviewedLoad(draft, "C", "fd_C_row")
  ];
  const reviewed = applyEvidenceBackedPatches(draft, patches, { sourceRefs: collectSourceRefs(source), sourceDraft: source });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.diagnostics));
  const trusted = createTrustedMigrationDsl(source, reviewed.dslDraft, { externalAgentReviewed: true, decisions: reviewed.decisions });
  assert.equal(checkTrust(source, trusted).ok, true);
  const adapter = new FakeNewoaAdapter("persist");
  const execution = await executeDsl(trusted, { client: adapter, credentials: { username: "fixture", encryptedPassword: "fixture" },
    confirmWrite: true, targetCategoryId: "route-category-id", baseUrl: "https://p-sit.onewo.com" });
  assert.equal(execution.ok, true, JSON.stringify(execution.diagnostics));
  assert.equal(execution.readback.ok, true);
  const attr = formAttr(adapter.template), key = Object.keys(attr.controlAction.control).find(name => name.endsWith(".fd_type"));
  assert.ok(attr.controlAction.control[key].onChange.every(action => action.function.includes('value === null ? "" : value')));
}));

it("blocks the old competing DSL and rejects an unproven removal at the trust boundary", () => {
  const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
  const patches = [
    ...reviewedLoad(draft, "A", "fd_A_primary_row"), ...reviewedLoad(draft, "B", "fd_B_row"),
    ...reviewedLoad(draft, "C", "fd_C_row")
  ];
  const reviewed = applyEvidenceBackedPatches(draft, patches, { sourceRefs: collectSourceRefs(source), sourceDraft: source });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.diagnostics));
  const trusted = createTrustedMigrationDsl(source, reviewed.dslDraft, { externalAgentReviewed: true });
  assert.equal(checkTrust(source, trusted).ok, true);
  const competing = structuredClone(trusted);
  competing.formRules.linkage.push(structuredClone(draft.formRules.linkage[0]));
  assert.equal(checkExecute(competing).diagnostics.some(item => item.code === "dsl.form_rules.competing_script_visibility"), true);
  const missingLoadEffects = structuredClone(trusted);
  missingLoadEffects.scripts.actions.find(action => action.event === "onLoad").function =
    'function onLoad() { var current = MKXFORM.getValue("fd_state_A"); if (current == "A") {} else {} }';
  assert.equal(checkTrust(source, missingLoadEffects).diagnostics.some(item => item.code === "trust.form_rule.bridged_row_ownership_unproven"), true);
  const mutations = [
    value => { value.formRules.linkage.shift(); },
    value => { value.formRules.linkage[0].when[0].field = "fd_type"; },
    value => { value.form.fields.find(field => field.sourceProps?.generatedInitialVisibilityAnchor).props.defaultValue = { kind: "literal", value: "changed" }; },
    value => { delete value.formRules.review.bridgedInitialVisibility; },
    value => { const anchor = value.formRules.review.bridgedInitialVisibility.anchorId;
      const action = value.scripts.actions.find(item => item.event === "onLoad");
      action.function = action.function.replace("{", `{ MKXFORM.setValue("${anchor}", "changed");`); },
    value => { const action = value.scripts.actions.find(item => item.event === "onLoad");
      action.function = action.function.replace("{", '{ MKXFORM.setValue(dynamicTarget, "changed");'); },
    value => { const action = value.scripts.actions.find(item => item.event === "onLoad");
      action.function = action.function.replace("{", '{ var alias = MKXFORM; alias.setValue(dynamicTarget, "changed");'); },
    value => { const action = value.scripts.actions.find(item => item.event === "onLoad");
      action.function = action.function.replace("{", '{ MKXFORM[dynamicMethod](dynamicTarget, "changed");'); }
  ];
  for (const mutate of mutations) {
    const corrupted = structuredClone(trusted); mutate(corrupted);
    assert.equal(checkExecute(corrupted).ok, false);
    assert.equal(checkTrust(source, corrupted).ok, false);
  }
});
