import { nativeMessageRuntime } from "../helpers/native-message-runtime.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { parseSysFormTemplateXml } from "../../src/translator/sysform-template-adapter.js";
import { detailColumnConsistencyCandidate } from "../../src/translator/detail-column-consistency.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { runRouteCase } from "./run-route-case.js";

const root = "tests/fixtures/route-validation/detail-column-consistency";
const fixture = join(root, "detail-consistency_SysFormTemplate.xml");
const xml = readFileSync(fixture, "utf8");
const display = parseSysFormTemplateXml(xml).fdDisplayJsp;
const javascript = display.match(/<script>([\s\S]*?)<\/script>/)[1];
const basis = "deterministic-procurement-payment-department-consistency";
const mappedGuard = (draft) => draft.scripts.actions.find((action) =>
  action.functionMappings?.some((mapping) => mapping.basis === basis));

describe("detail column consistency Route-validation", () => {
  it("includes empty strings while skipping only missing values", () => {
    const source = cleanSourceFile(fixture);
    const action = mappedGuard(draftSourceDraft(source));
    assert.equal(action.translationStatus, "mapped");
    for (const rows of [[], ["A"], ["A", "A"], ["A", "B"], ["A", ""], ["", "A"],
      ["", ""], [undefined, "A"], ["A", undefined], [null, "A"], ["A", null], [" ", ""], ["", " "], ["0", ""]]) {
      assert.deepEqual(runTarget(action.function, rows), runSource(javascript, rows), JSON.stringify(rows));
    }
    assert.equal(runTarget(action.function, ["A", ""], true).ok, true);
    assert.equal(runSource(javascript, undefined).ok, true);
    assert.equal(runTarget(action.function, undefined).ok, true);
  });

  it("recognizes the same bound helper and locals after renaming", () => {
    const source = cleanSourceFile(join(root, "renamed-valid-helper_SysFormTemplate.xml"));
    assert.equal(mappedGuard(draftSourceDraft(source))?.translationStatus, "mapped");
    const names = { list_check: "consistentValues", tableId: "tableKey", controlId: "columnKey", checkDept: "seen", tab_id: "tableName", tbInfo: "tableInfo", i: "rowIndex", child_id: "fieldName", temp: "current", curr: "valid" };
    const changed = javascript.replace(/\b(list_check|tableId|controlId|checkDept|tab_id|tbInfo|i|child_id|temp|curr)\b/g, (name) => names[name]);
    withScript(changed, (draft) => {
      const action = mappedGuard(draft);
      assert.equal(action?.translationStatus, "mapped");
      assert.equal(runTarget(action.function, ["", "A"]).ok, false);
    });
  });

  it("retains literal table/column/message evidence after business ids change", () => {
    withXml(xml.replaceAll("fd_lines", "other_lines").replaceAll("code", "other_code")
      .replaceAll("Values must agree", "Same category required"), (source) => {
      const action = mappedGuard(draftSourceDraft(source));
      assert.equal(action?.translationStatus, "mapped");
      assert.match(action.function, /table:other_lines/);
      assert.match(action.function, /\["other_code"\]/);
      assert.match(action.function, /Same category required/);
    });
  });

  it("accepts the same helper without diagnostic logging", () => {
    withScript(javascript.replace(/\s*console\.log\([^;]+\);/g, ""), (draft) => {
      assert.equal(mappedGuard(draft)?.translationStatus, "mapped");
    });
  });

  it("keeps the unsupported same-name helper source pending through trust", () => {
    const source = cleanSourceFile(join(root, "same-name-wrong-body_SysFormTemplate.xml"));
    const draft = draftSourceDraft(source);
    assert.equal(mappedGuard(draft), undefined);
    assert.ok(source.scripts.sources.some((script) =>
      script.javascript.includes("function list_check(tableId, controlId) { return true; }")));
    assert.ok(draft.scripts.actions.some((action) => action.translationStatus === "needs_review" &&
      action.function.includes("list_check('fd_lines','code')")));
    const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
    assert.equal(checkTrust(source, trusted).ok, false);
  });

  for (const [name, edit] of [
    ["same name but true-only helper", (text) => text.replace(/function list_check[^]*?(?=Com_Parameter)/, "function list_check(tableId, controlId) { return true; }\n")],
    ["same name but false-only helper", (text) => text.replace(/function list_check[^]*?(?=Com_Parameter)/, "function list_check(tableId, controlId) { return false; }\n")],
    ["missing helper", (text) => text.slice(text.indexOf("Com_Parameter"))],
    ["duplicate helper", (text) => "function list_check(a,b){return true;}\n" + text],
    ["helper reassignment", (text) => text.replace("Com_Parameter", "list_check=function(){return true;};\nCom_Parameter")],
    ["helper alias", (text) => text.replace("var curr=list_check", "var alias=list_check;var curr=alias")],
    ["helper parameter alias", (text) => text.replace("function list_check(tableId, controlId)", "function list_check(tableId, controlId, extra)")],
    ["source excludes empty values", (text) => text.replace("temp!=undefined", 'temp!=undefined && temp!=""')],
    ["source trims values", (text) => text.replace(").val();", ").val().trim();")],
    ["different missing-value comparison", (text) => text.replace("temp!=undefined", "temp!==undefined")],
    ["different value comparison", (text) => text.replace("checkDept.length-1]!=temp", "checkDept.length-1]===temp")],
    ["wrong selector column", (text) => text.replace('i + "." + controlId', 'i + "." + "other"')],
    ["dynamic table argument", (text) => text.replace("list_check('fd_lines','code')", "list_check(tableChoice,'code')")],
    ["starts after first row", (text) => text.replace("var i = 0", "var i = 1")],
    ["different loop bound", (text) => text.replace("i < tbInfo.lastIndex", "i <= tbInfo.lastIndex")],
    ["extra write", (text) => text.replace("var checkDept=[];", 'var checkDept=[];SetXFormFieldValueById("code","changed");')],
    ["extra callback effect", (text) => text.replace("var curr=", "unknownEffect();var curr=")],
    ["another submit registration", (text) => text + "\nCom_Parameter.event.submit.push(function(){return false;});"],
    ["helper-scope global shadow", (text) => text.replace("var checkDept=[];", "var checkDept=[];var DocList_TableInfo={};")],
    ["undefined shadow", (text) => text.replace("var checkDept=[];", "var checkDept=[];var undefined=1;")],
    ["alert shadow", (text) => text.replace("var curr=", "var alert=function(){};var curr=")],
    ["inverted submit result", (text) => text.replace("if(!curr)", "if(curr)")],
    ["different success return", (text) => text.replace(/return true;\s*\}\);$/, "return false;});")],
    ["comment-only fake helper call", () => "// list_check('fd_lines','code')\nCom_Parameter.event.submit.push(function(){return true;});"],
    ["string-only fake helper call", () => `var sample="list_check('fd_lines','code')";Com_Parameter.event.submit.push(function(){return true;});`]
  ]) {
    it(`does not claim deterministic coverage for ${name}`, () => {
      const changed = edit(javascript);
      assert.notEqual(changed, javascript, name);
      withScript(changed, (draft) => assert.equal(mappedGuard(draft), undefined, name));
    });
  }

  for (const [type, attributes] of [
    ["number", 'fd_type="inputText"'],
    ["checkbox", 'fd_type="inputCheckbox"'],
    ["address object", 'fd_type="addressDialog"']
  ]) {
    it(`does not assume a String input contract for ${type}`, () => {
      let changed = xml.replace('fd_type="inputText"', attributes);
      if (type === "number") changed = changed.replace('dataType:"String"', 'dataType:"Double"');
      withXml(changed, (source) => assert.equal(mappedGuard(draftSourceDraft(source)), undefined));
    });
  }

  it("keeps deterministic trust binding and rejects reintroduced empty-value filtering", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const trusted = createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true });
    assert.equal(checkTrust(source, trusted).ok, true);
    const action = mappedGuard(trusted);
    const original = action.function;
    action.function = action.function.replace("value === null)", 'value === null || value === "")');
    assert.notEqual(action.function, original);
    assert.equal(checkTrust(source, trusted).ok, false);
  });

  for (const [name, script] of [
    ["helper definition", "function list_check(tableId,controlId){return false;}"],
    ["helper assignment", "list_check=function(){return false;};"],
    ["window property", "window.list_check=function(){return false;};"],
    ["computed global property", 'globalThis["list_check"]=function(){return false;};'],
    ["top-level this", "this.list_check=function(){return false;};"],
    ["global alias", "var host=window;host.list_check=function(){return false;};"],
    ["assigned global alias", "var host;host=window;host.list_check=function(){return false;};"],
    ["Object.assign", "Object.assign(window,{list_check:function(){return false;}});"],
    ["defineProperty", 'Object.defineProperty(window,"list_check",{value:function(){return false;}});'],
    ["Reflect.set", 'Reflect.set(globalThis,"list_check",function(){return false;});'],
    ["unknown computed property", "window[chosenName]=function(){return false;};"],
    ["eval alias", 'var run=eval;run("list_check=function(){return false;}");'],
    ["selector global definition", "function $(selector){return {val:function(){return 'same';}};}"],
    ["table-info global declaration", "var DocList_TableInfo={};"],
    ["submit global declaration", "var Com_Parameter={event:{submit:[]}};"],
    ["undefined global declaration", "var undefined=1;"],
    ["alert global definition", "function alert(message){throw Error(message);}"],
    ["console global declaration", "var console={log:function(){throw Error('changed');}};"],
    ["nested platform member mutation", "Com_Parameter.event.submit=[];"],
    ["platform-object alias mutation", "var info=DocList_TableInfo;info.TABLE_DL_fd_lines={lastIndex:0};"],
    ["global-alias platform replacement", "var host=window;host.$=function(){return null;};"]
  ]) {
    it(`keeps the guard pending after overlapping sibling ${name}`, () => {
      withSibling(script, "edit", (source) => {
        const draft = draftSourceDraft(source);
        assert.equal(mappedGuard(draft), undefined, name);
        assert.equal(checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true })).ok, false);
      });
    });
  }

  it("checks aliases established by a separate sibling source", () => {
    withSibling("var host=window;</script><script>host.list_check=function(){return false;};", "edit", (source) => {
      assert.equal(mappedGuard(draftSourceDraft(source)), undefined);
    });
  });

  it("treats an ungated sibling definition as overlapping", () => {
    withSibling("function list_check(a,b){return false;}", "all", (source) => {
      assert.equal(mappedGuard(draftSourceDraft(source)), undefined);
    });
  });

  it("requires the original source inside a complete source context", () => {
    const source = cleanSourceFile(fixture), draft = draftSourceDraft(source);
    const script = source.scripts.sources[0];
    assert.equal(detailColumnConsistencyCandidate(script, draft.form), undefined);
    assert.equal(detailColumnConsistencyCandidate(script, draft.form, { sources: [] }), undefined);
    assert.equal(detailColumnConsistencyCandidate(script, draft.form, { sources: [script, script] }), undefined);
  });

  for (const [name, script, gate] of [
    ["disjoint view-only definition", "function list_check(a,b){return false;}", "view"],
    ["same proven helper body", javascript.slice(0, javascript.indexOf("Com_Parameter")), "edit"],
    ["unrelated helper", "function unrelated(a,b){return false;}", "edit"],
    ["nested local helper", "function localScope(){function list_check(a,b){return false;}}", "edit"],
    ["ordinary object member", "var holder={};holder.list_check=function(){return false;};", "edit"],
    ["shadowed window parameter", "function localScope(window){window.list_check=function(){return false;};}", "edit"],
    ["shadowed eval parameter", "function localScope(eval){eval('unrelated');}", "edit"]
  ]) {
    it(`keeps proven source coverage beside ${name}`, () => {
      withSibling(script, gate, (source) => assert.equal(mappedGuard(draftSourceDraft(source))?.translationStatus, "mapped"));
    });
  }

  it("passes the registered review, trust, dry-run and fake executor readback route", async () => {
    const result = await runRouteCase("detail-column-consistency-success");
    assert.equal(result.dsl.trust.executable, true);
    assert.equal(result.dryRun.ok, true);
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.readback.ok, true);
    for (const diagnostics of [result.review.diagnostics, result.dryRun.diagnostics]) {
      assert.deepEqual(diagnostics.map((entry) => entry.code), ["source.function_not_whitelisted"]);
      assert.equal(diagnostics[0].details.functionName, "alert");
      assert.equal(diagnostics[0].level, "warning");
    }
  });
});

function withScript(text, callback) {
  const changedDisplay = display.replace(javascript, text);
  withXml(xml.replace(escape(display), escape(changedDisplay)), (source) => callback(draftSourceDraft(source)));
}

function withSibling(script, gate, callback) {
  const sibling = `<script>${script}</script>`;
  const next = gate === "edit" ? display.replace("</xform:editShow>", `${sibling}</xform:editShow>`)
    : display + (gate === "view" ? `<xform:viewShow>${sibling}</xform:viewShow>` : sibling);
  withXml(xml.replace(escape(display), escape(next)), callback);
}

function withXml(text, callback) {
  const directory = mkdtempSync(join(tmpdir(), "detail-consistency-"));
  try {
    const file = join(directory, "route_SysFormTemplate.xml");
    writeFileSync(file, text);
    return callback(cleanSourceFile(file));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function escape(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function runSource(text, values) {
  const callbacks = [], messages = [];
  const context = vm.createContext({ console: { log() {} },
    DocList_TableInfo: values ? { TABLE_DL_fd_lines: { lastIndex: values.length } } : {},
    Com_Parameter: { event: { submit: callbacks } }, alert: (message) => messages.push(message),
    $: (selector) => ({ val: () => values[Number(selector.match(/fd_lines\.(\d+)\.code/)[1])] })
  });
  vm.runInContext(text, context, { timeout: 1000 });
  return { ok: callbacks[0](), messages };
}

function runTarget(text, values, isDraft = false) {
  const messages = [];
  const context = vm.createContext({ MKXFORM: {
    getValue: (id) => { assert.equal(id, "${table:fd_lines}"); return values?.map((code) => ({ code })); },
    ...nativeMessageRuntime("desktop", message => messages.push(message)).MKXFORM
  } });
  vm.runInContext(text, context, { timeout: 1000 });
  return { ok: context.onBeforeSubmit({ isDraft }), messages };
}
