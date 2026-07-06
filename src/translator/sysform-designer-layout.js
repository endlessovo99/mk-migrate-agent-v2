import { mkForComponent, mkForFieldType } from "../dsl/mk-components.js";
import {
  attrValue,
  cleanText,
  decodeEntities,
  parseFdValues,
  parseOptions,
  parseXmlAttributes,
  propertyFieldId
} from "./xml-utils.js";

export function buildDesignerFirstForm(html, metadata, warnings) {
  const designer = parseDesignerLayout(html, warnings);
  if (!designer.fields.length) {
    warnings.push({
      code: "source.sysform.designer_layout_missing",
      message: "SysFormTemplate fdDesignerHtml did not expose field controls; using metadata-only fallback layout.",
      path: "/fdDesignerHtml"
    });
    warnSuspiciousDetailTableTitles(metadata.fields, warnings);
    return {
      fields: metadata.fields,
      layout: fallbackLayout(metadata.fields, "fdMetadataXml")
    };
  }

  const metadataById = new Map(metadata.fields.map((field) => [field.id, field]));
  const metadataByTitle = groupBy(metadata.fields, (field) => normalizeMatchText(field.title));
  const matchedMetadataIds = new Set();
  const fields = [];

  for (const field of designer.fields) {
    const metadataField = matchMetadataField(field, metadataById, metadataByTitle);
    if (metadataField) matchedMetadataIds.add(metadataField.id);
    fields.push(enrichDesignerField(field, metadataField, warnings));
  }

  for (const metadataField of metadata.fields) {
    if (matchedMetadataIds.has(metadataField.id)) continue;
    warnings.push({
      code: "source.sysform.metadata_field_unmatched",
      message: `Metadata field ${metadataField.id} (${metadataField.title}) did not match a designer control and will not create a visible MK control.`,
      path: "/fdMetadataXml",
      details: {
        metadataId: metadataField.id,
        title: metadataField.title
      }
    });
  }

  warnSuspiciousDetailTableTitles(fields, warnings);
  return {
    fields,
    layout: designer.layout
  };
}

function parseDesignerLayout(html, warnings) {
  const decoded = decodeEntities(html);
  const rows = splitMainFormRows(decoded);
  const fields = [];
  const fieldIds = new Set();
  const layoutRows = [];

  rows.forEach((rowHtml, rowIndex) => {
    const cells = [];
    const sourceCells = splitDirectChildCells(rowHtml);

    sourceCells.forEach((cell, cellIndex) => {
      const controls = extractLayoutCellControls(cell.body);
      if (!controls.length) return;
      const cellFieldIds = [];
      for (const control of controls) {
        cellFieldIds.push(control.id);
        if (fieldIds.has(control.id)) continue;
        fieldIds.add(control.id);
        fields.push(control);
      }

      const column = parseColumnSpec(cell.attrs.column, cellIndex);
      cells.push({
        id: `row-${rowIndex}-cell-${column.column}`,
        fieldId: cellFieldIds[0],
        fieldIds: cellFieldIds,
        column: column.column,
        colspan: column.colspan
      });
    });

    if (cells.length) {
      layoutRows.push({
        id: `row-${rowIndex}`,
        sourceRow: String(rowIndex),
        columns: Math.max(...cells.map((cell) => cell.column + cell.colspan), 1),
        cells
      });
    }
  });

  if (!rows.length && decoded.trim()) {
    warnings.push({
      code: "source.sysform.designer_rows_missing",
      message: "SysFormTemplate fdDesignerHtml did not contain table rows for layout extraction.",
      path: "/fdDesignerHtml"
    });
  }

  return {
    fields,
    layout: {
      source: "fdDesignerHtml",
      rows: layoutRows
    }
  };
}

function enrichDesignerField(field, metadataField, warnings) {
  if (!metadataField) {
    warnings.push({
      code: "source.sysform.metadata_field_missing",
      message: `Designer field ${field.id} (${field.title}) did not match fdMetadataXml.`,
      path: "/fdDesignerHtml",
      details: {
        designerId: field.id,
        title: field.title
      }
    });
    return field;
  }

  const next = {
    ...field,
    title: field.title || metadataField.title,
    required: field.required || metadataField.required,
    source: {
      ...field.source,
      metadataId: metadataField.id,
      metadataKind: metadataField.source?.metadataKind,
      metadataAttributes: metadataField.source?.metadataAttributes
    }
  };

  if (field.id !== metadataField.id) {
    warnings.push({
      code: "source.sysform.metadata_id_mismatch",
      message: `Designer field ${field.id} (${field.title}) matched metadata field ${metadataField.id} by title.`,
      path: "/fdDesignerHtml",
      details: {
        designerId: field.id,
        metadataId: metadataField.id,
        title: field.title
      }
    });
  }

  if (field.type === "text" && ["number", "date", "dateTime"].includes(metadataField.type)) {
    next.type = metadataField.type;
    next.mk = metadataField.mk;
  }

  const options = Array.isArray(field.options) && field.options.length
    ? field.options
    : metadataField.options;
  if (Array.isArray(options) && options.length) {
    next.options = options;
  }

  if (field.type === "detailTable") {
    next.columns = Array.isArray(metadataField.columns) ? metadataField.columns : field.columns;
  }

  return next;
}

function warnSuspiciousDetailTableTitles(fields, warnings) {
  fields.forEach((field, index) => {
    if (field.type !== "detailTable" || !isSuspiciousDetailTableTitle(field.title)) return;
    warnings.push({
      code: "source.sysform.detail_table_title_suspicious",
      message: `Detail table ${field.id} uses placeholder-like title ${field.title}; agent review may rename it.`,
      path: `/form/fields/${index}/title`,
      details: {
        id: field.id,
        title: field.title,
        columnTitles: (field.columns || []).map((column) => column.title).filter(Boolean)
      }
    });
  });
}

function isSuspiciousDetailTableTitle(title) {
  const normalized = normalizeMatchText(title);
  if (!normalized) return false;
  if (/^明细表\d+$/i.test(normalized)) return true;
  if (/^(detailtable|details?table|table)\d*$/i.test(normalized)) return true;
  if (/^[a-z][a-z0-9_]*table$/i.test(normalized)) return true;
  return false;
}

function matchMetadataField(field, metadataById, metadataByTitle) {
  const exact = metadataById.get(field.id);
  if (exact) return exact;

  const sameTitle = metadataByTitle.get(normalizeMatchText(field.title)) || [];
  const compatible = sameTitle.filter((candidate) => metadataCompatibleWithDesigner(candidate, field));
  return compatible.length === 1 ? compatible[0] : undefined;
}

function metadataCompatibleWithDesigner(metadataField, designerField) {
  if (designerField.type === "detailTable") return metadataField.type === "detailTable";
  if (designerField.mk?.component === "xform-address") return metadataField.mk?.component === "xform-address";
  return metadataField.type !== "detailTable";
}

function extractLayoutCellControls(html) {
  const controls = extractDesignerFieldControls(html);
  const detailTables = controls.filter((control) => control.type === "detailTable");
  return detailTables.length ? detailTables : controls;
}

function extractDesignerFieldControls(html) {
  const controls = [];
  const controlPattern = /<([a-zA-Z][\w:-]*)\b([^>]*\bfd_type\s*=\s*(["'])([^"']+)\3[^>]*)>/gi;

  for (const match of html.matchAll(controlPattern)) {
    const fdType = match[4];
    const values = parseFdValues(attrValue(match[2], "fd_values"));
    const field = designerFieldFromControl(fdType, values, match[2]);
    if (field) controls.push(field);
  }

  return controls;
}

function designerFieldFromControl(fdType, values, attrs) {
  const normalized = String(fdType || "").toLowerCase();
  if (normalized === "textlabel") return undefined;

  const id = values.id || propertyFieldId(attrValue(attrs, "property")) || attrValue(attrs, "id");
  if (!id) return undefined;

  const title = cleanText(values.label || values.content || id);
  const required = values.required === "true" || /_required\s*=\s*["']?true["']?|required\s*=\s*["']?true["']?/i.test(attrs);
  const options = parseOptions(values.items);
  const source = {
    designerId: id,
    designerType: fdType,
    designerValues: values
  };

  if (normalized === "detailstable") {
    return { id, title, type: "detailTable", required, mk: mkForFieldType("detailTable"), source, columns: [] };
  }
  if (["textarea", "rtf"].includes(normalized)) {
    return { id, title, type: "longText", required, mk: mkForFieldType("longText"), source };
  }
  if (["inputcheckbox", "checkbox"].includes(normalized)) {
    return { id, title, type: "multiSelect", required, mk: mkForFieldType("multiSelect"), source, ...(options.length ? { options } : {}) };
  }
  if (["inputradio", "radio"].includes(normalized)) {
    return { id, title, type: "radio", required, mk: mkForFieldType("radio"), source, ...(options.length ? { options } : {}) };
  }
  if (["select", "inputselect"].includes(normalized)) {
    return { id, title, type: "singleSelect", required, mk: mkForFieldType("singleSelect"), source, ...(options.length ? { options } : {}) };
  }
  if (["date", "datetime", "inputdate", "inputdatetime"].includes(normalized)) {
    return { id, title, type: "dateTime", required, mk: mkForFieldType("dateTime"), source };
  }
  if (["address", "sysorgelement"].includes(normalized)) {
    return { id, title, type: "text", required, mk: mkForComponent("xform-address"), source };
  }
  if (normalized === "attachment") {
    return { id, title, type: "attachment", required, mk: mkForFieldType("attachment"), source };
  }
  if (["inputtext", "calculation"].includes(normalized)) {
    return { id, title, type: "text", required, mk: mkForFieldType("text"), source };
  }

  return undefined;
}

function fallbackLayout(fields, source) {
  return {
    source,
    rows: fields.map((field, index) => ({
      id: `row-${index}`,
      sourceRow: String(index),
      columns: 1,
      cells: [{
        id: `row-${index}-cell-0`,
        fieldId: field.id,
        fieldIds: [field.id],
        column: 0,
        colspan: 1
      }]
    }))
  };
}

function splitMainFormRows(html) {
  const standardTable = findStandardTableFragment(html);
  const fragment = extractFirstTbodyContent(standardTable || html) || standardTable || html;
  return splitDirectChildRows(fragment);
}

function findStandardTableFragment(html) {
  const tablePattern = /<table\b([^>]*)>/gi;
  for (const match of html.matchAll(tablePattern)) {
    if (attrValue(match[1], "fd_type").toLowerCase() !== "standardtable") continue;
    const start = match.index;
    const openEnd = start + match[0].length;
    const end = findMatchingCloseTag(html, openEnd, "table");
    return end > openEnd ? html.slice(openEnd, end) : html.slice(openEnd);
  }
  return "";
}

function extractFirstTbodyContent(fragment) {
  const match = /<tbody\b[^>]*>/i.exec(fragment);
  if (!match) return "";
  const start = match.index + match[0].length;
  const end = findMatchingCloseTag(fragment, start, "tbody");
  return end > start ? fragment.slice(start, end) : fragment.slice(start);
}

function findMatchingCloseTag(html, contentStart, tagName) {
  const lower = html.toLowerCase();
  const openToken = `<${tagName}`;
  const closeToken = `</${tagName}>`;
  let depth = 1;
  let cursor = contentStart;

  while (cursor < html.length) {
    const nextOpen = lower.indexOf(openToken, cursor);
    const nextClose = lower.indexOf(closeToken, cursor);
    if (nextClose === -1) return html.length;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      const openEnd = lower.indexOf(">", nextOpen);
      cursor = openEnd === -1 ? nextOpen + openToken.length : openEnd + 1;
      continue;
    }
    depth -= 1;
    if (depth === 0) return nextClose;
    cursor = nextClose + closeToken.length;
  }

  return html.length;
}

function splitDirectChildRows(fragment) {
  const rows = [];
  let tableDepth = 0;
  let rowStart = -1;
  const lower = fragment.toLowerCase();

  for (let index = 0; index < fragment.length; index += 1) {
    if (lower.startsWith("<table", index)) {
      const close = lower.indexOf(">", index);
      if (close === -1) break;
      tableDepth += 1;
      index = close;
      continue;
    }
    if (lower.startsWith("</table>", index)) {
      tableDepth = Math.max(0, tableDepth - 1);
      index += "</table>".length - 1;
      continue;
    }
    if (tableDepth === 0 && lower.startsWith("<tr", index)) {
      rowStart = index;
      continue;
    }
    if (tableDepth === 0 && lower.startsWith("</tr>", index) && rowStart >= 0) {
      rows.push(fragment.slice(rowStart, index + "</tr>".length));
      rowStart = -1;
      index += "</tr>".length - 1;
    }
  }

  if (rows.length) return rows;
  return [...fragment.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
}

function splitDirectChildCells(rowHtml) {
  const cells = [];
  let tableDepth = 0;
  let cellStart = -1;
  const lower = rowHtml.toLowerCase();

  for (let index = 0; index < rowHtml.length; index += 1) {
    if (lower.startsWith("<table", index) && cellStart >= 0) {
      const close = lower.indexOf(">", index);
      if (close === -1) break;
      tableDepth += 1;
      index = close;
      continue;
    }
    if (lower.startsWith("</table>", index) && tableDepth > 0) {
      tableDepth -= 1;
      index += "</table>".length - 1;
      continue;
    }
    if (tableDepth === 0 && cellStart < 0 && (lower.startsWith("<td", index) || lower.startsWith("<th", index))) {
      cellStart = index;
      continue;
    }
    if (tableDepth === 0 && cellStart >= 0 && (lower.startsWith("</td>", index) || lower.startsWith("</th>", index))) {
      const endTag = lower.startsWith("</td>", index) ? "</td>" : "</th>";
      const cellHtml = rowHtml.slice(cellStart, index + endTag.length);
      const openMatch = cellHtml.match(/^<(td|th)\b([^>]*)>/i);
      const bodyStart = openMatch ? openMatch[0].length : 0;
      cells.push({
        attrs: parseXmlAttributes(openMatch?.[2] || ""),
        body: cellHtml.slice(bodyStart, -endTag.length)
      });
      cellStart = -1;
      index += endTag.length - 1;
    }
  }

  return cells;
}

function parseColumnSpec(value, fallback) {
  const parts = String(value ?? fallback)
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isInteger(item) && item >= 0);
  if (!parts.length) return { column: fallback, colspan: 1 };
  return {
    column: parts[0],
    colspan: Math.max(parts.length, 1)
  };
}

function normalizeMatchText(value = "") {
  return cleanText(value).replace(/\s+/g, "");
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}
