import { createHash } from "node:crypto";
import { parse } from "acorn";
import { scanHtmlTags, findMatchingCloseTag } from "./designer-html-tokenizer.js";
import { parseStaticMarkupAttributes, staticSourceMarkup } from "./source-static-markup.js";
import { parseDesignerControlAttributes, parseDesignerFdValues, parseStaticDesignerStringValues } from "./designer-control-values.js";

const hash = value => createHash("sha256").update(String(value || "")).digest("hex");
const idPattern = /^[A-Za-z_][\w-]*$/;
const bindingSlots = ["name", "property", "propertyid", "propertyname"];
const htmlTags = new Set("html head body title meta link table tbody thead tfoot tr td th col colgroup div span p label input select option optgroup textarea button a b i u strong em small big font br hr img ul ol li dl dt dd form fieldset legend h1 h2 h3 h4 h5 h6 center section article header footer pre code style script".split(" "));
const gates = new Set(["xform:editshow", "xform:viewshow", "xform:right"]);
const renderers = new Set(["xform:xtext", "xform:text", "xform:xradio", "xform:radio", "xform:checkbox", "xform:select", "xform:datetime", "xform:address", "xform:textarea", "xform:rtf"]);
const textRendererAttributes = new Set(["property", "name", "datatype", "showstatus", "canshow", "style", "readonly", "required", "subject", "title", "onvaluechange", "htmlelementproperties"]);
const dynamic = value => /\$\{|#\{|<%|javascript\s*:|expression\s*\(/i.test(value);
const hidden = attrs => attrs.has("hidden") || attrs.get("type")?.toLowerCase() === "hidden" ||
  attrs.get("canshow")?.toLowerCase() === "false" || attrs.get("showstatus")?.toLowerCase() === "noshow" ||
  /(?:^|;)\s*display\s*:\s*none\s*(?:!important\s*)?(?:;|$)/i.test(attrs.get("style") || "");

/** Facts concern only the current export's statically present main String value bindings. */
export function mainStringValueBindingFacts(template = {}) {
  const sourceHashes = Object.fromEntries(["fdDesignerHtml", "fdDisplayJsp", "fdMetadataXml"].map(key => [key, hash(template[key])]));
  const metadata = metadataBindings(template.fdMetadataXml || "");
  const designer = surfaceBindings(template.fdDesignerHtml || "", "designer");
  const display = surfaceBindings(template.fdDisplayJsp || "", "display");
  const result = {};
  for (const [fieldId, declarations] of metadata.fields) {
    const surfaces = Object.fromEntries([["designer", designer], ["display", display]].map(([name, surface]) => {
      const bindings = surface.bindings.filter(binding => binding.fieldId === fieldId);
      return [name, { logicalBindingCount: bindings.length, hiddenBindingCount: bindings.filter(binding => binding.hidden).length,
        bindings, issues: [...surface.issues, ...bindings.flatMap(binding => binding.issues)] }];
    }));
    const reasons = [...metadata.issues];
    if (declarations.length !== 1 || declarations[0].kind !== "extendsimpleproperty" || declarations[0].type !== "String") reasons.push("metadata_not_one_main_String");
    for (const [name, surface] of Object.entries(surfaces)) {
      if (surface.logicalBindingCount !== 1) reasons.push(`${name}_binding_not_singleton`);
      if (surface.hiddenBindingCount !== 1) reasons.push(`${name}_binding_not_hidden`);
      if (surface.issues.length) reasons.push(`${name}_binding_domain_unproven`);
    }
    result[fieldId] = { version: 1, status: reasons.length ? "unproven" : "verified", fieldId, sourceHashes,
      metadata: { count: declarations.length, type: declarations.length === 1 ? declarations[0].type : undefined,
        declarations }, surfaces, reasons: [...new Set(reasons)] };
  }
  return result;
}

function metadataBindings(text) {
  const fields = new Map(), issues = [];
  let detailDepth = 0;
  for (const token of scanHtmlTags(text)) {
    if (token.name === "extendsubtableproperty") {
      detailDepth += token.closing ? -1 : token.selfClosing ? 0 : 1;
      if (detailDepth < 0) issues.push("metadata_unbalanced_detail");
      continue;
    }
    if (token.closing || detailDepth || !["extendsimpleproperty", "extendelementproperty"].includes(token.name)) continue;
    const attrs = parseStaticMarkupAttributes(token.attrs);
    if (!attrs || !idPattern.test(attrs.get("name") || "") || [...attrs.values()].some(dynamic)) { issues.push("metadata_dynamic_or_unparsed_property"); continue; }
    const id = attrs.get("name");
    if (!fields.has(id)) fields.set(id, []);
    fields.get(id).push({ kind: token.name, type: attrs.get("type"), start: token.start, end: token.end });
  }
  if (detailDepth) issues.push("metadata_unbalanced_detail");
  if (text.includes("<%") || /\$\{|#\{/.test(text)) issues.push("metadata_dynamic_markup");
  return { fields, issues };
}

function surfaceBindings(text, surface) {
  const bindings = [], issues = [];
  const markup = staticSourceMarkup(text);
  if (markup === undefined) return { bindings, issues: ["dynamic_or_unparsed_JSP"] };
  if (text.includes("<%")) issues.push("JSP_renderer_not_proven");
  issues.push(...scriptDomainIssues(text));
  const tokens = [...scanHtmlTags(markup)], entries = [], stack = [];
  let cursor = 0;
  for (const token of tokens) {
    if (/[<>]/.test(markup.slice(cursor, token.start))) issues.push("unparsed_markup_boundary");
    cursor = token.end;
    if (token.closing) {
      const expected = stack.pop();
      if (expected?.name !== token.name) issues.push("unbalanced_markup");
      continue;
    }
    const hasValues = /(?:^|\s)fd_values\s*=/i.test(token.attrs);
    const attrs = hasValues ? parseDesignerControlAttributes(token.attrs) : parseStaticMarkupAttributes(token.attrs);
    if (!attrs) { issues.push("unparsed_tag_attributes"); continue; }
    let values;
    if (hasValues) {
      const keys = new Set(Object.keys(parseDesignerFdValues(token.attrs)));
      values = parseStaticDesignerStringValues(token.attrs, keys, keys);
      if (!values || !idPattern.test(values.id || "")) issues.push("dynamic_or_unparsed_widget_values");
    }
    for (const [key, value] of attrs) {
      if (bindingSlots.includes(key) && (dynamic(value) || !staticBindingName(value))) issues.push("dynamic_or_unknown_binding_name");
      if (/^on/.test(key) && !(key === "onvaluechange" && value === "__xformDispatch") && !/^\s*return\s+false\s*;?\s*$/.test(value)) issues.push("unproven_inline_handler");
      if (["style", "id", "fd_type"].includes(key) && dynamic(value)) issues.push("dynamic_control_attributes");
      if (key === "htmlelementproperties" && value && !/^\s*readonly(?:\s*=\s*(['"]?)readonly\1)?\s*$/i.test(value)) issues.push("unproven_renderer_attributes");
    }
    if (!htmlTags.has(token.name) && !gates.has(token.name) && !renderers.has(token.name)) issues.push("unknown_rendering_tag");
    if (attrs.get("fd_type")?.toLowerCase() === "jsp") issues.push("opaque_designer_script_carrier");
    const entry = { token, attrs, values, hidden: hidden(attrs) || stack.some(parent => parent.hidden),
      gated: stack.some(parent => parent.gated) || gates.has(token.name) };
    entries.push(entry);
    if (!token.selfClosing && !["input", "br", "hr", "img", "meta", "link", "col"].includes(token.name)) stack.push({ name: token.name, hidden: entry.hidden, gated: entry.gated });
  }
  if (/[<>]/.test(markup.slice(cursor))) issues.push("unparsed_markup_boundary");
  if (stack.length) issues.push("unbalanced_markup");
  const consumed = new Map();
  if (surface === "designer") for (const entry of entries) {
    const { token, attrs, values } = entry;
    if (!values || !attrs.get("fd_type")) continue;
    const fieldId = values.id;
    const end = findMatchingCloseTag(markup, token.end, token.name);
    const inner = entries.filter(child => child.token.start >= token.end && child.token.start < end && ["input", "select", "textarea"].includes(child.token.name));
    const ownIssues = [];
    if (end < 0 || inner.length !== 1 || inner[0]?.token.name !== "input") ownIssues.push("widget_does_not_have_one_input");
    const validInner = inner.length === 1 && inner[0].attrs.get("id") === fieldId &&
      bindingSlots.every(key => !inner[0].attrs.has(key) || canonicalField(inner[0].attrs.get(key)) === fieldId);
    if (!validInner) ownIssues.push("widget_input_identity_unproven");
    const scalar = attrs.get("fd_type").toLowerCase() === "inputtext" && values.dataType === "String";
    if (!scalar) ownIssues.push("widget_not_static_String_inputText");
    const isHidden = entry.hidden || values.canShow === "false" || values.showStatus?.toLowerCase() === "noshow";
    const count = Math.max(1, inner.length);
    for (let index = 0; index < count; index++) bindings.push({ fieldId, kind: "designer-widget", start: token.start,
      end: end < 0 ? token.end : end, hidden: isHidden, issues: [...ownIssues, ...(entry.gated ? ["gated_binding"] : [])] });
    for (const input of inner) if (input.attrs.get("id") === fieldId || bindingSlots.some(key => canonicalField(input.attrs.get(key)) === fieldId)) consumed.set(input, fieldId);
  }
  for (const entry of entries) {
    const fields = [...new Set(bindingSlots.map(key => canonicalField(entry.attrs.get(key))).filter(Boolean))];
    if (fields.length > 1) issues.push("conflicting_binding_slots");
    for (const fieldId of fields) {
      if (consumed.get(entry) === fieldId) continue;
      const isInput = entry.token.name === "input";
      const isTextRenderer = ["xform:xtext", "xform:text"].includes(entry.token.name);
      const ownIssues = [];
      if (!isInput && !isTextRenderer) ownIssues.push("binding_renderer_not_single_String_input");
      if (isInput && entry.attrs.get("type")?.toLowerCase() !== "hidden") ownIssues.push("raw_binding_not_hidden_input");
      if (isTextRenderer && entry.attrs.has("datatype") && entry.attrs.get("datatype") !== "String") ownIssues.push("renderer_not_String");
      if (isTextRenderer && [...entry.attrs.keys()].some(key => !textRendererAttributes.has(key))) ownIssues.push("unproven_text_renderer_attributes");
      if (entry.gated) ownIssues.push("gated_binding");
      if (entry.attrs.has("disabled")) ownIssues.push("disabled_binding");
      bindings.push({ fieldId, kind: isInput ? "raw-input" : "runtime-renderer", start: entry.token.start, end: entry.token.end,
        hidden: entry.hidden, issues: ownIssues });
    }
  }
  return { bindings, issues: [...new Set(issues)] };
}

function canonicalField(value = "") {
  return /^extendDataFormInfo\.value\(([A-Za-z_][\w-]*)\)$/.exec(value)?.[1];
}
function staticBindingName(value) {
  return /^[A-Za-z_][\w.-]*$/.test(value) || /^extendDataFormInfo\.value\([A-Za-z_][\w.-]*\)$/.test(value);
}

const safeCalls = new Set(["GetXFormFieldValueById", "GetXFormFieldById", "SetXFormFieldValueById", "Com_AddEventListener", "AttachXFormValueChangeEventById", "common_dom_row_set_show_required_reset", "setTimeout", "clearTimeout"]);
const safeGlobals = new Set([...safeCalls, "window", "undefined", "NaN", "Infinity"]);
function scriptDomainIssues(text) {
  const issues = [];
  let skipUntil = 0;
  for (const token of scanHtmlTags(text)) {
    if (token.start < skipUntil || token.closing) continue;
    // The shared markup helper intentionally treats these bodies as opaque for
    // other evidence. Their binding/rendering contracts are outside this proof.
    if (["textarea", "xform:textarea", "pre", "code"].includes(token.name)) issues.push("opaque_control_domain");
    if (token.name !== "script") continue;
    const attrs = parseStaticMarkupAttributes(token.attrs);
    if (!attrs || [...attrs].some(([key, value]) => !(
      key === "type" && ["text/javascript", "application/javascript"].includes(value.toLowerCase()) ||
      key === "language" && value.toLowerCase() === "javascript"))) issues.push("unproven_script_attributes");
    const close = /<\/\s*script\s*>/ig;
    close.lastIndex = token.end;
    const match = close.exec(text);
    if (!match || token.selfClosing) { issues.push("unclosed_script"); continue; }
    skipUntil = close.lastIndex;
    if (!staticScriptBindingDomain(text.slice(token.end, match.index))) issues.push("unproven_script_binding_effects");
  }
  return issues;
}

// This is deliberately a small structural domain proof, not a JavaScript translator.
function staticScriptBindingDomain(javascript) {
  let program;
  try { program = parse(javascript, { ecmaVersion: "latest" }); } catch { return false; }
  const locals = new Set();
  let valid = true;
  const walk = (node, visit, parent) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) walk(item, visit, parent); return; }
    visit(node, parent);
    for (const [key, child] of Object.entries(node)) if (!["start", "end", "raw"].includes(key)) walk(child, visit, node);
  };
  walk(program, node => {
    const ids = node.type === "VariableDeclarator" ? [node.id] : ["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"].includes(node.type) ? [...node.params, ...(node.id ? [node.id] : [])] : [];
    for (const id of ids) {
      if (id?.type !== "Identifier" || safeGlobals.has(id.name)) valid = false;
      else locals.add(id.name);
    }
  });
  walk(program, (node, parent) => {
    if (["NewExpression", "ImportExpression", "TaggedTemplateExpression", "WithStatement", "ThisExpression", "AwaitExpression", "YieldExpression", "ClassExpression", "ClassDeclaration"].includes(node.type)) valid = false;
    if (node.type === "Identifier") {
      const property = parent?.type === "MemberExpression" && parent.property === node && !parent.computed;
      const key = parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand;
      if (!property && !key && !locals.has(node.name) && !safeGlobals.has(node.name)) valid = false;
    }
    if (node.type === "CallExpression") {
      const named = node.callee.type === "Identifier" && safeCalls.has(node.callee.name);
      const method = node.callee.type === "MemberExpression" && !node.callee.computed && ["indexOf", "includes"].includes(node.callee.property.name);
      if (!named && !method || node.optional) valid = false;
      if (named && node.callee.name === "setTimeout" && !["FunctionExpression", "ArrowFunctionExpression"].includes(node.arguments[0]?.type)) valid = false;
    }
    if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") {
      const target = node.left || node.argument;
      if (target.type !== "Identifier" || !locals.has(target.name)) valid = false;
    }
    if (node.type === "MemberExpression" && !(node.computed ? node.property.type === "Literal" && node.property.value === 0 : ["value", "length", "indexOf", "includes"].includes(node.property.name))) valid = false;
    if (node.type === "Property" && (node.computed || node.kind !== "init" || node.method)) valid = false;
    if (node.type === "UnaryExpression" && node.operator === "delete") valid = false;
  });
  return valid;
}
