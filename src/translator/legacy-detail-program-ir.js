import { parse } from "acorn";

// This is a syntax/effect inventory, not a source-DOM ownership proof or an
// authorization to migrate. The adapter must independently bind every handle
// and every requested operation to the verified source/target domain.
const GLOBAL_CALLS = new Set([
  "AttachXFormValueChangeEventById", "Com_AddEventListener", "GetXFormFieldById",
  "common_dom_row_set_show_required_reset", "__xformDispatch", "DocList_AddRow",
  "DocList_DeleteRow_ClearLast", "DocList_MoveRow", "XFom_RestValidationElements"
]);
const READS = new Set(["rows", "length", "value", "name", "checked", "style", "display", "parentNode", "nextSibling", "innerHTML"]);
const METHODS = new Set(["getElementById", "getElementsByName", "getElementsByTagName", "getAttribute", "setAttribute", "indexOf", "join"]);
const ATTRIBUTES = new Set(["src", "type", "checked", "validate", "placeholder", "onclick"]);
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor", "eval", "Function", "globalThis", "window", "document", "process", "require", "import", "fetch", "XMLHttpRequest", "location", "navigator", "self", "top", "parent"]);
const BINARY = new Set(["+", "-", "==", "!=", "===", "!==", "<", "<=", ">", ">="]);
const VERSION = "legacy-detail-program-ir/v1";
function fail(message) { throw new Error(`Legacy detail IR: ${message}`); }
function identifier(name) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name) || FORBIDDEN.has(name) || GLOBAL_CALLS.has(name)) fail(`forbidden binding ${name}`);
  return name;
}
function walk(node, visit, descendFunctions = true) {
  if (!node || typeof node !== "object") return;
  visit(node);
  if (!descendFunctions && ["FunctionDeclaration", "FunctionExpression"].includes(node.type)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "type") continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, descendFunctions));
    else if (value && typeof value === "object") walk(value, visit, descendFunctions);
  }
}
function declarations(body) {
  const names = new Set(), functions = [];
  for (const statement of body) {
    if (statement.type === "FunctionDeclaration") {
      names.add(identifier(statement.id?.name));
      functions.push(statement);
    } else {
      walk(statement, node => {
        if (node.type === "FunctionDeclaration") fail("block function declarations are outside the supported semantics");
        if (node.type === "VariableDeclaration") {
          if (node.kind !== "var") fail("only function-scoped var declarations are supported");
          for (const declaration of node.declarations) {
            if (declaration.id.type !== "Identifier") fail("destructuring is unsupported");
            names.add(identifier(declaration.id.name));
          }
        }
      }, false);
    }
  }
  return { names, functions };
}

export function compileLegacyDetailProgramIR(scripts) {
  if (!Array.isArray(scripts) || !scripts.length) fail("nonempty ordered scripts are required");
  const parsed = scripts.map((script, index) => {
    if (!script || typeof script.source !== "string" || script.source.length > 250000 ||
      (script.gate != null && (typeof script.gate !== "string" || !script.gate.length))) fail(`invalid script ${index}`);
    const ast = parse(script.source, { ecmaVersion: 2020, sourceType: "script" });
    walk(ast, node => {
      if (node.type === "ExpressionStatement" && node.directive === "use strict") {
        fail("strict-mode directives require a separate execution contract");
      }
    });
    return { ...script, ast };
  });
  const globals = new Set(), implicitGlobals = new Set();
  for (const script of parsed) for (const name of declarations(script.ast.body).names) globals.add(name);
  // Legacy scripts use a small number of implicit globals. They remain in this
  // private interpreter environment; they never become ambient JS properties.
  function findImplicit(body, outer) {
    const locals = new Set([...outer, ...declarations(body).names]);
    for (const node of body) walk(node, current => {
      if (["FunctionExpression", "FunctionDeclaration"].includes(current.type)) {
        const params = current.params.map(param => {
          if (param.type !== "Identifier") fail("unsupported parameter");
          return identifier(param.name);
        });
        findImplicit(current.body.body, new Set([...locals, ...params]));
      } else if (current.type === "AssignmentExpression" && current.left.type === "Identifier" && !locals.has(current.left.name)) {
        implicitGlobals.add(identifier(current.left.name));
      }
    }, false);
  }
  for (const script of parsed) findImplicit(script.ast.body, globals);
  for (const name of implicitGlobals) globals.add(name);
  const requirements = { globals: new Set(), reads: new Set(), writes: new Set(), methods: new Set(), attributes: new Set(), inlineHandlers: [] };
  let scriptIndex = 0;
  function property(node) {
    if (node.computed) {
      if (node.object.type === "Identifier" && ["document", "window"].includes(node.object.name)) fail("root objects cannot be indexed");
      if (node.property.type !== "Identifier" && !(node.property.type === "Literal" && Number.isSafeInteger(node.property.value) && node.property.value >= 0)) fail("only numeric collection indexes are supported");
      return ["index", expression(node.property)];
    }
    const name = node.property.name;
    if (!READS.has(name)) fail(`unsupported member read ${name}`);
    requirements.reads.add(name);
    return ["property", name];
  }
  let scope = globals;
  function fn(node) {
    if (node.async || node.generator || (node.type === "FunctionExpression" && node.id)) fail("unsupported function");
    const params = node.params.map(param => {
      if (param.type !== "Identifier") fail("unsupported parameter");
      return identifier(param.name);
    });
    if (new Set(params).size !== params.length) fail("duplicate parameters");
    const previous = scope;
    const locals = declarations(node.body.body);
    scope = new Set([...scope, ...params, ...locals.names]);
    const result = { params, ...block(node.body.body, false) };
    scope = previous;
    return result;
  }
  function expression(node) {
    if (!node) return ["literal", null];
    switch (node.type) {
      case "Literal":
        if (node.regex || (node.value !== null && !["string", "number", "boolean"].includes(typeof node.value)) ||
          (typeof node.value === "number" && !Number.isFinite(node.value))) fail("unsupported literal");
        return ["literal", node.value];
      case "Identifier":
        if (node.name === "document" || node.name === "window") return ["root", node.name];
        if (!scope.has(node.name)) fail(`unknown identifier ${node.name}`);
        return ["variable", node.name];
      case "FunctionExpression": return ["function", fn(node)];
      case "MemberExpression": return ["get", expression(node.object), property(node)];
      case "BinaryExpression":
        if (!BINARY.has(node.operator)) fail(`unsupported binary operator ${node.operator}`);
        return ["binary", node.operator, expression(node.left), expression(node.right)];
      case "LogicalExpression":
        if (!["&&", "||"].includes(node.operator)) fail("unsupported logical operator");
        return ["logical", node.operator, expression(node.left), expression(node.right)];
      case "UnaryExpression":
        if (!["!", "-", "+"].includes(node.operator)) fail(`unsupported unary operator ${node.operator}`);
        return ["unary", node.operator, expression(node.argument)];
      case "AssignmentExpression": {
        if (node.operator !== "=") fail("compound assignment is unsupported");
        const value = expression(node.right);
        if (node.left.type === "Identifier") {
          if (!scope.has(node.left.name)) fail(`unknown assignment ${node.left.name}`);
          return ["assign", node.left.name, value];
        }
        if (node.left.type !== "MemberExpression" || node.left.computed || !["value", "display"].includes(node.left.property.name)) fail("unsupported member write");
        requirements.writes.add(node.left.property.name);
        return ["set", expression(node.left.object), node.left.property.name, value];
      }
      case "CallExpression": {
        if (node.optional || node.arguments.some(arg => arg.type === "SpreadElement")) fail("unsupported call");
        const args = node.arguments.map(expression);
        if (node.callee.type === "Identifier") {
          const name = node.callee.name;
          if (GLOBAL_CALLS.has(name)) { requirements.globals.add(name); return ["hostCall", name, args]; }
          if (!scope.has(name)) fail(`unknown call ${name}`);
          return ["call", ["variable", name], args];
        }
        const member = node.callee;
        if (member.type !== "MemberExpression" || member.computed || !METHODS.has(member.property.name)) fail("unsupported method call");
        const name = member.property.name;
        requirements.methods.add(name);
        if (name === "getAttribute" || name === "setAttribute") {
          const attribute = node.arguments[0];
          if (attribute?.type !== "Literal" || !ATTRIBUTES.has(attribute.value)) fail("unsupported or dynamic attribute");
          requirements.attributes.add(attribute.value);
          if (name === "setAttribute" && !["validate", "placeholder", "onclick"].includes(attribute.value)) fail(`unsupported attribute write ${attribute.value}`);
          if (name === "setAttribute" && attribute.value === "onclick") requirements.inlineHandlers.push({ scriptIndex, start: node.start, end: node.end, expression: args[1] });
        }
        return ["method", expression(member.object), name, args];
      }
      default: fail(`unsupported expression ${node.type}`);
    }
  }
  function statement(node, loopDepth = 0) {
    switch (node.type) {
      case "EmptyStatement": return ["empty"];
      case "ExpressionStatement": return ["expression", expression(node.expression)];
      case "BlockStatement": return ["block", node.body.map(child => statement(child, loopDepth))];
      case "VariableDeclaration":
        return ["declare", node.declarations.map(item => [item.id.name, item.init ? expression(item.init) : null])];
      case "IfStatement": return ["if", expression(node.test), statement(node.consequent, loopDepth), node.alternate ? statement(node.alternate, loopDepth) : null];
      case "ReturnStatement": return ["return", node.argument ? expression(node.argument) : null];
      case "BreakStatement": case "ContinueStatement":
        if (node.label || !loopDepth) fail("unsupported control transfer");
        return [node.type === "BreakStatement" ? "break" : "continue"];
      case "ForStatement": {
        const declaration = node.init?.declarations?.[0], index = declaration?.id?.name;
        if (node.init?.type !== "VariableDeclaration" || node.init.kind !== "var" || node.init.declarations.length !== 1 ||
          declaration.id.type !== "Identifier" || declaration.init?.type !== "Literal" ||
          !Number.isSafeInteger(declaration.init.value) || declaration.init.value < 0 ||
          node.test?.type !== "BinaryExpression" || node.test.operator !== "<" || node.test.left.type !== "Identifier" || node.test.left.name !== index ||
          node.update?.type !== "UpdateExpression" || node.update.operator !== "++" || node.update.argument.type !== "Identifier" || node.update.argument.name !== index) fail("loop must have a bounded ascending counter");
        const bound = node.test.right;
        const length = bound.type === "BinaryExpression" && bound.operator === "-" ? bound.left : bound;
        const lengthBound = length.type === "MemberExpression" && !length.computed && length.property.name === "length";
        if (!(bound.type === "Literal" && Number.isSafeInteger(bound.value) && bound.value >= 0 && bound.value <= 10000) &&
          !(lengthBound && (bound === length || (bound.right.type === "Literal" && Number.isSafeInteger(bound.right.value) && bound.right.value >= 0)))) fail("loop bound must be a collection length or bounded constant");
        walk(node.body, current => {
          if ((current.type === "AssignmentExpression" && current.left.type === "Identifier" && current.left.name === index) ||
            (current.type === "UpdateExpression" && current.argument.type === "Identifier" && current.argument.name === index) ||
            (current.type === "VariableDeclarator" && current.id.name === index)) fail("loop body changes its counter");
        });
        return ["for", index, declaration.init.value, expression(bound), statement(node.body, loopDepth + 1)];
      }
      case "FunctionDeclaration": fail("unexpected nested declaration");
      default: fail(`unsupported statement ${node.type}`);
    }
  }
  function block(body) {
    const declared = declarations(body);
    return {
      vars: [...declared.names],
      functions: declared.functions.map(node => [node.id.name, fn(node)]),
      body: body.filter(node => node.type !== "FunctionDeclaration").map(node => statement(node))
    };
  }
  const programs = parsed.map((script, index) => {
    scriptIndex = index;
    return { gate: script.gate ?? null, ...block(script.ast.body) };
  });
  return {
    version: VERSION, requiresHostProof: true, implicitGlobals: [...implicitGlobals].sort(), scripts: programs,
    hostRequirements: Object.fromEntries(Object.entries(requirements).map(([key, value]) => [key, value instanceof Set ? [...value].sort() : value]))
  };
}

// Self-contained so a source-bound generated profile can embed this exact
// interpreter. No source text is evaluated, and no host object is dereferenced.
export function createLegacyDetailProgramRuntime(ir, host, options = {}) {
  const error = message => { throw new Error(`Legacy detail IR: ${message}`); };
  if (ir?.version !== "legacy-detail-program-ir/v1" || !Array.isArray(ir.scripts)) error("unsupported IR version");
  const maxSteps = options.maxSteps ?? 100000, maxLoopIterations = options.maxLoopIterations ?? 10000;
  const maxCallDepth = options.maxCallDepth ?? 128;
  if (![maxSteps, maxLoopIterations].every(value => Number.isSafeInteger(value) && value > 0 && value <= 10000000) ||
    !Number.isSafeInteger(maxCallDepth) || maxCallDepth < 1 || maxCallDepth > 512) error("invalid execution budget");
  const handles = new WeakSet(), closures = new WeakMap();
  const makeHandle = (kind, key) => {
    if (typeof kind !== "string" || !kind || !["string", "number"].includes(typeof key)) error("invalid host handle");
    const token = Object.freeze({ kind, key }); handles.add(token); return token;
  };
  const roots = { document: makeHandle("document", "document"), window: makeHandle("window", "window") };
  const global = { vars: new Map(), parent: null };
  let steps = 0, iterations = 0, active = 0, callDepth = 0, started = false;
  const tick = () => { if (++steps > maxSteps) error("step budget exhausted"); };
  function safe(value, allowClosure = false) {
    if (value === null || value === undefined || ["string", "boolean"].includes(typeof value) ||
      (typeof value === "number" && Number.isFinite(value))) return value;
    if (typeof value !== "object") error("host returned an unsupported value");
    if (handles.has(value) || (allowClosure && closures.has(value))) return value;
    if (Array.isArray(value)) {
      // Copy data descriptors only; never expose an ambient object or invoke
      // array element accessors through source property access.
      if (Object.getPrototypeOf(value) !== Array.prototype) error("unsupported collection");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      return Array.from({ length: descriptors.length.value }, (_, index) => {
        const descriptor = descriptors[index];
        if (!descriptor) return undefined;
        if (!Object.hasOwn(descriptor, "value")) error("accessor collection");
        return safe(descriptor.value);
      });
    }
    error("host returned an unbranded object");
  }
  function primitive(value) {
    if (value !== null && value !== undefined && !["string", "number", "boolean"].includes(typeof value)) error("object coercion is unsupported");
    return value;
  }
  function find(env, name, optional = false) {
    for (let current = env; current; current = current.parent) if (current.vars.has(name)) return current;
    if (optional) return null;
    error(`unbound variable ${name}`);
  }
  function closure(spec, env) { const token = Object.freeze({}); closures.set(token, { spec, env }); return token; }
  function install(spec, env) {
    for (const name of spec.vars) if (!env.vars.has(name)) env.vars.set(name, undefined);
    for (const [name, fn] of spec.functions) env.vars.set(name, closure(fn, env));
  }
  function hostCall(operation, args) {
    if (typeof host.call !== "function") error("missing host.call");
    return safe(host.call(operation, args));
  }
  function member(object, key) {
    if (key[0] === "index") {
      const index = key[1];
      if (!Array.isArray(object) || !Number.isSafeInteger(index) || index < 0) error("invalid collection index");
      return object[index];
    }
    const name = key[1];
    if (key[0] !== "property" || !["rows", "length", "value", "name", "checked", "style", "display", "parentNode", "nextSibling", "innerHTML"].includes(name)) error("unsupported property");
    if (name === "length" && (typeof object === "string" || Array.isArray(object))) return object.length;
    if (!object || !handles.has(object) || typeof host.get !== "function") error(`unsupported member read ${name}`);
    return safe(host.get(object, name));
  }
  function call(token, args) {
    const found = closures.get(token);
    if (!found) error("source can call only interpreted functions");
    if (++callDepth > maxCallDepth) { callDepth--; error("call depth budget exhausted"); }
    const env = { vars: new Map(), parent: found.env };
    try {
      found.spec.params.forEach((name, index) => env.vars.set(name, args[index]));
      install(found.spec, env);
      const signal = statements(found.spec.body, env);
      return signal?.kind === "return" ? signal.value : undefined;
    } finally { callDepth--; }
  }
  function expr(node, env) {
    tick();
    const [op, a, b, c] = node;
    switch (op) {
      case "literal": return primitive(a);
      case "root":
        if (!Object.hasOwn(roots, a)) error("unknown root");
        return roots[a];
      case "variable": return find(env, a).vars.get(a);
      case "function": return closure(a, env);
      case "get": return member(expr(a, env), [b[0], b[0] === "index" ? expr(b[1], env) : b[1]]);
      case "assign": {
        const value = expr(b, env), owner = find(env, a, true);
        if (owner) owner.vars.set(a, value);
        else if (ir.implicitGlobals.includes(a)) global.vars.set(a, value);
        else error(`unbound assignment ${a}`);
        return value;
      }
      case "set": {
        const object = expr(a, env), value = primitive(expr(c, env));
        if (!object || !handles.has(object) || !["value", "display"].includes(b) || typeof host.set !== "function") error("unsupported host write");
        host.set(object, b, value); return value;
      }
      case "logical": {
        const left = expr(b, env);
        if (a === "&&") return left ? expr(c, env) : left;
        if (a === "||") return left ? left : expr(c, env);
        error("unknown logical operator"); break;
      }
      case "unary": {
        const value = primitive(expr(b, env));
        if (a === "!") return !value;
        if (a === "-") return -value;
        if (a === "+") return +value;
        error("unknown unary operator"); break;
      }
      case "binary": {
        const left = primitive(expr(b, env)), right = primitive(expr(c, env));
        switch (a) {
          case "+": return left + right;
          case "-": return left - right;
          case "==": return left == right; // Preserve the source's primitive loose equality.
          case "!=": return left != right;
          case "===": return left === right;
          case "!==": return left !== right;
          case "<": return left < right;
          case "<=": return left <= right;
          case ">": return left > right;
          case ">=": return left >= right;
          default: error("unknown binary operator");
        } break;
      }
      case "call": return call(expr(a, env), b.map(argument => expr(argument, env)));
      case "hostCall": {
        const allowed = ["AttachXFormValueChangeEventById", "Com_AddEventListener", "GetXFormFieldById", "common_dom_row_set_show_required_reset", "__xformDispatch", "DocList_AddRow", "DocList_DeleteRow_ClearLast", "DocList_MoveRow", "XFom_RestValidationElements"];
        if (!allowed.includes(a)) error("unknown host call");
        const args = b.map(argument => expr(argument, env));
        const callbackIndex = a === "AttachXFormValueChangeEventById" ? 1 : a === "Com_AddEventListener" ? 2 : -1;
        args.forEach((value, index) => {
          if (closures.has(value) && index !== callbackIndex) error("callback escapes its registration slot");
          if (index === callbackIndex && !closures.has(value)) error("registration requires an interpreted callback");
          safe(value, index === callbackIndex);
        });
        return hostCall(a, args);
      }
      case "method": {
        const object = expr(a, env);
        // JS resolves a property reference on the receiver before evaluating
        // arguments. A nullish receiver must not run argument side effects.
        if (object === null || object === undefined) error("nullish method receiver");
        const args = c.map(argument => expr(argument, env));
        if (b === "indexOf" && (typeof object === "string" || Array.isArray(object))) return object.indexOf(...args.map(primitive));
        if (b === "join" && Array.isArray(object)) return object.map(primitive).join(...args.map(primitive));
        if (!object || !handles.has(object) || !["getElementById", "getElementsByName", "getElementsByTagName", "getAttribute", "setAttribute"].includes(b) ||
          typeof host.method !== "function") error(`unsupported host method ${b}`);
        if (b === "setAttribute" && !["validate", "placeholder", "onclick"].includes(args[0])) error("unsupported attribute write");
        if (b === "getAttribute" && !["src", "type", "checked", "validate", "placeholder", "onclick"].includes(args[0])) error("unsupported attribute read");
        return safe(host.method(object, b, args.map(primitive)));
      }
      default: error(`unknown expression ${op}`);
    }
  }
  function statements(nodes, env) {
    for (const node of nodes) { const signal = stmt(node, env); if (signal) return signal; }
    return null;
  }
  function stmt(node, env) {
    tick();
    const [op, a, b, c, d] = node;
    switch (op) {
      case "empty": return null;
      case "expression": expr(a, env); return null;
      case "block": return statements(a, env);
      case "declare": for (const [name, init] of a) if (init) find(env, name).vars.set(name, expr(init, env)); return null;
      case "if": return expr(a, env) ? stmt(b, env) : c ? stmt(c, env) : null;
      case "return": return { kind: "return", value: a ? expr(a, env) : undefined };
      case "break": case "continue": return { kind: op };
      case "for": {
        const owner = find(env, a); owner.vars.set(a, b);
        while (owner.vars.get(a) < primitive(expr(c, env))) {
          if (++iterations > maxLoopIterations) error("loop iteration budget exhausted");
          const before = owner.vars.get(a), signal = stmt(d, env);
          if (signal?.kind === "return") return signal;
          if (signal?.kind === "break") break;
          if (owner.vars.get(a) !== before) error("loop counter changed");
          owner.vars.set(a, before + 1);
        }
        return null;
      }
      default: error(`unknown statement ${op}`);
    }
  }
  function entry(action) {
    if (!active) { steps = 0; iterations = 0; }
    active++;
    try { return action(); } finally { active--; }
  }
  return Object.freeze({
    createHandle: makeHandle,
    run({ enabledGates = [] } = {}) {
      if (started) error("program already initialized");
      if (!Array.isArray(enabledGates) || enabledGates.some(gate => typeof gate !== "string")) error("invalid gates");
      started = true;
      return entry(() => {
        for (const script of ir.scripts) if (script.gate === null || enabledGates.includes(script.gate)) {
          install(script, global); statements(script.body, global);
        }
      });
    },
    invoke(callback, args = []) {
      if (!started) error("program is not initialized");
      return entry(() => call(typeof callback === "string" ? find(global, callback).vars.get(callback) : callback, args.map(value => safe(value))));
    },
    read(name) { return find(global, name).vars.get(name); }
  });
}
