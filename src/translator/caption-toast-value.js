import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";

// Only literal text and local arrays of numeric positions may build a message.
// This closes native validation diagnostics without trusting arbitrary values,
// array aliases, callbacks, property coercions or external message builders.
export function captionToastValueProof(text, tree) {
  const model = buildJavaScriptBindingModel(text), entries = [], parents = new WeakMap();
  walk(tree, (node, parent) => { entries.push({ node, parent }); if (parent) parents.set(node, parent); });
  const binding = node => node?.type === "Identifier" && model.ok && model.bindingAtUse(node.name, node.start);
  const declaration = value => {
    if (!value || value.ambiguous || value.declarations.length !== 1 || value.kinds.has("parameter")) return undefined;
    return entries.find(({ node }) => node.type === "VariableDeclarator" && binding(node.id) === value)?.node;
  };
  const number = (node, seen = new Set()) => {
    if (node?.type === "Literal") return typeof node.value === "number" && Number.isFinite(node.value);
    if (node?.type === "BinaryExpression" && ["+", "-", "*", "/", "%"].includes(node.operator))
      return number(node.left, seen) && number(node.right, seen);
    const value = binding(node), definition = declaration(value);
    if (!definition || seen.has(value) || definition.init?.type !== "Literal" || typeof definition.init.value !== "number" || !Number.isFinite(definition.init.value)) return false;
    const next = new Set([...seen, value]);
    return entries.every(({ node: use, parent }) => {
      if (use.type !== "Identifier" || binding(use) !== value) return true;
      if (parent?.type === "AssignmentExpression" && parent.left === use)
        return ["=", "+=", "-=", "*=", "/=", "%="].includes(parent.operator) && number(parent.right, next);
      if (parent?.type === "UpdateExpression") return ["++", "--"].includes(parent.operator);
      if (parent?.type?.endsWith("Pattern") || parent?.type === "RestElement" ||
          parent?.type === "Property" && parents.get(parent)?.type === "ObjectPattern") return false;
      return parent?.type !== "ForInStatement" && parent?.type !== "ForOfStatement";
    });
  };
  const array = node => {
    const value = binding(node), definition = declaration(value);
    if (definition?.init?.type !== "ArrayExpression" || definition.init.elements.length) return false;
    return entries.every(({ node: use, parent }) => {
      if (use.type !== "Identifier" || binding(use) !== value || use === definition.id) return true;
      if (parent?.type !== "MemberExpression" || parent.object !== use || parent.computed || parent.optional) return false;
      const consumer = parents.get(parent);
      if (parent.property.name === "length") return consumer?.type !== "AssignmentExpression" && consumer?.type !== "UpdateExpression";
      if (consumer?.type !== "CallExpression" || consumer.callee !== parent || consumer.optional) return false;
      if (parent.property.name === "join") return consumer.arguments.length === 1 && consumer.arguments[0].type === "Literal" && typeof consumer.arguments[0].value === "string";
      return parent.property.name === "push" && consumer.arguments.length === 1 && number(consumer.arguments[0]);
    });
  };
  const message = node => node?.type === "Literal" && typeof node.value === "string" ||
    node?.type === "BinaryExpression" && node.operator === "+" && message(node.left) && message(node.right) ||
    node?.type === "CallExpression" && !node.optional && node.callee.type === "MemberExpression" && !node.callee.computed &&
      node.callee.property.name === "join" && node.arguments.length === 1 && node.arguments[0].type === "Literal" &&
      typeof node.arguments[0].value === "string" && array(node.callee.object);
  return message;
}

function walk(node, visit, parent) {
  if (!node || typeof node !== "object") return;
  visit(node, parent);
  for (const value of Object.values(node)) if (value && typeof value === "object")
    Array.isArray(value) ? value.forEach(child => walk(child, visit, node)) : walk(value, visit, node);
}
