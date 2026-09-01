export function legacySqlDialogRuntimeCandidate(source = {}, form = {}) {
  const text = String(source.javascript || "");
  const fieldId = text.match(/_clickSqlSelect_(fd_[A-Za-z0-9_]+)/)?.[1];
  if (!fieldId) return undefined;
  if (!/\bDialog_List\s*\(/.test(text)) return undefined;
  if (!new RegExp(`_sqlSelectAfterCallBackFun_${fieldId}`).test(text)) return undefined;
  const field = (form?.fields || []).find((candidate) =>
    candidate?.id === fieldId && candidate.type !== "detailTable"
  );
  if (String(field?.sourceProps?.designerType || "") !== "SQLDialog") return undefined;

  const sourceRef = source.sourceRef || source.id;
  return {
    index: text.indexOf(`_clickSqlSelect_${fieldId}`),
    event: "onLoad",
    scope: "global",
    javascript: text,
    function: "",
    translationStatus: "omitted",
    coverage: { status: "covered", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: `generated SQLDialog Dialog_List runtime for ${fieldId}`,
      target: "visible required text field; remote SQL lookup remains manual",
      basis: "legacy-runtime-noop",
      reviewRequired: false
    }],
    sourceRefs: [sourceRef],
    semanticHints: {
      coveredLegacyFunctions: ["Dialog_List", "RegExp", "rtnVal.GetHashMapArray"],
      coveredCalculationRanges: [{
        sourceRef,
        name: "legacySqlDialogRuntime",
        start: 0,
        end: Math.max(1, text.length)
      }]
    }
  };
}
