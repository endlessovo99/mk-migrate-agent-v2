import { parse } from "acorn";
import { inlineOnChangeSourceActionKey } from "./source-action-key.js";

export const RADIO_CHECKED_ONCLICK_BASIS = "deterministic-radio-checked-onclick-lifecycle";

export function radioCheckedOnclickLifecycleCandidates(source = {}, form = {}) {
  const text = String(source.javascript || "");
  const program = parseProgram(text);
  if (!program) return [];
  const model = radioCheckedOnclickModel(program, form, text);
  if (!model) return [];

  const sourceRef = source.sourceRef || source.id;
  const mapping = {
    source: "radio .checked / getAttribute('checked') fallback plus option onclick controlDisplay",
    target: "MKXFORM.getValue/setValue/setFieldAttr and control onChange",
    basis: RADIO_CHECKED_ONCLICK_BASIS,
    reviewRequired: false
  };
  const semanticHints = {
    coveredLegacyFunctions: (source.functionAudit?.violations || [])
      .map((violation) => violation?.name)
      .filter(Boolean),
    coveredCalculationRanges: [{
      sourceRef,
      name: "radioCheckedOnclickLifecycle",
      start: 0,
      end: Math.max(1, text.length)
    }]
  };
  const common = {
    javascript: text,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [mapping],
    sourceRefs: [sourceRef],
    semanticHints
  };
  return [{
    ...common,
    index: model.loadStart,
    event: "onLoad",
    scope: "global",
    function: renderOnLoad(model)
  }, {
    ...common,
    index: model.onclickStart,
    sourceActionKey: inlineOnChangeSourceActionKey(sourceRef, model.onclickStart),
    event: "onChange",
    scope: "control",
    controlId: model.statusFieldId,
    function: renderOnChange(model)
  }];
}

function radioCheckedOnclickModel(program, form, text) {
  const statements = nonEmpty(program.body);
  if (statements.length !== 3) return undefined;
  const dealSpan = statements.find((statement) =>
    statement.type === "FunctionDeclaration" && statement.id?.name === "dealSpan"
  );
  const controlDisplay = statements.find((statement) =>
    statement.type === "FunctionDeclaration" && statement.id?.name === "controlDisplay"
  );
  const loadStatement = statements.find((statement) => isWindowLoad(statement));
  if (!dealSpan || !controlDisplay || !loadStatement) return undefined;
  if (!textIncludes(dealSpan, "次数") || !textIncludes(dealSpan, "getElementsByTagName")) {
    return undefined;
  }

  const display = controlDisplayModel(controlDisplay);
  if (!display) return undefined;

  const loadCall = expressionCall(loadStatement);
  const loadText = text.slice(loadCall.arguments[2].start, loadCall.arguments[2].end);
  const rowMarkers = [...loadText.matchAll(
    /common_dom_row_set_show_required_reset\(\s*["'](fd_[A-Za-z0-9_]+)["']\s*,\s*false\s*,\s*false\s*,\s*false\s*\)/gu
  )].map((match) => match[1]);
  const uniqueMarkers = [...new Set(rowMarkers)];
  if (uniqueMarkers.length !== 3) return undefined;

  const statusMatches = [...loadText.matchAll(
    /GetXFormFieldById\(\s*["'](fd_[A-Za-z0-9_]+)["']\s*\)\s*\[\s*([01])\s*\]/gu
  )];
  const statusFieldId = statusMatches[0]?.[1];
  if (
    !statusFieldId ||
    statusMatches.length < 2 ||
    statusMatches.some((match) => match[1] !== statusFieldId)
  ) {
    return undefined;
  }
  if ((loadText.match(/setAttribute\(\s*["']onclick["']/gu) || []).length !== 2) return undefined;
  if (!loadText.includes("controlDisplay(")) return undefined;
  if (!/document\.getElementById\(\s*["']times["']\s*\)/.test(loadText)) return undefined;

  const typeFieldId = loadText.match(
    /cat\s*=\s*GetXFormFieldById\(\s*["'](fd_[A-Za-z0-9_]+)["']\s*\)/
  )?.[1];
  const statusReadId = [...loadText.matchAll(
    /cat\s*=\s*GetXFormFieldById\(\s*["'](fd_[A-Za-z0-9_]+)["']\s*\)/gu
  )].at(-1)?.[1];
  if (!typeFieldId || statusReadId !== statusFieldId) return undefined;
  if (!loadText.includes(".checked") || !loadText.includes('getAttribute("checked")')) return undefined;

  const markers = layoutMarkerSet(form);
  if (
    !hardHiddenField(form, display.hiddenFieldId) ||
    !mainField(form, display.timesFieldId) ||
    !radioField(form, typeFieldId) ||
    !radioField(form, statusFieldId) ||
    uniqueMarkers.some((marker) => !markers.has(marker))
  ) {
    return undefined;
  }

  const onclickStart = text.indexOf("setAttribute(\"onclick\"");
  if (onclickStart < 0) return undefined;

  return {
    ...display,
    rowMarkers: uniqueMarkers,
    typeFieldId,
    statusFieldId,
    loadStart: loadCall.start,
    onclickStart
  };
}

function controlDisplayModel(declaration) {
  if (declaration.params?.length !== 1 || declaration.params[0]?.type !== "Identifier") {
    return undefined;
  }
  const valueName = declaration.params[0].name;
  const body = nonEmpty(declaration.body?.body);
  if (body.length !== 4) return undefined;
  const hidden = indexedFieldAlias(body[0]);
  const times = timesAlias(body[1]);
  const timesField = indexedFieldAlias(body[2]);
  if (!hidden || !times || !timesField) return undefined;
  const branch = body[3];
  if (branch?.type !== "IfStatement") return undefined;
  const matchValue = equalityLiteral(branch.test, valueName);
  const consequent = blockStatements(branch.consequent);
  const alternate = blockStatements(branch.alternate);
  if (
    matchValue === undefined ||
    !isMemberValueAssign(consequent[0], hidden.name, "true") ||
    !isDisplayAssign(consequent[1], times.name, "") ||
    !isSetAttribute(consequent[2], timesField.name, "validate", "required") ||
    consequent.length !== 3 ||
    !isMemberValueAssign(alternate[0], hidden.name, "") ||
    !isDisplayAssign(alternate[1], times.name, "none") ||
    !isSetAttribute(alternate[2], timesField.name, "validate", "") ||
    !isNamedCall(alternate[3], "dealSpan") ||
    alternate.length !== 4
  ) {
    return undefined;
  }
  return {
    hiddenFieldId: hidden.fieldId,
    timesFieldId: timesField.fieldId,
    matchValue
  };
}

function renderOnLoad(model) {
  const [projectRow, managerRow, otherRow] = model.rowMarkers;
  return [
    "function onLoad() {",
    `  MKXFORM.setFieldAttr(${JSON.stringify(projectRow)}, 4)`,
    `  MKXFORM.setFieldAttr(${JSON.stringify(projectRow)}, 6)`,
    `  MKXFORM.setFieldAttr(${JSON.stringify(managerRow)}, 4)`,
    `  MKXFORM.setFieldAttr(${JSON.stringify(managerRow)}, 6)`,
    `  MKXFORM.setFieldAttr(${JSON.stringify(otherRow)}, 4)`,
    `  MKXFORM.setFieldAttr(${JSON.stringify(otherRow)}, 6)`,
    `  var typeValue = MKXFORM.getValue(${JSON.stringify(model.typeFieldId)})`,
    "  typeValue = Array.isArray(typeValue) ? typeValue[0] : typeValue",
    "  typeValue = typeValue == null ? \"\" : String(typeValue)",
    "  if (typeValue === \"xmz\") {",
    `    MKXFORM.setFieldAttr(${JSON.stringify(projectRow)}, 5)`,
    `    MKXFORM.setFieldAttr(${JSON.stringify(projectRow)}, 3)`,
    `    MKXFORM.setFieldAttr(${JSON.stringify(managerRow)}, 5)`,
    `    MKXFORM.setFieldAttr(${JSON.stringify(managerRow)}, 3)`,
    "  }",
    "  if (typeValue === \"qt\") {",
    `    MKXFORM.setFieldAttr(${JSON.stringify(otherRow)}, 5)`,
    `    MKXFORM.setFieldAttr(${JSON.stringify(otherRow)}, 3)`,
    "  }",
    `  var statusValue = MKXFORM.getValue(${JSON.stringify(model.statusFieldId)})`,
    "  statusValue = Array.isArray(statusValue) ? statusValue[0] : statusValue",
    `  var timesVisible = String(statusValue || "") === ${JSON.stringify(model.matchValue)}`,
    `  MKXFORM.setFieldAttr(${JSON.stringify(model.timesFieldId)}, timesVisible ? 5 : 4)`,
    "}"
  ].join("\n");
}

function renderOnChange(model) {
  return [
    "function onChange(value, rowNum, parentRowNum) {",
    "  var selected = Array.isArray(value) ? value[0] : value",
    `  var active = String(selected || "") === ${JSON.stringify(model.matchValue)}`,
    `  MKXFORM.setValue(${JSON.stringify(model.hiddenFieldId)}, active ? "true" : "")`,
    `  MKXFORM.setFieldAttr(${JSON.stringify(model.timesFieldId)}, active ? 5 : 4)`,
    `  MKXFORM.setFieldAttr(${JSON.stringify(model.timesFieldId)}, active ? 3 : 6)`,
    "}"
  ].join("\n");
}

function indexedFieldAlias(statement) {
  const declaration = statement?.type === "VariableDeclaration" ? statement.declarations?.[0] : undefined;
  if (!declaration || declaration.id?.type !== "Identifier") return undefined;
  const init = declaration.init;
  if (
    init?.type !== "MemberExpression" ||
    !init.computed ||
    init.property?.value !== 0
  ) {
    return undefined;
  }
  const call = init.object;
  if (
    call?.type !== "CallExpression" ||
    call.callee?.name !== "GetXFormFieldById" ||
    call.arguments?.length !== 1
  ) {
    return undefined;
  }
  const fieldId = literalString(call.arguments[0]);
  return fieldId ? { name: declaration.id.name, fieldId } : undefined;
}

function timesAlias(statement) {
  const declaration = statement?.type === "VariableDeclaration" ? statement.declarations?.[0] : undefined;
  const init = declaration?.init;
  return declaration?.id?.type === "Identifier" &&
    init?.type === "CallExpression" &&
    init.callee?.type === "MemberExpression" &&
    init.callee.object?.name === "document" &&
    init.callee.property?.name === "getElementById" &&
    literalString(init.arguments?.[0]) === "times"
    ? { name: declaration.id.name }
    : undefined;
}

function isMemberValueAssign(statement, alias, value) {
  const assignment = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  return assignment?.type === "AssignmentExpression" &&
    assignment.left?.object?.name === alias &&
    assignment.left?.property?.name === "value" &&
    literalString(assignment.right) === value;
}

function isDisplayAssign(statement, alias, value) {
  const assignment = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  return assignment?.type === "AssignmentExpression" &&
    assignment.left?.property?.name === "display" &&
    assignment.left?.object?.object?.name === alias &&
    assignment.left?.object?.property?.name === "style" &&
    literalString(assignment.right) === value;
}

function isSetAttribute(statement, alias, name, value) {
  const call = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  return call?.type === "CallExpression" &&
    call.callee?.object?.name === alias &&
    call.callee?.property?.name === "setAttribute" &&
    literalString(call.arguments?.[0]) === name &&
    literalString(call.arguments?.[1]) === value;
}

function isNamedCall(statement, name) {
  const call = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  return call?.type === "CallExpression" &&
    call.callee?.name === name &&
    call.arguments?.length === 0;
}

function isWindowLoad(statement) {
  const call = expressionCall(statement);
  return call?.callee?.name === "Com_AddEventListener" &&
    call.arguments?.[0]?.name === "window" &&
    literalString(call.arguments?.[1]) === "load";
}

function equalityLiteral(test, alias) {
  if (
    test?.type !== "BinaryExpression" ||
    !["==", "==="].includes(test.operator) ||
    test.left?.name !== alias
  ) {
    return undefined;
  }
  return literalString(test.right);
}

function hardHiddenField(form, fieldId) {
  const field = mainField(form, fieldId);
  return field?.sourceProps?.hardHidden === true || field?.componentId === "xform-hidden"
    ? field
    : undefined;
}

function radioField(form, fieldId) {
  const field = mainField(form, fieldId);
  return field?.componentId === "xform-radio" ? field : undefined;
}

function mainField(form, fieldId) {
  return (form?.fields || []).find((field) => field?.id === fieldId && field.type !== "detailTable");
}

function layoutMarkerSet(form) {
  return new Set(
    (form?.layout?.mkTree || []).flatMap((node) =>
      Array.isArray(node?.sourceMarkers) ? node.sourceMarkers : []
    )
  );
}

function blockStatements(node) {
  if (!node) return [];
  if (node.type === "BlockStatement") return nonEmpty(node.body);
  return [node];
}

function expressionCall(statement) {
  return statement?.type === "ExpressionStatement" && statement.expression?.type === "CallExpression"
    ? statement.expression
    : undefined;
}

function literalString(node) {
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function textIncludes(node, snippet) {
  try {
    return JSON.stringify(node).includes(snippet);
  } catch {
    return false;
  }
}

function nonEmpty(nodes = []) {
  return nodes.filter((node) => node?.type !== "EmptyStatement");
}

function parseProgram(text) {
  try {
    return parse(String(text || ""), { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return undefined;
  }
}
