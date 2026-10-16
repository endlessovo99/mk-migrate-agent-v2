import { canonicalJson } from "../agent-review/digest.js";

/** Source-backed plain captions beside independently fixed ordinary controls. */
export function sourceMobileCaptionGrids(form = {}) {
  const fields = Array.isArray(form?.fields) ? form.fields.filter(Boolean) : [];
  const byId = new Map(fields.map(field => [field.id, field]));
  const rows = Array.isArray(form?.layout?.mkTree) ? form.layout.mkTree.filter(Boolean) : [];
  const sourceRows = Array.isArray(form?.layout?.sourceGrid?.rows) ? form.layout.sourceGrid.rows : [];
  const nested = new Set(rows.flatMap(row => (Array.isArray(row.children) ? row.children : [])
    .filter(cell => cell?.refType === "layout").flatMap(cell => cell.refIds || [])));
  const profiles = new Map();
  if (byId.size !== fields.length) return profiles;
  for (const row of rows) {
    const cells = Array.isArray(row.children) ? row.children : [], columns = row.props?.columns;
    const sourceMatches = sourceRows.filter(source => source?.sourceRef === row.sourceRef);
    if (nested.has(row.id) || sourceMatches.length !== 1 || !Number.isInteger(columns) || columns < 2 ||
        ![undefined, 1].includes(row.props?.rows) || cells.length < 2 ||
        !cells.every(cell => cell?.refType === "field" && cell.refIds?.length === 1 &&
          [undefined, 0].includes(cell.row) && [undefined, 1].includes(cell.rowspan))) continue;
    const source = sourceMatches[0];
    if (source.preserveSourceGeometry !== true || source.columns !== columns || !Array.isArray(source.cells) || source.cells.length !== cells.length) continue;
    const rowFields = cells.map(cell => byId.get(cell.refIds[0]));
    if (rowFields.some(field => !sourceIdentity(field) || field.dataOnly === true || field.sourceProps?.hardHidden === true)) continue;
    const captions = rowFields.filter(field => field.componentId === "xform-description");
    if (!captions.length || captions.length === rowFields.length || !captions.every(plainCaption)) continue;
    const covered = new Set(), percentTextareaColumns = [];
    let percentTextareas = 0;
    let complete = true;
    for (let index = 0; index < cells.length; index++) {
      const cell = cells[index], field = rowFields[index], original = source.cells[index];
      if (!original) { complete = false; break; }
      const flow = cell.contentFlow, sourceFlow = original.contentFlow;
      const width = flow?.items?.[0]?.width;
      if (!Number.isInteger(cell.column) || !Number.isInteger(cell.colspan) || cell.colspan < 1 || cell.column < 0 ||
          cell.column + cell.colspan > columns || !Number.isFinite(cell.widthWeight) || cell.widthWeight <= 0 ||
          original.sourceRef !== cell.sourceRef || original.column !== cell.column || original.colspan !== cell.colspan ||
          original.widthWeight !== cell.widthWeight || ![undefined, 1].includes(original.rowspan) ||
          original.references?.length !== 1 || original.references[0].sourceRef !== field.sourceRef ||
          original.references[0].referenceId !== field.id ||
          !singleFlow(flow, field.id) || !singleFlow(sourceFlow, field.id) ||
          canonicalJson(width) !== canonicalJson(sourceFlow.items[0].width) ||
          (captions.includes(field) ? cell.colspan !== 1 || width !== undefined :
            !fixedOrdinary(field, width) && !(captions.length >= 2 && percentTextarea(field, width)))) {
        complete = false; break;
      }
      if (percentTextarea(field, width)) {
        percentTextareas++;
        for (let column = cell.column; column < cell.column + cell.colspan; column++) percentTextareaColumns.push(column);
      }
      for (let column = cell.column; column < cell.column + cell.colspan; column++) {
        if (covered.has(column)) complete = false;
        covered.add(column);
      }
    }
    if (!complete || covered.size !== columns || percentTextareas > 1) continue;
    profiles.set(row.id, { row, source, fields: rowFields.map(fieldSemantics),
      ...(percentTextareas ? { percentTextareaColumns } : {}) });
  }
  for (const row of rows) {
    if (profiles.has(row.id) || nested.has(row.id)) continue;
    const sources = sourceRows.filter(source => source?.sourceRef === row.sourceRef);
    if (sources.length !== 1) continue;
    const cells = completeFlatRow(row, sources[0], byId);
    if (!cells) continue;
    const caption = entry => entry.fields.length === 1 && plainCaption(entry.fields[0]) &&
      entry.cell.colspan === 1 && entry.cell.contentFlow.items[0].width === undefined;
    const captions = cells.filter(caption), bodies = cells.filter(entry => !caption(entry));
    // Fixed widgets with a static inline hint contribute their complete cell's
    // intrinsic width, just as the existing independently fixed widgets do.
    const fixedHints = captions.length >= 2 && bodies.length > 0 && bodies.every(entry =>
      entry.fields.some((field, index) => fixedOrdinary(field, entry.cell.contentFlow.items[index].width)) &&
      entry.fields.every((field, index) => fixedOrdinary(field, entry.cell.contentFlow.items[index].width) ||
        staticDescription(field) && !field.props?.style && !/[\r\n<>]/.test(field.props.content) &&
        entry.cell.contentFlow.items[index].width === undefined));
    const lastBody = cells.length === 2 && caption(cells[0]) &&
      cells[0].cell.column === 0 && cells[1].cell.column === 1 &&
      cells[1].cell.colspan === row.props.columns - 1 &&
      cells[1].fields.every(field => field.componentId !== "xform-description" || staticDescription(field)) &&
      cells[1].fields.some(field => field.componentId !== "xform-description" || !plainCaption(field));
    if (!fixedHints && !lastBody) continue;
    profiles.set(row.id, { row, source: sources[0], fields: cells.flatMap(entry => entry.fields.map(fieldSemantics)),
      ...(!fixedHints ? { percentBodyColumns: Array.from({ length: row.props.columns - 1 }, (_, index) => index + 1) } : {}) });
  }
  for (const row of rows) {
    if (profiles.has(row.id) || nested.has(row.id)) continue;
    const sources = sourceRows.filter(source => source?.sourceRef === row.sourceRef);
    if (sources.length !== 1 || !normalizedTrailingBlanks(row, sources[0], byId)) continue;
    const cells = completeFlatCells(row, sources[0], byId);
    if (!cells || cells.some(entry => entry.fields.length !== 1) || !plainCaption(cells[0].fields[0]) ||
        cells[0].cell.contentFlow.items[0].width !== undefined || cells[1].fields[0].componentId === "xform-description") continue;
    profiles.set(row.id, { row, source: sources[0], fields: cells.flatMap(entry => entry.fields.map(fieldSemantics)), percentBodyColumns: [1] });
  }
  return profiles;
}

function completeFlatRow(row, source, byId) {
  if (source.preserveSourceGeometry !== true || source.columns !== row.props?.columns) return undefined;
  return completeFlatCells(row, source, byId);
}

function completeFlatCells(row, source, byId) {
  const cells = row.children, columns = row.props?.columns;
  if (!Number.isInteger(columns) || columns < 2 || ![undefined, 1].includes(row.props?.rows) ||
      !Array.isArray(cells) ||
      cells.length < 2 || !Array.isArray(source.cells) || source.cells.length !== cells.length) return undefined;
  const covered = new Set(), identities = new Set(), entries = [];
  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index], original = source.cells[index], ids = cell.refIds;
    if (cell.refType !== "field" || !Array.isArray(ids) || !ids.length ||
        ![undefined, 0].includes(cell.row) || ![undefined, 1].includes(cell.rowspan) ||
        !Number.isInteger(cell.column) || !Number.isInteger(cell.colspan) || cell.colspan < 1 || cell.column < 0 ||
        cell.column + cell.colspan > columns || !Number.isFinite(cell.widthWeight) || cell.widthWeight <= 0 ||
        !original || original.sourceRef !== cell.sourceRef || original.column !== cell.column ||
        original.colspan !== cell.colspan || original.widthWeight !== cell.widthWeight ||
        ![undefined, 1].includes(original.rowspan) || original.references?.length !== ids.length ||
        canonicalJson(cell.contentFlow) !== canonicalJson(original.contentFlow)) return undefined;
    const fields = ids.map(id => byId.get(id)), flow = cell.contentFlow;
    if (fields.some(field => !sourceIdentity(field) || field.dataOnly === true || field.sourceProps?.hardHidden === true) ||
        !Array.isArray(flow?.items) || flow.items.length !== ids.length ||
        !Array.isArray(flow.lines) || !flow.lines.length || !flow.lines.every(line => Array.isArray(line) && line.length) ||
        canonicalJson(flow.lines.flat()) !== canonicalJson(ids)) return undefined;
    for (let position = 0; position < ids.length; position++) {
      const id = ids[position], field = fields[position], reference = original.references[position], item = flow.items[position];
      if (identities.has(id) || reference.referenceType !== "control" || reference.referenceId !== id ||
          reference.sourceRef !== field.sourceRef || item?.referenceId !== id ||
          item.width !== undefined && (!Number.isFinite(item.width?.value) || item.width.value <= 0 ||
            !["px", "%"].includes(item.width.unit) || item.width.unit === "%" && item.width.value > 100)) return undefined;
      identities.add(id);
    }
    for (let column = cell.column; column < cell.column + cell.colspan; column++) {
      if (covered.has(column)) return undefined;
      covered.add(column);
    }
    entries.push({ cell, fields });
  }
  return covered.size === columns ? entries : undefined;
}

function normalizedTrailingBlanks(row, source, byId) {
  const fact = source.trailingBlankCells, cells = row.children;
  if (!fact || typeof fact !== "object" || Array.isArray(fact) || row.props?.columns !== 2 ||
      source.preserveSourceGeometry === true || (source.sourceMarkers?.length || 0) !== 0 ||
      !Number.isInteger(source.columns) || source.columns < 3 || source.columns > 8 || fact.sourceColumns !== source.columns ||
      fact.retainedColumns !== 2 || !Number.isInteger(fact.rowIndex) || fact.rowIndex < 0 ||
      String(fact.rowIndex) !== source.sourceRow || !/^[A-Za-z_][\w-]*$/.test(fact.tableId || "") ||
      !["px", "percent"].includes(fact.widthUnit) || !Array.isArray(fact.omittedColumns) ||
      canonicalJson(fact.omittedColumns) !== canonicalJson(Array.from({ length: source.columns - 2 }, (_, index) => index + 2)) ||
      !Array.isArray(fact.keptWidthWeights) || fact.keptWidthWeights.length !== 2 ||
      !fact.keptWidthWeights.every(value => Number.isFinite(value) && value > 0 && (fact.widthUnit !== "percent" || value <= 100)) ||
      !Array.isArray(cells) || cells.length !== 2 || source.cells?.length !== 2 ||
      Object.keys(fact).some(key => !["captionId", "bodyId", "tableId", "rowIndex", "sourceColumns", "retainedColumns",
        "omittedColumns", "widthUnit", "keptWidthWeights", "scriptCarrierIds"].includes(key))) return false;
  if (fact.scriptCarrierIds !== undefined && (!Array.isArray(fact.scriptCarrierIds) || !fact.scriptCarrierIds.length ||
      new Set(fact.scriptCarrierIds).size !== fact.scriptCarrierIds.length ||
      fact.scriptCarrierIds.some(id => !/^[A-Za-z_][\w-]*$/.test(id || "")))) return false;
  return cells.every((cell, index) => {
    const field = byId.get(cell.refIds?.[0]), original = source.cells[index];
    return cell.refIds?.length === 1 && field && cell.column === index && cell.colspan === 1 &&
      (index === 0 || field.type === "singleSelect" && field.componentId === "xform-select" && field.sourceProps?.designerType === "select") &&
      (field.sourceProps?.originalId || field.id) === (index === 0 ? fact.captionId : fact.bodyId) &&
      cell.widthWeight === fact.keptWidthWeights[index] && original?.widthWeight === fact.keptWidthWeights[index];
  });
}

function staticDescription(field) {
  const content = field.props?.content, values = field.sourceProps?.designerValues;
  return field.componentId === "xform-description" && field.type === "description" &&
    field.sourceProps?.designerType?.toLowerCase() === "textlabel" && typeof content === "string" && content.trim() &&
    typeof values?.content === "string" && content === values.content && !/\$\{|<%/.test(content);
}

function sourceIdentity(field) {
  const original = field?.sourceProps?.originalId || field?.id;
  return typeof original === "string" && /^[A-Za-z_][\w-]*$/.test(original) &&
    typeof field.sourceProps?.designerType === "string" &&
    field.sourceProps?.designerId === original && field.sourceProps?.designerValues?.id === original &&
    typeof field.sourceRef === "string" && field.sourceRef.startsWith("source.form.control.");
}
function plainCaption(field) {
  const source = field.sourceProps, values = source.designerValues;
  return source.runtimePlainCaption === true && field.type === "description" &&
    source.designerType?.toLowerCase() === "textlabel" && !field.props?.style &&
    typeof field.props?.content === "string" && field.props.content.trim() &&
    !/[<>]|\$\{|<%/.test(field.props.content) &&
    (!/[\r\n]/.test(field.props.content) || /^[^\r\n]+(?:\r\n|\n)[ \t\u00a0]*$/.test(field.props.content)) &&
    typeof values.content === "string" && field.props.content.trim() === values.content.trim() &&
    (source.runtimePlainCaptionMarkerIds === undefined || Array.isArray(source.runtimePlainCaptionMarkerIds) &&
      source.runtimePlainCaptionMarkerIds.length > 0 && new Set(source.runtimePlainCaptionMarkerIds).size === source.runtimePlainCaptionMarkerIds.length &&
      source.runtimePlainCaptionMarkerIds.every(id => typeof id === "string" && /^[A-Za-z_][\w-]*$/.test(id))) &&
    !Object.keys(source.metadataAttributes || {}).some(key => key.toLowerCase() === "width");
}
function singleFlow(flow, id) {
  return flow?.items?.length === 1 && flow.items[0].referenceId === id &&
    flow.lines?.length === 1 && flow.lines[0]?.length === 1 && flow.lines[0][0] === id;
}
function fixedOrdinary(field, width) {
  const source = field.sourceProps, values = source.designerValues;
  if (width === undefined && field.componentId === "xform-radio" && field.type === "radio" &&
      source.designerType?.toLowerCase() === "inputradio" && source.designerRadioLayoutLiteral === true && ["H", "V"].includes(values.alignment) &&
      !Object.hasOwn(values, "width") && !Object.keys(source.metadataAttributes || {}).some(key => key.toLowerCase() === "width") &&
      Array.isArray(field.props.options) && field.props.options.length > 0 && field.props.options.every(option =>
        option && typeof option.label === "string" && typeof option.value === "string" && option.type === undefined)) return true;
  if (width?.unit !== "px" || !Number.isFinite(width.value) || width.value <= 0 ||
      values.multiSelect === "true" || field.props?.multiple === true) return false;
  if (field.componentId === "xform-input") return field.type === "text" &&
    source.designerType?.toLowerCase() === "inputtext" && [undefined, "String"].includes(values.dataType);
  if (field.componentId === "xform-address") return field.type === "text" && source.designerType?.toLowerCase() === "address";
  return field.componentId === "xform-radio" && field.type === "radio" &&
    source.designerType?.toLowerCase() === "inputradio" && Array.isArray(field.props.options) && field.props.options.length > 0 &&
    field.props.options.every(option => option && typeof option.label === "string" && typeof option.value === "string" &&
      option.value !== "other_" && option.type === undefined);
}
function percentTextarea(field, width) {
  return field.componentId === "xform-textarea" && field.type === "longText" &&
    field.sourceProps?.designerType?.toLowerCase() === "textarea" &&
    [undefined, "String"].includes(field.sourceProps?.designerValues?.dataType) &&
    width?.unit === "%" && Number.isFinite(width.value) && width.value > 0 && width.value <= 100;
}
function fieldSemantics(field) {
  const props = { ...(field?.props || {}) };
  for (const key of ["required", "readOnly", "hiddenLabel"]) if (props[key] === false) delete props[key];
  return { id: field?.id, sourceRef: field?.sourceRef, title: field?.title, type: field?.type,
    componentId: field?.componentId, dataOnly: field?.dataOnly === true, props, sourceProps: field?.sourceProps };
}

/** The fact and every granted row are rebuilt from the fixed source, in both directions. */
export function mobileCaptionSourceDiagnostics(expectedForm, targetForm, { prefix = "trust.form" } = {}) {
  const expectedFields = Array.isArray(expectedForm?.fields) ? expectedForm.fields.filter(Boolean) : [];
  const actualFields = Array.isArray(targetForm?.fields) ? targetForm.fields.filter(Boolean) : [];
  const sourceRefs = new Set([...expectedFields, ...actualFields].filter(field =>
    field.sourceProps?.runtimePlainCaption === true || Object.hasOwn(field.sourceProps || {}, "runtimePlainCaptionMarkerIds")
  ).map(field => field.sourceRef));
  const diagnostics = [];
  const error = details => ({ level: "error", code: `${prefix}.mobile_plain_caption_source_mismatch`, path: "/form",
    message: "Plain caption evidence, field semantics and the complete source row must match the fixed source projection.", details });
  const expectedRows = expectedForm?.layout?.sourceGrid?.rows || [], actualRows = targetForm?.layout?.sourceGrid?.rows || [];
  const proofRows = new Set([...expectedRows, ...actualRows].filter(row => Object.hasOwn(row || {}, "trailingBlankCells")).map(row => row.sourceRef));
  for (const sourceRef of proofRows) {
    const before = expectedRows.filter(row => row.sourceRef === sourceRef), after = actualRows.filter(row => row.sourceRef === sourceRef);
    const beforeLayout = (expectedForm?.layout?.mkTree || []).filter(row => row.sourceRef === sourceRef);
    const afterLayout = (targetForm?.layout?.mkTree || []).filter(row => row.sourceRef === sourceRef);
    if (before.length !== 1 || after.length !== 1 || canonicalJson(before) !== canonicalJson(after) ||
        canonicalJson(beforeLayout) !== canonicalJson(afterLayout)) diagnostics.push(error({ trailingBlankRow: sourceRef }));
    const ids = new Set([...before, ...after].flatMap(row => (row.cells || []).flatMap(cell =>
      (cell.references || []).filter(reference => reference.referenceType === "control").map(reference => reference.referenceId))));
    for (const id of ids) {
      const expected = expectedFields.filter(field => field.id === id), actual = actualFields.filter(field => field.id === id);
      if (expected.length !== 1 || actual.length !== 1 || canonicalJson(expected.map(fieldSemantics)) !== canonicalJson(actual.map(fieldSemantics))) {
        diagnostics.push(error({ trailingBlankRow: sourceRef, fieldId: id }));
      }
    }
  }
  for (const sourceRef of sourceRefs) {
    const expected = expectedFields.filter(field => field.sourceRef === sourceRef);
    const actual = actualFields.filter(field => field.sourceRef === sourceRef);
    if (expected.length !== 1 || actual.length !== 1 ||
        canonicalJson(fieldSemantics(expected[0])) !== canonicalJson(fieldSemantics(actual[0]))) diagnostics.push(error({ sourceRef }));
    const markerIds = new Set([...expected, ...actual].flatMap(field =>
      Array.isArray(field.sourceProps?.runtimePlainCaptionMarkerIds) ? field.sourceProps.runtimePlainCaptionMarkerIds : []));
    for (const markerId of markerIds) {
      const naturalId = field => field.sourceProps?.originalId || field.id;
      const expectedHelpers = expectedFields.filter(field => naturalId(field) === markerId);
      const actualHelpers = actualFields.filter(field => naturalId(field) === markerId);
      if (expectedHelpers.length > 1 || actualHelpers.length > 1 || expectedHelpers.length !== actualHelpers.length ||
          expectedHelpers.length === 1 && canonicalJson(fieldSemantics(expectedHelpers[0])) !== canonicalJson(fieldSemantics(actualHelpers[0]))) {
        diagnostics.push(error({ sourceRef, markerId }));
      }
    }
  }
  const expected = sourceMobileCaptionGrids(expectedForm), actual = sourceMobileCaptionGrids(targetForm);
  for (const rowId of new Set([...expected.keys(), ...actual.keys()])) {
    if (canonicalJson(expected.get(rowId)) !== canonicalJson(actual.get(rowId))) diagnostics.push(error({ rowId }));
  }
  return diagnostics;
}
