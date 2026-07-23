/**
 * Deterministic MK mapping for detail-row controlDisplay / controlDisplay2 and
 * matching onLoad row-state initialization.
 *
 * Completeness requires same-row hidden write + display toggle + required/validate
 * toggle. Placeholder text changes are ignored (not part of MK targetApi surface).
 */

function isCompleteDetailControlDisplay(functionText = "") {
  const text = String(functionText || "");
  if (!text.trim()) return false;
  const writesHidden = /extendDataFormInfo\.value\([^)]*\)\s*\)\s*\.value\s*=/.test(text) ||
    /\.value\s*=\s*(["'])(?:true|)\1/.test(text);
  const togglesDisplay = /(?:\.style\.display|\[["']style\.display["']\])\s*=\s*(["'])(?:|none)\1/.test(text) ||
    /style\.display\s*=\s*(["'])(?:|none)\1/.test(text);
  const togglesValidate = /(?:setAttribute\s*\(\s*["']validate["']|\.validate\s*=)/.test(text);
  return writesHidden && togglesDisplay && togglesValidate;
}

function detailMatchValue(functionText = "") {
  return String(functionText || "").match(/if\s*\(\s*value\s*==+\s*(["'])([^"']+)\1\s*\)/)?.[2] || "gh";
}

function physicalTablePlaceholder(tableId) {
  return `\${table:${tableId}}`;
}

function buildDetailRowControlStateFunction(parts = {}) {
  const tableId = String(parts.tableId || parts.trigger?.tableId || "").trim();
  const hiddenControlId = String(parts.hiddenControlId || "").trim();
  const targetControlId = String(parts.targetControlId || parts.target?.controlId || "").trim();
  const matchValue = String(parts.matchValue || detailMatchValue(parts.functionText) || "gh").trim();
  if (!tableId || !hiddenControlId || !targetControlId) return "";
  const table = physicalTablePlaceholder(tableId);
  return [
    "function onChange(value, rowNum, parentRowNum) {",
    "  /* mk-migrate:view-status=add,edit */",
    "  if (MKXFORM.viewStatus != \"add\" && MKXFORM.viewStatus != \"edit\") return;",
    "  var selectedValue = Array.isArray(value) ? value[0] : value",
    `  var active = String(selectedValue) === ${JSON.stringify(matchValue)}`,
    `  MKXFORM.updateControl(${JSON.stringify(`${table}.${hiddenControlId}`)}, rowNum, active ? "true" : "")`,
    `  MKXFORM.updateControlStyle(${JSON.stringify(`${table}.${targetControlId}`)}, rowNum, { display: active ? "block" : "none" })`,
    `  MKXFORM.setDetailFieldItemAttr(${JSON.stringify(`${table}.${targetControlId}`)}, rowNum, active ? 3 : 6)`,
    "}"
  ].join("\n");
}

function buildDetailRowLifecycleFunction(parts = {}) {
  const tableId = String(parts.tableId || parts.trigger?.tableId || "").trim();
  const triggerControlId = String(parts.triggerControlId || parts.trigger?.controlId || "").trim();
  const hiddenControlId = String(parts.hiddenControlId || "").trim();
  const targetControlId = String(parts.targetControlId || parts.target?.controlId || "").trim();
  const matchValue = String(parts.matchValue || "gh").trim();
  if (!tableId || !triggerControlId || !hiddenControlId || !targetControlId) return "";
  const table = physicalTablePlaceholder(tableId);
  // Declare as onLoad so DSL schema accepts the action name; form-writer
  // renames to onLoad_1 when composing the global dispatcher.
  return [
    "function onLoad() {",
    `  var rows = MKXFORM.getValue(${JSON.stringify(table)}) || []`,
    "  for (var rowNum = 0; rowNum < rows.length; rowNum += 1) {",
    `    var active = String(rows[rowNum][${JSON.stringify(triggerControlId)}] || "") === ${JSON.stringify(matchValue)} || String(rows[rowNum][${JSON.stringify(hiddenControlId)}] || "") === "true"`,
    `    MKXFORM.updateControl(${JSON.stringify(`${table}.${hiddenControlId}`)}, rowNum, active ? "true" : "")`,
    `    MKXFORM.updateControlStyle(${JSON.stringify(`${table}.${targetControlId}`)}, rowNum, { display: active ? "block" : "none" })`,
    `    MKXFORM.setDetailFieldItemAttr(${JSON.stringify(`${table}.${targetControlId}`)}, rowNum, active ? 3 : 6)`,
    "  }",
    "}"
  ].join("\n");
}

function coveredRangesForText(sourceText = "", functionText = "", options = {}) {
  const source = String(sourceText || "");
  const sourceRef = String(options.sourceRef || "").trim();
  const name = String(options.name || "detail_row_control_state").trim() || "detail_row_control_state";
  const fn = String(functionText || "").trim();
  if (!sourceRef) return [];
  if (!fn) {
    return [{
      sourceRef,
      name,
      start: 0,
      end: Math.max(1, source.length || 1)
    }];
  }
  const start = source.indexOf(fn);
  if (start < 0) {
    return [{
      sourceRef,
      name,
      start: 0,
      end: Math.max(1, source.length || 1)
    }];
  }
  return [{
    sourceRef,
    name,
    start,
    end: start + fn.length
  }];
}

export {
  buildDetailRowControlStateFunction,
  buildDetailRowLifecycleFunction,
  coveredRangesForText,
  detailMatchValue,
  isCompleteDetailControlDisplay
};
