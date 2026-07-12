import {
  auditSourceScriptRowMarkerOrphans,
  ORPHAN_ROW_MARKER_WARNING_CODE,
  ROW_MARKER_HELPER
} from "../translator/row-marker-orphan-audit.js";

export function classifyActionRowMarkers(action = {}, form = {}, sourceDraft = {}) {
  const source = legacySourceFromGeneratedFunction(action.function);
  const markers = rowMarkersFromText(source);
  const knownMarkers = layoutMarkerSet(form);
  const markerIds = uniqueStrings(markers.map((item) => item.rowId));
  const auditableOrphanIds = verifiedAuditableOrphanIds(action, sourceDraft, knownMarkers);
  const resolvedMarkers = markerIds.filter((rowId) => knownMarkers.has(rowId));
  const orphanMarkers = markerIds.filter((rowId) =>
    !knownMarkers.has(rowId) &&
    auditableOrphanIds.has(rowId)
  );
  const orphanMarkerSet = new Set(orphanMarkers);
  const unresolvedMarkers = markerIds.filter((rowId) =>
    !knownMarkers.has(rowId) && !orphanMarkerSet.has(rowId)
  );

  return { source, markers, resolvedMarkers, orphanMarkers, unresolvedMarkers };
}

export function legacySourceFromGeneratedFunction(functionText = "") {
  const text = String(functionText || "");
  const marker = "Source JSP JavaScript:";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return "";
  return text
    .slice(markerIndex + marker.length)
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*\/\/ ?(.*)$/);
      return match ? match[1] : "";
    })
    .join("\n")
    .trim();
}

export function rowMarkersFromText(text = "") {
  const markers = [];
  const pattern = /common_dom_row_set_show_required_reset\(\s*(["'`])([^"'`]+)\1\s*,\s*(true|false)\s*,\s*(true|false)\s*,\s*(true|false)\s*\)/g;
  for (const match of String(text || "").matchAll(pattern)) {
    markers.push({
      rowId: match[2],
      visible: match[3] === "true",
      required: match[4] === "true",
      reset: match[5] === "true",
      evidence: oneLine(match[0])
    });
  }
  return markers;
}

function verifiedAuditableOrphanIds(action, sourceDraft, knownMarkers) {
  const actionSourceRefs = uniqueStrings(action?.sourceRefs || []);
  if (!actionSourceRefs.length) return new Set();
  const issues = Array.isArray(sourceDraft?.issues) ? sourceDraft.issues : [];
  const sources = Array.isArray(sourceDraft?.scripts?.sources) ? sourceDraft.scripts.sources : [];
  const auditedIds = new Set();
  const invalidIds = new Set();

  for (const sourceRef of actionSourceRefs) {
    const source = sources.find((item) => item?.sourceRef === sourceRef);
    if (!source) return new Set();
    const missingIds = uniqueStrings((source.semanticFacts?.rowMarkers || [])
      .map((fact) => String(fact?.rowId || "").trim())
      .filter((rowId) => rowId && !knownMarkers.has(rowId)));
    const expectedEvidence = auditSourceScriptRowMarkerOrphans(source, knownMarkers);
    const matchingIssues = issues.filter((issue) =>
      issue?.code === ORPHAN_ROW_MARKER_WARNING_CODE && issue?.evidence?.sourceRef === sourceRef
    );
    const validIssue = expectedEvidence &&
      matchingIssues.length === 1 &&
      exactAuditIssue(matchingIssues[0], expectedEvidence);
    const validIds = new Set(validIssue
      ? expectedEvidence.markers.map((marker) => marker.rowId)
      : []);

    for (const rowId of missingIds) {
      if (validIds.has(rowId)) auditedIds.add(rowId);
      else invalidIds.add(rowId);
    }
  }

  for (const rowId of invalidIds) auditedIds.delete(rowId);
  return auditedIds;
}

function exactAuditIssue(issue, expected) {
  const evidence = issue?.evidence;
  const proof = evidence?.proof;
  if (
    issue?.level !== "warning" ||
    issue?.code !== ORPHAN_ROW_MARKER_WARNING_CODE ||
    evidence?.sourceRef !== expected.sourceRef ||
    evidence?.helper !== ROW_MARKER_HELPER ||
    !Array.isArray(evidence?.markers) ||
    evidence.markers.length !== expected.markers.length ||
    proof?.absentFromLayout !== true ||
    proof?.onlyHelperTarget !== true ||
    proof?.resetValuesAudited !== true ||
    proof?.dynamicDomCreationDetected !== false
  ) {
    return false;
  }

  return evidence.markers.every((marker, index) => {
    const expectedMarker = expected.markers[index];
    return marker?.rowId === expectedMarker.rowId &&
      marker?.occurrenceCount === expectedMarker.occurrenceCount &&
      Array.isArray(marker?.resetValues) &&
      marker.resetValues.length === expectedMarker.resetValues.length &&
      marker.resetValues.every((value, resetIndex) => value === expectedMarker.resetValues[resetIndex]);
  });
}

function layoutMarkerSet(form) {
  return new Set(
    (Array.isArray(form?.layout?.mkTree) ? form.layout.mkTree : [])
      .flatMap((row) => Array.isArray(row?.sourceMarkers) ? row.sourceMarkers : [])
      .map((marker) => String(marker || "").trim())
      .filter(Boolean)
  );
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
