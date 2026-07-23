import { parse } from "acorn";

const GENERATED_REASON = "Project an exact legacy dynamic invoice anchor into a stored NewOA hyperlink control.";

export function projectDynamicHyperlinkForm(form = {}, sourceScripts = {}) {
  let projected = form;
  for (const source of sourceScripts?.sources || []) {
    const model = dynamicHyperlinkModel(source);
    if (!model || !canProjectModel(projected, model)) continue;
    projected = projectModel(projected, model);
  }
  return projected;
}

export function dynamicHyperlinkCandidates(source = {}, form = {}) {
  const model = dynamicHyperlinkModel(source);
  if (!model || !hasProjectedModel(form, model)) return [];
  const sourceRef = source.sourceRef || source.id;
  return [{
    index: model.bindingStart,
    event: "onLoad",
    scope: "global",
    javascript: model.source,
    function: compiledDynamicHyperlinkFunction(model),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "exact legacy dynamic anchor and marked-row visibility/required branch",
      target: "native hyperlinks field + global onLoad + MKXFORM.setValue/setFieldAttr",
      basis: "deterministic-dynamic-hyperlink",
      reviewRequired: false
    }],
    semanticHints: {
      coveredCalculationRanges: [{
        sourceRef,
        name: "dynamicHyperlink",
        start: model.bindingStart,
        end: model.bindingEnd
      }],
      dynamicHyperlink: projectionEvidence(model)
    }
  }];
}

function dynamicHyperlinkModel(source = {}) {
  const text = String(source.javascript || "");
  let program;
  try {
    program = parse(text, { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return undefined;
  }
  const statements = nonEmptyStatements(program.body);
  if (statements.length !== 1 || statements[0].type !== "ExpressionStatement") return undefined;
  const binding = loadBinding(statements[0].expression);
  if (!binding) return undefined;
  const body = nonEmptyStatements(binding.callback.body?.body);
  if (body.length !== 3) return undefined;

  const urlDeclaration = legacyFieldDeclaration(body[0]);
  const conditionDeclaration = legacyFieldDeclaration(body[1]);
  if (!urlDeclaration || !conditionDeclaration || urlDeclaration.name === conditionDeclaration.name) return undefined;
  const branch = body[2];
  if (branch?.type !== "IfStatement") return undefined;
  const allowedValues = exactConditionValues(branch.test, urlDeclaration.name, conditionDeclaration.name);
  if (!allowedValues) return undefined;

  const consequent = nonEmptyStatements(branch.consequent?.body);
  const alternate = nonEmptyStatements(branch.alternate?.body);
  if (consequent.length !== 2 || alternate.length !== 1) return undefined;
  const activeRow = rowStateCall(consequent[0]);
  const inactiveRow = rowStateCall(alternate[0]);
  if (
    !activeRow || !inactiveRow ||
    activeRow.marker !== inactiveRow.marker ||
    !sameFlags(activeRow.flags, [true, true, false]) ||
    !sameFlags(inactiveRow.flags, [false, false, false])
  ) return undefined;
  const anchor = dynamicAnchorAssignment(consequent[1], urlDeclaration.name);
  if (!anchor || anchor.label !== "查看发票") return undefined;

  return {
    source: text,
    sourceRef: source.sourceRef || source.id,
    bindingStart: statements[0].start,
    bindingEnd: statements[0].end,
    sourceUrlFieldId: urlDeclaration.fieldId,
    urlVariable: urlDeclaration.name,
    conditionFieldId: conditionDeclaration.fieldId,
    conditionVariable: conditionDeclaration.name,
    allowedValues,
    rowMarker: activeRow.marker,
    containerId: anchor.containerId,
    label: anchor.label,
    generatedFieldId: generatedHyperlinkFieldId(urlDeclaration.fieldId)
  };
}

function loadBinding(expression) {
  if (
    expression?.type !== "CallExpression" ||
    expression.callee?.type !== "Identifier" ||
    expression.callee.name !== "Com_AddEventListener" ||
    expression.arguments?.length !== 3 ||
    expression.arguments[0]?.type !== "Identifier" ||
    expression.arguments[0].name !== "window" ||
    literalString(expression.arguments[1]) !== "load" ||
    !["FunctionExpression", "ArrowFunctionExpression"].includes(expression.arguments[2]?.type) ||
    expression.arguments[2].params?.length !== 0 ||
    expression.arguments[2].body?.type !== "BlockStatement"
  ) return undefined;
  return { callback: expression.arguments[2] };
}

function legacyFieldDeclaration(statement) {
  if (
    statement?.type !== "VariableDeclaration" ||
    statement.kind !== "var" ||
    statement.declarations?.length !== 1 ||
    statement.declarations[0]?.id?.type !== "Identifier"
  ) return undefined;
  const fieldId = legacyFieldValue(statement.declarations[0].init);
  if (!fieldId) return undefined;
  return { name: statement.declarations[0].id.name, fieldId };
}

function legacyFieldValue(node) {
  if (
    node?.type !== "MemberExpression" || node.computed || node.property?.name !== "value" ||
    node.object?.type !== "MemberExpression" || !node.object.computed ||
    node.object.property?.type !== "Literal" || node.object.property.value !== 0 ||
    node.object.object?.type !== "CallExpression" ||
    node.object.object.callee?.type !== "Identifier" ||
    node.object.object.callee.name !== "GetXFormFieldById" ||
    node.object.object.arguments?.length !== 1
  ) return undefined;
  return literalString(node.object.object.arguments[0]);
}

function exactConditionValues(test, urlVariable, conditionVariable) {
  if (
    test?.type !== "LogicalExpression" || test.operator !== "&&" ||
    test.left?.type !== "Identifier" || test.left.name !== urlVariable ||
    test.right?.type !== "LogicalExpression" || test.right.operator !== "||"
  ) return undefined;
  const left = equalityValue(test.right.left, conditionVariable);
  const right = equalityValue(test.right.right, conditionVariable);
  if (!left || !right || left === right) return undefined;
  return [left, right];
}

function equalityValue(expression, variable) {
  if (
    expression?.type !== "BinaryExpression" ||
    !["==", "==="].includes(expression.operator) ||
    expression.left?.type !== "Identifier" ||
    expression.left.name !== variable
  ) return undefined;
  return literalString(expression.right);
}

function rowStateCall(statement) {
  const expression = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  if (
    expression?.type !== "CallExpression" ||
    expression.callee?.type !== "Identifier" ||
    expression.callee.name !== "common_dom_row_set_show_required_reset" ||
    expression.arguments?.length !== 4
  ) return undefined;
  const marker = literalString(expression.arguments[0]);
  const flags = expression.arguments.slice(1).map(literalBoolean);
  if (!marker || flags.some((flag) => flag === undefined)) return undefined;
  return { marker, flags };
}

function dynamicAnchorAssignment(statement, urlVariable) {
  const expression = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  if (
    expression?.type !== "AssignmentExpression" || expression.operator !== "=" ||
    expression.left?.type !== "MemberExpression" || expression.left.computed ||
    expression.left.property?.name !== "innerHTML"
  ) return undefined;
  const getter = expression.left.object;
  if (
    getter?.type !== "CallExpression" ||
    getter.callee?.type !== "MemberExpression" || getter.callee.computed ||
    getter.callee.object?.type !== "Identifier" || getter.callee.object.name !== "document" ||
    getter.callee.property?.name !== "getElementById" || getter.arguments?.length !== 1
  ) return undefined;
  const containerId = literalString(getter.arguments[0]);
  const pieces = flattenStringConcat(expression.right);
  if (
    !containerId || pieces?.length !== 3 ||
    literalString(pieces[0]) !== "<a href='" ||
    pieces[1]?.type !== "Identifier" || pieces[1].name !== urlVariable ||
    typeof literalString(pieces[2]) !== "string"
  ) return undefined;
  const suffix = literalString(pieces[2]);
  const match = suffix.match(/^'>([^<>]+)<\/a>$/u);
  return match ? { containerId, label: match[1] } : undefined;
}

function flattenStringConcat(node) {
  if (node?.type !== "BinaryExpression" || node.operator !== "+") return [node];
  return [...flattenStringConcat(node.left), ...flattenStringConcat(node.right)];
}

function canProjectModel(form, model) {
  const fields = mainFields(form);
  if (!fields.has(model.sourceUrlFieldId) || !fields.has(model.conditionFieldId)) return false;
  if (fields.has(model.generatedFieldId)) return false;
  const rows = markerRows(form, model.rowMarker);
  return rows.length === 1 &&
    rows[0].componentId === "xform-flex-1-1-layout" &&
    rows[0].props?.columns === 1 &&
    rows[0].children?.length === 1;
}

function hasProjectedModel(form, model) {
  const fields = mainFields(form);
  const field = fields.get(model.generatedFieldId);
  const rows = markerRows(form, model.rowMarker);
  return fields.has(model.sourceUrlFieldId) &&
    fields.has(model.conditionFieldId) &&
    field?.componentId === "xform-hyperlinks" &&
    field?.sourceProps?.dynamicHyperlinkProjection?.sourceRef === model.sourceRef &&
    rows.length === 1 &&
    rows[0].children?.some((child) => child?.refIds?.includes(model.generatedFieldId));
}

function projectModel(form, model) {
  const evidence = projectionEvidence(model);
  return {
    ...form,
    fields: [...(form.fields || []), {
      id: model.generatedFieldId,
      title: model.label,
      type: "hyperlinks",
      componentId: "xform-hyperlinks",
      props: { largestSet: 1, editable: false },
      sourceProps: { dynamicHyperlinkProjection: evidence },
      sourceRef: model.sourceRef,
      generated: true,
      reason: GENERATED_REASON
    }],
    layout: {
      ...(form.layout || {}),
      mkTree: (form.layout?.mkTree || []).map((row) => {
        if (!row?.sourceMarkers?.includes(model.rowMarker)) return row;
        return {
          ...row,
          componentId: "xform-flex-1-2-layout",
          props: { ...(row.props || {}), columns: 2 },
          children: [...(row.children || []), {
            id: `${row.id}-cell-generated-hyperlink`,
            refType: "field",
            refIds: [model.generatedFieldId],
            sourceRef: model.sourceRef,
            generated: true,
            reason: GENERATED_REASON,
            column: 1,
            colspan: 1
          }]
        };
      })
    }
  };
}

function compiledDynamicHyperlinkFunction(model) {
  const values = model.allowedValues.map((value) => (
    `${model.conditionVariable} == ${JSON.stringify(value)}`
  )).join(" || ");
  return [
    "function onLoad() {",
    `  var ${model.urlVariable} = String(MKXFORM.getValue(${JSON.stringify(model.sourceUrlFieldId)}) || "").trim()`,
    `  var ${model.conditionVariable} = MKXFORM.getValue(${JSON.stringify(model.conditionFieldId)})`,
    `  var safeUrl = ${model.urlVariable}.indexOf("https://") === 0 || ${model.urlVariable}.indexOf("http://") === 0`,
    `  if (safeUrl && (${values})) {`,
    `    MKXFORM.setValue(${JSON.stringify(model.generatedFieldId)}, JSON.stringify([{ linkTitle: ${JSON.stringify(model.label)}, url: ${model.urlVariable} }]))`,
    `    MKXFORM.setFieldAttr(${JSON.stringify(model.rowMarker)}, 5)`,
    `    MKXFORM.setFieldAttr(${JSON.stringify(model.rowMarker)}, 3)`,
    "  } else {",
    `    MKXFORM.setValue(${JSON.stringify(model.generatedFieldId)}, "")`,
    `    MKXFORM.setFieldAttr(${JSON.stringify(model.rowMarker)}, 4)`,
    `    MKXFORM.setFieldAttr(${JSON.stringify(model.rowMarker)}, 6)`,
    "  }",
    "}"
  ].join("\n");
}

function projectionEvidence(model) {
  return {
    sourceRef: model.sourceRef,
    sourceUrlFieldId: model.sourceUrlFieldId,
    conditionFieldId: model.conditionFieldId,
    allowedValues: model.allowedValues,
    rowMarker: model.rowMarker,
    containerId: model.containerId,
    label: model.label,
    generatedFieldId: model.generatedFieldId,
    urlPolicy: "http-or-https"
  };
}

function generatedHyperlinkFieldId(sourceUrlFieldId) {
  const base = /url$/iu.test(sourceUrlFieldId)
    ? sourceUrlFieldId.replace(/url$/iu, "Link")
    : `${sourceUrlFieldId}Link`;
  return base.slice(0, 25);
}

function mainFields(form) {
  return new Map((form?.fields || [])
    .filter((field) => field?.type !== "detailTable" && field?.id)
    .map((field) => [field.id, field]));
}

function markerRows(form, marker) {
  return (form?.layout?.mkTree || []).filter((row) => row?.sourceMarkers?.includes(marker));
}

function nonEmptyStatements(statements) {
  return (Array.isArray(statements) ? statements : []).filter((statement) => statement?.type !== "EmptyStatement");
}

function literalString(node) {
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function literalBoolean(node) {
  return node?.type === "Literal" && typeof node.value === "boolean" ? node.value : undefined;
}

function sameFlags(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
