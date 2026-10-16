// These source effects have no verified complete native translation. A reviewer
// can retain the pending work, but cannot erase it by changing script metadata.
const PROTECTED_RESIDUALS = new Set([
  "script.residual.detail_row_effect_unproven",
  "script.residual.detail_row_lifecycle_unproven",
  "script.residual.detail_row_property_unproven"
]);

export function detailRowSourceEffectResiduals(action) {
  return (action?.coverage?.residuals || []).filter(item => PROTECTED_RESIDUALS.has(item.code));
}

export function detailRowSourceEffectDiagnostics(expectedActions, actualActions, { prefix = "trust.script" } = {}) {
  const diagnostics = [];
  for (const expected of expectedActions || []) {
    const residuals = detailRowSourceEffectResiduals(expected);
    if (!residuals.length) continue;
    const matches = (actualActions || []).filter(action => action.id === expected.id);
    const actual = matches.length === 1 ? matches[0] : undefined;
    const ownerKeys = ["id", "name", "event", "scope", "controlId", "tableId", "runWhen", "sourceRefs", "sourceActionKey"];
    const ownerMatches = actual && ownerKeys.every(key => canonical(actual[key]) === canonical(expected[key]));
    const actualResiduals = actual?.coverage?.residuals || [];
    if (ownerMatches && actual.translationStatus === "needs_review" &&
        !["covered", "translated"].includes(actual.coverage?.status) &&
        residuals.every(item => actualResiduals.some(other => canonical(item) === canonical(other)))) continue;
    diagnostics.push({
      level: "error", code: `${prefix}.detail_row_source_effect_unproven`,
      message: "The fixed source contains unsupported detail-row effects or lifecycle behavior; retain its unique pending action and complete residual evidence.",
      path: "/scripts/actions",
      details: { actionId: expected.id, expectedResidualCodes: [...new Set(residuals.map(item => item.code))],
        reason: !ownerMatches ? "source_owner_changed" : "source_effect_erased" }
    });
  }
  return diagnostics;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
