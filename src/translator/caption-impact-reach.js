import { parse } from "acorn";

// Impact boundary for a program the semantic interpreter could not finish.
// This does not prove the unrecognized operation. It only asks which nodes it
// can reach. A closed set protects those nodes; a free call, dynamic selector,
// prototype write, eval or wide DOM collection has no pair-level boundary.
const SAFE_CALLS = new Set(["alert", "parseInt", "parseFloat", "Number", "String", "Boolean", "isNaN", "isFinite",
  "encodeURIComponent", "decodeURIComponent", "Com_IncludeFile"]);
const FIELD_CALLS = new Set(["GetXFormFieldById", "GetXFormFieldValueById", "SetXFormFieldValueById", "getFormFieldValue"]);
const DATA_METHODS = new Set(["join", "push", "pop", "shift", "unshift", "slice", "splice", "indexOf", "includes",
  "replace", "split", "trim", "toString", "toLowerCase", "toUpperCase", "match", "map", "filter", "forEach",
  "concat", "substring", "substr", "charAt", "toFixed", "padStart", "valueOf", "keys", "values", "entries",
  "test", "exec"]);
const DATA_PROPS = new Set(["value", "checked", "length", "selectedIndex", "name", "id", "type", "options", "files"]);
const WIDE_TAGS = new Set(["label", "td", "tr", "input", "textarea", "select", "table", "div", "span", "a", "form", "body", "p"]);
const DOM_ESCAPE = new Set(["parentNode", "parentElement", "offsetParent", "previousElementSibling", "nextElementSibling",
  "previousSibling", "nextSibling", "parent"]);
const BUILTINS = new Set(["Math", "JSON", "console", "Object", "Array", "Date", "RegExp", "Number", "String", "Boolean",
  "parseInt", "parseFloat", "isNaN", "isFinite"]);

export function captionImpactReach(scripts) {
  const anchors = new Set(), selectors = [], rowMarkers = [];
  for (let scriptIndex = 0; scriptIndex < scripts.length; scriptIndex++) {
    const text = scripts[scriptIndex];
    if (!text || !String(text).trim()) continue;
    let ast;
    try { ast = parse(text, { ecmaVersion: "latest", allowReturnOutsideFunction: true }); }
    catch (error) { return unbounded(scriptIndex, error.pos || 0, "script_syntax_unbounded"); }
    try { scanProgram(ast, scriptIndex, anchors, selectors, rowMarkers); }
    catch (error) {
      return unbounded(scriptIndex, error.offset || 0, error.reason || "script_reach_unbounded", error.details);
    }
  }
  return { bounded: true, anchors: [...anchors], selectors, rowMarkers };
}

function unbounded(scriptIndex, offset, reason, details) {
  return { bounded: false, reason, scriptIndex, offset, ...(details ? { details } : {}) };
}

function scanProgram(ast, scriptIndex, anchors, selectors, rowMarkers) {
  const env = new Map();
  const state = { anchors, selectors, rowMarkers, scriptIndex };
  for (const node of ast.body) if (node.type === "FunctionDeclaration" && node.id) env.set(node.id.name, { kind: "function" });
  for (const node of ast.body) scan(node, env, state);
}

function scan(node, env, state) {
  if (!node || typeof node !== "object") return;
  switch (node.type) {
    case "Program":
    case "BlockStatement":
      for (const statement of node.body || []) scan(statement, env, state);
      return;
    case "FunctionDeclaration":
      scanFunction(node, env, state); return;
    case "VariableDeclaration":
      for (const declaration of node.declarations) {
        if (declaration.id.type !== "Identifier") fail("unscoped_binding", declaration);
        const value = declaration.init ? evalExpr(declaration.init, env, state) : { kind: "data" };
        env.set(declaration.id.name, value?.kind === "function" ? value : value || { kind: "data" });
      }
      return;
    case "ExpressionStatement":
      if (node.expression.type === "AssignmentExpression") assign(node.expression, env, state);
      else evalExpr(node.expression, env, state);
      return;
    case "IfStatement":
      evalExpr(node.test, env, state); scan(node.consequent, env, state); if (node.alternate) scan(node.alternate, env, state); return;
    case "ForStatement": case "WhileStatement": case "DoWhileStatement":
      if (node.init) scan(node.init, env, state);
      if (node.test) evalExpr(node.test, env, state);
      if (node.update) evalExpr(node.update, env, state);
      scan(node.body, env, state); return;
    case "ForInStatement": case "ForOfStatement":
      scanIteration(node, env, state); return;
    case "SwitchStatement":
      evalExpr(node.discriminant, env, state);
      for (const item of node.cases) { if (item.test) evalExpr(item.test, env, state); for (const statement of item.consequent) scan(statement, env, state); }
      return;
    case "TryStatement":
      scan(node.block, env, state); if (node.handler) scan(node.handler.body, env, state); if (node.finalizer) scan(node.finalizer, env, state); return;
    case "ReturnStatement": if (node.argument) evalExpr(node.argument, env, state); return;
    case "ThrowStatement": evalExpr(node.argument, env, state); return;
    case "EmptyStatement": case "BreakStatement": case "ContinueStatement": case "DebuggerStatement": return;
    default: fail("unscoped_statement", node);
  }
}

function scanFunction(node, env, state) {
  const local = new Map(env);
  for (const param of node.params || []) {
    if (param.type !== "Identifier") fail("unscoped_binding", param);
    local.set(param.name, { kind: "param" });
  }
  if (node.body.type !== "BlockStatement") { evalExpr(node.body, local, state); return; }
  for (const statement of node.body.body) if (statement.type === "FunctionDeclaration" && statement.id) local.set(statement.id.name, { kind: "function" });
  for (const statement of node.body.body) scan(statement, local, state);
}

function assign(node, env, state) {
  if (node.operator !== "=" && node.operator !== "+=") fail("unscoped_assignment", node);
  if (memberPath(node.left)?.split(".").includes("prototype")) fail("prototype_mutation", node);
  const value = evalExpr(node.right, env, state);
  if (node.left.type === "Identifier") {
    if (BUILTINS.has(node.left.name)) fail("builtin_reassigned", node, { name: node.left.name });
    env.set(node.left.name, value || { kind: "data" }); return;
  }
  if (node.left.type !== "MemberExpression" || node.left.computed) fail("unscoped_dom_write", node.left);
  const object = evalExpr(node.left.object, env, state);
  const property = node.left.property.name;
  if (object?.kind === "dom-root" && ["onload", "onresize"].includes(property) && value?.kind === "function") return;
  if (object?.kind === "style" && ["innerHTML", "textContent", "type"].includes(property)) {
    if (property !== "type") addStyle(value, state, node);
    return;
  }
  if (object?.kind === "node" && DATA_PROPS.has(property)) return;
  if (object?.kind === "node") { object.ids.forEach(id => state.anchors.add(id)); return; }
  // A value/checked write on a field lookup is data, even when the lookup is
  // only known as a value result. Presentation writes stay unscoped.
  if (DATA_PROPS.has(property) && !["dom-root", "style", "head"].includes(object?.kind)) return;
  fail("unscoped_dom_write", node.left);
}

function evalExpr(node, env, state) {
  if (!node) return { kind: "data" };
  switch (node.type) {
    case "Literal": return node.regex ? { kind: "safe" } : typeof node.value === "string" ? { kind: "text", text: node.value } : { kind: "data" };
    case "Identifier": return identifier(node, env);
    case "TemplateLiteral":
      node.expressions.forEach(item => rejectUnresolved(evalExpr(item, env, state), item));
      return node.expressions.length ? { kind: "dynamic-text", text: node.quasis.map(item => item.value.cooked).join("") }
        : { kind: "text", text: node.quasis[0]?.value.cooked || "" };
    case "BinaryExpression":
      if (node.operator === "+") return concat(evalExpr(node.left, env, state), evalExpr(node.right, env, state));
      evalExpr(node.left, env, state); evalExpr(node.right, env, state); return { kind: "data" };
    case "LogicalExpression": case "ConditionalExpression":
      evalExpr(node.test || node.left, env, state); evalExpr(node.consequent || node.right, env, state);
      if (node.alternate) evalExpr(node.alternate, env, state); return { kind: "data" };
    case "UnaryExpression": case "UpdateExpression":
      if (node.operator === "delete") fail("unscoped_dom_write", node);
      evalExpr(node.argument, env, state); return { kind: "data" };
    case "ArrayExpression": {
      const items = node.elements.map(item => item ? rejectUnresolved(evalExpr(item, env, state), item) : { kind: "data" });
      return items.every(item => item?.kind === "text") ? { kind: "array", items } : { kind: "data" };
    }
    case "ObjectExpression":
      for (const property of node.properties) {
        if (property.type !== "Property" || property.computed) fail("unscoped_dom_write", property);
        evalExpr(property.value, env, state);
      }
      return { kind: "data" };
    case "FunctionExpression": case "ArrowFunctionExpression":
      scanFunction(node, env, state); return { kind: "function" };
    case "NewExpression": return construct(node, env, state);
    case "CallExpression": return call(node, env, state);
    case "MemberExpression": return member(node, env, state);
    case "AssignmentExpression": assign(node, env, state); return { kind: "data" };
    case "SequenceExpression": return node.expressions.map(item => evalExpr(item, env, state)).at(-1) || { kind: "data" };
    case "ThisExpression": return state.receiver || { kind: "data" };
    default: fail("unscoped_expression", node);
  }
  return { kind: "data" };
}

function identifier(node, env) {
  if (["undefined", "NaN", "Infinity", "arguments"].includes(node.name)) return { kind: "data" };
  if (env.has(node.name)) return env.get(node.name);
  if (["Math", "JSON", "console", "Object", "Array", "Date", "RegExp", "Number", "String", "Boolean"].includes(node.name)) return { kind: "safe" };
  if (node.name === "document" || node.name === "window" || node.name === "globalThis") return { kind: "dom-root", name: node.name };
  // A bare read can be an unused typo. A call or member use is checked at that site.
  return { kind: "unresolved", name: node.name };
}

function concat(left, right) {
  const text = `${left?.text || ""}${right?.text || ""}`;
  if (left?.kind === "text" && right?.kind === "text") return { kind: "text", text };
  if ((left?.text || right?.text) && !["node", "style", "head", "dom-root"].includes(left?.kind) && !["node", "style", "head", "dom-root"].includes(right?.kind))
    return { kind: "dynamic-text", text };
  return { kind: "data" };
}

function construct(node, env, state) {
  node.arguments.forEach(argument => rejectUnresolved(evalExpr(argument, env, state), argument));
  const name = node.callee.type === "Identifier" ? node.callee.name : undefined;
  if (["Array", "Date", "Object", "RegExp", "Map", "Set"].includes(name)) return { kind: "data" };
  fail("unknown_constructor", node, { name });
}

function call(node, env, state) {
  const callee = node.callee;
  if (callee.type === "Identifier") {
    const name = callee.name;
    if (env.get(name)?.kind === "function" || SAFE_CALLS.has(name)) {
      node.arguments.forEach(argument => rejectUnresolved(evalExpr(argument, env, state), argument)); return { kind: "data" };
    }
    if (name === "GetXFormFieldById") {
      const id = node.arguments[0] && rejectUnresolved(evalExpr(node.arguments[0], env, state), node.arguments[0]);
      node.arguments.slice(1).forEach(argument => rejectUnresolved(evalExpr(argument, env, state), argument));
      const ids = idsFrom(id);
      return ids.length ? { kind: "node", ids } : { kind: "data" };
    }
    if (FIELD_CALLS.has(name)) {
      const id = node.arguments[0] && evalExpr(node.arguments[0], env, state);
      rejectUnresolved(id, node.arguments[0]);
      node.arguments.slice(1).forEach(argument => rejectUnresolved(evalExpr(argument, env, state), argument));
      anchorText(id, state, false); return { kind: "data" };
    }
    if (name === "AttachXFormValueChangeEventById" || name === "common_required" || name === "common_not_required") {
      const id = evalExpr(node.arguments[0], env, state);
      node.arguments.slice(1).forEach(argument => evalExpr(argument, env, state));
      anchorText(id, state, true); return { kind: "data" };
    }
    if (name === "common_dom_row_set_show_required_reset") {
      const marker = evalExpr(node.arguments[0], env, state);
      node.arguments.slice(1).forEach(argument => evalExpr(argument, env, state));
      if (marker?.kind !== "text" || !marker.text) fail("dynamic_selector", node);
      state.rowMarkers.push(marker.text); return { kind: "data" };
    }
    if (name === "Com_AddEventListener") {
      node.arguments.forEach(argument => evalExpr(argument, env, state)); return { kind: "data" };
    }
    if (name === "setTimeout" || name === "setInterval") {
      node.arguments.forEach(argument => evalExpr(argument, env, state));
      if (node.arguments[0]?.type === "Literal") fail("eval_or_function_constructor", node);
      return { kind: "data" };
    }
    if (name === "$" || name === "jQuery") return selectorCall(node, env, state);
    // An unknown call that only receives closed nodes can affect those nodes.
    // A call with no node has no pair boundary.
    const args = node.arguments.map(argument => rejectUnresolved(evalExpr(argument, env, state), argument));
    if (args.some(arg => ["dom-root", "head", "style"].includes(arg?.kind))) fail("unknown_call", node, { name });
    const ids = [...new Set(args.flatMap(arg => arg?.kind === "node" ? arg.ids : []))];
    if (ids.length) { ids.forEach(id => state.anchors.add(id)); return { kind: "data" }; }
    fail("unknown_call", node, { name });
  }
  if (callee.type === "FunctionExpression" || callee.type === "ArrowFunctionExpression") {
    evalExpr(callee, env, state); node.arguments.forEach(argument => evalExpr(argument, env, state)); return { kind: "data" };
  }
  if (callee.type !== "MemberExpression" || callee.computed) fail("unknown_call", callee);
  const method = callee.property.name;
  if (method === "eval" || callee.object?.name === "Function") fail("eval_or_function_constructor", node);
  const object = evalExpr(callee.object, env, state);
  if (object?.kind === "dom-root" && object.name === "document") return documentCall(method, node, env, state);
  if (method === "join" && object?.kind === "array") {
    const separator = node.arguments[0] ? evalExpr(node.arguments[0], env, state) : { kind: "text", text: "," };
    if (separator?.kind !== "text") return { kind: "data" };
    return { kind: "text", text: object.items.map(item => item.text).join(separator.text) };
  }
  if (object?.kind === "safe" || DATA_METHODS.has(method)) {
    node.arguments.forEach(argument => rejectUnresolved(evalExpr(argument, env, state), argument)); return { kind: "data" };
  }
  if (object?.kind === "head" && method === "appendChild") {
    const argument = evalExpr(node.arguments[0], env, state);
    if (argument?.kind !== "style") fail("unscoped_dom_write", node);
    return { kind: "data" };
  }
  if (object?.kind === "node") {
    if (["each", "map"].includes(method)) {
      const callback = node.arguments[0];
      const previous = state.receiver;
      state.receiver = object;
      if (callback) evalExpr(callback, env, state);
      node.arguments.slice(1).forEach(argument => evalExpr(argument, env, state));
      state.receiver = previous;
      return object;
    }
    const args = node.arguments.map(argument => evalExpr(argument, env, state));
    const propName = args[0]?.kind === "text" ? args[0].text : undefined;
    const dataUse = ["val", "serialize", "serializeArray", "width", "height", "outerWidth", "outerHeight", "position", "offset", "index"].includes(method) ||
      (["prop", "attr", "removeAttr"].includes(method) && DATA_PROPS.has(propName)) ||
      (method === "setAttribute" && ["placeholder", "value", "checked", "maxlength"].includes(propName)) ||
      DATA_METHODS.has(method) || method === "getAttribute";
    if (!dataUse) object.ids.forEach(id => state.anchors.add(id));
    return object;
  }
  if (object?.kind === "guarded") {
    node.arguments.forEach(argument => evalExpr(argument, env, state)); return object;
  }
  if (object?.kind === "style" && ["appendChild", "setAttribute"].includes(method)) {
    node.arguments.forEach(argument => evalExpr(argument, env, state)); return object;
  }
  fail("unknown_call", node, { method });
}

function documentCall(method, node, env, state) {
  const argument = node.arguments[0] ? evalExpr(node.arguments[0], env, state) : undefined;
  node.arguments.slice(1).forEach(item => evalExpr(item, env, state));
  if (method === "createElement") {
    if (argument?.kind === "text" && argument.text.toLowerCase() === "style") return { kind: "style" };
    fail("unscoped_dom_write", node, { element: argument?.text });
  }
  if (method === "getElementsByTagName") {
    if (argument?.kind === "text" && argument.text.toLowerCase() === "head") return { kind: "head" };
    fail("wide_dom_collection", node, { tag: argument?.text });
  }
  if (method === "getElementById" || method === "getElementsByName" || method === "querySelector" || method === "querySelectorAll") {
    if (method.startsWith("querySelector") && argument?.kind === "text" && wideSelector(argument.text))
      fail("wide_style_selector", node, { selector: argument.text });
    if (!anchorText(argument, state, method !== "getElementById" && method !== "getElementsByName")) {
      if (argument?.kind === "text" && method.startsWith("query") && !wideSelector(argument.text)) {
        state.selectors.push(argument.text); return { kind: "data" };
      }
      fail("dynamic_selector", node);
    }
    return { kind: "node", ids: idsFrom(argument) };
  }
  if (method === "write" || method === "writeln") fail("unscoped_dom_write", node);
  fail("unscoped_dom_write", node, { method });
}

function selectorCall(node, env, state) {
  const argument = evalExpr(node.arguments[0], env, state);
  if (argument?.kind === "function") return argument;
  if (argument?.kind === "text" && wideSelector(argument.text)) fail("wide_style_selector", node, { selector: argument.text });
  if (argument?.kind === "node") return argument;
  const ids = idsFrom(argument);
  if (ids.length) return { kind: "node", ids };
  if (argument?.kind === "text") { state.selectors.push(argument.text); return { kind: "data" }; }
  fail("dynamic_selector", node);
}

function member(node, env, state) {
  if (memberPath(node)?.split(".").includes("prototype")) fail("prototype_mutation", node);
  const object = evalExpr(node.object, env, state);
  if (object?.kind === "unresolved") fail("unresolved_value", node, { name: object.name });
  if (node.computed && node.property.type === "Literal" && (node.property.value === 0 || node.property.value === "0") &&
      (object?.kind === "head" || object?.kind === "node" || object?.kind === "style")) return object;
  if (object?.kind === "node" && !node.computed && DOM_ESCAPE.has(node.property.name)) fail("dom_escape", node, { property: node.property.name });
  if (object?.kind === "node" && !node.computed && !DATA_PROPS.has(node.property.name)) return object;
  if (object?.kind === "dom-root" && node.computed) {
    const key = node.property.type === "Identifier" ? env.get(node.property.name) : evalExpr(node.property, env, state);
    if (key?.kind === "guarded-key") return { kind: "guarded", prefix: key.prefix };
    fail("unscoped_dom_write", node);
  }
  if (object?.kind === "guarded") return object;
  if (object?.kind === "dom-root") fail("unscoped_dom_write", node);
  return object?.kind === "text" || object?.kind === "dynamic-text" ? { kind: "data" } : (object || { kind: "data" });
}

function addStyle(value, state, node) {
  const text = value?.kind === "text" ? value.text : value?.kind === "dynamic-text" ? value.text : undefined;
  if (!text || value?.kind === "dynamic-text") fail("dynamic_style_text", node);
  for (const selector of cssSelectors(text)) {
    if (wideSelector(selector)) fail("wide_style_selector", node, { selector });
    state.selectors.push(selector);
  }
}

function anchorText(value, state, presentation) {
  const ids = idsFrom(value);
  if (!ids.length) return false;
  if (presentation) ids.forEach(id => state.anchors.add(id));
  return true;
}

function idsFrom(value) {
  if (!value || (value.kind !== "text" && value.kind !== "dynamic-text")) return [];
  const text = value.text || "";
  const ids = new Set();
  if (value.kind === "text" && /^[A-Za-z_][\w.-]*$/.test(text)) ids.add(text.replace(/\.(?:id|name)$/, ""));
  for (const match of text.matchAll(/extendDataFormInfo\.value\(([A-Za-z_][\w]*)/g)) ids.add(match[1]);
  for (const match of text.matchAll(/TABLE_DL_([A-Za-z_][\w]*)/g)) ids.add(match[1]);
  for (const match of text.matchAll(/\bfd_[A-Za-z0-9_]+/g)) ids.add(match[0]);
  for (const match of text.matchAll(/#([A-Za-z_][\w-]*)/g)) ids.add(match[1]);
  return [...ids];
}

function cssSelectors(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map(rule => rule.split("{")[0].trim()).filter(Boolean);
}

function wideSelector(selector) {
  return selector.split(",").some(part => {
    const body = part.trim();
    if (!body || body === "*") return true;
    if (/\b(td_normal|caption)\b/i.test(body)) return true;
    const tag = body.replace(/\[[^\]]*\]/g, "").replace(/[.#][A-Za-z_][\w-]*/g, "").replace(/::?[a-z-]+(\([^)]*\))?/gi, "").trim().toLowerCase();
    if (!tag) return false;
    return WIDE_TAGS.has(tag) && !/[.#\[]/.test(body);
  });
}

function scanIteration(node, env, state) {
  const name = node.left.type === "VariableDeclaration" ? node.left.declarations[0]?.id?.name : node.left.name;
  const root = node.right.type === "Identifier" ? node.right.name : undefined;
  const prefix = name && (root === "window" || root === "document") ? prefixGuard(node.body, name) : undefined;
  if (prefix && !/fd_|label|td_|caption|input|select/i.test(prefix)) {
    state.selectors.push(prefix);
    const local = new Map(env);
    local.set(name, { kind: "guarded-key", prefix });
    scan(node.body, local, state);
    return;
  }
  const right = evalExpr(node.right, env, state);
  if (right?.kind === "array" && name) {
    const local = new Map(env);
    local.set(name, { kind: "text", text: "" });
    scan(node.body, local, state);
    return;
  }
  fail("dynamic_iteration", node);
}

function prefixGuard(body, name) {
  const statement = body.type === "BlockStatement" && body.body.length === 1 ? body.body[0] : body;
  if (statement?.type !== "IfStatement") return undefined;
  return guardText(statement.test, name);
}

function guardText(test, name) {
  if (!test) return undefined;
  if (test.type === "LogicalExpression") return guardText(test.left, name) || guardText(test.right, name);
  const call = test.type === "BinaryExpression" ? test.left : test;
  if (call?.type === "CallExpression" && call.callee.type === "MemberExpression" && !call.callee.computed &&
      call.callee.object?.name === name && ["indexOf", "startsWith"].includes(call.callee.property.name) &&
      call.arguments[0]?.type === "Literal" && typeof call.arguments[0].value === "string" &&
      (test === call || test.right?.value === 0)) return call.arguments[0].value;
  return undefined;
}

function memberPath(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "MemberExpression" && !node.computed && node.property?.type === "Identifier")
    return `${memberPath(node.object)}.${node.property.name}`;
  return undefined;
}

function rejectUnresolved(value, node) {
  if (value?.kind === "unresolved") fail("unresolved_value", node, { name: value.name });
  return value;
}

function fail(reason, node, details) {
  throw Object.assign(new Error(reason), { reason, offset: node?.start, details });
}
