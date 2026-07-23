import { parse } from "acorn";

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression"
]);
const LOOP_TYPES = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement"
]);

export function buildJavaScriptBindingModel(source, {
  eventParameter,
  eventFunctionName,
  eventFunctionStart,
  event,
  programIsEntrypoint = false
} = {}) {
  const text = String(source || "");
  let ast;
  try {
    ast = parse(text, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowHashBang: true
    });
  } catch (error) {
    return {
      ok: false,
      reason: "javascript_parse_failed",
      error: String(error?.message || error)
    };
  }

  const structure = buildScopeStructure(ast, text.length);
  let nextBindingId = 1;
  const functionNodes = [];
  const callNodes = [];
  const bindingAt = (scope, name, kind) => {
    const existing = scope.bindings.get(name);
    if (existing) {
      existing.ambiguous = true;
      existing.kinds.add(kind);
      return existing;
    }
    const binding = {
      id: nextBindingId++,
      name,
      scope,
      kinds: new Set([kind]),
      declarations: [],
      effects: [],
      aliases: new Set(),
      ambiguous: false
    };
    scope.bindings.set(name, binding);
    return binding;
  };

  walkAst(ast, (node) => {
    const scope = structure.scopeFor(node);
    if (FUNCTION_TYPES.has(node.type)) {
      functionNodes.push(node);
      for (const identifier of patternIdentifiers(node.params)) {
        bindingAt(scope, identifier.name, "parameter");
      }
      if (node.id?.name) {
        const nameScope = node.type === "FunctionDeclaration" ? scope.parent : scope;
        if (nameScope) bindingAt(nameScope, node.id.name, "function");
      }
      return;
    }
    if (node.type === "CallExpression") callNodes.push(node);
    if (node.type === "VariableDeclaration") {
      for (const declarator of node.declarations) {
        const identifiers = patternIdentifiers([declarator.id]);
        for (const identifier of identifiers) {
          const declarationScope = node.kind === "var" ? scope.functionScope : scope;
          const binding = bindingAt(declarationScope, identifier.name, node.kind);
          const simple = declarator.id.type === "Identifier" && identifiers.length === 1;
          binding.declarations.push({
            index: identifier.start,
            expression: simple && declarator.init
              ? text.slice(declarator.init.start, declarator.init.end)
              : undefined,
            expressionIndex: simple && declarator.init ? declarator.init.start : identifier.start,
            lexicalScope: scope,
            controlFlowUnproven: controlledDeclaration(node, structure.parentFor)
          });
        }
      }
      return;
    }
    if (node.type === "CatchClause") {
      for (const identifier of patternIdentifiers([node.param])) {
        bindingAt(scope, identifier.name, "catch-parameter");
      }
    }
    if (node.type === "ClassDeclaration" && node.id?.name) {
      bindingAt(scope, node.id.name, "class");
    }
  });

  let eventBinding;
  let eventFunction;
  if (identifierName(eventParameter)) {
    eventBinding = bindingAt(structure.root, eventParameter, "event-parameter");
  } else {
    eventFunction = findEventFunction(
      functionNodes,
      callNodes,
      structure,
      eventFunctionName,
      eventFunctionStart,
      event
    );
    const parameter = eventFunction?.params?.[0];
    if (parameter?.type === "Identifier") {
      eventBinding = structure.scopeFor(eventFunction).bindings.get(parameter.name);
    }
  }

  const bindingForIdentifier = (identifier) => visibleBinding(
    structure.scopeFor(identifier),
    identifier.name
  );
  const addEffect = (binding, node, kind, index = node.start) => {
    if (!binding) return;
    binding.effects.push({ index, scope: structure.scopeFor(node), kind });
  };
  const addEscapes = (values, node, index = node.end) => {
    for (const identifier of referencedIdentifiers(values)) {
      const binding = bindingForIdentifier(identifier);
      const identifierFunction = structure.scopeFor(identifier).functionScope;
      if (
        identifierFunction !== structure.scopeFor(node).functionScope &&
        binding?.scope?.functionScope === identifierFunction
      ) continue;
      addEffect(binding, node, "escape", index);
    }
  };

  walkAst(ast, (node) => {
    if (node.type === "AssignmentExpression") {
      for (const target of assignmentTargets(node.left)) {
        addEffect(bindingForIdentifier(target.identifier), node, target.kind);
      }
      if (!legacyFieldValueSink(node.left, bindingForIdentifier, text)) {
        addEscapes(node.right, node);
      }
      return;
    }
    if (node.type === "UpdateExpression") {
      for (const target of assignmentTargets(node.argument)) {
        addEffect(bindingForIdentifier(target.identifier), node, target.kind);
      }
      return;
    }
    if (node.type === "UnaryExpression" && node.operator === "delete") {
      for (const target of assignmentTargets(node.argument)) {
        addEffect(bindingForIdentifier(target.identifier), node, "mutation");
      }
      return;
    }
    if (["ForInStatement", "ForOfStatement"].includes(node.type)) {
      for (const target of assignmentTargets(node.left)) {
        addEffect(bindingForIdentifier(target.identifier), node, target.kind);
      }
    }
    if (
      node.type === "VariableDeclarator" &&
      ["ObjectExpression", "ArrayExpression", "FunctionExpression", "ArrowFunctionExpression"].includes(node.init?.type)
    ) {
      addEscapes(node.init, node);
    }
    if (["ReturnStatement", "YieldExpression", "ThrowStatement"].includes(node.type) && node.argument) {
      addEscapes(node.argument, node);
    }
    if (
      (node.type === "CallExpression" || node.type === "NewExpression") &&
      !knownPureCall(node, (name) => !visibleBinding(structure.scopeFor(node), name))
    ) {
      const values = [
        ...(node.arguments || []),
        ...(node.type === "CallExpression" && node.callee?.type === "MemberExpression"
          ? [node.callee.object]
          : [])
      ];
      addEscapes(values, node);
    }
    if (node.type === "TaggedTemplateExpression") {
      addEscapes(node.quasi?.expressions || [], node);
    }
  });

  connectDirectAliases(ast, structure, text);

  const bindingAtUse = (name, beforeIndex) => {
    if (!identifierName(name) || !Number.isInteger(beforeIndex)) return undefined;
    return visibleBinding(structure.scopeAt(beforeIndex), name);
  };
  const stableInitializer = (name, { beforeIndex, sameFunction = false } = {}) => {
    const useScope = structure.scopeAt(beforeIndex);
    const binding = bindingAtUse(name, beforeIndex);
    if (!binding || binding.ambiguous || binding.declarations.length !== 1) return undefined;
    const declaration = binding.declarations[0];
    if (
      declaration.expression === undefined ||
      declaration.index >= beforeIndex ||
      declaration.controlFlowUnproven ||
      !isScopeAncestor(declaration.lexicalScope, useScope) ||
      (sameFunction && declaration.lexicalScope.functionScope !== useScope.functionScope) ||
      hasAffectingEffect(binding, useScope, declaration.expressionIndex, beforeIndex)
    ) return undefined;
    return { ...declaration, binding };
  };
  const stableEventUse = (binding, useScope, beforeIndex) => (
    binding === eventBinding &&
    !binding.ambiguous &&
    binding.declarations.length === 0 &&
    // Direct event-parameter reads stay stable when only an alias was passed into an
    // unknown helper. Alias mutation/write and escapes of the parameter itself still fail closed.
    !hasAffectingEffect(binding, useScope, binding.scope.start, beforeIndex, {
      ignoreAliasEscape: true
    })
  );

  return {
    ok: true,
    eventBinding,
    entrypoint: eventFunction
      ? {
          type: "function",
          start: eventFunction.start,
          end: eventFunction.end,
          bodyStart: eventFunction.body?.start,
          bodyEnd: eventFunction.body?.end
        }
      : identifierName(eventParameter) || programIsEntrypoint === true
        ? {
            type: "program",
            start: ast.start,
            end: ast.end,
            bodyStart: ast.start,
            bodyEnd: ast.end
          }
        : undefined,
    scopeAt: structure.scopeAt,
    bindingAtUse,
    isUnshadowedGlobal: (name, beforeIndex) => !bindingAtUse(name, beforeIndex),
    stableInitializer,
    stableEventUse
  };

  function connectDirectAliases(root) {
    walkAst(root, (node) => {
      if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") return;
      const sourceIdentifier = directAliasIdentifier(node.init);
      if (!sourceIdentifier) return;
      const target = visibleBinding(structure.scopeFor(node.id), node.id.name);
      const origin = visibleBinding(structure.scopeFor(sourceIdentifier), sourceIdentifier.name);
      if (!target || !origin || target === origin) return;
      target.aliases.add(origin);
      origin.aliases.add(target);
    });
  }
}

function buildScopeStructure(ast, textLength) {
  const root = newScope({ kind: "program", start: -1, end: textLength + 1 });
  const scopes = [root];
  const nodeScopes = new WeakMap();
  const parents = new WeakMap();
  let nextScopeId = 1;

  const visit = (node, current, parent, functionBody = false) => {
    if (!isNode(node)) return;
    if (parent) parents.set(node, parent);
    let scope = current;
    if (FUNCTION_TYPES.has(node.type)) {
      scope = newScope({
        id: nextScopeId++,
        kind: "function",
        start: node.start,
        end: node.end,
        parent: current
      });
      scopes.push(scope);
    } else if (createsLexicalScope(node, functionBody)) {
      scope = newScope({
        id: nextScopeId++,
        kind: "block",
        start: node.start,
        end: node.end,
        parent: current
      });
      scopes.push(scope);
    }
    nodeScopes.set(node, scope);
    for (const child of childNodes(node)) {
      visit(child, scope, node, FUNCTION_TYPES.has(node.type) && child === node.body);
    }
  };
  visit(ast, root, undefined);

  const scopeAt = (index) => {
    let selected = root;
    for (const scope of scopes) {
      if (scope.start <= index && index < scope.end && scope.depth >= selected.depth) {
        selected = scope;
      }
    }
    return selected;
  };
  return {
    root,
    parentFor: (node) => parents.get(node),
    scopeFor: (node) => nodeScopes.get(node) || scopeAt(node?.start || 0),
    scopeAt
  };
}

function newScope({ id = 0, kind, start, end, parent }) {
  const scope = {
    id,
    kind,
    start,
    end,
    parent,
    bindings: new Map(),
    depth: parent ? parent.depth + 1 : 0
  };
  scope.functionScope = kind === "function" ? scope : (parent?.functionScope || scope);
  return scope;
}

function createsLexicalScope(node, functionBody) {
  if (functionBody) return false;
  return node.type === "BlockStatement" ||
    node.type === "CatchClause" ||
    node.type === "SwitchStatement" ||
    LOOP_TYPES.has(node.type);
}

function controlledDeclaration(node, parentFor) {
  for (let current = parentFor(node); current; current = parentFor(current)) {
    if (FUNCTION_TYPES.has(current.type)) return false;
    if (
      current.type === "IfStatement" ||
      current.type === "ConditionalExpression" ||
      current.type === "SwitchCase" ||
      LOOP_TYPES.has(current.type)
    ) return true;
  }
  return false;
}

function findEventFunction(
  functionNodes,
  callNodes,
  structure,
  eventFunctionName,
  eventFunctionStart,
  event
) {
  if (Number.isInteger(eventFunctionStart) && eventFunctionStart >= 0) {
    const exact = functionNodes.filter((node) => node.start === eventFunctionStart);
    return exact.length === 1 ? exact[0] : undefined;
  }
  if (identifierName(eventFunctionName)) {
    const explicit = functionNodes.filter((node) => (
      node.type === "FunctionDeclaration" &&
      node.id?.name === eventFunctionName &&
      structure.scopeFor(node).parent === structure.root
    ));
    return explicit.length === 1 ? explicit[0] : undefined;
  }
  const expectedName = event === "onLoad" ? "onLoad" : "onChange";
  const named = functionNodes.filter((node) => (
    node.type === "FunctionDeclaration" &&
    node.id?.name === expectedName &&
    structure.scopeFor(node).parent === structure.root
  ));
  if (named.length === 1) return named[0];
  if (named.length > 1) return undefined;
  if (event === "onLoad") {
    const attached = callNodes
      .filter((node) => (
        node.callee?.type === "Identifier" &&
        node.callee.name === "Com_AddEventListener" &&
        !visibleBinding(structure.scopeFor(node.callee), node.callee.name) &&
        node.arguments?.[0]?.type === "Identifier" &&
        node.arguments[0].name === "window" &&
        !visibleBinding(structure.scopeFor(node.arguments[0]), "window") &&
        staticStringValue(node.arguments?.[1]) === "load"
      ))
      .map((node) => node.arguments?.[2])
      .filter((node) => FUNCTION_TYPES.has(node?.type));
    return attached.length === 1 ? attached[0] : undefined;
  }
  const attached = callNodes
    .filter((node) => (
      node.callee?.type === "Identifier" &&
      node.callee.name === "AttachXFormValueChangeEventById" &&
      !visibleBinding(structure.scopeFor(node.callee), node.callee.name) &&
      staticStringArgument(node.arguments?.[0])
    ))
    .map((node) => node.arguments?.[1])
    .filter((node) => FUNCTION_TYPES.has(node?.type));
  return attached.length === 1 ? attached[0] : undefined;
}

function staticStringArgument(node) {
  return (node?.type === "Literal" && typeof node.value === "string") ||
    (node?.type === "TemplateLiteral" && node.expressions.length === 0);
}

function staticStringValue(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis?.[0]?.value?.cooked;
  }
  return undefined;
}

function directAliasIdentifier(node) {
  let current = node;
  while (current?.type === "ChainExpression" || current?.type === "ParenthesizedExpression") {
    current = current.expression;
  }
  if (current?.type === "Identifier") return current;
  if (current?.type === "MemberExpression") return memberRootIdentifier(current);
  if (
    current?.type === "LogicalExpression" &&
    current.operator === "||" &&
    emptyStringLiteral(current.right)
  ) return directAliasIdentifier(current.left);
  if (arrayFirstConditional(current)) return directAliasIdentifier(current.alternate);
  return undefined;
}

function arrayFirstConditional(node) {
  if (node?.type !== "ConditionalExpression") return false;
  const tested = node.test;
  if (
    tested?.type !== "CallExpression" ||
    tested.callee?.type !== "MemberExpression" ||
    tested.callee.computed ||
    tested.callee.object?.type !== "Identifier" ||
    tested.callee.object.name !== "Array" ||
    tested.callee.property?.name !== "isArray" ||
    tested.arguments?.length !== 1 ||
    tested.arguments[0]?.type !== "Identifier"
  ) return false;
  const name = tested.arguments[0].name;
  return memberRootIdentifier(node.consequent)?.name === name &&
    node.alternate?.type === "Identifier" && node.alternate.name === name;
}

function emptyStringLiteral(node) {
  return node?.type === "Literal" && node.value === "";
}

function assignmentTargets(node) {
  if (!node) return [];
  if (node.type === "Identifier") return [{ identifier: node, kind: "write" }];
  if (node.type === "MemberExpression") {
    const root = memberRootIdentifier(node);
    return root ? [{ identifier: root, kind: "mutation" }] : [];
  }
  if (node.type === "RestElement") return assignmentTargets(node.argument);
  if (node.type === "AssignmentPattern") return assignmentTargets(node.left);
  if (node.type === "ArrayPattern") return node.elements.flatMap(assignmentTargets);
  if (node.type === "ObjectPattern") {
    return node.properties.flatMap((property) => (
      property.type === "RestElement" ? assignmentTargets(property.argument) : assignmentTargets(property.value)
    ));
  }
  return [];
}

function memberRootIdentifier(node) {
  let current = node;
  while (current?.type === "MemberExpression") current = current.object;
  while (current?.type === "ChainExpression") current = current.expression;
  return current?.type === "Identifier" ? current : undefined;
}

function legacyFieldValueSink(node, bindingForIdentifier, source) {
  if (
    node?.type !== "MemberExpression" ||
    node.computed ||
    node.property?.type !== "Identifier" ||
    node.property.name !== "value"
  ) return false;
  const root = memberRootIdentifier(node);
  if (!root) {
    return /^GetXFormField(?:Value)?ById\(\s*(["'`])[^"'`]+\1\s*\)\s*\[\s*0\s*\]\s*\.\s*value$/.test(
      source.slice(node.start, node.end)
    );
  }
  const binding = bindingForIdentifier(root);
  if (!binding || binding.ambiguous || binding.declarations.length !== 1) return false;
  const expression = binding.declarations[0].expression || "";
  return /^GetXFormField(?:Value)?ById\(\s*(["'`])[^"'`]+\1\s*\)\s*(?:\[\s*0\s*\])?$/.test(expression);
}

function knownPureCall(node, isUnshadowedGlobal) {
  if (node.type !== "CallExpression") return false;
  if (
    node.callee?.type === "Identifier" &&
    node.callee.name === "String" &&
    isUnshadowedGlobal("String")
  ) return true;
  if (
    node.callee?.type === "Identifier" &&
    node.callee.name === "SetXFormFieldValueById" &&
    isUnshadowedGlobal("SetXFormFieldValueById")
  ) return true;
  if (
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === "Array" &&
    node.callee.property?.name === "isArray" &&
    isUnshadowedGlobal("Array")
  ) return true;
  if (node.callee?.type !== "MemberExpression" || node.callee.computed) return false;
  const method = node.callee.property?.name;
  if (
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === "console" &&
    isUnshadowedGlobal("console") &&
    ["debug", "info", "log", "warn", "error"].includes(method)
  ) return true;
  if (
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === "MKXFORM" &&
    isUnshadowedGlobal("MKXFORM") &&
    [
      "getValue",
      "setValue",
      "setFieldAttr",
      "setDetailFieldAttr",
      "setDetailFieldItemAttr",
      "updateControl",
      "updateControlStyle"
    ].includes(method)
  ) return true;
  if (["indexOf", "includes"].includes(method)) return true;
  return method === "test" && node.callee.object?.type === "Literal" && node.callee.object.regex;
}

function referencedIdentifiers(values) {
  const result = [];
  const visit = (node, parent, key) => {
    if (!isNode(node)) return;
    if (node.type === "Identifier") {
      if (!isNonReferenceIdentifier(node, parent, key)) result.push(node);
      return;
    }
    for (const [childKey, child] of childNodeEntries(node)) visit(child, node, childKey);
  };
  for (const value of Array.isArray(values) ? values : [values]) visit(value);
  return result;
}

function isNonReferenceIdentifier(node, parent, key) {
  return (parent?.type === "MemberExpression" && key === "property" && !parent.computed) ||
    (parent?.type === "Property" && key === "key" && !parent.computed && !parent.shorthand) ||
    (parent?.type === "MethodDefinition" && key === "key" && !parent.computed) ||
    (parent?.type === "LabeledStatement" && key === "label");
}

function patternIdentifiers(patterns) {
  const result = [];
  const visit = (node) => {
    if (!node) return;
    if (node.type === "Identifier") result.push(node);
    else if (node.type === "RestElement") visit(node.argument);
    else if (node.type === "AssignmentPattern") visit(node.left);
    else if (node.type === "ArrayPattern") node.elements.forEach(visit);
    else if (node.type === "ObjectPattern") {
      node.properties.forEach((property) => visit(
        property.type === "RestElement" ? property.argument : property.value
      ));
    }
  };
  patterns.filter(Boolean).forEach(visit);
  return result;
}

function visibleBinding(scope, name) {
  for (let current = scope; current; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding) return binding;
  }
  return undefined;
}

function hasAffectingEffect(binding, useScope, startIndex, beforeIndex, options = {}) {
  const connected = aliasClosure(binding);
  return [...connected].some((candidate) => candidate.effects.some((effect) => {
    if (candidate !== binding && !["mutation", "escape"].includes(effect.kind)) return false;
    if (
      options.ignoreAliasEscape === true &&
      candidate !== binding &&
      effect.kind === "escape"
    ) {
      return false;
    }
    if (effect.scope.functionScope !== useScope.functionScope) return true;
    return effect.index > startIndex && effect.index < beforeIndex;
  }));
}

function aliasClosure(binding) {
  const seen = new Set([binding]);
  const pending = [binding];
  while (pending.length) {
    const current = pending.pop();
    for (const alias of current.aliases) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      pending.push(alias);
    }
  }
  return seen;
}

function isScopeAncestor(ancestor, scope) {
  for (let current = scope; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function identifierName(value) {
  return typeof value === "string" && /^[A-Za-z_$][\w$]*$/.test(value);
}

function walkAst(root, enter) {
  const visit = (node) => {
    if (!isNode(node)) return;
    enter(node);
    for (const child of childNodes(node)) visit(child);
  };
  visit(root);
}

function childNodes(node) {
  return childNodeEntries(node).map(([, child]) => child);
}

function childNodeEntries(node) {
  const result = [];
  for (const [key, value] of Object.entries(node || {})) {
    if (["start", "end", "loc", "range", "raw", "regex"].includes(key)) continue;
    if (isNode(value)) result.push([key, value]);
    else if (Array.isArray(value)) {
      for (const entry of value) if (isNode(entry)) result.push([key, entry]);
    }
  }
  return result;
}

function isNode(value) {
  return Boolean(value && typeof value === "object" && typeof value.type === "string");
}
