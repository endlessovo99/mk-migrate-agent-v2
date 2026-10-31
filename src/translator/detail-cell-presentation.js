import { sourceDetailCellCandidates } from "../dsl/source-detail-cell-layout.js";

export function applyDetailCellPresentation(sourceForm, form) {
  const candidates = sourceDetailCellCandidates(sourceForm, form);
  if (!candidates.length) return form;
  return { ...form, fields: (form.fields || []).map(field => {
    const groups = candidates.filter(candidate => candidate.tableRef === field.sourceRef).map(candidate => candidate.group);
    return groups.length ? { ...field, detailCellGroups: groups } : field;
  }) };
}
