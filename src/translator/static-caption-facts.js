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
const STYLE_MIRRORS = new Map([
  ["style_textalign", ["text-align", "left"]], ["style_verticalalign", ["vertical-align", "middle"]]
]);
const EMPTY_BORDERS = new Set(["style_borderbottomwidth", "style_bordertopwidth", "style_borderleftwidth", "style_borderrightwidth"]);
const RUNTIME_TABLE_DUPLICATES = new Map([
  ["tablename", /^[A-Za-z_][\w.-]*$/], ["showindex", /^(?:true|false)$/],
  ["showstatisticrow", /^(?:true|false)$/], ["showrow", /^\d+$/]
]);
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
  return inspectStaticCaptions(designerHtml, runtimeHtml).facts;
}

export function inspectStaticCaptions(designerHtml, runtimeHtml = "") {
  const result = new Map();
  const issues = new Map();
  const designer = markupTree(designerHtml, true);
  const runtime = String(runtimeHtml || "").trim() ? markupTree(runtimeHtml) : undefined;
  const globalIssue = !designer ? { reason: "designer_markup_unproven" } :
    String(runtimeHtml || "").trim() && !runtime ? { reason: "runtime_markup_unproven" } : undefined;
  if (globalIssue) return { facts: result, issues, globalIssue };
  const hiddenOwnerIds = runtime ? hiddenRuntimeOwners(runtime) : [];
  // Designer HTML also contains editor-only menus/handlers. Runtime programs
  // come from fdDisplayJsp; Designer JSP/control scripts use the source registry.
  const program = runtimeProgram(runtimeHtml);

  for (const caption of designer.nodes) {
    if (caption.name !== "label" || caption.attrs?.get("fd_type")?.toLowerCase() !== "textlabel") continue;
    const values = parseStaticDesignerStringValues(caption.attrsText, CAPTION_KEYS, new Set(["content"]));
    const terminalBreak = typeof values?.content === "string" && /\r?\n\s*$/.test(values.content);
    const content = plainText(designer, caption, terminalBreak);
    const id = values?.id || parseDesignerFdValues(caption.attrsText).id;
    const reason = !values ? "caption_values_not_literal" :
      !/^[A-Za-z_][\w.-]*$/.test(values.id || "") || designer.identities.get(values.id) !== 1 ? "caption_identity_ambiguous" :
      !plainValues(values) ? "caption_formatting_protected" :
      content !== values.content.trim() ? "caption_content_mismatch" :
      !plainCaption(caption, true) ? "caption_markup_protected" :
      !unguardedAncestors(caption) ? ancestorIssue(caption) :
      cellPosition(designer, caption) === undefined ? "caption_region_unproven" :
      caption.attrs.has("id") && caption.attrs.get("id") !== values.id ? "caption_identity_mismatch" :
      runtime && !runtimeMatches(designer, caption, values.id, content, runtime, terminalBreak) ? "runtime_caption_mismatch" : undefined;
    if (reason) { if (id) issues.set(id, { reason }); continue; }
    result.set(values.id, { plainText: true, unique: true, unguarded: true, content,
      runtimeHiddenOwnerIds: hiddenOwnerIds.length ? hiddenOwnerIds : undefined,
      runtimeOwnerId: runtime && runtimeOwner(designer, caption, values.id, runtime),
      terminalBreakNormalized: terminalBreak || undefined,
      domContext: { ...captionDomContext(designer, caption, runtime, terminalBreak), version: 1,
        inlineScripts: program.scripts, inlineDomainComplete: program.complete } });
  }
  return { facts: result, issues };
}

// Collect the runtime independently of the designer-first migration registry.
// Masked text controls can carry handlers too; unknown attributes cannot be
// treated as an empty program. Script/textarea bodies are HTML raw text.
function runtimeProgram(input) {
  const html = String(input || ""), scripts = new Set();
  let complete = true, skipUntil = 0;
  for (const token of scanHtmlTags(html)) {
    if (token.closing || token.start < skipUntil) continue;
    // The native toolbar exports a static JSP URL inside a quoted src. Resolve
    // only its exact icon declaration before parsing the complete attribute set.
    const attributes = token.name === "img" ? token.attrs.replace(
      /<c:url\s+value=(["'])(\/resource\/style\/default\/icons\/(?:add|delete|up|down)\.gif)\1\s*\/>/g,
      (_, _quote, path) => path) : token.attrs;
    const attrs = parseStaticMarkupAttributes(attributes, token.name === "table" ? RUNTIME_TABLE_DUPLICATES : undefined) ||
      parseDesignerControlAttributes(attributes);
    if (!attrs) complete = false;
    for (const [key, value] of attrs || []) {
      if (/^on[a-z]+$/.test(key) && value.trim() &&
          !(key === "onvaluechange" && value.trim() === "__xformDispatch")) scripts.add(value);
    }
    if (!["script", "textarea", "xform:textarea"].includes(token.name) ||
        token.name === "xform:textarea" && token.selfClosing) continue;
    const close = new RegExp(`<\\/\\s*${token.name}\\s*>`, "ig");
    close.lastIndex = token.end;
    const match = close.exec(html);
    if (!match) { complete = false; break; }
    if (token.name === "script") scripts.add(html.slice(token.end, match.index));
    skipUntil = close.lastIndex;
  }
  return { complete, scripts: [...scripts].filter(Boolean) };
}

function ancestorIssue(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.invalid) return "caption_row_malformed";
    if (!parent.attrs || !containerAttributes(parent)) return "ancestor_attributes_unproven";
    if (!ordinaryAppearance(parent.attrs)) return "ancestor_formatting_protected";
    if (!unguardedAncestors({ parent: { ...parent, parent: undefined } })) return "ancestor_guard_or_geometry";
  }
  return "ancestor_guard_or_geometry";
}

function captionDomContext(designer, caption, runtime, terminalBreak) {
  const ancestorIds = new Set(), cellDescendantIds = new Set();
  const ids = node => node.identityIds || [];
  const collect = (tree, node) => {
    if (!node) return;
    const cell = nearest(node, "td"), row = cell?.parent;
    const cells = tree.nodes.filter(item => item.parent === row && item.name === "td");
    for (const root of [node, cells[cells.indexOf(cell) + 1]].filter(Boolean)) {
      for (let parent = root; parent; parent = parent.parent) {
        ids(parent).forEach(id => ancestorIds.add(id));
        if (parent.name !== "td") continue;
        for (const id of tree.cellDomains.get(parent) || []) cellDescendantIds.add(id);
      }
    }
  };
  collect(designer, caption);
  if (runtime) collect(runtime, runtime.nodes.find(node => node.name === "label" &&
    JSON.stringify(cellPosition(runtime, node)) === JSON.stringify(cellPosition(designer, caption)) &&
    plainText(runtime, node, terminalBreak) === plainText(designer, caption, terminalBreak)));
  return { ancestorIds: [...ancestorIds], cellDescendantIds: [...cellDescendantIds] };
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
    node.identityIds = [...new Set([attrs?.get("id"), parseDesignerFdValues(token.attrs).id].filter(Boolean))];
    for (const id of node.identityIds) {
      identities.set(id, (identities.get(id) || 0) + 1);
    }
    if (!token.selfClosing && !isVoidLikeTag(token.name)) stack.push(node);
  }
  if (stack.length) return undefined;
  const cellDomains = new Map();
  for (const node of nodes) for (let parent = node; parent; parent = parent.parent) {
    if (parent.name !== "td") continue;
    if (!cellDomains.has(parent)) cellDomains.set(parent, new Set());
    node.identityIds.forEach(id => cellDomains.get(parent).add(id));
  }
  return { nodes, raw, identities, cellDomains };
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
    !/[<>\r\n]|\$\{|<%/.test(values.content.trim()) &&
    ["font", "color", "effect"].every(key => !values[key]) &&
    [undefined, "", "14px"].includes(values.size) &&
    ["b", "i", "underline"].every(key => [undefined, "", "false"].includes(values[key])) &&
    [undefined, "", "true"].includes(values.canShow) &&
    (values.width === undefined || dimension(values.width));
}

function plainText(tree, node, terminalBreak = false) {
  const content = tree.raw.slice(node.contentStart, node.contentEnd).trim();
  const raw = terminalBreak ? content.replace(/<br\s*\/?\s*>$/i, "").trim() : content;
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
      !(node.name === "table" && TABLE_METADATA.has(key)) &&
      !STYLE_MIRRORS.has(key) && !EMPTY_BORDERS.has(key))) return false;
  for (const key of EMPTY_BORDERS) if (attrs.has(key) && attrs.get(key) !== "null") return false;
  for (const [key, [css, fallback]] of STYLE_MIRRORS) {
    if (!attrs.has(key)) continue;
    const declarations = String(attrs.get("style") || "").split(";")
      .map(value => value.trim().match(/^([a-z-]+)\s*:\s*(.*?)$/i)).filter(Boolean);
    const values = declarations.filter(value => value[1].toLowerCase() === css);
    if (values.length > 1 || attrs.get(key).toLowerCase() !== (values[0]?.[2] || fallback).toLowerCase()) return false;
  }
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

function runtimeMatches(designer, caption, id, content, runtime, terminalBreak = false) {
  const sourcePosition = cellPosition(designer, caption);
  if (!sourcePosition) return false;
  const labels = runtime.nodes.filter(node => node.name === "label" &&
    (node.attrs?.get("id") === id || plainText(runtime, node, terminalBreak) === content) &&
    JSON.stringify(cellPosition(runtime, node)) === JSON.stringify(sourcePosition));
  if (labels.length !== 1) return false;
  const rendered = labels[0];
  if (plainText(runtime, rendered, terminalBreak) !== content || !plainCaption(rendered, false) ||
      !unguardedAncestors(rendered) || rendered.attrs.has("id") && rendered.attrs.get("id") !== id ||
      runtime.identities.has(id) && (runtime.identities.get(id) !== 1 || rendered.attrs.get("id") !== id)) return false;
  const targetPosition = cellPosition(runtime, rendered);
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
  const binding = node => node.attrs?.get("property") ||
    (node.name === "xform:address" && node.attrs?.get("propertyid") === `extendDataFormInfo.value(${values.id}.id)` &&
      node.attrs?.get("propertyname") === `extendDataFormInfo.value(${values.id}.name)`
      ? `extendDataFormInfo.value(${values.id})` : undefined);
  const editors = runtime.nodes.filter(node => within(node, runtimeValueCell) && binding(node)?.startsWith("extendDataFormInfo.value("));
  if (editors.length !== 1 || !editors[0].selfClosing ||
      !RUNTIME_EDITORS.get(controls[0].attrs.get("fd_type")?.toLowerCase())?.includes(editors[0].name) ||
      binding(editors[0]) !== `extendDataFormInfo.value(${values.id})` ||
      runtime.nodes.filter(node => binding(node) === binding(editors[0])).length !== 1 ||
      !ordinaryAppearance(editors[0].attrs) ||
      !runtimeEditorAncestors(runtime, editors[0], runtimeValueCell) ||
      ["true"].includes(editors[0].attrs.get("showlabel")) ||
      ["false"].includes(editors[0].attrs.get("canshow")) ||
      ["noshow"].includes(editors[0].attrs.get("showstatus"))) return undefined;
  return values.id;
}

function runtimeEditorAncestors(tree, editor, cell) {
  const wrapper = editor.parent;
  if (wrapper?.name !== "label") return unguardedAncestors(editor);
  if (wrapper.parent !== cell || !wrapper.attrs || !ordinaryAppearance(wrapper.attrs) ||
      [...wrapper.attrs.keys()].some(key => !["id", "style", "canshow", "_required"].includes(key)) ||
      wrapper.attrs.has("canshow") && wrapper.attrs.get("canshow") !== "true" ||
      wrapper.attrs.has("_required") && !["true", "false"].includes(wrapper.attrs.get("_required"))) return false;
  const surrounding = tree.raw.slice(wrapper.contentStart, editor.start) + tree.raw.slice(editor.end, wrapper.contentEnd);
  return !surrounding.trim() && unguardedAncestors(wrapper);
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
