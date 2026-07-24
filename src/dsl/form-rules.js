export const FORM_RULE_OPERATORS = new Set([
  "eq",
  "ne",
  "contains",
  "notContains",
  "in",
  "empty",
  "notEmpty"
]);

export const FORM_RULE_EFFECT_TYPES = new Set(["visible", "required"]);
export const FORM_RULE_TRIGGERS = new Set(["change", "load"]);
export const FORM_RULE_LOGIC = new Set(["and", "or"]);

export function summarizeFormRules(formRules = {}) {
  const linkage = Array.isArray(formRules.linkage) ? formRules.linkage : [];
  const summary = {
    sourceRuleCount: linkage.length,
    displayRuleCount: 0,
    requireRuleCount: 0,
    conditionFieldCount: 0,
    targetCount: 0,
    conditions: [],
    targets: []
  };
  const conditionSet = new Set();
  const targetSet = new Set();

  for (const rule of linkage) {
    const when = Array.isArray(rule?.when) ? rule.when : [];
    summary.conditionFieldCount += when.length;
    for (const condition of when) {
      const text = conditionText(condition);
      if (text && !conditionSet.has(text)) {
        conditionSet.add(text);
        summary.conditions.push(text);
      }
    }

    for (const branch of [rule?.effects, rule?.else]) {
      const effects = Array.isArray(branch) ? branch : [];
      if (effects.some((effect) => effect?.type === "visible")) summary.displayRuleCount += 1;
      if (effects.some((effect) => effect?.type === "required")) summary.requireRuleCount += 1;
      for (const effect of effects) {
        if (typeof effect?.target !== "string" || !effect.target.trim()) continue;
        if (!targetSet.has(effect.target)) {
          targetSet.add(effect.target);
          summary.targets.push(effect.target);
        }
      }
    }
  }

  summary.targetCount = summary.targets.length;
  return summary;
}

export function buildFormRuleRefIndex(form = {}) {
  const fieldRefs = new Map();
  const markerRefs = new Map();
  const fields = Array.isArray(form.fields) ? form.fields : [];

  for (const field of fields) {
    if (!field?.id) continue;
    if (field.type === "detailTable") {
      const columns = Array.isArray(field.columns) ? field.columns : [];
      addRef(fieldRefs, field.id, {
        kind: "detailTable",
        id: field.id,
        field,
        columns: columns.map((column) => ({
          kind: "detailColumn",
          id: column.id,
          parentId: field.id,
          field: column
        })).filter((column) => column.id)
      });
      for (const column of columns) {
        if (!column?.id) continue;
        const ref = {
          kind: "detailColumn",
          id: column.id,
          parentId: field.id,
          field: column
        };
        addRef(fieldRefs, column.id, ref);
        addRef(fieldRefs, `${field.id}.${column.id}`, ref);
      }
      continue;
    }

    addRef(fieldRefs, field.id, {
      kind: "field",
      id: field.id,
      field
    });
  }

  const rows = Array.isArray(form.layout?.mkTree) ? form.layout.mkTree : [];
  const layoutRowsById = new Map(
    rows.filter((row) => row?.id).map((row) => [row.id, row])
  );
  // A single legacy row can become multiple native rows when a detail table
  // has ordinary sibling controls (for example a footer total). The segments
  // deliberately share sourceRef while only one owns the runtime marker.
  // Resolve that marker through the whole source-row group without copying it
  // onto sibling rows and creating duplicate runtime locators.
  const sourceRowGroups = new Map();
  for (const row of rows) {
    const sourceRef = normalizeRef(row?.sourceRef);
    if (!sourceRef) continue;
    const group = sourceRowGroups.get(sourceRef) || { rowIds: [], refIds: [] };
    group.rowIds.push(row.id);
    group.refIds.push(...descendantLeafRefIds(row, layoutRowsById));
    sourceRowGroups.set(sourceRef, group);
  }

  for (const row of rows) {
    const sourceMarkers = Array.isArray(row?.sourceMarkers) ? row.sourceMarkers : [];
    if (!sourceMarkers.length) continue;
    const ownRefIds = descendantLeafRefIds(row, layoutRowsById);
    const sourceGroup = sourceRowGroups.get(normalizeRef(row.sourceRef));
    const rowIds = [...new Set((sourceGroup?.rowIds || [row.id]).filter(Boolean))];
    const refIds = [...new Set((sourceGroup?.refIds || ownRefIds).filter(Boolean))];
    for (const marker of sourceMarkers) {
      addMarkerRef(markerRefs, marker, {
        kind: "rowMarker",
        marker,
        rowId: row.id,
        rowIds,
        refIds
      });
    }
  }

  return { fieldRefs, markerRefs };
}

export function resolveDirectRef(index, ref) {
  for (const candidate of fieldRefCandidates(ref)) {
    if (index.fieldRefs.has(candidate)) return index.fieldRefs.get(candidate);
    if (candidate.includes(".")) {
      const tail = candidate.split(".").pop();
      if (index.fieldRefs.has(tail)) return index.fieldRefs.get(tail);
    }
  }
  return undefined;
}

export function resolveEffectTarget(index, ref) {
  const direct = resolveDirectRef(index, ref);
  if (direct) {
    return {
      source: "direct",
      ref: normalizeRef(ref),
      targets: expandDslTarget(direct)
    };
  }

  const normalized = normalizeRef(ref);
  const marker = findMarkerRef(index, normalized);
  if (!marker) return undefined;

  const targets = [];
  const unresolved = [];
  for (const refId of marker.refIds) {
    const resolved = resolveDirectRef(index, refId);
    if (!resolved) {
      unresolved.push(refId);
      continue;
    }
    targets.push(...expandDslTarget(resolved));
  }

  if (!targets.length || unresolved.length) {
    return {
      source: "rowMarker",
      ref: normalized,
      marker,
      targets,
      unresolved
    };
  }

  return {
    source: "rowMarker",
    ref: normalized,
    marker,
    targets
  };
}

/**
 * Resolve a legacy layout row marker to the concrete NewOA controls rendered
 * inside that row. Script functions may keep the marker as a DSL-level source
 * reference, but the executor must compile it away before persistence because
 * MKXFORM.setFieldAttr accepts control ids, not layout metadata ids.
 */
export function resolveRowMarkerControlIds(form = {}, ref) {
  const resolved = resolveEffectTarget(buildFormRuleRefIndex(form), ref);
  if (resolved?.source !== "rowMarker" || resolved.unresolved?.length) return [];
  return [...new Set((resolved.targets || []).map((target) => target?.id).filter(Boolean))];
}

export function normalizeRef(ref) {
  return typeof ref === "string" && ref.trim() ? ref.trim() : undefined;
}

function findMarkerRef(index, ref) {
  for (const candidate of markerRefCandidates(ref)) {
    const marker = index.markerRefs.get(candidate);
    if (marker) return marker;
  }
  return undefined;
}

function markerRefCandidates(ref) {
  const normalized = normalizeRef(ref);
  if (!normalized) return [];
  const candidates = [normalized];
  if (normalized.startsWith("fd_")) {
    candidates.push(normalized.slice(3));
  } else {
    candidates.push(`fd_${normalized}`);
  }
  return candidates;
}

// Landray radio/checkbox change listeners often register as d_<hex> while the
// designer/metadata field id remains fd_<hex>. Accept that one-character alias.
function fieldRefCandidates(ref) {
  const normalized = normalizeRef(ref);
  if (!normalized) return [];
  const candidates = [normalized];
  if (/^d_[A-Za-z0-9_]+$/.test(normalized)) {
    candidates.push(`f${normalized}`);
  } else if (/^fd_[A-Za-z0-9_]+$/.test(normalized)) {
    candidates.push(normalized.slice(1));
  }
  return candidates;
}

function expandDslTarget(target) {
  // Detail tables are whole-container visibility/required targets.
  // Column-level effects must address column ids (or table.column) directly.
  return [target];
}

function conditionText(condition) {
  if (!condition?.field || !condition?.op) return "";
  if (condition.value === undefined || condition.value === null || condition.op === "empty" || condition.op === "notEmpty") {
    return `${condition.field} ${condition.op}`;
  }
  return `${condition.field} ${condition.op} ${Array.isArray(condition.value) ? condition.value.join(",") : condition.value}`;
}

function childRefIds(child) {
  if (Array.isArray(child?.refIds) && child.refIds.length) return child.refIds;
  if (child?.refId) return [child.refId];
  return [];
}

function descendantLeafRefIds(row, layoutRowsById, ancestors = new Set()) {
  if (!row || ancestors.has(row.id)) return [];
  const nextAncestors = new Set(ancestors);
  if (row.id) nextAncestors.add(row.id);
  const refs = [];
  for (const child of row.children || []) {
    const childIds = childRefIds(child);
    if (child?.refType !== "layout") {
      refs.push(...childIds);
      continue;
    }
    for (const layoutId of childIds) {
      const nested = layoutRowsById.get(layoutId);
      if (nested) {
        refs.push(...descendantLeafRefIds(nested, layoutRowsById, nextAncestors));
      } else {
        // Keep a missing layout id unresolved so form-rule validation does not
        // silently erase a source target when the layout graph is invalid.
        refs.push(layoutId);
      }
    }
  }
  return refs;
}

function addRef(map, key, value) {
  const normalized = normalizeRef(key);
  if (normalized && !map.has(normalized)) map.set(normalized, value);
}

function addMarkerRef(map, key, value) {
  const normalized = normalizeRef(key);
  if (!normalized) return;
  const existing = map.get(normalized);
  if (!existing) {
    map.set(normalized, value);
    return;
  }
  existing.rowIds = [...new Set([
    ...(existing.rowIds || [existing.rowId]).filter(Boolean),
    ...(value.rowIds || [value.rowId]).filter(Boolean)
  ])];
  existing.refIds = [...new Set([
    ...(existing.refIds || []),
    ...(value.refIds || [])
  ])];
}
