import { basename } from "node:path";
import { DSL_VERSION } from "../dsl/schema.js";

export function translateSysFormTemplateXml(xml, options = {}) {
  const template = parseSysFormTemplateXml(xml);
  const metadata = parseMetadataXml(template.fdMetadataXml || "");
  const title = extractDesignerTitle(template.fdDesignerHtml || "") ||
    template.fdName ||
    basename(options.sourcePath || "SysFormTemplate.xml").replace(/_SysFormTemplate\.xml$/i, "");
  const warnings = [];

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
    form: {
      fields: metadata.fields
    },
    review: {
      warnings
    }
  };
}

export function parseSysFormTemplateXml(xml = "") {
  const values = {};
  const putPattern = /<void\s+method=["']put["']>\s*<string>([\s\S]*?)<\/string>\s*<string>([\s\S]*?)<\/string>\s*<\/void>/g;
  for (const match of xml.matchAll(putPattern)) {
    const key = decodeEntities(match[1]);
    if (values[key] === undefined) {
      values[key] = decodeEntities(match[2]);
    }
  }
  return values;
}

export function parseMetadataXml(metadataXml = "") {
  const xml = decodeEntities(metadataXml);
  const fields = [];
  const tableRanges = [];

  for (const tableMatch of xml.matchAll(/<extendSubTableProperty\b([^>]*)>([\s\S]*?)<\/extendSubTableProperty>/gi)) {
    tableRanges.push([tableMatch.index, tableMatch.index + tableMatch[0].length]);
    const attrs = parseXmlAttributes(tableMatch[1]);
    const columns = extractSimpleProperties(tableMatch[2]).map(metadataFieldToDslField);
    fields.push({
      id: attrs.name,
      title: attrs.label || attrs.name,
      type: "detailTable",
      required: attrs.notNull === "true",
      columns
    });
  }

  const mainXml = removeRanges(xml, tableRanges);
  for (const property of extractSimpleProperties(mainXml)) {
    fields.push(metadataFieldToDslField(property));
  }

  return { fields };
}

function extractSimpleProperties(xml = "") {
  return [...xml.matchAll(/<extend(Simple|Element)Property\b([^/>]*?)\/>/gi)]
    .map((match) => ({
      ...parseXmlAttributes(match[2]),
      kind: match[1] === "Element" ? "element" : "simple"
    }))
    .filter((item) => item.name);
}

function metadataFieldToDslField(property) {
  const options = parseOptions(property.enumValues);
  return {
    id: property.name,
    title: property.label || property.name,
    type: inferDslFieldType(property, options),
    required: property.notNull === "true",
    ...(options.length ? { options } : {})
  };
}

function inferDslFieldType(property, options) {
  if (options.length) return "singleSelect";
  const type = String(property.type || property.dataType || "").toLowerCase();
  if (["double", "float", "integer", "long", "number", "bigdecimal"].includes(type)) return "number";
  if (type.includes("date")) return "date";
  return "text";
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

function parseFdValues(value = "") {
  const result = {};
  for (const match of decodeEntities(value).matchAll(/([\w$]+)\s*:\s*"([^"]*)"/g)) {
    result[match[1]] = decodeEntities(match[2]);
  }
  return result;
}

function parseOptions(value = "") {
  const text = decodeEntities(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text) return [];
  return text
    .split(/\n|;/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [label, optionValue] = item.includes("|") ? item.split("|", 2) : [item, item];
      return { label: cleanText(label), value: cleanText(optionValue) };
    })
    .filter((item) => item.label && item.value);
}

function parseXmlAttributes(text = "") {
  const result = {};
  for (const match of text.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    result[match[1]] = decodeEntities(match[3]);
  }
  return result;
}

function removeRanges(text, ranges) {
  if (!ranges.length) return text;
  let result = "";
  let cursor = 0;
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    result += text.slice(cursor, start);
    cursor = end;
  }
  return result + text.slice(cursor);
}

function cleanText(value = "") {
  return decodeEntities(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function decodeEntities(value = "") {
  return String(value)
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&amp;#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
