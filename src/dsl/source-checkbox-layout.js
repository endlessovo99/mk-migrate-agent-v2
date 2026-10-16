import { canonicalJson } from "../agent-review/digest.js";

/** Fixed-source checkbox presentation; no new public DSL properties. */
export function sourceCheckboxLayouts(form = {}) {
  const result = new Map();
  for (const { field, tableRef } of checkboxEntries(form)) {
    const source = field.sourceProps || {}, values = source.designerValues || {};
    const raw = field.sourceType !== undefined, type = field.sourceType || field.type;
    const options = raw ? field.options : field.props?.options;
    const alignment = values.alignment, id = source.originalId || field.id;
    if (type !== "checkbox" || (!raw && field.componentId !== "xform-checkbox") ||
        typeof source.designerType !== "string" || source.designerType.toLowerCase() !== "inputcheckbox" ||
        !["H", "V"].includes(alignment) || typeof field.sourceRef !== "string" || !field.sourceRef ||
        typeof id !== "string" || !id ||
        source.designerId !== id || values.id !== id ||
        !Array.isArray(options) || !options.length ||
        options.some(option => !option || typeof option.label !== "string" || typeof option.value !== "string")) continue;
    const sourceCount = options.length;
    const nativeCount = options.length;
    const capacity = sourceCount;
    const nativeProps = alignment === "V"
      ? { direction: "row", rowCount: 1 }
      : { direction: "column", rowCount: capacity };
    result.set(field.sourceRef, {
      scope: tableRef ? "detail" : "main",
      tableRef,
      nativeProps,
      expected: {
        desktop: rowSizes(nativeCount, alignment === "V" ? 1 : capacity),
        mobile: rowSizes(nativeCount, alignment === "V" ? 1 : capacity)
      }
    });
  }
  return result;
}

/** Observe the registered PC/mobile grouping semantics, including defaults. */
export function nativeCheckboxLayout(controlProps = {}) {
  const result = {};
  for (const platform of ["desktop", "mobile"]) {
    const props = { ...controlProps, ...controlProps[platform] };
    const options = props.options;
    const direction = props.direction === undefined ? "column" : props.direction;
    if (!Array.isArray(options) || !options.length ||
        canonicalJson(options) !== canonicalJson(controlProps.options) ||
        !["row", "column"].includes(direction) || props.align ||
        ![undefined, "custom"].includes(props.optionSource)) {
      result[platform] = { invalid: true };
      continue;
    }
    // A row direction never consumes rowCount; column+1 is the same single-item branch.
    const capacity = direction === "row" ? 1 : props.rowCount || 3;
    result[platform] = Number.isInteger(capacity) && capacity > 0
      ? rowSizes(options.length, capacity) : { invalid: true };
  }
  return result;
}

function rowSizes(count, capacity) {
  const sizes = [];
  for (let offset = 0; offset < count; offset += capacity) sizes.push(Math.min(capacity, count - offset));
  return sizes;
}

function checkboxEntries(form) {
  if (Array.isArray(form.controls)) {
    return [...[...form.controls, ...(form.dataFields || [])].map(field => ({ field })),
      ...(form.detailTables || []).flatMap(table => (table.columns || []).map(field => ({ field, tableRef: table.sourceRef || table.id })))];
  }
  return (form.fields || []).flatMap(field => [{ field }, ...(field.columns || []).map(column => ({ field: column, tableRef: field.sourceRef || field.id }))]);
}
