export function reviewAuditedRowMarkerOrphan({ sourceDraft, dslDraft, reviewScope }) {
  const patches = auditedRowMarkerOrphanPatches(sourceDraft, dslDraft, reviewScope);
  return {
    summary: "Translated supported row-marker behavior and ignored only fully audited orphan helper calls.",
    patches,
    diagnostics: patches.length > 0
      ? [{
          level: "warning",
          code: "route.review.audited_orphan_marker_noop",
          path: "/scripts/actions",
          message: "Orphan row-marker helper calls were omitted only after the Source Draft recorded the complete no-op proof."
        }]
      : []
  };
}

function auditedRowMarkerOrphanPatches(sourceDraft, dslDraft, reviewScope) {
  const actions = Array.isArray(dslDraft?.scripts?.actions) ? dslDraft.scripts.actions : [];
  return actions.flatMap((action, actionIndex) => {
    if (!actionIsInReviewScope(actionIndex, reviewScope)) return [];
    const audit = auditedActionContext(action, sourceDraft, dslDraft);
    if (!audit) return [];

    const common = {
      op: "replace",
      sourceRefs: action.sourceRefs || [],
      evidence: [
        "The Source Draft proves every omitted orphan marker is absent from layout, used only by the row helper, never reset, and not dynamically created."
      ],
      confidence: 0.99,
      rationale: "Translate only behavior whose helper or row-marker targets exist in the generated form."
    };
    return [
      {
        ...common,
        path: `/scripts/actions/${actionIndex}/function`,
        value: auditedActionFunction(action, audit)
      },
      {
        ...common,
        path: `/scripts/actions/${actionIndex}/translationStatus`,
        value: "mapped"
      },
      {
        ...common,
        path: `/scripts/actions/${actionIndex}/functionMappings`,
        value: auditedActionMappings(action, audit)
      },
      {
        ...common,
        path: `/scripts/actions/${actionIndex}/coverage`,
        value: { status: "translated", nativeRules: [], residuals: [] }
      }
    ];
  });
}

function auditedActionContext(action, sourceDraft, dslDraft) {
  const actionRefs = uniqueStrings(action?.sourceRefs || []);
  if (!actionRefs.length || !supportedAuditedAction(action, dslDraft?.form)) return undefined;

  const issues = (Array.isArray(sourceDraft?.issues) ? sourceDraft.issues : [])
    .filter((issue) => issue?.code === "source.sysform.script_row_marker_orphan_noop");
  const sources = actionRefs.map((sourceRef) =>
    (sourceDraft?.scripts?.sources || []).find((source) => source?.sourceRef === sourceRef)
  );
  if (sources.some((source) => !source)) return undefined;

  const primaryMarkerBySourceMarker = layoutMarkerIndex(dslDraft?.form);
  const persistedMarkers = [];
  for (let index = 0; index < actionRefs.length; index += 1) {
    const sourceRef = actionRefs[index];
    const source = sources[index];
    const matchingIssues = issues.filter((issue) => issue?.evidence?.sourceRef === sourceRef);
    if (matchingIssues.length !== 1) return undefined;
    const issue = matchingIssues[0];
    if (!completeOrphanAuditIssue(issue, primaryMarkerBySourceMarker, source)) return undefined;

    const factMarkers = uniqueStrings(
      (source?.semanticFacts?.rowMarkers || []).map((fact) => fact?.rowId)
    );
    const orphanMarkers = factMarkers.filter((marker) => !primaryMarkerBySourceMarker.has(marker));
    const auditedOrphans = issue.evidence.markers.map((marker) => marker.rowId);
    if (!sameStringSet(orphanMarkers, auditedOrphans)) return undefined;

    persistedMarkers.push(...factMarkers
      .filter((marker) => primaryMarkerBySourceMarker.has(marker))
      .map((marker) => primaryMarkerBySourceMarker.get(marker)));
  }

  const rowMarkers = uniqueStrings(persistedMarkers);
  const helperFieldId = auditedHelperFieldId(action, sources, dslDraft?.form);
  if (!rowMarkers.length || !helperFieldId || !sources.every(hasElevenAndTwentyTwoBranches)) {
    return undefined;
  }

  return { rowMarkers, helperFieldId };
}

function supportedAuditedAction(action, form) {
  if (action?.event === "onLoad") {
    return action.scope === "global";
  }
  if (action?.event !== "onChange" || action.scope !== "control" || !action.controlId) {
    return false;
  }
  return (form?.fields || []).some((field) =>
    field?.id === action.controlId && field.type !== "detailTable" && field.dataOnly !== true
  );
}

function completeOrphanAuditIssue(issue, primaryMarkerBySourceMarker, source) {
  const evidence = issue?.evidence;
  const proof = evidence?.proof;
  const sourceMarkerFacts = Array.isArray(source?.semanticFacts?.rowMarkers)
    ? source.semanticFacts.rowMarkers
    : [];
  if (
    issue?.level !== "warning" ||
    evidence?.helper !== "common_dom_row_set_show_required_reset" ||
    !Array.isArray(evidence?.markers) ||
    evidence.markers.length === 0 ||
    proof?.absentFromLayout !== true ||
    proof?.onlyHelperTarget !== true ||
    proof?.resetValuesAudited !== true ||
    proof?.dynamicDomCreationDetected !== false
  ) {
    return false;
  }

  const markerIds = evidence.markers.map((marker) => marker?.rowId);
  if (uniqueStrings(markerIds).length !== markerIds.length) return false;
  return evidence.markers.every((marker) => {
    const matchingFacts = sourceMarkerFacts.filter((fact) => fact?.rowId === marker?.rowId);
    return typeof marker?.rowId === "string" && marker.rowId.trim() &&
      Number.isSafeInteger(marker.occurrenceCount) && marker.occurrenceCount > 0 &&
      marker.occurrenceCount === matchingFacts.length &&
      matchingFacts.every((fact) => fact?.reset === false) &&
      Array.isArray(marker.resetValues) &&
      marker.resetValues.length === 1 && marker.resetValues[0] === false &&
      !primaryMarkerBySourceMarker.has(marker.rowId);
  });
}

function layoutMarkerIndex(form) {
  const primaryByMarker = new Map();
  for (const row of Array.isArray(form?.layout?.mkTree) ? form.layout.mkTree : []) {
    const markers = uniqueStrings(row?.sourceMarkers || []);
    if (!markers.length) continue;
    for (const marker of markers) primaryByMarker.set(marker, markers[0]);
  }
  return primaryByMarker;
}

function auditedHelperFieldId(action, sources, form) {
  const fieldIds = new Set(
    (form?.fields || [])
      .filter((field) => field?.dataOnly === true && field?.id)
      .map((field) => field.id)
  );
  const candidates = uniqueStrings(sources.flatMap((source) =>
    action.event === "onChange"
      ? setValueHelperIds(source?.javascript)
      : getValueHelperIds(source?.javascript)
  )).filter((fieldId) => fieldIds.has(fieldId));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function setValueHelperIds(javascript = "") {
  return [...String(javascript).matchAll(
    /\bSetXFormFieldValueById\(\s*(["'])([^"']+)\1\s*,\s*[A-Za-z_$][\w$]*\s*,\s*false\s*\)/g
  )].map((match) => match[2]);
}

function getValueHelperIds(javascript = "") {
  return [...String(javascript).matchAll(
    /\bGetXFormFieldById\(\s*(["'])([^"']+)\1\s*\)/g
  )].map((match) => match[2]);
}

function hasElevenAndTwentyTwoBranches(source) {
  const javascript = String(source?.javascript || "");
  return /={2,3}\s*(?:["']11["']|11\b)/.test(javascript) &&
    /={2,3}\s*(?:["']22["']|22\b)/.test(javascript);
}

function sameStringSet(left, right) {
  const leftSet = new Set(uniqueStrings(left));
  const rightSet = new Set(uniqueStrings(right));
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function auditedActionFunction(action, audit) {
  const rowUpdates = auditedRowUpdates(audit.rowMarkers);
  if (action?.event === "onChange") {
    return `function onChange(value, rowNum, parentRowNum) {
  var selectedValue = Array.isArray(value) ? value[0] : value
  MKXFORM.setValue(${JSON.stringify(audit.helperFieldId)}, selectedValue)
  var normalizedValue = String(selectedValue)
  if (normalizedValue !== "11" && normalizedValue !== "22") return
  var active = normalizedValue === "11"
${rowUpdates}
}`;
  }

  return `function onLoad() {
  var storedValue = MKXFORM.getValue(${JSON.stringify(audit.helperFieldId)})
  var selectedValue = Array.isArray(storedValue) ? storedValue[0] : storedValue
  var normalizedValue = String(selectedValue)
  if (normalizedValue !== "11" && normalizedValue !== "22") return
  var active = normalizedValue === "11"
${rowUpdates}
}`;
}

function auditedRowUpdates(rowMarkers) {
  return rowMarkers.flatMap((rowMarker) => [
    `  MKXFORM.setFieldAttr(${JSON.stringify(rowMarker)}, active ? 5 : 4)`,
    `  MKXFORM.setFieldAttr(${JSON.stringify(rowMarker)}, active ? 3 : 6)`
  ]).join("\n");
}

function auditedActionMappings(action, audit) {
  return [{
    source: action?.event === "onChange" ? "SetXFormFieldValueById" : "GetXFormFieldById",
    target: `${action?.event === "onChange" ? "MKXFORM.setValue" : "MKXFORM.getValue"}(${audit.helperFieldId})`,
    basis: "function-catalog",
    reviewRequired: false
  }, {
    source: "common_dom_row_set_show_required_reset",
    target: "MKXFORM.setFieldAttr",
    basis: "function-catalog",
    reviewRequired: false
  }, {
    source: "audited orphan row-marker helper calls",
    target: "omitted as proven no-op",
    basis: "source-audit",
    reviewRequired: false
  }];
}

function actionIsInReviewScope(actionIndex, reviewScope) {
  return reviewScope === undefined ||
    (Array.isArray(reviewScope.actionIndexes) && reviewScope.actionIndexes.includes(actionIndex));
}
