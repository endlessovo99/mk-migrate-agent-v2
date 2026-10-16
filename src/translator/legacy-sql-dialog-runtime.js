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
    translationStatus: "needs_review",
    coverage: { status: "uncovered", nativeRules: [], residuals: [{
      code: "script.residual.remote_dialog_unbound",
      message: "Generated SQL lookup and callback behavior has no verified target implementation.",
      sourceRef
    }] },
    functionMappings: [{
      source: `generated SQLDialog Dialog_List runtime for ${fieldId}`,
      target: "unimplemented remote lookup and callback",
      basis: "untranslated-source",
      reviewRequired: true
    }],
    sourceRefs: [sourceRef]
  };
}
