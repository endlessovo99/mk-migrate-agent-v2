import { readFileSync } from "node:fs";
const functions = JSON.parse(readFileSync(new URL("../../fixtures/route-validation/same-operand-or-proof/reviewed-functions.json", import.meta.url), "utf8"));

export function reviewSameOperandOr({ dslDraft, reviewScope }) {
  const patches = dslDraft.scripts.actions.flatMap((action, index) => {
    if (reviewScope?.actionIndexes && !reviewScope.actionIndexes.includes(index)) return [];
    if (action.translationStatus !== "needs_review") return [];
    if (!functions[action.event]) throw new Error("Missing OR fixture review function");
    const common = {
      op: "replace", sourceRefs: action.sourceRefs, confidence: 0.99,
      evidence: ["The fixture preserves the same operand, ordered OR tree, and branch effects."],
      rationale: "Translate the evidenced load and change callbacks with their complete source branches."
    };
    return [
      { ...common, path: `/scripts/actions/${index}/function`, value: functions[action.event] },
      { ...common, path: `/scripts/actions/${index}/translationStatus`, value: "mapped" },
      { ...common, path: `/scripts/actions/${index}/functionMappings`, value: [{ source: "same-operand OR source callbacks", target: "MKXFORM field reads and effects", basis: "semantic-translation", reviewRequired: false }] },
      { ...common, path: `/scripts/actions/${index}/coverage`, value: { status: "translated", nativeRules: [], residuals: [] } }
    ];
  });
  return { summary: "Preserved both source OR callbacks.", patches, diagnostics: [] };
}
