import { parse } from "acorn";
import { createHash } from "node:crypto";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";
import { auditSourceScriptRowMarkerOrphans, ROW_MARKER_HELPER } from "./row-marker-orphan-audit.js";

const digest = value => createHash("sha256").update(String(value)).digest("hex");

// Re-audit the current whole script. The returned work copy keeps every source
// position and line ending; callers retain the original Source Draft unchanged.
export function normalizeAuditedSourceRowOrphans(source = {}, form = {}) {
  const text = String(source.javascript || "");
  const sourceRef = source.sourceRef || source.id;
  if (!sourceRef) return undefined;
  let program;
  try { program = parse(text, { ecmaVersion: "latest" }); } catch { return undefined; }
  const markers = layoutMarkers(form);
  const audit = auditSourceScriptRowMarkerOrphans({ ...source, sourceRef }, markers);
  if (!audit) return undefined;
  const bindings = buildJavaScriptBindingModel(text);
  if (!bindings.ok) return undefined;
  const calls = [];
  let helperMutation = false;
  visit(program, undefined, (node, parent) => {
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === ROW_MARKER_HELPER) calls.push({ node, parent });
    if (["AssignmentExpression", "UpdateExpression"].includes(node.type)) {
      let left = node.left || node.argument;
      if (left?.type === "Identifier" && left.name === ROW_MARKER_HELPER) helperMutation = true;
      while (left?.type === "MemberExpression") {
        const property = left.computed ? left.property?.value : left.property?.name;
        if (property === ROW_MARKER_HELPER) helperMutation = true;
        left = left.object;
      }
    }
  });
  if (helperMutation) return undefined;
  const fieldIds = new Set((form.fields || []).flatMap(field => [field, ...(field.columns || [])]).flatMap(field => [
    field?.id, field?.sourceProps?.designerId, field?.sourceProps?.metadataId
  ]).filter(Boolean));
  const removedStatements = [];
  const auditedMarkers = [];
  for (const marker of audit.markers) {
    if (markers.has(marker.rowId) || fieldIds.has(marker.rowId)) continue;
    const matches = calls.filter(({ node }) => node.arguments[0]?.type === "Literal" && node.arguments[0].value === marker.rowId);
    if (matches.length !== marker.occurrenceCount || matches.some(({ node, parent }) =>
      node.optional || node.arguments.length !== 4 || parent?.type !== "ExpressionStatement" || parent.expression !== node ||
      !bindings.isUnshadowedGlobal(ROW_MARKER_HELPER, node.callee.start) ||
      node.arguments.slice(1).some(argument => argument.type !== "Literal" || typeof argument.value !== "boolean")
    )) continue;
    auditedMarkers.push(marker);
    removedStatements.push(...matches.map(({ node, parent }) => ({
      helper: ROW_MARKER_HELPER, marker: marker.rowId,
      flags: node.arguments.slice(1).map(argument => argument.value),
      start: parent.start, end: parent.end, callStart: node.start, callEnd: node.end,
      sourceSha256: digest(text.slice(parent.start, parent.end))
    })));
  }
  if (!removedStatements.length) return undefined;
  const javascript = [...removedStatements].sort((left, right) => right.start - left.start).reduce((current, range) => {
    const blank = current.slice(range.start, range.end).replace(/[^\r\n]/g, " ");
    return current.slice(0, range.start) + ";" + blank.slice(1) + current.slice(range.end);
  }, text);
  const layoutMarkerIds = [...markers].sort();
  return {
    javascript,
    evidence: { version: 1, sourceRef, helper: ROW_MARKER_HELPER,
      sourceJavascriptSha256: digest(text), normalizedJavascriptSha256: digest(javascript),
      layoutMarkerIds, layoutMarkersSha256: digest(JSON.stringify(layoutMarkerIds)),
      markers: auditedMarkers, removedStatements: removedStatements.sort((left, right) => left.start - right.start), audit }
  };
}

function layoutMarkers(form) {
  const markers = new Set();
  visit(form.layout, undefined, node => {
    for (const marker of node.sourceMarkers || []) if (typeof marker === "string" && marker.trim()) markers.add(marker.trim());
  });
  return markers;
}
function visit(node, parent, callback) {
  if (!node || typeof node !== "object") return;
  callback(node, parent);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach(value => visit(value, node, callback));
    else if (child && typeof child === "object") visit(child, node, callback);
  }
}
