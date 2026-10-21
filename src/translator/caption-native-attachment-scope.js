import { parse } from "acorn";
import { isUnconditionalAttachmentRequirement } from "./attachment-non-empty.js";

// Reuse the complete native-required recognizer. No loop, global attachment
// handle or unknown submit callback gains a general interpreter exemption.
export function captionNativeAttachmentScope(text, form, originals, programs) {
  const matches = (form.fields || []).filter(field => field.componentId === "xform-attach" &&
    originals.filter(source => source.id === field.id).length === 1 &&
    originals.some(source => source.id === field.id && source.sourceType === "attachment" &&
      (!source.sourceProps?.designerId || source.sourceProps.designerId === field.id)) &&
    isUnconditionalAttachmentRequirement(text, field.id));
  if (matches.length !== 1) return undefined;
  const id = matches[0].id;
  const bindings = new Set([`attachmentObject_${id}`, "Attachment_ObjectInfo", "Com_Parameter", "alert"]);
  let shadowed = false;
  for (const program of programs) {
    let tree;
    try { tree = parse(program, { ecmaVersion: "latest", allowReturnOutsideFunction: true }); } catch { return undefined; }
    walk(tree, node => {
      if (["VariableDeclarator", "FunctionDeclaration", "FunctionExpression", "ClassDeclaration"].includes(node.type) && bindings.has(node.id?.name) ||
          node.params?.some(parameter => bindings.has(parameter.name)) ||
          ["AssignmentExpression", "UpdateExpression"].includes(node.type) && bindings.has((node.left || node.argument)?.name)) shadowed = true;
    });
  }
  return shadowed ? undefined : { targets: [], dataTargets: [id], parentReads: [],
    attachmentBindings: [{ fieldId: id, basis: "complete-active-file-submit-guard" }] };
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) if (value && typeof value === "object")
    Array.isArray(value) ? value.forEach(child => walk(child, visit)) : walk(value, visit);
}
