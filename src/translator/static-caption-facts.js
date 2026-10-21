import {
  parseDesignerControlAttributes,
  parseDesignerFdValues,
  parseStaticDesignerStringValues
} from "./designer-control-values.js";
import { isVoidLikeTag, scanHtmlTags } from "./designer-html-tokenizer.js";
import { parseStaticMarkupAttributes, staticSourceMarkup } from "./source-static-markup.js";
import { decodeEntities } from "./xml-utils.js";

const CAPTION_KEYS = new Set([
  "id", "content", "font", "size", "color", "effect", "b", "i", "underline", "canShow", "width"
]);
const CAPTION_ATTRIBUTES = new Set(["id", "style", "width", "fd_type", "fd_values", "formdesign"]);
const CONTAINER_ATTRIBUTES = new Set([
  "id", "style", "class", "width", "height", "row", "column", "colspan", "rowspan",
  "border", "cellpadding", "cellspacing", "align", "valign", "fd_type", "formdesign", "canshow"
]);
const CONTAINER_TAGS = new Set(["table", "tbody", "thead", "tfoot", "tr", "td", "div", "span"]);
const PLAIN_CLASSES = new Set(["tb_normal", "tr_normal", "td_normal", "td_normal_title", "td_normal_label"]);
const TABLE_METADATA = new Set(["label", "layout2col", "fd_values"]);
const RUNTIME_EDITORS = new Map([
  ["inputtext", ["xform:xtext"]], ["textarea", ["xform:textarea"]],
  ["datetime", ["xform:datetime"]], ["inputselect", ["xform:select"]],
  ["inputradio", ["xform:radio", "xform:xradio"]], ["inputcheckbox", ["xform:checkbox"]],
  ["address", ["xform:address"]], ["rtf", ["xform:rtf"]]
]);

/**
 * Source-only facts about an independently rendered plain caption. These facts
 * do not establish field ownership, nor authorize removing script references.
 */
export function staticCaptionFacts(designerHtml, runtimeHtml = "") {
  const result = new Map();
  const designer = markupTree(designerHtml, true);
  const runtime = String(runtimeHtml || "").trim() ? markupTree(runtimeHtml) : undefined;
  if (!designer || String(runtimeHtml || "").trim() && !runtime) return result;
  const hiddenOwnerIds = runtime ? hiddenRuntimeOwners(runtime) : [];

  for (const caption of designer.nodes) {
    if (caption.name !== "label" || caption.attrs?.get("fd_type")?.toLowerCase() !== "textlabel") continue;
    const values = parseStaticDesignerStringValues(caption.attrsText, CAPTION_KEYS);
    const content = plainText(designer, caption);
    if (!values || !/^[A-Za-z_][\w.-]*$/.test(values.id || "") ||
        designer.identities.get(values.id) !== 1 ||
        !plainValues(values) || content !== values.content.trim() ||
        !plainCaption(caption, true) || !unguardedAncestors(caption) ||
        cellPosition(designer, caption) === undefined ||
        caption.attrs.has("id") && caption.attrs.get("id") !== values.id) continue;
    if (runtime && !runtimeMatches(designer, caption, values.id, content, runtime)) continue;
    result.set(values.id, { plainText: true, unique: true, unguarded: true, content,
      runtimeHiddenOwnerIds: hiddenOwnerIds.length ? hiddenOwnerIds : undefined,
      runtimeOwnerId: runtime && runtimeOwner(designer, caption, values.id, runtime) });
  }
  return result;
}

function hiddenRuntimeOwners(tree) {
  return tree.nodes.flatMap(node => {
    const id = node.attrs?.get("property")?.match(/^extendDataFormInfo\.value\(([A-Za-z_][\w.-]*)\)$/)?.[1];
    if (!id) return [];
    for (let current = node; current; current = current.parent) {
      const attrs = current.attrs;
      if (attrs?.has("hidden") || attrs?.get("canshow") === "false" || attrs?.get("showstatus") === "noshow" ||
          /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\.0*)?)\s*(?:;|$)/i.test(attrs?.get("style") || "")) return [id];
    }
    return [];
  });
}

function markupTree(input, designer = false) {
  const raw = String(input || "");
  const html = staticSourceMarkup(raw);
  if (html === undefined || hasUnmodeledPresentationCode(raw, designer)) return undefined;
  const nodes = [], stack = [], identities = new Map();
  for (const token of scanHtmlTags(html)) {
    if (token.closing) {
      const current = stack.at(-1);
      if (!current || current.name !== token.name) {
        // Recover only inside a completely delimited row. The affected row
        // remains ineligible, and every identity is still counted globally.
        const rowIndex = stack.findLastIndex(node => node.name === "tr");
        const matchIndex = stack.findLastIndex(node => node.name === token.name);
        if (rowIndex < 0 || matchIndex >= 0 && matchIndex < rowIndex) return undefined;
        stack[rowIndex].invalid = true;
        if (matchIndex >= rowIndex) stack.splice(matchIndex);
        continue;
      }
      stack.pop();
      current.contentEnd = token.start;
      continue;
    }
    const attrs = parseStaticMarkupAttributes(token.attrs) ||
      parseDesignerControlAttributes(token.attrs);
    const node = { ...token, attrsText: token.attrs, attrs, parent: stack.at(-1),
      contentStart: token.end, contentEnd: token.end };
    nodes.push(node);
    for (const id of new Set([attrs?.get("id"), parseDesignerFdValues(token.attrs).id].filter(Boolean))) {
      identities.set(id, (identities.get(id) || 0) + 1);
    }
    if (!token.selfClosing && !isVoidLikeTag(token.name)) stack.push(node);
  }
  return stack.length ? undefined : { nodes, raw, identities };
}

function hasUnmodeledPresentationCode(html, designer) {
  let skipUntil = 0;
  for (const token of scanHtmlTags(html)) {
    if (token.start < skipUntil || token.closing) continue;
    if (token.name === "style") return true;
    // Designer SCRIPTs outside a JSP carrier are not included in the existing
    // source-script registry. External scripts also have no inspectable body.
    if (token.name === "script" && (designer ||
        parseStaticMarkupAttributes(token.attrs)?.has("src"))) return true;
    if (token.name === "link") {
      const attrs = parseStaticMarkupAttributes(token.attrs);
      if (!attrs || /\bstylesheet\b/i.test(attrs.get("rel") || "") ||
          /\$\{|#\{|<%/.test(attrs.get("rel") || "")) return true;
    }
    // Match the same opaque carriers as staticSourceMarkup, before its masking
    // erases real style elements as well as inert strings containing "<style>".
    if (!["script", "textarea", "xform:textarea", "pre", "code"].includes(token.name) ||
        token.name === "xform:textarea" && token.selfClosing) continue;
    const close = new RegExp(`<\\/\\s*${token.name}\\s*>`, "ig");
    close.lastIndex = token.end;
    if (!close.exec(html)) return true;
    skipUntil = close.lastIndex;
  }
  return false;
}

function plainValues(values) {
  return typeof values.content === "string" && Boolean(values.content.trim()) &&
    !/[<>\r\n]|\$\{|<%/.test(values.content) &&
    ["font", "color", "effect"].every(key => !values[key]) &&
    [undefined, "", "14px"].includes(values.size) &&
    ["b", "i", "underline"].every(key => [undefined, "", "false"].includes(values[key])) &&
    [undefined, "", "true"].includes(values.canShow) &&
    (values.width === undefined || dimension(values.width));
}

function plainText(tree, node) {
  const raw = tree.raw.slice(node.contentStart, node.contentEnd);
  if (node.selfClosing || /[<>\r\n]|\$\{|#\{/.test(raw)) return undefined;
  const text = decodeEntities(raw).trim();
  return text && !/[<>\r\n]|\$\{|#\{/.test(text) ? text : undefined;
}

function plainCaption(node, designer) {
  const attrs = node.attrs;
  if (!attrs || [...attrs.keys()].some(key => !(designer
    ? CAPTION_ATTRIBUTES.has(key) : ["id", "style", "width"].includes(key)))) return false;
  return ordinaryAppearance(attrs, true) && (!attrs.has("width") || dimension(attrs.get("width")));
}

function unguardedAncestors(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    const attrs = parent.attrs;
    if (parent.invalid || !CONTAINER_TAGS.has(parent.name) || parent.name === "thead" || !attrs ||
        !containerAttributes(parent) ||
        !ordinaryAppearance(attrs)) return false;
    const type = attrs.get("fd_type");
    if (attrs.has("canshow") && attrs.get("canshow") !== "true") return false;
    if (type !== undefined && !(parent.name === "table" && type.toLowerCase() === "standardtable")) return false;
    if (attrs.has("rowspan") && attrs.get("rowspan") !== "1") return false;
    if (attrs.has("colspan") && !/^[1-9]\d*$/.test(attrs.get("colspan"))) return false;
    if (attrs.has("row") && !/^(?:0|[1-9]\d*)$/.test(attrs.get("row"))) return false;
    if (attrs.has("column") && !/^(?:0|[1-9]\d*)(?:,(?:0|[1-9]\d*))*$/.test(attrs.get("column"))) return false;
    if (["width", "height"].some(key => attrs.has(key) && !dimension(attrs.get(key)))) return false;
    if (["border", "cellpadding", "cellspacing"].some(key => attrs.has(key) && !/^\d+$/.test(attrs.get(key)))) return false;
    if (attrs.has("align") && !(parent.name === "table"
      ? /^(?:left|center|right)$/i : /^left$/i).test(attrs.get("align"))) return false;
    if (attrs.has("valign") && !/^(?:top|middle|bottom|baseline)$/i.test(attrs.get("valign"))) return false;
  }
  return true;
}

function containerAttributes(node) {
  const attrs = node.attrs;
  if ([...attrs.keys()].some(key => !CONTAINER_ATTRIBUTES.has(key) &&
      !(node.name === "table" && TABLE_METADATA.has(key)))) return false;
  if (node.name !== "table") return true;
  if (attrs.has("label") && /[<>\r\n]/.test(attrs.get("label"))) return false;
  if (attrs.has("layout2col") && !["", "undefined", "true", "false"].includes(attrs.get("layout2col"))) return false;
  return !attrs.has("fd_values") || Boolean(parseStaticDesignerStringValues(node.attrsText, new Set(["id", "label"])));
}

function ordinaryAppearance(attrs, caption = false) {
  if ([...attrs.values()].some(value => /\$\{|#\{|<%/.test(value))) return false;
  if ((attrs.get("class") || "").split(/\s+/).filter(Boolean).some(value => !PLAIN_CLASSES.has(value))) return false;
  const seen = new Set();
  for (const declaration of String(attrs.get("style") || "").split(";")) {
    if (!declaration.trim()) continue;
    const match = /^\s*([-a-z]+)\s*:\s*([^:]+?)\s*$/i.exec(declaration);
    const key = match?.[1].toLowerCase(), value = match?.[2];
    if (!match || seen.has(key)) return false;
    seen.add(key);
    if (key === "width" && dimension(value)) continue;
    if (!caption && key === "height" && dimension(value)) continue;
    if (caption && key === "display" && /^inline$/i.test(value)) continue;
    if (caption && ["display", "text-align", "vertical-align"].includes(key)) return false;
    if (key === "display" && /^(?:inline|inline-block|block|table|table-row|table-cell|table-row-group)$/i.test(value)) continue;
    if (key === "vertical-align" && /^(?:top|middle|bottom|baseline)$/i.test(value)) continue;
    if (key === "text-align" && /^(?:left|start)$/i.test(value)) continue;
    if (key === "text-decoration" && /^none$/i.test(value)) continue;
    if (caption && key === "font-size" && /^14px$/i.test(value)) continue;
    if (["font-weight", "font-style"].includes(key) && /^normal$/i.test(value)) continue;
    return false;
  }
  return true;
}

function dimension(value) {
  return /^auto$/i.test(value) || /^\d+(?:\.\d+)?(?:px|%)?$/i.test(value) && Number.parseFloat(value) > 0;
}

function runtimeMatches(designer, caption, id, content, runtime) {
  const labels = runtime.nodes.filter(node => node.name === "label" &&
    (node.attrs?.get("id") === id || plainText(runtime, node) === content));
  if (labels.length !== 1) return false;
  const rendered = labels[0];
  if (plainText(runtime, rendered) !== content || !plainCaption(rendered, false) ||
      !unguardedAncestors(rendered) || rendered.attrs.has("id") && rendered.attrs.get("id") !== id ||
      runtime.identities.has(id) && (runtime.identities.get(id) !== 1 || rendered.attrs.get("id") !== id)) return false;
  const sourcePosition = cellPosition(designer, caption), targetPosition = cellPosition(runtime, rendered);
  return sourcePosition !== undefined && targetPosition !== undefined &&
    JSON.stringify(sourcePosition) === JSON.stringify(targetPosition);
}

function runtimeOwner(designer, caption, id, runtime) {
  const sourceCell = nearest(caption, "td");
  const nextCell = tree => {
    const row = sourceCell?.parent;
    if (!row || row.name !== "tr") return undefined;
    const cells = designer.nodes.filter(node => node.parent === row && node.name === "td");
    const cell = cells[cells.indexOf(sourceCell) + 1];
    if (tree === designer) return cell;
    const position = cell && cellPosition(designer, cell);
    return position && runtime.nodes.find(node => node.name === "td" &&
      JSON.stringify(cellPosition(runtime, node)) === JSON.stringify(position));
  };
  const sourceValueCell = nextCell(designer), runtimeValueCell = nextCell(runtime);
  if (!sourceValueCell || !runtimeValueCell || !unguardedAncestors({ parent: sourceValueCell }) ||
      !unguardedAncestors({ parent: runtimeValueCell })) return undefined;
  const within = (node, parent) => { for (let n = node.parent; n; n = n.parent) if (n === parent) return true; return false; };
  const controls = designer.nodes.filter(node => within(node, sourceValueCell) && node.attrs?.has("fd_type"));
  if (controls.length !== 1) return undefined;
  const values = parseDesignerFdValues(controls[0].attrsText);
  if (!values.id || values._label_bind_id !== id || values.canShow === "false") return undefined;
  const editors = runtime.nodes.filter(node => within(node, runtimeValueCell) &&
    node.attrs?.get("property")?.startsWith("extendDataFormInfo.value("));
  if (editors.length !== 1 || !editors[0].selfClosing ||
      !RUNTIME_EDITORS.get(controls[0].attrs.get("fd_type")?.toLowerCase())?.includes(editors[0].name) ||
      editors[0].attrs.get("property") !== `extendDataFormInfo.value(${values.id})` ||
      runtime.nodes.filter(node => node.attrs?.get("property") === editors[0].attrs.get("property")).length !== 1 ||
      !ordinaryAppearance(editors[0].attrs) ||
      !unguardedAncestors(editors[0]) ||
      ["true"].includes(editors[0].attrs.get("showlabel")) ||
      ["false"].includes(editors[0].attrs.get("canshow")) ||
      ["noshow"].includes(editors[0].attrs.get("showstatus"))) return undefined;
  return values.id;
}

function cellPosition(tree, node) {
  const cell = node.name === "td" ? node : nearest(node, "td"), row = cell && nearest(cell, "tr"), table = row && nearest(row, "table");
  if (!cell || !row || !table) return null;
  const tableId = table.attrs?.get("id");
  if (tableId && tree.identities.get(tableId) !== 1) return undefined;
  const rows = tree.nodes.filter(item => item.name === "tr" && nearest(item, "table") === table);
  const cells = tree.nodes.filter(item => ["td", "th"].includes(item.name) && item.parent === row);
  // A span from an earlier row can change this row's physical field ownership.
  const rowIndex = rows.indexOf(row);
  for (let index = 0; index <= rowIndex; index++) {
    for (const item of tree.nodes.filter(candidate => ["td", "th"].includes(candidate.name) && candidate.parent === rows[index])) {
      const span = item.attrs?.get("rowspan") || "1";
      if (!/^[1-9]\d*$/.test(span) || index + Number(span) > rowIndex && span !== "1") return undefined;
    }
  }
  return { table: tableId || tree.nodes.filter(item => item.name === "table").indexOf(table),
    row: rowIndex, cell: cells.indexOf(cell), colspan: cell.attrs?.get("colspan") || "1",
    sourceRow: cell.attrs?.get("row"), sourceColumn: cell.attrs?.get("column") };
}

function nearest(node, name) {
  for (let parent = node.parent; parent; parent = parent.parent) if (parent.name === name) return parent;
}
