import { resolveDirectRef, resolveSourceRowEffectTarget } from "../dsl/form-rules.js";
import { auditSourceScriptRowMarkerOrphans } from "./row-marker-orphan-audit.js";

// Impact analysis may conservatively cover all same-name source rows. This is
// not a canonical execution target and never changes executor row resolution.
export function captionRowRegion(form, index, id) {
  const exact = resolveSourceRowEffectTarget(form, id);
  if (exact?.source === "rowMarker" && !exact.unresolved?.length) return exact;
  const rows = (form.layout?.mkTree || []).filter(row => row.sourceMarkers?.includes(id));
  const marker = index.markerRefs.get(id);
  if (rows.length < 2 || !marker?.refIds?.length || rows.some(row => !row.sourceRef)) return undefined;
  const fields = (form.fields || []).flatMap(field => [field, ...(field.columns || [])]);
  const targets = marker.refIds.map(ref => {
    const target = resolveDirectRef(index, ref);
    if (!target || fields.filter(field => field.id === target.id).length !== 1 ||
        ref !== target.id && ref !== `${target.parentId}.${target.id}`) return undefined;
    return target;
  });
  if (targets.some(target => !target)) return undefined;
  return { source: "rowMarker", marker, targets,
    impactBasis: "complete-same-name-source-row-union" };
}

// Rebuild the existing source-only orphan audit rather than accepting a warning
// or an absent target alone. The complete runtime still has to pass script scope.
export function auditedCaptionOrphans(source) {
  const markers = new Set((source.form?.layout?.rows || []).flatMap(row => row.sourceMarkers || []));
  const fields = [...(source.form?.controls || []), ...(source.form?.dataFields || []),
    ...(source.form?.detailTables || []).flatMap(table => [table, ...(table.columns || [])])];
  const ids = new Set(fields.map(field => field.id)), result = new Map();
  const scripts = source.scripts?.sources || [];
  for (const script of scripts) {
    if (!script.sourceRef || scripts.filter(other => other.sourceRef === script.sourceRef).length !== 1) continue;
    const audit = auditSourceScriptRowMarkerOrphans(script, markers);
    for (const marker of audit?.markers || []) {
      if (ids.has(marker.rowId)) continue;
      const proof = result.get(marker.rowId) || { resetValues: new Set(), sourceRefs: new Set() };
      marker.resetValues.forEach(value => proof.resetValues.add(value));
      proof.sourceRefs.add(script.sourceRef);
      result.set(marker.rowId, proof);
    }
  }
  return result;
}
