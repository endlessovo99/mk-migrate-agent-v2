import { parse } from "acorn";

// Shared with the existing lifecycle mapper. This complete source algorithm
// returns field data/selected option text, never a DOM handle or label text.
export const SOURCE_FORM_VALUE_READER = `function getFormFieldValue(elementId, type, containSelectText) {
    if (type == 'radio') {
        return $('input[name="extendDataFormInfo.value(' + elementId + ')"]:checked').val();
    } else if (type == 'select') {
        return $('select[name="extendDataFormInfo.value(' + elementId + ')"]').val();
    } else if (type == 'table') {
        var doms = $('[name="' + elementId + '"]');
        if (doms && doms.length > 0) {
            if (doms[0].type == 'radio') {
                return $('[name="' + elementId + '"]:checked').val();
            } else if (doms[0].tagName === 'SELECT' && containSelectText) {
                var field = $('[name="' + elementId + '"]');
                var text = field.find("option:selected").text();
                var val = field.val();
                return ((text ? text : '') + "|" + (val ? val : ''));
            }
        }
        return $('[name="' + elementId + '"]').val();
    } else {
        var elementVal = $('[name="' + elementId + '"]').val();
        if (elementVal) {
            return elementVal;
        }
        var elementVal = GetXFormFieldValueById(elementId);
        return elementVal && elementVal.length == 1 ? elementVal[0] : elementVal;
    }
}`;

const expected = parse(SOURCE_FORM_VALUE_READER, { ecmaVersion: "latest" }).body[0];
const variables = fn => { const result = []; walk(fn.body, node => { if (node.type === "VariableDeclarator") result.push(node.id); }); return result; };
const normalize = (value, names, parent) => {
  if (Array.isArray(value)) return value.map(child => normalize(child, names, parent));
  if (!value || typeof value !== "object") return value;
  const result = Object.fromEntries(Object.entries(value).filter(([key]) => !["start", "end", "raw"].includes(key))
    .map(([key, child]) => [key, normalize(child, names, value)]));
  if (value.type === "Identifier" && names.has(value.name) &&
      !(parent?.type === "MemberExpression" && parent.property === value && !parent.computed)) result.name = names.get(value.name);
  return result;
};

export function sourceFormValueReader(node, reserved = new Set()) {
  return sourceFunctionShape(node, expected, reserved);
}

export function sourceFunctionShape(node, reference, reserved = new Set(), aliases = []) {
  if (node?.type !== "FunctionDeclaration" || node.async || node.generator || node.params.length !== reference.params.length ||
      node.params.some(param => param.type !== "Identifier")) return false;
  const expectedVariables = variables(reference);
  const actualVariables = variables(node);
  if (actualVariables.length !== expectedVariables.length || actualVariables.some(id => id.type !== "Identifier")) return false;
  const names = new Map(), inverse = new Map();
  const bindings = [...node.params.map((id, index) => [id.name, reference.params[index].name]),
    ...actualVariables.map((id, index) => [id.name, expectedVariables[index].name])];
  for (const [actual, target] of bindings) {
    if (reserved.has(actual) || ["arguments", "undefined", "eval", "Function"].includes(actual) ||
        names.has(actual) && names.get(actual) !== target || inverse.has(target) && inverse.get(target) !== actual) return false;
    names.set(actual, target); inverse.set(target, actual);
  }
  for (const [actual, target] of aliases) {
    if (names.has(actual) && names.get(actual) !== target || inverse.has(target) && inverse.get(target) !== actual) return false;
    names.set(actual, target); inverse.set(target, actual);
  }
  const actual = normalize(node, names), shape = normalize(reference, new Map());
  actual.id = shape.id; // Function identity is checked by the caller's binding model.
  return JSON.stringify(actual) === JSON.stringify(shape);
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) if (value && typeof value === "object")
    Array.isArray(value) ? value.forEach(child => walk(child, visit)) : walk(value, visit);
}
