import { detailTableNameFor } from "./detail-table-names.js";

const DETAIL_EDIT_OPERATIONS = Object.freeze([
  {
    id: "canAddRow",
    label: "添加行",
    messageKey: "sys-xform:detail.operation.addRow",
    showType: "edit",
    type: "operation"
  },
  {
    id: "canDeleteRow",
    label: "删除行",
    messageKey: "sys-xform:detail.operation.deleteRow",
    showType: "edit",
    type: "operation"
  },
  {
    id: "canImport",
    label: "导入",
    messageKey: "sys-xform:detail.operation.import",
    showType: "edit",
    type: "operation"
  }
]);

const DETAIL_VIEW_OPERATIONS = Object.freeze([
  {
    id: "canExport",
    label: "导出",
    messageKey: "sys-xform:detail.operation.export",
    showType: "onlyView",
    type: "view"
  }
]);

export function detailTableEditOperations() {
  return DETAIL_EDIT_OPERATIONS.map((operation) => ({ ...operation }));
}

export function detailTableViewOperations() {
  return DETAIL_VIEW_OPERATIONS.map((operation) => ({ ...operation }));
}

/** Operations string used by lbpm fdTemplateFormAuths table-level entries. */
export function detailTableNodeOperations({ editable } = {}) {
  if (editable) {
    return [
      ...DETAIL_VIEW_OPERATIONS.map((operation) => ({
        ...operation,
        required: false,
        enable: false
      })),
      ...DETAIL_EDIT_OPERATIONS.map((operation) => ({
        ...operation,
        required: false,
        value: operation.id,
        enable: true
      }))
    ];
  }

  return [
    ...DETAIL_EDIT_OPERATIONS.map((operation) => ({
      ...operation,
      required: false,
      enable: false
    })),
    ...DETAIL_VIEW_OPERATIONS.map((operation) => ({
      ...operation,
      required: false,
      enable: true
    }))
  ];
}

/** Map detail column field id → parent detailTable field id. */
export function buildDetailColumnIndex(form = {}) {
  const index = new Map();
  for (const field of form.fields || []) {
    if (field?.type !== "detailTable") continue;
    for (const column of field.columns || []) {
      const columnId = String(column?.id || "").trim();
      if (!columnId) continue;
      index.set(columnId, field.id);
    }
  }
  return index;
}

export function physicalDetailTableName(mainTableName, detailFieldId) {
  return detailTableNameFor(mainTableName, detailFieldId);
}

export function isPhysicalDetailTableAuthKey(key = "") {
  return !String(key).includes(".") && /_d_[0-9a-f]{8}$/i.test(String(key));
}

export function authFieldIdFromKey(key = "") {
  const text = String(key || "");
  if (!text.includes(".")) return text;
  return text.slice(text.lastIndexOf(".") + 1);
}
