import { componentSupportsProp } from "../dsl/catalogs.js";

/**
 * Retains one shared left-side caption and the complete source cell when
 * multiple actionable controls bind to the same legacy textLabel.
 */
export function recoverSharedBoundCaptionGroups(fields, layout) {
  const nextLayout = structuredClone(layout || { source: "fdDesignerHtml", rows: [] });
  const nextFields = [...fields];
  const fieldsById = new Map(nextFields.map((field) => [field.id, field]));
  const groups = new Map();

  for (const field of nextFields) {
    const labelId = sharedBoundCaptionId(field);
    if (!labelId) continue;
    if (!groups.has(labelId)) groups.set(labelId, []);
    groups.get(labelId).push(field);
  }

  const compoundCells = new Map();
  const groupedFieldIds = new Map();
  for (const [captionId, members] of groups) {
    const activeMember = members.find(hasActiveDesignerLabelBinding);
    if (!activeMember || members.length < 2) continue;
    const location = sharedBoundCaptionCellLocation(nextLayout, members);
    if (!location) continue;

    let caption = fieldsById.get(captionId);
    if (!isDescriptionField(caption)) {
      const captionCell = recoverSharedCaptionCell(nextLayout, location, captionId);
      if (!captionCell) continue;
      caption = {
        id: captionId,
        title: activeMember.title,
        type: "description",
        componentId: "xform-description",
        props: { content: activeMember.title },
        sourceProps: {
          generatedFromSharedLabelBinding: true,
          sharedCaptionId: captionId,
          sourceFieldIds: members.map((member) => member.id)
        },
        sourceRef: activeMember.sourceRef,
        generated: true,
        reason: "The source cell shares one left-side caption across multiple actionable controls."
      };
      nextFields.push(caption);
      fieldsById.set(captionId, caption);
      captionCell.references = [{
        referenceType: "control",
        referenceId: captionId,
        sourceRef: caption.sourceRef
      }];
    }

    const captionCell = (location.row.cells || []).find((cell) =>
      (cell.references || []).some((reference) => reference.referenceId === captionId)
    );
    if (!captionCell || captionCell.id === location.cell.id) continue;

    const memberIds = new Set(members.map((member) => member.id));
    const sourceCellFieldIds = (location.cell.references || [])
      .map((reference) => reference.referenceId)
      .filter((fieldId) => fieldsById.has(fieldId));
    if (sourceCellFieldIds.filter((fieldId) => memberIds.has(fieldId)).length < 2) continue;

    compoundCells.set(layoutCellKey(location.row.id, location.cell.id), {
      captionId,
      fieldIds: sourceCellFieldIds
    });
    groupedFieldIds.set(captionId, memberIds);
  }

  return {
    fields: nextFields.map((field) => withHiddenSharedLabel(field, groupedFieldIds)),
    layout: nextLayout,
    compoundCells
  };
}

export function projectCompoundLayoutCell(sourceRowId, cell, compoundCells = new Map()) {
  const compound = compoundCells.get(layoutCellKey(sourceRowId, cell?.id));
  if (!compound || compound.fieldIds.length < 2 || compound.fieldIds.length > 4) return undefined;

  const nestedId = `layout.${sourceRowId}.${cell.id}.inline`;
  const innerColumns = Math.max(
    compound.fieldIds.length,
    Math.min(Number.isInteger(cell.colspan) ? cell.colspan : compound.fieldIds.length, 4)
  );
  const leadingColspan = innerColumns - compound.fieldIds.length + 1;
  return {
    cell: {
      ...cell,
      references: [{
        referenceType: "layout",
        referenceId: nestedId,
        sourceRef: cell.sourceRef
      }]
    },
    node: {
      id: nestedId,
      componentId: `xform-flex-1-${innerColumns}-layout`,
      props: {
        columns: innerColumns,
        sourceColumns: innerColumns
      },
      sourceRef: cell.sourceRef,
      children: compound.fieldIds.map((fieldId, fieldIndex) => {
        const isLeadingField = fieldIndex === 0;
        return {
          id: `${nestedId}.cell-${fieldIndex}`,
          refType: "field",
          refIds: [fieldId],
          sourceRef: cell.sourceRef,
          column: isLeadingField ? 0 : leadingColspan + fieldIndex - 1,
          colspan: isLeadingField ? leadingColspan : 1
        };
      })
    }
  };
}

function withHiddenSharedLabel(field, groupedFieldIds) {
  const captionId = sharedBoundCaptionId(field);
  const group = captionId ? groupedFieldIds.get(captionId) : undefined;
  if (!group?.has(field.id) || !componentSupportsProp(field.componentId, "hiddenLabel")) {
    return field;
  }
  return {
    ...field,
    props: { ...field.props, hiddenLabel: true },
    sourceProps: {
      ...field.sourceProps,
      sharedBoundCaption: { id: captionId }
    }
  };
}

function sharedBoundCaptionId(field) {
  const value = field?.sourceProps?.designerValues?._label_bind_id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasActiveDesignerLabelBinding(field) {
  return String(field?.sourceProps?.designerValues?._label_bind || "").trim().toLowerCase() === "true";
}

function isDescriptionField(field) {
  return field?.type === "description" && field?.componentId === "xform-description";
}

function sharedBoundCaptionCellLocation(layout, members) {
  const memberIds = new Set(members.map((member) => member.id));
  for (const row of layout?.rows || []) {
    for (const cell of row.cells || []) {
      const matchingMembers = (cell.references || [])
        .map((reference) => reference.referenceId)
        .filter((fieldId) => memberIds.has(fieldId));
      if (matchingMembers.length >= 2) return { row, cell };
    }
  }
  return undefined;
}

function recoverSharedCaptionCell(layout, location, captionId) {
  const row = location?.row;
  const cell = location?.cell;
  const column = Number.isInteger(cell?.column) ? cell.column : 0;
  if (!row || column <= 0) return undefined;
  const captionColumn = column - 1;
  const occupied = (row.cells || []).some((candidate) => {
    const start = Number.isInteger(candidate.column) ? candidate.column : 0;
    const span = Number.isInteger(candidate.colspan) ? candidate.colspan : 1;
    return captionColumn >= start && captionColumn < start + span;
  });
  if (occupied) return undefined;

  const captionCell = {
    id: `${row.id || "row"}-recovered-caption-${captionId}`,
    sourceRef: cell.sourceRef,
    column: captionColumn,
    colspan: 1,
    references: []
  };
  row.cells = [...(row.cells || []), captionCell].sort((left, right) =>
    (left.column || 0) - (right.column || 0)
  );
  return captionCell;
}

function layoutCellKey(rowId, cellId) {
  return `${String(rowId || "")}:${String(cellId || "")}`;
}
