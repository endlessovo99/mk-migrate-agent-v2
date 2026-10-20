export const ADAPTIVE_LAYOUT_SIZING = "adaptive";

/** Missing sizing is the retained DSL contract; never reinterpret old artifacts. */
export function usesAdaptiveLayout(form) {
  return form?.layout?.sizing === ADAPTIVE_LAYOUT_SIZING;
}

export function layoutSizingIssues(form) {
  return form?.layout?.sizing === undefined || usesAdaptiveLayout(form)
    ? [] : ["form.layout.sizing must be adaptive or absent for the retained source-width policy"];
}
