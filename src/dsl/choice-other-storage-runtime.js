import { choiceOtherToggleBindings } from "./choice-other-runtime.js";
import { CHOICE_OTHER_STORAGE_CAPABILITY } from "./choice-other-storage-capability.js";

export function withChoiceOtherStorageRuntime(scripts = {}, form = {}, mainTableName) {
  const bindings = choiceOtherToggleBindings(form);
  if (!bindings.length) return scripts;
  const action = choiceOtherStorageAction(form, bindings, mainTableName);
  const actions = Array.isArray(scripts.actions) ? scripts.actions : [];
  const existing = actions.filter(candidate => candidate.id === action.id);
  if (existing.length) {
    if (existing.length === 1 && actions[0] === existing[0] &&
        Object.keys(existing[0]).length === Object.keys(action).length &&
        Object.keys(action).every(key => existing[0][key] === action[key])) return scripts;
    const error = new Error(`Checkbox storage runtime action identity is already occupied: ${action.id}.`);
    error.code = "projection.choice_other.checkbox_storage_action_collision";
    throw error;
  }
  return { ...scripts, actions: [action, ...actions] };
}

/**
 * Native QAS contract: main checkbox widgets expose arrays, while the current
 * XForm virtual entity accepts a scalar string and returns that string on read.
 * Only source-proven, static, comma-free options are safe to round-trip.
 */
export function choiceOtherStorageAction(form = {}, bindings = [], mainTableName) {
  if (typeof mainTableName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(mainTableName)) {
    const error = new Error("Checkbox storage requires a valid physical main table name.");
    error.code = "projection.choice_other.checkbox_storage_table_invalid";
    throw error;
  }
  const toggles = new Set(bindings.map(binding => binding.toggleId));
  const fields = (form.fields || []).filter(field =>
    field?.componentId === "xform-checkbox" && field.dataOnly !== true
  ).map(field => {
    const options = field.props?.options;
    const defaultValue = field.props?.defaultValue;
    const nonEmptyDefault = defaultValue !== undefined && defaultValue !== null &&
      !(defaultValue?.kind === "literal" && (defaultValue.value === "" ||
        Array.isArray(defaultValue.value) && defaultValue.value.length === 0));
    if (!Array.isArray(options) || !options.length || options.some(option =>
      typeof option?.value !== "string" || !option.value || /[,\r\n]/.test(option.value) ||
      option.type === "other" || option.value.startsWith("other_")
    ) || new Set(options.map(option => option.value)).size !== options.length || !toggles.has(field.id) && nonEmptyDefault) {
      const error = new Error(`Checkbox ${field.id} has no unambiguous scalar storage contract.`);
      error.code = "projection.choice_other.checkbox_storage_unproven";
      throw error;
    }
    return { ref: `${mainTableName}.${field.id}`, values: options.map(option => option.value), toggle: toggles.has(field.id) };
  });

  return {
    id: "mk-choice-other-storage-v1", name: "onLoadChoiceOtherStorage", event: "onLoad", scope: "global",
    translationStatus: "mapped",
    function: `function onLoadChoiceOtherStorage(context) {
  if (typeof MKXFORM === "undefined" || !MKXFORM || !MKXFORM.$$FORM || !MKXFORM.$$FORM.current ||
      !MKXFORM.MKXFORM_DATA_CONTAINER || typeof MKXFORM.getValue !== "function" ||
      typeof MKXFORM.setValue !== "function" || typeof MKXFORM.beforeSubmit !== "function") {
    throw new Error("Checkbox storage requires the native form and submit APIs.");
  }
  var form = MKXFORM.$$FORM.current, container = MKXFORM.MKXFORM_DATA_CONTAINER;
  var existing = container.__mkMigrationCheckboxStorageV1;
  if (existing && existing.form === form) return;
  var capability = ${JSON.stringify(CHOICE_OTHER_STORAGE_CAPABILITY)};
  function verifiedRuntime() {
    if (typeof location === "undefined" || location.origin !== capability.origin || typeof document === "undefined" || !document.scripts) return false;
    return Array.prototype.some.call(document.scripts, function(script) {
      return Object.keys(capability.modules).some(function(platform) {
        var item = capability.modules[platform];
        return script.src === capability.origin + "/web/" + item.path + "/index.js?" + item.release;
      });
    });
  }
  if (!verifiedRuntime()) {
    MKXFORM.beforeSubmit(function() { return false; }, "多选字段保存能力未验证，请联系管理员。");
    container.__mkMigrationCheckboxStorageV1 = { form: form, unsupported: true };
    return;
  }
  var fields = ${JSON.stringify(fields)};
  fields.forEach(function(field) {
    var value = MKXFORM.getValue(field.ref), decoded;
    if (typeof value !== "string" || value === "") return;
    if (field.toggle) {
      if (value === "0") decoded = [];
      else if (value === "selected") decoded = ["selected"];
      else return;
    } else {
      decoded = value.split(",");
      if (!decoded.length || decoded.some(function(item) { return field.values.indexOf(item) < 0; })) return;
    }
    MKXFORM.setValue(field.ref, decoded);
  });
  var state = { form: form, getter: null, setter: null };
  container.__mkMigrationCheckboxStorageV1 = state;
  function install() {
    var descriptor = Object.getOwnPropertyDescriptor(form, "getFieldsValue");
    if (descriptor && descriptor.get === state.getter && descriptor.set === state.setter) return true;
    if (!descriptor || descriptor.configurable !== true || typeof descriptor.get !== "function" || typeof descriptor.set !== "function") return false;
    var previous, wrapped;
    function getter() {
      var base = descriptor.get.call(this);
      if (typeof base !== "function") return base;
      if (base !== previous) {
        previous = base;
        wrapped = function() {
          var result = base.apply(this, arguments);
          var stack = new Error().stack;
          var nativeSubmit = typeof stack === "string" && stack.split("\\n").some(function(line) {
            return line.indexOf("getXformValue") >= 0 && Object.keys(capability.modules).some(function(platform) {
              var item = capability.modules[platform];
              return line.indexOf(capability.origin + "/web/" + item.path + "/index.js?" + item.release) >= 0;
            });
          });
          if (arguments.length || !nativeSubmit || !result || typeof result !== "object" || Array.isArray(result)) return result;
          var changed = false, copy = Object.assign({}, result);
          fields.forEach(function(field) {
            if (!Object.prototype.hasOwnProperty.call(result, field.ref)) return;
            var value = result[field.ref];
            if (!Array.isArray(value) || value.some(function(item) { return typeof item !== "string" || field.values.indexOf(item) < 0; })) return;
            if (field.toggle) {
              if (value.length === 0) copy[field.ref] = "0";
              else if (value.length === 1 && value[0] === "selected") copy[field.ref] = "selected";
              else return;
            } else copy[field.ref] = value.join(",");
            changed = true;
          });
          return changed ? copy : result;
        };
      }
      return wrapped;
    }
    function setter(value) { return descriptor.set.call(this, value); }
    Object.defineProperty(form, "getFieldsValue", { configurable: true, enumerable: descriptor.enumerable, get: getter, set: setter });
    state.getter = getter; state.setter = setter;
    return true;
  }
  MKXFORM.beforeSubmit(function() {
    if (!verifiedRuntime() || !MKXFORM.$$FORM || MKXFORM.$$FORM.current !== form) return false;
    try { return install(); } catch (error) { return false; }
  }, "多选字段保存保护不可用，请联系管理员。");
}`
  };
}
