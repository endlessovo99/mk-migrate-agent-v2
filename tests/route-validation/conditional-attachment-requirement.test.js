import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import {
  analyzeConditionalAttachmentRequirement,
  conditionalAttachmentRequirementCandidates
} from "../../src/translator/conditional-attachment-requirement.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { buildDeterministicScriptBranchProof } from "../../src/dsl/deterministic-script-translations.js";
import { executeDsl } from "../../src/executor/execute.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";

const fixture = "tests/fixtures/route-validation/conditional-attachment-requirement/route-conditional-attachment_SysFormTemplate.xml";
const native = JSON.parse(readFileSync("tests/fixtures/route-validation/conditional-attachment-requirement/native-attachment-read-contract.json", "utf8"));
const clone = value => structuredClone(value);
function inputs() {
  const sourceDraft = cleanSourceFile(fixture);
  return { source: sourceDraft.scripts.sources[0], form: draftSourceDraft(sourceDraft).form };
}
function nativeFunctions() {
  const run = (name, context = {}) => vm.runInNewContext(`(${native.parts[name].source})`, context);
  const utilities = { x: run("configs"), M: run("business"), I: run("main") };
  const utils = { getFormConfig: run("config", utilities), getFormConfigs: utilities.x };
  const enums = { EDataModelType: { detail: "detail" } };
  const detail = { DETAIL_TABLE_DESKTOP: "@elem/xform-detail-table", DETAIL_TABLE_MOBILE: "@elem/xform-m-detail-table" };
  const getter = run("getter", { r: enums, o: detail, i: utils, a: run("attached", { r: enums }), u: run("detached") });
  return {
    api: run("api", { r: { getValue: getter }, o: { $$form: context => context.form } }),
    requiredTransform: run("requiredTransform")
  };
}
const nativeFns = nativeFunctions();
function nativeForm(selected, files, status = "edit", storage = "fields") {
  const values = { "main.fd_quote": selected, "main.fd_compare_file": files };
  const configs = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
    key, type: key.endsWith("fd_quote") ? "@elem/xform-radio" : "@elem/xform-attach",
    controlProps: { $$tableType: "main", name: key.split(".")[1], showStatus: status === "hidden" ? "edit" : status, value },
    labelProps: { hidden: status === "hidden" }
  }]));
  return {
    businessInfos: { tableName: "main", names: ["fd_quote", "fd_compare_file"] },
    ...(storage === "attached" ? { attachedValues: values } : {}),
    getFormConfig(key) { return key ? configs[key] || configs[`main.${key}`] : configs; },
    getFieldsValue() { return storage === "fields" ? values : {}; }
  };
}
function targetSubmit(action, selected, files, status, storage) {
  const form = nativeForm(selected, files, status, storage);
  const messages = [];
  const result = vm.runInNewContext(`${action.function}\nonBeforeSubmit({isDraft:false});`, {
    MKXFORM: { getValue: id => nativeFns.api(id, { form }), toast: message => messages.push(message) }
  });
  return { result, messages, form };
}
function sourceSubmit(source, selected, files) {
  let submit;
  const messages = [];
  vm.runInNewContext(source.javascript, {
    $: () => ({ val: () => selected }), Attachment_ObjectInfo: { fd_compare_file: { fileList: files } },
    Com_Parameter: { event: { submit: { push(callback) { submit = callback; } } } }, alert: message => messages.push(message)
  });
  return { result: submit(), messages };
}
const review = { externalAgentReviewed: true, reviewerName: "route-test", checkedAt: "2026-10-17T00:00:00.000Z" };

describe("conditional attachment source derivation Route-validation", { concurrency: false }, () => {
  it("proves the complete source filter, checked-radio condition, failure branch and original gate", () => {
    const { source, form } = inputs();
    const model = analyzeConditionalAttachmentRequirement(source, form);
    assert.equal(model.fieldId, "fd_compare_file");
    assert.equal(model.conditionFieldId, "fd_quote");
    assert.equal(model.conditionValue, "是");
    assert.equal(model.comparisonOperator, "==");
    assert.equal(model.message, "请上传比价文件!");
    assert.equal(model.baselineRequired, false);
    assert.equal(model.displayGate, "xform:editShow");
    assert.deepEqual(model.runWhen, { viewStatusIn: ["add", "edit"] });
    assert.match(model.sourceSha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(model.sourceRanges[0].sourceRef, source.sourceRef);
  });

  it("renders one source-bound synchronous submit without changing required, visibility or comparison", () => {
    const { source, form } = inputs();
    const before = clone({ source, form });
    const [action, ...others] = conditionalAttachmentRequirementCandidates(source, form);
    assert.deepEqual(others, []);
    assert.equal(action.id, `${source.id}.event.1`);
    assert.equal(action.event, "onBeforeSubmit");
    assert.equal(action.translationStatus, "mapped");
    assert.equal(action.functionMappings[0].basis, "deterministic-conditional-attachment-submit");
    assert.deepEqual(action.runWhen, { viewStatusIn: ["add", "edit"] });
    assert.match(action.function, /getValue\("fd_quote"\)/);
    assert.match(action.function, /getValue\("fd_compare_file"\)/);
    assert.doesNotMatch(action.function, /setFieldAttr|setValue|String\(/);
    assert.deepEqual({ source, form }, before);
    assert.equal(vm.runInNewContext(`${action.function}\nonBeforeSubmit({isDraft:true});`), true);
  });

  it("executes nine captured native functions with verified excerpt hashes and main-field storage fallbacks", () => {
    assert.equal(native.runtimeSha256, "a3ee70fad7030bd66884aa39a2e28e59d3472671b0d633acd0fb05d4d48c91ba");
    assert.deepEqual(Object.keys(native.parts).sort(), ["api", "attached", "business", "config", "configs", "detached", "getter", "main", "requiredTransform"].sort());
    for (const part of Object.values(native.parts)) {
      assert.equal(part.source.length, part.end - part.start);
      assert.equal(createHash("sha256").update(part.source).digest("hex"), part.sha256);
    }
    const { source, form } = inputs();
    const [action] = conditionalAttachmentRequirementCandidates(source, form);
    const values = [undefined, null, "", "legacy-binding-id", [], [{ fdBindType: "DELETE" }], [{ fdBindType: "ADD" }],
      [{ fdBindType: "DELETE" }, { fdBindType: "ADD" }],
      { mechanismKey: "sys-attach", mechanismValue: [] },
      { mechanismKey: "sys-attach", mechanismValue: [{ fdBindType: "DELETE" }] },
      { mechanismKey: "sys-attach", mechanismValue: [{ fdBindType: "ADD" }] },
      { mechanismKey: "sys-attach", mechanismValue: "legacy-binding-id" }];
    for (const files of values) for (const status of ["edit", "readOnly", "hidden"]) for (const storage of ["fields", "attached", "config"]) {
      const { result, messages, form: targetForm } = targetSubmit(action, "是", files, status, storage);
      const read = nativeFns.api("fd_compare_file", { form: targetForm });
      if (typeof files === "string") assert.equal(read, undefined);
      const normalized = nativeFns.requiredTransform(files);
      const count = Array.isArray(normalized) ? normalized.length : 0;
      assert.equal(result, count > 0, `${status}/${storage}/${JSON.stringify(files)}`);
      assert.deepEqual(messages, count ? [] : ["请上传比价文件!"]);
    }
  });

  it("matches source boolean and alert outcomes for inactive/active files and scalar/array radio values", () => {
    const { source, form } = inputs();
    const [action] = conditionalAttachmentRequirementCandidates(source, form);
    for (const value of ["是", "否", undefined]) for (const files of [[], [{ fileStatus: -1 }], [{ fileStatus: 0 }], [{ fileStatus: -1 }, { fileStatus: 0 }]]) {
      const expected = sourceSubmit(source, value, files);
      const bindings = files.map(file => ({ fdBindType: file.fileStatus === -1 ? "DELETE" : "ADD" }));
      for (const selected of [value, value === undefined ? [] : [value]]) {
        const actual = targetSubmit(action, selected, bindings, "hidden", "config");
        assert.equal(actual.result, expected.result);
        assert.deepEqual(actual.messages, expected.messages);
      }
    }
  });

  it("preserves ==/===, baseline field attributes, and rejects unknown outer attachment values", () => {
    const { source, form } = inputs();
    const numericForm = clone(form);
    numericForm.fields.find(field => field.id === "fd_quote").props.options = [{ label: "1", value: "1" }];
    const numeric = { ...source, javascript: source.javascript.replace("currentVal=='是'", "currentVal=='1'") };
    const [loose] = conditionalAttachmentRequirementCandidates(numeric, numericForm);
    const [strict] = conditionalAttachmentRequirementCandidates({ ...numeric, javascript: numeric.javascript.replace("currentVal=='1'", "currentVal==='1'") }, numericForm);
    assert.equal(targetSubmit(loose, 1, []).result, false);
    assert.equal(targetSubmit(strict, 1, []).result, true);
    assert.equal(targetSubmit(strict, "1", []).result, false);
    const requiredForm = clone(form);
    requiredForm.fields.find(field => field.id === "fd_compare_file").props.required = true;
    const [required] = conditionalAttachmentRequirementCandidates(source, requiredForm);
    assert.equal(required.semanticHints.conditionalAttachmentRequirement.baselineRequired, true);
    assert.equal(required.function, conditionalAttachmentRequirementCandidates(source, form)[0].function);
    for (const files of [{}, { fdBindType: "ADD" }, { mechanismKey: "sys-attach", mechanismValue: {} }]) {
      assert.equal(targetSubmit(required, "是", files).result, false);
    }
  });

  it("keeps reversed conditions, side effects, multiple attachments and non-pure guards unresolved", () => {
    const { source, form } = inputs();
    const mutations = [
      text => text.replace("currentVal=='是'", "currentVal!='是'"),
      text => text.replace("currentVal=='是'&&", "currentVal=='是'||"),
      text => text.replace("att2.length==0", "att2.length!=0"),
      text => text.replace("return true;", "notifyExternal(); return true;"),
      text => text.replace("var att2=[];", 'var other=Attachment_ObjectInfo["fd_other"].fileList; var att2=[];'),
      text => text.replace("alert(\"请上传比价文件!\")", "alert(buildMessage())"),
      text => text.replace("fileStatus!=-1", "fileStatus==-1"),
      text => text.replace("arr.push((obj[i]));", "arr.push((obj[i])); notifyExternal();"),
      text => text.replace("function removeDeletion(arr,obj)", "function removeDeletion(arr,arr)"),
      text => text.replaceAll("removeDeletion", "alert"),
      text => text.replace("submit.push(function()", "submit.push(function alert()"),
      text => text.replace(":checked", ""),
      text => text.replace("return true;", "return false;")
    ];
    for (const mutate of mutations) assert.equal(analyzeConditionalAttachmentRequirement({ ...source, javascript: mutate(source.javascript) }, form), undefined);
    assert.equal(analyzeConditionalAttachmentRequirement({ ...source, displayGate: "xform:viewShow" }, form), undefined);
    const wrongForm = clone(form);
    wrongForm.fields.find(field => field.id === "fd_quote").type = "checkbox";
    assert.equal(analyzeConditionalAttachmentRequirement(source, wrongForm), undefined);
  });

  it("rejects cross-source helper redefinition and platform-global writes while allowing unrelated locals", () => {
    const { source, form } = inputs();
    const withOther = javascript => ({ sources: [source, { id: "other", sourceRef: "source.other", javascript }] });
    for (const text of [
      "function removeDeletion(arr,obj) { arr.push(obj[0]); }",
      "removeDeletion = function() {};",
      "var alert = function() {};",
      'Attachment_ObjectInfo.fd_compare_file = {fileList: []};',
      "Com_Parameter.event.submit = [];",
      "window.$ = function() {};",
      'delete globalThis["alert"];'
    ]) assert.deepEqual(conditionalAttachmentRequirementCandidates(source, form, withOther(text)), []);
    assert.equal(conditionalAttachmentRequirementCandidates(source, form,
      withOther("function unrelated(alert) { alert = 1; }" )).length, 1);
  });

  it("runs the complete XML route through trust, native API readback and one migration receipt", async () => withNetworkGuard(async () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    assert.equal(checkDraft(draft).ok, true, JSON.stringify(checkDraft(draft).diagnostics));
    assert.deepEqual(draft.scripts.actions.map(action => action.translationStatus), ["mapped"]);
    assert.equal(draft.scripts.actions[0].event, "onBeforeSubmit");
    const trusted = createTrustedMigrationDsl(source, draft, review);
    const trust = checkTrust(source, trusted);
    assert.equal(trust.ok, true, JSON.stringify(trust.diagnostics));
    const client = new FakeNewoaAdapter("persist");
    const result = await executeDsl(trusted, {
      client, baseUrl: "https://p-sit.onewo.com", confirmWrite: true, targetCategoryId: "fixture-category",
      credentials: { username: "fixture-user", encryptedPassword: "fixture-password" },
      now: new Date("2026-10-17T00:00:00.000Z"), transferRecordIdFactory: () => "fixture-conditional-attachment-record"
    });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.readback.ok, true);
    assert.equal(result.readback.status, "verified");
    assert.equal(result.readback.form.scripts.persistedActionCount, 1);
    assert.equal(result.transferRecord.status, "recorded");
    assert.equal(client.transcript().filter(entry => entry.operation === "add-transfer-record").length, 1);
    assert.deepEqual(result.readback.form.scripts.actions[0].runWhen, { viewStatusIn: ["add", "edit"] });
  }));

  it("rejects changed functions/proofs and coherent source-unbound condition or gate forgeries", () => {
    const source = cleanSourceFile(fixture);
    const original = draftSourceDraft(source);
    const changedBody = clone(original);
    changedBody.scripts.actions[0].function = changedBody.scripts.actions[0].function.replace('selected == "是"', 'selected == "否"');
    assert.equal(checkDraft(changedBody).ok, false);
    for (const mutate of [
      draft => { draft.scripts.actions[0].function = draft.scripts.actions[0].function.replace('selected == "是"', 'selected == "否"'); },
      draft => { delete draft.scripts.actions[0].runWhen; },
      draft => { draft.scripts.actions[0].function = draft.scripts.actions[0].function.replace('file.fdBindType !== "DELETE"', 'file.fdBindType === "DELETE"'); },
      draft => { draft.scripts.actions[0].translationStatus = "omitted"; draft.scripts.actions[0].function = ""; }
    ]) {
      const draft = clone(original);
      mutate(draft);
      const action = draft.scripts.actions[0];
      action.deterministicBranchProof = buildDeterministicScriptBranchProof(action);
      const trusted = createTrustedMigrationDsl(source, draft, review);
      assert.equal(checkTrust(source, trusted).ok, false, "Self-consistent DSL cannot replace source-derived proof.");
    }
  });
});
