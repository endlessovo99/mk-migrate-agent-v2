import { createHash } from "node:crypto";
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
const TABLE_LAYOUT_MODES = new Set(["", "undefined", "default", "true", "false"]);
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

/** Source-only script reach for two uniquely rendered editors in one cell. */
export function inspectOtherPairContexts(designerHtml, runtimeHtml, pairs = []) {
  const result = new Map();
  if (!pairs.length || !String(runtimeHtml || "").trim()) return result;
  const designer = markupTree(designerHtml, true), runtime = markupTree(runtimeHtml);
  if (!designer || !runtime) return result;
  const program = runtimeProgram(runtimeHtml, runtime);
  if (!program.complete) return result;
  for (const pair of pairs) {
    const designerWidget = id => designer.nodes.filter(node => node.attrs?.has("fd_type") &&
      parseDesignerFdValues(node.attrsText).id === id);
    const runtimeWidget = id => runtime.nodes.filter(node =>
      node.attrs?.get("property") === `extendDataFormInfo.value(${id})`);
    const dChoice = designerWidget(pair.choiceId), dText = designerWidget(pair.textId);
    const rChoice = runtimeWidget(pair.choiceId), rText = runtimeWidget(pair.textId);
    if ([dChoice, dText, rChoice, rText].some(nodes => nodes.length !== 1)) continue;
    const choiceType = dChoice[0].attrs.get("fd_type")?.toLowerCase();
    const textType = dText[0].attrs.get("fd_type")?.toLowerCase();
    const renderers = { inputcheckbox: ["xform:checkbox"], checkbox: ["xform:checkbox"],
      inputradio: ["xform:radio", "xform:xradio"], radio: ["xform:radio", "xform:xradio"],
      select: ["xform:select"], inputselect: ["xform:select"] };
    if (!renderers[choiceType]?.includes(rChoice[0].name) || !["inputtext", "text"].includes(textType) || rText[0].name !== "xform:xtext" ||
        [dChoice[0], dText[0], rChoice[0], rText[0]].some(node =>
          node.attrs?.get("canshow") === "false" || node.attrs?.get("showstatus") === "noshow" ||
          /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.attrs?.get("style") || ""))) continue;
    const dCell = nearest(dChoice[0], "td"), rCell = nearest(rChoice[0], "td");
    const dPosition = dCell && cellPosition(designer, dCell), rPosition = rCell && cellPosition(runtime, rCell);
    if (!dCell || !rCell || !dPosition || !rPosition || nearest(dText[0], "td") !== dCell ||
        nearest(rText[0], "td") !== rCell || JSON.stringify(dPosition) !== JSON.stringify(rPosition)) continue;
    const ancestors = new Set(), descendants = new Set([pair.choiceId, pair.textId]);
    let valid = true;
    for (const [tree, cell, nodes] of [[designer, dCell, [dChoice[0], dText[0]]], [runtime, rCell, [rChoice[0], rText[0]]]]) {
      for (const node of nodes) for (let current = node; current; current = current.parent) {
        if (current.invalid) valid = false;
        for (const id of current.identityIds || []) ancestors.add(id);
      }
      for (const id of tree.cellDomains.get(cell) || []) descendants.add(id);
      for (const node of tree.nodes) if (nearest(node, "td") === cell) {
        const id = node.attrs?.get("property")?.match(/^extendDataFormInfo\.value\(([A-Za-z_][\w.-]*)\)$/)?.[1];
        if (id) descendants.add(id);
      }
    }
    if (!valid) continue;
    const inlineScriptDigests = [...new Set(program.scripts.map(script =>
      createHash("sha256").update(script.trim()).digest("hex")))];
    result.set(pair.choiceId, { version: 1, ancestorIds: [...ancestors], cellDescendantIds: [...descendants],
      pairDescendantIds: [...descendants], inlineScriptDigests, inlineDomainComplete: true });
  }
  return result;
}

export function inspectStaticCaptions(designerHtml, runtimeHtml = "") {
  const result = new Map();
  const structures = new Map();
  const structureIssues = new Map();
  const issues = new Map();
  const designer = markupTree(designerHtml, true);
  const runtime = String(runtimeHtml || "").trim() ? markupTree(runtimeHtml) : undefined;
  const globalIssue = !designer ? { reason: "designer_markup_unproven" } :
    String(runtimeHtml || "").trim() && !runtime ? { reason: "runtime_markup_unproven" } : undefined;
  if (globalIssue) return { facts: result, structures, structureIssues, issues, globalIssue };
  const hiddenOwnerIds = runtime ? hiddenRuntimeOwners(runtime) : [];
  const hiddenCompanions = new Set(hiddenOwnerIds.filter(id => runtime.nodes.filter(node =>
    node.attrs?.get("property") === `extendDataFormInfo.value(${id})`).length === 1));
  // Designer HTML also contains editor-only menus/handlers. Runtime programs
  // come from fdDisplayJsp; Designer JSP/control scripts use the source registry.
  const program = runtimeProgram(runtimeHtml, runtime);

  for (const caption of designer.nodes) {
    if (caption.name !== "label" || caption.attrs?.get("fd_type")?.toLowerCase() !== "textlabel") continue;
    const values = parseStaticDesignerStringValues(caption.attrsText, CAPTION_KEYS, new Set(["content"]));
    const terminalBreak = typeof values?.content === "string" && /\r?\n\s*$/.test(values.content);
    const content = plainText(designer, caption, terminalBreak);
    const id = values?.id || parseDesignerFdValues(caption.attrsText).id;
    const structure = fieldCaptionStructure(designer, caption, values, runtime, terminalBreak, program, hiddenCompanions);
    if (id && structure?.issue) structureIssues.set(id, structure.issue);
    else if (id && structure) structures.set(id, structure);
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
      runtimePresent: Boolean(runtime),
      runtimeHiddenOwnerIds: hiddenOwnerIds.length ? hiddenOwnerIds : undefined,
      runtimeOwnerId: runtime && runtimeOwner(designer, caption, values.id, runtime),
      terminalBreakNormalized: terminalBreak || undefined,
      domContext: { ...captionDomContext(designer, caption, runtime, terminalBreak), version: 1,
        inlineScripts: program.scripts, inlineDomainComplete: program.complete,
        ...(program.uninterpretedMetadata.length ? { uninterpretedProgramMetadata: program.uninterpretedMetadata } : {}) } });
  }
  return { facts: result, structures, structureIssues, issues };
}

// This is source relationship evidence, independent of target component choice
// and of whole-program JavaScript proof. A false exporter binding flag is not a
// rendering fact. The literal binding, occupied cells and actual editor agree.
function fieldCaptionStructure(designer, caption, values, runtime, terminalBreak, program, hiddenCompanions) {
  const fail = (reason, details) => ({ issue: { reason, ...details } });
  if (!values || !plainValues(values) || !plainCaption(caption, true) ||
      designer.identities.get(values.id) !== 1 ||
      caption.attrs.has("id") && caption.attrs.get("id") !== values.id) return fail("caption_identity_or_plain_appearance_unproven");
  const content = plainText(designer, caption, terminalBreak);
  if (content !== values.content.trim()) return fail("caption_text_mismatch");
  const cell = nearest(caption, "td"), row = cell && nearest(cell, "tr");
  if (!cell || !row) return fail("caption_cell_missing");
  const cells = designer.nodes.filter(node => node.name === "td" && nearest(node, "tr") === row);
  const body = cells[cells.indexOf(cell) + 1];
  if (!body || cellPosition(designer, caption) === undefined) return fail("caption_position_unproven");
  const within = (node, parent) => { for (let n = node.parent; n; n = n.parent) if (n === parent) return true; return false; };
  const owners = designer.nodes.filter(node => within(node, body) && node.attrs?.has("fd_type") &&
    !["right", "jsp"].includes(node.attrs.get("fd_type").toLowerCase()) &&
    !hiddenCompanions.has(parseDesignerFdValues(node.attrsText).id));
  if (owners.length !== 1) return fail("value_cell_has_multiple_or_missing_editors", { editorCount: owners.length,
    editors: owners.map(node => ({ id: parseDesignerFdValues(node.attrsText).id, type: node.attrs.get("fd_type") })) });
  const owner = owners[0], binding = parseDesignerFdValues(owner.attrsText);
  if (!binding.id || binding._label_bind_id !== values.id ||
      !unguardedAncestors(caption, { owner, standardTitleCell: true }) ||
      !unguardedAncestors({ parent: body }, { owner: caption, standardTitleCell: true })) return fail("source_binding_or_ancestry_unproven");
  let rendered;
  if (runtime) {
    const position = cellPosition(designer, caption);
    const labels = runtime.nodes.filter(node => node.name === "label" &&
      plainText(runtime, node, terminalBreak) === content &&
      JSON.stringify(cellPosition(runtime, node)) === JSON.stringify(position));
    const renderedBody = runtime.nodes.find(node => node.name === "td" &&
      JSON.stringify(cellPosition(runtime, node)) === JSON.stringify(cellPosition(designer, body)));
    if (labels.length !== 1 || !renderedBody || !plainCaption(labels[0], false) ||
        labels[0].attrs.has("id") && labels[0].attrs.get("id") !== values.id ||
        runtime.identities.has(values.id) && runtime.identities.get(values.id) !== 1) return fail("runtime_caption_region_or_text_mismatch");
    const attachmentImports = runtime.nodes.filter(node => within(node, renderedBody) &&
      nativeAttachmentImportKey(runtime, node) === binding.id);
    const editors = runtime.nodes.filter(node => within(node, renderedBody) &&
      !hiddenCompanions.has(node.attrs?.get("property")?.match(/^extendDataFormInfo\.value\(([^)]+)\)$/)?.[1]) &&
      ["property", "propertyid"].some(key => /^extendDataFormInfo\.value\(/.test(node.attrs?.get(key) || ""))).concat(attachmentImports);
    if (editors.length !== 1) return fail("runtime_value_cell_has_multiple_or_missing_editors", { editorCount: editors.length });
    rendered = editors[0];
    const property = rendered.attrs?.get("property");
    const address = rendered.name === "xform:address" &&
      rendered.attrs.get("propertyid") === `extendDataFormInfo.value(${binding.id}.id)` &&
      rendered.attrs.get("propertyname") === `extendDataFormInfo.value(${binding.id}.name)`;
    const rendererTypes = {
      inputtext: ["xform:xtext"], calculation: ["xform:xtext"], textarea: ["xform:textarea"], datetime: ["xform:datetime"],
      select: ["xform:select"], inputselect: ["xform:select"], inputradio: ["xform:radio", "xform:xradio"],
      inputcheckbox: ["xform:checkbox"], address: ["xform:address"], rtf: ["xform:rtf"],
      attachment: ["xform:attachment", "c:import"], chinavalue: ["xform:chinavalue"]
    };
    if (!rendererTypes[owner.attrs.get("fd_type").toLowerCase()]?.includes(rendered.name) ||
        !(address || attachmentImports.includes(rendered) || property === `extendDataFormInfo.value(${binding.id})`) ||
        ["true"].includes(rendered.attrs.get("showlabel")) ||
        rendered.attrs.get("canshow") === "false" || rendered.attrs.get("showstatus") === "noshow" ||
        /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(rendered.attrs.get("style") || "") ||
        !unguardedAncestors(labels[0], { owner: rendered, standardTitleCell: true }) ||
        !unguardedAncestors({ parent: renderedBody }, { owner: labels[0], standardTitleCell: true }) ||
        !plainRuntimeOwnerWrappers(rendered, renderedBody)) return fail("runtime_editor_binding_kind_or_wrapper_unproven", {
          renderer: rendered.name, designerType: owner.attrs.get("fd_type"),
          labelAncestors: unguardedAncestors(labels[0], { owner: rendered, standardTitleCell: true }),
          bodyAncestors: unguardedAncestors({ parent: renderedBody }, { owner: labels[0], standardTitleCell: true }),
          editorWrappers: plainRuntimeOwnerWrappers(rendered, renderedBody)
        });
  } else if (String(binding._label_bind).toLowerCase() !== "true") {
    // Without a runtime export, require an actual non-hidden designer editor.
    const editors = designer.nodes.filter(node => within(node, owner) &&
      ["input", "textarea", "select"].includes(node.name) && node.attrs?.get("id") === binding.id &&
      node.attrs.get("type") !== "hidden");
    if (editors.length !== 1) return fail("inactive_binding_without_rendered_designer_editor");
  }
  const emphasis = ["b", "i", "underline"].filter(key => values[key] === "true");
  return { version: 1, relation: "one-to-one-field-caption", ownerId: binding.id, content,
    plainText: true, unique: true, unguarded: true, ...(emphasis.length ? { emphasis } : {}),
    bindingFlag: binding._label_bind, runtimeRenderer: rendered?.name,
    designerOffset: caption.start, ownerOffset: owner.start,
    permission: permissionAncestors(caption).map(node => parseDesignerFdValues(node.attrsText).id || node.attrs?.get("id")).filter(Boolean),
    domContext: { ...captionDomContext(designer, caption, runtime, terminalBreak), version: 1,
      inlineScripts: program.scripts, inlineDomainComplete: program.complete,
      ...(program.uninterpretedMetadata.length ? { uninterpretedProgramMetadata: program.uninterpretedMetadata } : {}) } };
}

function plainRuntimeOwnerWrappers(editor, cell) {
  for (let node = editor.parent; node && node !== cell; node = node.parent) {
    const appearance = new Map(node.attrs || []);
    appearance.set("style", String(appearance.get("style") || "").split(";").filter(declaration =>
      !/^\s*(?:word-wrap\s*:\s*break-word|word-break\s*:\s*break-all)\s*$/i.test(declaration)).join(";"));
    if (!["label", "div", "span"].includes(node.name) || !node.attrs || !ordinaryAppearance(appearance) ||
        [...node.attrs.keys()].some(key => !["id", "class", "style", "width", "canshow", "_required"].includes(key)) ||
        node.attrs.has("canshow") && node.attrs.get("canshow") !== "true") return false;
  }
  return true;
}

function permissionAncestors(node) {
  const result = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.attrs?.get("fd_type")?.toLowerCase() === "right" || parent.name === "xform:right") result.push(parent);
  }
  return result;
}

const ATTACHMENT_ROOT = "/sys/attachment/sys_att_main/sysAttMain_";
const ATTACHMENT_MODE = "${empty _xformRight ? ((_xformMainForm.method_GET == 'add' || _xformMainForm.method_GET == 'edit') ? 'edit' : 'view') : (_xformRight == 'edit' ? 'edit' : 'view')}";
function nativeAttachmentImportKey(tree, node) {
  if (node.name !== "c:import" || !node.attrs ||
      [...node.attrs.keys()].some(key => !["url", "charencoding"].includes(key)) ||
      node.attrs.has("charencoding") && node.attrs.get("charencoding") !== "UTF-8" ||
      !["edit", "view", ATTACHMENT_MODE].some(mode => node.attrs.get("url") === `${ATTACHMENT_ROOT}${mode}.jsp`)) return undefined;
  const parameters = tree.nodes.filter(param => param.parent === node);
  const values = new Map();
  const known = new Map([["fdAttType", ["byte"]], ["fdMulti", ["true", "false"]], ["fdShowMsg", ["true", "false"]],
    ["fdImgHtmlProperty", [""]], ["fdModelId", ["${_xformMainForm.fdId}"]],
    ["fdModelName", ["${_xformMainForm.modelClass.name}"]], ["formBeanName", ["_xformMainForm"]]]);
  for (const parameter of parameters) {
    const attrs = parameter.attrs, name = attrs?.get("name"), value = attrs?.get("value") || "";
    if (parameter.name !== "c:param" || !attrs || [...attrs.keys()].some(key => !["name", "value"].includes(key)) ||
        values.has(name) || name !== "fdKey" && !known.get(name)?.includes(value)) return undefined;
    values.set(name, value);
  }
  return /^[A-Za-z_][\w.-]*$/.test(values.get("fdKey") || "") ? values.get("fdKey") : undefined;
}

// Collect the runtime independently of the designer-first migration registry.
// Masked text controls can carry handlers too; unknown attributes cannot be
// treated as an empty program. Script/textarea bodies are HTML raw text.
function runtimeProgram(input, tree) {
  const html = String(input || ""), scripts = new Set(), uninterpretedMetadata = [];
  let complete = true, skipUntil = 0;
  for (const token of scanHtmlTags(html)) {
    if (token.closing || token.start < skipUntil) continue;
    // The native toolbar exports a static JSP URL inside a quoted src. Resolve
    // only its exact icon declaration before parsing the complete attribute set.
    const attributes = token.name === "img" ? token.attrs.replace(
      /<c:url\s+value=(["'])(\/resource\/style\/default\/icons\/(?:add|delete|up|down)\.gif)\1\s*\/>/g,
      (_, _quote, path) => path) : token.attrs;
    let attrs = parseStaticMarkupAttributes(attributes, token.name === "table" ? RUNTIME_TABLE_DUPLICATES : undefined) ||
      parseDesignerControlAttributes(attributes);
    if (!attrs) {
      // Permission/table metadata is not executable text. Inventory every
      // attribute without choosing its rendering meaning; the independent
      // markup/ownership parser still rejects these conflicts in that region.
      const metadata = new Map();
      if (token.name === "table") metadata.set("tablename", /^[A-Za-z_][\w.-]*$/);
      if (token.name === "xform:right") for (const match of attributes.matchAll(/\b((?:mode|def)_(?:n\d+|g|d))\s*=/gi)) {
        metadata.set(match[1].toLowerCase(), /^def_/i.test(match[1]) ? /^(?:true|false)$/ : /^(?:edit|view|hidden)$/);
      }
      if (metadata.size) {
        attrs = parseStaticMarkupAttributes(attributes, token.name === "table" ? RUNTIME_TABLE_DUPLICATES : undefined, metadata);
        if (attrs) uninterpretedMetadata.push({ tag: token.name, offset: token.start, keys: [...metadata.keys()],
          basis: "program-inventory-only-not-rendering-ownership" });
      }
    }
    if (!attrs) complete = false;
    if (token.name === "c:import" && (!tree || !tree.nodes.some(node => node.start === token.start && nativeAttachmentImportKey(tree, node)))) complete = false;
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
  return { complete, scripts: [...scripts].filter(Boolean), uninterpretedMetadata };
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
  const ancestorIds = new Set(), cellDescendantIds = new Set(), pairDescendantIds = new Set();
  const ids = node => node.identityIds || [];
  const collect = (tree, node) => {
    if (!node) return;
    const cell = nearest(node, "td"), row = cell?.parent;
    const cells = tree.nodes.filter(item => item.parent === row && item.name === "td");
    for (const pairCell of [cell, cells[cells.indexOf(cell) + 1]].filter(Boolean)) {
      for (const id of tree.cellDomains.get(pairCell) || []) pairDescendantIds.add(id);
    }
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
  return { ancestorIds: [...ancestorIds], cellDescendantIds: [...cellDescendantIds], pairDescendantIds: [...pairDescendantIds] };
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
  let html = staticSourceMarkup(raw);
  if (html === undefined || hasUnmodeledPresentationCode(raw, designer)) return undefined;
  // Textarea bodies remain opaque text, but their opening renderer/binding is
  // real source structure. Restore only tag boundaries, never their content.
  let skipUntil = 0;
  for (const token of scanHtmlTags(raw)) {
    if (token.start < skipUntil || token.closing || token.selfClosing ||
        !["script", "style", "textarea", "xform:textarea", "pre", "code"].includes(token.name)) continue;
    const close = new RegExp(`<\\/\\s*${token.name}\\s*>`, "ig"); close.lastIndex = token.end;
    const end = close.exec(raw);
    if (!end) return undefined;
    skipUntil = close.lastIndex;
    if (!["textarea", "xform:textarea"].includes(token.name)) continue;
    html = html.slice(0, token.start) + raw.slice(token.start, token.end) + html.slice(token.end, end.index) +
      raw.slice(end.index, close.lastIndex) + html.slice(close.lastIndex);
  }
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
    // Bold, italic and underline are title emphasis. They do not make the label
    // a second control. Color, font family and effects stay protected.
    ["b", "i", "underline"].every(key => [undefined, "", "false", "true"].includes(values[key])) &&
    [undefined, "", "true"].includes(values.canShow) &&
    (values.width === undefined || dimension(values.width));
}

function plainText(tree, node, terminalBreak = false) {
  const content = tree.raw.slice(node.contentStart, node.contentEnd).trim();
  const raw = terminalBreak ? content.replace(/<br\s*\/?\s*>(?:\s|&nbsp;|&#160;|&#x0*a0;)*$/i, "").trim() : content;
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

function unguardedAncestors(node, { owner, standardTitleCell = false } = {}) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    const attrs = parent.attrs;
    if (owner && permissionAncestors(node).includes(parent) && permissionAncestors(owner).includes(parent)) {
      if (!attrs || [...attrs].some(([key, value]) => /^on/i.test(key) || /\$\{|#\{|<%/.test(value)) ||
          !ordinaryAppearance(attrs)) return false;
      continue;
    }
    if (parent.invalid || !CONTAINER_TAGS.has(parent.name) || parent.name === "thead" || !attrs ||
        !containerAttributes(parent) ||
        !ordinaryAppearance(attrs, false, standardTitleCell && parent.name === "td")) return false;
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
      ? /^(?:left|center|right)$/i : standardTitleCell && parent.name === "td"
        ? /^(?:left|center)$/i : /^left$/i).test(attrs.get("align"))) return false;
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
  if (attrs.has("layout2col") && !TABLE_LAYOUT_MODES.has(attrs.get("layout2col"))) return false;
  if (!attrs.has("fd_values")) return true;
  const values = parseStaticDesignerStringValues(node.attrsText, new Set(["id", "label", "layout2col"]));
  return Boolean(values && (values.layout2col === undefined || TABLE_LAYOUT_MODES.has(values.layout2col) &&
    (!attrs.has("layout2col") || attrs.get("layout2col") === values.layout2col)));
}

function ordinaryAppearance(attrs, caption = false, standardTitleCell = false) {
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
    if (standardTitleCell && key === "text-align" && /^center$/i.test(value)) continue;
    if (key === "text-decoration" && /^none$/i.test(value)) continue;
    if (caption && key === "font-size" && /^14px$/i.test(value)) continue;
    if (["font-weight", "font-style"].includes(key) && /^normal$/i.test(value)) continue;
    if (caption && key === "font-weight" && /^(?:bold|[5-9]00)$/i.test(value)) continue;
    if (caption && key === "font-style" && /^italic$/i.test(value)) continue;
    if (caption && key === "text-decoration" && /^underline$/i.test(value)) continue;
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
  // Only disjoint, physically verified spans may coexist with this cell. A
  // declared column alone cannot override the browser's occupied columns.
  const rowIndex = rows.indexOf(row);
  const active = [];
  for (let index = 0; index <= rowIndex; index++) {
    for (const item of tree.nodes.filter(candidate => ["td", "th"].includes(candidate.name) && candidate.parent === rows[index])) {
      const span = item.attrs?.get("rowspan") || "1";
      if (!/^[1-9]\d*$/.test(span)) return undefined;
      if (index + Number(span) > rowIndex && span !== "1") active.push(item);
    }
  }
  if (active.length) {
    const columns = physicalCellColumns(tree, table, rows), current = columns.get(cell);
    const agrees = item => {
      const physical = columns.get(item), declared = item.attrs?.get("column")?.split(",");
      return physical && declared && [1, physical.colspan].includes(declared.length) &&
        declared.every((value, index) => /^(?:0|[1-9]\d*)$/.test(value) && Number(value) === physical.column + index);
    };
    if (!current || !agrees(cell) || active.some(item => {
      const other = columns.get(item);
      return !agrees(item) || current.column < other.column + other.colspan && other.column < current.column + current.colspan;
    })) return undefined;
  }
  return { table: tableId || tree.nodes.filter(item => item.name === "table").indexOf(table),
    row: rowIndex, cell: cells.indexOf(cell), colspan: cell.attrs?.get("colspan") || "1",
    sourceRow: cell.attrs?.get("row"), sourceColumn: cell.attrs?.get("column") };
}

function physicalCellColumns(tree, table, rows) {
  tree.physicalColumns ||= new Map();
  if (tree.physicalColumns.has(table)) return tree.physicalColumns.get(table);
  const result = new Map(), occupied = new Map();
  for (const [index, row] of rows.entries()) {
    let column = 0, valid = !row.invalid;
    const pending = [];
    for (const cell of tree.nodes.filter(node => ["td", "th"].includes(node.name) && node.parent === row)) {
      while ((occupied.get(column) || 0) > index && column < 128) column++;
      const spanText = [cell.attrs?.get("colspan") || "1", cell.attrs?.get("rowspan") || "1"];
      const [colspan, rowspan] = spanText.map(Number);
      if (!spanText.every(value => /^[1-9]\d*$/.test(value)) || ![colspan, rowspan].every(Number.isSafeInteger) ||
          column + colspan > 128 || index + rowspan > rows.length ||
          Array.from({ length: colspan }, (_, offset) => column + offset).some(value => (occupied.get(value) || 0) > index)) {
        valid = false; break;
      }
      pending.push([cell, { column, colspan }]);
      for (let offset = 0; offset < colspan; offset++) occupied.set(column + offset, index + rowspan);
      column += colspan;
    }
    if (!valid) break;
    pending.forEach(([cell, position]) => result.set(cell, position));
  }
  tree.physicalColumns.set(table, result);
  return result;
}

function nearest(node, name) {
  for (let parent = node.parent; parent; parent = parent.parent) if (parent.name === name) return parent;
}
