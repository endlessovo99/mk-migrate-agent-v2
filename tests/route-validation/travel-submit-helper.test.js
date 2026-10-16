import assert from "node:assert/strict";
import vm from "node:vm";
import { describe, it } from "node:test";
import { parse } from "acorn";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { createTrustedMigrationDsl, checkTrust } from "../../src/dsl/trust.js";
import { checkDraft, checkExecute } from "../../src/dsl/checks.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { getTravelReimbursementLifecycleModel } from "../../src/translator/travel-reimbursement-lifecycle-model.js";

const FIXTURE = "tests/fixtures/route-validation/travel-reimbursement-lifecycle/route-travel-reimbursement-lifecycle_SysFormTemplate.xml";
const SUBMIT_BASIS = "deterministic-travel-reimbursement-submit-calculation";
const LIFECYCLE_ID = "fd_3cc17629476baa.script.2";
let baseline;

function artifacts() {
  if (!baseline) {
    const source = cleanSourceFile(FIXTURE);
    baseline = { source, draft: draftSourceDraft(source) };
  }
  return structuredClone(baseline);
}
function helper(source) {
  return source.scripts.sources.find((entry) => entry.javascript.includes("function _DocList_FormFieldValue"));
}
function replaceText(entry, from, to) {
  assert.ok(entry.javascript.includes(from), from);
  entry.javascript = entry.javascript.replace(from, to);
}
function candidate(source, draft = draftSourceDraft(source)) {
  return createTrustedMigrationDsl(source, draft, {
    externalAgentReviewed: true,
    reviewerName: "synthetic-offline-helper-regression"
  });
}
function submit(draft) {
  return draft.scripts.actions.find((action) =>
    action.functionMappings.some((mapping) => mapping.basis === SUBMIT_BASIS)
  );
}
function rejectHelper(source, label) {
  const draft = draftSourceDraft(source);
  assert.equal(submit(draft), undefined, label);
  assert.equal(checkTrust(source, candidate(source, draft)).ok, false, label);
}

const HELPER_MUTATIONS = [
  ["missing helper", (source) => { source.scripts.sources = source.scripts.sources.filter((entry) => entry !== helper(source)); }],
  ["unfiltered list", (source) => replaceText(helper(source), "if (rowFieldValue) {", "if (true) {")],
  ["unrelated constant array", (source) => replaceText(helper(source), "return fieldValue;", 'return ["short"];')],
  ["non-array return", (source) => replaceText(helper(source), "return fieldValue;", "return {values: fieldValue};")],
  ["wrong field builder", (source) => replaceText(helper(source), ".!{index}.", ".!{wrong}.")],
  ["wrong getter argument", (source) => replaceText(helper(source), "getFormFieldValue(rowFieldId, 'table')", "getFormFieldValue(tbId, 'table')")],
  ["changed lastIndex bound", (source) => replaceText(helper(source), "i < tbInfo.lastIndex - 1", "i <= tbInfo.lastIndex - 1")],
  ["reverse loop", (source) => replaceText(helper(source), "i++", "i--")],
  ["helper side effect", (source) => replaceText(helper(source), "return fieldValue;", 'SetXFormFieldValueById("extra", 1); return fieldValue;')],
  ["late conflicting getter", (source) => { helper(source).javascript += "\nfunction getFormFieldValue(a,b,c) { return 'wrong'; }"; }],
  ["helper assignment", (source) => { helper(source).javascript += "\n_DocList_FormFieldValue = function() { return []; };"; }],
  ["indirect property writer", (source) => { helper(source).javascript += '\nvar define = Object.defineProperty; define(window, "_DocList_FormFieldValue", {value: function() { return []; }});'; }],
  ["computed global override", (source) => { helper(source).javascript += '\nwindow[helperName] = function() { return []; };'; }],
  ["local shadow", (source) => replaceText(source.scripts.sources.find((entry) => entry.id === LIFECYCLE_ID), "var getPayeeTableId", "var _DocList_FormFieldValue = function() { return []; }; var getPayeeTableId")],
  ["cross-script conflicting definition", (source) => { source.scripts.sources.push({ ...helper(source), id: "route-conflict.script.1", sourceRef: "source.form.jsp.route-conflict.script.1" }); }],
  ["helper only in view", (source) => { helper(source).displayGate = "xform:viewShow"; }],
  ["unknown gate", (source) => { helper(source).displayGate = "xform:unknownShow"; }],
  ["duplicate source ID", (source) => { source.scripts.sources.push({ ...helper(source), sourceRef: "source.form.jsp.route-duplicate.script.1" }); }],
  ["duplicate source reference", (source) => { source.scripts.sources.push({ ...helper(source), id: "route-duplicate.script.1" }); }],
  ["wrong table binding", (source) => replaceText(source.scripts.sources.find((entry) => entry.id === LIFECYCLE_ID), 'var getPayeeTableId = "fd_payee_list"', 'var getPayeeTableId = "fd_project_num_list"')],
  ["wrong column binding", (source) => replaceText(source.scripts.sources.find((entry) => entry.id === LIFECYCLE_ID), '_DocList_FormFieldValue(getPayeeTableId, "fd_card_number")', '_DocList_FormFieldValue(getPayeeTableId, "fd_bseg_projk")')],
  ["list reassignment", (source) => replaceText(source.scripts.sources.find((entry) => entry.id === LIFECYCLE_ID), 'errorFlag = false;\n      var payeeMsg', 'tempPayeeList = ["replacement"]; errorFlag = false;\n      var payeeMsg')],
  ["list mutation", (source) => replaceText(source.scripts.sources.find((entry) => entry.id === LIFECYCLE_ID), 'errorFlag = false;\n      var payeeMsg', 'tempPayeeList.reverse(); errorFlag = false;\n      var payeeMsg')]
];

describe("travel submit source helper Route contract", { concurrency: false }, () => {
  it("proves the last hoisted getter and binds helper ranges through public validation", () => {
    const { source, draft } = artifacts();
    const trusted = candidate(source, draft);
    assert.equal(checkDraft(draft).ok, true);
    assert.equal(checkTrust(source, trusted).ok, true);
    assert.equal(checkExecute(trusted).ok, true);
    assert.equal(buildDryRunPlan(trusted).ok, true);
    const action = submit(draft);
    const helperSource = helper(source);
    assert.ok(action.sourceRefs.includes(helperSource.sourceRef));
    const ranges = action.semanticHints.coveredCalculationRanges.filter((range) => range.sourceRef === helperSource.sourceRef);
    assert.deepEqual(ranges.map((range) => range.name).sort(), ["_DocList_FormFieldValue", "buildDetailTableFieldId", "getFormFieldValue"].sort());
    const getter = ranges.find((range) => range.name === "getFormFieldValue");
    assert.match(helperSource.javascript.slice(getter.start, getter.end), /elementId, type, containSelectText/);
    assert.ok(getter.start > helperSource.javascript.indexOf("function getFormFieldValue"));
  });

  for (const [label, mutate] of HELPER_MUTATIONS) {
    it(`keeps ${label} outside deterministic trust`, () => {
      const { source } = artifacts();
      mutate(source);
      rejectHelper(source, label);
    });
  }

  it("does not let stale deterministic proofs or cleared review coverage wash out fixed-source helper failures", () => {
    const { source, draft } = artifacts();
    replaceText(helper(source), "return fieldValue;", 'return ["short"];');
    assert.equal(checkTrust(source, candidate(source, draft)).ok, false);
    const unsupported = draftSourceDraft(source);
    const action = unsupported.scripts.actions.find((entry) => entry.event === "onBeforeSubmit");
    assert.ok(action);
    action.translationStatus = "mapped";
    action.coverage = { status: "translated", nativeRules: [], residuals: [] };
    action.function = "function onBeforeSubmit() { return true; }";
    assert.equal(checkTrust(source, candidate(source, unsupported)).ok, false);
    action.translationStatus = "omitted";
    action.coverage.status = "omitted";
    assert.equal(checkTrust(source, candidate(source, unsupported)).ok, false);
    unsupported.scripts.actions = unsupported.scripts.actions.filter((entry) => entry !== action);
    assert.equal(checkTrust(source, candidate(source, unsupported)).ok, false);
  });

  it("invalidates cached qualification for detail identity, type, source evidence, and helper changes", () => {
    const { source, draft } = artifacts();
    const get = () => getTravelReimbursementLifecycleModel(source.scripts, draft.form, draft.formRules);
    const original = get();
    assert.ok(original);
    assert.equal(get(), original);
    const table = draft.form.fields.find((field) => field.id === "fd_payee_list");
    const column = table.columns.find((field) => field.id === "fd_card_number");
    for (const [holder, key, value] of [
      [column, "type", "number"],
      [column, "componentId", "xform-number"],
      [column, "sourceRef", "source.form.detailTable.other.column.fd_card_number"],
      [column.sourceProps.designerValues, "tableName", "wrong-table"],
      [column.sourceProps.designerValues, "dataType", "Double"],
      [column.sourceProps.metadataAttributes, "type", "Double"]
    ]) {
      const previous = holder[key]; holder[key] = value;
      assert.equal(get(), undefined, key);
      holder[key] = previous;
      assert.ok(get(), key);
    }
    const project = draft.form.fields.find((field) => field.id === "fd_project_num_list");
    table.columns.splice(table.columns.indexOf(column), 1); project.columns.push(column);
    assert.equal(get(), undefined, "wrong table ownership");
    project.columns.pop(); table.columns.push(column);
    assert.ok(get());
    const current = get();
    draft.form.fields.find((field) => field.id === "fd_voucher_no").title = "Unrelated label";
    assert.equal(get(), current, "unrelated main field does not invalidate model");
    replaceText(helper(source), "if (rowFieldValue) {", "if (true) {");
    assert.equal(get(), undefined, "helper in-place mutation");
  });

  it("filters card values independently and preserves filtered indices and early-return order", () => {
    for (const values of [[], [""], [null], [undefined], ["", "123456789012345"], ["123456789012345", ""], ["", "1234567890123456", "short"], ["1234567890123456789"], ["0"], ["false"], [" "]]) {
      const rows = values.map((value) => ({ fd_card_number: value, fd_payee_amount: 0 }));
      const source = runSubmit(rows, [], false, true);
      const target = runSubmit(rows, [], false, false);
      assert.deepEqual(target, source, JSON.stringify(values));
      if (!target.result) assert.deepEqual(target.sets, [], "card failure precedes amount/save writes");
    }
  });

  it("uses the same truthy text contract for WBS with its own filtered indices", () => {
    for (const values of [[], [""], [null], ["", "BAD"], ["ROUTE-WBS-001", "BAD"], ["", "ROUTE-WBS-001", "BAD"], [" "]]) {
      const project = values.map((value) => ({ fd_bseg_projk: value }));
      assert.deepEqual(runSubmit([], project, true, false), runSubmit([], project, true, true), JSON.stringify(values));
    }
  });

  it("keeps all original amount rows and does not erase out-of-domain numeric or boolean card values", () => {
    const rows = [{ fd_card_number: "", fd_payee_amount: 5 }, { fd_card_number: "1234567890123456", fd_payee_amount: 7 }];
    const source = runSubmit(rows, [], false, true, 12);
    const target = runSubmit(rows, [], false, false, 12);
    assert.deepEqual(target, source);
    assert.deepEqual(target.sets, [["fd_payee_total", 12], ["fd_payee_diff", 0], ["fd_flag_save_no", 2222]]);
    for (const value of [0, false]) {
      const result = runSubmit([{ fd_card_number: value, fd_payee_amount: 0 }], [], false, false);
      assert.equal(result.result, false, "unexpected target type remains visible to validation");
    }
  });
});

function runSubmit(payeeRows, projectRows, projectFlag, legacy, total = 0) {
  const { source, draft } = artifacts();
  const lifecycle = source.scripts.sources.find((entry) => entry.id === LIFECYCLE_ID);
  const registration = parse(lifecycle.javascript, { ecmaVersion: "latest" }).body.find((node) =>
    node.type === "ExpressionStatement" && node.expression?.callee?.property?.name === "push"
  );
  const callback = registration.expression.arguments[0];
  const callbackText = lifecycle.javascript.slice(callback.start, callback.end);
  const sets = [], alerts = [];
  const env = {
    commonWBSStr: "ROUTE-WBS-001|ROUTE-WBS-002", theFinanceFlag: 1,
    theConstFiaSaveFlag: 2222, theFlagNo: 0,
    DocList_TableInfo: { TABLE_DL_fd_payee_list: { lastIndex: payeeRows.length + 1 }, TABLE_DL_fd_project_num_list: { lastIndex: projectRows.length + 1 } },
    GetXFormFieldById: () => [{ value: projectFlag ? "1" : "0" }],
    GetXFormFieldValueById: () => [],
    SetXFormFieldValueById: (...args) => sets.push(args),
    alert: (message) => alerts.push(message),
    MKXFORM: {
      getValue: (id) => id.includes("fd_payee_list") ? payeeRows : id.includes("fd_project_num_list") ? projectRows : id === "fd_is_project" ? (projectFlag ? "1" : "0") : total,
      setValue: (...args) => sets.push(args), toast: (message) => alerts.push(message)
    },
    $: (selector) => {
      if (selector.includes("fd_payee_diff")) return { val: () => sets.find((entry) => entry[0] === "fd_payee_diff")?.[1] ?? 0 };
      const match = selector.match(/(fd_payee_list|fd_project_num_list)\.(\d+)\.(\w+)/);
      const row = match && (match[1] === "fd_payee_list" ? payeeRows : projectRows)[Number(match[2])];
      const value = row?.[match?.[3]];
      return { 0: { type: "text", tagName: "INPUT" }, length: value === undefined ? 0 : 1, val: () => value };
    },
    payeeListSum: () => {
      let sum = 0;
      for (const row of payeeRows) sum = Math.round((sum + Number(row.fd_payee_amount || 0)) * 100) / 100;
      sets.push(["fd_payee_total", sum], ["fd_payee_diff", sum - total]);
    }
  };
  const text = legacy ? helper(source).javascript + "\n(" + callbackText + ")()" : "(" + submit(draft).function + ")({})";
  const result = vm.runInNewContext(text, env, { timeout: 200 });
  const errorRows = alerts.map((message) => {
    const match = message.match(/rows: ,([\d,]+)/) || message.match(/第([\d、]+)行/);
    assert.ok(match, message);
    return match[1].split(/[,、]/).map(Number);
  });
  return { result, errorRows, sets };
}
