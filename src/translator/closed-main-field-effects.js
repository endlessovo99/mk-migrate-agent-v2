import { parse } from "acorn";
import { createHash } from "node:crypto";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";
import { componentSupportsProp } from "../dsl/catalogs.js";
import { scanHtmlTags } from "./designer-html-tokenizer.js";
import { attrValue, parseFdValues } from "./xml-utils.js";
import { compileStaticRowEffect } from "./inline-radio-row-effects.js";
import { inlineOnChangeSourceActionKey } from "./source-action-key.js";
import { isPureLocalCurrencyHelperDeclaration } from "./local-currency-helper.js";

const BASIS = "deterministic-closed-main-field-effects";
const hash = text => createHash("sha256").update(String(text)).digest("hex");
const apis = new Set(["GetXFormFieldById", "AttachXFormValueChangeEventById", "Com_AddEventListener", "common_dom_row_set_show_required_reset"]);
const protectedSourceNames = new Set([...apis, "Number", "parseFloat", "parseInt", "Array", "String"]);
const literal = node => node?.type === "Literal" ? node.value : undefined;
const member = (node, name) => node?.type === "MemberExpression" && !node.computed && !node.optional && node.property?.name === name;
const call = (node, name) => node?.type === "CallExpression" && !node.optional && node.callee?.type === "Identifier" && node.callee.name === name;
const nodes = body => body?.type === "BlockStatement" ? body.body.filter(n => n.type !== "EmptyStatement") : [body];
function ast(text) { try { return parse(text, { ecmaVersion: "latest" }); } catch { return undefined; } }
function walk(node, visit, parent) { if (!node || typeof node !== "object") return; visit(node, parent); for (const [key, child] of Object.entries(node)) if (!["start", "end", "raw"].includes(key)) { if (Array.isArray(child)) child.forEach(n => walk(n, visit, node)); else if (child && typeof child === "object") walk(child, visit, node); } }

// Negative control evidence is established from the complete current source,
// never from a missing target field alone. Unknown executable domains fail closed.
export function attachClosedMainFieldFacts(template, scripts, form) {
  if (!scripts?.sources?.length) return;
  const runtime = String(template.fdDisplayJsp || "");
  const markup = runtime.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  if (!runtime || /\b(?:eval|document\.write)\s*\(|\.(?:innerHTML|outerHTML)\s*=/i.test(scripts.sources.map(s => s.javascript).join("\n"))) return;
  const fields = [...(form.fields || []), ...(form.dataFields || [])].flatMap(f => [f, ...(f.columns || [])]);
  const declared = new Set(fields.flatMap(f => [f.id, f.source?.metadataId, f.source?.designerId]).filter(Boolean));
  for (const token of scanHtmlTags(template.fdDesignerHtml || "")) {
    for (const key of ["id", "name", "property"]) { const value = attrValue(token.attrs, key); if (value) declared.add(value); }
    const value = attrValue(token.attrs, "fd_values");
    if (value) { const id = parseFdValues(value)?.id; if (id) declared.add(id); }
  }
  const referenced = new Set();
  for (const source of scripts.sources) {
    const program = ast(source.javascript), bindings = buildJavaScriptBindingModel(source.javascript);
    if (!program || !bindings.ok) return;
    const pureDeclarations = program.body.filter(n => n.type === "FunctionDeclaration" && isPureLocalCurrencyHelperDeclaration(source.javascript.slice(n.start, n.end)));
    const pureHelpers = new Set(pureDeclarations.map(n => n.id.name));
    let closed = true;
    walk(program, (node, parent) => {
      if (["WithStatement", "ImportExpression"].includes(node.type) || node.type === "NewExpression" && !pureDeclarations.some(h => h.start <= node.start && h.end >= node.end)) closed = false;
      if (node.type === "NewExpression" && (node.callee?.name !== "Array" || !bindings.isUnshadowedGlobal("Array", node.callee.start))) closed = false;
      if (node.type === "FunctionDeclaration" && !pureHelpers.has(node.id?.name)) closed = false;
      if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
        const name = node.callee.name;
        if (pureHelpers.has(name)) return;
        if (name === "Com_IncludeFile" && /^\s*Com_IncludeFile\(\s*(['"])chinaValue_script\.js\1\s*,\s*(['"])\.\.\/sys\/xform\/designer\/chinaValue\/\2\s*\)\s*;?\s*$/.test(source.javascript)) return;
        if (!apis.has(name) && !["Number", "parseFloat", "parseInt", "Array"].includes(name) || !bindings.isUnshadowedGlobal(name, node.callee.start)) closed = false;
        if (name === "GetXFormFieldById" && node.arguments.length === 1 && typeof literal(node.arguments[0]) === "string") referenced.add(literal(node.arguments[0]));
      }
      if (node.type === "CallExpression" && node.callee?.type === "MemberExpression" && !["indexOf", "split", "substr", "toString", "push", "join", "getAttribute", "getElementsByTagName", "setAttribute"].includes(node.callee.property?.name)) closed = false;
      if (node.type === "CallExpression" && member(node.callee, "setAttribute") && (node.arguments.length !== 2 || literal(node.arguments[0]) !== "placeholder" || typeof literal(node.arguments[1]) !== "string")) closed = false;
      const target = ["AssignmentExpression", "UpdateExpression"].includes(node.type) ? node.left || node.argument : undefined;
      if (target?.type === "Identifier" && protectedSourceNames.has(target.name) || target?.type === "MemberExpression" && ["innerHTML", "outerHTML", "prototype", "__proto__"].includes(target.computed ? literal(target.property) : target.property?.name)) closed = false;
      if (target?.type === "MemberExpression") { let root = target; while (root.type === "MemberExpression") root = root.object; if (["window", "document", "globalThis", "self"].includes(root.name)) closed = false; }
      if (node.type === "VariableDeclarator" && protectedSourceNames.has(node.id?.name) || node.type === "FunctionDeclaration" && protectedSourceNames.has(node.id?.name)) closed = false;
    });
    if (!closed) return;
  }
  const absent = [...referenced].filter(id => !declared.has(id) && !String(template.fdMetadataXml || "").includes(id) && !markup.includes(id));
  const domain = { version: 1, sourceHashes: Object.fromEntries(["fdDesignerHtml", "fdDisplayJsp", "fdMetadataXml"].map(k => [k, hash(template[k] || "")])),
    scriptHashes: scripts.sources.map(s => ({ sourceRef: s.sourceRef, sha256: hash(s.javascript) })), absentFieldIds: absent.sort() };
  for (const source of scripts.sources) source.semanticFacts = { ...source.semanticFacts, closedMainFieldDomain: domain };
}

export function annotateChinaValueReadOnly(form, template) {
  const tokens = [...scanHtmlTags(template.fdDisplayJsp || "")].filter(t => !t.closing && t.name === "xform:xtext");
  for (const field of form.fields || []) {
    if (String(field.source?.designerType || "").toLowerCase() !== "chinavalue") continue;
    const related = field.source.designerValues?.relatedid;
    if (!related || field.source.metadataAttributes?.relatedid !== related) continue;
    const matches = tokens.filter(t => attrValue(t.attrs, "property") === `extendDataFormInfo.value(${field.id})`);
    if (matches.length !== 1 || attrValue(matches[0].attrs, "showStatus") !== "readOnly" || !/\bchinavalue\s*=\s*(['"])true\1/i.test(attrValue(matches[0].attrs, "htmlElementProperties"))) continue;
    field.source.runtimeTextReadOnly = { readOnly: true, source: "fdDisplayJsp", evidence: [{ property: `extendDataFormInfo.value(${field.id})`, offset: matches[0].start, htmlElementProperties: attrValue(matches[0].attrs, "htmlElementProperties") }] };
  }
}

// Each candidate owns exactly one original callback. Unsupported siblings stay
// with the normal translator and cannot disappear through partial recognition.
export function closedMainFieldEffectCandidates(source = {}, form = {}, sourceScripts = {}) {
  const text = String(source.javascript || ""), program = ast(text), bindings = buildJavaScriptBindingModel(text);
  if (!program || !bindings.ok || !crossSourceApisStable(sourceScripts)) return [];
  const fields = new Map((form.fields || []).filter(f => f.type !== "detailTable" && !f.dataOnly).map(f => [f.id, f]));
  const domain = source.semanticFacts?.closedMainFieldDomain;
  const stableDomain = domain?.version === 1 && Array.isArray(domain.scriptHashes) && domain.scriptHashes.length === (sourceScripts.sources || []).length &&
    (sourceScripts.sources || []).every(s => domain.scriptHashes.filter(h => h.sourceRef === s.sourceRef && h.sha256 === hash(s.javascript)).length === 1);
  const absent = new Set(stableDomain ? domain.absentFieldIds : []);
  const helpers = new Map(program.body.filter(n => n.type === "FunctionDeclaration" && isPureLocalCurrencyHelperDeclaration(text.slice(n.start, n.end))).map(n => [n.id.name, n]));
  const results = [];
  let ordinal = 0;
  for (const statement of program.body) {
    const binding = statement.type === "ExpressionStatement" && statement.expression;
    const change = call(binding, "AttachXFormValueChangeEventById") && binding.arguments.length === 2;
    const load = call(binding, "Com_AddEventListener") && binding.arguments.length === 3 && binding.arguments[0]?.name === "window" && literal(binding.arguments[1]) === "load";
    if (!change && !load || !bindings.isUnshadowedGlobal(binding.callee.name, binding.callee.start)) continue;
    ordinal++;
    const fn = binding.arguments[change ? 1 : 2], id = change ? literal(binding.arguments[0]) : undefined;
    if (fn?.type !== "FunctionExpression" || fn.async || fn.generator || fn.id || fn.body?.type !== "BlockStatement" || (change ? !fields.has(id) || ![1, 2].includes(fn.params.length) || fn.params.some(p => p.type !== "Identifier") || new Set(fn.params.map(p => p.name)).size !== fn.params.length : fn.params.length)) continue;
    let stableCalls = true;
    walk(fn, node => { if (node.type === "CallExpression" && node.callee?.type === "Identifier" && apis.has(node.callee.name) && !bindings.isUnshadowedGlobal(node.callee.name, node.callee.start)) stableCalls = false; });
    if (!stableCalls) continue;
    const state = { fields, form, aliases: new Map(), placeholder: new Map(), absent, helpers, text, bindings, callback: fn, source, sourceScripts, nativeCurrencySupported: (sourceScripts.sources || []).some(s => /^\s*Com_IncludeFile\(\s*(['"])chinaValue_script\.js\1\s*,\s*(['"])\.\.\/sys\/xform\/designer\/chinaValue\/\2\s*\)\s*;?\s*$/.test(s.javascript)), eventName: change ? fn.params[0].name : undefined, effects: 0, fieldWrites: 0, closures: [], usedHelpers: [] };
    let lines = checkboxJoin(fn, id, state);
    if (!lines) lines = pureAbsentCurrency(fn, id, state);
    // Native select events have a separate source empty-value/branch contract.
    // This recipe only extends main radio/checkbox effects; it must not compete
    // with the established select proof or its reviewer rejection boundary.
    if (!lines && (!change || ["xform-radio", "xform-checkbox"].includes(fields.get(id)?.componentId))) lines = compileBlock(fn.body, state, "  ");
    if (!lines || !state.effects) continue;
    // Native-only row callbacks already have exact condition/effect ownership.
    // Do not replace their omission with a second script implementation.
    if (!state.fieldWrites && !state.closures.length && !state.placeholder.size) continue;
    // Preserve the established review boundary for the existing single static
    // placeholder recipe; this compiler adds compound, ordered closures.
    if (!change && bodyIsSinglePlaceholder(fn, state)) continue;
    const sourceRef = source.sourceRef || source.id, event = change ? "onChange" : "onLoad";
    results.push({ id: `${source.id}.event.${ordinal}`, source, sourceRefs: [sourceRef], index: binding.start, ...(change ? { sourceActionKey: inlineOnChangeSourceActionKey(sourceRef, binding.start) } : {}), event, scope: change ? "control" : "global", controlId: id,
      javascript: text.slice(binding.start, binding.end), function: [`function ${event}(${change ? "value, rowNum, parentRowNum" : ""}) {`, ...lines, "}"].join("\n"),
      translationStatus: "mapped", coverage: { status: "translated", nativeRules: [], residuals: [], ...(state.placeholder.size ? { staticProps: [...state.placeholder].map(([fieldId, value]) => ({ fieldId, prop: "placeholder", value })) } : {}) },
      functionMappings: [{ source: "complete source-bound main-field literal effects and closed auxiliary targets", target: "ordered MKXFORM value and row operations; audited absent auxiliary effects", basis: BASIS, reviewRequired: false }],
      semanticHints: { closedMainFieldEffects: { closures: state.closures }, coveredCalculationRanges: [{ sourceRef, name: "closedMainFieldCallback", start: binding.start, end: binding.end }, ...state.usedHelpers.map(h => ({ sourceRef, name: h.id.name, start: h.start, end: h.end }))] } });
  }
  return results;
}

function bodyIsSinglePlaceholder(fn, state) {
  return nodes(fn.body).length === 2 && state.placeholder.size === 1 && state.closures.length === 0;
}

function crossSourceApisStable(scripts) {
  for (const source of scripts.sources || []) {
    const p = ast(source.javascript); if (!p) return false;
    let okay = true;
    walk(p, node => {
      const target = node.type === "VariableDeclarator" ? node.id : node.type === "FunctionDeclaration" ? node.id : ["AssignmentExpression", "UpdateExpression"].includes(node.type) ? node.left || node.argument : undefined;
      if (target?.type === "Identifier" && protectedSourceNames.has(target.name) || target?.type === "MemberExpression" && apis.has(target.computed ? literal(target.property) : target.property?.name)) okay = false;
      if (target?.type === "MemberExpression") { let root = target; while (root.type === "MemberExpression") root = root.object; if (protectedSourceNames.has(root.name) || ["window", "document", "globalThis", "self"].includes(root.name)) okay = false; }
      if (call(node, "eval") || call(node, "Function") || node.type === "WithStatement") okay = false;
    });
    if (!okay) return false;
  }
  return true;
}
function fieldElement(node) {
  return node?.type === "MemberExpression" && node.computed && literal(node.property) === 0 && call(node.object, "GetXFormFieldById") && node.object.arguments.length === 1 && typeof literal(node.object.arguments[0]) === "string" ? literal(node.object.arguments[0]) : undefined;
}
function compileBlock(block, state, indent) {
  const body = nodes(block), lines = [];
  for (let i = 0; i < body.length; i++) {
    const n = body[i]; if (n.type === "EmptyStatement") continue;
    const d = n.type === "VariableDeclaration" && n.declarations.length === 1 && n.declarations[0];
    if (d?.id?.type === "Identifier") {
      if (d.id.name === state.eventName) return undefined;
      const target = fieldElement(d.init), next = body[i + 1];
      if (!state.eventName && block === state.callback.body && target && next?.type === "IfStatement" && next.test?.name === d.id.name && !next.alternate) {
        const only = nodes(next.consequent), expr = only.length === 1 && only[0]?.expression;
        if (expr?.type === "CallExpression" && member(expr.callee, "setAttribute") && expr.callee.object?.name === d.id.name && expr.arguments.length === 2 && literal(expr.arguments[0]) === "placeholder" && typeof literal(expr.arguments[1]) === "string") {
          if (state.fields.has(target) && componentSupportsProp(state.fields.get(target).componentId, "placeholder")) state.placeholder.set(target, literal(expr.arguments[1]));
          else if (state.absent.has(target)) state.closures.push({ kind: "absent-guarded-placeholder", fieldId: target, start: n.start, end: next.end });
          else return undefined;
          state.effects++; i++; continue;
        }
      }
      if (!target || !state.fields.has(target) || state.aliases.has(d.id.name)) return undefined;
      state.aliases.set(d.id.name, target); continue;
    }
    if (n.type === "IfStatement") {
      const test = condition(n.test, state); if (!test) return undefined;
      const yes = compileBlock(n.consequent, state, indent + "  "); if (!yes) return undefined;
      lines.push(indent + `if (${test}) {`, ...yes);
      if (n.alternate) { const no = compileBlock(n.alternate, state, indent + "  "); if (!no) return undefined; lines.push(indent + "} else {", ...no); }
      lines.push(indent + "}"); continue;
    }
    const expr = n.type === "ExpressionStatement" && n.expression;
    if (call(expr, "common_dom_row_set_show_required_reset") && expr.arguments.length === 4 && typeof literal(expr.arguments[0]) === "string" && expr.arguments.slice(1).every(a => typeof literal(a) === "boolean")) {
      const [target, visible, required, reset] = expr.arguments.map(literal), compiled = compileStaticRowEffect({ target, visible, required, reset }, state.form, indent);
      if (!compiled) return undefined; lines.push(...compiled); state.effects++; continue;
    }
    if (expr?.type === "AssignmentExpression" && expr.operator === "=" && member(expr.left, "value") && typeof literal(expr.right) === "string") {
      const target = fieldElement(expr.left.object) || state.aliases.get(expr.left.object?.name);
      if (!state.fields.has(target)) return undefined;
      lines.push(indent + `MKXFORM.setValue(${JSON.stringify(target)}, ${JSON.stringify(literal(expr.right))});`); state.effects++; state.fieldWrites++; continue;
    }
    return undefined;
  }
  return lines;
}
function condition(node, state) {
  if (node?.type === "LogicalExpression" && ["&&", "||"].includes(node.operator)) { const a = condition(node.left, state), b = condition(node.right, state); return a && b ? `(${a}) ${node.operator} (${b})` : undefined; }
  if (node?.type !== "BinaryExpression") return undefined;
  if (["==", "===", "!=", "!=="].includes(node.operator) && typeof literal(node.right) === "string") {
    const id = member(node.left, "value") && state.aliases.get(node.left.object?.name);
    const operand = node.left?.type === "Identifier" && node.left.name === state.eventName ? "value" : id ? `MKXFORM.getValue(${JSON.stringify(id)})` : undefined;
    if (operand) return `${operand} ${node.operator} ${JSON.stringify(literal(node.right))}`;
  }
  const c = node.left;
  if (node.operator === ">=" && literal(node.right) === 0 && c?.type === "CallExpression" && member(c.callee, "indexOf") && c.callee.object?.name === state.eventName && c.arguments.length === 1 && typeof literal(c.arguments[0]) === "string") return `value.indexOf(${JSON.stringify(literal(c.arguments[0]))}) >= 0`;
  return undefined;
}
function pureAbsentCurrency(fn, triggerId, state) {
  const body = nodes(fn.body), declaration = body[0]?.type === "VariableDeclaration" && body[0].declarations.length === 1 && body[0].declarations[0], write = body[1]?.expression;
  const missing = declaration && fieldElement(declaration.init), helper = write?.right?.callee?.name && state.helpers.get(write.right.callee.name);
  if (body.length !== 2 || !state.nativeCurrencySupported || !missing || !state.absent.has(missing) || state.fields.has(missing) || declaration.id?.type !== "Identifier" || write?.type !== "AssignmentExpression" || write.operator !== "=" || !member(write.left, "value") || write.left.object?.name !== declaration.id.name || !helper || write.right.arguments.length !== 1 || write.right.arguments[0]?.name !== fn.params[0]?.name || state.bindings.bindingAtUse(helper.id.name, write.right.callee.start) !== state.bindings.bindingAtUse(helper.id.name, helper.id.start)) return undefined;
  const live = [...state.fields.values()].filter(f => String(f.sourceProps?.designerType || "").toLowerCase() === "chinavalue" && f.sourceProps?.designerValues?.relatedid === triggerId && f.sourceProps?.metadataAttributes?.relatedid === triggerId);
  if (live.length !== 1 || live[0].props?.readOnly !== true) return undefined;
  state.effects++; state.usedHelpers.push(helper); state.closures.push({ kind: "absent-pure-currency-target", fieldId: missing, triggerId, nativeTargetId: live[0].id, helperSha256: hash(state.text.slice(helper.start, helper.end)), start: fn.start, end: fn.end });
  return [];
}
function checkboxJoin(fn, triggerId, state) {
  const body = nodes(fn.body), field = state.fields.get(triggerId);
  if (body.length !== 6 || !["checkbox", "radio"].includes(field?.type) || !Array.isArray(field.props?.options)) return undefined;
  const assignment = n => n?.type === "ExpressionStatement" && n.expression?.type === "AssignmentExpression" && n.expression.operator === "=" ? n.expression : undefined;
  const collection = assignment(body[0]), target = assignment(body[1]), list = assignment(body[2]), join = assignment(body[4]), final = assignment(body[5]), loop = body[3];
  if (collection?.left?.type !== "Identifier" || !call(collection.right, "GetXFormFieldById") || collection.right.arguments.length !== 1 || literal(collection.right.arguments[0]) !== triggerId || target?.left?.type !== "Identifier" || list?.left?.type !== "Identifier" || list.right?.type !== "ArrayExpression" || list.right.elements.length || join?.left?.type !== "Identifier") return undefined;
  const targetId = fieldElement(target.right), targetField = state.fields.get(targetId), iterator = loop?.init?.type === "VariableDeclaration" && loop.init.declarations.length === 1 && loop.init.declarations[0];
  if (!targetField || targetField.type !== "text" || targetField.sourceProps?.metadataAttributes?.canDisplay !== "false" || loop?.type !== "ForStatement" || iterator?.id?.type !== "Identifier" || literal(iterator.init) !== 0) return undefined;
  const index = iterator.id.name, root = collection.left.name, array = list.left.name, at = n => n?.type === "MemberExpression" && n.computed && n.object?.name === root && n.property?.name === index;
  if (loop.test?.type !== "BinaryExpression" || loop.test.operator !== "<" || loop.test.left?.name !== index || !member(loop.test.right, "length") || loop.test.right.object?.name !== root || loop.update?.type !== "UpdateExpression" || loop.update.operator !== "++" || loop.update.argument?.name !== index) return undefined;
  const loopBody = nodes(loop.body), branch = loopBody.length === 1 && loopBody[0], push = branch?.type === "IfStatement" && !branch.alternate && nodes(branch.consequent)[0]?.expression;
  if (!member(branch?.test, "checked") || !at(branch.test.object) || nodes(branch.consequent).length !== 1 || push?.type !== "CallExpression" || !member(push.callee, "push") || push.callee.object?.name !== array || push.arguments.length !== 1 || !member(push.arguments[0], "value") || !at(push.arguments[0].object)) return undefined;
  if (join.right?.type !== "CallExpression" || !member(join.right.callee, "join") || join.right.callee.object?.name !== array || join.right.arguments.length !== 1 || typeof literal(join.right.arguments[0]) !== "string" || !member(final?.left, "value") || final.left.object?.name !== target.left.name || final.right?.name !== join.left.name) return undefined;
  const escaped = new Set([root, target.left.name, array, join.left.name]);
  for (const other of state.sourceScripts.sources || []) {
    const program = ast(other.javascript); if (!program) return undefined;
    let observed = false;
    walk(program, (node, parent) => {
      if (node.type !== "Identifier" || !escaped.has(node.name) || other === state.source && node.start >= fn.start && node.end <= fn.end || parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return;
      observed = true;
    });
    if (observed) return undefined;
  }
  const options = field.props.options.map(o => o.value); if (!options.every(v => typeof v === "string") || new Set(options).size !== options.length) return undefined;
  state.effects++; state.fieldWrites++;
  return [`  var selected = MKXFORM.getValue(${JSON.stringify(triggerId)});`, "  var values = Array.isArray(selected) ? selected : (selected == null || selected === \"\" ? [] : [selected]);", `  var ordered = ${JSON.stringify(options)}.filter(function(option) { return values.indexOf(option) >= 0; });`, `  MKXFORM.setValue(${JSON.stringify(targetId)}, ordered.join(${JSON.stringify(literal(join.right.arguments[0]))}));`];
}
