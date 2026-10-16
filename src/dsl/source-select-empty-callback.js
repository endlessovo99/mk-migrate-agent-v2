import { parse } from "acorn";
import { canonicalJson } from "../agent-review/digest.js";
import { buildFieldIdMap } from "../translator/field-id-remap.js";
import { buildJavaScriptBindingModel } from "./javascript-binding-provenance.js";

/** Prove the whole fixed-source callback before its null bridge closes residuals. */
export function proveSelectEmptySourceCallback({ action, sources, form, formRules, needle, writes, targetTrace } = {}) {
  const context = sourceCallbackContext(action, sources, form);
  if (!context.ok) return context;
  if (typeof needle !== "string" || !needle || !Array.isArray(writes)) return invalid("owner_unproven");
  const { callback, bindings, identities } = context;

  const getters = new Map(), sourceWrites = [], branches = [[], []];
  const trace = { before: [], branches: [[], []], after: [] };
  let condition;
  const eventValue = node => node?.type === "Identifier" &&
    bindings.bindingAtUse(node.name, node.start) === bindings.eventBinding &&
    bindings.stableEventUse(bindings.eventBinding, bindings.scopeAt(node.start), node.start);
  const diagnostic = expression => sourceDiagnostic(expression, bindings, eventValue);
  const declaration = (statement, allowGetter) => {
    if (!["var", "let", "const"].includes(statement.kind)) return false;
    return statement.declarations.every(declarator => {
      if (declarator.id.type !== "Identifier" || !declarator.init) return false;
      const binding = bindings.bindingAtUse(declarator.id.name, declarator.id.start);
      if (!binding || binding.ambiguous || binding.declarations.length !== 1) return false;
      if (inertLiteral(declarator.init)) return true;
      const member = declarator.init, list = member.type === "CallExpression", getter = list ? member : member?.object;
      if (!allowGetter || !list && (member.type !== "MemberExpression" || !member.computed || member.optional ||
          member.property.type !== "Literal" || member.property.value !== 0) ||
          getter?.type !== "CallExpression" || getter.optional || getter.callee.type !== "Identifier" ||
          getter.callee.name !== "GetXFormFieldById" || !bindings.isUnshadowedGlobal("GetXFormFieldById", getter.start) ||
          getter.arguments.length !== 1 || !stringLiteral(getter.arguments[0]) ||
          binding.declarations[0].controlFlowUnproven) return false;
      const target = identities.target(getter.arguments[0].value);
      if (!target || getters.has(binding)) return false;
      getters.set(binding, { target, list, start: declarator.end, assignments: new Set() });
      return true;
    });
  };
  const branch = (block, index) => {
    if (block?.type !== "BlockStatement") return false;
    for (const statement of block.body) {
      if (statement.type === "EmptyStatement") continue;
      if (statement.type === "VariableDeclaration" && declaration(statement, false)) continue;
      const expression = statement.type === "ExpressionStatement" && statement.expression;
      if (!expression) return false;
      const log = diagnostic(expression);
      if (log) { trace.branches[index].push(log); continue; }
      if (expression.type === "AssignmentExpression") {
        const left = expression.left;
        if (expression.operator !== "=" || left.type !== "MemberExpression" || left.computed || left.optional ||
            left.property.type !== "Identifier" || left.property.name !== "value" ||
            !stringLiteral(expression.right)) return false;
        const indexed = left.object.type === "MemberExpression", object = indexed ? left.object.object : left.object;
        if (object.type !== "Identifier" || indexed && (!left.object.computed || left.object.optional ||
            left.object.property.type !== "Literal" || left.object.property.value !== 0)) return false;
        const binding = bindings.bindingAtUse(object.name, object.start), getter = getters.get(binding);
        if (!getter || getter.list !== indexed || getter.start >= expression.start) return false;
        getter.assignments.add(expression.start);
        sourceWrites.push({ target: getter.target, value: expression.right.value });
        trace.branches[index].push({ type: "setValue", target: getter.target, value: expression.right.value });
        continue;
      }
      if (expression.type !== "CallExpression" || expression.optional || expression.callee.type !== "Identifier" ||
          expression.callee.name !== "common_dom_row_set_show_required_reset" ||
          !bindings.isUnshadowedGlobal("common_dom_row_set_show_required_reset", expression.start) || expression.arguments.length !== 4 ||
          !stringLiteral(expression.arguments[0]) || expression.arguments.slice(1).some(argument =>
            argument.type !== "Literal" || typeof argument.value !== "boolean") || expression.arguments[3].value !== false) return false;
      const target = rowTarget(expression.arguments[0].value, form, identities);
      if (!target) return false;
      branches[index].push({ type: "visible", target, value: expression.arguments[1].value },
        { type: "required", target, value: expression.arguments[2].value });
    }
    return true;
  };
  for (const statement of callback.body.body) {
    if (statement.type === "EmptyStatement") continue;
    if (statement.type === "VariableDeclaration" && declaration(statement, !condition)) continue;
    const log = statement.type === "ExpressionStatement" && diagnostic(statement.expression);
    if (log) { trace[condition ? "after" : "before"].push(log); continue; }
    if (statement.type !== "IfStatement" || condition || !containsEvent(statement.test, needle, eventValue) ||
        !branch(statement.consequent, 0) || !branch(statement.alternate, 1)) return invalid("effect_unproven");
    condition = statement;
  }
  if (!condition || !sourceWrites.length || canonicalJson(sourceWrites) !== canonicalJson(writes)) return invalid("writes_unproven");
  for (const [binding, getter] of getters) {
    if (!getter.assignments.size || binding.effects.some(effect =>
      effect.kind !== "mutation" || !getter.assignments.has(effect.index))) return invalid("getter_binding_unproven");
  }
  if (!nativeEffects(action, context.owner.source.sourceRef, needle, branches, formRules)) return invalid("native_effects_unproven");
  if (targetTrace === undefined) {
    if ([...trace.before, ...trace.branches.flat(), ...trace.after].some(step => step.type === "console.log")) return invalid("trace_missing");
  } else if (!validTrace(targetTrace) || canonicalJson(trace) !== canonicalJson(targetTrace) ||
      canonicalJson([...targetTrace.before, ...targetTrace.branches.flat(), ...targetTrace.after]
        .filter(step => step.type === "setValue").map(({ target, value }) => ({ target, value }))) !== canonicalJson(writes)) {
    return invalid("trace_unproven");
  }
  return { ok: true };
}

function sourceCallbackContext(action, sources, form) {
  const owner = sourceOwner(action, sources);
  if (!owner) return invalid("owner_unproven");
  const text = owner.source.javascript;
  let program;
  try { program = parse(text, { ecmaVersion: "latest" }); }
  catch { return invalid("parse_failed"); }
  const statements = program.body.filter(statement => statement.type !== "EmptyStatement");
  const registrations = statements.filter(statement => statement.type === "ExpressionStatement" &&
    statement.expression.type === "CallExpression" && statement.expression.start === owner.offset);
  if (registrations.length !== 1) return invalid("registration_unproven");
  const call = registrations[0].expression, callback = call.arguments[1];
  const identities = fieldIdentities(form);
  if (!identities || call.optional || call.callee.type !== "Identifier" || call.callee.name !== "AttachXFormValueChangeEventById" ||
      call.arguments.length !== 2 || !stringLiteral(call.arguments[0]) || identities.target(call.arguments[0].value) !== action.controlId ||
      callback?.type !== "FunctionExpression" || callback.id || callback.async || callback.generator ||
      callback.params.length < 1 || callback.params.length > 2 || callback.params.some(parameter => parameter.type !== "Identifier") ||
      new Set(callback.params.map(parameter => parameter.name)).size !== callback.params.length) return invalid("registration_unproven");
  const bindings = buildJavaScriptBindingModel(text, { event: "onChange", eventFunctionStart: callback.start });
  if (!bindings.ok || !bindings.eventBinding || bindings.entrypoint?.start !== callback.start ||
      !bindings.isUnshadowedGlobal("AttachXFormValueChangeEventById", call.start)) return invalid("binding_unproven");

  return { ok: true, owner, callback, bindings, identities, statements };
}

// Only this source-backed, synchronous map grammar may lend its diagnostic
// argument a representation bridge. No other source calls are discarded.
export function selectEmptyDiagnosticMapSource({ action, sources, form, targetMapCandidate = false } = {}) {
  const context = sourceCallbackContext(action, sources, form);
  if (!context.ok) return context;
  const { callback, bindings, identities, statements } = context;
  const eventValue = node => node?.type === "Identifier" &&
    bindings.bindingAtUse(node.name, node.start) === bindings.eventBinding &&
    bindings.stableEventUse(bindings.eventBinding, bindings.scopeAt(node.start), node.start);
  const body = callback.body.body.filter(statement => statement.type !== "EmptyStatement");
  // Recognition establishes a proof obligation, not credit. An unsupported
  // consumer of this map read must fail the whole callback grammar below.
  if (!hasEventIndexedLiteralMap(callback.body, bindings) && !targetMapCandidate) return { ok: true, relevant: false };
  const trace = [];
  let index = 0;
  while (index < body.length) {
    const statement = body[index], log = statement.type === "ExpressionStatement" &&
      sourceDiagnostic(statement.expression, bindings, eventValue);
    if (!log) break;
    trace.push(log); index++;
  }
  if (statements.length !== 1) return invalid("diagnostic_map_source_effect_unproven");
  const locals = new Map(), allowedCalls = new Set();
  const literalString = (node, seen = new Set()) => {
    if (stringLiteral(node)) return node.value;
    if (node?.type === "BinaryExpression" && node.operator === "+") {
      const left = literalString(node.left, seen), right = literalString(node.right, seen);
      return typeof left === "string" && typeof right === "string" ? left + right : undefined;
    }
    if (node?.type !== "Identifier") return undefined;
    const binding = bindings.bindingAtUse(node.name, node.start), local = locals.get(binding);
    if (!local || seen.has(binding)) return undefined;
    const next = new Set(seen); next.add(binding);
    return literalString(local.node, next);
  };
  let effect;
  for (; index < body.length; index++) {
    const statement = body[index];
    if (statement.type === "VariableDeclaration" && !effect) {
      for (const declaration of statement.declarations) {
        const binding = declaration.id.type === "Identifier" && bindings.bindingAtUse(declaration.id.name, declaration.id.start);
        if (!binding || binding.ambiguous || binding.declarations.length !== 1 || binding.effects.some(effect => effect.kind !== "escape") || !declaration.init) return invalid("diagnostic_map_source_binding_unproven");
        const node = declaration.init, map = diagnosticMapLiteral(node);
        if (primitiveLiteral(node) || map) { locals.set(binding, { node, map }); continue; }
        if (node.type !== "CallExpression" || node.optional || node.callee.type !== "Identifier" ||
            !["$", "jQuery"].includes(node.callee.name) || !bindings.isUnshadowedGlobal(node.callee.name, node.start) ||
            node.arguments.length !== 1) return invalid("diagnostic_map_source_getter_unproven");
        const selector = literalString(node.arguments[0]);
        const id = selector?.match(/^\s*(?:input|select|textarea)?\[name\s*=\s*(["'])extendDataFormInfo\.value\(([A-Za-z_][\w-]*)\)\1\]\s*$/)?.[2];
        const targetId = id && identities.target(id);
        if (!targetId) return invalid("diagnostic_map_source_selector_unproven");
        allowedCalls.add(node.end);
        locals.set(binding, { node, targetId });
      }
      continue;
    }
    const call = statement.type === "ExpressionStatement" && statement.expression, member = call?.callee;
    if (effect || call?.type !== "CallExpression" || call.optional || member.type !== "MemberExpression" || member.computed || member.optional ||
        member.object.type !== "Identifier" || member.property.name !== "val" || call.arguments.length !== 1) return invalid("diagnostic_map_source_effect_unproven");
    const destination = locals.get(bindings.bindingAtUse(member.object.name, member.object.start)), lookup = call.arguments[0];
    if (!destination?.targetId || lookup.type !== "MemberExpression" || !lookup.computed || lookup.optional ||
        lookup.object.type !== "Identifier" || !eventValue(lookup.property)) return invalid("diagnostic_map_source_effect_unproven");
    const map = locals.get(bindings.bindingAtUse(lookup.object.name, lookup.object.start))?.map;
    if (!map) return invalid("diagnostic_map_source_lookup_unproven");
    effect = { target: destination.targetId, map };
    allowedCalls.add(call.end);
  }
  if ([...locals.keys()].some(binding => binding.effects.some(effect => !allowedCalls.has(effect.index)))) return invalid("diagnostic_map_source_binding_unproven");
  return effect ? { ok: true, relevant: true, trace, effect } : invalid("diagnostic_map_source_effect_unproven");
}

export function diagnosticMapLiteral(node) {
  if (node?.type !== "ObjectExpression" || !node.properties.length || node.properties.some(property =>
    property.type !== "Property" || property.computed || property.method || property.kind !== "init" ||
    staticPropertyKey(property.key) === undefined || !stringLiteral(property.value))) return undefined;
  return node.properties.map(property => [staticPropertyKey(property.key), property.value.value]);
}

function staticPropertyKey(node) {
  if (node?.type === "Identifier") return node.name;
  if (stringLiteral(node)) return node.value;
  if (node?.type === "Literal" && typeof node.value === "number" && Number.isFinite(node.value)) return String(node.value);
  return undefined;
}

export function hasEventIndexedLiteralMap(ast, bindings) {
  const nodes = [];
  const visit = node => {
    if (!node || typeof node !== "object") return;
    nodes.push(node);
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") visit(value);
  };
  visit(ast);
  const maps = new Set(nodes.filter(node => node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init?.type === "ObjectExpression")
    .map(node => bindings.bindingAtUse(node.id.name, node.id.start)));
  return nodes.some(node => node.type === "MemberExpression" && node.computed && node.object.type === "Identifier" && node.property.type === "Identifier" &&
    maps.has(bindings.bindingAtUse(node.object.name, node.object.start)) &&
    bindings.bindingAtUse(node.property.name, node.property.start) === bindings.eventBinding);
}

function sourceDiagnostic(expression, bindings, eventValue) {
  if (expression?.type !== "CallExpression" || expression.optional || expression.callee.type !== "MemberExpression" ||
      expression.callee.computed || expression.callee.optional || expression.callee.object.type !== "Identifier" ||
      expression.callee.object.name !== "console" || expression.callee.property.type !== "Identifier" ||
      expression.callee.property.name !== "log" || !bindings.isUnshadowedGlobal("console", expression.start)) return undefined;
  const args = [];
  for (const argument of expression.arguments) {
    if (primitiveLiteral(argument)) args.push({ kind: "literal", value: argument.value });
    else if (eventValue(argument)) args.push({ kind: "event" });
    else return undefined;
  }
  return { type: "console.log", args };
}

function sourceOwner(action, sources) {
  if (action?.event !== "onChange" || action.scope !== "control" || action.tableId ||
      typeof action.controlId !== "string" || !Array.isArray(action.sourceRefs) || !Array.isArray(sources)) return undefined;
  const match = /^(.*)#onChange@(0|[1-9]\d*)$/.exec(action.sourceActionKey || "");
  if (!match || !action.sourceRefs.includes(match[1]) ||
      action.branchProvenance?.sourceRef !== match[1] || action.branchProvenance?.sourceActionKey !== action.sourceActionKey) return undefined;
  const matches = sources.filter(source => source?.sourceRef === match[1]);
  const offset = Number(match[2]);
  return matches.length === 1 && typeof matches[0].javascript === "string" && Number.isSafeInteger(offset)
    ? { source: matches[0], offset } : undefined;
}

function fieldIdentities(form = {}) {
  const sourceFields = Array.isArray(form.controls)
    ? [...form.controls, ...(form.detailTables || []), ...(form.dataFields || [])]
    : form.fields;
  if (!Array.isArray(sourceFields)) return undefined;
  const fields = sourceFields.filter(field => field?.type !== "detailTable" && !field?.columns);
  const idMap = buildFieldIdMap({ fields: sourceFields });
  const identities = new Map();
  for (const field of fields) {
    const natural = field?.sourceProps?.originalId || field?.id;
    if (typeof natural !== "string" || identities.has(natural)) return undefined;
    identities.set(natural, field.id === natural ? idMap.get(natural) || natural : field.id);
  }
  return { target: id => identities.get(id), mapped: id => idMap.get(id) || id };
}

function rowTarget(id, form, identities) {
  const rows = form?.layout?.rows || form?.layout?.sourceGrid?.rows || [];
  const owners = rows.filter(row => row.sourceMarkers?.includes(id));
  if (owners.length > 1) return undefined;
  return owners.length === 1 ? identities.mapped(owners[0].sourceMarkers[0]) : identities.target(id);
}

function containsEvent(test, needle, eventValue) {
  if (test.type !== "BinaryExpression") return false;
  const right = test.right;
  const comparison = test.operator === ">=" && right.type === "Literal" && right.value === 0 ||
    [">", "!==", "!="].includes(test.operator) && right.type === "UnaryExpression" && right.operator === "-" &&
      right.argument.type === "Literal" && right.argument.value === 1;
  const call = test.left;
  return comparison && call.type === "CallExpression" && !call.optional && call.arguments.length === 1 &&
    stringLiteral(call.arguments[0]) && call.arguments[0].value === needle && call.callee.type === "MemberExpression" &&
    !call.callee.computed && !call.callee.optional && call.callee.property.type === "Identifier" &&
    call.callee.property.name === "indexOf" && eventValue(call.callee.object);
}

function nativeEffects(action, sourceRef, needle, branches, formRules) {
  const ids = action.coverage?.nativeRules;
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length) return false;
  const effects = [[], []];
  for (const id of ids) {
    const rules = (formRules?.linkage || []).filter(rule => rule.id === id);
    if (rules.length !== 1) return false;
    const rule = rules[0];
    if (rule.translationStatus !== "executable" || rule.trigger !== "change" || rule.source !== action.controlId || rule.logic !== "and" ||
        rule.meta?.sourceJsp !== sourceRef || rule.meta?.sourceActionKey !== action.sourceActionKey ||
        canonicalJson(rule.meta?.runWhen) !== canonicalJson(action.runWhen) ||
        canonicalJson(rule.when) !== canonicalJson([{ field: action.controlId, op: "contains", value: needle }]) ||
        !Array.isArray(rule.effects) || !Array.isArray(rule.else)) return false;
    effects[0].push(...rule.effects); effects[1].push(...rule.else);
  }
  return branches.every((branch, index) => {
    const keys = branch.map(effect => `${effect.type}:${effect.target}`);
    return new Set(keys).size === keys.length && canonicalJson(branch) === canonicalJson(effects[index]);
  });
}

function stringLiteral(node) { return node?.type === "Literal" && typeof node.value === "string"; }
function primitiveLiteral(node) {
  return node?.type === "Literal" && !node.regex && primitiveValue(node.value);
}
function primitiveValue(value) {
  return value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value);
}
function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validTrace(trace) {
  if (!exactKeys(trace, ["before", "branches", "after"]) || !Array.isArray(trace.before) || !Array.isArray(trace.after) ||
      !Array.isArray(trace.branches) || trace.branches.length !== 2 || !trace.branches.every(Array.isArray)) return false;
  return [...trace.before, ...trace.branches.flat(), ...trace.after].every(step =>
    step?.type === "setValue" ? exactKeys(step, ["type", "target", "value"]) && typeof step.target === "string" && typeof step.value === "string" :
      step?.type === "console.log" && exactKeys(step, ["type", "args"]) && Array.isArray(step.args) && step.args.every(argument =>
        argument?.kind === "event" ? exactKeys(argument, ["kind"]) : argument?.kind === "literal" &&
          exactKeys(argument, ["kind", "value"]) && primitiveValue(argument.value)));
}
function inertLiteral(node) {
  return node.type === "Literal" && !node.regex &&
    (node.value === null || ["string", "boolean"].includes(typeof node.value) || typeof node.value === "number" && Number.isFinite(node.value)) ||
    node.type === "UnaryExpression" && ["+", "-", "!", "~", "void"].includes(node.operator) && inertLiteral(node.argument);
}
function invalid(reason) { return { ok: false, reason: `source_callback_${reason}` }; }
