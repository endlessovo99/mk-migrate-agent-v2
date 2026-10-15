import { scanHtmlTags, findMatchingCloseTag, isVoidLikeTag } from "./designer-html-tokenizer.js";
import { decodeEntities } from "./xml-utils.js";
import { sanitizeCredentialMaterial } from "../credential-material.js";

// Preserve only static rendered select facts. No HTML, URLs or executable code
// is copied into SourceDraft. Ambiguous markup is not an empty-choice proof.
export function annotateRuntimeSelectEmpty(fields = [], html = "") {
  const source = String(html), blank = text => text.replace(/[^\r\n]/g, " ");
  let markup = source.replace(/<%--[\s\S]*?(?:--%>|$)|<!--[\s\S]*?(?:-->|$)/g, blank);
  const dynamic = dynamicRenderRanges(markup);
  markup = markup.replace(/<%[\s\S]*?(?:%>|$)/g, blank);
  let cursor = 0;
  while (cursor < markup.length) {
    const token = scanHtmlTags(markup, cursor).next().value;
    if (!token) break;
    cursor = token.end;
    if (token.closing || (token.selfClosing && token.name.startsWith("xform:")) ||
        !["script", "style", "textarea", "xform:textarea", "xform:text", "pre", "code"].includes(token.name)) continue;
    // HTML non-void elements remain open even when their start tag has '/'.
    // Only the explicitly self-closing JSP controls above have an empty body.
    // Raw script/style text is not HTML attribute syntax. Its quotes and '<'
    // operators cannot consume the closing tag or hide later real controls.
    const close = new RegExp(`<\\/\\s*${token.name}\\s*>`, "ig");
    close.lastIndex = token.end;
    const end = close.exec(markup) ? close.lastIndex : markup.length;
    markup = markup.slice(0, token.start) + blank(markup.slice(token.start, end)) + markup.slice(end);
    cursor = end;
  }
  const matches = new Map(), ancestors = [];
  for (const token of scanHtmlTags(markup)) {
    if (token.closing) {
      const index = ancestors.findLastIndex(entry => entry.name === token.name);
      if (index >= 0) ancestors.splice(index);
      continue;
    }
    if (token.name === "xform:select") {
      const attrs = attributes(token.attrs);
      const ids = [...token.attrs.matchAll(/\bproperty\s*=\s*(["'])extendDataFormInfo\.value\(([A-Za-z_][\w-]*)\)\1/g)].map(match => match[2]);
      const closing = token.selfClosing ? -1 : findMatchingCloseTag(markup, token.end, token.name);
      const options = closing >= 0 ? staticOptions(markup.slice(token.end, closing)) : undefined;
      for (const id of new Set(ids)) {
        const property = `extendDataFormInfo.value(${id})`;
        const supportedAttributes = new Set(["property", "id", "subject", "title", "required", "showPleaseSelect", "onValueChange"]);
        const closeToken = closing >= 0 ? scanHtmlTags(markup, closing).next().value : undefined;
        const valid = exactTagName(token) === "xform:select" && exactTagName(closeToken) === "xform:select" && !closeToken.attrs.trim() && attrs?.get("property") === property && [...attrs.keys()].every(key => supportedAttributes.has(key)) &&
          (!attrs.has("required") || ["true", "false"].includes(attrs.get("required"))) && (!attrs.has("id") || attrs.get("id") === id) &&
          attrs.get("onValueChange") === "__xformDispatch" && ["true", "false"].includes(attrs.get("showPleaseSelect")) &&
          options && !dynamic.some(range => range.start < (closing < 0 ? token.end : closing) && range.end > token.start) &&
          !ancestors.some(entry => entry.name.includes(":") && (exactTagName(entry) !== "xform:editShow" || entry.attrs.trim()));
        const fact = { version: 1, source: "fdDisplayJsp", status: valid ? "proven" : "unsupported", property, offset: token.start,
          ...(valid ? { showPleaseSelect: attrs.get("showPleaseSelect") === "true", options } : {}) };
        const entries = matches.get(id) || []; entries.push(fact); matches.set(id, entries);
      }
    }
    if (!token.selfClosing && !isVoidLikeTag(token.name)) ancestors.push(token);
  }
  return fields.map(field => {
    if (field.type !== "singleSelect" || field.dataOnly === true) return field;
    const entries = matches.get(field.id) || [];
    const fact = entries.length === 1 ? entries[0] : { version: 1, source: "fdDisplayJsp", status: entries.length ? "ambiguous" : "missing" };
    return { ...field, source: { ...field.source, runtimeSelectEmpty: fact } };
  });
}

function attributes(text) {
  const source = String(text).replace(/\/\s*$/, ""), result = new Map();
  const pattern = /\s*([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/y;
  let index = 0;
  while (source.slice(index).trim()) {
    if (index > 0 && !/\s/.test(source[index])) return undefined;
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match) return undefined;
    const key = match[1], value = decodeEntities(match[2] ?? match[3]);
    if (result.has(key) || /\$\{|<%|[<>]/.test(value)) return undefined;
    result.set(key, value); index = pattern.lastIndex;
  }
  return result;
}

function staticOptions(body) {
  const tokens = [...scanHtmlTags(body)], options = [];
  let offset = 0;
  for (let index = 0; index < tokens.length; index += 2) {
    const open = tokens[index], close = tokens[index + 1];
    if (open.closing || exactTagName(open) !== "xform:simpleDataSource" || open.selfClosing || !close?.closing || exactTagName(close) !== "xform:simpleDataSource" || close.attrs.trim() || body.slice(offset, open.start).trim()) return undefined;
    const attrs = attributes(open.attrs), rawLabel = body.slice(open.end, close.start);
    if (attrs?.size !== 1 || !attrs.has("value") || /[<>]|\$\{|<%/.test(rawLabel)) return undefined;
    options.push({ label: decodeEntities(rawLabel).trim(), value: attrs.get("value") });
    offset = close.end;
  }
  if (sanitizeCredentialMaterial({ options }).redactedPaths.length || options.some(option => [option.label, option.value].some(value => {
    try { const url = new URL(value); return Boolean(url.username || url.password); } catch { return false; }
  }))) return undefined;
  return options.length && !body.slice(offset).trim() && new Set(options.map(option => option.value)).size === options.length ? options : undefined;
}

function exactTagName(token) { return token?.raw.match(/^<\s*\/?\s*([A-Za-z][\w:-]*)/)?.[1]; }

// Only a balanced, side-effect-free request-attribute rendering guard has a
// local extent. Unknown server code continues to block all following evidence.
function dynamicRenderRanges(markup) {
  const ranges = [], stack = [];
  for (const match of markup.matchAll(/<%(?!@)([\s\S]*?)(?:%>|$)/g)) {
    const body = match[1].trim();
    if (/^if\s*\(\s*"[^"\\\r\n]*"\s*\.\s*equals\s*\(\s*request\s*\.\s*getAttribute\s*\(\s*"[^"\\\r\n]*"\s*\)\s*\)\s*\)\s*\{$/.test(body)) {
      stack.push(match.index);
    } else if (body === "}" && stack.length) {
      ranges.push({ start: stack.pop(), end: match.index + match[0].length });
    } else ranges.push({ start: match.index, end: Infinity });
  }
  for (const start of stack) ranges.push({ start, end: Infinity });
  return ranges;
}
