import { readFileSync } from "node:fs";

export function reviewRowMarkerProof({ sourceDraft, dslDraft, reviewScope }) {
  const functions = JSON.parse(readFileSync(new URL("../../fixtures/route-validation/row-marker-proof/reviewed-functions.json", import.meta.url), "utf8"));
  const patches = dslDraft.scripts.actions.flatMap((action, index) => {
    if (reviewScope?.actionIndexes && !reviewScope.actionIndexes.includes(index)) return [];
    if (action.translationStatus !== "needs_review") return [];
    if (index !== 0) throw new Error("Unexpected row-marker proof fixture action");
    const source = sourceDraft.scripts.sources.find(script => action.sourceRefs.includes(script.sourceRef));
    if (!source) throw new Error("Missing row-marker proof fixture source");
    const key = source.javascript.includes("setTimeout") ? "timed-indexed-main-select" : "existing-atomic-if";
    const common = {
      op: "replace", sourceRefs: action.sourceRefs, confidence: 0.99,
      evidence: ["The fixture preserves the source field read, prelude, conditional row effects and timer when present."],
      rationale: "Retain each source read and row effect in its original execution order."
    };
    const values = {
      function: functions[key], translationStatus: "mapped",
      functionMappings: [{ source: "source row initialization", target: "MKXFORM row initialization", basis: "semantic-translation", reviewRequired: false }],
      coverage: { status: "translated", nativeRules: [], residuals: [] }
    };
    return Object.entries(values).map(([field, value]) => ({ ...common, path: `/scripts/actions/${index}/${field}`, value }));
  });
  return { summary: "Preserved source row initialization and ordered effects.", patches, diagnostics: [] };
}
