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
  const detailFields = detailModels.map((model) => observeDetailField(model));
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
  }

  const attribute = config.attribute && typeof config.attribute === "object" ? config.attribute : {};
  const formAttrResult = decodeRequiredJsonObject(attribute.formAttr, {
    partition: "form",
    decodePath: "/mechanisms/sys-xform/fdConfig/attribute/formAttr",
    code: "readback.decode.formAttr.invalid_json"
  });

  let rulesValue = { rules: [] };
  let scriptsValue = { actions: [] };
  let rulesStatus = "verified";
  let scriptsStatus = "verified";

  if (!formAttrResult.ok) {
    // formAttr is required for rules/scripts; form structure can still be compared
    rulesStatus = "decode_failed";
    scriptsStatus = "decode_failed";
    rulesDiagnostics.push(formAttrResult.diagnostic);
  } else {
    const formAttr = formAttrResult.value;
    rulesValue = observeRules(formAttr.formRule || {}, rulesDiagnostics);
    scriptsValue = observeScripts(formAttr.controlAction || {}, scriptsDiagnostics);
  }

  const formValue = {
    fields,
    layoutRows,
    tableName: normalizeScalar(mainModel.fdTableName || xform?.fdTableName || "")
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

function observeDetailField(model) {
  const columns = (model.fdFields || [])
    .filter((field) => field && !isPlatformSystemField(field, "detail"))
    .map((field) => {
      const attribute = safeParseObject(field.fdAttribute);
      const controlProps = attribute?.config?.controlProps || {};
      return {
        id: normalizeScalar(field.fdName),
        title: normalizeScalar(field.fdLabel || controlProps.title || ""),
        type: inferFieldType(field, controlProps),
        component: inferComponent(field, controlProps),
        props: observeExecutableProps(controlProps)
      };
    });
  return {
    id: normalizeScalar(model.dynamicProps?.detailFieldName || model.fdName),
    title: normalizeScalar(model.fdName),
    type: "detailTable",
    component: "xform-detail-table",
    dataOnly: false,
    props: {},
    columns
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

function observeLayoutRows(viewModel, detailModels, diagnostics) {
  const detailByTable = new Map(
    detailModels.map((model) => [model.fdTableName, model.dynamicProps?.detailFieldName || model.fdName])
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
      const fieldRef = (item.children || [])[0] || {};
      const fieldIds = nativeFieldIdsFromRef(fieldRef, detailByTable);
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

function observeRules(formRule, diagnostics) {
  void diagnostics;
  const display = Array.isArray(formRule.display) ? formRule.display : [];
  const require = Array.isArray(formRule.require) ? formRule.require : [];
  const rules = [
    ...display.map((rule) => observeNativeRule(rule, "display")),
    ...require.map((rule) => observeNativeRule(rule, "require"))
  ].filter(Boolean);
  return { rules };
}

function observeNativeRule(rule, kind) {
  if (!rule || typeof rule !== "object") return null;
  const conditions = (rule.choices?.items || []).map((item) => ({
    field: normalizeScalar(item.fieldName || item.fieldKey),
    op: denormalizeOperator(item.operate),
    value: item.value?.script === "" || item.value?.script === undefined
      ? ""
      : normalizeRuleValue(item.value?.script ?? item.value)
  }));
  const effects = (Array.isArray(rule.result) ? rule.result : []).map((result) => {
    if (kind === "display") {
      return {
        target: normalizeScalar(result.fieldName || result.fieldKey),
        visible: result.displayFlag !== "hide"
      };
    }
    return {
      target: normalizeScalar(result.fieldName || result.fieldKey),
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
  const initiatorSelectTargetNodeIds = collectMustModifyHandlerTargetNodeIds(nodes);
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
      participants: observeParticipants(node, initiatorSelectTargetNodeIds.has(node.id)),
      dataAuthority: observeDataAuthority(formAuths[node.id]),
      // presentation-only fields intentionally omitted from error comparison
      x: node.x,
      y: node.y
    })),
    edges: edges.map((edge) => ({
      id: normalizeScalar(edge.id),
      source: normalizeScalar(edge.sourceRef),
      target: normalizeScalar(edge.targetRef),
      isDefault: edge.isDefault === true || edge.attributes?.isDefault === true,
      branch: normalizeScalar(edge.branch || edge.attributes?.branch || ""),
      condition: observeEdgeCondition(edge),
      waypoints: edge.waypoints
    }))
  };

  return {
    status: diagnostics.length ? "decode_failed" : "verified",
    value,
    diagnostics
  };
}

function observeParticipants(node, initiatorSelectTarget) {
  const handlers = node?.handlers;
  if (initiatorSelectTarget) {
    return {
      mode: "initiator_select",
      handlersSource: normalizeScalar(handlers?.source),
      handlersRuleKey: normalizeScalar(handlers?.ruleKey),
      memberIds: (handlers?.members || []).map((member) => member.id || member.fdId).filter(Boolean).sort()
    };
  }
  if (!handlers || typeof handlers !== "object") return undefined;
  if (handlers.type === "formula" || handlers.source === "2") {
    return {
      mode: "form_field"
    };
  }
  if (handlers.source === "1" || Array.isArray(handlers.members)) {
    return {
      mode: "explicit",
      memberIds: (handlers.members || []).map((member) => member.id || member.fdId).filter(Boolean).sort()
    };
  }
  return {
    mode: normalizeScalar(handlers.source || handlers.type || "")
  };
}

function collectMustModifyHandlerTargetNodeIds(nodes = []) {
  const targetNodeIds = new Set();
  for (const node of nodes) {
    for (const targetNodeId of splitRelatedNodeIds(node?.mustModifyHandlerNodes)) {
      targetNodeIds.add(targetNodeId);
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

function observeEdgeCondition(edge) {
  const text = edge?.condition ||
    edge?.attributes?.condition ||
    edge?.outgoingCondition ||
    "";
  if (!String(text).trim()) return undefined;
  return { text: normalizeScalar(typeof text === "string" ? text : stableStringify(text)) };
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
