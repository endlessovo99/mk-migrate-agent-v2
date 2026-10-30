import { canonicalJson } from "../agent-review/digest.js";

/** Only the source-bound choice/explanation presentation needs this extra check. */
export function choiceOtherStorageExpectation(field, form = {}) {
  const id = field.sourceProps?.originalId || field.id;
  const related = (form.fields || []).some(choice => ["xform-checkbox", "xform-select"].includes(choice.componentId) &&
    choice.sourceProps?.otherTextCompanion &&
    [choice.sourceProps.originalId || choice.id, choice.sourceProps.otherTextCompanion.id,
      choice.sourceProps.otherTextCompanion.captionId].includes(id));
  return related ? !["description", "button"].includes(field.type) : undefined;
}

/** Source-only associations; no inferred encoding or native lifecycle. */
function sourcePairs(form = {}) {
  const scopes = [
    { fields: [...(form.controls || []), ...(form.dataFields || [])] },
    ...(form.detailTables || []).map(table => ({ fields: table.columns || [], tableRef: table.sourceRef || table.id }))
  ];
  return scopes.flatMap(scope => scope.fields.filter(field =>
    ["checkbox", "radio", "singleSelect"].includes(field.sourceType) && field.sourceProps?.otherTextCompanion?.id
  ).map(choice => {
    const relation = choice.sourceProps.otherTextCompanion;
    const texts = scope.fields.filter(field => field.id === relation.id);
    const captions = relation.captionId ? scope.fields.filter(field => field.id === relation.captionId) : [];
    return { choice, text: texts.length === 1 ? texts[0] : undefined,
      caption: captions.length === 1 ? captions[0] : undefined,
      captionId: relation.captionId, tableRef: scope.tableRef };
  }));
}

export function choiceOtherSourceErrors(sourceForm = {}) {
  return sourcePairs(sourceForm).flatMap(pair => {
    const details = { sourceRef: pair.choice.sourceRef, fieldId: pair.choice.id,
      companionId: pair.text?.id || pair.choice.sourceProps.otherTextCompanion.id };
    const error = (suffix, message) => ({ code: `source.form.${suffix}`, message, path: "/form", details });
    const errors = [];
    if (!pair.text || pair.text.sourceType !== "text") errors.push(error("choice_other_identity_unproven",
      "The source choice/text association must retain one independent text field in the same scope."));
    if (pair.tableRef) errors.push(error("choice_other_detail_layout_unproven",
      "A source detail cell with choice and independent text has no proven equivalent native compound-column contract."));
    return errors;
  }).concat(visibleSourceChoices(sourceForm).filter(field =>
    (field.options || []).some(option => option.value === "other_")
  ).map(field => ({
    code: "source.form.choice_other_reserved_value_unproven",
    message: "The original choice code collides with the native Other branch; retain its code and keep this mapping unverified.",
    path: "/form", details: { sourceRef: field.sourceRef, fieldId: field.id, reservedValue: "other_" }
  })));
}

function visibleSourceChoices(form) {
  const visible = field => field?.dataOnly !== true && field?.sourceProps?.hardHidden !== true;
  return [...(form?.controls || []), ...(form?.detailTables || []).filter(visible).flatMap(table => table.columns || [])]
    .filter(field => visible(field) && ["checkbox", "radio"].includes(field.sourceType));
}

export function choiceOtherCompanionDiagnostics(sourceForm, targetForm, expectedForm, { prefix = "trust.form" } = {}) {
  const diagnostics = choiceOtherSourceErrors(sourceForm).map(item => ({ ...item, level: "error",
    code: item.code.replace(/^source\.form/, prefix) }));
  const flatten = form => (form?.fields || []).flatMap(field => field.type === "detailTable"
    ? (field.columns || []).map(column => ({ field: column, tableRef: field.sourceRef || field.id }))
    : [{ field }]);
  const expectedFields = flatten(expectedForm), actualFields = flatten(targetForm);
  // Older retained DSLs have no reveal policy. An opted-in policy must match
  // the source-derived translator result exactly; it cannot be added by a
  // review patch or moved to a different field.
  for (const entry of actualFields.filter(item => item.field?.otherPresentation !== undefined)) {
    const expected = expectedFields.filter(item => item.field?.sourceRef === entry.field.sourceRef);
    if (entry.tableRef || expected.length !== 1 || expected[0].tableRef ||
        canonicalJson(entry.field.otherPresentation) !== canonicalJson(expected[0].field.otherPresentation)) {
      diagnostics.push({ level: "error", code: `${prefix}.choice_other_reveal_source_mismatch`,
        message: "Other reveal presentation must match the source-derived, script-safe relationship.",
        path: "/form", details: { fieldId: entry.field.id, sourceRef: entry.field.sourceRef } });
    }
  }
  for (const pair of sourcePairs(sourceForm)) {
    if (pair.tableRef || !pair.text) continue;
    const sources = [pair.choice, pair.text, ...(pair.caption ? [pair.caption] : [])];
    const ids = [];
    let complete = true;
    for (const source of sources) {
      const fixed = expectedFields.filter(entry => entry.field.sourceRef === source.sourceRef);
      const actual = actualFields.filter(entry => entry.field.sourceRef === source.sourceRef);
      if (fixed.length !== 1 || actual.length !== 1 || fixed[0]?.tableRef || actual[0]?.tableRef ||
          canonicalJson(fieldSemantics(fixed[0]?.field)) !== canonicalJson(fieldSemantics(actual[0]?.field))) complete = false;
      if (fixed.length === 1) ids.push(fixed[0].field.id);
    }
    // Preserve the independent caption at its source position, not merely as a
    // stored description elsewhere in the form.
    if (pair.captionId && !pair.caption) complete = false;
    if (canonicalJson(presentation(expectedForm, ids)) !== canonicalJson(presentation(targetForm, ids))) complete = false;
    if (!complete) diagnostics.push({ level: "error", code: `${prefix}.choice_other_companion_source_mismatch`,
      message: "Independent source choice codes, text, caption, permissions, defaults and presentation must not be folded or replaced by a composite Other value.",
      path: "/form", details: { fieldId: pair.choice.id, companionId: pair.text.id, sourceRef: pair.choice.sourceRef } });
  }
  return diagnostics;
}

function fieldSemantics(field) {
  const props = { ...(field?.props || {}) };
  for (const key of ["required", "readOnly", "hiddenLabel"]) if (props[key] === false) delete props[key];
  return { id: field?.id, title: field?.title, type: field?.type, componentId: field?.componentId, sourceRef: field?.sourceRef,
    dataOnly: field?.dataOnly === true, props, sourceProps: field?.sourceProps };
}

function presentation(form, ids) {
  const selected = new Set(ids), cells = [];
  function visit(node, path) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.refIds) && node.refIds.some(id => selected.has(id))) cells.push({ path, cell: node });
    for (const [key, child] of Object.entries(node)) {
      if (Array.isArray(child)) child.forEach((item, index) => visit(item, `${path}/${key}/${index}`));
      else if (child && typeof child === "object") visit(child, `${path}/${key}`);
    }
  }
  visit(form?.layout, "/layout");
  return cells;
}
