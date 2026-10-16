import { parse } from "acorn";
import { buildJavaScriptBindingModel } from "./javascript-binding-provenance.js";
import { classifyActionRowMarkers, legacySourceFromGeneratedFunction } from "../agent-review/row-marker-policy.js";
import { canonicalJson } from "../agent-review/digest.js";
import { nativeFormRuleBelongsToAction } from "./native-form-rule-projection.js";
import { validateOrderedRowEffects, validateRowMarkerBranchSemantics } from "../agent-review/script-semantic-closure.js";

/** Recheck newly retained row diagnostics from fixed source, independently of review claims. */
export function sourceRowDiagnosticProof({ sourceAction, action, sourceDraft, expectedForm, targetForm, sourceFormRules, targetFormRules, emptyEventProof }) {
  if (!["mapped", "omitted", "executable"].includes(action?.translationStatus) || emptyEventProof?.ok === false) return { ok: true };
  const source = legacySourceFromGeneratedFunction(sourceAction?.function);
  if (!diagnosticReference(source) && !diagnosticReference(action?.function || "")) return { ok: true };
  const policy = classifyActionRowMarkers(sourceAction, expectedForm, sourceDraft);
  if (!policy.resolvedMarkers.length) return { ok: true }; // Other action kinds retain their existing source contracts.
  if (policy.unresolvedMarkers.length) return invalid("row_diagnostic_source_markers_unproven");
  const native = sourceAction.coverage?.nativeRules || [];
  if (native.length || action.coverage?.nativeRules?.length) {
    if (emptyEventProof?.adapted === true) return { ok: true };
    if (!sameNativeRows(native, action, sourceAction, sourceFormRules, targetFormRules, policy)) {
      return invalid("row_diagnostic_native_closure_unproven");
    }
    const residualSource = withoutNativeRowCalls(source, policy.resolvedMarkers, sourceAction.event);
    if (residualSource === undefined) return invalid("row_diagnostic_native_source_unproven");
    const conditions = (sourceAction.branchProvenance?.conditions || []).map(rowCondition);
    if (conditions.some(condition => !condition.operand) || residualSource.hasIf &&
        (!conditions.length || sourceAction.branchProvenance?.status !== "proven")) {
      return invalid("row_diagnostic_native_conditions_unproven");
    }
    return validateOrderedRowEffects(residualSource.text, action.function, new Set(), value => value,
      conditions, {
        sourceControls: sourceDraft.form?.controls, sourceForm: sourceDraft.form,
        sourceScripts: sourceDraft.scripts, sourceRefs: sourceAction.sourceRefs,
        auditedOrphanMarkers: policy.orphanMarkers, targetFields: targetForm?.fields
      });
  }
  const aliases = new Map();
  for (const row of expectedForm?.layout?.mkTree || []) {
    const markers = (row.sourceMarkers || []).filter(marker => typeof marker === "string" && marker.trim());
    for (const marker of markers) aliases.set(marker, markers[0]);
  }
  return validateRowMarkerBranchSemantics({
    sourceFunction: sourceAction.function,
    reviewedFunction: emptyEventProof?.adapted ? emptyEventProof.function : action.function,
    resolvedMarkers: policy.resolvedMarkers,
    primaryMarkerByAlias: aliases,
    sourceControls: sourceDraft.form?.controls,
    sourceForm: sourceDraft.form,
    sourceScripts: sourceDraft.scripts,
    sourceRefs: sourceAction.sourceRefs,
    auditedOrphanMarkers: policy.orphanMarkers,
    targetFields: targetForm?.fields
  });
}

function rowCondition(condition) {
  return { ...condition, operand: condition.origin,
    ...(condition.kind === "or" ? { left: rowCondition(condition.left), right: rowCondition(condition.right) } : {}) };
}

// Native credit must be fixed-source, action-owned and complete before only
// its value-preserving row attributes are removed from the residual proof view.
function sameNativeRows(ids, action, sourceAction, sourceRules, targetRules, policy) {
  if (!ids.length || canonicalJson(ids) !== canonicalJson(action.coverage?.nativeRules || [])) return false;
  const expected = new Set(policy.markers.filter(marker => policy.resolvedMarkers.includes(marker.rowId))
    .flatMap(marker => [`${marker.rowId}:visible:${marker.visible}`, `${marker.rowId}:required:${marker.required}`]));
  const covered = new Set();
  for (const id of ids) {
    const source = (sourceRules?.linkage || []).filter(rule => rule.id === id);
    const target = (targetRules?.linkage || []).filter(rule => rule.id === id);
    if (source.length !== 1 || target.length !== 1 || source[0].translationStatus !== "executable" ||
        !nativeFormRuleBelongsToAction(source[0], sourceAction) || canonicalJson(source[0]) !== canonicalJson(target[0])) return false;
    for (const effect of [...(source[0].effects || []), ...(source[0].else || [])]) {
      if (["visible", "required"].includes(effect.type) && typeof effect.value === "boolean") {
        covered.add(`${effect.target}:${effect.type}:${effect.value}`);
      }
    }
  }
  return [...expected].every(effect => covered.has(effect));
}

function withoutNativeRowCalls(text, markers, event) {
  let program;
  try { program = parse(text, { ecmaVersion: "latest" }); } catch { return undefined; }
  const bindings = buildJavaScriptBindingModel(text, { event });
  if (!bindings.ok) return undefined;
  const spans = [];
  let hasIf = false;
  function walk(node, parent) {
    if (!node || typeof node !== "object") return;
    if (node.type === "IfStatement") hasIf = true;
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" &&
        node.callee.name === "common_dom_row_set_show_required_reset" && markers.includes(node.arguments[0]?.value)) {
      if (node.optional || !bindings.isUnshadowedGlobal(node.callee.name, node.start) ||
          parent?.type !== "ExpressionStatement" || node.arguments.length !== 4 ||
          node.arguments.some(argument => argument.type !== "Literal") ||
          node.arguments.slice(1, 3).some(argument => typeof argument.value !== "boolean") ||
          node.arguments[3].value !== false) throw Error("unproven native row call");
      spans.push({ start: parent.start, end: parent.end });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => walk(child, node));
      else if (value && typeof value === "object") walk(value, node);
    }
  }
  try { walk(program); } catch { return undefined; }
  let output = text;
  for (const span of spans.sort((left, right) => right.start - left.start)) {
    output = output.slice(0, span.start) + ";" + output.slice(span.end);
  }
  return { text: output, hasIf };
}

function diagnosticReference(text) {
  if (!text) return false;
  let program;
  try { program = parse(text, { ecmaVersion: "latest" }); } catch { return true; }
  function contains(node, parent) {
    if (!node || typeof node !== "object") return false;
    if (node.type === "Identifier" && node.name === "console" &&
        !(parent?.type === "MemberExpression" && parent.property === node && !parent.computed) &&
        !(parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand)) return true;
    return Object.values(node).some(value => Array.isArray(value)
      ? value.some(child => contains(child, node)) : value && typeof value === "object" && contains(value, node));
  }
  return contains(program);
}
function invalid(reason) { return { ok: false, reason }; }
