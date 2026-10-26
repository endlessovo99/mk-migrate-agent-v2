import { createHash } from "node:crypto";

const BASIS = "deterministic-allowance-calculation";
const PRIMITIVE_CONTROLS = new Set([
  "xform-input", "xform-textarea", "xform-number", "xform-select",
  "xform-radio", "xform-date", "xform-datetime"
]);

export function canCommitDetailEventValue(actions, table) {
  if (!table.columns?.length || !table.columns.every(safeColumn)) return false;
  // Publication must not add a second source-level reactive side effect.
  if (actions.some(action => action.translationStatus !== "omitted" && (
    action.scope === "global" && (action.event || action.name) === "onChange" ||
    action.scope === "control" && action.tableId === table.id &&
      action.controlId === table.id && (action.event || action.name) === "onDetailChange"
  ))) return false;
  return ["onAfterAdd", "onAfterDel"].every(event =>
    actions.some(action => provedLifecycle(action, table.id, event)));
}

function safeColumn(column) {
  const value = column.props?.defaultValue;
  return PRIMITIVE_CONTROLS.has(column.componentId) && (!value ||
    value.kind === "literal" && [null, ""].includes(value.value));
}

function provedLifecycle(action, tableId, event) {
  const proof = action.deterministicBranchProof;
  return action.scope === "control" && action.controlId === tableId &&
    action.tableId === tableId && (action.event || action.name) === event &&
    action.translationStatus === "mapped" && action.sourceRefs?.length &&
    action.coverage?.status === "translated" && !action.coverage.residuals?.length &&
    proof?.version === 2 && proof.basis === BASIS &&
    proof.functionSha256 === createHash("sha256").update(action.function).digest("hex") &&
    action.functionMappings?.some(mapping => mapping.basis === BASIS && mapping.reviewRequired === false);
}

// The native row writer publishes the already accepted current-cell value by
// stable row key. All other values must be unchanged, or belong to the same
// source-proved pending numeric event family. No source arithmetic is replaced.
export function renderDetailEventValueCommit() {
  return `
  function __mkDetailReadCommit(handle, rows, current, column, table) {
    var host = MKXFORM.$$FORM && MKXFORM.$$FORM.current;
    var meta = host && typeof host.$ === "function" && host.$(table);
    var node = meta && meta._CURRENT_FIBRE;
    if (!node || node.kind !== "control" || node.name !== table || node.isInvalid ||
        !node.props || ["add", "edit"].indexOf(node.props.showStatus) < 0 ||
        typeof handle.getCurrentValues !== "function" || typeof handle.getHiddenData !== "function" ||
        typeof handle.updateRowValue !== "function") return;
    var columns = node.props && node.props.columns;
    var choices = Array.isArray(columns) && columns.filter(function(item) {
      return item.kind === "control" && item.controlProps && item.controlProps.name === column;
    });
    var config = choices && choices.length === 1 && choices[0];
    var hiddenNames = node.props && node.props.hiddenNames;
    if (!config || config.labelProps && config.labelProps.hidden ||
        ["add", "edit"].indexOf(config.controlProps.showStatus) < 0 ||
        config.controlProps.readonly || config.controlProps.disabled || node.hidden ||
        Array.isArray(hiddenNames) && (hiddenNames.indexOf(column) >= 0 || hiddenNames.indexOf(table + "." + column) >= 0)) return;
    var saved = handle.getCurrentValues(), hidden = handle.getHiddenData();
    if (!Array.isArray(saved) || saved.length !== rows.length || !hidden || typeof hidden !== "object" || Array.isArray(hidden)) return;
    function primitive(value) {
      return value == null || typeof value === "string" || typeof value === "boolean" ||
        typeof value === "number" && isFinite(value);
    }
    function record(row) {
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      var out = Object.create(null), keys = Object.keys(row), prefix = table + ".";
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k], name = key.indexOf(prefix) === 0 ? key.slice(prefix.length) : key;
        if (name === "key" || name === "fd_order") continue;
        if (name.indexOf(".") >= 0 || Object.prototype.hasOwnProperty.call(out, name) || !primitive(row[key])) return null;
        out[name] = row[key];
      }
      return out;
    }
    function owns(row, index) {
      var queue = typeof window === "undefined" ? null : window.MXFORM_ACTIONS;
      var entry = queue && queue[table + "." + column + "~" + String(row.key)];
      var args = entry && entry.actionParams && entry.actionParams.onChange;
      var functions = entry && entry.actionFuns && entry.actionFuns.onChange;
      var hiddenFields = hidden[row.key];
      return hiddenFields !== "all" && (!Array.isArray(hiddenFields) ||
          hiddenFields.indexOf(column) < 0 && hiddenFields.indexOf(table + "." + column) < 0) &&
        typeof row[column] === "number" && isFinite(row[column]) &&
        entry && entry.actionTableType === "detail" && entry.actionTableName === table &&
        Array.isArray(functions) && functions.indexOf(__mkDetailReadOwner) >= 0 &&
        Array.isArray(args) && args[0] === row[column] && args[1] === index &&
        (args[2] === undefined || args[2] === null);
    }
    var seen = Object.create(null), changed = false;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i], old = saved[i];
      if (!row || !old || row.key !== old.key ||
          !(typeof row.key === "string" || typeof row.key === "number" && isFinite(row.key)) ||
          Object.prototype.hasOwnProperty.call(seen, String(row.key))) return;
      seen[String(row.key)] = true;
      var fresh = record(row), previous = record(old);
      if (!fresh || !previous) return;
      var names = Object.keys(fresh).concat(Object.keys(previous));
      for (var j = 0; j < names.length; j++) {
        var name = names[j];
        if (fresh[name] === previous[name]) continue;
        if (name !== column || !owns(row, i)) return;
        if (row === current) changed = true;
      }
    }
    if (!changed || !owns(current, rows.indexOf(current))) return;
    var value = Object.create(null); value[column] = current[column];
    handle.updateRowValue({ rowKey: current.key, value: [value] });
  }
`;
}
