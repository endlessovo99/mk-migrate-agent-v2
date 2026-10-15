import { readFileSync } from "node:fs";
const functions = JSON.parse(readFileSync(new URL("../../fixtures/route-validation/timed-initialization/reviewed-functions.json", import.meta.url), "utf8"));

export function reviewTimedInitialization({ dslDraft, reviewScope }) {
  const patches = dslDraft.scripts.actions.flatMap((action, index) => {
    if (reviewScope?.actionIndexes && !reviewScope.actionIndexes.includes(index)) return [];
    if (action.translationStatus !== "needs_review") return [];
    if (index > 1) throw new Error("Unexpected timed fixture action");
    const common = {
      op: "replace", sourceRefs: action.sourceRefs, confidence: 0.99,
      evidence: ["The fixture preserves the source timer, callback field reads, conditions and ordered effects."],
      rationale: "Use the same 510ms scheduled callback with evidenced native field operations."
    };
    const values = {
      function: functions[index === 0 ? "atomic" : "or"], translationStatus: "mapped",
      functionMappings: [{ source: "static scheduled initialization", target: "same setTimeout with MKXFORM", basis: "semantic-translation", reviewRequired: false }],
      coverage: { status: "translated", nativeRules: [], residuals: [] }
    };
    return Object.entries(values).map(([key, value]) => ({ ...common, path: `/scripts/actions/${index}/${key}`, value }));
  });
  return { summary: "Preserved both source scheduled initializations.", patches, diagnostics: [] };
}
