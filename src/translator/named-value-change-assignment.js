import { parse } from "acorn";
import { inlineOnChangeSourceActionKey } from "./source-action-key.js";

export function namedValueChangeAssignmentCandidates(source = {}, form = {}) {
  const model = namedValueChangeAssignmentModel(source.javascript);
  if (!model) return [];
  const fieldIds = new Set((Array.isArray(form?.fields) ? form.fields : [])
    .filter((field) => field?.type !== "detailTable")
    .map((field) => field?.id)
    .filter(nonEmptyString));
  if (!fieldIds.has(model.triggerId) || !fieldIds.has(model.targetId)) return [];

  return [{
    index: model.bindingIndex,
    sourceActionKey: inlineOnChangeSourceActionKey(
      source.sourceRef || source.id,
      model.bindingIndex
    ),
    event: "onChange",
    scope: "control",
    controlId: model.triggerId,
    javascript: String(source.javascript || ""),
    function: namedValueChangeFunction(model),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "named same-control value-change field assignment",
      target: "control onChange + MKXFORM.setValue",
      basis: "deterministic-calculation-assignment",
      reviewRequired: false
    }]
  }];
}

function namedValueChangeAssignmentModel(source = "") {
  const text = String(source || "");
  let ast;
  try {
    ast = parse(text, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: false,
      allowReturnOutsideFunction: false
    });
  } catch {
    return undefined;
  }

  const statements = ast.body.filter((statement) => statement.type !== "EmptyStatement");
  if (statements.length !== 2) return undefined;
  const fn = statements.find((statement) => statement.type === "FunctionDeclaration");
  const bindingStatement = statements.find((statement) => statement.type === "ExpressionStatement");
  if (!fn?.id?.name || fn.params.length !== 0 || !bindingStatement) return undefined;

  const binding = valueChangeBinding(bindingStatement.expression, fn.id.name);
  if (!binding) return undefined;
  const body = fn.body.body.filter((statement) => statement.type !== "EmptyStatement");
  if (body.length < 3) return undefined;
  const declarations = body.slice(0, 2).map(singleVariableDeclaration);
  if (declarations.some((declaration) => !declaration)) return undefined;

  const sourceDeclaration = declarations.find((declaration) => (
    getterFieldId(declaration.initializer, "GetXFormFieldValueById") !== undefined
  ));
  const targetDeclaration = declarations.find((declaration) => (
    getterFieldId(declaration.initializer, "GetXFormFieldById") !== undefined
  ));
  if (!sourceDeclaration || !targetDeclaration || sourceDeclaration === targetDeclaration) return undefined;
  const triggerId = getterFieldId(sourceDeclaration.initializer, "GetXFormFieldValueById");
  const targetId = getterFieldId(targetDeclaration.initializer, "GetXFormFieldById");
  if (triggerId !== binding.triggerId || !targetId) return undefined;

  const branches = [];
  for (const statement of body.slice(2)) {
    const branch = assignmentBranch(
      statement,
      sourceDeclaration.name,
      targetDeclaration.name
    );
    if (!branch) return undefined;
    branches.push(branch);
  }
  if (!branches.length) return undefined;

  const seenValues = new Map();
  for (const branch of branches) {
    for (const condition of branch.conditions) {
      const previous = seenValues.get(condition.value);
      if (previous !== undefined && previous !== branch.assignment) return undefined;
      seenValues.set(condition.value, branch.assignment);
    }
  }

  return {
    bindingIndex: bindingStatement.start,
    triggerId,
    targetId,
    branches
  };
}

function valueChangeBinding(expression, callbackName) {
  if (
    expression?.type !== "CallExpression" ||
    expression.callee?.type !== "Identifier" ||
    expression.callee.name !== "AttachXFormValueChangeEventById" ||
    expression.arguments.length !== 2 ||
    expression.arguments[1]?.type !== "Identifier" ||
    expression.arguments[1].name !== callbackName
  ) return undefined;
  const triggerId = stringLiteral(expression.arguments[0]);
  return triggerId ? { triggerId } : undefined;
}

function singleVariableDeclaration(statement) {
  if (statement?.type !== "VariableDeclaration" || statement.declarations.length !== 1) {
    return undefined;
  }
  const declaration = statement.declarations[0];
  if (declaration.id?.type !== "Identifier" || !declaration.init) return undefined;
  return { name: declaration.id.name, initializer: declaration.init };
}

function getterFieldId(expression, getterName) {
  if (
    expression?.type !== "CallExpression" ||
    expression.callee?.type !== "Identifier" ||
    expression.callee.name !== getterName ||
    expression.arguments.length !== 1
  ) return undefined;
  return stringLiteral(expression.arguments[0]);
}

function assignmentBranch(statement, sourceName, targetName) {
  if (
    statement?.type !== "IfStatement" ||
    statement.alternate !== null ||
    statement.consequent?.type !== "BlockStatement"
  ) return undefined;
  const conditions = equalityConditions(statement.test, sourceName);
  const body = statement.consequent.body.filter((item) => item.type !== "EmptyStatement");
  if (!conditions?.length || body.length !== 1 || body[0].type !== "ExpressionStatement") {
    return undefined;
  }
  const assignment = body[0].expression;
  if (
    assignment?.type !== "AssignmentExpression" ||
    assignment.operator !== "=" ||
    !targetValueMember(assignment.left, targetName)
  ) return undefined;
  const value = stringLiteral(assignment.right);
  return value === undefined ? undefined : {
    conditions: dedupeConditions(conditions),
    assignment: value
  };
}

function equalityConditions(expression, sourceName) {
  if (expression?.type === "LogicalExpression" && expression.operator === "||") {
    const left = equalityConditions(expression.left, sourceName);
    const right = equalityConditions(expression.right, sourceName);
    return left && right ? [...left, ...right] : undefined;
  }
  if (
    expression?.type !== "BinaryExpression" ||
    !["==", "==="].includes(expression.operator)
  ) return undefined;
  if (expression.left?.type === "Identifier" && expression.left.name === sourceName) {
    const value = stringLiteral(expression.right);
    return value === undefined ? undefined : [{ operator: expression.operator, value }];
  }
  if (expression.right?.type === "Identifier" && expression.right.name === sourceName) {
    const value = stringLiteral(expression.left);
    return value === undefined ? undefined : [{ operator: expression.operator, value }];
  }
  return undefined;
}

function targetValueMember(expression, targetName) {
  return expression?.type === "MemberExpression" &&
    expression.computed === false &&
    expression.property?.type === "Identifier" &&
    expression.property.name === "value" &&
    expression.object?.type === "MemberExpression" &&
    expression.object.computed === true &&
    expression.object.object?.type === "Identifier" &&
    expression.object.object.name === targetName &&
    numericLiteral(expression.object.property) === 0;
}

function namedValueChangeFunction(model) {
  const lines = ["function onChange(value, rowNum, parentRowNum) {"];
  for (const branch of model.branches) {
    const condition = branch.conditions
      .map((item) => `value ${item.operator} ${JSON.stringify(item.value)}`)
      .join(" || ");
    lines.push(
      `  if (${condition}) {`,
      `    MKXFORM.setValue(${JSON.stringify(model.targetId)}, ${JSON.stringify(branch.assignment)})`,
      "  }"
    );
  }
  lines.push("}");
  return lines.join("\n");
}

function dedupeConditions(conditions) {
  const seen = new Set();
  return conditions.filter((condition) => {
    const key = `${condition.operator}:${condition.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stringLiteral(node) {
  return node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;
}

function numericLiteral(node) {
  return node?.type === "Literal" && typeof node.value === "number"
    ? node.value
    : undefined;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
