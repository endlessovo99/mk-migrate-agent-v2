import { canonicalJson } from "../agent-review/digest.js";
import { sourceNumberEditors, sourceNumberDisplays } from "./source-number-editor.js";

/**
 * An intrinsic title is now inside the field wrapper. Keep the source editor
 * width, adding the existing classic desktop title and padding budget only for
 * these newly combined wrappers. This is not a column-sizing/auto-width policy.
 */
export function nativeCaptionDesktopWidths(form = {}) {
  const result = new Map();
  const numbers = new Map([...sourceNumberEditors(form), ...sourceNumberDisplays(form)]);
  for (const field of form.fields || []) {
    if (!field.sourceProps?.foldedCaption || field.props?.hiddenLabel === true) continue;
    const cells = cellsContaining(form, field.id);
    const flow = cells.length === 1 && cells[0].cell.contentFlow;
    const item = flow?.items?.length === 1 && flow.items[0];
    if (item?.referenceId === field.id && item.width?.unit === "px" &&
        Number.isFinite(item.width.value) && item.width.value > 0) {
      result.set(field.id, (numbers.get(field.id)?.inputPx ?? item.width.value) + 8 * 14 + 32 + 1 + 32);
    }
  }
  return result;
}

/** Only the independently rebuilt mapping can authorize a consumed caption. */
export function nativeCaptionFoldIssues(expectedForm = {}, actualForm = {}) {
  const issues = [];
  const expectedFields = expectedForm.fields || [], actualFields = actualForm.fields || [];
  const sources = new Set([...expectedFields, ...actualFields]
    .filter(field => field.sourceProps?.foldedCaption).map(field => field.sourceRef));
  const foldedSourceRefs = new Set(), consumedCaptionIds = new Set();
  if (sources.size && canonicalJson(expectedForm.layout?.sourceGrid) !== canonicalJson(actualForm.layout?.sourceGrid)) {
    issues.push({ reason: "caption_fold_source_grid" });
  }
  for (const sourceRef of sources) {
    const expected = expectedFields.filter(field => field.sourceRef === sourceRef);
    const actual = actualFields.filter(field => field.sourceRef === sourceRef);
    const field = expected[0], caption = field?.sourceProps?.foldedCaption;
    const fail = reason => issues.push({ reason, fieldId: field?.id || actual[0]?.id, sourceRef });
    if (expected.length !== 1 || actual.length !== 1 || !caption ||
        canonicalJson(field) !== canonicalJson(actual[0])) {
      fail("caption_fold_field");
      continue;
    }
    const resurrected = actualFields.some(item => item.id === caption.id ||
      item.sourceProps?.originalId === caption.id || item.sourceRef === caption.sourceRef);
    const expectedCells = cellsContaining(expectedForm, field.id);
    const actualCells = cellsContaining(actualForm, field.id);
    if (resurrected || cellsContaining(actualForm, caption.id).length ||
        expectedCells.length !== 1 || actualCells.length !== 1 ||
        canonicalJson(expectedCells[0]) !== canonicalJson(actualCells[0])) {
      fail("caption_fold_layout");
      continue;
    }
    foldedSourceRefs.add(sourceRef);
    consumedCaptionIds.add(caption.id);
  }
  return { issues, foldedSourceRefs, consumedCaptionIds };
}

function cellsContaining(form, id) {
  return (form.layout?.mkTree || []).flatMap(row => (row.children || [])
    .filter(cell => cell.refIds?.includes(id))
    .map(cell => ({
      rowId: row.id, rowSourceRef: row.sourceRef, componentId: row.componentId,
      props: row.props, sourceMarkers: row.sourceMarkers, cell
    })));
}
