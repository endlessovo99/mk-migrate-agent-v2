import { scanHtmlTags } from "./designer-html-tokenizer.js";
import { decodeEntities } from "./xml-utils.js";

export function parseStaticMarkupAttributes(text = "") {
  const source = String(text).replace(/\/\s*$/, ""), result = new Map();
  const attribute = /\s*([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s"'`=<>]+)))?/y;
  let offset = 0;
  while (source.slice(offset).trim()) {
    if (offset > 0 && !/\s/.test(source[offset])) return undefined;
    attribute.lastIndex = offset;
    const match = attribute.exec(source);
    if (!match || result.has(match[1].toLowerCase())) return undefined;
    result.set(match[1].toLowerCase(), decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
    offset = attribute.lastIndex;
  }
  return result;
}

export function staticSourceMarkup(html) {
  const blank = value => value.replace(/[^\r\n]/g, " ");
  const starts = /<!--|<%--|<%/g;
  let source = html, match, conditional;
  while ((match = starts.exec(source))) {
    const marker = match[0], start = match.index;
    const close = marker === "<!--" ? "-->" : marker === "<%--" ? "--%>" : undefined;
    const end = close ? source.indexOf(close, starts.lastIndex) : scriptletEnd(source, starts.lastIndex);
    if (end < 0) return undefined;
    const finish = close ? end + close.length : end;
    if (marker === "<%") {
      const statement = html.slice(start + 2, end - 2).trim();
      if (knownDirective(statement)) {
        if (conditional) return undefined;
      } else if (/^if\s*\(\s*(["'])readOnly\1\s*\.\s*equals\s*\(\s*request\s*\.\s*getAttribute\s*\(\s*(["'])SysForm\.base\.showStatus\2\s*\)\s*\)\s*\)\s*\{$/.test(statement)) {
        if (conditional) return undefined;
        conditional = { end: finish };
      } else if (statement === "}" && conditional) {
        if (!calculationLibraryIsland(html.slice(conditional.end, start))) return undefined;
        conditional = undefined;
      } else return undefined;
    }
    source = source.slice(0, start) + blank(source.slice(start, finish)) + source.slice(finish);
    starts.lastIndex = finish;
  }
  if (conditional) return undefined;
  let skipUntil = 0;
  const ranges = [];
  for (const token of scanHtmlTags(source)) {
    if (token.start < skipUntil || token.closing || !["script", "style", "textarea", "xform:textarea", "pre", "code"].includes(token.name)) continue;
    if (token.name === "xform:textarea" && token.selfClosing) continue;
    const close = new RegExp(`<\\/\\s*${token.name}\\s*>`, "ig");
    close.lastIndex = token.end;
    if (!close.exec(source)) return undefined;
    skipUntil = close.lastIndex;
    ranges.push([token.start, skipUntil]);
  }
  for (const [start, end] of ranges.reverse()) source = source.slice(0, start) + blank(source.slice(start, end)) + source.slice(end);
  return source;
}

function knownDirective(statement) {
  const match = /^@\s*(page|include|taglib)\s+([\s\S]*)$/.exec(statement);
  if (!match) return false;
  const attrs = parseStaticMarkupAttributes(match[2]);
  if (!attrs || [...attrs.values()].some(value => /[<>{}]/.test(value))) return false;
  if (match[1] === "include") return attrs.size === 1 && attrs.get("file") === "/resource/jsp/common.jsp";
  if (match[1] === "taglib" && (attrs.get("prefix") === "xform" || !attrs.get("prefix") || !attrs.get("uri"))) return false;
  const keys = match[1] === "page" ? ["language", "contenttype", "pageencoding", "import"] : ["prefix", "uri"];
  return [...attrs.keys()].every(key => keys.includes(key));
}

function calculationLibraryIsland(html) {
  const tokens = [...scanHtmlTags(html)];
  if (tokens.length !== 2 || tokens[0].name !== "script" || tokens[0].closing || tokens[0].selfClosing ||
      tokens[1].name !== "script" || !tokens[1].closing ||
      (html.slice(0, tokens[0].start) + html.slice(tokens[1].end)).trim()) return false;
  const attrs = parseStaticMarkupAttributes(tokens[0].attrs);
  if (!attrs || [...attrs].some(([key, value]) => !(
    key === "type" && value.toLowerCase() === "text/javascript" ||
    key === "language" && value.toLowerCase() === "javascript"
  ))) return false;
  // This is the same legacy calculation-library declaration recognized by the DSL mapper.
  return /^\s*Com_IncludeFile\(\s*(["'])calculation_script\.js\1\s*,\s*(["'])\.\.\/sys\/xform\/designer\/calculation\/\2\s*\)\s*;?\s*$/.test(
    html.slice(tokens[0].end, tokens[1].start)
  );
}
function scriptletEnd(source, offset) {
  let quote, comment;
  for (let index = offset; index < source.length; index++) {
    const c = source[index], next = source[index + 1];
    if (comment === "line") { if (c === "\n") comment = undefined; continue; }
    if (comment === "block") { if (c === "*" && next === "/") { comment = undefined; index++; } continue; }
    if (quote) { if (c === "\\") index++; else if (c === quote) quote = undefined; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "/" && next === "/") { comment = "line"; index++; continue; }
    if (c === "/" && next === "*") { comment = "block"; index++; continue; }
    if (c === "%" && next === ">") return index + 2;
  }
  return -1;
}
