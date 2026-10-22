/** Source-only ownership. No NewOA component or executable script is selected
 * here. Keeping this inventory before target mapping makes a one-to-one title
 * the ordinary translation model, rather than a post-hoc visual optimization. */
export function sourceCaptionRelations(form) {
  const roots = [...(form.controls || []), ...(form.dataFields || []), ...(form.detailTables || [])];
  const fields = [...(form.controls || []), ...(form.dataFields || []),
    ...(form.detailTables || []).flatMap(table => [table, ...(table.columns || [])])];
  const candidates = roots.flatMap(owner => {
    const existing = owner.sourceProps?.layoutCell?.captionIds;
    if (existing?.length) return [{ owner, captionIds: existing, renderedAdjacent: false }];
    const adjacent = renderedAdjacentCaption(form, fields, owner);
    const bindOn = String(owner.sourceProps?.designerValues?._label_bind).toLowerCase() === "true";
    // A false exported pointer is not the rendered title. The adjacent cell is.
    if (adjacent && !bindOn) return [{ owner, captionIds: [adjacent], renderedAdjacent: true }];
    const id = owner.sourceProps?.designerValues?._label_bind_id;
    const caption = fields.find(field => field.id === id && field.sourceType === "description");
    if (caption && !["description", "detailTable"].includes(owner.sourceType) && !owner.dataOnly && !owner.sourceProps?.hardHidden &&
        !caption.dataOnly && !caption.sourceProps?.hardHidden) return [{ owner, captionIds: [id], renderedAdjacent: false }];
    return adjacent ? [{ owner, captionIds: [adjacent], renderedAdjacent: true }] : [];
  });
  return candidates.map(({ owner, captionIds, renderedAdjacent }) => {
    const relation = { fieldId: owner.id, sourceRef: owner.sourceRef, captionIds,
      disposition: "needs-evidence", reason: "caption_identity_ambiguous" };
    const captions = fields.filter(field => captionIds.includes(field.id));
    if (captionIds.length !== 1 || captions.length !== 1) return relation;
    const caption = captions[0], facts = caption.sourceProps || {};
    const sourceCell = id => (form.layout?.rows || []).flatMap(row => (row.cells || [])
      .filter(cell => cell.references?.some(ref => ref.referenceId === id)).map(cell => ({ row, cell })));
    const left = sourceCell(caption.id), right = sourceCell(owner.id);
    const body = right.length === 1 ? right[0].cell : undefined;
    const old = facts.staticCaptionFact, layout = owner.sourceProps?.layoutCell;
    const legacyOwnership = old && (old.runtimePresent !== true && String(owner.sourceProps?.designerValues?._label_bind).toLowerCase() === "true" ||
      old.runtimeOwnerId === owner.id || ["runtime-independent-title-cell", "retained-source-caption"].includes(layout?.relation));
    let structure = facts.captionStructure || (legacyOwnership && !old.runtimeHiddenOwnerIds?.includes(owner.id)
      ? { ...old, ownerId: owner.id } : undefined);
    if (renderedAdjacent && (!structure || structure.ownerId !== owner.id)) {
      const issue = facts.captionStructureIssue?.reason;
      const layoutMayOwn = !issue || ["source_binding_or_ancestry_unproven", "value_cell_has_multiple_or_missing_editors"].includes(issue);
      const fact = facts.staticCaptionFact;
      const plain = fact?.plainText !== false && fact?.unique !== false && fact?.unguarded !== false && !/[<>]/.test(String(caption.title));
      if (layoutMayOwn && plain && normalizeText(caption.title) === normalizeText(owner.title))
        structure = { ...(fact || {}), ownerId: owner.id, plainText: true, unique: true, unguarded: true, content: caption.title };
    }
    if (structure && structure.ownerId !== owner.id && !owner.sourceProps?.layoutCell?.captionIds?.includes(caption.id) &&
        String(owner.sourceProps?.designerValues?._label_bind).toLowerCase() === "false") {
      return { ...relation, disposition: "exception", reason: "inactive_binding_outside_rendered_region",
        evidence: { renderedOwnerId: structure.ownerId } };
    }
    const users = fields.filter(field => {
      if (field.id === caption.id) return false;
      if (renderedAdjacent && field.id === owner.id) return true;
      return (field.sourceProps?.layoutCell?.captionIds?.includes(caption.id) || field.sourceProps?.designerValues?._label_bind_id === caption.id) &&
        // An inactive, stale pointer outside this title's rendered value cell is
        // not a second rendered owner. Active claims remain protected.
        (!structure || field.id === structure.ownerId ||
         String(field.sourceProps?.designerValues?._label_bind).toLowerCase() === "true" ||
         body?.references?.some(ref => ref.referenceId === field.id));
    });
    const preserve = reason => ({ ...relation, disposition: "exception", reason });
    if (owner.sourceProps?.layoutCell?.relation === "standard-table-column-header" || owner.sourceProps?.detailHeaderCaption) {
      return { ...preserve("column_header_owns_title"), evidence: owner.sourceProps.layoutCell || owner.sourceProps.detailHeaderCaption };
    }
    if (users.length !== 1 || body?.references?.length > 1) return preserve("shared_caption");
    if (owner.dataOnly || owner.sourceProps?.hardHidden || owner.sourceType === "description" ||
        (owner.sourceType === "detailTable" && !renderedAdjacent)) {
      return preserve("owner_presentation_protected");
    }
    const captionRight = facts.rightContainer?.id, ownerRight = owner.sourceProps?.rightContainer?.id;
    if (captionRight !== ownerRight) return preserve("independent_permission");
    if ((form.workflow?.nodes || []).some(node => {
      const a = node.dataAuthority?.fields?.[caption.id], b = node.dataAuthority?.fields?.[owner.id];
      return a && (!b || a.visible !== b.visible || a.sourceMode !== b.sourceMode);
    })) return preserve("independent_permission");
    if (facts.metadataId) return preserve("caption_has_data_identity");
    if (!structure || structure.ownerId !== owner.id) {
      return { ...relation, reason: "caption_structure_unproven", evidence: facts.captionStructureIssue || facts.staticCaptionIssue };
    }
    if (left.length !== 1 || right.length !== 1 || left[0].row !== right[0].row ||
        left[0].cell.references?.length !== 1 || body.references?.length !== 1 ||
        (left[0].cell.rowspan || 1) !== 1 || (body.rowspan || 1) !== 1 ||
        left[0].cell.column + left[0].cell.colspan !== body.column ||
        !hasSingleControlFlow(left[0].cell, true) || !hasSingleControlFlow(body)) {
      return { ...relation, reason: "compound_or_unproven_region" };
    }
    return { ...relation, disposition: "field-caption", reason: "binding_layout_and_rendering_agree",
      content: structure.content, evidence: { designerOffset: structure.designerOffset,
        ownerOffset: structure.ownerOffset, runtimeRenderer: structure.runtimeRenderer,
        bindingFlag: structure.bindingFlag, permission: captionRight ? "same-wrapper" : "unwrapped",
        ...(structure.emphasis?.length ? { titleEmphasis: structure.emphasis } : {}),
        ...(left[0].cell.contentFlow?.lines?.length === 2 ? { captionTrailingEmptyLine: true } : {}),
        captionCellSourceRef: left[0].cell.sourceRef, fieldCellSourceRef: body.sourceRef } };
  });
}

// A single terminal empty line contains no second title/control. Keep the
// original source flow; only a proven caption may consume this empty tail.
// Leading blanks, multiple blanks and editor tails remain separate regions.
function renderedAdjacentCaption(form, fields, owner) {
  if (owner.sourceType === "description" || owner.dataOnly || owner.sourceProps?.hardHidden) return undefined;
  const text = normalizeText(owner.title);
  if (!text) return undefined;
  for (const row of form.layout?.rows || []) {
    const cells = row.cells || [];
    const index = cells.findIndex(cell => cell.references?.length === 1 && cell.references[0].referenceId === owner.id);
    if (index <= 0) continue;
    const left = cells[index - 1], right = cells[index];
    if (left.references?.length !== 1 || (left.rowspan || 1) !== 1 || (right.rowspan || 1) !== 1) continue;
    if (!Number.isInteger(left.column) || !Number.isInteger(left.colspan) || left.column + left.colspan !== right.column) continue;
    const caption = fields.find(field => field.id === left.references[0].referenceId && field.sourceType === "description");
    if (!caption || caption.dataOnly || caption.sourceProps?.hardHidden || normalizeText(caption.title) !== text) continue;
    if (fields.some(field => field.id !== owner.id && field.sourceProps?.layoutCell?.captionIds?.includes(caption.id))) continue;
    return caption.id;
  }
  return undefined;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, "");
}

export function hasSingleControlFlow(cell, allowEmptyTail = false) {
  const flow = cell.contentFlow;
  return !flow || flow.lines?.[0]?.length === 1 &&
    (flow.lines.length === 1 || allowEmptyTail && flow.lines.length === 2 &&
      flow.lines[1]?.length === 0 && flow.items?.length === 1 &&
      flow.items[0].referenceId === flow.lines[0][0]);
}
