import { legacySourceFromGeneratedFunction } from "../../../src/agent-review/row-marker-policy.js";

// Fixture-only reviewer: preserve the supplied callback order while spelling
// its field copies and non-resetting row effects with the target APIs.
export function reviewEventValueAssignment({ dslDraft, reviewScope }) {
  const patches = (dslDraft.scripts?.actions || []).flatMap((action, index) => {
    if (reviewScope?.actionIndexes && !reviewScope.actionIndexes.includes(index)) return [];
    if (action.translationStatus !== "needs_review") return [];
    const source = legacySourceFromGeneratedFunction(action.function);
    const aliases = new Map();
    let body = source.replace(/var\s+(\w+)\s*=\s*GetXFormFieldById\("([^"]+)"\)\[0\];/g,
      (_, alias, target) => { aliases.set(alias, target); return ""; });
    body = body.replace(/(\w+)\.value\s*=\s*([^;\n]+);/g, (_, alias, value) => {
      if (!aliases.has(alias)) throw new Error("Fixture assignment alias is missing");
      return `MKXFORM.setValue(${JSON.stringify(aliases.get(alias))}, ${value});`;
    });
    body = body.replace(/common_dom_row_set_show_required_reset\("([^"]+)",(true|false),(true|false),false\);/g,
      (_, target, visible, required) => action.coverage?.nativeRules?.length ? ""
        : `MKXFORM.setFieldAttr(${JSON.stringify(target)}, ${visible === "true" ? 5 : 4});\nMKXFORM.setFieldAttr(${JSON.stringify(target)}, ${required === "true" ? 3 : 6});`);
    body = body.replace(/\$\('input\[name="extendDataFormInfo\.value\((\w+)\)"\]'\)\.val\(""\);\s*\$\('input\[name="_extendDataFormInfo\.value\(\1\)"\]'\)\.prop\("checked",\s*false\);/g,
      (_, target) => `MKXFORM.setValue(${JSON.stringify(target)}, []);`);
    body = body.replace(/^AttachXFormValueChangeEventById\("[^"]+", function\(value, domElement\) \{/, "function onChange(value, rowNum, parentRowNum) {")
      .replace(/\}\);\s*$/, "}");
    const common = {
      op: "replace", sourceRefs: action.sourceRefs, confidence: 0.99,
      evidence: ["The fixture callback explicitly assigns the bound event parameter and retains its ordered source branches."],
      rationale: "Preserve every field write and row effect in source order using MKXFORM APIs."
    };
    return [
      { ...common, path: `/scripts/actions/${index}/function`, value: body },
      { ...common, path: `/scripts/actions/${index}/translationStatus`, value: "mapped" },
      { ...common, path: `/scripts/actions/${index}/functionMappings`, value: [{ source: "legacy field-object event assignment", target: "MKXFORM.setValue", basis: "semantic-translation", reviewRequired: false }] },
      { ...common, path: `/scripts/actions/${index}/coverage`, value: { status: "translated", nativeRules: action.coverage?.nativeRules || [], residuals: [] } }
    ];
  });
  return { summary: "Preserved source-backed event assignments and branch write order.", patches, diagnostics: [] };
}
