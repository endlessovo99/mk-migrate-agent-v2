import { parse } from "acorn";
import { nativeValidationMessage } from "./native-validation-message.js";
import { JS_METHOD_CATALOG } from "../dsl/catalogs.js";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";

// One complete source algorithm, compared by lexical bindings rather than local
// names. Other loops, comparisons, effects and submit wrappers remain reviewable.
const SOURCE_SHAPE = `
function consistent(table, column) {
  var seen = [];
  var key = 'TABLE_DL_' + table;
  var info = DocList_TableInfo[key];
  if (typeof info != "undefined") {
    for (var index = 0; index < info.lastIndex; index++) {
      var field = table + "." + index + "." + column;
      var current = $("[name='extendDataFormInfo.value(" + field + ")']").val();
      if (current != undefined) {
        if (seen.length == 0) {
          seen.push(current);
        } else {
          if (seen[seen.length - 1] != current) {
            seen.push(current);
            return false;
          }
        }
      }
    }
  }
  return true;
}
Com_Parameter.event.submit.push(function() {
  var valid = consistent("table", "column");
  if (!valid) {
    alert("message");
    return false;
  }
  return true;
});`;

const EXPECTED_SHAPE = inspectGuard(SOURCE_SHAPE)?.shape;

export function detailColumnConsistencyCandidate(source, form, sourceScripts) {
  const sources = sourceScripts?.sources;
  if (!Array.isArray(sources)) return undefined;
  const originals = sources.filter((entry) => entry.sourceRef === source.sourceRef);
  if (originals.length !== 1) return undefined;
  const original = originals[0];
  const text = String(original.javascript || "");
  const guard = inspectGuard(text);
  if (!guard || guard.shape !== EXPECTED_SHAPE || !stableAcrossSources(original, guard, sources)) return undefined;
  const tables = (form.fields || []).filter((field) => field.id === guard.tableId && field.type === "detailTable");
  const columns = tables.length === 1
    ? (tables[0].columns || []).filter((column) => column.id === guard.columnId)
    : [];
  const column = columns[0];
  // A DOM input .val() and the target text input both provide scalar strings.
  // Numeric, multi-value and address-object controls need a different proof.
  if (columns.length !== 1 || column.type !== "text" || column.componentId !== "xform-input" ||
      String(column.sourceProps?.designerType).toLowerCase() !== "inputtext" ||
      column.sourceProps?.designerValues?.dataType !== "String") return undefined;
  return {
    index: guard.index,
    event: "onBeforeSubmit",
    scope: "global",
    function: [
      "function onBeforeSubmit(context) {",
      "  if (context && context.isDraft) return true",
      `  var rows = MKXFORM.getValue("\${table:${guard.tableId}}") || []`,
      "  var previous = null",
      "  for (var index = 0; index < rows.length; index += 1) {",
      `    var value = rows[index] && rows[index][${JSON.stringify(guard.columnId)}]`,
      "    if (value === undefined || value === null) continue",
      "    value = String(value)",
      "    if (previous !== null && previous !== value) {",
      nativeValidationMessage(JSON.stringify(guard.message), "      "),
      "      return false",
      "    }",
      "    previous = value",
      "  }",
      "  return true",
      "}"
    ].join("\n"),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "DocList_TableInfo department consistency submit guard",
      target: "onBeforeSubmit + MKXFORM.getValue detail table rows",
      basis: "deterministic-procurement-payment-department-consistency",
      reviewRequired: false
    }],
    semanticHints: {
      coveredCalculationRanges: [{
        sourceRef: source.sourceRef,
        name: "procurement_payment_department_consistency",
        start: 0,
        end: text.length
      }]
    }
  };
}

function inspectGuard(text) {
  let program;
  try { program = parse(text, { ecmaVersion: "latest" }); } catch { return undefined; }
  const bindings = buildJavaScriptBindingModel(text, { programIsEntrypoint: true });
  if (!bindings.ok) return undefined;
  const statements = program.body.filter((node) => node.type !== "EmptyStatement");
  if (statements.length !== 2 || statements[0].type !== "FunctionDeclaration") return undefined;
  const helper = statements[0];
  const push = statements[1].type === "ExpressionStatement" && statements[1].expression;
  const callback = push?.type === "CallExpression" && push.arguments[0];
  if (callback?.type !== "FunctionExpression" || callback.params.length || callback.async || callback.generator || callback.id) return undefined;
  const body = callback.body.body.filter((node) => node.type !== "EmptyStatement" && !debugStatement(node, bindings));
  const call = body[0]?.type === "VariableDeclaration" && body[0].declarations[0]?.init;
  if (call?.type !== "CallExpression" || call.callee.type !== "Identifier" || call.arguments.length !== 2 ||
      !call.arguments.every((node) => node.type === "Literal" && typeof node.value === "string" && node.value)) return undefined;
  const helperBinding = bindings.bindingAtUse(call.callee.name, call.callee.start);
  if (!helperBinding || helperBinding.ambiguous || !helperBinding.kinds.has("function") ||
      call.callee.name !== helper.id?.name) return undefined;
  const rejection = body[1]?.type === "IfStatement" && body[1].consequent;
  const alert = rejection?.type === "BlockStatement" && rejection.body
    .filter((node) => node.type !== "EmptyStatement" && !debugStatement(node, bindings))[0]?.expression;
  const message = alert?.type === "CallExpression" && alert.arguments[0];
  if (message?.type !== "Literal" || typeof message.value !== "string") return undefined;

  const parameters = new Map([[call.arguments[0], "table"], [call.arguments[1], "column"], [message, "message"]]);
  try {
    return {
      shape: boundShape(program, bindings, helper, helperBinding, parameters), index: statements[1].start,
      helperName: helper.id.name, helperShape: boundShape(helper, bindings, helper, helperBinding),
      tableId: call.arguments[0].value, columnId: call.arguments[1].value, message: message.value
    };
  } catch { return undefined; }
}

function boundShape(node, bindings, helper, helperBinding, parameters = new Map()) {
  const names = new Map();
  function normalize(node, parent, key) {
    if (Array.isArray(node)) return node
      .filter((entry) => entry?.type !== "EmptyStatement" && !debugStatement(entry, bindings))
      .map((entry) => normalize(entry, parent, key));
    if (!node || typeof node !== "object") return node;
    if (parameters.has(node)) return { type: "Literal", value: parameters.get(node) };
    if (node.type === "Identifier") {
      if (parent?.type === "MemberExpression" && key === "property" && !parent.computed) {
        return { type: "Identifier", property: node.name };
      }
      const binding = node === helper.id ? helperBinding : bindings.bindingAtUse(node.name, node.start);
      if (binding?.ambiguous) throw new Error("ambiguous local binding");
      if (binding && !names.has(binding)) names.set(binding, names.size);
      return { type: "Identifier", name: binding ? `local:${names.get(binding)}` : `global:${node.name}` };
    }
    return Object.fromEntries(Object.keys(node).sort()
      .filter((property) => !["start", "end", "raw"].includes(property))
      .map((property) => [property, normalize(node[property], node, property)]));
  }
  return JSON.stringify(normalize(node));
}

// This is an overwrite audit for the known helper and its platform dependencies,
// not an evaluator of sibling scripts or their runtime call order.
function stableAcrossSources(source, guard, sources) {
  const protectedNames = new Set([guard.helperName, "$", "DocList_TableInfo", "Com_Parameter", "undefined", "alert", "console"]);
  const records = [];
  for (const sibling of sources) {
    if (disjointViews(source.displayGate, sibling.displayGate)) continue;
    const text = String(sibling.javascript || "");
    let program;
    try { program = parse(text, { ecmaVersion: "latest" }); } catch { return false; }
    const bindings = buildJavaScriptBindingModel(text, { programIsEntrypoint: true });
    if (!bindings.ok) return false;
    records.push({ program, bindings, text, nodes: astEntries(program), aliases: new Map() });
  }
  const globalAliases = new Map();
  const roots = (node, record) => globalRoots(node, record, globalAliases, protectedNames);
  // A simple assignment can make a formerly ordinary binding a global alias.
  // Unioning these facts deliberately does not guess path or execution order.
  let changed;
  do {
    changed = false;
    for (const record of records) for (const { node } of record.nodes) {
      const left = node.type === "VariableDeclarator" ? node.id : node.type === "AssignmentExpression" ? node.left : null;
      const right = node.type === "VariableDeclarator" ? node.init : node.type === "AssignmentExpression" ? node.right : null;
      const values = roots(right, record);
      if (!values.size) continue;
      if (left?.type === "Identifier") {
        const binding = record.bindings.bindingAtUse(left.name, left.start);
        changed = addRoots(binding ? record.aliases : globalAliases, binding || left.name, values) || changed;
        if (!binding || binding.scope.kind === "program") changed = addRoots(globalAliases, left.name, values) || changed;
      } else if (left?.type === "MemberExpression" && roots(left.object, record).has("window")) {
        const name = memberName(left);
        if (name) changed = addRoots(globalAliases, name, values) || changed;
      }
    }
  } while (changed);

  for (const record of records) for (const { node, parent, key } of record.nodes) {
    if (node.type === "FunctionDeclaration" && protectedNames.has(node.id?.name)) {
      const binding = record.bindings.bindingAtUse(node.id.name, record.program.end);
      const global = record.bindings.scopeAt(node.start).parent?.functionScope.kind === "program";
      if (!global) continue;
      if (node.id.name !== guard.helperName || !record.program.body.includes(node) || !binding || binding.ambiguous) return false;
      try {
        if (boundShape(node, record.bindings, node, binding) !== guard.helperShape) return false;
      } catch { return false; }
    }
    if (node.type === "VariableDeclarator" && assignmentTargets(node.id).some((target) =>
      target.type === "Identifier" && protectedNames.has(target.name) &&
      record.bindings.bindingAtUse(target.name, target.start)?.scope.kind === "program"
    )) return false;
    const target = node.type === "AssignmentExpression" ? node.left
      : node.type === "UpdateExpression" || node.type === "UnaryExpression" && node.operator === "delete" ? node.argument : null;
    if (target && assignmentTargets(target).some((entry) => protectedWrite(entry, record, roots, protectedNames))) return false;
    if (node.type === "Identifier" && ["eval", "Function"].includes(node.name) &&
        !(parent?.type === "MemberExpression" && key === "property" && !parent.computed) &&
        record.bindings.isUnshadowedGlobal(node.name, node.start)) return false;
    if (node.type === "CallExpression" && unsafeGlobalCall(node, record, roots, protectedNames)) return false;
  }
  return true;
}

function disjointViews(left, right) {
  return left === "xform:editShow" && right === "xform:viewShow" ||
    left === "xform:viewShow" && right === "xform:editShow";
}

function globalRoots(node, record, globalAliases, protectedNames) {
  if (!node) return new Set();
  const bindings = record.bindings;
  if (node.type === "ThisExpression" && bindings.scopeAt(node.start).functionScope.kind === "program") return new Set(["window"]);
  if (node.type === "Identifier") {
    const binding = bindings.bindingAtUse(node.name, node.start);
    const global = !binding || binding.scope.kind === "program";
    return new Set([
      ...(!binding && ["window", "globalThis", "self"].includes(node.name) ? ["window"] : []),
      ...(global && protectedNames.has(node.name) ? [node.name] : []),
      ...(binding ? record.aliases.get(binding) || [] : []),
      ...(global ? globalAliases.get(node.name) || [] : [])
    ]);
  }
  if (node.type !== "MemberExpression") return new Set();
  const values = globalRoots(node.object, record, globalAliases, protectedNames), name = memberName(node);
  if (values.has("window")) {
    values.delete("window");
    if (name && protectedNames.has(name)) values.add(name);
    else if (name && ["window", "globalThis", "self"].includes(name)) values.add("window");
    else if (!name) values.add("unknown-global");
    if (name) for (const alias of globalAliases.get(name) || []) values.add(alias);
  }
  return values;
}

function protectedWrite(target, record, roots, protectedNames) {
  if (target.type === "Identifier") {
    const binding = record.bindings.bindingAtUse(target.name, target.start);
    return protectedNames.has(target.name) && (!binding || binding.scope.kind === "program");
  }
  if (target.type !== "MemberExpression") return false;
  const values = roots(target.object, record);
  return [...values].some((value) => value !== "window") ||
    values.has("window") && (!memberName(target) || protectedNames.has(memberName(target)));
}

function unsafeGlobalCall(call, record, roots, protectedNames) {
  const member = call.callee;
  if (member.type === "MemberExpression" && roots(member.object, record).has("window") &&
      ["eval", "Function"].includes(memberName(member))) return true;
  const api = member.type === "MemberExpression" && !member.computed &&
    member.object.type === "Identifier" && record.bindings.isUnshadowedGlobal(member.object.name, member.start)
    ? `${member.object.name}.${member.property.name}` : "";
  if (["Object.assign", "Object.defineProperty", "Object.defineProperties", "Reflect.set"].includes(api)) {
    const target = roots(call.arguments[0], record);
    if (!target.size) return false;
    if ([...target].some((value) => value !== "window")) return true;
    if (["Object.defineProperty", "Reflect.set"].includes(api)) {
      const key = call.arguments[1];
      return key?.type !== "Literal" || typeof key.value !== "string" || protectedNames.has(key.value);
    }
    return call.arguments.slice(1).some((argument) => argument.type !== "ObjectExpression" ||
      argument.properties.some((property) => property.type !== "Property" || property.computed ||
        protectedNames.has(property.key.name ?? property.key.value) || roots(property.value, record).size));
  }
  // Passing a global object to an unknown writer/alias cannot prove stability.
  // The known platform event binder and jQuery window receiver are not writers.
  const platformReceiver = member.type === "Identifier" && ["$", "Com_AddEventListener"].includes(member.name) &&
    record.bindings.isUnshadowedGlobal(member.name, member.start);
  return !platformReceiver && call.arguments.some((argument) => roots(argument, record).has("window"));
}

function memberName(node) {
  return !node.computed && node.property.type === "Identifier" ? node.property.name
    : node.computed && node.property.type === "Literal" && typeof node.property.value === "string" ? node.property.value : undefined;
}

function assignmentTargets(node) {
  if (!node) return [];
  if (["Identifier", "MemberExpression"].includes(node.type)) return [node];
  if (node.type === "ObjectPattern") return node.properties.flatMap((entry) => assignmentTargets(entry.value || entry.argument));
  if (node.type === "ArrayPattern") return node.elements.flatMap(assignmentTargets);
  if (node.type === "RestElement") return assignmentTargets(node.argument);
  if (node.type === "AssignmentPattern") return assignmentTargets(node.left);
  return [];
}

function addRoots(map, key, values) {
  const previous = map.get(key) || new Set(), size = previous.size;
  for (const value of values) previous.add(value);
  map.set(key, previous);
  return previous.size !== size;
}

function astEntries(program) {
  const entries = [];
  function visit(node, parent, key) {
    if (!node || typeof node !== "object" || !node.type) return;
    entries.push({ node, parent, key });
    for (const [property, value] of Object.entries(node)) {
      if (Array.isArray(value)) value.forEach((entry) => visit(entry, node, property));
      else if (value && typeof value === "object") visit(value, node, property);
    }
  }
  visit(program);
  return entries;
}

function debugStatement(node, bindings) {
  if (node?.type !== "ExpressionStatement" || node.expression.type !== "CallExpression") return false;
  const call = node.expression, member = call.callee;
  return !call.optional && member.type === "MemberExpression" && !member.computed && !member.optional &&
    member.object.type === "Identifier" && member.object.name === "console" &&
    bindings.isUnshadowedGlobal("console", call.start) &&
    JS_METHOD_CATALOG.staticMethods.some((entry) => entry.name === `console.${member.property.name}` &&
      entry.status === "supported" && entry.notes?.startsWith("Debug only")) &&
    call.arguments.every((argument) => argument.type === "Literal" ||
      argument.type === "Identifier" && bindings.bindingAtUse(argument.name, argument.start) &&
      !bindings.bindingAtUse(argument.name, argument.start).ambiguous);
}
