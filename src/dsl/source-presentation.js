import { contentFlowIssues, mergeContentFlowReferences, remapContentFlow, selectContentFlow } from "./content-flow.js";

/** Compare source presentation facts directly, independently of the mapper. */
export function sourcePresentationIssues(sourceForm = {}, targetForm = {}, {
  dataOnlySourceRefs = new Set(), presentationReferenceMap = new Map()
} = {}) {
  const issues = [];
  const sourceMainFields = [...(sourceForm.controls || []), ...(sourceForm.dataFields || []), ...(sourceForm.detailTables || [])];
  const targetMainFields = targetForm.fields || [];
  const sourceById = new Map(sourceMainFields.map((field) => [field.id, field]));
  const targetBySourceId = new Map(sourceMainFields.map((field) => [field.id, targetForSource(field, targetMainFields)]));
  const cells = (targetForm.layout?.mkTree || []).flatMap((node) => node.children || []);
  const rendered = new Set(cells.filter((cell) => cell.refType === "field").flatMap((cell) => cell.refIds || []));
  const renderedTables = new Set(cells.filter((cell) => cell.refType === "detailTable").flatMap((cell) => cell.refIds || []));
  const consumedUnits = new Set();
  const add = (reason, details) => issues.push({ reason, ...details });
  const sourceIsDataOnly = (source) => source?.dataOnly === true || source?.sourceProps?.hardHidden === true ||
    (sourceForm.dataFields || []).includes(source);
  // The caller may grant only non-rendered exceptions rebuilt from the source.
  // Target annotations never authorize dropping visible source content.
  const mayOmit = (source, target) => sourceIsDataOnly(source) ||
    (source?.sourceRef && dataOnlySourceRefs.has(source.sourceRef) && isNonRendered(target));
  const scopes = [{ sourceFields: sourceMainFields, targetFields: targetMainFields }];
  for (const table of sourceForm.detailTables || []) {
    const targetTable = targetForSource(table, targetMainFields);
    scopes.push({ sourceFields: table.columns || [], targetFields: targetTable?.columns || [], tableId: targetTable?.id });
  }

  for (const scope of scopes) for (const source of scope.sourceFields) {
    const target = targetForSource(source, scope.targetFields);
    if (!target || mayOmit(source, target)) continue;
    if (isNonRendered(target)) {
      add("visibility", { fieldId: target.id, sourceId: source.id, sourceRef: source.sourceRef });
      continue;
    }
    if (source.sourceProps?.layoutCell?.hiddenLabel === true && target.type !== "description" &&
      target.props?.hiddenLabel !== true) {
      add("hidden_label", { fieldId: target.id, sourceId: source.id, sourceRef: source.sourceRef });
    }
    const unit = source.sourceProps?.inlineUnit;
    if (!unit?.id || !unit?.content) continue;
    const expectedUnit = normalizedUnit(unit.content);
    const nativeUnit = target.props?.unit;
    const sourceUnit = scope.sourceFields.find((field) => field.id === unit.id);
    const text = sourceUnit ? targetForSource(sourceUnit, scope.targetFields) : undefined;
    const textIsRendered = text && !isNonRendered(text) &&
      (scope.tableId ? renderedTables.has(scope.tableId) : rendered.has(text.id));
    if (nativeUnit !== undefined && normalizedUnit(nativeUnit) !== expectedUnit) {
      add("unit", { fieldId: target.id, sourceUnitId: unit.id, expected: expectedUnit, actual: nativeUnit });
    }
    if (nativeUnit !== undefined && normalizedUnit(nativeUnit) === expectedUnit) {
      if (!scope.tableId) consumedUnits.add(unit.id);
      if (textIsRendered) {
        add("duplicate_unit", { fieldId: target.id, sourceUnitId: unit.id });
      }
    } else {
      if (!text || text.componentId !== "xform-description" || normalizedUnit(text.props?.content) !== expectedUnit || !textIsRendered) {
        add("unit", { fieldId: target.id, sourceUnitId: unit.id, expected: expectedUnit });
      }
    }
  }

  for (const row of sourceForm.layout?.rows || []) {
    for (const cell of row.cells || []) {
      if (!cell.contentFlow) continue;
      const sourceIds = (cell.references || []).filter((ref) => ref.referenceType !== "layout").map((ref) => ref.referenceId);
      if (contentFlowIssues(cell.contentFlow, sourceIds).length) {
        add("source_flow_invalid", { sourceCellId: cell.id });
        continue;
      }
      const sourceFlow = mergeContentFlowReferences(cell.contentFlow, presentationReferenceMap);
      const retained = sourceFlow.lines.flat().filter((id) => !consumedUnits.has(id) && !mayOmit(sourceById.get(id), targetBySourceId.get(id)));
      if (!retained.length) continue;
      if (retained.some((id) => !targetBySourceId.get(id))) {
        add("missing_field", { sourceCellId: cell.id, sourceIds: retained.filter((id) => !targetBySourceId.get(id)) });
        continue;
      }
      // Detail tables have their own exclusive-cell contract, not a field flow.
      if (retained.some((id) => targetBySourceId.get(id)?.type === "detailTable")) continue;
      const expected = remapContentFlow(selectContentFlow(sourceFlow, retained),
        (id) => targetBySourceId.get(id).id);
      const candidates = cells.filter((target) => target.refType === "field" &&
        (target.sourceRef === cell.sourceRef || target.refIds?.some((id) => expected.lines.flat().includes(id))));
      if (!candidates.some((target) => canonicalJson(target.contentFlow) === canonicalJson(expected))) {
        add("content_flow", { sourceCellId: cell.id, sourceRef: cell.sourceRef });
      }
    }
  }
  return issues;
}

function isNonRendered(field) {
  return field?.dataOnly === true || field?.componentId === "xform-hidden";
}

function targetForSource(source, fields) {
  const candidates = source.sourceRef
    ? fields.filter((field) => field.sourceRef === source.sourceRef)
    : fields.filter((field) => (field.sourceProps?.originalId || field.id) === source.id);
  return candidates.find((field) => (field.sourceProps?.originalId || field.id) === source.id) ||
    (candidates.length === 1 ? candidates[0] : undefined);
}

function normalizedUnit(value) {
  return typeof value === "string" ? value.trim() : value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonicalValue));
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}
