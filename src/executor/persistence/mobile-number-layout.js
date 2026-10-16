import { sourceNumberDisplays, sourceNumberEditors } from "../../dsl/source-number-editor.js";

// The current mobile fieldset has 16px horizontal padding, and m-number
// retains an 80px input minimum. Source widths remain unchanged in the DSL.
export function mobileNumberBudgets(form) {
  return new Map([
    ...[...sourceNumberEditors(form)].map(([id, profile]) => [id, Math.max(80, profile.inputPx) + 32]),
    ...[...sourceNumberDisplays(form)].map(([id, profile]) => [id, profile.inputPx + 32])
  ]);
}

// Keep the source grid and merged-cell positions. In a narrow mobile viewport,
// preserve content minima and make the original row horizontally accessible.
export function mobileNumberGrid(projection, budgets, captionProfiles = new Map()) {
  const numeric = projection.cells.some(cell => cell.refIds?.some(id => budgets.has(id)));
  if (projection.columns < 2 || !numeric && !captionProfiles.has(projection.id)) return undefined;
  const styles = projection.colsStyle;
  if (!Array.isArray(styles) || styles.length !== projection.columns || !styles.every((style, index) =>
    style.startIndex === index && style.count === 1 &&
    /^(?:\d+(?:\.\d+)?)%$/.test(style.value) && Number.parseFloat(style.value) > 0)) return undefined;
  return {
    colsStyle: styles.map(style => ({
      ...style,
      // A percentage inside minmax is normalized incorrectly by this runtime.
      // Fr weights retain the proportions without assuming source pixel units.
      value: !numeric && (captionProfiles.get(projection.id)?.percentTextareaColumns?.includes(style.startIndex) ||
        captionProfiles.get(projection.id)?.percentBodyColumns?.includes(style.startIndex))
        ? style.value
        : `minmax(max-content, ${Number.parseFloat(style.value)}fr)`
    })),
    style: { overflowX: "auto" }
  };
}
