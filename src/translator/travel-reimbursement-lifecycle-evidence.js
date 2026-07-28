import { parse } from "acorn";
import { DETAIL_TABLE_IDS, FIELD_IDS } from "./travel-reimbursement-lifecycle-contract.js";

export function inspectTravelReimbursementStaticEvidence({
  sources,
  wbsSource,
  constantsSource,
  financeSource
}) {
  const commonWbs = staticVariableString(wbsSource, "commonWBSStr");
  const researchWbs = staticVariableString(wbsSource, "commonKYWBSStr");
  if (
    !commonWbs ||
    !researchWbs ||
    countIdentifierUses(sources, "commonWBSStr") !== 2 ||
    countIdentifierUses(sources, "commonKYWBSStr") !== 1
  ) {
    return undefined;
  }

  const cityFlagRange = topLevelLiteralDeclaration(
    constantsSource,
    "theCityFlag",
    1
  );
  const saveCounterRange = topLevelLiteralDeclaration(
    constantsSource,
    "theFlagNo",
    0
  );
  const saveMarkerRange = topLevelLiteralDeclaration(
    constantsSource,
    "theConstFiaSaveFlag",
    2222
  );
  const financeFlagRange = topLevelLiteralDeclaration(
    financeSource,
    "theFinanceFlag",
    1
  );
  if (
    !cityFlagRange ||
    !saveCounterRange ||
    !saveMarkerRange ||
    !financeFlagRange ||
    countAssignments(sources, "theFinanceFlag") !== 1
  ) {
    return undefined;
  }

  return { commonWbs, financeFlagRange };
}

export function hasExactTravelReimbursementBehaviorEvidence({
  lifecycleParts,
  changeCostCenterText,
  trafficCalculationText,
  payeeCalculationSourceText,
  payeeCalculationText,
  payeeAggregateText,
  roundingText,
  form
}) {
  return (
    hasExactLifecycleAnchors(lifecycleParts) &&
    hasUnconditionalCostCenterReset(changeCostCenterText) &&
    hasExactTrafficCalculation(trafficCalculationText) &&
    hasExactPayeeCalculation(
      payeeCalculationSourceText,
      payeeCalculationText
    ) &&
    hasExactPayeeAggregate(payeeAggregateText) &&
    hasExactTwoDecimalRounding(roundingText) &&
    hasExactPayeeNativeCalculations(form)
  );
}

function hasExactLifecycleAnchors(parts) {
  const city = parts.cityBinding.text;
  const department = parts.departmentBinding.text;
  const load = parts.loadBinding.text;
  const submit = parts.submitBinding.text;
  const clear = parts.clearTraffic.text;
  const setDepartment = parts.setDepartment.text;
  return (
    hasSingleTextMatch(city, /if\s*\(\s*value\s*==\s*["']1["']\s*\)\s*\{/g) &&
    hasSingleTextMatch(city, /\btheCityFlag\s*=\s*1\s*;/g) &&
    hasSingleTextMatch(city, /\btheCityFlag\s*=\s*0\s*;/g) &&
    /isCityFlag\.value\s*=\s*"1"/.test(city) &&
    /isCityFlag\.value\s*=\s*"0"/.test(city) &&
    /clearTrainData\s*\(\s*\)/.test(city) &&
    /trafficCityChange\s*\(\s*\)/.test(city) &&
    /fd_guonei_row/.test(city) &&
    /value\.length\s*>\s*1/.test(department) &&
    /setDepartMentSelect\s*\(\s*value\s*\[\s*1\s*\]\s*\)/.test(department) &&
    [DETAIL_TABLE_IDS.traffic, DETAIL_TABLE_IDS.train, DETAIL_TABLE_IDS.flight]
      .every((id) => clear.includes(id)) &&
    /fd_bseg_firstkostl/.test(setDepartment) &&
    /changeBsegValue\s*\(\s*\)/.test(setDepartment) &&
    /typeof\s+theFinanceFlag\s*!=\s*['"]undefined['"]/.test(load) &&
    /theConstFiaSaveFlag\s*==\s*theFlagNo/.test(load) &&
    hasSingleTextMatch(
      load,
      /theCityFlag\s*=\s*Number\s*\(\s*getFormRadioValue\s*\(\s*["']fd_3cc1757848e700["']\s*\)\s*\)\s*;?/g
    ) &&
    /fd_voucher_no/.test(load) &&
    /fd_voucher_msg/.test(load) &&
    /fd_link_address/.test(load) &&
    /fd_finance_detail|financeDetailTableId/.test(load) &&
    /fd_3cc1757848e700/.test(load) &&
    /fd_396238f4339462/.test(load) &&
    /fd_bseg_firstkostl/.test(load) &&
    /commonWBSStr/.test(submit) &&
    /fd_project_num_list/.test(submit) &&
    hasExactSubmitSemantics(submit)
  );
}

function hasExactSubmitSemantics(text) {
  const ast = parseScriptAst(text);
  const callback = ast?.body?.[0]?.expression?.arguments?.[0];
  if (
    !callback ||
    callback.type !== "FunctionExpression" ||
    callback.body?.type !== "BlockStatement"
  ) {
    return false;
  }

  const nodes = collectAstNodes(callback.body);
  const cardChecks = nodes.filter((node) =>
    node.type === "IfStatement" &&
    isBinary(node.test, "<", cardNumberLengthExpression(), literalExpression(16)) &&
    blockContainsAssignment(node.consequent, "errorFlag", true)
  );
  const payeeRefreshCalls = nodes.filter((node) =>
    isIdentifierCall(node, "payeeListSum", [])
  );
  const differenceChecks = nodes.filter((node) =>
    node.type === "IfStatement" &&
    isBinary(
      node.test,
      "!=",
      callExpression(identifierExpression("Number"), [
        callExpression(memberExpression(identifierExpression("$tempObj"), "val"), [])
      ]),
      literalExpression(0)
    ) &&
    blockContainsReturn(node.consequent, false)
  );
  const financeBranches = nodes.filter((node) =>
    isExactFinanceSaveBranch(node)
  );
  const saveCalls = nodes.filter((node) =>
    isIdentifierCall(node, "SetXFormFieldValueById", [
      literalExpression(FIELD_IDS.saveFlag),
      identifierExpression("theFlagNo")
    ])
  );
  const finalStatement = callback.body.body.at(-1);

  return (
    cardChecks.length === 1 &&
    payeeRefreshCalls.length === 1 &&
    differenceChecks.length === 1 &&
    financeBranches.length === 1 &&
    saveCalls.length === 1 &&
    cardChecks[0].start < payeeRefreshCalls[0].start &&
    payeeRefreshCalls[0].start < differenceChecks[0].start &&
    differenceChecks[0].start < financeBranches[0].start &&
    financeBranches[0].start < saveCalls[0].start &&
    finalStatement?.type === "ReturnStatement" &&
    isLiteralValue(finalStatement.argument, true)
  );
}

function isExactFinanceSaveBranch(node) {
  if (
    node?.type !== "IfStatement" ||
    !isBinary(
      node.test,
      "!=",
      {
        type: "UnaryExpression",
        operator: "typeof",
        prefix: true,
        argument: identifierExpression("theFinanceFlag")
      },
      literalExpression("undefined")
    )
  ) {
    return false;
  }

  const consequent = node.consequent?.type === "BlockStatement"
    ? node.consequent.body
    : [];
  const alternate = node.alternate?.type === "BlockStatement"
    ? node.alternate.body
    : [];
  return (
    consequent.length === 1 &&
    isAssignmentStatement(
      consequent[0],
      "theFlagNo",
      identifierExpression("theConstFiaSaveFlag")
    ) &&
    alternate.length === 1 &&
    isAssignmentStatement(
      alternate[0],
      "theFlagNo",
      {
        type: "BinaryExpression",
        operator: "+",
        left: identifierExpression("theFlagNo"),
        right: literalExpression(1)
      }
    )
  );
}

function hasUnconditionalCostCenterReset(functionText) {
  const ast = parseScriptAst(functionText);
  const declaration = ast?.body?.[0];
  if (
    declaration?.type !== "FunctionDeclaration" ||
    declaration.id?.name !== "changeBsegValue"
  ) {
    return false;
  }
  const statements = declaration.body?.body || [];
  const declarationIndex = statements.findIndex((statement) =>
    statement.type === "VariableDeclaration" &&
    statement.declarations.some((candidate) =>
      candidate.id?.type === "Identifier" &&
      candidate.id.name === "secondCostCenter" &&
      isIdentifierCall(candidate.init, "$") &&
      String(candidate.init.arguments[0]?.value || "").includes(
        `extendDataFormInfo.value(${FIELD_IDS.secondCostCenter})`
      )
    )
  );
  return (
    declarationIndex >= 0 &&
    isMemberCall(
      statements[declarationIndex + 1]?.expression,
      "secondCostCenter",
      "empty",
      []
    )
  );
}

function hasExactTrafficCalculation(functionText) {
  const ast = parseScriptAst(functionText);
  const declaration = ast?.body?.[0];
  if (
    declaration?.type !== "FunctionDeclaration" ||
    declaration.id?.name !== "trafficCityChange"
  ) {
    return false;
  }
  const fieldBindings = [
    ["fdOvernightDays", "fd_overnight_days"],
    ["fdAllowanceDays", "fd_allowance_days"],
    ["allowanceCHG", "fd_allowance_chg"],
    ["everydayAllowance", "fd_everyday_allowance"]
  ];
  if (fieldBindings.some(([variable, fieldId]) =>
    !astNodeContainsLiteral(variableInitializer(declaration, variable), fieldId)
  )) {
    return false;
  }

  const nodes = collectAstNodes(declaration.body);
  const modeBranches = nodes.filter((node) =>
    node.type === "IfStatement" &&
    isBinary(
      node.test,
      "==",
      identifierExpression("theCityFlag"),
      literalExpression(0)
    )
  );
  if (modeBranches.length !== 1) return false;
  const city = collectAstNodes(modeBranches[0].consequent);
  const domestic = collectAstNodes(modeBranches[0].alternate);
  return (
    city.some((node) => isMemberCall(node, "fdOvernightDays", "val", [
      literalExpression(0)
    ])) &&
    city.some((node) => isMemberCall(node, "fdAllowanceDays", "val", [
      literalExpression(0)
    ])) &&
    city.some((node) => isMemberCall(node, "allowanceCHG", "val", [
      literalExpression(0)
    ])) &&
    city.some((node) => isMemberCall(node, "everydayAllowance", "val", [
      literalExpression(20)
    ])) &&
    city.some((node) => isIdentifierCall(node, "allowanceCalBG", [])) &&
    domestic.some((node) => isMemberCall(node, "everydayAllowance", "val", [
      literalExpression(100)
    ])) &&
    domestic.some((node) => isIdentifierCall(node, "trafficOvernightDays", [])) &&
    domestic.some((node) => isIdentifierCall(node, "allowanceCalBG", [])) &&
    nodes.filter((node) => isIdentifierCall(node, "receiptTotal", [])).length === 1
  );
}

function hasExactPayeeCalculation(sourceText, functionText) {
  if (
    staticVariableString(sourceText, "payeeListTableId") !== DETAIL_TABLE_IDS.payee ||
    staticVariableString(sourceText, "totalPayId") !== FIELD_IDS.totalCost
  ) {
    return false;
  }

  const ast = parseScriptAst(functionText);
  const declaration = ast?.body?.[0];
  if (
    declaration?.type !== "FunctionDeclaration" ||
    declaration.id?.name !== "payeeListSum"
  ) {
    return false;
  }
  const sum = variableInitializer(declaration, "sum");
  const total = variableInitializer(declaration, "payeeTotalVal");
  const totalCost = variableInitializer(declaration, "fd_total_pay");
  const differenceField = variableInitializer(declaration, "payeeDiffVal");
  const difference = variableInitializer(declaration, "diffAmount");
  const nodes = collectAstNodes(declaration.body);
  return (
    isIdentifierCall(sum, "payeeListCal", [
      identifierExpression("payeeListTableId"),
      literalExpression("fd_payee_amount")
    ]) &&
    astNodeContainsLiteral(total, FIELD_IDS.payeeTotal) &&
    isIdentifierCall(totalCost, "getFormFieldValue", [
      identifierExpression("totalPayId")
    ]) &&
    astNodeContainsLiteral(differenceField, FIELD_IDS.payeeDifference) &&
    isBinary(
      difference,
      "-",
      identifierExpression("sum"),
      callExpression(identifierExpression("Number"), [
        identifierExpression("fd_total_pay")
      ])
    ) &&
    nodes.some((node) => isMemberCall(node, "payeeTotalVal", "val", [
      identifierExpression("sum")
    ])) &&
    nodes.some((node) => isMemberCall(node, "payeeDiffVal", "val", [
      identifierExpression("diffAmount")
    ])) &&
    nodes.some((node) => isIdentifierCall(node, "payeeDiffTip", [
      identifierExpression("diffAmount")
    ]))
  );
}

function hasExactPayeeAggregate(functionText) {
  const ast = parseScriptAst(functionText);
  const declaration = ast?.body?.[0];
  if (
    declaration?.type !== "FunctionDeclaration" ||
    declaration.id?.name !== "payeeListCal" ||
    !sameIdentifiers(declaration.params, ["tableId", "controlId"]) ||
    !isLiteralValue(variableInitializer(declaration, "sum"), 0)
  ) {
    return false;
  }

  const currentAmount = variableInitializerDeep(declaration, "current_inspire");
  const nodes = collectAstNodes(declaration.body);
  const roundedAccumulations = nodes.filter((node) =>
    matchesAstShape(node, {
      type: "AssignmentExpression",
      operator: "=",
      left: identifierExpression("sum"),
      right: callExpression(identifierExpression("theFixedNumTwo"), [{
        type: "BinaryExpression",
        operator: "+",
        left: identifierExpression("sum"),
        right: callExpression(identifierExpression("Number"), [
          identifierExpression("current_inspire")
        ])
      }])
    })
  );
  return (
    matchesAstShape(currentAmount, {
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        computed: false,
        property: identifierExpression("val")
      },
      arguments: []
    }) &&
    roundedAccumulations.length === 1 &&
    nodes.filter((node) =>
      node.type === "ReturnStatement" &&
      matchesAstShape(node.argument, identifierExpression("sum"))
    ).length === 1
  );
}

function hasExactTwoDecimalRounding(functionText) {
  const ast = parseScriptAst(functionText);
  const declaration = ast?.body?.[0];
  if (
    declaration?.type !== "FunctionDeclaration" ||
    declaration.id?.name !== "theFixedNumTwo" ||
    !sameIdentifiers(declaration.params, ["value"]) ||
    !isLiteralValue(variableInitializer(declaration, "precision"), 2) ||
    !matchesAstShape(
      variableInitializer(declaration, "power"),
      callExpression(memberExpression(identifierExpression("Math"), "pow"), [
        literalExpression(10),
        identifierExpression("precision")
      ])
    )
  ) {
    return false;
  }
  const returns = collectAstNodes(declaration.body).filter((node) =>
    node.type === "ReturnStatement"
  );
  return (
    returns.length === 1 &&
    matchesAstShape(returns[0].argument, {
      type: "BinaryExpression",
      operator: "/",
      left: callExpression(
        memberExpression(identifierExpression("Math"), "round"),
        [{
          type: "BinaryExpression",
          operator: "*",
          left: identifierExpression("value"),
          right: identifierExpression("power")
        }]
      ),
      right: identifierExpression("power")
    })
  );
}

function hasExactPayeeNativeCalculations(form) {
  const total = mainField(form, FIELD_IDS.payeeTotal);
  const difference = mainField(form, FIELD_IDS.payeeDifference);
  const totalCalculation = total?.props?.calculation;
  const differenceCalculation = difference?.props?.calculation;
  return (
    total?.componentId === "xform-calculate" &&
    totalCalculation?.kind === "aggregate" &&
    totalCalculation.operation === "sum" &&
    totalCalculation.tableId === DETAIL_TABLE_IDS.payee &&
    totalCalculation.fieldId === "fd_payee_amount" &&
    difference?.componentId === "xform-calculate" &&
    differenceCalculation?.kind === "formula" &&
    differenceCalculation.expression ===
      `$${FIELD_IDS.payeeTotal}$ - $${FIELD_IDS.totalCost}$` &&
    differenceCalculation.displayExpression ===
      `$${FIELD_IDS.payeeTotal}$ - $${FIELD_IDS.totalCost}$` &&
    sameStrings(
      differenceCalculation.fieldIds,
      [FIELD_IDS.payeeTotal, FIELD_IDS.totalCost]
    )
  );
}

function parseScriptAst(text) {
  try {
    return parse(String(text || ""), {
      ecmaVersion: "latest",
      sourceType: "script"
    });
  } catch {
    return undefined;
  }
}

function collectAstNodes(root) {
  const nodes = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.type === "string") nodes.push(value);
    for (const [key, child] of Object.entries(value)) {
      if (["start", "end", "loc", "range"].includes(key)) continue;
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else {
        visit(child);
      }
    }
  };
  visit(root);
  return nodes;
}

function identifierExpression(name) {
  return { type: "Identifier", name };
}

function literalExpression(value) {
  return { type: "Literal", value };
}

function memberExpression(object, property) {
  return {
    type: "MemberExpression",
    computed: false,
    object,
    property: identifierExpression(property)
  };
}

function callExpression(callee, args) {
  return {
    type: "CallExpression",
    callee,
    arguments: args
  };
}

function cardNumberLengthExpression() {
  return memberExpression({
    type: "MemberExpression",
    computed: true,
    object: identifierExpression("tempPayeeList"),
    property: identifierExpression("i")
  }, "length");
}

function isBinary(node, operator, left, right) {
  return matchesAstShape(node, {
    type: "BinaryExpression",
    operator,
    left,
    right
  });
}

function isIdentifierCall(node, name, args) {
  return matchesAstShape(node, {
    type: "CallExpression",
    callee: identifierExpression(name),
    ...(args === undefined ? {} : { arguments: args })
  });
}

function isMemberCall(node, objectName, methodName, args) {
  return matchesAstShape(node, callExpression(
    memberExpression(identifierExpression(objectName), methodName),
    args
  ));
}

function matchesAstShape(actual, expected) {
  if (
    expected === null ||
    typeof expected !== "object"
  ) {
    return actual === expected;
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((entry, index) => matchesAstShape(actual[index], entry))
    );
  }
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) =>
    matchesAstShape(actual[key], value)
  );
}

function blockContainsAssignment(block, name, value) {
  return collectAstNodes(block).some((node) =>
    node.type === "AssignmentExpression" &&
    node.operator === "=" &&
    matchesAstShape(node.left, identifierExpression(name)) &&
    isLiteralValue(node.right, value)
  );
}

function blockContainsReturn(block, value) {
  return collectAstNodes(block).some((node) =>
    node.type === "ReturnStatement" &&
    isLiteralValue(node.argument, value)
  );
}

function isAssignmentStatement(statement, name, right) {
  return matchesAstShape(statement, {
    type: "ExpressionStatement",
    expression: {
      type: "AssignmentExpression",
      operator: "=",
      left: identifierExpression(name),
      right
    }
  });
}

function isLiteralValue(node, value) {
  return matchesAstShape(node, literalExpression(value));
}

function variableInitializer(functionDeclaration, name) {
  for (const statement of functionDeclaration?.body?.body || []) {
    if (statement.type !== "VariableDeclaration") continue;
    const declaration = statement.declarations.find((candidate) =>
      candidate.id?.type === "Identifier" &&
      candidate.id.name === name
    );
    if (declaration) return declaration.init;
  }
  return undefined;
}

function variableInitializerDeep(root, name) {
  return collectAstNodes(root)
    .find((node) =>
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      node.id.name === name
    )?.init;
}

function astNodeContainsLiteral(node, value) {
  return collectAstNodes(node).some((candidate) =>
    candidate.type === "Literal" &&
    typeof candidate.value === "string" &&
    candidate.value.includes(value)
  );
}

function sameStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function sameIdentifiers(actual, expectedNames) {
  return (
    Array.isArray(actual) &&
    actual.length === expectedNames.length &&
    actual.every((node, index) =>
      node?.type === "Identifier" &&
      node.name === expectedNames[index]
    )
  );
}

function hasSingleTextMatch(text, pattern) {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  return [...String(text || "").matchAll(new RegExp(pattern.source, flags))].length === 1;
}

function topLevelLiteralDeclaration(text, name, expectedValue) {
  const ast = parseScriptAst(text);
  if (!ast) return undefined;
  const declarations = ast.body.flatMap((statement) => {
    if (statement.type !== "VariableDeclaration") return [];
    return statement.declarations.filter((declaration) =>
      declaration.id?.type === "Identifier" &&
      declaration.id.name === name
    ).map((declaration) => ({ declaration, statement }));
  });
  if (
    declarations.length !== 1 ||
    declarations[0].declaration.init?.type !== "Literal" ||
    declarations[0].declaration.init.value !== expectedValue
  ) {
    return undefined;
  }
  return {
    start: declarations[0].statement.start,
    end: declarations[0].statement.end
  };
}

function staticVariableString(text, name) {
  const ast = parseScriptAst(text);
  if (!ast) return undefined;
  const values = ast.body.flatMap((statement) => {
    if (statement.type !== "VariableDeclaration") return [];
    return statement.declarations
      .filter((declaration) =>
        declaration.id?.type === "Identifier" &&
        declaration.id.name === name &&
        declaration.init?.type === "Literal" &&
        typeof declaration.init.value === "string"
      )
      .map((declaration) => declaration.init.value);
  });
  return values.length === 1 ? values[0] : undefined;
}

function countIdentifierUses(sources, name) {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
  return sources.reduce((count, source) =>
    count + [...String(source.javascript || "").matchAll(pattern)].length, 0);
}

function countAssignments(sources, name) {
  const pattern = new RegExp(`\\b(?:var\\s+)?${escapeRegExp(name)}\\s*=`, "g");
  return sources.reduce((count, source) =>
    count + [...String(source.javascript || "").matchAll(pattern)].length, 0);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mainField(form, fieldId) {
  return (form?.fields || []).find((field) =>
    field?.id === fieldId && field?.type !== "detailTable"
  );
}
