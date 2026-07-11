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
  for (const row of rows) {
    const sourceMarkers = Array.isArray(row?.sourceMarkers) ? row.sourceMarkers : [];
    if (!sourceMarkers.length) continue;
    const refIds = (row.children || []).flatMap((child) => childRefIds(child));
    for (const marker of sourceMarkers) {
      addRef(markerRefs, marker, {
        kind: "rowMarker",
        marker,
        rowId: row.id,
        refIds
      });
    }
  }

  return { fieldRefs, markerRefs };
}

export function resolveDirectRef(index, ref) {
  const normalized = normalizeRef(ref);
  if (!normalized) return undefined;
  if (index.fieldRefs.has(normalized)) return index.fieldRefs.get(normalized);
  if (normalized.includes(".")) {
    const tail = normalized.split(".").pop();
    if (index.fieldRefs.has(tail)) return index.fieldRefs.get(tail);
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

function addRef(map, key, value) {
  const normalized = normalizeRef(key);
  if (normalized && !map.has(normalized)) map.set(normalized, value);
}
