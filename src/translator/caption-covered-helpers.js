import { parse } from "acorn";

// Coverage of one call does not make its helper declaration disposable while
// an uncovered callback still uses it. Retain actual bodies transitively;
// the ordinary scope checker must prove their effects and return values.
export function captionNeededCoveredHelpers(programs, statements, key) {
  const entries = [], covered = new Map(), needed = new Set();
  for (const program of programs) {
    let ast;
    try { ast = parse(program.text, { ecmaVersion: "latest", allowReturnOutsideFunction: true }); } catch { continue; }
    const last = new Map(ast.body.filter(node => node.type === "FunctionDeclaration").map(node => [node.id?.name, node]));
    for (const node of ast.body) {
      const isCovered = statements.has(key(node));
      const shadowed = node.type === "FunctionDeclaration" && last.get(node.id?.name) !== node && statements.has(key(last.get(node.id?.name)));
      entries.push({ node, removed: isCovered || shadowed });
      if (isCovered && node.type === "FunctionDeclaration") {
        const definitions = covered.get(node.id.name) || [];
        definitions.push(node); covered.set(node.id.name, definitions);
      }
    }
  }
  const references = node => walk(node, (use, parent) => {
    if (use.type !== "Identifier" || !covered.has(use.name) ||
        parent?.type === "MemberExpression" && parent.property === use && !parent.computed ||
        parent?.type === "Property" && parent.key === use && !parent.computed && !parent.shorthand ||
        parent?.type === "VariableDeclarator" && parent.id === use ||
        ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(parent?.type) && (parent.id === use || parent.params.includes(use))) return;
    needed.add(use.name);
  });
  for (const entry of entries) if (!entry.removed) references(entry.node);
  const visited = new Set();
  for (const name of needed) {
    if (visited.has(name)) continue;
    visited.add(name);
    for (const definition of covered.get(name) || []) references(definition.body);
  }
  return needed;
}

function walk(node, visit, parent) {
  if (!node || typeof node !== "object") return;
  visit(node, parent);
  for (const value of Object.values(node)) if (value && typeof value === "object")
    Array.isArray(value) ? value.forEach(child => walk(child, visit, node)) : walk(value, visit, node);
}
