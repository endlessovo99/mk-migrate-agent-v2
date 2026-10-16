import { parse } from "acorn";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";

/**
 * The native row-state recipe represents exactly the hidden/display/required
 * branch pair. Other source effects remain reviewable until a target contract
 * and an equivalent source translation are available.
 */
function detailControlDisplayProof(functionText = "") {
  let ast;
  try { ast = parse(String(functionText), { ecmaVersion: "latest" }); } catch { return undefined; }
  if (ast.body.length !== 1) return undefined;
  const fn = ast.body[0];
  if (fn.type !== "FunctionDeclaration" || fn.async || fn.generator || fn.id?.name !== "controlDisplay" ||
      fn.params.length !== 2 || fn.params[0]?.name !== "value" || fn.params[1]?.name !== "i") return undefined;
  const statements = fn.body.body.filter(node => node.type !== "EmptyStatement");
  if (statements.length !== 2) return undefined;
  const declaration = statements[0], branch = statements[1];
  if (declaration.type !== "VariableDeclaration" || declaration.kind !== "var" || declaration.declarations.length !== 1) return undefined;
  const hidden = declaration.declarations[0];
  if (hidden.id?.type !== "Identifier" || ["document", "value", "i"].includes(hidden.id.name)) return undefined;
  const hiddenField = detailElement(hidden.init);
  const test = branch.test;
  if (!hiddenField || branch.type !== "IfStatement" || !branch.alternate ||
      test?.type !== "BinaryExpression" || !["==", "==="].includes(test.operator) ||
      test.left?.type !== "Identifier" || test.left.name !== "value" ||
      test.right?.type !== "Literal" || typeof test.right.value !== "string" || !test.right.value) return undefined;
  const active = branchEffects(branch.consequent, hidden.id.name, hiddenField, true);
  const inactive = branchEffects(branch.alternate, hidden.id.name, hiddenField, false);
  if (!active || !inactive || active.tableId !== inactive.tableId || active.controlId !== inactive.controlId) return undefined;
  return { hiddenControlId: hiddenField.controlId, targetControlId: active.controlId,
    tableId: active.tableId, matchValue: test.right.value };
}

function detailControlDisplayBindingProof(sourceText, trigger = {}) {
  let ast;
  try { ast = parse(sourceText, { ecmaVersion: "latest" }); } catch { return false; }
  const model = buildJavaScriptBindingModel(sourceText), parents = new WeakMap(), matches = [], declarations = new Map();
  if (!model.ok) return false;
  const visit = (node, parent) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "string") {
      if (parent) parents.set(node, parent);
      if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") declarations.set(node.id.start, node);
      if (node.type === "CallExpression" && member(node.callee, "setAttribute") &&
          node.arguments[0]?.type === "Literal" && node.arguments[0].value === "onclick") matches.push(node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (["start", "end"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(value => visit(value, node));
      else if (child && typeof child === "object") visit(child, node);
    }
  };
  visit(ast);
  const qualified = [];
  let sourceBindings = 0;
  for (const call of matches) {
    const receiver = call.callee.object;
    if (receiver?.type !== "Identifier") continue;
    const owner = model.bindingAtUse(receiver.name, receiver.start);
    const initializer = owner?.declarations.length === 1 ? declarations.get(owner.declarations[0].index) : undefined;
    const field = detailElement(initializer?.init);
    if (!field || field.tableId !== trigger.tableId || field.controlId !== trigger.controlId) continue;
    sourceBindings += 1;
    const statement = parents.get(call), block = parents.get(statement);
    if (statement?.type !== "ExpressionStatement" || block?.type !== "BlockStatement" || block.body.length !== 2 || block.body[1] !== statement) continue;
    const declaration = block.body[0];
    if (declaration.type !== "VariableDeclaration" || declaration.kind !== "var" || declaration.declarations.length !== 1) continue;
    const binding = declaration.declarations[0];
    if (binding.id?.type !== "Identifier" || binding.id.name !== receiver.name) continue;
    if (binding !== initializer) continue;
    if (!owner || owner.ambiguous || owner.declarations.length !== 1 || owner.aliases.size ||
        owner.effects.some(effect => ["write", "mutation"].includes(effect.kind)) ||
        !model.isUnshadowedGlobal("document", binding.init.start)) continue;
    const expression = call.arguments[1];
    const row = expression?.left?.right;
    const rowBinding = row?.type === "Identifier" && row.name === "i" ? model.bindingAtUse("i", row.start) : undefined;
    const lookupRow = binding.init.object.arguments[0].left.right;
    if (call.arguments.length !== 2 || expression?.type !== "BinaryExpression" || expression.operator !== "+" ||
        expression.right?.type !== "Literal" || typeof expression.right.value !== "string" ||
        expression.left?.type !== "BinaryExpression" || expression.left.operator !== "+" ||
        expression.left.left?.type !== "Literal" || typeof expression.left.left.value !== "string" ||
        !rowBinding || rowBinding.ambiguous || rowBinding !== model.bindingAtUse("i", lookupRow.start)) continue;
    let handler;
    try { handler = parse(expression.left.left.value + "__row__" + expression.right.value, { ecmaVersion: "latest" }); }
    catch { continue; }
    const invoked = handler.body[0]?.expression;
    if (handler.body.length !== 1 || handler.body[0].type !== "ExpressionStatement" || invoked?.type !== "CallExpression" ||
        invoked.optional || invoked.callee?.type !== "Identifier" || invoked.callee.name !== "controlDisplay" || invoked.arguments.length !== 2 ||
        !member(invoked.arguments[0], "value") || invoked.arguments[0].object?.type !== "ThisExpression" ||
        invoked.arguments[1]?.type !== "Identifier" || invoked.arguments[1].name !== "__row__") continue;
    const helper = model.bindingAtUse("controlDisplay", call.start);
    if (!helper || helper.ambiguous || helper.scope.kind !== "program" || !helper.kinds.has("function") ||
        helper.effects.some(effect => ["write", "mutation", "escape"].includes(effect.kind))) continue;
    qualified.push(call);
  }
  return sourceBindings === 1 && qualified.length === 1;
}

function isCompleteDetailControlDisplay(functionText = "") {
  return Boolean(detailControlDisplayProof(functionText));
}

function member(node, name) {
  return node?.type === "MemberExpression" && !node.optional &&
    (node.computed ? node.property?.type === "Literal" && node.property.value === name
      : node.property?.type === "Identifier" && node.property.name === name);
}

function detailElement(node) {
  if (node?.type !== "MemberExpression" || !node.computed || node.property?.type !== "Literal" || node.property.value !== 0) return undefined;
  const call = node.object;
  if (call?.type !== "CallExpression" || call.optional || call.arguments.length !== 1 ||
      !member(call.callee, "getElementsByName") || call.callee.object?.type !== "Identifier" || call.callee.object.name !== "document") return undefined;
  const address = call.arguments[0];
  if (address?.type !== "BinaryExpression" || address.operator !== "+" || address.right?.type !== "Literal" ||
      address.left?.type !== "BinaryExpression" || address.left.operator !== "+" ||
      address.left.left?.type !== "Literal" || address.left.right?.type !== "Identifier" || address.left.right.name !== "i") return undefined;
  const prefix = String(address.left.left.value).match(/^extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\.$/);
  const suffix = String(address.right.value).match(/^\.(fd_[A-Za-z0-9_]+)\)$/);
  return prefix && suffix ? { tableId: prefix[1], controlId: suffix[1] } : undefined;
}

function branchEffects(node, hiddenName, hiddenField, active) {
  if (node?.type !== "BlockStatement" || node.body.length !== 3) return undefined;
  const [hidden, display, validate] = node.body.map(statement => statement.type === "ExpressionStatement" ? statement.expression : undefined);
  if (hidden?.type !== "AssignmentExpression" || hidden.operator !== "=" ||
      !member(hidden.left, "value") || hidden.left.object?.type !== "Identifier" || hidden.left.object.name !== hiddenName ||
      hidden.right?.type !== "Literal" || hidden.right.value !== (active ? "true" : "")) return undefined;
  if (display?.type !== "AssignmentExpression" || display.operator !== "=" || !member(display.left, "display") ||
      !member(display.left.object, "style") || display.right?.type !== "Literal" || display.right.value !== (active ? "" : "none")) return undefined;
  const target = detailElement(display.left.object.object);
  if (!target || target.tableId !== hiddenField.tableId || target.controlId === hiddenField.controlId) return undefined;
  if (validate?.type !== "CallExpression" || validate.optional || !member(validate.callee, "setAttribute") ||
      validate.arguments.length !== 2 || validate.arguments[0]?.type !== "Literal" || validate.arguments[0].value !== "validate" ||
      validate.arguments[1]?.type !== "Literal" || validate.arguments[1].value !== (active ? "required" : "")) return undefined;
  const validationTarget = detailElement(validate.callee.object);
  return validationTarget?.tableId === target.tableId && validationTarget.controlId === target.controlId ? target : undefined;
}

function detailMatchValue(functionText = "") {
  return String(functionText || "").match(/if\s*\(\s*value\s*==+\s*(["'])([^"']+)\1\s*\)/)?.[2] || "gh";
}

function physicalTablePlaceholder(tableId) {
  return `\${table:${tableId}}`;
}

function buildDetailRowControlStateFunction(parts = {}) {
  const tableId = String(parts.tableId || parts.trigger?.tableId || "").trim();
  const hiddenControlId = String(parts.hiddenControlId || "").trim();
  const targetControlId = String(parts.targetControlId || parts.target?.controlId || "").trim();
  const matchValue = String(parts.matchValue || detailMatchValue(parts.functionText) || "gh");
  if (!tableId || !hiddenControlId || !targetControlId) return "";
  const table = physicalTablePlaceholder(tableId);
  return [
    "function onChange(value, rowNum, parentRowNum) {",
    "  /* mk-migrate:view-status=add,edit */",
    "  if (MKXFORM.viewStatus != \"add\" && MKXFORM.viewStatus != \"edit\") return;",
    "  var selectedValue = Array.isArray(value) ? value[0] : value",
    `  var active = String(selectedValue) === ${JSON.stringify(matchValue)}`,
    `  MKXFORM.updateControl(${JSON.stringify(`${table}.${hiddenControlId}`)}, rowNum, active ? "true" : "")`,
    `  MKXFORM.updateControlStyle(${JSON.stringify(`${table}.${targetControlId}`)}, rowNum, { display: active ? "block" : "none" })`,
    `  MKXFORM.setDetailFieldItemAttr(${JSON.stringify(table)}, active ? 5 : 4, rowNum, ${JSON.stringify(`${table}.${targetControlId}`)})`,
    `  MKXFORM.setDetailFieldItemAttr(${JSON.stringify(table)}, active ? 3 : 6, rowNum, ${JSON.stringify(`${table}.${targetControlId}`)})`,
    "}"
  ].join("\n");
}

function buildDetailRowLifecycleFunction(parts = {}) {
  const tableId = String(parts.tableId || parts.trigger?.tableId || "").trim();
  const triggerControlId = String(parts.triggerControlId || parts.trigger?.controlId || "").trim();
  const hiddenControlId = String(parts.hiddenControlId || "").trim();
  const targetControlId = String(parts.targetControlId || parts.target?.controlId || "").trim();
  const matchValue = String(parts.matchValue || "gh").trim();
  if (!tableId || !triggerControlId || !hiddenControlId || !targetControlId) return "";
  const table = physicalTablePlaceholder(tableId);
  // Declare as onLoad so DSL schema accepts the action name; form-writer
  // renames to onLoad_1 when composing the global dispatcher.
  return [
    "function onLoad() {",
    `  var rows = MKXFORM.getValue(${JSON.stringify(table)}) || []`,
    "  for (var rowNum = 0; rowNum < rows.length; rowNum += 1) {",
    `    var active = String(rows[rowNum][${JSON.stringify(triggerControlId)}] || "") === ${JSON.stringify(matchValue)} || String(rows[rowNum][${JSON.stringify(hiddenControlId)}] || "") === "true"`,
    `    MKXFORM.updateControl(${JSON.stringify(`${table}.${hiddenControlId}`)}, rowNum, active ? "true" : "")`,
    `    MKXFORM.updateControlStyle(${JSON.stringify(`${table}.${targetControlId}`)}, rowNum, { display: active ? "block" : "none" })`,
    `    MKXFORM.setDetailFieldItemAttr(${JSON.stringify(table)}, active ? 5 : 4, rowNum, ${JSON.stringify(`${table}.${targetControlId}`)})`,
    `    MKXFORM.setDetailFieldItemAttr(${JSON.stringify(table)}, active ? 3 : 6, rowNum, ${JSON.stringify(`${table}.${targetControlId}`)})`,
    "  }",
    "}"
  ].join("\n");
}

function coveredRangesForText(sourceText = "", functionText = "", options = {}) {
  const source = String(sourceText || "");
  const sourceRef = String(options.sourceRef || "").trim();
  const name = String(options.name || "detail_row_control_state").trim() || "detail_row_control_state";
  const fn = String(functionText || "").trim();
  if (!sourceRef) return [];
  if (!fn) {
    return [{
      sourceRef,
      name,
      start: 0,
      end: Math.max(1, source.length || 1)
    }];
  }
  const start = source.indexOf(fn);
  if (start < 0) {
    return [{
      sourceRef,
      name,
      start: 0,
      end: Math.max(1, source.length || 1)
    }];
  }
  return [{
    sourceRef,
    name,
    start,
    end: start + fn.length
  }];
}

export {
  buildDetailRowControlStateFunction,
  buildDetailRowLifecycleFunction,
  coveredRangesForText,
  detailMatchValue,
  isCompleteDetailControlDisplay,
  detailControlDisplayProof,
  detailControlDisplayBindingProof
};
