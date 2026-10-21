import { parse } from "acorn";

const PURE_CALLS = new Set(["Number", "String", "Boolean", "parseInt", "parseFloat", "isNaN", "isFinite", "alert"]);
const FIELD_CALLS = new Set(["GetXFormFieldValueById", "getFormFieldValue", "SetXFormFieldValueById"]);
const VALUE_READS = new Set(["GetXFormFieldValueById", "getFormFieldValue"]);
const GLOBALS = new Set(["document", "window", "globalThis", "self", "$", "jQuery", "eval", "Function"]);
const MATH_CALLS = new Set(["abs", "ceil", "floor", "round", "min", "max", "pow", "sqrt", "trunc"]);
const INSPECTED_SYNTAX = new Set([
  "Program", "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "BlockStatement",
  "VariableDeclaration", "VariableDeclarator", "EmptyStatement", "ExpressionStatement", "ReturnStatement",
  "IfStatement", "ConditionalExpression", "LogicalExpression", "BinaryExpression", "UnaryExpression",
  "UpdateExpression", "AssignmentExpression", "CallExpression", "MemberExpression", "Identifier", "Literal",
  "TemplateLiteral", "TemplateElement", "SequenceExpression", "ForStatement", "WhileStatement",
  "DoWhileStatement", "BreakStatement", "ContinueStatement", "SwitchStatement", "SwitchCase",
  "ThrowStatement", "TryStatement", "CatchClause"
]);

/** Only completely inspected local functions and bounded data calls avoid the
 * unknown-presentation guard. DOM selectors and unknown callees remain opaque. */
export function captionScriptReferences(scripts) {
  const result = { values: [], opaque: false };
  const trees = [];
  for (const script of scripts) {
    try { trees.push(parse(script, { ecmaVersion: "latest", allowReturnOutsideFunction: true })); }
    catch { result.opaque = true; }
  }
  const localFunctions = new Set();
  for (const tree of trees) for (const node of tree.body) {
    if (node.type === "FunctionDeclaration" && node.id) localFunctions.add(node.id.name);
  }
  const reserved = name => PURE_CALLS.has(name) || FIELD_CALLS.has(name) || ["Math", "Com_IncludeFile"].includes(name);
  for (const tree of trees) walk(tree, node => {
    if (!INSPECTED_SYNTAX.has(node.type) || node.type === "UpdateExpression" ||
        node.type === "AssignmentExpression" && node.operator !== "=" ||
        node.type === "UnaryExpression" && node.operator === "delete" ||
        node.type === "TemplateLiteral" && node.expressions.length) result.opaque = true;
    if (node.type === "Identifier" && GLOBALS.has(node.name)) result.opaque = true;
    // A handle can reach a caption through arbitrary DOM properties. Only the
    // explicitly modeled Math namespace is safe; no DOM-member blacklist.
    if (node.type === "MemberExpression" && !(node.object.name === "Math" &&
        !node.computed && MATH_CALLS.has(node.property.name))) result.opaque = true;
    const protectedBinding = name => reserved(name) || localFunctions.has(name);
    if (node.type === "VariableDeclarator" && (node.id.type !== "Identifier" || protectedBinding(node.id.name)) ||
        ["AssignmentExpression", "UpdateExpression"].includes(node.type) &&
          (protectedBinding((node.left || node.argument)?.name) ||
           (node.left || node.argument)?.object?.name === "Math" ||
           ["ObjectPattern", "ArrayPattern"].includes(node.left?.type)) ||
        /Function/.test(node.type) && (reserved(node.id?.name) ||
          node.params?.some(param => param.type !== "Identifier" || protectedBinding(param.name))) ||
        node.type === "CatchClause" && node.param && (node.param.type !== "Identifier" || protectedBinding(node.param.name)) ||
        ["ClassDeclaration", "ClassExpression", "WithStatement"].includes(node.type)) {
      result.opaque = true;
    }
    if (node.type === "NewExpression") result.opaque = true;
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const name = callee.type === "Identifier" && callee.name;
      const math = callee.type === "MemberExpression" && !callee.computed &&
        callee.object.name === "Math" && MATH_CALLS.has(callee.property.name);
      // Coercing an unknown object can execute its valueOf/toString hook.
      if ((PURE_CALLS.has(name) || math) && !node.arguments.every(provenValue)) result.opaque = true;
      const calculationLibrary = name === "Com_IncludeFile" && node.arguments.length === 2 &&
        staticString(node.arguments[0]) === "calculation_script.js" &&
        staticString(node.arguments[1]) === "../sys/xform/designer/calculation/";
      if (!(PURE_CALLS.has(name) || localFunctions.has(name) || math || calculationLibrary ||
          FIELD_CALLS.has(name) && staticString(node.arguments[0]) !== undefined &&
          node.arguments.slice(1).every(provenValue))) result.opaque = true;
    }
    if (node.type === "BinaryExpression" && !["===", "!=="].includes(node.operator) && !provenValue(node) ||
        node.type === "UnaryExpression" && !["!", "typeof", "void"].includes(node.operator) && !provenValue(node)) result.opaque = true;
    const value = staticString(node);
    if (value !== undefined) result.values.push(value);
  });
  return result;
}

function provenValue(node) {
  if (!node) return false;
  if (node.type === "Literal") return !node.regex && (node.value === null || typeof node.value !== "object");
  if (node.type === "TemplateLiteral") return node.expressions.length === 0;
  if (node.type === "BinaryExpression") return !["in", "instanceof"].includes(node.operator) &&
    provenValue(node.left) && provenValue(node.right);
  if (node.type === "UnaryExpression") return node.operator !== "delete" && provenValue(node.argument);
  if (node.type !== "CallExpression") return false;
  const name = node.callee.type === "Identifier" && node.callee.name;
  if (VALUE_READS.has(name)) return node.arguments.length === 1 && staticString(node.arguments[0]) !== undefined;
  const math = node.callee.type === "MemberExpression" && !node.callee.computed &&
    node.callee.object.name === "Math" && MATH_CALLS.has(node.callee.property.name);
  return (PURE_CALLS.has(name) || math) && node.arguments.every(provenValue);
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach(item => walk(item, visit));
    else if (child && typeof child === "object") walk(child, visit);
  }
}

function staticString(node) {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticString(node.left), right = staticString(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
}
