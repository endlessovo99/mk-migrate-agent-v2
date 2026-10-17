import { parse } from "acorn";
import { createHash } from "node:crypto";
import { canonicalJson } from "../agent-review/digest.js";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";
import { dynamicAnchorAssignment } from "./dynamic-hyperlink.js";
import { ROW_MARKER_HELPER } from "./row-marker-orphan-audit.js";
import { scanHtmlTags, isVoidLikeTag } from "./designer-html-tokenizer.js";
import { staticSourceMarkup } from "./source-static-markup.js";
import { decodeEntities } from "./xml-utils.js";

const hash = text => createHash("sha256").update(String(text)).digest("hex");
const GLOBALS = ["window", "document", "GetXFormFieldById", "Com_AddEventListener", ROW_MARKER_HELPER];
const PLATFORM_CALLS = new Set(["Com_AddEventListener", "AttachXFormValueChangeEventById", "GetXFormFieldById", "GetXFormFieldValueById", "SetXFormFieldValueById", ROW_MARKER_HELPER, "common_required", "common_not_required", "setTimeout", "clearTimeout", "Number", "String", "parseInt", "parseFloat"]);
const VALUE_METHODS = new Set(["indexOf", "includes", "toString", "split", "substr", "substring", "slice", "charAt", "toFixed", "log"]);
const PROTECTED_GLOBALS = [...new Set([...GLOBALS, ...PLATFORM_CALLS, "Array", "Math", "console"])];

// A point witness within the existing orphan-helper, ordinary onLoad and
// dynamic-hyperlink contracts. It does not normalize or erase any source text.
export function analyzeOrphanBeforeAnchorWitness(source = {}, form = {}, { sourceScripts, rawMarkup } = {}) {
  const text = String(source.javascript || ""), sourceRef = source.sourceRef || source.id;
  if (!sourceRef || !sourceScripts?.sources?.includes(source) || !rawMarkup ||
      ![undefined, "xform:editShow", "xform:viewShow"].includes(source.displayGate)) return undefined;
  const sourceRefs = sourceScripts.sources.map(s => s.sourceRef || s.id);
  if (sourceScripts.sources.filter(s => s === source).length !== 1 || sourceRefs.some(ref => !ref) ||
      new Set(sourceRefs).size !== sourceRefs.length) return undefined;
  let ast;
  try { ast = parse(text, { ecmaVersion: "latest" }); } catch { return undefined; }
  const top = statements(ast.body), call = top[0]?.expression;
  if (top.length !== 1 || top[0].type !== "ExpressionStatement" || !namedCall(call, "Com_AddEventListener") ||
      call.arguments.length !== 3 || !identifier(call.arguments[0], "window") || literal(call.arguments[1]) !== "load") return undefined;
  const callback = call.arguments[2], body = statements(callback?.body?.body);
  if (callback?.type !== "FunctionExpression" || callback.id || callback.async || callback.generator || callback.params.length || body.length !== 4) return undefined;
  const first = fieldRead(body[0]), second = fieldRead(body[1]);
  if (!first || !second || first.variable === second.variable || first.fieldId === second.fieldId ||
      [first.variable, second.variable].some(name => GLOBALS.includes(name))) return undefined;
  const rowStatement = body[2], row = rowStatement?.expression;
  if (rowStatement?.type !== "ExpressionStatement" || !namedCall(row, ROW_MARKER_HELPER) || row.arguments.length !== 4 ||
      typeof literal(row.arguments[0]) !== "string" || row.arguments.slice(1).some(n => n.type !== "Literal" || typeof n.value !== "boolean")) return undefined;
  const rowId = literal(row.arguments[0]), flags = row.arguments.slice(1).map(n => n.value);
  const anchor = dynamicAnchorAssignment(body[3], first.variable);
  if (!rowId || !anchor || anchor.target !== "_blank" && anchor.label !== "查看发票") return undefined;
  let secondUses = 0;
  walk(callback.body, n => { if (identifier(n, second.variable)) secondUses++; });
  if (secondUses !== 1) return undefined;
  const fact = source.semanticFacts?.rowMarkers;
  if (!Array.isArray(fact) || fact.length !== 1 || fact[0].rowId !== rowId ||
      [fact[0].visible, fact[0].required, fact[0].reset].some((v, i) => v !== flags[i])) return undefined;
  const mainIds = new Set([...(form.fields || form.controls || []), ...(form.dataFields || [])]
    .filter(f => f && f.type !== "detailTable" && !f.columns).map(f => f.id));
  if (!mainIds.has(first.fieldId) || !mainIds.has(second.fieldId) || mainIds.has(rowId)) return undefined;
  const markers = new Set();
  walk(form.layout, n => { for (const marker of n.sourceMarkers || []) markers.add(marker); });
  if (markers.has(rowId)) return undefined;
  const markup = rawEvidence(rawMarkup, rowId, anchor.containerId, [first.fieldId, second.fieldId]);
  if (!markup) return undefined;
  const registry = registryEvidence(source, sourceScripts.sources, form, rowId, body[3].start, body[3].end);
  if (!registry) return undefined;
  const result = {
    version: 1, sourceRef, sourceJavascriptSha256: hash(text),
    sourceRange: range(top[0]), callbackRange: range(callback),
    reads: [first, second].map((read, index) => ({ ...read, ...range(body[index]) })),
    rowCall: { rowId, flags, ...range(rowStatement), statementSha256: hash(text.slice(rowStatement.start, rowStatement.end)) },
    anchor: { ...anchor, ...range(body[3]), statementSha256: hash(text.slice(body[3].start, body[3].end)) },
    rawMarkup: markup, authoredSources: registry,
    layoutMarkerIds: [...markers].sort(), layoutMarkersSha256: hash(JSON.stringify([...markers].sort())),
    lifecycle: "normal-single-window-load-before-the-only-anchor-write",
    contracts: {
      orphanHelper: "existing audited absent-row helper no-op; literal flags and unused return",
      load: "existing Com_AddEventListener(window,load,anonymous-function) to ordinary onLoad",
      anchor: "existing dynamicAnchorAssignment matcher and http-or-https native hyperlink policy",
      valueDomain: "valid HTTP/HTTPS hyperlink values; unsafe HTML interpretation is not generated",
      scope: "first ordinary load invocation; explicit dispatch/reentry and earlier authored DOM creation rejected"
    }
  };
  return { ...result, witnessSha256: hash(canonicalJson(result)) };
}

export function inspectOrphanBeforeAnchorWitness(witness, source, form, options) {
  const expected = analyzeOrphanBeforeAnchorWitness(source, form, options);
  return { ok: Boolean(expected && witness && canonicalJson(witness) === canonicalJson(expected)), expected };
}

function rawEvidence(raw, rowId, containerId, fieldIds) {
  const summary = {}, runtimeBindings = new Map(fieldIds.map(id => [id, []]));
  let runtimeAnchor;
  for (const key of ["fdDesignerHtml", "fdDisplayJsp"]) {
    const html = raw[key];
    if (typeof html !== "string" || !html) return undefined;
    let scriptEnd = 0;
    for (const token of scanHtmlTags(html)) {
      if (token.start < scriptEnd || token.closing || token.name !== "script") continue;
      const attrs = attributes(token.attrs);
      if (!attrs || attrs.src) return undefined;
      const close = /<\/\s*script\s*>/ig;
      close.lastIndex = token.end;
      if (!close.exec(html)) return undefined;
      scriptEnd = close.lastIndex;
    }
    const markup = staticSourceMarkup(html);
    if (markup === undefined) return undefined;
    const nodes = [], stack = [];
    for (const token of scanHtmlTags(markup)) {
      if (token.closing) {
        const index = stack.findLastIndex(n => n.tag === token.name);
        if (index >= 0) { stack[index].closeStart = token.start; stack.splice(index); }
        continue;
      }
      const attrs = attributes(token.attrs);
      if (!attrs) return undefined;
      if (["id", "name"].some(k => attrs[k] === rowId || dynamicCouldEqual(attrs[k], rowId))) return undefined;
      if (attrs.src && token.name === "script") return undefined;
      const node = { tag: token.name, start: token.start, end: token.end, attrs, ancestors: stack.map(n => n.tag), parent: stack.at(-1) };
      nodes.push(node);
      if (!token.selfClosing && !isVoidLikeTag(token.name)) stack.push(node);
    }
    if (key === "fdDisplayJsp") {
      const anchors = nodes.filter(n => n.attrs.id === containerId);
      if (anchors.length !== 1 || anchors[0].tag !== "div" || anchors[0].ancestors.some(n => n.includes(":")) ||
          anchors[0].closeStart === undefined || markup.slice(anchors[0].end, anchors[0].closeStart).trim()) return undefined;
      let row = anchors[0].parent;
      while (row && row.tag !== "tr") row = row.parent;
      const rowMarkers = row ? nodes.filter(node => {
        if (node.tag !== "input" || node.attrs.type?.toLowerCase() !== "hidden") return false;
        for (let parent = node.parent; parent; parent = parent.parent) if (parent === row) return true;
        return false;
      }).map(node => /_row\d*$/i.test(node.attrs.name || "") ? node.attrs.name
        : /_row\d*$/i.test(node.attrs.id || "") ? node.attrs.id : undefined).filter(Boolean) : [];
      runtimeAnchor = { containerId, start: anchors[0].start, end: anchors[0].end,
        rowMarkers: [...new Set(rowMarkers)], ...(row ? { rowStart: row.start, rowCloseStart: row.closeStart } : {}) };
      for (const node of nodes) for (const id of fieldIds) {
        if (node.attrs.property !== `extendDataFormInfo.value(${id})`) continue;
        if (!["xform:xtext", "xform:text"].includes(node.tag) || node.attrs.datatype && node.attrs.datatype !== "String") return undefined;
        runtimeBindings.get(id).push({ fieldId: id, renderer: node.tag, start: node.start, end: node.end });
      }
    }
    summary[key] = { sha256: hash(html), length: html.length };
  }
  if ([...runtimeBindings.values()].some(entries => entries.length !== 1)) return undefined;
  return { ...summary, runtimeAnchor, runtimeBindings: [...runtimeBindings.values()].flat() };
}

function registryEvidence(current, sources, form, rowId, anchorStart, anchorEnd) {
  const scalarIds = new Set([...(form.fields || form.controls || []), ...(form.dataFields || [])]
    .filter(field => ["text", "number", "date", "radio", "checkbox", "singleSelect", "select", undefined].includes(field.type) && !field.columns)
    .map(field => field.id));
  const result = [];
  for (const source of sources) {
    const text = String(source.javascript || ""), bindings = buildJavaScriptBindingModel(text);
    if (!bindings.ok || PROTECTED_GLOBALS.some(name => !bindings.isUnshadowedGlobal(name, text.length))) return undefined;
    let ast;
    try { ast = parse(text, { ecmaVersion: "latest" }); } catch { return undefined; }
    const localFunctions = new Set();
    walk(ast, n => { if (n.type === "FunctionDeclaration" && n.id) localFunctions.add(n.id.name); });
    let invalid = false, markerReferences = 0;
    walk(ast, (node, parent) => {
      if (node.type === "Literal" && typeof node.value === "string" && node.value.includes(rowId)) markerReferences++;
      if (node.type === "Identifier" &&
          !(parent?.type === "MemberExpression" && parent.property === node && !parent.computed) &&
          !(parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand)) {
        if (!bindings.bindingAtUse(node.name, node.start) &&
            !PROTECTED_GLOBALS.includes(node.name) && !["undefined", "NaN", "Infinity"].includes(node.name)) invalid = true;
        if (node.name === "document" && !(source === current && node.start >= anchorStart && node.end <= anchorEnd)) invalid = true;
        if (node.name === "window" && !(namedCall(parent, "Com_AddEventListener") && parent.arguments[0] === node)) invalid = true;
        if (PLATFORM_CALLS.has(node.name) && !(parent?.type === "CallExpression" && parent.callee === node)) invalid = true;
      }
      if (["ImportExpression", "TaggedTemplateExpression", "WithStatement", "ThisExpression"].includes(node.type)) invalid = true;
      if (node.type === "NewExpression" && (!identifier(node.callee, "Array") || !bindings.isUnshadowedGlobal("Array", node.start))) invalid = true;
      if (node.type === "CallExpression") {
        if (source === current && node.start >= anchorStart && node.end <= anchorEnd) return;
        if (node.callee.type === "Identifier") {
          if (!PLATFORM_CALLS.has(node.callee.name) && !localFunctions.has(node.callee.name)) invalid = true;
          if (PLATFORM_CALLS.has(node.callee.name) && !bindings.isUnshadowedGlobal(node.callee.name, node.start)) invalid = true;
          if (["GetXFormFieldById", "GetXFormFieldValueById", "SetXFormFieldValueById", "common_required", "common_not_required"].includes(node.callee.name) &&
              !scalarIds.has(literal(node.arguments[0]))) invalid = true;
        } else if (node.callee.type !== "MemberExpression" || node.callee.computed || !VALUE_METHODS.has(node.callee.property?.name)) invalid = true;
      }
      if (node.type === "AssignmentExpression" || node.type === "UpdateExpression" || node.type === "UnaryExpression" && node.operator === "delete") {
        if (source === current && node.start === anchorStart && node.end <= anchorEnd) return;
        let target = node.left || node.argument;
        if (target?.type === "MemberExpression" && ["id", "name", "innerHTML", "outerHTML"].includes(target.computed ? target.property.value : target.property.name)) invalid = true;
        while (target?.type === "MemberExpression") target = target.object;
        if (target?.type === "Identifier" && PROTECTED_GLOBALS.includes(target.name)) invalid = true;
      }
    });
    if (invalid || markerReferences !== (source === current ? 1 : 0)) return undefined;
    result.push({ sourceRef: source.sourceRef || source.id, javascriptSha256: hash(text), length: text.length });
  }
  return result.sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
}

function attributes(text) {
  const result = {}, pattern = /\s*([^\s"'`<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/y;
  const source = text.replace(/<c:url\s+value=(["'])([^"'<>${}\r\n]*)\1\s*\/>/g, (_, _quote, path) => path)
    .replace(/\/\s*$/, ""); let offset = 0;
  while (source.slice(offset).trim()) {
    if (offset && !/\s/.test(source[offset])) return undefined;
    pattern.lastIndex = offset; const match = pattern.exec(source);
    if (!match) return undefined;
    const key = match[1].toLowerCase(), value = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
    if (Object.hasOwn(result, key) && result[key] !== value) return undefined;
    result[key] = value; offset = pattern.lastIndex;
  }
  return result;
}
function dynamicCouldEqual(value, target) {
  if (typeof value !== "string" || !value.includes("${")) return false;
  const pieces = value.split(/\$\{[^}]*\}/g);
  return pieces.length > 1 && target.startsWith(pieces[0]) && target.endsWith(pieces.at(-1));
}
function fieldRead(statement) {
  const declaration = statement?.type === "VariableDeclaration" && statement.kind === "var" && statement.declarations.length === 1 ? statement.declarations[0] : undefined;
  const value = declaration?.init, indexed = value?.object, call = indexed?.object;
  if (declaration?.id.type !== "Identifier" || value?.type !== "MemberExpression" || value.computed || value.property.name !== "value" ||
      indexed?.type !== "MemberExpression" || !indexed.computed || literal(indexed.property) !== 0 ||
      !namedCall(call, "GetXFormFieldById") || call.arguments.length !== 1 || typeof literal(call.arguments[0]) !== "string") return undefined;
  return { variable: declaration.id.name, fieldId: literal(call.arguments[0]) };
}
function namedCall(node, name) { return node?.type === "CallExpression" && !node.optional && identifier(node.callee, name); }
function identifier(node, name) { return node?.type === "Identifier" && node.name === name; }
function literal(node) { return node?.type === "Literal" ? node.value : undefined; }
function statements(body) { return (body || []).filter(n => n.type !== "EmptyStatement"); }
function range(node) { return { start: node.start, end: node.end }; }
function walk(node, visit, parent) { if (!node || typeof node !== "object") return; visit(node, parent); for (const value of Object.values(node)) { if (Array.isArray(value)) value.forEach(child => walk(child, visit, node)); else if (value && typeof value === "object") walk(value, visit, node); } }
