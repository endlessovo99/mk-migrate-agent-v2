export function procurementDetailLockAndLinkCandidates(source = {}, form = {}) {
  return [
    procurementDetailPointerLockCandidate(source, form),
    viewUrlAutolinkOmissionCandidate(source, form)
  ].filter(Boolean);
}

function procurementDetailPointerLockCandidate(source, form) {
  const text = String(source.javascript || "");
  const match = text.match(
    /\$\(\s*document\s*\)\.ready\(\s*function\s*\(\s*\)\s*\{[\s\S]*?#TABLE_DL_(fd_[A-Za-z0-9_]+)['"]\s*\)\.css\(\s*\{[\s\S]*?pointer-events['"]\s*:\s*['"]none['"][\s\S]*?\}\s*\)/u
  );
  if (!match) return undefined;
  const tableId = match[1];
  const table = (form?.fields || []).find((field) => field?.id === tableId && field.type === "detailTable");
  if (!table) return undefined;

  const sourceRef = source.sourceRef || source.id;
  return {
    index: text.indexOf("pointer-events"),
    event: "onLoad",
    scope: "global",
    javascript: text,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: `jQuery pointer-events:none on TABLE_DL_${tableId}`,
      target: "MKXFORM.disabledOperation(table, false)",
      basis: "deterministic-detail-pointer-lock",
      reviewRequired: false
    }],
    sourceRefs: [sourceRef],
    semanticHints: {
      coveredCalculationRanges: [{
        sourceRef,
        name: "procurementDetailPointerLock",
        start: 0,
        end: Math.max(1, text.length)
      }]
    },
    function: [
      "function onLoad() {",
      `  MKXFORM.disabledOperation(${JSON.stringify(`\${table:${tableId}}`)}, false)`,
      "}"
    ].join("\n")
  };
}

function viewUrlAutolinkOmissionCandidate(source, form) {
  const text = String(source.javascript || "");
  if (source.displayGate !== "xform:viewShow") return undefined;
  if (!/getElementsByClassName\(\s*['"]link-url['"]\s*\)/.test(text)) return undefined;
  if (!/window\.open/.test(text) || !/window\.onload/.test(text)) return undefined;
  const hasHyperlink = (form?.fields || []).some((field) => field?.componentId === "xform-hyperlinks");
  if (hasHyperlink) return undefined;

  const sourceRef = source.sourceRef || source.id;
  return {
    index: text.indexOf("window.onload"),
    event: "onLoad",
    scope: "global",
    javascript: text,
    function: "",
    translationStatus: "omitted",
    coverage: { status: "covered", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "viewShow .link-url innerHTML rewrite and window.open; source layout never emits that class",
      target: "native longText rendering",
      basis: "legacy-runtime-noop",
      reviewRequired: false
    }],
    sourceRefs: [sourceRef],
    semanticHints: {
      coveredLegacyFunctions: ["window.open", "window.onload", "getElementsByClassName"],
      coveredCalculationRanges: [{
        sourceRef,
        name: "viewUrlAutolink",
        start: 0,
        end: Math.max(1, text.length)
      }]
    }
  };
}
