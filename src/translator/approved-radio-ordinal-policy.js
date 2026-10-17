import { parse } from "acorn";
import { createHash } from "node:crypto";
import { canonicalJson, sha256Digest } from "../agent-review/digest.js";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";
import { componentSupportsProp } from "../dsl/catalogs.js";
import { compileStaticRowEffect } from "./inline-radio-row-effects.js";
import { scanHtmlTags, findMatchingCloseTag } from "./designer-html-tokenizer.js";
import { attrValue, decodeEntities } from "./xml-utils.js";

export const SOURCE_FORM_RADIO_ORDINAL_LOAD_KIND = "source-form-radio-ordinal-load";
const sha = text => "sha256:" + createHash("sha256").update(String(text)).digest("hex");
const hashPattern = /^sha256:[a-f0-9]{64}$/;
const value = node => node?.type === "Literal" ? node.value : undefined;
const call = (node, name) => node?.type === "CallExpression" && !node.optional && node.callee?.type === "Identifier" && node.callee.name === name;
const member = (node, name) => node?.type === "MemberExpression" && !node.computed && !node.optional && node.property?.name === name;
const body = node => node?.type === "BlockStatement" ? node.body.filter(n => n.type !== "EmptyStatement") : [node];
const exact = (object, keys) => object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
const text = x => typeof x === "string" && x.trim() === x && x.length > 0 && !/[\r\n]/.test(x);
const reserved = new Set(["MKXFORM", "window", "document", "globalThis", "self", "Object", "Array", "String", "Number", "Function", "eval", "undefined", "arguments", "NaN", "Infinity"]);
function requireProof(ok, message) { if (!ok) throw Object.assign(new Error(message), { code: "policy.radio_ordinal_source_not_matched" }); }
function walk(node, fn, parent) { if (!node || typeof node !== "object") return; fn(node, parent); for (const [key, child] of Object.entries(node)) if (!["start", "end", "raw"].includes(key)) { if (Array.isArray(child)) child.forEach(n => walk(n, fn, node)); else if (child && typeof child === "object") walk(child, fn, node); } }

// This records the exported form domain, not the old framework's global DOM.
// Applying the policy requires an explicit decision accepting that distinction.
export function sourceFormRadioOrdinalFact(template, form) {
  const runtime = String(template.fdDisplayJsp || "").replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, text => text.replace(/[^\r\n]/g, " ")), fields = (form.fields || []).filter(f => f.type === "radio"), groups = [];
  if (!runtime || !fields.length) return undefined;
  for (const token of scanHtmlTags(runtime)) {
    if (token.closing || token.name !== "xform:radio") continue;
    const id = /^extendDataFormInfo\.value\(([A-Za-z_][\w]*)\)$/.exec(attrValue(token.attrs, "property"))?.[1];
    const found = fields.filter(f => f.id === id), end = findMatchingCloseTag(runtime, token.end, token.name);
    if (found.length !== 1 || end < 0 || groups.some(g => g.fieldId === id)) return undefined;
    const inner = runtime.slice(token.end, end), options = [];
    const remainder = inner.replace(/<xform:simpleDataSource\b([^>]*)>([^<]*)<\/xform:simpleDataSource\s*>/gi, (_all, attrs, label) => {
      options.push({ label: decodeEntities(label).trim(), value: attrValue(attrs, "value") }); return "";
    });
    if (remainder.trim() || !options.length || options.some(o => !text(o.value) || !text(o.label) || /[{}<>]/.test(o.value + o.label)) || new Set(options.map(o => o.value)).size !== options.length || canonicalJson(options) !== canonicalJson(found[0].options)) return undefined;
    groups.push({ fieldId: id, options, offset: token.start });
  }
  if (groups.length !== fields.length) return undefined;
  const fact = { version: 1, status: "verified", domain: "exported-form-radio-groups", sourceHashes: Object.fromEntries(["fdDesignerHtml", "fdDisplayJsp", "fdMetadataXml"].map(key => [key, sha(template[key] || "")])), groups };
  return { ...fact, digest: sha256Digest(fact) };
}

export function validateApprovedRadioOrdinalDecisions(decisions = []) {
  const diagnostics = [], seen = new Set();
  const fail = message => diagnostics.push({ level: "error", code: "policy.radio_ordinal_invalid", message });
  if (!Array.isArray(decisions)) fail("Expected a decision array.");
  else for (const decision of decisions) {
    if (!exact(decision, ["kind", "sourceRef", "sourceJavascriptSha256", "actionId", "radioFieldIds", "sourceDomainDigest"]) || decision.kind !== SOURCE_FORM_RADIO_ORDINAL_LOAD_KIND || ![decision.sourceRef, decision.actionId].every(text) || !hashPattern.test(decision.sourceJavascriptSha256 || "") || !hashPattern.test(decision.sourceDomainDigest || "") || !Array.isArray(decision.radioFieldIds) || !decision.radioFieldIds.length || decision.radioFieldIds.some(id => !/^[A-Za-z_][\w]*$/.test(id)) || new Set(decision.radioFieldIds).size !== decision.radioFieldIds.length) fail("Exact source, action, script hash and ordered form-radio domain are required.");
    if (seen.has(decision?.actionId)) fail("An action cannot have duplicate ordinal policies.");
    seen.add(decision?.actionId);
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

export function applyApprovedRadioOrdinalPolicies(sourceDraft, draft, decisions = []) {
  requireProof(validateApprovedRadioOrdinalDecisions(decisions).ok, "Invalid form-radio ordinal decisions.");
  const result = structuredClone(draft), audits = [];
  for (const decision of decisions) {
    requireProof(sourceDraft.migrationPolicies?.decisions?.filter(d => canonicalJson(d) === canonicalJson(decision)).length === 1, "The explicit ordinal decision must be in the original authorized manifest.");
    const sources = (sourceDraft.scripts?.sources || []).filter(s => (s.sourceRef || s.id) === decision.sourceRef), source = sources[0];
    requireProof(sources.length === 1 && sha(source.javascript) === decision.sourceJavascriptSha256, "The original source script must match exactly.");
    const fact = source.semanticFacts?.sourceFormRadioOrdinalDomain;
    requireProof(fact?.version === 1 && fact.status === "verified" && fact.domain === "exported-form-radio-groups" && fact.digest === decision.sourceDomainDigest && sha256Digest(Object.fromEntries(Object.entries(fact).filter(([key]) => key !== "digest"))) === fact.digest && canonicalJson(fact.groups.map(g => g.fieldId)) === canonicalJson(decision.radioFieldIds), "The static source-form radio domain is missing or stale.");
    const fields = new Map((result.form.fields || []).filter(f => f.type !== "detailTable" && !f.dataOnly).map(f => [f.id, f]));
    for (const group of fact.groups) {
      const original = (sourceDraft.form?.controls || []).filter(f => f.id === group.fieldId), target = fields.get(group.fieldId);
      requireProof(original.length === 1 && original[0].sourceType === "radio" && canonicalJson(original[0].options) === canonicalJson(group.options) && target?.type === "radio" && target.componentId === "xform-radio" && canonicalJson(target.props.options) === canonicalJson(group.options), "Every ordered group and option must retain its exact original field identity.");
    }
    const actions = (result.scripts?.actions || []).filter(a => a.id === decision.actionId), action = actions[0];
    requireProof(actions.length === 1 && action.event === "onLoad" && action.scope === "global" && canonicalJson(action.sourceRefs) === canonicalJson([decision.sourceRef]), "The policy may change only its original global load action.");
    const program = parse(source.javascript, { ecmaVersion: "latest" }), bindings = buildJavaScriptBindingModel(source.javascript);
    requireProof(bindings.ok && stableSourceApis(sourceDraft.scripts?.sources || []), "Source APIs are shadowed, reassigned or dynamically exposed.");
    let ordinal = 0, boundary;
    for (const statement of program.body) {
      const c = statement.expression;
      if (c?.type !== "CallExpression" || c.callee?.type !== "Identifier" || !["AttachXFormValueChangeEventById", "Com_AddEventListener"].includes(c.callee.name)) continue;
      ordinal++;
      if (`${source.id}.event.${ordinal}` === action.id) boundary = c;
    }
    const fn = boundary?.arguments?.[2];
    requireProof(call(boundary, "Com_AddEventListener") && boundary.arguments.length === 3 && boundary.arguments[0]?.name === "window" && value(boundary.arguments[1]) === "load" && bindings.isUnshadowedGlobal("Com_AddEventListener", boundary.start) && bindings.isUnshadowedGlobal("window", boundary.start) && fn?.type === "FunctionExpression" && !fn.id && !fn.async && !fn.generator && !fn.params.length, "Only the retained ordinary window-load callback may be projected.");
    const domain = source.semanticFacts?.closedMainFieldDomain, stableDomain = domain?.scriptHashes?.length === (sourceDraft.scripts?.sources || []).length && (sourceDraft.scripts?.sources || []).every(s => domain.scriptHashes.filter(h => h.sourceRef === s.sourceRef && h.sha256 === sha(s.javascript).slice(7)).length === 1);
    const state = { fields, layout: result.form.layout, groups: fact.groups, handles: new Map(), collections: new Map(), placeholders: new Map(), absent: new Set(stableDomain ? domain.absentFieldIds : []), closures: [], radioScans: 0, readCollections: 0, fieldWrites: 0, rowEffects: 0, locals: new Set(), bindings };
    walk(fn.body, node => { if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") state.locals.add(node.id.name); if (node.type === "AssignmentExpression" && node.left?.type === "Identifier") state.locals.add(node.left.name); });
    requireProof([...state.locals].every(name => !reserved.has(name) && !name.startsWith("__sourceRadio")), "A source alias collides with the fixed target runtime.");
    const lines = compileBlock(fn.body, state, "  ");
    requireProof(lines && state.radioScans === 1 && state.readCollections >= 1 && state.rowEffects >= 1 && state.fieldWrites >= 1, "The complete source load is outside the closed radio-ordinal grammar.");
    for (const [id, hint] of state.placeholders) fields.get(id).props = { ...fields.get(id).props, placeholder: hint };
    const helpers = fact.groups.flatMap((group, index) => [
      `  function __sourceRadioGroup${index}() {`, `    var raw = MKXFORM.getValue(${JSON.stringify(group.fieldId)});`, "    var selected = Array.isArray(raw) ? raw[0] : raw;",
      `    return ${JSON.stringify(group.options)}.map(function(option) { return { value: option.value, label: option.label, checked: option.value === selected }; });`, "  }"
    ]);
    const generated = ["function onLoad() {", ...helpers, `  var ${[...state.locals].join(", ")};`, ...lines, "}"].join("\n");
    action.function = generated; action.translationStatus = "mapped";
    action.coverage = { status: "translated", nativeRules: [], residuals: [] };
    action.functionMappings = [{ source: "Explicitly approved source-form radio ordinal reconstruction", target: "same ordinal loop, branches, field clears and row effects over source-backed radio groups", basis: "deterministic-approved-migration-policy", reviewRequired: false }];
    action.semanticHints = { ...action.semanticHints, coveredCalculationRanges: [{ sourceRef: decision.sourceRef, name: "approvedSourceFormRadioOrdinalLoad", start: boundary.start, end: boundary.end }], approvedRadioOrdinal: { sourceDomainDigest: fact.digest, radioFieldIds: decision.radioFieldIds, approvedDifference: "Reconstruct radio input order from the current exported form groups; framework inputs and renderer-specific checked attributes are excluded." } };
    audits.push({ kind: decision.kind, actionId: action.id, sourceRef: decision.sourceRef, sourceJavascriptSha256: decision.sourceJavascriptSha256, sourceDomainDigest: fact.digest, radioFieldIds: decision.radioFieldIds, workflowBefore: sha256Digest(result.workflow ?? null), sourceCallback: { start: boundary.start, end: boundary.end, sha256: sha(source.javascript.slice(boundary.start, boundary.end)) }, implementationSha256: sha(generated), radioScans: state.radioScans, fieldWrites: state.fieldWrites, rowEffects: state.rowEffects, closures: state.closures,
      approvedDifference: action.semanticHints.approvedRadioOrdinal.approvedDifference, retainedBehavior: "Original selected-radio ordinal counting, label predicates, OR branches, amount clears, visibility and required flags." });
  }
  return { draft: result, audits, changedActionIds: audits.map(a => a.actionId) };
}

function compileBlock(block, state, indent) {
  const statements = body(block), lines = [];
  for (let i = 0; i < statements.length; i++) {
    const node = statements[i];
    if (node.type === "EmptyStatement") continue;
    if (node.type === "VariableDeclaration") {
      if (node.declarations.length !== 1 || node.declarations[0].id?.type !== "Identifier") return undefined;
      const declaration = node.declarations[0], id = elementField(declaration.init), next = statements[i + 1];
      if (id) {
        if (next?.type === "IfStatement" && next.test?.name === declaration.id.name && !next.alternate) {
          const entries = body(next.consequent), c = entries.length === 1 && entries[0].expression;
          if (c?.type === "CallExpression" && member(c.callee, "setAttribute") && c.callee.object?.name === declaration.id.name && c.arguments.length === 2 && value(c.arguments[0]) === "placeholder" && typeof value(c.arguments[1]) === "string") {
            if (state.fields.has(id) && componentSupportsProp(state.fields.get(id).componentId, "placeholder")) state.placeholders.set(id, value(c.arguments[1]));
            else if (state.absent.has(id)) state.closures.push({ kind: "absent-guarded-placeholder", fieldId: id, start: node.start, end: next.end });
            else return undefined;
            i++; continue;
          }
        }
        if (!state.fields.has(id) || state.handles.has(declaration.id.name)) return undefined;
        state.handles.set(declaration.id.name, id); continue;
      }
      const init = expression(declaration.init, state); if (init === undefined) return undefined;
      lines.push(indent + `var ${declaration.id.name} = ${init};`); continue;
    }
    if (node.type === "IfStatement") {
      const test = expression(node.test, state), yes = compileBlock(node.consequent, state, indent + "  ");
      if (test === undefined || !yes) return undefined;
      lines.push(indent + `if (${test}) {`, ...yes);
      if (node.alternate) { const no = compileBlock(node.alternate, state, indent + "  "); if (!no) return undefined; lines.push(indent + "} else {", ...no); }
      lines.push(indent + "}"); continue;
    }
    if (node.type === "ForStatement") {
      const initial = node.init?.type === "VariableDeclaration" && node.init.declarations.length === 1 && node.init.declarations[0];
      const test = expression(node.test, state), update = expression(node.update, state), content = compileBlock(node.body, state, indent + "  ");
      if (!initial || initial.id?.type !== "Identifier" || value(initial.init) !== 0 || node.test?.type !== "BinaryExpression" || node.test.operator !== "<" || node.test.left?.name !== initial.id.name || !member(node.test.right, "length") || !state.collections.has(node.test.right.object?.name) || node.update?.type !== "UpdateExpression" || node.update.operator !== "++" || node.update.argument?.name !== initial.id.name || test === undefined || update === undefined || !content) return undefined;
      lines.push(indent + `for (var ${initial.id.name} = 0; ${test}; ${update}) {`, ...content, indent + "}"); continue;
    }
    if (node.type === "BreakStatement" && !node.label) { lines.push(indent + "break;"); continue; }
    const expr = node.type === "ExpressionStatement" && node.expression;
    if (call(expr, "common_dom_row_set_show_required_reset") && expr.arguments.length === 4 && typeof value(expr.arguments[0]) === "string" && expr.arguments.slice(1).every(a => typeof value(a) === "boolean")) {
      if (!state.bindings.isUnshadowedGlobal("common_dom_row_set_show_required_reset", expr.start)) return undefined;
      const [target, visible, required, reset] = expr.arguments.map(value), compiled = compileStaticRowEffect({ target, visible, required, reset }, { fields: [...state.fields.values()], layout: state.layout }, indent);
      if (!compiled) return undefined; lines.push(...compiled); state.rowEffects++; continue;
    }
    if (expr?.type === "AssignmentExpression" && expr.operator === "=") {
      const id = member(expr.left, "value") && state.handles.get(expr.left.object?.name);
      if (id) { if (typeof value(expr.right) !== "string") return undefined; lines.push(indent + `MKXFORM.setValue(${JSON.stringify(id)}, ${JSON.stringify(value(expr.right))});`); state.fieldWrites++; continue; }
      if (expr.left?.type !== "Identifier" || !state.locals.has(expr.left.name)) return undefined;
      if (call(expr.right, "GetXFormFieldById") && expr.right.arguments.length === 1 && typeof value(expr.right.arguments[0]) === "string") {
        const group = state.groups.findIndex(g => g.fieldId === value(expr.right.arguments[0]));
        if (group < 0 || !state.bindings.isUnshadowedGlobal("GetXFormFieldById", expr.right.start)) return undefined;
        state.collections.set(expr.left.name, "group"); state.readCollections++;
        lines.push(indent + `${expr.left.name} = __sourceRadioGroup${group}();`); continue;
      }
      if (expr.right?.type === "CallExpression" && member(expr.right.callee, "getElementsByTagName") && expr.right.callee.object?.name === "document" && expr.right.arguments.length === 1 && value(expr.right.arguments[0]) === "input") {
        if (!state.bindings.isUnshadowedGlobal("document", expr.right.start)) return undefined;
        state.collections.set(expr.left.name, "inventory"); state.radioScans++;
        lines.push(indent + `${expr.left.name} = [].concat(${state.groups.map((_g, index) => `__sourceRadioGroup${index}()`).join(", ")});`); continue;
      }
      const right = expression(expr.right, state); if (right === undefined) return undefined;
      lines.push(indent + `${expr.left.name} = ${right};`); continue;
    }
    const rendered = expression(expr, state); if (expr?.type !== "UpdateExpression" || rendered === undefined) return undefined;
    lines.push(indent + rendered + ";");
  }
  return lines;
}
function elementField(node) { return node?.type === "MemberExpression" && node.computed && value(node.property) === 0 && call(node.object, "GetXFormFieldById") && node.object.arguments.length === 1 && typeof value(node.object.arguments[0]) === "string" ? value(node.object.arguments[0]) : undefined; }
function indexed(node, state) { return node?.type === "MemberExpression" && node.computed && state.collections.has(node.object?.name) && node.property?.type === "Identifier" && state.locals.has(node.property.name) ? `${node.object.name}[${node.property.name}]` : undefined; }
function expression(node, state) {
  if (node?.type === "Literal" && ["string", "number", "boolean", "object"].includes(typeof node.value) && !node.regex && (node.value === null || typeof node.value !== "object")) return JSON.stringify(node.value);
  if (node?.type === "Identifier" && state.locals.has(node.name) && !state.handles.has(node.name)) return node.name;
  if (node?.type === "UnaryExpression" && node.operator === "-" && typeof value(node.argument) === "number") return `-${value(node.argument)}`;
  if (node?.type === "UpdateExpression" && node.operator === "++" && node.argument?.type === "Identifier" && state.locals.has(node.argument.name)) return node.prefix ? `++${node.argument.name}` : `${node.argument.name}++`;
  if (["BinaryExpression", "LogicalExpression"].includes(node?.type) && ["==", "===", "!=", "!==", "<", "<=", ">", ">=", "&&", "||"].includes(node.operator)) { const a = expression(node.left, state), b = expression(node.right, state); return a !== undefined && b !== undefined ? `(${a} ${node.operator} ${b})` : undefined; }
  const item = indexed(node, state); if (item) return item;
  if (node?.type === "MemberExpression" && !node.computed && !node.optional) {
    const id = node.property?.name === "value" && state.handles.get(node.object?.name); if (id) return `MKXFORM.getValue(${JSON.stringify(id)})`;
    if (node.property?.name === "length" && state.collections.has(node.object?.name)) return node.object.name + ".length";
    const index = indexed(node.object, state); if (index && ["value", "checked"].includes(node.property?.name)) return index + "." + node.property.name;
    const original = member(node, "innerHTML") && member(node.object, "parentNode") && indexed(node.object.object, state);
    if (original && state.collections.get(node.object.object.object?.name) === "inventory") return original + ".label";
  }
  if (node?.type === "CallExpression" && !node.optional && node.arguments.length === 1) {
    const index = member(node.callee, "getAttribute") && indexed(node.callee.object, state);
    if (index && state.collections.get(node.callee.object.object?.name) === "inventory") {
      if (value(node.arguments[0]) === "type") return '"radio"';
      if (value(node.arguments[0]) === "checked") return `(${index}.checked ? "" : null)`;
    }
    if (member(node.callee, "indexOf") && typeof value(node.arguments[0]) === "string") { const target = expression(node.callee.object, state); if (target?.endsWith(".label")) return `${target}.indexOf(${JSON.stringify(value(node.arguments[0]))})`; }
  }
  return undefined;
}
function stableSourceApis(sources) {
  const names = new Set(["GetXFormFieldById", "Com_AddEventListener", "common_dom_row_set_show_required_reset", "document", "window", "Array"]);
  for (const source of sources) {
    let p; try { p = parse(source.javascript, { ecmaVersion: "latest" }); } catch { return false; }
    let okay = true;
    walk(p, node => {
      const left = node.type === "VariableDeclarator" ? node.id : node.type === "FunctionDeclaration" ? node.id : ["AssignmentExpression", "UpdateExpression"].includes(node.type) ? node.left || node.argument : undefined;
      if (left?.type === "Identifier" && names.has(left.name)) okay = false;
      if (left?.type === "MemberExpression") { let root = left; while (root.type === "MemberExpression") root = root.object; if (["window", "document", "globalThis", "self", "Array"].includes(root.name)) okay = false; }
      if (call(node, "eval") || call(node, "Function") || node.type === "WithStatement") okay = false;
    }); if (!okay) return false;
  }
  return true;
}
