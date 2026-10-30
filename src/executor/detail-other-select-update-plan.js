import assert from "node:assert/strict";
import { parse } from "acorn";
import { sha256Digest } from "../agent-review/digest.js";
import { sourceRequiresReadOnly } from "../dsl/source-readonly.js";
import { buildGlobalDispatcher } from "./persistence/form-writer.js";
import { markedDispatcherActionFunction } from "./persistence/script-dispatcher-contract.js";
import { detailOtherSelectAction } from "./persistence/detail-other-select-reveal.js";

const unsafeCode = /\b(?:document|window|globalThis|self|top|parent|frames|Function|constructor|__proto__|parentNode|innerHTML)\b|\beval\s*\(|\bMKXFORM\s*\.\s*(?:setValue|setProps|setFieldAttr|setDetailField|setDetailValues|updateControl|addRow|deleteRow)\s*\(/;
const allowedNative = new Set(["getValue", "setValue", "setFieldAttr", "updateControl", "updateControlStyle", "setDetailFieldItemAttr"]);

/** Pure existing-target preview; this is neither migration trust nor write authority. */
export function prepareDetailOtherSelectConfig({ source, config, pairs }) {
  assert.equal(source?.artifact, "source-draft");
  assert.ok(Array.isArray(pairs) && pairs.length && new Set(pairs.map(p => `${p.tableId}.${p.textId}`)).size === pairs.length);
  const allFields = (config.dataModel || []).flatMap(model => [model.fdTableName, ...(model.fdFields || []).map(field => field.fdName)]).filter(Boolean);
  const modelTables = new Set((config.dataModel || []).map(model => model.fdTableName).filter(Boolean));
  const evidence = [];
  for (const pair of pairs) {
    assert.deepEqual(Object.keys(pair).sort(), ["choiceId", "optionValue", "tableId", "textId"]);
    const table = unique((source.form?.detailTables || []).filter(item => item.id === pair.tableId));
    const choice = unique((table.columns || []).filter(item => item.id === pair.choiceId));
    const note = unique((table.columns || []).filter(item => item.id === pair.textId));
    const relation = choice.sourceProps?.otherTextCompanion;
    assert.ok(choice.sourceType === "singleSelect" && note.sourceType === "text" && relation?.id === note.id &&
      relation.optionValue === pair.optionValue && relation.otherRequired !== true && note.required !== true &&
      note.sourceProps?.hardHidden !== true && !sourceRequiresReadOnly(note), "source detail pair is not independently optional and bound");
    assert.equal((choice.options || []).filter(option => option.value === pair.optionValue).length, 1, "source Other code is ambiguous");
    assert.ok((choice.options || []).every(option => option.value !== "other_"), "source choice collides with native composite Other storage");
    const sourceTexts = [...(source.scripts?.sources || []).flatMap(item => [item.javascript, item.helperJavascript]),
      ...(source.scripts?.fragments || []).map(item => item.content)].filter(item => typeof item === "string");
    assert.ok(sourceTexts.every(text => !text.includes(note.id)), "source scripts address the detail explanation");
    const model = unique((config.dataModel || []).filter(item => item.fdType === "detail" && item.fdTableName === pair.tableId));
    for (const [field, kind] of [[choice, "select"], [note, "input"]]) {
      const native = unique((model.fdFields || []).filter(item => item.fdName === field.id));
      assert.ok(native.fdIsStored === true && native.fdDataType === "varchar" && native.fdDisplay === true && native.fdIsSystem !== true,
        "detail choice and text must retain independent stored fields");
      const node = JSON.parse(native.fdAttribute || "{}").config;
      assert.ok(node?.kind === "control" && node.type === `@elem/xform-${kind}` && node.controlProps?.name === field.id &&
        node.controlProps?.$$tableType === "detail" && node.controlProps?.$$tableName === pair.tableId &&
        node.controlProps?.desktop?.type === `@elem/xform-${kind}` && node.controlProps?.mobile?.type === `@elem/xform-m-${kind}`,
      "detail native control identity changed");
      if (kind === "select") {
        assert.notEqual(node.controlProps.multi, true);
        assert.ok((node.controlProps.options || []).every(option => option.value !== "other_" && option.type !== "other"), "native composite Other storage is not independent");
        assert.deepEqual((node.controlProps.options || []).map(({ label, value }) => ({ label, value })),
          (choice.options || []).map(({ label, value }) => ({ label, value })), "native detail choice options changed");
      }
    }
    assert.ok(Array.isArray(config.auth) && config.auth.length, "detail field permissions are missing");
    for (const mode of ["add", "edit"]) {
      const permissions = config.auth.flatMap(a => a?.[mode]?.[pair.tableId]?.fields?.[pair.textId] ? [a[mode][pair.tableId].fields[pair.textId]] : []);
      assert.ok(permissions.length && permissions.every(p => p.required === false), "detail explanation has unproved editable permissions");
    }
    evidence.push({ tableSourceRef: table.sourceRef, choiceSourceRef: choice.sourceRef, textSourceRef: note.sourceRef, optionValue: pair.optionValue });
  }
  const next = structuredClone(config), attr = JSON.parse(next.attribute?.formAttr || "{}");
  assert.ok(attr.controlAction && Object.keys(attr).every(key => ["subjectRule", "formRule", "dataUnique", "controlAction", "currentTableName", "migrationDsl"].includes(key)),
    "target contains an unproved action surface");
  assert.ok(!unsafeCode.test(JSON.stringify([attr.subjectRule, attr.formRule, attr.dataUnique])), "target rules contain unproved dynamic behavior");
  auditRuleConditions(attr, new Set(allFields));
  for (const pair of pairs) for (const rule of attr.formRule?.require || []) for (const result of rule.result || []) {
    const names = Array.isArray(result.fieldName) ? result.fieldName : [result.fieldName];
    if (result.type === pair.tableId && (names.includes(pair.textId) || names.includes("all")))
      assert.equal(result.required, "non-required", "target rules may require the detail explanation");
  }
  const global = attr.controlAction.global; assert.ok(global && typeof global === "object");
  const existing = global.onLoad || []; assert.ok(Array.isArray(existing) && existing.length <= 1, "native onLoad dispatcher is ambiguous");
  let actions = [];
  if (existing.length) {
    const dispatcher = existing[0];
    assert.ok(Array.isArray(dispatcher.migrationActions) && dispatcher.migrationActions.length, "native onLoad has no verified dispatcher");
    actions = dispatcher.migrationActions.map(item => ({ ...item,
      function: markedDispatcherActionFunction(dispatcher.function, item.name).replace(/\n  /g, "\n") }));
    assert.ok(actions.every(item => item.function)); assert.deepEqual(buildGlobalDispatcher("onLoad", actions), dispatcher);
  }
  const generated = detailOtherSelectAction(pairs), occupied = actions.filter(action => action.id === generated.id);
  assert.ok(occupied.length <= 1, "detail reveal action identity is ambiguous");
  const desired = buildGlobalDispatcher("onLoad", occupied.length ? [...actions.filter(action => action !== occupied[0]), generated] : [...actions, generated]);
  if (occupied.length) assert.deepEqual(existing[0], desired, "existing detail reveal action differs");
  const audited = structuredClone(attr.controlAction);
  if (occupied.length) {
    const retained = actions.filter(action => action.id !== generated.id);
    audited.global.onLoad = retained.length ? [buildGlobalDispatcher("onLoad", retained)] : [];
  }
  auditActions(audited, pairs, new Set(allFields), modelTables);
  if (!occupied.length) global.onLoad = [desired];
  next.attribute.formAttr = JSON.stringify(attr);
  const protectedConfig = structuredClone(next); protectedConfig.attribute.formAttr = config.attribute.formAttr;
  assert.deepEqual(protectedConfig, config, "detail reveal changed protected configuration");
  return { config: next, changed: sha256Digest(next) !== sha256Digest(config), changes: pairs.map(pair => ({ ...pair })), evidence };
}

function auditRuleConditions(attr, fieldIds) {
  const empty = value => value === undefined || value === null || typeof value === "object" && Object.keys(value).length === 0;
  assert.ok(empty(attr.subjectRule) && empty(attr.dataUnique) && empty(attr.formRule?.pattern) && empty(attr.formRule?.compute),
    "target contains an unproved subject, uniqueness, pattern or calculation rule");
  assert.ok(Object.keys(attr.formRule || {}).every(key => ["pattern", "display", "require", "compute"].includes(key)));
  for (const kind of ["display", "require"]) for (const rule of attr.formRule?.[kind] || []) for (const condition of rule.choices?.items || []) {
    if (condition.condNodeType !== "formula") {
      assert.ok(condition.condNodeType === "condition" && condition.valueType === "fixed", "target rule condition is not bounded");
      continue;
    }
    const script = condition.value?.script, refs = [];
    assert.equal(typeof script, "string");
    if (condition.value?.vo?.content !== undefined) assert.equal(condition.value.vo.content, script);
    const expression = script.replace(/\$\{data\.biz\.([A-Za-z_][A-Za-z0-9_.]*)\}/g, (_all, id) => {
      assert.ok(fieldIds.has(id) || fieldIds.has(id.split(".").at(-1)), "target rule reads an unknown field");
      let index = refs.indexOf(id); if (index < 0) { index = refs.length; refs.push(id); } return `__field_${index}`;
    });
    assert.ok(!expression.includes("${") && refs.length && Array.isArray(condition.value.varIds) &&
      [...new Set(condition.value.varIds)].sort().join("\0") === [...refs].sort().join("\0"), "target rule dependencies are unproved");
    const ast = parse(expression, { ecmaVersion: "latest" });
    assert.equal(ast.body.length, 1); assert.equal(ast.body[0].type, "ExpressionStatement");
    walkAst(ast, (node, parent) => {
      assert.ok(["Program", "ExpressionStatement", "LogicalExpression", "BinaryExpression", "UnaryExpression", "CallExpression", "MemberExpression", "Identifier", "Literal"].includes(node.type), "target rule expression is unproved");
      if (node.type === "LogicalExpression") assert.ok(["&&", "||"].includes(node.operator));
      if (node.type === "BinaryExpression") assert.ok(["==", "!=", "===", "!==", ">", ">=", "<", "<="].includes(node.operator));
      if (node.type === "UnaryExpression") assert.equal(node.operator, "!");
      if (node.type === "Identifier") assert.ok(node.name === "MKXFORM" || /^__field_\d+$/.test(node.name) ||
        parent?.type === "MemberExpression" && parent.property === node && ["viewStatus", "indexOf"].includes(node.name), "target rule identifier is unproved");
      if (node.type === "MemberExpression") assert.ok(!node.computed && node.object?.type === "Identifier" &&
        (node.object.name === "MKXFORM" && node.property?.name === "viewStatus" || /^__field_\d+$/.test(node.object.name) && node.property?.name === "indexOf"), "target rule member is unproved");
      if (node.type === "CallExpression") assert.ok(node.callee?.type === "MemberExpression" && node.callee.property?.name === "indexOf" &&
        /^__field_\d+$/.test(node.callee.object?.name || "") && node.arguments?.length === 1 && node.arguments[0]?.type === "Literal" &&
        typeof node.arguments[0].value === "string", "target rule call is unproved");
    });
  }
}

function auditActions(actions, pairs, fieldIds, modelTables) {
  const texts = []; walkObject(actions, node => { if (Object.hasOwn(node, "function")) { assert.equal(typeof node.function, "string"); texts.push(node.function); } });
  for (const text of texts) {
    assert.ok(pairs.every(pair => !text.includes(pair.textId)), "current target actions address the detail explanation");
    const ast = parse(text, { ecmaVersion: "latest" }), declared = new Set(), variables = new Set();
    walkAst(ast, node => {
      if (node.type === "FunctionDeclaration" && node.id) { assert.ok(!declared.has(node.id.name), "duplicate target function identity"); declared.add(node.id.name); }
      if (node.type === "VariableDeclarator") { assert.equal(node.id?.type, "Identifier", "target action destructures an unproved binding"); variables.add(node.id.name); }
      if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type))
        for (const param of node.params || []) { assert.equal(param.type, "Identifier", "target action has an unproved parameter"); variables.add(param.name); }
    });
    assert.ok(!["MKXFORM", "Array", "String", "Number", "Boolean", "isFinite", "isNaN", "parseInt", "parseFloat"].some(name => variables.has(name) || declared.has(name)), "target action shadows a native dependency");
    validateLocalWrites(ast, declared);
    walkAst(ast, (node, parent) => {
      assert.ok(!["ThisExpression", "NewExpression", "ImportExpression", "WithStatement", "MetaProperty", "TaggedTemplateExpression"].includes(node.type), "target action has an opaque operation");
      if (node.type === "Identifier" && ["document", "window", "globalThis", "self", "top", "parent", "frames", "eval", "Function", "$", "jQuery"].includes(node.name)) throw new Error("target action accesses a global or DOM");
      if (node.type === "Identifier" && node.name === "MKXFORM") assert.ok(parent?.type === "MemberExpression" && parent.object === node && !parent.computed &&
        (allowedNative.has(parent.property?.name) || parent.property?.name === "viewStatus"), "target action aliases native form");
      if (node.type === "MemberExpression") {
        const prop = node.computed ? node.property?.type === "Literal" && node.property.value : node.property?.name;
        assert.ok(!["constructor", "prototype", "__proto__", "parentNode", "ownerDocument", "innerHTML"].includes(prop), "target action accesses an opaque property");
      }
      if (node.type !== "CallExpression") return;
      const callee = node.callee;
      if (["FunctionExpression", "ArrowFunctionExpression"].includes(callee?.type)) return;
      if (callee?.type === "Identifier") { assert.ok(["String", "Number", "Boolean", "isFinite", "isNaN", "parseInt", "parseFloat"].includes(callee.name) || declared.has(callee.name), "target action calls an unproved function"); return; }
      assert.ok(callee?.type === "MemberExpression" && !callee.computed, "target action has a dynamic call");
      const method = callee.property?.name;
      if (callee.object?.type === "Identifier" && callee.object.name === "MKXFORM") {
        assert.ok(allowedNative.has(method)); const first = node.arguments?.[0];
        assert.ok(first?.type === "Literal" && typeof first.value === "string", "target native identity is dynamic");
        const target = first.value.split(".").at(-1); assert.ok(fieldIds.has(first.value) || fieldIds.has(target), "target native identity is unknown");
        if (method === "setFieldAttr" && pairs.some(pair => pair.tableId === first.value))
          assert.ok(node.arguments[1]?.type === "Literal" && [4, 5].includes(node.arguments[1].value), "target changes the entire detail table beyond visibility");
        if (method === "setValue") assert.ok(!modelTables.has(first.value), "target can replace an entire data model");
        if (method === "setDetailFieldItemAttr" && pairs.some(pair => pair.tableId === first.value)) {
          const field = node.arguments?.[3]; assert.ok(field?.type === "Literal" && typeof field.value === "string" &&
            !pairs.some(pair => field.value === `${pair.tableId}.${pair.textId}` || field.value === pair.textId || field.value === "all"),
          "target can change detail explanation permissions");
        }
        return;
      }
      if (callee.object?.type === "Identifier" && callee.object.name === "Array") { assert.equal(method, "isArray"); return; }
      throw new Error("target action calls an unproved object method");
    });
  }
}
function validateLocalWrites(ast, declared) {
  const isFunction = node => ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node?.type);
  function visit(node, local) {
    if (!node || typeof node !== "object") return;
    if (isFunction(node)) {
      local = new Set((node.params || []).filter(param => param.type === "Identifier").map(param => param.name));
      function collect(child) {
        if (!child || typeof child !== "object" || child !== node && isFunction(child)) return;
        if (child.type === "VariableDeclarator" && child.id?.type === "Identifier") local.add(child.id.name);
        for (const value of Object.values(child)) if (value && typeof value === "object") Array.isArray(value) ? value.forEach(collect) : collect(value);
      }
      collect(node.body);
    }
    if (node.type === "AssignmentExpression") assert.ok(node.left?.type === "Identifier" && local?.has(node.left.name) && !declared.has(node.left.name), "target action writes an unproved binding");
    if (node.type === "UpdateExpression") assert.ok(node.argument?.type === "Identifier" && local?.has(node.argument.name), "target action updates an unproved binding");
    for (const value of Object.values(node)) if (value && typeof value === "object") Array.isArray(value) ? value.forEach(child => visit(child, local)) : visit(value, local);
  }
  visit(ast, undefined);
}
function unique(items) { assert.equal(items.length, 1, "source or target detail identity is ambiguous"); return items[0]; }
function walkObject(node, visit) { if (!node || typeof node !== "object") return; if (!Array.isArray(node)) visit(node); for (const value of Object.values(node)) if (value && typeof value === "object") walkObject(value, visit); }
function walkAst(node, visit, parent) { if (!node || typeof node !== "object") return; if (typeof node.type === "string") visit(node, parent); for (const value of Object.values(node)) if (value && typeof value === "object") Array.isArray(value) ? value.forEach(child => walkAst(child, visit, node)) : walkAst(value, visit, node); }
