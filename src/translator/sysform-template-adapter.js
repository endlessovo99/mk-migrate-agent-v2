import { basename } from "node:path";
import { DSL_VERSION } from "../dsl/schema.js";
import { auditFunctionWhitelist, functionWhitelistErrors } from "./function-whitelist.js";
import { buildDesignerFirstForm } from "./sysform-designer-layout.js";
import { isVoidLikeTag, scanHtmlTags } from "./designer-html-tokenizer.js";
import { parseStaticMarkupAttributes, staticSourceMarkup } from "./source-static-markup.js";
import { extractSysFormJspScripts } from "./sysform-jsp-scripts.js";
import { parseMetadataXml } from "./sysform-metadata.js";
import { extractSysFormNodeDataAuthorities } from "./sysform-rights.js";
import { mainStringValueBindingFacts } from "./main-string-value-binding.js";
import { approvedRemoteSelectorSourceFacts,remoteSelectorOmissionSourceFacts } from "./approved-remote-policies.js";
import { remoteSelectorSourceContracts } from "./remote-selector-source-contract.js";
import { analyzeOrphanBeforeAnchorWitness } from "./orphan-before-anchor-witness.js";
import { annotateChinaValueReadOnly, attachClosedMainFieldFacts } from "./closed-main-field-effects.js";
import { sourceFormRadioOrdinalFact } from "./approved-radio-ordinal-policy.js";
import {
  attrValue,
  cleanText,
  decodeEntities,
  parseFdValues,
  parseRootHashMapStringPuts,
  parseRootHashMapXmlStringPuts,
  propertyFieldId
} from "./xml-utils.js";

export function translateSysFormTemplateXml(xml, options = {}) {
  const template = parseSysFormTemplateXml(xml);
  const literalTemplate = parseRootHashMapXmlStringPuts(xml);
  const scripts = extractSysFormJspScripts(template, { functionWhitelist: options.functionWhitelist });
  const metadata = parseMetadataXml(template.fdMetadataXml || "");
  const warnings = [];
  const errors = [];
  const preliminaryNodeDataAuthorities = extractSysFormNodeDataAuthorities(template, {
    knownFieldIds: collectMetadataFieldIds(metadata)
  });
  const form = buildDesignerFirstForm(template.fdDesignerHtml || "", metadata, warnings, {
    errors,
    runtimeDisplayHtml: template.fdDisplayJsp || "",
    trailingBlankSource: { designer: literalTemplate.fdDesignerHtml || "", runtime: literalTemplate.fdDisplayJsp || "",
      scriptFragments: scripts?.fragments, scriptSources: scripts?.sources },
    runtimeVisibleFieldIds: unconditionallyRenderedRichTextFieldIds(
      template.fdDisplayJsp || ""
    ),
    nodeDataAuthorityVisibleFieldIds: visibleNodeDataAuthorityFieldIds(
      preliminaryNodeDataAuthorities.nodeDataAuthorities
    ),
    editorLabelEvidence: editorLabelEvidence(template.fdDisplayJsp || "")
  });
  const nodeDataAuthorities = extractSysFormNodeDataAuthorities(template, {
    knownFieldIds: collectDataAuthorityFieldIds(form)
  });
  annotateChinaValueReadOnly(form, template);
  attachClosedMainFieldFacts(template, scripts, form);
  const radioOrdinalDomain = sourceFormRadioOrdinalFact(template, form);
  if (radioOrdinalDomain) for (const source of scripts?.sources || []) source.semanticFacts.sourceFormRadioOrdinalDomain = radioOrdinalDomain;
  const mainValueBindings = mainStringValueBindingFacts(template);
  for (const field of [...(form.fields || []), ...(form.dataFields || [])]) {
    if (field.type === "detailTable" || !mainValueBindings[field.id]) continue;
    field.source = { ...field.source, mainStringValueBindingFact: mainValueBindings[field.id] };
  }
  const remoteContracts = remoteSelectorSourceContracts(template), remoteRuntimeFacts = approvedRemoteSelectorSourceFacts(template), remoteOmissionFacts = remoteSelectorOmissionSourceFacts(template);
  for (const field of [...(form.fields || []), ...(form.dataFields || [])]) {
    if (remoteContracts[field.id]) field.source = { ...field.source, remoteSelectorSourceContract: remoteContracts[field.id], ...(remoteOmissionFacts[field.id]?{remoteSelectorOmissionSourceFact:remoteOmissionFacts[field.id]}:{}), ...(remoteRuntimeFacts[field.id] ? {approvedRemoteSelectorSourceFact:remoteRuntimeFacts[field.id]}:{}) };
    for (const column of field.columns || []) {
      const fact = remoteContracts[`${field.id}.${column.id}`];
      if (fact) column.source = { ...column.source, remoteSelectorSourceContract: fact, ...(remoteOmissionFacts[`${field.id}.${column.id}`]?{remoteSelectorOmissionSourceFact:remoteOmissionFacts[`${field.id}.${column.id}`]}:{}), ...(remoteRuntimeFacts[`${field.id}.${column.id}`] ? {approvedRemoteSelectorSourceFact:remoteRuntimeFacts[`${field.id}.${column.id}`]}:{}) };
    }
  }
  for (const source of scripts?.sources || []) {
    const witness = analyzeOrphanBeforeAnchorWitness(source, form, { sourceScripts: scripts, rawMarkup: template });
    if (witness) source.semanticFacts.orphanBeforeAnchorWitness = witness;
  }
  if (Object.keys(nodeDataAuthorities.nodeDataAuthorities || {}).length) {
    form.nodeDataAuthorities = nodeDataAuthorities.nodeDataAuthorities;
  }
  const title = String(options.templateName || "").trim() ||
    template.fdName ||
    extractDesignerTitle(template.fdDesignerHtml || "") ||
    basename(options.sourcePath || "SysFormTemplate.xml").replace(/_SysFormTemplate\.xml$/i, "");
  const functionWhitelist = options.functionWhitelist
    ? auditFunctionWhitelist(template.fdDesignerHtml || "", options.functionWhitelist, { path: "/fdDesignerHtml" })
    : undefined;

  if (!template.fdDesignerHtml) {
    warnings.push({
      code: "source.sysform.designer_html_missing",
      message: "SysFormTemplate XML does not contain fdDesignerHtml.",
      path: "/fdDesignerHtml"
    });
  }

  if (metadata.fields.length === 0) {
    warnings.push({
      code: "source.sysform.metadata_fields_missing",
      message: "SysFormTemplate metadata did not expose any fields.",
      path: "/fdMetadataXml"
    });
  }

  if (functionWhitelist?.violations.length) {
    warnings.push(...functionWhitelistErrors(functionWhitelist, "/fdDesignerHtml"));
  }
  warnings.push(...nodeDataAuthorities.warnings);
  errors.push(...nodeDataAuthorities.errors);
  for (const source of scripts?.sources || []) {
    if (source.functionAudit?.violations?.length) {
      warnings.push(...functionWhitelistErrors(source.functionAudit, source.sourceRef));
    }
  }

  return {
    version: DSL_VERSION,
    source: {
      kind: "sysform-template-xml",
      path: options.sourcePath,
      fdId: template.fdId,
      fdTemplateEdition: template.fdTemplateEdition,
      fdModelName: template.fdModelName,
      fdModelId: template.fdModelId
    },
    template: {
      name: title,
      categoryPath: options.categoryPath || ""
    },
    form,
    scripts,
    review: {
      warnings,
      ...(errors.length ? { errors } : {}),
      ...(functionWhitelist ? { functionWhitelist } : {})
    }
  };
}

function collectMetadataFieldIds(metadata = {}) {
  const ids = new Set();
  for (const field of metadata.fields || []) {
    if (field?.id) ids.add(field.id);
    for (const column of field?.columns || []) {
      if (column?.id) ids.add(column.id);
    }
  }
  return ids;
}

function visibleNodeDataAuthorityFieldIds(nodes = {}) {
  const ids = new Set();
  for (const node of Object.values(nodes || {})) {
    for (const [fieldId, authority] of Object.entries(node?.fields || {})) {
      if (["view", "edit"].includes(authority?.mode)) ids.add(fieldId);
    }
  }
  return ids;
}

function collectDataAuthorityFieldIds(form = {}) {
  const ids = new Set();
  for (const field of [...(form.fields || []), ...(form.dataFields || [])]) {
    if (field?.id) ids.add(field.id);
    if (field?.type !== "detailTable") continue;
    for (const column of field.columns || []) {
      if (column?.id) ids.add(column.id);
    }
  }
  return ids;
}

export function parseSysFormTemplateXml(xml = "") {
  return parseRootHashMapStringPuts(xml);
}

function unconditionallyRenderedRichTextFieldIds(displayJsp = "") {
  const ids = new Set();
  const conditionalTags = new Set([
    "c:choose",
    "c:foreach",
    "c:if",
    "c:otherwise",
    "c:when",
    "xform:editshow",
    "xform:right",
    "xform:viewshow"
  ]);
  let conditionalDepth = 0;
  const decoded = decodeEntities(displayJsp);
  const tagPattern = /<(\/?)([A-Za-z][\w-]*):([\w-]+)\b([^>]*)>/gi;

  for (const match of decoded.matchAll(tagPattern)) {
    const closing = match[1] === "/";
    const name = `${match[2]}:${match[3]}`.toLowerCase();
    const selfClosing = /\/\s*$/.test(match[4]);
    if (conditionalTags.has(name)) {
      conditionalDepth = Math.max(
        0,
        conditionalDepth + (closing ? -1 : (selfClosing ? 0 : 1))
      );
      continue;
    }
    if (
      closing ||
      name !== "xform:rtf" ||
      conditionalDepth > 0
    ) {
      continue;
    }

    const fieldId = displayJspFieldId(attrValue(match[4], "property"));
    if (fieldId) ids.add(fieldId);
  }

  return ids;
}

function displayJspFieldId(property = "") {
  const match = String(property).match(
    /^extendDataFormInfo\.value\(([A-Za-z_][\w-]*(?:\.name)?)\)$/
  );
  return match?.[1] || propertyFieldId(property);
}

function editorLabelEvidence(displayJsp) {
  const decoded = decodeEntities(displayJsp);
  const editors = new Set(["xform:rtf", "xform:textarea", "xform:xtext", "xform:address", "xform:radio"]);
  const conditionalTags = new Set([
    "c:choose", "c:foreach", "c:if", "c:otherwise", "c:when",
    "xform:editshow", "xform:viewshow"
  ]);
  // xform:right controls access to its child; it does not add an editor label.
  // Its permission modes remain source evidence for the workflow authority path.
  const rows = [];
  const rowStack = [];
  const renderings = new Map();
  let conditionalDepth = 0;
  const staticEvidence = staticJspLabelEvidence(displayJsp, editors, conditionalTags);
  for (const token of scanHtmlTags(decoded)) {
    if (conditionalTags.has(token.name)) {
      conditionalDepth = Math.max(0, conditionalDepth + (
        token.closing ? -1 : token.selfClosing ? 0 : 1
      ));
    }
    if (token.name === "tr") {
      if (!token.closing) rowStack.push(token.start);
      else if (rowStack.length) rows.push({ start: rowStack.pop(), end: token.end });
    }
    if (token.closing || !editors.has(token.name)) continue;
    const addressId = attrValue(token.attrs, "propertyId").match(/^extendDataFormInfo\.value\(([A-Za-z_][\w-]*)\.id\)$/)?.[1];
    const addressName = attrValue(token.attrs, "propertyName").match(/^extendDataFormInfo\.value\(([A-Za-z_][\w-]*)\.name\)$/)?.[1];
    const id = token.name === "xform:address"
      ? (addressId && addressId === addressName ? addressId : undefined)
      : displayJspFieldId(attrValue(token.attrs, "property"));
    if (!id) continue;
    const entries = renderings.get(id) || [];
    entries.push({
      renderer: token.name,
      offset: token.start,
      unconditional: conditionalDepth === 0 &&
        attrValue(token.attrs, "showStatus").toLowerCase() !== "noshow" &&
        attrValue(token.attrs, "showLabel").toLowerCase() !== "true"
    });
    renderings.set(id, entries);
  }
  return new Map([...renderings].map(([id, entries]) => {
    const entry = entries[0];
    const row = rows.filter((item) => item.start <= entry.offset && entry.offset < item.end)
      .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
    const rowHtml = row ? decoded.slice(row.start, row.end) : "";
    const hasJsp = rowHtml.includes("<%");
    const staticEntry = hasJsp && staticEvidence?.get(id);
    return [id, {
      renderer: entry.renderer,
      verified: entries.length === 1 && entry.unconditional && Boolean(rowHtml) && (
        hasJsp ? staticEntry?.renderer === entry.renderer : true
      ),
      conditionalRow: [...scanHtmlTags(rowHtml)].some(token => conditionalTags.has(token.name)),
      rowText: cleanText(rowHtml),
      ...(hasJsp ? { staticCaptions: staticEntry?.captions || [] } : {}),
      sourceRef: "source.form.fdDisplayJsp"
    }];
  }));
}

// This proof only extends rows previously rejected for containing JSP. Other rows
// retain the existing caption contract. Scan original markup so escaped examples
// cannot become renderer or caption tokens through another entity decode.
function staticJspLabelEvidence(displayJsp, editors, conditionalTags) {
  const html = staticSourceMarkup(displayJsp);
  if (html === undefined) return undefined;
  const stack = [], nodes = [], bindings = new Map();
  for (const token of scanHtmlTags(html)) {
    if (token.closing) {
      const node = stack.pop();
      if (!node || node.name !== token.name) return undefined;
      node.contentEnd = token.start;
      node.end = token.end;
      continue;
    }
    const attrs = parseStaticMarkupAttributes(token.attrs);
    const uncertain = !attrs || conditionalTags.has(token.name) ||
      token.name.includes(":") && !editors.has(token.name) && token.name !== "xform:right" ||
      attrs.has("hidden") || ["false", "noshow"].includes(attrs.get("canshow")?.toLowerCase()) ||
      attrs.get("showstatus")?.toLowerCase() === "noshow" ||
      !staticCaptionAppearance(attrs) ||
      [...attrs].some(([key, value]) => /\$\{|<%/.test(value) && !(editors.has(token.name) && key === "showstatus"));
    const parent = stack.at(-1);
    const node = { ...token, attrs, parent, children: [], visible: !uncertain && (!parent || parent.visible), contentStart: token.end, contentEnd: token.end, end: token.end };
    parent?.children.push(node);
    nodes.push(node);
    const property = attrs?.get("property");
    const binding = property?.match(/^extendDataFormInfo\s*\.\s*value\s*\(\s*([A-Za-z_][\w-]*)\s*\)$/)?.[1];
    if (binding) bindings.set(binding, [...(bindings.get(binding) || []), node]);
    if (!attrs && /(?:^|\s)property\s*=/i.test(token.attrs)) return undefined;
    if (!token.selfClosing && !isVoidLikeTag(token.name)) stack.push(node);
  }
  if (stack.length) return undefined;
  const result = new Map();
  for (const node of nodes) {
    if (!editors.has(node.name) || !node.visible || !node.attrs) continue;
    const property = node.attrs.get("property");
    const id = property?.match(/^extendDataFormInfo\.value\(([A-Za-z_][\w-]*)\)$/)?.[1];
    const status = node.attrs.get("showstatus"), label = node.attrs.get("showlabel");
    const inner = parseStaticMarkupAttributes(node.attrs.get("htmlelementproperties") || "");
    if (!id || bindings.get(id)?.length !== 1 || (node.name === "xform:xtext" && !node.selfClosing) ||
        !inner || !staticCaptionAppearance(inner) || inner.has("hidden") ||
        ![undefined, "", "false"].includes(label?.toLowerCase()) ||
        !(status === undefined || status === "" || /^\$\{requestScope\[(["'])SysForm\.showStatus\1\]\}$/.test(status))) continue;
    let cell = node.parent;
    while (cell && !["td", "th"].includes(cell.name)) cell = cell.parent;
    const row = cell?.parent;
    if (!cell || row?.name !== "tr") continue;
    const cells = row.children.filter(child => ["td", "th"].includes(child.name));
    const previous = cells[cells.indexOf(cell) - 1];
    if (!previous?.visible) continue;
    const captions = nodes.filter(caption => {
      if (caption.name !== "label" || !caption.visible || caption.selfClosing) return false;
      let ancestor = caption.parent;
      while (ancestor && ancestor !== previous && ancestor.name !== "table") ancestor = ancestor.parent;
      return ancestor === previous;
    }).filter(caption => {
      const descendants = nodes.filter(child => child.start > caption.start && child.start < caption.end);
      return descendants.every(child => child.visible) && !/\$\{|<%/.test(html.slice(caption.contentStart, caption.contentEnd));
    }).map(caption => decodeEntities(html.slice(caption.contentStart, caption.contentEnd).replace(/<[^>]*>/g, ""))
      .replace(/\s+/g, " ").trim()).filter(Boolean);
    result.set(id, { renderer: node.name, captions });
  }
  return result;
}

function staticCaptionAppearance(attrs) {
  if (!attrs) return false;
  const dimension = value => /^(?:auto|\d+(?:\.\d+)?(?:px|%)?)$/i.test(value) &&
    (value.toLowerCase() === "auto" || Number.parseFloat(value) > 0);
  if (["width", "height"].some(key => attrs.has(key) && !dimension(attrs.get(key)))) return false;
  const values = {
    width: dimension,
    height: dimension,
    display: value => /^(?:inline|inline-block|block|table|table-row|table-cell|table-row-group)$/i.test(value),
    "vertical-align": value => /^(?:top|middle|bottom|baseline)$/i.test(value),
    "text-align": value => /^(?:left|right|center|justify|start|end)$/i.test(value),
    "text-decoration": value => /^(?:none|underline|line-through)$/i.test(value),
    "font-weight": value => /^(?:normal|bold|[1-9]00)$/i.test(value),
    "font-style": value => /^(?:normal|italic|oblique)$/i.test(value)
  };
  const seen = new Set();
  for (const declaration of (attrs.get("style") || "").split(";")) {
    if (!declaration.trim()) continue;
    const match = /^\s*([-a-z]+)\s*:\s*([^:]+?)\s*$/i.exec(declaration);
    const key = match?.[1].toLowerCase();
    if (!match || seen.has(key) || !Object.hasOwn(values, key) || !values[key](match[2])) return false;
    seen.add(key);
  }
  return true;
}

function extractDesignerTitle(html = "") {
  const decoded = decodeEntities(html);
  for (const match of decoded.matchAll(/<[^>]*\bfd_type=["']textLabel["'][^>]*>|<[^>]*\bfd_values=(["'])([\s\S]*?)\1[^>]*>/gi)) {
    const tag = match[0];
    if (!/\bfd_type=["']textLabel["']/i.test(tag)) continue;
    const valuesMatch = tag.match(/\bfd_values=(["'])([\s\S]*?)\1/i);
    if (!valuesMatch) continue;
    const values = parseFdValues(valuesMatch[2]);
    if (values.b === "true" && values.content) return cleanText(values.content);
  }
  return "";
}
