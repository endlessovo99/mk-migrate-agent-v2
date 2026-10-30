import assert from "node:assert/strict";
import { parse } from "acorn";
import { sha256Digest } from "../agent-review/digest.js";
import { choiceOtherRevealBindings } from "../dsl/choice-other-reveal.js";
import { sourceRequiresReadOnly } from "../dsl/source-readonly.js";
import { draftSourceDraft } from "../translator/dsl-draft.js";

const DANGEROUS = new Set(["document", "window", "globalThis", "self", "top", "parent", "frames", "eval", "Function", "$", "jQuery"]);
const MEMBER_DENY = new Set(["constructor", "prototype", "__proto__", "parentNode", "parentElement", "ownerDocument", "innerHTML", "outerHTML"]);
const NATIVE_METHODS = new Set(["getValue", "setValue", "getFieldAttr", "setFieldAttr", "getFormValues", "updateControl", "updateControlStyle",
  "setDetailFieldItemAttr", "setDetailFieldAttr", "setDetailRowAttr", "setDetailValues", "addRow", "deleteRow", "getRowCount"]);
const DATA_METHODS = new Set(["indexOf", "includes", "split", "substring", "substr", "slice", "toFixed", "join", "map", "filter", "concat", "trim", "replace", "toString", "push", "pop", "forEach"]);
const GLOBAL_CALLS = new Set(["String", "Number", "Boolean", "isFinite", "isNaN", "parseInt", "parseFloat"]);
const MATH = new Set(["abs", "ceil", "floor", "round", "min", "max", "pow", "trunc"]);
const WRITES = new Set(["setValue", "setFieldAttr", "updateControl", "updateControlStyle", "setDetailFieldItemAttr", "setDetailFieldAttr", "setDetailRowAttr", "setDetailValues", "addRow", "deleteRow"]);
const OPAQUE_CODE = /\b(?:document|window|globalThis|Function|eval|constructor|__proto__|parentNode|innerHTML)\b/;

/** Pure current-target proof; it never authorizes a write or changes migration trust. */
export function prepareTargetBoundOtherForm({ source, config, tableName, pairs }) {
  assert.equal(source?.artifact, "source-draft");
  assert.ok(Array.isArray(pairs) && pairs.length && new Set(pairs.map(pair => pair.choiceId)).size === pairs.length);
  const draft = draftSourceDraft(source), form = structuredClone(draft.form), sourceFields = source.form?.controls || [];
  const cells = (source.form?.layout?.rows || []).flatMap(row => row.cells || []), evidence = [];
  for (const pair of pairs) {
    const choice = unique(form.fields.filter(field => field.id === pair.choiceId));
    const text = unique(form.fields.filter(field => field.id === pair.textId));
    const original = unique(sourceFields.filter(field => field.sourceRef === choice.sourceRef));
    const originalText = unique(sourceFields.filter(field => field.sourceRef === text.sourceRef));
    const relation = original.sourceProps?.otherTextCompanion;
    assert.ok(relation && relation.id === originalText.id && relation.optionValue === pair.optionValue &&
      pair.triggerId === choice.id && relation.otherRequired !== true && originalText.required !== true &&
      !sourceRequiresReadOnly(originalText) && originalText.sourceProps?.hardHidden !== true);
    const locations = cells.filter(cell => {
      const ids = (cell.references || []).map(ref => ref.referenceId);
      return ids.includes(original.id) && ids.includes(originalText.id) &&
        (cell.contentFlow?.lines || []).some(line => line.indexOf(original.id) >= 0 && line[line.indexOf(original.id) + 1] === originalText.id);
    });
    assert.equal(locations.length, 1, "source choice and text must share one ordered cell");
    const texts = [...(source.scripts?.sources || []).flatMap(item => [item.javascript, item.helperJavascript]),
      ...(source.scripts?.fragments || []).map(item => item.content)].filter(value => typeof value === "string");
    assert.ok(texts.every(value => !value.includes(originalText.id)), "source scripts address the explanation");
    if (!choice.otherPresentation) choice.otherPresentation = { version: 1, mode: "reveal-on-selection",
      textSourceRef: text.sourceRef, triggerSourceRef: choice.sourceRef, optionValue: pair.optionValue };
    evidence.push({ choiceSourceRef: choice.sourceRef, textSourceRef: text.sourceRef, sourceCellRef: locations[0].sourceRef, optionValue: pair.optionValue });
  }
  assert.deepEqual(choiceOtherRevealBindings(form), pairs, "target repair scope differs from its source-bound pair");
  const native = auditNativeActions(config, tableName, pairs.map(pair => pair.textId));
  return { form, evidence: { sourcePair: evidence, targetActionsDigest: sha256Digest(native) } };
}

function auditNativeActions(config, tableName, noteIds) {
  const models = (config.dataModel || []).filter(model => model.fdType === "main" && model.fdTableName === tableName);
  assert.equal(models.length, 1, "current main model is missing");
  const detailTables = new Set((config.dataModel || []).filter(model => model.fdType === "detail").map(model => model.fdTableName));
  const fieldIds = new Set((config.dataModel || []).flatMap(model => [model.fdTableName, ...(model.fdFields || []).map(field => field.fdName)]).filter(Boolean));
  assert.ok(Array.isArray(config.auth) && config.auth.length, "target field permissions are missing");
  for (const id of noteIds) for (const mode of ["add", "edit"]) {
    const entries = config.auth.flatMap(entry => entry?.[mode]?.[tableName]?.fields?.[id] ? [entry[mode][tableName].fields[id]] : []);
    assert.ok(entries.length && entries.every(entry => entry.required === false), "target explanation must remain optional in editable modes");
  }
  const attribute = JSON.parse(config.attribute?.formAttr || "{}");
  assert.ok(attribute.controlAction && typeof attribute.controlAction === "object", "current target actions are missing");
  assert.ok(Object.keys(attribute).every(key => ["subjectRule", "formRule", "dataUnique", "controlAction", "currentTableName", "migrationDsl"].includes(key)),
    "current target contains an unproved action surface");
  assert.ok(!OPAQUE_CODE.test(JSON.stringify([attribute.subjectRule, attribute.formRule, attribute.dataUnique])), "target rules may access DOM or dynamic code");
  for (const model of config.dataModel || []) for (const field of model.fdFields || [])
    assert.ok(!OPAQUE_CODE.test(String(field.fdAttribute || "")), "target field configuration may access DOM or dynamic code");
  const functions = [];
  function collect(node) {
    if (!node || typeof node !== "object") return;
    if (Object.hasOwn(node, "function")) {
      assert.equal(typeof node.function, "string"); functions.push(node.function);
    }
    for (const value of Object.values(node)) if (value && typeof value === "object") Array.isArray(value) ? value.forEach(collect) : collect(value);
  }
  collect(attribute.controlAction);
  for (const text of functions) {
    assert.ok(noteIds.every(id => !text.includes(id)), "current target actions address the explanation");
    const ast = parse(text, { ecmaVersion: "latest" }), declared = new Set(), parents = new WeakMap(), wholeFormAliases = new Set();
    walk(ast, (node, parent) => {
      if (parent) parents.set(node, parent);
      if (node.type === "FunctionDeclaration" && node.id) declared.add(node.id.name);
      if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && ["FunctionExpression", "ArrowFunctionExpression"].includes(node.init?.type)) declared.add(node.id.name);
      if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init?.type === "LogicalExpression" &&
          node.init.operator === "||" && node.init.left?.type === "CallExpression" &&
          node.init.left.callee?.object?.name === "MKXFORM" && node.init.left.callee?.property?.name === "getFormValues" &&
          node.init.right?.type === "ObjectExpression" && node.init.right.properties.length === 0) wholeFormAliases.add(node.id.name);
    });
    walk(ast, (node, parent) => {
      assert.ok(!["ThisExpression", "NewExpression", "ImportExpression", "WithStatement", "MetaProperty", "TaggedTemplateExpression"].includes(node.type), "target script uses an opaque runtime operation");
      if (node.type === "Identifier" && DANGEROUS.has(node.name)) throw new Error("target script can access global or DOM state");
      if (node.type === "Identifier" && node.name === "MKXFORM") assert.ok(parent?.type === "MemberExpression" && parent.object === node && !parent.computed &&
        (NATIVE_METHODS.has(parent.property?.name) || parent.property?.name === "viewStatus"), "target script aliases or accesses an unproved MKXFORM property");
      if (node.type === "Identifier" && wholeFormAliases.has(node.name) && !(parent?.type === "VariableDeclarator" && parent.id === node)) {
        assert.ok(parent?.type === "MemberExpression" && parent.object === node && parent.computed && parent.property?.type === "Literal" &&
          detailTables.has(parent.property.value) && !(parents.get(parent)?.type === "AssignmentExpression" && parents.get(parent).left === parent),
        "whole-form data may only be read through a fixed detail table");
      }
      if (node.type === "MemberExpression") {
        const property = node.computed ? node.property?.type === "Literal" && node.property.value : node.property?.name;
        assert.ok(!MEMBER_DENY.has(property), "target script accesses a prototype or DOM property");
      }
      if (node.type !== "CallExpression") return;
      const callee = node.callee;
      if (["FunctionExpression", "ArrowFunctionExpression"].includes(callee?.type)) return;
      if (callee?.type === "Identifier") { assert.ok(GLOBAL_CALLS.has(callee.name) || declared.has(callee.name), "target script calls an unproved function"); return; }
      assert.ok(callee?.type === "MemberExpression" && !callee.computed, "target script has a dynamic call");
      const method = callee.property?.name;
      if (callee.object?.type === "Identifier" && callee.object.name === "MKXFORM") {
        assert.ok(NATIVE_METHODS.has(method), "target script uses an unproved native method");
        if (method === "getFormValues") {
          const logical = parents.get(node), declaration = logical && parents.get(logical);
          assert.ok(logical?.type === "LogicalExpression" && logical.left === node && declaration?.type === "VariableDeclarator" &&
            wholeFormAliases.has(declaration.id?.name), "whole-form access must be confined to fixed detail-table reads");
        }
        if (method === "getValue") {
          const first = node.arguments?.[0];
          assert.ok(first?.type === "Literal" && typeof first.value === "string" && first.value !== tableName,
            "target value read must have a fixed field or detail-table identity");
        }
        if (WRITES.has(method)) {
          const first = node.arguments?.[0];
          assert.ok(first?.type === "Literal" && typeof first.value === "string", "target native write has dynamic identity");
          const id = first.value.split(".").at(-1);
          assert.ok(fieldIds.has(first.value) || fieldIds.has(id), "target native write identity is unproved");
          assert.notEqual(first.value, tableName, "target native write may not address the whole main model");
        }
        return;
      }
      if (callee.object?.type === "Identifier" && callee.object.name === "Math") { assert.ok(MATH.has(method)); return; }
      if (callee.object?.type === "Identifier" && callee.object.name === "Array") { assert.equal(method, "isArray"); return; }
      assert.ok(DATA_METHODS.has(method), "target script calls an unproved object method");
    });
  }
  assert.ok(noteIds.every(id => !JSON.stringify(attribute.formRule || {}).includes(id)), "native rules independently address the explanation");
  return { controlAction: attribute.controlAction, formRule: attribute.formRule || {} };
}

function unique(items) { assert.equal(items.length, 1, "source or target field identity is ambiguous"); return items[0]; }
function walk(node, visit, parent) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node, parent);
  for (const value of Object.values(node)) if (value && typeof value === "object") Array.isArray(value) ? value.forEach(child => walk(child, visit, node)) : walk(value, visit, node);
}
