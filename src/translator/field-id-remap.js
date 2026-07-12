import { createHash } from "node:crypto";

export const MK_FIELD_ID_MAX_LENGTH = 25;

// Detail-table system columns written by NewOA/MK form persistence. User columns that
// collide with these names are dropped or overwritten on write, so remap them first.
const RESERVED_DETAIL_COLUMN_IDS = new Set([
  "fd_id",
  "fd_main_id",
  "fd_order"
]);

export function buildFieldIdMap(form = {}) {
  const used = new Set();
  const originals = [];

  for (const field of form.fields || []) {
    if (field?.id) originals.push({ id: field.id, detailColumn: false });
    for (const column of field?.columns || []) {
      if (column?.id) originals.push({ id: column.id, detailColumn: true });
    }
  }

  for (const entry of originals) {
    if (
      entry.id.length <= MK_FIELD_ID_MAX_LENGTH &&
      !(entry.detailColumn && RESERVED_DETAIL_COLUMN_IDS.has(entry.id))
    ) {
      used.add(entry.id);
    }
  }

  const idMap = new Map();
  for (const entry of originals) {
    const { id, detailColumn } = entry;
    const reservedCollision = detailColumn && RESERVED_DETAIL_COLUMN_IDS.has(id);
    if ((!reservedCollision && id.length <= MK_FIELD_ID_MAX_LENGTH) || idMap.has(id)) continue;
    const shortId = allocateShortFieldId(id, used);
    used.add(shortId);
    idMap.set(id, shortId);
  }
  return idMap;
}

export function applyFieldIdMapToForm(form, idMap) {
  if (!idMap?.size) return form;
  return {
    ...form,
    fields: (form.fields || []).map((field) => remapFieldLike(field, idMap)),
    layout: remapLayout(form.layout, idMap)
  };
}

export function applyFieldIdMapToSourceFormRules(sourceFormRules, idMap) {
  if (!idMap?.size || !sourceFormRules) return sourceFormRules;
  const linkage = Array.isArray(sourceFormRules.linkage) ? sourceFormRules.linkage : [];
  return {
    ...sourceFormRules,
    linkage: linkage.map((rule) => ({
      ...rule,
      source: mapFieldId(rule.source, idMap),
      when: Array.isArray(rule.when)
        ? rule.when.map((condition) => ({
            ...condition,
            field: mapFieldId(condition.field, idMap)
          }))
        : rule.when,
      effects: remapEffectTargets(rule.effects, idMap),
      else: remapEffectTargets(rule.else, idMap)
    }))
  };
}

export function applyFieldIdMapToScripts(scripts, idMap) {
  if (!idMap?.size || !scripts) return scripts;
  const actions = Array.isArray(scripts.actions) ? scripts.actions : [];
  return {
    ...scripts,
    actions: actions.map((action) => ({
      ...action,
      controlId: mapFieldId(action.controlId, idMap),
      tableId: mapFieldId(action.tableId, idMap),
      function: replaceFieldIdsInText(action.function, idMap),
      coverage: remapCoverage(action.coverage, idMap),
      recipe: remapStructuredValue(action.recipe, idMap)
    }))
  };
}

export function applyFieldIdMapToWorkflow(workflow, idMap) {
  if (!idMap?.size || !workflow) return workflow;
  return {
    ...workflow,
    nodes: (workflow.nodes || []).map((node) => ({
      ...node,
      dataAuthority: remapDataAuthority(node.dataAuthority, idMap),
      participants: remapParticipants(node.participants, idMap),
      subProcess: remapStructuredValue(node.subProcess, idMap)
    }))
  };
}

function remapStructuredValue(value, idMap) {
  if (value === undefined) return undefined;
  return JSON.parse(replaceFieldIdsInText(JSON.stringify(value), idMap));
}

function allocateShortFieldId(originalId, used) {
  let shortId = `fd_${createHash("sha256").update(originalId).digest("hex").slice(0, 22)}`;
  let attempt = 0;
  while (used.has(shortId)) {
    attempt += 1;
    const suffix = String(attempt);
    const hashLen = Math.max(1, 22 - suffix.length);
    shortId = `fd_${createHash("sha256").update(`${originalId}:${attempt}`).digest("hex").slice(0, hashLen)}${suffix}`;
  }
  return shortId;
}

function remapFieldLike(field, idMap) {
  const nextId = mapFieldId(field.id, idMap);
  return {
    ...field,
    id: nextId,
    sourceProps: nextId === field.id
      ? field.sourceProps
      : {
          ...(field.sourceProps || {}),
          originalId: field.id
        },
    columns: Array.isArray(field.columns)
      ? field.columns.map((column) => remapFieldLike(column, idMap))
      : field.columns
  };
}

function remapLayout(layout, idMap) {
  if (!layout || typeof layout !== "object") return layout;
  return {
    ...layout,
    mkTree: Array.isArray(layout.mkTree)
      ? layout.mkTree.map((row) => ({
          ...row,
          children: Array.isArray(row.children)
            ? row.children.map((child) => ({
                ...child,
                refIds: Array.isArray(child.refIds)
                  ? child.refIds.map((refId) => mapFieldId(refId, idMap))
                  : child.refIds
              }))
            : row.children
        }))
      : layout.mkTree,
    sourceGrid: remapSourceGrid(layout.sourceGrid, idMap)
  };
}

function remapSourceGrid(sourceGrid, idMap) {
  if (!sourceGrid || typeof sourceGrid !== "object") return sourceGrid;
  const rows = Array.isArray(sourceGrid.rows) ? sourceGrid.rows : [];
  return {
    ...sourceGrid,
    rows: rows.map((row) => ({
      ...row,
      cells: Array.isArray(row.cells)
        ? row.cells.map((cell) => ({
            ...cell,
            references: Array.isArray(cell.references)
              ? cell.references.map((reference) => ({
                  ...reference,
                  referenceId: mapFieldId(reference.referenceId, idMap)
                }))
              : cell.references
          }))
        : row.cells
    }))
  };
}

function remapEffectTargets(effects, idMap) {
  if (!Array.isArray(effects)) return effects;
  return effects.map((effect) => ({
    ...effect,
    target: mapEffectTarget(effect.target, idMap)
  }));
}

function mapEffectTarget(target, idMap) {
  if (typeof target !== "string" || !target) return target;
  if (idMap.has(target)) return idMap.get(target);
  // Keep row markers and multi-target expressions intact except exact field-id tokens.
  return replaceFieldIdsInText(target, idMap);
}

function remapCoverage(coverage, idMap) {
  if (!coverage || typeof coverage !== "object") return coverage;
  return {
    ...coverage,
    staticProps: Array.isArray(coverage.staticProps)
      ? coverage.staticProps.map((entry) => ({
          ...entry,
          fieldId: mapFieldId(entry.fieldId, idMap)
        }))
      : coverage.staticProps
  };
}

function remapDataAuthority(dataAuthority, idMap) {
  if (!dataAuthority || typeof dataAuthority !== "object") return dataAuthority;
  const fields = Object.fromEntries(
    Object.entries(dataAuthority.fields || {}).map(([fieldId, value]) => [mapFieldId(fieldId, idMap), value])
  );
  return {
    ...dataAuthority,
    fields
  };
}

function remapParticipants(participants, idMap) {
  if (!participants || typeof participants !== "object") return participants;
  if (!participants.fieldId) return participants;
  return {
    ...participants,
    fieldId: mapFieldId(participants.fieldId, idMap)
  };
}

function mapFieldId(id, idMap) {
  if (typeof id !== "string" || !id) return id;
  return idMap.get(id) || id;
}

function replaceFieldIdsInText(text, idMap) {
  if (typeof text !== "string" || !text || !idMap.size) return text;
  let next = text;
  // Replace longer ids first so prefixes do not clobber longer names.
  const originals = [...idMap.keys()].sort((left, right) => right.length - left.length);
  for (const original of originals) {
    const shortId = idMap.get(original);
    next = next.replace(new RegExp(`\\b${escapeRegExp(original)}\\b`, "g"), shortId);
  }
  return next;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
