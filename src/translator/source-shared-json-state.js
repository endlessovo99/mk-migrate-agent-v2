import { createHash } from "node:crypto";
import { parse } from "acorn";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";
import { resolveControlEventSupport } from "../dsl/scripts.js";
import { inlineOnChangeSourceActionKey } from "./source-action-key.js";
import { validatedSharedJsonStateSourceDomain } from "./source-shared-json-state-domain.js";

export const SHARED_JSON_STATE_BASIS = "deterministic-source-shared-json-state";

// Source state stays in the captured runtime instance, outside GLOBALJS/window.
export function sharedJsonStateCandidates(source = {}, form = {}, sourceScripts = {}) {
  const model = inspectModel(form, sourceScripts.sources?.length ? sourceScripts : { sources: [source] });
  const entry = model?.entries.find(entry => entry.source === source);
  if (!entry) return [];
  return model.callbacks.filter(callback => callback.entry === entry && callback.supported).map(callback => {
    const sourceRef = ref(source), definitions = [model.declaration, ...callback.dependencies];
    const ranges = [{ sourceRef, name: "sharedJsonStateCallback", start: callback.call.start, end: callback.call.end },
      ...definitions.map(definition => ({ sourceRef: ref(definition.entry.source), name: definition.name, start: definition.node.start, end: definition.node.end }))];
    return {
      id: (source.id || "script") + ".event." + callback.ordinal, index: callback.call.start,
      ...(callback.event === "onChange" ? { sourceActionKey: inlineOnChangeSourceActionKey(sourceRef, callback.call.start) } : {}),
      event: callback.event, scope: callback.event === "onChange" ? "control" : "global", controlId: callback.controlId,
      javascript: source.javascript, source, sourceRefs: [...new Set(ranges.map(range => range.sourceRef))],
      function: render(callback, model), translationStatus: "mapped", coverage: { status: "translated", nativeRules: [], residuals: [] },
      functionMappings: [{ source: "source-bound shared JSON state initialization, property changes and serialization",
        target: "captured per-instance MKXFORM_DATA_CONTAINER state and exact JSON operations", basis: SHARED_JSON_STATE_BASIS, reviewRequired: false }],
      semanticHints: { coveredCalculationRanges: ranges, sourceSharedJsonState: {
        version: 1, containerKey: model.key, stateName: model.name, fieldId: model.field.id,
        sourceDisplayGate: source.displayGate, initializerResiduals: model.initializer.residuals,
        sourceStateDeclaration: { sourceRef: ref(model.declaration.entry.source), start: model.declaration.node.start, end: model.declaration.node.end }
      } }
    };
  });
}

export function inspectSharedJsonStateModel(form = {}, sourceScripts = {}) {
  const model = inspectModel(form, sourceScripts);
  if (!model) return undefined;
  return { version: 1, stateName: model.name, fieldId: model.field.id, containerKey: model.key,
    initializer: { sourceRef: ref(model.initializer.entry.source), name: model.initializer.name,
      prefixStart: model.initializer.node.body.start, prefixEnd: model.initializer.prefixEnd,
      residuals: model.initializer.residuals, provenPrefixFunction: render({ event: "onLoad", kind: "initialize" }, model) },
    callbacks: model.callbacks.map(callback => ({ sourceRef: ref(callback.entry.source), index: callback.call.start,
      event: callback.event, controlId: callback.controlId, supported: callback.supported })) };
}

function inspectModel(form, sourceScripts) {
  const sources = sourceScripts.sources || [];
  const entries = [];
  for (const source of sources) {
    let ast;
    try { ast = parse(String(source.javascript || ""), { ecmaVersion: "latest" }); } catch { return undefined; }
    const bindings = buildJavaScriptBindingModel(source.javascript);
    if (!bindings.ok || !ref(source)) return undefined;
    const parents = new WeakMap(); walk(ast, (node, parent) => { if (parent) parents.set(node, parent); });
    entries.push({ source, ast, bindings, parents });
  }
  const declarations = entries.flatMap(entry => entry.ast.body.flatMap(statement => statement.type === "VariableDeclaration" && statement.kind === "var"
    ? statement.declarations.filter(node => node.id.type === "Identifier" && node.init?.type === "ObjectExpression" && !node.init.properties.length)
      .map(node => ({ name: node.id.name, node: statement, declaration: node, entry })) : []));
  const domain = validatedSharedJsonStateSourceDomain(sourceScripts, entries);
  const viable = declarations.map(declaration => buildModel(declaration, entries, form, domain)).filter(Boolean);
  return viable.length === 1 ? viable[0] : undefined;
}

function buildModel(declaration, entries, form, domain) {
  const name = declaration.name;
  if (declaration.entry.source.displayGate || declaration.node.declarations.length !== 1 || entries.some(entry => entry.ast.body.some(statement =>
    statement.type === "FunctionDeclaration" && statement.id?.name === name || statement.type === "VariableDeclaration" && statement.declarations.some(node => node.id.name === name && node !== declaration.declaration)))) return undefined;
  const binding = declaration.entry.bindings.bindingAtUse(name, declaration.declaration.id.start);
  if (!binding || binding.ambiguous || binding.declarations.length !== 1) return undefined;
  const model = { name, declaration, binding, entries, domain };
  const initializers = entries.flatMap(entry => entry.ast.body.filter(node => node.type === "FunctionDeclaration").map(node => initializer(node, entry, model)).filter(Boolean));
  if (initializers.length !== 1 || !["JSON", "Number", "GetXFormFieldById", "SetXFormFieldValueById"].every(name => stableGlobal(name, entries))) return undefined;
  model.initializer = initializers[0];
  const fields = (form.fields || []).filter(field => field.id === model.initializer.fieldId && field.type === "text" && field.componentId === "xform-hidden" &&
    field.sourceProps?.hardHidden === true && field.sourceProps?.metadataAttributes?.type === "String" && field.dataOnly !== true &&
    [field.sourceProps?.metadataId, field.sourceProps?.designerId, field.sourceProps?.metadataAttributes?.name, field.sourceProps?.designerValues?.id].every(id => !id || id === field.id));
  if (fields.length !== 1) return undefined;
  model.field = fields[0];
  model.callbacks = entries.flatMap(entry => callbackBoundaries(entry).map((callback, ordinal) => classifyCallback({ ...callback, entry, ordinal: ordinal + 1 }, model, form)));
  if (!model.callbacks.some(callback => callback.kind === "change") || !model.callbacks.some(callback => callback.kind === "serialize")) return undefined;
  const safeReaders = entries.flatMap(entry => entry.ast.body.filter(node => node.type === "FunctionDeclaration").map(node => ({ node, entry })).filter(definition => readonlyReader(definition, model, false)));
  const readerReferences = [];
  for (const definition of safeReaders) walk(definition.node, node => { if (stateReference(node, definition.entry, model)) readerReferences.push(node); });
  const allowed = [declaration.declaration.id, ...model.initializer.stateReferences, ...readerReferences,
    ...model.callbacks.filter(callback => callback.kind === "change").map(callback => callback.stateReference)];
  let valid = true;
  for (const entry of entries) walk(entry.ast, (node, parent) => {
    if (!valid) return;
    if (node.type === "Identifier" && ["eval", "Function"].includes(node.name) && entry.bindings.isUnshadowedGlobal(node.name, node.start) &&
      !(parent?.type === "MemberExpression" && parent.property === node && !parent.computed)) valid = false;
    if (node.type === "MemberExpression" && ["prototype", "__proto__", "constructor"].includes(node.computed ? value(node.property) : node.property?.name)) valid = false;
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression" && ["Object", "Reflect"].includes(node.callee.object?.name) &&
      ["assign", "defineProperty", "defineProperties", "set"].includes(node.callee.property?.name) &&
      ["window", "globalThis", "self"].includes(node.arguments[0]?.name)) valid = false;
    if (node.type === "MemberExpression" && ["window", "globalThis", "self", "this"].includes(node.object?.type === "ThisExpression" ? "this" : node.object?.name) &&
      (node.computed && typeof value(node.property) !== "string" || (node.computed ? value(node.property) : node.property?.name) === name)) valid = false;
    if (!stateReference(node, entry, model) || allowed.includes(node)) return;
    if (!serializeUse(node, entry, model)) valid = false;
  });
  if (!valid) return undefined;
  const id = ref(declaration.entry.source) + "@" + declaration.node.start + ":" + name;
  model.key = "source-json-state:" + createHash("sha256").update(id).digest("hex").slice(0, 24);
  const names = new Set(); for (const entry of entries) walk(entry.ast, node => { if (node.type === "Identifier") names.add(node.name); });
  model.cellName = fresh(names, "__sourceJsonCell"); model.readerName = fresh(names, "__sourceJsonReader");
  return model;
}

function initializer(node, entry, model) {
  if (node.async || node.generator || node.params.length || !node.id || !uniqueFunction(node.id.name, model.entries, node)) return undefined;
  const body = nonEmpty(node.body.body), head = body[0], declaration = singleDeclaration(head), read = declaration?.init;
  if (!declaration || !call(read, "GetXFormFieldById") || read.arguments.length !== 1 || typeof value(read.arguments[0]) !== "string") return undefined;
  const elements = declaration.id.name, branch = body[1], assignment = nonEmpty(branch?.consequent?.body)[0]?.expression;
  if (branch?.type !== "IfStatement" || branch.alternate || nonEmpty(branch.consequent?.body).length !== 1 || assignment?.type !== "AssignmentExpression" || assignment.operator !== "=" ||
    !stateReference(assignment.left, entry, model) || !memberCall(assignment.right, "JSON", "parse") || assignment.right.arguments.length !== 1) return undefined;
  const expected = parseStatements(`var ${elements}=GetXFormFieldById(${JSON.stringify(value(read.arguments[0]))});if(${elements}&&${elements}.length>0){${model.name}=JSON.parse(${elements}[0].value);}`);
  if (!same([head, branch], expected) || !entry.bindings.isUnshadowedGlobal("JSON", assignment.right.start) || !entry.bindings.isUnshadowedGlobal("GetXFormFieldById", read.start)) return undefined;
  if ([elements, node.id.name].some(name => [model.name, "MKXFORM", "String", "JSON", "Number"].includes(name))) return undefined;
  let prefixLength = 2, reader, max;
  if (body[2]?.type === "ForStatement") {
    const loop = body[2], counter = singleDeclaration(loop.init), fnCall = nonEmpty(loop.body?.body)[0]?.expression;
    if (!counter || !call(fnCall) || fnCall.arguments.length !== 1 || fnCall.arguments[0].type !== "Identifier" || !id(fnCall.arguments[0], counter.id.name) ||
      loop.test?.type !== "BinaryExpression" || !id(loop.test.left, counter.id.name) || loop.test.operator !== "<" || loop.test.right?.type !== "Identifier") return undefined;
    max = immutableInteger(loop.test.right.name, model.entries);
    const definition = effectiveFunction(fnCall.callee.name, model.entries, model.domain);
    if (max && constantReference(loop.test.right, entry, max) && definition && readonlyReader(definition, model, false) &&
      functionReference(fnCall.callee, entry, definition, model.entries, model.domain) &&
      same([loop], parseStatements(`for(var ${counter.id.name}=0;${counter.id.name}<${max.name};${counter.id.name}++){${definition.node.id.name}(${counter.id.name});}`))) {
      reader = definition; prefixLength = 3;
    } else { max = undefined; }
  }
  const stateReferences = []; walk({ body: body.slice(0, prefixLength) }, child => { if (stateReference(child, entry, model)) stateReferences.push(child); });
  if (reader) walk(reader.node, child => { if (stateReference(child, reader.entry, model)) stateReferences.push(child); });
  const residuals = body.slice(prefixLength).map(node => ({ sourceRef: ref(entry.source), start: node.start, end: node.end, code: "shared_json_initializer_remaining_effect", reason: "Initializer has additional source behavior that is not covered by the shared-state adapter." }));
  // Read-only optional init effects remain pending, rather than being dropped.
  for (const residual of body.slice(prefixLength)) {
    let safeReads = true;
    walk(residual, (child, parent) => {
      if (!stateReference(child, entry, model)) return;
      if (parent?.type !== "MemberExpression" || parent.object !== child || parent.computed || ["__proto__", "constructor", "prototype"].includes(parent.property.name)) safeReads = false;
      else {
        const use = entry.parents.get(parent);
        const ancestor = entry.parents.get(use), nestedWrite = ancestor?.type === "AssignmentExpression" && ancestor.left === use || ancestor?.type === "UpdateExpression";
        const pure = !nestedWrite && (use?.type === "UnaryExpression" && use.operator === "!" || use?.type === "LogicalExpression" ||
          use?.type === "MemberExpression" && !use.computed && !use.optional && (use.property.name === "length" ||
            use.property.name === "split" && entry.parents.get(use)?.type === "CallExpression" && entry.parents.get(use).callee === use &&
            entry.parents.get(use).arguments.length === 1 && typeof value(entry.parents.get(use).arguments[0]) === "string"));
        if (!pure) safeReads = false; else stateReferences.push(child);
      }
    });
    if (!safeReads) return undefined;
  }
  return { name: node.id.name, node, entry, fieldId: value(read.arguments[0]), read, reader, max,
    prefixEnd: body[prefixLength - 1].end, prefixStatements: body.slice(0, prefixLength), residuals, stateReferences };
}

function readonlyReader(definition, model, requireUnique = true) {
  const { node, entry } = definition, body = nonEmpty(node.body.body), variable = singleDeclaration(body[0]), fnName = node.id?.name, parameter = node.params[0]?.name;
  if (!fnName || node.async || node.generator || node.params.length !== 1 || node.params[0].type !== "Identifier" || body.length !== 2 || !variable || requireUnique && !uniqueFunction(fnName, model.entries, node)) return false;
  const key = variable.id.name, expression = variable.init;
  if (expression?.type !== "BinaryExpression" || expression.operator !== "+" || typeof value(expression.right) !== "string" ||
    expression.left?.type !== "BinaryExpression" || expression.left.operator !== "+" || typeof value(expression.left.left) !== "string" || !id(expression.left.right, parameter) ||
    new Set([parameter, key, model.name, "Number", "MKXFORM"]).size !== 5) return false;
  const expected = parseStatements(`var ${key}=${JSON.stringify(value(expression.left.left))}+${parameter}+${JSON.stringify(value(expression.right))};if(${model.name}[${key}]&&Number(${model.name}[${key}])==1){}else{}`);
  return same(body, expected) && entry.bindings.isUnshadowedGlobal("Number", body[1].test.right?.left?.start ?? body[1].start);
}

function classifyCallback(callback, model, form) {
  const { fn, entry } = callback, body = nonEmpty(fn?.body?.body), expression = body[0]?.expression;
  callback.supported = false; callback.dependencies = [];
  if (!plain(fn)) return callback;
  if (callback.event === "onChange" && fn.params.length >= 1 && fn.params.length <= 2 && body.length === 1 && expression?.type === "AssignmentExpression" && expression.operator === "=" &&
    expression.left?.type === "MemberExpression" && !expression.left.computed && stateReference(expression.left.object, entry, model) &&
    !["__proto__", "constructor", "prototype"].includes(expression.left.property.name) && id(expression.right, fn.params[0].name) &&
    entry.bindings.bindingAtUse(expression.right.name, expression.right.start)?.kinds.has("parameter")) {
    const controls = (form.fields || []).filter(field => field.id === callback.controlId && field.type !== "detailTable" && field.dataOnly !== true);
    if (controls.length === 1 && resolveControlEventSupport({ kind: "field", field: controls[0] }, "onChange").status === "supported") {
      Object.assign(callback, { kind: "change", supported: true, property: expression.left.property.name, stateReference: expression.left.object });
    }
  } else if (callback.event === "onBeforeSubmit" && fn.params.length === 0 && body.length === 2 && body[1].type === "ReturnStatement" && value(body[1].argument) === true && serializeUse(expression?.arguments?.[1]?.arguments?.[0], entry, model)) {
    Object.assign(callback, { kind: "serialize", supported: true });
  } else if (callback.event === "onLoad" && fn.params.length === 0 && body.length === 1 && call(expression, model.initializer.name) && !expression.arguments.length &&
    functionReference(expression.callee, entry, model.initializer, model.entries, model.domain)) {
    Object.assign(callback, { kind: "initialize", supported: model.initializer.residuals.length === 0,
      dependencies: [model.initializer, ...(model.initializer.reader ? [{ ...model.initializer.reader, name: model.initializer.reader.node.id.name }] : []), ...(model.initializer.max ? [model.initializer.max] : [])] });
  }
  return callback;
}

function serializeUse(node, entry, model) {
  if (!stateReference(node, entry, model)) return false;
  const stringify = entry.parents.get(node), setter = entry.parents.get(stringify);
  return memberCall(stringify, "JSON", "stringify") && stringify.arguments.length === 1 && stringify.arguments[0] === node &&
    call(setter, "SetXFormFieldValueById") && setter.arguments.length === 2 && setter.arguments[1] === stringify && value(setter.arguments[0]) === model.initializer.fieldId &&
    entry.bindings.isUnshadowedGlobal("JSON", stringify.start) && entry.bindings.isUnshadowedGlobal("SetXFormFieldValueById", setter.start) &&
    entry.parents.get(setter)?.type === "ExpressionStatement";
}

function render(callback, model) {
  const cell = model.cellName, state = cell + ".value", lines = [`function ${callback.event}(${callback.event === "onChange" ? "value, rowNum, parentRowNum" : callback.event === "onBeforeSubmit" ? "context" : ""}) {`,
    ...(callback.event === "onBeforeSubmit" ? ["  if (context.isDraft) return true;"] : []),
    `  var ${cell} = MKXFORM.MKXFORM_DATA_CONTAINER[${JSON.stringify(model.key)}];`,
    `  if (!${cell}) { ${cell} = { value: {} }; MKXFORM.MKXFORM_DATA_CONTAINER[${JSON.stringify(model.key)}] = ${cell}; }`];
  if (callback.kind === "change") lines.push(`  ${state}.${callback.property} = value;`);
  else if (callback.kind === "serialize") lines.push(`  MKXFORM.setValue(${JSON.stringify(model.field.id)}, JSON.stringify(${state}));`, "  return true;");
  else {
    const init = model.initializer;
    if (init.reader) lines.push("  " + rewrite(init.reader.node, init.reader.entry, model, { reader: true, state }).replace(/\n/g, "\n  "));
    for (const statement of init.prefixStatements) lines.push("  " + rewrite(statement, init.entry, model, { state }).replace(/\n/g, "\n  "));
  }
  return [...lines, "}"].join("\n");
}

function rewrite(node, entry, model, options) {
  const replacements = [], init = model.initializer;
  walk(node, child => {
    if (stateReference(child, entry, model)) replacements.push({ start: child.start, end: child.end, text: options.state });
    else if (child.type === "Identifier" && init.reader && child.name === init.reader.node.id.name &&
      (child === init.reader.node.id || functionReference(child, entry, { ...init.reader, name: init.reader.node.id.name }, model.entries, model.domain))) replacements.push({ start: child.start, end: child.end, text: model.readerName });
    else if (child.type === "Identifier" && init.max && constantReference(child, entry, init.max)) replacements.push({ start: child.start, end: child.end, text: String(init.max.value) });
  });
  if (node.start <= init.read.start && node.end >= init.read.end) replacements.push({ start: init.read.start, end: init.read.end,
    text: `[{ value: String(MKXFORM.getValue(${JSON.stringify(model.field.id)}) ?? "") }]` });
  return replacements.sort((a, b) => b.start - a.start).reduce((text, replacement) => text.slice(0, replacement.start - node.start) + replacement.text + text.slice(replacement.end - node.start), entry.source.javascript.slice(node.start, node.end));
}

function callbackBoundaries(entry) {
  return entry.ast.body.flatMap(statement => {
    const node = statement.expression;
    if (call(node, "AttachXFormValueChangeEventById") && node.arguments.length === 2 && typeof value(node.arguments[0]) === "string" && entry.bindings.isUnshadowedGlobal(node.callee.name, node.start)) return [{ call: node, fn: node.arguments[1], event: "onChange", controlId: value(node.arguments[0]) }];
    if (call(node, "Com_AddEventListener") && node.arguments.length === 3 && id(node.arguments[0], "window") && value(node.arguments[1]) === "load" && entry.bindings.isUnshadowedGlobal(node.callee.name, node.start) && entry.bindings.isUnshadowedGlobal("window", node.start)) return [{ call: node, fn: node.arguments[2], event: "onLoad" }];
    if (node?.type === "CallExpression" && node.arguments.length === 1 && node.callee?.type === "MemberExpression" && !node.callee.computed && id(node.callee.property, "push") &&
      node.callee.object?.type === "MemberExpression" && node.callee.object.computed && value(node.callee.object.property) === "submit" && member(node.callee.object.object, "Com_Parameter", "event") && entry.bindings.isUnshadowedGlobal("Com_Parameter", node.start)) return [{ call: node, fn: node.arguments[0], event: "onBeforeSubmit" }];
    return [];
  });
}
function immutableInteger(name, entries) {
  const defs = entries.flatMap(entry => entry.ast.body.flatMap(node => node.type === "VariableDeclaration" && node.kind === "var" ? node.declarations.filter(d => d.id.name === name).map(d => ({ name, node, declaration: d, entry, value: value(d.init) })) : []));
  if (defs.length !== 1 || defs[0].node.declarations.length !== 1 || !Number.isInteger(defs[0].value) || defs[0].value < 0 || defs[0].value > 1000) return undefined;
  let valid = true; for (const entry of entries) walk(entry.ast, (node, parent) => { if (node.type === "Identifier" && node.name === name && node !== defs[0].declaration.id &&
    (parent?.type === "AssignmentExpression" && parent.left === node || parent?.type === "UpdateExpression")) valid = false; });
  return valid ? defs[0] : undefined;
}
function stableGlobal(name, entries) {
  let valid = true; for (const entry of entries) walk(entry.ast, (node, parent) => {
    if (node.type !== "Identifier" || node.name !== name || parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return;
    if (!entry.bindings.isUnshadowedGlobal(name, node.start)) valid = false;
    const ancestor = parent?.type === "MemberExpression" && parent.object === node ? entry.parents.get(parent) : parent;
    if (ancestor?.type === "AssignmentExpression" && (ancestor.left === node || ancestor.left === parent) || ancestor?.type === "UpdateExpression") valid = false;
  }); return valid;
}
function stateReference(node, entry, model) { return id(node, model.name) && !(entry.parents.get(node)?.type === "MemberExpression" && entry.parents.get(node).property === node && !entry.parents.get(node).computed) && (entry === model.declaration.entry ? entry.bindings.bindingAtUse(node.name, node.start) === model.binding : entry.bindings.isUnshadowedGlobal(node.name, node.start)); }
function constantReference(node, entry, definition) { return id(node, definition.name) && (entry === definition.entry ? entry.bindings.bindingAtUse(node.name, node.start) === entry.bindings.bindingAtUse(node.name, definition.declaration.id.start) : entry.bindings.isUnshadowedGlobal(node.name, node.start)); }
function functionReference(node, entry, definition, entries, domain) {
  if (!id(node, definition.name || definition.node.id.name) || effectiveFunction(node.name, entries, domain)?.node !== definition.node) return false;
  const binding = entry.bindings.bindingAtUse(node.name, node.start);
  return !binding ? entry.bindings.isUnshadowedGlobal(node.name, node.start) : binding.scope.kind === "program" && binding.kinds.has("function");
}
function effectiveFunction(name, entries, domain) {
  const definitions = entries.flatMap(entry => entry.ast.body.filter(node => node.type === "FunctionDeclaration" && node.id?.name === name).map(node => ({ node, entry, name })));
  if (definitions.length === 1 && uniqueFunction(name, entries, definitions[0].node)) return definitions[0];
  if (!domain || definitions.length < 2 || definitions.some(definition => definitions.filter(other => other.entry === definition.entry).length !== 1)) return undefined;
  let stable = true;
  for (const entry of entries) walk(entry.ast, (node, parent) => {
    if (node.type === "FunctionDeclaration" && node.id?.name === name && parent !== entry.ast || node.type === "VariableDeclarator" && node.id?.name === name ||
      node.type === "AssignmentExpression" && (id(node.left, name) || node.left?.type === "MemberExpression" && ["window", "self", "globalThis"].includes(node.left.object?.name) && (node.left.computed ? value(node.left.property) === name : id(node.left.property, name)))) stable = false;
  });
  if (!stable) return undefined;
  const ordered = definitions.map(definition => ({ ...definition, record: domain.scripts.find(record => record.sourceRef === ref(definition.entry.source)) })).sort((left, right) => left.record.order - right.record.order);
  const final = ordered.at(-1);
  return final.record.gate === undefined ? final : undefined;
}
function uniqueFunction(name, entries, expected) { let count = 0, valid = true; for (const entry of entries) walk(entry.ast, (node, parent) => { if (node.type === "FunctionDeclaration" && node.id?.name === name) { count += 1; if (node !== expected || parent !== entry.ast) valid = false; } if (node.type === "VariableDeclarator" && node.id?.name === name || node.type === "AssignmentExpression" && (id(node.left, name) || node.left?.type === "MemberExpression" && ["window", "self", "globalThis"].includes(node.left.object?.name) && (node.left.computed ? value(node.left.property) === name : id(node.left.property, name)))) valid = false; }); return valid && count === 1; }
function parseStatements(text) { return parse(text, { ecmaVersion: "latest" }).body; }
function same(left, right) { const normalize = value => JSON.stringify(value, (key, child) => ["start", "end", "raw"].includes(key) ? undefined : child); return normalize(left) === normalize(right); }
function fresh(names, stem) { let result = stem; for (let i = 0; names.has(result); i += 1) result = stem + i; names.add(result); return result; }
function ref(source) { return source.sourceRef || source.id; }
function nonEmpty(body = []) { return body.filter(node => node.type !== "EmptyStatement"); }
function singleDeclaration(node) { return node?.type === "VariableDeclaration" && node.kind === "var" && node.declarations.length === 1 && node.declarations[0].id.type === "Identifier" ? node.declarations[0] : undefined; }
function plain(node) { return node?.type === "FunctionExpression" && !node.async && !node.generator && !node.id && node.params.every(node => node.type === "Identifier") && new Set(node.params.map(node => node.name)).size === node.params.length; }
function id(node, name) { return node?.type === "Identifier" && node.name === name; }
function value(node) { return node?.type === "Literal" ? node.value : undefined; }
function call(node, name) { return node?.type === "CallExpression" && !node.optional && node.callee.type === "Identifier" && (!name || node.callee.name === name); }
function member(node, object, property) { return node?.type === "MemberExpression" && !node.computed && !node.optional && id(node.object, object) && id(node.property, property); }
function memberCall(node, object, property) { return node?.type === "CallExpression" && !node.optional && member(node.callee, object, property); }
function walk(node, visit, parent) { if (!node || typeof node !== "object") return; visit(node, parent); for (const value of Object.values(node)) if (value && typeof value === "object") Array.isArray(value) ? value.forEach(child => walk(child, visit, node)) : walk(value, visit, node); }
