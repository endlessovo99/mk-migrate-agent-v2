import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { applyEvidenceBackedPatches, collectSourceRefs } from "../../src/agent-review/review-validation.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sourceDraftFromLegacyDsl } from "../../src/translator/source-draft.js";
import { translateSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { parseRootHashMapStringPuts } from "../../src/translator/xml-utils.js";
import { withDetailVisibilitySync } from "../../src/executor/persistence/detail-visibility-sync.js";
import { DETAIL_VISIBILITY_RUNTIME, inspectDetailVisibilityRuntime } from "../../src/executor/detail-visibility-runtime.js";
import { executeDsl } from "../../src/executor/execute.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { formAttr, persistAndVerify, projectTemplate, xformConfig } from "../helpers/persistence.js";

const sourcePath = "tests/fixtures/source/18bd737e9c30fcbc3aeff0a48aab8fac";
const evidencePath = new URL("../fixtures/route-validation/detail-visibility-submission/", import.meta.url);
const provenance = JSON.parse(readFileSync(new URL("provenance.json", evidencePath), "utf8"));
const tables = [
  "fd_3c6719a6f103f0", "fd_3c671d59b7128e",
  "fd_3c67388d66e9b0", "fd_3c6b0abc7c89cc"
];
const selector = "fd_3c66895473ff5c";

function nativeFunction(name) {
  const source = readFileSync(new URL(`${name}.js.txt`, evidencePath), "utf8").trimEnd();
  assert.equal(createHash("sha256").update(source).digest("hex"), provenance.functions[name].sha256);
  return source;
}

function reviewedDsl() {
  const source = cleanSourceFile(sourcePath);
  const draft = draftSourceDraft(source);
  const index = draft.scripts.actions.findIndex(action => action.event === "onChange" && action.controlId === selector);
  const action = draft.scripts.actions[index];
  assert.ok(action);
  const fn = [
    "function onChange(value, rowNum, parentRowNum) {",
    ...["A", "B", "C", "D"].map((value, i) =>
      `  ${i ? "else if" : "if"} (value.indexOf(${JSON.stringify(value)}) >= 0) { MKXFORM.setValue("fd_3c6a790de91eb0", ${JSON.stringify(value)}); }`),
    '  else { MKXFORM.setValue("fd_3c6a790de91eb0", ""); }',
    "}"
  ].join("\n");
  const common = { op: "replace", sourceRefs: action.sourceRefs, evidence: ["Source-bound helper values."], confidence: 0.99, rationale: "Preserve the source branches." };
  const patches = [
    { ...common, path: `/scripts/actions/${index}/function`, value: fn },
    { ...common, path: `/scripts/actions/${index}/translationStatus`, value: "mapped" },
    { ...common, path: `/scripts/actions/${index}/functionMappings`, value: [{ source: "legacy gated helper behavior", target: "MKXFORM.setValue helper synchronization", basis: "semantic-translation", reviewRequired: false }] },
    { ...common, path: `/scripts/actions/${index}/coverage`, value: { status: "translated", nativeRules: action.coverage.nativeRules, residuals: [] } }
  ];
  const result = applyEvidenceBackedPatches(draft, patches, { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.dslDraft;
}

function reviewedSelectDsl(source = cleanSourceFile("tests/fixtures/route-validation/detail-visibility-submission/select-detail_SysFormTemplate.xml")) {
  const draft = draftSourceDraft(source);
  const index = draft.scripts.actions.findIndex(action => action.event === "onChange" && action.controlId === "fd_route_type");
  const action = draft.scripts.actions[index];
  assert.ok(action);
  const common = { op: "replace", sourceRefs: action.sourceRefs, evidence: ["The select handler writes its source-backed helper value."], confidence: 0.99, rationale: "Preserve the source branch helper." };
  const patches = [
    { ...common, path: `/scripts/actions/${index}/function`, value: 'function onChange(value) { if ((value === null ? "" : value).indexOf("A") >= 0) { MKXFORM.setValue("fd_subject", "A"); } else { MKXFORM.setValue("fd_subject", "B"); } }' },
    { ...common, path: `/scripts/actions/${index}/translationStatus`, value: "mapped" },
    { ...common, path: `/scripts/actions/${index}/functionMappings`, value: [{ source: "GetXFormFieldById helper assignment", target: "MKXFORM.setValue helper synchronization", basis: "semantic-translation", reviewRequired: false }] },
    { ...common, path: `/scripts/actions/${index}/coverage`, value: { status: "translated", nativeRules: action.coverage.nativeRules, residuals: [] } }
  ];
  const result = applyEvidenceBackedPatches(draft, patches, { sourceDraft: source, sourceRefs: collectSourceRefs(source) });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.dslDraft;
}

test("shared-cell presentation and source-bound detail visibility coexist through native readback", async () => {
  const path = "tests/fixtures/route-validation/detail-visibility-submission/select-detail_SysFormTemplate.xml";
  const properties = parseRootHashMapStringPuts(readFileSync(path, "utf8"));
  const oldTable = `<table fd_type="detailsTable" fd_values='{id:"fd_route_detail",label:"明细"}'></table>`;
  const newTable = `<table fd_type="detailsTable" fd_values='{id:"fd_route_detail",label:"明细"}'><tbody>
    <tr type="titleRow"><td row="0" column="0"><label fd_type="textLabel" fd_values='{id:"detail_title",content:"名称"}'>名称</label></td></tr>
    <tr type="templateRow"><td row="1" column="0"><div style="display:inline" fd_type="inputText" fd_values='{id:"fd_detail_name",label:"名称",_label_bind:"true",_label_bind_id:"detail_title",tableName:"fd_route_detail"}'><input id="fd_detail_name"/></div><div style="display:inline" fd_type="inputText" fd_values='{id:"fd_detail_note",label:"补充",_label_bind:"false",_label_bind_id:"detail_title",tableName:"fd_route_detail"}'><input id="fd_detail_note"/></div></td></tr></tbody></table>`;
  assert.equal(properties.fdDesignerHtml.split(oldTable).length, 2);
  properties.fdDesignerHtml = properties.fdDesignerHtml.replace(oldTable, newTable);
  properties.fdMetadataXml = properties.fdMetadataXml.replace('</extendSubTableProperty>', '<extendSimpleProperty name="fd_detail_note" label="补充" type="String"/></extendSubTableProperty>');
  properties.fdDisplayJsp += '<table><tr><td><xform:xtext property="extendDataFormInfo.value(fd_route_detail.0.fd_detail_name)"/><xform:xtext property="extendDataFormInfo.value(fd_route_detail.0.fd_detail_note)"/></td></tr></table>';
  const encode = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const xml = '<java><object class="java.util.HashMap">' + Object.entries(properties).map(([key, value]) =>
    `<void method="put"><string>${key}</string><string>${encode(value)}</string></void>`).join("") + '</object></java>';
  const source = sourceDraftFromLegacyDsl(translateSysFormTemplateXml(xml)), draft = reviewedSelectDsl(source);
  assert.deepEqual(draft.form.fields.find(field => field.id === "fd_route_detail").detailCellGroups[0].fieldIds, ["fd_detail_name", "fd_detail_note"]);
  const dsl = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  const client = new FakeNewoaAdapter("persist", { detailCellRuntime: true, templateAuthorization: dsl.template?.authorization });
  const result = await executeDsl(dsl, { client, baseUrl: provenance.origin,
    credentials: { username: "fixture", encryptedPassword: "fixture" }, confirmWrite: true, targetCategoryId: "route-category-id" });
  assert.equal(result.ok, true, JSON.stringify({ status: result.status, stage: result.stage, diagnostics: result.diagnostics }));
  assert.equal(result.apiStages.find(stage => stage.name === "verifyDetailVisibilityRuntime")?.status, "ok");
  assert.equal(result.apiStages.find(stage => stage.name === "verifyDetailCellPresentationRuntime")?.status, "ok");
  assert.equal(result.readback.partitions.scripts, "verified");
  const attr = formAttr(client.template);
  assert.ok(attr.controlAction.global.onLoad.some(action => action.migrationActions?.some(item => item.id === "mk-detail-cell-presentation-v1")));
  const selectorKey = Object.keys(attr.controlAction.control).find(name => name.endsWith(".fd_route_type"));
  assert.ok(attr.controlAction.control[selectorKey].onChange.some(action => action.id.endsWith(".detail-visibility-sync")));
});

test("a source-bound single select retains its visible detail row in the native collector", () => {
  const dsl = reviewedSelectDsl();
  const attr = formAttr(projectTemplate(dsl));
  const key = Object.keys(attr.controlAction.control).find(name => name.endsWith(".fd_route_type"));
  const bridge = attr.controlAction.control[key].onChange.find(action => action.id.endsWith(".detail-visibility-sync"));
  assert.ok(bridge);
  const id = "fd_route_detail";
  const node = { kind: "control", name: id, isInvalid: true, hiddenInvalid: true,
    props: { value: { values: [{ fd_order: 1, fd_detail_name: "select-test-row" }] } } };
  const host = { detachedValues: { mechanisms: { "sys-auth": { fieldPermission: { [id]: { visible: true } } } } } };
  const sdk = { viewStatus: "add", $$FORM: { current: host }, setFieldAttr(target, state) {
    assert.equal(target, id); node.isInvalid = state === 4;
  } };
  const run = vm.runInNewContext(`(${bridge.function})`, { MKXFORM: sdk });
  const collect = vm.runInNewContext(`(${nativeFunction("getFormValues")})`);
  for (const [value, included] of [["A", true], ["B", false], ["A", true], ["", false], [null, false]]) {
    run(value);
    const values = collect({ [id]: node });
    assert.equal(Object.hasOwn(values, id), included);
    if (included) assert.equal(values[id].values[0].fd_detail_name, "select-test-row");
  }
  delete host.detachedValues.mechanisms["sys-auth"];
  run("A");
  assert.equal(node.isInvalid, true);
  host.detachedValues.mechanisms["sys-auth"] = { fieldPermission: { [id]: { visible: true } } };
  sdk.viewStatus = "view";
  run("A");
  assert.equal(node.isInvalid, true);
});

test("select visibility synchronization fails closed for multi or nonliteral choices", () => {
  const dsl = reviewedSelectDsl();
  const bridge = value => withDetailVisibilitySync(value.scripts, value.form, value.formRules)
    .actions.filter(action => action.id.endsWith(".detail-visibility-sync"));
  assert.equal(bridge(dsl).length, 1);
  for (const mutate of [
    field => { field.componentId = "xform-select~multi"; },
    field => { field.type = "multiSelect"; },
    field => { field.props.options = []; },
    field => { field.props.options[0].value = 1; },
    field => { field.props.options[0].value = field.props.options[1].value; }
  ]) {
    const copy = structuredClone(dsl);
    mutate(copy.form.fields.find(field => field.id === "fd_route_type"));
    assert.equal(bridge(copy).length, 0);
  }
});

// The original native callback is executed, with the smallest host behavior
// observed on QAS: detail display changes the label, while setFieldAttr also
// changes the form's isInvalid flag. The native value collector is captured too.
function runtime(attr, { order = "action-first", permission = {} } = {}) {
  const queue = [];
  const nodes = Object.fromEntries(tables.map((id, i) => [id, {
    kind: "control", name: id, isInvalid: true, hiddenInvalid: true,
    label: { hidden: true }, props: { value: { values: [{ fd_order: 1, testValue: `row-${i}` }] } }
  }]));
  const configs = Object.fromEntries(tables.flatMap(id => [
    [id, { key: id, type: "@elem/xform-detail-table", controlProps: { name: id, $$tableName: id, hiddenNames: [] } }],
    [`${id}-label`, { key: `${id}-label`, controlProps: { hidden: true } }]
  ]));
  const form = {
    detachedValues: { mechanisms: { "sys-auth": { fieldPermission: Object.fromEntries(tables.map(id => [id, { visible: permission[id] !== false }])) } } },
    getFormConfig(key) { return configs[key]; },
    updateFormItemProps(key, update) {
      Object.assign(configs[key].controlProps, update);
      if (key.endsWith("-label")) nodes[key.slice(0, -6)].label.hidden = update.hidden;
    },
    switchControlInvalid(key, invalid) { nodes[key].isInvalid = invalid; }
  };
  const sdk = {
    viewStatus: "add", $$FORM: { current: form },
    setValue() {},
    setFieldAttr(id, state) {
      assert.ok(nodes[id], `unexpected detail target ${id}`);
      assert.ok([4, 5].includes(state));
      nodes[id].isInvalid = state === 4;
      nodes[id].label.hidden = state === 4;
    }
  };
  const module = vm.runInNewContext(`(${nativeFunction("displayCallbackModule")})`, {
    console, setTimeout: fn => queue.push(fn)
  });
  const exports = {};
  const deps = { 39155: { useCallback: fn => fn }, 8655: { fmtMsg: () => "" }, 80536: { EPlatform: { mobile: "mobile" } }, 88055: { __esModule: true, default: value => value } };
  module({}, exports, id => { assert.ok(deps[id], `unexpected native dependency ${id}`); return deps[id]; });
  const callback = exports.default({ container: { current: form }, fakePlatform: "desktop", formKeyMapInfos: { current: Object.fromEntries(tables.map(id => [id, id])) }, fieldsAuth: {}, mode: "add" }).formRulesDisplayCallBack;
  const getValues = vm.runInNewContext(`(${nativeFunction("getFormValues")})`);
  const actionGroup = Object.entries(attr.controlAction.control).find(([key]) => key.endsWith(`.${selector}`));
  assert.ok(actionGroup);
  const actions = actionGroup[1].onChange.map(action => vm.runInNewContext(`(${action.function})`, { MKXFORM: sdk, console }));
  const applyRules = value => {
    for (const rule of attr.formRule.display) {
      const formula = rule.choices.items[0].value.script.replaceAll(`\${data.biz.${selector}}`, "value");
      if (!vm.runInNewContext(formula, { MKXFORM: sdk, value })) continue;
      for (const result of rule.result) if (result.tableType === "detail" && tables.includes(result.type)) callback(result);
    }
    while (queue.length) queue.shift()();
  };
  return {
    nodes, sdk,
    change(value) {
      const runActions = () => actions.forEach(action => action(value));
      if (order === "action-first") { runActions(); applyRules(value); }
      else { applyRules(value); runActions(); }
      return getValues(nodes);
    }
  };
}

test("a visible source-bound detail table remains in the native submit values", () => {
  const dsl = reviewedDsl();
  const attr = formAttr(projectTemplate(dsl));
  for (const order of ["action-first", "rules-first"]) {
    const r = runtime(attr, { order });
    for (const [value, selected] of [["A", 0], ["B", 1], ["A", 0], ["C", 2], ["D", 3], ["AB", 0], ["BA", 0], ["", -1]]) {
      const values = r.change(value);
      for (const [index, id] of tables.entries()) {
        assert.equal(Object.hasOwn(values, id), index === selected, `${order}: ${value || "empty"} ${id}`);
        if (index === selected) assert.equal(values[id].values[0].testValue, `row-${index}`);
      }
    }
  }
});

test("the projected fix never reveals a detail table denied by field permission", () => {
  const attr = formAttr(projectTemplate(reviewedDsl()));
  const r = runtime(attr, { permission: { [tables[0]]: false } });
  r.change("A");
  assert.equal(r.nodes[tables[0]].isInvalid, true);
  const missing = runtime(attr);
  delete missing.sdk.$$FORM.current.detachedValues.mechanisms["sys-auth"];
  missing.change("A");
  assert.equal(missing.nodes[tables[0]].isInvalid, true);
  const view = runtime(attr);
  view.sdk.viewStatus = "view";
  view.change("A");
  assert.equal(view.nodes[tables[0]].isInvalid, true);
});

test("persistence readback protects the source-bound detail visibility behavior", () => {
  const dsl = reviewedDsl();
  delete dsl.workflow;
  const result = persistAndVerify(dsl);
  assert.equal(result.readback.ok, true, JSON.stringify(result.readback.diagnostics));
  const changed = persistAndVerify(dsl, { mutate(template) {
    const config = xformConfig(template), attr = JSON.parse(config.attribute.formAttr);
    const key = Object.keys(attr.controlAction.control).find(name => name.endsWith(`.${selector}`));
    attr.controlAction.control[key].onChange = attr.controlAction.control[key].onChange
      .filter(action => !action.id.endsWith(".detail-visibility-sync"));
    config.attribute.formAttr = JSON.stringify(attr);
    template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    return template;
  } });
  assert.equal(changed.readback.partitions.scripts, "mismatch");
});

test("ambiguous ownership and unproven selector semantics do not add a native bridge", () => {
  const dsl = reviewedDsl();
  const bridge = value => withDetailVisibilitySync(value.scripts, value.form, value.formRules)
    .actions.filter(action => action.id.endsWith(".detail-visibility-sync"));
  assert.equal(bridge(dsl).length, 1);
  for (const mutate of [
    value => { value.form.fields.find(field => field.id === selector).componentId = "xform-checkbox"; },
    value => { value.scripts.actions.find(action => action.event === "onChange").coverage.status = "partial"; },
    value => { value.formRules.linkage = value.formRules.linkage.map(rule => ({ ...rule, meta: { ...rule.meta, conditionSemantics: rule.meta.conditionSemantics.map(item => ({ ...item, transforms: ["trim"] })) } })); },
    value => { value.formRules.linkage.push(structuredClone(value.formRules.linkage[0])); },
    value => { const action = value.scripts.actions.find(item => item.event === "onChange"); value.scripts.actions.push({ ...structuredClone(action), id: `${action.id}.duplicate` }); }
  ]) {
    const copy = structuredClone(dsl);
    mutate(copy);
    const synchronized = bridge(copy);
    if (synchronized.length) assert.doesNotMatch(synchronized[0].function, new RegExp(tables[0]));
  }
  const collision = structuredClone(dsl);
  const sourceAction = collision.scripts.actions.find(action => action.event === "onChange");
  collision.scripts.actions.push({ ...structuredClone(sourceAction), event: "onLoad", scope: "global", id: `${sourceAction.id}.detail-visibility-sync` });
  assert.throws(() => bridge(collision), { code: "projection.detail_visibility_action_collision" });
});

test("the native bridge requires the recorded desktop and mobile runtime bundles", async () => {
  assert.equal(DETAIL_VISIBILITY_RUNTIME.origin, provenance.origin);
  for (const platform of ["desktop", "mobile"]) {
    assert.equal(DETAIL_VISIBILITY_RUNTIME.modules[platform].release, provenance.bundles[platform].release);
    assert.equal(DETAIL_VISIBILITY_RUNTIME.modules[platform].sha256, provenance.bundles[platform].sha256);
  }
  assert.equal(provenance.bundles.mobile.displayCallbackSha256, provenance.functions.displayCallbackModule.sha256);
  const client = new FakeNewoaAdapter("persist", { detailVisibilityRuntime: true });
  assert.deepEqual(await inspectDetailVisibilityRuntime(client, provenance.origin), { ok: true, issues: [] });
  assert.deepEqual(await inspectDetailVisibilityRuntime(client, "https://other.example"), { ok: false, issues: ["origin_unverified"] });
  client.getXFormMobileDigest = async () => ({});
  assert.deepEqual(await inspectDetailVisibilityRuntime(client, provenance.origin), { ok: false, issues: ["mobile_release_unverified"] });
});

test("an unverified target runtime blocks before any template write", async () => {
  const source = cleanSourceFile(sourcePath), draft = reviewedDsl();
  const dsl = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  const wrongOrigin = new FakeNewoaAdapter("persist", { detailVisibilityRuntime: true });
  const originResult = await executeDsl(dsl, { client: wrongOrigin, baseUrl: "https://p-sit.onewo.com",
    credentials: { username: "fixture", encryptedPassword: "fixture" }, confirmWrite: true, targetCategoryId: "route-category-id" });
  assert.equal(originResult.status, "blocked");
  assert.ok(originResult.diagnostics.some(item => item.code === "safety.detail_visibility_origin_unverified"));
  assert.equal(wrongOrigin.transcript().length, 0);
  const client = new FakeNewoaAdapter("persist", { detailVisibilityRuntime: true });
  client.getXFormMobileDigest = async () => ({});
  const result = await executeDsl(dsl, { client, baseUrl: provenance.origin,
    credentials: { username: "fixture", encryptedPassword: "fixture" }, confirmWrite: true, targetCategoryId: "route-category-id" });
  assert.equal(result.status, "blocked", JSON.stringify(result.diagnostics));
  assert.equal(result.stage, "verifyDetailVisibilityRuntime");
  assert.equal(client.transcript().some(item => ["init", "add", "update", "save-workflow-draft"].includes(item.operation)), false);
});

test("the verified QAS route persists and reads back the detail visibility bridge", async () => {
  const source = cleanSourceFile(sourcePath), draft = reviewedDsl();
  delete draft.workflow;
  const dsl = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
  const client = new FakeNewoaAdapter("persist", { detailVisibilityRuntime: true, templateAuthorization: dsl.template?.authorization });
  const result = await executeDsl(dsl, { client, baseUrl: provenance.origin,
    credentials: { username: "fixture", encryptedPassword: "fixture" }, confirmWrite: true, targetCategoryId: "route-category-id" });
  assert.equal(result.ok, true, JSON.stringify({ status: result.status, stage: result.stage, diagnostics: result.diagnostics }));
  assert.equal(result.apiStages.find(stage => stage.name === "verifyDetailVisibilityRuntime")?.status, "ok");
  assert.equal(result.readback.partitions.scripts, "verified");
});
