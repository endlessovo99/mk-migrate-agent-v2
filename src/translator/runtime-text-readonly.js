import { scanHtmlTags } from "./designer-html-tokenizer.js";
import { decodeEntities } from "./xml-utils.js";

// The selector's existing metadata text may have no Designer control of its own.
// Preserve only explicit runtime text permissions; do not infer a companion by name.
export function annotateRuntimeTextReadOnly(fields = [], html = "", warnings = []) {
  const candidates = [];
  const collect = (scope, tableId) => {
    if (!scope.some(field => String(field.source?.designerType || "").toLowerCase() === "sqldialog")) return;
    for (const field of scope) {
      if (field.type === "text" && field.source?.metadataId === field.id &&
          !field.source?.designerId && !field.source?.designerType) candidates.push({ field, tableId });
    }
  };
  collect(fields.filter(field => field.type !== "detailTable"));
  for (const table of fields.filter(field => field.type === "detailTable")) collect(table.columns || [], table.id);
  if (!candidates.length) return fields;

  const { entries, uncertain } = runtimeTextEntries(String(html));
  const facts = new Map();
  for (const { field, tableId } of candidates) {
    const matches = entries.map(entry => ({ entry, binding: matchProperty(entry.property, field.id, tableId) }))
      .filter(match => match.binding !== undefined);
    if (!uncertain && matches.length && matches.every(match => match.binding && match.entry.readOnly === true)) {
      facts.set(field, {
        readOnly: true,
        source: "fdDisplayJsp",
        evidence: matches.map(({ entry }) => ({
          property: entry.property,
          htmlElementProperties: entry.htmlElementProperties,
          offset: entry.offset
        }))
      });
    } else if (uncertain || matches.some(match => match.entry.readOnly === true || match.entry.uncertain)) {
      warnings.push({
        code: "source.sysform.runtime_text_readonly_ambiguous",
        message: `Runtime text permissions for ${tableId ? `${tableId}.` : ""}${field.id} are not consistently provable.`,
        path: "/fdDisplayJsp",
        details: { fieldId: field.id, ...(tableId ? { tableId } : {}), offsets: matches.map(({ entry }) => entry.offset) }
      });
    }
  }
  const annotate = field => facts.has(field)
    ? { ...field, source: { ...field.source, runtimeTextReadOnly: facts.get(field) } }
    : field;
  return fields.map(field => field.type === "detailTable"
    ? { ...field, columns: (field.columns || []).map(annotate) }
    : annotate(field));
}

function matchProperty(property, fieldId, tableId) {
  const match = /^extendDataFormInfo\.value\(([^\r\n]*)\)$/.exec(property || "");
  if (!match) return undefined;
  const value = match[1];
  if (!tableId) return value === fieldId ? true : undefined;
  const prefix = `${tableId}.`;
  const suffix = `.${fieldId}`;
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return undefined;
  const row = value.slice(prefix.length, -suffix.length);
  return row === "!{index}" || row === "${vstatus.index}";
}

function runtimeTextEntries(html) {
  const entries = [];
  let uncertain = false;
  const markup = maskNonMarkup(html);
  let skipUntil = 0;
  for (const token of scanHtmlTags(markup)) {
    if (token.start < skipUntil || token.closing || token.name !== "xform:text") continue;
    if (!token.selfClosing) {
      const close = /<\/\s*xform:text\s*>/ig;
      close.lastIndex = token.end;
      skipUntil = close.exec(markup) ? close.lastIndex : markup.length;
    }
    const attributes = parseAttributes(token.attrs.replace(/\/\s*$/, ""));
    if (!attributes || /<%|<!--/.test(html.slice(token.start, token.end))) {
      uncertain = true;
      continue;
    }
    const property = attributes.get("property");
    if (!property) continue;
    const raw = attributes.get("htmlelementproperties");
    const properties = raw !== undefined && !/[<>{}]/.test(raw) ? parseAttributes(raw) : undefined;
    entries.push({
      property,
      offset: token.start,
      htmlElementProperties: raw || "",
      // HTML readonly is a presence attribute: readonly="false" is still readonly.
      readOnly: token.selfClosing && properties?.has("readonly") === true,
      uncertain: !token.selfClosing || (raw !== undefined && !properties)
    });
  }
  return { entries, uncertain };
}

function parseAttributes(text) {
  const attributes = new Map();
  const source = String(text);
  const attribute = /\s*([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s"'`=<>]+)))?/y;
  let offset = 0;
  while (source.slice(offset).trim()) {
    if (offset > 0 && !/\s/.test(source[offset])) return undefined;
    attribute.lastIndex = offset;
    const match = attribute.exec(source);
    if (!match) return undefined;
    const name = match[1].toLowerCase();
    if (attributes.has(name)) return undefined;
    attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
    offset = attribute.lastIndex;
  }
  return attributes;
}

function maskNonMarkup(html) {
  const blank = text => text.replace(/[^\r\n]/g, " ");
  // Mask server-side code and both comment forms before tokenizing HTML.
  let masked = html.replace(/<%--[\s\S]*?(?:--%>|$)|<!--[\s\S]*?(?:-->|$)|<%[\s\S]*?(?:%>|$)/g, blank);
  let skipUntil = 0;
  const ranges = [];
  for (const token of scanHtmlTags(masked)) {
    if (token.start < skipUntil || token.closing ||
        !["script", "style", "textarea", "xform:textarea", "pre", "code"].includes(token.name)) continue;
    const close = new RegExp(`<\\/\\s*${token.name}\\s*>`, "ig");
    close.lastIndex = token.end;
    const end = close.exec(masked);
    skipUntil = end ? close.lastIndex : masked.length;
    ranges.push([token.start, skipUntil]);
  }
  for (const [start, end] of ranges.reverse()) masked = masked.slice(0, start) + blank(masked.slice(start, end)) + masked.slice(end);
  return masked;
}
