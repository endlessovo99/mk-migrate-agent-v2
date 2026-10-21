import { parse } from "acorn";
import { buildFormRuleRefIndex, resolveEffectTarget, resolveSourceRowEffectTarget } from "../dsl/form-rules.js";
import { captionDoclistScope, hasStaticDoclistRegistration } from "./caption-doclist-scope.js";
import { pureCaptionDataHelper } from "./caption-data-helper.js";

const DATA = Object.freeze({ kind: "data" });
const NONE = Object.freeze({ kind: "none" });
const PURE = new Set(["Number", "String", "Boolean", "parseInt", "parseFloat", "isNaN", "isFinite", "alert"]);
const GETTERS = new Set(["GetXFormFieldValueById", "getFormFieldValue"]);
const ROW = "common_dom_row_set_show_required_reset";
const REQUIRED = new Set(["common_required", "common_not_required"]);
const RESERVED = new Set([...PURE, ...GETTERS, ...REQUIRED, ROW, "GetXFormFieldById", "SetXFormFieldValueById",
  "AttachXFormValueChangeEventById", "Com_AddEventListener", "setTimeout", "$", "jQuery", "document", "window", "Math", "console",
  "Com_IncludeFile", "DocList_Info", "DocList_AddRow", "DocList_DeleteRow_ClearLast", "DocList_MoveRow", "XFom_RestValidationElements", "Array", "Date", "Com_Parameter", "Attachment_ObjectInfo"]);
const ATTRS = new Set(["value", "checked", "required", "disabled", "readonly", "placeholder", "validate"]);
const MATH = new Set(["abs", "ceil", "floor", "round", "min", "max", "pow", "sqrt", "trunc"]);
const INHERITED_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);
const canonical = value => JSON.stringify(value, (key, item) => ["start", "end", "raw"].includes(key) ? undefined : item);
const literal = value => ({ kind: "data", literal: value });
const nodes = ids => ({ kind: "nodes", ids: [...new Set(ids)] });
const memberPath = node => node?.type === "Identifier" ? node.name :
  node?.type === "MemberExpression" && !node.computed && !node.optional ? `${memberPath(node.object)}.${node.property.name}` : undefined;

/** Prove a complete, bounded field/row program. This is static interpretation:
 * no source code is executed. Unknown calls, selectors, syntax or escapes fail
 * closed for the entire program; known effects protect their complete region. */
export function captionScriptScope(scripts, form, originals) {
  const targets = new Set(), rowTargets = new Set(), parentReads = new Set(), functions = new Set(), invoked = new Set();
  const writes = new Set(), dropdownAssumptions = new Set();
  const globals = { env: new Map(), writable: new Set(), constants: new Set() };
  let budget = 30000, depth = 0, scriptIndex = 0;
  const fail = (reason, node, details) => { throw Object.assign(new Error(reason), { reason, nodeType: node?.type, offset: node?.start, details }); };
  const tick = node => { if (--budget < 0) fail("script_scope_budget", node); };
  const scalar = (value, node) => { if (value?.kind !== "data") fail("unproven_data_value", node); return value; };
  const string = (value, node) => { scalar(value, node); if (typeof value.literal !== "string") fail("dynamic_target_identity", node); return value.literal; };
  const merge = (a, b) => a?.kind === "nodes" && b?.kind === "nodes" ? nodes([...a.ids, ...b.ids]) :
    a?.kind === "data" && b?.kind === "data" ? a === b ? a :
      Object.hasOwn(a, "literal") && Object.hasOwn(b, "literal") && a.literal === b.literal ? a : DATA :
    a?.kind === "date" && b?.kind === "date" ? a : a === b ? a : NONE;
  const protect = value => { value.ids.forEach(id => targets.add(id)); return value; };
  const write = value => { value.ids.forEach(id => writes.add(id)); return protect(value); };
  const attachmentIds = new Set(form.fields.filter(f => f.componentId === "xform-attach").map(f => f.id));
  const dropdowns = new Map(originals.filter(field => field.sourceType === "singleSelect" &&
    originals.filter(other => other.id === field.id).length === 1 &&
    form.fields.some(other => other.id === field.id && other.componentId === "xform-select") &&
    field.sourceProps?.runtimeSelectEmpty?.status === "proven" &&
    JSON.stringify(field.options) === JSON.stringify(field.sourceProps.runtimeSelectEmpty.options))
    .map(field => [field.id, [...new Set(["", ...field.options.map(option => option.value)])]]));

  function declare(node, scope, text) {
    if (node.type !== "FunctionDeclaration") return;
    if (!node.id || RESERVED.has(node.id.name)) fail("script_callee_shadowed", node);
    const existing = scope.env.get(node.id.name);
    if (existing && (existing.kind !== "function" || canonical(existing.node) !== canonical(node))) fail("script_binding_ambiguous", node);
    const fn = existing || { kind: "function", node, env: scope.env,
      pure: Boolean(text && pureCaptionDataHelper(text.slice(node.start, node.end), RESERVED)) };
    scope.env.set(node.id.name, fn); functions.add(fn);
  }

  function invoke(fn, args, node) {
    if (fn?.kind !== "function" || ++depth > 12) fail("unproven_callback", node);
    invoked.add(fn);
    if (fn.pure) { args.forEach(arg => scalar(arg, node)); depth--; return DATA; }
    const scope = { env: new Map(fn.env), writable: new Set(), constants: new Set(), returns: [], functionScope: true };
    for (const [index, parameter] of fn.node.params.entries()) {
      if (parameter.type !== "Identifier" || RESERVED.has(parameter.name)) fail("script_parameter_unproven", parameter);
      scope.env.set(parameter.name, args[index] || NONE); scope.writable.add(parameter.name);
    }
    if (fn.node.body.type === "BlockStatement") block(fn.node.body.body, scope, true);
    else scope.returns.push(expr(fn.node.body, scope));
    depth--;
    return scope.returns.reduce(merge, scope.returns[0]) || NONE;
  }

  function member(node, scope) {
    if (memberPath(node)?.startsWith("window.event.target.")) fail("event_target_region_unproven", node);
    if (node.object.type === "Identifier" && node.object.name === "Attachment_ObjectInfo" && node.computed) {
      const id = string(expr(node.property, scope), node);
      if (!attachmentIds.has(id)) fail("attachment_domain_unproven", node, { targetId: id });
      protect(nodes([id])); return { kind: "attachment" };
    }
    const object = expr(node.object, scope);
    const keyValue = node.computed ? expr(node.property, scope) : literal(node.property.name);
    const key = keyValue.literal;
    if (object.kind === "record") {
      const keys = typeof key === "string" ? [key] : keyValue.options;
      if (!keys?.length || keys.some(key => typeof key !== "string" || INHERITED_KEYS.has(key))) fail("record_key_unproven", node);
      if (keyValue.dropdownId) dropdownAssumptions.add(keyValue.dropdownId);
      return keys.length === 1 ? object.values.get(keys[0]) || DATA : DATA;
    }
    if (object.kind === "nodes" && Number.isInteger(key) && key >= 0) return object;
    if (object.kind === "nodes" && ["value", "checked", "name", "length", "selectedIndex"].includes(key)) return DATA;
    if (object.kind === "data" && (key === "length" || Number.isInteger(key) && key >= 0)) return DATA;
    if (object.kind === "array" && key === "length") return literal(object.elements.length);
    if (object.kind === "array" && Number.isInteger(key) && key >= 0) return object.elements[key] || NONE;
    if (object.kind === "attachment" && key === "fileList") return { kind: "attachmentFiles" };
    if (object.kind === "attachmentFiles" && key === "length") return DATA;
    fail("unbounded_member_access", node);
  }

  function expr(node, scope) {
    if (!node) return NONE;
    tick(node);
    switch (node.type) {
      case "Literal": return node.regex ? { kind: "regex" } : literal(node.value);
      case "ArrayExpression": return { kind: "array", elements: node.elements.map(item => {
        const value = expr(item, scope); return value.kind === "date" ? value : scalar(value, node);
      }) };
      case "ObjectExpression": {
        const values = new Map();
        for (const p of node.properties) {
          const key = p.key?.type === "Identifier" ? p.key.name : p.key?.type === "Literal" ? p.key.value : undefined;
          if (p.type !== "Property" || p.kind !== "init" || p.computed || p.method || p.shorthand || typeof key !== "string" ||
              INHERITED_KEYS.has(key) || values.has(key) || p.value.type !== "Literal" || p.value.regex ||
              p.value.value !== null && !["string", "number", "boolean"].includes(typeof p.value.value)) fail("record_value_unproven", node);
          values.set(key, literal(p.value.value));
        }
        return { kind: "record", values };
      }
      case "TemplateLiteral":
        node.expressions.forEach(item => scalar(expr(item, scope), node));
        return node.expressions.length ? DATA : literal(node.quasis[0].value.cooked);
      case "NewExpression":
        if (node.callee.type !== "Identifier" || node.callee.name !== "Date" || node.arguments.length > 1) fail("unmodeled_constructor", node);
        node.arguments.forEach(arg => scalar(expr(arg, scope), node));
        return { kind: "date" };
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
        const a = expr(node.left, scope), b = expr(node.right, scope);
        if (![a.kind, b.kind].every(kind => ["data", "date"].includes(kind))) fail("unproven_data_value", node);
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
      if (!scope.writable.has(node.left.name) || scope.constants.has(node.left.name) || RESERVED.has(node.left.name)) fail("nonlocal_binding_write", node);
      if (!["data", "nodes", "none", "date", "array"].includes(value.kind)) fail("unproven_binding_value", node);
      scope.env.set(node.left.name, value); return;
    }
    scalar(value, node);
    if (node.left.type !== "MemberExpression" || node.left.computed || !ATTRS.has(node.left.property.name)) fail("unbounded_member_write", node);
    const receiver = expr(node.left.object, scope);
    if (receiver.kind !== "nodes") fail("unbounded_member_write", node);
    write(receiver);
  }

  function call(node, scope) {
    const callee = node.callee, args = node.arguments;
    if (memberPath(callee) === "Com_Parameter.event.submit.push") {
      if (args.length !== 1) fail("unbounded_submit_binding", node);
      invoke(expr(args[0], scope), [], node); return NONE;
    }
    const name = callee.type === "Identifier" ? callee.name : undefined;
    if (name === "Com_AddEventListener") {
      if (args.length !== 3 || args[0].name !== "window" || string(expr(args[1], scope), node) !== "load") fail("unbounded_event_binding", node);
      return invoke(expr(args[2], scope), [], node);
    }
    if (name === "AttachXFormValueChangeEventById") {
      if (args.length !== 2) fail("unbounded_event_binding", node);
      const id = string(expr(args[0], scope), node); protect(nodes([id]));
      const value = dropdowns.has(id) ? { kind: "data", options: dropdowns.get(id), dropdownId: id } : DATA;
      return invoke(expr(args[1], scope), [value, nodes([id])], node);
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
      rowTargets.add(id); return write(nodes([id]));
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
      (name === "SetXFormFieldValueById" ? write : protect)(nodes([id])); return name === "GetXFormFieldById" ? nodes([id]) : DATA;
    }
    if (PURE.has(name)) { args.forEach(arg => scalar(expr(arg, scope), node)); return DATA; }
    if (callee.type === "Identifier") return invoke(expr(callee, scope), args.map(arg => expr(arg, scope)), node);
    if (callee.type !== "MemberExpression" || callee.computed) fail("unresolved_call", node);
    const method = callee.property.name;
    if (callee.object.name === "Math" && MATH.has(method)) {
      args.forEach(arg => scalar(expr(arg, scope), node)); return DATA;
    }
    if (callee.object.name === "document" && method === "getElementById" && args.length === 1) {
      return protect(nodes([string(expr(args[0], scope), node)]));
    }
    if (callee.object.name === "console" && method === "log") { args.forEach(arg => expr(arg, scope)); return NONE; }
    const receiver = expr(callee.object, scope);
    if (receiver.kind === "array" && method === "some" && args.length === 1) {
      const fn = expr(args[0], scope);
      for (const [index, value] of receiver.elements.entries()) invoke(fn, [value, literal(index), receiver], node);
      return DATA;
    }
    if (receiver.kind === "array" && ["indexOf", "includes", "join", "toString"].includes(method)) {
      args.forEach(arg => scalar(expr(arg, scope), node)); return DATA;
    }
    if (receiver.kind === "date" && ["getTime", "getFullYear", "getMonth", "getDate"].includes(method) && args.length === 0) return DATA;
    if (receiver.kind === "data" && ["indexOf", "toString", "split", "replace", "trim", "padStart"].includes(method)) {
      args.forEach(arg => { const value = expr(arg, scope); if (!["data", "regex"].includes(value.kind)) fail("unproven_data_method", node); }); return DATA;
    }
    if (receiver.kind === "regex" && method === "test" && args.length === 1) { scalar(expr(args[0], scope), node); return DATA; }
    if (receiver.kind !== "nodes") fail("unresolved_call", node);
    if (["val", "text", "width"].includes(method) && args.length <= 1) {
      args.forEach(arg => scalar(expr(arg, scope), node)); (args.length ? write : protect)(receiver); return args.length ? receiver : DATA;
    }
    if (["show", "hide"].includes(method) && args.length === 0) return protect(receiver);
    if (["attr", "prop", "setAttribute", "removeAttr", "removeAttribute"].includes(method) && args.length >= 1 && args.length <= 2 && ATTRS.has(string(expr(args[0], scope), node))) {
      args.slice(1).forEach(arg => scalar(expr(arg, scope), node));
      (args.length === 1 && ["attr", "prop"].includes(method) ? protect : write)(receiver);
      return args.length === 1 && ["attr", "prop"].includes(method) ? DATA : receiver;
    }
    fail("unbounded_dom_operation", node);
  }

  function block(statements, scope, allowConst = false) {
    statements.forEach(node => declare(node, scope));
    for (const node of statements) {
      tick(node);
      switch (node.type) {
        case "FunctionDeclaration": case "EmptyStatement": break;
        case "BlockStatement": block(node.body, scope); break;
        case "VariableDeclaration":
          if (node.kind !== "var" && !(node.kind === "const" && allowConst)) fail("lexical_binding_unproven", node);
          for (const declaration of node.declarations) {
            if (declaration.id.type !== "Identifier" || RESERVED.has(declaration.id.name) || scope.constants.has(declaration.id.name) ||
                node.kind === "const" && scope.writable.has(declaration.id.name) || scope.env.get(declaration.id.name)?.kind === "function") fail("script_binding_unproven", declaration);
            scope.env.set(declaration.id.name, expr(declaration.init, scope)); scope.writable.add(declaration.id.name);
            if (node.kind === "const") scope.constants.add(declaration.id.name);
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
    for (const program of programs) { scriptIndex = program.index; program.tree.body.forEach(node => declare(node, globals, texts[program.index])); }
    for (const program of programs) { scriptIndex = program.index; block(program.tree.body, globals, true); }
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
    for (const id of writes) {
      const resolved = rowTargets.has(id) ? resolveSourceRowEffectTarget(form, id) : resolveEffectTarget(index, id);
      if ([id, ...(resolved?.targets || []).map(target => target.id)].some(id => dropdownAssumptions.has(id)))
        fail("dropdown_domain_mutated", undefined, { targetId: id });
    }
    return { ok: true, targets: [...targets], parentReads: [...parentReads] };
  } catch (error) {
    return { ok: false, targets: [], issue: { reason: error.reason || "script_scope_parse_error", scriptIndex,
      nodeType: error.nodeType, offset: error.offset, ...error.details } };
  }
}
