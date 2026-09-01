import { parse } from "acorn";

const BASIS = "deterministic-synchronous-submit-validation";

export function synchronousSubmitValidationCandidate(source = {}, form = {}) {
  const text = String(source.javascript || "");
  const program = parseProgram(text);
  if (!program) return undefined;
  const statements = program.body.filter((statement) => statement.type !== "EmptyStatement");
  if (statements.length !== 1 || statements[0].type !== "ExpressionStatement") {
    return undefined;
  }
  const push = submitPushCall(statements[0].expression);
  if (!push) return undefined;

  const context = {
    fields: formFieldIds(form),
    locals: new Set(),
    fieldLocals: new Set(),
    omittedDiagnosticCount: 0
  };
  const lines = compileStatements(push.callback.body.body, context, "  ");
  if (!lines || !hasBooleanReturn(push.callback.body)) return undefined;

  const sourceRef = source.sourceRef || source.id;
  const violations = (source.functionAudit?.violations || [])
    .map((violation) => violation?.name)
    .filter(Boolean);
  return {
    index: push.index,
    event: "onBeforeSubmit",
    scope: "global",
    javascript: text,
    function: [
      "function onBeforeSubmit(context) {",
      "  if (context && context.isDraft) return true",
      ...lines,
      "}"
    ].join("\n"),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "complete synchronous legacy submit validation chain",
      target: "onBeforeSubmit + MKXFORM.getValue + MKXFORM.toast",
      basis: BASIS,
      reviewRequired: false
    }],
    semanticHints: {
      coveredLegacyFunctions: violations,
      omittedDiagnosticCalls: context.omittedDiagnosticCount,
      coveredCalculationRanges: [{
        sourceRef,
        name: "synchronous-submit-validation",
        start: push.index,
        end: statements[0].end
      }]
    }
  };
}

export function synchronousOnChangeAlertCandidate(source = {}, form = {}) {
  const text = String(source.javascript || "");
  const program = parseProgram(text);
  const statements = program?.body?.filter((statement) => statement.type !== "EmptyStatement") || [];
  if (statements.length !== 1 || statements[0].type !== "ExpressionStatement") {
    return undefined;
  }
  const binding = valueChangeBinding(statements[0].expression);
  if (!binding || !formFieldIds(form).has(binding.controlId)) return undefined;

  const locals = new Set([binding.valueName]);
  let branch;
  for (const statement of binding.callback.body.body) {
    if (statement.type === "EmptyStatement") continue;
    if (statement.type === "VariableDeclaration") {
      if (branch || statement.declarations.length !== 1) return undefined;
      const declaration = statement.declarations[0];
      const fieldId = legacyElementValueRead(declaration.init);
      if (
        declaration.id?.type !== "Identifier" ||
        !fieldId ||
        !formFieldIds(form).has(fieldId) ||
        locals.has(declaration.id.name)
      ) return undefined;
      locals.add(declaration.id.name);
      continue;
    }
    if (statement.type === "IfStatement" && !branch && !statement.alternate) {
      const message = negativeAlertBranch(statement, binding.valueName);
      if (message === undefined) return undefined;
      branch = { message };
      continue;
    }
    if (diagnosticConsoleCall(statement.expression, {
      locals,
      strictDiagnosticIdentifiers: true
    })) continue;
    return undefined;
  }
  if (!branch) return undefined;

  const sourceRef = source.sourceRef || source.id;
  return {
    index: binding.index,
    event: "onChange",
    scope: "control",
    controlId: binding.controlId,
    javascript: text,
    function: [
      "function onChange(value, rowNum, parentRowNum) {",
      "  if (value < 0) {",
      `    MKXFORM.toast(${JSON.stringify(branch.message)})`,
      "  }",
      "}"
    ].join("\n"),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "complete alert-only legacy value-change validation",
      target: "control onChange + MKXFORM.toast",
      basis: "deterministic-synchronous-onchange-alert",
      reviewRequired: false
    }],
    semanticHints: {
      coveredLegacyFunctions: (source.functionAudit?.violations || [])
        .map((violation) => violation?.name)
        .filter(Boolean),
      coveredCalculationRanges: [{
        sourceRef,
        name: `synchronous-onchange-alert:${binding.controlId}`,
        start: binding.index,
        end: statements[0].end
      }]
    }
  };
}

function compileStatements(statements, context, indent) {
  const lines = [];
  for (const statement of statements || []) {
    if (statement.type === "EmptyStatement") continue;
    const compiled = compileStatement(statement, context, indent);
    if (!compiled) return undefined;
    lines.push(...compiled);
  }
  return lines;
}

function compileStatement(statement, context, indent) {
  if (statement.type === "VariableDeclaration") {
    const lines = [];
    for (const declaration of statement.declarations || []) {
      if (declaration.id?.type !== "Identifier" || !declaration.init) return undefined;
      const name = declaration.id.name;
      if (context.locals.has(name)) return undefined;
      const fieldId = legacyFieldRead(declaration.init);
      if (fieldId) {
        if (!context.fields.has(fieldId)) return undefined;
        lines.push(
          `${indent}${statement.kind} ${name} = MKXFORM.getValue(${JSON.stringify(fieldId)})`,
          `${indent}${name} = Array.isArray(${name}) ? ${name}[0] : ${name}`
        );
        context.fieldLocals.add(name);
      } else {
        const expression = compileExpression(declaration.init, context);
        if (!expression) return undefined;
        lines.push(`${indent}${statement.kind} ${name} = ${expression}`);
      }
      context.locals.add(name);
    }
    return lines;
  }

  if (statement.type === "ExpressionStatement") {
    if (diagnosticConsoleCall(statement.expression, context)) {
      context.omittedDiagnosticCount += 1;
      return [];
    }
    const alertMessage = literalAlertMessage(statement.expression);
    if (alertMessage !== undefined) {
      return [`${indent}MKXFORM.toast(${JSON.stringify(alertMessage)})`];
    }
    const assignment = statement.expression;
    if (
      assignment?.type === "AssignmentExpression" &&
      assignment.operator === "=" &&
      assignment.left?.type === "Identifier" &&
      context.locals.has(assignment.left.name)
    ) {
      const right = compileExpression(assignment.right, context);
      return right ? [`${indent}${assignment.left.name} = ${right}`] : undefined;
    }
    return undefined;
  }

  if (statement.type === "IfStatement") {
    const condition = compileExpression(statement.test, context);
    if (!condition) return undefined;
    const consequent = compileBranch(statement.consequent, context, `${indent}  `);
    if (!consequent) return undefined;
    const lines = [`${indent}if (${condition}) {`, ...consequent];
    if (!statement.alternate) return [...lines, `${indent}}`];
    if (statement.alternate.type === "IfStatement") {
      const alternate = compileStatement(statement.alternate, context, indent);
      if (!alternate) return undefined;
      return [...lines, `${indent}} else ${alternate[0].trimStart()}`, ...alternate.slice(1)];
    }
    const alternate = compileBranch(statement.alternate, context, `${indent}  `);
    return alternate
      ? [...lines, `${indent}} else {`, ...alternate, `${indent}}`]
      : undefined;
  }

  if (statement.type === "ReturnStatement") {
    const value = compileExpression(statement.argument, context);
    return ["true", "false"].includes(value)
      ? [`${indent}return ${value}`]
      : undefined;
  }
  return undefined;
}

function compileBranch(branch, context, indent) {
  const statements = branch?.type === "BlockStatement" ? branch.body : [branch];
  return compileStatements(statements, context, indent);
}

function compileExpression(node, context) {
  if (!node) return undefined;
  if (node.type === "Literal") return JSON.stringify(node.value);
  if (node.type === "Identifier") {
    if (node.name === "undefined") return "undefined";
    return context.locals.has(node.name) ? node.name : undefined;
  }
  if (node.type === "UnaryExpression" && ["!", "+", "-"].includes(node.operator)) {
    const argument = compileExpression(node.argument, context);
    return argument ? `${node.operator}${parenthesize(argument)}` : undefined;
  }
  if (
    (node.type === "BinaryExpression" || node.type === "LogicalExpression") &&
    ["+", "-", "*", "/", "<", "<=", ">", ">=", "==", "!=", "===", "!==", "&&", "||"].includes(node.operator)
  ) {
    const left = compileExpression(node.left, context);
    const right = compileExpression(node.right, context);
    return left && right ? `${parenthesize(left)} ${node.operator} ${parenthesize(right)}` : undefined;
  }
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    ["Number", "String", "parseFloat", "isNaN"].includes(node.callee.name) &&
    node.arguments.length === 1
  ) {
    const argument = compileExpression(node.arguments[0], context);
    return argument ? `${node.callee.name}(${argument})` : undefined;
  }
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object?.type === "Identifier" &&
    context.fieldLocals.has(node.callee.object.name) &&
    node.callee.property?.name === "val" &&
    node.arguments.length === 0
  ) {
    return node.callee.object.name;
  }
  if (
    node.type === "NewExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "Date" &&
    node.arguments.length === 1
  ) {
    const argument = compileExpression(node.arguments[0], context);
    return argument ? `new Date(${argument})` : undefined;
  }
  return undefined;
}

function submitPushCall(expression) {
  if (
    expression?.type !== "CallExpression" ||
    expression.arguments.length !== 1 ||
    !isFunction(expression.arguments[0]) ||
    expression.arguments[0].params.length !== 0 ||
    expression.arguments[0].body?.type !== "BlockStatement"
  ) return undefined;
  const push = expression.callee;
  if (
    push?.type !== "MemberExpression" ||
    memberName(push) !== "push" ||
    push.object?.type !== "MemberExpression" ||
    memberName(push.object) !== "submit" ||
    push.object.object?.type !== "MemberExpression" ||
    memberName(push.object.object) !== "event" ||
    push.object.object.object?.type !== "Identifier" ||
    push.object.object.object.name !== "Com_Parameter"
  ) return undefined;
  return { index: expression.start, callback: expression.arguments[0] };
}

function legacyFieldRead(node) {
  const directCall = node?.type === "CallExpression" ? node : undefined;
  const valueCall = node?.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.property?.name === "val" &&
    node.arguments.length === 0
    ? node.callee.object
    : undefined;
  const jquery = valueCall || directCall;
  if (
    jquery?.type !== "CallExpression" ||
    jquery.callee?.type !== "Identifier" ||
    jquery.callee.name !== "$" ||
    jquery.arguments.length !== 1 ||
    jquery.arguments[0]?.type !== "Literal" ||
    typeof jquery.arguments[0].value !== "string"
  ) return undefined;
  return jquery.arguments[0].value.match(
    /extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)/
  )?.[1];
}

function diagnosticConsoleCall(expression, context) {
  if (
    expression?.type !== "CallExpression" ||
    expression.callee?.type !== "MemberExpression" ||
    expression.callee.computed ||
    expression.callee.object?.type !== "Identifier" ||
    expression.callee.object.name !== "console" ||
    !["log", "debug", "info"].includes(expression.callee.property?.name)
  ) return false;
  if (context?.strictDiagnosticIdentifiers === true && context?.locals instanceof Set) {
    return expression.arguments.every((argument) => (
      argument?.type === "Literal" ||
      argument?.type === "Identifier" && context.locals.has(argument.name)
    ));
  }
  return expression.arguments.every((argument) => Boolean(compileExpression(argument, context)));
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

function legacyElementValueRead(node) {
  if (
    node?.type !== "MemberExpression" ||
    node.computed ||
    node.property?.name !== "value" ||
    node.object?.type !== "MemberExpression" ||
    !node.object.computed ||
    node.object.property?.type !== "Literal" ||
    node.object.property.value !== 0 ||
    node.object.object?.type !== "CallExpression" ||
    node.object.object.callee?.type !== "Identifier" ||
    node.object.object.callee.name !== "GetXFormFieldById" ||
    node.object.object.arguments.length !== 1 ||
    node.object.object.arguments[0]?.type !== "Literal" ||
    typeof node.object.object.arguments[0].value !== "string"
  ) return undefined;
  return node.object.object.arguments[0].value;
}

function negativeAlertBranch(statement, valueName) {
  const test = statement?.test;
  if (
    test?.type !== "BinaryExpression" ||
    test.operator !== "<" ||
    test.left?.type !== "Identifier" ||
    test.left.name !== valueName ||
    test.right?.type !== "Literal" ||
    test.right.value !== 0
  ) return undefined;
  const body = statement.consequent?.type === "BlockStatement"
    ? statement.consequent.body.filter((item) => item.type !== "EmptyStatement")
    : [statement.consequent];
  if (body.length !== 1 || body[0]?.type !== "ExpressionStatement") return undefined;
  return literalAlertMessage(body[0].expression);
}

function literalAlertMessage(expression) {
  if (
    expression?.type !== "CallExpression" ||
    expression.callee?.type !== "Identifier" ||
    expression.callee.name !== "alert" ||
    expression.arguments.length !== 1 ||
    expression.arguments[0]?.type !== "Literal" ||
    typeof expression.arguments[0].value !== "string"
  ) return undefined;
  return expression.arguments[0].value;
}

function hasBooleanReturn(node) {
  if (!node || typeof node !== "object") return false;
  if (
    node.type === "ReturnStatement" &&
    node.argument?.type === "Literal" &&
    typeof node.argument.value === "boolean"
  ) return true;
  return Object.values(node).some((value) => (
    Array.isArray(value)
      ? value.some(hasBooleanReturn)
      : value && typeof value === "object" && hasBooleanReturn(value)
  ));
}

function formFieldIds(form) {
  return new Set((form?.fields || []).flatMap((field) => [
    field?.id,
    ...(field?.columns || []).map((column) => column?.id)
  ]).filter(Boolean));
}

function memberName(member) {
  if (member?.computed) {
    return member.property?.type === "Literal" ? member.property.value : undefined;
  }
  return member?.property?.type === "Identifier" ? member.property.name : undefined;
}

function parenthesize(expression) {
  return /^[A-Za-z_$][\w$]*$|^(?:true|false|null|undefined|-?\d+(?:\.\d+)?)$/.test(expression)
    ? expression
    : `(${expression})`;
}

function isFunction(node) {
  return node?.type === "FunctionExpression" || node?.type === "ArrowFunctionExpression";
}

function parseProgram(source) {
  try {
    return parse(String(source || ""), { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return undefined;
  }
}
