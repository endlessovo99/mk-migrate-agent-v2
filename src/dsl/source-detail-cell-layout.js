import { canonicalJson } from "../agent-review/digest.js";

/** Source detail cells are physical regions, not equivalence of header text. */
export function sourceDetailCellGroups(form = {}) {
  const groups = [];
  for (const table of Array.isArray(form?.detailTables) ? form.detailTables : []) {
    const seen = new Set();
    const columns = Array.isArray(table?.columns) ? table.columns : [];
    for (const column of columns) {
      const cell = column?.sourceProps?.detailCell;
      if (!cell || !Array.isArray(cell.fieldIds) || cell.fieldIds.length < 2) continue;
      const key = `${cell.row}:${cell.cell}`;
      if (seen.has(key)) continue;
      seen.add(key);
      groups.push({ table, cell });
    }
    // Retained Source Drafts created before cell membership was recorded can
    // still contain the independently parsed physical column-header identity.
    // Do not silently admit a likely shared column when its cell is unknown.
    const legacyHeaders = new Map();
    for (const column of columns) {
      const header = column?.sourceProps?.detailHeaderCaption;
      if (column?.sourceProps?.detailCell || header?.relation !== "same-detail-column-header" || !header.id) continue;
      const members = legacyHeaders.get(header.id) || [];
      members.push(column.id);
      legacyHeaders.set(header.id, members);
    }
    for (const fieldIds of legacyHeaders.values()) {
      if (fieldIds.length > 1) groups.push({ table, cell: { fieldIds }, legacy: true });
    }
  }
  return groups;
}

const PRESENTABLE_COMPONENTS = new Set(["xform-input", "xform-textarea", "xform-radio", "xform-select"]);

/** Rebuild the narrow, source-proven inline presentation from both sides. */
export function sourceDetailCellCandidates(sourceForm, targetForm) {
  if (targetForm?.layout?.sizing !== "adaptive") return [];
  const fields = Array.isArray(targetForm?.fields) ? targetForm.fields : [];
  return sourceDetailCellGroups(sourceForm).flatMap(({ table, cell, legacy }) => {
    if (legacy || cell.inline !== true || cell.runtimeInline !== true || ![cell.row, cell.column, cell.cell].every(Number.isSafeInteger) ||
        [cell.row, cell.column, cell.cell].some(value => value < 0) || new Set(cell.fieldIds).size !== cell.fieldIds.length) return [];
    const sourceColumns = cell.fieldIds.map(id => (table.columns || []).filter(column => column?.id === id));
    if (sourceColumns.some(matches => matches.length !== 1)) return [];
    const originals = sourceColumns.map(matches => matches[0]);
    if (originals.some(column => {
      const own = column.sourceProps?.detailCell;
      return !own || own.inline !== true || own.runtimeInline !== true || own.row !== cell.row || own.column !== cell.column || own.cell !== cell.cell ||
        JSON.stringify(own.fieldIds) !== JSON.stringify(cell.fieldIds);
    })) return [];
    const tables = fields.filter(field => field?.sourceRef === table.sourceRef && field.type === "detailTable");
    if (tables.length !== 1 || !Array.isArray(tables[0].columns) || tables[0].columns.length > 64) return [];
    const target = tables[0], pairs = [];
    for (const source of originals) {
      if (source.dataOnly === true || source.sourceProps?.hardHidden === true) continue;
      const matches = target.columns.filter(column => column?.sourceRef === source.sourceRef);
      if (matches.length !== 1) return [];
      const column = matches[0];
      if (column.dataOnly === true && column.sourceProps?.legacyDetailComposite?.role === "stored_display_shadow") continue;
      if (column.dataOnly === true || !PRESENTABLE_COMPONENTS.has(column.componentId) ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,24}$/.test(String(column.id || ""))) return [];
      pairs.push({ source, column });
    }
    if (pairs.length !== 2) return [];
    const headers = pairs.map(pair => pair.source.sourceProps?.detailHeaderCaption);
    if (headers.some(header => header?.relation !== "same-detail-column-header" || !header.id || !header.content) ||
        headers[0].id !== headers[1].id || headers[0].content !== headers[1].content || pairs[0].column.title !== headers[0].content) return [];
    if ((table.columns || []).some(column => column?.sourceProps?.detailHeaderCaption?.id === headers[0].id &&
        !cell.fieldIds.includes(column.id))) return [];
    const rendered = target.columns.filter(column => column?.dataOnly !== true && column?.componentId !== "xform-hidden");
    const index = rendered.findIndex(column => column?.sourceRef === pairs[0].source.sourceRef);
    if (index < 0 || rendered[index + 1]?.sourceRef !== pairs[1].source.sourceRef) return [];
    return [{ tableRef: table.sourceRef, group: {
      version: 1, fieldIds: pairs.map(pair => pair.column.id), sourceRefs: pairs.map(pair => pair.source.sourceRef),
      headerId: headers[0].id, sourceCell: { row: cell.row, column: cell.column, cell: cell.cell }
    } }];
  });
}

/**
 * The current native writer creates one column per visible field. A source
 * cell with independent visible editors is not equivalent to that output.
 * A previously proven address/display fold has only one interactive editor.
 */
export function sourceDetailCellLayoutErrors(sourceForm, expectedForm) {
  const candidates = sourceDetailCellCandidates(sourceForm, expectedForm);
  return sourceDetailCellGroups(sourceForm).flatMap(({ table, cell, legacy }) => {
    const columns = table.columns || [];
    const targetFields = Array.isArray(expectedForm?.fields) ? expectedForm.fields : [];
    const targetTables = targetFields.filter(field => field?.sourceRef === table.sourceRef);
    const targetColumns = targetTables.length === 1 && Array.isArray(targetTables[0].columns) ? targetTables[0].columns : [];
    let complete = new Set(cell.fieldIds).size === cell.fieldIds.length;
    const visible = [];
    for (const id of cell.fieldIds) {
      const matches = columns.filter(column => column?.id === id);
      if (matches.length !== 1) { complete = false; continue; }
      const column = matches[0], own = column.sourceProps?.detailCell;
      if (!legacy && (!own || own.row !== cell.row || own.cell !== cell.cell || own.column !== cell.column ||
          JSON.stringify(own.fieldIds) !== JSON.stringify(cell.fieldIds))) complete = false;
      if (column.dataOnly === true || column.sourceProps?.hardHidden === true) continue;
      const target = targetColumns.filter(item => item?.sourceRef === column.sourceRef);
      const folded = target.length === 1 && target[0].dataOnly === true &&
        target[0].sourceProps?.legacyDetailComposite?.role === "stored_display_shadow";
      if (!folded) visible.push(id);
    }
    if (complete && visible.length < 2) return [];
    const admitted = !legacy && candidates.find(candidate => candidate.tableRef === table.sourceRef &&
      candidate.group.sourceCell.row === cell.row && candidate.group.sourceCell.cell === cell.cell &&
      candidate.group.sourceCell.column === cell.column);
    if (admitted && targetTables.length === 1 && Array.isArray(targetTables[0].detailCellGroups) &&
        targetTables[0].detailCellGroups.some(group => canonicalJson(group) === canonicalJson(admitted.group))) return [];
    return [{
      code: "source.form.detail_cell_layout_unproven",
      message: "Independent editors in one source detail cell cannot be projected as separate native columns without a verified shared-cell layout.",
      path: "/form/detailTables",
      details: { tableId: table.id, sourceRef: table.sourceRef, ...(legacy ? {} : { row: cell.row, column: cell.column }),
        fieldIds: complete ? visible : cell.fieldIds, ...(complete
          ? (legacy ? { reason: "source_cell_membership_unavailable" } : {})
          : { reason: "source_cell_membership_incomplete" }) }
    }];
  });
}

/** Validate retained trusted DSLs at the source-free execution boundary. */
export function projectedDetailCellLayoutErrors(form) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const detailTables = fields.filter(field => field?.type === "detailTable").map(table => ({
    id: table.sourceProps?.originalId || table.id,
    sourceRef: table.sourceRef,
    columns: (Array.isArray(table.columns) ? table.columns : []).map(column => ({
      ...column,
      id: column?.sourceProps?.originalId || column?.id
    }))
  }));
  const sourceForm = { detailTables };
  const errors = sourceDetailCellLayoutErrors(sourceForm, form).map(item => ({
    ...item, level: "error", code: item.code.replace(/^source\.form/, "dsl.form")
  }));
  const candidates = sourceDetailCellCandidates(sourceForm, form);
  for (const table of detailTables) {
    const actual = fields.filter(field => field?.sourceRef === table.sourceRef && field.type === "detailTable");
    const expectedGroups = candidates.filter(item => item.tableRef === table.sourceRef).map(item => item.group);
    if (actual.length !== 1 || canonicalJson(actual[0].detailCellGroups || []) !== canonicalJson(expectedGroups)) errors.push({
      level: "error", code: "dsl.form.detail_cell_group_unproven", path: "/form/fields",
      message: "Detail-cell presentation must exactly match its source-proven field membership.", details: { tableId: table.id }
    });
  }
  return errors;
}

export function detailCellPresentationDiagnostics(expectedForm, targetForm, { prefix = "trust.form" } = {}) {
  const tables = form => (Array.isArray(form?.fields) ? form.fields : []).filter(field => field?.type === "detailTable");
  const before = tables(expectedForm), after = tables(targetForm), refs = new Set([...before, ...after]
    .filter(table => table.detailCellGroups !== undefined).map(table => table.sourceRef));
  const diagnostics = [];
  for (const sourceRef of refs) {
    const expected = before.filter(table => table.sourceRef === sourceRef), actual = after.filter(table => table.sourceRef === sourceRef);
    const mismatch = details => diagnostics.push({ level: "error", code: `${prefix}.detail_cell_presentation_source_mismatch`, path: "/form/fields",
      message: "Detail-cell presentation must retain the exact source-derived fields and ownership.", details: { sourceRef, ...details } });
    if (expected.length !== 1 || actual.length !== 1 || expected[0].id !== actual[0].id ||
        canonicalJson(expected[0].detailCellGroups || []) !== canonicalJson(actual[0].detailCellGroups || [])) { mismatch({ reason: "group" }); continue; }
    const memberRefs = new Set((expected[0].detailCellGroups || []).flatMap(group => group.sourceRefs || []));
    const semantics = field => {
      const props = { ...(field?.props || {}) };
      for (const key of ["required", "readOnly", "hiddenLabel"]) if (props[key] === false) delete props[key];
      return { id: field?.id, title: field?.title, type: field?.type, componentId: field?.componentId, props,
        dataOnly: field?.dataOnly === true, originalId: field?.sourceProps?.originalId,
        cell: field?.sourceProps?.detailCell, header: field?.sourceProps?.detailHeaderCaption };
    };
    for (const memberRef of memberRefs) {
      const fixed = (expected[0].columns || []).filter(field => field.sourceRef === memberRef);
      const received = (actual[0].columns || []).filter(field => field.sourceRef === memberRef);
      if (fixed.length !== 1 || received.length !== 1 || canonicalJson(semantics(fixed[0])) !== canonicalJson(semantics(received[0]))) {
        mismatch({ reason: "member_binding", memberRef });
      }
    }
  }
  return diagnostics;
}
