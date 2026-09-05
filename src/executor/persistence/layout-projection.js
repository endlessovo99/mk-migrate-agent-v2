import { projectLayoutGrid } from "../../dsl/layout-pack.js";

const DEFAULT_MAX_COLUMNS = 8;
const MIN_SOURCE_COLUMN_WIDTH_WEIGHT = 135;
const MIN_NESTED_CAPTION_COLUMN_SHARE = 0.2;

/**
 * Lower the DSL's flat layout registry to the native layout-grid rows NewOA can
 * persist. Native layout-grid does not safely support grid-in-grid, so a root
 * containing layout references is projected into one proportional grid.
 */
export function projectNativeLayoutRows(mkTree = [], options = {}) {
  const nodes = Array.isArray(mkTree) ? mkTree.filter(isRecord) : [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]).filter(([id]) => nonEmptyString(id)));
  const referencedLayoutIds = new Set(
    nodes.flatMap((node) =>
      (node.children || [])
        .filter((cell) => cell?.refType === "layout")
        .flatMap(refIdsFor)
    )
  );
  const roots = nodes.filter((node) => !referencedLayoutIds.has(node.id));
  const maxColumns = positiveInteger(options.maxColumns) || DEFAULT_MAX_COLUMNS;

  return roots.map((root) => {
    if (!hasLayoutReference(root)) {
      return projectPlainRoot(root);
    }

    const projectionColumns = selectProjectionColumns(root, nodesById, maxColumns);
    const flattened = flattenNode({
      node: root,
      nodesById,
      regionColumn: 0,
      regionColspan: projectionColumns,
      totalColumns: projectionColumns,
      ancestors: new Set(),
      ownerNodePath: [root.id]
    });
    const compressed = compressProjectionColumns(
      orderedCells(flattened.cells),
      projectionColumns
    );
    const sourceColsStyle = sourceWidthColsStyle(compressed.cells, compressed.columns);
    const colsStyle = ensureNestedCaptionColumnShare(
      compressed.cells,
      compressed.columns,
      sourceColsStyle || compressed.colsStyle
    );
    return {
      id: root.id,
      rows: Math.max(1, flattened.rows),
      columns: compressed.columns,
      cells: compressed.cells,
      ...(colsStyle ? { colsStyle } : {})
    };
  });
}

function projectPlainRoot(root) {
  const projected = projectLayoutGrid(root.children || [], {
    columns: root.props?.columns,
    rows: root.componentId === "xform-multi-row-table-layout"
      ? root.props?.rows
      : 1
  });
  const colsStyle = completeSourceWidthColsStyle(projected.cells, projected.columns);
  return {
    id: root.id,
    rows: projected.rows,
    columns: projected.columns,
    ...(colsStyle ? { colsStyle } : {}),
    cells: projected.cells.map((cell) => ({
      id: cell.id,
      ownerNodeId: root.id,
      ownerNodePath: [root.id],
      refType: cell.refType,
      refIds: refIdsFor(cell),
      row: integerOr(cell.row, 0),
      column: integerOr(cell.column, 0),
      colspan: positiveInteger(cell.colspan) || 1,
      rowspan: 1,
      ...(cell.keepInline === true ? { keepInline: true } : {})
    }))
  };
}

function completeSourceWidthColsStyle(cells, columns) {
  const weights = Array.from({ length: columns });
  for (const cell of cells) {
    const column = integerOr(cell.column, -1);
    const span = positiveInteger(cell.colspan) || 1;
    if (column < 0 || column + span > columns || !Number.isFinite(cell.widthWeight) || cell.widthWeight <= 0) {
      return undefined;
    }
    const weight = cell.widthWeight / span;
    for (let index = column; index < column + span; index += 1) {
      if (weights[index] !== undefined && Math.abs(weights[index] - weight) > 1e-9) return undefined;
      weights[index] = weight;
    }
  }
  if (!weights.length || weights.some((weight) => weight === undefined)) return undefined;
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight, index) => ({ startIndex: index, count: 1, value: percentageWidth(weight, total) }));
}

function flattenNode({
  node,
  nodesById,
  regionColumn,
  regionColspan,
  totalColumns,
  ancestors,
  ownerNodePath
}) {
  if (!node || ancestors.has(node.id)) return { rows: 0, cells: [] };
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(node.id);

  const sourceColumns = positiveInteger(node.props?.columns) || 1;
  const expandedCells = expandOrdinaryReferences(node.children || [], sourceColumns);
  const declaredRows = node.componentId === "xform-multi-row-table-layout"
    ? positiveInteger(node.props?.rows) || 1
    : 1;
  const sourceRows = Math.max(
    declaredRows,
    expandedCells.reduce((maximum, cell) => Math.max(maximum, integerOr(cell.row, 0) + 1), 1)
  );

  let projectedRow = 0;
  const projectedCells = [];
  for (let sourceRow = 0; sourceRow < sourceRows; sourceRow += 1) {
    const rowCells = expandedCells.filter((cell) => integerOr(cell.row, 0) === sourceRow);
    const plans = rowCells.map((cell) => {
      const bounds = proportionalBounds({
        regionColumn,
        regionColspan,
        sourceColumn: integerOr(cell.column, 0),
        sourceColspan: positiveInteger(cell.colspan) || 1,
        sourceColumns,
        totalColumns
      });
      if (cell.refType !== "layout") {
        return { cell, bounds, rows: 1, cells: [] };
      }

      let stackRow = 0;
      const stackCells = [];
      for (const layoutId of refIdsFor(cell)) {
        const child = nodesById.get(layoutId);
        if (!child) continue;
        const childProjection = flattenNode({
          node: child,
          nodesById,
          regionColumn: bounds.column,
          regionColspan: bounds.colspan,
          totalColumns,
          ancestors: nextAncestors,
          ownerNodePath: [...ownerNodePath, child.id]
        });
        stackCells.push(...childProjection.cells.map((projected) => ({
          ...projected,
          row: projected.row + stackRow
        })));
        stackRow += childProjection.rows;
      }
      return {
        cell,
        bounds,
        rows: Math.max(1, stackRow),
        cells: stackCells
      };
    });
    if (!plans.length) {
      projectedRow += 1;
      continue;
    }

    const placedPlans = placePlansWithoutOverlap(plans, {
      regionColumn,
      regionColspan,
      sourceColumns
    });
    const groupHeights = new Map();
    for (const plan of placedPlans) {
      groupHeights.set(
        plan.groupRow,
        Math.max(groupHeights.get(plan.groupRow) || 1, plan.rows)
      );
    }
    const groupOffsets = new Map();
    let projectedBlockRows = 0;
    for (const groupRow of [...groupHeights.keys()].sort((left, right) => left - right)) {
      groupOffsets.set(groupRow, projectedBlockRows);
      projectedBlockRows += groupHeights.get(groupRow);
    }

    for (const plan of placedPlans) {
      const groupOffset = groupOffsets.get(plan.groupRow) || 0;
      const groupHeight = groupHeights.get(plan.groupRow) || 1;
      if (plan.cell.refType === "layout") {
        projectedCells.push(...plan.cells.map((cell) => ({
          ...cell,
          row: cell.row + projectedRow + groupOffset
        })));
        continue;
      }
      projectedCells.push({
        id: plan.cell.id,
        ownerNodeId: node.id,
        ownerNodePath,
        refType: plan.cell.refType,
        refIds: refIdsFor(plan.cell),
        row: projectedRow + groupOffset,
        column: plan.bounds.column,
        colspan: plan.bounds.colspan,
        rowspan: groupHeight,
        ...(plan.cell.keepInline === true ? { keepInline: true } : {}),
        ...(Number.isFinite(plan.cell.widthWeight) && plan.cell.widthWeight > 0
          ? { widthWeight: plan.cell.widthWeight }
          : {})
      });
    }
    projectedRow += Math.max(projectedBlockRows, 1);
  }

  return { rows: projectedRow, cells: projectedCells };
}

function selectProjectionColumns(root, nodesById, maxColumns) {
  // This is an internal integer lattice, not the number of native columns.
  // Nested ratios such as an outer 1/4 + an inner five-column grid need 20
  // lattice units, but compress back to only six visible native columns.
  const internalLimit = maxColumns * maxColumns;
  for (let candidate = 1; candidate <= internalLimit; candidate += 1) {
    if (hasExactRecursiveBoundaries({
      node: root,
      nodesById,
      regionColspan: candidate,
      ancestors: new Set()
    }) && projectedVisibleColumnCount(root, nodesById, candidate) <= maxColumns) {
      return candidate;
    }
  }
  return positiveInteger(root.props?.columns) || 1;
}

function projectedVisibleColumnCount(root, nodesById, projectionColumns) {
  const flattened = flattenNode({
    node: root,
    nodesById,
    regionColumn: 0,
    regionColspan: projectionColumns,
    totalColumns: projectionColumns,
    ancestors: new Set(),
    ownerNodePath: [root.id]
  });
  return compressProjectionColumns(
    orderedCells(flattened.cells),
    projectionColumns
  ).columns;
}

function hasExactRecursiveBoundaries({
  node,
  nodesById,
  regionColspan,
  ancestors
}) {
  if (!node || ancestors.has(node.id)) return false;
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(node.id);

  const sourceColumns = positiveInteger(node.props?.columns) || 1;
  const expandedCells = expandOrdinaryReferences(node.children || [], sourceColumns);
  for (const cell of expandedCells) {
    const sourceColumn = integerOr(cell.column, 0);
    const sourceColspan = positiveInteger(cell.colspan) || 1;
    const sourceStart = Math.max(
      0,
      Math.min(sourceColumns, sourceColumn)
    );
    const sourceEnd = Math.max(
      sourceStart,
      Math.min(sourceColumns, sourceColumn + sourceColspan)
    );
    const startNumerator = sourceStart * regionColspan;
    const endNumerator = sourceEnd * regionColspan;
    if (
      startNumerator % sourceColumns !== 0 ||
      endNumerator % sourceColumns !== 0
    ) {
      return false;
    }
    if (cell.refType !== "layout") continue;

    const childRegionColspan = (endNumerator - startNumerator) / sourceColumns;
    for (const layoutId of refIdsFor(cell)) {
      const child = nodesById.get(layoutId);
      if (!child) continue;
      if (!hasExactRecursiveBoundaries({
        node: child,
        nodesById,
        regionColspan: childRegionColspan,
        ancestors: nextAncestors
      })) {
        return false;
      }
    }
  }
  return true;
}

function placePlansWithoutOverlap(plans, {
  regionColumn,
  regionColspan,
  sourceColumns
}) {
  if (!boundsOverlap(plans)) {
    return plans.map((plan) => ({ ...plan, groupRow: 0 }));
  }

  let groupRow = 0;
  let cursor = 0;
  return plans
    .map((plan, index) => ({ plan, index }))
    .sort((left, right) => {
      const columnDelta =
        integerOr(left.plan.cell?.column, left.index) -
        integerOr(right.plan.cell?.column, right.index);
      return columnDelta || left.index - right.index;
    })
    .map(({ plan }) => {
      const sourceColspan = positiveInteger(plan.cell?.colspan) || 1;
      const targetColspan = Math.max(
        1,
        Math.min(
          regionColspan,
          Math.round((sourceColspan * regionColspan) / sourceColumns)
        )
      );
      if (cursor > 0 && cursor + targetColspan > regionColspan) {
        groupRow += 1;
        cursor = 0;
      }
      const placed = {
        ...plan,
        groupRow,
        bounds: {
          column: regionColumn + cursor,
          colspan: targetColspan
        }
      };
      cursor += targetColspan;
      return placed;
    });
}

function boundsOverlap(plans) {
  const ordered = plans
    .map((plan) => plan.bounds)
    .filter(Boolean)
    .slice()
    .sort((left, right) => left.column - right.column);
  let previousEnd = -1;
  for (const bounds of ordered) {
    if (bounds.column < previousEnd) return true;
    previousEnd = Math.max(previousEnd, bounds.column + bounds.colspan);
  }
  return false;
}

function expandOrdinaryReferences(cells, columns) {
  return cells.flatMap((cell, cellIndex) => {
    const refIds = refIdsFor(cell);
    if (cell?.refType === "layout" || refIds.length <= 1 || cell?.keepInline === true) {
      return [{ ...cell, refIds }];
    }
    const startRow = integerOr(cell?.row, 0);
    const startColumn = Number.isInteger(cell?.column) ? cell.column : cellIndex;
    const start = startRow * columns + startColumn;
    return refIds.map((refId, referenceIndex) => {
      const position = start + referenceIndex;
      return {
        ...cell,
        id: `${cell.id || `cell-${cellIndex}`}-control-${referenceIndex + 1}`,
        refIds: [refId],
        refId,
        row: Math.floor(position / columns),
        column: position % columns,
        colspan: 1
      };
    });
  });
}

function proportionalBounds({
  regionColumn,
  regionColspan,
  sourceColumn,
  sourceColspan,
  sourceColumns,
  totalColumns
}) {
  const regionEnd = Math.min(totalColumns, regionColumn + regionColspan);
  const sourceStart = Math.max(0, Math.min(sourceColumns, sourceColumn));
  const sourceEnd = Math.max(sourceStart, Math.min(sourceColumns, sourceColumn + sourceColspan));
  const rawStart = regionColumn + Math.round((sourceStart * regionColspan) / sourceColumns);
  const rawEnd = regionColumn + Math.round((sourceEnd * regionColspan) / sourceColumns);
  const column = Math.max(regionColumn, Math.min(regionEnd - 1, rawStart));
  const end = Math.max(column + 1, Math.min(regionEnd, rawEnd));
  return { column, colspan: end - column };
}

/**
 * The recursive projector uses a uniform integer lattice internally so every
 * nested fractional boundary remains exact. NewOA does not require that
 * internal lattice to become visible columns: it persists non-uniform column
 * widths through colsStyle. Collapse every unused lattice boundary and retain
 * its physical width as a percentage instead of exposing an arbitrary 8-column
 * grid to the designer.
 */
function compressProjectionColumns(cells, projectionColumns) {
  const boundaries = new Set([0, projectionColumns]);
  for (const cell of cells) {
    const start = Math.max(0, Math.min(projectionColumns, integerOr(cell.column, 0)));
    const end = Math.max(
      start,
      Math.min(projectionColumns, start + (positiveInteger(cell.colspan) || 1))
    );
    boundaries.add(start);
    boundaries.add(end);
  }
  const orderedBoundaries = [...boundaries].sort((left, right) => left - right);
  const boundaryIndex = new Map(
    orderedBoundaries.map((boundary, index) => [boundary, index])
  );
  const columns = Math.max(1, orderedBoundaries.length - 1);
  const compressedCells = cells.map((cell) => {
    const start = Math.max(0, Math.min(projectionColumns, integerOr(cell.column, 0)));
    const end = Math.max(
      start,
      Math.min(projectionColumns, start + (positiveInteger(cell.colspan) || 1))
    );
    const column = boundaryIndex.get(start) ?? 0;
    const endColumn = boundaryIndex.get(end) ?? column + 1;
    return {
      ...cell,
      column,
      colspan: Math.max(1, endColumn - column)
    };
  });
  if (columns === projectionColumns) {
    return { columns, cells: compressedCells };
  }
  return {
    columns,
    cells: compressedCells,
    colsStyle: orderedBoundaries.slice(0, -1).map((start, index) => ({
      startIndex: index,
      count: 1,
      value: percentageWidth(orderedBoundaries[index + 1] - start, projectionColumns)
    }))
  };
}

function percentageWidth(units, total) {
  const value = Number(((units / total) * 100).toFixed(12));
  return `${value}%`;
}

function ensureNestedCaptionColumnShare(cells, columns, colsStyle) {
  if (!Array.isArray(colsStyle) || colsStyle.length < 2) return colsStyle;
  const caption = nestedCaptionColumn(cells, columns);
  if (caption === undefined) return colsStyle;
  const shares = colsStyle.map((style) => parseFloat(style.value) / 100);
  if (shares.some((share) => !Number.isFinite(share) || share <= 0)) return colsStyle;
  if (shares[caption] + 1e-12 >= MIN_NESTED_CAPTION_COLUMN_SHARE) return colsStyle;

  const deficit = MIN_NESTED_CAPTION_COLUMN_SHARE - shares[caption];
  const donors = shares.map((share, index) => index === caption ? 0 : share);
  const donorTotal = donors.reduce((sum, share) => sum + share, 0);
  if (!(donorTotal > deficit)) return colsStyle;
  const next = shares.map((share, index) =>
    index === caption
      ? MIN_NESTED_CAPTION_COLUMN_SHARE
      : share - deficit * (donors[index] / donorTotal)
  );
  return next.map((share, index) => ({
    startIndex: index,
    count: 1,
    value: percentageWidth(share, 1)
  }));
}

function nestedCaptionColumn(cells, columns) {
  if (columns !== 2) return undefined;
  if (!cells.some((cell) => cell.refType === "detailTable")) return undefined;
  const candidates = [];
  for (const cell of cells) {
    if (
      (positiveInteger(cell.colspan) || 1) !== 1 ||
      (positiveInteger(cell.rowspan) || 1) <= 1
    ) {
      continue;
    }
    const column = integerOr(cell.column, -1);
    if (column < 0) continue;
    if (candidates.some((candidate) => candidate !== column)) return undefined;
    if (!candidates.includes(column)) candidates.push(column);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function sourceWidthColsStyle(cells, columns) {
  const weights = Array.from({ length: columns });
  for (const cell of orderedCells(cells)) {
    const column = integerOr(cell.column, -1);
    if (
      column < 0 ||
      column >= columns ||
      (positiveInteger(cell.colspan) || 1) !== 1 ||
      weights[column] !== undefined ||
      !Number.isFinite(cell.widthWeight) ||
      cell.widthWeight <= 0
    ) continue;
    weights[column] = cell.widthWeight;
  }
  const measuredWeights = weights.filter((weight) => weight !== undefined);
  if (!measuredWeights.length) return undefined;
  // Legacy section-caption cells often omit WIDTH while the nested standard
  // table supplies exact pixel widths. Keep the caption compact by using the
  // narrowest measured source column for any such unmeasured native column.
  const fallbackWeight = Math.min(...measuredWeights);
  for (let index = 0; index < weights.length; index += 1) {
    if (weights[index] === undefined) weights[index] = fallbackWeight;
    // NewOA's grid item chrome consumes roughly 40px before child content.
    // A literal legacy 62px column otherwise leaves only a couple of pixels
    // for labels such as 类型/A型 and makes a real five-column table look like
    // a three-column table. Preserve proportions above this renderer floor.
    weights[index] = Math.max(weights[index], MIN_SOURCE_COLUMN_WIDTH_WEIGHT);
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) return undefined;
  return weights.map((weight, index) => ({
    startIndex: index,
    count: 1,
    value: percentageWidth(weight, total)
  }));
}

function orderedCells(cells) {
  return cells.slice().sort((left, right) => {
    if (left.row !== right.row) return left.row - right.row;
    return left.column - right.column;
  });
}

function hasLayoutReference(node) {
  return (node?.children || []).some((cell) => cell?.refType === "layout");
}

function refIdsFor(cell = {}) {
  for (const key of ["refIds", "references", "fieldIds"]) {
    const values = Array.isArray(cell[key]) ? cell[key].filter(Boolean) : [];
    if (key === "references") {
      return values.map((reference) =>
        typeof reference === "string" ? reference : reference?.referenceId
      ).filter(Boolean);
    }
    if (values.length) return values;
  }
  return [cell.refId, cell.fieldId].filter(Boolean);
}

function positiveInteger(value) {
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

function integerOr(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
