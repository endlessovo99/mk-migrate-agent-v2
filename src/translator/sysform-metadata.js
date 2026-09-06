import { mkForComponent, mkForFieldType } from "../dsl/mk-components.js";
import { decodeEntities, parseOptions, parseXmlAttributes, removeRanges } from "./xml-utils.js";

export function parseMetadataXml(metadataXml = "") {
  const xml = decodeEntities(metadataXml);
  const fields = [];
  const tableRanges = [];

  for (const tableMatch of xml.matchAll(/<extendSubTableProperty\b([^>]*)>([\s\S]*?)<\/extendSubTableProperty>/gi)) {
    tableRanges.push([tableMatch.index, tableMatch.index + tableMatch[0].length]);
    const attrs = parseXmlAttributes(tableMatch[1]);
    const columns = extractSimpleProperties(tableMatch[2]).map((property) =>
      metadataFieldToDslField(property, { classifyDataOnly: true })
    );
    fields.push({
      id: attrs.name,
      title: attrs.label || attrs.name,
      type: "detailTable",
      required: attrs.notNull === "true",
      mk: mkForFieldType("detailTable"),
      columns,
      source: {
        metadataId: attrs.name,
        metadataKind: "detailTable",
        metadataAttributes: attrs
      }
    });
  }

  const mainXml = removeRanges(xml, tableRanges);
  for (const property of extractSimpleProperties(mainXml)) {
    fields.push(metadataFieldToDslField(property, { classifyDataOnly: true }));
  }

  recoverStaticOrgDefaultMetadata(fields, metadataXml);
  return { fields };
}

function recoverStaticOrgDefaultMetadata(fields, metadataXml) {
  const recoveredByName = new Map();
  for (const match of String(metadataXml).matchAll(/<extendElementProperty\b([^/>]*?)\/>/gi)) {
    const attrs = parseXmlAttributes(match[1]);
    if (
      attrs.formula === "true" &&
      /^OtherFunction\s*\.\s*getModel\s*\(\s*"[^"]+"\s*,\s*"com\.landray\.kmss\.sys\.organization\.model\.SysOrgElement"\s*,\s*null\s*\)$/u.test(
        String(attrs.defaultValue || "")
      )
    ) {
      recoveredByName.set(attrs.name, attrs.defaultValue);
    }
  }
  for (const field of fields) {
    const recovered = recoveredByName.get(field?.id);
    if (recovered && field?.source?.metadataKind === "element") {
      field.source.metadataAttributes.defaultValue = recovered;
    }
  }
}

export function isDataOnlyMetadataField(field = {}) {
  if (field.type === "detailTable") return false;
  if (field.dataOnly === true) return true;
  return isHiddenMetadataAttributes(field.source?.metadataAttributes || {});
}

function extractSimpleProperties(xml = "") {
  return [...xml.matchAll(/<extend(Simple|Element)Property\b([^/>]*?)\/>/gi)]
    .map((match) => ({
      ...parseXmlAttributes(match[2]),
      kind: match[1] === "Element" ? "element" : "simple"
    }))
    .filter((item) => item.name);
}

function metadataFieldToDslField(property, settings = {}) {
  const fieldOptions = parseOptions(property.enumValues);
  const type = inferDslFieldType(property, fieldOptions);
  const dataOnly = settings.classifyDataOnly && isHiddenMetadataAttributes(property);
  return {
    id: property.name,
    title: property.label || property.name,
    type,
    required: property.notNull === "true",
    mk: mkForMetadataField(property, type),
    source: {
      metadataId: property.name,
      metadataKind: property.kind,
      metadataAttributes: property
    },
    ...(dataOnly ? { dataOnly: true } : {}),
    ...(fieldOptions.length ? { options: fieldOptions } : {})
  };
}

export function isHiddenMetadataAttributes(attrs = {}) {
  return isFalseLike(attrs.canDisplay) || isFalseLike(attrs.canShow) || isNoShow(attrs.showStatus);
}

function isFalseLike(value) {
  return String(value ?? "").trim().toLowerCase() === "false";
}

function isNoShow(value) {
  return String(value ?? "").trim().toLowerCase() === "noshow";
}

function mkForMetadataField(property, type) {
  if (property.kind === "element") return mkForComponent("xform-address");
  return mkForFieldType(type);
}

function inferDslFieldType(property, options) {
  if (options.length) return "singleSelect";
  if (property.kind === "element") return "text";
  const type = String(property.type || property.dataType || "").toLowerCase();
  if (["double", "float", "integer", "long", "number", "bigdecimal"].includes(type)) return "number";
  if (type.includes("date")) return "date";
  return "text";
}
