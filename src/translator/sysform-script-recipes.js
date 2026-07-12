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
  const semanticHints = [{
    kind: "dependent_select_options",
    triggerFieldId,
    targetFieldId: targetField.id,
    targetApiCandidates: ["MKXFORM.setProps"],
    evidence: "Legacy option remove/append behavior selects a restricted option set for one trigger value and restores the complete source option set otherwise."
  }];
  const onChange = {
    index: binding.index || 0,
    event: "onChange",
    scope: "control",
    controlId: triggerFieldId,
    recipe,
    semanticHints
  };
  const hasInitialLoad = /\$\(\s*document\s*\)\.ready\s*\(\s*function\s*\(/.test(text) ||
    /\$\(\s*function\s*\(/.test(text);
  return hasInitialLoad
    ? [onChange, {
      index: text.search(/\$\(\s*document\s*\)\.ready|\$\(\s*function\s*\(/),
      event: "onLoad",
      scope: "global",
      recipe,
      semanticHints
    }]
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
  return {
    index: attachment.index || 0,
    event: "onBeforeSubmit",
    scope: "global",
    javascript: text,
    recipe,
    semanticHints: [{
      kind: "attachment_non_empty",
      fieldId,
      message,
      targetApiCandidates: ["MKXFORM.getFormValues", "MKXFORM.modal"],
      evidence: "Legacy submit queue rejects submission when the named attachment fileList is empty and displays the captured validation message."
    }]
  };
}

export function detailRowControlStateCandidate(parts) {
  const recipe = detailRowRecipe("detail_row_control_state", parts);
  return { recipe };
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
  return {
    coverage: {
      status: "partial",
      nativeRules,
      residuals: [{
        code: "script.residual.detail_row_lifecycle_review_required",
        type: "detailRowLifecycleReviewRequired",
        message: "Native rules cover row linkage, but Agent Review must decide how to translate existing-row initialization and lifecycle semantics.",
        evidence: sourceRef
      }]
    },
    recipe
  };
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
