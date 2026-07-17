/**
 * Pack layout cells into contiguous 0-based columns for NewOA layout-grid.
 *
 * Source Landray rows often keep label-only columns that are filtered out before
 * DSL. Preserving those source column indexes leaves empty NewOA columns and a
 * broken designer layout. Packing keeps left-to-right order while filling the
 * target grid densely.
 */
export function packLayoutCells(cells = []) {
  const packed = packLayoutGrid(cells);
  return {
    columns: packed.columns,
    cells: packed.cells
  };
}

/**
 * Pack controls into one native NewOA layout-grid. The default mirrors the
 * designer's one-to-four-column quick layouts. Callers projecting a wider
 * table layout pass the target grid's permitted column count; overflow is
 * packed into additional rows of the same grid.
 */
export function packLayoutGrid(cells = [], options = {}) {
  const sorted = orderedExpandedCells(cells);
  const requestedColumns = positiveInteger(options.columns);
  const columns = requestedColumns || Math.max(1, Math.min(4, sorted.length || 1));
  const requiredRows = Math.max(1, Math.ceil(sorted.length / columns));
  const rows = Math.max(positiveInteger(options.rows) || 1, requiredRows);
  return {
    columns,
    rows,
    cells: packedCells(sorted, columns)
  };
}

/**
 * Project an already-reviewed DSL grid without reflowing its coordinates.
 * Multi-ref children are the one supported expansion: their references occupy
 * consecutive cells beginning at the declared row/column.
 */
export function projectLayoutGrid(cells = [], options = {}) {
  const columns = positiveInteger(options.columns) || 1;
  const rows = positiveInteger(options.rows) || 1;
  const projected = [];

  cells.forEach((cell, cellIndex) => {
    const expanded = splitCellReferences(cell, cellIndex);
    const startRow = Number.isInteger(cell?.row) ? cell.row : 0;
    const startColumn = Number.isInteger(cell?.column) ? cell.column : cellIndex;
    const start = startRow * columns + startColumn;
    expanded.forEach((entry, referenceIndex) => {
      const position = start + referenceIndex;
      projected.push({
        ...entry,
        row: Math.floor(position / columns),
        column: position % columns,
        colspan: expanded.length > 1
          ? 1
          : (Number.isInteger(cell?.colspan) ? cell.colspan : 1)
      });
    });
  });

  projected.sort((left, right) => {
    if (left.row !== right.row) return left.row - right.row;
    return left.column - right.column;
  });
  return { columns, rows, cells: projected };
}

function orderedExpandedCells(cells) {
  const expanded = cells.flatMap((cell, cellIndex) => splitCellReferences(cell, cellIndex));
  return expanded.sort((left, right) => {
    const leftRow = Number.isInteger(left?.row) ? left.row : 0;
    const rightRow = Number.isInteger(right?.row) ? right.row : 0;
    if (leftRow !== rightRow) return leftRow - rightRow;
    const leftColumn = Number.isInteger(left?.column) ? left.column : Number.MAX_SAFE_INTEGER;
    const rightColumn = Number.isInteger(right?.column) ? right.column : Number.MAX_SAFE_INTEGER;
    if (leftColumn !== rightColumn) return leftColumn - rightColumn;
    return 0;
  });
}

function packedCells(cells, columns) {
  return cells.map((cell, index) => ({
    ...cell,
    row: Math.floor(index / columns),
    column: index % columns,
    colspan: 1
  }));
}

function positiveInteger(value) {
  return Number.isInteger(value) && value >= 1 ? value : undefined;
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
