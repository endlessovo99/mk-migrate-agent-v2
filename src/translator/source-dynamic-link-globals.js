import {parse} from 'acorn';

export function stableSourceGlobals(source, allowAnchor = false) {
  let valid = true;
  const neverReference = new Set(['Object', 'Reflect', 'globalThis', 'self', 'top', 'parent', 'frames', 'MKXFORM']);
  const callable = new Set(['GetXFormFieldById', 'Com_AddEventListener', 'String']);
  const calls = new Set(['GetXFormFieldById', 'Com_AddEventListener', 'AttachXFormValueChangeEventById', 'common_dom_row_set_show_required_reset']);
  function walk(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (['ThisExpression', 'Super', 'NewExpression', 'ImportExpression', 'TaggedTemplateExpression', 'AwaitExpression', 'YieldExpression'].includes(node.type)) valid = false;
    if (['FunctionExpression', 'FunctionDeclaration', 'ArrowFunctionExpression'].includes(node.type) && (node.async || node.generator)) valid = false;
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      const selectedAnchorLookup = allowAnchor && callee?.type === 'MemberExpression' &&
        !callee.computed && callee.object?.name === 'document' && callee.property?.name === 'getElementById';
      if (!(callee?.type === 'Identifier' && calls.has(callee.name)) && !selectedAnchorLookup) valid = false;
    }
    if (['AssignmentExpression', 'UpdateExpression'].includes(node.type)) {
      const target = node.left || node.argument;
      if (target?.type === 'MemberExpression' && (target.computed || ['id', 'outerHTML', 'innerHTML'].includes(target.property?.name)) &&
          !(allowAnchor && !target.computed && target.property?.name === 'innerHTML')) valid = false;
    }
    if (node.type === 'Identifier') {
      const isProperty = parent?.type === 'MemberExpression' && parent.property === node && !parent.computed;
      const isObjectKey = parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand;
      if (!isProperty && !isObjectKey) {
        if (neverReference.has(node.name)) valid = false;
        if (callable.has(node.name) && !(parent?.type === 'CallExpression' && parent.callee === node)) valid = false;
        if (node.name === 'window' && !(parent?.type === 'CallExpression' && parent.callee?.name === 'Com_AddEventListener' && parent.arguments?.[0] === node)) valid = false;
        if (node.name === 'document' && !(allowAnchor && parent?.type === 'MemberExpression' && parent.object === node && !parent.computed && parent.property?.name === 'getElementById')) valid = false;
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => walk(child, node));
      else if (value && typeof value === 'object') walk(value, node);
    }
  }
  try { walk(parse(String(source || ''), {ecmaVersion:'latest'})); } catch { return false; }
  return valid;
}
