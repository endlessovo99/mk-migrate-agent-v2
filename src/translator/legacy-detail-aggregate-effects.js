import { parse } from "acorn";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";
import { inlineOnChangeSourceActionKey } from "./source-action-key.js";

const BASIS = "deterministic-legacy-detail-aggregate-effects";

// Only independently proven listeners are returned. Unrelated callbacks and
// shared-state helpers remain on the normal source-review path.
export function legacyDetailAggregateEffectCandidates(source = {}, form = {}, sourceScripts = {}) {
  const entries = registryEntries(source, sourceScripts);
  const entry = entries.find(item => item.source === source);
  if (!entry) return [];
  const registry = { entries, form };
  const bindings = entry.ast.body.flatMap(statement => valueChangeBinding(statement, entry));
  const candidates = [];
  for (const [bindingIndex, binding] of bindings.entries()) {
    const handler = resolveFunction(binding.handler, entry, binding.handlerCallIndex, registry);
    if (!handler) continue;
    const sum = numericRowSum(handler, registry);
    const aggregate = sum ? undefined : anyRowAggregate(handler, registry);
    const model = sum || aggregate;
    if (!model) continue;
    if (sum && (binding.arguments.length !== 1 || !identifier(binding.arguments[0], binding.domName))) continue;
    if (aggregate && binding.arguments.length) continue;
    const table = uniqueTable(form, [binding.controlId, ...model.columnIds]);
    if (!table || model.tableId && model.tableId !== table.id) continue;
    if (sum && !model.columnIds.every(id => table.columns.find(column => column.id === id)?.type === "number")) continue;
    if (sum && table.columns.find(column => column.id === sum.targetId)?.props?.calculation) continue;
    if (aggregate) {
      const column = table.columns.find(column => column.id === aggregate.fieldId);
      if (!["text", "number", "radio"].includes(column?.type) || column.props?.multiple === true) continue;
      if (!form.fields.some(field => field.id === aggregate.targetId && field.type !== "detailTable" && field.dataOnly !== true)) continue;
    }
    const sourceRef = source.sourceRef || source.id;
    const definitions = [handler, ...model.dependencies];
    const sourceRefs = [...new Set([sourceRef, ...definitions.map(definition => definition.entry.source.sourceRef || definition.entry.source.id)])];
    candidates.push({
      id: (source.id || "script") + ".event." + (bindingIndex + 1), index: binding.call.start,
      sourceActionKey: inlineOnChangeSourceActionKey(sourceRef, binding.call.start),
      event: "onChange", scope: "control", controlId: binding.controlId, tableId: table.id,
      javascript: source.javascript, source, sourceRefs,
      function: sum ? renderSum(sum, table.id) : renderAny(aggregate, table.id),
      translationStatus: "mapped", coverage: { status: "translated", nativeRules: [], residuals: [] },
      functionMappings: [{ source: sum ? "same-row numeric reads, proven decimal rounding and conditional write" : "proven current-row enumeration and ordered existential predicate",
        target: "MKXFORM.getValue + synchronous detail/main value writes", basis: BASIS, reviewRequired: false }],
      semanticHints: { coveredCalculationRanges: [
        ...definitions.map(definition => ({ sourceRef: definition.entry.source.sourceRef || definition.entry.source.id,
          name: definition.node.id.name, start: definition.node.start, end: definition.node.end })),
        { sourceRef, name: "detailAggregateListener:" + binding.controlId, start: binding.call.start, end: binding.call.end }
      ] }
    });
  }
  return candidates;
}

function numericRowSum(definition, registry) {
  const fn = definition.node;
  if (fn.params.length !== 1 || fn.params[0].type !== "Identifier") return undefined;
  const body = statements(fn.body);
  if (body.length !== 5 || !["Number", "GetXFormSameRowFieldById"].every(name => globalsStable(definition.entry, name, registry))) return undefined;
  const first = numberRowRead(body[0], fn.params[0].name, definition.entry);
  const second = numberRowRead(body[1], fn.params[0].name, definition.entry);
  const output = declaration(body[2]), outputId = sameRowElement(output?.init, fn.params[0].name, definition.entry);
  const total = declaration(body[3]), roundingCall = total?.init;
  if (!first || !second || !outputId || !total || !callIdentifier(roundingCall) || roundingCall.arguments.length !== 1) return undefined;
  const add = roundingCall.arguments[0];
  if (add?.type !== "BinaryExpression" || add.operator !== "+" || !identifier(add.left, first.name) || !identifier(add.right, second.name)) return undefined;
  const rounding = resolveFunction(roundingCall.callee.name, definition.entry, roundingCall.start, registry);
  if (!distinct([fn.params[0].name, first.name, second.name, output.id.name, total.id.name])) return undefined;
  const precision = rounding && decimalRounding(rounding, registry);
  if (precision === undefined) return undefined;
  const branch = body[4], condition = branch?.test;
  if (branch?.type !== "IfStatement" || !branch.alternate || condition?.type !== "BinaryExpression" ||
      ![">", ">=", "<", "<=", "==", "==="].includes(condition.operator) || !identifier(condition.left, total.id.name) || !finiteNumber(condition.right)) return undefined;
  const yes = fieldWrite(singleExpression(branch.consequent), output.id.name);
  const no = fieldWrite(singleExpression(branch.alternate), output.id.name);
  if (!identifier(yes, total.id.name) || !finiteNumber(no)) return undefined;
  return { columnIds: [first.fieldId, second.fieldId, outputId], inputIds: [first.fieldId, second.fieldId], targetId: outputId,
    precision, operator: condition.operator, threshold: numberValue(condition.right), fallback: numberValue(no), dependencies: [rounding] };
}

function decimalRounding(definition, registry) {
  const fn = definition.node, body = statements(fn.body);
  if (fn.params.length !== 1 || fn.params[0].type !== "Identifier" || body.length !== 3) return undefined;
  const precision = declaration(body[0]), power = declaration(body[1]), result = body[2];
  if (!precision || !finiteNumber(precision.init) || !power || !mathCall(power.init, "pow", definition.entry) || power.init.arguments.length !== 2 ||
      !literal(power.init.arguments[0], 10) || !identifier(power.init.arguments[1], precision.id.name)) return undefined;
  if (!distinct([fn.params[0].name, precision.id.name, power.id.name]) || !globalsStable(definition.entry, "Math", registry)) return undefined;
  const value = numberValue(precision.init), multiplier = Math.pow(10, value);
  if (!Number.isInteger(value) || !Number.isFinite(multiplier) || multiplier <= 0 || result.type !== "ReturnStatement") return undefined;
  const quotient = result.argument;
  if (quotient?.type !== "BinaryExpression" || quotient.operator !== "/" || !identifier(quotient.right, power.id.name) ||
      !mathCall(quotient.left, "round", definition.entry) || quotient.left.arguments.length !== 1) return undefined;
  const product = quotient.left.arguments[0];
  return product?.type === "BinaryExpression" && product.operator === "*" && identifier(product.left, fn.params[0].name) && identifier(product.right, power.id.name) ? value : undefined;
}

function anyRowAggregate(definition, registry) {
  const fn = definition.node, body = statements(fn.body);
  if (fn.params.length || body.length !== 6) return undefined;
  const table = declaration(body[0]), field = declaration(body[1]), rows = declaration(body[2]), flag = declaration(body[3]);
  if (!table || !stringLiteral(table.init) || !field || !stringLiteral(field.init) || !rows || !flag || !primitiveLiteral(flag.init)) return undefined;
  const readerCall = rows.init;
  if (!callIdentifier(readerCall) || readerCall.arguments.length !== 2 || !identifier(readerCall.arguments[0], table.id.name) ||
      readerCall.arguments[1]?.type !== "ArrayExpression" || readerCall.arguments[1].elements.length !== 1 || !identifier(readerCall.arguments[1].elements[0], field.id.name)) return undefined;
  const reader = resolveFunction(readerCall.callee.name, definition.entry, readerCall.start, registry);
  const dependencies = reader && rowReaderDependencies(reader, registry);
  if (!dependencies) return undefined;
  const loop = body[4], counter = declaration(loop?.init);
  if (loop?.type !== "ForStatement" || !counter || !literal(counter.init, 0) || loop.test?.type !== "BinaryExpression" || loop.test.operator !== "<" ||
      !identifier(loop.test.left, counter.id.name) || !member(loop.test.right, "length") || !identifier(loop.test.right.object, rows.id.name) ||
      loop.update?.type !== "UpdateExpression" || loop.update.operator !== "++" || !identifier(loop.update.argument, counter.id.name)) return undefined;
  const loopBody = statements(loop.body), row = declaration(loopBody[0]), branch = loopBody[1];
  if (loopBody.length !== 2 || !row || !computed(row.init, rows.id.name, counter.id.name) || branch?.type !== "IfStatement" || branch.alternate) return undefined;
  if (!distinct([table.id.name, field.id.name, rows.id.name, flag.id.name, counter.id.name, row.id.name])) return undefined;
  const clauses = rowPredicate(branch.test, row.id.name, field.id.name);
  const effects = statements(branch.consequent), change = effects[0]?.expression;
  if (!clauses || effects.length !== 2 || change?.type !== "AssignmentExpression" || change.operator !== "=" || !identifier(change.left, flag.id.name) ||
      !primitiveLiteral(change.right) || effects[1].type !== "BreakStatement" || effects[1].label) return undefined;
  const write = body[5]?.expression;
  if (!callIdentifier(write, "SetXFormFieldValueById") || write.arguments.length !== 2 || !stringLiteral(write.arguments[0]) || !identifier(write.arguments[1], flag.id.name) ||
      !definition.entry.bindings.isUnshadowedGlobal("SetXFormFieldValueById", write.start)) return undefined;
  return { tableId: table.init.value, fieldId: field.init.value, columnIds: [field.init.value], targetId: write.arguments[0].value,
    whenFalse: flag.init.value, whenTrue: change.right.value, clauses, dependencies: [reader, ...dependencies] };
}

function rowReaderDependencies(definition, registry) {
  const body = statements(definition.node.body), outer = body[2]?.consequent?.body?.[0], inner = outer?.body?.body?.[1];
  const builderCall = declaration(inner?.body?.body?.[0])?.init, getterCall = declaration(inner?.body?.body?.[2])?.init;
  if (!callIdentifier(builderCall) || !callIdentifier(getterCall)) return undefined;
  const builder = resolveFunction(builderCall.callee.name, definition.entry, builderCall.start, registry);
  const getter = resolveFunction(getterCall.callee.name, definition.entry, getterCall.start, registry);
  if (!builder || !getter || !sameFunctionShape(definition.node, ROW_READER,
    new Map([[builderCall.callee.name, "__fieldName"], [getterCall.callee.name, "__readField"]])) ||
      !sameFunctionShape(builder.node, FIELD_NAME) || !sameFunctionShape(getter.node, FIELD_READER)) return undefined;
  for (const [helper, globals] of [[definition, ["DocList_TableInfo", "Object"]], [getter, ["$", "GetXFormFieldValueById"]]]) {
    if (!globals.every(name => globalsStable(helper.entry, name, registry))) return undefined;
  }
  return [builder, getter];
}

function rowPredicate(node, rowName, fieldName) {
  if (node?.type === "LogicalExpression" && node.operator === "||") {
    const left = rowPredicate(node.left, rowName, fieldName), right = rowPredicate(node.right, rowName, fieldName);
    return left && right ? [...left, ...right] : undefined;
  }
  return node?.type === "BinaryExpression" && ["==", "==="].includes(node.operator) && computed(node.left, rowName, fieldName) && primitiveLiteral(node.right)
    ? [{ operator: node.operator, value: node.right.value }] : undefined;
}

function distinct(names) { return new Set(names).size === names.length; }
function detailRef(table, id) { return JSON.stringify("$" + "{table:" + table + "}" + (id ? "." + id : "")); }
function renderSum(model, tableId) {
  return ["function onChange(value, rowNum, parentRowNum) {",
    ...model.inputIds.map((id, index) => "  var operand" + index + " = Number(MKXFORM.getValue(" + detailRef(tableId, id) + ', { detailRowIndex: rowNum }) ?? "");'),
    "  var power = Math.pow(10, " + model.precision + ");",
    "  var result = Math.round((operand0 + operand1) * power) / power;",
    "  MKXFORM.updateControl(" + detailRef(tableId, model.targetId) + ", rowNum, result " + model.operator + " " + model.threshold + " ? result : " + model.fallback + ");", "}"].join("\n");
}
function renderAny(model, tableId) {
  const conditions = model.clauses.map(clause => "current " + clause.operator + " " + JSON.stringify(clause.value)).join(" || ");
  return ["function onChange(value, rowNum, parentRowNum) {",
    "  var raw = MKXFORM.getValue(" + detailRef(tableId) + ");",
    "  var rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.values) ? raw.values : []);",
    "  var result = " + JSON.stringify(model.whenFalse) + ";",
    "  for (var index = 0; index < rows.length; index += 1) {",
    "    var current = rows[index][" + JSON.stringify(model.fieldId) + "];",
    "    current = Array.isArray(current) ? current[0] : current;",
    '    current = current === undefined || current === null ? "" : String(current);',
    "    if (" + conditions + ") { result = " + JSON.stringify(model.whenTrue) + "; break; }",
    "  }", "  MKXFORM.setValue(" + JSON.stringify(model.targetId) + ", result);", "}"].join("\n");
}

function registryEntries(source, sourceScripts) {
  const sources = [...new Set([...(sourceScripts.sources || []), source])];
  return sources.flatMap(item => {
    try { const ast = parse(String(item.javascript || ""), { ecmaVersion: "latest" });
      return [{ source: item, ast, bindings: buildJavaScriptBindingModel(item.javascript) }]; }
    catch { return []; }
  });
}
function resolveFunction(name, entry, index, registry) {
  const binding = entry.bindings.bindingAtUse(name, index);
  if (binding && (binding.scope.kind !== "program" || [...binding.kinds].some(kind => kind !== "function"))) return undefined;
  const definitions = registry.entries.flatMap(item => item.ast.body.filter(node => node.type === "FunctionDeclaration" && node.id?.name === name).map(node => ({ entry: item, node })));
  if (!definitions.length || new Set(definitions.map(item => item.entry)).size !== 1 || mutated(name, registry)) return undefined;
  const selected = definitions.at(-1);
  return !selected.node.async && !selected.node.generator && selected.node.params.every(node => node.type === "Identifier") ? selected : undefined;
}
function mutated(name, registry) {
  let changed = false;
  for (const entry of registry.entries) walk(entry.ast, node => {
    if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") {
      let target = node.left || node.argument;
      while (target?.type === "MemberExpression") target = target.object;
      if (identifier(target, name)) changed = true;
    }
    if (node.type === "VariableDeclarator" && identifier(node.id, name)) changed = true;
  });
  return changed;
}
function globalsStable(entry, name, registry) { return entry.bindings.isUnshadowedGlobal(name, 0) && !mutated(name, registry); }
function valueChangeBinding(statement, entry) {
  const call = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  if (!callIdentifier(call, "AttachXFormValueChangeEventById") || call.arguments.length !== 2 || !stringLiteral(call.arguments[0]) ||
      !entry.bindings.isUnshadowedGlobal("AttachXFormValueChangeEventById", call.start)) return [];
  const callback = call.arguments[1], body = statements(callback?.body);
  if (callback?.type !== "FunctionExpression" || callback.async || callback.generator || callback.id || callback.params.length !== 2 ||
      callback.params.some(node => node.type !== "Identifier") || body.length !== 1 || !callIdentifier(body[0]?.expression)) return [];
  return [{ call, controlId: call.arguments[0].value, handler: body[0].expression.callee.name, handlerCallIndex: body[0].expression.start, arguments: body[0].expression.arguments, domName: callback.params[1].name, valueName: callback.params[0].name }];
}
function numberRowRead(statement, domName, entry) {
  const item = declaration(statement), call = item?.init;
  if (!item || !callIdentifier(call, "Number") || call.arguments.length !== 1 || !entry.bindings.isUnshadowedGlobal("Number", call.start) || !member(call.arguments[0], "value")) return undefined;
  const fieldId = sameRowElement(call.arguments[0].object, domName, entry);
  return fieldId ? { name: item.id.name, fieldId } : undefined;
}
function sameRowElement(node, domName, entry) {
  const call = node?.object;
  return node?.type === "MemberExpression" && node.computed && literal(node.property, 0) && callIdentifier(call, "GetXFormSameRowFieldById") &&
    call.arguments.length === 2 && identifier(call.arguments[0], domName) && stringLiteral(call.arguments[1]) && entry.bindings.isUnshadowedGlobal("GetXFormSameRowFieldById", call.start)
    ? call.arguments[1].value : undefined;
}
function mathCall(node, method, entry) {
  return node?.type === "CallExpression" && !node.optional && member(node.callee, method) && identifier(node.callee.object, "Math") && entry.bindings.isUnshadowedGlobal("Math", node.start);
}
function uniqueTable(form, ids) {
  const tables = (form.fields || []).filter(field => field.type === "detailTable" && ids.every(id => field.columns?.some(column => column.id === id)));
  return tables.length === 1 ? tables[0] : undefined;
}
function declaration(node) { return node?.type === "VariableDeclaration" && node.kind === "var" && node.declarations.length === 1 && node.declarations[0].id.type === "Identifier" ? node.declarations[0] : undefined; }
function fieldWrite(node, alias) { return node?.type === "AssignmentExpression" && node.operator === "=" && member(node.left, "value") && identifier(node.left.object, alias) ? node.right : undefined; }
function singleExpression(node) { const body = statements(node); return body.length === 1 && body[0].type === "ExpressionStatement" ? body[0].expression : undefined; }
function statements(node) { return node?.type === "BlockStatement" ? node.body.filter(node => node.type !== "EmptyStatement") : node ? [node] : []; }
function callIdentifier(node, name) { return node?.type === "CallExpression" && !node.optional && node.callee?.type === "Identifier" && (!name || node.callee.name === name); }
function identifier(node, name) { return node?.type === "Identifier" && node.name === name; }
function member(node, name) { return node?.type === "MemberExpression" && !node.optional && !node.computed && identifier(node.property, name); }
function computed(node, object, property) { return node?.type === "MemberExpression" && !node.optional && node.computed && identifier(node.object, object) && identifier(node.property, property); }
function literal(node, value) { return node?.type === "Literal" && node.value === value; }
function stringLiteral(node) { return node?.type === "Literal" && typeof node.value === "string"; }
function primitiveLiteral(node) { return node?.type === "Literal" && (["string", "boolean"].includes(typeof node.value) || typeof node.value === "number" && Number.isFinite(node.value)); }
function finiteNumber(node) { return Number.isFinite(numberValue(node)); }
function numberValue(node) { return node?.type === "Literal" && typeof node.value === "number" ? node.value : node?.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "Literal" && typeof node.argument.value === "number" ? -node.argument.value : undefined; }
function walk(node, visit) { if (!node || typeof node !== "object") return; visit(node); for (const child of Object.values(node)) { if (Array.isArray(child)) child.forEach(item => walk(item, visit)); else if (child && typeof child === "object") walk(child, visit); } }

function sameFunctionShape(node, template, globals = new Map()) {
  const expected = parse(template, { ecmaVersion: "latest" }).body[0];
  return JSON.stringify(alphaShape(node, globals)) === JSON.stringify(alphaShape(expected));
}
function alphaShape(fn, globals = new Map()) {
  const names = new Map([[fn.id.name, "$function"]]);
  fn.params.forEach((param, index) => names.set(param.name, "$parameter" + index));
  walk(fn.body, node => { if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && !names.has(node.id.name)) names.set(node.id.name, "$local" + names.size); });
  const shape = (node, parent, key) => {
    if (Array.isArray(node)) return node.map(item => shape(item));
    if (!node || typeof node !== "object") return node;
    if (node.type === "Identifier") {
      const property = parent?.type === "MemberExpression" && key === "property" && !parent.computed;
      return { type: node.type, name: property ? node.name : names.get(node.name) || globals.get(node.name) || node.name };
    }
    return Object.fromEntries(Object.entries(node).filter(([name]) => !["start", "end", "raw"].includes(name)).map(([name, child]) => [name, shape(child, node, name)]));
  };
  return shape(fn);
}


const FIELD_NAME = "function fieldAddress(tbId, columnId) {\n            return 'extendDataFormInfo.value(' + tbId + '.!{index}.' + columnId + ')';\n        }";
const ROW_READER = "function collectCurrentRows(tbId, fieldIds, containSelectText) {\n            var detailValue = [];\n            var tbInfo = DocList_TableInfo[\"TABLE_DL_\" + tbId];\n            if (tbInfo) {\n                for (var i = 0; i < tbInfo.lastIndex - 1; i++) {\n                    var rowValue = new Object();\n                    for (var j = 0; j < fieldIds.length; ++j) {\n                        var detailFieldId = __fieldName(tbId, fieldIds[j]);\n                        var rowFieldId = detailFieldId.replace('!{index}', i);\n                        var rowFieldValue = __readField(rowFieldId, 'table', containSelectText);\n                        rowValue[fieldIds[j]] = rowFieldValue ? rowFieldValue : '';\n                    }\n                    detailValue.push(rowValue);\n                }\n            }\n            return detailValue;\n        }";
const FIELD_READER = "function readSourceField(elementId, type, containSelectText) {\n            if (type == 'radio') {\n                return $('input[name=\"extendDataFormInfo.value(' + elementId + ')\"]:checked').val();\n            } else if (type == 'select') {\n                return $('select[name=\"extendDataFormInfo.value(' + elementId + ')\"]').val();\n            } else if (type == 'table') {\n                var doms = $('[name=\"' + elementId + '\"]');\n                if (doms && doms.length > 0) {\n                    if (doms[0].type == 'radio') {\n                        return $('[name=\"' + elementId + '\"]:checked').val();\n                    } else if (doms[0].tagName === 'SELECT' && containSelectText) {\n                        var field = $('[name=\"' + elementId + '\"]');\n                        var text = field.find(\"option:selected\").text();\n                        var val = field.val();\n                        return ((text ? text : '') + \"|\" + (val ? val : ''));\n                    }\n                }\n                return $('[name=\"' + elementId + '\"]').val();\n            } else {\n                var elementVal = $('[name=\"' + elementId + '\"]').val();\n                if (elementVal) {\n                    return elementVal;\n                }\n                var elementVal = GetXFormFieldValueById(elementId);\n                return elementVal && elementVal.length == 1 ? elementVal[0] : elementVal;\n            }\n        }";

export function legacyPersonTextCountCandidates(source = {}, form = {}, sourceScripts = {}) {
  const entries = registryEntries(source, sourceScripts), entry = entries.find(item => item.source === source);
  if (!entry) return [];
  const registry = { entries, form };
  return entry.ast.body.flatMap(statement => valueChangeBinding(statement, entry)).flatMap((binding, index) => {
    const input = form.fields?.find(field => field.id === binding.controlId);
    if (!input || input.dataOnly === true || !["text", "longText"].includes(input.type) || !["xform-input", "xform-textarea"].includes(input.componentId) ||
        binding.arguments.length !== 2 || !identifier(binding.arguments[0], binding.valueName) || !stringLiteral(binding.arguments[1])) return [];
    const targetId = binding.arguments[1].value;
    const target = form.fields.find(field => field.id === targetId);
    if (target?.type !== "number" || target.dataOnly === true || target.props?.calculation) return [];
    const wrapper = resolveFunction(binding.handler, entry, binding.handlerCallIndex, registry);
    if (!wrapper || wrapper.node.params.length !== 2) return [];
    const body = statements(wrapper.node.body), result = declaration(body[0]), write = body[1]?.expression;
    const params = wrapper.node.params.map(node => node.name);
    if (body.length !== 2 || !result || !distinct([...params, result.id.name]) || !callIdentifier(result.init) || result.init.arguments.length !== 1 ||
        !identifier(result.init.arguments[0], params[0]) || !callIdentifier(write, "SetXFormFieldValueById") || write.arguments.length !== 2 ||
        !identifier(write.arguments[0], params[1]) || !identifier(write.arguments[1], result.id.name) ||
        !globalsStable(wrapper.entry, "SetXFormFieldValueById", registry)) return [];
    const counter = resolveFunction(result.init.callee.name, wrapper.entry, result.init.start, registry);
    if (!counter || !sameFunctionShape(counter.node, PERSON_COUNT) ||
        !["RegExp", "String"].every(name => globalsStable(counter.entry, name, registry))) return [];
    const sourceRef = source.sourceRef || source.id;
    const counterText = counter.entry.source.javascript.slice(counter.node.id.end, counter.node.end);
    const sourceRefs = [...new Set([sourceRef, wrapper.entry.source.sourceRef || wrapper.entry.source.id, counter.entry.source.sourceRef || counter.entry.source.id])];
    return [{
      id: (source.id || "script") + ".event." + (index + 1), index: binding.call.start,
      sourceActionKey: inlineOnChangeSourceActionKey(sourceRef, binding.call.start),
      event: "onChange", scope: "control", controlId: binding.controlId, source, sourceRefs, javascript: source.javascript,
      function: ["function onChange(value, rowNum, parentRowNum) {", "  function countSourceText" + counterText,
        "  MKXFORM.setValue(" + JSON.stringify(targetId) + ", countSourceText(value));", "}"].join("\n"),
      translationStatus: "mapped", coverage: { status: "translated", nativeRules: [], residuals: [] },
      functionMappings: [{ source: "complete literal delimiter normalization and non-empty segment count", target: "source-equivalent pure string helper + MKXFORM.setValue",
        basis: "deterministic-legacy-person-text-count", reviewRequired: false }],
      semanticHints: { coveredCalculationRanges: [
        ...[wrapper, counter].map(definition => ({ sourceRef: definition.entry.source.sourceRef || definition.entry.source.id,
          name: definition.node.id.name, start: definition.node.start, end: definition.node.end })),
        { sourceRef, name: "textCountListener:" + binding.controlId, start: binding.call.start, end: binding.call.end }
      ] }
    }];
  });
}


const PERSON_COUNT = "function countSeparatedNames(paramsStrArr) {\n            // 人员字符串\n            paramsStrArr = paramsStrArr.replace(/，/g, \"、\")\n                                            .replace(/,/g, \"、\")\n                                            .replace(/\\//g, \"、\")\n                                            .replace(/\\\\/g,\"、\")\n                                            .replace(/\\n/g,\"、\")\n                                            .replace(/、、/g,\"、\")\n                                            .replace(/、、/g,\"、\");\n            var fdNameArr = paramsStrArr.split(\"、\");\n\n            var relCount = 0;\n            for (var index = 0; index < fdNameArr.length; index++) {\n                if (fdNameArr[index].length > 0) {\n                    relCount++;\n                }\n            }\n            \n            return relCount;\n        }";
