import { parse } from "acorn";
import { buildFormRuleRefIndex, resolveEffectTarget } from "../dsl/form-rules.js";
import {
  buildConditionOperandResolver
} from "../dsl/script-condition-provenance.js";
import {
  inspectLegacyDetailControlTarget,
  legacyControlAliases
} from "./detail-control-target.js";
import { inlineOnChangeSourceActionKey } from "./source-action-key.js";
import { resolveControlEventSupport } from "../dsl/scripts.js";

export const DETAIL_MAIN_ROW_LIFECYCLE_BASIS =
  "deterministic-detail-main-row-lifecycle";

const VALUE_CHANGE_API = "AttachXFormValueChangeEventById";
const WINDOW_EVENT_API = "Com_AddEventListener";
const GET_VALUE_API = "GetXFormFieldValueById";
const SET_VALUE_API = "SetXFormFieldValueById";
const ROW_HELPER = "common_dom_row_set_show_required_reset";
const NON_RESETTABLE_COMPONENTS = new Set([
  "xform-button",
  "xform-description"
]);

/**
 * Deterministically translates a detail-column listener that controls main-form
 * layout rows, including the destructive reset=true helper semantics, plus the
 * matching per-detail-row onLoad restoration.
 */
export function detailMainRowLifecycleCandidates(
  source = {},
  form = {},
  sourceScripts = {}
) {
  if (Array.isArray(source.functionAudit?.violations) && source.functionAudit.violations.length) {
    return [];
  }
  const javascript = String(source.javascript || "");
  const program = parseProgram(javascript);
  const statements = program?.body?.filter((statement) =>
    statement.type !== "EmptyStatement"
  );
  if (!statements || statements.length !== 1) return [];
  const call = expressionCall(statements[0]);
  if (!call) return [];

  const context = {
    form,
    formRuleIndex: buildFormRuleRefIndex(form),
    javascript,
    sourceBindings: buildConditionOperandResolver(javascript),
    sourceRef: source.sourceRef || source.id,
    sourceKey: source.sourceKey,
    sourceType: source.sourceType,
    fragmentId: source.fragmentId,
    sourceScripts
  };
  const change = valueChangeCandidate(call, context);
  if (change) return [change];
  const load = windowLoadCandidate(call, context);
  return load ? [load] : [];
}

function valueChangeCandidate(call, context) {
  if (
    identifierCallName(call) !== VALUE_CHANGE_API ||
    !unshadowedPlatformCall(call, context) ||
    call.arguments?.length !== 2 ||
    !isFunction(call.arguments[1])
  ) {
    return undefined;
  }
  const controlId = staticString(call.arguments[0]);
  const target = uniqueDetailColumn(context.form, controlId);
  const callback = call.arguments[1];
  const valueName = callback.params?.[0]?.type === "Identifier"
    ? callback.params[0].name
    : undefined;
  if (!target || !valueName || callback.body?.type !== "BlockStatement") {
    return undefined;
  }

  const mainWrites = boundMainWriteDomain(callback, target, controlId, valueName, context);
  if (mainWrites === false || mainWrites && call.optional) return undefined;

  const compiled = compileStatements(callback.body.body, {
    ...context,
    tableId: target.table.id,
    valueName,
    targetValueName: "value",
    mainWrites,
    indent: "  "
  });
  if (!compiled) return undefined;
  const lifecycle = {
    tableId: target.table.id,
    triggerControlId: target.column.id,
    stateControlIds: uniqueStrings([
      target.column.id,
      ...collectDetailWriteControlIds(callback.body, {
        ...context,
        tableId: target.table.id,
        valueName
      })
    ]),
    rowMarkers: collectRowMarkers(callback.body, context)
  };
  if (mainWrites) lifecycle.mainStringWriteControlIds = [mainWrites.targetId];

  return mappedCandidate({
    context,
    call,
    event: "onChange",
    scope: "control",
    tableId: target.table.id,
    controlId: target.column.id,
    sourceActionKey: inlineOnChangeSourceActionKey(context.sourceRef, call.start),
    function: [
      "function onChange(value, rowNum, parentRowNum) {",
      ...compiled,
      "}"
    ].join("\n"),
    mappingSource: "detail-column value change controlling main-form rows",
    mappingTarget: "MKXFORM.updateControl/setFieldAttr/setValue",
    lifecycle
  });
}

function windowLoadCandidate(call, context) {
  if (
    identifierCallName(call) !== WINDOW_EVENT_API ||
    !unshadowedPlatformCall(call, context) ||
    call.arguments?.length !== 3 ||
    call.arguments[0]?.type !== "Identifier" ||
    call.arguments[0].name !== "window" ||
    staticString(call.arguments[1]) !== "load" ||
    !isFunction(call.arguments[2]) ||
    call.arguments[2].body?.type !== "BlockStatement"
  ) {
    return undefined;
  }
  const listener = call.arguments[2];
  const detailReads = collectDetailReads(listener.body, context);
  if (detailReads.length !== 1) return undefined;
  const [{ table, column }] = detailReads;
  const lifecycle = matchingValueChangeLifecycle(context, table, column);
  if (!lifecycle) return undefined;
  const compiled = compileStatements(listener.body.body, {
    ...context,
    tableId: table.id,
    detailReadControlAliases: detailControlAliases(column),
    targetValueName: "value",
    indent: "    "
  });
  if (!compiled) return undefined;
  if (!sameStrings(lifecycle.rowMarkers, collectRowMarkers(listener.body, context))) {
    return undefined;
  }
  const tablePlaceholder = `\${table:${table.id}}`;

  return mappedCandidate({
    context,
    call,
    event: "onLoad",
    scope: "global",
    function: [
      "function onLoad() {",
      `  var rows = MKXFORM.getValue(${JSON.stringify(tablePlaceholder)}) || [];`,
      "  for (var rowNum = 0; rowNum < rows.length; rowNum += 1) {",
      `    var value = rows[rowNum][${JSON.stringify(column.id)}];`,
      ...compiled,
      "  }",
      "}"
    ].join("\n"),
    mappingSource: "detail-row value load restoration controlling main-form rows",
    mappingTarget: "MKXFORM.getValue/setFieldAttr/setValue",
    lifecycle
  });
}

function mappedCandidate({
  context,
  call,
  event,
  scope,
  tableId,
  controlId,
  sourceActionKey,
  function: functionText,
  mappingSource,
  mappingTarget,
  lifecycle
}) {
  return {
    index: call.start,
    event,
    scope,
    tableId,
    controlId,
    sourceActionKey,
    javascript: context.javascript,
    function: functionText,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: mappingSource,
      target: mappingTarget,
      basis: DETAIL_MAIN_ROW_LIFECYCLE_BASIS,
      reviewRequired: false
    }],
    sourceRefs: [context.sourceRef],
    semanticHints: {
      ownsLegacyRowEffects: true,
      detailMainRowLifecycle: lifecycle,
      coveredCalculationRanges: [{
        sourceRef: context.sourceRef,
        name: `detailMainRowLifecycle:${event}`,
        start: call.start,
        end: call.end
      }]
    }
  };
}

function compileStatements(statements, context) {
  const lines = [];
  for (const statement of statements || []) {
    if (statement?.type === "EmptyStatement") continue;
    const compiled = compileStatement(statement, context);
    if (!compiled) return undefined;
    lines.push(...compiled);
  }
  return lines.length ? lines : undefined;
}

function compileStatement(statement, context) {
  if (statement?.type === "IfStatement") return compileIf(statement, context);
  const rowEffect = parseRowEffect(statement, context);
  if (rowEffect) return compileRowEffect(rowEffect, context);
  const assignment = parseDetailAssignment(statement, context);
  if (assignment) {
    if (assignment.kind === "main") return [
      `${context.indent}MKXFORM.setValue(${JSON.stringify(assignment.controlId)}, ${assignment.value});`
    ];
    const target = `\${table:${context.tableId}}.${assignment.controlId}`;
    return [
      `${context.indent}MKXFORM.updateControl(${JSON.stringify(target)}, rowNum, ${assignment.value});`
    ];
  }
  return undefined;
}

function compileIf(statement, context) {
  const condition = detailCondition(statement.test, context);
  if (!condition) return undefined;
  const consequent = compileBlock(statement.consequent, {
    ...context,
    indent: `${context.indent}  `
  });
  if (!consequent) return undefined;

  const lines = [
    `${context.indent}if (${context.targetValueName} ${condition.operator} ${condition.literal}) {`,
    ...consequent
  ];
  if (!statement.alternate) {
    lines.push(`${context.indent}}`);
    return lines;
  }
  if (statement.alternate.type === "IfStatement") {
    const alternate = compileIf(statement.alternate, context);
    if (!alternate) return undefined;
    lines.push(
      `${context.indent}} else ${alternate[0].trimStart()}`,
      ...alternate.slice(1)
    );
    return lines;
  }
  const alternate = compileBlock(statement.alternate, {
    ...context,
    indent: `${context.indent}  `
  });
  if (!alternate) return undefined;
  lines.push(`${context.indent}} else {`, ...alternate, `${context.indent}}`);
  return lines;
}

function compileBlock(block, context) {
  return compileStatements(
    block?.type === "BlockStatement" ? block.body : [block],
    context
  );
}

function compileRowEffect(effect, context) {
  const resolved = resolveEffectTarget(context.formRuleIndex, effect.target);
  if (
    resolved?.source !== "rowMarker" ||
    resolved.unresolved?.length ||
    !resolved.targets?.length
  ) {
    return undefined;
  }
  const lines = [
    `${context.indent}MKXFORM.setFieldAttr(${JSON.stringify(effect.target)}, ${effect.visible ? 5 : 4});`,
    `${context.indent}MKXFORM.setFieldAttr(${JSON.stringify(effect.target)}, ${effect.required ? 3 : 6});`
  ];
  if (!effect.reset) return lines;

  const resetFieldIds = [];
  for (const target of resolved.targets) {
    if (target.kind !== "field") return undefined;
    if (NON_RESETTABLE_COMPONENTS.has(target.field?.componentId)) continue;
    if (!target.id || target.field?.dataOnly === true) return undefined;
    resetFieldIds.push(target.id);
  }
  if (!resetFieldIds.length) return undefined;
  for (const fieldId of [...new Set(resetFieldIds)]) {
    lines.push(`${context.indent}MKXFORM.setValue(${JSON.stringify(fieldId)}, "");`);
  }
  return lines;
}

function parseRowEffect(statement, context) {
  const call = expressionCall(statement);
  if (
    identifierCallName(call) !== ROW_HELPER ||
    !unshadowedPlatformCall(call, context) ||
    call.arguments?.length !== 4
  ) {
    return undefined;
  }
  const target = staticString(call.arguments[0]);
  const visible = staticBoolean(call.arguments[1]);
  const required = staticBoolean(call.arguments[2]);
  const reset = staticBoolean(call.arguments[3]);
  if (
    target === undefined ||
    visible === undefined ||
    required === undefined ||
    reset === undefined
  ) {
    return undefined;
  }
  return { target, visible, required, reset };
}

function parseDetailAssignment(statement, context) {
  const call = expressionCall(statement);
  if (identifierCallName(call) !== SET_VALUE_API || call.arguments?.length !== 2) {
    return undefined;
  }
  if (!unshadowedPlatformCall(call, context)) return undefined;
  const controlId = staticString(call.arguments[0]);
  if (context.mainWrites) {
    if (controlId !== context.mainWrites.sourceId) return undefined;
    const node = call.arguments[1], literal = scalarLiteralExpression(node, context.javascript);
    if (literal === undefined || !["number", "string"].includes(typeof node.value)) return undefined;
    // A proven single source String input stores numeric arguments using its
    // DOM-string value contract, including Number literal rounding.
    const value = typeof node.value === "string" ? literal : "`" + "${" + literal + "}`";
    return { kind: "main", controlId: context.mainWrites.targetId, value };
  }
  const target = uniqueDetailColumn(context.form, controlId);
  if (!target || target.table.id !== context.tableId) return undefined;
  const value = targetExpression(call.arguments[1], context);
  return value === undefined
    ? undefined
    : { controlId: target.column.id, value };
}

function targetExpression(node, context) {
  if (node?.type === "Identifier" && node.name === context.valueName) {
    return context.targetValueName;
  }
  return scalarLiteralExpression(node, context.javascript);
}

function detailCondition(node, context) {
  if (
    node?.type !== "BinaryExpression" ||
    !["==", "==="].includes(node.operator)
  ) {
    return undefined;
  }
  const leftIsValue = isDetailConditionOperand(node.left, context);
  const rightIsValue = isDetailConditionOperand(node.right, context);
  if (leftIsValue === rightIsValue) return undefined;
  const literal = scalarLiteralExpression(
    leftIsValue ? node.right : node.left,
    context.javascript
  );
  return literal === undefined
    ? undefined
    : { operator: node.operator, literal };
}

function isDetailConditionOperand(node, context) {
  if (
    context.valueName &&
    node?.type === "Identifier" &&
    node.name === context.valueName
  ) {
    return true;
  }
  if (!context.detailReadControlAliases?.length || node?.type !== "CallExpression") {
    return false;
  }
  return identifierCallName(node) === GET_VALUE_API &&
    unshadowedPlatformCall(node, context) &&
    node.arguments?.length === 1 &&
    context.detailReadControlAliases.includes(staticString(node.arguments[0]));
}

function collectDetailReads(node, context) {
  const reads = [];
  walk(node, (candidate) => {
    if (
      candidate?.type !== "CallExpression" ||
      identifierCallName(candidate) !== GET_VALUE_API ||
      !unshadowedPlatformCall(candidate, context) ||
      candidate.arguments?.length !== 1
    ) {
      return;
    }
    const controlId = staticString(candidate.arguments[0]);
    const target = uniqueDetailColumn(context.form, controlId);
    if (target) reads.push(target);
  });
  const unique = new Map(reads.map((read) => [
    `${read.table.id}.${read.column.id}`,
    read
  ]));
  return [...unique.values()];
}

function unshadowedPlatformCall(call, context) {
  const name = identifierCallName(call);
  return Boolean(
    name &&
    context.sourceBindings?.isUnshadowedGlobal(name, call.callee.start)
  );
}

function uniqueDetailColumn(form, controlId) {
  const target = inspectLegacyDetailControlTarget(form, controlId);
  return target.status === "resolved"
    ? { table: target.table, column: target.column }
    : undefined;
}

function scalarLiteralExpression(node, source) {
  if (node?.type !== "Literal") {
    return undefined;
  }
  if (typeof node.value === "string" || typeof node.value === "boolean") {
    return JSON.stringify(node.value);
  }
  if (typeof node.value !== "number" || !Number.isFinite(node.value)) {
    return undefined;
  }
  const raw = String(source || "").slice(node.start, node.end).trim();
  return /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)
    ? raw
    : undefined;
}

function collectDetailWriteControlIds(node, context) {
  const controlIds = [];
  walk(node, (candidate) => {
    if (candidate?.type !== "ExpressionStatement") return;
    const assignment = parseDetailAssignment(candidate, context);
    if (assignment?.kind !== "main" && assignment) controlIds.push(assignment.controlId);
  });
  return uniqueStrings(controlIds);
}

function collectRowMarkers(node, context) {
  const rowMarkers = [];
  walk(node, (candidate) => {
    if (candidate?.type !== "ExpressionStatement") return;
    const effect = parseRowEffect(candidate, context);
    if (effect) rowMarkers.push(effect.target);
  });
  return uniqueStrings(rowMarkers).sort();
}

function matchingValueChangeLifecycle(context, table, column) {
  const matches = [];
  for (const source of context.sourceScripts?.sources || []) {
    if ((source.sourceRef || source.id) === context.sourceRef) continue;
    if (!sameSourceOwner(context, source)) {
      continue;
    }
    if (
      Array.isArray(source.functionAudit?.violations) &&
      source.functionAudit.violations.length
    ) {
      continue;
    }
    const javascript = String(source.javascript || "");
    const program = parseProgram(javascript);
    const statements = program?.body?.filter((statement) =>
      statement.type !== "EmptyStatement"
    );
    if (!statements || statements.length !== 1) continue;
    const call = expressionCall(statements[0]);
    if (!call) continue;
    const candidate = valueChangeCandidate(call, {
      ...context,
      javascript,
      sourceBindings: buildConditionOperandResolver(javascript),
      sourceRef: source.sourceRef || source.id,
      sourceKey: source.sourceKey,
      sourceType: source.sourceType,
      fragmentId: source.fragmentId
    });
    const lifecycle = candidate?.semanticHints?.detailMainRowLifecycle;
    if (
      lifecycle?.tableId === table.id && !lifecycle.mainStringWriteControlIds?.length &&
      lifecycle.stateControlIds?.includes(column.id)
    ) {
      matches.push(lifecycle);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

// Extend the existing detail recipe only for one independently source-bound
// String store. The ordinary detail-to-detail lifecycle remains unchanged.
function boundMainWriteDomain(callback, target, controlId, valueName, context) {
  const calls = [];
  walk(callback.body, node => { if (identifierCallName(node) === SET_VALUE_API) calls.push(node); });
  const mainTargets = calls.map(call => sourceBoundMainString(context.form, staticString(call.arguments[0])));
  if (!mainTargets.some(Boolean)) return undefined;
  if (!mainTargets.every(Boolean) || new Set(mainTargets.map(field => field.id)).size !== 1 ||
      callback.type !== "FunctionExpression" || callback.async || callback.generator || callback.id ||
      ![1, 2].includes(callback.params.length) || callback.params.some(node => node.type !== "Identifier") ||
      new Set(callback.params.map(node => node.name)).size !== callback.params.length ||
      target.column.type !== "singleSelect" || target.column.componentId !== "xform-select" ||
      resolveControlEventSupport({ kind: "detail", field: target.column }, "onChange").status !== "supported" ||
      !sameSourceControl(target.column, controlId) ||
      context.form.fields.some(field => field.type !== "detailTable" && legacyControlAliases(field).includes(controlId)) ||
      !collectRowMarkers(callback.body, context).length) return false;
  let valid = true, conditions = 0;
  walk(callback.body, node => {
    if (node.type !== "IfStatement") return;
    conditions += 1;
    const test = node.test;
    if (test?.type !== "BinaryExpression" || !["==", "==="].includes(test.operator)) { valid = false; return; }
    const literal = test.left?.type === "Identifier" && test.left.name === valueName ? test.right :
      test.right?.type === "Identifier" && test.right.name === valueName ? test.left : undefined;
    if (scalarLiteralExpression(literal, context.javascript) === undefined ||
        !(typeof literal.value === "number" && literal.value !== 0 ||
          typeof literal.value === "string" && literal.value !== "" && Number(literal.value) !== 0)) valid = false;
  });
  if (!valid || !conditions || calls.some(call => call.optional || !unshadowedPlatformCall(call, context))) return false;
  return { sourceId: staticString(calls[0].arguments[0]), targetId: mainTargets[0].id };
}

function sourceBoundMainString(form, controlId) {
  const matches = (form.fields || []).filter(field => field.type !== "detailTable" && legacyControlAliases(field).includes(controlId));
  if (matches.length !== 1) return undefined;
  const field = matches[0], fact = field.sourceProps?.mainStringValueBindingFact;
  if (!["text", "longText"].includes(field.type) || field.dataOnly !== true || !["xform-hidden", "xform-input"].includes(field.componentId) ||
      !sameSourceControl(field, controlId) || fact?.version !== 1 || fact.status !== "verified" || fact.fieldId !== controlId ||
      fact.metadata?.count !== 1 || fact.metadata.type !== "String" ||
      !["designer", "display"].every(name => fact.surfaces?.[name]?.logicalBindingCount === 1 &&
        fact.surfaces[name].hiddenBindingCount === 1 && fact.surfaces[name].issues?.length === 0)) return undefined;
  return field;
}
function sameSourceControl(field, controlId) {
  const ids = [field.sourceProps?.originalId, field.sourceProps?.designerId, field.sourceProps?.metadataId].filter(Boolean);
  return ids.length > 0 && ids.every(id => id === controlId);
}

function sameStrings(left = [], right = []) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function detailControlAliases(column) {
  return legacyControlAliases(column);
}

function sameSourceOwner(context, source) {
  if (context.fragmentId || source.fragmentId) {
    return Boolean(
      context.fragmentId &&
      source.fragmentId === context.fragmentId &&
      source.sourceType === context.sourceType
    );
  }
  return Boolean(
    context.sourceKey &&
    source.sourceKey === context.sourceKey &&
    source.sourceType === context.sourceType
  );
}

function staticString(node) {
  return node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;
}

function staticBoolean(node) {
  return node?.type === "Literal" && typeof node.value === "boolean"
    ? node.value
    : undefined;
}

function identifierCallName(call) {
  return call?.type === "CallExpression" && call.callee?.type === "Identifier"
    ? call.callee.name
    : undefined;
}

function expressionCall(statement) {
  return statement?.type === "ExpressionStatement"
    ? statement.expression
    : undefined;
}

function isFunction(node) {
  return ["FunctionExpression", "ArrowFunctionExpression"].includes(node?.type);
}

function parseProgram(source) {
  try {
    return parse(String(source || ""), {
      ecmaVersion: "latest",
      sourceType: "script"
    });
  } catch {
    return undefined;
  }
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["start", "end"].includes(key)) continue;
    if (Array.isArray(value)) {
      value.forEach((child) => walk(child, visit));
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      walk(value, visit);
    }
  }
}
