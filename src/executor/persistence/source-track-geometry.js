const READABLE_CAPTION_SHARE = 0.2;
// Same source-weight floor as the native nested-column projector.
const MIN_ATTACHMENT_CAPTION_WEIGHT = 135;

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
    const exactProfiles = new Map();
    let run = [];
    const flush = () => { if (run.length >= 2) for (const entry of readableAttachmentGroup(aggregateAttachmentTracks(run))) shared.set(entry.projected.id, entry); run = []; };
    for (const source of sourceRows) {
      const node = nodesByRef.get(source.sourceRef), row = projectionById.get(node?.id);
      const profile = directTrackProfile(source, node, row, evidence.rowCount, fieldsById);
      if (profile && !profile.attachmentHints.size) {
        const matches = exactProfiles.get(profile.signature) || [];
        matches.push(profile);
        exactProfiles.set(profile.signature, matches);
      }
      if (!profile || run.length && (profile.index !== run.at(-1).index + 1 || !compatibleTracks(run, profile))) flush();
      if (profile) run.push(profile);
    }
    flush();
    // A merged row does not create a new source table. Restore an interrupted
    // ordinary row only from its own complete, exactly repeated track profile;
    // attachment rebalancing remains confined to the existing contiguous runs.
    for (const matches of exactProfiles.values()) {
      if (new Set(matches.map(profile => profile.index)).size < 2) continue;
      for (const profile of matches) if (!shared.has(profile.projected.id)) shared.set(profile.projected.id, profile);
    }
  }
  return projected.map(row => {
    const node = nodes.find(node => node.id === row.id), source = rowsByRef.get(node?.sourceRef), profile = shared.get(row.id);
    const independentHints = provedRoot && !mobile ? independentAttachmentHints(source, node, row, fieldsById) : new Set();
    return {
      ...row,
      colsStyle: profile?.colsStyle || [{ startIndex: 0, count: row.columns, value: "auto" }],
      cells: row.cells.map(cell => ({ ...cell,
        ...(fullRowHeading(source, row, cell, fieldsById) && (provedRoot ||
          sourceGrid?.source === "fdDesignerHtml" && centeredCellEvidence(source, node, cell, fieldsById))
          ? { stretchDescription: true } : {}),
        // Native upload titles and buttons need the complete source cell. Keep
        // its static hint beneath the upload instead of competing for that width.
        ...(profile?.attachmentHints.has(cell.id) || independentHints.has(cell.id) ? {
          contentFlow: { ...cell.contentFlow, lines: cell.refIds.map(id => [id]) }, stretchDescription: true
        } : {}),
        ...(profile?.captions.get(cell.id) ? { captionWidth: profile.captions.get(cell.id) } : {})
      }))
    };
  });
}

function directTrackProfile(source, node, projected, rowCount, fields) {
  if (!/^(?:0|[1-9]\d*)$/.test(String(source.sourceRow)) || Number(source.sourceRow) >= rowCount ||
      source.preserveSourceGeometry !== true || !Number.isInteger(source.columns) || source.columns < 2 ||
      !node || !projected || projected.rows !== 1 || projected.columns !== source.columns || projected.cells.length < 2 ||
      projected.cells.some(cell => cell.ownerNodeId !== projected.id || cell.refType !== "field" ||
        ![1, 2].includes(cell.refIds.length) || cell.rowspan !== 1)) return undefined;
  const cells = [...(source.cells || [])].sort((a, b) => a.column - b.column), weights = [];
  let next = 0;
  for (const cell of cells) {
    if (cell.column !== next || !Number.isInteger(cell.colspan) || cell.colspan < 1 ||
        cell.rowspan !== undefined && cell.rowspan !== 1 || !Number.isFinite(cell.widthWeight) || cell.widthWeight <= 0 ||
        !(cell.references?.length === 1 && cell.references[0].referenceType === "control" || sourceAttachmentHint(cell, fields)) ||
        cell.evidence?.column !== cell.column || cell.evidence?.colspan !== cell.colspan ||
        cell.evidence?.widthWeight !== cell.widthWeight) return undefined;
    for (let i = 0; i < cell.colspan; i++) weights.push(cell.widthWeight / cell.colspan);
    next += cell.colspan;
  }
  if (next !== source.columns) return undefined;
  const captions = new Map(), captionRanges = new Map(), attachmentHints = new Set();
  for (const cell of projected.cells) {
    const pieces = cells.filter(piece => piece.column >= cell.column && piece.column + piece.colspan <= cell.column + cell.colspan);
    const original = node.children.find(child => child.id === cell.id);
    if (!pieces.length || pieces[0].column !== cell.column || pieces.at(-1).column + pieces.at(-1).colspan !== cell.column + cell.colspan ||
        pieces.reduce((sum, piece) => sum + piece.colspan, 0) !== cell.colspan ||
        !Number.isFinite(original?.widthWeight) || original.widthWeight <= 0 ||
        Math.abs(pieces.reduce((sum, piece) => sum + piece.widthWeight, 0) - original.widthWeight) > 1e-8) return undefined;
    if (cell.refIds.length === 2) {
      const sourceCell = pieces[0], ids = sourceAttachmentHint(sourceCell, fields);
      if (pieces.length !== 1 || !ids || original.sourceRef !== sourceCell.sourceRef ||
          original.keepInline !== true || cell.keepInline !== true ||
          !sameIds(original.refIds, ids) || !sameIds(cell.refIds, ids) ||
          !sameAttachmentFlow(original.contentFlow, sourceCell.contentFlow, ids) ||
          !sameAttachmentFlow(cell.contentFlow, sourceCell.contentFlow, ids)) return undefined;
      attachmentHints.add(cell.id);
      continue;
    }
    if (pieces.some(piece => piece.references.length !== 1)) return undefined;
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
    captionRanges.set(cell.id, { start: caption.column, split: value.column, end: value.column + value.colspan });
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const values = weights.map(weight => percentage(weight / total));
  return { projected, index: Number(source.sourceRow), signature: JSON.stringify(values), weights, captions, captionRanges, attachmentHints,
    attachmentPartition: attachmentPartition(cells, node, projected, fields, attachmentHints),
    independentCaption: leadingIndependentCaption(cells, projected, fields),
    colsStyle: values.map((value, startIndex) => ({ startIndex, count: 1, value })) };
}

function compatibleTracks(run, profile) {
  return run.every(entry => entry.signature === profile.signature) || profile.attachmentPartition &&
    run.every(entry => entry.attachmentPartition?.key === profile.attachmentPartition.key);
}

/** Unequal row widths constrain one proved attachment lattice. Do not infer a
 * shared lattice for ordinary rows or change the existing equal-width route. */
function aggregateAttachmentTracks(run) {
  if (!run.length || run.every(entry => entry.signature === run[0].signature)) return run;
  const partition = run[0].attachmentPartition;
  if (!partition || run.some(entry => entry.attachmentPartition?.key !== partition.key)) return [];
  const weights = run[0].weights.map((_, column) => Math.max(...run.map(entry => entry.weights[column])));
  weights[partition.captionColumn] = Math.max(weights[partition.captionColumn], MIN_ATTACHMENT_CAPTION_WEIGHT);
  const total = weights.reduce((sum, value) => sum + value, 0);
  return withSharedTracks(run, weights.map(value => value / total * 100));
}

function attachmentPartition(cells, node, row, fields, hints) {
  if (hints.size !== 1) return undefined;
  const upload = row.cells.find(cell => hints.has(cell.id)), caption = cells.find(cell => cell.column + cell.colspan === upload.column);
  const description = fields.get(caption?.references?.[0]?.referenceId);
  if (upload.colspan !== 1 || upload.column !== row.columns - 1 || caption?.colspan !== 1 || caption.references.length !== 1 ||
      description?.componentId !== "xform-description" || description.sourceProps?.designerType !== "textLabel" ||
      description.sourceRef !== caption.references[0].sourceRef || description.sourceProps?.designerValues?.content !== description.props?.content ||
      !/^[^\r\n]{1,4}$/u.test(String(description.props?.content || "").trim())) return undefined;
  for (const cell of row.cells.filter(cell => cell.refIds.length === 1)) {
    const field = fields.get(cell.refIds[0]), original = node.children.find(child => child.id === cell.id);
    const value = cells.find(piece => piece.references.length === 1 && piece.references[0].referenceId === field?.id);
    if (!value || field.dataOnly || field.sourceProps?.choiceOtherToggle || field.sourceProps?.otherTextCompanion ||
        field.sourceRef !== value.references[0].sourceRef || original?.sourceRef !== value.sourceRef ||
        value.contentFlow?.items?.[0]?.width?.value === 0 || !sameSingleFlow(original.contentFlow, value.contentFlow, field.id) ||
        !sameSingleFlow(cell.contentFlow, value.contentFlow, field.id)) return undefined;
  }
  return { key: JSON.stringify(cells.map(cell => [cell.column, cell.colspan, cell.references.length])), captionColumn: caption.column };
}

function sameSingleFlow(flow, source, id) {
  const width = flow?.items?.[0]?.width, sourceWidth = source?.items?.[0]?.width;
  return flow?.lines?.length === 1 && sameIds(flow.lines[0], [id]) && flow.items?.length === 1 && flow.items[0].referenceId === id &&
    source?.lines?.length === 1 && sameIds(source.lines[0], [id]) && source.items?.length === 1 && source.items[0].referenceId === id &&
    (width === undefined && sourceWidth === undefined || width !== undefined && sourceWidth !== undefined &&
      width.value === sourceWidth.value && width.unit === sourceWidth.unit);
}

/** Rebalance only the leading caption/editor region of an attachment group.
 * Reuse the proportional caption budget used for nested caption columns. */
function readableAttachmentGroup(run) {
  if (!run.some(entry => entry.attachmentHints.size)) return run;
  const ranges = run.map(entry => entry.independentCaption).filter(Boolean), range = ranges[0];
  if (!range || ranges.some(candidate => candidate.end !== range.end)) return run;
  const values = run[0].colsStyle.map(style => parseFloat(style.value)), total = values.slice(0, range.end).reduce((sum, value) => sum + value, 0);
  const caption = READABLE_CAPTION_SHARE * 100;
  if (values[0] >= caption || total <= caption * 2) return run;
  const remaining = total - values[0];
  for (let column = 1; column < range.end; column++) values[column] *= (total - caption) / remaining;
  values[0] = caption;
  return withSharedTracks(run, values);
}

function withSharedTracks(run, values) {
  return run.map(entry => ({ ...entry,
    colsStyle: values.map((value, startIndex) => ({ startIndex, count: 1, value: percentage(value / 100) })),
    captions: new Map([...entry.captionRanges].map(([id, bounds]) => [id, percentage(
      values.slice(bounds.start, bounds.split).reduce((sum, value) => sum + value, 0) /
      values.slice(bounds.start, bounds.end).reduce((sum, value) => sum + value, 0))]))
  }));
}

function leadingIndependentCaption(cells, row, fields) {
  const [captionCell, valueCell] = cells, field = fields.get(valueCell?.references?.[0]?.referenceId);
  const caption = boundCaptionCell(field, { cells }, fields);
  if (!caption || caption !== captionCell || caption.column !== 0 || caption.colspan !== 1 ||
      valueCell.column !== 1 || valueCell.references.length !== 1 ||
      field.sourceRef !== valueCell.references[0].sourceRef ||
      String(fields.get(caption.references[0].referenceId)?.props?.content || "").trim().length <= 8 ||
      !row.cells.some(cell => cell.refIds.length === 1 && cell.refIds[0] === field.id && cell.column === valueCell.column && cell.colspan === valueCell.colspan)) return undefined;
  return { end: valueCell.column + valueCell.colspan };
}

function boundCaptionCell(field, source, fields) {
  const fact = field?.sourceProps?.layoutCell, binding = field?.sourceProps?.boundCaption;
  if (field?.props?.hiddenLabel !== true || field.dataOnly || fact?.relation !== "independent-bound-title-cell" ||
      fact.hiddenLabel !== true || binding?.relation !== "explicit-label-bind-id" ||
      field.sourceProps.designerValues?._label_bind !== "true" || field.sourceProps.designerValues?._label_bind_id !== binding.id ||
      !sameIds(fact.captionIds, [binding.id])) return undefined;
  const matches = (source?.cells || []).filter(cell => cell.references?.length === 1 && cell.references[0].referenceId === binding.id);
  const caption = matches[0], description = fields.get(binding.id);
  return matches.length === 1 && caption.references[0].referenceType === "control" &&
    description?.componentId === "xform-description" && description.sourceRef === caption.references[0].sourceRef &&
    description.sourceProps?.designerType === "textLabel" ? caption : undefined;
}

function independentAttachmentHints(source, node, row, fields) {
  const result = new Set();
  if (!source || source.preserveSourceGeometry !== true || !node || row.rows !== 1 || row.columns !== source.columns) return result;
  for (const cell of row.cells) {
    const original = node.children.find(child => child.id === cell.id), matches = (source.cells || []).filter(piece => piece.sourceRef === original?.sourceRef);
    const piece = matches[0], ids = piece && sourceAttachmentHint(piece, fields, true), upload = ids && fields.get(ids[0]);
    if (matches.length !== 1 || !ids || !boundCaptionCell(upload, source, fields) ||
        cell.ownerNodeId !== row.id || cell.refType !== "field" || cell.rowspan !== 1 ||
        cell.column !== piece.column || cell.colspan !== piece.colspan || piece.rowspan !== undefined && piece.rowspan !== 1 ||
        !Number.isFinite(piece.widthWeight) || piece.widthWeight <= 0 || original.widthWeight !== piece.widthWeight ||
        piece.evidence?.column !== piece.column || piece.evidence?.colspan !== piece.colspan || piece.evidence?.widthWeight !== piece.widthWeight ||
        original.keepInline !== true || cell.keepInline !== true || !sameIds(original.refIds, ids) || !sameIds(cell.refIds, ids) ||
        !sameAttachmentFlow(original.contentFlow, piece.contentFlow, ids) || !sameAttachmentFlow(cell.contentFlow, piece.contentFlow, ids)) continue;
    result.add(cell.id);
  }
  return result;
}

function sourceAttachmentHint(cell, fields, allowIndependentTitle = false) {
  const refs = cell.references;
  if (refs?.length !== 2 || refs.some(ref => ref.referenceType !== "control")) return undefined;
  const ids = refs.map(ref => ref.referenceId), [upload, hint] = ids.map(id => fields.get(id));
  const text = String(hint?.props?.content || "").trim();
  if (upload?.componentId !== "xform-attach" || upload.sourceProps?.designerType !== "attachment" || upload.props?.hiddenLabel === true && !allowIndependentTitle ||
      hint?.componentId !== "xform-description" || hint.sourceProps?.designerType !== "textLabel" ||
      !text || /^[^\r\n]{1,4}$/u.test(text) || hint.sourceProps?.designerValues?.content !== hint.props.content ||
      [upload, hint].some((field, index) => field.dataOnly || field.sourceRef !== refs[index].sourceRef ||
        field.sourceProps?.foldedCaption || field.sourceProps?.choiceOtherToggle || field.sourceProps?.otherTextCompanion) ||
      !sameAttachmentFlow(cell.contentFlow, cell.contentFlow, ids)) return undefined;
  return ids;
}

function sameAttachmentFlow(flow, source, ids) {
  return flow?.lines?.length === 1 && sameIds(flow.lines[0], ids) && flow.items?.length === 2 &&
    sameIds(flow.items.map(item => item.referenceId), ids) &&
    flow.items[0].width?.unit === "px" && Number.isFinite(flow.items[0].width.value) && flow.items[0].width.value > 0 &&
    flow.items[0].width.value === source.items[0].width.value && flow.items[1].width === undefined;
}

function sameIds(actual, expected) { return actual?.length === expected.length && actual.every((id, index) => id === expected[index]); }

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

// Centering one complete source cell does not require a shared table lattice.
// Retain only that cell's literal geometry and unmodified text-label binding;
// do not infer tracks or widen an explicitly sized/inline caption.
function centeredCellEvidence(source, node, cell, fields) {
  const original = source.cells[0], field = fields.get(cell.refIds[0]), sourceField = field?.sourceProps;
  const child = node?.children?.[0], ref = original.references[0];
  return !!field && !field.dataOnly && node?.children?.length === 1 && child.id === cell.id &&
    node.sourceRef === source.sourceRef && child.sourceRef === original.sourceRef &&
    Number.isInteger(source.columns) && source.columns > 0 &&
    (node.props?.sourceColumns ?? node.props?.columns) === source.columns &&
    /^(?:0|[1-9]\d*)$/.test(String(source.sourceRow)) &&
    String(original.evidence?.row) === String(source.sourceRow) &&
    original.evidence?.column === 0 && original.evidence?.colspan === source.columns &&
    Number.isFinite(original.widthWeight) && original.widthWeight > 0 &&
    original.evidence?.widthWeight === original.widthWeight && child.widthWeight === original.widthWeight &&
    ref.referenceType === "control" && ref.sourceRef === field.sourceRef &&
    sourceField?.designerType === "textLabel" && sourceField.designerId === field.id &&
    sourceField.textPresentation?.textAlign === "center" &&
    sourceField.designerValues?.content === field.props?.content && String(field.props.content || "").trim().length > 0 &&
    original.contentFlow?.items?.[0]?.width === undefined &&
    sameSingleFlow(child.contentFlow, original.contentFlow, field.id) &&
    sameSingleFlow(cell.contentFlow, original.contentFlow, field.id);
}

function uniqueBy(items, key) {
  const result = new Map(), duplicates = new Set();
  for (const item of items) { const id = key(item); if (result.has(id)) duplicates.add(id); else if (id) result.set(id, item); }
  for (const id of duplicates) result.delete(id);
  return result;
}

function percentage(value) { return `${Number((value * 100).toFixed(12))}%`; }
