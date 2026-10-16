import { parseExpressionAt } from "acorn";
import { parseDesignerFdValues } from "./designer-control-values.js";
import { isVoidLikeTag, scanHtmlTags } from "./designer-html-tokenizer.js";
import { parseStaticMarkupAttributes, staticSourceMarkup } from "./source-static-markup.js";
import { attrValue, decodeEntities } from "./xml-utils.js";
import { trailingBlankPrefixProof } from "./trailing-blank-prefix-proof.js";

const CAPTION_VALUE_KEYS = new Set(["id", "content", "font", "size", "color", "effect", "b", "i", "underline", "canShow"]);

// A designer LABEL can carry a sizing handle that is absent from its actual
// rendered counterpart. Only an exact static table/cell pair can omit that hint.
export function runtimeCaptionWidthEvidence(designerHtml = "", runtimeHtml = "", metadataFields = []) {
  return captionEvidence(designerHtml, runtimeHtml, metadataFields, false);
}

/** Static source identity and actual widthlessness for a mobile plain caption. */
export function runtimePlainCaptionEvidence(designerHtml = "", runtimeHtml = "", metadataFields = []) {
  return runtimePlainCaptionEvidenceWithMarkers(designerHtml, runtimeHtml, metadataFields).ids;
}

/** The marker fact contains natural identities only, never copied JSP content. */
export function runtimePlainCaptionEvidenceWithMarkers(designerHtml = "", runtimeHtml = "", metadataFields = []) {
  const decorative = runtimeCaptionWidthEvidence(designerHtml, runtimeHtml, metadataFields);
  const markerIds = new Map();
  const ids = captionEvidence(designerHtml, runtimeHtml, metadataFields, true, decorative, markerIds);
  return { ids, markerIds };
}

/** A packed two-cell prefix may omit only these matched, genuinely blank tail cells. */
export function runtimeCaptionTrailingBlankCells(designerHtml = "", runtimeHtml = "", captionIds = new Set(), options = {}) {
  const designer = markupTree(designerHtml), runtime = markupTree(runtimeHtml), result = new Map();
  if (!designer || !runtime) return result;
  for (const captionId of captionIds) {
    const captions = designer.nodes.filter(node => node.name === "label" && parseDesignerFdValues(node.rawAttrs).id === captionId);
    if (captions.length !== 1) continue;
    const caption = captions[0], table = nearest(caption, "table"), first = caption.parent, row = first?.parent;
    const tableId = table?.attrs?.get("id");
    if (!tableId || row?.name !== "tr" || row.attrs?.size !== 0 || !unspannedRow(designer, table, row)) continue;
    const tables = runtime.nodes.filter(node => node.name === "table" && node.attrs?.get("id") === tableId);
    if (tables.length !== 1 || designer.nodes.filter(node => node.attrs?.get("id") === tableId).length !== 1) continue;
    const sourceGeometry = cellGeometry(first), renderedCells = matchingCells(runtime.nodes, tables[0], sourceGeometry);
    if (!sourceGeometry || matchingCells(designer.nodes, table, sourceGeometry).length !== 1 || renderedCells.length !== 1) continue;
    const renderedFirst = renderedCells[0], renderedRow = renderedFirst.parent;
    const text = captionText(designer.html, caption);
    const renderedCaptions = runtime.nodes.filter(node => node.name === "label" && node.parent === renderedFirst &&
      [undefined, captionId].includes(node.attrs?.get("id")) && captionText(runtime.html, node) === text);
    if (!text || renderedCaptions.length !== 1 || !onlyChild(designer, first, caption) || !onlyChild(runtime, renderedFirst, renderedCaptions[0])) continue;
    if (renderedRow?.name !== "tr" || renderedRow.attrs?.size !== 0 || !unspannedRow(runtime, tables[0], renderedRow) ||
        physicalCellGeometry(designer, table, first) !== physicalCellGeometry(runtime, tables[0], renderedFirst)) continue;
    const cells = designer.nodes.filter(node => node.parent === row && ["td", "th"].includes(node.name));
    const rendered = runtime.nodes.filter(node => node.parent === renderedRow && ["td", "th"].includes(node.name));
    if (cells.length < 3 || cells.length > 8 || cells.length !== rendered.length || cells[0] !== first || rendered[0] !== renderedFirst) continue;
    const widths = cells.map(trailingCellWidth), renderedWidths = rendered.map(trailingCellWidth);
    if (widths.some(value => value === false) || renderedWidths.some(value => value === false) ||
        cells.some((cell, index) => !singlePhysicalCell(cell, index) || !singlePhysicalCell(rendered[index], index) ||
          cell.attrs.get("row") !== cells[0].attrs.get("row") || rendered[index].attrs.get("row") !== rendered[0].attrs.get("row") ||
          cellGeometry(cell) !== cellGeometry(rendered[index]) || JSON.stringify(widths[index]) !== JSON.stringify(renderedWidths[index]) ||
          JSON.stringify(inertCellHints(cell)) !== JSON.stringify(inertCellHints(rendered[index])))) continue;
    // Inspect the original body. Static markup intentionally masks comments and scripts.
    if (!cells.slice(2).every((cell, index) => rawBlankBody(designer, cell) && rawBlankBody(runtime, rendered[index + 2]))) continue;
    if (!widths[0] || !widths[1] || widths[0].unit !== widths[1].unit) continue;
    const body = trailingBlankPrefixProof({ designerHtml, runtimeHtml, sourceCell: cells[1], runtimeCell: rendered[1], tableId,
      scriptFragments: options.scriptFragments, scriptSources: options.scriptSources });
    if (!body) continue;
    const rows = designer.nodes.filter(node => node.name === "tr" && nearest(node, "table") === table);
    result.set(captionId, { captionId, bodyId: body.id, tableId, rowIndex: rows.indexOf(row),
      sourceColumns: cells.length, retainedColumns: 2, omittedColumns: cells.slice(2).map((_, index) => index + 2),
      widthUnit: widths[0].unit, keptWidthWeights: widths.slice(0, 2).map(width => width.value),
      ...(body.carrierIds.length ? { scriptCarrierIds: body.carrierIds } : {}) });
  }
  return result;
}

function singlePhysicalCell(cell, index) {
  const attrs = cell?.attrs;
  return cell?.name === "td" && attrs && cell.visible &&
    [...attrs.keys()].every(key => ["row", "column", "width", "style", "colspan", "rowspan", "class",
      "style_borderbottomwidth", "style_bordertopwidth", "style_borderrightwidth", "style_borderleftwidth",
      "style_verticalalign", "style_textalign"].includes(key)) && inertCellHints(cell) !== undefined &&
    attrs.get("column") === String(index) && /^(?:0|[1-9]\d*)$/.test(attrs.get("row") || "") &&
    [undefined, "1"].includes(attrs.get("colspan")) && [undefined, "1"].includes(attrs.get("rowspan"));
}
function inertCellHints(cell) {
  const attrs = cell?.attrs, map = attrs && styles(attrs);
  if (!map) return undefined;
  const className = attrs.get("class"), result = {};
  if (className !== undefined) {
    if (!["tb_normal", "td_normal", "td_normal_title", "td_normal_label"].includes(className)) return undefined;
    result.className = className;
  }
  for (const edge of ["bottom", "top", "right", "left"]) {
    const key = `style_border${edge}width`, value = attrs.get(key);
    if (value === undefined) continue;
    if (value !== "null") return undefined;
    result[key] = value;
  }
  for (const [attribute, property] of [["style_verticalalign", "vertical-align"], ["style_textalign", "text-align"]]) {
    const value = attrs.get(attribute);
    if (value === undefined) continue;
    if (value.toLowerCase() !== map.get(property)?.toLowerCase()) return undefined;
    result[attribute] = value.toLowerCase();
  }
  for (const property of ["vertical-align", "text-align"]) if (map.has(property)) result[property] = map.get(property).toLowerCase();
  return result;
}
function trailingCellWidth(cell) {
  if (!cell?.attrs) return false;
  const map = styles(cell.attrs);
  if (!map || [...map].some(([key, value]) => !(
    key === "width" && /^(?:\d+(?:\.\d+)?)(?:px|%)$/i.test(value) ||
    key === "vertical-align" && /^(?:top|middle|bottom|baseline)$/i.test(value) ||
    key === "text-align" && /^(?:left|right|center|justify|start|end)$/i.test(value)
  ))) return false;
  const attribute = cell.attrs.get("width");
  if (attribute !== undefined && !/^(?:\d+(?:\.\d+)?)(?:px|%)?$/i.test(attribute)) return false;
  const selected = map.get("width") ?? attribute;
  if (selected === undefined) return undefined;
  const value = Number.parseFloat(selected), unit = selected.endsWith("%") ? "percent" : "px";
  return value > 0 && Number.isFinite(value) && (unit !== "percent" || value <= 100) ? { value, unit } : false;
}
function rawBlankBody(tree, cell) {
  return /^(?:[ \t\r\n\f\u00a0]|&nbsp;|&#160;|&#x[aA]0;)*$/.test(tree.rawHtml.slice(cell.contentStart, cell.contentEnd));
}
function captionEvidence(designerHtml, runtimeHtml, metadataFields, plainWidthless, decorative = new Set(), markerIds) {
  const designer = markupTree(designerHtml), runtime = markupTree(runtimeHtml);
  const result = new Set();
  if (!designer || !runtime) return result;
  const identities = openingIdentities(designerHtml);
  const runtimeIdentities = openingIdentities(runtimeHtml);
  const metadata = [...metadataFields].flatMap(field => [field, ...(field.columns || [])]);
  for (const source of designer.nodes) {
    const values = parseDesignerFdValues(source.rawAttrs);
    const terminalBreak = plainWidthless && typeof values.content === "string" &&
      /^[^\r\n]+(?:\r\n|\n)[ \t\u00a0]*$/.test(values.content);
    if (source.name !== "label" || source.attrs?.get("fd_type")?.toLowerCase() !== "textlabel" ||
        !/^[A-Za-z_][\w-]*$/.test(values.id || "") || identities.get(values.id) !== 1 ||
        !completeStringValues(source, values, CAPTION_VALUE_KEYS, terminalBreak) || !plainCaptionValues(values, terminalBreak) || !source.visible || !source.attrs || source.attrs.has("width") ||
        !simpleCaptionAttributes(source.attrs, true)) continue;
    const designerWidth = styles(source.attrs)?.get("width");
    if (plainWidthless
      ? designerWidth !== undefined && !/^auto$/i.test(designerWidth) && !positivePixels(designerWidth)
      : !positivePixels(designerWidth)) continue;
    const matchingMetadata = metadata.filter(field => field.id === values.id);
    if (matchingMetadata.length > 1 || matchingMetadata.some(field =>
      Object.keys(field.source?.metadataAttributes || {}).some(key => key.toLowerCase() === "width"))) continue;
    const text = captionText(terminalBreak ? designer.rawHtml : designer.html, source, terminalBreak);
    if (!text || text !== values.content.trim()) continue;
    const cell = source.parent, table = nearest(source, "table"), geometry = cellGeometry(cell);
    // Reuse only an independently complete two-ended proof. The new identity,
    // geometry and non-rowspan checks still run; do not mix per-side shortcuts.
    const completeDecorative = plainWidthless && decorative.has(values.id);
    const markers = plainWidthless && !completeDecorative
      ? designerCaptionMarkers(designer, cell, source, identities, metadata)
      : [];
    if (!geometry || table?.attrs?.get("fd_type")?.toLowerCase() !== "standardtable" ||
        !completeDecorative && (plainWidthless ? markers === undefined : !captionCell(designer, cell, source)) ||
        terminalBreak && !captionCell({ ...designer, html: designer.rawHtml }, cell, source, true) ||
        plainWidthless && !unspannedRow(designer, table, cell.parent)) continue;
    const tableId = table.attrs.get("id");
    if (!tableId || identities.get(tableId) !== 1) continue;
    const tables = runtime.nodes.filter(node => node.name === "table" && node.attrs?.get("id") === tableId);
    if (tables.length !== 1 || runtimeIdentities.get(tableId) !== 1 || !tables[0].visible) continue;
    const sourceCells = matchingCells(designer.nodes, table, geometry);
    const runtimeCells = matchingCells(runtime.nodes, tables[0], geometry);
    if (sourceCells.length !== 1 || sourceCells[0] !== cell || runtimeCells.length !== 1) continue;
    const renderedCell = runtimeCells[0];
    const physicalGeometry = physicalCellGeometry(designer, table, cell);
    if (!physicalGeometry || physicalGeometry !== physicalCellGeometry(runtime, tables[0], renderedCell)) continue;
    const labels = runtime.nodes.filter(node => node.name === "label" && node.parent === renderedCell &&
      captionText(terminalBreak ? runtime.rawHtml : runtime.html, node, terminalBreak) === text);
    if (labels.length !== 1) continue;
    const label = labels[0], runtimeId = label.attrs?.get("id");
    if (!label.visible || !label.attrs || !simpleCaptionAttributes(label.attrs, false) ||
        (runtimeId && runtimeId !== values.id) ||
        (runtimeIdentities.has(values.id) && (runtimeId !== values.id || runtimeIdentities.get(values.id) !== 1)) ||
        !completeDecorative && !markers.length && !captionCell(runtime, renderedCell, label, plainWidthless) || !runtimeWidthless(label.attrs) ||
        terminalBreak && !captionCell({ ...runtime, html: runtime.rawHtml }, renderedCell, label, true) ||
        plainWidthless && !unspannedRow(runtime, tables[0], renderedCell.parent)) continue;
    if (markers.length && !runtimeMarkersMatch(runtime, renderedCell, label, markers)) continue;
    result.add(values.id);
    if (markers.length) markerIds?.set(values.id, markers.map(marker => marker.id));
  }
  return result;
}

function markupTree(input) {
  const html = staticSourceMarkup(String(input || ""));
  if (html === undefined) return undefined;
  const nodes = [], stack = [];
  for (const token of scanHtmlTags(html)) {
    if (token.closing) {
      const node = stack.pop();
      if (!node || node.name !== token.name) return undefined;
      node.contentEnd = token.start; node.end = token.end;
      continue;
    }
    const attrs = parseStaticMarkupAttributes(token.attrs), parent = stack.at(-1);
    const node = { ...token, rawAttrs: token.attrs, attrs, parent, contentStart: token.end,
      contentEnd: token.end, visible: Boolean(attrs) && appearance(attrs) && !token.name.includes(":") &&
        !["jsp", "right"].includes(attrs?.get("fd_type")?.toLowerCase()) && (!parent || parent.visible) };
    nodes.push(node);
    if (!token.selfClosing && !isVoidLikeTag(token.name)) stack.push(node);
  }
  return stack.length ? undefined : { html, rawHtml: String(input || ""), nodes };
}

function openingIdentities(html) {
  const counts = new Map();
  for (const token of scanHtmlTags(String(html || ""))) {
    if (token.closing) continue;
    for (const id of new Set([parseDesignerFdValues(token.attrs).id, attrValue(token.attrs, "id")].filter(Boolean))) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return counts;
}

function plainCaptionValues(values, terminalBreak = false) {
  return Object.keys(values).every(key => CAPTION_VALUE_KEYS.has(key)) && typeof values.content === "string" &&
    values.content.trim() && !/[<>]|\$\{|<%/.test(values.content) &&
    (terminalBreak || !/[\r\n]/.test(values.content)) &&
    ["font", "size", "color", "effect"].every(key => !values[key]) &&
    ["b", "i", "underline"].every(key => [undefined, "", "false"].includes(values[key])) &&
    [undefined, "", "true"].includes(values.canShow);
}

function completeCaptionValues(source, legacyValues) {
  return completeStringValues(source, legacyValues, CAPTION_VALUE_KEYS);
}

function completeStringValues(source, legacyValues, allowedKeys, terminalBreak = false) {
  const raw = source.attrs?.get("fd_values");
  // Some exporter captions contain a literal terminal CRLF inside a quoted
  // content value. Validate the complete object, without changing that value.
  const text = terminalBreak ? escapeQuotedLineBreaks(raw) : raw;
  if (!text) return false;
  const comments = [];
  let object;
  try { object = parseExpressionAt(text, 0, { ecmaVersion: "latest", onComment: comments }); }
  catch { return false; }
  if (object.type !== "ObjectExpression" || comments.length || text.slice(0, object.start).trim() || text.slice(object.end).trim()) return false;
  const values = new Map();
  for (const property of object.properties) {
    if (property.type !== "Property" || property.kind !== "init" || property.method || property.computed || property.shorthand) return false;
    const key = property.key.type === "Identifier" ? property.key.name :
      property.key.type === "Literal" && typeof property.key.value === "string" ? property.key.value : undefined;
    if (!allowedKeys.has(key) || values.has(key) || property.value.type !== "Literal" || typeof property.value.value !== "string") return false;
    values.set(key, property.value.value);
  }
  // The legacy mapper deliberately accepts a smaller string-value grammar.
  // Its ignored or comment-like fragments cannot establish new width evidence.
  return values.size === Object.keys(legacyValues).length && [...values].every(([key, value]) =>
    Object.hasOwn(legacyValues, key) && legacyValues[key] === value);
}

function escapeQuotedLineBreaks(text) {
  if (typeof text !== "string") return undefined;
  let quote, escaped = false, result = "";
  for (const character of text) {
    if (!quote) {
      if (character === '"' || character === "'") quote = character;
      result += character;
    } else if (escaped) {
      if (/[\r\n]/.test(character)) return undefined;
      escaped = false; result += character;
    } else if (character === "\\") {
      escaped = true; result += character;
    } else if (character === quote) {
      quote = undefined; result += character;
    } else result += character === "\r" ? "\\r" : character === "\n" ? "\\n" : character;
  }
  return quote || escaped ? undefined : result;
}

function simpleCaptionAttributes(attrs, designer) {
  const allowed = new Set(designer ? ["id", "style", "fd_type", "fd_values", "formdesign"] : ["id", "style", "width"]);
  return [...attrs.keys()].every(key => allowed.has(key));
}

function styles(attrs) {
  const result = new Map();
  for (const declaration of String(attrs.get("style") || "").split(";")) {
    if (!declaration.trim()) continue;
    const match = /^\s*([-a-z]+)\s*:\s*([^:]+?)\s*$/i.exec(declaration), key = match?.[1].toLowerCase();
    if (!match || result.has(key)) return undefined;
    result.set(key, match[2]);
  }
  return result;
}

function positivePixels(value) { return /^\d+(?:\.\d+)?px$/i.test(value || "") && Number.parseFloat(value) > 0; }
function dimension(value) { return /^auto$/i.test(value) || /^(?:\d+(?:\.\d+)?)(?:px|%)?$/i.test(value) && Number.parseFloat(value) > 0; }
function appearance(attrs) {
  if (attrs.has("hidden") || [...attrs].some(([key, value]) => /^on\w+/i.test(key) || /\$\{|<%/.test(value)) ||
      ["false", "noshow"].includes(attrs.get("canshow")?.toLowerCase()) ||
      attrs.get("showstatus")?.toLowerCase() === "noshow" ||
      ["width", "height"].some(key => attrs.has(key) && !dimension(attrs.get(key)))) return false;
  const classes = (attrs.get("class") || "").split(/\s+/).filter(Boolean);
  if (classes.some(name => !["tb_normal", "td_normal", "td_normal_title", "td_normal_label", "tr_normal"].includes(name))) return false;
  const map = styles(attrs); if (!map) return false;
  const rules = new Map([
    ["width", dimension], ["height", dimension],
    ["display", value => /^(?:inline|inline-block|block|table|table-row|table-cell|table-row-group)$/i.test(value)],
    ["vertical-align", value => /^(?:top|middle|bottom|baseline)$/i.test(value)],
    ["text-align", value => /^(?:left|right|center|justify|start|end)$/i.test(value)],
    ["text-decoration", value => /^none$/i.test(value)], ["font-weight", value => /^normal$/i.test(value)],
    ["font-style", value => /^normal$/i.test(value)]
  ]);
  return [...map].every(([key, value]) => rules.has(key) && rules.get(key)(value));
}

function nearest(node, name) { for (let p = node.parent; p; p = p.parent) if (p.name === name) return p; }
function captionText(html, node, terminalBreak = false) {
  if (node.selfClosing || node.contentEnd <= node.contentStart) return undefined;
  let body = html.slice(node.contentStart, node.contentEnd);
  if (terminalBreak) {
    const match = /^([^<>\r\n]+)<br\s*\/?>([\s\S]*)$/i.exec(body);
    if (!match || !/^(?:[ \t\r\n\f\u00a0]|&nbsp;|&#0*(?:9|10|13|32|160);|&#[xX]0*(?:9|[aA]|[dD]|20|[aA]0);)*$/.test(match[2])) return undefined;
    body = match[1];
  }
  if (/<|>|\$\{/.test(body)) return undefined;
  const text = decodeEntities(body).trim();
  return text && !/[<>\r\n]|\$\{/.test(text) ? text : undefined;
}
function captionCell(tree, cell, label, plainWidthless = false) {
  if (!["td", "th"].includes(cell?.name) || !cell.visible || label.parent !== cell) return false;
  const children = tree.nodes.filter(node => node.parent === cell);
  let offset = cell.contentStart;
  for (const child of children) {
    if (tree.html.slice(offset, child.start).trim() || child !== label &&
        !(plainWidthless ? staticHiddenInput(child) : explicitlyHidden(child))) return false;
    offset = child.end;
  }
  return !tree.html.slice(offset, cell.contentEnd).trim();
}
function staticHiddenInput(node) {
  if (node.name !== "input" || node.attrs?.get("type")?.toLowerCase() !== "hidden") return false;
  const allowed = new Set(["id", "name", "type", "value", "style", "hidden"]);
  return [...node.attrs].every(([key, value]) => allowed.has(key) && !/[<>]|\$\{|<%/.test(value)) &&
    (!node.attrs.has("style") || /^\s*display\s*:\s*none\s*;?\s*$/i.test(node.attrs.get("style")));
}

function designerCaptionMarkers(tree, cell, label, identities, metadata) {
  if (!["td", "th"].includes(cell?.name) || !cell.visible || label.parent !== cell) return undefined;
  const children = tree.nodes.filter(node => node.parent === cell), markers = [];
  let offset = cell.contentStart;
  for (const child of children) {
    if (tree.html.slice(offset, child.start).trim()) return undefined;
    if (child !== label && !staticHiddenInput(child)) {
      const marker = designerHiddenMarker(tree, child, identities) || designerTypedHidden(tree, child, identities, metadata);
      if (!marker || markers.length || !markerMetadataMatches(marker, metadata)) return undefined;
      markers.push(marker);
    }
    offset = child.end;
  }
  if (tree.html.slice(offset, cell.contentEnd).trim() || markers.length &&
      (children.length !== 2 || !rawChildrenOnly(tree, cell, children)) || markers.some(marker => children.some(child =>
    child.name === "input" && child.attrs?.get("id") === marker.id))) return undefined;
  return markers;
}

function designerHiddenMarker(tree, node, identities) {
  const attrs = node.attrs, allowed = ["id", "title", "style", "formdesign", "fd_values", "fd_type", "mobileview"];
  const values = parseDesignerFdValues(node.rawAttrs), style = attrs && styles(attrs);
  if (node.name !== "div" || !attrs || attrs.size !== allowed.length || [...attrs.keys()].some(key => !allowed.includes(key)) ||
      attrs.get("fd_type")?.toLowerCase() !== "jsp" || attrs.get("formdesign") !== "landray" ||
      attrs.get("mobileview") !== "default" || !attrs.get("title") || /[<>]|\$\{|<%/.test(attrs.get("title")) ||
      !/^[A-Za-z_][\w-]*$/.test(attrs.get("id") || "") || attrs.get("id") !== values.id || identities.get(values.id) !== 1 ||
      Object.keys(values).length !== 1 || !completeCaptionValues(node, values) ||
      style?.size !== 2 || !positivePixels(style.get("width")) || style.get("display")?.toLowerCase() !== "inline") return undefined;
  const children = tree.nodes.filter(child => child.parent === node);
  if (children.length !== 1 || !onlyChild(tree, node, children[0])) return undefined;
  const icon = children[0], iconAttrs = icon.attrs, iconStyle = iconAttrs && styles(iconAttrs);
  if (icon.name !== "label" || iconAttrs?.size !== 3 ||
      [...iconAttrs.keys()].some(key => !["ondblclick", "class", "style"].includes(key)) ||
      iconAttrs.get("class") !== "button_img" ||
      !/^\s*Designer_Control_JSP_ShowEditFrame\(event,\s*this\);\s*$/.test(iconAttrs.get("ondblclick") || "") ||
      iconStyle?.size !== 2 || iconStyle.get("background-position") !== "center -480px" ||
      iconStyle.get("margin") !== "2px 3px 3px 2px") return undefined;
  const inputs = tree.nodes.filter(child => child.parent === icon);
  if (inputs.length !== 1 || inputs[0].name !== "input" || !onlyChild(tree, icon, inputs[0])) return undefined;
  // Raw source carriers contain literal angle brackets inside one quoted value.
  // Consume the whole finite attribute shape locally; the shared parser stays strict.
  const carrier = /^\s*type\s*=\s*(?:"hidden"|'hidden'|hidden)\s+value\s*=\s*(?:"([^"]*)"|'([^']*)')\s*\/?\s*$/i.exec(inputs[0].rawAttrs);
  if (!carrier) return undefined;
  const fragment = decodeCarrierAttribute(carrier[1] ?? carrier[2]);
  if (fragment === undefined) return undefined;
  const tokens = [...scanHtmlTags(fragment)];
  if (tokens.length !== 1 || tokens[0].closing || tokens[0].name !== "input" ||
      (fragment.slice(0, tokens[0].start) + fragment.slice(tokens[0].end)).trim()) return undefined;
  return markerIdentity({ ...tokens[0], rawAttrs: tokens[0].attrs, attrs: parseStaticMarkupAttributes(tokens[0].attrs) });
}

function onlyChild(tree, parent, child) {
  return !(tree.rawHtml.slice(parent.contentStart, child.start) + tree.rawHtml.slice(child.end, parent.contentEnd)).trim();
}
function rawChildrenOnly(tree, parent, children) {
  let offset = parent.contentStart;
  for (const child of children) {
    if (tree.rawHtml.slice(offset, child.start).trim()) return false;
    offset = child.end;
  }
  return !tree.rawHtml.slice(offset, parent.contentEnd).trim();
}
function decodeCarrierAttribute(text) {
  const named = new Map([["quot", '"'], ["apos", "'"], ["amp", "&"], ["lt", "<"], ["gt", ">"]]);
  let valid = true;
  const decoded = text.replace(/&([^;\s]+);/g, (_whole, entity) => {
    if (named.has(entity)) return named.get(entity);
    const match = /^#(?:x([0-9a-f]+)|(\d+))$/i.exec(entity);
    const code = match && Number.parseInt(match[1] || match[2], match[1] ? 16 : 10);
    if (!match || !Number.isInteger(code) || code <= 0 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) {
      valid = false; return "";
    }
    return String.fromCodePoint(code);
  });
  return valid ? decoded : undefined;
}
function markerIdentity(node) {
  const attrs = node.attrs;
  if (!staticHiddenInput(node) || /&/.test(node.rawAttrs || "") ||
      [...attrs.values()].some(value => /[\u0000-\u001f\u007f-\u009f]/.test(value)) ||
      [...attrs.keys()].some(key => !["type", "id", "name", "value"].includes(key)) ||
      !/^[A-Za-z_][\w-]*$/.test(attrs.get("id") || "") ||
      attrs.get("name") !== attrs.get("id")) return undefined;
  return { id: attrs.get("id"), name: attrs.get("name"), type: "hidden",
    hasValue: attrs.has("value"), value: attrs.get("value") };
}
function markerMetadataMatches(marker, metadata) {
  const matches = metadata.filter(field => field.id === marker.id);
  if (matches.length > 1) return false;
  if (!matches.length) return true;
  const attrs = matches[0].source?.metadataAttributes || {};
  return matches[0].type === "text" && [undefined, "simple"].includes(attrs.kind) &&
    [undefined, "String"].includes(attrs.type) && !attrs.enumValues && attrs.formula !== "true" &&
    (attrs.defaultValue === undefined || marker.hasValue && attrs.defaultValue === marker.value);
}
function runtimeMarkersMatch(tree, cell, label, markers) {
  const children = tree.nodes.filter(node => node.parent === cell);
  if (children.length !== markers.length + 1 || !children.includes(label) || !rawChildrenOnly(tree, cell, children)) return false;
  const extras = children.filter(node => node !== label);
  return markers.every(marker => {
    if (marker.kind === "typed") return extras.filter(node => runtimeTypedHidden(tree, node, marker)).length === 1;
    const matches = extras.filter(node => node.name === "input" && node.attrs?.get("id") === marker.id);
    return matches.length === 1 && JSON.stringify(markerIdentity(matches[0])) === JSON.stringify(marker);
  });
}

function designerTypedHidden(tree, node, identities, metadata) {
  const attrs = node.attrs, values = parseDesignerFdValues(node.rawAttrs), style = attrs && styles(attrs);
  const outerKeys = ["style", "formdesign", "fd_values", "fd_type", "canshow"];
  const valueKeys = new Set(["id", "width", "_label_bind", "label", "_label_bind_id", "canShow", "readOnly", "required",
    "dataType", "validate", "thousandShow", "formula", "defaultValue", "reCalculate"]);
  const tableId = nearest(node, "table")?.attrs?.get("id");
  if (node.name !== "div" || attrs?.size !== outerKeys.length || [...attrs.keys()].some(key => !outerKeys.includes(key)) ||
      attrs.get("fd_type")?.toLowerCase() !== "inputtext" || attrs.get("formdesign") !== "landray" || attrs.get("canshow") !== "false" ||
      !/^[A-Za-z_][\w-]*$/.test(values.id || "") || identities.get(values.id) !== 2 ||
      !completeStringValues(node, values, valueKeys) || Object.keys(values).length !== valueKeys.size ||
      values._label_bind !== "false" || values._label_bind_id !== "" || values.canShow !== "false" || values.readOnly !== "true" ||
      values.required !== "false" || values.dataType !== "String" || values.validate !== "false" || values.thousandShow !== "false" ||
      values.formula !== "" || values.defaultValue !== "" || values.reCalculate !== "false" ||
      !values.label || /[<>\r\n]|\$\{|<%/.test(values.label) ||
      !/^(?:\d+(?:\.\d+)?)$/.test(values.width) || !Number.isFinite(Number(values.width)) || Number(values.width) <= 0 ||
      style?.size !== 2 || style.get("display")?.toLowerCase() !== "inline" || !samePixelWidth(style.get("width"), values.width)) return undefined;
  const children = tree.nodes.filter(child => child.parent === node);
  if (children.length !== 1 || children[0].name !== "input" || !onlyChild(tree, node, children[0])) return undefined;
  const input = typedInputAttributes(children[0].rawAttrs);
  const inputKeys = ["id", "class", "style", "readonly", "label", "tablename", "_required", "required", "_readonly", "thousandshow", "canshow"];
  const inputStyle = input && styles(input);
  if (input?.size !== inputKeys.length || [...input.keys()].some(key => !inputKeys.includes(key)) ||
      input.get("id") !== values.id || input.get("class") !== "inputhidden" || inputStyle?.size !== 1 ||
      !samePixelWidth(inputStyle.get("width"), values.width) || input.get("readonly") !== "" ||
      input.get("label") !== values.label || input.get("tablename") !== tableId ||
      ["_required", "required", "thousandshow", "canshow"].some(key => input.get(key) !== "false") || input.get("_readonly") !== "true") return undefined;
  const matches = metadata.filter(field => field.id === values.id);
  if (matches.length !== 1 || matches[0].type !== "text") return undefined;
  const meta = matches[0].source?.metadataAttributes || {}, metaKeys = ["name", "label", "type", "length", "canDisplay", "kind", "notNull", "formula", "defaultValue"];
  if (Object.keys(meta).some(key => !metaKeys.includes(key)) || meta.name !== values.id || meta.label !== values.label ||
      meta.type !== "String" || meta.kind !== "simple" || meta.canDisplay !== "false" ||
      ![undefined, "false"].includes(meta.notNull) || ![undefined, "", "false"].includes(meta.formula) ||
      ![undefined, ""].includes(meta.defaultValue) || meta.length !== undefined &&
        (!/^[1-9]\d*$/.test(meta.length) || !Number.isFinite(Number(meta.length)))) return undefined;
  return { kind: "typed", id: values.id, width: values.width, label: values.label };
}

function samePixelWidth(style, width) {
  return positivePixels(style) && Number.parseFloat(style) === Number(width);
}

function typedInputAttributes(text) {
  const attribute = /\s*([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s"'`=<>]+)))?/y;
  const result = new Map();
  let offset = 0, bareReadonly = false, artifact = false;
  while (text.slice(offset).trim()) {
    if (offset > 0 && !/\s/.test(text[offset])) return undefined;
    if (bareReadonly && !artifact) {
      const question = /^\s+\?(?=\s+label\s*=)/i.exec(text.slice(offset));
      if (question) { offset += question[0].length; artifact = true; }
    }
    attribute.lastIndex = offset;
    const match = attribute.exec(text);
    if (!match || /&|\$\{|<%/.test(match[0])) return undefined;
    const parsed = parseStaticMarkupAttributes(match[0]);
    if (parsed?.size !== 1) return undefined;
    const [key, value] = [...parsed][0];
    if (result.has(key)) return undefined;
    result.set(key, value);
    bareReadonly = key === "readonly" && match.slice(2).every(value => value === undefined);
    offset = attribute.lastIndex;
  }
  return result;
}

function runtimeTypedHidden(tree, node, marker) {
  const attrs = node.attrs, outerStyle = attrs && styles(attrs);
  if (node.name !== "div" || attrs?.size !== 2 || !attrs.has("style") || attrs.get("canshow") !== "false" ||
      outerStyle?.size !== 1 || outerStyle.get("display")?.toLowerCase() !== "none") return false;
  const children = tree.nodes.filter(child => child.parent === node);
  if (children.length !== 1 || children[0].name !== "xform:xtext" || !children[0].selfClosing || !onlyChild(tree, node, children[0])) return false;
  const rendered = children[0].attrs, allowed = ["property", "style", "required", "showstatus", "subject", "title", "onvaluechange"];
  const innerStyle = rendered && styles(rendered);
  return rendered?.size === allowed.length && [...rendered.keys()].every(key => allowed.includes(key)) &&
    rendered.get("property") === `extendDataFormInfo.value(${marker.id})` && innerStyle?.size === 1 &&
    samePixelWidth(innerStyle.get("width"), marker.width) && rendered.get("required") === "false" &&
    rendered.get("showstatus")?.toLowerCase() === "noshow" && rendered.get("subject") === marker.label &&
    rendered.get("title") === marker.label && rendered.get("onvaluechange") === "__xformDispatch";
}
function unspannedRow(tree, table, row) {
  const rows = tree.nodes.filter(node => node.name === "tr" && nearest(node, "table") === table);
  const index = rows.indexOf(row);
  if (index < 0) return false;
  for (let i = 0; i <= index; i++) {
    for (const cell of tree.nodes.filter(node => ["td", "th"].includes(node.name) && node.parent === rows[i])) {
      const span = cell.attrs?.get("rowspan") || "1";
      if (!/^[1-9]\d*$/.test(span) || i === index && span !== "1" || i < index && i + Number(span) > index) return false;
    }
  }
  return true;
}
function explicitlyHidden(node) {
  if (!node.attrs) return false;
  const map = styles(node.attrs); if (!map) return false;
  return node.attrs.has("hidden") || node.attrs.get("canshow")?.toLowerCase() === "false" ||
    parseDesignerFdValues(node.rawAttrs).canShow === "false" ||
    map.get("display")?.toLowerCase() === "none" || ["hidden", "collapse"].includes(map.get("visibility")?.toLowerCase());
}
function cellGeometry(cell) {
  if (!["td", "th"].includes(cell?.name) || cell.parent?.name !== "tr" || !cell.visible || !cell.attrs) return undefined;
  const row = cell.attrs.get("row"), column = cell.attrs.get("column");
  if (!/^(?:0|[1-9]\d*)$/.test(row || "") || !/^(?:0|[1-9]\d*)(?:,(?:0|[1-9]\d*))*$/.test(column || "")) return undefined;
  const columns = column.split(",").map(Number), colspan = cell.attrs.get("colspan"), rowspan = cell.attrs.get("rowspan") || "1";
  if (columns.some((value, i) => i > 0 && value !== columns[i - 1] + 1) ||
      colspan !== undefined && (!/^[1-9]\d*$/.test(colspan) || Number(colspan) !== columns.length) || !/^[1-9]\d*$/.test(rowspan)) return undefined;
  return JSON.stringify({ row, columns, rowspan });
}
function matchingCells(nodes, table, geometry) {
  return nodes.filter(node => nearest(node, "table") === table && cellGeometry(node) === geometry);
}
function physicalCellGeometry(tree, table, cell) {
  const rows = tree.nodes.filter(node => node.name === "tr" && nearest(node, "table") === table);
  const rowIndex = rows.indexOf(cell.parent);
  if (rowIndex < 0) return undefined;
  const precedingRows = [];
  let cellIndex = -1;
  for (const row of rows.slice(0, rowIndex + 1)) {
    const cells = tree.nodes.filter(node => ["td", "th"].includes(node.name) && node.parent === row);
    const spans = [];
    for (const candidate of cells) {
      if (!candidate.attrs) return undefined;
      const colspan = candidate.attrs.get("colspan") || "1", rowspan = candidate.attrs.get("rowspan") || "1";
      if (!/^[1-9]\d*$/.test(colspan) || !/^[1-9]\d*$/.test(rowspan)) return undefined;
      spans.push([colspan, rowspan]);
    }
    precedingRows.push(spans);
    if (row === cell.parent) cellIndex = cells.indexOf(cell);
  }
  return cellIndex < 0 ? undefined : JSON.stringify({ rowIndex, cellIndex, precedingRows });
}
function runtimeWidthless(attrs) {
  const map = styles(attrs); if (!map) return false;
  const width = map.get("width"), attribute = attrs.get("width");
  return !(width !== undefined && attribute !== undefined) &&
    [width, attribute].every(value => value === undefined || /^auto$/i.test(value));
}
