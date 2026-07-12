const DETAIL_REQUIRED_STATE = 3;
const DETAIL_OPTIONAL_STATE = 6;

export function dependentSelectOptionsCandidates(source, form) {
  const text = String(source.javascript || "");
  const binding = text.match(/AttachXFormValueChangeEventById\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*,\s*function\s*\(/);
  const subject = text.match(/select\[subject=(["'])([^"']+)\1\]/);
  if (!binding || !subject || !/\.children\(\s*["']option["']\s*\)/.test(text)) return [];
  if (!/\.remove\(\)/.test(text) || !/\.append\(\s*['"]<option\b/.test(text)) return [];

  const triggerFieldId = binding[2];
  const targetField = (form?.fields || []).find((field) =>
    field?.title === subject[2] && field.componentId === "xform-select"
  );
  const triggerField = (form?.fields || []).find((field) => field?.id === triggerFieldId);
  const options = targetField?.props?.options;
  if (!triggerField || !targetField || !Array.isArray(options) || options.length < 2) return [];

  const appendedValues = new Set(
    [...text.matchAll(/<option\s+value=(["'])([^"']+)\1>/g)].map((match) => match[2])
  );
  if (!appendedValues.size) return [];
  const restrictedOptions = options.filter((option) => !appendedValues.has(String(option.value)));
  if (!restrictedOptions.length || restrictedOptions.length === options.length) return [];

  const condition = text.match(/if\s*\(\s*[A-Za-z_$][\w$]*\s*==+\s*(["']?)([^\s&|)"']+)\1/);
  if (!condition) return [];
  const recipe = {
    kind: "dependent_select_options",
    triggerFieldId,
    targetFieldId: targetField.id,
    cases: [{ when: { op: "equals", value: condition[2] }, options: restrictedOptions }],
    defaultOptions: options
  };
  const functionMappings = [{
    source: "legacy select option remove/append",
    target: "MKXFORM.setProps",
    basis: "semantic-recipe",
    reviewRequired: false
  }];
  const onChange = mappedRecipeCandidate({
    index: binding.index || 0,
    event: "onChange",
    scope: "control",
    controlId: triggerFieldId,
    function: renderDependentSelect("onChange", recipe),
    functionMappings,
    recipe
  });
  const hasInitialLoad = /\$\(\s*document\s*\)\.ready\s*\(\s*function\s*\(/.test(text) ||
    /\$\(\s*function\s*\(/.test(text);
  return hasInitialLoad
    ? [onChange, mappedRecipeCandidate({
      index: text.search(/\$\(\s*document\s*\)\.ready|\$\(\s*function\s*\(/),
      event: "onLoad",
      scope: "global",
      function: renderDependentSelect("onLoad", recipe),
      functionMappings,
      recipe
    })]
    : [onChange];
}

export function attachmentNonEmptyCandidate(source, form) {
  const text = String(source.javascript || "");
  if (!/Com_Parameter\.event(?:\s*\[\s*["']submit["']\s*\]|\s*\.\s*submit)\s*\.push/.test(text)) return undefined;
  const attachment = text.match(/attachmentObject_(fd_[A-Za-z0-9_]+)\.fileList/);
  if (!attachment) return undefined;
  const fieldId = attachment[1];
  const field = (form?.fields || []).find((candidate) =>
    candidate?.id === fieldId && candidate.type === "attachment"
  );
  if (!field) return undefined;
  const message = text.match(/alert\(\s*(["'])([^"']+)\1\s*\)/)?.[2] || `${field.title}不能为空`;
  const recipe = { kind: "attachment_non_empty", fieldId, message };
  return mappedRecipeCandidate({
    index: attachment.index || 0,
    event: "onBeforeSubmit",
    scope: "global",
    javascript: text,
    function: [
      "function onBeforeSubmit(context) {",
      "  if (context && context.isDraft) return true",
      "  var values = MKXFORM.getFormValues() || {}",
      `  var attachmentValue = values[${JSON.stringify(fieldId)}]`,
      "  if (!attachmentValue || (Array.isArray(attachmentValue) && attachmentValue.length === 0)) {",
      `    MKXFORM.modal({ title: "提示", content: ${JSON.stringify(message)} })`,
      "    return false",
      "  }",
      "  return true",
      "}"
    ].join("\n"),
    functionMappings: [{
      source: "legacy attachmentObject.fileList non-empty submit validation",
      target: "MKXFORM.getFormValues + MKXFORM.modal",
      basis: "semantic-recipe",
      reviewRequired: false
    }],
    recipe
  });
}

export function detailRowControlStateCandidate(parts) {
  const recipe = detailRowRecipe("detail_row_control_state", parts);
  return mappedRecipeCandidate({
    function: renderDetailRowControlState(recipe),
    functionMappings: [{
      source: "detail-row DOM hidden value/display/required behavior",
      target: "MKXFORM.updateControl + MKXFORM.updateControlStyle + MKXFORM.setDetailFieldItemAttr",
      basis: "semantic-recipe",
      reviewRequired: false
    }],
    recipe
  });
}

export function detailRowLifecycleCandidate(parts, formRules, sourceRef) {
  const sourceFamily = scriptSourceFamily(sourceRef);
  const nativeRules = (formRules?.linkage || [])
    .filter((rule) =>
      rule.translationStatus === "executable" &&
      sourceFamily &&
      scriptSourceFamily(rule.meta?.sourceJsp) === sourceFamily
    )
    .map((rule) => rule.id);
  if (!nativeRules.length) return undefined;
  const recipe = detailRowRecipe("detail_row_lifecycle", parts, {
    nativeRuleIds: nativeRules,
    rowLifecycle: {
      existingRows: "on_load_initialization",
      addedRows: "native_detail_control_event",
      deletedRows: "native_detail_runtime",
      legacyDomCleanup: "not_applicable_native_runtime"
    }
  });
  return mappedRecipeCandidate({
    function: renderDetailRowLifecycle(recipe),
    coverage: { status: "translated", nativeRules, residuals: [] },
    functionMappings: [
      {
        source: "legacy row visibility/required initialization",
        target: "native formRules.linkage",
        basis: "native-form-rule",
        reviewRequired: false
      },
      {
        source: "legacy detail-row DOM lifecycle",
        target: "detail column onChange + native add/delete lifecycle + MKXFORM.getValue/updateControl/updateControlStyle/setDetailFieldItemAttr",
        basis: "semantic-recipe",
        reviewRequired: false
      }
    ],
    recipe
  });
}

function scriptSourceFamily(value) {
  return String(value || "").replace(/\.script\.\d+$/, "");
}

function detailRowRecipe(kind, parts, extra = {}) {
  return {
    kind,
    tableId: parts.trigger.tableId,
    triggerControlId: parts.trigger.controlId,
    targetControlId: parts.target.controlId,
    hiddenControlId: parts.hiddenControlId,
    matchValue: detailMatchValue(parts.functionText),
    ...extra
  };
}

function detailMatchValue(functionText) {
  return String(functionText || "").match(/if\s*\(\s*value\s*==+\s*(["'])([^"']+)\1\s*\)/)?.[2] || "gh";
}

function renderDependentSelect(event, recipe) {
  const readValue = event === "onLoad"
    ? `  var value = MKXFORM.getValue(${JSON.stringify(recipe.triggerFieldId)})`
    : "  var selected = Array.isArray(value) ? value[0] : value\n  value = selected";
  return [
    `function ${event}(${event === "onChange" ? "value, rowNum, parentRowNum" : ""}) {`,
    readValue,
    `  var options = String(value) === ${JSON.stringify(String(recipe.cases[0].when.value))} ? ${JSON.stringify(recipe.cases[0].options)} : ${JSON.stringify(recipe.defaultOptions)}`,
    `  MKXFORM.setProps(${JSON.stringify(recipe.targetFieldId)}, { options: options })`,
    "}"
  ].join("\n");
}

function renderDetailRowControlState(recipe) {
  const targetField = detailFieldRef(recipe.tableId, recipe.targetControlId);
  const hiddenField = recipe.hiddenControlId
    ? detailFieldRef(recipe.tableId, recipe.hiddenControlId)
    : "";
  return [
    "function onChange(value, rowNum, parentRowNum) {",
    "  var selectedValue = Array.isArray(value) ? value[0] : value",
    `  var active = String(selectedValue) === ${JSON.stringify(recipe.matchValue)}`,
    ...(hiddenField ? [`  MKXFORM.updateControl(${JSON.stringify(hiddenField)}, rowNum, active ? "true" : "")`] : []),
    `  MKXFORM.updateControlStyle(${JSON.stringify(targetField)}, rowNum, { display: active ? "block" : "none" })`,
    `  MKXFORM.setDetailFieldItemAttr(${JSON.stringify(targetField)}, rowNum, active ? ${DETAIL_REQUIRED_STATE} : ${DETAIL_OPTIONAL_STATE})`,
    "}"
  ].join("\n");
}

function renderDetailRowLifecycle(recipe) {
  const targetField = detailFieldRef(recipe.tableId, recipe.targetControlId);
  const activeTerms = [
    `String(rows[rowNum][${JSON.stringify(recipe.triggerControlId)}] || "") === ${JSON.stringify(recipe.matchValue)}`
  ];
  if (recipe.hiddenControlId) {
    activeTerms.push(`String(rows[rowNum][${JSON.stringify(recipe.hiddenControlId)}] || "") === "true"`);
  }
  return [
    "function onLoad() {",
    `  var rows = MKXFORM.getValue(${JSON.stringify(`\${table:${recipe.tableId}}`)}) || []`,
    "  for (var rowNum = 0; rowNum < rows.length; rowNum += 1) {",
    `    var active = ${activeTerms.join(" || ")}`,
    ...(recipe.hiddenControlId
      ? [`    MKXFORM.updateControl(${JSON.stringify(detailFieldRef(recipe.tableId, recipe.hiddenControlId))}, rowNum, active ? "true" : "")`]
      : []),
    `    MKXFORM.updateControlStyle(${JSON.stringify(targetField)}, rowNum, { display: active ? "block" : "none" })`,
    `    MKXFORM.setDetailFieldItemAttr(${JSON.stringify(targetField)}, rowNum, active ? ${DETAIL_REQUIRED_STATE} : ${DETAIL_OPTIONAL_STATE})`,
    "  }",
    "}"
  ].join("\n");
}

function detailFieldRef(tableId, controlId) {
  return `\${table:${tableId}}.${controlId}`;
}

function mappedRecipeCandidate(candidate) {
  return {
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    ...candidate
  };
}
