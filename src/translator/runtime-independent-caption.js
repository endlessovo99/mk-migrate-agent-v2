import { scanHtmlTags, findMatchingCloseTag, isVoidLikeTag } from "./designer-html-tokenizer.js";
import { parseDesignerFdValues } from "./designer-control-values.js";
import { attrValue, cleanText, decodeEntities } from "./xml-utils.js";

// Recover presentation only. A broken Designer binding remains broken evidence;
// a unique runtime table/cell pair can still prove a separate visible caption.
export function runtimeIndependentCaptionEvidence(designerHtml = "", displayHtml = "") {
  const declaredIds = new Set();
  const designer = maskOpaqueMarkup(designerHtml, declaredIds), runtime = maskOpaqueMarkup(displayHtml);
  const result = new Map();
  if (designer === undefined || runtime === undefined) return result;
  const designerTokens = [...scanHtmlTags(designer)];
  const runtimeTokens = [...scanHtmlTags(runtime)];
  const fieldCounts = new Map();
  for (const token of runtimeTokens.filter(token => !token.closing)) {
    const id = fieldId(token);
    if (id) fieldCounts.set(id, (fieldCounts.get(id) || 0) + 1);
  }
  for (const table of designerTokens.filter(token => !token.closing && token.name === "table" &&
    attrValue(token.attrs, "fd_type").toLowerCase() === "standardtable")) {
    const tableId = attrValue(table.attrs, "id");
    if (!tableId || designerTokens.filter(token => !token.closing && token.name === "table" && attrValue(token.attrs, "id") === tableId).length !== 1) continue;
    const matches = runtimeTokens.filter(token => !token.closing && token.name === "table" && attrValue(token.attrs, "id") === tableId);
    if (matches.length !== 1 || !containerAppearance(table.attrs) || !containerAppearance(matches[0].attrs) ||
      guardedAt(designer, table.start) || guardedAt(runtime, matches[0].start)) continue;
    const sourceRows = directElements(bodyOf(designer, table), "tr");
    const runtimeRows = directElements(bodyOf(runtime, matches[0]), "tr");
    for (const row of sourceRows) {
      const cells = directElements(row.body, "td");
      if (cells.length !== 2 || !titleCell(cells[0]) || titleCell(cells[1])) continue;
      const geometry = cellGeometry(cells);
      if (!geometry || sourceRows.filter(row => JSON.stringify(cellGeometry(directElements(row.body, "td"))) === JSON.stringify(geometry)).length !== 1) continue;
      const runtimeMatches = runtimeRows.map(row => directElements(row.body, "td"))
        .filter(cells => JSON.stringify(cellGeometry(cells)) === JSON.stringify(geometry));
      if (runtimeMatches.length !== 1) continue;
      const runtimeCells = runtimeMatches[0];
      if (!titleCell(runtimeCells[0]) || titleCell(runtimeCells[1])) continue;
      const sourceCaption = caption(cells[0].body, true), runtimeCaption = caption(runtimeCells[0].body, false);
      if (!sourceCaption || !runtimeCaption || sourceCaption.text !== runtimeCaption.text ||
        designerTokens.filter(token => !token.closing && parseDesignerFdValues(token.attrs).id === sourceCaption.id).length !== 1) continue;
      const control = sourceValue(cells[1].body);
      if (!control || declaredIds.has(control.binding) || fieldCounts.get(control.id) !== 1 ||
        designerTokens.filter(token => !token.closing && parseDesignerFdValues(token.attrs).id === control.id).length !== 1) continue;
      const rendered = runtimeValue(runtimeCells[1].body, control.id);
      if (!rendered || rendered.width !== control.width || sourceCaption.id === control.id) continue;
      if (result.has(control.id)) { result.set(control.id, undefined); continue; }
      result.set(control.id, {
        captionId: sourceCaption.id, content: sourceCaption.text, tableId,
        row: geometry.row, captionColumn: geometry.captionColumn, valueColumn: geometry.valueColumn,
        sourceBindingId: control.binding, renderer: "xform:xtext", sourceRef: "source.form.fdDisplayJsp"
      });
    }
  }
  return new Map([...result].filter(([, value]) => value));
}

function sourceValue(html) {
  const typed = [...scanHtmlTags(html)].filter(token => !token.closing && attrValue(token.attrs, "fd_type"));
  if (typed.length !== 1 || attrValue(typed[0].attrs, "fd_type").toLowerCase() !== "inputtext") return undefined;
  const token = typed[0], values = parseDesignerFdValues(token.attrs), binding = String(values._label_bind_id || "");
  const width = pixelWidth(token.attrs);
  if (!values.id || !binding || values.canShow === "false" || ![true, "true"].includes(values._label_bind) ||
    !width || Number(values.width) !== width || !valueAppearance(token.attrs) ||
    guardedAt(html, token.start) || hidden(token.attrs)) return undefined;
  const end = elementEnd(html, token);
  if (end === undefined || cleanText(html.slice(0, token.start) + html.slice(end))) return undefined;
  const inner = html.slice(token.end, end), inputs = [...scanHtmlTags(inner)].filter(token => !token.closing && token.name === "input");
  if (inputs.length !== 1 || [...scanHtmlTags(inner)].some(token => !token.closing && token.name !== "input") ||
    cleanText(inner) || pixelWidth(inputs[0].attrs) !== width || !valueAppearance(inputs[0].attrs)) return undefined;
  const input = inputs[0];
  const identityKeys = [...input.attrs.matchAll(/(?:^|\s)(id|name|property)\s*=/ig)].map(match => match[1].toLowerCase());
  if (new Set(identityKeys).size !== identityKeys.length) return undefined;
  const inputId = attrValue(input.attrs, "id"), property = attrValue(input.attrs, "property"), name = attrValue(input.attrs, "name");
  const expectedProperty = `extendDataFormInfo.value(${values.id})`;
  if ((inputId && inputId !== values.id) || (property && property !== expectedProperty) ||
    (name && ![values.id, expectedProperty].includes(name))) return undefined;
  return { id: values.id, binding, width };
}

function runtimeValue(html, id) {
  const tokens = [...scanHtmlTags(html)], editors = tokens.filter(token => !token.closing && token.name === "xform:xtext");
  if (editors.length !== 1 || fieldId(editors[0]) !== id || !editors[0].selfClosing ||
    attrValue(editors[0].attrs, "showLabel").toLowerCase() === "true" || hidden(editors[0].attrs) || !valueAppearance(editors[0].attrs) ||
    guardedAt(html, editors[0].start) || cleanText(html)) return undefined;
  if (tokens.some(token => !["div", "xform:xtext", "xform:editshow", "xform:viewshow"].includes(token.name))) return undefined;
  const width = pixelWidth(editors[0].attrs);
  if (!width || tokens.some(token => !token.closing && token.name === "div" &&
    (hidden(token.attrs) || !valueAppearance(token.attrs) || (hasWidth(token.attrs) && pixelWidth(token.attrs) !== width)))) return undefined;
  return { width };
}

function caption(html, designer) {
  const tokens = [...scanHtmlTags(html)];
  if (tokens.length !== 2 || tokens[0].name !== "label" || tokens[0].closing ||
    tokens[1].name !== "label" || !tokens[1].closing || hidden(tokens[0].attrs) || !captionAppearance(tokens[0].attrs) ||
    cleanText(html.slice(0, tokens[0].start) + html.slice(tokens[1].end))) return undefined;
  const raw = html.slice(tokens[0].end, tokens[1].start), text = cleanText(raw);
  if (!text || /<|>/.test(decodeEntities(raw)) || attrValue(tokens[0].attrs, "class") || /(?:^|\s)on\w+\s*=/i.test(tokens[0].attrs)) return undefined;
  if (!designer) return { text };
  const values = parseDesignerFdValues(tokens[0].attrs);
  return attrValue(tokens[0].attrs, "fd_type").toLowerCase() === "textlabel" && /^[A-Za-z_][\w-]*$/.test(values.id || "") && values.canShow !== "false" &&
    cleanText(values.content) === text ? { id: values.id, text } : undefined;
}

function cellGeometry(cells) {
  if (cells.length !== 2) return undefined;
  const row = attrValue(cells[0].attrs, "row"), otherRow = attrValue(cells[1].attrs, "row");
  const left = columns(attrValue(cells[0].attrs, "column")), right = columns(attrValue(cells[1].attrs, "column"));
  if (!/^\d+$/.test(row) || row !== otherRow || !left || !right || left.length !== 1 ||
    left[0] + 1 !== right[0] || cells.some(cell => hidden(cell.attrs) || !containerAppearance(cell.attrs)) ||
    cells.some(cell => !["", "1"].includes(attrValue(cell.attrs, "rowspan")))) return undefined;
  if (cells.some((cell, i) => attrValue(cell.attrs, "colspan") && Number(attrValue(cell.attrs, "colspan")) !== [left, right][i].length)) return undefined;
  return { row, captionColumn: left[0], valueColumn: right[0], valueColspan: right.length };
}
function columns(value) {
  if (!/^\d+(?:,\d+)*$/.test(value)) return undefined;
  const values = value.split(",").map(Number);
  return values.every((value, i) => i === 0 || value === values[i - 1] + 1) ? values : undefined;
}
function titleCell(cell) { return attrValue(cell.attrs, "class").split(/\s+/).includes("td_normal_title"); }
function fieldId(token) { return attrValue(token.attrs, "property").match(/^extendDataFormInfo\.value\(([A-Za-z_][\w-]*)\)$/)?.[1]; }
function hasWidth(attrs) { return /(?:^|;)\s*width\s*:/i.test(attrValue(attrs, "style")) || Boolean(attrValue(attrs, "width")); }
function pixelWidth(attrs) {
  const style = attrValue(attrs, "style");
  if (/\/\*|\\|[{}<>]/.test(style)) return undefined;
  const declarations = style.split(";").filter(item => /^\s*width\s*:/i.test(item));
  const match = declarations.length === 1 && declarations[0].match(/^\s*width\s*:\s*(\d+(?:\.\d+)?)px\s*$/i);
  return match && Number(match[1]) > 0 ? Number(match[1]) : undefined;
}
function hidden(attrs) {
  return /[$\\{}<>]|(?:expression|var)\s*\(/i.test(attrValue(attrs, "style")) ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:;|$))/i.test(attrValue(attrs, "style")) ||
    /(?:^|\s)hidden(?:\s|=|$)/i.test(attrs) || ["false", "noshow"].includes(attrValue(attrs, "canShow").toLowerCase()) ||
    attrValue(attrs, "showStatus").toLowerCase() === "noshow";
}
function guardedAt(html, offset) {
  const stack = [];
  for (const token of scanHtmlTags(html)) {
    if (token.start >= offset) break;
    if (token.closing) { const i = stack.findLastIndex(item => item.name === token.name); if (i >= 0) stack.splice(i); }
    else if (!token.selfClosing && !isVoidLikeTag(token.name)) stack.push(token);
  }
  return stack.some(token => hidden(token.attrs) || !containerAppearance(token.attrs) ||
    /^(?:c:|xform:(?:editshow|viewshow|right)$)/.test(token.name));
}
function bodyOf(html, token) {
  const end = findMatchingCloseTag(html, token.end, token.name);
  return end >= token.end ? html.slice(token.end, end) : "";
}
function elementEnd(html, token) {
  if (token.selfClosing || isVoidLikeTag(token.name)) return token.end;
  const close = findMatchingCloseTag(html, token.end, token.name);
  const closing = close >= token.end ? scanHtmlTags(html, close).next().value : undefined;
  return closing?.end;
}
function directElements(html, name) {
  const items = []; let nestedTable = 0;
  for (const token of scanHtmlTags(html)) {
    if (token.name === "table") { nestedTable += token.closing ? -1 : 1; continue; }
    if (nestedTable || token.name !== name || token.closing || hidden(token.attrs) ||
      !containerAppearance(token.attrs) || guardedAt(html, token.start)) continue;
    const body = bodyOf(html, token); if (body) items.push({ attrs: token.attrs, body });
  }
  return items;
}
function maskOpaqueMarkup(input, openingIds) {
  const html = String(input), chars = html.split("");
  const blank = (start, end) => { for (let i = start; i < end; i += 1) if (!/[\r\n]/.test(chars[i])) chars[i] = " "; };
  for (let i = 0; i < html.length;) {
    if (html.startsWith("<!--", i) || html.startsWith("<%", i)) {
      // Executable JSP can alter surrounding structure; comments/directives do not
      // establish markup. Do not erase a conditional into an unconditional proof.
      if (html.startsWith("<%", i) && !html.startsWith("<%--", i) && !html.startsWith("<%@", i)) return undefined;
      const marker = html.startsWith("<!--", i) ? "-->" : html.startsWith("<%--", i) ? "--%>" : "%>";
      const close = html.indexOf(marker, i + 2); if (close < 0) return undefined;
      blank(i, close + marker.length); i = close + marker.length; continue;
    }
    if (html[i] !== "<") { i += 1; continue; }
    const token = scanHtmlTags(html, i).next().value;
    if (!token || token.start !== i) { i += 1; continue; }
    if (!token.closing && openingIds) {
      const values = parseDesignerFdValues(token.attrs);
      for (const id of [values.id, attrValue(token.attrs, "id")]) if (id) openingIds.add(id);
    }
    const opaque = !token.closing && (["script", "style", "textarea", "code", "pre"].includes(token.name) ||
      attrValue(token.attrs, "fd_type").toLowerCase() === "jsp");
    if (opaque) {
      const end = ["script", "style", "textarea"].includes(token.name)
        ? (() => { const match = new RegExp(`</${token.name}\\s*>`, "ig"); match.lastIndex = token.end; return match.exec(html)?.index; })()
        : findMatchingCloseTag(html, token.end, token.name);
      if (end === undefined || end < token.end) return undefined;
      const close = scanHtmlTags(html, end).next().value; if (!close) return undefined;
      blank(token.start, close.end); i = close.end;
    } else i = token.end;
  }
  return chars.join("");
}

// A finite presentation vocabulary, not a CSS interpreter. Unknown styles cannot
// establish visibility for this new recovery path; older binding paths are intact.
function knownStyle(attrs, allowed) {
  const style = attrValue(attrs, "style");
  if (/\/\*|\*\/|[$\\{}<>!]/.test(style)) return false;
  const keys = new Set();
  for (const declaration of style.split(";").filter(value => value.trim())) {
    const match = declaration.trim().match(/^([a-z-]+)\s*:\s*([^:]+)$/i);
    if (!match) return false;
    const key = match[1].toLowerCase(), value = match[2].trim().toLowerCase();
    if (keys.has(key) || !allowed[key]?.(value)) return false;
    keys.add(key);
  }
  return true;
}
const visibleDisplay = value => ["inline", "inline-block", "block", "table", "table-row", "table-cell"].includes(value);
const positiveDimension = value => /^(?:\d+(?:\.\d+)?)(?:px|%)$/.test(value) && parseFloat(value) > 0;
function captionAppearance(attrs) {
  return knownStyle(attrs, {
    display: value => value === "inline", width: value => value === "auto",
    "font-weight": value => value === "normal", "font-style": value => value === "normal",
    "text-decoration": value => value === "none"
  });
}
function containerAppearance(attrs) {
  return knownStyle(attrs, { width: value => value === "auto" || positiveDimension(value), display: visibleDisplay });
}
function valueAppearance(attrs) {
  return knownStyle(attrs, { width: value => /^\d+(?:\.\d+)?px$/.test(value) && parseFloat(value) > 0, display: visibleDisplay });
}
