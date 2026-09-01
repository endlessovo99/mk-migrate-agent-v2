import { parse } from "acorn";
import { inlineOnChangeSourceActionKey } from "./source-action-key.js";

const BASIS = "deterministic-conditional-field-reset";

export function conditionalFieldResetCandidates(source = {}, form = {}) {
  const text = String(source.javascript || "");
  const program = parseProgram(text);
  const statements = program?.body?.filter((statement) => statement.type !== "EmptyStatement") || [];
  if (statements.length !== 1 || statements[0].type !== "ExpressionStatement") return [];
  const binding = valueChangeBinding(statements[0].expression);
  if (!binding || !formFieldIds(form).has(binding.controlId)) return [];

  const state = {
    aliases: new Map(),
    form,
    sourceValueName: binding.valueName,
    hardHiddenAssignments: 0,
    fieldResets: 0,
    rowEffects: 0
  };
  const lines = compileStatements(binding.callback.body.body, state, "  ");
  if (
    !lines ||
    state.hardHiddenAssignments !== 2 ||
    state.fieldResets < 1 ||
    state.rowEffects < 2
  ) return [];

  const sourceRef = source.sourceRef || source.id;
  return [{
    index: binding.index,
    sourceActionKey: inlineOnChangeSourceActionKey(sourceRef, binding.index),
    event: "onChange",
    scope: "control",
    controlId: binding.controlId,
    javascript: text,
    function: [
      "function onChange(value, rowNum, parentRowNum) {",
      ...lines,
      "}"
    ].join("\n"),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "complete conditional hidden-field mirror, row state, and dependent field resets",
      target: "MKXFORM.setValue + MKXFORM.setFieldAttr",
      basis: BASIS,
      reviewRequired: false
    }],
    semanticHints: {
      coveredLegacyFunctions: (source.functionAudit?.violations || [])
        .map((violation) => violation?.name)
        .filter(Boolean),
      coveredCalculationRanges: [{
        sourceRef,
        name: `conditional-field-reset:${binding.controlId}`,
        start: binding.index,
        end: statements[0].end
      }]
    }
  }];
}

function compileStatements(statements, state, indent) {
  const lines = [];
  for (const statement of statements || []) {
    if (statement.type === "EmptyStatement") continue;
    if (statement.type === "VariableDeclaration") {
      if (statement.declarations.length !== 1) return undefined;
      const declaration = statement.declarations[0];
      if (declaration.id?.type !== "Identifier" || state.aliases.has(declaration.id.name)) {
        return undefined;
      }
      const fieldId = legacyElementId(declaration.init) || jqueryFieldId(declaration.init);
      if (!fieldId || !formFieldIds(state.form).has(fieldId)) return undefined;
      state.aliases.set(declaration.id.name, fieldId);
      continue;
    }
    if (statement.type === "IfStatement") {
      const condition = containsCondition(statement.test, state.sourceValueName);
      if (!condition) return undefined;
      const consequent = compileBranch(statement.consequent, state, `${indent}  `);
      if (!consequent) return undefined;
      lines.push(`${indent}if (value.indexOf(${JSON.stringify(condition)}) >= 0) {`, ...consequent);
      if (!statement.alternate) {
        lines.push(`${indent}}`);
        continue;
      }
      const alternate = compileBranch(statement.alternate, state, `${indent}  `);
      if (!alternate) return undefined;
      lines.push(`${indent}} else {`, ...alternate, `${indent}}`);
      continue;
    }
    const row = rowEffect(statement, state.form);
    if (row) {
      lines.push(
        `${indent}MKXFORM.setFieldAttr(${JSON.stringify(row.target)}, ${row.visible ? 5 : 4})`,
        `${indent}MKXFORM.setFieldAttr(${JSON.stringify(row.target)}, ${row.required ? 3 : 6})`
      );
      state.rowEffects += 1;
      continue;
    }
    const assignment = fieldAssignment(statement, state.aliases);
    if (assignment) {
      lines.push(`${indent}MKXFORM.setValue(${JSON.stringify(assignment.fieldId)}, ${JSON.stringify(assignment.value)})`);
      const field = formField(state.form, assignment.fieldId);
      if (field?.sourceProps?.hardHidden === true) state.hardHiddenAssignments += 1;
      if (assignment.value === "" && field?.sourceProps?.hardHidden !== true) state.fieldResets += 1;
      continue;
    }
    return undefined;
  }
  return lines;
}

function compileBranch(branch, state, indent) {
  return compileStatements(branch?.type === "BlockStatement" ? branch.body : [branch], state, indent);
}

function valueChangeBinding(expression) {
  if (
    expression?.type !== "CallExpression" ||
    expression.callee?.type !== "Identifier" ||
    expression.callee.name !== "AttachXFormValueChangeEventById" ||
    expression.arguments.length !== 2 ||
    expression.arguments[0]?.type !== "Literal" ||
    typeof expression.arguments[0].value !== "string" ||
    !isFunction(expression.arguments[1]) ||
    expression.arguments[1].params[0]?.type !== "Identifier" ||
    expression.arguments[1].body?.type !== "BlockStatement"
  ) return undefined;
  return {
    index: expression.start,
    controlId: expression.arguments[0].value,
    valueName: expression.arguments[1].params[0].name,
    callback: expression.arguments[1]
  };
}

function containsCondition(node, valueName) {
  if (
    node?.type !== "BinaryExpression" ||
    ![">=", ">"].includes(node.operator) ||
    node.left?.type !== "CallExpression" ||
    node.left.callee?.type !== "MemberExpression" ||
    node.left.callee.computed ||
    node.left.callee.object?.type !== "Identifier" ||
    node.left.callee.object.name !== valueName ||
    node.left.callee.property?.name !== "indexOf" ||
    node.left.arguments.length !== 1 ||
    node.left.arguments[0]?.type !== "Literal" ||
    typeof node.left.arguments[0].value !== "string" ||
    node.right?.type !== "Literal"
  ) return undefined;
  if (
    node.operator === ">=" && node.right.value === 0 ||
    node.operator === ">" && node.right.value === -1
  ) return node.left.arguments[0].value;
  return undefined;
}

function rowEffect(statement, form) {
  const call = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  if (
    call?.type !== "CallExpression" ||
    call.callee?.type !== "Identifier" ||
    call.callee.name !== "common_dom_row_set_show_required_reset" ||
    call.arguments.length !== 4 ||
    call.arguments[0]?.type !== "Literal" ||
    typeof call.arguments[0].value !== "string" ||
    call.arguments.slice(1).some((argument) => (
      argument?.type !== "Literal" || typeof argument.value !== "boolean"
    )) ||
    !layoutMarkerSet(form).has(call.arguments[0].value)
  ) return undefined;
  return {
    target: call.arguments[0].value,
    visible: call.arguments[1].value,
    required: call.arguments[2].value
  };
}

function fieldAssignment(statement, aliases) {
  const expression = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  if (
    expression?.type === "AssignmentExpression" &&
    expression.operator === "=" &&
    expression.left?.type === "MemberExpression" &&
    !expression.left.computed &&
    expression.left.object?.type === "Identifier" &&
    expression.left.property?.name === "value" &&
    aliases.has(expression.left.object.name) &&
    expression.right?.type === "Literal" &&
    typeof expression.right.value === "string"
  ) {
    return { fieldId: aliases.get(expression.left.object.name), value: expression.right.value };
  }
  if (
    expression?.type === "CallExpression" &&
    expression.callee?.type === "MemberExpression" &&
    !expression.callee.computed &&
    expression.callee.object?.type === "Identifier" &&
    expression.callee.property?.name === "val" &&
    aliases.has(expression.callee.object.name) &&
    expression.arguments.length === 1 &&
    expression.arguments[0]?.type === "Literal" &&
    typeof expression.arguments[0].value === "string"
  ) {
    return { fieldId: aliases.get(expression.callee.object.name), value: expression.arguments[0].value };
  }
  return undefined;
}

function legacyElementId(node) {
  if (
    node?.type !== "MemberExpression" ||
    !node.computed ||
    node.property?.type !== "Literal" ||
    node.property.value !== 0 ||
    node.object?.type !== "CallExpression" ||
    node.object.callee?.type !== "Identifier" ||
    node.object.callee.name !== "GetXFormFieldById" ||
    node.object.arguments.length !== 1 ||
    node.object.arguments[0]?.type !== "Literal" ||
    typeof node.object.arguments[0].value !== "string"
  ) return undefined;
  return node.object.arguments[0].value;
}

function jqueryFieldId(node) {
  if (
    node?.type !== "CallExpression" ||
    node.callee?.type !== "Identifier" ||
    node.callee.name !== "$" ||
    node.arguments.length !== 1 ||
    node.arguments[0]?.type !== "Literal" ||
    typeof node.arguments[0].value !== "string"
  ) return undefined;
  return node.arguments[0].value.match(
    /extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)/u
  )?.[1];
}

function formField(form, fieldId) {
  return (form?.fields || []).find((field) => field?.id === fieldId);
}

function formFieldIds(form) {
  return new Set((form?.fields || []).flatMap((field) => [
    field?.id,
    ...(field?.columns || []).map((column) => column?.id)
  ]).filter(Boolean));
}

function layoutMarkerSet(form) {
  const markers = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value.sourceMarkers)) {
      value.sourceMarkers.forEach((marker) => markers.add(marker));
    }
    if (Array.isArray(value)) value.forEach(visit);
    else Object.values(value).forEach(visit);
  };
  visit(form?.layout);
  return markers;
}

function parseProgram(source) {
  try {
    return parse(String(source || ""), { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return undefined;
  }
}

function isFunction(node) {
  return node?.type === "FunctionExpression" || node?.type === "ArrowFunctionExpression";
}
