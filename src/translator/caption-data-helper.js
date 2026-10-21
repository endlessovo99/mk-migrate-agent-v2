import { parse } from "acorn";
import { isPureLocalCurrencyHelperDeclaration } from "./local-currency-helper.js";

const INSPECTED = new Set([
  "Program", "FunctionDeclaration", "BlockStatement", "Identifier", "Literal",
  "VariableDeclaration", "VariableDeclarator", "ExpressionStatement", "EmptyStatement",
  "ReturnStatement", "IfStatement", "ForStatement", "BreakStatement", "ContinueStatement",
  "CallExpression", "NewExpression", "MemberExpression", "BinaryExpression",
  "LogicalExpression", "UnaryExpression", "ConditionalExpression", "AssignmentExpression",
  "UpdateExpression", "ArrayExpression", "SequenceExpression"
]);

/** Reuse the existing v2 pure-data proof, with caption-program binding guards.
 * Its input comes from the scalar domain; it cannot receive DOM handles or
 * source callbacks. This checks source AST only and never runs the helper. */
export function pureCaptionDataHelper(text, reserved) {
  if (!isPureLocalCurrencyHelperDeclaration(text)) return false;
  const tree = parse(text, { ecmaVersion: "latest" });
  let safe = true;
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.type && !INSPECTED.has(node.type)) safe = false;
    if (node.type === "UnaryExpression" && node.operator === "delete") safe = false;
    if (node.type === "VariableDeclaration" && node.kind !== "var") safe = false;
    if (node.type === "VariableDeclarator" && (node.id.type !== "Identifier" || reserved.has(node.id.name))) safe = false;
    if (["AssignmentExpression", "UpdateExpression"].includes(node.type) && reserved.has((node.left || node.argument)?.name)) safe = false;
    if (/Function/.test(node.type) && node.params?.some(p => p.type !== "Identifier" || reserved.has(p.name))) safe = false;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  }
  walk(tree);
  return safe;
}
