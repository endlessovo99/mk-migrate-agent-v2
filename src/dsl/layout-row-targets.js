/** Select an unambiguous DSL reference for each layout row. Main-field IDs keep
 * their value/control meaning even when the source also uses them as markers. */
export function layoutRowTargets(form = {}) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const rows = Array.isArray(form?.layout?.mkTree) ? form.layout.mkTree : [];
  const fieldIds = new Set(fields.flatMap(field => [
    field?.id, ...(Array.isArray(field?.columns) ? field.columns : []).map(column => column?.id)
  ]).filter(Boolean));
  return rows.flatMap(row => {
    const markers = (Array.isArray(row?.sourceMarkers) ? row.sourceMarkers : []).map(marker => String(marker || "").trim()).filter(Boolean);
    const primary = markers[0] || String(row?.id || "").trim();
    const target = fieldIds.has(primary) ? String(row?.id || "").trim() : primary;
    if (!target || fieldIds.has(target)) return [];
    return [{ row, markers, target }];
  });
}

export function canonicalRowTarget(form, sourceMarker) {
  const matches = layoutRowTargets(form).filter(entry =>
    entry.markers.includes(sourceMarker) || entry.row.id === sourceMarker
  );
  const targets = new Set(matches.map(entry => entry.target));
  return targets.size === 1 ? matches[0].target : undefined;
}
