import { parse } from "acorn";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";
import { resolveControlEventSupport } from "../dsl/scripts.js";
import { compileStaticRowEffect } from "./inline-radio-row-effects.js";
import { inlineOnChangeSourceActionKey } from "./source-action-key.js";
import { approvedScalarStringReadExpression } from "./approved-scalar-string-read.js";

export const LITERAL_ARRAY_ROW_LIFECYCLE_BASIS = "deterministic-literal-array-row-lifecycle";
const ROW_HELPER = "common_dom_row_set_show_required_reset";

export function literalArrayRowLifecycleCandidates(source = {}, form = {}, sourceScripts = {}, options = {}) {
  const approved = options.approvedScalarReadFieldIds;
  if (approved !== undefined && (!Array.isArray(approved) || new Set(approved).size !== approved.length ||
      approved.some(id => !approvedScalarStringReadExpression(id, form, approved)))) return [];
  const approvedScalarReadFieldIds = new Set(approved || []);
  const text = String(source.javascript || ""), sourceRef = source.sourceRef || source.id;
  let program;
  try { program = parse(text, { ecmaVersion: "latest" }); } catch { return []; }
  const bindings = buildJavaScriptBindingModel(text);
  if (!sourceRef || !bindings.ok || hasUnsupportedGlobalExposure(program, bindings)) return [];
  const parents = new WeakMap();
  walk(program, (node, parent) => { if (parent) parents.set(node, parent); });
  const definitions = new Map(), callbacks = [];
  for (const statement of nonEmpty(program.body)) {
    if (statement.type === "FunctionDeclaration") {
      if (!statement.id || definitions.has(statement.id.name) || statement.async || statement.generator || statement.params.length) return [];
      definitions.set(statement.id.name, statement);
    } else {
      const callback = callbackBoundary(statement, bindings);
      if (!callback) return [];
      callbacks.push(callback);
    }
  }
  if (!crossSourceBindingsStable(source, definitions, sourceScripts)) return [];
  const actions = [], usedDefinitions = new Set();
  for (const [ordinal, boundary] of callbacks.entries()) {
    const field = boundary.event === "onChange" ? mainField(form, boundary.controlId) : undefined;
    if (boundary.event === "onChange" && (!field || resolveControlEventSupport({ kind: "field", field }, "onChange").status !== "supported")) continue;
    const fn = boundary.callback;
    if (!plainFunction(fn) || (boundary.event === "onLoad" ? fn.params.length : ![1, 2].includes(fn.params.length))) continue;
    const usedNames = new Set(["value", "rowNum", "parentRowNum", "MKXFORM", "String", "Array", "console", "setTimeout"]);
    walk(program, node => { if (node.type === "Identifier") usedNames.add(node.name); });
    const environment = { sourceRef, text, form, bindings, parents, definitions, usedNames, program, serial: 0, approvedScalarReadFieldIds };
    let body = fn.body, timer;
    const bodyStatements = nonEmpty(body.body), possibleTimer = bodyStatements.length === 1 ? bodyStatements[0].expression : undefined;
    if (boundary.event === "onLoad" && callId(possibleTimer, "setTimeout")) {
      timer = possibleTimer;
      if (!bindings.isUnshadowedGlobal("setTimeout", timer.start) || timer.arguments.length !== 2 || !plainFunction(timer.arguments[0]) ||
          timer.arguments[0].params.length || !Number.isInteger(literal(timer.arguments[1])) || literal(timer.arguments[1]) < 0 || literal(timer.arguments[1]) > 2147483647) continue;
      body = timer.arguments[0].body;
    }
    const frame = newFrame(environment, fn, boundary.event === "onChange" ? fn.params[0].name : undefined, false);
    const lines = compileBlock(body, frame, timer ? "    " : "  ");
    if (!lines || !frame.rowEffects || !frame.membership && !frame.helpers.size) continue;
    const ranges = [
      { sourceRef, name: "literalArrayRowCallback", start: boundary.call.start, end: boundary.call.end },
      ...[...frame.helpers.values()].map(helper => ({ sourceRef, name: helper.node.id.name, start: helper.node.start, end: helper.node.end }))
    ];
    const functionText = ["function " + boundary.event + "(" + (boundary.event === "onChange" ? "value, rowNum, parentRowNum" : "") + ") {",
      ...[...frame.helpers.values()].flatMap(helper => ["  function " + helper.targetName + "() {", ...helper.lines.map(line => "  " + line), "  }"]),
      ...(timer ? ["  setTimeout(function() {", ...lines, "  }, " + literal(timer.arguments[1]) + ");"] : lines), "}"].join("\n");
    for (const name of frame.helpers.keys()) usedDefinitions.add(name);
    actions.push({
      id: (source.id || "script") + ".event." + (ordinal + 1), index: boundary.call.start,
      ...(boundary.event === "onChange" ? { sourceActionKey: inlineOnChangeSourceActionKey(sourceRef, boundary.call.start) } : {}),
      event: boundary.event, scope: boundary.event === "onChange" ? "control" : "global", controlId: boundary.controlId,
      source, sourceRefs: [sourceRef], javascript: text, function: functionText,
      translationStatus: "mapped", coverage: { status: "translated", nativeRules: [], residuals: [] },
      functionMappings: [{ source: "immutable local string arrays and source-bound zero-argument row helpers",
        target: "same typed membership, fresh helper scope and MKXFORM main-field/row operations", basis: LITERAL_ARRAY_ROW_LIFECYCLE_BASIS, reviewRequired: false }],
      semanticHints: {
        coveredCalculationRanges: ranges, ...(timer ? { sourceTimerDelay: literal(timer.arguments[1]) } : {}),
        literalArrayRowLifecycle: { arrays: frame.evidence.arrays, memberships: frame.evidence.memberships,
          fieldReads: frame.evidence.fieldReads, fieldWrites: frame.evidence.fieldWrites,
          helperRanges: ranges.slice(1), sourceDisplayGate: source.displayGate,
          ...(approvedScalarReadFieldIds.size ? { approvedScalarReadFieldIds: [...approvedScalarReadFieldIds] } : {}) }
      }
    });
  }
  if ([...definitions.keys()].some(name => !usedDefinitions.has(name))) return [];
  const complete = actions.length === callbacks.length;
  return actions.map(action => ({ ...action, semanticHints: { ...action.semanticHints,
    ...(complete ? { ownsLegacyRowEffects: true } : {}),
    sourceCallbackOffsets: callbacks.map(boundary => boundary.call.start),
    pendingSourceCallbackOffsets: callbacks.map(boundary => boundary.call.start).filter(index => !actions.some(action => action.index === index))
  } }));
}

function crossSourceBindingsStable(source, definitions, sourceScripts) {
  const dependencies = new Set([...definitions.keys(), ROW_HELPER, "GetXFormFieldById", "Com_AddEventListener",
    "AttachXFormValueChangeEventById", "setTimeout", "console", "String", "Array"]);
  for (const other of sourceScripts.sources || []) {
    if (other === source) continue;
    if (other.sourceRef && other.sourceRef === source.sourceRef) return false;
    let program;
    try { program = parse(String(other.javascript || ""), { ecmaVersion: "latest" }); } catch { return false; }
    const model = buildJavaScriptBindingModel(String(other.javascript || ""));
    if (!model.ok) return false;
    let valid = true;
    walk(program, (node, parent) => {
      if (node.type === "Identifier" && model.isUnshadowedGlobal(node.name, node.start) &&
          !(parent?.type === "MemberExpression" && parent.property === node && !parent.computed) &&
          !(parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand)) {
        if (["Object", "Reflect", "eval", "Function", "globalThis", "self", "Array"].includes(node.name)) valid = false;
        if (node.name === "window" && !(callId(parent, "Com_AddEventListener") && parent.arguments[0] === node)) valid = false;
        if (dependencies.has(node.name) && node.name !== "console" && node.name !== "String" &&
            !(parent?.type === "CallExpression" && parent.callee === node)) valid = false;
      }
      const declared = node.type === "FunctionDeclaration" ? node.id : node.type === "VariableDeclarator" ? node.id : undefined;
      if (declared?.type === "Identifier" && dependencies.has(declared.name) &&
          model.bindingAtUse(declared.name, declared.start)?.scope.kind === "program") valid = false;
      if (["AssignmentExpression", "UpdateExpression"].includes(node.type) || node.type === "UnaryExpression" && node.operator === "delete") {
        const target = node.left || node.argument;
        if (target?.type === "Identifier" && dependencies.has(target.name) && model.isUnshadowedGlobal(target.name, target.start)) valid = false;
        if (target?.type === "MemberExpression") {
          let root = target;
          while (root.type === "MemberExpression") root = root.object;
          if (root.type === "Identifier" && model.isUnshadowedGlobal(root.name, root.start) &&
              (["window", "globalThis", "self"].includes(root.name) || dependencies.has(root.name))) valid = false;
        }
      }
      if (node.type === "CallExpression" && node.callee?.type === "Identifier" &&
          ["eval", "Function"].includes(node.callee.name) && model.isUnshadowedGlobal(node.callee.name, node.start)) valid = false;
    });
    if (!valid) return false;
  }
  return true;
}

function hasUnsupportedGlobalExposure(program, bindings) {
  let invalid = false;
  const globals = new Set(["Array", "String", "Object", "Reflect", "eval", "Function", "globalThis", "self"]);
  walk(program, (node, parent) => {
    if (node.type === "MemberExpression" && ["prototype", "__proto__", "constructor"].includes(node.computed ? literal(node.property) : node.property?.name)) invalid = true;
    if (node.type !== "Identifier") return;
    if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return;
    if (!bindings.isUnshadowedGlobal(node.name, node.start)) return;
    if (globals.has(node.name)) invalid = true;
    if (node.name === "window" && !(callId(parent, "Com_AddEventListener") && parent.arguments[0] === node)) invalid = true;
  });
  return invalid;
}

function newFrame(environment, fn, eventName, inHelper) {
  return { environment, fn, eventName, inHelper, locals: new Map(), declared: new Set(fn.params.map(node => node.name)),
    helpers: new Map(), membership: 0, rowEffects: 0, branchDepth: 0, evidence: { arrays: [], memberships: [], fieldReads: [], fieldWrites: [] } };
}
function compileBlock(block, frame, indent) {
  if (block?.type !== "BlockStatement") return undefined;
  const lines = [];
  for (const statement of nonEmpty(block.body)) {
    const next = compileStatement(statement, frame, indent);
    if (!next) return undefined;
    lines.push(...next);
  }
  return lines;
}
function compileStatement(node, frame, indent) {
  const e = frame.environment;
  if (node.type === "VariableDeclaration") {
    if (frame.branchDepth || node.kind !== "var" || node.declarations.length !== 1) return undefined;
    const declaration = node.declarations[0], name = declaration.id?.name;
    if (declaration.id?.type !== "Identifier" || frame.declared.has(name)) return undefined;
    frame.declared.add(name);
    const binding = e.bindings.bindingAtUse(name, declaration.id.start);
    if (!binding || binding.ambiguous || binding.declarations.length !== 1) return undefined;
    const targetName = fresh(e, "__sourceLocal");
    if (declaration.init?.type === "ArrayExpression") {
      const values = declaration.init.elements.map(node => literal(node));
      if (declaration.init.elements.some(node => node?.type !== "Literal" || typeof node.value !== "string") ||
          !readonlyArrayUses(binding, declaration, frame)) return undefined;
      frame.locals.set(name, { kind: "array", targetName, binding });
      frame.evidence.arrays.push({ name, bindingId: binding.id, start: declaration.start, end: declaration.end, values });
      return [indent + "var " + targetName + " = " + JSON.stringify(values) + ";"];
    }
    const handleId = fieldHandle(declaration.init, frame);
    if (handleId) {
      frame.locals.set(name, { kind: "handle", fieldId: handleId, binding });
      return [];
    }
    const expression = compileExpression(declaration.init, frame);
    if (!expression || !expression.fieldId) return undefined;
    frame.locals.set(name, { kind: "scalar", targetName, fieldId: expression.fieldId, binding });
    return [indent + "var " + targetName + " = " + expression.code + ";"];
  }
  if (node.type === "IfStatement") {
    const condition = compileCondition(node.test, frame);
    if (!condition) return undefined;
    const branch = branchBody(node.consequent);
    if (!branch) return undefined;
    frame.branchDepth += 1;
    try {
      const yes = compileBlock(branch, frame, indent + "  ");
      if (!yes) return undefined;
      const lines = [indent + "if (" + condition + ") {", ...yes];
      if (node.alternate) {
        const noBody = branchBody(node.alternate), no = noBody && compileBlock(noBody, frame, indent + "  ");
        if (!no) return undefined;
        lines.push(indent + "} else {", ...no);
      }
      return [...lines, indent + "}"];
    } finally { frame.branchDepth -= 1; }
  }
  if (node.type !== "ExpressionStatement") return undefined;
  const expression = node.expression;
  if (expression?.type === "AssignmentExpression" && expression.operator === "=" && member(expression.left, "value") && !frame.inHelper) {
    const descriptor = local(expression.left.object, frame);
    const rhs = compileExpression(expression.right, frame), field = descriptor?.kind === "handle" && mainField(e.form, descriptor.fieldId);
    if (!rhs || !field || field.componentId !== "xform-hidden" || field.sourceProps?.hardHidden !== true) return undefined;
    const valueName = fresh(e, "__assignedValue");
    frame.evidence.fieldWrites.push({ fieldId: field.id, start: node.start, end: node.end, conversion: "hidden-input-dom-string" });
    const quote = String.fromCharCode(96), domString = valueName + ' === null ? "" : ' + quote + '${' + valueName + '}' + quote;
    return [indent + "var " + valueName + " = " + rhs.code + ";",
      indent + "MKXFORM.setValue(" + JSON.stringify(field.id) + ", " + domString + ");"];
  }
  if (callId(expression, ROW_HELPER)) {
    if (!e.bindings.isUnshadowedGlobal(ROW_HELPER, expression.start) || expression.arguments.length !== 4 ||
        typeof literal(expression.arguments[0]) !== "string" || expression.arguments.slice(1).some(node => typeof literal(node) !== "boolean") ||
        frame.inHelper && literal(expression.arguments[3])) return undefined;
    const lines = compileStaticRowEffect({ target: literal(expression.arguments[0]), visible: literal(expression.arguments[1]),
      required: literal(expression.arguments[2]), reset: literal(expression.arguments[3]) }, e.form, indent);
    if (!lines) return undefined;
    frame.rowEffects += 1;
    return lines;
  }
  if (expression?.type === "CallExpression" && expression.callee?.type === "MemberExpression" && !expression.callee.computed &&
      id(expression.callee.object, "console") && ["log", "debug", "info"].includes(expression.callee.property?.name) &&
      e.bindings.isUnshadowedGlobal("console", expression.callee.object.start)) {
    const args = expression.arguments.map(node => compileExpression(node, frame));
    return args.every(Boolean) ? [indent + "console." + expression.callee.property.name + "(" + args.map(arg => arg.code).join(", ") + ");"] : undefined;
  }
  if (!callId(expression) || expression.arguments.length || frame.inHelper) return undefined;
  const definition = e.definitions.get(expression.callee.name), binding = e.bindings.bindingAtUse(expression.callee.name, expression.callee.start);
  if (!definition || !binding || binding.scope.kind !== "program" || binding.ambiguous ||
      [...binding.kinds].some(kind => kind !== "function") || binding.aliases.size || !readonlyHelperUses(definition, binding, e)) return undefined;
  let helper = frame.helpers.get(definition.id.name);
  if (!helper) {
    const nested = newFrame(e, definition, undefined, true), lines = compileBlock(definition.body, nested, "  ");
    if (!lines || !nested.rowEffects) return undefined;
    helper = { node: definition, targetName: fresh(e, "__rowEffectHelper"), lines };
    frame.helpers.set(definition.id.name, helper);
    frame.rowEffects += nested.rowEffects;
    frame.membership += nested.membership;
    for (const key of Object.keys(frame.evidence)) frame.evidence[key].push(...nested.evidence[key]);
  }
  return [indent + helper.targetName + "();"];
}

function compileCondition(node, frame) {
  if (node?.type === "LogicalExpression" && ["&&", "||"].includes(node.operator)) {
    const left = compileCondition(node.left, frame), right = compileCondition(node.right, frame);
    return left && right ? "(" + left + ") " + node.operator + " (" + right + ")" : undefined;
  }
  if (node?.type !== "BinaryExpression") return undefined;
  const call = node.left;
  if (node.operator === ">=" && literal(node.right) === 0 && call?.type === "CallExpression" && !call.optional &&
      member(call.callee, "indexOf") && call.arguments.length === 1) {
    const array = local(call.callee.object, frame), argument = compileExpression(call.arguments[0], frame);
    if (array?.kind === "array" && argument) {
      frame.membership += 1;
      frame.evidence.memberships.push({ bindingId: array.binding.id, start: node.start, end: node.end,
        operand: argument.fieldId ? { kind: "field", fieldId: argument.fieldId } : { kind: argument.event ? "event" : "literal" } });
      return array.targetName + ".indexOf(" + argument.code + ") >= 0";
    }
    const receiver = compileExpression(call.callee.object, frame);
    if (receiver && typeof literal(call.arguments[0]) === "string") return receiver.code + ".indexOf(" + JSON.stringify(literal(call.arguments[0])) + ") >= 0";
    return undefined;
  }
  if (!["==", "===", "!=", "!=="].includes(node.operator)) return undefined;
  const left = compileExpression(node.left, frame), right = compileExpression(node.right, frame);
  return left && right ? left.code + " " + node.operator + " " + right.code : undefined;
}
function compileExpression(node, frame) {
  const e = frame.environment;
  if (node?.type === "Literal" && (node.value === null || ["string", "boolean"].includes(typeof node.value) ||
      typeof node.value === "number" && Number.isFinite(node.value))) return { code: JSON.stringify(node.value) };
  if (node?.type === "Identifier" && node.name === frame.eventName && e.bindings.bindingAtUse(node.name, node.start)?.kinds.has("parameter")) return { code: "value", event: true };
  const descriptor = local(node, frame);
  if (descriptor?.kind === "scalar") return { code: descriptor.targetName, fieldId: descriptor.fieldId };
  const fieldId = member(node, "value") ? fieldHandle(node.object, frame) || (local(node.object, frame)?.kind === "handle" ? local(node.object, frame).fieldId : undefined) : undefined;
  if (!fieldId) return undefined;
  const approvedRead = approvedScalarStringReadExpression(fieldId, e.form, e.approvedScalarReadFieldIds);
  frame.evidence.fieldReads.push({ fieldId, start: node.start, end: node.end,
    ...(approvedRead ? { conversion: "approved-current-selected-string" } : {}) });
  if (approvedRead) return { code: approvedRead, fieldId };
  return { code: 'String(MKXFORM.getValue(' + JSON.stringify(fieldId) + ') ?? "")', fieldId };
}
function fieldHandle(node, frame) {
  const call = node?.object;
  if (node?.type !== "MemberExpression" || !node.computed || literal(node.property) !== 0 || !callId(call, "GetXFormFieldById") ||
      call.arguments.length !== 1 || typeof literal(call.arguments[0]) !== "string" ||
      !frame.environment.bindings.isUnshadowedGlobal("GetXFormFieldById", call.start)) return undefined;
  const field = mainField(frame.environment.form, literal(call.arguments[0]));
  if (field && approvedScalarStringReadExpression(field.id, frame.environment.form, frame.environment.approvedScalarReadFieldIds)) return field.id;
  return field && ["text", "longText"].includes(field.type) && ["xform-input", "xform-hidden", "xform-textarea"].includes(field.componentId) &&
    field.sourceProps?.metadataAttributes?.type === "String" && [undefined, "", "String"].includes(field.sourceProps?.designerValues?.dataType) &&
    field.dataOnly !== true ? field.id : undefined;
}
function local(node, frame) {
  if (node?.type !== "Identifier") return undefined;
  const descriptor = frame.locals.get(node.name);
  return descriptor && frame.environment.bindings.bindingAtUse(node.name, node.start) === descriptor.binding ? descriptor : undefined;
}
function readonlyHelperUses(definition, binding, environment) {
  let valid = true;
  walk(environment.program, (node, parent) => {
    if (!valid || node.type !== "Identifier" || node.name !== definition.id.name || node === definition.id ||
        parent?.type === "MemberExpression" && parent.property === node && !parent.computed ||
        environment.bindings.bindingAtUse(node.name, node.start) !== binding) return;
    const statement = environment.parents.get(parent);
    if (parent?.type !== "CallExpression" || parent.callee !== node || parent.optional || parent.arguments.length ||
        statement?.type !== "ExpressionStatement" || statement.expression !== parent) valid = false;
  });
  return valid;
}

function readonlyArrayUses(binding, declaration, frame) {
  let valid = true;
  const e = frame.environment;
  walk(frame.fn.body, (node, parent) => {
    if (!valid || node.type !== "Identifier" || node.name !== declaration.id.name || node === declaration.id ||
        parent?.type === "MemberExpression" && parent.property === node && !parent.computed ||
        e.bindings.bindingAtUse(node.name, node.start) !== binding) return;
    const memberNode = parent, call = e.parents.get(memberNode), predicate = e.parents.get(call);
    if (memberNode?.type !== "MemberExpression" || memberNode.object !== node || memberNode.computed || memberNode.property?.name !== "indexOf" ||
        call?.type !== "CallExpression" || call.callee !== memberNode || call.optional || call.arguments.length !== 1 ||
        predicate?.type !== "BinaryExpression" || predicate.left !== call || predicate.operator !== ">=" || literal(predicate.right) !== 0) valid = false;
  });
  return valid;
}
function callbackBoundary(statement, bindings) {
  const call = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  if (callId(call, "Com_AddEventListener") && call.arguments.length === 3 && id(call.arguments[0], "window") && literal(call.arguments[1]) === "load" &&
      bindings.isUnshadowedGlobal("Com_AddEventListener", call.start) && bindings.isUnshadowedGlobal("window", call.start)) return { call, callback: call.arguments[2], event: "onLoad" };
  if (callId(call, "AttachXFormValueChangeEventById") && call.arguments.length === 2 && typeof literal(call.arguments[0]) === "string" &&
      bindings.isUnshadowedGlobal("AttachXFormValueChangeEventById", call.start)) return { call, callback: call.arguments[1], event: "onChange", controlId: literal(call.arguments[0]) };
  return undefined;
}
function mainField(form, fieldId) {
  const matches = (form.fields || []).filter(field => field.type !== "detailTable" && field.id === fieldId);
  if (matches.length !== 1) return undefined;
  const field = matches[0];
  return [field.sourceProps?.designerId, field.sourceProps?.metadataId].some(id => id && id !== field.id) ? undefined : field;
}
function fresh(environment, stem) { let name; do { name = stem + environment.serial++; } while (environment.usedNames.has(name)); environment.usedNames.add(name); return name; }
function branchBody(node) { return node?.type === "BlockStatement" ? node : node?.type === "IfStatement" || node?.type === "ExpressionStatement" || node?.type === "EmptyStatement" ? { type: "BlockStatement", body: [node] } : undefined; }
function plainFunction(node) { return node?.type === "FunctionExpression" && !node.async && !node.generator && !node.id && node.params.every(node => node.type === "Identifier") && new Set(node.params.map(node => node.name)).size === node.params.length && node.body?.type === "BlockStatement"; }
function member(node, property) { return node?.type === "MemberExpression" && !node.optional && !node.computed && id(node.property, property); }
function callId(node, name) { return node?.type === "CallExpression" && !node.optional && node.callee?.type === "Identifier" && (!name || node.callee.name === name); }
function id(node, name) { return node?.type === "Identifier" && node.name === name; }
function literal(node) { return node?.type === "Literal" ? node.value : undefined; }
function nonEmpty(nodes) { return (nodes || []).filter(node => node.type !== "EmptyStatement"); }
function walk(node, visit, parent) { if (!node || typeof node !== "object") return; visit(node, parent); for (const child of Object.values(node)) { if (Array.isArray(child)) child.forEach(item => walk(item, visit, node)); else if (child && typeof child === "object") walk(child, visit, node); } }
