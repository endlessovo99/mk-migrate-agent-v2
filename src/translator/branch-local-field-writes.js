import { parse } from "acorn";
import { createHash } from "node:crypto";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";

const digest = text => createHash("sha256").update(text).digest("hex");
const APIs = new Set(["GetXFormFieldById", "SetXFormFieldValueById"]);
const visit = (node, callback, parent) => {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(child => visit(child, callback, parent)); return; }
  callback(node, parent);
  for (const [key, child] of Object.entries(node)) if (!["start", "end", "raw"].includes(key)) visit(child, callback, node);
};

// Qualify a branch-local DOM handle used only by its adjacent literal write.
export function branchLocalLiteralWrites(source = {}, form = {}) {
  const text = String(source.javascript || "");
  let program;
  try { program = parse(text, { ecmaVersion: "latest" }); } catch { return undefined; }
  const bindings = buildJavaScriptBindingModel(text);
  if (!bindings.ok) return undefined;
  let apiMutation = false;
  visit(program, node => {
    if (!["AssignmentExpression", "UpdateExpression"].includes(node.type) && !(node.type === "UnaryExpression" && node.operator === "delete")) return;
    const left = node.left || node.argument;
    if (left?.type === "Identifier" && APIs.has(left.name) || left?.type === "MemberExpression" &&
      APIs.has(left.computed ? left.property?.value : left.property?.name)) apiMutation = true;
  });
  if (apiMutation) return undefined;
  const patches = [];
  visit(program, (block, parent) => {
    if (block.type !== "BlockStatement" || parent?.type !== "IfStatement") return;
    for (let index = 0; index < block.body.length - 1; index++) {
      const declaration = block.body[index], statement = block.body[index + 1];
      if (declaration.type !== "VariableDeclaration" || declaration.kind !== "var" || declaration.declarations.length !== 1) continue;
      const binding = declaration.declarations[0], init = binding.init, write = statement.type === "ExpressionStatement" && statement.expression;
      if (binding.id.type !== "Identifier" || init?.type !== "MemberExpression" || !init.computed || init.property?.type !== "Literal" || init.property.value !== 0 ||
        init.object?.type !== "CallExpression" || init.object.optional || init.object.callee?.type !== "Identifier" || init.object.callee.name !== "GetXFormFieldById" ||
        init.object.arguments.length !== 1 || init.object.arguments[0]?.type !== "Literal" || typeof init.object.arguments[0].value !== "string" ||
        write?.type !== "AssignmentExpression" || write.operator !== "=" || write.left?.type !== "MemberExpression" || write.left.computed || write.left.optional ||
        write.left.object?.type !== "Identifier" || write.left.object.name !== binding.id.name || write.left.property?.name !== "value" ||
        write.right?.type !== "Literal" || typeof write.right.value !== "string") continue;
      const fieldId = init.object.arguments[0].value;
      const fields = form.fields?.filter(field => field.id === fieldId);
      if (fields?.length !== 1 || !["text", "longText"].includes(fields[0].type) || fields[0].sourceProps?.metadataKind !== "simple" ||
        fields[0].sourceProps?.metadataAttributes?.type !== "String" ||
        !bindings.isUnshadowedGlobal("GetXFormFieldById", init.object.callee.start) ||
        !bindings.isUnshadowedGlobal("SetXFormFieldValueById", declaration.start)) continue;
      const identity = bindings.bindingAtUse(binding.id.name, binding.id.start);
      if (!identity || identity.ambiguous || identity.declarations.length !== 1) continue;
      const references = [];
      visit(program, (node, owner) => {
        if (node.type !== "Identifier" || node.name !== binding.id.name || bindings.bindingAtUse(node.name, node.start) !== identity) return;
        if (owner?.type === "MemberExpression" && owner.property === node && !owner.computed ||
            owner?.type === "Property" && owner.key === node && !owner.computed && !owner.shorthand) return;
        references.push(node.start);
      });
      if (references.length !== 2 || !references.includes(binding.id.start) || !references.includes(write.left.object.start)) continue;
      patches.push({ start: declaration.start, end: statement.end, writeStart: statement.start, fieldId, value: write.right.value,
        sourceSha256: digest(text.slice(declaration.start, statement.end)) });
    }
  });
  if (!patches.length) return undefined;
  return { sourceJavascriptSha256: digest(text), pairs: patches };
}
