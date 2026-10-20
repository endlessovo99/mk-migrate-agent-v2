/**
 * Runtime-only bridge for the verified desktop detail cell component seam.
 * Admission, release hashes and source/event coverage belong to the caller.
 * This factory is self-contained so a fixed generated runtime can embed it.
 */
export function createNativeDetailControlBridge({ MKXFORM, React, loader, getRows, onRadioClick }) {
  if (!MKXFORM || !React || typeof React.createElement !== "function" || typeof React.useState !== "function" || typeof React.useRef !== "function" || typeof React.useMemo !== "function" || typeof React.useEffect !== "function" || !loader || typeof loader.getModule !== "function") throw new Error("Native detail bridge dependencies are unavailable.");
  if (onRadioClick !== undefined && typeof onRadioClick !== "function") throw new Error("Native radio callback must be a function.");
  var readRows = getRows;
  if (typeof readRows !== "function") throw new Error("Native detail rows reader must be a function.");
  var cells = new Map(), stopped = false;
  var supported = ["@elem/xform-input", "@elem/xform-textarea", "@elem/xform-radio"];
  function active() { if (stopped) throw new Error("Native detail bridge has been disposed."); }
  function identifier(value) { if (typeof value !== "string" || !value || value.indexOf(".") !== -1) throw new Error("Native bridge field identity is invalid."); return value; }
  function rowKey(value) { if (!(typeof value === "string" && value || typeof value === "number" && Number.isFinite(value))) throw new Error("Native row identity is unavailable."); return value; }
  function rows(tableId) {
    var values = readRows(tableId), seen = new Set();
    if (!Array.isArray(values)) throw new Error("Native detail rows are unavailable.");
    values.forEach(function (row) { var key = rowKey(row && row.key), nativeAddress = String(key); if (seen.has(nativeAddress)) throw new Error("Native detail row identity is ambiguous."); seen.add(nativeAddress); });
    return values;
  }
  function currentIndex(tableId, key) { var index = rows(tableId).findIndex(function (row) { return row.key === key; }); if (index < 0) throw new Error("Native detail row no longer exists."); return index; }
  function cell(tableId, fieldId) {
    var key = tableId + "." + fieldId, state = cells.get(key);
    if (!state) { state = { values: new Map(), listeners: new Map(), component: null, nativeType: null }; cells.set(key, state); }
    return state;
  }
  function patchValue(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Native cell property patch is invalid.");
    var result = {};
    Object.keys(patch).forEach(function (key) {
      if (key === "placeholder" && typeof patch[key] === "string" || key === "display" && (patch[key] === "" || patch[key] === "none")) result[key] = patch[key];
      else throw new Error("Native cell property is outside the verified bridge contract.");
    });
    return result;
  }
  function component(spec) {
    active();
    var tableId = identifier(spec.tableId), fieldId = identifier(spec.fieldId), nativeType = spec.nativeType;
    if (supported.indexOf(nativeType) < 0) throw new Error("Native control type is outside the verified bridge contract.");
    var module = loader.getModule(nativeType), Native = module && module.default;
    if (typeof Native !== "function" && !(Native && typeof Native === "object" && Native.$$typeof)) throw new Error("Verified native control module is not loaded.");
    var state = cell(tableId, fieldId);
    if (state.component) { if (state.nativeType !== nativeType) throw new Error("Native control type changed after bridge installation."); return state.component; }
    state.nativeType = nativeType;
    function NativeDetailCell(props) {
      active();
      var key = rowKey(props.rowKey), tick = React.useState(0), refresh = tick[1], pending = React.useRef(null), revision = React.useState(0), advance = revision[1];
      var isRadio = nativeType === "@elem/xform-radio";
      var radioOptions = React.useMemo(function () { return isRadio && Array.isArray(props.options) ? props.options.map(function (option) { return Object.assign({}, option); }) : props.options; }, [props.options, revision[0]]);
      React.useEffect(function () {
        var listeners = state.listeners.get(key) || new Set(); listeners.add(refresh); state.listeners.set(key, listeners);
        return function () { listeners.delete(refresh); if (!listeners.size) state.listeners.delete(key); };
      }, [key]);
      var patch = state.values.get(key) || {}, next = Object.assign({}, props);
      if (Object.prototype.hasOwnProperty.call(patch, "placeholder")) next.placeholder = patch.placeholder;
      var wrapper = Object.prototype.hasOwnProperty.call(patch, "display") ? { style: { display: patch.display } } : {};
      if (isRadio && onRadioClick) {
        if (props.align || props.optionSource && props.optionSource !== "custom" || !Array.isArray(props.options) || props.options.some(function (option) { return !option || typeof option.value !== "string" || option.type === "other" || option.value === "other_"; })) throw new Error("Radio options are outside the verified click bridge contract.");
        var optionValues = props.options.map(function (option) { return option.value; });
        if (new Set(optionValues).size !== optionValues.length) throw new Error("Radio option identity is ambiguous.");
        if (props.controlActions && props.controlActions.onChange && props.controlActions.onChange.length) throw new Error("Radio source actions must be owned by the verified click callback.");
        next.options = radioOptions;
        wrapper.onClickCapture = function (event) {
          var target = event && event.target;
          if (!target || target.type !== "radio" || target.name !== props.name || target.disabled || ["edit", "add"].indexOf(props.showStatus) < 0 || props.editable === false) return;
          if (optionValues.indexOf(target.value) < 0) throw new Error("Clicked native radio option is unproven.");
          currentIndex(tableId, key);
          pending.current = { value: target.value, event: event };
        };
        wrapper.onClick = function () { pending.current = null; };
        next.onChange = function (value) {
          var click = pending.current;
          if (!click) { if (props.onChange) props.onChange(value); return; }
          pending.current = null;
          if (value !== null && value !== click.value) throw new Error("Native radio click and value emission disagree.");
          var index = currentIndex(tableId, key);
          if (typeof props.onChange !== "function") throw new Error("Native radio value writer is unavailable.");
          props.onChange(click.value);
          advance(function (value) { return value + 1; });
          onRadioClick({ tableId: tableId, fieldId: fieldId, rowKey: key, rowIndex: index, value: click.value, nativeValue: value, event: click.event });
        };
      }
      return React.createElement("div", wrapper, React.createElement(Native, next));
    }
    state.component = NativeDetailCell;
    return state.component;
  }
  function setCellProps(spec, patch) {
    active(); var tableId = identifier(spec.tableId), fieldId = identifier(spec.fieldId), key = rowKey(spec.rowKey), state = cell(tableId, fieldId);
    if (!state.component) throw new Error("Native cell bridge is not installed.");
    currentIndex(tableId, key);
    var accepted = patchValue(patch);
    if (state.nativeType === "@elem/xform-radio" && Object.prototype.hasOwnProperty.call(accepted, "placeholder")) throw new Error("Radio placeholder is outside the verified bridge contract.");
    var previous = state.values.get(key) || {}, next = Object.assign({}, previous, accepted);
    if (Object.keys(accepted).every(function (name) { return previous[name] === next[name]; })) return;
    state.values.set(key, next);
    (state.listeners.get(key) || []).forEach(function (notify) { notify(function (value) { return value + 1; }); });
  }
  function setRowProps(tableId, index, fieldId, patch) {
    active(); if (!Number.isInteger(index) || index < 0) throw new Error("Native row index is invalid.");
    var row = rows(tableId)[index]; if (!row) throw new Error("Native row index is outside the table.");
    setCellProps({ tableId: tableId, fieldId: fieldId, rowKey: row.key }, patch);
  }
  function getCellProps(spec) { active(); return Object.assign({}, cell(identifier(spec.tableId), identifier(spec.fieldId)).values.get(rowKey(spec.rowKey)) || {}); }
  function installTable(tableId, fieldIds) {
    active(); identifier(tableId);
    if (!Array.isArray(fieldIds) || !fieldIds.length || new Set(fieldIds).size !== fieldIds.length) throw new Error("Native bridge field selection is invalid.");
    fieldIds.forEach(identifier); rows(tableId);
    var accessor = MKXFORM.$(tableId), self = accessor && accessor.getSelf(), props = self && self.props, columns = props && props.columns;
    if (!Array.isArray(columns) || typeof MKXFORM.setProps !== "function") throw new Error("Native detail column configuration is unavailable.");
    // Validate the complete requested set before allocating wrappers or updating the form.
    fieldIds.forEach(function (name) {
      var matches = columns.filter(function (candidate) { return candidate.controlProps && candidate.controlProps.name === name; });
      if (!matches.length) throw new Error("Native detail field is missing.");
      if (matches.length !== 1) throw new Error("Native detail column identity is ambiguous.");
      var column = matches[0], module = loader.getModule(column.type), existing = cells.get(tableId + "." + name);
      if (column.children && column.children.length) throw new Error("Nested native columns need a separate capability.");
      if (supported.indexOf(column.type) < 0) throw new Error("Native control type is outside the verified bridge contract.");
      if (!module || typeof module.default !== "function" && !(module.default && typeof module.default === "object" && module.default.$$typeof)) throw new Error("Verified native control module is not loaded.");
      if (existing && existing.component && existing.nativeType !== column.type) throw new Error("Native control type changed after bridge installation.");
      var override = column.controlProps.type;
      // The native renderer resolves an equal native string through the same pd loader.
      // Other runtime overrides may carry behavior and must never be overwritten.
      if (override !== undefined && override !== column.type && !(existing && existing.component && override === existing.component)) throw new Error("Native detail column already has an unowned component override.");
    });
    var next = columns.map(function (column) {
      var name = column.controlProps && column.controlProps.name;
      if (fieldIds.indexOf(name) < 0) return column;
      var Wrapped = component({ tableId: tableId, fieldId: name, nativeType: column.type });
      return Object.assign({}, column, { controlProps: Object.assign({}, column.controlProps, { type: Wrapped }) });
    });
    MKXFORM.setProps(tableId, { columns: next });
  }
  function prune(tableId) {
    active(); var live = new Set(rows(tableId).map(function (row) { return row.key; }));
    cells.forEach(function (state, address) { if (address.startsWith(tableId + ".")) state.values.forEach(function (_, key) { if (!live.has(key)) state.values.delete(key); }); });
  }
  function dispose() { stopped = true; cells.forEach(function (state) { state.listeners.clear(); state.values.clear(); }); }
  return { component: component, installTable: installTable, setCellProps: setCellProps, setRowProps: setRowProps, getCellProps: getCellProps, prune: prune, dispose: dispose };
}
