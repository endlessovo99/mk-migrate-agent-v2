import { isVoidLikeTag, scanHtmlTags } from "./designer-html-tokenizer.js";
import {
  isSourceDescriptionControl,
  isStyledSourceDescriptionControl
} from "./source-description-control.js";

export function applyAdjacentDetailTableTitles(controls, isSuspiciousTitle, options = {}) {
  const consumedHeadingIds = new Set();
  const consumedHintIds = new Set();
  let descriptionBlockStart = 0;
  const result = controls.map((control, index) => {
    if (control.type !== "detailTable") {
      if (!isSourceDescriptionControl(control)) descriptionBlockStart = index + 1;
      return control;
    }
    const descriptionBlock = controls.slice(descriptionBlockStart, index);
    const headingCandidates = descriptionBlock.filter((candidate) =>
      isExplicitDetailTableHeading(candidate)
    );
    descriptionBlockStart = index + 1;
    const heading = headingCandidates.length === 1 ? headingCandidates[0] : undefined;
    const canRecoverHeading = heading && (
      isSuspiciousTitle(control.title) || sameVisibleTitle(heading.title, control.title)
    );
    const styledPrecedingHints = descriptionBlock.filter((candidate) =>
      candidate.id !== heading?.id && isStyledSourceDescriptionControl(candidate)
    );
    const precedingHint =
      canRecoverHeading &&
      styledPrecedingHints.length === 1 &&
      options.hasDirectBreakBetween?.(heading, styledPrecedingHints[0]) === true
        ? styledPrecedingHints[0]
        : undefined;
    const ownedHint = precedingHint;

    if (!canRecoverHeading && !ownedHint) return control;
    if (canRecoverHeading) consumedHeadingIds.add(heading.id);
    if (ownedHint) consumedHintIds.add(ownedHint.id);
    const baseTitle = canRecoverHeading ? heading.title : control.title;
    return {
      ...control,
      title: baseTitle,
      source: {
        ...control.source,
        ...(canRecoverHeading
          ? {
              explicitTitle: {
                sourceId: heading.id,
                content: heading.title,
                evidence: "preceding-large-bold-textLabel-in-same-cell"
              }
            }
          : {}),
        ...(ownedHint
          ? {
              detailTitleHint: {
                id: ownedHint.id,
                content: String(ownedHint.title ?? ""),
                rawContent: String(
                  ownedHint.source?.designerValues?.content ?? ownedHint.title ?? ""
                ),
                designerValues: ownedHint.source?.designerValues,
                relation: "post-heading-break-styled-text-before-detail-table"
              }
            }
          : {})
      }
    };
  });
  return result.filter((control) =>
    !consumedHeadingIds.has(control.id) && !consumedHintIds.has(control.id)
  );
}

export function applyAdjacentRowDetailTableTitles(controls, rows, isSuspiciousTitle) {
  const controlsById = new Map(controls.map((control) => [control.id, control]));
  const candidates = [];

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const previousRow = rows[rowIndex - 1];
    const row = rows[rowIndex];
    if (!areImmediatelyAdjacentSourceRows(previousRow, row)) continue;

    for (const cell of row.cells || []) {
      const detailTables = controlIdsForCell(cell)
        .map((id) => controlsById.get(id))
        .filter((control) => control?.type === "detailTable" && isSuspiciousTitle(control.title));
      if (!detailTables.length) continue;

      for (const previousCell of previousRow.cells || []) {
        if (!cellsOverlap(previousCell, cell)) continue;
        const previousControls = controlIdsForCell(previousCell)
          .map((id) => controlsById.get(id))
          .filter(Boolean);
        if (previousControls.length !== 1 || !isExplicitDetailTableHeading(previousControls[0])) continue;
        for (const detailTable of detailTables) {
          candidates.push({ heading: previousControls[0], detailTable });
        }
      }
    }
  }

  const candidatesByHeading = groupCandidates(candidates, (candidate) => candidate.heading.id);
  const candidatesByTable = groupCandidates(candidates, (candidate) => candidate.detailTable.id);
  const assignments = candidates.filter((candidate) =>
    candidatesByHeading.get(candidate.heading.id)?.length === 1 &&
    candidatesByTable.get(candidate.detailTable.id)?.length === 1
  );
  if (!assignments.length) return { controls, rows };

  const consumedHeadingIds = new Set(assignments.map((assignment) => assignment.heading.id));
  const titleByTableId = new Map(assignments.map((assignment) => [assignment.detailTable.id, assignment.heading]));
  const nextControls = controls
    .filter((control) => !consumedHeadingIds.has(control.id))
    .map((control) => {
      const heading = titleByTableId.get(control.id);
      if (!heading) return control;
      return {
        ...control,
        title: heading.title,
        source: {
          ...control.source,
          explicitTitle: {
            sourceId: heading.id,
            content: heading.title,
            evidence: "preceding-large-bold-textLabel-in-immediately-adjacent-row-cell"
          }
        }
      };
    });
  const nextRows = rows.map((row) => {
    const cells = (row.cells || []).map((cell) => {
      const fieldIds = controlIdsForCell(cell).filter((id) => !consumedHeadingIds.has(id));
      if (!fieldIds.length) return undefined;
      return {
        ...cell,
        fieldId: fieldIds[0],
        fieldIds
      };
    }).filter(Boolean);
    return cells.length ? { ...row, cells } : undefined;
  }).filter(Boolean);

  return { controls: nextControls, rows: nextRows };
}

export function attachmentContextControls(html, attachmentEntry, entries) {
  const ranges = enclosingElementRanges(html, attachmentEntry.start)
    .filter((range) => range.start !== attachmentEntry.start)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start));
  for (const range of ranges) {
    const contained = entries.filter((entry) =>
      entry.start >= range.start && entry.start < range.end
    );
    if (
      contained.some((entry) => entry.control.id === attachmentEntry.control.id) &&
      contained.some((entry) => isSourceDescriptionControl(entry.control))
    ) {
      return contained.map((entry) => entry.control);
    }
  }
  return [attachmentEntry.control];
}

function isExplicitDetailTableHeading(control) {
  const values = control?.source?.designerValues || {};
  const size = Number.parseFloat(String(values.size || ""));
  return isTrueLike(values.b) && Number.isFinite(size) && size >= 16;
}

function areImmediatelyAdjacentSourceRows(previousRow, row) {
  const previous = Number.parseInt(String(previousRow?.sourceRow ?? ""), 10);
  const current = Number.parseInt(String(row?.sourceRow ?? ""), 10);
  return Number.isInteger(previous) && Number.isInteger(current) && current === previous + 1;
}

function cellsOverlap(left, right) {
  const leftStart = Number.isFinite(left?.column) ? left.column : 0;
  const rightStart = Number.isFinite(right?.column) ? right.column : 0;
  const leftEnd = leftStart + positiveSpan(left?.colspan);
  const rightEnd = rightStart + positiveSpan(right?.colspan);
  return leftStart < rightEnd && rightStart < leftEnd;
}

function positiveSpan(value) {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function controlIdsForCell(cell) {
  if (Array.isArray(cell?.fieldIds)) return cell.fieldIds.filter(Boolean);
  return cell?.fieldId ? [cell.fieldId] : [];
}

function groupCandidates(candidates, keyFn) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = keyFn(candidate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  return groups;
}

function enclosingElementRanges(html, position) {
  const ranges = [];
  const stack = [];
  for (const token of scanHtmlTags(html)) {
    if (!token.closing) {
      if (!token.selfClosing && !isVoidLikeTag(token.name)) stack.push(token);
      continue;
    }
    const openIndex = stack.findLastIndex((entry) => entry.name === token.name);
    if (openIndex < 0) continue;
    const [open] = stack.splice(openIndex, 1);
    if (open.start <= position && position < token.end) {
      ranges.push({ start: open.start, end: token.end });
    }
  }
  return ranges;
}

function isTrueLike(value) {
  return ["true", "1", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

function sameVisibleTitle(left, right) {
  return String(left ?? "").replace(/[\s\u00a0]+/gu, "").toLowerCase() ===
    String(right ?? "").replace(/[\s\u00a0]+/gu, "").toLowerCase();
}
