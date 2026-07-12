import { createHash } from "node:crypto";
import { mkForComponent, mkForFieldType } from "../dsl/mk-components.js";
import { isDataOnlyMetadataField } from "./sysform-metadata.js";
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
  const metadataFields = Array.isArray(metadata?.fields) ? metadata.fields : [];
  const designerById = new Map(
    [...designer.fields, ...designer.hiddenFields].map((field) => [field.id, field])
  );
  const hiddenDesignerIds = new Set(
    designer.hiddenFields
      .filter((field) => field.type !== "detailTable")
      .map((field) => field.id)
  );
  const dataOnlyMetadataFields = metadataFields.filter((field) =>
    field.type !== "detailTable" &&
    (isDataOnlyMetadataField(field) || hiddenDesignerIds.has(field.id))
  );
  const dataOnlyIds = new Set(dataOnlyMetadataFields.map((field) => field.id));
  const dataFields = dataOnlyMetadataFields.map((field) =>
    dataOnlyFieldFromMetadata(field, designerById.get(field.id), warnings)
  );
  const visibleMetadataFields = metadataFields.filter((field) => !dataOnlyIds.has(field.id));

  if (!designer.fields.length) {
    warnings.push({
      code: "source.sysform.designer_layout_missing",
      message: "SysFormTemplate fdDesignerHtml did not expose field controls; using metadata-only fallback layout.",
      path: "/fdDesignerHtml"
    });
    warnSuspiciousDetailTableTitles(visibleMetadataFields, warnings);
    return {
      fields: visibleMetadataFields,
      dataFields,
      layout: fallbackLayout(visibleMetadataFields, "fdMetadataXml")
    };
  }

  const metadataById = new Map(visibleMetadataFields.map((field) => [field.id, field]));
  const metadataByTitle = groupBy(visibleMetadataFields, (field) => normalizeMatchText(field.title));
  const matchedMetadataIds = new Set(dataOnlyIds);
  const fields = [];

  for (const field of designer.fields) {
    if (dataOnlyIds.has(field.id)) continue;
    const metadataField = matchMetadataField(field, metadataById, metadataByTitle);
    if (metadataField) matchedMetadataIds.add(metadataField.id);
    fields.push(enrichDesignerField(field, metadataField, warnings));
  }

  for (const metadataField of visibleMetadataFields) {
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
    dataFields,
    layout: removeDataOnlyFieldsFromLayout(designer.layout, dataOnlyIds)
  };
}

function dataOnlyFieldFromMetadata(metadataField, designerField, warnings) {
  const field = designerField
    ? enrichDesignerField(designerField, metadataField, warnings)
    : metadataField;
  return {
    ...field,
    dataOnly: true
  };
}

function parseDesignerLayout(html, warnings) {
  const decoded = decodeEntities(html);
  const rows = splitMainFormRows(decoded);
  const fields = [];
  const fieldIds = new Set();
  const hiddenFields = [];
  const hiddenFieldIds = new Set();
  const layoutRows = [];

  rows.forEach((rowHtml, rowIndex) => {
    const cells = [];
    const sourceMarkers = extractRowMarkers(rowHtml, warnings);
    const sourceCells = splitDirectChildCells(rowHtml);
    const sourceColumns = sourceCells.reduce((max, cell, cellIndex) => {
      const column = parseColumnSpec(cell.attrs.column, cellIndex);
      return Math.max(max, column.column + column.colspan);
    }, 1);

    sourceCells.forEach((cell, cellIndex) => {
      const controls = extractLayoutCellControls(cell.body);
      if (!controls.length) return;
      const column = parseColumnSpec(cell.attrs.column, cellIndex);
      const controlGroups = groupLayoutCellControls(controls);
      controlGroups.forEach((group, groupIndex) => {
        const cellFieldIds = [];
        for (const control of group) {
          if (control.source?.designerHidden) {
            if (!hiddenFieldIds.has(control.id)) {
              hiddenFieldIds.add(control.id);
              hiddenFields.push(control);
            }
            continue;
          }
          cellFieldIds.push(control.id);
          if (fieldIds.has(control.id)) continue;
          fieldIds.add(control.id);
          fields.push(control);
        }
        if (!cellFieldIds.length) return;

        cells.push({
          id: `row-${rowIndex}-cell-${column.column}${groupIndex ? `-${groupIndex}` : ""}`,
          fieldId: cellFieldIds[0],
          fieldIds: cellFieldIds,
          column: column.column,
          colspan: column.colspan
        });
      });
    });

    if (!cells.length && sourceMarkers.length) {
      const description = descriptionFieldFromMarkedRow(rowHtml, sourceMarkers[0], fieldIds);
      if (description && !fieldIds.has(description.id)) {
        fieldIds.add(description.id);
        fields.push(description);
        cells.push({
          id: `row-${rowIndex}-cell-0`,
          fieldId: description.id,
          fieldIds: [description.id],
          column: 0,
          colspan: sourceColumns
        });
      }
    }

    if (cells.length) {
      layoutRows.push({
        id: `row-${rowIndex}`,
        sourceRow: String(rowIndex),
        ...(sourceMarkers.length ? { sourceMarkers } : {}),
        columns: Math.max(sourceColumns, ...cells.map((cell) => cell.column + cell.colspan), 1),
        cells
      });
    }
  });

  recoverDesignerAttachments(decoded, fields, fieldIds, layoutRows, warnings);

  if (!rows.length && decoded.trim()) {
    warnings.push({
      code: "source.sysform.designer_rows_missing",
      message: "SysFormTemplate fdDesignerHtml did not contain table rows for layout extraction.",
      path: "/fdDesignerHtml"
    });
  }

  return {
    fields,
    hiddenFields,
    layout: {
      source: "fdDesignerHtml",
      rows: layoutRows
    }
  };
}

function recoverDesignerAttachments(html, fields, fieldIds, layoutRows, warnings) {
  const attachments = extractDesignerFieldControls(html)
    .filter((control) => control.type === "attachment" && !fieldIds.has(control.id));

  for (const attachment of attachments) {
    fieldIds.add(attachment.id);
    fields.push(attachment);
    const rowIndex = layoutRows.length;
    layoutRows.push({
      id: `row-recovered-attachment-${attachment.id}`,
      sourceRow: `recovered-attachment-${attachment.id}`,
      columns: 1,
      cells: [{
        id: `row-recovered-attachment-${attachment.id}-cell-0`,
        fieldId: attachment.id,
        fieldIds: [attachment.id],
        column: 0,
        colspan: 1
      }]
    });
    warnings.push({
      code: "source.sysform.designer_attachment_recovered",
      message: `Designer attachment ${attachment.id} (${attachment.title}) was recovered outside the directly parsed standard-table cells.`,
      path: `/fdDesignerHtml/attachments/${rowIndex}`,
      details: { designerId: attachment.id, title: attachment.title }
    });
  }
}

function enrichDesignerField(field, metadataField, warnings) {
  if (!metadataField) {
    if (field.type !== "description") {
      warnings.push({
        code: "source.sysform.metadata_field_missing",
        message: `Designer field ${field.id} (${field.title}) did not match fdMetadataXml.`,
        path: "/fdDesignerHtml",
        details: {
          designerId: field.id,
          title: field.title
        }
      });
    }
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
    next.columns = Array.isArray(metadataField.columns) && metadataField.columns.length
      ? metadataField.columns
      : field.columns;
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
  const controls = extractDesignerFieldControls(html, { includeHidden: true, includeTextLabels: true });
  const detailTables = controls.filter((control) => control.type === "detailTable");
  if (detailTables.length) {
    // Detail-table cells often host main-level calculation totals in footer
    // (nofoot) rows. Keep those as sibling form controls; do not promote
    // ordinary detail columns that also match the broad control scan.
    const footerControls = [];
    const seen = new Set(detailTables.map((table) => table.id));
    for (const table of detailTables) {
      const tableHtml = matchingDetailTableFragment(html, table.id);
      for (const control of extractDetailTableFooterControls(tableHtml, table.id)) {
        if (seen.has(control.id)) continue;
        seen.add(control.id);
        footerControls.push(control);
      }
    }
    return [...detailTables, ...footerControls];
  }

  const fieldControls = controls.filter((control) => control.type !== "description");
  if (fieldControls.length) return fieldControls;

  // Label-only cells: keep styled/hint textLabels as descriptions; skip plain field titles.
  return controls.filter((control) => control.type === "description" && isHintTextLabel(control));
}

// Detail tables and ordinary fields cannot share one mkTree child refType.
function groupLayoutCellControls(controls) {
  const detailTables = controls.filter((control) => control.type === "detailTable");
  const others = controls.filter((control) => control.type !== "detailTable");
  if (detailTables.length && others.length) return [detailTables, others];
  return [controls];
}

function extractDesignerFieldControls(html, options = {}) {
  const controls = [];
  const controlPattern = /<([a-zA-Z][\w:-]*)\b([^>]*\bfd_type\s*=\s*(["'])([^"']+)\3[^>]*)>/gi;

  for (const match of html.matchAll(controlPattern)) {
    const fdType = match[4];
    const normalizedType = String(fdType || "").toLowerCase();
    if (normalizedType === "textlabel" && !options.includeTextLabels) continue;
    const values = parseFdValues(attrValue(match[2], "fd_values"));
    const fragment = matchingElementFragment(html, match);
    const hidden = isHiddenDesignerControl(values, match[2], fragment);
    if (hidden && !options.includeHidden) continue;
    const field = designerFieldFromControl(fdType, values, match[2], {
      html: fragment,
      hidden
    });
    if (field) controls.push(field);
  }

  return controls;
}

function isHintTextLabel(field) {
  const values = field?.source?.designerValues || {};
  if (hasTextLabelColor(values.color) || isTrueLike(values.b)) return true;
  const style = String(values.style || "");
  if (/color\s*:\s*#(?!000000|000\b)[0-9a-f]{3,8}\b/i.test(style)) return true;
  if (/font-weight\s*:\s*(bold|[6-9]00)\b/i.test(style)) return true;
  return false;
}

function hasTextLabelColor(value) {
  const color = String(value || "").trim();
  if (!color) return false;
  const normalized = color.toLowerCase();
  return !["#000", "#000000", "black", "rgb(0,0,0)", "rgba(0,0,0,1)"].includes(normalized);
}

function isTrueLike(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function extractRowMarkers(html, warnings = []) {
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

function resolveLegacyRowMarker(id, name, warnings = []) {
  const rawId = String(id || "").trim();
  const rawName = String(name || "").trim();
  const idMarker = isLegacyRowMarker(rawId) ? rawId : "";
  const nameMarker = isLegacyRowMarker(rawName) ? rawName : "";
  if (nameMarker) {
    // Prefer name when id/name diverge so script literals such as
    // common_dom_row_set_show_required_reset("invoice_row4", ...) can resolve
    // against layout sourceMarkers. Export typos often leave a duplicated id.
    if (rawId && rawId !== nameMarker) {
      warnings.push({
        code: "source.sysform.row_marker_id_name_mismatch",
        message: `Row marker hidden input id (${rawId}) differs from name (${nameMarker}); using name for sourceMarkers.`,
        path: "/fdDesignerHtml",
        details: {
          id: rawId,
          name: nameMarker,
          chosen: nameMarker
        }
      });
    }
    return nameMarker;
  }
  return idMarker;
}

function isLegacyRowMarker(value) {
  return /_row\d*$/i.test(String(value || ""));
}

function descriptionFieldFromMarkedRow(html, marker, usedFieldIds = new Set()) {
  const labels = [];
  const decoded = decodeEntities(html);
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

function descriptionFieldId(html, marker, usedFieldIds) {
  const legacyId = `${marker}__description`.replace(/[^A-Za-z0-9_]/g, "_");
  if (legacyId.length <= 25 && !usedFieldIds.has(legacyId)) return legacyId;

  for (const match of html.matchAll(/<div\b([^>]*)>/gi)) {
    if (attrValue(match[1], "fd_type").toLowerCase() !== "textlabel") continue;
    const values = parseFdValues(attrValue(match[1], "fd_values"));
    const designerId = values.id || attrValue(match[1], "id");
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(designerId) && designerId.length <= 25 && !usedFieldIds.has(designerId)) {
      return designerId;
    }
  }

  return `fd_desc_${createHash("sha256").update(legacyId).digest("hex").slice(0, 12)}`;
}

function containsHiddenInput(value = "") {
  return /<input\b(?=[^>]*\btype\s*=\s*(?:"hidden"|'hidden'|hidden)\b)[^>]*>/i.test(value);
}

function cleanDescriptionLabelText(value) {
  return cleanText(value)
    .split("\n")
    .map((line) => line.replace(/^['"]?>\s*/, "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function designerFieldFromControl(fdType, values, attrs, context = {}) {
  const normalized = String(fdType || "").toLowerCase();

  const id = values.id || propertyFieldId(attrValue(attrs, "property")) || attrValue(attrs, "id");
  if (!id) return undefined;

  const title = cleanText(values.label || values.content || id);
  const required = values.required === "true" || /_required\s*=\s*["']?true["']?|required\s*=\s*["']?true["']?/i.test(attrs);
  const options = parseOptions(values.items);
  const source = {
    designerId: id,
    designerType: fdType,
    designerValues: values,
    designerTableName: attrValue(attrs, "tableName") || undefined,
    designerShowStatus: attrValue(attrs, "showStatus") || undefined,
    ...(context.hidden ? { designerHidden: true } : {})
  };

  if (normalized === "textlabel") {
    const content = cleanText(values.content || title);
    if (!content) return undefined;
    return {
      id,
      title: content,
      type: "description",
      required: false,
      mk: mkForFieldType("description"),
      source
    };
  }

  if (normalized === "detailstable") {
    return {
      id,
      title,
      type: "detailTable",
      required,
      mk: mkForFieldType("detailTable"),
      source,
      columns: extractDesignerDetailTableColumns(context.html || "", id)
    };
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
  // EKP chinaValue is a read-only Chinese-currency display bound to a related amount field.
  // Map it as ordinary text so metadata matching and convertCurrency scripts have a target.
  if (normalized === "chinavalue") {
    return { id, title, type: "text", required, mk: mkForFieldType("text"), source };
  }

  return undefined;
}

function extractDesignerDetailTableColumns(tableHtml, tableId) {
  if (!tableHtml) return [];

  const columns = [];
  const seen = new Set();
  for (const row of splitDirectChildRows(extractFirstTbodyContent(tableHtml) || tableHtml)) {
    for (const cell of splitDirectChildCells(row)) {
      if (isNonDataDetailCell(cell.attrs)) continue;
      for (const control of extractDesignerFieldControls(cell.body)) {
        if (!isDetailColumnControl(control, tableId) || seen.has(control.id)) continue;
        seen.add(control.id);
        columns.push(control);
      }
    }
  }
  return columns;
}

function extractDetailTableFooterControls(tableHtml, tableId) {
  if (!tableHtml) return [];

  const controls = [];
  const seen = new Set();
  for (const row of splitDirectChildRows(extractFirstTbodyContent(tableHtml) || tableHtml)) {
    if (!isDetailFooterRow(row)) continue;
    for (const cell of splitDirectChildCells(row)) {
      if (isNonDataDetailCell(cell.attrs)) continue;
      for (const control of extractDesignerFieldControls(cell.body)) {
        if (!isDetailFooterMainControl(control, tableId) || seen.has(control.id)) continue;
        seen.add(control.id);
        controls.push(control);
      }
    }
  }
  return controls;
}

function isDetailFooterRow(rowHtml) {
  return splitDirectChildCells(rowHtml).some((cell) => {
    const colType = String(cell.attrs.colType || cell.attrs.coltype || "").toLowerCase();
    return colType === "nofoot";
  });
}

function isDetailFooterMainControl(control, tableId) {
  if (!control || control.type === "detailTable" || control.type === "description") return false;
  if (!control.title || control.title === control.id) return false;
  if ((control.source?.designerValues?.showStatus || control.source?.designerShowStatus) === "noShow") return false;
  const tableName = control.source?.designerValues?.tableName || control.source?.designerTableName;
  if (tableName && tableName !== tableId) return false;
  // Footer totals are main-model calculation/simple fields, not row-scoped columns.
  const designerType = String(control.source?.designerType || "").toLowerCase();
  return designerType === "calculation" || !tableName;
}

function isNonDataDetailCell(attrs) {
  const colType = String(attrs.colType || attrs.coltype || "").toLowerCase();
  return ["notitle", "notemplate", "nofoot", "emptycell"].includes(colType);
}

function isDetailColumnControl(control, tableId) {
  if (!control || control.type === "detailTable") return false;
  if (!control.title || control.title === control.id) return false;
  if ((control.source?.designerValues?.showStatus || control.source?.designerShowStatus) === "noShow") return false;
  const tableName = control.source?.designerValues?.tableName || control.source?.designerTableName;
  if (tableName && tableName !== tableId) return false;
  return true;
}

function isHiddenDesignerControl(values = {}, attrs = "", fragment = "") {
  if (isFalseLike(values.canShow) || isFalseLike(attrValue(attrs, "canShow"))) return true;
  if (isNoShow(values.showStatus) || isNoShow(attrValue(attrs, "showStatus"))) return true;
  if (hasDisplayNone(values.style) || hasDisplayNone(attrValue(attrs, "style"))) return true;
  if (/\bclass\s*=\s*(["'])[^"']*\binputhidden\b/i.test(fragment)) return true;
  return false;
}

function isFalseLike(value) {
  return String(value ?? "").trim().toLowerCase() === "false";
}

function isNoShow(value) {
  return String(value ?? "").trim().toLowerCase() === "noshow";
}

function hasDisplayNone(value) {
  return /(?:^|;)\s*display\s*:\s*none\b/i.test(String(value ?? ""));
}

function matchingElementFragment(html, match) {
  const tagName = match[1];
  const start = match.index;
  const openEnd = start + match[0].length;
  if (isVoidLikeTag(tagName)) return match[0];
  const end = findMatchingCloseTag(html, openEnd, tagName);
  return end > openEnd ? html.slice(start, end + `</${tagName}>`.length) : match[0];
}

function matchingDetailTableFragment(html, tableId) {
  if (!html || !tableId) return "";
  const controlPattern = /<([a-zA-Z][\w:-]*)\b([^>]*\bfd_type\s*=\s*(["'])detailsTable\3[^>]*)>/gi;
  for (const match of html.matchAll(controlPattern)) {
    const values = parseFdValues(attrValue(match[2], "fd_values"));
    const id = values.id || attrValue(match[2], "id");
    if (id !== tableId) continue;
    return matchingElementFragment(html, match);
  }
  return "";
}

function isVoidLikeTag(tagName = "") {
  return ["input", "br", "hr", "img", "meta", "link"].includes(String(tagName).toLowerCase());
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

function removeDataOnlyFieldsFromLayout(layout, dataOnlyIds) {
  if (!dataOnlyIds.size) return layout;
  return {
    ...layout,
    rows: (layout.rows || []).map((row) => {
      const cells = (row.cells || []).map((cell) => {
        const fieldIds = (cell.fieldIds || [cell.fieldId]).filter((fieldId) =>
          fieldId && !dataOnlyIds.has(fieldId)
        );
        if (!fieldIds.length) return undefined;
        return {
          ...cell,
          fieldId: fieldIds[0],
          fieldIds
        };
      }).filter(Boolean);
      return cells.length ? { ...row, cells } : undefined;
    }).filter(Boolean)
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
