import { mkForComponent, mkForFieldType } from "../dsl/mk-components.js";
import { componentSupportsProp } from "../dsl/catalogs.js";
import { sanitizeCredentialMaterial } from "../credential-material.js";
import { isDataOnlyMetadataField } from "./sysform-metadata.js";
import { restDialogEvidence, sanitizeDesignerValues } from "./rest-dialog.js";
import { parseDesignerFdValues } from "./designer-control-values.js";
import { componentForSourceType } from "./field-component.js";
import { descriptionFieldFromMarkedRow, extractRowMarkers } from "./designer-row-markers.js";
import {
  isSourceDescriptionControl,
  isStyledSourceDescriptionControl
} from "./source-description-control.js";
import {
  applyAdjacentDetailTableTitles,
  applyAdjacentRowDetailTableTitles,
  attachmentContextControls
} from "./designer-structure-recovery.js";
import {
  findMatchingCloseTag,
  isVoidLikeTag,
  matchingElementFragment,
  scanHtmlTags,
  splitDirectChildCells,
  splitDirectChildRows
} from "./designer-html-tokenizer.js";
import {
  attrValue,
  cleanText,
  decodeEntities,
  parseOptions,
  propertyFieldId
} from "./xml-utils.js";

export function buildDesignerFirstForm(html, metadata, warnings) {
  const metadataFields = Array.isArray(metadata?.fields) ? metadata.fields : [];
  const designer = parseDesignerLayout(html, metadataFields, warnings);
  const visibleDesignerIds = new Set(designer.fields.map((field) => field.id));
  const designerById = new Map(
    [...designer.hiddenFields, ...designer.fields].map((field) => [field.id, field])
  );
  const hiddenDesignerIds = new Set(
    designer.hiddenFields
      .filter((field) => field.type !== "detailTable" && !visibleDesignerIds.has(field.id))
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

function parseDesignerLayout(html, metadataFields, warnings) {
  const decoded = decodeEntities(html);
  const rows = splitMainFormRows(decoded);
  const boundCaptions = designerBoundCaptions(decoded);
  const metadataContext = metadataMatchContext(metadataFields);
  const fields = [];
  const fieldIds = new Set();
  const hiddenFields = [];
  const hiddenFieldIds = new Set();
  const layoutRows = [];

  rows.forEach((rowHtml, rowIndex) => {
    const rowDescriptors = nestedLayoutRowDescriptors(
      rowHtml,
      rowIndex,
      boundCaptions,
      metadataContext,
      warnings
    );
    for (const descriptor of rowDescriptors) {
      appendDesignerLayoutRow(descriptor, {
        boundCaptions,
        metadataContext,
        warnings,
        fields,
        fieldIds,
        hiddenFields,
        hiddenFieldIds,
        layoutRows
      });
    }
  });

  const adjacentRowTitles = applyAdjacentRowDetailTableTitles(
    fields,
    layoutRows,
    isSuspiciousDetailTableTitle
  );
  fields.splice(0, fields.length, ...adjacentRowTitles.controls);
  layoutRows.splice(0, layoutRows.length, ...adjacentRowTitles.rows);

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

function nestedLayoutRowDescriptors(
  rowHtml,
  rowIndex,
  boundCaptions,
  metadataContext,
  warnings
) {
  const base = {
    html: rowHtml,
    id: `row-${rowIndex}`,
    sourceRow: String(rowIndex),
    inheritedMarkers: []
  };
  const sourceCells = splitDirectChildCells(rowHtml);
  if (sourceCells.length !== 1) return [base];

  const nestedTables = directStandardTableFragments(sourceCells[0].body);
  if (nestedTables.length !== 1) return [base];
  const nested = nestedTables[0];
  const outside = `${sourceCells[0].body.slice(0, nested.start)}${sourceCells[0].body.slice(nested.end)}`;
  const outsideControls = extractLayoutCellControls(outside, boundCaptions, metadataContext)
    .filter((control) => !control.source?.designerHidden);
  if (outsideControls.length) return [base];

  const nestedRows = splitDirectChildRows(extractFirstTbodyContent(nested.html) || nested.html);
  if (!nestedRows.length) return [base];
  const inheritedMarkers = extractRowMarkers(outside, warnings);
  const preservePlainLabels = /<table\b[^>]*\bfd_type\s*=\s*(["'])detailsTable\1/i.test(nested.html);
  return nestedRows.map((html, nestedRowIndex) => ({
    html,
    id: `row-${rowIndex}.nested-0.row-${nestedRowIndex}`,
    sourceRow: `${rowIndex}.${nestedRowIndex}`,
    inheritedMarkers,
    preservePlainLabels
  }));
}

function directStandardTableFragments(html) {
  const fragments = [];
  let tableDepth = 0;
  for (const token of scanHtmlTags(html)) {
    if (token.name !== "table") continue;
    if (token.closing) {
      tableDepth = Math.max(0, tableDepth - 1);
      continue;
    }
    if (tableDepth === 0 && attrValue(token.attrs, "fd_type").toLowerCase() === "standardtable") {
      const closeStart = findMatchingCloseTag(html, token.end, "table");
      const end = closeStart >= token.end
        ? closeStart + "</table>".length
        : token.end;
      fragments.push({
        html: html.slice(token.start, end),
        start: token.start,
        end
      });
    }
    tableDepth += 1;
  }
  return fragments;
}

function appendDesignerLayoutRow(descriptor, context) {
  const {
    boundCaptions,
    metadataContext,
    warnings,
    fields,
    fieldIds,
    hiddenFields,
    hiddenFieldIds,
    layoutRows
  } = context;
  const rowHtml = descriptor.html;
  const cells = [];
  const sourceMarkers = [...new Set([
    ...(descriptor.inheritedMarkers || []),
    ...extractRowMarkers(rowHtml, warnings)
  ])];
  const sourceCells = splitDirectChildCells(rowHtml);
  const sourceColumns = sourceCells.reduce((max, cell, cellIndex) => {
    const column = parseColumnSpec(cell.attrs.column, cellIndex);
    return Math.max(max, column.column + column.colspan);
  }, 1);

  sourceCells.forEach((cell, cellIndex) => {
    const controls = extractLayoutCellControls(cell.body, boundCaptions, metadataContext, {
      preservePlainLabels: descriptor.preservePlainLabels === true
    });
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
        if (fieldIds.has(control.id)) continue;
        fieldIds.add(control.id);
        fields.push(control);
        cellFieldIds.push(control.id);
      }
      if (!cellFieldIds.length) return;

      cells.push({
        id: `${descriptor.id}-cell-${column.column}${groupIndex ? `-${groupIndex}` : ""}`,
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
        id: `${descriptor.id}-cell-0`,
        fieldId: description.id,
        fieldIds: [description.id],
        column: 0,
        colspan: sourceColumns
      });
    }
  }

  if (cells.length) {
    layoutRows.push({
      id: descriptor.id,
      sourceRow: descriptor.sourceRow,
      ...(sourceMarkers.length ? { sourceMarkers } : {}),
      columns: Math.max(sourceColumns, ...cells.map((cell) => cell.column + cell.colspan), 1),
      cells
    });
  }
}

function recoverDesignerAttachments(html, fields, fieldIds, layoutRows, warnings) {
  const detailChildIds = nestedDetailControlIds(html);
  const entries = extractDesignerFieldControlEntries(html);
  const attachments = entries.filter((entry) =>
      entry.control.type === "attachment" &&
      !fieldIds.has(entry.control.id) &&
      !detailChildIds.has(entry.control.id)
    );

  for (const attachmentEntry of attachments) {
    const attachment = attachmentEntry.control;
    if (fieldIds.has(attachment.id)) continue;
    const recovered = attachmentContextControls(html, attachmentEntry, entries)
      .filter((control) =>
        (isSourceDescriptionControl(control) || control.type === "attachment") &&
        !fieldIds.has(control.id) &&
        !detailChildIds.has(control.id)
      );
    const candidates = recovered.some((control) => control.id === attachment.id)
      ? recovered
      : [attachment];
    const groupIds = new Set();
    const group = candidates.filter((control) => {
      if (groupIds.has(control.id)) return false;
      groupIds.add(control.id);
      return true;
    });
    for (const control of group) {
      fieldIds.add(control.id);
      fields.push(control);
    }
    const rowIndex = layoutRows.length;
    layoutRows.push({
      id: `row-recovered-attachment-${attachment.id}`,
      sourceRow: `recovered-attachment-${attachment.id}`,
      columns: 1,
      cells: [{
        id: `row-recovered-attachment-${attachment.id}-cell-0`,
        fieldId: group[0].id,
        fieldIds: group.map((control) => control.id),
        column: 0,
        colspan: 1
      }]
    });
    warnings.push({
      code: "source.sysform.designer_attachment_recovered",
      message: `Designer attachment ${attachment.id} (${attachment.title}) was recovered outside the directly parsed standard-table cells.`,
      path: `/fdDesignerHtml/attachments/${rowIndex}`,
      details: {
        designerId: attachment.id,
        title: attachment.title,
        contextIds: group.map((control) => control.id)
      }
    });
  }
}

function enrichDesignerField(field, metadataField, warnings) {
  if (String(field.source?.designerType || "").toLowerCase() === "restdialog") {
    warnings.push({
      code: "source.sysform.rest_dialog_partial",
      message: `Designer RestDialog ${field.id} (${field.title}) is preserved as a visible text field; remote lookup and cascading output behavior require manual implementation.`,
      path: "/fdDesignerHtml",
      details: {
        designerId: field.id,
        title: field.title,
        outputMappings: field.source?.restDialog?.outputMappings || []
      }
    });
  }

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
    next.columns = mergeDetailColumns(field.columns, metadataField.columns, warnings);
  }

  return next;
}

function mergeDetailColumns(designerColumns = [], metadataColumns = [], warnings) {
  const metadataById = new Map(
    (Array.isArray(metadataColumns) ? metadataColumns : []).map((column) => [column.id, column])
  );
  const merged = [];
  const seen = new Set();

  for (const column of Array.isArray(designerColumns) ? designerColumns : []) {
    if (!column?.id || seen.has(column.id)) continue;
    seen.add(column.id);
    const metadataColumn = metadataById.get(column.id);
    const enriched = enrichDesignerField(column, metadataColumn, warnings);
    // The designer is authoritative for the visible control family. Metadata
    // enum values describe the stored value domain, but do not prove that an
    // inputRadio was rendered as a select. enrichDesignerField still applies
    // compatible scalar refinements (for example text -> number/date) and
    // supplements options/requiredness without replacing radio/checkbox/select.
    merged.push(enriched);
  }

  for (const column of Array.isArray(metadataColumns) ? metadataColumns : []) {
    if (!column?.id || seen.has(column.id)) continue;
    seen.add(column.id);
    merged.push(column);
  }

  return merged;
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

  const matchTitles = [
    field.title,
    field.source?.designerValues?.label
  ].map(normalizeMatchText).filter(Boolean);
  const compatible = [...new Set(matchTitles)]
    .flatMap((title) => metadataByTitle.get(title) || [])
    .filter((candidate, index, candidates) =>
      candidates.findIndex((item) => item.id === candidate.id) === index &&
      metadataCompatibleWithDesigner(candidate, field)
    );
  return compatible.length === 1 ? compatible[0] : undefined;
}

function metadataCompatibleWithDesigner(metadataField, designerField) {
  if (designerField.type === "detailTable") return metadataField.type === "detailTable";
  if (designerField.mk?.component === "xform-address") return metadataField.mk?.component === "xform-address";
  return metadataField.type !== "detailTable";
}

function metadataMatchContext(metadataFields = []) {
  return {
    byId: new Map(metadataFields.map((field) => [field.id, field])),
    byTitle: groupBy(metadataFields, (field) => normalizeMatchText(field.title))
  };
}

function extractLayoutCellControls(html, crossCellBoundCaptions = new Map(), metadataContext, options = {}) {
  const extractedEntries = extractDesignerFieldControlEntries(html, {
    includeHidden: true,
    includeTextLabels: true
  }).map((entry) => withBoundCaptionEntry(entry, crossCellBoundCaptions));
  const entries = extractedEntries.filter((entry) =>
    !isSourceDescriptionControl(entry.control) ||
    !crossCellBoundCaptions.has(entry.control.id)
  );
  const controls = entries.map((entry) => entry.control);
  const detailTables = controls.filter((control) => control.type === "detailTable");
  if (detailTables.length) {
    // Detail-table cells often host main-level calculation totals in footer
    // (nofoot) rows. Keep those as sibling form controls; do not promote
    // ordinary detail columns that also match the broad control scan.
    const footerControls = [];
    const nestedControlIds = new Set();
    const seen = new Set(detailTables.map((table) => table.id));
    for (const table of detailTables) {
      const tableHtml = matchingDetailTableFragment(html, table.id);
      for (const nested of extractDesignerFieldControls(tableHtml, { includeHidden: true, includeTextLabels: true })) {
        if (nested.id !== table.id) nestedControlIds.add(nested.id);
      }
      for (const control of extractDetailTableFooterControls(tableHtml, table.id)) {
        if (seen.has(control.id)) continue;
        seen.add(control.id);
        footerControls.push(control);
        nestedControlIds.delete(control.id);
      }
    }
    const topLevelControls = controls.filter((control) =>
      control.type === "detailTable" || !nestedControlIds.has(control.id)
    );
    const withFooters = appendMissingControls(topLevelControls, footerControls);
    const entryById = new Map(entries.map((entry) => [entry.control.id, entry]));
    return applyAdjacentDetailTableTitles(withFooters, isSuspiciousDetailTableTitle, {
      hasDirectBreakBetween(left, right) {
        const leftEntry = entryById.get(left?.id);
        const rightEntry = entryById.get(right?.id);
        return Boolean(
          leftEntry &&
          rightEntry &&
          hasDirectDesignerBreakBetween(html, leftEntry, rightEntry)
        );
      }
    });
  }

  const semanticControls = foldInlineCellSemantics(html, entries, metadataContext);
  const fieldControls = semanticControls.filter((control) => !isSourceDescriptionControl(control));
  if (fieldControls.length) {
    const cellBoundLabelIds = new Set(
      fieldControls
        .map((control) => control.source?.designerValues?._label_bind_id)
        .filter(Boolean)
    );
    return semanticControls.filter((control) =>
      !isSourceDescriptionControl(control) || !cellBoundLabelIds.has(control.id)
    );
  }

  // Label-only cells: keep styled/hint textLabels as descriptions; skip plain field titles.
  return semanticControls.filter((control) =>
    isSourceDescriptionControl(control) &&
    (
      options.preservePlainLabels === true ||
      isStyledSourceDescriptionControl(control) ||
      String(control.source?.designerType || "").toLowerCase() === "linklabel"
    )
  );
}

function foldInlineCellSemantics(html, entries, metadataContext) {
  const captions = foldInlineCaptions(html, entries);
  const units = foldInlineNumberUnits(html, captions, metadataContext);
  return foldInlineHints(html, units, metadataContext)
    .map((entry) => entry.control);
}

function foldInlineNumberUnits(html, entries, metadataContext) {
  const folded = [];

  for (let index = 0; index < entries.length;) {
    const current = entries[index];
    const next = entries[index + 1];
    if (
      next &&
      !current.control.source?.designerHidden &&
      !next.control.source?.designerHidden &&
      !isSourceDescriptionControl(current.control) &&
      isNumberControl(current.control, metadataContext) &&
      isPlainInlineCaption(next.control) &&
      hasOnlyInlineUnitGap(html, current, next) &&
      isSafeInlineUnit(next.control.title)
    ) {
      folded.push(mergeControlEntries(
        current,
        next,
        withInlineUnit(current.control, next.control)
      ));
      index += 2;
      continue;
    }

    folded.push(current);
    index += 1;
  }

  return folded;
}

function isNumberControl(control, metadataContext) {
  if (control?.type === "number") return true;
  const metadataField = metadataContext?.byId?.get(control?.id) || (
    metadataContext
      ? matchMetadataField(control, metadataContext.byId, metadataContext.byTitle)
      : undefined
  );
  return metadataField?.type === "number";
}

function isSafeInlineUnit(value) {
  const unit = cleanText(value);
  return [...unit].length > 0 &&
    [...unit].length <= 12 &&
    /^[\p{L}\p{N}%‰°℃℉¥￥/$²³·]+$/u.test(unit);
}

function hasOnlyInlineUnitGap(html, left, right) {
  const between = String(html || "").slice(left.end, right.start);
  if (directElementFragments(between).length) return false;
  return between
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(?:\s|&#(?:x[0-9a-f]+|\d+);|&nbsp;)+/gi, "") === "";
}

function withInlineUnit(control, unit) {
  return {
    ...control,
    source: {
      ...control.source,
      inlineUnit: {
        id: unit.id,
        content: cleanText(unit.title),
        relation: "immediately-adjacent-plain-text-in-same-cell"
      }
    }
  };
}

function foldInlineCaptions(html, entries) {
  const folded = [];

  for (let index = 0; index < entries.length;) {
    const current = entries[index];
    const next = entries[index + 1];
    if (!next || current.control.source?.designerHidden || next.control.source?.designerHidden) {
      folded.push(current);
      index += 1;
      continue;
    }

    const separatedByBreak = hasDesignerBreakBetween(html, current, next);
    if (
      !isSourceDescriptionControl(current.control) &&
      isPlainInlineCaption(next.control) &&
      !separatedByBreak
    ) {
      const canonicalTitle = ordinalCaptionTitle(current.control.title, next.control.title);
      if (canonicalTitle) {
        folded.push(mergeControlEntries(
          current,
          next,
          withInlineCaption(current.control, next.control, canonicalTitle, "trailing-ordinal-caption")
        ));
        index += 2;
        continue;
      }

      if (captionMatchesExactTitle(next.control.title, current.control.title)) {
        folded.push(mergeControlEntries(
          current,
          next,
          withInlineCaption(
            current.control,
            next.control,
            current.control.title,
            "trailing-duplicate-caption"
          )
        ));
        index += 2;
        continue;
      }
    }

    if (
      isPlainInlineCaption(current.control) &&
      !isSourceDescriptionControl(next.control) &&
      !separatedByBreak &&
      captionMatchesTitleEnd(current.control.title, next.control.title)
    ) {
      folded.push(mergeControlEntries(
        current,
        next,
        withInlineCaption(next.control, current.control, next.control.title, "leading-title-segment")
      ));
      index += 2;
      continue;
    }

    // Visible plain textLabel + unbound input subject: UI title is the caption;
    // designer/metadata label is only the field subject, not a second title.
    if (
      isPlainInlineCaption(current.control) &&
      !isSourceDescriptionControl(next.control) &&
      !separatedByBreak &&
      isUnboundSubjectField(next.control) &&
      !isSafeInlineUnit(current.control.title)
    ) {
      folded.push(mergeControlEntries(
        current,
        next,
        withUnboundSubjectCaption(next.control, current.control)
      ));
      index += 2;
      continue;
    }

    folded.push(current);
    index += 1;
  }

  return folded;
}

function isUnboundSubjectField(control) {
  return String(control?.source?.designerValues?._label_bind || "").toLowerCase() === "false";
}

function withUnboundSubjectCaption(control, caption) {
  const subject = cleanText(control.source?.designerValues?.label || control.title);
  const displayTitle = inlineCaptionText(caption.title);
  const folded = withInlineCaption(
    control,
    caption,
    displayTitle,
    "leading-unbound-subject-caption"
  );
  if (!subject || normalizeSemanticText(subject) === normalizeSemanticText(displayTitle)) {
    return folded;
  }
  return {
    ...folded,
    source: {
      ...folded.source,
      subjectLabel: {
        content: subject,
        relation: "unbound-control-subject-distinct-from-visible-caption"
      }
    }
  };
}

function foldInlineHints(html, entries, metadataContext) {
  const folded = [];

  for (let index = 0; index < entries.length;) {
    const current = entries[index];
    const next = entries[index + 1];
    if (
      next &&
      !current.control.source?.designerHidden &&
      !next.control.source?.designerHidden &&
      !isSourceDescriptionControl(current.control) &&
      supportsInlinePlaceholder(current.control, metadataContext) &&
      isSourceDescriptionControl(next.control) &&
      isStyledSourceDescriptionControl(next.control) &&
      hasDirectDesignerBreakBetween(html, current, next)
    ) {
      folded.push(mergeControlEntries(
        current,
        next,
        withInlineHint(current.control, next.control)
      ));
      index += 2;
      continue;
    }

    folded.push(current);
    index += 1;
  }

  return folded;
}

function isPlainInlineCaption(control) {
  return isSourceDescriptionControl(control) &&
    String(control.source?.designerType || "").toLowerCase() === "textlabel" &&
    !isStyledSourceDescriptionControl(control);
}

function supportsInlinePlaceholder(control, metadataContext) {
  const metadataField = metadataContext
    ? matchMetadataField(control, metadataContext.byId, metadataContext.byTitle)
    : undefined;
  const type = control?.type === "text" && ["number", "date", "dateTime"].includes(metadataField?.type)
    ? metadataField.type
    : control?.type;
  const component = componentForSourceType(type, {
    sourceProps: {
      ...control?.source,
      ...(metadataField?.source?.metadataKind
        ? { metadataKind: metadataField.source.metadataKind }
        : {})
    }
  });
  return componentSupportsProp(component, "placeholder") || control?.type === "RestDialog";
}

function hasDesignerBreakBetween(html, left, right) {
  const between = String(html || "").slice(left.end, right.start);
  return /\bfd_type\s*=\s*(["'])brcontrol\1/i.test(between);
}

function hasDirectDesignerBreakBetween(html, left, right) {
  const between = String(html || "").slice(left.end, right.start);
  const elements = directElementFragments(between);
  if (elements.length < 1 || elements.length > 2) return false;
  const [breakElement, placeholder] = elements;
  if (attrValue(breakElement.attrs, "fd_type").toLowerCase() !== "brcontrol") return false;

  const breakId = attrValue(breakElement.attrs, "id") ||
    parseDesignerFdValues(breakElement.attrs).id;
  if (placeholder) {
    if (!breakId || placeholder.name !== "div") return false;
    if (attrValue(placeholder.attrs, "id") !== `brcontrol-${breakId}`) return false;
    if (!/^<div\b[^>]*>\s*<\/div>$/i.test(placeholder.html)) return false;
  }

  const gaps = directElementGaps(between, elements);
  return gaps.replace(/(?:\s|&#(?:x[0-9a-f]+|\d+);|&nbsp;)+/gi, "") === "";
}

function directElementFragments(html) {
  const elements = [];
  let depth = 0;
  let opening;

  for (const token of scanHtmlTags(html)) {
    if (token.closing) {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && opening) {
        elements.push({
          ...opening,
          end: token.end,
          html: html.slice(opening.start, token.end)
        });
        opening = undefined;
      }
      continue;
    }

    const voidLike = token.selfClosing || isVoidLikeTag(token.name);
    if (depth === 0) {
      opening = token;
      if (voidLike) {
        elements.push({ ...token, html: html.slice(token.start, token.end) });
        opening = undefined;
      }
    }
    if (!voidLike) depth += 1;
  }

  return depth === 0 ? elements : [];
}

function directElementGaps(html, elements) {
  let cursor = 0;
  let gaps = "";
  for (const element of elements) {
    gaps += html.slice(cursor, element.start);
    cursor = element.end;
  }
  return gaps + html.slice(cursor);
}

function mergeControlEntries(left, right, control) {
  return {
    control,
    start: left.start,
    end: right.end
  };
}

function ordinalCaptionTitle(fieldTitle, captionTitle) {
  const title = cleanText(fieldTitle);
  const match = /^(.*\S)([0-9０-９]+)$/u.exec(title);
  if (!match) return undefined;
  const caption = inlineCaptionText(captionTitle);
  if (!caption || normalizeSemanticText(match[1]) !== normalizeSemanticText(caption)) return undefined;
  return caption;
}

function captionMatchesTitleEnd(captionTitle, fieldTitle) {
  const caption = normalizeSemanticText(inlineCaptionText(captionTitle));
  if (!caption) return false;
  const segments = cleanText(fieldTitle)
    .split(/\s*[-–—/／|｜:：]\s*/u)
    .map(normalizeSemanticText)
    .filter(Boolean);
  return segments.length > 0 && segments.at(-1) === caption;
}

function captionMatchesExactTitle(captionTitle, fieldTitle) {
  const caption = normalizeSemanticText(inlineCaptionText(captionTitle));
  const field = normalizeSemanticText(inlineCaptionText(fieldTitle));
  return Boolean(caption && field && caption === field);
}

function inlineCaptionText(value) {
  return cleanText(value).replace(/^[\s:：,，;；]+|[\s:：,，;；]+$/gu, "");
}

function normalizeSemanticText(value) {
  return normalizeMatchText(value).toLocaleLowerCase();
}

function withInlineCaption(control, caption, title, relation) {
  return {
    ...control,
    title,
    source: {
      ...control.source,
      inlineCaption: {
        id: caption.id,
        content: inlineCaptionText(caption.title),
        relation
      }
    }
  };
}

function withInlineHint(control, hint) {
  return {
    ...control,
    source: {
      ...control.source,
      inlineHint: {
        id: hint.id,
        content: cleanText(hint.title),
        relation: "post-break-styled-text"
      }
    }
  };
}

function designerBoundCaptions(html) {
  const controls = extractDesignerFieldControls(html, {
    includeHidden: true,
    includeTextLabels: true
  });
  const descriptionsById = new Map(
    controls
      .filter((control) => isSourceDescriptionControl(control))
      .map((control) => [control.id, control])
  );
  const references = controls
    .filter((control) =>
      !isSourceDescriptionControl(control) && !control.source?.designerHidden
    )
    .map((control) => control.source?.designerValues?._label_bind_id)
    .filter(Boolean);
  const referenceCounts = new Map();
  for (const labelId of references) {
    referenceCounts.set(labelId, (referenceCounts.get(labelId) || 0) + 1);
  }
  return new Map(
    [...referenceCounts.entries()]
      .filter(([labelId, count]) => count === 1 && descriptionsById.has(labelId))
      .map(([labelId]) => [labelId, descriptionsById.get(labelId)])
  );
}

function withBoundCaptionEntry(entry, boundCaptions) {
  const labelId = entry.control?.source?.designerValues?._label_bind_id;
  const caption = boundCaptions.get(labelId);
  if (!caption || isSourceDescriptionControl(entry.control)) return entry;
  return {
    ...entry,
    control: {
      ...entry.control,
      title: cleanText(caption.title),
      source: {
        ...entry.control.source,
        boundCaption: {
          id: caption.id,
          content: cleanText(caption.title),
          relation: "explicit-label-bind-id"
        }
      }
    }
  };
}

function appendMissingControls(controls, additions) {
  const seen = new Set(controls.map((control) => control.id));
  const result = [...controls];
  for (const addition of additions) {
    if (seen.has(addition.id)) continue;
    seen.add(addition.id);
    result.push(addition);
  }
  return result;
}

// One designer <td> remains one source-layout cell. The deterministic DSL
// mapper expands its ordered references and gives detail tables target rows.
function groupLayoutCellControls(controls) {
  return [controls];
}

function extractDesignerFieldControls(html, options = {}) {
  return extractDesignerFieldControlEntries(html, options).map((entry) => entry.control);
}

function extractDesignerFieldControlEntries(html, options = {}) {
  const controls = [];
  const hiddenRanges = hiddenAncestorRanges(html);
  const controlPattern = /<([a-zA-Z][\w:-]*)\b([^>]*\bfd_type\s*=\s*(["'])([^"']+)\3[^>]*)>/gi;

  for (const match of html.matchAll(controlPattern)) {
    const fdType = match[4];
    const normalizedType = String(fdType || "").toLowerCase();
    if (normalizedType === "textlabel" && !options.includeTextLabels) continue;
    const values = parseDesignerFdValues(match[2]);
    const fragment = matchingElementFragment(html, match);
    const hidden = isHiddenDesignerControl(values, match[2], fragment) ||
      hiddenRanges.some((range) => match.index >= range.start && match.index < range.end);
    if (hidden && !options.includeHidden) continue;
    const field = designerFieldFromControl(fdType, values, match[2], {
      html: fragment,
      hidden
    });
    if (field) controls.push({
      control: field,
      start: match.index,
      end: match.index + fragment.length
    });
  }

  return controls;
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
    designerValues: sanitizeDesignerValues(normalized, values),
    designerTableName: attrValue(attrs, "tableName") || undefined,
    designerShowStatus: attrValue(attrs, "showStatus") || undefined,
    ...(normalized === "restdialog" ? { restDialog: restDialogEvidence(values) } : {}),
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
  if (normalized === "linklabel") {
    const content = cleanText(values.content || title);
    const link = normalizeDesignerLink(values.link || linkHrefFromHtml(context.html || ""));
    const descriptionContent = [content, link].filter(Boolean).join("\n");
    if (!descriptionContent) return undefined;
    return {
      id,
      title: content || link || id,
      type: "LinkLabel",
      required: false,
      source: {
        ...source,
        designerValues: {
          ...source.designerValues,
          content: descriptionContent,
          ...(link ? { link } : {})
        }
      }
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
  if (["inputtext", "calculation", "sqldialog"].includes(normalized)) {
    return { id, title, type: "text", required, mk: mkForFieldType("text"), source };
  }
  if (normalized === "restdialog") {
    return { id, title, type: "RestDialog", required, source };
  }
  // EKP chinaValue is a read-only Chinese-currency display bound to a related amount field.
  // Map it as ordinary text so metadata matching and convertCurrency scripts have a target.
  if (normalized === "chinavalue") {
    return { id, title, type: "text", required, mk: mkForFieldType("text"), source };
  }

  return undefined;
}

function normalizeDesignerLink(value) {
  const decoded = decodeDesignerValue(value);
  const sanitized = sanitizeCredentialMaterial(decoded);
  return cleanText(sanitized.redactedPaths.length ? "" : sanitized.value);
}

function decodeDesignerValue(value) {
  let current = String(value || "");
  for (let index = 0; index < 5; index += 1) {
    const next = decodeEntities(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

function linkHrefFromHtml(html) {
  const match = String(html || "").match(/<a\b[^>]*\bhref\s*=\s*(["'])([\s\S]*?)\1/i);
  return match ? match[2] : "";
}

function extractDesignerDetailTableColumns(tableHtml, tableId) {
  if (!tableHtml) return [];

  const rows = splitDirectChildRows(extractFirstTbodyContent(tableHtml) || tableHtml);
  const headerSemantics = detailHeaderSemanticsByColumn(rows);
  const titleLabels = detailTitleLabelsById(rows);
  const columns = [];
  const seen = new Set();
  for (const row of rows) {
    // A noFoot marker classifies the whole direct-child row as a detail footer.
    // The marker and its main-model total commonly occupy sibling cells, so
    // filtering only the marked cell would also retain the footer total as a
    // row-scoped detail column.
    if (isDetailFooterRow(row)) continue;
    const cells = splitDirectChildCells(row);
    for (const [cellIndex, cell] of cells.entries()) {
      if (isNonDataDetailCell(cell.attrs)) continue;
      const sourceColumn = parseColumnSpec(cell.attrs.column, cellIndex).column;
      for (const control of extractDesignerFieldControls(cell.body)) {
        if (!isDetailColumnControl(control, tableId) || seen.has(control.id)) continue;
        seen.add(control.id);
        const withHeader = withDetailHeaderSemantics(control, headerSemantics.get(sourceColumn));
        columns.push(detailColumnWithTitleLabel(withHeader, titleLabels));
      }
    }
  }
  return columns;
}

function detailHeaderSemanticsByColumn(rows) {
  const candidates = new Map();
  const ambiguous = new Set();

  for (const row of rows) {
    const cells = splitDirectChildCells(row);
    for (const [cellIndex, cell] of cells.entries()) {
      const semantics = detailHeaderSemantics(cell.body);
      if (!semantics) continue;
      const sourceColumn = parseColumnSpec(cell.attrs.column, cellIndex).column;
      if (candidates.has(sourceColumn)) {
        candidates.delete(sourceColumn);
        ambiguous.add(sourceColumn);
      } else if (!ambiguous.has(sourceColumn)) {
        candidates.set(sourceColumn, semantics);
      }
    }
  }

  return candidates;
}

function detailHeaderSemantics(html) {
  const entries = extractDesignerFieldControlEntries(html, { includeTextLabels: true });
  if (!entries.length || entries.some((entry) => !isSourceDescriptionControl(entry.control))) {
    return undefined;
  }
  const captions = entries.filter((entry) => isPlainInlineCaption(entry.control));
  if (captions.length !== 1) return undefined;
  const hints = entries.filter((entry) =>
    entry.control.id !== captions[0].control.id &&
    isStyledSourceDescriptionControl(entry.control)
  );
  const hint = hints.length === 1 && hasDirectDesignerBreakBetween(html, captions[0], hints[0])
    ? hints[0].control
    : undefined;
  return {
    caption: captions[0].control,
    hint
  };
}

function withDetailHeaderSemantics(control, semantics) {
  if (!semantics) return control;
  const headerContent = cleanText(semantics.caption.title);
  return withUnboundDetailDisplayText({
    ...control,
    title: headerContent,
    source: {
      ...control.source,
      detailHeaderCaption: {
        id: semantics.caption.id,
        content: headerContent,
        relation: "same-detail-column-header"
      },
      ...(semantics.hint
        ? {
            inlineHint: {
              id: semantics.hint.id,
              content: cleanText(semantics.hint.title),
              relation: "same-detail-column-header-post-break-styled-text"
            }
          }
        : {})
    }
  }, headerContent);
}

function detailTitleLabelsById(rows) {
  const labels = new Map();
  for (const row of rows) {
    if (!isDetailTitleRow(row)) continue;
    for (const cell of splitDirectChildCells(row)) {
      for (const label of extractDesignerFieldControls(cell.body, { includeTextLabels: true })) {
        if (label.type !== "description" || !label.id || !label.title) continue;
        labels.set(label.id, label.title);
      }
    }
  }
  return labels;
}

function isDetailTitleRow(rowHtml) {
  return /^<tr\b[^>]*\btype\s*=\s*(["'])titleRow\1/i.test(String(rowHtml || ""));
}

function detailColumnWithTitleLabel(control, titleLabels) {
  const values = control.source?.designerValues || {};
  if (String(values._label_bind).toLowerCase() !== "false") return control;
  const title = titleLabels.get(values._label_bind_id);
  if (!title) return control;
  return withUnboundDetailDisplayText({
    ...control,
    title
  }, title);
}

function withUnboundDetailDisplayText(control, headerContent) {
  const values = control.source?.designerValues || {};
  if (String(values._label_bind).toLowerCase() !== "false") return control;
  const content = cleanText(values.label);
  const header = cleanText(headerContent);
  if (!content || !header || content === header) return control;
  return {
    ...control,
    source: {
      ...control.source,
      displayText: {
        content,
        relation: "unbound-detail-control-display-text-distinct-from-header"
      }
    }
  };
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
  if (!control || control.type === "detailTable" || isSourceDescriptionControl(control)) return false;
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

function hiddenAncestorRanges(html) {
  const ranges = [];
  const stack = [];
  for (const token of scanHtmlTags(html)) {
    if (token.closing) {
      const entry = stack.pop();
      if (entry?.rootHidden) ranges.push({ start: entry.contentStart, end: token.start });
      continue;
    }
    if (token.selfClosing || isVoidLikeTag(token.name)) continue;
    const parentHidden = stack.at(-1)?.hidden === true;
    const values = parseDesignerFdValues(token.attrs);
    const ownHidden = isHiddenDesignerControl(values, token.attrs, token.raw);
    stack.push({
      name: token.name,
      contentStart: token.end,
      hidden: parentHidden || ownHidden,
      rootHidden: ownHidden && !parentHidden
    });
  }
  for (const entry of stack) {
    if (entry.rootHidden) ranges.push({ start: entry.contentStart, end: String(html || "").length });
  }
  return ranges;
}

function nestedDetailControlIds(html) {
  const ids = new Set();
  const detailTables = extractDesignerFieldControls(html, {
    includeHidden: true,
    includeTextLabels: true
  }).filter((control) => control.type === "detailTable");
  for (const table of detailTables) {
    const tableHtml = matchingDetailTableFragment(html, table.id);
    for (const control of extractDesignerFieldControls(tableHtml, {
      includeHidden: true,
      includeTextLabels: true
    })) {
      if (control.id !== table.id) ids.add(control.id);
    }
  }
  return ids;
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

function matchingDetailTableFragment(html, tableId) {
  if (!html || !tableId) return "";
  const controlPattern = /<([a-zA-Z][\w:-]*)\b([^>]*\bfd_type\s*=\s*(["'])detailsTable\3[^>]*)>/gi;
  for (const match of html.matchAll(controlPattern)) {
    const values = parseDesignerFdValues(match[2]);
    const id = values.id || attrValue(match[2], "id");
    if (id !== tableId) continue;
    return matchingElementFragment(html, match);
  }
  return "";
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
    return end >= openEnd ? html.slice(openEnd, end) : html.slice(openEnd);
  }
  return "";
}

function extractFirstTbodyContent(fragment) {
  const match = /<tbody\b[^>]*>/i.exec(fragment);
  if (!match) return "";
  const start = match.index + match[0].length;
  const end = findMatchingCloseTag(fragment, start, "tbody");
  return end >= start ? fragment.slice(start, end) : fragment.slice(start);
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
