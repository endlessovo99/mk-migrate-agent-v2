import { createHash } from "node:crypto";
import { mkForFieldType } from "../dsl/mk-components.js";
import { parseDesignerFdValues } from "./designer-control-values.js";
import { attrValue, cleanText, decodeEntities } from "./xml-utils.js";

export function extractRowMarkers(html, warnings = []) {
  const decoded = decodeEntities(html);
  const markers = [];
  const seen = new Set();
  const inputPattern = /<input\b(?=[^>]*\btype\s*=\s*(?:"hidden"|'hidden'|hidden)(?=\s|\/?>))[^>]*>/gi;
  for (const match of decoded.matchAll(inputPattern)) {
    const id = attrValue(match[0], "id");
    const name = attrValue(match[0], "name");
    const marker = resolveLegacyRowMarker(id, name, warnings);
    if (!marker || seen.has(marker)) continue;
    seen.add(marker);
    markers.push(marker);
  }
  return markers;
}

export function descriptionFieldFromMarkedRow(html, marker, usedFieldIds = new Set()) {
  const labels = [];
  const decoded = decodeEntities(String(html || ""));
  for (const match of decoded.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)) {
    if (containsHiddenInput(match[1])) continue;
    const text = cleanDescriptionLabelText(match[1]);
    if (text) labels.push(text);
  }
  const content = labels.join("\n").trim();
  if (!content) return undefined;
  const title = labels[0].replace(/[:：]\s*$/, "") || marker;
  const id = descriptionFieldId(decoded, marker, usedFieldIds);
  return {
    id,
    title,
    type: "description",
    required: false,
    mk: mkForFieldType("description"),
    source: {
      designerId: id,
      designerType: "textLabel",
      designerValues: {
        id,
        label: title,
        content
      }
    }
  };
}

function resolveLegacyRowMarker(id, name, warnings = []) {
  const rawId = String(id || "").trim();
  const rawName = String(name || "").trim();
  const idMarker = isLegacyRowMarker(rawId) ? rawId : "";
  const nameMarker = isLegacyRowMarker(rawName) ? rawName : "";
  if (nameMarker) {
    if (rawId && rawId !== nameMarker) {
      warnings.push({
        code: "source.sysform.row_marker_id_name_mismatch",
        message: `Row marker hidden input id (${rawId}) differs from name (${nameMarker}); using name for sourceMarkers.`,
        path: "/fdDesignerHtml",
        details: { id: rawId, name: nameMarker, chosen: nameMarker }
      });
    }
    return nameMarker;
  }
  return idMarker;
}

function isLegacyRowMarker(value) {
  return /_row\d*$/i.test(String(value || ""));
}

function containsHiddenInput(value = "") {
  return /<input\b(?=[^>]*\btype\s*=\s*(?:"hidden"|'hidden'|hidden)\b)[^>]*>/i.test(value);
}

function descriptionFieldId(html, marker, usedFieldIds) {
  const legacyId = `${marker}__description`.replace(/[^A-Za-z0-9_]/g, "_");
  if (legacyId.length <= 25 && !usedFieldIds.has(legacyId)) return legacyId;
  for (const match of html.matchAll(/<div\b([^>]*)>/gi)) {
    if (attrValue(match[1], "fd_type").toLowerCase() !== "textlabel") continue;
    const values = parseDesignerFdValues(match[1]);
    const designerId = values.id || attrValue(match[1], "id");
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(designerId) && designerId.length <= 25 && !usedFieldIds.has(designerId)) {
      return designerId;
    }
  }
  return `fd_desc_${createHash("sha256").update(legacyId).digest("hex").slice(0, 12)}`;
}

function cleanDescriptionLabelText(value) {
  return cleanText(value)
    .split("\n")
    .map((line) => line.replace(/^['"]?>\s*/, "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}
