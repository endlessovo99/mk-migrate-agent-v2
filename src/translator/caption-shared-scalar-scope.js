// A source-owned primitive shared by callbacks has no stable current value.
// Its abstraction is scalar data, never its initializer or last visited write.
export const HOST_BINDINGS = new Set(["globalThis", "self", "top", "parent", "frames", "location", "navigator", "Object", "Reflect", "JSON",
  "eval", "Function", "Promise", "Symbol", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "Error", "TypeError", "URL", "URLSearchParams",
  "Intl", "undefined", "NaN", "Infinity", "__proto__", "constructor", "prototype"]);

export function captionSharedScalars(programs, reserved) {
  const declarations = new Map(), invalid = new Set(), captured = new Set(), initializers = new Map(), mutated = new Set();
  for (const { tree, index } of programs) visit(tree, (node, parent, functions) => {
    if (functions.length) return;
    if (node.type === "FunctionDeclaration" && node.id) invalid.add(node.id.name);
    if (node.type !== "VariableDeclaration") return;
    for (const declaration of node.declarations) {
      if (declaration.id.type !== "Identifier") continue;
      const name = declaration.id.name;
      if (parent !== tree || node.kind !== "var" || reserved.has(name) || HOST_BINDINGS.has(name) || declaration.init?.type !== "Literal" ||
          declaration.init.regex || declaration.init.value !== null && !["string", "number", "boolean"].includes(typeof declaration.init.value)) {
        invalid.add(name); continue;
      }
      const records = declarations.get(name) || [];
      records.push({ scriptIndex: index, offset: declaration.start }); declarations.set(name, records);
      initializers.set(name, [...(initializers.get(name) || []), declaration.init.value]);
    }
  });
  for (const { tree } of programs) visit(tree, (node, parent, functions) => {
    if (["AssignmentExpression", "UpdateExpression"].includes(node.type)) {
      const target = node.left || node.argument;
      // A same-name local (including a hoisted var) does not mutate the
      // captured Program binding. Writes through any unshadowed callback do.
      if (target.type === "Identifier" && !functions.some(names => names.has(target.name))) mutated.add(target.name);
    }
    if (!functions.length || node.type !== "Identifier" || !declarations.has(node.name) ||
        functions.some(names => names.has(node.name)) ||
        parent?.type === "MemberExpression" && parent.property === node && !parent.computed ||
        parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand) return;
    captured.add(node.name);
  });
  return new Map([...declarations].filter(([name]) => captured.has(name) && !invalid.has(name))
    .map(([name, declarations]) => [name, { name, abstraction: "unknown-scalar", declarations,
      ...(!mutated.has(name) ? { readonlyLiterals: [...new Set(initializers.get(name))] } : {}) }]));
}

export function captionFunctionBindings(fn) {
  const names = new Set(fn.params.filter(node => node.type === "Identifier").map(node => node.name));
  if (fn.id) names.add(fn.id.name);
  visit(fn.body, node => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" || node.type === "FunctionDeclaration" && node.id)
      names.add(node.id.name);
  }, [], true);
  return names;
}

function visit(node, fn, functions = [], skipNested = false, parent) {
  if (!node || typeof node !== "object") return;
  fn(node, parent, functions);
  const isFunction = ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type);
  if (isFunction && skipNested) return;
  const scopes = isFunction ? [...functions, captionFunctionBindings(node)] : functions;
  for (const value of Object.values(node)) if (value && typeof value === "object")
    Array.isArray(value) ? value.forEach(child => visit(child, fn, scopes, skipNested, node)) : visit(value, fn, scopes, skipNested, node);
}
