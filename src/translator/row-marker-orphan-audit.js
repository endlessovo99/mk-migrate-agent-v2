import { extractFunctionCalls } from "./function-whitelist.js";

export const ORPHAN_ROW_MARKER_WARNING_CODE = "source.sysform.script_row_marker_orphan_noop";
export const ROW_MARKER_HELPER = "common_dom_row_set_show_required_reset";

export function auditSourceScriptRowMarkerOrphans(source = {}, layoutMarkers = new Set()) {
  const persistedMarkers = layoutMarkers instanceof Set
    ? layoutMarkers
    : new Set(layoutMarkers || []);
  const facts = Array.isArray(source.semanticFacts?.rowMarkers)
    ? source.semanticFacts.rowMarkers
    : [];
  const orphanIds = uniqueStrings(facts
    .map((fact) => String(fact?.rowId || "").trim())
    .filter((rowId) => rowId && !persistedMarkers.has(rowId)));
  if (!orphanIds.length || dynamicDomCreationDetected(source.javascript)) return undefined;

  const helperCalls = exactRowMarkerHelperCalls(source.javascript);
  const stringValues = literalStringValues(source.javascript);
  const markers = orphanIds.flatMap((rowId) => {
    const matchingFacts = facts.filter((fact) => fact?.rowId === rowId);
    const matchingCalls = helperCalls.filter((call) => call.rowId === rowId);
    const resetValues = uniqueBooleans(matchingCalls.map((call) => call.reset));
    const factResetValues = uniqueBooleans(matchingFacts.map((fact) => fact.reset));
    const literalOccurrenceCount = stringValues.filter((value) =>
      containsMarkerToken(value, rowId)
    ).length;
    const onlyHelperTarget = matchingCalls.length > 0 &&
      matchingCalls.length === matchingFacts.length &&
      matchingCalls.length === literalOccurrenceCount;
    const resetAlwaysFalse = resetValues.length === 1 && resetValues[0] === false &&
      factResetValues.length === 1 && factResetValues[0] === false;

    if (!onlyHelperTarget || !resetAlwaysFalse) return [];
    return [{
      rowId,
      occurrenceCount: matchingCalls.length,
      resetValues
    }];
  });
  if (!markers.length) return undefined;

  return {
    sourceRef: source.sourceRef,
    helper: ROW_MARKER_HELPER,
    markers,
    proof: {
      absentFromLayout: true,
      onlyHelperTarget: true,
      resetAlwaysFalse: true,
      dynamicDomCreationDetected: false
    }
  };
}

function exactRowMarkerHelperCalls(javascript = "") {
  const text = String(javascript || "");
  const calls = [];
  const helper = extractFunctionCalls(text).find((call) => call.name === ROW_MARKER_HELPER);
  const pattern = /^common_dom_row_set_show_required_reset\(\s*(["'`])([^"'`\\]+)\1\s*,\s*(?:true|false)\s*,\s*(?:true|false)\s*,\s*(true|false)\s*\)/;
  for (const occurrence of helper?.occurrences || []) {
    const match = pattern.exec(text.slice(occurrence.index));
    if (!match) continue;
    calls.push({
      rowId: match[2],
      reset: match[3] === "true"
    });
  }
  return calls;
}

function literalStringValues(javascript = "") {
  const values = [];
  const pattern = /(["'`])([^"'`\\]*(?:\\.[^"'`\\]*)*)\1/g;
  for (const match of String(javascript || "").matchAll(pattern)) {
    values.push(match[2]);
  }
  return values;
}

function dynamicDomCreationDetected(javascript = "") {
  const text = String(javascript || "");
  return [
    /\b(?:createElement|createElementNS|createDocumentFragment|createTextNode|cloneNode)\s*\(/,
    /\b(?:appendChild|insertBefore|replaceChild|insertAdjacentHTML|insertAdjacentElement|createContextualFragment|insertRow|insertCell)\s*\(/,
    /\.(?:append|prepend|before|after|replaceWith|wrap|wrapAll|wrapInner|html)\s*\(/,
    /\.(?:innerHTML|outerHTML)\s*(?:\+?=)/,
    /\bdocument\.(?:write|writeln)\s*\(/,
    /\bnew\s+DOMParser\s*\(/,
    /(?:^|[^\w$])(?:\$|jQuery)\s*\(\s*["'`]\s*</
  ].some((pattern) => pattern.test(text));
}

function containsMarkerToken(value, rowId) {
  const marker = escapeRegExp(rowId);
  return new RegExp(`(?:^|[^A-Za-z0-9_])${marker}(?=$|[^A-Za-z0-9_])`).test(String(value || ""));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function uniqueBooleans(values) {
  return [...new Set(values.filter((value) => typeof value === "boolean"))];
}
