import { parse } from "acorn";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";

// Preserve this lifecycle entry as evidence, never as an executable translation.
export function jqueryReadyInitializationCandidates(source = {}) {
  const text = String(source.javascript || "");
  let program;
  try { program = parse(text, { ecmaVersion: "latest" }); }
  catch { return []; }
  const bindings = buildJavaScriptBindingModel(text);
  if (!bindings.ok) return [];
  let rootScope = bindings.scopeAt(0);
  while (rootScope.parent) rootScope = rootScope.parent;
  const all = nodes(program);
  const dynamicBindings = all.filter(node => node.type === "WithStatement" ||
    ["CallExpression", "NewExpression"].includes(node.type) && node.callee.type === "Identifier" &&
    ["eval", "Function"].includes(node.callee.name));
  if (dynamicBindings.some(node => bindings.scopeAt(node.start).functionScope === rootScope)) return [];
  const declarations = new Map();
  for (const node of program.body.filter(node => node.type === "FunctionDeclaration")) {
    const name = node.id?.name;
    declarations.set(name, [...(declarations.get(name) || []), node]);
  }
  const written = new Set();
  for (const node of all) {
    if (node.type === "VariableDeclarator") names(node.id).forEach(name => written.add(name));
    if (/^(Function|ArrowFunction)/.test(node.type)) node.params.forEach(param => names(param).forEach(name => written.add(name)));
    if (["AssignmentExpression", "UpdateExpression"].includes(node.type)) {
      const target = node.left || node.argument;
      names(target).forEach(name => written.add(name));
      if (target.type === "MemberExpression" && ["window", "globalThis"].includes(target.object?.name)) {
        const key = target.computed ? target.property?.value : target.property?.name;
        written.add(typeof key === "string" ? key : "*");
      }
    }
  }
  const helper = (name, atIndex) => {
    const matches = declarations.get(name) || [];
    return matches.length === 1 && bindings.bindingAtUse(name, atIndex)?.scope === rootScope &&
      !written.has(name) && !written.has("*") &&
      !matches[0].async && !matches[0].generator && matches[0].params.length === 0
      ? matches[0] : undefined;
  };
  const isBinder = declaration => !written.has("AttachXFormValueChangeEventById") &&
    !declarations.has("AttachXFormValueChangeEventById") && nodes(declaration.body).some(node =>
      node.type === "CallExpression" && !node.optional && node.callee.type === "Identifier" &&
      node.callee.name === "AttachXFormValueChangeEventById" && bindings.isUnshadowedGlobal(node.callee.name, node.start));
  const binderNames = new Set([...declarations].filter(([, matches]) => matches.some(isBinder)).map(([name]) => name));
  const candidates = [];
  for (const statement of program.body) {
    const call = statement.type === "ExpressionStatement" && statement.expression;
    if (call?.type !== "CallExpression" || call.optional || call.callee.type !== "Identifier" ||
        !["$", "jQuery"].includes(call.callee.name) || written.has(call.callee.name) ||
        !bindings.isUnshadowedGlobal(call.callee.name, call.start) ||
        declarations.has(call.callee.name) || written.has("*") || call.arguments.length !== 1) continue;
    const callback = call.arguments[0];
    if (callback.type !== "FunctionExpression" || callback.id || callback.async || callback.generator ||
        callback.params.length || callback.body.type !== "BlockStatement") continue;
    const calls = callback.body.body.filter(node => node.type === "ExpressionStatement")
      .map(node => node.expression).filter(node => node.type === "CallExpression" && !node.optional &&
        node.callee.type === "Identifier" && node.arguments.length === 0);
    const binders = calls.filter(node => binderNames.has(node.callee.name));
    const initializers = calls.filter(node => !binderNames.has(node.callee.name));
    // An uncertain helper still executes from a real ready registration. Keep
    // the entire callback pending rather than losing it beside other events.
    if (!binderNames.size || !initializers.length) continue;
    const bindingsKnown = binders.length > 0 && !dynamicBindings.length &&
      calls.every(node => helper(node.callee.name, node.start)) &&
      callback.body.body.every(node => node.type === "EmptyStatement" ||
        node.type === "ExpressionStatement" && calls.includes(node.expression));
    candidates.push({
      id: `${source.id || "script"}.ready.${candidates.length + 1}`,
      index: call.start, event: "onLoad", scope: "global", source,
      sourceActionKey: `onLoad@${call.start}`,
      javascript: text.slice(statement.start, statement.end),
      branchSource: text, branchFunctionStart: callback.start,
      translationStatus: "needs_review",
      coverage: { status: "uncovered", nativeRules: [], residuals: [{
        code: "script.residual.jquery_ready_initialization", sourceRef: source.sourceRef,
        reason: "The complete ready callback, including registration and initialization effects, requires lifecycle review."
      }] },
      semanticHints: { jqueryReadyInitialization: {
        sourceRange: { start: statement.start, end: statement.end },
        callbackRange: { start: callback.start, end: callback.end },
        binderNames: [...new Set(binders.map(node => node.callee.name))],
        initializerNames: [...new Set(initializers.map(node => node.callee.name))],
        bindingStatus: bindingsKnown ? "source-declared" : "unproven"
      } }
    });
  }
  return candidates;
}

function names(pattern) {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "RestElement") return names(pattern.argument);
  if (pattern.type === "AssignmentPattern") return names(pattern.left);
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(names);
  if (pattern.type === "ObjectPattern") return pattern.properties.flatMap(property => names(property.value || property.argument));
  return [];
}

function nodes(root) {
  const found = [];
  function visit(node) {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;
    found.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(root);
  return found;
}
