import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { literalArrayRowLifecycleCandidates } from "../../src/translator/literal-array-row-lifecycle.js";
import { form, helperLifecycle, source } from "../helpers/literal-array-row/fixtures.js";

function result(javascript, { sameRef = false } = {}) {
  const original = source(helperLifecycle);
  const other = { id: "other.script.1", sourceRef: sameRef ? original.sourceRef : "source.form.jsp.other.script.1", javascript };
  return literalArrayRowLifecycleCandidates(original, form, { sources: [original, other] });
}

describe("literal-array row lifecycle cross-source binding guard", () => {
  it("retains unrelated local scopes and independent authored sources", () => {
    for (const text of [
      'var unrelated="value";',
      'function unrelated(){var synchronizeRows="local";return synchronizeRows;}',
      'function unrelated(Array){return Array;}'
    ]) assert.equal(result(text).length, 2, text);
  });
  for (const [name, text, options] of [
    ["duplicate helper", 'function synchronizeRows(){}'],
    ["global helper assignment", 'synchronizeRows=function(){};'],
    ["platform getter replacement", 'GetXFormFieldById=function(){};'],
    ["window helper replacement", 'window.synchronizeRows=function(){};'],
    ["computed global replacement", 'globalThis["Array"]=replacement;'],
    ["prototype mutation", 'Array.prototype.indexOf=function(){return 0;};'],
    ["alias of global scope", 'var scope=window;scope.synchronizeRows=function(){};'],
    ["alias of prototype", 'var prototype=Array.prototype;prototype.indexOf=function(){return 0;};'],
    ["defineProperty mutation", 'Object.defineProperty(window,"synchronizeRows",{value:function(){}});'],
    ["Object.assign mutation", 'Object.assign(window,{synchronizeRows:function(){}});'],
    ["Reflect mutation", 'Reflect.set(globalThis,"Array",replacement);'],
    ["Function constructor", 'new Function("window.synchronizeRows=function(){}")();'],
    ["duplicate ref hides conflicting source", 'function synchronizeRows(){}', { sameRef: true }]
  ]) it("rejects " + name, () => assert.equal(result(text, options).length, 0, text));
});
