import { inlineOnChangeSourceActionKey } from "./source-action-key.js";

export const PROJECT_CHANGE_ROW_DETAIL_BASIS = "deterministic-project-change-row-detail";
export const PROJECT_CHANGE_APPROVAL_ALERT_BASIS = "deterministic-jquery-field-change-alert";

export function projectChangeScriptClosureCandidates(source = {}, form = {}, formRules = {}) {
  return [
    ...projectChangeEditCandidates(source, form, formRules),
    ...projectChangeViewCandidates(source, form),
    ...approvalBranchAlertCandidates(source, form)
  ];
}

function projectChangeEditCandidates(source, form, formRules) {
  const text = String(source.javascript || "");
  if (source.displayGate !== "xform:editShow") return [];
  if (!String(source.helperJavascript || "").includes("function setItemsRequired")) return [];
  if (!/AttachXFormValueChangeEventById\(\s*["']fd_project_property["']/.test(text)) return [];
  if (!/common_dom_row_set_show_required_reset\(\s*["']fd_first_row["']/.test(text)) return [];
  if (!/GetXFormFieldById\(\s*["']fd_3e95c74ae39794["']/.test(text)) return [];
  if (!/setItemsRequired/.test(text) || !/setItemsNotRequired/.test(text)) return [];
  if (!/img\[title=['"]添加行['"]\]/.test(text)) return [];
  if (!/fd_3e96b925d04394/.test(text) || !/list_set\(\s*["']fd_sheet["']\s*,\s*["']fd_target_cost["']/.test(source.helperJavascript || "")) {
    return [];
  }
  if (!layoutHasMarker(form, "fd_first_row")) return [];
  if (!hardHiddenField(form, "fd_3e95c74ae39794")) return [];
  if (!mainField(form, "fd_3e96b925d04394")) return [];
  if (!detailColumn(form, "fd_sheet", "fd_target_cost")) return [];
  if (!radioField(form, "fd_project_property")) return [];

  const sourceRef = source.sourceRef || source.id;
  const changeIndex = text.indexOf("AttachXFormValueChangeEventById");
  const loadIndex = text.indexOf("Com_AddEventListener");
  if (changeIndex < 0 || loadIndex < 0) return [];
  const nativeRules = nativeRulesForSource(source, formRules);
  const mapping = {
    source: "project-property row marker, hidden flag, detail required, and add-row reapply",
    target: "MKXFORM.setValue/setFieldAttr/setDetailFieldAttr/updateControl",
    basis: PROJECT_CHANGE_ROW_DETAIL_BASIS,
    reviewRequired: false
  };
  const semanticHints = {
    coveredLegacyFunctions: (source.functionAudit?.violations || [])
      .map((violation) => violation?.name)
      .filter(Boolean),
    coveredCalculationRanges: [{
      sourceRef,
      name: "projectChangeEdit",
      start: 0,
      end: Math.max(1, text.length)
    }]
  };
  const common = {
    javascript: text,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules, residuals: [] },
    functionMappings: [mapping],
    sourceRefs: [sourceRef],
    semanticHints
  };
  return [{
    ...common,
    index: loadIndex,
    event: "onLoad",
    scope: "global",
    function: [
      "function onLoad() {",
      "  MKXFORM.setFieldAttr(\"fd_first_row\", 4)",
      "  MKXFORM.setFieldAttr(\"fd_first_row\", 6)",
      "  var current = MKXFORM.getValue(\"fd_project_property\")",
      "  current = Array.isArray(current) ? current[0] : current",
      "  var active = String(current || \"\") === \"1\"",
      "  if (active) {",
      "    MKXFORM.setFieldAttr(\"fd_first_row\", 5)",
      "    MKXFORM.setFieldAttr(\"fd_first_row\", 3)",
      "    MKXFORM.setDetailFieldAttr(\"${table:fd_sheet}.fd_target_cost\", 5)",
      "    MKXFORM.setDetailFieldAttr(\"${table:fd_sheet}.fd_target_cost\", 3)",
      "    MKXFORM.setFieldAttr(\"fd_3e96b925d04394\", 5)",
      "  } else {",
      "    MKXFORM.setDetailFieldAttr(\"${table:fd_sheet}.fd_target_cost\", 4)",
      "    MKXFORM.setDetailFieldAttr(\"${table:fd_sheet}.fd_target_cost\", 6)",
      "    MKXFORM.setFieldAttr(\"fd_3e96b925d04394\", 4)",
      "  }",
      "}"
    ].join("\n")
  }, {
    ...common,
    index: changeIndex,
    sourceActionKey: inlineOnChangeSourceActionKey(sourceRef, changeIndex),
    event: "onChange",
    scope: "control",
    controlId: "fd_project_property",
    function: [
      "function onChange(value, rowNum, parentRowNum) {",
      "  var selected = Array.isArray(value) ? value[0] : value",
      "  var active = String(selected || \"\").indexOf(\"1\") >= 0",
      "  MKXFORM.setValue(\"fd_3e95c74ae39794\", active ? \"1\" : \"\")",
      "  MKXFORM.setFieldAttr(\"fd_first_row\", active ? 5 : 4)",
      "  MKXFORM.setFieldAttr(\"fd_first_row\", active ? 3 : 6)",
      "  MKXFORM.setFieldAttr(\"fd_3e96b925d04394\", active ? 5 : 4)",
      "  if (active) {",
      "    MKXFORM.setValue(\"fd_3e96b925d04394\", \"\")",
      "  }",
      "  var rowCount = MKXFORM.getRowCount(\"${table:fd_sheet}\")",
      "  for (var i = 0; i < rowCount; i += 1) {",
      "    MKXFORM.updateControl(\"${table:fd_sheet}.fd_target_cost\", i, \"\")",
      "  }",
      "  MKXFORM.setDetailFieldAttr(\"${table:fd_sheet}.fd_target_cost\", active ? 5 : 4)",
      "  MKXFORM.setDetailFieldAttr(\"${table:fd_sheet}.fd_target_cost\", active ? 3 : 6)",
      "}"
    ].join("\n")
  }];
}

function projectChangeViewCandidates(source, form) {
  const text = String(source.javascript || "");
  if (source.displayGate !== "xform:viewShow") return [];
  if (!String(source.helperJavascript || "").includes("function setItemsRequired")) return [];
  if (!/GetXFormFieldById\(\s*["']fd_3e95c74ae39794["']/.test(text)) return [];
  if (!/common_dom_row_set_show_required_reset\(\s*["']fd_first_row["']/.test(text)) return [];
  if (!/setItemsRequired/.test(text) || !/setItemsNotRequired/.test(text)) return [];
  if (/AttachXFormValueChangeEventById/.test(text)) return [];
  if (!layoutHasMarker(form, "fd_first_row")) return [];
  if (!hardHiddenField(form, "fd_3e95c74ae39794")) return [];
  if (!mainField(form, "fd_3e96b925d04394")) return [];
  if (!detailColumn(form, "fd_sheet", "fd_target_cost")) return [];

  const sourceRef = source.sourceRef || source.id;
  const loadIndex = text.indexOf("Com_AddEventListener");
  if (loadIndex < 0) return [];
  return [{
    index: loadIndex,
    event: "onLoad",
    scope: "global",
    javascript: text,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "view-gated project-property row and detail required restoration",
      target: "MKXFORM.getValue/setFieldAttr/setDetailFieldAttr",
      basis: PROJECT_CHANGE_ROW_DETAIL_BASIS,
      reviewRequired: false
    }],
    sourceRefs: [sourceRef],
    semanticHints: {
      coveredCalculationRanges: [{
        sourceRef,
        name: "projectChangeView",
        start: 0,
        end: Math.max(1, text.length)
      }]
    },
    function: [
      "function onLoad() {",
      "  var hidden = MKXFORM.getValue(\"fd_3e95c74ae39794\")",
      "  hidden = Array.isArray(hidden) ? hidden[0] : hidden",
      "  var active = String(hidden || \"\") === \"1\"",
      "  MKXFORM.setFieldAttr(\"fd_first_row\", active ? 5 : 4)",
      "  MKXFORM.setFieldAttr(\"fd_first_row\", 6)",
      "  MKXFORM.setDetailFieldAttr(\"${table:fd_sheet}.fd_target_cost\", active ? 5 : 4)",
      "  MKXFORM.setDetailFieldAttr(\"${table:fd_sheet}.fd_target_cost\", active ? 3 : 6)",
      "  MKXFORM.setFieldAttr(\"fd_3e96b925d04394\", active ? 5 : 4)",
      "}"
    ].join("\n")
  }];
}

function approvalBranchAlertCandidates(source, form) {
  const text = String(source.javascript || "");
  if (!/\$\(\s*document\s*\)\.ready/.test(text)) return [];
  if (!/fd_Approval_branch/.test(text) || !/\.on\(\s*['"]change['"]/.test(text)) return [];
  if (!/fd_budget/.test(text) || !/fd_schedule/.test(text)) return [];
  const message = text.match(/alert\(\s*(['"])([^'"]+)\1\s*\)/)?.[2];
  if (!message) return [];
  if (!selectField(form, "fd_Approval_branch")) return [];
  if (!hardHiddenField(form, "fd_budget") || !hardHiddenField(form, "fd_schedule")) return [];

  const sourceRef = source.sourceRef || source.id;
  const index = text.indexOf("fd_Approval_branch");
  return [{
    index,
    event: "onChange",
    scope: "control",
    controlId: "fd_Approval_branch",
    javascript: text,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "jQuery change alert on approval-branch vs hidden budget/schedule flags",
      target: "control onChange + MKXFORM.getValue + MKXFORM.toast",
      basis: PROJECT_CHANGE_APPROVAL_ALERT_BASIS,
      reviewRequired: false
    }],
    sourceRefs: [sourceRef],
    semanticHints: {
      coveredLegacyFunctions: ["alert", "$"],
      coveredCalculationRanges: [{
        sourceRef,
        name: "approvalBranchAlert",
        start: 0,
        end: Math.max(1, text.length)
      }]
    },
    function: [
      "function onChange(value, rowNum, parentRowNum) {",
      "  var selected = Array.isArray(value) ? value[0] : value",
      "  var budget = MKXFORM.getValue(\"fd_budget\")",
      "  var schedule = MKXFORM.getValue(\"fd_schedule\")",
      "  budget = Array.isArray(budget) ? budget[0] : budget",
      "  schedule = Array.isArray(schedule) ? schedule[0] : schedule",
      "  if (String(budget) === \"1\" && String(schedule) === \"two\") {",
      "    if (String(selected) === \"one\" || String(selected) === \"two\") {",
      `      MKXFORM.toast(${JSON.stringify(message)})`,
      "    }",
      "  }",
      "}"
    ].join("\n")
  }];
}

function nativeRulesForSource(source, formRules) {
  const sourceRef = source.sourceRef || source.id;
  return (formRules?.linkage || [])
    .filter((rule) =>
      rule?.meta?.sourceJsp === sourceRef ||
      rule?.meta?.sourceRef === sourceRef ||
      rule?.sourceRef === sourceRef
    )
    .map((rule) => rule.id)
    .filter(Boolean);
}

function layoutHasMarker(form, marker) {
  return (form?.layout?.mkTree || []).some((node) =>
    (node?.sourceMarkers || []).includes(marker)
  );
}

function mainField(form, fieldId) {
  return (form?.fields || []).find((field) => field?.id === fieldId && field.type !== "detailTable");
}

function hardHiddenField(form, fieldId) {
  const field = mainField(form, fieldId);
  return field?.sourceProps?.hardHidden === true || field?.componentId === "xform-hidden"
    ? field
    : undefined;
}

function radioField(form, fieldId) {
  const field = mainField(form, fieldId);
  return field?.componentId === "xform-radio" ? field : undefined;
}

function selectField(form, fieldId) {
  const field = mainField(form, fieldId);
  return field?.componentId === "xform-select" ? field : undefined;
}

function detailColumn(form, tableId, columnId) {
  const table = (form?.fields || []).find((field) => field?.id === tableId && field.type === "detailTable");
  return (table?.columns || []).find((column) => column?.id === columnId);
}
