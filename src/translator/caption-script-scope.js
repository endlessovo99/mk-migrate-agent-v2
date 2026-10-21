import { parse } from "acorn";
import { buildFormRuleRefIndex, resolveEffectTarget, resolveSourceRowEffectTarget } from "../dsl/form-rules.js";
import { captionDoclistScope, hasStaticDoclistRegistration } from "./caption-doclist-scope.js";

const DATA = Object.freeze({ kind: "data" });
const NONE = Object.freeze({ kind: "none" });
const PURE = new Set(["Number", "String", "Boolean", "parseInt", "parseFloat", "isNaN", "isFinite", "alert"]);
const GETTERS = new Set(["GetXFormFieldValueById", "getFormFieldValue"]);
const ROW = "common_dom_row_set_show_required_reset";
const REQUIRED = new Set(["common_required", "common_not_required"]);
const RESERVED = new Set([...PURE, ...GETTERS, ...REQUIRED, ROW, "GetXFormFieldById", "SetXFormFieldValueById",
  "AttachXFormValueChangeEventById", "Com_AddEventListener", "setTimeout", "$", "jQuery", "document", "window", "Math", "console",
  "Com_IncludeFile", "DocList_Info", "DocList_AddRow", "DocList_DeleteRow_ClearLast", "DocList_MoveRow", "XFom_RestValidationElements"]);
const ATTRS = new Set(["value", "checked", "required", "disabled", "readonly", "placeholder", "validate"]);
const canonical = value => JSON.stringify(value, (key, item) => ["start", "end", "raw"].includes(key) ? undefined : item);
const literal = value => ({ kind: "data", literal: value });
const nodes = ids => ({ kind: "nodes", ids: [...new Set(ids)] });

/** Prove a complete, bounded field/row program. This is static interpretation:
 * no source code is executed. Unknown calls, selectors, syntax or escapes fail
 * closed for the entire program; known effects protect their complete region. */
export function captionScriptScope(scripts, form, originals) {
  const targets = new Set(), rowTargets = new Set(), parentReads = new Set(), functions = new Set(), invoked = new Set();
  const globals = { env: new Map(), writable: new Set() };
  let budget = 30000, depth = 0, scriptIndex = 0;
  const fail = (reason, node, details) => { throw Object.assign(new Error(reason), { reason, nodeType: node?.type, offset: node?.start, details }); };
  const tick = node => { if (--budget < 0) fail("script_scope_budget", node); };
  const scalar = (value, node) => { if (value?.kind !== "data") fail("unproven_data_value", node); return value; };
  const string = (value, node) => { scalar(value, node); if (typeof value.literal !== "string") fail("dynamic_target_identity", node); return value.literal; };
  const merge = (a, b) => a?.kind === "nodes" && b?.kind === "nodes" ? nodes([...a.ids, ...b.ids]) :
    a?.kind === "data" && b?.kind === "data" ? a.literal === b.literal ? a : DATA : a === b ? a : NONE;
  const protect = value => { value.ids.forEach(id => targets.add(id)); return value; };

  function declare(node, scope) {
    if (node.type !== "FunctionDeclaration") return;
    if (!node.id || RESERVED.has(node.id.name)) fail("script_callee_shadowed", node);
    const existing = scope.env.get(node.id.name);
    if (existing && (existing.kind !== "function" || canonical(existing.node) !== canonical(node))) fail("script_binding_ambiguous", node);
    const fn = existing || { kind: "function", node, env: scope.env };
    scope.env.set(node.id.name, fn); functions.add(fn);
  }

  function invoke(fn, args, node) {
    if (fn?.kind !== "function" || ++depth > 12) fail("unproven_callback", node);
    invoked.add(fn);
    const scope = { env: new Map(fn.env), writable: new Set(), returns: [], functionScope: true };
    for (const [index, parameter] of fn.node.params.entries()) {
      if (parameter.type !== "Identifier" || RESERVED.has(parameter.name)) fail("script_parameter_unproven", parameter);
      scope.env.set(parameter.name, args[index] || NONE); scope.writable.add(parameter.name);
    }
    if (fn.node.body.type === "BlockStatement") block(fn.node.body.body, scope);
    else scope.returns.push(expr(fn.node.body, scope));
    depth--;
    return scope.returns.reduce(merge, scope.returns[0]) || NONE;
  }

  function member(node, scope) {
    const object = expr(node.object, scope);
    const key = node.computed ? expr(node.property, scope).literal : node.property.name;
    if (object.kind === "nodes" && Number.isInteger(key) && key >= 0) return object;
    if (object.kind === "nodes" && ["value", "checked", "name", "length", "selectedIndex"].includes(key)) return DATA;
    if (object.kind === "data" && (key === "length" || Number.isInteger(key) && key >= 0)) return DATA;
    fail("unbounded_member_access", node);
  }

  function expr(node, scope) {
    if (!node) return NONE;
    tick(node);
    switch (node.type) {
      case "Literal": return node.regex ? { kind: "regex" } : literal(node.value);
      case "Identifier": {
        if (node.name === "undefined") return NONE;
        const value = scope.env.get(node.name);
        if (!value) fail("unresolved_identifier", node);
        if (scope.functionScope && value.kind !== "function" && !scope.writable.has(node.name)) fail("unproven_closure_capture", node);
        return value;
      }
      case "FunctionExpression": case "ArrowFunctionExpression": {
        const fn = { kind: "function", node, env: new Map(scope.env) }; functions.add(fn); return fn;
      }
      case "MemberExpression": return member(node, scope);
      case "BinaryExpression": case "LogicalExpression": {
        if (["in", "instanceof"].includes(node.operator)) fail("unproven_operator", node);
        const a = scalar(expr(node.left, scope), node), b = scalar(expr(node.right, scope), node);
        if (node.operator === "+" && a.literal !== undefined && b.literal !== undefined) return literal(a.literal + b.literal);
        return DATA;
      }
      case "UnaryExpression":
        if (node.operator === "delete") fail("script_delete", node);
        { const value = expr(node.argument, scope);
          if (!["!", "typeof", "void"].includes(node.operator) || !["nodes", "none"].includes(value.kind)) scalar(value, node);
          return DATA; }
      case "ConditionalExpression":
        scalar(expr(node.test, scope), node); return merge(expr(node.consequent, scope), expr(node.alternate, scope));
      case "AssignmentExpression": fail("nested_assignment_unproven", node); break;
      case "CallExpression": return call(node, scope);
      default: fail("unmodeled_script_syntax", node);
    }
  }

  function assign(node, scope) {
    if (node.operator !== "=") fail("unproven_mutation", node);
    const value = expr(node.right, scope);
    if (node.left.type === "Identifier") {
      if (!scope.writable.has(node.left.name) || RESERVED.has(node.left.name)) fail("nonlocal_binding_write", node);
      if (!["data", "nodes", "none"].includes(value.kind)) fail("unproven_binding_value", node);
      scope.env.set(node.left.name, value); return;
    }
    scalar(value, node);
    if (node.left.type !== "MemberExpression" || node.left.computed || !ATTRS.has(node.left.property.name)) fail("unbounded_member_write", node);
    const receiver = expr(node.left.object, scope);
    if (receiver.kind !== "nodes") fail("unbounded_member_write", node);
    protect(receiver);
  }

  function call(node, scope) {
    const callee = node.callee, args = node.arguments;
    const name = callee.type === "Identifier" ? callee.name : undefined;
    if (name === "Com_AddEventListener") {
      if (args.length !== 3 || args[0].name !== "window" || string(expr(args[1], scope), node) !== "load") fail("unbounded_event_binding", node);
      return invoke(expr(args[2], scope), [], node);
    }
    if (name === "AttachXFormValueChangeEventById") {
      if (args.length !== 2) fail("unbounded_event_binding", node);
      const id = string(expr(args[0], scope), node); protect(nodes([id]));
      return invoke(expr(args[1], scope), [DATA, nodes([id])], node);
    }
    if (name === "setTimeout") {
      if (args.length !== 2 || typeof expr(args[1], scope).literal !== "number") fail("unbounded_timer", node);
      return invoke(expr(args[0], scope), [], node);
    }
    if (name === "$" || name === "jQuery") {
      if (args.length !== 1) fail("unbounded_selector", node);
      const value = expr(args[0], scope);
      if (value.kind === "function") return invoke(value, [], node);
      if (value.kind === "nodes") return value;
      const selector = string(value, node);
      const id = /^#([A-Za-z_][\w-]*)$/.exec(selector)?.[1] ||
        /^(?:(?:input|select|textarea))?\[name=(["'])extendDataFormInfo\.value\(([A-Za-z_][\w.-]*)\)\1\](?::checked)?$/.exec(selector)?.[2];
      if (!id) fail("unbounded_selector", node);
      return protect(nodes([id.replace(/\.(?:id|name)$/, "")]));
    }
    if (name === ROW) {
      if (args.length !== 4) fail("unbounded_row_helper", node);
      const id = string(expr(args[0], scope), node); args.slice(1).forEach(arg => scalar(expr(arg, scope), node));
      rowTargets.add(id); return protect(nodes([id]));
    }
    if (REQUIRED.has(name)) {
      if (args.length !== 1) fail("unbounded_required_helper", node);
      return protect(nodes([string(expr(args[0], scope), node)]));
    }
    if (name === "GetXFormFieldById" || GETTERS.has(name) || name === "SetXFormFieldValueById") {
      if (name === "SetXFormFieldValueById" ? ![2, 3].includes(args.length) ||
          args.length === 3 && expr(args[2], scope).literal !== false : args.length !== 1) fail("unbounded_field_call", node);
      const id = string(expr(args[0], scope), node);
      args.slice(1).forEach(arg => scalar(expr(arg, scope), node));
      protect(nodes([id])); return name === "GetXFormFieldById" ? nodes([id]) : DATA;
    }
    if (PURE.has(name)) { args.forEach(arg => scalar(expr(arg, scope), node)); return DATA; }
    if (callee.type === "Identifier") return invoke(expr(callee, scope), args.map(arg => expr(arg, scope)), node);
    if (callee.type !== "MemberExpression" || callee.computed) fail("unresolved_call", node);
    const method = callee.property.name;
    if (callee.object.name === "document" && method === "getElementById" && args.length === 1) {
      return protect(nodes([string(expr(args[0], scope), node)]));
    }
    if (callee.object.name === "console" && method === "log") { args.forEach(arg => expr(arg, scope)); return NONE; }
    const receiver = expr(callee.object, scope);
    if (receiver.kind === "data" && ["indexOf", "toString", "split", "replace", "trim"].includes(method)) {
      args.forEach(arg => { const value = expr(arg, scope); if (!["data", "regex"].includes(value.kind)) fail("unproven_data_method", node); }); return DATA;
    }
    if (receiver.kind === "regex" && method === "test" && args.length === 1) { scalar(expr(args[0], scope), node); return DATA; }
    if (receiver.kind !== "nodes") fail("unresolved_call", node);
    if (["val", "text", "width"].includes(method) && args.length <= 1) {
      args.forEach(arg => scalar(expr(arg, scope), node)); protect(receiver); return args.length ? receiver : DATA;
    }
    if (["show", "hide"].includes(method) && args.length === 0) return protect(receiver);
    if (["attr", "prop", "setAttribute", "removeAttr", "removeAttribute"].includes(method) && args.length >= 1 && args.length <= 2 && ATTRS.has(string(expr(args[0], scope), node))) {
      args.slice(1).forEach(arg => scalar(expr(arg, scope), node)); protect(receiver); return args.length === 1 && ["attr", "prop"].includes(method) ? DATA : receiver;
    }
    fail("unbounded_dom_operation", node);
  }

  function block(statements, scope) {
    statements.forEach(node => declare(node, scope));
    for (const node of statements) {
      tick(node);
      switch (node.type) {
        case "FunctionDeclaration": case "EmptyStatement": break;
        case "BlockStatement": block(node.body, scope); break;
        case "VariableDeclaration":
          if (node.kind !== "var") fail("lexical_binding_unproven", node);
          for (const declaration of node.declarations) {
            if (declaration.id.type !== "Identifier" || RESERVED.has(declaration.id.name) || scope.env.get(declaration.id.name)?.kind === "function") fail("script_binding_unproven", declaration);
            scope.env.set(declaration.id.name, expr(declaration.init, scope)); scope.writable.add(declaration.id.name);
          } break;
        case "ExpressionStatement":
          if (node.expression.type === "AssignmentExpression") assign(node.expression, scope);
          else expr(node.expression, scope);
          break;
        case "IfStatement": {
          const condition = expr(node.test, scope);
          if (!["data", "nodes", "none"].includes(condition.kind)) fail("unproven_condition", node);
          const a = { ...scope, env: new Map(scope.env), writable: new Set(scope.writable) };
          const b = { ...scope, env: new Map(scope.env), writable: new Set(scope.writable) };
          block([node.consequent], a); if (node.alternate) block([node.alternate], b);
          for (const key of new Set([...a.env.keys(), ...b.env.keys()])) scope.env.set(key, merge(a.env.get(key) || NONE, b.env.get(key) || NONE));
          break;
        }
        case "ReturnStatement": { const value = expr(node.argument, scope); scope.returns?.push(value); break; }
        default: fail("unmodeled_script_statement", node);
      }
    }
  }

  try {
    const texts = [...new Set(scripts.filter(Boolean))];
    const tables = form.fields.filter(field => field.type === "detailTable").map(field => field.id);
    const registration = hasStaticDoclistRegistration(texts, tables);
    const programs = texts.flatMap((text, textIndex) => {
      scriptIndex = textIndex;
      const closed = captionDoclistScope(text, tables, registration);
      if (!closed) return [{ tree: parse(text, { ecmaVersion: "latest", allowReturnOutsideFunction: true }), index: textIndex }];
      closed.targets.forEach(id => targets.add(id)); closed.parentReads.forEach(id => parentReads.add(id)); return [];
    });
    for (const program of programs) { scriptIndex = program.index; program.tree.body.forEach(node => declare(node, globals)); }
    for (const program of programs) { scriptIndex = program.index; block(program.tree.body, globals); }
    if ([...functions].some(fn => !invoked.has(fn))) fail("unbound_source_function");
    const index = buildFormRuleRefIndex(form);
    const known = new Set(originals.map(field => field.id));
    originals.flatMap(field => field.sourceProps?.staticCaptionFact?.domContext?.ancestorIds || []).forEach(id => known.add(id));
    for (const id of [...targets]) {
      const resolved = rowTargets.has(id) ? resolveSourceRowEffectTarget(form, id) : resolveEffectTarget(index, id);
      if (rowTargets.has(id) && (resolved?.source !== "rowMarker" || resolved.unresolved?.length)) fail("row_region_unproven", undefined, { targetId: id });
      if (resolved?.targets?.length) resolved.targets.forEach(target => targets.add(target.id));
      else if (!known.has(id)) fail("target_outside_export_domain", undefined, { targetId: id });
    }
    return { ok: true, targets: [...targets], parentReads: [...parentReads] };
  } catch (error) {
    return { ok: false, targets: [], issue: { reason: error.reason || "script_scope_parse_error", scriptIndex,
      nodeType: error.nodeType, offset: error.offset, ...error.details } };
  }
}
