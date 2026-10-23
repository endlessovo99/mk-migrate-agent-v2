/** Source-backed sizing for repeated complete direct rows. No table identity is
 * inferred from row numbers: rootTable is supplied by the strict XML parser. */
export function sourceTrackGeometry(projected, nodes, sourceGrid, fields = [], mobile = false) {
  const sourceRows = Array.isArray(sourceGrid?.rows) ? sourceGrid.rows : [];
  const rowsByRef = uniqueBy(sourceRows, row => row.sourceRef);
  const nodesByRef = uniqueBy(nodes, node => node.sourceRef);
  const projectionById = new Map(projected.map(row => [row.id, row]));
  const fieldsById = new Map(fields.map(field => [field.id, field]));
  const shared = new Map();
  const evidence = sourceGrid?.rootTable;
  const provedRoot = sourceGrid?.source === "fdDesignerHtml" && evidence?.version === 1 &&
    evidence.kind === "standard-table" && Number.isInteger(evidence.rowCount) && evidence.rowCount > 0 &&
    Object.keys(evidence).length === 3;
  if (provedRoot && !mobile) {
    let run = [];
    const flush = () => { if (run.length >= 2) for (const entry of run) shared.set(entry.projected.id, entry); run = []; };
    for (const source of sourceRows) {
      const node = nodesByRef.get(source.sourceRef), row = projectionById.get(node?.id);
      const profile = directTrackProfile(source, node, row, evidence.rowCount, fieldsById);
      if (!profile || run.length && (profile.index !== run.at(-1).index + 1 || profile.signature !== run[0].signature)) flush();
      if (profile) run.push(profile);
    }
    flush();
  }
  return projected.map(row => {
    const node = nodes.find(node => node.id === row.id), source = rowsByRef.get(node?.sourceRef), profile = shared.get(row.id);
    return {
      ...row,
      colsStyle: profile?.colsStyle || [{ startIndex: 0, count: row.columns, value: "auto" }],
      cells: row.cells.map(cell => ({ ...cell,
        ...(provedRoot && fullRowHeading(source, row, cell, fieldsById) ? { stretchDescription: true } : {}),
        ...(profile?.captions.get(cell.id) ? { captionWidth: profile.captions.get(cell.id) } : {})
      }))
    };
  });
}

function directTrackProfile(source, node, projected, rowCount, fields) {
  if (!/^(?:0|[1-9]\d*)$/.test(String(source.sourceRow)) || Number(source.sourceRow) >= rowCount ||
      source.preserveSourceGeometry !== true || !Number.isInteger(source.columns) || source.columns < 2 ||
      !node || !projected || projected.rows !== 1 || projected.columns !== source.columns || projected.cells.length < 2 ||
      projected.cells.some(cell => cell.ownerNodeId !== projected.id || cell.refType !== "field" || cell.refIds.length !== 1 || cell.rowspan !== 1)) return undefined;
  const cells = [...(source.cells || [])].sort((a, b) => a.column - b.column), weights = [];
  let next = 0;
  for (const cell of cells) {
    if (cell.column !== next || !Number.isInteger(cell.colspan) || cell.colspan < 1 ||
        cell.rowspan !== undefined && cell.rowspan !== 1 || !Number.isFinite(cell.widthWeight) || cell.widthWeight <= 0 ||
        cell.references?.length !== 1 || cell.references[0].referenceType !== "control" ||
        cell.evidence?.column !== cell.column || cell.evidence?.colspan !== cell.colspan ||
        cell.evidence?.widthWeight !== cell.widthWeight) return undefined;
    for (let i = 0; i < cell.colspan; i++) weights.push(cell.widthWeight / cell.colspan);
    next += cell.colspan;
  }
  if (next !== source.columns) return undefined;
  const captions = new Map();
  for (const cell of projected.cells) {
    const pieces = cells.filter(piece => piece.column >= cell.column && piece.column + piece.colspan <= cell.column + cell.colspan);
    const original = node.children.find(child => child.id === cell.id);
    if (!pieces.length || pieces[0].column !== cell.column || pieces.at(-1).column + pieces.at(-1).colspan !== cell.column + cell.colspan ||
        pieces.reduce((sum, piece) => sum + piece.colspan, 0) !== cell.colspan ||
        !Number.isFinite(original?.widthWeight) || original.widthWeight <= 0 ||
        Math.abs(pieces.reduce((sum, piece) => sum + piece.widthWeight, 0) - original.widthWeight) > 1e-8) return undefined;
    const field = fields.get(cell.refIds[0]), folded = field?.sourceProps?.foldedCaption;
    if (!folded) continue;
    const caption = pieces.find(piece => piece.sourceRef === folded.captionCellSourceRef);
    const value = pieces.find(piece => piece.sourceRef === folded.fieldCellSourceRef);
    if (pieces.length !== 2 || !caption || !value || caption.column + caption.colspan !== value.column ||
        caption.references[0].referenceId !== folded.id || value.references[0].referenceId !== field.id ||
        folded.referenceMap?.sourceRowRef !== source.sourceRef || field.props?.hiddenLabel === true || field.dataOnly ||
        ["xform-description", "xform-button", "xform-hyperlinks", "xform-hidden"].includes(field.componentId) ||
        field.sourceProps?.choiceOtherToggle || field.sourceProps?.otherTextCompanion) return undefined;
    const share = caption.widthWeight / (caption.widthWeight + value.widthWeight);
    if (!(share > 0 && share <= 0.5)) return undefined;
    captions.set(cell.id, percentage(share));
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const values = weights.map(weight => percentage(weight / total));
  return { projected, index: Number(source.sourceRow), signature: JSON.stringify(values), captions,
    colsStyle: values.map((value, startIndex) => ({ startIndex, count: 1, value })) };
}

function fullRowHeading(source, row, cell, fields) {
  if (!source || source.cells?.length !== 1 || row.cells.length !== 1 || cell.ownerNodeId !== row.id ||
      cell.refType !== "field" || cell.refIds.length !== 1 || cell.column !== 0 || cell.colspan !== row.columns) return false;
  const original = source.cells[0], field = fields.get(cell.refIds[0]);
  return !!field && original.column === 0 && original.colspan === source.columns && original.references?.length === 1 &&
    original.references[0].referenceId === field?.id && field.componentId === "xform-description" &&
    field.props?.style?.textAlign === "center" && cell.contentFlow?.items?.length === 1 &&
    cell.contentFlow.lines?.length === 1 && cell.contentFlow.lines[0].length === 1 &&
    cell.contentFlow.items[0].width?.value !== 0;
}

function uniqueBy(items, key) {
  const result = new Map(), duplicates = new Set();
  for (const item of items) { const id = key(item); if (result.has(id)) duplicates.add(id); else if (id) result.set(id, item); }
  for (const id of duplicates) result.delete(id);
  return result;
}

function percentage(value) { return `${Number((value * 100).toFixed(12))}%`; }
