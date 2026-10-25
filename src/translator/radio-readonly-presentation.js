import { parse } from "acorn";
import { createHash } from "node:crypto";
import { canonicalJson, sha256Digest } from "../agent-review/digest.js";
import { scanHtmlTags, findMatchingCloseTag } from "./designer-html-tokenizer.js";
import { parseStaticMarkupAttributes, staticSourceMarkup } from "./source-static-markup.js";
import { sourceRadioGroupingValues } from "./radio-source-proof.js";
import { parseDesignerControlAttributes, parseDesignerFdValues } from "./designer-control-values.js";
import { attrValue, cleanText, decodeEntities } from "./xml-utils.js";

export const RADIO_READONLY_OPTIONS_KIND = "source-radio-readonly-options";
const hash = text => "sha256:" + createHash("sha256").update(String(text || "")).digest("hex");
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const exact = (x, keys) => x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const identifier = /^[A-Za-z_][\w]*$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const binding = value => /^extendDataFormInfo\.value\(([A-Za-z_][\w]*)\)$/.exec(value || "")?.[1];
const dynamic = text => /\$\{|#\{|<%|javascript\s*:|expression\s*\(/i.test(text);
const literal = node => node?.type === "Literal" && !node.regex ? node.value : undefined;
const namedCall = (node, name) => node?.type === "CallExpression" && !node.optional && node.callee.type === "Identifier" && node.callee.name === name;
const member = (node, name) => node?.type === "MemberExpression" && !node.computed && !node.optional && node.property.name === name;
function requireProof(value, message) { if (!value) throw Object.assign(new Error(message), { code: "policy.radio_readonly_source_unproved" }); }

/** Structural facts only. The caller's policy supplies the reviewed presentation intent. */
export function radioReadOnlySourceFacts(template = {}, form = {}, scripts = {}) {
  const designer = staticSourceMarkup(template.fdDesignerHtml || "");
  const runtime = staticSourceMarkup(template.fdDisplayJsp || "");
  const sourceHashes = Object.fromEntries(["fdDesignerHtml", "fdDisplayJsp", "fdMetadataXml"].map(k => [k, hash(template[k])]));
  const scriptDomain = scriptInventory(template, scripts, form);
  const result = {};
  for (const field of (form.fields || []).filter(f => f.type === "radio")) {
    const reasons = [], id = field.id, options = field.options;
    const dt = designer === undefined ? [] : [...scanHtmlTags(designer)];
    const rt = runtime === undefined ? [] : [...scanHtmlTags(runtime)];
    const widgets = dt.filter(t => !t.closing && attrValue(t.attrs, "fd_type").toLowerCase() === "inputradio" && parseDesignerFdValues(t.attrs).id === id);
    const renderers = rt.filter(t => {
      if (t.closing) return false;
      const attrs = parseStaticMarkupAttributes(t.attrs);
      return attrs && (["property", "name", "propertyid", "propertyname"].some(k => binding(attrs.get(k)) === id || attrs.get(k) === id) ||
        ["input", "select", "textarea"].includes(t.name) && [attrs.get("id"), attrs.get("name")].includes(id));
    });
    const mt = [...scanHtmlTags(template.fdMetadataXml || "")];
    const metadata = mt.filter(t => !t.closing &&
      ["extendsimpleproperty", "extendelementproperty"].includes(t.name) && attrValue(t.attrs, "name") === id);
    if (designer === undefined || runtime === undefined) reasons.push("dynamic_markup");
    if (widgets.length !== 1 || renderers.length !== 1 || metadata.length !== 1) reasons.push("binding_not_unique");
    const widget = widgets[0], renderer = renderers[0], meta = metadata[0];
    const values = widget && sourceRadioGroupingValues(widget.attrs);
    const attrs = renderer && parseStaticMarkupAttributes(renderer.attrs);
    const ma = meta && parseStaticMarkupAttributes(meta.attrs);
    const end = renderer ? findMatchingCloseTag(runtime, renderer.end, renderer.name) : -1;
    const rendererOptions = end >= 0 ? staticRadioOptions(runtime.slice(renderer.end, end)) : undefined;
    const inputs = widget ? dt.filter(t => !t.closing && t.name === "input" && t.start > widget.end &&
      t.end < findMatchingCloseTag(designer, widget.end, widget.name)).map(t => parseStaticMarkupAttributes(t.attrs)) : [];
    const allInputs = dt.filter(t => !t.closing && t.name === "input" && attrValue(t.attrs, "id") === id);
    const context = renderer ? rt.filter(t => !t.closing && t.name.startsWith("xform:") && t.start < renderer.start &&
      findMatchingCloseTag(runtime, t.end, t.name) > renderer.end) : [];
    const rightModes = Object.fromEntries(context.filter(t => t.name === "xform:right").flatMap(t =>
      [...(parseStaticMarkupAttributes(t.attrs) || [])].filter(([k]) => k.startsWith("mode_"))));
    const nodeModes = Object.fromEntries(Object.entries(form.nodeDataAuthorities || {}).filter(([, a]) => a.fields?.[id])
      .map(([nodeId, a]) => [nodeId, a.fields[id].mode]));
    if (Object.entries(rightModes).some(([k, mode]) => /^mode_n\d+$/i.test(k) && nodeModes[k.slice(5).toUpperCase()] !== mode) ||
        context.filter(t => t.name === "xform:right").length > 1) reasons.push("right_mode_conflict");
    if (rt.some(t => !t.closing && /\b(?:property|name|propertyid|propertyname)\s*=/i.test(t.attrs) &&
        t.attrs.includes(id) && !parseStaticMarkupAttributes(t.attrs))) reasons.push("unparsed_binding");
    const runtimeBindings = scriptDomain.events.bindings.filter(b => b.surface === "fdDisplayJsp");
    if (runtimeBindings.filter(b => b.values.some(value => binding(value) === id || value === id)).length !== renderers.length ||
        runtimeBindings.some(b => b.values.some(value => dynamic(value) && !knownDetailBinding(value, form) ||
          value.includes(id) && !binding(value) && value !== id && !knownDetailBinding(value, form)))) reasons.push("dynamic_or_unknown_binding");
    if (!identifier.test(id) || field.source?.designerRadioLayoutLiteral !== true || !values || !parseDesignerControlAttributes(widget?.attrs || "") ||
        !Array.isArray(options) || !options.length || !equal(parseOptions(values?.items, /\r\n|\r|\n/), options) ||
        !ma || meta.name !== "extendsimpleproperty" || ma.get("type") !== "String" || !equal(parseOptions(ma.get("enumvalues"), /;/), options) ||
        meta && mt.some(t => !t.closing && t.name === "extendsubtableproperty" && t.start < meta.start && findMatchingCloseTag(template.fdMetadataXml, t.end, t.name) > meta.end)) reasons.push("static_option_domain_unproved");
    if (!attrs || renderer.name !== "xform:radio" || end < 0 || !equal(rendererOptions, options) ||
        [...attrs].some(([k, v]) => !["property", "alignment", "required", "readonly", "subject", "title", "onvaluechange"].includes(k) || dynamic(v)) ||
        attrs.has("onvaluechange") && attrs.get("onvaluechange") !== "__xformDispatch" ||
        ["name", "propertyid", "propertyname"].some(k => attrs?.has(k)) || context.some(t => t.name !== "xform:right")) reasons.push("radio_renderer_unproved");
    if (inputs.length !== options?.length || allInputs.length !== inputs.length || inputs.some((a, i) => !a || a.get("id") !== id || a.get("type")?.toLowerCase() !== "radio" || a.get("value") !== options[i].value ||
        [...a].some(([k, v]) => !["id", "type", "value", "attach", "label", "tablename", "_required", "required", "itemvalues", "items", "alignment", "defaultvalue", "checked"].includes(k) || dynamic(v)) ||
        ["name", "property"].some(k => a.has(k) && a.get(k) !== id && binding(a.get(k)) !== id))) reasons.push("designer_group_unproved");
    if (!scriptDomain.closed) reasons.push("options_effect_domain_unclosed");
    const emptyDefault = values?.defaultValue === "" && [undefined, ""].includes(values.formula) && [undefined, "false"].includes(values.reCalculate) &&
      ma && [undefined, ""].includes(ma.get("defaultvalue")) && ![...ma.keys()].some(k => /default|formula|checked|calculate/.test(k) && k !== "defaultvalue") &&
      inputs.length > 0 && inputs.every(a => a && !a.has("checked") && [undefined, ""].includes(a.get("defaultvalue")));
    if (!emptyDefault) reasons.push("empty_unchecked_default_unproved");
    const fact = { version: 1, kind: "static-main-radio-group", profile: "empty-unchecked-v1", status: reasons.length ? "unproven" : "verified", fieldId: id,
      sourceOrigin: { fdId: template.fdId || "", fdModelId: template.fdModelId || "", edition: template.fdTemplateEdition || "" }, sourceHashes,
      options, declarations: { designer: widget?.start ?? null, renderer: renderer?.start ?? null, metadata: meta?.start ?? null },
      defaults: { designer: values?.defaultValue ?? null, metadata: ma?.get("defaultvalue") ?? null,
        inputs: inputs.map(a => ({ checked: a?.has("checked") || false, defaultValue: a?.get("defaultvalue") ?? null })) },
      readOnly: values?.readOnly === "true" || ma?.get("readonly") === "true" || attrs?.get("readonly") === "true",
      rightModes, nodeModes, scriptDomain, reasons };
    result[id] = { ...fact, digest: sha256Digest(fact) };
  }
  return result;
}

function parseOptions(text, separator) {
  if (typeof text !== "string") return undefined;
  const result = text.split(separator).filter(s => s.trim()).map(s => {
    const parts = s.split("|");
    return parts.length === 2 ? { label: cleanText(parts[0]), value: parts[1].trim() } : null;
  });
  return result.length && result.every(o => o?.label && o.value) && new Set(result.map(o => o.value)).size === result.length ? result : undefined;
}

function staticRadioOptions(body) {
  const options = [];
  const remainder = body.replace(/<xform:simpleDataSource\b([^>]*)>([^<]*)<\/xform:simpleDataSource\s*>/gi, (_all, attrs, label) => {
    const a = parseStaticMarkupAttributes(attrs);
    options.push(a?.size === 1 && a.has("value") && !dynamic(a.get("value") + label) ? { label: cleanText(label), value: a.get("value") } : null);
    return "";
  });
  return !remainder.trim() && options.length && options.every(Boolean) ? options : undefined;
}

function knownDetailBinding(value, form) {
  const match = /^extendDataFormInfo\.value\(([A-Za-z_][\w]*)\.\$\{vstatus\.index\}\.([A-Za-z_][\w]*)\)$/.exec(value);
  return Boolean(match && (form.fields || []).some(table => table.type === "detailTable" && table.id === match[1] &&
    (match[2] === "fdId" || table.columns?.some(column => column.id === match[2]))));
}

function scriptInventory(template, scripts, form) {
  const normalize = text => String(text).replace(/\r\n?|\n/g, "\n").trim();
  const authored = (scripts.sources || []).map(s => normalize(s.javascript));
  const detailIds = (form.fields || []).filter(f => f.type === "detailTable").map(f => f.id);
  const sourceFields = [...(form.fields || []), ...(form.dataFields || [])].flatMap(f => [f, ...(f.columns || [])]);
  const scalarIds = new Set(sourceFields.filter(f => !["radio", "detailTable"].includes(f.type) && sourceFields.filter(other => other.id === f.id).length === 1).map(f => f.id));
  const { scriptBodies, ...events } = inlineEventInventory(template, detailIds);
  const inventory = scriptBodies.map(s => ({ ...s, code: normalize(s.code) }));
  const closed = events.closed && authored.every(code => closedFieldEffects(code, scalarIds)) && inventory.every(({ code, attrs }) => attrs &&
    [...attrs].every(([k, v]) => k === "type" && v === "text/javascript" || k === "language" && v.toLowerCase() === "javascript") &&
    (authored.includes(code) || detailScaffold(code, detailIds)));
  return { closed, authoredHashes: authored.map(hash), inlineHashes: inventory.map(({ surface, code }) => ({ surface, sha256: hash(code) })), events };
}

// The new gate consumes every HTML tag itself. HTML quotes are not JavaScript
// strings: a backslash never escapes the closing attribute quote.
function profileHtmlTokens(raw) {
  const tokens = [], voids = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const fail = offset => ({ complete: false, offset, tokens });
  let cursor = 0;
  while (cursor < raw.length) {
    const start = raw.indexOf("<", cursor);
    if (start < 0) break;
    if (raw.startsWith("<!--", start)) {
      const end = raw.indexOf("-->", start + 4);
      if (end < 0) return fail(start);
      const body = raw.slice(start + 4, end);
      // Admit canonical comments only. HTML error recovery can close an
      // end-bang/abrupt comment before this ordinary terminator.
      if (/^(?:>|->)/.test(body) || body.includes("--!>") || body.includes("<!--") || body.endsWith("<!-")) return fail(start);
      cursor = end + 3; continue;
    }
    if (raw.startsWith("<%@", start)) {
      const end = raw.indexOf("%>", start + 3);
      if (end < 0 || staticSourceMarkup(raw.slice(start, end + 2)) === undefined) return fail(start);
      cursor = end + 2; continue;
    }
    const match = /^<(\/?)([A-Za-z][\w:-]*)\b/.exec(raw.slice(start));
    if (!match) return fail(start);
    const name = match[2].toLowerCase(), closing = Boolean(match[1]), attrs = new Map();
    let offset = start + match[0].length, selfClosing = false, ended = false;
    const attrStart = offset;
    while (offset < raw.length) {
      offset += /^\s*/.exec(raw.slice(offset))[0].length;
      if (raw[offset] === ">") { offset++; ended = true; break; }
      if (raw.startsWith("/>", offset)) { offset += 2; ended = true; selfClosing = true; break; }
      if (closing) return fail(offset);
      if (raw[offset] === "?" && /^(?:\s|>)/.test(raw.slice(offset + 1))) { offset++; continue; }
      const keyMatch = /^[A-Za-z_:][\w:.-]*/.exec(raw.slice(offset));
      if (!keyMatch) return fail(offset);
      const key = keyMatch[0].toLowerCase(); offset += keyMatch[0].length;
      const afterName = offset, separator = /^\s*/.exec(raw.slice(offset))[0].length;
      if (raw[offset + separator] === "=") offset += separator;
      let value = "";
      if (raw[offset] === "=") {
        offset++; offset += /^\s*/.exec(raw.slice(offset))[0].length;
        const quote = raw[offset];
        if (quote === '"' || quote === "'") {
          const begin = ++offset;
          if (raw.startsWith("<c:url", begin)) {
            // This is a static JSP URL atom, before server-side HTML emission.
            const atom = /^<c:url\s+value=(["'])([^<>"']*)\1\s*\/>/.exec(raw.slice(begin));
            if (!atom || raw[begin + atom[0].length] !== quote) return fail(begin);
            offset = begin + atom[0].length;
          } else {
            offset = raw.indexOf(quote, begin);
            if (offset < 0) return fail(begin);
          }
          value = raw.slice(begin, offset++);
        } else {
          const unquoted = /^[^\s"'`=<>]+/.exec(raw.slice(offset));
          if (!unquoted) return fail(offset);
          value = unquoted[0]; offset += value.length;
        }
      } else offset = afterName;
      value = decodeEntities(value);
      if (attrs.has(key) && (key.startsWith("on") || attrs.get(key) !== value)) return fail(offset);
      attrs.set(key, value);
      if (offset < raw.length && !/\s|>/.test(raw[offset]) && !raw.startsWith("/>", offset)) return fail(offset);
    }
    if (!ended) return fail(start);
    const token = { start, end: offset, name, closing, selfClosing, attrs, rawAttrs: raw.slice(attrStart, offset - (selfClosing ? 2 : 1)), matchEnd: -1 };
    tokens.push(token); cursor = offset;
    if (!closing && !selfClosing && ["script", "style", "textarea", "xform:textarea"].includes(name)) {
      const close = new RegExp(`<\\/\\s*${name}\\s*>`, "ig"); close.lastIndex = offset;
      const found = close.exec(raw);
      if (!found) return fail(start);
      token.body = raw.slice(offset, found.index); cursor = found.index;
    }
  }
  const stacks = new Map();
  for (const token of tokens) {
    if (token.closing) {
      const open = stacks.get(token.name)?.pop();
      if (open) open.matchEnd = token.start;
    } else if (!token.selfClosing && !voids.has(token.name)) {
      if (!stacks.has(token.name)) stacks.set(token.name, []);
      stacks.get(token.name).push(token);
    }
  }
  return { complete: true, tokens };
}

const URI_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "data", "codebase", "background", "poster", "cite", "xlink:href", "longdesc"]);
const ACTIVE_HTML = new Set(["iframe", "frame", "frameset", "object", "embed", "applet", "svg", "math", "base", "meta", "link", "style"]);

function passiveUri(value) {
  const atom = /^<c:url\s+value=(["'])([^<>"']*)\1\s*\/>$/.exec(value);
  if (atom) value = decodeEntities(atom[2]);
  for (let depth = 0; depth < 3; depth++) {
    const decoded = decodeEntities(value);
    if (decoded === value) break;
    value = decoded;
  }
  // Unknown entities and controls are unresolved URL syntax, not passive data.
  if (decodeEntities(value) !== value || /[\u0000-\u0020\u007f]/.test(value) || /&(?:#|[A-Za-z][A-Za-z0-9]*;)/.test(value) || /\$\{|#\{|<%/.test(value)) return false;
  let url;
  try { url = new URL(value, "https://source-profile.invalid/"); } catch { return false; }
  if (["http:", "https:"].includes(url.protocol)) return true;
  if (url.protocol !== "javascript:") return false;
  let body;
  try { body = parse(value.slice(value.indexOf(":") + 1), { ecmaVersion: "latest" }).body.filter(n => n.type !== "EmptyStatement"); } catch { return false; }
  const expression = body.length === 1 && body[0].type === "ExpressionStatement" && body[0].expression;
  return expression?.type === "UnaryExpression" && expression.operator === "void" && literal(expression.argument) === 0;
}

function passiveStyle(style) {
  return style.split(";").filter(s => s.trim()).every(declaration => {
    const match = /^\s*([A-Za-z-]+)\s*:\s*([\s\S]*?)\s*$/.exec(declaration);
    if (!match) return false;
    let valid = true;
    const value = match[2].replace(/url\(\s*(?:(["'])([^"']*)\1|([^()\s"']+))\s*\)/gi, (_all, _quote, quoted, plain) => {
      if (!["background", "background-image"].includes(match[1].toLowerCase()) || !passiveUri(quoted ?? plain)) valid = false;
      return "profile-static-image";
    });
    return valid && /^[\p{L}\p{N}_#%.,+\-\s]+(?:!important)?$/iu.test(value);
  });
}

function passiveHtmlCarrier(tag, attrs, selfClosing) {
  if (ACTIVE_HTML.has(tag) || tag === "script" && selfClosing || ["srcdoc", "srcset", "ping", "dynsrc", "lowsrc", "manifest"].some(k => attrs.has(k))) return false;
  for (const [name, value] of attrs) {
    if (URI_ATTRIBUTES.has(name) && !passiveUri(value)) return false;
    if (name === "style" && !passiveStyle(value)) return false;
  }
  return true;
}

function inlineEventInventory(template, detailIds) {
  const entries = [], unparsed = [], bindings = [], scriptBodies = [], carriers = []; let closed = true;
  for (const surface of ["fdDesignerHtml", "fdDisplayJsp"]) {
    const raw = String(template[surface] || "").replace(/<%--[\s\S]*?--%>/g, text => text.replace(/[^\r\n]/g, " "));
    const scanned = profileHtmlTokens(raw), tokens = scanned.tokens, containers = [];
    if (!scanned.complete) { closed = false; unparsed.push({ surface, offset: scanned.offset, tag: "unconsumed-html", sha256: hash(raw.slice(scanned.offset)) }); }
    for (const token of tokens) {
      if (token.closing) continue;
      const attrs = token.attrs;
      if (!passiveHtmlCarrier(token.name, attrs, token.selfClosing)) {
        closed = false; carriers.push({ surface, offset: token.start, tag: token.name, sha256: hash(token.rawAttrs), safe: false });
      }
      if (token.name.startsWith("xform:") || ["input", "select", "textarea"].includes(token.name)) {
        const values = ["property", "name", "propertyid", "propertyname"].filter(key => attrs.has(key)).map(key => attrs.get(key));
        if (values.length) bindings.push({ surface, offset: token.start, tag: token.name, values });
      }
      const end = token.matchEnd;
      const ancestors = containers.filter(c => c.start < token.start && c.end > token.end);
      const context = { designerJsp: surface === "fdDesignerHtml" && ancestors.some(c => c.kind === "jsp"),
        designerRight: surface === "fdDesignerHtml" && ancestors.some(c => c.kind === "right"),
        runtimeDetail: surface === "fdDisplayJsp" && ancestors.some(c => c.kind === "detail") };
      const kind = attrs.get("fd_type")?.toLowerCase();
      if (["jsp", "right"].includes(kind)) { if (end < 0) closed = false; else containers.push({ start: token.start, end, kind }); }
      if (token.name === "table" && detailIds.some(id => attrs.get("id") === "TABLE_DL_" + id)) { if (end < 0) closed = false; else containers.push({ start: token.start, end, kind: "detail" }); }
      for (const [name, code] of attrs) if (name.startsWith("on")) {
        const safe = safeInlineEvent(token.name, name, code, context);
        entries.push({ surface, offset: token.start, name, sha256: hash(code), safe });
        if (!safe) closed = false;
      }
      if (token.name === "script" && token.body !== undefined) scriptBodies.push({ surface, code: token.body, attrs });
    }
  }
  return { closed, entries, unparsed, bindings, scriptBodies, carriers };
}

function safeInlineEvent(tag, name, code, context) {
  let body;
  try { body = parse(code, { ecmaVersion: "latest", allowReturnOutsideFunction: true }).body.filter(n => n.type !== "EmptyStatement"); } catch { return false; }
  if (!body.length || body.length === 1 && body[0].type === "ReturnStatement" && literal(body[0].argument) === false) return true;
  if (name === "onvaluechange" && tag.startsWith("xform:") && body.length === 1 && body[0].expression?.type === "Identifier" && body[0].expression.name === "__xformDispatch") return true;
  const calls = body.map(s => s.type === "ExpressionStatement" ? s.expression : null);
  const call = (n, args) => namedCall(n, args[0]) && n.arguments.length === args.length - 1 && n.arguments.every((a, i) =>
    args[i + 1] === "this" ? a.type === "ThisExpression" : args[i + 1] === "event" ? a.type === "Identifier" && a.name === "event" : literal(a) === args[i + 1]);
  if (context.designerJsp && tag === "label" && name === "ondblclick") return calls.length === 1 && call(calls[0], ["Designer_Control_JSP_ShowEditFrame", "event", "this"]);
  if (context.designerRight) {
    if (tag === "button" && name === "onclick") return calls.length === 1 && ["Mode", "Default", "Reader"].some(kind => call(calls[0], [`Designer_Control_Right_Set${kind}CellValue`, "this"]));
    if (tag === "button" && ["ondblclick", "onmousedown"].includes(name)) return calls.length === 1 && call(calls[0], ["Designer_Control_Right_CancelBubbleFun", "event"]);
    if (tag === "span" && name === "ondblclick") return calls.length === 2 && call(calls[0], ["Designer_Control_Right_CancelBubbleFun", "event"]) && call(calls[1], ["Designer_Control_Right_ShowLabelEditor", "this"]);
  }
  if (context.runtimeDetail && tag === "img" && name === "onclick") {
    if (calls.length === 2) return ["DocList_AddRow", "DocList_DeleteRow_ClearLast"].some(fn => call(calls[0], [fn])) && call(calls[1], ["XFom_RestValidationElements"]);
    return calls.length === 1 && namedCall(calls[0], "DocList_MoveRow") && calls[0].arguments.length === 1 &&
      (literal(calls[0].arguments[0]) === 1 || calls[0].arguments[0]?.type === "UnaryExpression" && calls[0].arguments[0].operator === "-" && literal(calls[0].arguments[0].argument) === 1);
  }
  return false;
}

/** The exporter emits these fixed, detail-only scaffolds outside authored JSPs. */
function detailScaffold(code, ids) {
  const astShape = text => {
    const project = value => Array.isArray(value) ? value.map(project) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).filter(([k]) => !["start", "end", "raw"].includes(k)).map(([k, v]) => [k, project(v)])) : value;
    try { return canonicalJson(project(parse(text, { ecmaVersion: "latest" }))); } catch { return null; }
  };
  const shape = astShape(code);
  if (!shape) return false;
  if (shape === astShape("Com_IncludeFile('doclist.js');")) return ids.length > 0;
  return ids.some(id => {
    const table = "TABLE_DL_" + id;
    return [
      `DocList_Info.push('${table}');`,
      `Com_AddEventListener(window, 'load', function(){ setTimeout(function() {for (var i = 0; i < 1; i ++) {DocList_AddRow(document.getElementById('${table}'))};}, 500);});`,
      `$(function(){var tb=document.getElementById('${table}');var totalWidth=0;var tds=$(tb).find("tr[type='titleRow']").children();var hasPercent=false;tds.each(function(){if(!this.width||this.width+''.indexOf('%')>=0){totalWidth+=$(this).width();hasPercent=true;}else{totalWidth+=parseInt(this.width);}});var tdWidth=$(tb).parents('td').width();if(!hasPercent&&totalWidth>tdWidth)$(tb).css('width',totalWidth+'px');var tb_div=document.getElementById('${table}_div');$(tb_div).css('width','100%');});`
    ].some(expected => shape === astShape(expected));
  });
}

/** Closed authored grammar: value/row-state effects cannot modify a radio option domain. */
function closedFieldEffects(code, scalarIds) {
  let ast;
  try { ast = parse(code, { ecmaVersion: "latest" }); } catch { return false; }
  const forbidden = new Set(["window", "document", "globalThis", "self", "eval", "Function", "GetXFormFieldById", "AttachXFormValueChangeEventById", "Com_AddEventListener", "common_dom_row_set_show_required_reset"]);
  const callback = fn => {
    if (fn?.type !== "FunctionExpression" || fn.id || fn.async || fn.generator || fn.params.some(p => p.type !== "Identifier" || forbidden.has(p.name))) return false;
    const locals = new Set(fn.params.map(p => p.name)), aliases = new Map();
    const expression = node => node && (node.type === "Literal" && !node.regex || node.type === "Identifier" && locals.has(node.name) ||
      member(node, "value") && aliases.has(node.object.name) || node.type === "UnaryExpression" && ["!", "+", "-"].includes(node.operator) && expression(node.argument) ||
      ["BinaryExpression", "LogicalExpression"].includes(node.type) && expression(node.left) && expression(node.right) ||
      node.type === "CallExpression" && member(node.callee, "indexOf") && expression(node.callee.object) && node.arguments.length === 1 && typeof literal(node.arguments[0]) === "string");
    const block = statements => statements.every(statement => {
      if (statement.type === "EmptyStatement") return true;
      if (statement.type === "BlockStatement") return block(statement.body);
      if (statement.type === "IfStatement") return expression(statement.test) && block(statement.consequent.type === "BlockStatement" ? statement.consequent.body : [statement.consequent]) &&
        (!statement.alternate || block(statement.alternate.type === "BlockStatement" ? statement.alternate.body : [statement.alternate]));
      if (statement.type === "VariableDeclaration") return statement.declarations.every(d => {
        if (d.id.type !== "Identifier" || locals.has(d.id.name) || forbidden.has(d.id.name)) return false;
        const init = d.init;
        if (init?.type !== "MemberExpression" || !init.computed || literal(init.property) !== 0 || !namedCall(init.object, "GetXFormFieldById") ||
            init.object.arguments.length !== 1 || typeof literal(init.object.arguments[0]) !== "string" || !identifier.test(literal(init.object.arguments[0]))) return false;
        locals.add(d.id.name); aliases.set(d.id.name, literal(init.object.arguments[0])); return true;
      });
      const e = statement.type === "ExpressionStatement" && statement.expression;
      if (e?.type === "AssignmentExpression") return e.operator === "=" && member(e.left, "value") && scalarIds.has(aliases.get(e.left.object.name)) && e.right.type === "Literal" && !e.right.regex;
      return namedCall(e, "common_dom_row_set_show_required_reset") && e.arguments.length === 4 && typeof literal(e.arguments[0]) === "string" && e.arguments.slice(1).every(a => typeof literal(a) === "boolean");
    });
    return block(fn.body.body);
  };
  return ast.body.every(s => {
    if (s.type === "EmptyStatement") return true;
    const c = s.type === "ExpressionStatement" && s.expression;
    return namedCall(c, "AttachXFormValueChangeEventById") && c.arguments.length === 2 && typeof literal(c.arguments[0]) === "string" && identifier.test(literal(c.arguments[0])) && callback(c.arguments[1]) ||
      namedCall(c, "Com_AddEventListener") && c.arguments.length === 3 && c.arguments[0]?.type === "Identifier" && c.arguments[0].name === "window" && literal(c.arguments[1]) === "load" && callback(c.arguments[2]);
  });
}

function verifiedFact(field) {
  const fact = field?.sourceProps?.radioReadOnlySourceFact;
  if (!fact) return false;
  const { digest: seal, ...original } = fact;
  return fact.version === 1 && fact.kind === "static-main-radio-group" && fact.profile === "empty-unchecked-v1" && fact.status === "verified" && seal === sha256Digest(original) &&
    fact.fieldId === (field.sourceProps?.originalId || field.id) && equal(fact.options, field.options || field.props?.options) && fact.scriptDomain?.closed === true && fact.reasons?.length === 0;
}

export function buildRadioReadOnlyPresentationDecision(sourceDraft, sourceRefs) {
  requireProof(Array.isArray(sourceRefs) && sourceRefs.length > 0, "Explicit source radio references are required.");
  const fields = sourceRefs.map(ref => {
    const matches = (sourceDraft.form?.controls || []).filter(f => f.sourceRef === ref);
    requireProof(matches.length === 1 && verifiedFact(matches[0]), "One verified current main radio source group is required.");
    const fact = matches[0].sourceProps.radioReadOnlySourceFact;
    requireProof(fact.readOnly || Object.entries(fact.nodeModes || {}).some(([id, mode]) => mode === "view" &&
      sourceDraft.workflow?.nodes?.some(n => n.id === id && n.dataAuthority?.fields?.[matches[0].id]?.visible === true && n.dataAuthority.fields[matches[0].id].editable === false)), "Source readonly access must be proved.");
    return { sourceRef: ref, sourceFactDigest: fact.digest };
  });
  const decision = { kind: RADIO_READONLY_OPTIONS_KIND, fields };
  requireProof(validateRadioReadOnlyPresentationDecisions([decision]).ok, "Invalid readonly radio decision.");
  return decision;
}

export function validateRadioReadOnlyPresentationDecisions(decisions) {
  const diagnostics = [], refs = new Set();
  if (!Array.isArray(decisions) || !decisions.length) diagnostics.push({ level: "error", code: "policy.radio_readonly_invalid", message: "Explicit readonly radio decisions are required." });
  for (const d of Array.isArray(decisions) ? decisions : []) {
    let invalid = !exact(d, ["kind", "fields"]) || d.kind !== RADIO_READONLY_OPTIONS_KIND || !Array.isArray(d.fields) || !d.fields.length;
    for (const f of Array.isArray(d?.fields) ? d.fields : []) {
      if (!exact(f, ["sourceRef", "sourceFactDigest"]) || typeof f.sourceRef !== "string" || !f.sourceRef.trim() || !digest.test(f.sourceFactDigest || "") || refs.has(f.sourceRef)) invalid = true;
      refs.add(f?.sourceRef);
    }
    if (invalid) {
      diagnostics.push({ level: "error", code: "policy.radio_readonly_invalid", message: "Unique source fields and exact current fact digests are required." });
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

export function applyRadioReadOnlyPresentationPolicies(sourceDraft, baseDraft, decisions) {
  requireProof(validateRadioReadOnlyPresentationDecisions(decisions).ok, "Invalid readonly radio decisions.");
  const draft = structuredClone(baseDraft), audits = [];
  for (const decision of decisions) {
    requireProof(equal(decision, buildRadioReadOnlyPresentationDecision(sourceDraft, decision.fields.map(f => f.sourceRef))), "The current radio source fact changed after approval.");
    for (const approved of decision.fields) {
      const matches = (draft.form.fields || []).filter(f => f.sourceRef === approved.sourceRef);
      requireProof(matches.length === 1 && matches[0].type === "radio" && matches[0].componentId === "xform-radio" && !matches[0].dataOnly && verifiedFact(matches[0]), "The approved source requires one unchanged native main radio.");
      const field = matches[0];
      requireProof(field.props.readOnlyPresentation === undefined, "Readonly presentation must be applied once to its original field.");
      field.props.readOnlyPresentation = "all-options";
    }
    audits.push({ kind: decision.kind, fields: decision.fields, workflowBefore: sha256Digest(baseDraft.workflow ?? null),
      scriptsBefore: sha256Digest(baseDraft.scripts ?? null), formRulesBefore: sha256Digest(baseDraft.formRules ?? null),
      approvedDifference: "Caller-reviewed readonly all-options presentation only; selection, defaults, permissions and source behavior remain unchanged." });
  }
  return { draft, audits, changedActionIds: [] };
}

export function radioReadOnlyPresentationDslDiagnostics(dsl) {
  const diagnostics = [], fail = () => diagnostics.push({ level: "error", code: "dsl.radio_readonly_policy_mismatch", path: "/migrationPolicies", message: "Readonly radio presentation requires its exact current source fact, field decision and unchanged workflow/scripts/rules." });
  const decisions = (Array.isArray(dsl?.migrationPolicies?.decisions) ? dsl.migrationPolicies.decisions : []).filter(d => d?.kind === RADIO_READONLY_OPTIONS_KIND);
  const approved = decisions.flatMap(d => Array.isArray(d.fields) ? d.fields : []);
  const fields = (Array.isArray(dsl?.form?.fields) ? dsl.form.fields : []).flatMap(f => [f, ...(Array.isArray(f?.columns) ? f.columns : [])]).filter(Boolean);
  for (const f of fields.filter(f => f.props?.readOnlyPresentation !== undefined)) {
    if (f.type !== "radio" || f.componentId !== "xform-radio" || f.props.readOnlyPresentation !== "all-options" || !verifiedFact(f) ||
        !(f.sourceProps.radioReadOnlySourceFact.readOnly || Object.values(f.sourceProps.radioReadOnlySourceFact.nodeModes || {}).includes("view")) ||
        approved.filter(a => a?.sourceRef === f.sourceRef && a.sourceFactDigest === f.sourceProps.radioReadOnlySourceFact.digest).length !== 1) fail();
  }
  for (const decision of decisions) {
    if (!Array.isArray(decision.fields)) { fail(); continue; }
    const audit = (Array.isArray(dsl.migrationPolicyAudit?.audits) ? dsl.migrationPolicyAudit.audits : []).filter(a => a?.kind === RADIO_READONLY_OPTIONS_KIND && equal(a.fields, decision.fields));
    if (audit.length !== 1 || audit[0].workflowBefore !== sha256Digest(dsl.workflow ?? null) || audit[0].scriptsBefore !== sha256Digest(dsl.scripts ?? null) || audit[0].formRulesBefore !== sha256Digest(dsl.formRules ?? null)) fail();
    for (const a of decision.fields) {
      const found = fields.filter(f => f.sourceRef === a?.sourceRef);
      if (found.length !== 1 || found[0].props?.readOnlyPresentation !== "all-options" || found[0].sourceProps?.radioReadOnlySourceFact?.digest !== a.sourceFactDigest) fail();
    }
  }
  return diagnostics;
}
