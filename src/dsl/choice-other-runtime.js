const ACTION_ID = "mk-choice-other-init-v1";

// This is a native projection of the explicit DSL relationship. The original
// choice values and explanation field remain independent business values.
export function withChoiceOtherRuntime(scripts = {}, form = {}, mainTableName) {
  const bindings = choiceOtherToggleBindings(form);
  if (!bindings.length) return scripts;
  if (typeof mainTableName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(mainTableName)) {
    const error = new Error("Choice Other runtime requires an explicit valid physical main table name.");
    error.code = "projection.choice_other.main_table_invalid";
    throw error;
  }
  const qualifiedBindings = bindings.map((binding) => Object.fromEntries(
    Object.entries(binding).map(([key, id]) => [key, `${mainTableName}.${id}`])
  ));
  const action = {
    id: ACTION_ID, name: "onLoadChoiceOther", event: "onLoad", scope: "global", translationStatus: "mapped",
    function: `function onLoadChoiceOther(context) {
  if (typeof MKXFORM === "undefined" || !MKXFORM) {
    throw new Error("Choice Other runtime requires a ready native form and value/subscription APIs.");
  }
  var container = MKXFORM.MKXFORM_DATA_CONTAINER;
  var nativeForm = MKXFORM.$$FORM && MKXFORM.$$FORM.current;
  if (!container || typeof container !== "object" || !nativeForm ||
      typeof MKXFORM.getValue !== "function" || typeof MKXFORM.setValue !== "function" || typeof MKXFORM.onChange !== "function") {
    throw new Error("Choice Other runtime requires a ready native form and value/subscription APIs.");
  }
  var namespace = "__mkMigrationChoiceOtherV1";
  var state = container[namespace];
  if (!state || state.nativeForm !== nativeForm) {
    state = { nativeForm: nativeForm, pairs: {} };
    container[namespace] = state;
  }
  var bindings = ${JSON.stringify(qualifiedBindings)};
  bindings.forEach(function (binding) {
    var key = JSON.stringify([binding.toggleId, binding.choiceId, binding.textId]);
    if (state.pairs[key]) return;
    var text = MKXFORM.getValue(binding.textId);
    var selected = MKXFORM.getValue(binding.toggleId);
    if (selected === undefined || selected === null || selected === "") {
      MKXFORM.setValue(binding.toggleId, text !== undefined && text !== null && text !== "" ? ["selected"] : []);
    }
    MKXFORM.onChange(binding.textId, function (value) {
      if (!MKXFORM.$$FORM || MKXFORM.$$FORM.current !== nativeForm) return;
      if (value === text) return;
      text = value;
      MKXFORM.setValue(binding.toggleId, value !== undefined && value !== null && value !== "" ? ["selected"] : []);
    });
    state.pairs[key] = true;
  });
}`
  };
  const actions = Array.isArray(scripts.actions) ? scripts.actions : [];
  const existing = actions.filter((candidate) => candidate.id === ACTION_ID);
  if (existing.length) {
    if (existing.length === 1 && Object.keys(existing[0]).length === Object.keys(action).length &&
      Object.keys(action).every((key) => existing[0][key] === action[key])) return scripts;
    const error = new Error(`Choice Other runtime action identity is already occupied: ${ACTION_ID}.`);
    error.code = "projection.choice_other.action_id_collision";
    throw error;
  }
  return { ...scripts, actions: [...actions, action] };
}

export function choiceOtherToggleBindings(form = {}) {
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const toggles = fields.filter((field) => field?.sourceProps?.choiceOtherToggle !== undefined);
  return toggles.map((toggle) => {
    const relation = toggle.sourceProps.choiceOtherToggle;
    if (relation?.version !== 1) throw bindingError("unsupported relationship version", toggle.id);
    const choice = resolveSource(fields, relation.choiceSourceRef, toggle.id);
    const text = resolveSource(fields, relation.textSourceRef, toggle.id);
    if (toggle.generated !== true || toggle.componentId !== "xform-checkbox" ||
      choice.componentId !== "xform-checkbox" || text.componentId !== "xform-input" ||
      [toggle, choice, text].some((field) => field.dataOnly === true)) {
      throw bindingError("only a generated checkbox and rendered source checkbox/input may be bound", toggle.id);
    }
    const options = toggle.props?.options;
    if (!Array.isArray(options) || options.length !== 1 || options[0]?.value !== "selected" ||
      options[0]?.type === "other" || typeof options[0]?.label !== "string" || !options[0].label.trim() ||
      toggle.props.hiddenLabel !== true || toggle.props.required === true) {
      throw bindingError("toggle must be an optional plain native checkbox with exactly one selected option", toggle.id);
    }
    const companion = choice.sourceProps?.otherTextCompanion;
    if (!companion || companion.optionValue !== undefined ||
      companion.captionId !== (toggle.sourceProps.originalId || toggle.id) ||
      companion.id !== (text.sourceProps?.originalId || text.id)) {
      throw bindingError("source companion identities do not match", toggle.id);
    }
    const ids = [toggle.id, choice.id, text.id];
    if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== 3 ||
      ids.some((id) => fields.filter((field) => field?.id === id).length !== 1)) {
      throw bindingError("field identities must be distinct and unique", toggle.id);
    }
    return { toggleId: toggle.id, choiceId: choice.id, textId: text.id };
  });
}

function resolveSource(fields, sourceRef, toggleId) {
  const matches = typeof sourceRef === "string" && sourceRef
    ? fields.filter((field) => field?.sourceRef === sourceRef)
    : [];
  if (matches.length !== 1) throw bindingError("source reference must resolve uniquely", toggleId);
  return matches[0];
}

function bindingError(reason, toggleId) {
  const error = new Error(`Choice Other runtime binding failed: ${reason} (${toggleId || "unknown"}).`);
  error.code = "projection.choice_other.binding_invalid";
  return error;
}
