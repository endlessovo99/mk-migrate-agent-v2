import { parse } from "acorn";
import { inlineOnChangeSourceActionKey } from "./source-action-key.js";

const SAFE_GLOBAL_CALLS = new Set(["Number", "parseFloat", "parseInt"]);
const SAFE_METHOD_CALLS = new Set(["indexOf", "split", "substr", "toString"]);

export function localCurrencyHelperCandidates(source = {}, form = {}) {
  const model = localCurrencyHelperModel(source);
  if (!model || !mainField(form, model.triggerId) || !mainField(form, model.targetId)) return [];
  const sourceRef = source.sourceRef || source.id;
  return [{
    index: model.bindingStart,
    sourceActionKey: inlineOnChangeSourceActionKey(sourceRef, model.bindingStart),
    event: "onChange",
    scope: "control",
    controlId: model.triggerId,
    javascript: model.source,
    function: compiledCurrencyFunction(model),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "exact local convertCurrency helper assignment",
      target: "control onChange + MKXFORM.setValue",
      basis: "deterministic-local-currency-helper",
      reviewRequired: false
    }],
    semanticHints: {
      coveredCalculationRanges: [{
        sourceRef,
        name: model.helperName,
        start: model.bindingStart,
        end: model.helperEnd
      }]
    }
  }];
}

function localCurrencyHelperModel(source = {}) {
  const text = String(source.javascript || "");
  let program;
  try {
    program = parse(text, { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return undefined;
  }
  const statements = program.body.filter((statement) => statement.type !== "EmptyStatement");
  if (statements.length !== 2) return undefined;
  const bindingStatement = statements.find((statement) => statement.type === "ExpressionStatement");
  const helper = statements.find((statement) => statement.type === "FunctionDeclaration");
  if (helper?.id?.name !== "convertCurrency" || helper.params?.length !== 1) return undefined;
  if (helper.params[0]?.type !== "Identifier" || !safeLocalCurrencyHelper(helper)) return undefined;

  const binding = valueChangeBinding(bindingStatement?.expression);
  if (!binding || binding.callback.params?.[0]?.type !== "Identifier") return undefined;
  const callbackBody = binding.callback.body?.body?.filter((statement) => (
    statement.type !== "EmptyStatement"
  ));
  if (callbackBody?.length !== 1 || callbackBody[0].type !== "ExpressionStatement") return undefined;
  const assignment = callbackBody[0].expression;
  if (assignment?.type !== "AssignmentExpression" || assignment.operator !== "=") return undefined;
  const targetId = legacyFieldValueTarget(assignment.left);
  const call = assignment.right;
  if (
    !targetId ||
    call?.type !== "CallExpression" ||
    call.callee?.type !== "Identifier" ||
    call.callee.name !== helper.id.name ||
    call.arguments?.length !== 1 ||
    call.arguments[0]?.type !== "Identifier" ||
    call.arguments[0].name !== binding.callback.params[0].name
  ) return undefined;

  return {
    source: text,
    bindingStart: bindingStatement.start,
    helperEnd: helper.end,
    helperName: helper.id.name,
    helperSource: text.slice(helper.start, helper.end),
    triggerId: binding.triggerId,
    targetId
  };
}

function valueChangeBinding(expression) {
  if (
    expression?.type !== "CallExpression" ||
    expression.callee?.type !== "Identifier" ||
    expression.callee.name !== "AttachXFormValueChangeEventById" ||
    expression.arguments?.length !== 2 ||
    expression.arguments[0]?.type !== "Literal" ||
    typeof expression.arguments[0].value !== "string" ||
    !["FunctionExpression", "ArrowFunctionExpression"].includes(expression.arguments[1]?.type)
  ) return undefined;
  return { triggerId: expression.arguments[0].value, callback: expression.arguments[1] };
}

function legacyFieldValueTarget(node) {
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
    node.object.object.arguments?.length !== 1 ||
    node.object.object.arguments[0]?.type !== "Literal" ||
    typeof node.object.object.arguments[0].value !== "string"
  ) return undefined;
  return node.object.object.arguments[0].value;
}

function safeLocalCurrencyHelper(helper) {
  const declared = new Set(helper.params.map((param) => param.name));
  walk(helper.body, (node) => {
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
      declared.add(node.id.name);
    }
  });
  let safe = true;
  walk(helper.body, (node, parent) => {
    if (!safe) return;
    if (["AwaitExpression", "ClassDeclaration", "ClassExpression", "ImportExpression", "MetaProperty", "NewExpression", "Super", "ThisExpression", "ThrowStatement", "TryStatement", "WhileStatement", "WithStatement", "YieldExpression"].includes(node.type)) {
      if (node.type !== "NewExpression" || !safeArrayConstructor(node)) safe = false;
      return;
    }
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      safe = false;
      return;
    }
    if (node.type === "CallExpression" && !safeHelperCall(node)) safe = false;
    if (node.type === "AssignmentExpression" && (
      node.left?.type !== "Identifier" || !declared.has(node.left.name)
    )) safe = false;
    if (node.type === "UpdateExpression" && (
      node.argument?.type !== "Identifier" || !declared.has(node.argument.name)
    )) safe = false;
    if (node.type === "Identifier" && !safeIdentifier(node, parent, declared)) safe = false;
  }, helper);
  return safe;
}

function safeArrayConstructor(node) {
  return node.callee?.type === "Identifier" &&
    node.callee.name === "Array" &&
    node.arguments.every((argument) => argument.type === "Literal");
}

function safeHelperCall(node) {
  if (node.callee?.type === "Identifier") return SAFE_GLOBAL_CALLS.has(node.callee.name);
  return node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.property?.type === "Identifier" &&
    SAFE_METHOD_CALLS.has(node.callee.property.name);
}

function safeIdentifier(node, parent, declared) {
  if (declared.has(node.name) || SAFE_GLOBAL_CALLS.has(node.name) || node.name === "Array") return true;
  if (parent?.type === "FunctionDeclaration" && (parent.id === node || parent.params.includes(node))) return true;
  if (parent?.type === "VariableDeclarator" && parent.id === node) return true;
  if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return true;
  return false;
}

function compiledCurrencyFunction(model) {
  const helper = model.helperSource.replace(/new\s+Array\(([^()]*)\)/g, "[$1]");
  return [
    "function onChange(value, rowNum, parentRowNum) {",
    indent(helper, "  "),
    `  MKXFORM.setValue(${JSON.stringify(model.targetId)}, ${model.helperName}(value))`,
    "}"
  ].join("\n");
}

function mainField(form, fieldId) {
  return (Array.isArray(form?.fields) ? form.fields : []).some((field) => (
    field?.id === fieldId && field.type !== "detailTable" && field.dataOnly !== true
  ));
}

function walk(node, visitor, parent) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") return;
  visitor(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (["start", "end", "loc", "range"].includes(key)) continue;
    if (Array.isArray(value)) {
      value.forEach((child) => walk(child, visitor, node));
    } else {
      walk(value, visitor, node);
    }
  }
}

function indent(text, prefix) {
  return String(text).split("\n").map((line) => `${prefix}${line}`).join("\n");
}
