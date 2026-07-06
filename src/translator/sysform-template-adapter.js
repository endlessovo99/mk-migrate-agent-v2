import { basename } from "node:path";
import { DSL_VERSION } from "../dsl/schema.js";
import { auditFunctionWhitelist, functionWhitelistErrors } from "./function-whitelist.js";
import { buildDesignerFirstForm } from "./sysform-designer-layout.js";
import { extractSysFormJspScripts } from "./sysform-jsp-scripts.js";
import { parseMetadataXml } from "./sysform-metadata.js";
import { cleanText, decodeEntities, parseFdValues } from "./xml-utils.js";

export function translateSysFormTemplateXml(xml, options = {}) {
  const template = parseSysFormTemplateXml(xml);
  const metadata = parseMetadataXml(template.fdMetadataXml || "");
  const warnings = [];
  const form = buildDesignerFirstForm(template.fdDesignerHtml || "", metadata, warnings);
  const title = extractDesignerTitle(template.fdDesignerHtml || "") ||
    template.fdName ||
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
    errors.push(...functionWhitelistErrors(functionWhitelist, "/fdDesignerHtml"));
  }
  for (const source of scripts?.sources || []) {
    if (source.functionAudit?.violations?.length) {
      errors.push(...functionWhitelistErrors(source.functionAudit, source.sourceRef));
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

export function parseSysFormTemplateXml(xml = "") {
  const values = {};
  const putPattern = /<void\s+method=["']put["']>\s*<string>([^<]*?)<\/string>\s*<string>([\s\S]*?)<\/string>\s*<\/void>/g;
  for (const match of xml.matchAll(putPattern)) {
    const key = decodeEntities(match[1]);
    if (values[key] === undefined) {
      values[key] = decodeEntities(match[2]);
    }
  }
  return values;
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
