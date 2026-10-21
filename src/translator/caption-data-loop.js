// A finite forward traversal of an unchanged primitive split result. It never
// supplies a DOM handle, a concrete element identity or an exact iteration count.
export function captionDataLoop(node) {
  const declaration = node.init?.type === "VariableDeclaration" && node.init.kind === "var" &&
    node.init.declarations.length === 1 && node.init.declarations[0];
  const index = declaration?.id?.type === "Identifier" && declaration.id.name;
  const test = node.test, length = test?.right;
  const collection = length?.type === "MemberExpression" && !length.computed && length.property.name === "length" &&
    length.object.type === "Identifier" && length.object.name;
  const update = node.update;
  const forward = update?.type === "UpdateExpression" && update.operator === "++" && update.argument?.name === index ||
    update?.type === "AssignmentExpression" && update.operator === "+=" && update.left?.name === index && update.right?.value === 1;
  if (!index || !collection || index === collection || declaration.init?.type !== "Literal" || declaration.init.value !== 0 ||
      test.type !== "BinaryExpression" || test.operator !== "<" || test.left.type !== "Identifier" || test.left.name !== index || !forward) return undefined;
  let mutated = false;
  walk(node.body, item => {
    if (item.type === "VariableDeclarator" && [index, collection].includes(item.id?.name) ||
        ["AssignmentExpression", "UpdateExpression"].includes(item.type) && [index, collection].includes((item.left || item.argument)?.name)) mutated = true;
  });
  return mutated ? undefined : { index, collection, collectionNode: length.object };
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) if (value && typeof value === "object")
    Array.isArray(value) ? value.forEach(child => walk(child, visit)) : walk(value, visit);
}
