import { createHash } from "node:crypto";
import { parse } from "acorn";
import { canCommitDetailEventValue, renderDetailEventValueCommit } from "./detail-event-value-commit.js";

// Native projection only. The source-proven callback and its public DSL remain
// unchanged. Captured ABI: initRuntime.$$DETAILFORMS -> table imperative
// getLatestValue() -> qo(ko.current), even between native publication/flushes.
const PREFIX = "__mkDetailRead";
const BASIS = "deterministic-allowance-calculation";
const STANDARD_GLOBALS = new Set(["MKXFORM", "Number", "String", "Math", "Array", "Date", "parseInt", "parseFloat", "isNaN", "isFinite"]);

export function withDetailEventReadBridge(scripts = {}, form = {}) {
  const actions = Array.isArray(scripts.actions) ? scripts.actions : [];
  const mainFields = new Set((form.fields || []).filter(field => field.type !== "detailTable").map(field => field.id));
  const plans = new Map();
  for (const action of actions) {
    const table = (form.fields || []).find(field => field.type === "detailTable" && field.id === action.tableId);
    if (!table?.columns?.some(column => column.id === action.controlId && column.componentId === "xform-number")) continue;
    if (action.scope !== "control" || (action.event || action.name) !== "onChange" || action.translationStatus !== "mapped") continue;
    if (!action.sourceRefs?.length || action.coverage?.status !== "translated" || action.coverage.residuals?.length) continue;
    if (action.deterministicBranchProof?.version !== 2 || action.deterministicBranchProof.basis !== BASIS || action.deterministicBranchProof.functionSha256 !== digest(action.function)) continue;
    if (!action.functionMappings?.some(mapping => mapping.basis === BASIS && mapping.reviewRequired === false)) continue;
    const group = actions.filter(candidate => candidate.scope === "control" && candidate.tableId === action.tableId && candidate.controlId === action.controlId && (candidate.event || candidate.name) === "onChange" && candidate.translationStatus !== "omitted");
    if (!group.every(candidate => preservesTableReads(candidate.function, mainFields))) continue;
    const compiled = bridgeFunction(action, table.id, canCommitDetailEventValue(actions, table));
    if (compiled === action.function) continue;
    plans.set(action, compiled);
  }
  if (!plans.size) return scripts;
  return {
    ...scripts,
    actions: actions.map(action => plans.has(action) ? { ...action, function: plans.get(action) } : action)
  };
}

function preservesTableReads(source, mainFields) {
  try {
    let safe = true;
    const tree = parse(`(${source})`, { ecmaVersion: "latest" });
    const actionScope = tree.body[0]?.expression;
    const locals = new Set(), dates = new Set();
    const bindings = new Map(), declarations = new Map(), writes = new Set(), scopes = new WeakMap(), dateConstructors = new Set();
    visit(tree, (node, parent) => {
      const fn = /^(?:FunctionExpression|FunctionDeclaration|ArrowFunctionExpression)$/.test(node.type);
      scopes.set(node, fn ? node : scopes.get(parent));
      const patterns = node.type === "VariableDeclarator" ? [node.id] : fn ? [node.id, ...node.params] :
        node.type === "CatchClause" ? [node.param] : node.type === "ClassDeclaration" || node.type === "ClassExpression" ? [node.id] : [];
      for (const pattern of patterns) for (const name of bindingNames(pattern)) {
        bindings.set(name, (bindings.get(name) || 0) + 1);
        // Reject shadows in every lexical scope rather than guessing which
        // standard object a recipe reference would resolve to.
        if (STANDARD_GLOBALS.has(name)) safe = false;
      }
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
        locals.add(node.id.name);
        declarations.set(node.id.name, { node, kind: parent.kind });
      }
      const written = node.type === "AssignmentExpression" ? node.left : node.type === "UpdateExpression" ? node.argument :
        (node.type === "ForInStatement" || node.type === "ForOfStatement") && node.left.type !== "VariableDeclaration" ? node.left : null;
      for (const name of bindingNames(written)) {
        writes.add(name);
        if (STANDARD_GLOBALS.has(name)) safe = false;
      }
    });
    visit(tree, (node, parent) => {
      if (node.type !== "NewExpression") return;
      if (scopes.get(node) !== actionScope || !sourceDateConstruction(node, parent, declarations, bindings, writes, scopes, mainFields)) { safe = false; return; }
      dates.add(parent.id.name);
      dateConstructors.add(node);
    });
    visit(tree, (node, parent, grandparent) => {
      // The SDK itself and its methods must not escape through aliases,
      // destructuring, call/apply/bind, arguments or property assignments.
      if (node.type === "Identifier" && node.name === "MKXFORM" && !(parent?.type === "MemberExpression" && parent.object === node && !parent.computed && grandparent?.type === "CallExpression" && grandparent.callee === parent)) safe = false;
      if (node.type === "Identifier" && node.name === "Date" && !(parent?.type === "NewExpression" && parent.callee === node && dateConstructors.has(parent))) safe = false;
      if (node.type === "Identifier" && dates.has(node.name) && (scopes.get(node) !== actionScope ||
          !(parent?.type === "VariableDeclarator" && parent.id === node) &&
          !(parent?.type === "MemberExpression" && parent.object === node && grandparent?.callee === parent && sourceDateMethod(grandparent, dates)))) safe = false;
      if ((node.type === "AssignmentExpression" && node.left.type === "MemberExpression") || (node.type === "UpdateExpression" && node.argument.type === "MemberExpression") || (node.type === "UnaryExpression" && node.operator === "delete")) safe = false;
      if (node.type !== "CallExpression") return;
      if (node.callee.type !== "MemberExpression" || node.callee.object?.name !== "MKXFORM") {
        const callee = node.callee, object = callee.object, method = callee.property?.name;
        const primitive = callee.type === "Identifier" && ["Number", "String", "parseInt", "parseFloat", "isNaN", "isFinite"].includes(callee.name);
        const standard = callee.type === "MemberExpression" && !callee.computed && (
          object?.name === "Math" && ["floor", "round", "min", "max"].includes(method) ||
          object?.name === "Array" && method === "isArray" ||
          sourceDateMethod(node, dates) ||
          locals.has(object?.name) && method === "toFixed" ||
          object?.type === "CallExpression" && object.callee.name === "String" && method === "replace"
        );
        if (!primitive && !standard) safe = false;
        return;
      }
      const method = node.callee.property?.name;
      if (method === "getValue") return;
      // A sibling's own-table write would make a captured snapshot unsuitable
      // for read-after-write. Do not change that control group at all.
      if (method !== "setValue" || node.arguments[0]?.type !== "Literal" || !mainFields.has(node.arguments[0].value)) safe = false;
    });
    return safe;
  } catch { return false; }
}

function sourceDateConstruction(node, parent, declarations, bindings, writes, scopes, mainFields) {
  if (node.callee.type !== "Identifier" || node.callee.name !== "Date" || node.arguments.length !== 1 ||
      parent?.type !== "VariableDeclarator" || parent.init !== node || parent.id.type !== "Identifier" ||
      declarations.get(parent.id.name)?.kind !== "var" || bindings.get(parent.id.name) !== 1 || writes.has(parent.id.name)) return false;
  // The captured source recipe only constructs Date from a main-field read
  // normalized as String(raw).replace(/-/g, '/'). No coercible arbitrary args.
  const replace = node.arguments[0], callee = replace.callee, string = callee?.object;
  if (replace.type !== "CallExpression" || callee?.type !== "MemberExpression" || callee.computed || callee.property.name !== "replace" ||
      string?.type !== "CallExpression" || string.callee.type !== "Identifier" || string.callee.name !== "String" || string.arguments.length !== 1 ||
      string.arguments[0].type !== "Identifier" || replace.arguments.length !== 2 ||
      replace.arguments[0].regex?.pattern !== "-" || replace.arguments[0].regex.flags !== "g" || replace.arguments[1].value !== "/") return false;
  const raw = string.arguments[0].name, declaration = declarations.get(raw), read = declaration?.node.init;
  return declaration?.kind === "var" && bindings.get(raw) === 1 && !writes.has(raw) && declaration.node.end < node.start &&
    scopes.get(declaration.node) === scopes.get(node) && read?.type === "CallExpression" && read.callee.type === "MemberExpression" &&
    !read.callee.computed && read.callee.object.name === "MKXFORM" && read.callee.property.name === "getValue" &&
    read.arguments.length === 1 && read.arguments[0].type === "Literal" && mainFields.has(read.arguments[0].value);
}

function sourceDateMethod(node, dates) {
  const callee = node.callee;
  return node.type === "CallExpression" && callee.type === "MemberExpression" && !callee.computed && dates.has(callee.object?.name) &&
    (callee.property.name === "getTime" && node.arguments.length === 0 || callee.property.name === "setHours" && node.arguments.length === 4 &&
      node.arguments.every(argument => argument.type === "Literal" && argument.value === 0));
}

function bindingNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(bindingNames);
  if (pattern.type === "ObjectPattern") return pattern.properties.flatMap(property => bindingNames(property.type === "RestElement" ? property.argument : property.value));
  return [];
}

function bridgeFunction(action, tableId, commitValue) {
  const source = action.function;
  try {
    const tree = parse(`(${source})`, { ecmaVersion: "latest" });
    const fn = tree.body[0]?.expression;
    if (fn?.type !== "FunctionExpression" || fn.params[0]?.name !== "value" || fn.params[1]?.name !== "rowNum") return source;
    const table = `\${table:${tableId}}`;
    const calls = []; let collision = false;
    visit(tree, node => {
      if (node.type === "Identifier" && node.name.startsWith(PREFIX)) collision = true;
      if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.object?.name === "MKXFORM" && node.callee.property?.name === "getValue" && node.arguments.length === 1 && node.arguments[0]?.value === table) calls.push(node);
    });
    if (!calls.length || collision) return source;
    let next = source;
    for (const node of calls.sort((a, b) => b.start - a.start)) next = next.slice(0, node.start - 1) + `${PREFIX}Table()` + next.slice(node.end - 1);
    const helper = renderReader(table, action.controlId, commitValue);
    return next.slice(0, fn.body.start) + helper + next.slice(fn.body.start);
  } catch { return source; }
}

function renderReader(table, column, commitValue) {
  return `
  var ${PREFIX}Owner = this, ${PREFIX}Args = arguments;${commitValue ? renderDetailEventValueCommit() : ""}
  function ${PREFIX}Table() {
    var table = ${JSON.stringify(table)}, column = ${JSON.stringify(column)};
    var queue = typeof window === "undefined" ? null : window.MXFORM_ACTIONS;
    var registry = MKXFORM.$$DETAILFORMS && MKXFORM.$$DETAILFORMS.current;
    var ref = registry && registry[table], handle = ref && ref.current;
    if (!handle || typeof handle.getLatestValue !== "function" ||
        typeof handle.getTableName !== "function" || handle.getTableName() !== table)
      return MKXFORM.getValue(table);
    var data = handle.getLatestValue();
    var rows = Array.isArray(data) ? data : data && data.values;
    var rowNum = ${PREFIX}Args[1], parentRowNum = ${PREFIX}Args[2];
    var current = Array.isArray(rows) && rows[rowNum];
    var valid = queue && typeof rowNum === "number" && rowNum >= 0 && rowNum % 1 === 0 &&
      (parentRowNum === undefined || parentRowNum === null) && current &&
      (typeof current.key === "string" || typeof current.key === "number" && isFinite(current.key)) &&
      Object.prototype.hasOwnProperty.call(current, column);
    var owners = 0;
    if (valid) Object.keys(queue).forEach(function(key) {
      var entry = queue[key], args = entry && entry.actionParams && entry.actionParams.onChange;
      var functions = entry && entry.actionFuns && entry.actionFuns.onChange;
      var suffix = "~" + String(current.key);
      if (entry && entry.actionTableType === "detail" && entry.actionTableName === table &&
          Array.isArray(functions) && functions.indexOf(${PREFIX}Owner) >= 0 &&
          Array.isArray(args) && args[0] === ${PREFIX}Args[0] && args[1] === rowNum &&
          args[2] === parentRowNum && key.slice(-suffix.length) === suffix) owners += 1;
    });
${commitValue ? `    if (valid && owners === 1) {
      __mkDetailReadCommit(handle, rows, current, column, table);
      return data;
    }` : "    if (valid && owners === 1) return data;"}
    return MKXFORM.getValue(table);
  }
`;
}

function visit(node, callback, parent, grandparent) {
  if (!node || typeof node !== "object") return;
  callback(node, parent, grandparent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(item => visit(item, callback, node, parent));
    else if (value && typeof value === "object") visit(value, callback, node, parent);
  }
}

function digest(value) { return createHash("sha256").update(String(value || "")).digest("hex"); }
