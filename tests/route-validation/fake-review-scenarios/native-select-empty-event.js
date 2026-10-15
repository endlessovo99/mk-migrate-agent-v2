import { readFileSync } from "node:fs";

export function reviewNativeSelectEmptyEvent({ dslDraft, reviewScope }) {
  const functions = JSON.parse(readFileSync(new URL("../../fixtures/route-validation/native-select-empty-event/reviewed-functions.json", import.meta.url), "utf8"));
  const patches = dslDraft.scripts.actions.flatMap((action, index) => {
    if (reviewScope?.actionIndexes && !reviewScope.actionIndexes.includes(index)) return [];
    if (action.translationStatus !== "needs_review") return [];
    if (index !== 0 || action.event !== "onChange") throw new Error("Unexpected native select empty-event fixture action");
    const common = {
      op: "replace", sourceRefs: action.sourceRefs, confidence: 0.99,
      evidence: ["The source runtime select explicitly provides an empty choice; native clear uses null for that state."],
      rationale: "Adapt only native null to the source empty value, preserving all other inputs and source effects."
    };
    const values = {
      function: functions.onChange, translationStatus: "mapped",
      functionMappings: (action.functionMappings || []).map(mapping => ({ ...mapping, basis: "semantic-translation", reviewRequired: false })),
      coverage: { status: "translated", nativeRules: action.coverage?.nativeRules || [], residuals: [] }
    };
    return Object.entries(values).map(([field, value]) => ({ ...common, path: `/scripts/actions/${index}/${field}`, value }));
  });
  return { summary: "Preserved the source select's empty-choice branch with a strict native-null adapter.", patches, diagnostics: [] };
}
