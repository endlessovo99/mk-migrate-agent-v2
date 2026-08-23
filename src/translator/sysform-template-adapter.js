import { basename } from "node:path";
import { DSL_VERSION } from "../dsl/schema.js";
import { auditFunctionWhitelist, functionWhitelistErrors } from "./function-whitelist.js";
import { buildDesignerFirstForm } from "./sysform-designer-layout.js";
import { extractSysFormJspScripts } from "./sysform-jsp-scripts.js";
import { parseMetadataXml } from "./sysform-metadata.js";
import { extractSysFormNodeDataAuthorities } from "./sysform-rights.js";
import {
  attrValue,
  cleanText,
  decodeEntities,
  parseFdValues,
  parseRootHashMapStringPuts,
  propertyFieldId
} from "./xml-utils.js";

export function translateSysFormTemplateXml(xml, options = {}) {
  const template = parseSysFormTemplateXml(xml);
  const metadata = parseMetadataXml(template.fdMetadataXml || "");
  const warnings = [];
  const preliminaryNodeDataAuthorities = extractSysFormNodeDataAuthorities(template, {
    knownFieldIds: collectMetadataFieldIds(metadata)
  });
  const form = buildDesignerFirstForm(template.fdDesignerHtml || "", metadata, warnings, {
    runtimeVisibleFieldIds: unconditionallyRenderedRichTextFieldIds(
      template.fdDisplayJsp || ""
    ),
    nodeDataAuthorityVisibleFieldIds: visibleNodeDataAuthorityFieldIds(
      preliminaryNodeDataAuthorities.nodeDataAuthorities
    )
  });
  const nodeDataAuthorities = extractSysFormNodeDataAuthorities(template, {
    knownFieldIds: collectDataAuthorityFieldIds(form)
  });
  if (Object.keys(nodeDataAuthorities.nodeDataAuthorities || {}).length) {
    form.nodeDataAuthorities = nodeDataAuthorities.nodeDataAuthorities;
  }
  const title = String(options.templateName || "").trim() ||
    template.fdName ||
    extractDesignerTitle(template.fdDesignerHtml || "") ||
    basename(options.sourcePath || "SysFormTemplate.xml").replace(/_SysFormTemplate\.xml$/i, "");
  const errors = [];
  const functionWhitelist = options.functionWhitelist
    ? auditFunctionWhitelist(template.fdDesignerHtml || "", options.functionWhitelist, { path: "/fdDesignerHtml" })
    : undefined;
  const scripts = extractSysFormJspScripts(template, { functionWhitelist: options.functionWhitelist });

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
    /^extendDataFormInfo\.value\(([A-Za-z_][\w-]*)\)$/
  );
  return match?.[1] || propertyFieldId(property);
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
