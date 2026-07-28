function fieldAliases(field) {
  return [field?.id, field?.sourceProps?.originalId].filter(Boolean);
}

export function legacyControlAliases(field) {
  const aliases = fieldAliases(field);
  return [...new Set([
    ...aliases,
    ...aliases
      .filter((alias) => /^fd_[A-Za-z0-9_]+$/.test(alias))
      .map((alias) => alias.slice(1))
  ])];
}

/**
 * Resolve an unqualified legacy control id only when it identifies one detail
 * column and does not also identify a main-form control or detail table.
 */
export function inspectLegacyDetailControlTarget(form = {}, controlId) {
  if (!controlId) return { status: "not_detail" };
  const controlIds = new Set([
    controlId,
    ...(/^d_[A-Za-z0-9_]+$/.test(controlId)
      ? [`f${controlId}`]
      : [])
  ]);
  const detailMatches = [];
  const nonDetailMatches = [];

  for (const field of form.fields || []) {
    if (field?.type !== "detailTable") {
      if (legacyControlAliases(field).some((alias) => controlIds.has(alias))) {
        nonDetailMatches.push(field);
      }
      continue;
    }
    if (legacyControlAliases(field).some((alias) => controlIds.has(alias))) {
      nonDetailMatches.push(field);
    }
    for (const column of field.columns || []) {
      if (legacyControlAliases(column).some((alias) => controlIds.has(alias))) {
        detailMatches.push({ table: field, column });
      }
    }
  }

  if (!detailMatches.length) return { status: "not_detail" };
  if (detailMatches.length !== 1 || nonDetailMatches.length) {
    return {
      status: "ambiguous",
      controlId,
      detailMatches,
      nonDetailMatches
    };
  }
  return {
    status: "resolved",
    controlId,
    ...detailMatches[0]
  };
}

export function qualifyUniqueLegacyDetailControlTarget(action, form = {}) {
  if (!action || action.scope !== "control" || action.tableId) return action;
  const target = inspectLegacyDetailControlTarget(form, action.controlId);
  if (target.status !== "resolved") return action;
  return {
    ...action,
    tableId: target.table.id,
    controlId: target.column.id
  };
}
