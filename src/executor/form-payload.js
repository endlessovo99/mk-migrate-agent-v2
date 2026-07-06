import {
  buildNativeFormRuleConfig,
  mergeNativeFormRules,
  summarizeNativeFormRuleConfig
} from "./form-rules.js";

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
  const summary = summarizeDslForm(form, dsl.formRules);
  const mainModel = buildMainModel(next, xform, config, form);
  const detailModels = buildDetailModels(next, form);
  const dataModels = [mainModel, ...detailModels];
  const detailModelsByField = new Map(
    detailModels.map((model) => [model.dynamicProps?.detailFieldName, model]).filter(([fieldId]) => Boolean(fieldId))
  );

  const fieldAuth = buildFieldAuth(mainModel, detailModels, form);
  const existingFormAttr = parseJsonObject(config.attribute?.formAttr || "{}");
  const controlAction = buildControlAction(existingFormAttr.controlAction, dsl.scripts);
  const nativeFormRules = buildNativeFormRuleConfig(dsl.formRules, form, dataModels);
  const formAttr = {
    subjectRule: {
      script: "${data.biz.fdSubject}",
      type: "Eval",
      vo: { content: "$标题$", mode: "formula" }
    },
    formRule: mergeNativeFormRules(existingFormAttr.formRule || { pattern: {} }, nativeFormRules),
    dataUnique: existingFormAttr.dataUnique || {},
    controlAction,
    currentTableName: mainModel.fdTableName,
    migrationDsl: {
      form: summary,
      scripts: summarizeDslScripts(dsl.scripts),
      formRules: nativeFormRules.summary
    }
  };

  const nextConfig = {
    authFilter: config.authFilter || { detailAuthDefine: {} },
    auth: buildAuth(mainModel.fdTableName, fieldAuth),
    attribute: {
      ...(config.attribute || {}),
      formAttr: JSON.stringify(formAttr)
    },
    dataModel: dataModels,
    viewModel: [buildViewModel(config, next, mainModel, form, detailModelsByField)],
    lang: config.lang || "{}",
    extendMap: {
      ...(config.extendMap || {}),
      dataModelError: JSON.stringify({ errors: [] })
    },
    sign: config.sign || { formula: {} },
    error: config.error || "{}",
    migrationDsl: {
      ...(config.migrationDsl || {}),
      form: summary,
      scripts: summarizeDslScripts(dsl.scripts),
      formRules: nativeFormRules.summary
    }
  };

  xform.fdConfig = JSON.stringify(nextConfig);
  xform.fdFormDefineType = 1;
  xform.fdStatus = "draft";
  xform.mechanisms = xform.mechanisms || {};

  return next;
}

export function summarizeFormFromTemplate(template) {
  const xform = template?.mechanisms?.["sys-xform"];
  const config = parseJsonObject(xform?.fdConfig || "{}");
  const models = Array.isArray(config.dataModel) ? config.dataModel : [];
  const mainModel = models.find((model) => model?.fdType === "main") || models[0];
  const detailModels = models.filter((model) => model?.fdType === "detail");
  const detailFields = detailModels.map((model) => detailModelToSummaryField(model));
  const fields = [
    ...((mainModel?.fdFields || []).filter((field) => !field.fdIsSystem).map(dataFieldToSummaryField)),
    ...detailFields
  ];
  const layoutRows = extractLayoutRows(config, detailModels);

  const formAttr = parseJsonObject(config.attribute?.formAttr || "{}");

  return {
    fieldCount: fields.length,
    fields,
    detailTableCount: detailFields.length,
    layoutRowCount: layoutRows.length,
    layoutRows,
    scripts: summarizeScriptsFromConfig(config),
    formRules: summarizeNativeFormRuleConfig(formAttr.formRule || {})
  };
}

export function summarizeDslForm(form = {}, formRules = {}) {
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const rows = Array.isArray(form.layout?.mkTree) ? form.layout.mkTree : [];
  const sourceRules = Array.isArray(formRules?.linkage) ? formRules.linkage : [];
  const branchRuleCount = (type) => sourceRules.reduce((count, rule) => {
    const branches = [rule.effects, rule.else].filter(Array.isArray);
    return count + branches.filter((effects) => effects.some((effect) => effect?.type === type)).length;
  }, 0);

  return {
    fieldCount: fields.length,
    fields: fields.map((field) => ({
      id: field.id,
      title: field.title,
      type: field.type,
      component: field.componentId,
      columns: Array.isArray(field.columns)
        ? field.columns.map((column) => ({
            id: column.id,
            title: column.title,
            type: column.type,
            component: column.componentId
          }))
        : []
    })),
    detailTableCount: fields.filter((field) => field.type === "detailTable").length,
    layoutRowCount: rows.length,
    layoutRows: rows.map((row) => ({
      id: row.id,
      componentId: row.componentId,
      fields: (row.children || []).flatMap((cell) => childRefIds(cell)),
      cells: (row.children || []).map((cell) => ({
        fieldId: childRefIds(cell)[0],
        fieldIds: childRefIds(cell),
        column: cell.column,
        colspan: cell.colspan
      }))
    })),
    formRules: {
      sourceRuleCount: sourceRules.length,
      displayRuleCount: branchRuleCount("visible"),
      requireRuleCount: branchRuleCount("required")
    }
  };
}

function summarizeDslScripts(scripts = {}) {
  const actions = Array.isArray(scripts.actions) ? scripts.actions : [];
  return {
    actionCount: actions.length,
    events: actions.map((action) => action.event || action.name).filter(Boolean),
    translationStatuses: actions.map((action) => action.translationStatus).filter(Boolean)
  };
}

function summarizeScriptsFromConfig(config = {}) {
  const formAttr = parseJsonObject(config.attribute?.formAttr || "{}");
  const controlAction = formAttr.controlAction || {};
  const global = controlAction.global || {};
  const events = Object.keys(global).filter((event) => Array.isArray(global[event]) && global[event].length);
  return {
    actionCount: events.reduce((count, event) => count + global[event].length, 0),
    events,
    javascriptLength: typeof controlAction.javascript === "string" ? controlAction.javascript.length : 0
  };
}

function buildControlAction(existing, scripts = {}) {
  const next = {
    control: existing?.control || {},
    global: existing?.global || {}
  };
  const actions = Array.isArray(scripts.actions) ? scripts.actions : [];

  if (!actions.length) {
    if (existing?.javascript) next.javascript = existing.javascript;
    return next;
  }

  const grouped = new Map();
  for (const action of actions) {
    const event = action.event || action.name;
    if (!event || typeof action.function !== "string" || !action.function.trim()) continue;
    if (!grouped.has(event)) grouped.set(event, []);
    grouped.get(event).push({
      name: action.name || event,
      function: action.function,
      id: action.id || stableHexId(`${event}:${action.function}`).slice(0, 18)
    });
  }

  for (const [event, eventActions] of grouped) {
    next.global[event] = eventActions;
  }

  next.javascript = actions
    .map((action) => action.function)
    .filter((fn) => typeof fn === "string" && fn.trim())
    .join("\n\n");
  return next;
}

function buildMainModel(template, xform, config, form) {
  const existing = (Array.isArray(config.dataModel) ? config.dataModel : []).find((model) => model?.fdType === "main") || {};
  const main = {
    ...clone(existing),
    fdId: template.fdId,
    fdName: template.fdName || "NewOA Migration Template",
    fdTableName: xform.fdTableName || template.fdTableName || existing.fdTableName || tableNameFor(template.fdId || "main"),
    fdType: "main",
    dynamicProps: existing.dynamicProps || {},
    fdXForm: { fdId: template.fdId, fdName: template.fdName },
    fdOuterMapping: false,
    needDelete: false,
    deletePhysicalTable: false
  };
  main.fdTableNameAlias = main.fdTableName;

  const systemFields = (existing.fdFields || []).filter((field) => field.fdIsSystem);
  const normalFields = (form.fields || []).filter((field) => field.type !== "detailTable");
  main.fdFields = [
    ...systemFields,
    ...normalFields.map((field, index) => canonicalField(field, template, main, systemFields.length + index + 1, "main"))
  ];
  return main;
}

function buildDetailModels(template, form) {
  return (form.fields || [])
    .filter((field) => field.type === "detailTable")
    .map((field) => {
      const tableName = tableNameFor(field.id);
      const model = {
        fdId: stableHexId(`${template.fdId}:detail:${field.id}`),
        dynamicProps: { detailFieldName: field.id },
        fdName: field.title,
        fdTableName: tableName,
        fdTableNameAlias: tableName,
        fdType: "detail",
        fdFields: [],
        fdXForm: { fdId: template.fdId, fdName: template.fdName },
        fdOuterMapping: false,
        needDelete: false,
        deletePhysicalTable: false,
        fdFontExtendData: "{\"passValue\":false}"
      };
      model.fdFields = [
        ...(field.columns || []).map((column, index) => canonicalField(column, template, model, index + 1, "detail")),
        ...detailSystemFields(model)
      ];
      model.fdAttribute = JSON.stringify(detailModelAttribute(field, model));
      return model;
    });
}

function canonicalField(field, template, model, order, tableType) {
  const spec = componentSpec(field);
  const fdLength = fieldLengthFromDsl(field, spec);
  return {
    fdId: stableHexId(`${template.fdId}:${model.fdTableName}:${field.id}:${order}`),
    fdLabel: field.title,
    fdName: field.id,
    fdColumn: `fd_${field.id}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48),
    fdType: spec.fdType,
    fdAttribute: JSON.stringify(fieldAttribute(field, model.fdTableName, tableType, spec)),
    fdFontExtendData: "{}",
    fdDataType: spec.fdDataType,
    fdDictType: spec.fdDictType,
    ...(fdLength !== undefined ? { fdLength } : {}),
    fdIsStored: true,
    fdIsIndex: false,
    fdIsSystem: false,
    fdIsDataTask: false,
    fdDisplay: true,
    fdOuterMapping: false,
    fdState: "notEffective",
    fdDataModel: { fdId: model.fdId, fdName: model.fdName },
    fdMechanismType: tableType === "detail" ? "KmReviewDetail" : "SYS-XFORM",
    fdOrder: order
  };
}

function fieldLengthFromDsl(field, spec) {
  if (spec.attrType === "textarea") {
    return textareaMaxLengthFromDsl(field);
  }
  return 200;
}

function fieldAttribute(field, tableName, tableType, spec) {
  const controlId = `${spec.desktop}~${stableShortId(field.id)}`;
  const controlProps = {
    id: controlId,
    desktop: { type: spec.desktop },
    mobile: { type: spec.mobile },
    name: field.id,
    uuid: field.id,
    title: field.title,
    span: 24,
    "$$tableType": tableType,
    "$$tableName": tableName
  };

  if (field.props?.required) controlProps.required = true;
  if (field.props?.options?.length) {
    controlProps.options = field.props.options.map((option) => ({
      label: option.label ?? option.text ?? option.value,
      value: option.value ?? option.label ?? option.text
    }));
  }
  if (spec.attrType === "select") {
    controlProps.multi = field.componentId === "xform-select~multi";
  }
  if (spec.attrType === "attachment") {
    Object.assign(controlProps, {
      showText: false,
      maxCount: 0,
      singleMaxSize: 5242880,
      itemDisplayConfig: ["showCreated", "showCreator", "showOrder", "showSize"],
      maxLength: 200,
      anonymous: false
    });
  }
  if (spec.attrType === "textarea") {
    Object.assign(controlProps, { placeholder: "请输入" });
    const maxLength = textareaMaxLengthFromDsl(field);
    if (maxLength !== undefined) {
      controlProps.maxLength = maxLength;
    }
    const height = textareaHeightFromDsl(field);
    if (height !== undefined) {
      controlProps.height = height;
    }
  }
  if (spec.attrType === "timestamp") {
    Object.assign(controlProps, { placeholder: "请选择", displayPattern: "yyyy-MM-dd HH:mm" });
  }
  if (spec.attrType === "address") {
    controlProps.org = { types: ["ORG_TYPE_PERSON", "ORG_TYPE_DEPT"] };
  }

  return {
    uuid: field.id,
    config: {
      key: controlId,
      type: spec.attrType,
      controlProps,
      kind: "control",
      label: field.title,
      labelProps: { desktop: {}, title: field.title, mobile: {} }
    },
    env: ["xform"]
  };
}

function textareaHeightFromDsl(field) {
  return normalizeHeight(field.props?.height);
}

function textareaMaxLengthFromDsl(field) {
  return normalizeMaxLength(field.props?.maxLength);
}

function normalizeMaxLength(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (!/^\d+$/.test(text)) return undefined;
  const length = Number(text);
  return Number.isSafeInteger(length) && length > 0 ? length : undefined;
}

function normalizeHeight(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  const styleHeight = text.match(/(?:^|;)\s*height\s*:\s*([^;]+)/i)?.[1]?.trim();
  if (styleHeight) return normalizeHeight(styleHeight);
  const numericHeight = text.match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  if (numericHeight) return Number(numericHeight[1]);
  return text;
}

function detailModelAttribute(field, model) {
  const controlId = `@elem/xform-detail-table~${stableShortId(field.id)}`;
  return {
    uuid: model.fdTableName,
    config: {
      key: controlId,
      type: "detail",
      controlProps: {
        passValue: false,
        mode: "table",
        defaultRowNumber: 1,
        showNumber: true,
        showFieldName: true,
        showRowSelection: true,
        showTopActionBar: true,
        pcSetting: ["pagination"],
        defaultPageSize: 10,
        detailAlign: [
          { key: "alignItems", value: "left" },
          { key: "alignHeader", value: "left" }
        ],
        mobileRender: ["simple"],
        alignTitle: "left",
        nest: false,
        id: controlId,
        desktop: { type: "@elem/xform-detail-table" },
        mobile: { type: "@elem/xform-m-detail-table" },
        name: model.fdTableName,
        uuid: model.fdTableName,
        title: field.title,
        "$$detailTableFieldName": field.id,
        "$$tableType": "detail",
        "$$tableName": model.fdTableName,
        canChangeSpan: false,
        pcNestSetting: ["toggle"],
        printLayoutType: "table"
      },
      kind: "container",
      label: field.title,
      labelProps: { desktop: {}, mobile: {} }
    }
  };
}

function detailSystemFields(model) {
  return [
    systemDetailField(model, "fd_id", "主键ID", "SYS-XFORM.fd_id", "varchar", false),
    systemDetailField(model, "fd_main_id", "主文档ID", "SYS-XFORM.fd_main_id", "varchar", true),
    systemDetailField(model, "fd_order", "行号", "SYS-XFORM.fd_order", "number", false)
  ];
}

function systemDetailField(model, name, label, labelLangKey, type, isIndex) {
  return {
    fdId: stableHexId(`${model.fdId}:${name}`),
    fdLabel: label,
    fdLabelLangKey: labelLangKey,
    fdName: name,
    fdColumn: name,
    fdType: type,
    fdDataType: type,
    fdDictType: "simpleDict",
    fdLength: 36,
    fdIsStored: true,
    fdIsIndex: isIndex,
    fdIsSystem: true,
    fdIsDataTask: false,
    fdDisplay: false,
    fdOuterMapping: false,
    fdState: "notEffective",
    fdDataModel: { fdId: model.fdId, fdName: model.fdName },
    fdMechanismType: "SYS-XFORM"
  };
}

function buildViewModel(config, template, mainModel, form, detailModelsByField) {
  const existing = Array.isArray(config.viewModel) ? config.viewModel[0] || {} : {};
  return {
    ...existing,
    fdName: "默认",
    fdCode: existing.fdCode || "default",
    fdStatus: "draft",
    fdLockMode: existing.fdLockMode || "none",
    fdXForm: { fdId: template.fdId, fdName: template.fdName },
    fdOrder: existing.fdOrder || 1,
    needDelete: false,
    fdConfig: JSON.stringify(buildViewConfig(mainModel, form, detailModelsByField))
  };
}

function buildViewConfig(mainModel, form, detailModelsByField) {
  const desktopRows = buildRows(form.layout?.mkTree || [], detailModelsByField);
  const mainContainer = {
    key: "main",
    type: "main",
    kind: "container",
    controlProps: { importBtn: null, onDesktopImport: null, id: "main" },
    children: desktopRows
  };
  return {
    view: {
      render: {
        desktop: [appearanceNode(mainModel.fdTableName, clone(mainContainer))],
        mobile: [appearanceNode(mainModel.fdTableName, clone(mainContainer))]
      }
    },
    theme: {},
    controlStyle: {}
  };
}

function appearanceNode(tableName, mainContainer) {
  return {
    key: "@elem/xform-appearance",
    type: "@elem/xform-appearance",
    kind: "container",
    controlProps: { "$$tableName": tableName },
    children: [mainContainer]
  };
}

function buildRows(rows, detailModelsByField) {
  return rows.map((row) => buildLayoutGridRow(row, detailModelsByField));
}

function buildLayoutGridRow(row, detailModelsByField) {
  const cells = row.children || [];
  const layoutId = `layout~${stableShortId(row.id)}`;
  const gridId = `@elem/layout-grid~${stableShortId(`${row.id}:grid`)}`;
  const displayColumns = displayColumnCount(row);
  return {
    key: layoutId,
    type: "layout",
    kind: "container",
    controlProps: {
      id: layoutId,
      migrationRowId: row.id,
      migrationLayoutComponentId: row.componentId,
      migrationLayoutType: `@elem/${row.componentId}`,
      migrationSourceColumns: row.props?.sourceColumns || cells.length || 1,
      migrationDisplayColumns: displayColumns
    },
    children: [
      {
        key: gridId,
        type: "@elem/layout-grid",
        kind: "container",
        controlProps: {
          columns: displayColumns,
          rows: 1,
          id: gridId
        },
        children: cells.map((cell, index) => buildGridItem(row, cell, index, detailModelsByField))
      }
    ]
  };
}

function buildGridItem(row, cell, index, detailModelsByField) {
  const refIds = childRefIds(cell);
  const firstRefId = refIds[0];
  const itemId = `@elem/layout-grid.GridItem~${stableShortId(`${row.id}:${cell.id || firstRefId || index}`)}`;
  const detailModel = detailModelsByField.get(firstRefId);
  const fieldRef = {
    key: detailModel?.fdTableName || firstRefId,
    migrationFieldId: firstRefId,
    migrationFieldIds: refIds,
    migrationRefType: cell.refType,
    migrationColumn: cell.column,
    migrationColspan: cell.colspan,
    ...(detailModel
      ? { children: detailModel.fdFields.filter((field) => !field.fdIsSystem).map((field) => ({ key: field.fdName })) }
      : {})
  };
  return {
    key: itemId,
    type: "@elem/layout-grid.GridItem",
    kind: "container",
    controlProps: {
      column: index + 1,
      row: 1,
      id: itemId,
      style: { backgroundColor: "" },
      migrationRowId: row.id,
      migrationFieldId: firstRefId,
      migrationFieldIds: refIds,
      migrationRefType: cell.refType,
      migrationColumn: cell.column,
      migrationColspan: cell.colspan
    },
    children: [fieldRef]
  };
}

function displayColumnCount(row) {
  const cells = row.children || [];
  if (Number.isInteger(row.props?.columns)) return row.props.columns;
  if (cells.length <= 1) return 1;
  return Math.max(1, Math.min(4, cells.length));
}

function buildFieldAuth(mainModel, detailModels, form) {
  const required = new Set((form.fields || []).filter((field) => field.props?.required).map((field) => field.id));
  return Object.fromEntries(
    [...(mainModel.fdFields || []), ...detailModels.flatMap((model) => model.fdFields || [])]
      .map((field) => [field.fdName, {
        visible: true,
        editable: !field.fdIsSystem,
        required: required.has(field.fdName),
        hide: false
      }])
  );
}

function buildAuth(tableName, fieldAuth) {
  const viewFields = Object.fromEntries(Object.keys(fieldAuth).map((fieldName) => [fieldName, {
    visible: true,
    hide: false
  }]));
  return [{
    fdName: ":publicLang.sysFormAuth",
    authOrg: [],
    fdIsAvailable: true,
    add: { [tableName]: { fields: fieldAuth } },
    edit: { [tableName]: { fields: fieldAuth } },
    view: { [tableName]: { fields: viewFields } }
  }];
}

function extractLayoutRows(config, detailModels) {
  const scene = Array.isArray(config.viewModel) ? config.viewModel[0] : undefined;
  const sceneConfig = parseJsonObject(scene?.fdConfig || "{}");
  const simpleRows = sceneConfig.view?.render?.desktop?.children;
  if (Array.isArray(simpleRows)) {
    return simpleRows.map((row) => ({
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

  const detailFieldByTable = new Map(detailModels.map((model) => [model.fdTableName, detailFieldIdForModel(model)]));
  const desktopRoots = sceneConfig.view?.render?.desktop;
  const root = Array.isArray(desktopRoots) ? desktopRoots[0] : undefined;
  const main = (root?.children || []).find((child) => child?.key === "main") || root?.children?.[0];
  return (main?.children || [])
    .map((row, rowIndex) => layoutNodeToSummaryRow(row, rowIndex, detailFieldByTable))
    .filter(Boolean);
}

function layoutNodeToSummaryRow(row, rowIndex, detailFieldByTable) {
  if (row?.type === "@elem/xform-row") {
    return {
      id: row.controlProps?.migrationRowId || row.key || `row-${rowIndex}`,
      layoutType: row.type,
      fields: (row.children || []).flatMap((child) => childFieldIds(child, detailFieldByTable)),
      cells: (row.children || []).map((child, cellIndex) => {
        const fieldIds = childFieldIds(child, detailFieldByTable);
        return {
          fieldId: fieldIds[0],
          fieldIds,
          column: child.migrationColumn ?? cellIndex,
          colspan: child.migrationColspan ?? 1
        };
      })
    };
  }

  if (row?.type !== "layout") return undefined;
  const grid = (row.children || []).find((child) => child?.type === "@elem/layout-grid");
  if (!grid) return undefined;
  const gridItems = (grid.children || [])
    .filter((child) => child?.type === "@elem/layout-grid.GridItem")
    .slice()
    .sort((left, right) => {
      const leftRow = Number(left.controlProps?.row || 1);
      const rightRow = Number(right.controlProps?.row || 1);
      if (leftRow !== rightRow) return leftRow - rightRow;
      return Number(left.controlProps?.column || 1) - Number(right.controlProps?.column || 1);
    });
  return {
    id: row.controlProps?.migrationRowId || row.key || `row-${rowIndex}`,
    layoutType: row.controlProps?.migrationLayoutType || "layout",
    fields: gridItems.flatMap((item) => childFieldIds(gridItemFieldRef(item), detailFieldByTable)),
    cells: gridItems.map((item, cellIndex) => {
      const child = gridItemFieldRef(item);
      const fieldIds = childFieldIds(child, detailFieldByTable);
      return {
        fieldId: fieldIds[0],
        fieldIds,
        column: item.controlProps?.migrationColumn ?? child?.migrationColumn ?? cellIndex,
        colspan: item.controlProps?.migrationColspan ?? child?.migrationColspan ?? 1
      };
    })
  };
}

function gridItemFieldRef(item) {
  return (item?.children || [])[0] || {};
}

function childFieldIds(child, detailFieldByTable) {
  if (Array.isArray(child.migrationFieldIds) && child.migrationFieldIds.length) return child.migrationFieldIds;
  if (child.migrationFieldId) return [child.migrationFieldId];
  if (detailFieldByTable.has(child.key)) return [detailFieldByTable.get(child.key)];
  return child.key ? [child.key] : [];
}

function detailModelToSummaryField(model) {
  return {
    id: detailFieldIdForModel(model),
    title: model.fdName,
    type: "detailTable",
    component: "xform-detail-table",
    columns: (model.fdFields || []).filter((field) => !field.fdIsSystem).map(dataFieldToSummaryField)
  };
}

function dataFieldToSummaryField(field) {
  return {
    id: field.fdName,
    title: field.fdLabel,
    type: field.fdType,
    component: componentFromDataField(field),
    columns: []
  };
}

function detailFieldIdForModel(model) {
  if (model.dynamicProps?.detailFieldName) return model.dynamicProps.detailFieldName;
  const attribute = parseJsonObject(model.fdAttribute || "{}");
  return attribute.config?.controlProps?.["$$detailTableFieldName"] || model.fdTableName || model.fdName;
}

function componentFromDataField(field) {
  const attribute = parseJsonObject(field.fdAttribute || "{}");
  const desktopType = attribute.config?.controlProps?.desktop?.type;
  return {
    "@elem/xform-input": "xform-input",
    "@elem/xform-textarea": "xform-textarea",
    "@elem/xform-radio": "xform-radio",
    "@elem/xform-checkbox": "xform-checkbox",
    "@elem/xform-select": "xform-select",
    "@elem/xform-datetime": "xform-datetime",
    "@elem/xform-number": "xform-number",
    "@elem/xform-address": "xform-address",
    "@elem/xform-attach": "xform-attach",
    "@elem/xform-description": "xform-description"
  }[desktopType] || field.component || componentForFdType(field.fdType);
}

function componentForFdType(type) {
  return {
    text: "xform-input",
    textarea: "xform-textarea",
    radio: "xform-radio",
    checkbox: "xform-checkbox",
    select: "xform-select",
    timestamp: "xform-datetime",
    number: "xform-number",
    address: "xform-address",
    attachment: "xform-attach",
    desc: "xform-description"
  }[type] || "xform-input";
}

function componentSpec(field) {
  const component = field.componentId;
  if (component === "xform-address") {
    return spec("address", "address", "orgElementDict", "address", "@elem/xform-address", "@elem/xform-m-address");
  }
  if (component === "xform-radio") {
    return spec("radio", "varchar", "simpleDict", "radio", "@elem/xform-radio", "@elem/xform-m-radio");
  }
  if (component === "xform-select" || component === "xform-select~multi") {
    return spec("select", "varchar", "simpleDict", "select", "@elem/xform-select", "@elem/xform-m-select");
  }
  if (component === "xform-checkbox") {
    return spec("checkbox", "varchar", "simpleDict", "checkbox", "@elem/xform-checkbox", "@elem/xform-m-checkbox");
  }
  if (component === "xform-textarea") {
    return spec("textarea", "clob", "simpleDict", "textarea", "@elem/xform-textarea", "@elem/xform-m-textarea");
  }
  if (component === "xform-datetime") {
    return spec("timestamp", "timestamp", "dateDict", "timestamp", "@elem/xform-datetime", "@elem/xform-m-datetime");
  }
  if (component === "xform-number") {
    return spec("number", "number", "numberDict", "number", "@elem/xform-number", "@elem/xform-m-number");
  }
  if (component === "xform-attach") {
    return spec("attachment", "varchar", "attachmentDict", "attachment", "@elem/xform-attach", "@elem/xform-m-attach");
  }
  if (component === "xform-description") {
    return spec("desc", "varchar", "simpleDict", "desc", "@elem/xform-description", "@elem/xform-m-description");
  }
  return spec("text", "varchar", "simpleDict", "text", "@elem/xform-input", "@elem/xform-m-input");
}

function spec(fdType, fdDataType, fdDictType, attrType, desktop, mobile) {
  return { fdType, fdDataType, fdDictType, attrType, desktop, mobile };
}

function cellFieldIds(cell) {
  if (Array.isArray(cell.fieldIds) && cell.fieldIds.length) return cell.fieldIds;
  return cell.fieldId ? [cell.fieldId] : [];
}

function childRefIds(child) {
  if (Array.isArray(child.refIds) && child.refIds.length) return child.refIds;
  if (child.refId) return [child.refId];
  if (Array.isArray(child.fieldIds) && child.fieldIds.length) return child.fieldIds;
  return child.fieldId ? [child.fieldId] : [];
}

function tableNameFor(value) {
  return `mk_model_${String(value || "table").replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 32)}`;
}

function stableShortId(value) {
  return stableHexId(value).slice(0, 10);
}

function stableHexId(value) {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (const char of String(value)) {
    const code = char.charCodeAt(0);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= code + 0x9e37;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }

  let output = "";
  while (output.length < 32) {
    h1 = Math.imul(h1 ^ (h1 >>> 13), 0x5bd1e995) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 15), 0x27d4eb2d) >>> 0;
    output += h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }
  return output.slice(0, 32);
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
