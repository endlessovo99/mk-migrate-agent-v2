export function applyFormPayload(template, dsl) {
  const next = clone(template);
  const form = dsl.form || {};
  next.mechanisms = next.mechanisms || {};
  next.mechanisms["sys-xform"] = next.mechanisms["sys-xform"] || {
    fdId: next.fdId,
    fdName: next.fdName,
    fdConfig: "{}"
  };

  const xform = next.mechanisms["sys-xform"];
  const config = parseJsonObject(xform.fdConfig || "{}");
  const summary = summarizeDslForm(form);

  config.id ||= xform.fdId || next.fdId;
  config.name ||= xform.fdName || next.fdName;
  config.entityName ||= "com.landray.km.review.core.entity.KmReviewTemplate";
  config.entityCode ||= "km-review";
  config.migrationDsl = {
    ...(config.migrationDsl || {}),
    form: summary
  };
  config.dataModel = buildDataModel(next, form);
  config.viewModel = buildViewModel(form);
  config.attribute = config.attribute || {};
  config.attribute.formAttr = JSON.stringify({
    ...(parseJsonObject(config.attribute.formAttr || "{}")),
    migrationDsl: {
      form: summary
    }
  });

  xform.fdConfig = JSON.stringify(config);
  xform.fdFormDefineType = 1;
  xform.fdStatus = "draft";
  xform.mechanisms = xform.mechanisms || {};

  return next;
}

export function summarizeFormFromTemplate(template) {
  const xform = template?.mechanisms?.["sys-xform"];
  const config = parseJsonObject(xform?.fdConfig || "{}");
  const mainModel = Array.isArray(config.dataModel)
    ? config.dataModel.find((model) => model?.fdType === "main") || config.dataModel[0]
    : undefined;
  const detailModelsByField = new Map(
    (Array.isArray(config.dataModel) ? config.dataModel : [])
      .filter((model) => model?.fdType === "detail")
      .map((model) => [model.dynamicProps?.detailFieldName, model])
      .filter(([fieldName]) => Boolean(fieldName))
  );
  const fields = (mainModel?.fdFields || []).map((field) => ({
    id: field.fdName,
    title: field.fdLabel,
    type: field.fdType,
    component: field.component,
    columns: (detailModelsByField.get(field.fdName)?.fdFields || []).map((column) => ({
      id: column.fdName,
      title: column.fdLabel,
      type: column.fdType,
      component: column.component
    }))
  }));
  const layoutRows = extractLayoutRows(config);

  return {
    fieldCount: fields.length,
    fields,
    detailTableCount: fields.filter((field) => field.type === "detailTable").length,
    layoutRowCount: layoutRows.length,
    layoutRows
  };
}

export function summarizeDslForm(form = {}) {
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const rows = Array.isArray(form.layout?.rows) ? form.layout.rows : [];

  return {
    fieldCount: fields.length,
    fields: fields.map((field) => ({
      id: field.id,
      title: field.title,
      type: field.type,
      component: field.mk?.component,
      columns: Array.isArray(field.columns)
        ? field.columns.map((column) => ({
            id: column.id,
            title: column.title,
            type: column.type,
            component: column.mk?.component
          }))
        : []
    })),
    detailTableCount: fields.filter((field) => field.type === "detailTable").length,
    layoutRowCount: rows.length,
    layoutRows: rows.map((row) => ({
      id: row.id,
      fields: (row.cells || []).flatMap((cell) => cellFieldIds(cell)),
      cells: (row.cells || []).map((cell) => ({
        fieldId: cell.fieldId || cellFieldIds(cell)[0],
        fieldIds: cellFieldIds(cell),
        column: cell.column,
        colspan: cell.colspan
      }))
    }))
  };
}

function buildDataModel(template, form) {
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const mainFields = fields.map((field) => fieldToDataField(field));
  const detailModels = fields
    .filter((field) => field.type === "detailTable")
    .map((field) => ({
      fdName: field.title,
      fdType: "detail",
      fdTableName: tableNameFor(field.id),
      dynamicProps: {
        detailFieldName: field.id
      },
      fdFields: (field.columns || []).map((column) => fieldToDataField(column))
    }));

  return [
    {
      fdName: template.fdName || "NewOA Migration Template",
      fdType: "main",
      fdTableName: template.fdTableName || tableNameFor(template.fdId || "main"),
      fdFields: mainFields
    },
    ...detailModels
  ];
}

function buildViewModel(form) {
  const rows = Array.isArray(form.layout?.rows) ? form.layout.rows : [];
  return [{
    fdName: "默认视图",
    fdConfig: JSON.stringify({
      view: {
        render: {
          desktop: {
            children: rows.map((row) => ({
              id: row.id,
              cells: normalizeLayoutCells(row.cells || [])
            }))
          },
          mobile: {
            children: rows.map((row) => ({
              id: row.id,
              cells: normalizeLayoutCells(row.cells || [])
            }))
          }
        }
      }
    })
  }];
}

function extractLayoutRows(config) {
  const scene = Array.isArray(config.viewModel) ? config.viewModel[0] : undefined;
  const sceneConfig = parseJsonObject(scene?.fdConfig || "{}");
  const rows = sceneConfig.view?.render?.desktop?.children || [];
  return rows.map((row) => ({
    id: row.id,
    fields: (row.cells || []).flatMap((cell) => cellFieldIds(cell)),
    cells: (row.cells || []).map((cell) => ({
      fieldId: cell.fieldId || cellFieldIds(cell)[0],
      fieldIds: cellFieldIds(cell),
      column: cell.column,
      colspan: cell.colspan
    }))
  }));
}

function normalizeLayoutCells(cells) {
  return cells.map((cell) => ({
    ...cell,
    fieldId: cell.fieldId || cellFieldIds(cell)[0],
    fieldIds: cellFieldIds(cell)
  }));
}

function cellFieldIds(cell) {
  if (Array.isArray(cell.fieldIds) && cell.fieldIds.length) return cell.fieldIds;
  return cell.fieldId ? [cell.fieldId] : [];
}

function fieldToDataField(field) {
  return {
    fdName: field.id,
    fdLabel: field.title,
    fdType: field.type,
    fdDataType: dataTypeFor(field),
    fdRequired: field.required === true,
    component: field.mk?.component,
    options: field.options || []
  };
}

function dataTypeFor(field) {
  if (field.type === "number") return "decimal";
  if (field.type === "date" || field.type === "dateTime") return "timestamp";
  if (field.type === "detailTable") return "json";
  return "varchar";
}

function tableNameFor(value) {
  return `mk_${String(value || "table").replace(/[^\w]+/g, "_").slice(0, 48)}`;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}
