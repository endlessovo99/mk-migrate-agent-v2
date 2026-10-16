import { canonicalJson } from "../agent-review/digest.js";

/** Radio's registered grouping contract: column groups N options, row groups one. */
export function sourceRadioLayouts(form = {}) {
  const profiles = new Map();
  const entries = Array.isArray(form.controls)
    ? [...[...form.controls, ...(form.dataFields || [])].map(field => ({ field })),
      ...(form.detailTables || []).flatMap(table => (table.columns || []).map(field => ({ field, tableRef: table.sourceRef || table.id })))]
    : (form.fields || []).flatMap(field => [{ field }, ...(field.columns || []).map(column => ({ field: column, tableRef: field.sourceRef || field.id }))]);
  for (const { field, tableRef } of entries) {
    const source = field.sourceProps || {}, values = source.designerValues || {};
    const raw = field.sourceType !== undefined, options = raw ? field.options : field.props?.options;
    const id = source.originalId || field.id;
    if ((field.sourceType || field.type) !== "radio" || !raw && field.componentId !== "xform-radio" ||
        source.designerType?.toLowerCase() !== "inputradio" || source.designerRadioLayoutLiteral !== true || !["H", "V"].includes(values.alignment) ||
        !field.sourceRef || !id || source.designerId !== id || values.id !== id ||
        !Array.isArray(options) || !options.length || options.some(option => !option ||
          typeof option.label !== "string" || typeof option.value !== "string")) continue;
    const capacity = values.alignment === "V" ? 1 : options.length;
    profiles.set(field.sourceRef, { scope: tableRef ? "detail" : "main", tableRef,
      nativeProps: { direction: values.alignment === "V" ? "row" : "column", rowCount: capacity },
      expected: { desktop: rowSizes(options.length, capacity), mobile: rowSizes(options.length, capacity) } });
  }
  return profiles;
}

export function nativeRadioLayout(controlProps = {}, styles = {}) {
  return Object.fromEntries(["desktop", "mobile"].map(platform => {
    const props = { ...controlProps, ...controlProps[platform], ...styles[platform] };
    const direction = props.direction === undefined ? "column" : props.direction;
    const capacity = direction === "row" ? 1 : props.rowCount || 3;
    // Mobile wraps every option even without align; PC consumes these sizes
    // only in the align branch, which this source-backed policy excludes.
    const mobileSizing = platform !== "mobile" ||
      [undefined, "auto"].includes(props.optionWidth) && [undefined, 0, "0px"].includes(props.optionPadding);
    const valid = props.type === (platform === "mobile" ? "@elem/xform-m-radio" : "@elem/xform-radio") &&
      Array.isArray(props.options) && props.options.length && canonicalJson(props.options) === canonicalJson(controlProps.options) &&
      ["row", "column"].includes(direction) && !props.align && [undefined, "custom"].includes(props.optionSource) &&
      Number.isInteger(capacity) && capacity > 0 && mobileSizing;
    return [platform, valid ? rowSizes(props.options.length, capacity) : { invalid: true }];
  }));
}

function rowSizes(count, capacity) {
  return Array.from({ length: Math.ceil(count / capacity) }, (_, index) => Math.min(capacity, count - index * capacity));
}

/** Check fixed-source presentation before either trust or evidence-backed patching. */
export function radioSourceDiagnostics(expectedForm, targetForm, { prefix = "trust.form" } = {}) {
  const flatten = form => (form?.fields || []).flatMap(field => [{ field }, ...(field.columns || []).map(column => ({ field: column, tableRef: field.sourceRef || field.id }))]);
  const expected = flatten(expectedForm), actual = flatten(targetForm);
  const radio = entry => entry.field.type === "radio" || entry.field.componentId === "xform-radio";
  const refs = new Set([...expected, ...actual].filter(radio).map(entry => entry.field.sourceRef));
  const semantics = entry => {
    const field = entry.field, props = { ...field.props };
    for (const key of ["required", "readOnly", "hiddenLabel"]) if (props[key] === false) delete props[key];
    return { ...entry, field: { ...field, props } };
  };
  const diagnostics = [];
  const error = details => ({ level: "error", code: `${prefix}.radio_layout_source_mismatch`, path: "/form",
    message: "Radio presentation must preserve fixed source identity, scope, complete field semantics and source layout.", details });
  for (const ref of refs) {
    const before = expected.filter(entry => entry.field.sourceRef === ref), after = actual.filter(entry => entry.field.sourceRef === ref);
    if (before.length === 1 && ["H", "V"].includes(before[0].field.sourceProps?.designerValues?.alignment) &&
        before[0].field.sourceProps?.designerRadioLayoutLiteral !== true) diagnostics.push({
      level: "error", code: `${prefix}.radio_layout_source_unproven`, path: "/form",
      message: "Source radio grouping needs a complete static literal object; ignored or executable fragments cannot establish alignment.", details: { sourceRef: ref }
    });
    if (before.length !== 1 || after.length !== 1 || canonicalJson(semantics(before[0])) !== canonicalJson(semantics(after[0]))) diagnostics.push(error({ sourceRef: ref }));
  }
  const ids = new Set([...expected, ...actual].filter(radio).map(entry => entry.field.id));
  const containsRadio = object => object && typeof object === "object" &&
    (ids.has(object.referenceId) || object.refIds?.some(id => ids.has(id)) || Object.values(object).some(value =>
      Array.isArray(value) ? value.some(containsRadio) : containsRadio(value)));
  const rows = form => ({
    source: (form?.layout?.sourceGrid?.rows || []).filter(containsRadio),
    target: (form?.layout?.mkTree || []).filter(containsRadio)
  });
  if (canonicalJson(rows(expectedForm)) !== canonicalJson(rows(targetForm))) diagnostics.push(error({ reason: "source row changed" }));
  return diagnostics;
}
