import { parse } from "acorn";
import { buildFormRuleRefIndex, resolveEffectTarget } from "../dsl/form-rules.js";
import { captionDoclistScope, hasStaticDoclistRegistration } from "./caption-doclist-scope.js";
import { pureCaptionDataHelper } from "./caption-data-helper.js";
import { jqueryRadioClearPair } from "./inline-radio-row-effects.js";
import { captionRowRegion } from "./caption-row-scope.js";
import { captionNativeCurrencyScope } from "./caption-native-currency-scope.js";
import { captionNativeAttachmentScope } from "./caption-native-attachment-scope.js";
import { captionSharedScalars, captionFunctionBindings } from "./caption-shared-scalar-scope.js";
import { sourceFormValueReader } from "./source-form-value-reader.js";
import { captionImpactNodeKey } from "./caption-json-impact.js";
import { captionDataLoop } from "./caption-data-loop.js";
import { sourceTablePollEffect } from "./source-table-poll.js";
import { sourceDetailSumReader, sourceDecimalRounder, sourceFilteredDetailAggregate } from "./source-detail-data-reader.js";

const DATA = Object.freeze({ kind: "data" });
const NONE = Object.freeze({ kind: "none" });
const PURE = new Set(["Number", "String", "Boolean", "parseInt", "parseFloat", "isNaN", "isFinite", "alert"]);
const GETTERS = new Set(["GetXFormFieldValueById", "getFormFieldValue"]);
const SOURCE_GETTERS = new Set(["getFormFieldValue"]);
const ROW = "common_dom_row_set_show_required_reset";
const REQUIRED = new Set(["common_required", "common_not_required"]);
const RESERVED = new Set([...PURE, ...GETTERS, ...REQUIRED, ROW, "GetXFormFieldById", "SetXFormFieldValueById",
  "AttachXFormValueChangeEventById", "Com_AddEventListener", "setTimeout", "$", "jQuery", "document", "window", "Math", "console",
  "Com_IncludeFile", "DocList_Info", "DocList_AddRow", "DocList_DeleteRow_ClearLast", "DocList_MoveRow", "XFom_RestValidationElements", "Array", "Date", "Com_Parameter", "Attachment_ObjectInfo", "XForm_GetChinaValue"]);
const ATTRS = new Set(["value", "checked", "required", "disabled", "readonly", "placeholder", "validate"]);
const MATH = new Set(["abs", "ceil", "floor", "round", "min", "max", "pow", "sqrt", "trunc"]);
const INHERITED_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);
const canonical = value => JSON.stringify(value, (key, item) => ["start", "end", "raw"].includes(key) ? undefined : item);
const literal = value => ({ kind: "data", literal: value });
const nodes = ids => ({ kind: "nodes", ids: [...new Set(ids)] });
const memberPath = node => node?.type === "Identifier" ? node.name :
  node?.type === "MemberExpression" && !node.optional && (!node.computed || node.property.type === "Literal" && typeof node.property.value === "string")
    ? `${memberPath(node.object)}.${node.computed ? node.property.value : node.property.name}` : undefined;

/** Prove a complete, bounded field/row program. This is static interpretation:
 * no source code is executed. Unknown calls, selectors, syntax or escapes fail
 * closed for the entire program; known effects protect their complete region. */
export function captionScriptScope(scripts, form, originals, { auditedOrphans = new Map(), sharedScalarPrograms = scripts, jsonImpact, helperUnits = new Map() } = {}) {
  const targets = new Set(), rowTargets = new Set(), parentReads = new Set(), functions = new Set(), invoked = new Set();
  const observedFunctionReferences = new Set();
  const presentationTargets = new Set(), dataTargets = new Set(), rowEffectTargets = new Set();
  const writes = new Set(), dropdownAssumptions = new Set();
  const inertSubmitScratch = [];
  const inertRowNoops = [];
  const nativeCurrencyBindings = [];
  const attachmentBindings = [];
  const sourceValueReads = [];
  const dataLoops = [];
  const tablePollEffects = [];
  const registeredTables = new Set();
  const detailDataReads = [];
  const targetOrigins = new Map();
  const globals = { env: new Map(), writable: new Set(), constants: new Set() };
  let sharedScalars = new Map();
  const sharedValue = name => ({ kind: "data", sharedScalar: name });
  let budget = 30000, depth = 0, scriptIndex = 0;
  const fail = (reason, node, details) => { throw Object.assign(new Error(reason), { reason, nodeType: node?.type, offset: node?.start, details }); };
  const tick = node => { if (--budget < 0) fail("script_scope_budget", node); };
  const scalar = (value, node) => { if (value?.kind !== "data") fail("unproven_data_value", node); return value; };
  const string = (value, node) => { scalar(value, node); if (typeof value.literal !== "string") fail("dynamic_target_identity", node); return value.literal; };
  // Only source-complete data readers use this domain.
  // It does not make a shared initializer the current value, nor lend a node
  // handle or a concrete identity to arbitrary consumers.
  const readDomain = (value, node) => {
    scalar(value, node);
    const domain = typeof value.literal === "string" ? [value.literal] : sharedScalars.get(value.sharedScalar)?.readonlyLiterals;
    if (!domain?.length || domain.some(id => typeof id !== "string")) fail("dynamic_target_identity", node);
    return domain;
  };
  const merge = (a, b) => a?.kind === "nodes" && b?.kind === "nodes" ? nodes([...a.ids, ...b.ids]) :
    a?.kind === "data" && b?.kind === "data" ? a === b ? a :
      a.sharedScalar && a.sharedScalar === b.sharedScalar ? a :
      Object.hasOwn(a, "literal") && Object.hasOwn(b, "literal") && a.literal === b.literal ? a : DATA :
    a?.kind === "date" && b?.kind === "date" ? a : a === b ? a : NONE;
  const protect = (value, kind = "presentation", node) => {
    value.ids.forEach(id => {
      targets.add(id); (kind === "data" ? dataTargets : kind === "row" ? rowEffectTargets : presentationTargets).add(id);
      if (node && !targetOrigins.has(id)) targetOrigins.set(id, { scriptIndex, nodeType: node.type, start: node.start });
    }); return value;
  };
  const data = (value, node) => protect(value, "data", node);
  const write = (value, kind = "presentation", node) => { value.ids.forEach(id => writes.add(id)); return protect(value, kind, node); };
  const dataWrite = (value, node) => write(value, "data", node);
  const attachmentIds = new Set(form.fields.filter(f => f.componentId === "xform-attach").map(f => f.id));
  const dropdowns = new Map(originals.filter(field => field.sourceType === "singleSelect" &&
    originals.filter(other => other.id === field.id).length === 1 &&
    form.fields.some(other => other.id === field.id && other.componentId === "xform-select") &&
    field.sourceProps?.runtimeSelectEmpty?.status === "proven" &&
    JSON.stringify(field.options) === JSON.stringify(field.sourceProps.runtimeSelectEmpty.options))
    .map(field => [field.id, [...new Set(["", ...field.options.map(option => option.value)])]]));

  function declare(node, scope, text) {
    if (node.type !== "FunctionDeclaration") return;
    if (!node.id || RESERVED.has(node.id.name) && !SOURCE_GETTERS.has(node.id.name)) fail("script_callee_shadowed", node);
    const existing = scope.env.get(node.id.name);
    if (existing?.kind !== undefined && existing.kind !== "function") fail("script_binding_ambiguous", node);
    const variants = existing ? existing.variants || [existing] : [];
    if (variants.some(fn => canonical(fn.node) === canonical(node))) return;
    if (existing && (!text || !existing.programDeclaration)) fail("script_binding_ambiguous", node);
    const fn = { kind: "function", node, env: scope.env, scriptIndex, programDeclaration: Boolean(text),
      jsonReader: jsonImpact?.readers.get(captionImpactNodeKey(scriptIndex, node)),
      valueReader: sourceFormValueReader(node, RESERVED),
      tablePoll: text && sourceTablePollEffect(node),
      detailSum: sourceDetailSumReader(node, RESERVED),
      filteredAggregate: sourceFilteredDetailAggregate(node, RESERVED),
      decimalRounder: sourceDecimalRounder(node, RESERVED),
      pure: Boolean(text && pureCaptionDataHelper(text.slice(node.start, node.end), RESERVED)) };
    scope.env.set(node.id.name, existing
      ? { kind: "function", variants: [...variants, fn], programDeclaration: true } : fn);
    functions.add(fn);
  }

  function invoke(fn, args, node, submit = false) {
    // A global name can denote any declaration during immediate or delayed
    // execution. Prove every body and join its result; never select a winner.
    if (fn?.variants) return fn.variants.map(variant => invoke(variant, args, node, submit)).reduce(merge);
    if (fn?.kind !== "function" || ++depth > 12) fail("unproven_callback", node);
    invoked.add(fn);
    if (fn.detailSum || fn.filteredAggregate) {
      const aggregate = fn.filteredAggregate, contract = aggregate || fn.detailSum;
      if (args.length !== (aggregate ? 4 : 2)) fail("detail_read_arguments_unproven", node);
      [args[0], args[1], ...(aggregate ? [args[3]] : [])].forEach(arg => scalar(arg, node));
      const domain = typeof args[0].literal === "string" ? [args[0].literal] : sharedScalars.get(args[0].sharedScalar)?.readonlyLiterals;
      const columnId = string(args[1], node), rounding = fn.env.get(contract.roundingFunction);
      const roundingVariants = rounding?.variants || (rounding ? [rounding] : []);
      if (!domain?.length || domain.some(id => typeof id !== "string") || !roundingVariants.length || roundingVariants.some(helper => !helper.pure && !helper.decimalRounder))
        fail("detail_read_dependency_unproven", node);
      for (const tableId of domain) {
        const tables = form.fields.filter(field => field.type === "detailTable" && field.id === tableId);
        const columns = tables[0]?.columns?.filter(field => field.id === columnId && !["description", "button", "detailTable"].includes(field.type));
        if (tables.length !== 1 || columns?.length !== 1 || !registeredTables.has(tableId)) fail("detail_read_domain_unproven", node);
        if (aggregate && tables[0].columns.filter(field => field.id === aggregate.radioColumnId && field.type === "radio").length !== 1)
          fail("detail_read_domain_unproven", node);
        data(nodes([tableId, columnId]), node);
        if (aggregate) data(nodes([aggregate.radioColumnId]), node);
      }
      if (aggregate) {
        const ids = args[2]?.kind === "nodes" && [...args[2].ids, aggregate.counterId];
        if (!ids?.length || ids.some(id => form.fields.filter(field => field.id === id && !["description", "button", "detailTable"].includes(field.type)).length !== 1))
          fail("detail_output_domain_unproven", node);
        dataWrite(nodes(ids), node);
      }
      roundingVariants.forEach(helper => invoked.add(helper));
      detailDataReads.push({ scriptIndex, offset: node.start, tableDomain: domain, columnId,
        ...(aggregate ? { radioColumnId: aggregate.radioColumnId, counterId: aggregate.counterId } : {}),
        basis: aggregate ? "complete-source-filtered-detail-aggregate" : "complete-source-detail-value-sum" });
      depth--; return DATA;
    }
    if (fn.tablePoll && registeredTables.has(fn.tablePoll.tableId)) {
      const self = fn.env.get(fn.node.id.name);
      if (self !== fn) fail("poll_callback_binding_unproven", node);
      args.forEach(arg => scalar(arg, node));
      const table = form.fields.find(field => field.id === fn.tablePoll.tableId && field.type === "detailTable");
      protect(nodes([table.id, ...(table.columns || []).map(field => field.id)]), "presentation", node);
      tablePollEffects.push({ scriptIndex, offset: node.start, functionName: fn.node.id.name, ...fn.tablePoll,
        basis: "complete-fixed-table-polling-effect-union" });
      depth--; return literal(undefined);
    }
    if (fn.jsonReader) {
      args.forEach(arg => scalar(arg, node)); data(nodes([fn.jsonReader.fieldId]), node);
      depth--; return literal(undefined);
    }
    if (fn.valueReader) {
      args.forEach(arg => scalar(arg, node));
      // This source getter returns values only. It does not lend its internal
      // DOM collection to callers or bypass identity/domain checks for writes.
      for (const input of readDomain(args[0] || literal(undefined), node)) {
        const id = /^extendDataFormInfo\.value\(([A-Za-z_][\w.-]*)\)$/.exec(input)?.[1] || input;
        const fields = originals.filter(field => field.id === id);
        if (!fields.length) fail("dynamic_target_identity", node, { targetId: id });
        if (fields.some(field => field.sourceType === "description")) protect(nodes([id]), "presentation", node);
        else data(nodes([id]), node);
        sourceValueReads.push({ lookup: input, fieldId: id, scriptIndex, offset: node.start,
          declarationScriptIndex: fn.scriptIndex, declarationOffset: fn.node.start, basis: "complete-source-form-value-reader" });
      }
      depth--; return DATA;
    }
    if (fn.pure) { args.forEach(arg => scalar(arg, node)); depth--; return DATA; }
    const callerScriptIndex = scriptIndex;
    scriptIndex = fn.scriptIndex ?? scriptIndex;
    const ignored = submit ? unusedSubmitButtonScratch(fn.node, RESERVED) : [];
    inertSubmitScratch.push(...ignored.map(pair => ({ scriptIndex, variable: pair.variable,
      declarationStart: pair.declaration.start, fallbackStart: pair.fallback.start,
      basis: "unused-local-submit-button-scratch" })));
    const scope = { env: new Map(fn.env), writable: new Set(), constants: new Set(), returns: [], functionScope: true,
      ignoredStatements: new Set(ignored.flatMap(pair => [pair.declaration, pair.fallback])),
      localBindings: captionFunctionBindings(fn.node) };
    for (const [index, parameter] of fn.node.params.entries()) {
      if (parameter.type !== "Identifier" || RESERVED.has(parameter.name)) fail("script_parameter_unproven", parameter);
      // An omitted argument is the known primitive undefined. NONE remains an
      // unproven union/return sentinel and must not become trusted scalar data.
      scope.env.set(parameter.name, index < args.length ? args[index] : literal(undefined)); scope.writable.add(parameter.name);
    }
    if (fn.node.body.type === "BlockStatement") block(fn.node.body.body, scope, true);
    else scope.returns.push(expr(fn.node.body, scope));
    depth--;
    scriptIndex = callerScriptIndex;
    return scope.returns.length ? scope.returns.reduce(merge, scope.returns[0]) : literal(undefined);
  }

  function member(node, scope) {
    if (memberPath(node)?.startsWith("window.event.target.")) fail("event_target_region_unproven", node);
    if (node.object.type === "Identifier" && node.object.name === "Attachment_ObjectInfo" && node.computed) {
      const id = string(expr(node.property, scope), node);
      if (!attachmentIds.has(id)) fail("attachment_domain_unproven", node, { targetId: id });
      data(nodes([id]), node); return { kind: "attachment" };
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
    if (object.kind === "scalarArray" && (key === "length" || keyValue.arrayIndex || Number.isInteger(key) && key >= 0)) return DATA;
    if (object.kind === "attachment" && key === "fileList") return { kind: "attachmentFiles" };
    if (object.kind === "attachmentFiles" && key === "length") return DATA;
    fail("unbounded_member_access", node);
  }

  function expr(node, scope) {
    if (!node) return NONE;
    tick(node);
    const jsonRead = jsonImpact?.values.get(captionImpactNodeKey(scriptIndex, node));
    if (jsonRead) { data(nodes([jsonRead.fieldId]), node); return DATA; }
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
        if (node.callee.type === "Identifier" && node.callee.name === "Array" && node.arguments.length === 0)
          return { kind: "array", elements: [] };
        if (node.callee.type !== "Identifier" || node.callee.name !== "Date" || node.arguments.length > 1) fail("unmodeled_constructor", node);
        node.arguments.forEach(arg => scalar(expr(arg, scope), node));
        return { kind: "date" };
      case "Identifier": {
        if (node.name === "undefined") return NONE;
        const value = scope.env.get(node.name);
        if (!value) fail("unresolved_identifier", node);
        if (value.kind === "function") for (const fn of value.variants || [value]) observedFunctionReferences.add(fn);
        if (scope.functionScope && value.kind !== "function" && !scope.writable.has(node.name) &&
            !(value.sharedScalar === node.name && !scope.localBindings.has(node.name))) fail("unproven_closure_capture", node);
        return value;
      }
      case "FunctionExpression": case "ArrowFunctionExpression": {
        const fn = { kind: "function", node, env: new Map(scope.env), scriptIndex }; functions.add(fn); return fn;
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
        // typeof may inspect an unbound identifier without a ReferenceError.
        // Keep its type unknown and analyze both branches. An actual read,
        // member access, call or accessor definition still needs its own proof.
        if (node.operator === "typeof" && node.argument.type === "Identifier" && !scope.env.has(node.argument.name)) return DATA;
        { const value = expr(node.argument, scope);
          if (!["!", "typeof", "void"].includes(node.operator) || !["nodes", "none"].includes(value.kind)) scalar(value, node);
          return DATA; }
      case "ConditionalExpression":
        predicate(node.test, scope); return merge(expr(node.consequent, scope), expr(node.alternate, scope));
      case "AssignmentExpression": fail("nested_assignment_unproven", node); break;
      case "UpdateExpression": {
        const name = node.argument?.type === "Identifier" && node.argument.name, value = name && scope.env.get(name);
        if (!name || !["++", "--"].includes(node.operator) || !scope.writable.has(name) || scope.constants.has(name) ||
            RESERVED.has(name) || value?.kind !== "data") fail("unproven_mutation", node);
        scope.env.set(name, value.sharedScalar ? sharedValue(name) : DATA); return DATA;
      }
      case "CallExpression": return call(node, scope);
      default: fail("unmodeled_script_syntax", node);
    }
  }

  // A collection can be tested for truth without becoming scalar field data.
  // Visit both operands and both branches; this is an impact union, never an
  // execution shortcut or permission to pass node handles into scalar APIs.
  function predicate(node, scope) {
    if (node.type === "LogicalExpression" && ["&&", "||"].includes(node.operator)) {
      tick(node); predicate(node.left, scope); predicate(node.right, scope); return;
    }
    const value = expr(node, scope);
    if (!["data", "nodes", "none"].includes(value.kind)) fail("unproven_condition", node);
  }

  function assign(node, scope) {
    if (node.operator !== "=") fail("unproven_mutation", node);
    const value = expr(node.right, scope);
    if (node.left.type === "Identifier") {
      const shared = scope.env.get(node.left.name)?.sharedScalar === node.left.name &&
        (!scope.functionScope || !scope.localBindings.has(node.left.name));
      if (shared) {
        if (!["data", "none"].includes(value.kind)) fail("shared_scalar_escape", node);
        scope.env.set(node.left.name, sharedValue(node.left.name)); return;
      }
      if (!scope.writable.has(node.left.name) || scope.constants.has(node.left.name) || RESERVED.has(node.left.name)) fail("nonlocal_binding_write", node);
      if (!["data", "nodes", "none", "date", "array", "scalarArray"].includes(value.kind)) fail("unproven_binding_value", node);
      scope.env.set(node.left.name, value); return;
    }
    scalar(value, node);
    if (node.left.type !== "MemberExpression" || node.left.computed || !ATTRS.has(node.left.property.name)) fail("unbounded_member_write", node);
    const receiver = expr(node.left.object, scope);
    if (receiver.kind !== "nodes") fail("unbounded_member_write", node);
    dataWrite(receiver, node);
  }

  function call(node, scope) {
    const callee = node.callee, args = node.arguments;
    if (memberPath(callee) === "Com_Parameter.event.submit.push") {
      if (args.length !== 1) fail("unbounded_submit_binding", node);
      invoke(expr(args[0], scope), [], node, true); return NONE;
    }
    const name = callee.type === "Identifier" ? callee.name : undefined;
    // Source declarations override a modeled convenience getter. Prove the
    // actual body and its effects instead of silently using the SDK contract.
    if (SOURCE_GETTERS.has(name) && scope.env.has(name))
      return invoke(expr(callee, scope), args.map(arg => expr(arg, scope)), node);
    if (name === "Com_AddEventListener") {
      if (args.length !== 3 || args[0].name !== "window" || string(expr(args[1], scope), node) !== "load") fail("unbounded_event_binding", node);
      return invoke(expr(args[2], scope), [], node);
    }
    if (name === "AttachXFormValueChangeEventById") {
      if (args.length !== 2) fail("unbounded_event_binding", node);
      const id = string(expr(args[0], scope), node); data(nodes([id]), node);
      const value = dropdowns.has(id) ? { kind: "data", options: dropdowns.get(id), dropdownId: id } : DATA;
      return invoke(expr(args[1], scope), [value, nodes([id])], node);
    }
    if (name === "setTimeout") {
      if (args.length !== 2 || typeof expr(args[1], scope).literal !== "number") fail("unbounded_timer", node);
      return invoke(expr(args[0], scope), [], node);
    }
    if (name === "XForm_GetChinaValue" && nativeCurrencyBindings.length) {
      if (args.length !== 1) fail("currency_conversion_arguments_unproven", node);
      scalar(expr(args[0], scope), node); return DATA;
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
      return data(nodes([id.replace(/\.(?:id|name)$/, "")]), node);
    }
    if (name === ROW) {
      if (args.length !== 4) fail("unbounded_row_helper", node);
      const id = string(expr(args[0], scope), node), values = args.slice(1).map(arg => scalar(expr(arg, scope), node));
      const audit = auditedOrphans.get(id);
      if (audit && args[0].type === "Literal" && values.every(value => typeof value.literal === "boolean") &&
          audit.resetValues.has(values[2].literal)) {
        inertRowNoops.push({ marker: id, reset: values[2].literal, scriptIndex, offset: node.start,
          sourceRefs: [...audit.sourceRefs], basis: "rebuilt-source-orphan-noop" });
        return NONE;
      }
      rowTargets.add(id); return write(nodes([id]), "row", node);
    }
    if (REQUIRED.has(name)) {
      if (args.length !== 1) fail("unbounded_required_helper", node);
      return data(nodes([string(expr(args[0], scope), node)]), node);
    }
    if (name === "GetXFormFieldById" || GETTERS.has(name) || name === "SetXFormFieldValueById") {
      if (name === "SetXFormFieldValueById" ? ![2, 3].includes(args.length) ||
          args.length === 3 && expr(args[2], scope).literal !== false : args.length !== 1) fail("unbounded_field_call", node);
      const id = string(expr(args[0], scope), node);
      args.slice(1).forEach(arg => scalar(expr(arg, scope), node));
      (name === "SetXFormFieldValueById" ? dataWrite : data)(nodes([id]), node); return name === "GetXFormFieldById" ? nodes([id]) : DATA;
    }
    if (PURE.has(name)) { args.forEach(arg => scalar(expr(arg, scope), node)); return DATA; }
    if (callee.type === "Identifier") return invoke(expr(callee, scope), args.map(arg => expr(arg, scope)), node);
    if (["FunctionExpression", "ArrowFunctionExpression"].includes(callee.type))
      return invoke(expr(callee, scope), args.map(arg => expr(arg, scope)), node);
    if (callee.type !== "MemberExpression" || callee.computed) fail("unresolved_call", node);
    const method = callee.property.name;
    if (callee.object.name === "Math" && MATH.has(method)) {
      args.forEach(arg => scalar(expr(arg, scope), node)); return DATA;
    }
    if (callee.object.name === "document" && method === "getElementById" && args.length === 1) {
      return data(nodes([string(expr(args[0], scope), node)]), node);
    }
    if (callee.object.name === "console" && method === "log") { args.forEach(arg => expr(arg, scope)); return NONE; }
    const receiver = expr(callee.object, scope);
    if (receiver.kind === "array" && method === "some" && args.length === 1) {
      const fn = expr(args[0], scope);
      for (const [index, value] of receiver.elements.entries()) invoke(fn, [value, literal(index), receiver], node);
      return DATA;
    }
    if (["array", "scalarArray"].includes(receiver.kind) && ["indexOf", "includes", "join", "toString"].includes(method)) {
      args.forEach(arg => scalar(expr(arg, scope), node)); return DATA;
    }
    if (receiver.kind === "date" && ["getTime", "getFullYear", "getMonth", "getDate"].includes(method) && args.length === 0) return DATA;
    if (receiver.kind === "date" && ["setTime", "setHours", "setMinutes", "setSeconds", "setMilliseconds"].includes(method) && args.length <= 4) {
      args.forEach(arg => scalar(expr(arg, scope), node)); return DATA;
    }
    if (receiver.kind === "data" && ["indexOf", "toString", "split", "replace", "trim", "padStart", "toFixed"].includes(method)) {
      args.forEach(arg => { const value = expr(arg, scope); if (!["data", "regex"].includes(value.kind)) fail("unproven_data_method", node); });
      return method === "split" ? { kind: "scalarArray" } : DATA;
    }
    if (receiver.kind === "regex" && method === "test" && args.length === 1) { scalar(expr(args[0], scope), node); return DATA; }
    if (receiver.kind !== "nodes") fail("unresolved_call", node);
    if (["val", "text", "width"].includes(method) && args.length <= 1) {
      args.forEach(arg => scalar(expr(arg, scope), node));
      (method === "val" ? args.length ? dataWrite : data : args.length ? write : protect)(receiver);
      return args.length ? receiver : DATA;
    }
    if (["show", "hide"].includes(method) && args.length === 0) return protect(receiver);
    if (["attr", "prop", "setAttribute", "removeAttr", "removeAttribute"].includes(method) && args.length >= 1 && args.length <= 2 && ATTRS.has(string(expr(args[0], scope), node))) {
      args.slice(1).forEach(arg => scalar(expr(arg, scope), node));
      (args.length === 1 && ["attr", "prop"].includes(method) ? data : dataWrite)(receiver);
      return args.length === 1 && ["attr", "prop"].includes(method) ? DATA : receiver;
    }
    fail("unbounded_dom_operation", node);
  }

  function block(statements, scope, allowConst = false, predeclared = false) {
    if (!predeclared) statements.forEach(node => declare(node, scope));
    for (let index = 0; index < statements.length; index++) {
      const node = statements[index];
      tick(node);
      const jsonStatement = jsonImpact?.skip.get(captionImpactNodeKey(scriptIndex, node));
      if (jsonStatement) {
        data(nodes([jsonStatement.fieldId]), node);
        if (jsonStatement.invokedReader) for (const fn of functions)
          if (fn.jsonReader && canonical(fn.node) === jsonStatement.invokedReader) invoked.add(fn);
        continue;
      }
      if (scope.ignoredStatements?.has(node)) continue;
      const cleared = jqueryRadioClearPair(node, statements[index + 1], form);
      if (cleared) { tick(statements[++index]); dataWrite(nodes([cleared.fieldId]), node); continue; }
      switch (node.type) {
        case "FunctionDeclaration": case "EmptyStatement": break;
        case "BlockStatement": block(node.body, scope); break;
        case "VariableDeclaration":
          if (node.kind !== "var" && !(node.kind === "const" && allowConst)) fail("lexical_binding_unproven", node);
          for (const declaration of node.declarations) {
            if (declaration.id.type !== "Identifier" || RESERVED.has(declaration.id.name) || scope.constants.has(declaration.id.name) ||
                node.kind === "const" && scope.writable.has(declaration.id.name) || scope.env.get(declaration.id.name)?.kind === "function") fail("script_binding_unproven", declaration);
            const value = expr(declaration.init, scope);
            scope.env.set(declaration.id.name, scope === globals && sharedScalars.has(declaration.id.name) ? sharedValue(declaration.id.name) : value);
            scope.writable.add(declaration.id.name);
            if (node.kind === "const") scope.constants.add(declaration.id.name);
          } break;
        case "ExpressionStatement":
          if (node.expression.type === "AssignmentExpression") assign(node.expression, scope);
          else expr(node.expression, scope);
          break;
        case "IfStatement": {
          predicate(node.test, scope);
          const a = { ...scope, env: new Map(scope.env), writable: new Set(scope.writable) };
          const b = { ...scope, env: new Map(scope.env), writable: new Set(scope.writable) };
          block([node.consequent], a); if (node.alternate) block([node.alternate], b);
          for (const key of new Set([...a.env.keys(), ...b.env.keys()])) scope.env.set(key, merge(a.env.get(key) || NONE, b.env.get(key) || NONE));
          break;
        }
        case "ForStatement": {
          const loop = captionDataLoop(node);
          if (!loop || expr(loop.collectionNode, scope).kind !== "scalarArray" || RESERVED.has(loop.index) || scope.constants.has(loop.index))
            fail("unproven_data_loop", node);
          scope.env.set(loop.index, literal(0)); scope.writable.add(loop.index);
          const body = { ...scope, env: new Map(scope.env), writable: new Set(scope.writable) };
          body.env.set(loop.index, { kind: "data", arrayIndex: true });
          block(node.body.type === "BlockStatement" ? node.body.body : [node.body], body);
          for (const key of new Set([...scope.env.keys(), ...body.env.keys()])) scope.env.set(key, merge(scope.env.get(key) || NONE, body.env.get(key) || NONE));
          dataLoops.push({ scriptIndex, offset: node.start, index: loop.index, collection: loop.collection,
            basis: "unchanged-primitive-split-array-forward-loop" });
          break;
        }
        case "BreakStatement": case "ContinueStatement":
          if (node.label) fail("unmodeled_script_statement", node);
          break;
        case "ReturnStatement": { const value = node.argument ? expr(node.argument, scope) : literal(undefined); scope.returns?.push(value); break; }
        default: fail("unmodeled_script_statement", node);
      }
    }
  }

  try {
    const texts = [...new Set(scripts.filter(Boolean))];
    const tables = form.fields.filter(field => field.type === "detailTable").map(field => field.id);
    const registration = hasStaticDoclistRegistration(texts, tables);
    for (const id of tables) if (hasStaticDoclistRegistration(texts, [id])) registeredTables.add(id);
    const programs = texts.flatMap((text, textIndex) => {
      scriptIndex = textIndex;
      const closed = captionDoclistScope(text, tables, registration) || captionNativeCurrencyScope(text, form, originals) ||
        captionNativeAttachmentScope(text, form, originals, texts);
      if (!closed) return [{ tree: parse(text, { ecmaVersion: "latest", allowReturnOutsideFunction: true }), index: textIndex }];
      closed.targets.forEach(id => { targets.add(id); presentationTargets.add(id); });
      (closed.dataTargets || []).forEach(id => { targets.add(id); dataTargets.add(id); });
      nativeCurrencyBindings.push(...(closed.bindings || []));
      attachmentBindings.push(...(closed.attachmentBindings || []));
      closed.parentReads.forEach(id => parentReads.add(id)); return [];
    });
    // Mapped statements may consume a declaration while residual callbacks
    // still read/write its data. Rebuild ownership from the complete current
    // source inventory, never infer it from the missing residual declaration.
    const scalarPrograms = sharedScalarPrograms === scripts ? programs : [...new Set(sharedScalarPrograms.filter(Boolean))]
      .map((text, index) => ({ tree: parse(text, { ecmaVersion: "latest", allowReturnOutsideFunction: true }), index }));
    sharedScalars = captionSharedScalars(scalarPrograms, RESERVED);
    for (const name of sharedScalars.keys()) { globals.env.set(name, sharedValue(name)); globals.writable.add(name); }
    for (const program of programs) {
      scriptIndex = program.index;
      // Direct declarations in one Program are instantiated together. Across
      // Programs retain every variant: callbacks may observe different bodies.
      const declarations = program.tree.body.filter(node => node.type === "FunctionDeclaration");
      const last = new Map(declarations.map(node => [node.id?.name, node]));
      for (const node of declarations) {
        if (SOURCE_GETTERS.has(node.id?.name) && last.get(node.id.name) !== node) continue;
        declare(node, globals, texts[program.index]);
      }
    }
    for (const program of programs) { scriptIndex = program.index; block(program.tree.body, globals, true, true); }
    if ([...functions].some(fn => !invoked.has(fn) && (observedFunctionReferences.has(fn) || !helperUnits.has(canonical(fn.node))))) fail("unbound_source_function");
    const index = buildFormRuleRefIndex(form);
    const rowCache = new Map();
    const rowRegion = id => {
      if (!rowCache.has(id)) rowCache.set(id, captionRowRegion(form, index, id));
      return rowCache.get(id);
    };
    const failTarget = (reason, id) => {
      const origin = targetOrigins.get(id);
      if (origin) scriptIndex = origin.scriptIndex;
      fail(reason, origin, { targetId: id });
    };
    const outsideExportIds = [];
    const known = new Set(originals.map(field => field.id));
    originals.flatMap(field => [field.sourceProps?.staticCaptionFact, field.sourceProps?.captionStructure]
      .flatMap(fact => [...(fact?.domContext?.ancestorIds || []), ...(fact?.domContext?.pairDescendantIds || [])])).forEach(id => known.add(id));
    for (const id of [...targets]) {
      const resolved = rowTargets.has(id) ? rowRegion(id) : resolveEffectTarget(index, id);
      if (rowTargets.has(id) && (resolved?.source !== "rowMarker" || resolved.unresolved?.length)) failTarget("row_region_unproven", id);
      if (resolved?.targets?.length) resolved.targets.forEach(target => {
        targets.add(target.id);
        if (presentationTargets.has(id)) presentationTargets.add(target.id);
        if (dataTargets.has(id)) dataTargets.add(target.id);
        if (rowEffectTargets.has(id)) rowEffectTargets.add(target.id);
      });
      // A concrete id that is not a migrated field is not a wildcard. Keep the
      // completed target set; only pairs that actually intersect it are affected.
      else if (!known.has(id)) outsideExportIds.push({ id, ...(targetOrigins.get(id) || {}) });
    }
    for (const id of writes) {
      const resolved = rowTargets.has(id) ? rowRegion(id) : resolveEffectTarget(index, id);
      if ([id, ...(resolved?.targets || []).map(target => target.id)].some(id => dropdownAssumptions.has(id)))
        failTarget("dropdown_domain_mutated", id);
    }
    return { ok: true, targets: [...targets], presentationTargets: [...presentationTargets], dataTargets: [...dataTargets],
      rowRegions: [...rowTargets].map(marker => ({ marker, targets: rowRegion(marker).targets.map(target => target.id),
        ...(rowRegion(marker).impactBasis ? { basis: rowRegion(marker).impactBasis } : {}) })),
      parentReads: [...parentReads], ...(inertSubmitScratch.length ? { inertSubmitScratch } : {}),
      ...(inertRowNoops.length ? { inertRowNoops } : {}),
      ...(attachmentBindings.length ? { attachmentBindings } : {}),
      ...(sharedScalars.size ? { sharedScalars: [...sharedScalars.values()].map(({ readonlyLiterals, ...proof }) => ({ ...proof,
        ...(readonlyLiterals ? { immutableInitializers: true } : {}) })) } : {}),
      ...(sourceValueReads.length ? { sourceValueReads } : {}),
      ...(dataLoops.length ? { dataLoops } : {}),
      ...(tablePollEffects.length ? { tablePollEffects } : {}),
      ...(detailDataReads.length ? { detailDataReads } : {}),
      ...(jsonImpact ? { sharedJsonData: jsonImpact.proof } : {}),
      ...([...functions].some(fn => !invoked.has(fn)) ? { nonEntryHelpers: [...functions].filter(fn => !invoked.has(fn)).map(fn => helperUnits.get(canonical(fn.node))) } : {}),
      ...(nativeCurrencyBindings.length ? { nativeCurrencyBindings } : {}),
      ...(outsideExportIds.length ? { outsideExportIds } : {}) };
  } catch (error) {
    return { ok: false, targets: [], issue: { reason: error.reason || "script_scope_parse_error", scriptIndex,
      nodeType: error.nodeType, offset: error.offset, ...error.details } };
  }
}

// This proof is local to a no-argument submit callback. It never accepts event
// text as field data: the scratch binding has exactly its declaration, fallback
// test and fallback assignment, with no later read, capture or redeclaration.
// Source/migrated scripts are unchanged; only caption dependency analysis skips
// these unused native DOM scalar reads. Every other event-target use stays opaque.
function unusedSubmitButtonScratch(fn, reserved) {
  if (fn.params.length || fn.body.type !== "BlockStatement") return [];
  const statements = fn.body.body, result = [];
  const count = (node, name) => {
    if (!node || typeof node !== "object") return 0;
    if (Array.isArray(node)) return node.reduce((sum, child) => sum + count(child, name), 0);
    return (node.type === "Identifier" && node.name === name ? 1 : 0) +
      Object.values(node).reduce((sum, child) => sum + (child && typeof child === "object" ? count(child, name) : 0), 0);
  };
  for (const declaration of statements) {
    const variable = declaration.type === "VariableDeclaration" && declaration.kind === "var" &&
      declaration.declarations.length === 1 && declaration.declarations[0];
    const name = variable?.id?.type === "Identifier" && variable.id.name;
    if (!name || reserved.has(name) || memberPath(variable.init) !== "window.event.target.innerText" || count(fn.body, name) !== 3) continue;
    const fallback = statements.find(statement => {
      if (statement.type !== "IfStatement" || statement.alternate || statement.test.type !== "UnaryExpression" ||
          statement.test.operator !== "!" || statement.test.argument.type !== "Identifier" || statement.test.argument.name !== name) return false;
      const body = statement.consequent.type === "BlockStatement" && statement.consequent.body.length === 1
        ? statement.consequent.body[0] : statement.consequent;
      const assignment = body.type === "ExpressionStatement" && body.expression;
      return assignment?.type === "AssignmentExpression" && assignment.operator === "=" &&
        assignment.left.type === "Identifier" && assignment.left.name === name &&
        memberPath(assignment.right) === "window.event.target.value" && statement.start > declaration.end;
    });
    if (fallback) result.push({ variable: name, declaration, fallback });
  }
  return result;
}
