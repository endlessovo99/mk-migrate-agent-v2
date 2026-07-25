import { parse } from "acorn";
import { inlineOnChangeSourceActionKey } from "./source-action-key.js";

const BASIS = "deterministic-inline-radio-row-effects";
const ROW_HELPER = "common_dom_row_set_show_required_reset";

export function inlineRadioRowEffectCandidates(source = {}, form = {}, formRules = {}) {
  if (Array.isArray(source.functionAudit?.violations) && source.functionAudit.violations.length) {
    return [];
  }
  if (sourceHasNativeRules(source, formRules)) return [];
  const text = String(source.javascript || "");
  const program = parseProgram(text);
  if (!program) return [];

  const onChangeCalls = program.body
    .map(expressionCall)
    .filter((call) => call?.callee?.type === "Identifier" &&
      call.callee.name === "AttachXFormValueChangeEventById");
  if (onChangeCalls.length) {
    if (
      onChangeCalls.length < 2 ||
      onChangeCalls.length !== program.body.filter((statement) => statement.type !== "EmptyStatement").length
    ) {
      return [];
    }
    const candidates = onChangeCalls.map((call) =>
      onChangeCandidate(call, source, form)
    );
    return candidates.every(Boolean) ? candidates : [];
  }

  const loadCalls = program.body
    .map(expressionCall)
    .filter((call) => isWindowLoadCall(call));
  if (
    loadCalls.length !== 1 ||
    program.body.filter((statement) => statement.type !== "EmptyStatement").length !== 1
  ) {
    return [];
  }
  const candidate = onLoadCandidate(loadCalls[0], source, form);
  return candidate ? [candidate] : [];
}

function onChangeCandidate(call, source, form) {
  if (
    call.arguments?.length !== 2 ||
    typeof literalValue(call.arguments[0]) !== "string" ||
    !isFunction(call.arguments[1])
  ) {
    return undefined;
  }
  const controlId = literalValue(call.arguments[0]);
  if (!formFieldIds(form).has(controlId)) return undefined;
  const compiled = compileOnChange(call.arguments[1], form);
  if (!compiled) return undefined;
  if (!targetsHaveDistinctLayoutOwners(form, rowEffectTargets(call.arguments[1]))) {
    return undefined;
  }
  const sourceRef = source.sourceRef || source.id;
  return {
    index: call.start,
    sourceActionKey: inlineOnChangeSourceActionKey(sourceRef, call.start),
    event: "onChange",
    scope: "control",
    controlId,
    javascript: String(source.javascript || ""),
    function: compiled,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "inline radio value-change row effects",
      target: "MKXFORM.getValue/setValue/setFieldAttr",
      basis: BASIS,
      reviewRequired: false
    }],
    sourceRefs: [sourceRef],
    semanticHints: {
      coveredCalculationRanges: [{
        sourceRef,
        name: `inlineRadioRowEffects:${controlId}`,
        start: call.start,
        end: call.end
      }]
    }
  };
}

function compileOnChange(callback, form) {
  if (
    callback.params?.[0]?.type !== "Identifier" ||
    callback.body?.type !== "BlockStatement"
  ) {
    return undefined;
  }
  const sourceValueName = callback.params[0].name;
  const aliases = new Map();
  const lines = ["function onChange(value, rowNum, parentRowNum) {"];
  for (const statement of callback.body.body) {
    if (statement.type === "EmptyStatement") continue;
    const alias = legacyFieldAlias(statement);
    if (alias) {
      if (!formFieldIds(form).has(alias.fieldId) || aliases.has(alias.name)) return undefined;
      aliases.set(alias.name, alias.fieldId);
      lines.push(`  var ${alias.name} = MKXFORM.getValue(${JSON.stringify(alias.fieldId)});`);
      continue;
    }
    const compiled = compileStatement(statement, {
      aliases,
      sourceValueName,
      targetValueName: "value",
      form,
      indent: "  "
    });
    if (!compiled) return undefined;
    lines.push(...compiled);
  }
  lines.push("}");
  return lines.join("\n");
}

function compileStatement(statement, context) {
  if (statement.type === "IfStatement") return compileIf(statement, context);
  const effect = rowEffect(statement);
  if (effect) return compileRowEffect(effect, context.form, context.indent);
  const assignment = legacyFieldAssignment(statement, context.aliases);
  if (assignment) {
    return [
      `${context.indent}MKXFORM.setValue(${JSON.stringify(assignment.fieldId)}, ${JSON.stringify(assignment.value)});`,
      `${context.indent}${assignment.alias} = ${JSON.stringify(assignment.value)};`
    ];
  }
  return undefined;
}

function compileIf(statement, context) {
  const condition = compileCondition(statement.test, context);
  if (!condition) return undefined;
  const consequent = compileBlock(statement.consequent, {
    ...context,
    indent: `${context.indent}  `
  });
  if (!consequent) return undefined;
  const lines = [`${context.indent}if (${condition}) {`, ...consequent];
  if (!statement.alternate) {
    lines.push(`${context.indent}}`);
    return lines;
  }
  if (statement.alternate.type === "IfStatement") {
    const alternate = compileIf(statement.alternate, context);
    if (!alternate) return undefined;
    lines.push(`${context.indent}} else ${alternate[0].trimStart()}`, ...alternate.slice(1));
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
  const statements = block?.type === "BlockStatement" ? block.body : [block];
  const lines = [];
  for (const statement of statements) {
    if (statement?.type === "EmptyStatement") continue;
    const compiled = compileStatement(statement, context);
    if (!compiled) return undefined;
    lines.push(...compiled);
  }
  return lines;
}

function compileCondition(condition, context) {
  const contains = eventContainsCondition(condition, context.sourceValueName);
  if (contains) {
    return `${context.targetValueName}.indexOf(${JSON.stringify(contains)}) >= 0`;
  }
  const fieldEquality = aliasValueEquality(condition, context.aliases);
  if (fieldEquality) {
    return `${fieldEquality.alias} == ${JSON.stringify(fieldEquality.value)}`;
  }
  return undefined;
}

function onLoadCandidate(call, source, form) {
  const listener = call.arguments?.[2];
  if (!isFunction(listener) || listener.body?.type !== "BlockStatement") return undefined;
  const model = loadModel(listener, source, form);
  if (!model) return undefined;
  const sourceRef = source.sourceRef || source.id;
  return {
    index: call.start,
    event: "onLoad",
    scope: "global",
    javascript: String(source.javascript || ""),
    function: renderOnLoad(model),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "legacy radio checked-value and DOM fallback row initialization",
      target: "MKXFORM.getValue/setFieldAttr",
      basis: BASIS,
      reviewRequired: false
    }],
    sourceRefs: [sourceRef],
    semanticHints: {
      coveredCalculationRanges: [{
        sourceRef,
        name: "inlineRadioRowEffects:onLoad",
        start: call.start,
        end: call.end
      }]
    }
  };
}

function loadModel(listener, source, form) {
  const body = listener.body.body.filter((statement) => statement.type !== "EmptyStatement");
  const finalChain = [...body].reverse().find((statement) => statement.type === "IfStatement");
  if (!finalChain) return undefined;
  const prelude = parseLoadPrelude(body.slice(0, body.indexOf(finalChain)), form);
  if (!prelude) return undefined;
  const { reads, initialEffects } = prelude;

  const main = parseLoadChain(finalChain, reads[0].alias, form);
  if (!main || main.branches.length < 2) return undefined;
  const nestedAliases = new Set(
    main.branches.flatMap((branch) => branch.nested ? [branch.nested.alias] : [])
  );
  if (
    nestedAliases.size > 1 ||
    (nestedAliases.size === 1 && !nestedAliases.has(reads[1].alias))
  ) {
    return undefined;
  }

  const markers = layoutMarkerSet(form);
  const branchTargets = new Set(main.branches.flatMap((branch) => [
    ...branch.effects.map((effect) => effect.target),
    ...(branch.nested?.branches || []).flatMap((nested) =>
      nested.effects.map((effect) => effect.target)
    )
  ]));
  if ([...branchTargets].some((target) => !markers.has(target))) return undefined;
  if (!targetsHaveDistinctLayoutOwners(form, branchTargets)) return undefined;
  const initialTargets = new Set(initialEffects.map((effect) => effect.target));
  if ([...branchTargets].some((target) => !initialTargets.has(target))) return undefined;

  return {
    reads,
    initialTargets: [...initialTargets].filter((target) => markers.has(target)),
    main
  };
}

function parseLoadPrelude(statements, form) {
  const fields = formFieldIds(form);
  const initialEffects = [];
  const reads = [];
  let index = 0;

  const unusedAlias = legacyFieldAlias(statements[index]);
  if (unusedAlias) {
    if (!fields.has(unusedAlias.fieldId)) return undefined;
    index += 1;
  }

  while (index < statements.length) {
    const effect = rowEffect(statements[index]);
    if (!effect) break;
    if (effect.visible || effect.required || effect.reset) return undefined;
    initialEffects.push(effect);
    index += 1;
  }
  if (!initialEffects.length) return undefined;

  while (index < statements.length) {
    const fieldId = legacyFieldCollectionAssignment(statements[index]);
    const alias = nullableValueDeclaration(statements[index + 1]);
    if (!fieldId || !fields.has(fieldId) || !alias) return undefined;
    if (!isCheckedValueLoop(statements[index + 2], alias)) return undefined;
    if (!isInputCollectionAssignment(statements[index + 3])) return undefined;
    index += 4;

    const counter = zeroCounterDeclaration(statements[index]);
    if (counter) index += 1;
    const flagName = alias.replace(/^selectvalue/u, "flag");
    if (!isRadioFallbackLoop(statements[index], flagName, counter)) return undefined;
    index += 1;
    reads.push({ fieldId, alias });
  }

  if (
    reads.length !== 2 ||
    new Set(reads.map((read) => read.alias)).size !== reads.length
  ) {
    return undefined;
  }
  return { reads, initialEffects };
}

function legacyFieldCollectionAssignment(statement) {
  const assignment = statement?.type === "ExpressionStatement"
    ? statement.expression
    : undefined;
  if (
    assignment?.type !== "AssignmentExpression" ||
    assignment.operator !== "=" ||
    assignment.left?.type !== "Identifier" ||
    assignment.left.name !== "cat" ||
    assignment.right?.type !== "CallExpression" ||
    assignment.right.callee?.type !== "Identifier" ||
    assignment.right.callee.name !== "GetXFormFieldById" ||
    assignment.right.arguments?.length !== 1 ||
    typeof literalValue(assignment.right.arguments[0]) !== "string"
  ) {
    return undefined;
  }
  return literalValue(assignment.right.arguments[0]);
}

function nullableValueDeclaration(statement) {
  const declaration = singleVariableDeclaration(statement);
  if (
    !declaration ||
    !/^selectvalue\d+$/u.test(declaration.id.name) ||
    literalValue(declaration.init) !== null
  ) {
    return undefined;
  }
  return declaration.id.name;
}

function zeroCounterDeclaration(statement) {
  const declaration = singleVariableDeclaration(statement);
  if (
    !declaration ||
    declaration.id.name !== "cnt" ||
    literalValue(declaration.init) !== 0
  ) {
    return undefined;
  }
  return declaration.id.name;
}

function singleVariableDeclaration(statement) {
  if (
    statement?.type !== "VariableDeclaration" ||
    statement.declarations?.length !== 1 ||
    statement.declarations[0].id?.type !== "Identifier"
  ) {
    return undefined;
  }
  return statement.declarations[0];
}

function isInputCollectionAssignment(statement) {
  const assignment = statement?.type === "ExpressionStatement"
    ? statement.expression
    : undefined;
  const call = assignment?.right;
  return assignment?.type === "AssignmentExpression" &&
    assignment.operator === "=" &&
    assignment.left?.type === "Identifier" &&
    assignment.left.name === "inpt" &&
    call?.type === "CallExpression" &&
    call.callee?.type === "MemberExpression" &&
    !call.callee.computed &&
    call.callee.object?.type === "Identifier" &&
    call.callee.object.name === "document" &&
    call.callee.property?.name === "getElementsByTagName" &&
    call.arguments?.length === 1 &&
    literalValue(call.arguments[0]) === "input";
}

function isCheckedValueLoop(statement, alias) {
  if (!isCanonicalCollectionLoop(statement, "cat")) return false;
  const body = blockStatements(statement.body);
  if (body.length !== 1 || body[0].type !== "IfStatement" || body[0].alternate) return false;
  const checked = body[0];
  if (!isIndexedMember(checked.test, "cat", "checked")) return false;
  const consequent = blockStatements(checked.consequent);
  if (consequent.length !== 2 || consequent[1].type !== "BreakStatement") return false;
  const assignment = consequent[0]?.type === "ExpressionStatement"
    ? consequent[0].expression
    : undefined;
  return assignment?.type === "AssignmentExpression" &&
    assignment.operator === "=" &&
    assignment.left?.type === "Identifier" &&
    assignment.left.name === alias &&
    isIndexedMember(assignment.right, "cat", "value");
}

function isRadioFallbackLoop(statement, flagName, counterName) {
  if (!isCanonicalCollectionLoop(statement, "inpt")) return false;
  const body = blockStatements(statement.body);
  if (body.length !== 1 || body[0].type !== "IfStatement" || body[0].alternate) return false;
  const typeCheck = body[0];
  if (!isAttributeComparison(typeCheck.test, "type", "radio")) return false;
  const typeBody = blockStatements(typeCheck.consequent);
  if (typeBody.length !== 1 || typeBody[0].type !== "IfStatement" || typeBody[0].alternate) {
    return false;
  }
  const checked = typeBody[0];
  if (!isAttributeComparison(checked.test, "checked", "")) return false;
  const checkedBody = blockStatements(checked.consequent);
  if (checkedBody.at(-1)?.type !== "BreakStatement") return false;
  const flagIndex = counterName ? 2 : 0;
  if (checkedBody.length !== flagIndex + 2) return false;
  if (counterName && (
    !isCounterIncrement(checkedBody[0], counterName) ||
    !isCounterContinue(checkedBody[1], counterName)
  )) {
    return false;
  }
  return isFallbackFlagChain(checkedBody[flagIndex], flagName);
}

function isCanonicalCollectionLoop(statement, collectionName) {
  const init = singleVariableDeclaration(statement?.init);
  const test = statement?.test;
  const update = statement?.update;
  return statement?.type === "ForStatement" &&
    init?.id?.name === "i" &&
    literalValue(init.init) === 0 &&
    test?.type === "BinaryExpression" &&
    test.operator === "<" &&
    test.left?.type === "Identifier" &&
    test.left.name === "i" &&
    test.right?.type === "MemberExpression" &&
    !test.right.computed &&
    test.right.object?.type === "Identifier" &&
    test.right.object.name === collectionName &&
    test.right.property?.name === "length" &&
    update?.type === "UpdateExpression" &&
    update.operator === "++" &&
    update.argument?.type === "Identifier" &&
    update.argument.name === "i";
}

function isAttributeComparison(node, attribute, value) {
  const call = node?.left;
  return node?.type === "BinaryExpression" &&
    ["==", "==="].includes(node.operator) &&
    literalValue(node.right) === value &&
    call?.type === "CallExpression" &&
    call.callee?.type === "MemberExpression" &&
    !call.callee.computed &&
    isIndexedRoot(call.callee.object, "inpt") &&
    call.callee.property?.name === "getAttribute" &&
    call.arguments?.length === 1 &&
    literalValue(call.arguments[0]) === attribute;
}

function isCounterIncrement(statement, counterName) {
  const expression = statement?.type === "ExpressionStatement"
    ? statement.expression
    : undefined;
  return expression?.type === "UpdateExpression" &&
    expression.operator === "++" &&
    expression.argument?.type === "Identifier" &&
    expression.argument.name === counterName;
}

function isCounterContinue(statement, counterName) {
  if (statement?.type !== "IfStatement" || statement.alternate) return false;
  const test = statement.test;
  const body = blockStatements(statement.consequent);
  return test?.type === "BinaryExpression" &&
    test.operator === "<" &&
    test.left?.type === "Identifier" &&
    test.left.name === counterName &&
    typeof literalValue(test.right) === "number" &&
    body.length === 1 &&
    body[0].type === "ContinueStatement";
}

function isFallbackFlagChain(statement, flagName) {
  let current = statement;
  let count = 0;
  while (current?.type === "IfStatement") {
    if (!isLabelContainsCondition(current.test)) return false;
    const branch = blockStatements(current.consequent);
    if (
      branch.length !== 1 ||
      !isNumericFlagAssignment(branch[0], flagName)
    ) {
      return false;
    }
    count += 1;
    if (!current.alternate) break;
    if (current.alternate.type !== "IfStatement") return false;
    current = current.alternate;
  }
  return count >= 2;
}

function isLabelContainsCondition(node) {
  const call = node?.left;
  const negativeOne = node?.right;
  return node?.type === "BinaryExpression" &&
    ["!=", "!=="].includes(node.operator) &&
    call?.type === "CallExpression" &&
    call.callee?.type === "MemberExpression" &&
    !call.callee.computed &&
    isParentHtml(call.callee.object) &&
    call.callee.property?.name === "indexOf" &&
    call.arguments?.length === 1 &&
    typeof literalValue(call.arguments[0]) === "string" &&
    negativeOne?.type === "UnaryExpression" &&
    negativeOne.operator === "-" &&
    literalValue(negativeOne.argument) === 1;
}

function isNumericFlagAssignment(statement, flagName) {
  const declaration = singleVariableDeclaration(statement);
  if (declaration) {
    return declaration.id.name === flagName &&
      typeof literalValue(declaration.init) === "number";
  }
  const assignment = statement?.type === "ExpressionStatement"
    ? statement.expression
    : undefined;
  return assignment?.type === "AssignmentExpression" &&
    assignment.operator === "=" &&
    assignment.left?.type === "Identifier" &&
    assignment.left.name === flagName &&
    typeof literalValue(assignment.right) === "number";
}

function isIndexedMember(node, rootName, propertyName) {
  return node?.type === "MemberExpression" &&
    !node.computed &&
    node.property?.name === propertyName &&
    isIndexedRoot(node.object, rootName);
}

function isIndexedRoot(node, rootName) {
  return node?.type === "MemberExpression" &&
    node.computed &&
    node.object?.type === "Identifier" &&
    node.object.name === rootName &&
    node.property?.type === "Identifier" &&
    node.property.name === "i";
}

function isParentHtml(node) {
  return node?.type === "MemberExpression" &&
    !node.computed &&
    node.property?.name === "innerHTML" &&
    node.object?.type === "MemberExpression" &&
    !node.object.computed &&
    node.object.property?.name === "parentNode" &&
    isIndexedRoot(node.object.object, "inpt");
}

function blockStatements(node) {
  return node?.type === "BlockStatement" ? node.body : [node].filter(Boolean);
}

function parseLoadChain(statement, expectedAlias, form) {
  const branches = [];
  let current = statement;
  while (current?.type === "IfStatement") {
    const condition = redundantRadioCondition(current.test);
    if (!condition || condition.alias !== expectedAlias) return undefined;
    const parsed = parseLoadBranch(current.consequent, form);
    if (!parsed) return undefined;
    branches.push({ value: condition.value, ...parsed });
    if (!current.alternate) {
      current = undefined;
      break;
    }
    if (current.alternate.type !== "IfStatement") return undefined;
    current = current.alternate;
  }
  return branches.length ? { alias: expectedAlias, branches } : undefined;
}

function parseLoadBranch(block, form) {
  const statements = block?.type === "BlockStatement" ? block.body : [block];
  const effects = [];
  let nested;
  for (const statement of statements) {
    if (statement.type === "EmptyStatement") continue;
    const effect = rowEffect(statement);
    if (effect) {
      if (effect.required || effect.reset) return undefined;
      if (!layoutMarkerSet(form).has(effect.target)) return undefined;
      effects.push(effect);
      continue;
    }
    if (statement.type === "IfStatement" && !nested) {
      nested = parseLoadChain(statement, redundantRadioCondition(statement.test)?.alias, form);
      if (!nested) return undefined;
      continue;
    }
    return undefined;
  }
  return { effects, nested };
}

function renderOnLoad(model) {
  const [mainRead, nestedRead] = model.reads;
  const lines = [
    "function onLoad() {",
    `  var rawMain = MKXFORM.getValue(${JSON.stringify(mainRead.fieldId)});`,
    "  var mainValue = Array.isArray(rawMain) ? rawMain[0] : rawMain;",
    `  var rawNested = MKXFORM.getValue(${JSON.stringify(nestedRead.fieldId)});`,
    "  var nestedValue = Array.isArray(rawNested) ? rawNested[0] : rawNested;"
  ];
  for (const target of model.initialTargets) {
    lines.push(...renderRowEffect({ target, visible: false, required: false }, "  "));
  }
  model.main.branches.forEach((branch, index) => {
    lines.push(`${index === 0 ? "  if" : "  } else if"} (mainValue == ${JSON.stringify(branch.value)}) {`);
    for (const effect of branch.effects) {
      lines.push(...renderRowEffect(effect, "    "));
    }
    if (branch.nested) {
      branch.nested.branches.forEach((nested, nestedIndex) => {
        lines.push(`${nestedIndex === 0 ? "    if" : "    } else if"} (nestedValue == ${JSON.stringify(nested.value)}) {`);
        for (const effect of nested.effects) {
          lines.push(...renderRowEffect(effect, "      "));
        }
      });
      lines.push("    }");
    }
  });
  lines.push("  }", "}");
  return lines.join("\n");
}

function compileRowEffect(effect, form, indent) {
  if (!effect || effect.reset || !layoutMarkerSet(form).has(effect.target)) return undefined;
  return renderRowEffect(effect, indent);
}

function renderRowEffect(effect, indent) {
  return [
    `${indent}MKXFORM.setFieldAttr(${JSON.stringify(effect.target)}, ${effect.visible ? 5 : 4});`,
    `${indent}MKXFORM.setFieldAttr(${JSON.stringify(effect.target)}, ${effect.required ? 3 : 6});`
  ];
}

function rowEffect(statement) {
  const call = expressionCall(statement);
  if (
    call?.callee?.type !== "Identifier" ||
    call.callee.name !== ROW_HELPER ||
    call.arguments?.length !== 4 ||
    typeof literalValue(call.arguments[0]) !== "string" ||
    typeof literalValue(call.arguments[1]) !== "boolean" ||
    typeof literalValue(call.arguments[2]) !== "boolean" ||
    typeof literalValue(call.arguments[3]) !== "boolean"
  ) {
    return undefined;
  }
  return {
    target: literalValue(call.arguments[0]),
    visible: literalValue(call.arguments[1]),
    required: literalValue(call.arguments[2]),
    reset: literalValue(call.arguments[3])
  };
}

function legacyFieldAlias(statement) {
  if (
    statement?.type !== "VariableDeclaration" ||
    statement.declarations?.length !== 1 ||
    statement.declarations[0].id?.type !== "Identifier"
  ) {
    return undefined;
  }
  const fieldId = legacyFieldElementId(statement.declarations[0].init);
  return fieldId
    ? { name: statement.declarations[0].id.name, fieldId }
    : undefined;
}

function legacyFieldElementId(node) {
  if (
    node?.type !== "MemberExpression" ||
    !node.computed ||
    literalValue(node.property) !== 0 ||
    node.object?.type !== "CallExpression" ||
    node.object.callee?.type !== "Identifier" ||
    node.object.callee.name !== "GetXFormFieldById" ||
    node.object.arguments?.length !== 1 ||
    typeof literalValue(node.object.arguments[0]) !== "string"
  ) {
    return undefined;
  }
  return literalValue(node.object.arguments[0]);
}

function legacyFieldAssignment(statement, aliases) {
  const assignment = expressionCall(statement)?.type === "AssignmentExpression"
    ? expressionCall(statement)
    : statement?.type === "ExpressionStatement" &&
        statement.expression?.type === "AssignmentExpression"
      ? statement.expression
      : undefined;
  if (
    assignment?.operator !== "=" ||
    assignment.left?.type !== "MemberExpression" ||
    assignment.left.computed ||
    assignment.left.property?.name !== "value" ||
    assignment.left.object?.type !== "Identifier" ||
    typeof literalValue(assignment.right) !== "string"
  ) {
    return undefined;
  }
  const alias = assignment.left.object.name;
  const fieldId = aliases.get(alias);
  return fieldId
    ? { alias, fieldId, value: literalValue(assignment.right) }
    : undefined;
}

function eventContainsCondition(node, valueName) {
  if (
    node?.type !== "BinaryExpression" ||
    ![">=", ">"].includes(node.operator) ||
    node.left?.type !== "CallExpression" ||
    node.left.callee?.type !== "MemberExpression" ||
    node.left.callee.computed ||
    node.left.callee.object?.type !== "Identifier" ||
    node.left.callee.object.name !== valueName ||
    node.left.callee.property?.name !== "indexOf" ||
    node.left.arguments?.length !== 1 ||
    typeof literalValue(node.left.arguments[0]) !== "string" ||
    typeof literalValue(node.right) !== "number"
  ) {
    return undefined;
  }
  if (
    (node.operator === ">=" && literalValue(node.right) === 0) ||
    (node.operator === ">" && literalValue(node.right) === -1)
  ) {
    return literalValue(node.left.arguments[0]);
  }
  return undefined;
}

function aliasValueEquality(node, aliases) {
  if (node?.type !== "BinaryExpression" || !["==", "==="].includes(node.operator)) {
    return undefined;
  }
  const member = node.left?.type === "MemberExpression" ? node.left : node.right;
  const literal = member === node.left ? node.right : node.left;
  if (
    member?.computed ||
    member?.object?.type !== "Identifier" ||
    member?.property?.name !== "value" ||
    typeof literalValue(literal) !== "string" ||
    !aliases.has(member.object.name)
  ) {
    return undefined;
  }
  return { alias: member.object.name, value: literalValue(literal) };
}

function redundantRadioCondition(node) {
  if (node?.type !== "LogicalExpression" || node.operator !== "||") return undefined;
  const clauses = [node.left, node.right];
  const valueClause = clauses.find((clause) => (
    clause?.type === "BinaryExpression" &&
    ["==", "==="].includes(clause.operator) &&
    clause.left?.type === "Identifier" &&
    typeof literalValue(clause.right) === "string"
  ));
  const flagClause = clauses.find((clause) => (
    clause !== valueClause &&
    clause?.type === "BinaryExpression" &&
    ["==", "==="].includes(clause.operator) &&
    clause.left?.type === "Identifier" &&
    /^flag\d+$/.test(clause.left.name) &&
    typeof literalValue(clause.right) === "number"
  ));
  if (!valueClause || !flagClause) return undefined;
  return {
    alias: valueClause.left.name,
    value: literalValue(valueClause.right)
  };
}

function isWindowLoadCall(call) {
  return call?.type === "CallExpression" &&
    call.callee?.type === "Identifier" &&
    call.callee.name === "Com_AddEventListener" &&
    call.arguments?.length === 3 &&
    call.arguments[0]?.type === "Identifier" &&
    call.arguments[0].name === "window" &&
    literalValue(call.arguments[1]) === "load";
}

function formFieldIds(form) {
  return new Set(
    (Array.isArray(form?.fields) ? form.fields : [])
      .map((field) => field?.id)
      .filter(nonEmptyString)
  );
}

function layoutMarkerSet(form) {
  const markers = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.sourceMarkers)) {
      node.sourceMarkers.filter(nonEmptyString).forEach((marker) => markers.add(marker));
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit(form?.layout);
  return markers;
}

function targetsHaveDistinctLayoutOwners(form, targets) {
  const targetList = [...new Set(targets || [])];
  if (!targetList.length) return false;
  const owners = new Map(targetList.map((target) => [target, new Set()]));
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.sourceMarkers)) {
      const owner = node.sourceRef || node.id || node;
      for (const marker of node.sourceMarkers) {
        if (owners.has(marker)) owners.get(marker).add(owner);
      }
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit(form?.layout);
  if ([...owners.values()].some((matches) => matches.size !== 1)) return false;
  return new Set([...owners.values()].map((matches) => [...matches][0])).size === targetList.length;
}

function rowEffectTargets(node) {
  if (!node || typeof node !== "object") return [];
  const effect = rowEffect(node);
  if (effect) return [effect.target];
  if (node.type === "BlockStatement") return node.body.flatMap(rowEffectTargets);
  if (node.type === "IfStatement") {
    return [
      ...rowEffectTargets(node.consequent),
      ...rowEffectTargets(node.alternate)
    ];
  }
  if (isFunction(node)) return rowEffectTargets(node.body);
  return [];
}

function sourceHasNativeRules(source, formRules) {
  const sourceRef = source.sourceRef || source.id;
  return (Array.isArray(formRules?.linkage) ? formRules.linkage : []).some((rule) =>
    rule?.meta?.sourceJsp === sourceRef ||
    rule?.meta?.sourceRef === sourceRef ||
    rule?.sourceRef === sourceRef
  );
}

function expressionCall(statement) {
  return statement?.type === "ExpressionStatement" ? statement.expression : statement;
}

function literalValue(node) {
  return node?.type === "Literal" ? node.value : undefined;
}

function isFunction(node) {
  return ["FunctionExpression", "ArrowFunctionExpression"].includes(node?.type);
}

function parseProgram(source) {
  try {
    return parse(source, { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return undefined;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
