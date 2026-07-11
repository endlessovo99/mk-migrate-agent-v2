/**
 * Pack layout cells into contiguous 0-based columns for NewOA layout-grid.
 *
 * Source Landray rows often keep label-only columns that are filtered out before
 * DSL. Preserving those source column indexes leaves empty NewOA columns and a
 * broken designer layout. Packing keeps left-to-right order while filling the
 * target grid densely.
 */
export function packLayoutCells(cells = []) {
  const expanded = cells.flatMap((cell, cellIndex) => splitCellReferences(cell, cellIndex));
  const sorted = expanded.sort((left, right) => {
    const leftColumn = Number.isInteger(left?.column) ? left.column : Number.MAX_SAFE_INTEGER;
    const rightColumn = Number.isInteger(right?.column) ? right.column : Number.MAX_SAFE_INTEGER;
    if (leftColumn !== rightColumn) return leftColumn - rightColumn;
    return 0;
  });
  const columns = Math.max(1, Math.min(4, sorted.length || 1));
  return {
    columns,
    cells: sorted.map((cell, index) => ({
      ...cell,
      column: index,
      colspan: 1
    }))
  };
}

function splitCellReferences(cell = {}, cellIndex) {
  for (const key of ["references", "refIds", "fieldIds"]) {
    const references = Array.isArray(cell[key]) ? cell[key].filter(Boolean) : [];
    if (references.length <= 1) continue;
    return references.map((reference, referenceIndex) => {
      const next = {
        ...cell,
        id: `${cell.id || `cell-${cellIndex}`}-control-${referenceIndex + 1}`,
        [key]: [reference]
      };
      if (key === "refIds" && "refId" in next) next.refId = reference;
      if (key === "fieldIds" && "fieldId" in next) next.fieldId = reference;
      return next;
    });
  }
  return [cell];
}
