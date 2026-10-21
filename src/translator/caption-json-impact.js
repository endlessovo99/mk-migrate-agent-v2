import { parse } from "acorn";
import { createHash } from "node:crypto";
import { inspectSharedJsonImpactModel } from "./source-shared-json-state.js";

export const captionImpactNodeKey = (index, node) => `${index}:${node.start}:${node.end}:${astKey(node)}`;
const astKey = node => JSON.stringify(node, (key, value) => ["start", "end", "raw"].includes(key) ? undefined : value);
const digest = node => createHash("sha256").update(astKey(node)).digest("hex");

// Rebuild the existing complete source-state proof, then abstract only its
// data-only fragments. Every residual statement still reaches the normal
// effect checker. Nothing is removed from Source Draft or migrated scripts.
export function captionJsonImpact(source, form, programs) {
  const model = inspectSharedJsonImpactModel(form, source.scripts);
  if (!model) return undefined;
  const skip = new Map(), values = new Map(), readers = new Map(), evidence = [];
  const initializer = astKey(model.initializer.node);
  const readerFrames = new Map(model.readers.map(frame => [astKey(frame.node), frame]));
  const standalone = new Set([model.declaration, ...model.callbacks].filter(Boolean).map(astKey));
  const add = (map, index, node, kind, details = {}) => {
    const proof = { fieldId: model.fieldId, kind, ...details };
    map.set(captionImpactNodeKey(index, node), proof);
    evidence.push({ scriptIndex: index, start: node.start, end: node.end, astSha256: digest(node), kind });
  };
  for (const [index, text] of [...new Set(programs.filter(Boolean))].entries()) {
    let tree;
    try { tree = parse(text, { ecmaVersion: "latest", allowReturnOutsideFunction: true }); } catch { continue; }
    for (const node of tree.body) {
      if (standalone.has(astKey(node))) add(skip, index, node, "closed-json-data-statement");
      if (node.type !== "FunctionDeclaration") continue;
      const frame = astKey(node) === initializer ? model.initializer : readerFrames.get(astKey(node));
      if (!frame) continue;
      if (frame === model.initializer) {
        for (const statement of node.body.body.filter(node => node.type !== "EmptyStatement").slice(0, frame.prefixLength))
          add(skip, index, statement, "closed-json-initializer-data-prefix", {
            ...(statement.type === "ForStatement" && frame.reader ? { invokedReader: astKey(frame.reader) } : {}) });
      } else add(readers, index, node, "closed-json-readonly-reader");
      for (const path of frame.reads) {
        const read = path.reduce((node, part) => node?.[part], node);
        if (read?.type === "MemberExpression") add(values, index, read, "closed-json-state-value-read");
      }
    }
  }
  return { skip, values, readers, proof: { version: 1, contract: "rebuilt-source-shared-json-data-impact",
    stateName: model.stateName, fieldId: model.fieldId, fragments: evidence } };
}
