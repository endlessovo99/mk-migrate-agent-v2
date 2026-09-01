import { parse } from "acorn";
import { inlineOnChangeSourceActionKey } from "./source-action-key.js";

export const RADIO_OPTION_VISIBILITY_BASIS = "deterministic-radio-option-visibility";

export function radioOptionVisibilityCandidates(source = {}, form = {}) {
  const text = String(source.javascript || "");
  const program = parseProgram(text);
  if (!program) return [];
  const model = radioOptionVisibilityModel(program, form);
  if (!model) return [];

  const sourceRef = source.sourceRef || source.id;
  const mapping = {
    source: "named radio option parent().show/hide by eq(index)",
    target: "MKXFORM.setProps options",
    basis: RADIO_OPTION_VISIBILITY_BASIS,
    reviewRequired: false
  };
  const semanticHints = {
    coveredLegacyFunctions: (source.functionAudit?.violations || [])
      .map((violation) => violation?.name)
      .filter(Boolean),
    coveredCalculationRanges: [{
      sourceRef,
      name: `radioOptionVisibility:${model.handlerName}`,
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
  const candidates = [];
  if (model.loadStart >= 0) {
    candidates.push({
      ...common,
      index: model.loadStart,
      event: "onLoad",
      scope: "global",
      function: renderVisibilityFunction("onLoad", model)
    });
  }
  candidates.push({
    ...common,
    index: model.bindingStart,
    sourceActionKey: inlineOnChangeSourceActionKey(sourceRef, model.bindingStart),
    event: "onChange",
    scope: "control",
    controlId: model.triggerId,
    function: renderVisibilityFunction("onChange", model)
  });
  return candidates;
}

function radioOptionVisibilityModel(program, form) {
  const statements = nonEmpty(program.body);
  const handler = statements.find((statement) =>
    statement.type === "FunctionDeclaration" &&
    statement.id?.type === "Identifier" &&
    statement.params.length === 0 &&
    statement.body?.type === "BlockStatement"
  );
  if (!handler) return undefined;

  const bindingStatement = statements.find((statement) => {
    const call = expressionCall(statement);
    return call?.callee?.type === "Identifier" &&
      call.callee.name === "AttachXFormValueChangeEventById" &&
      call.arguments?.[1]?.type === "Identifier" &&
      call.arguments[1].name === handler.id.name;
  });
  const loadStatement = statements.find((statement) =>
    isWindowLoadCalling(statement, handler.id.name)
  );
  const expectedCount = loadStatement ? 3 : 2;
  if (!bindingStatement || statements.length !== expectedCount) return undefined;

  const triggerId = literalString(expressionCall(bindingStatement).arguments?.[0]);
  const body = nonEmpty(handler.body.body);
  if (!triggerId || body.length < 3) return undefined;

  const sourceDecl = jqueryCheckedValDeclaration(body[0]);
  const targetDecl = jqueryFieldCollectionDeclaration(body[1]);
  if (!sourceDecl || !targetDecl || sourceDecl.fieldId !== triggerId) return undefined;

  const trigger = radioField(form, triggerId);
  const target = radioField(form, targetDecl.fieldId);
  const options = radioOptions(target);
  if (!trigger || !options.length) return undefined;

  const branches = [];
  for (const statement of body.slice(2)) {
    if (statement.type !== "IfStatement" || statement.alternate) return undefined;
    const value = equalityLiteral(statement.test, sourceDecl.name);
    if (value === undefined) return undefined;
    const ops = optionVisibilityOps(statement.consequent, targetDecl.name, options.length);
    if (!ops) return undefined;
    branches.push({
      value,
      options: options.filter((_, index) => applyVisibility(options.length, ops).has(index))
    });
  }
  if (!branches.length) return undefined;

  return {
    handlerName: handler.id.name,
    triggerId,
    targetId: target.id,
    allOptions: options,
    branches,
    bindingStart: expressionCall(bindingStatement).start,
    loadStart: loadStatement ? expressionCall(loadStatement).start : -1
  };
}

function renderVisibilityFunction(event, model) {
  const selectedExpr = event === "onLoad"
    ? `MKXFORM.getValue(${JSON.stringify(model.triggerId)})`
    : "value";
  const lines = event === "onLoad"
    ? [
      "function onLoad() {",
      `  var selected = ${selectedExpr}`,
      "  selected = Array.isArray(selected) ? selected[0] : selected"
    ]
    : [
      "function onChange(value, rowNum, parentRowNum) {",
      "  var selected = Array.isArray(value) ? value[0] : value"
    ];
  lines.push("  selected = selected == null ? \"\" : String(selected)");
  model.branches.forEach((branch, index) => {
    const keyword = index === 0 ? "if" : "else if";
    lines.push(
      `  ${keyword} (selected === ${JSON.stringify(branch.value)}) {`,
      `    MKXFORM.setProps(${JSON.stringify(model.targetId)}, { options: ${JSON.stringify(branch.options)} })`,
      "  }"
    );
  });
  lines.push("}");
  return lines.join("\n");
}

function jqueryCheckedValDeclaration(statement) {
  const declaration = singleDeclarator(statement);
  const valCall = declaration?.init;
  if (
    valCall?.type !== "CallExpression" ||
    valCall.callee?.type !== "MemberExpression" ||
    valCall.callee.computed ||
    valCall.callee.property?.name !== "val" ||
    valCall.arguments?.length
  ) {
    return undefined;
  }
  const fieldId = jqueryExtendInputSelector(valCall.callee.object, { checked: true });
  if (!fieldId || declaration.id.type !== "Identifier") return undefined;
  return { name: declaration.id.name, fieldId };
}

function jqueryFieldCollectionDeclaration(statement) {
  const declaration = singleDeclarator(statement);
  const fieldId = jqueryExtendInputSelector(declaration?.init, { checked: false });
  if (!fieldId || declaration.id.type !== "Identifier") return undefined;
  return { name: declaration.id.name, fieldId };
}

function jqueryExtendInputSelector(node, { checked }) {
  if (
    node?.type !== "CallExpression" ||
    node.callee?.type !== "Identifier" ||
    node.callee.name !== "$" ||
    node.arguments?.length !== 1
  ) {
    return undefined;
  }
  const selector = literalString(node.arguments[0]);
  if (!selector) return undefined;
  const match = selector.match(
    /^input\[name=["']extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)["']\](:checked)?$/u
  );
  if (!match) return undefined;
  if (Boolean(match[2]) !== checked) return undefined;
  return match[1];
}

function optionVisibilityOps(consequent, alias, optionCount) {
  const statements = consequent?.type === "BlockStatement"
    ? nonEmpty(consequent.body)
    : [consequent];
  const ops = [];
  for (const statement of statements) {
    if (statement?.type !== "ExpressionStatement") return undefined;
    const call = statement.expression;
    if (
      call?.type !== "CallExpression" ||
      call.arguments?.length ||
      call.callee?.type !== "MemberExpression" ||
      call.callee.computed ||
      !["show", "hide"].includes(call.callee.property?.name)
    ) {
      return undefined;
    }
    const parentCall = call.callee.object;
    if (
      parentCall?.type !== "CallExpression" ||
      parentCall.arguments?.length ||
      parentCall.callee?.type !== "MemberExpression" ||
      parentCall.callee.computed ||
      parentCall.callee.property?.name !== "parent"
    ) {
      return undefined;
    }
    const eqCall = parentCall.callee.object;
    if (
      eqCall?.type !== "CallExpression" ||
      eqCall.arguments?.length !== 1 ||
      eqCall.callee?.type !== "MemberExpression" ||
      eqCall.callee.computed ||
      eqCall.callee.property?.name !== "eq" ||
      eqCall.callee.object?.type !== "Identifier" ||
      eqCall.callee.object.name !== alias
    ) {
      return undefined;
    }
    const index = eqCall.arguments[0]?.type === "Literal" && Number.isInteger(eqCall.arguments[0].value)
      ? eqCall.arguments[0].value
      : undefined;
    if (index === undefined || index < 0 || index >= optionCount) return undefined;
    ops.push({ index, visible: call.callee.property.name === "show" });
  }
  return ops.length ? ops : undefined;
}

function applyVisibility(optionCount, ops) {
  const visible = new Set(Array.from({ length: optionCount }, (_, index) => index));
  for (const op of ops) {
    if (op.visible) visible.add(op.index);
    else visible.delete(op.index);
  }
  return visible;
}

function equalityLiteral(test, alias) {
  if (
    test?.type !== "BinaryExpression" ||
    !["==", "==="].includes(test.operator) ||
    test.left?.type !== "Identifier" ||
    test.left.name !== alias
  ) {
    return undefined;
  }
  const value = literalString(test.right);
  return value === undefined ? undefined : value;
}

function radioField(form, fieldId) {
  const field = (form?.fields || []).find((candidate) =>
    candidate?.id === fieldId && candidate.type !== "detailTable"
  );
  if (field?.componentId !== "xform-radio") return undefined;
  return field;
}

function radioOptions(field) {
  return (Array.isArray(field?.props?.options) ? field.props.options : [])
    .map((option) => ({
      label: option.label,
      value: option.value
    }))
    .filter((option) => option.label !== undefined && option.value !== undefined);
}

function isWindowLoadCalling(statement, handlerName) {
  const call = expressionCall(statement);
  if (
    call?.callee?.type !== "Identifier" ||
    call.callee.name !== "Com_AddEventListener" ||
    call.arguments?.length !== 3 ||
    call.arguments[0]?.type !== "Identifier" ||
    call.arguments[0].name !== "window" ||
    literalString(call.arguments[1]) !== "load"
  ) {
    return false;
  }
  const listener = call.arguments[2];
  if (!listener || !["FunctionExpression", "ArrowFunctionExpression"].includes(listener.type)) {
    return false;
  }
  const body = listener.body?.type === "BlockStatement" ? nonEmpty(listener.body.body) : [];
  if (body.length !== 1 || body[0].type !== "ExpressionStatement") return false;
  const inner = body[0].expression;
  return inner?.type === "CallExpression" &&
    inner.callee?.type === "Identifier" &&
    inner.callee.name === handlerName &&
    inner.arguments?.length === 0;
}

function singleDeclarator(statement) {
  if (
    statement?.type !== "VariableDeclaration" ||
    statement.declarations?.length !== 1 ||
    statement.declarations[0].id?.type !== "Identifier"
  ) {
    return undefined;
  }
  return statement.declarations[0];
}

function expressionCall(statement) {
  return statement?.type === "ExpressionStatement" &&
    statement.expression?.type === "CallExpression"
    ? statement.expression
    : undefined;
}

function literalString(node) {
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
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
