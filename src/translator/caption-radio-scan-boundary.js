import { createHash } from "node:crypto";
import { parse } from "acorn";

// A proof-only abstraction. Original source and translated actions are never
// rewritten. Accepted scans inspect checked radio labels and assign only local
// scalar flags; they cannot observe an independently proven radio-free cell.
export function abstractRadioScans(programs, form) {
  const parsed = [];
  try {
    for (const [index, text] of programs.entries()) parsed.push({ index, text, tree: parse(text, { ecmaVersion: "latest", allowReturnOutsideFunction: true }) });
  } catch { return undefined; }
  const radios = new Set((form?.fields || []).filter(field => field?.type === "radio").map(field => field.id));
  const rewrites = [], aliases = new Set(), protectedScalars = [];
  for (const program of parsed) {
    const functions = [];
    visit(program.tree, node => { if (["FunctionExpression", "FunctionDeclaration", "ArrowFunctionExpression"].includes(node.type) && node.body?.type === "BlockStatement") functions.push(node); });
    for (const fn of functions) {
      const body = fn.body.body, locals = functionVarNames(fn), checked = [];
      for (let i = 0; i + 2 < body.length; i++) {
        const match = checkedRadioLoop(body[i], body[i + 1], body[i + 2]);
        if (match && radios.has(match.fieldId)) { checked.push(match); rewrites.push({ index: program.index, start: body[i].start, end: body[i + 2].end,
          text: `var ${match.output}=GetXFormFieldValueById(${JSON.stringify(match.fieldId)});`, kind: "checked-radio-loop", fieldId: match.fieldId }); aliases.add(match.alias); i += 2; }
      }
      if (!checked.length) continue;
      for (let i = 0; i + 2 < body.length; i++) {
        const match = globalRadioLoop(body[i], body[i + 1], body[i + 2], locals);
        if (!match) continue;
        const fieldId = checked[0].fieldId;
        const replacement = match.written.map(name => `var ${name}=GetXFormFieldValueById(${JSON.stringify(fieldId)});`).join(" ");
        rewrites.push({ index: program.index, start: body[i].start, end: body[i + 2].end, text: replacement,
          kind: "read-only-radio-label-scan", fieldId }); aliases.add(match.alias); i += 2;
        protectedScalars.push({ index: program.index, start: body[i - 2].start, end: body[i].end,
          counter: match.counter, indexName: match.index, names: match.written, fn });
      }
    }
  }
  if (!rewrites.some(item => item.kind === "read-only-radio-label-scan")) return undefined;
  // A removed implicit global must not be observed by any other source code,
  // including a different callback or a computed/global-object access.
  for (const program of parsed) {
    let unsafe = false;
    visit(program.tree, (node, parent) => {
      if (node.type === "Identifier" && aliases.has(node.name) && !rewrites.some(r => r.index === program.index && node.start >= r.start && node.end <= r.end)) unsafe = true;
      if (node.type === "Identifier" && ["eval", "Function", "globalThis"].includes(node.name)) unsafe = true;
      if (node.type === "ThisExpression" || node.type === "MemberExpression" && node.object?.type === "Identifier" &&
          ["window", "self", "top", "parent", "frames"].includes(node.object.name)) unsafe = true;
      for (const item of protectedScalars.filter(value => value.index === program.index)) {
        if (node.type !== "Identifier" || !item.names.includes(node.name) && node.name !== item.indexName ||
            node.start < item.fn.start || node.end > item.fn.end ||
            node.start >= item.start && node.end <= item.end) continue;
        if (node.name === item.indexName && rewrites.some(r => r.index === program.index && node.start >= r.start && node.end <= r.end)) continue;
        if (node.name === item.counter || node.name === item.indexName ||
            parent?.type === "VariableDeclarator" && parent.id === node ||
            parent?.type === "AssignmentExpression" && parent.left === node ||
            parent?.type === "UpdateExpression" && parent.argument === node) unsafe = true;
      }
      if (node.type === "Identifier" && node.name === "document" &&
          (parent?.type === "VariableDeclarator" && parent.id === node || parent?.type === "AssignmentExpression" && parent.left === node ||
           ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(parent?.type) && parent.params?.includes(node))) unsafe = true;
    });
    if (unsafe) return undefined;
  }
  const texts = [...programs];
  for (const program of parsed) {
    const changes = rewrites.filter(r => r.index === program.index).sort((a, b) => b.start - a.start);
    for (const change of changes) texts[program.index] = texts[program.index].slice(0, change.start) + change.text + texts[program.index].slice(change.end);
  }
  return { programs: texts, evidence: rewrites.map(({ index, start, end, kind, fieldId }) => ({
    scriptIndex: index, start, end, kind, fieldId, sourceSha256: createHash("sha256").update(programs[index]).digest("hex")
  })) };
}

function checkedRadioLoop(first, declaration, loop) {
  const assign = first?.type === "ExpressionStatement" && first.expression;
  if (assign?.type !== "AssignmentExpression" || assign.operator !== "=" || assign.left?.type !== "Identifier" ||
      assign.right?.type !== "CallExpression" || assign.right.callee?.type !== "Identifier" || assign.right.callee.name !== "GetXFormFieldById" ||
      assign.right.arguments?.length !== 1 || typeof assign.right.arguments[0]?.value !== "string") return undefined;
  const d = singleVar(declaration), alias = assign.left.name;
  if (!d || d.init?.type !== "Literal" || d.init.value !== null) return undefined;
  const index = forwardLoop(loop, alias); if (!index) return undefined;
  const body = blockBody(loop.body); if (body?.length !== 1) return undefined;
  const branch = body[0], statements = blockBody(branch?.consequent);
  if (branch?.type !== "IfStatement" || branch.alternate || !indexedMember(branch.test, alias, index, "checked") || statements?.length !== 2) return undefined;
  const update = statements[0]?.type === "ExpressionStatement" && statements[0].expression;
  if (update?.type !== "AssignmentExpression" || update.operator !== "=" || update.left?.type !== "Identifier" || update.left.name !== d.id.name ||
      !indexedMember(update.right, alias, index, "value") || statements[1]?.type !== "BreakStatement" || statements[1].label) return undefined;
  return { alias, output: d.id.name, fieldId: assign.right.arguments[0].value };
}

function globalRadioLoop(first, declaration, loop, locals) {
  const a = first?.type === "ExpressionStatement" && first.expression, d = singleVar(declaration);
  if (a?.type !== "AssignmentExpression" || a.operator !== "=" || a.left?.type !== "Identifier" ||
      a.right?.type !== "CallExpression" || a.right.callee?.type !== "MemberExpression" || a.right.callee.computed ||
      a.right.callee.object?.name !== "document" || a.right.callee.property?.name !== "getElementsByTagName" ||
      a.right.arguments?.length !== 1 || a.right.arguments[0]?.type !== "Literal" || a.right.arguments[0].value !== "input" ||
      !d || d.init?.type !== "Literal" || typeof d.init.value !== "number") return undefined;
  const alias = a.left.name, index = forwardLoop(loop, alias), body = blockBody(loop?.body);
  if (!index || body?.length !== 1) return undefined;
  const radio = body[0];
  if (radio?.type !== "IfStatement" || radio.alternate || !radioTypeGuard(radio.test, alias, index)) return undefined;
  const scalars = new Set([d.id.name, index]);
  let declarationsValid = true;
  visit(radio.consequent, node => {
    if (["FunctionExpression", "FunctionDeclaration", "ArrowFunctionExpression"].includes(node.type)) declarationsValid = false;
    if (node.type === "VariableDeclaration") for (const item of node.declarations || []) {
      if (node.kind !== "var" || item.id?.type !== "Identifier" || item.init?.type !== "Literal" || typeof item.init.value !== "number") declarationsValid = false;
      else scalars.add(item.id.name);
    }
  });
  if (!declarationsValid) return undefined;
  const written = new Set([d.id.name]);
  if (!safeScanStatements(radio.consequent, { alias, index, locals, scalars, written })) return undefined;
  return { alias, written: [...written], counter: d.id.name, index };
}

function safeScanStatements(node, scope) {
  if (!node) return true;
  if (node.type === "BlockStatement") return node.body.every(item => safeScanStatements(item, scope));
  if (node.type === "IfStatement") return safeScanExpr(node.test, scope) && safeScanStatements(node.consequent, scope) && safeScanStatements(node.alternate, scope);
  if (node.type === "VariableDeclaration") return node.kind === "var" && node.declarations.every(item => {
    if (item.id?.type !== "Identifier" || !scope.locals.has(item.id.name) || !scope.scalars.has(item.id.name) || !safeScanExpr(item.init, scope)) return false;
    scope.written.add(item.id.name); return true;
  });
  if (node.type === "ExpressionStatement") {
    const x = node.expression;
    if (x?.type === "AssignmentExpression" && x.operator === "=" && x.left?.type === "Identifier" && scope.locals.has(x.left.name) && scope.scalars.has(x.left.name) && safeScanExpr(x.right, scope)) {
      scope.written.add(x.left.name); return true;
    }
    if (x?.type === "UpdateExpression" && ["++", "--"].includes(x.operator) && x.argument?.type === "Identifier" && scope.locals.has(x.argument.name) && scope.scalars.has(x.argument.name)) {
      scope.written.add(x.argument.name); return true;
    }
    return false;
  }
  return node.type === "BreakStatement" && !node.label || node.type === "EmptyStatement";
}

function safeScanExpr(node, scope) {
  if (!node) return true;
  if (node.type === "Literal") return !node.regex && ["string", "number", "boolean"].includes(typeof node.value) || node.value === null;
  if (node.type === "Identifier") return scope.scalars.has(node.name) && node.name !== scope.alias;
  if (node.type === "UnaryExpression") return ["!", "+", "-"].includes(node.operator) && safeScanExpr(node.argument, scope);
  if (node.type === "BinaryExpression" || node.type === "LogicalExpression") return (
    ["==", "!=", "===", "!==", "<", "<=", ">", ">=", "+", "-", "&&", "||"].includes(node.operator) &&
    safeScanExpr(node.left, scope) && safeScanExpr(node.right, scope)
  );
  if (node.type !== "CallExpression" || node.optional || node.arguments?.length !== 1 || node.arguments[0]?.type !== "Literal" || typeof node.arguments[0].value !== "string") return false;
  if (node.callee?.type !== "MemberExpression" || node.callee.computed) return false;
  if (node.callee.property?.name === "getAttribute") return indexedNode(node.callee.object, scope.alias, scope.index) && ["type", "checked"].includes(node.arguments[0].value);
  const html = node.callee.object;
  return node.callee.property?.name === "indexOf" && html?.type === "MemberExpression" && !html.computed && html.property?.name === "innerHTML" &&
    html.object?.type === "MemberExpression" && !html.object.computed && html.object.property?.name === "parentNode" && indexedNode(html.object.object, scope.alias, scope.index);
}

function radioTypeGuard(node, alias, index) {
  if (node?.type !== "BinaryExpression" || !["==", "==="].includes(node.operator)) return false;
  const test = node.left?.type === "CallExpression" ? node.left : node.right, value = test === node.left ? node.right : node.left;
  return value?.type === "Literal" && value.value === "radio" && test?.callee?.type === "MemberExpression" && !test.callee.computed &&
    test.callee.property?.name === "getAttribute" && indexedNode(test.callee.object, alias, index) && test.arguments?.length === 1 &&
    test.arguments[0]?.type === "Literal" && test.arguments[0].value === "type";
}
function forwardLoop(loop, alias) {
  const d = singleVar(loop?.init), test = loop?.test, update = loop?.update;
  if (loop?.type !== "ForStatement" || !d || d.init?.type !== "Literal" || d.init.value !== 0 ||
      test?.type !== "BinaryExpression" || test.operator !== "<" || test.left?.type !== "Identifier" || test.left.name !== d.id.name ||
      test.right?.type !== "MemberExpression" || test.right.computed || test.right.object?.name !== alias || test.right.property?.name !== "length" ||
      update?.type !== "UpdateExpression" || update.operator !== "++" || update.argument?.name !== d.id.name) return undefined;
  return d.id.name;
}
function indexedNode(node, alias, index) { return node?.type === "MemberExpression" && node.computed && node.object?.name === alias && node.property?.type === "Identifier" && node.property.name === index; }
function indexedMember(node, alias, index, property) { return node?.type === "MemberExpression" && !node.computed && node.property?.name === property && indexedNode(node.object, alias, index); }
function singleVar(node) { return node?.type === "VariableDeclaration" && node.kind === "var" && node.declarations?.length === 1 && node.declarations[0].id?.type === "Identifier" ? node.declarations[0] : undefined; }
function blockBody(node) { return node?.type === "BlockStatement" ? node.body : undefined; }
function functionVarNames(fn) {
  const names = new Set();
  const walk = node => {
    if (!node || typeof node !== "object") return;
    if (node !== fn && ["FunctionExpression", "FunctionDeclaration", "ArrowFunctionExpression"].includes(node.type)) return;
    if (node.type === "VariableDeclaration" && node.kind === "var") for (const item of node.declarations) if (item.id?.type === "Identifier") names.add(item.id.name);
    for (const v of Object.values(node)) if (v && typeof v === "object") Array.isArray(v) ? v.forEach(walk) : walk(v);
  };
  walk(fn.body); return names;
}
function visit(node, callback, parent) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") callback(node, parent);
  for (const value of Object.values(node)) if (value && typeof value === "object") Array.isArray(value) ? value.forEach(child => visit(child, callback, node)) : visit(value, callback, node);
}
