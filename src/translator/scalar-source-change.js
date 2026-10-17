import { parse } from "acorn";
import { createHash } from "node:crypto";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";
import { inlineOnChangeSourceActionKey } from "./source-action-key.js";
import { dateOnlyInputContract, nativeDateOnlyValueExpression, NATIVE_DATE_ONLY_TEXT_CONTRACT } from "./native-date-only-value.js";

export const SCALAR_SOURCE_CHANGE_BASIS = "deterministic-scalar-source-change";
const protectedNames = new Set(["AttachXFormValueChangeEventById", "GetXFormFieldById", "$", "alert", "console", "Date", "Number", "parseFloat"]);
const reservedNames = new Set([...protectedNames, "MKXFORM", "value", "rowNum", "parentRowNum", "window", "document", "globalThis", "self", "Function", "eval", "undefined", "NaN", "Infinity", "arguments", "__sourceDateEvent"]);
const hash = text => createHash("sha256").update(String(text)).digest("hex");
const literal = node => node?.type === "Literal" ? node.value : undefined;
const member = (node, name) => node?.type === "MemberExpression" && !node.computed && !node.optional && node.property?.name === name;
const call = (node, name) => node?.type === "CallExpression" && !node.optional && node.callee?.type === "Identifier" && node.callee.name === name;
function program(text) { try { return parse(text, { ecmaVersion: "latest" }); } catch { return undefined; } }
function walk(node, visit, parent) { if (!node || typeof node !== "object") return; visit(node, parent); for (const [key, child] of Object.entries(node)) if (!["start", "end", "raw"].includes(key)) { if (Array.isArray(child)) child.forEach(value => walk(value, visit, node)); else if (child && typeof child === "object") walk(child, visit, node); } }

// Complete synchronous callbacks only. No source ID, field name or alert text is
// a dispatch key; the source AST and unique scalar input contracts are the proof.
export function scalarSourceChangeCandidates(source = {}, form = {}, sourceScripts = {}) {
  const text = String(source.javascript || ""), ast = program(text), bindings = buildJavaScriptBindingModel(text);
  if (!ast || !bindings.ok || !stableSourceGlobals(sourceScripts.sources || [source])) return [];
  let cacheCollision = false;
  walk(ast, node => { if (node.type === "Identifier" && node.name === "__sourceDateEvent") cacheCollision = true; });
  if (cacheCollision) return [];
  const statements = ast.body.filter(node => node.type !== "EmptyStatement");
  const registration = statements.length === 1 && statements[0].expression;
  if (!call(registration, "AttachXFormValueChangeEventById") || registration.arguments.length !== 2 || typeof literal(registration.arguments[0]) !== "string" || !bindings.isUnshadowedGlobal("AttachXFormValueChangeEventById", registration.callee.start)) return [];
  const fn = registration.arguments[1];
  if (fn?.type !== "FunctionExpression" || fn.async || fn.generator || fn.id || fn.body?.type !== "BlockStatement" || ![1, 2].includes(fn.params.length) || fn.params.some(p => p.type !== "Identifier" || protectedNames.has(p.name)) || new Set(fn.params.map(p => p.name)).size !== fn.params.length) return [];
  const fields = new Map();
  for (const field of form.fields || []) {
    if (field.type === "detailTable" || field.dataOnly === true || !scalarInputContract(field)) continue;
    if (fields.has(field.id)) return [];
    fields.set(field.id, field);
  }
  const triggerId = literal(registration.arguments[0]);
  if (!fields.has(triggerId)) return [];
  const dateEvent = fields.get(triggerId).type === "dateTime";
  const state = { fields, triggerId, bindings, parameter: fn.params[0].name, parameterBinding: bindings.bindingAtUse(fn.params[0].name, fn.params[0].start),
    locals: new Map(), handles: new Map(), declared: new Set(fn.params.map(p => p.name)), reads: new Set(), dateReads: new Set(), dateEvent, writes: new Set(), alerts: [], diagnostics: [], conditions: [], stats: { dates: 0, numbers: 0 } };
  const lines = compileStatements(fn.body.body, state, "  ");
  if (!lines || !state.conditions.length || !state.alerts.length || !state.reads.size || !(state.stats.dates || state.stats.numbers || state.writes.size)) return [];
  const sourceRef = source.sourceRef || source.id;
  return [{ source, sourceRefs: [sourceRef], index: registration.start,
    sourceActionKey: inlineOnChangeSourceActionKey(sourceRef, registration.start),
    event: "onChange", scope: "control", controlId: triggerId,
    javascript: text, function: ["function onChange(value, rowNum, parentRowNum) {", ...(dateEvent ? [`  var __sourceDateEvent = ${nativeDateOnlyValueExpression(triggerId, "value")};`] : []), ...lines, "}"].join("\n"),
    translationStatus: "mapped", coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{ source: "complete synchronous scalar/date alert, diagnostic and input-clear callback", target: "same Date/Number predicates and console order, MKXFORM.toast and literal input clear", basis: SCALAR_SOURCE_CHANGE_BASIS, reviewRequired: false }],
    semanticHints: { coveredLegacyFunctions: (source.functionAudit?.violations || []).map(v => v.name).filter(Boolean), coveredCalculationRanges: [{ sourceRef, name: "scalarSourceChangeCallback", start: registration.start, end: registration.end }],
      scalarSourceChange: { version: 1, sourceJavascriptSha256: hash(text), eventValue: dateEvent ? "native-date-display-text" : "unchanged", inputEmptyProjection: dateEvent || state.dateReads.size ? "native-date-display-text-nullish-only" : "nullish-only-to-empty-string", readFieldIds: [...state.reads], writeFieldIds: [...state.writes],
        ...(dateEvent || state.dateReads.size ? { nativeDateOnlyTextContract: NATIVE_DATE_ONLY_TEXT_CONTRACT, dateReadFieldIds: [...state.dateReads], ...(dateEvent ? { dateEventFieldId: triggerId } : {}) } : {}),
        inputContracts: [...state.reads].map(id => ({ fieldId: id, sourceHashes: fields.get(id).sourceProps.mainStringValueBindingFact.sourceHashes, metadataType: fields.get(id).sourceProps.metadataAttributes.type, designerBindings: 1, runtimeBindings: 1 })),
        alertRanges: state.alerts, consoleRanges: state.diagnostics, conditionRanges: state.conditions.sort((a, b) => a.start - b.start), dateConstructors: state.stats.dates, numericConversions: state.stats.numbers } }
  }];
}

function scalarInputContract(field) {
  const props = field.sourceProps || {}, fact = props.mainStringValueBindingFact;
  const combinations = { text: ["String", "xform-input"], longText: ["String", "xform-textarea"], number: ["Double", "xform-number", "xform-calculate"], dateTime: ["Date", "xform-datetime"] };
  const expected = combinations[field.type];
  return expected && expected[0] === props.metadataAttributes?.type && expected.slice(1).includes(field.componentId) &&
    (field.type !== "dateTime" || dateOnlyInputContract(field)) &&
    props.designerId === field.id && props.metadataId === field.id && props.metadataKind === "simple" &&
    props.metadataAttributes.name === field.id && props.originalId === undefined &&
    fact?.version === 1 && fact.fieldId === field.id && fact.metadata?.count === 1 && fact.metadata.type === expected[0] &&
    fact.surfaces?.designer?.logicalBindingCount === 1 && fact.surfaces?.display?.logicalBindingCount === 1 &&
    ["fdDesignerHtml", "fdDisplayJsp", "fdMetadataXml"].every(key => /^[a-f0-9]{64}$/.test(fact.sourceHashes?.[key] || ""));
}
function compileStatements(statements, state, indent) {
  const lines = [];
  for (const statement of statements) {
    if (statement.type === "EmptyStatement") continue;
    if (statement.type === "VariableDeclaration") {
      if (statement.declarations.length !== 1 || !["var", "let", "const"].includes(statement.kind)) return undefined;
      const declaration = statement.declarations[0], name = declaration.id?.name;
      if (declaration.id?.type !== "Identifier" || state.declared.has(name) || reservedNames.has(name) || name === state.parameter) return undefined;
      const selected = selectorField(declaration.init, state);
      if (selected) { state.declared.add(name); state.handles.set(name, selected); continue; }
      const expression = compileExpression(declaration.init, state);
      if (!expression) return undefined;
      state.declared.add(name); state.locals.set(name, expression.kind);
      lines.push(`${indent}${statement.kind} ${name} = ${expression.text};`); continue;
    }
    if (statement.type === "IfStatement") {
      const condition = compileExpression(statement.test, state);
      if (!condition || condition.kind !== "boolean") return undefined;
      const yes = compileStatements(asBlock(statement.consequent), cloneBranch(state), indent + "  ");
      if (!yes) return undefined;
      state.conditions.push({ start: statement.test.start, end: statement.test.end });
      lines.push(`${indent}if (${condition.text}) {`, ...yes);
      if (statement.alternate) {
        const no = compileStatements(asBlock(statement.alternate), cloneBranch(state), indent + "  ");
        if (!no) return undefined;
        lines.push(indent + "} else {", ...no);
      }
      lines.push(indent + "}"); continue;
    }
    const expression = statement.type === "ExpressionStatement" && statement.expression;
    if (call(expression, "alert") && expression.arguments.length === 1 && typeof literal(expression.arguments[0]) === "string" && state.bindings.isUnshadowedGlobal("alert", expression.callee.start)) {
      state.alerts.push({ start: expression.start, end: expression.end, message: literal(expression.arguments[0]) });
      lines.push(indent + `MKXFORM.toast(${JSON.stringify(literal(expression.arguments[0]))});`); continue;
    }
    if (expression?.type === "CallExpression" && member(expression.callee, "log") && expression.callee.object?.type === "Identifier" && expression.callee.object.name === "console" && state.bindings.isUnshadowedGlobal("console", expression.callee.object.start)) {
      const args = expression.arguments.map(node => compileExpression(node, state));
      if (args.some(arg => !arg || arg.kind === "handle")) return undefined;
      state.diagnostics.push({ start: expression.start, end: expression.end, method: "log" });
      lines.push(indent + `console.log(${args.map(arg => arg.text).join(", ")});`); continue;
    }
    if (expression?.type === "CallExpression" && member(expression.callee, "val") && expression.callee.object?.type === "Identifier" && state.handles.has(expression.callee.object.name) && expression.arguments.length === 1 && literal(expression.arguments[0]) === "") {
      const id = state.handles.get(expression.callee.object.name);
      if (id !== state.triggerId) return undefined;
      state.writes.add(id); lines.push(indent + `MKXFORM.setValue(${JSON.stringify(id)}, "");`); continue;
    }
    return undefined;
  }
  return lines;
}
function asBlock(node) { return node?.type === "BlockStatement" ? node.body : [node]; }
function cloneBranch(state) { return { ...state, declared: new Set(state.declared), locals: new Map(state.locals), handles: new Map(state.handles) }; }
function compileExpression(node, state) {
  if (node?.type === "Literal" && !node.regex && (node.value === null || ["number", "string", "boolean"].includes(typeof node.value))) return { text: JSON.stringify(node.value), kind: typeof node.value === "boolean" ? "boolean" : "scalar" };
  if (node?.type === "Identifier") {
    if (node.name === state.parameter && state.bindings.bindingAtUse(node.name, node.start) === state.parameterBinding) return { text: state.dateEvent ? "__sourceDateEvent" : "value", kind: "scalar" };
    return state.locals.has(node.name) ? { text: node.name, kind: state.locals.get(node.name) } : undefined;
  }
  if (member(node, "value") && node.object?.type === "MemberExpression" && node.object.computed && literal(node.object.property) === 0 && call(node.object.object, "GetXFormFieldById") && node.object.object.arguments.length === 1 && state.bindings.isUnshadowedGlobal("GetXFormFieldById", node.object.object.callee.start)) {
    const id = literal(node.object.object.arguments[0]);
    if (typeof id !== "string" || !state.fields.has(id)) return undefined;
    state.reads.add(id);
    if (state.fields.get(id).type === "dateTime") { state.dateReads.add(id); return { text: nativeDateOnlyValueExpression(id), kind: "scalar" }; }
    return { text: `(MKXFORM.getValue(${JSON.stringify(id)}) ?? "")`, kind: "scalar" };
  }
  if (node?.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "Date" && node.arguments.length === 1 && state.bindings.isUnshadowedGlobal("Date", node.callee.start)) {
    const argument = compileExpression(node.arguments[0], state); if (!argument || argument.kind !== "scalar") return undefined;
    state.stats.dates++; return { text: `new Date(${argument.text})`, kind: "date" };
  }
  if (node?.type === "CallExpression" && node.callee?.type === "Identifier" && ["Number", "parseFloat"].includes(node.callee.name) && node.arguments.length === 1 && state.bindings.isUnshadowedGlobal(node.callee.name, node.callee.start)) {
    const argument = compileExpression(node.arguments[0], state); if (!argument || argument.kind !== "scalar") return undefined;
    state.stats.numbers++; return { text: `${node.callee.name}(${argument.text})`, kind: "scalar" };
  }
  if (member(node, "length") && node.object?.type === "Identifier" && state.locals.get(node.object.name) === "scalar") return { text: node.object.name + ".length", kind: "scalar" };
  if (node?.type === "UnaryExpression" && ["+", "-"].includes(node.operator) && typeof literal(node.argument) === "number") return { text: node.operator + JSON.stringify(literal(node.argument)), kind: "scalar" };
  if (node?.type === "BinaryExpression" && ["<", "<=", ">", ">=", "==", "!=", "===", "!=="].includes(node.operator)) {
    const left = compileExpression(node.left, state), right = compileExpression(node.right, state);
    if (!left || !right || left.kind === "boolean" || right.kind === "boolean" || (left.kind === "date") !== (right.kind === "date")) return undefined;
    return { text: `(${left.text} ${node.operator} ${right.text})`, kind: "boolean" };
  }
  return undefined;
}
function selectorField(node, state) {
  if (!call(node, "$") || node.arguments.length !== 1 || typeof literal(node.arguments[0]) !== "string" || !state.bindings.isUnshadowedGlobal("$", node.callee.start)) return undefined;
  const id = /^\[name=(["'])extendDataFormInfo\.value\(([A-Za-z_][\w]*)\)\1\]$/.exec(literal(node.arguments[0]))?.[2];
  return id && state.fields.has(id) ? id : undefined;
}
function stableSourceGlobals(sources) {
  for (const source of sources) {
    const ast = program(source.javascript); if (!ast) return false;
    let stable = true;
    walk(ast, node => {
      const target = node.type === "FunctionDeclaration" ? node.id : node.type === "VariableDeclarator" ? node.id : ["AssignmentExpression", "UpdateExpression"].includes(node.type) ? node.left || node.argument : undefined;
      if (target?.type === "Identifier" && protectedNames.has(target.name)) stable = false;
      if (target?.type === "MemberExpression") { let root = target; while (root.type === "MemberExpression") root = root.object; if (protectedNames.has(root.name) || ["window", "globalThis", "self"].includes(root.name)) stable = false; }
      if (node.type === "WithStatement" || call(node, "eval") || call(node, "Function")) stable = false;
    });
    if (!stable) return false;
  }
  return true;
}
