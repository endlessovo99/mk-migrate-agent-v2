import { parse } from "acorn";

export function isUnconditionalAttachmentRequirement(text, fieldId) {
  let program;
  try {
    program = parse(String(text || ""), {
      ecmaVersion: "latest",
      sourceType: "script"
    });
  } catch {
    return false;
  }
  const body = significantStatements(program.body);
  if (body.length === 1) {
    const callback = submitCallback(body[0]);
    return Boolean(callback && isDirectAttachmentGuard(callback, fieldId));
  }
  if (body.length !== 2 || !isPlainHelperFunction(body[0])) return false;
  const callback = submitCallback(body[1]);
  return Boolean(
    callback &&
    isFilteredAttachmentGuard(body[0], callback, fieldId)
  );
}

function isDirectAttachmentGuard(callback, fieldId) {
  const body = significantStatements(callback.body?.body);
  if (!sameTypes(body, [
    "VariableDeclaration",
    "IfStatement",
    "IfStatement",
    "IfStatement",
    "ReturnStatement"
  ])) return false;

  const validator = singleVariable(body[0]);
  if (!validator || !isLiteral(validator.init, true)) return false;
  const validatorName = validator.id.name;
  if (
    !isZeroLengthTest(body[1].test, directAttachmentList(fieldId), "<=") ||
    body[1].alternate ||
    !isSingleAssignment(body[1].consequent, validatorName, false)
  ) return false;

  if (!isIdentifier(body[2].test, validatorName) || body[2].alternate) return false;
  const activeBody = significantStatements(body[2].consequent?.body);
  if (!sameTypes(activeBody, ["VariableDeclaration", "ForStatement", "IfStatement"])) return false;
  const activeCount = singleVariable(activeBody[0]);
  if (!activeCount || !isLiteral(activeCount.init, 0)) return false;
  const countName = activeCount.id.name;
  if (!isActiveAttachmentLoop(activeBody[1], fieldId, countName)) return false;
  if (
    !isZeroTest(activeBody[2].test, countName) ||
    activeBody[2].alternate ||
    !isSingleAssignment(activeBody[2].consequent, validatorName, false)
  ) return false;

  if (
    !isNegatedIdentifier(body[3].test, validatorName) ||
    !isSingleAlert(body[3].consequent) ||
    !isSingleAssignment(body[3].alternate, validatorName, true)
  ) return false;
  return isReturn(body[4], validatorName);
}

function isFilteredAttachmentGuard(helper, callback, fieldId) {
  const helperName = helper.id?.name;
  const [arrayParam, objectParam] = helper.params;
  const helperBody = significantStatements(helper.body?.body);
  if (
    !helperName ||
    !isIdentifier(arrayParam) ||
    !isIdentifier(objectParam) ||
    !sameTypes(helperBody, ["ForStatement"]) ||
    !isActiveFileFilterLoop(helperBody[0], arrayParam.name, objectParam.name)
  ) return false;

  const body = significantStatements(callback.body?.body);
  if (!sameTypes(body, [
    "VariableDeclaration",
    "VariableDeclaration",
    "ExpressionStatement",
    "IfStatement",
    "ReturnStatement"
  ])) return false;
  const attachment = singleVariable(body[0]);
  const active = singleVariable(body[1]);
  if (
    !attachment ||
    !active ||
    !isMemberPath(attachment.init, ["Attachment_ObjectInfo", fieldId, "fileList"]) ||
    active.init?.type !== "ArrayExpression" ||
    active.init.elements.length !== 0 ||
    !isCallStatement(body[2], helperName, [active.id.name, attachment.id.name])
  ) return false;

  const emptyBody = significantStatements(body[3].consequent?.body);
  if (
    body[3].alternate ||
    !isZeroLengthTest(body[3].test, [active.id.name], "equality") ||
    !sameTypes(emptyBody, ["ExpressionStatement", "ReturnStatement"]) ||
    !isLiteralAlertCall(emptyBody[0].expression) ||
    !isReturn(emptyBody[1], false)
  ) return false;
  return isReturn(body[4], true);
}

function isActiveAttachmentLoop(statement, fieldId, countName) {
  const loop = forLoopParts(statement);
  if (!loop || !isMemberPath(loop.limit, [...directAttachmentList(fieldId), "length"])) return false;
  const body = significantStatements(statement.body?.body);
  if (!sameTypes(body, ["IfStatement"]) || body[0].alternate) return false;
  const test = body[0].test;
  if (
    test?.type !== "BinaryExpression" ||
    test.operator !== ">" ||
    !isLiteral(test.right, -1) ||
    !isMemberPath(test.left, [
      `attachmentObject_${fieldId}`,
      "fileList",
      { index: loop.indexName },
      "fileStatus"
    ])
  ) return false;
  const increment = significantStatements(body[0].consequent?.body);
  return sameTypes(increment, ["ExpressionStatement"]) &&
    increment[0].expression?.type === "UpdateExpression" &&
    increment[0].expression.operator === "++" &&
    isIdentifier(increment[0].expression.argument, countName);
}

function isActiveFileFilterLoop(statement, arrayName, objectName) {
  const loop = forLoopParts(statement);
  if (!loop || !isMemberPath(loop.limit, [objectName, "length"])) return false;
  const body = significantStatements(statement.body?.body);
  if (!sameTypes(body, ["IfStatement"]) || body[0].alternate) return false;
  const test = body[0].test;
  if (
    test?.type !== "BinaryExpression" ||
    !["!=", "!=="].includes(test.operator) ||
    !isLiteral(test.right, -1) ||
    !isMemberPath(test.left, [objectName, { index: loop.indexName }, "fileStatus"])
  ) return false;
  const consequent = significantStatements(body[0].consequent?.body);
  if (!sameTypes(consequent, ["ExpressionStatement"])) return false;
  const call = consequent[0].expression;
  return call?.type === "CallExpression" &&
    isMemberPath(call.callee, [arrayName, "push"]) &&
    call.arguments.length === 1 &&
    isMemberPath(call.arguments[0], [objectName, { index: loop.indexName }]);
}

function forLoopParts(statement) {
  if (statement?.type !== "ForStatement") return undefined;
  const init = singleVariable(statement.init);
  const test = statement.test;
  const update = statement.update;
  if (
    !init ||
    !isLiteral(init.init, 0) ||
    test?.type !== "BinaryExpression" ||
    test.operator !== "<" ||
    !isIdentifier(test.left, init.id.name) ||
    update?.type !== "UpdateExpression" ||
    update.operator !== "++" ||
    !isIdentifier(update.argument, init.id.name)
  ) return undefined;
  return { indexName: init.id.name, limit: test.right };
}

function submitCallback(statement) {
  const call = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  if (
    call?.type !== "CallExpression" ||
    !isMemberPath(call.callee, ["Com_Parameter", "event", "submit", "push"]) ||
    call.arguments.length !== 1
  ) return undefined;
  const callback = call.arguments[0];
  return callback?.type === "FunctionExpression" &&
    callback.async !== true &&
    callback.generator !== true &&
    callback.params.length === 0 &&
    callback.body?.type === "BlockStatement"
    ? callback
    : undefined;
}

function isPlainHelperFunction(node) {
  return node?.type === "FunctionDeclaration" &&
    node.async !== true &&
    node.generator !== true &&
    node.params.length === 2 &&
    node.params.every((parameter) => parameter?.type === "Identifier") &&
    node.body?.type === "BlockStatement";
}

function directAttachmentList(fieldId) {
  return [`attachmentObject_${fieldId}`, "fileList"];
}

function isZeroLengthTest(node, ownerPath, operator) {
  if (node?.type !== "BinaryExpression" || !isLiteral(node.right, 0)) return false;
  const accepted = operator === "equality" ? ["==", "==="] : [operator];
  return accepted.includes(node.operator) &&
    isMemberPath(node.left, [...ownerPath, "length"]);
}

function isZeroTest(node, identifierName) {
  return node?.type === "BinaryExpression" &&
    ["==", "==="].includes(node.operator) &&
    isIdentifier(node.left, identifierName) &&
    isLiteral(node.right, 0);
}

function isSingleAssignment(node, identifierName, value) {
  const body = node?.type === "BlockStatement"
    ? significantStatements(node.body)
    : [node].filter(Boolean);
  const expression = body.length === 1 && body[0]?.type === "ExpressionStatement"
    ? body[0].expression
    : undefined;
  return expression?.type === "AssignmentExpression" &&
    expression.operator === "=" &&
    isIdentifier(expression.left, identifierName) &&
    isLiteral(expression.right, value);
}

function isSingleAlert(node) {
  const body = node?.type === "BlockStatement"
    ? significantStatements(node.body)
    : [node].filter(Boolean);
  return body.length === 1 &&
    body[0]?.type === "ExpressionStatement" &&
    isLiteralAlertCall(body[0].expression);
}

function isLiteralAlertCall(node) {
  return isNamedCall(node, "alert") &&
    node.arguments.length === 1 &&
    node.arguments[0]?.type === "Literal" &&
    typeof node.arguments[0].value === "string";
}

function isCallStatement(statement, name, argumentNames) {
  const call = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  return isNamedCall(call, name) &&
    call.arguments.length === argumentNames.length &&
    call.arguments.every((argument, index) => isIdentifier(argument, argumentNames[index]));
}

function isNamedCall(node, name) {
  return node?.type === "CallExpression" && isIdentifier(node.callee, name);
}

function isReturn(statement, value) {
  if (statement?.type !== "ReturnStatement") return false;
  return typeof value === "string"
    ? isIdentifier(statement.argument, value)
    : isLiteral(statement.argument, value);
}

function isNegatedIdentifier(node, name) {
  return node?.type === "UnaryExpression" &&
    node.operator === "!" &&
    isIdentifier(node.argument, name);
}

function singleVariable(statement) {
  return statement?.type === "VariableDeclaration" &&
    statement.declarations?.length === 1 &&
    statement.declarations[0]?.id?.type === "Identifier"
    ? statement.declarations[0]
    : undefined;
}

function isIdentifier(node, name) {
  return node?.type === "Identifier" && (name === undefined || node.name === name);
}

function isLiteral(node, value) {
  if (value === -1) {
    return node?.type === "UnaryExpression" &&
      node.operator === "-" &&
      node.argument?.type === "Literal" &&
      node.argument.value === 1;
  }
  return node?.type === "Literal" && node.value === value;
}

function isMemberPath(node, expected) {
  const actual = memberPath(node);
  return actual &&
    actual.length === expected.length &&
    expected.every((part, index) => (
      typeof part === "string"
        ? actual[index] === part
        : actual[index]?.index === part.index
    ));
}

function memberPath(node) {
  if (node?.type === "Identifier") return [node.name];
  if (node?.type !== "MemberExpression") return undefined;
  const owner = memberPath(node.object);
  if (!owner) return undefined;
  if (!node.computed && node.property?.type === "Identifier") {
    return [...owner, node.property.name];
  }
  if (node.computed && node.property?.type === "Literal" && typeof node.property.value === "string") {
    return [...owner, node.property.value];
  }
  if (node.computed && node.property?.type === "Identifier") {
    return [...owner, { index: node.property.name }];
  }
  return undefined;
}

function significantStatements(statements) {
  return (Array.isArray(statements) ? statements : [])
    .filter((statement) => statement?.type !== "EmptyStatement");
}

function sameTypes(statements, types) {
  return statements.length === types.length &&
    statements.every((statement, index) => statement?.type === types[index]);
}
