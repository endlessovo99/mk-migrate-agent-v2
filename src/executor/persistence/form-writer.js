import {
  buildNativeFormRuleConfig,
  mergeNativeFormRules,
  summarizeNativeFormRuleConfig
} from "./form-rules-writer.js";
import { COMPONENTS_BY_ID, componentSupportsProp } from "../../dsl/catalogs.js";
import { projectLayoutGrid } from "../../dsl/layout-pack.js";
import { detailTableNameFor } from "./detail-table-names.js";
import { persistedFieldLabel } from "./field-labels.js";
import { SCRIPT_SINGLETON_GLOBAL_EVENTS, analyzeScriptFunction } from "../../dsl/scripts.js";
import {
  dispatcherActionEndMarker,
  dispatcherActionStartMarker,
  markedDispatcherActionFunction,
  renderDispatcherInvocation,
  singletonDispatcherContract
} from "./script-dispatcher-contract.js";
import {
  findScriptFunctionBody,
  hasEquivalentLeadingViewStatusGuard
} from "./view-status-guard.js";

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
  const lang = parseJsonObject(config.lang || "{}");
  const summary = summarizeDslForm(form, dsl.formRules);
  const mainModel = buildMainModel(next, xform, config, form, lang);
  const detailModels = buildDetailModels(next, form, mainModel, lang);
  const dataModels = [mainModel, ...detailModels];
  assertUniqueNativeControlIds(dataModels);
  const detailModelsByField = new Map(
    detailModels.map((model) => [model.dynamicProps?.detailFieldName, model]).filter(([fieldId]) => Boolean(fieldId))
  );
  applyButtonNativeActions(mainModel, dsl.scripts, lang, { mainModel, detailModelsByField });

  const fieldAuth = buildFieldAuth(mainModel, detailModels, form);
  const existingFormAttr = parseJsonObject(config.attribute?.formAttr || "{}");
  const controlAction = buildControlAction(existingFormAttr.controlAction, dsl.scripts, {
    mainModel,
    detailModelsByField
  });
  const nativeFormRules = buildNativeFormRuleConfig(dsl.formRules, form, dataModels, dsl.scripts);
  const formAttr = {
    subjectRule: {},
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
    auth: buildAuth(mainModel.fdTableName, fieldAuth, form),
    attribute: {
      ...(config.attribute || {}),
      formAttr: JSON.stringify(formAttr)
    },
    dataModel: dataModels,
    viewModel: [buildViewModel(config, next, mainModel, form, detailModelsByField)],
    lang: JSON.stringify(lang),
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
      required: field.props?.required === true,
      dataOnly: field.dataOnly === true,
      columns: Array.isArray(field.columns)
        ? field.columns.map((column) => ({
            id: column.id,
            title: column.title,
            type: column.type,
            component: column.componentId,
            required: column.props?.required === true
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

export function summarizeDslScripts(scripts = {}) {
  const actions = Array.isArray(scripts.actions) ? scripts.actions : [];
  return {
    actionCount: actions.length,
    events: actions.map((action) => action.event || action.name).filter(Boolean),
    scopes: actions.map((action) => action.scope).filter(Boolean),
    translationStatuses: actions.map((action) => action.translationStatus).filter(Boolean),
    actions: actions
      .filter((action) => action.translationStatus !== "omitted")
      .map((action) => ({
        id: action.id,
        event: action.event || action.name,
        scope: action.scope || "global",
        controlId: action.controlId,
        tableId: action.tableId,
        runWhen: action.runWhen
      }))
  };
}

export function summarizeScriptsFromConfig(config = {}) {
  const formAttr = parseJsonObject(config.attribute?.formAttr || "{}");
  const controlAction = formAttr.controlAction || {};
  const global = controlAction.global || {};
  const control = controlAction.control || {};
  const events = Object.keys(global).filter((event) => Array.isArray(global[event]) && global[event].length);
  const controlEvents = Object.entries(control)
    .flatMap(([controlKey, actionByEvent]) => Object.entries(actionByEvent || {})
      .filter(([, actions]) => Array.isArray(actions) && actions.length)
      .map(([event, actions]) => ({ controlKey, event, count: actions.length })));
  const actions = [
    ...Object.entries(global).flatMap(([event, entries]) =>
      (Array.isArray(entries) ? entries : []).flatMap((action) => persistedActionSummaries(action, {
        event,
        scope: "global"
      }))
    ),
    ...Object.entries(control).flatMap(([controlKey, actionByEvent]) =>
      Object.entries(actionByEvent || {}).flatMap(([event, entries]) =>
        (Array.isArray(entries) ? entries : []).flatMap((action) => persistedActionSummaries(action, {
          event,
          scope: "control",
          controlKey
        }))
      )
    )
  ];
  const persistedActionCount = events.reduce((count, event) => count + global[event].length, 0) +
    controlEvents.reduce((count, item) => count + item.count, 0);
  return {
    actionCount: actions.length,
    persistedActionCount,
    events,
    controlEvents,
    javascriptLength: typeof controlAction.javascript === "string" ? controlAction.javascript.length : 0,
    actions
  };
}

function persistedActionSummaries(action = {}, context = {}) {
  const migrationActions = Array.isArray(action.migrationActions) ? action.migrationActions : [];
  if (!migrationActions.length) return [persistedActionSummary(action, context)];

  return migrationActions.flatMap((migrationAction) => {
    const functionText = markedDispatcherActionFunction(action.function, migrationAction.name);
    if (!migrationAction.id || !functionText) return [];
    return [persistedActionSummary({
      id: migrationAction.id,
      function: functionText,
      migrationRunWhen: migrationAction.migrationRunWhen
    }, context)];
  });
}

function persistedActionSummary(action = {}, context = {}) {
  const markerStatuses = viewStatusMarkerFromFunction(action.function);
  return {
    id: action.id,
    event: context.event,
    scope: context.scope,
    controlKey: context.controlKey,
    runWhen: action.migrationRunWhen,
    guardViewStatusIn: markerStatuses,
    hasCanonicalGuard: markerStatuses
      ? hasCanonicalViewStatusGuard(action.function, markerStatuses, context.event)
      : false
  };
}

function buildControlAction(existing, scripts = {}, context = {}) {
  const next = {
    control: pruneOrphanControlActions(existing?.control, context),
    global: existing?.global || {}
  };
  const actions = Array.isArray(scripts.actions) ? scripts.actions : [];

  if (!actions.length) {
    if (existing?.javascript) next.javascript = existing.javascript;
    return next;
  }

  const grouped = new Map();
  let onChangeIndex = 0;
  for (const action of actions) {
    if (action.translationStatus === "omitted") continue;
    const event = action.event || action.name;
    if (!event || typeof action.function !== "string" || !action.function.trim()) continue;
    assertSynchronousMkScript(action.function, action.id || event, event);
    const scope = action.scope || "global";
    const key = scope === "control"
      ? controlActionKey(action, context)
      : event;
    if (!key) continue;
    const groupedKey = `${scope}:${key}:${event}`;
    if (!grouped.has(groupedKey)) grouped.set(groupedKey, { scope, key, event, actions: [] });
    const renderedFunction = renderScriptFunction(action.function, context, action);
    let persistedName = action.name || event;
    if (event === "onChange") {
      onChangeIndex += 1;
      persistedName = `onChange_${onChangeIndex}`;
    }
    const persistedFunction = event === "onChange"
      ? renameFunctionDeclaration(renderedFunction, action.name || event, persistedName)
      : renderedFunction;
    grouped.get(groupedKey).actions.push({
      name: persistedName,
      function: persistedFunction,
      id: action.id || stableHexId(`${event}:${renderedFunction}`).slice(0, 18),
      ...(action.runWhen ? { migrationRunWhen: clone(action.runWhen) } : {})
    });
  }

  for (const item of grouped.values()) {
    const persistedActions = item.scope === "global" && SCRIPT_SINGLETON_GLOBAL_EVENTS.has(item.event)
      ? [buildGlobalDispatcher(item.event, item.actions)]
      : item.actions;
    if (item.scope === "control") {
      next.control[item.key] = {
        ...(next.control[item.key] || {}),
        [item.event]: persistedActions
      };
      continue;
    }
    next.global[item.event] = persistedActions;
  }
  return next;
}

function assertSynchronousMkScript(source, actionId, event) {
  try {
    // Syntax-only persistence guard; declarations are compiled but never executed.
    // eslint-disable-next-line no-new-func
    new Function(source);
  } catch (error) {
    throw new Error(`MK runtime script ${actionId} uses unsupported JavaScript syntax: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const analysis = analyzeScriptFunction(source);
  if (analysis.unsupportedSyntax.length) {
    const keywords = [...new Set(analysis.unsupportedSyntax.map((usage) => usage.keyword))].join(", ");
    throw new Error(`MK runtime script ${actionId} uses unsupported asynchronous syntax: ${keywords}.`);
  }
  if (event === "onBeforeSubmit" && analysis.promiseReturns.length) {
    throw new Error(`MK runtime script ${actionId} must synchronously return a boolean and cannot return a Promise.`);
  }
}

function pruneOrphanControlActions(control, context) {
  const validKeys = new Set();
  for (const field of context.mainModel?.fdFields || []) {
    if (!field?.fdIsSystem && field?.fdName) {
      validKeys.add(`${context.mainModel.fdTableName}.${field.fdName}`);
    }
  }
  for (const model of context.detailModelsByField?.values?.() || []) {
    if (model?.fdTableName) validKeys.add(`${model.fdTableName}.${model.fdTableName}`);
    for (const field of model.fdFields || []) {
      if (!field?.fdIsSystem && field?.fdName) validKeys.add(`${model.fdTableName}.${field.fdName}`);
    }
  }
  return Object.fromEntries(
    Object.entries(control || {}).filter(([controlKey]) => validKeys.has(controlKey))
  );
}

function buildGlobalDispatcher(event, actions) {
  const contract = singletonDispatcherContract(event, actions);
  const handlers = actions.map((action, index) => {
    const name = contract.childNames[index];
    return {
      action,
      name,
      function: renameFunctionDeclaration(action.function, action.name, name)
    };
  });
  const definitions = handlers.map((handler) => [
    `  ${dispatcherActionStartMarker(handler.name)}`,
    indentLines(handler.function, "  "),
    `  ${dispatcherActionEndMarker(handler.name)}`
  ].join("\n"));
  const invocation = renderDispatcherInvocation(event, contract.callNames);
  const migrationActions = handlers.map((handler) => ({
    id: handler.action.id,
    name: handler.name,
    ...(handler.action.migrationRunWhen
      ? { migrationRunWhen: clone(handler.action.migrationRunWhen) }
      : {})
  }));
  return {
    name: event,
    function: `function ${event}(context) {\n${definitions.join("\n\n")}\n\n${invocation}\n}`,
    id: `${event}_dispatcher_${stableShortId(migrationActions.map((action) => action.id).join("|"))}`,
    migrationActions
  };
}

function renameFunctionDeclaration(source, currentName, nextName) {
  const declaration = new RegExp(`\\bfunction\\s+${escapeRegExp(currentName)}(?=\\s*\\()`);
  if (!declaration.test(source)) {
    throw new Error(`cannot rename persisted script function ${currentName || "<missing>"}`);
  }
  return String(source).replace(declaration, `function ${nextName}`);
}

function indentLines(value, indent) {
  return String(value).split("\n").map((line) => `${indent}${line}`).join("\n");
}

function controlActionKey(action, context) {
  const model = action.tableId
    ? context.detailModelsByField?.get(action.tableId)
    : context.mainModel;
  if (!model?.fdTableName || !action.controlId) return "";
  if (action.tableId && action.controlId === action.tableId) {
    return `${model.fdTableName}.${model.fdTableName}`;
  }
  return `${model.fdTableName}.${action.controlId}`;
}

function renderScriptFunction(source, context = {}, action = {}) {
  const rendered = String(source || "").replace(/\$\{table:([^}]+)\}/g, (_, tableId) => {
    const sourceTableId = String(tableId || "").trim();
    const model = context.detailModelsByField?.get(sourceTableId);
    return model?.fdTableName || sourceTableId;
  });
  return injectViewStatusGuard(rendered, action);
}

function injectViewStatusGuard(source, action = {}) {
  const statuses = action.runWhen?.viewStatusIn;
  if (!Array.isArray(statuses) || !statuses.length) return source;
  const marker = viewStatusMarker(statuses);
  const condition = viewStatusGuardCondition(statuses);
  const event = action.event || action.name;
  const functionName = action.name || action.event || "";
  const fallback = event === "onBeforeSubmit" ? "return true" : "return";
  const functionBody = findScriptFunctionBody(source, functionName);
  if (!functionBody) {
    throw new Error(`cannot inject view-status guard: named function ${action.name || action.event || "<missing>"} was not found`);
  }
  const hasLeadingGuard = hasEquivalentLeadingViewStatusGuard(source, statuses, { event, functionName });
  const markerStatuses = viewStatusMarkerFromFunction(source);
  const hasCanonicalMarker = markerStatuses && sameStrings(markerStatuses, statuses);
  if (hasLeadingGuard && hasCanonicalMarker) return source;

  const guard = hasLeadingGuard
    ? `\n  ${marker}`
    : `\n  ${marker}\n  if (${condition}) ${fallback};`;
  return `${source.slice(0, functionBody.bodyStart)}${guard}${source.slice(functionBody.bodyStart)}`;
}

function viewStatusMarker(statuses) {
  return `/* mk-migrate:view-status=${statuses.join(",")} */`;
}

function viewStatusGuardCondition(statuses) {
  return statuses.map((status) => `MKXFORM.viewStatus !== ${JSON.stringify(status)}`).join(" && ");
}

function viewStatusMarkerFromFunction(source = "") {
  const match = String(source).match(/\/\*\s*mk-migrate:view-status=([^*]+?)\s*\*\//);
  return match ? match[1].split(",").map((status) => status.trim()).filter(Boolean) : undefined;
}

function hasCanonicalViewStatusGuard(source, statuses, event) {
  return hasEquivalentLeadingViewStatusGuard(source, statuses, { event });
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildMainModel(template, xform, config, form, lang) {
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
    ...normalFields.map((field, index) => canonicalField(
      field,
      template,
      main,
      systemFields.length + index + 1,
      "main",
      lang
    ))
  ];
  return main;
}

function buildDetailModels(template, form, mainModel, lang) {
  return (form.fields || [])
    .filter((field) => field.type === "detailTable")
    .map((field) => {
      const tableName = detailTableNameFor(mainModel.fdTableName, field.id);
      const model = {
        fdId: stableHexId(`${template.fdId}:detail:${field.id}`),
        dynamicProps: { detailFieldName: field.id },
        fdName: persistedFieldLabel(field),
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
        ...(field.columns || []).map((column, index) => canonicalField(column, template, model, index + 1, "detail", lang)),
        ...detailSystemFields(model)
      ];
      model.fdAttribute = JSON.stringify(detailModelAttribute(field, model));
      return model;
    });
}

function assertUniqueNativeControlIds(dataModels) {
  const refsByControlId = new Map();

  for (const model of dataModels) {
    const detailTableId = model?.fdType === "detail"
      ? model.dynamicProps?.detailFieldName
      : undefined;
    for (const field of model?.fdFields || []) {
      if (!field?.fdName || field.fdIsSystem) continue;
      const controlId = parseJsonObject(field.fdAttribute).config?.controlProps?.id;
      if (typeof controlId !== "string" || !controlId.trim()) continue;
      const fieldRef = detailTableId
        ? `${detailTableId}.${field.fdName}`
        : field.fdName;
      const refs = refsByControlId.get(controlId) || [];
      refs.push(fieldRef);
      refsByControlId.set(controlId, refs);
    }
  }

  for (const [controlId, fieldRefs] of refsByControlId) {
    const uniqueRefs = [...new Set(fieldRefs)];
    if (uniqueRefs.length <= 1) continue;
    const error = new Error(
      `Native control id ${controlId} is shared by multiple DSL fields.`,
    );
    error.code = "projection.form.native_control_id_collision";
    error.details = { controlId, fieldRefs: uniqueRefs };
    throw error;
  }
}

function canonicalField(field, template, model, order, tableType, lang) {
  const spec = componentSpec(field);
  const fdLength = fieldLengthFromDsl(field, spec);
  const isDisplayOnly = ["desc", "button"].includes(spec.attrType);
  const label = persistedFieldLabel(field);
  return {
    fdId: stableHexId(`${template.fdId}:${model.fdTableName}:${field.id}:${order}`),
    fdLabel: label,
    fdName: field.id,
    ...(tableType === "main"
      ? { fdColumn: `fd_${field.id}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48) }
      : {}),
    fdType: spec.fdType,
    fdAttribute: JSON.stringify(fieldAttribute(field, template, model.fdTableName, tableType, spec, lang)),
    fdFontExtendData: JSON.stringify(fieldFontExtendData(field, template, spec)),
    fdDataType: spec.fdDataType,
    fdDictType: spec.fdDictType,
    ...(fdLength !== undefined ? { fdLength } : {}),
    fdIsStored: !isDisplayOnly,
    fdIsIndex: false,
    fdIsSystem: false,
    fdIsDataTask: false,
    fdDisplay: field.dataOnly !== true,
    fdOuterMapping: false,
    fdState: "notEffective",
    fdDataModel: { fdId: model.fdId, fdName: model.fdName },
    fdMechanismType: "SYS-XFORM",
    fdOrder: order
  };
}

function fieldLengthFromDsl(field, spec) {
  if (["desc", "button"].includes(spec.attrType)) return 0;
  if (spec.attrType === "textarea") {
    return textareaMaxLengthFromDsl(field);
  }
  return 200;
}

function fieldAttribute(field, template, tableName, tableType, spec, lang) {
  const controlId = `${spec.desktop}~${stableShortId(field.id)}`;
  const label = persistedFieldLabel(field);
  const controlProps = {
    id: controlId,
    desktop: { type: spec.desktop },
    mobile: { type: spec.mobile },
    name: field.id,
    uuid: field.id,
    title: label,
    span: 24,
    "$$tableType": tableType,
    "$$tableName": tableName
  };

  if (field.props?.required) controlProps.required = true;
  if (componentSupportsProp(field.componentId, "placeholder") && typeof field.props?.placeholder === "string") {
    controlProps.placeholder = field.props.placeholder;
  }
  if (componentSupportsProp(field.componentId, "unit") && typeof field.props?.unit === "string") {
    const unit = field.props.unit.trim();
    const unitToken = nativeLangToken(field.id, "numberFormat");
    lang[unitToken] = nativeNumberFormatLangEntry(field.id, unit);
    Object.assign(controlProps, {
      showCount: true,
      numberFormat: nativeNumberFormat(unitToken),
      defaultValueType: "formula"
    });
  }
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
    if (typeof controlProps.placeholder !== "string") controlProps.placeholder = "请输入";
    const maxLength = textareaMaxLengthFromDsl(field);
    if (maxLength !== undefined) {
      controlProps.maxLength = maxLength;
    }
  }
  if (spec.attrType === "timestamp") {
    Object.assign(controlProps, { placeholder: "请选择", displayPattern: "yyyy-MM-dd HH:mm" });
  }
  if (spec.attrType === "address") {
    controlProps.org = { types: ["ORG_TYPE_PERSON", "ORG_TYPE_DEPT"] };
  }
  if (spec.attrType === "number" && hasNativeNumberPrecision(field)) {
    const precision = field.props.precision;
    controlProps.valueType = {
      formatType: "decimal",
      groupingUsed: false,
      precision
    };
    Object.assign(controlProps, {
      maxLength: controlProps.maxLength || 200,
      "$$allowCustomValue": true,
      type: spec.desktop,
      showCount: true,
      numberFormat: nativeDecimalNumberFormat(
        precision,
        typeof controlProps.numberFormat?.unit === "string"
          ? controlProps.numberFormat.unit
          : ""
      ),
      defaultValueType: controlProps.defaultValueType || "formula"
    });
  }
  if (spec.attrType === "calculate" && hasNativeNumberPrecision(field)) {
    controlProps.valueType = {
      formatType: "decimal",
      groupingUsed: false,
      precision: field.props.precision
    };
  }
  if (spec.attrType === "calculate") {
    controlProps.statisticMode = nativeStatisticMode(field.props?.calculation);
    if (!controlProps.defaultValueType) controlProps.defaultValueType = "empty";
  }
  if (spec.attrType === "desc") {
    const content = field.props?.content || field.title || "";
    Object.assign(controlProps, {
      defaultTextValue: content,
      content,
      alignDesc: "left",
      maxLength: 0
    });
    delete controlProps.span;
  }
  if (spec.attrType === "button") {
    const textToken = nativeLangToken(field.id, "btnCfg");
    lang[textToken] = nativeLangEntry("btnCfg", field.id, label);
    Object.assign(controlProps, {
      showText: false,
      btnCfg: {
        title: "按钮",
        inputVal: textToken,
        colorMap: {
          background: { label: "背景", color: "#4285F4" },
          font: { label: "文字", color: "#fff" }
        }
      },
      maxLength: 0
    });
  }

  applyDefaultValueToControlProps(controlProps, field, template, spec);

  const isDescription = spec.attrType === "desc";
  const isButton = spec.attrType === "button";
  return {
    uuid: field.id,
    config: {
      key: controlId,
      type: isDescription
        ? "desc"
        : isButton
          ? "button"
          : spec.attrType === "number" && hasNativeNumberPrecision(field)
            ? "numbertext"
            : spec.desktop,
      controlProps,
      kind: "control",
      label,
      labelProps: isDescription
        ? {
            compose: true,
            desktop: { hiddenLabel: true },
            title: label,
            mobile: { hiddenLabel: true }
          }
        : isButton
          ? { desktop: {}, showText: false, title: label, mobile: {} }
          : { desktop: {}, title: label, mobile: {} }
    },
    env: isDescription ? ["xform", "print"] : ["xform"]
  };
}

function applyButtonNativeActions(mainModel, scripts, lang, context) {
  const actions = (scripts?.actions || []).filter((candidate) =>
    candidate?.translationStatus !== "omitted" &&
    candidate?.scope === "control" &&
    (candidate?.event || candidate?.name) === "onClick" &&
    typeof candidate?.function === "string" &&
    candidate.function.trim()
  );
  const actionsByControl = new Map(actions.map((action) => [action.controlId, action]));
  for (const field of mainModel.fdFields || []) {
    if (field?.fdType !== "button") continue;
    const action = actionsByControl.get(field.fdName);
    if (!action) throw new Error(`xform-button ${field.fdName} requires one translated onClick action`);
    const scriptToken = nativeLangToken(field.fdName, "typeCfg");
    const rendered = renderScriptFunction(action.function, context, action);
    lang[scriptToken] = nativeLangEntry("typeCfg", field.fdName, rendered);
    const attribute = JSON.parse(field.fdAttribute);
    attribute.config.controlProps.typeCfg = { type: "js", operInfo: scriptToken, business: {} };
    field.fdAttribute = JSON.stringify(attribute);
  }
}

function nativeLangToken(fieldId, prop) {
  return `!{${stableHexId(`${fieldId}:${prop}`)}${stableHexId(`${prop}:${fieldId}`)}}`;
}

function nativeLangEntry(prop, name, text) {
  return { prop, name, type: "input", content: { Cn: String(text || "") } };
}

function nativeNumberFormatLangEntry(fieldId, unit) {
  return {
    prop: "numberFormat",
    name: fieldId,
    type: "input",
    content: { Cn: unit, default: unit }
  };
}

function nativeNumberFormat(unitToken) {
  return {
    formatType: "base",
    precision: null,
    groupingUsed: null,
    symbol: null,
    unit: unitToken,
    percentage: false
  };
}

function nativeDecimalNumberFormat(precision, unit = "") {
  return {
    formatType: "decimal",
    percentage: null,
    precision: String(precision),
    groupingUsed: false,
    symbol: null,
    unit
  };
}

function hasNativeNumberPrecision(field) {
  return Number.isSafeInteger(field.props?.precision) && field.props.precision >= 0;
}

function applyDefaultValueToControlProps(controlProps, field, template, spec) {
  const contextDefault = contextDefaultFormula(field, template, spec);
  if (contextDefault) {
    applyContextDefaultToControlProps(controlProps, contextDefault, spec);
    return;
  }

  const literalDefault = normalizeLiteralDefault(field.props?.defaultValue);
  if (!literalDefault) return;

  if (["radio", "checkbox", "select"].includes(spec.attrType)) {
    controlProps.defaultValueType = "fixed";
    controlProps.defaultValue = cloneLiteral(literalDefault.value);
    if (Array.isArray(controlProps.options)) {
      const selected = new Set(Array.isArray(literalDefault.value) ? literalDefault.value : [literalDefault.value]);
      controlProps.options = controlProps.options.map((option) => ({
        ...option,
        checked: selected.has(option.value)
      }));
    }
    return;
  }

  if (["text", "textarea", "number", "calculate"].includes(spec.attrType)) {
    controlProps.defaultValueType = "formula";
    controlProps.defaultValueFormulaVO = literalDefaultFormula(literalDefault.value);
    if (spec.attrType === "text") controlProps.maxLength = controlProps.maxLength || 200;
  }
}

function applyContextDefaultToControlProps(controlProps, contextDefault, spec) {

  if (spec.attrType === "address") {
    Object.assign(controlProps, {
      multi: false,
      preSelectType: "fixed",
      defaultValueFormulaVO: contextDefault.formula,
      showOrgType: 0,
      maxLength: 0,
      "$$allowCustomValue": true
    });
    controlProps.org = {
      ...(controlProps.org || {}),
      orgTypeArr: contextDefault.orgTypeArr,
      defaultValueType: "formula"
    };
    return;
  }

  if (spec.attrType === "text") {
    controlProps.defaultValueType = "formula";
    controlProps.defaultValueFormulaVO = contextDefault.formula;
    controlProps.maxLength = controlProps.maxLength || 200;
  }
}

function fieldFontExtendData(field, template, spec) {
  const data = {};
  if (
    spec.attrType === "number" &&
    componentSupportsProp(field.componentId, "unit") &&
    typeof field.props?.unit === "string" &&
    field.props.unit.trim()
  ) {
    const unitToken = nativeLangToken(field.id, "numberFormat");
    Object.assign(data, {
      passValue: false,
      showCount: true,
      trace: false,
      defaultValueType: "formula",
      percentage: false,
      precision: null,
      groupingUsed: null,
      symbol: null,
      unit: unitToken,
      formatType: "base"
    });
  }

  if (spec.attrType === "number" && hasNativeNumberPrecision(field)) {
    Object.assign(data, {
      precision: String(field.props.precision),
      groupingUsed: false,
      formatType: "decimal",
      passValue: false,
      showCount: true,
      defaultValueType: "formula",
      percentage: null,
      symbol: null,
      unit: typeof data.unit === "string" ? data.unit : ""
    });
  }

  if (spec.attrType === "calculate" && hasNativeNumberPrecision(field)) {
    data.precision = field.props.precision;
    if (!data.formatType) {
      data.groupingUsed = false;
      data.formatType = "decimal";
    }
  }

  if (spec.attrType === "calculate") {
    data.statisticMode = nativeStatisticMode(field.props?.calculation);
    if (!data.defaultValueType) data.defaultValueType = "empty";
  }

  const contextDefault = contextDefaultFormula(field, template, spec);
  if (contextDefault && spec.attrType === "address") {
    return {
      ...data,
      orgTypeArr: contextDefault.orgTypeArr,
      defaultValueType: "formula",
      multi: false,
      defaultValueFormulaVO: contextDefault.formula,
      ...(contextDefault.source === "creatorDept" ? { relation: [] } : {})
    };
  }

  if (contextDefault && spec.attrType === "text") {
    return {
      ...data,
      passValue: false,
      trace: false,
      encrypt: false,
      defaultValueType: "formula",
      encryptDefinition: {},
      recalculate: false,
      defaultValueFormulaVO: contextDefault.formula
    };
  }

  const literalDefault = normalizeLiteralDefault(field.props?.defaultValue);
  if (!literalDefault) return data;

  if (["radio", "checkbox", "select"].includes(spec.attrType)) {
    const selected = new Set(Array.isArray(literalDefault.value) ? literalDefault.value : [literalDefault.value]);
    return {
      ...data,
      passValue: false,
      trace: false,
      defaultValueType: "fixed",
      defaultValue: cloneLiteral(literalDefault.value),
      options: (field.props?.options || []).map((option) => ({
        label: option.label ?? option.text ?? option.value,
        value: option.value ?? option.label ?? option.text,
        checked: selected.has(option.value ?? option.label ?? option.text)
      }))
    };
  }

  if (["text", "textarea", "number", "calculate"].includes(spec.attrType)) {
    return {
      ...data,
      passValue: false,
      trace: false,
      defaultValueType: "formula",
      defaultValueFormulaVO: literalDefaultFormula(literalDefault.value)
    };
  }

  return data;
}

function normalizeLiteralDefault(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.kind !== "literal" || !Object.hasOwn(value, "value")) return undefined;
  const literal = value.value;
  if (!["string", "number", "boolean"].includes(typeof literal) && !Array.isArray(literal)) return undefined;
  return { value: cloneLiteral(literal) };
}

function cloneLiteral(value) {
  return Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : value;
}

function literalDefaultFormula(value) {
  const script = typeof value === "string" ? JSON.stringify(value) : String(value);
  return {
    type: "Eval",
    script,
    vo: {
      mode: "formula",
      content: String(value)
    }
  };
}

function nativeStatisticMode(calculation) {
  return calculation?.kind === "aggregate"
    ? String(calculation.operation || "sum").toUpperCase()
    : "FORMULA";
}

function contextDefaultFormula(field, template, spec) {
  const defaultValue = normalizeContextDefault(field.props?.defaultValue);
  if (!defaultValue) return undefined;
  if (!["address", "text"].includes(spec.attrType)) return undefined;

  const property = spec.attrType === "text" ? defaultValue.property : undefined;
  if (spec.attrType === "text" && property !== "fdName") return undefined;

  const sourceField = defaultValue.source === "creator" ? "fdCreator" : "fdCreatorDept";
  const scriptPath = property === "fdName" ? `${sourceField}.fdName` : sourceField;
  const sourceLabel = defaultValue.source === "creator" ? "创建人" : "创建者部门";
  const propertyLabel = property === "fdName" ? ".名称" : "";
  const templateName = String(template?.fdName || "表单").trim() || "表单";

  return {
    source: defaultValue.source,
    orgTypeArr: defaultValue.source === "creator" ? ["8"] : ["2"],
    formula: {
      type: "Eval",
      script: `\${data.biz.${scriptPath}}`,
      vo: {
        mode: "formula",
        content: `$${templateName}.${sourceLabel}${propertyLabel}$`
      },
      varIds: [scriptPath]
    }
  };
}

function normalizeContextDefault(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.kind !== "context") return undefined;
  if (!["creator", "creatorDept"].includes(value.source)) return undefined;
  if (value.property !== undefined && value.property !== "fdName") return undefined;
  return {
    source: value.source,
    property: value.property
  };
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

function detailModelAttribute(field, model) {
  const target = componentTarget("xform-detail-table", "@elem/xform-detail-table", "@elem/xform-m-detail-table");
  const controlId = `${target.desktop}~${stableShortId(field.id)}`;
  const label = persistedFieldLabel(field);
  return {
    uuid: model.fdTableName,
    config: {
      key: controlId,
      type: target.desktop,
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
        desktop: { type: target.desktop },
        mobile: { type: target.mobile },
        name: model.fdTableName,
        uuid: model.fdTableName,
        title: label,
        "$$detailTableFieldName": field.id,
        "$$tableType": "detail",
        "$$tableName": model.fdTableName,
        canChangeSpan: false,
        pcNestSetting: ["toggle"],
        printLayoutType: "table"
      },
      kind: "container",
      label,
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
    controlStyle: buildControlStyle(form)
  };
}

function buildControlStyle(form = {}) {
  const styles = {};
  for (const field of form.fields || []) {
    if (field.componentId !== "xform-description") continue;
    const style = descriptionControlStyle(field);
    if (!style) continue;
    styles[field.id] = {
      desktop: {
        layout: "vertical",
        controlValueStyle: style
      }
    };
  }
  return styles;
}

function descriptionControlStyle(field) {
  const style = field.props?.style;
  if (!style || typeof style !== "object" || Array.isArray(style)) return undefined;
  const next = {};
  if (typeof style.color === "string" && style.color.trim()) next.color = style.color.trim();
  if (typeof style.fontWeight === "string" && style.fontWeight.trim()) next.fontWeight = style.fontWeight.trim();
  return Object.keys(next).length ? next : undefined;
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
  const packed = projectLayoutGrid(row.children || [], {
    columns: row.props?.columns,
    rows: row.componentId === "xform-multi-row-table-layout" ? row.props?.rows : 1
  });
  const cells = packed.cells;
  const layoutId = `layout~${stableShortId(row.id)}`;
  const gridId = `@elem/layout-grid~${stableShortId(`${row.id}:grid`)}`;
  const displayColumns = packed.columns;
  const displayRows = packed.rows;
  const migrationRowId = migrationRowIdFor(row);
  return {
    key: layoutId,
    type: "layout",
    kind: "container",
    controlProps: {
      id: layoutId,
      migrationRowId,
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
          rows: displayRows,
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
  const migrationRowId = migrationRowIdFor(row);
  const fieldRef = {
    key: detailModel?.fdTableName || firstRefId,
    migrationFieldId: firstRefId,
    migrationFieldIds: refIds,
    migrationRefType: cell.refType,
    migrationColumn: cell.column,
    migrationColspan: cell.colspan,
    migrationGridRow: cell.row,
    ...(detailModel
      ? { children: detailModel.fdFields.filter((field) => !field.fdIsSystem).map((field) => ({ key: field.fdName })) }
      : {})
  };
  const column = Number.isInteger(cell.column) ? cell.column : index;
  const gridRow = Number.isInteger(cell.row) ? cell.row : 0;
  const colspan = Number.isInteger(cell.colspan) ? cell.colspan : 1;
  return {
    key: itemId,
    type: "@elem/layout-grid.GridItem",
    kind: "container",
    controlProps: {
      column: column + 1,
      colSpan: colspan,
      row: gridRow + 1,
      id: itemId,
      style: { backgroundColor: "" },
      // Audit-only markers; observers must not treat these as verification evidence.
      migrationRowId,
      migrationFieldId: firstRefId,
      migrationFieldIds: refIds,
      migrationRefType: cell.refType,
      migrationColumn: cell.column,
      migrationColspan: cell.colspan,
      migrationGridRow: cell.row
    },
    children: [fieldRef]
  };
}

/** Prefer layout sourceMarkers so MKXFORM.setFieldAttr(rowMarker) resolves at runtime. */
function migrationRowIdFor(row = {}) {
  const markers = Array.isArray(row.sourceMarkers)
    ? row.sourceMarkers.map((marker) => String(marker || "").trim()).filter(Boolean)
    : [];
  return markers[0] || row.id;
}

function buildFieldAuth(mainModel, detailModels, form) {
  const required = new Set((form.fields || []).filter((field) => field.props?.required).map((field) => field.id));
  return Object.fromEntries(
    [...(mainModel.fdFields || []), ...detailModels.flatMap((model) => model.fdFields || [])]
      .map((field) => [field.fdName, {
        visible: true,
        editable: !field.fdIsSystem && field.fdType !== "desc",
        required: required.has(field.fdName),
        hide: false
      }])
  );
}

function buildAuth(tableName, fieldAuth, form) {
  const editOnly = new Set((form.fields || [])
    .filter((field) => field.sourceProps?.displayGate === "xform:editShow")
    .map((field) => field.id));
  const viewFields = Object.fromEntries(Object.keys(fieldAuth).map((fieldName) => [fieldName, {
    visible: !editOnly.has(fieldName),
    hide: editOnly.has(fieldName)
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
      rows: row.rows || 1,
      columns: row.columns || 1,
      fields: (row.cells || []).flatMap((cell) => cellFieldIds(cell)),
      cells: (row.cells || []).map((cell) => ({
        fieldId: cell.fieldId || cellFieldIds(cell)[0],
        fieldIds: cellFieldIds(cell),
        row: cell.row ?? 0,
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
      rows: 1,
      columns: Math.max((row.children || []).length, 1),
      fields: (row.children || []).flatMap((child) => childFieldIds(child, detailFieldByTable)),
      cells: (row.children || []).map((child, cellIndex) => {
        const fieldIds = childFieldIds(child, detailFieldByTable);
        return {
          fieldId: fieldIds[0],
          fieldIds,
          row: child.migrationGridRow ?? 0,
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
    rows: grid.controlProps?.rows || 1,
    columns: grid.controlProps?.columns || 1,
    fields: gridItems.flatMap((item) => childFieldIds(gridItemFieldRef(item), detailFieldByTable)),
    cells: gridItems.map((item, cellIndex) => {
      const child = gridItemFieldRef(item);
      const fieldIds = childFieldIds(child, detailFieldByTable);
      return {
        fieldId: fieldIds[0],
        fieldIds,
        row: item.controlProps?.migrationGridRow ?? child?.migrationGridRow ?? 0,
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
    required: false,
    columns: (model.fdFields || []).filter((field) => !field.fdIsSystem).map(dataFieldToSummaryField)
  };
}

function dataFieldToSummaryField(field) {
  return {
    id: field.fdName,
    title: field.fdLabel,
    type: field.fdType,
    component: componentFromDataField(field),
    required: nativeRequiredState(field.fdAttribute),
    dataOnly: field.fdDisplay === false,
    columns: []
  };
}

function nativeRequiredState(fdAttribute) {
  if (typeof fdAttribute !== "string" || !fdAttribute.trim()) return undefined;
  try {
    const attribute = JSON.parse(fdAttribute);
    const controlProps = attribute?.config?.controlProps;
    if (!controlProps || typeof controlProps !== "object" || Array.isArray(controlProps)) return undefined;
    if (!Object.hasOwn(controlProps, "required")) return false;
    return typeof controlProps.required === "boolean" ? controlProps.required : undefined;
  } catch {
    return undefined;
  }
}

function detailFieldIdForModel(model) {
  if (model.dynamicProps?.detailFieldName) return model.dynamicProps.detailFieldName;
  const attribute = parseJsonObject(model.fdAttribute || "{}");
  return attribute.config?.controlProps?.["$$detailTableFieldName"] || model.fdTableName || model.fdName;
}

function componentFromDataField(field) {
  const attribute = parseJsonObject(field.fdAttribute || "{}");
  const controlProps = attribute.config?.controlProps || {};
  const desktopType = controlProps.desktop?.type || attribute.config?.type;
  const component = {
    "@elem/xform-input": "xform-input",
    "@elem/xform-textarea": "xform-textarea",
    "@elem/xform-radio": "xform-radio",
    "@elem/xform-checkbox": "xform-checkbox",
    "@elem/xform-select": "xform-select",
    "@elem/xform-select~multi": "xform-select~multi",
    "@elem/xform-datetime": "xform-datetime",
    "@elem/xform-number": "xform-number",
    "@elem/xform-calculate": "xform-calculate",
    "@elem/xform-address": "xform-address",
    "@elem/xform-attach": "xform-attach",
    "@elem/xform-subject": "xform-subject",
    "@elem/xform-description": "xform-description"
  }[desktopType] || field.component || componentForFdType(field.fdType);
  if (component === "xform-select" && controlProps.multi === true) return "xform-select~multi";
  return component;
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
    calculate: "xform-calculate",
    address: "xform-address",
    attachment: "xform-attach",
    subject: "xform-subject",
    desc: "xform-description"
  }[type] || "xform-input";
}

function componentSpec(field) {
  const component = field.componentId;
  if (component === "xform-button") {
    return specForComponent(component, "button", "varchar", "simpleDict", "button", "@elem/xform-button", "@elem/xform-m-button");
  }
  if (component === "xform-subject") {
    return specForComponent(component, "subject", "varchar", "simpleDict", "subject", "@elem/xform-subject", "@elem/xform-m-subject");
  }
  if (component === "xform-address") {
    return specForComponent(component, "address", "address", "orgElementDict", "address", "@elem/xform-address", "@elem/xform-m-address");
  }
  if (component === "xform-radio") {
    return specForComponent(component, "radio", "varchar", "simpleDict", "radio", "@elem/xform-radio", "@elem/xform-m-radio");
  }
  if (component === "xform-select" || component === "xform-select~multi") {
    return specForComponent(component, "select", "varchar", "simpleDict", "select", "@elem/xform-select", "@elem/xform-m-select");
  }
  if (component === "xform-checkbox") {
    return specForComponent(component, "checkbox", "varchar", "simpleDict", "checkbox", "@elem/xform-checkbox", "@elem/xform-m-checkbox");
  }
  if (component === "xform-textarea") {
    return specForComponent(component, "textarea", "clob", "simpleDict", "textarea", "@elem/xform-textarea", "@elem/xform-m-textarea");
  }
  if (component === "xform-datetime") {
    return specForComponent(component, "timestamp", "timestamp", "dateDict", "timestamp", "@elem/xform-datetime", "@elem/xform-m-datetime");
  }
  if (component === "xform-number") {
    return specForComponent(component, "number", "number", "numberDict", "number", "@elem/xform-number", "@elem/xform-m-number");
  }
  if (component === "xform-calculate") {
    return specForComponent(component, "calculate", "number", "numberDict", "calculate", "@elem/xform-calculate", "@elem/xform-m-calculate");
  }
  if (component === "xform-attach") {
    return specForComponent(component, "attachment", "varchar", "attachmentDict", "attachment", "@elem/xform-attach", "@elem/xform-m-attach");
  }
  if (component === "xform-description") {
    return specForComponent(component, "desc", "varchar", "simpleDict", "desc", "@elem/xform-description", "@elem/xform-m-description");
  }
  return specForComponent("xform-input", "text", "varchar", "simpleDict", "text", "@elem/xform-input", "@elem/xform-m-input");
}

function specForComponent(componentId, fdType, fdDataType, fdDictType, attrType, fallbackDesktop, fallbackMobile) {
  const target = componentTarget(componentId, fallbackDesktop, fallbackMobile);
  return spec(fdType, fdDataType, fdDictType, attrType, target.desktop, target.mobile);
}

function componentTarget(componentId, fallbackDesktop, fallbackMobile) {
  const target = COMPONENTS_BY_ID.get(componentId)?.target || {};
  return {
    desktop: target.desktop || fallbackDesktop,
    mobile: target.mobile || fallbackMobile
  };
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
