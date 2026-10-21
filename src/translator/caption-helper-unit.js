import { parse } from "acorn";
import { createHash } from "node:crypto";
import { HOST_BINDINGS } from "./caption-shared-scalar-scope.js";

const key = node => JSON.stringify(node, (name, value) => ["start", "end", "raw"].includes(name) ? undefined : value);
const inert = node => node?.type === "Literal" && !node.regex ||
  node?.type === "ObjectExpression" && node.properties.length === 0 || node?.type === "ArrayExpression" && node.elements.length === 0;

// These designer-owned units already have no global executable script in the
// DSL. Their declarations remain available for every observed caller; only an
// uncalled declaration in this exact independently rebuilt unit is non-entry.
export function captionHelperUnits(source, scripts) {
  const definitions = new Map();
  for (const unit of source.scripts?.sources || []) {
    if (unit.sourceKey !== "fdDesignerHtml" || unit.sourceType !== "designer-jsp" || !unit.fragmentId || !unit.sourceRef) continue;
    const actions = (scripts?.actions || []).filter(action => action.sourceRefs?.includes(unit.sourceRef));
    if (actions.length !== 1 || actions[0].sourceRefs.length !== 1 || actions[0].translationStatus !== "omitted" ||
        actions[0].function?.trim() || actions[0].coverage?.status !== "covered" || actions[0].coverage.residuals?.length ||
        actions[0].coverage.nativeRules?.length || !actions[0].functionMappings?.some(mapping => mapping.basis === "legacy-runtime-noop" &&
          mapping.source === "legacy helper function definitions" && mapping.target === "inlined translated script actions" && mapping.reviewRequired === false)) continue;
    let tree;
    try { tree = parse(unit.javascript, { ecmaVersion: "latest" }); } catch { continue; }
    if (!tree.body.every(node => ["FunctionDeclaration", "EmptyStatement"].includes(node.type) ||
        node.type === "VariableDeclaration" && node.kind === "var" && node.declarations.every(d => d.id.type === "Identifier" && inert(d.init)))) continue;
    for (const node of tree.body.filter(node => node.type === "FunctionDeclaration")) {
      if (HOST_BINDINGS.has(node.id.name)) continue;
      const signature = key(node);
      definitions.set(signature, { sourceRef: unit.sourceRef, owner: unit.fragmentId, functionName: node.id.name,
        start: node.start, end: node.end, astSha256: createHash("sha256").update(signature).digest("hex"),
        basis: "designer-helper-only-unit-with-no-active-inbound-call" });
    }
  }
  return definitions;
}
