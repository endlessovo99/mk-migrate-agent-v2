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
export function detailTableNodeOperations({ editable, operations } = {}) {
  const operationState = operations || detailTableAuthorityOperationState(editable);
  if (operationState.canAddRow || operationState.canDeleteRow || operationState.canImport) {
    return [
      ...DETAIL_VIEW_OPERATIONS.map((operation) => ({
        ...operation,
        required: false,
        enable: operationState[operation.id] === true
      })),
      ...DETAIL_EDIT_OPERATIONS.map((operation) => ({
        ...operation,
        required: false,
        value: operation.id,
        enable: operationState[operation.id] === true
      }))
    ];
  }

  return [
    ...DETAIL_EDIT_OPERATIONS.map((operation) => ({
      ...operation,
      required: false,
      enable: operationState[operation.id] === true
    })),
    ...DETAIL_VIEW_OPERATIONS.map((operation) => ({
      ...operation,
      required: false,
      enable: operationState[operation.id] === true
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

/** Map detailTable field id → complete set of business column ids. */
export function buildDetailTableColumnIds(form = {}) {
  const index = new Map();
  for (const field of form.fields || []) {
    if (field?.type !== "detailTable") continue;
    index.set(
      field.id,
      new Set(
        (field.columns || [])
          .map((column) => String(column?.id || "").trim())
          .filter(Boolean)
      )
    );
  }
  return index;
}

/**
 * Derive canonical table-level authority from sparse detail-column overrides.
 * Unconfigured business columns inherit NewOA's default edit authority.
 */
export function deriveDetailTableAuthority(
  form = {},
  authorityFields = {},
  { mainTableName } = {}
) {
  const columnIndex = buildDetailColumnIndex(form);
  const completeColumnIds = buildDetailTableColumnIds(form);
  const grouped = new Map();

  for (const [fieldId, authority] of Object.entries(authorityFields || {})) {
    const detailFieldId = columnIndex.get(fieldId);
    if (!detailFieldId || !mainTableName) continue;
    const group = grouped.get(detailFieldId) || {
      configuredColumnIds: new Set(),
      authorities: []
    };
    group.configuredColumnIds.add(fieldId);
    group.authorities.push(authority);
    grouped.set(detailFieldId, group);
  }

  const derived = {};
  for (const [detailFieldId, group] of grouped.entries()) {
    const inheritsDefaultEdit =
      group.configuredColumnIds.size < (completeColumnIds.get(detailFieldId)?.size || 0);
    const editable = inheritsDefaultEdit ||
      group.authorities.some((authority) => authority?.editable === true);
    const visible = inheritsDefaultEdit || editable ||
      group.authorities.some((authority) => authority?.visible === true);
    const blocksDetailRowOperations = group.authorities.some((authority) =>
      authority?.editable === true && authority?.detailRowOperations === false
    );
    derived[physicalDetailTableName(mainTableName, detailFieldId)] = {
      visible,
      editable,
      required: false,
      operations: detailTableAuthorityOperationState(editable && !blocksDetailRowOperations)
    };
  }
  return derived;
}

export function deriveDetailColumnBindings(
  form = {},
  authorityFields = {},
  { mainTableName } = {}
) {
  if (!mainTableName) return {};
  const columnIndex = buildDetailColumnIndex(form);
  return Object.fromEntries(
    Object.keys(authorityFields || {}).flatMap((fieldId) => {
      const detailFieldId = columnIndex.get(fieldId);
      return detailFieldId
        ? [[fieldId, physicalDetailTableName(mainTableName, detailFieldId)]]
        : [];
    })
  );
}

export function detailTableAuthorityOperationState(editable) {
  return editable
    ? {
        canAddRow: true,
        canDeleteRow: true,
        canImport: true,
        canExport: false
      }
    : {
        canAddRow: false,
        canDeleteRow: false,
        canImport: false,
        canExport: true
      };
}

export function physicalDetailTableName(mainTableName, detailFieldId) {
  return detailTableNameFor(mainTableName, detailFieldId);
}

export function isPhysicalDetailTableAuthKey(key = "", detailTableNames) {
  const text = String(key);
  if (text.includes(".")) return false;
  if (detailTableNames instanceof Set) return detailTableNames.has(text);
  return /_d_[0-9a-f]{8}$/i.test(text);
}

export function authFieldIdFromKey(key = "") {
  const text = String(key || "");
  if (!text.includes(".")) return text;
  return text.slice(text.lastIndexOf(".") + 1);
}
