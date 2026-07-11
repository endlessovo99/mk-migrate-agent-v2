import { PLATFORM_OWNED } from "./invariants.js";
import { decodeRequiredJsonObject, requireArray, requireRecord } from "./decode.js";
import { digestText, normalizeBoolean, normalizeScalar, stableStringify } from "./normalize.js";
import { diagnostic } from "./diagnostics.js";

/**
 * Independently observe native persisted template semantics.
 * Must not import writer traversal/serialization helpers or trust migration markers.
 */
export function observeNativeTemplate(template) {
  const partitions = {
    envelope: { status: "verified", value: null, diagnostics: [] },
    form: { status: "verified", value: null, diagnostics: [] },
    rules: { status: "verified", value: null, diagnostics: [] },
    scripts: { status: "verified", value: null, diagnostics: [] },
    workflow: { status: "verified", value: null, diagnostics: [] }
  };

  partitions.envelope = observeEnvelope(template);

  const xform = template?.mechanisms?.["sys-xform"];
  const configResult = decodeRequiredJsonObject(xform?.fdConfig, {
    partition: "form",
    decodePath: "/mechanisms/sys-xform/fdConfig",
    code: "readback.decode.fdConfig.invalid_json"
  });
  if (!configResult.ok) {
    partitions.form = {
      status: "decode_failed",
      value: null,
      diagnostics: [configResult.diagnostic]
    };
    partitions.rules = {
      status: "decode_failed",
      value: null,
      diagnostics: []
    };
    partitions.scripts = {
      status: "decode_failed",
      value: null,
      diagnostics: []
    };
  } else {
    const formObserved = observeForm(configResult.value, xform);
    partitions.form = formObserved.form;
    partitions.rules = formObserved.rules;
    partitions.scripts = formObserved.scripts;
  }

  const lbpm = template?.mechanisms?.lbpmTemplate?.[0];
  if (!lbpm || (!lbpm.fdContent && lbpm.fdContent !== "")) {
    partitions.workflow = {
      status: "not_expected",
      value: null,
      diagnostics: []
    };
  } else {
    partitions.workflow = observeWorkflow(lbpm);
  }

  return partitions;
}

function observeEnvelope(template) {
  const diagnostics = [];
  const xform = template?.mechanisms?.["sys-xform"];
  const lbpm = template?.mechanisms?.lbpmTemplate?.[0];
  const categoryId = template?.fdCategory?.fdId || "";
  const value = {
    templateId: normalizeScalar(template?.fdId),
    templateName: normalizeScalar(template?.fdName),
    categoryId: normalizeScalar(categoryId),
    tableName: normalizeScalar(xform?.fdTableName || template?.fdTableName),
    lifecycle: {
      draft: true,
      unpublished: true,
      fdStatus: template?.fdStatus ?? 0,
      xformStatus: normalizeScalar(xform?.fdStatus || ""),
      lbpmStatus: normalizeScalar(lbpm?.fdStatus || ""),
      lbpmIsDraft: lbpm ? lbpm.isDraft === true : undefined
    },
    bindings: {
      formFdId: normalizeScalar(xform?.fdId || template?.fdId || ""),
      workflowFdId: normalizeScalar(lbpm?.fdId || "")
    }
  };

  if (!value.templateId) {
    diagnostics.push(diagnostic({
      level: "error",
      code: "readback.decode.envelope.fdId_missing",
      message: "Readback template is missing fdId.",
      partition: "envelope",
      decodePath: "/fdId"
    }));
  }

  return {
    status: diagnostics.length ? "decode_failed" : "verified",
    value,
    diagnostics
  };
}

function observeForm(config, xform) {
  const formDiagnostics = [];
  const rulesDiagnostics = [];
  const scriptsDiagnostics = [];

  const dataModelResult = requireArray(config.dataModel, {
    partition: "form",
    decodePath: "/mechanisms/sys-xform/fdConfig/dataModel",
    code: "readback.decode.dataModel.array_required"
  });
  if (!dataModelResult.ok) {
    return {
      form: { status: "decode_failed", value: null, diagnostics: [dataModelResult.diagnostic] },
      rules: { status: "decode_failed", value: null, diagnostics: [] },
      scripts: { status: "decode_failed", value: null, diagnostics: [] }
    };
  }

  const models = dataModelResult.value;
  const mainModel = models.find((model) => model?.fdType === "main") || models[0];
  const detailModels = models.filter((model) => model?.fdType === "detail");
  if (!mainModel || typeof mainModel !== "object") {
    const item = diagnostic({
      level: "error",
      code: "readback.decode.dataModel.main_missing",
      message: "Readback form dataModel is missing the main model.",
      partition: "form",
      decodePath: "/mechanisms/sys-xform/fdConfig/dataModel"
    });
    return {
      form: { status: "decode_failed", value: null, diagnostics: [item] },
      rules: { status: "decode_failed", value: null, diagnostics: [] },
      scripts: { status: "decode_failed", value: null, diagnostics: [] }
    };
  }

  const mainFields = (mainModel.fdFields || [])
    .filter((field) => field && !isPlatformSystemField(field, "main"))
    .map((field) => observeDataField(field));
  const detailFields = detailModels.map((model) => observeDetailField(model, models.indexOf(model)));
  const fields = [...mainFields, ...detailFields];

  const viewModelResult = requireArray(config.viewModel, {
    partition: "form",
    decodePath: "/mechanisms/sys-xform/fdConfig/viewModel",
    code: "readback.decode.viewModel.array_required"
  });
  let layoutRows = [];
  if (!viewModelResult.ok) {
    formDiagnostics.push(viewModelResult.diagnostic);
  } else {
    layoutRows = observeLayoutRows(viewModelResult.value[0], detailModels, formDiagnostics);
    applyViewControlStyles(fields, viewModelResult.value[0]);
  }

  const attribute = config.attribute && typeof config.attribute === "object" ? config.attribute : {};
  const formAttrResult = decodeRequiredJsonObject(attribute.formAttr, {
    partition: "form",
    decodePath: "/mechanisms/sys-xform/fdConfig/attribute/formAttr",
    code: "readback.decode.formAttr.invalid_json"
  });

  let rulesValue = { rules: [] };
  let scriptsValue = { actions: [] };
  let subjectRule;
  let rulesStatus = "verified";
  let scriptsStatus = "verified";

  if (!formAttrResult.ok) {
    // formAttr is required for rules/scripts; form structure can still be compared
    rulesStatus = "decode_failed";
    scriptsStatus = "decode_failed";
    rulesDiagnostics.push(formAttrResult.diagnostic);
  } else {
    const formAttr = formAttrResult.value;
    subjectRule = formAttr.subjectRule;
    rulesValue = observeRules(formAttr.formRule || {}, detailModels, rulesDiagnostics);
    scriptsValue = observeScripts(formAttr.controlAction || {}, scriptsDiagnostics);
  }

  const formValue = {
    fields,
    layoutRows,
    tableName: normalizeScalar(mainModel.fdTableName || xform?.fdTableName || ""),
    subjectRule,
    persistence: {
      models: models.map((model, modelIndex) => observeModelIdentity(model, modelIndex)),
      detailModels: detailFields.map((field) => field.persistence)
    }
  };

  return {
    form: {
      status: formDiagnostics.some((item) => item.level === "error") ? "decode_failed" : "verified",
      value: formValue,
      diagnostics: formDiagnostics
    },
    rules: {
      status: rulesStatus === "decode_failed" || rulesDiagnostics.some((item) => item.level === "error")
        ? "decode_failed"
        : "verified",
      value: rulesValue,
      diagnostics: rulesDiagnostics
    },
    scripts: {
      status: scriptsStatus === "decode_failed" || scriptsDiagnostics.some((item) => item.level === "error")
        ? "decode_failed"
        : "verified",
      value: scriptsValue,
      diagnostics: scriptsDiagnostics
    }
  };
}

function observeDataField(field) {
  const attributeResult = decodeFieldAttribute(field.fdAttribute);
  const controlProps = attributeResult?.config?.controlProps || {};
  const props = observeExecutableProps(controlProps);
  // Malformed attributes cannot prove required/component persistence.
  if (attributeResult === null && field.fdDisplay !== false) {
    return {
      id: normalizeScalar(field.fdName),
      title: normalizeScalar(field.fdLabel || ""),
      type: field.fdType || "text",
      component: "",
      dataOnly: field.fdDisplay === false,
      props: {},
      columns: [],
      attributeCorrupt: true
    };
  }
  return {
    id: normalizeScalar(field.fdName),
    title: normalizeScalar(field.fdLabel || controlProps.title || ""),
    type: inferFieldType(field, controlProps),
    component: inferComponent(field, controlProps),
    dataOnly: field.fdDisplay === false,
    props,
    columns: []
  };
}

function decodeFieldAttribute(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function observeDetailField(model, modelIndex) {
  const columns = (model.fdFields || [])
    .map((field, fieldIndex) => ({ field, fieldIndex }))
    .filter(({ field }) => field && !isPlatformSystemField(field, "detail"))
    .map(({ field, fieldIndex }) => {
      const attribute = safeParseObject(field.fdAttribute);
      const controlProps = attribute?.config?.controlProps || {};
      return {
        id: normalizeScalar(field.fdName),
        title: normalizeScalar(field.fdLabel || controlProps.title || ""),
        type: inferFieldType(field, controlProps),
        component: inferComponent(field, controlProps),
        props: observeExecutableProps(controlProps),
        persistence: {
          fieldIndex,
          mechanismType: normalizeScalar(field.fdMechanismType),
          columnName: normalizeScalar(field.fdColumn),
          dataModel: {
            id: normalizeScalar(field.fdDataModel?.fdId),
            name: normalizeScalar(field.fdDataModel?.fdName)
          },
          controlBinding: observeNativeControlBinding(field.fdAttribute)
        }
      };
    });
  const controlBinding = observeNativeControlBinding(model.fdAttribute);
  return {
    id: normalizeScalar(detailFieldNameForModel(model)),
    title: normalizeScalar(model.fdName),
    type: "detailTable",
    component: "xform-detail-table",
    dataOnly: false,
    props: {},
    columns,
    persistence: {
      fieldId: normalizeScalar(detailFieldNameForModel(model)),
      modelIndex,
      modelId: normalizeScalar(model.fdId),
      modelName: normalizeScalar(model.fdName),
      tableName: normalizeScalar(model.fdTableName),
      tableNameAlias: normalizeScalar(model.fdTableNameAlias),
      controlBinding,
      columns: columns.map((column) => ({
        id: column.id,
        ...column.persistence
      }))
    }
  };
}

function observeModelIdentity(model, modelIndex) {
  return {
    modelIndex,
    modelId: normalizeScalar(model?.fdId),
    modelName: normalizeScalar(model?.fdName),
    modelType: normalizeScalar(model?.fdType),
    tableName: normalizeScalar(model?.fdTableName)
  };
}

function observeNativeControlBinding(value) {
  const attribute = decodeFieldAttribute(value);
  const controlProps = attribute?.config?.controlProps;
  const readable = Boolean(
    attribute &&
    controlProps &&
    typeof controlProps === "object" &&
    !Array.isArray(controlProps)
  );
  return {
    readable,
    detailFieldId: normalizeScalar(controlProps?.["$$detailTableFieldName"]),
    fieldName: normalizeScalar(controlProps?.name || controlProps?.uuid),
    tableType: normalizeScalar(controlProps?.["$$tableType"]),
    tableName: normalizeScalar(controlProps?.["$$tableName"])
  };
}

function observeExecutableProps(controlProps = {}) {
  const props = {};
  if (controlProps.required === true) props.required = true;
  if (Array.isArray(controlProps.options) && controlProps.options.length) {
    props.options = controlProps.options.map((option) => ({
      label: normalizeScalar(option.label ?? option.text ?? option.value),
      value: normalizeScalar(option.value ?? option.label ?? option.text)
    }));
  }
  if (controlProps.multi === true) props.multi = true;
  if (controlProps.content !== undefined) props.content = normalizeScalar(controlProps.content);
  if (controlProps.maxLength !== undefined) props.maxLength = controlProps.maxLength;
  return props;
}

function applyViewControlStyles(fields, viewModel) {
  const scene = safeParseObject(viewModel?.fdConfig);
  const controlStyle = scene.controlStyle && typeof scene.controlStyle === "object" && !Array.isArray(scene.controlStyle)
    ? scene.controlStyle
    : {};
  for (const field of fields) {
    if (field?.component !== "xform-description") continue;
    const value = controlStyle[field.id]?.desktop?.controlValueStyle;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const style = {};
    if (typeof value.color === "string" && value.color.trim()) style.color = value.color.trim();
    if (typeof value.fontWeight === "string" && value.fontWeight.trim()) style.fontWeight = value.fontWeight.trim();
    if (Object.keys(style).length) field.props.style = style;
  }
}

function observeLayoutRows(viewModel, detailModels, diagnostics) {
  const detailByTable = new Map(
    detailModels.map((model) => [model.fdTableName, detailFieldNameForModel(model)])
  );
  const sceneConfigResult = decodeRequiredJsonObject(viewModel?.fdConfig, {
    partition: "form",
    decodePath: "/mechanisms/sys-xform/fdConfig/viewModel/0/fdConfig",
    code: "readback.decode.viewModel.fdConfig_invalid_json"
  });
  if (!sceneConfigResult.ok) {
    diagnostics.push(sceneConfigResult.diagnostic);
    return [];
  }

  const desktopRoots = sceneConfigResult.value?.view?.render?.desktop;
  const root = Array.isArray(desktopRoots) ? desktopRoots[0] : undefined;
  if (!root || typeof root !== "object") {
    diagnostics.push(diagnostic({
      level: "error",
      code: "readback.decode.viewModel.render_missing",
      message: "Readback viewModel is missing desktop render.",
      partition: "form",
      decodePath: "/mechanisms/sys-xform/fdConfig/viewModel/0/fdConfig/view/render/desktop"
    }));
    return [];
  }

  const main = (root.children || []).find((child) => child?.key === "main") || root.children?.[0];
  const rows = Array.isArray(main?.children) ? main.children : [];
  return rows.map((row, rowIndex) => observeNativeLayoutRow(row, rowIndex, detailByTable)).filter(Boolean);
}

function observeNativeLayoutRow(row, rowIndex, detailByTable) {
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
    // Structural identity is order + membership; native keys are not DSL row ids.
    id: `row-${rowIndex}`,
    order: rowIndex,
    cells: gridItems.map((item, cellIndex) => {
      const fieldIds = (Array.isArray(item.children) ? item.children : [])
        .flatMap((fieldRef) => nativeFieldIdsFromRef(fieldRef, detailByTable))
        .filter(Boolean);
      const column = Number.isInteger(item.controlProps?.column)
        ? item.controlProps.column - 1
        : cellIndex;
      const colspan = Number.isInteger(item.controlProps?.colSpan)
        ? item.controlProps.colSpan
        : 1;
      return {
        id: normalizeScalar(item.key || `cell-${cellIndex}`),
        fieldIds,
        column,
        colspan
      };
    })
  };
}

function nativeFieldIdsFromRef(fieldRef, detailByTable) {
  if (!fieldRef || typeof fieldRef !== "object") return [];
  if (detailByTable.has(fieldRef.key)) return [normalizeScalar(detailByTable.get(fieldRef.key))];
  if (fieldRef.key) return [normalizeScalar(fieldRef.key)];
  return [];
}

function observeRules(formRule, detailModels = [], diagnostics) {
  void diagnostics;
  const detailByTable = new Map(
    detailModels.map((model) => [model.fdTableName, detailFieldNameForModel(model)])
  );
  const display = Array.isArray(formRule.display) ? formRule.display : [];
  const require = Array.isArray(formRule.require) ? formRule.require : [];
  const rules = [
    ...display.map((rule) => observeNativeRule(rule, "display", detailByTable)),
    ...require.map((rule) => observeNativeRule(rule, "require", detailByTable))
  ].filter(Boolean);
  return { rules };
}

function observeNativeRule(rule, kind, detailByTable = new Map()) {
  if (!rule || typeof rule !== "object") return null;
  const conditions = (rule.choices?.items || []).map((item) => ({
    field: normalizeScalar(item.fieldName || item.fieldKey),
    op: denormalizeOperator(item.operate),
    value: item.value?.script === "" || item.value?.script === undefined
      ? ""
      : normalizeRuleValue(item.value?.script ?? item.value)
  }));
  const effects = (Array.isArray(rule.result) ? rule.result : []).map((result) => {
    const target = observeRuleResultTarget(result, detailByTable);
    if (kind === "display") {
      return {
        target,
        visible: result.displayFlag !== "hide"
      };
    }
    return {
      target,
      required: result.required === "required" || result.required === true
    };
  });
  return {
    kind,
    logic: rule.condition === "2" ? "or" : "and",
    conditions,
    effects,
    // provenance ignored for verification; retained only for debugging summaries
    provenanceIgnored: true
  };
}

function observeRuleResultTarget(result, detailByTable) {
  if (result?.tableType === "detail" && result?.type && detailByTable.has(result.type)) {
    return normalizeScalar(detailByTable.get(result.type));
  }
  if (Array.isArray(result?.fieldName)) {
    if (result.fieldName[0] === "all" && result?.type && detailByTable.has(result.type)) {
      return normalizeScalar(detailByTable.get(result.type));
    }
    return normalizeScalar(result.fieldName.find((name) => name && name !== "all") || result.fieldName[0]);
  }
  return normalizeScalar(result?.fieldName || result?.fieldKey);
}

function detailFieldNameForModel(model) {
  const attribute = decodeFieldAttribute(model?.fdAttribute);
  const attributeFieldName = attribute?.config?.controlProps?.["$$detailTableFieldName"];
  if (attributeFieldName) return attributeFieldName;
  if (model?.dynamicProps?.detailFieldName) return model.dynamicProps.detailFieldName;
  const tableName = typeof model?.fdTableName === "string" ? model.fdTableName.trim() : "";
  if (tableName.startsWith("mk_model_")) {
    const fieldName = tableName.slice("mk_model_".length);
    if (fieldName) return fieldName;
  }
  return model?.fdName;
}

function observeScripts(controlAction, diagnostics) {
  void diagnostics;
  const global = controlAction.global && typeof controlAction.global === "object" ? controlAction.global : {};
  const control = controlAction.control && typeof controlAction.control === "object" ? controlAction.control : {};
  const actions = [];

  for (const [event, entries] of Object.entries(global)) {
    for (const action of Array.isArray(entries) ? entries : []) {
      actions.push(...observePersistedActions(action, { event, scope: "global" }));
    }
  }
  for (const [controlKey, byEvent] of Object.entries(control)) {
    for (const [event, entries] of Object.entries(byEvent || {})) {
      for (const action of Array.isArray(entries) ? entries : []) {
        actions.push(...observePersistedActions(action, {
          event,
          scope: "control",
          controlKey
        }));
      }
    }
  }

  return { actions };
}

function observePersistedActions(action, context) {
  if (!action || typeof action !== "object") return [];
  const functionText = typeof action.function === "string" ? action.function : "";
  const nested = extractNestedFunctions(functionText);
  if (context.event === "onLoad" && context.scope === "global" && nested.length >= 1 && /onLoad_\d+/.test(functionText)) {
    // Dispatcher wraps one child function per expected action; compare children, not the wrapper.
    return nested.map((part) => ({
      id: undefined,
      event: context.event,
      scope: context.scope,
      controlKey: context.controlKey,
      bodyDigest: digestText(canonicalizeScriptBody(part.function)),
      runWhen: observeRunWhenFromFunction(part.function),
      hasCanonicalGuard: hasCanonicalGuard(part.function, context.event),
      rawFunction: part.function
    }));
  }

  return [{
    id: typeof action.id === "string" ? action.id : undefined,
    event: context.event,
    scope: context.scope,
    controlKey: context.controlKey,
    bodyDigest: digestText(canonicalizeScriptBody(functionText)),
    runWhen: observeRunWhenFromFunction(functionText),
    hasCanonicalGuard: hasCanonicalGuard(functionText, context.event),
    rawFunction: functionText
  }];
}

function extractNestedFunctions(source = "") {
  const all = extractAllFunctions(source);
  if (all.length <= 1) return all;
  const outer = all[0];
  const nested = all.filter((part) => part.start > outer.start && part.end < outer.end);
  return nested.length ? nested : all;
}

function extractAllFunctions(source = "") {
  const text = String(source);
  const parts = [];
  const re = /\bfunction\s+([A-Za-z0-9_]+)\s*\(/g;
  let match = re.exec(text);
  while (match) {
    const name = match[1];
    const start = match.index;
    const bodyStart = text.indexOf("{", start);
    if (bodyStart < 0) break;
    let depth = 0;
    let end = -1;
    for (let index = bodyStart; index < text.length; index += 1) {
      if (text[index] === "{") depth += 1;
      if (text[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end < 0) break;
    parts.push({
      name,
      start,
      end,
      function: text.slice(start, end)
    });
    match = re.exec(text);
  }
  return parts;
}

function observeRunWhenFromFunction(source = "") {
  const statuses = extractViewStatusGuard(source);
  if (!statuses?.length) return undefined;
  return { viewStatusIn: statuses };
}

function extractViewStatusGuard(source = "") {
  const text = String(source);
  const matches = [...text.matchAll(/MKXFORM\.viewStatus\s*!==\s*["']([^"']+)["']/g)];
  if (!matches.length) return undefined;
  return matches.map((match) => match[1]);
}

function hasCanonicalGuard(source, event) {
  const statuses = extractViewStatusGuard(source);
  if (!statuses?.length) return false;
  const fallback = event === "onBeforeSubmit" ? "return true" : "return";
  const condition = statuses.map((status) => `MKXFORM.viewStatus !== ${JSON.stringify(status)}`).join(" && ");
  return String(source).includes(`if (${condition}) ${fallback}`);
}

function observeWorkflow(lbpm) {
  const diagnostics = [];
  const contentResult = decodeRequiredJsonObject(lbpm.fdContent, {
    partition: "workflow",
    decodePath: "/mechanisms/lbpmTemplate/0/fdContent",
    code: "readback.decode.fdContent.invalid_json"
  });
  if (!contentResult.ok) {
    return {
      status: "decode_failed",
      value: null,
      diagnostics: [contentResult.diagnostic]
    };
  }

  const content = contentResult.value;
  const elementsResult = requireArray(content.elements, {
    partition: "workflow",
    decodePath: "/mechanisms/lbpmTemplate/0/fdContent/elements",
    code: "readback.decode.fdContent.elements_array_required"
  });
  if (!elementsResult.ok) {
    return {
      status: "decode_failed",
      value: null,
      diagnostics: [elementsResult.diagnostic]
    };
  }

  const elements = elementsResult.value;
  const nodes = elements.filter((element) => element && element.type !== "sequenceFlow");
  const edges = elements.filter((element) => element && element.type === "sequenceFlow");
  const autoConditionBranchNodeIds = new Set(
    nodes
      .filter((node) => node?.type === "conditionBranch" && String(node.conditionType || "1") !== "2")
      .map((node) => node.id)
  );
  const initiatorSelectTargetNodeIds = collectInitiatorSelectTargetNodeIds(nodes);
  const formAuths = lbpm.fdTemplateFormAuths && typeof lbpm.fdTemplateFormAuths === "object"
    ? lbpm.fdTemplateFormAuths
    : {};

  const value = {
    readable: true,
    nodes: nodes.map((node) => ({
      id: normalizeScalar(node.id),
      name: normalizeScalar(node.name || node.attributes?.name || ""),
      type: normalizeScalar(node.type),
      element: normalizeScalar(node.element),
      mustModifyHandlerNodeIds: splitRelatedNodeIds(node.mustModifyHandlerNodes),
      canModifyHandlerNodeIds: splitRelatedNodeIds(node.canModifyHandlerNodes),
      participants: observeParticipants(node, initiatorSelectTargetNodeIds.has(node.id)),
      alternativeParticipants: observeAlternativeParticipants(node),
      sendConfig: observeSendConfig(node),
      dataAuthority: observeDataAuthority(formAuths[node.id]),
      ignoreOnSameIdentity: node.ignoreOnSameIdentity === undefined
        ? undefined
        : normalizeScalar(node.ignoreOnSameIdentity),
      // presentation-only fields intentionally omitted from error comparison
      x: node.x,
      y: node.y
    })),
    edges: edges.map((edge) => ({
      id: normalizeScalar(edge.id),
      source: normalizeScalar(edge.sourceRef),
      target: normalizeScalar(edge.targetRef),
      isDefault: nativeBoolean(edge.defaultTrend) ||
        nativeBoolean(edge.isDefault) ||
        nativeBoolean(edge.attributes?.isDefault),
      branch: normalizeScalar(edge.branch || edge.attributes?.branch || ""),
      condition: observeEdgeCondition(edge, autoConditionBranchNodeIds.has(edge.sourceRef)),
      waypoints: edge.waypoints
    }))
  };

  return {
    status: diagnostics.length ? "decode_failed" : "verified",
    value,
    diagnostics
  };
}

function observeFormulaFieldId(handlers, node) {
  const candidates = [];
  const varIds = Array.isArray(handlers?.ruleKey?.varIds) ? handlers.ruleKey.varIds : [];
  for (const varId of varIds) {
    candidates.push(normalizeScalar(varId));
  }
  candidates.push(normalizeScalar(handlers?.ruleKey?.script));
  candidates.push(normalizeScalar(node?.handlerIds));
  for (const text of candidates) {
    if (!text) continue;
    const match = text.match(/(fd_[A-Za-z0-9_]+)\s*$/) || text.match(/\$\{data\.[^.}]*?(fd_[A-Za-z0-9_]+)\}/) || text.match(/\$(fd_[A-Za-z0-9_]+)\$/);
    if (match) return match[1];
  }
  return undefined;
}

function observeRoleLineParticipants(script, formulaName, fieldId) {
  const expression = [script, formulaName].find((value) => /组织架构\.解释角色线/.test(value));
  if (!expression) return undefined;

  const roles = observeRoleLineRoles(expression);
  const nodeMatch = expression.match(/\$流程\.获取节点实际处理人\$\s*\(\s*["']([^"']+)["']\s*\)/);
  if (nodeMatch) {
    return {
      mode: "role_line",
      subjectKind: "node_handlers",
      nodeId: nodeMatch[1],
      ...roles
    };
  }
  return fieldId
    ? { mode: "role_line", subjectKind: "field", fieldId, ...roles }
    : { mode: "role_line", ...roles };
}

function observeParticipantFormula(handlers, node) {
  const ruleKey = handlers?.ruleKey && typeof handlers.ruleKey === "object"
    ? handlers.ruleKey
    : {};
  return {
    script: normalizeScalar(ruleKey.script),
    varIds: Array.isArray(ruleKey.varIds) ? ruleKey.varIds.map(normalizeScalar) : [],
    handlerSelectType: normalizeScalar(node?.handlerSelectType),
    handlersType: normalizeScalar(handlers?.type),
    handlersSource: normalizeScalar(handlers?.source),
    handlersElement: normalizeScalar(handlers?.element),
    memberCount: Array.isArray(handlers?.members) ? handlers.members.length : -1,
    ruleMode: normalizeScalar(handlers?.ruleMode),
    formulaType: normalizeScalar(handlers?.formulaType),
    ruleKeyType: normalizeScalar(ruleKey.type),
    ruleKeyMode: normalizeScalar(ruleKey.mode),
    ruleVoMode: normalizeScalar(ruleKey.vo?.mode),
    resultType: observeParticipantResultType(ruleKey.resultType)
  };
}

function observeParticipantResultType(resultType) {
  if (resultType === undefined) return "none";
  const properties = resultType?.items?.properties;
  if (
    resultType?.type === "array" &&
    resultType?.items?.type === "object" &&
    properties?.fdId?.type === "string" &&
    properties?.fdName?.type === "string" &&
    properties?.fdOrgType?.type === "string"
  ) {
    return "org_array";
  }
  return `invalid:${stableStringify(resultType)}`;
}

function observeRoleLineRoles(expression) {
  const match = String(expression || "").match(
    /,\s*("(?:\\.|[^"\\])*")\s*,\s*("(?:\\.|[^"\\])*")\s*\)\s*$/
  );
  if (!match) return {};
  try {
    return {
      companyRole: JSON.parse(match[1]),
      departmentRole: JSON.parse(match[2])
    };
  } catch {
    return {};
  }
}

function observeParticipants(node, initiatorSelectTarget) {
  const handlers = node?.handlers;
  if (initiatorSelectTarget) {
    return {
      mode: "initiator_select",
      handlersType: normalizeScalar(handlers?.type),
      handlersSource: normalizeScalar(handlers?.source),
      handlersRuleKey: normalizeScalar(handlers?.ruleKey),
      handlersRuleName: normalizeScalar(handlers?.ruleName),
      handlersElement: normalizeScalar(handlers?.element),
      members: observeNativeMembers(handlers?.members)
    };
  }
  if (!handlers || typeof handlers !== "object") return undefined;
  if (handlers.type === "formula" || handlers.source === "2") {
    const fieldId = observeFormulaFieldId(handlers, node);
    const nativeFormula = observeParticipantFormula(handlers, node);
    const script = normalizeScalar(handlers?.ruleKey?.script) || "";
    const formulaName = normalizeScalar(handlers?.ruleName) ||
      normalizeScalar(handlers?.ruleKey?.formulaName) ||
      normalizeScalar(handlers?.ruleKey?.vo?.content) ||
      "";
    const roleLine = observeRoleLineParticipants(script, formulaName, fieldId);
    if (roleLine) return { ...roleLine, nativeFormula };
    if (/getPersonByLoginName/.test(script)) {
      return fieldId
        ? { mode: "person_by_login_name", fieldId, nativeFormula }
        : { mode: "person_by_login_name", nativeFormula };
    }
    if (/根据部门编号获取部门领导/.test(script) || /根据部门编号获取部门领导/.test(formulaName)) {
      return fieldId
        ? { mode: "dept_leader_by_no", fieldId, nativeFormula }
        : { mode: "dept_leader_by_no", nativeFormula };
    }
    if (
      /data\._ProcessCreator|process\.docCreator/.test(script) ||
      /流程数据项\.起草人/.test(formulaName) ||
      /^(?:\$)?(?:docCreator|申请人|起草人)(?:\$)?$/i.test(formulaName) ||
      /\$docCreator\$|\$申请人\$|\$起草人\$/i.test(formulaName)
    ) {
      return { mode: "doc_creator", nativeFormula };
    }
    return fieldId
      ? { mode: "form_field", fieldId, nativeFormula }
      : { mode: "form_field", nativeFormula };
  }
  if (handlers.source === "1" || Array.isArray(handlers.members)) {
    return {
      mode: "explicit",
      handlersType: normalizeScalar(handlers.type),
      handlersSource: normalizeScalar(handlers.source),
      handlersRuleKey: normalizeScalar(handlers.ruleKey),
      handlersRuleName: normalizeScalar(handlers.ruleName),
      handlersElement: normalizeScalar(handlers.element),
      members: observeNativeMembers(handlers.members)
    };
  }
  return {
    mode: normalizeScalar(handlers.source || handlers.type || "")
  };
}

function observeNativeMembers(members) {
  return (members || [])
    .map((member) => ({
      id: normalizeScalar(member.id || member.fdId),
      element: normalizeScalar(member.element),
      type: normalizeScalar(member.type)
    }))
    .filter((member) => member.id)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function observeAlternativeParticipants(node) {
  const handlers = node?.alternativeHandlers;
  const hasAlternativeConfig = handlers && typeof handlers === "object" ||
    node?.isUseAlternativeHandlerOnly !== undefined;
  if (!hasAlternativeConfig) return undefined;

  return {
    handlersType: normalizeScalar(handlers?.type),
    handlersSource: normalizeScalar(handlers?.source),
    handlersRuleKey: normalizeScalar(handlers?.ruleKey),
    handlersRuleName: normalizeScalar(handlers?.ruleName),
    handlersElement: normalizeScalar(handlers?.element),
    useAlternativeOnly: nativeBoolean(node?.isUseAlternativeHandlerOnly),
    members: (handlers?.members || [])
      .map((member) => ({
        id: normalizeScalar(member.id || member.fdId),
        element: normalizeScalar(member.element),
        type: normalizeScalar(member.type)
      }))
      .filter((member) => member.id)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
  };
}

function nativeBoolean(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return value === true || value === 1 || normalized === "true" || normalized === "1";
}

function collectInitiatorSelectTargetNodeIds(nodes = []) {
  const targetNodeIds = new Set();
  for (const node of nodes) {
    for (const attribute of ["mustModifyHandlerNodes", "canModifyHandlerNodes"]) {
      for (const targetNodeId of splitRelatedNodeIds(node?.[attribute])) {
        targetNodeIds.add(targetNodeId);
      }
    }
  }
  return targetNodeIds;
}

function splitRelatedNodeIds(value = "") {
  return [...new Set(
    String(value || "").split(/[;,，\s]+/).map((item) => item.trim()).filter(Boolean)
  )];
}

function observeDataAuthority(auth) {
  if (!auth || typeof auth !== "object") return undefined;
  return {
    enabled: true,
    fields: Object.fromEntries(
      Object.entries(auth).map(([fieldId, value]) => [fieldId, {
        visible: normalizeBoolean(value?.isShow),
        editable: normalizeBoolean(value?.isEdit),
        required: normalizeBoolean(value?.isRequire)
      }])
    )
  };
}

function observeSendConfig(node) {
  if (normalizeScalar(node?.type) !== "send") return undefined;
  return {
    modifyProcessAuthority: normalizeScalar(node.modifyProcessAuthority),
    systemNotifyType: normalizeScalar(node.systemNotifyType),
    languageNameUs: normalizeScalar(node.language?.nameUs)
  };
}

function observeEdgeCondition(edge, autoConditionBranch = false) {
  const formulaRaw = edge?.formula;
  const formulaText = typeof formulaRaw === "string"
    ? formulaRaw
    : formulaRaw && typeof formulaRaw === "object"
      ? stableStringify(formulaRaw)
      : "";
  const trimmedFormula = formulaText.trim();

  // Manual decision outlets (conditionType=2) persist named rule formulas, not Batch JSON.
  if (!autoConditionBranch && edge?.formulaType === "rule") {
    if (!trimmedFormula) {
      return withConditionProvenance(edge, { nativeKind: "rule", nativeStatus: "missing" });
    }
    return withConditionProvenance(edge, {
      nativeKind: "rule",
      nativeStatus: "ok",
      text: normalizeScalar(trimmedFormula),
      hasForbiddenLiteral: hasForbiddenConditionLiteral(trimmedFormula)
    });
  }

  const looksLikeBatch = autoConditionBranch ||
    edge?.formulaType === "formula" ||
    trimmedFormula.startsWith("{") ||
    trimmedFormula.startsWith("[");

  if (looksLikeBatch) {
    if (!trimmedFormula) {
      return withConditionProvenance(edge, { nativeKind: "batch_formula", nativeStatus: "missing" });
    }
    if (autoConditionBranch && edge?.formulaType !== "formula") {
      return withConditionProvenance(edge, {
        nativeKind: "batch_formula",
        nativeStatus: "corrupt",
        reason: "condition_branch_formula_type",
        hasForbiddenLiteral: hasForbiddenConditionLiteral(trimmedFormula)
      });
    }
    let parsed;
    try {
      parsed = typeof formulaRaw === "string" ? JSON.parse(trimmedFormula) : formulaRaw;
    } catch {
      return withConditionProvenance(edge, {
        nativeKind: "batch_formula",
        nativeStatus: "corrupt",
        reason: "invalid_json",
        hasForbiddenLiteral: hasForbiddenConditionLiteral(trimmedFormula)
      });
    }
    if (!isValidBatchConditionFormula(parsed)) {
      return withConditionProvenance(edge, {
        nativeKind: "batch_formula",
        nativeStatus: "corrupt",
        reason: "invalid_batch_shape",
        hasForbiddenLiteral: hasForbiddenConditionLiteral(trimmedFormula)
      });
    }
    return withConditionProvenance(edge, {
      nativeKind: "batch_formula",
      nativeStatus: "ok",
      hasForbiddenLiteral: hasForbiddenConditionLiteral(trimmedFormula),
      formulaDigest: digestText(normalizeScalar(trimmedFormula)),
      ...observeBatchConditionSemantics(parsed)
    });
  }

  if (edge?.formulaType === "rule" || edge?.formula !== undefined) {
    if (!trimmedFormula) {
      return withConditionProvenance(edge, { nativeKind: "rule", nativeStatus: "missing" });
    }
    if (edge?.formulaType !== "rule") {
      return withConditionProvenance(edge, {
        nativeKind: "rule",
        nativeStatus: "corrupt",
        reason: "rule_formula_type",
        hasForbiddenLiteral: hasForbiddenConditionLiteral(trimmedFormula)
      });
    }
    return withConditionProvenance(edge, {
      nativeKind: "rule",
      nativeStatus: "ok",
      text: normalizeScalar(trimmedFormula),
      hasForbiddenLiteral: hasForbiddenConditionLiteral(trimmedFormula)
    });
  }

  const text = edge?.condition ||
    edge?.attributes?.condition ||
    edge?.outgoingCondition ||
    edge?.formulaName ||
    "";
  if (!String(text).trim()) return undefined;
  return withConditionProvenance(edge, {
    nativeKind: "rule",
    nativeStatus: "missing",
    text: normalizeScalar(typeof text === "string" ? text : stableStringify(text)),
    hasForbiddenLiteral: hasForbiddenConditionLiteral(text)
  });
}

function isValidBatchConditionFormula(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.type === "Batch" &&
      Array.isArray(value.vars) &&
      value.result &&
      typeof value.result === "object" &&
      !Array.isArray(value.result) &&
      value.vo &&
      typeof value.vo === "object" &&
      !Array.isArray(value.vo)
  );
}

function observeBatchConditionSemantics(formula) {
  const referencedVarKeys = new Set(
    [...String(formula?.result?.value || "").matchAll(/\$\{data\.\$VAR\.([^}]+)\}/g)]
      .map((match) => String(match[1] || "").trim())
      .filter(Boolean)
  );
  const functionIds = new Set();
  const orgIds = new Set();

  for (const variable of Array.isArray(formula?.vars) ? formula.vars : []) {
    if (!variable || !referencedVarKeys.has(String(variable.key || ""))) continue;
    if (variable.type !== "Function" || typeof variable.value !== "string") continue;

    const functionId = variable.value.trim();
    if (!functionId) continue;
    functionIds.add(functionId);
    if (functionId !== "sysorg.isOrganizationBelongOrIncludeAnother") continue;

    for (const argument of Array.isArray(variable.arguments) ? variable.arguments : []) {
      if (argument?.key !== "secondOrgs" || argument?.type !== "Fixed") continue;
      for (const org of Array.isArray(argument.value) ? argument.value : []) {
        const fdId = String(org?.fdId || "").trim();
        if (fdId) orgIds.add(fdId);
      }
    }
  }

  return {
    functionIds: [...functionIds].sort(),
    orgIds: [...orgIds].sort()
  };
}

function withConditionProvenance(edge, native) {
  const migrationSource = edge?.migrationSource;
  if (!migrationSource || typeof migrationSource !== "object" || Array.isArray(migrationSource)) {
    return native;
  }
  const provenance = {
    sourceText: normalizeScalar(migrationSource.condition || ""),
    targetText: normalizeScalar(migrationSource.targetText || ""),
    displayText: normalizeScalar(migrationSource.displayCondition || "")
  };
  if (!Object.values(provenance).some((value) => String(value).trim())) return native;
  return { ...native, provenance };
}

function hasForbiddenConditionLiteral(value) {
  return /\bu0021\b/i.test(String(value || ""));
}

function isPlatformSystemField(field, tableType) {
  if (field.fdIsSystem === true) return true;
  const allow = tableType === "detail"
    ? PLATFORM_OWNED.detailSystemFieldNames
    : PLATFORM_OWNED.mainSystemFieldNames;
  return allow.includes(field.fdName);
}

function inferComponent(field, controlProps) {
  const desktop = String(controlProps?.desktop?.type || controlProps?.type || "");
  const normalized = desktop.replace(/^@elem\//, "");
  const multi = controlProps?.multi === true;
  if (normalized === "xform-select" && multi) return "xform-select~multi";
  if (normalized === "xform-select" || normalized === "select") {
    return multi ? "xform-select~multi" : "xform-select";
  }
  if (normalized.startsWith("xform-")) return multi && normalized === "xform-select" ? "xform-select~multi" : normalized;
  if (normalized === "textarea") return "xform-textarea";
  if (normalized === "attachment") return "xform-attachment";
  if (normalized === "datetime" || normalized === "timestamp") return "xform-datetime";
  if (normalized === "address") return "xform-address";
  if (normalized === "desc" || normalized === "description") return "xform-desc";
  if (normalized === "input" || normalized === "text") return "xform-input";
  if (field.fdType === "detailTable") return "xform-detail-table";
  return normalized || field.fdType || "";
}

function inferFieldType(field, controlProps) {
  if (field.fdType && field.fdType !== "varchar") return field.fdType;
  const component = inferComponent(field, controlProps);
  if (component.includes("select")) return "select";
  if (component.includes("textarea")) return "textarea";
  if (component.includes("attachment")) return "attachment";
  if (component.includes("datetime")) return "datetime";
  if (component.includes("address")) return "address";
  if (component.includes("desc")) return "desc";
  return "text";
}

function denormalizeOperator(operate) {
  const map = {
    "=": "eq",
    "!=": "ne",
    include: "contains",
    notInclude: "notContains",
    $contains: "in",
    empty: "empty",
    notEmpty: "notEmpty"
  };
  return map[operate] || operate;
}

function normalizeRuleValue(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeScalar(item));
  return normalizeScalar(value);
}

function canonicalizeScriptBody(source) {
  return String(source || "")
    .replace(/\/\*\s*mk-migrate:[^*]+?\*\//g, "")
    .replace(/\bif\s*\(\s*MKXFORM\.viewStatus\s*!==[\s\S]*?\)\s*(return true|return)\s*;?/g, "")
    .replace(/\bfunction\s+[A-Za-z0-9_]+\s*\(/g, "function __fn(")
    .replace(/\s+/g, " ")
    .trim();
}

function safeParseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
