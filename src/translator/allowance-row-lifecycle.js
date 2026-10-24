import { parse } from "acorn";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";
import { inspectLegacyDetailControlTarget } from "./detail-control-target.js";

// This recognizes a closed receipt-calculation binding, not a jQuery runtime.
// The source's comma selector also matches global images. Only its exact table
// member proves a table lifecycle; a bare image or the nested hashless rebind
// cannot independently establish one.
export function inspectAllowanceRowLifecycle(source, form, model, { sourceScripts = {}, downstream = [] } = {}) {
  const empty = { status: "not_applicable", candidates: [] };
  const target = inspectLegacyDetailControlTarget(form, model.receiptFieldId);
  if (target.status !== "resolved" || target.table.id !== model.receiptTableId) return empty;
  const text = String(source.javascript || "");
  let program;
  try { program = parse(text, { ecmaVersion: "latest" }); }
  catch { return empty; }
  const bindings = buildJavaScriptBindingModel(text);
  if (!bindings.ok) return empty;
  let root = bindings.scopeAt(0);
  while (root.parent) root = root.parent;
  const receiptFunctions = program.body.filter(node => node.type === "FunctionDeclaration" &&
    node.id?.name === model.receiptFunctionName);
  const receiptFunction = receiptFunctions[0];
  if (receiptFunctions.length !== 1) return empty;
  const receiptBinding = bindings.bindingAtUse(model.receiptFunctionName, receiptFunction.end);
  if (receiptBinding?.scope !== root) return empty;
  const tableBinding = bindings.bindingAtUse(model.receiptTableVariable, receiptFunction.start);
  const stable = binding => binding?.scope === root && !binding.ambiguous &&
    !binding.effects.some(effect => ["write", "mutation"].includes(effect.kind));
  const parents = new Map();
  const all = nodes(program, parents);
  const protectedNames = new Set(["$", "jQuery", model.receiptFunctionName, model.receiptHelperName, model.receiptTableVariable]);

  const directReceiptCall = statement => {
    const call = statement?.type === "ExpressionStatement" && statement.expression;
    return call?.type === "CallExpression" && !call.optional &&
      call.callee.type === "Identifier" && call.callee.name === model.receiptFunctionName &&
      call.arguments.length === 0 && bindings.bindingAtUse(call.callee.name, call.start) === receiptBinding;
  };
  const selectorValue = (node, requireStable) => {
    if (node?.type === "Literal" && typeof node.value === "string") return node.value;
    if (node?.type === "Identifier") {
      const binding = bindings.bindingAtUse(node.name, node.start);
      // Recognition identifies the source table from one root literal
      // declaration. Its writes are checked separately by the proof stage so
      // a matching but unstable binding cannot silently become not_applicable.
      if (binding?.scope !== root || binding.declarations.length !== 1 ||
          binding.declarations[0].controlFlowUnproven || binding.declarations[0].lexicalScope !== root ||
          binding.declarations[0].index >= node.start || requireStable && !stable(binding)) return undefined;
      const expression = binding.declarations[0].expression;
      let value;
      try { value = parse(`(${expression})`, { ecmaVersion: "latest" }).body[0].expression; }
      catch { return undefined; }
      return value.type === "Literal" && typeof value.value === "string" ? value.value : undefined;
    }
    if (node?.type !== "BinaryExpression" || node.operator !== "+") return undefined;
    const left = selectorValue(node.left, requireStable);
    const right = selectorValue(node.right, requireStable);
    return left === undefined || right === undefined ? undefined : left + right;
  };
  const bindingFromCall = (call, nested = false, requireProof = false) => {
    if (call?.type !== "CallExpression" || call.optional || call.arguments.length !== 2 ||
        !member(call.callee) || !["on", "bind"].includes(call.callee.property.name) ||
        literal(call.arguments[0]) !== "click") return undefined;
    let select = call.callee.object;
    if (select.type === "CallExpression" && member(select.callee) && select.callee.property.name === "unbind") {
      if (select.arguments.length !== 1 || literal(select.arguments[0]) !== "click") return undefined;
      select = select.callee.object;
    }
    if (select.type !== "CallExpression" || select.optional || select.arguments.length !== 1 ||
        select.callee.type !== "Identifier" || !["$", "jQuery"].includes(select.callee.name) ||
        !bindings.isUnshadowedGlobal(select.callee.name, select.start)) return undefined;
    const selector = selectorValue(select.arguments[0], requireProof);
    const match = (nested ? /^#?TABLE_DL_(fd_[A-Za-z0-9_]+),\s*img\[title=(["'])(添加行|删除行)\2\]$/u
      : /^#TABLE_DL_(fd_[A-Za-z0-9_]+),\s*img\[title=(["'])(添加行|删除行)\2\]$/u).exec(selector || "");
    if (!match || match[1] !== model.receiptTableId) return undefined;
    const callback = call.arguments[1];
    if (callback.type !== "FunctionExpression" || callback.id || callback.async ||
        callback.generator || callback.params.length) return undefined;
    const statements = callback.body.body.filter(node => node.type !== "EmptyStatement");
    if (!directReceiptCall(statements[0])) return undefined;
    const event = match[3] === "添加行" ? "onAfterAdd" : "onAfterDel";
    if (requireProof && statements.length !== 1) {
      if (nested || event !== "onAfterAdd" || statements.length !== 2 ||
          statements[1].type !== "ExpressionStatement" ||
          bindingFromCall(statements[1].expression, true, true)?.event !== "onAfterDel") return undefined;
    }
    return { event, start: call.start, end: call.end };
  };
  const bound = program.body.flatMap(statement => {
    const binding = statement.type === "ExpressionStatement" && bindingFromCall(statement.expression);
    return binding ? [binding] : [];
  });
  if (!bound.length) return empty;
  const unproven = () => ({ status: "unproven", candidates: [], residual: {
    code: "script.residual.allowance_receipt_lifecycle_unproven",
    sourceRef: source.sourceRef || source.id,
    reason: "Source receipt-row click bindings exist, but their global bindings or complete receipt calculation closure are not proved safe."
  } });
  // From this point ownership has been recognized. Every proof failure must
  // preserve a residual rather than erase the matching source behavior.
  if (receiptFunction.params.length || receiptFunction.async || receiptFunction.generator ||
      !stable(receiptBinding) || !stable(tableBinding) || tableBinding.declarations.length !== 1) return unproven();
  const tableDeclaration = tableBinding.declarations[0];
  if (tableDeclaration.controlFlowUnproven || tableDeclaration.lexicalScope !== root ||
      bound.some(binding => tableDeclaration.index >= binding.start)) return unproven();
  let tableValue;
  try { tableValue = parse(`(${tableDeclaration.expression})`, { ecmaVersion: "latest" }).body[0].expression; }
  catch { return unproven(); }
  if (tableValue.type !== "Literal" || tableValue.value !== model.receiptTableId) return unproven();
  if (all.some(node => node.type === "WithStatement" ||
      node.type === "CallExpression" && ["eval", "Function"].includes(node.callee?.name) ||
      node.type === "NewExpression" && node.callee?.name === "Function" ||
      writesProtectedGlobal(node, protectedNames))) return unproven();
  const receiptScope = bindings.scopeAt(receiptFunction.body.start + 1).functionScope;
  const helperFunctions = program.body.filter(node => node.type === "FunctionDeclaration" && node.id?.name === model.receiptHelperName);
  if (helperFunctions.length !== 1) return unproven();
  const helperBinding = bindings.bindingAtUse(model.receiptHelperName, receiptFunction.start);
  if (!stable(helperBinding)) return unproven();
  const receiptRead = nodes(receiptFunction.body).find(node => node.type === "CallExpression" &&
    node.callee?.name === model.receiptHelperName && node.arguments.length === 2 &&
    bindings.scopeAt(node.start).functionScope === receiptScope && bindings.bindingAtUse(model.receiptHelperName, node.start) === helperBinding &&
    node.arguments[0]?.name === model.receiptTableVariable && literal(node.arguments[1]) === model.receiptFieldId &&
    bindings.bindingAtUse(model.receiptTableVariable, node.start) === tableBinding);
  if (!receiptRead) return unproven();
  const provenBound = program.body.flatMap(statement => {
    const binding = statement.type === "ExpressionStatement" && bindingFromCall(statement.expression, false, true);
    return binding ? [binding] : [];
  });
  if (provenBound.length !== bound.length) return unproven();
  if (!closedGlobalCapabilities(all, parents, bindings, model, sourceScripts) ||
      !closedReceiptCalculation(receiptFunction, program, bindings, root, model, downstream, source, sourceScripts)) {
    return unproven();
  }
  const seen = new Set();
  return { status: "accepted", candidates: provenBound.flatMap(binding => {
    if (seen.has(binding.event)) return [];
    seen.add(binding.event);
    const delegated = downstream.filter(edge => nodes(receiptFunction.body).some(node =>
      node.type === "CallExpression" && node.callee?.name === edge.functionName));
    return [{
      index: binding.start,
      event: binding.event,
      scope: "control",
      controlId: model.receiptTableId,
      tableId: model.receiptTableId,
      sourceActionKey: `${binding.event}@${binding.start}`,
      javascript: text.slice(binding.start, binding.end),
      function: receiptLifecycleFunction(binding.event, model),
      sourceRefs: delegated.map(edge => edge.sourceRef),
      semanticHints: { coveredCalculationRanges: [{
        sourceRef: source.sourceRef || source.id,
        name: `receipt-row-lifecycle:${binding.event}`,
        start: binding.start,
        end: binding.end
      }, ...delegated.map(edge => ({ sourceRef: edge.sourceRef,
        name: `receipt-target-change:${edge.functionName}`, start: edge.start, end: edge.end }))] }
    }];
  }) };
}

function receiptLifecycleFunction(event, model) {
  const tablePrefix = `${"${table:"}${model.receiptTableId}}.`;
  const qualifiedField = tablePrefix + model.receiptFieldId;
  return [
    `function ${event}(data) {`,
    "  if (!Array.isArray(data)) return",
    "  var receiptTotal = 0",
    "  for (var index = 0; index < data.length; index += 1) {",
    "    var row = data[index]",
    "    if (!row || typeof row !== \"object\" || Array.isArray(row)) return",
    "    var keys = Object.keys(row)",
    "    for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {",
    `      if (keys[keyIndex].indexOf(".") >= 0 && keys[keyIndex].indexOf(${JSON.stringify(tablePrefix)}) !== 0) return`,
    "    }",
    `    var rawAmount = row[${JSON.stringify(qualifiedField)}]`,
    `    if (rawAmount === undefined) rawAmount = row[${JSON.stringify(model.receiptFieldId)}]`,
    "    if (rawAmount != null && typeof rawAmount !== \"number\" && typeof rawAmount !== \"string\") return",
    "    var amount = Number(rawAmount || 0)",
    "    if (!Number.isFinite(amount)) return",
    "    receiptTotal = Math.round((receiptTotal + amount) * 100) / 100",
    "  }",
    `  var modeRaw = MKXFORM.getValue(${JSON.stringify(model.modeFieldId)})`,
    "  var mode = Number(Array.isArray(modeRaw) ? modeRaw[0] : modeRaw || 0)",
    `  var startRaw = MKXFORM.getValue(${JSON.stringify(model.startFieldId)})`,
    `  var endRaw = MKXFORM.getValue(${JSON.stringify(model.endFieldId)})`,
    "  var dayDifference = 0",
    "  if (startRaw && endRaw) {",
    "    var startDate = new Date(String(startRaw).replace(/-/g, '/'))",
    "    var endDate = new Date(String(endRaw).replace(/-/g, '/'))",
    "    startDate.setHours(0, 0, 0, 0)",
    "    endDate.setHours(0, 0, 0, 0)",
    "    dayDifference = Math.floor((endDate.getTime() - startDate.getTime()) / 86400000)",
    "  }",
    `  var people = Number(MKXFORM.getValue(${JSON.stringify(model.personFieldId)}) || 0)`,
    `  var receiptCap = (dayDifference + 1) * people * ${model.receiptCapPerPersonDay}`,
    "  var receiptResult = mode === 0 ? receiptTotal : Math.min(receiptTotal, Math.max(receiptCap, 0))",
    `  MKXFORM.setValue(${JSON.stringify(model.receiptTargetFieldId)}, receiptResult)`,
    "}"
  ].join("\n");
}

const literal = node => node?.type === "Literal" ? node.value : undefined;
const member = node => node?.type === "MemberExpression" && !node.optional && !node.computed;

// A global object is a capability, not an inert alias. This recipe has no
// reason to expose one or to use reflection. Accept only the source APIs and
// scalar/global reads used by the calculation; unknown capabilities fail
// closed regardless of whether they are assigned, passed, or called indirectly.
function closedGlobalCapabilities(all, parents, bindings, model, sourceScripts) {
  const scalarCalls = new Set(["$", "jQuery", "Number", "getFormRadioValue", "getFormFieldValue",
    "theFixedNumTwo", "AttachXFormValueChangeEventById", "alert"]);
  const sourceFunctions = new Set();
  for (const source of sourceScripts.sources || []) {
    let program;
    try { program = parse(String(source.javascript || ""), { ecmaVersion: "latest" }); }
    catch { continue; }
    for (const node of program.body) if (node.type === "FunctionDeclaration") sourceFunctions.add(node.id.name);
  }
  for (const node of all) {
    const parent = parents.get(node);
    if (node.type === "ThisExpression" || node.type === "WithStatement") return false;
    const written = node.type === "AssignmentExpression" ? node.left :
      node.type === "UpdateExpression" || node.type === "UnaryExpression" && node.operator === "delete" ? node.argument : undefined;
    if (written?.type === "MemberExpression") return false;
    if (node.type === "MemberExpression") {
      const property = node.computed ? literal(node.property) : node.property.name;
      if (["constructor", "prototype", "__proto__"].includes(property)) return false;
      if (node.computed && !(node.object.type === "Identifier" &&
          node.object.name === "DocList_TableInfo" && bindings.isUnshadowedGlobal(node.object.name, node.start))) return false;
    }
    if (node.type !== "Identifier" || !identifierReference(node, parent)) continue;
    const binding = bindings.bindingAtUse(node.name, node.start);
    if (binding) {
      if (scalarCalls.has(node.name) || ["Math", "Date", "DocList_TableInfo"].includes(node.name)) return false;
      continue;
    }
    if (node.name === model.modeVariableName) continue;
    const directCall = parent?.type === "CallExpression" && parent.callee === node && !parent.optional;
    if (directCall && scalarCalls.has(node.name)) continue;
    if (directCall && sourceFunctions.has(node.name) && parents.get(parent)?.type === "ExpressionStatement") continue;
    if (parent?.type === "NewExpression" && parent.callee === node && node.name === "Date") continue;
    if (node.name === "Math" && member(parent) && ["min", "max", "floor", "round"].includes(parent.property.name) &&
        parents.get(parent)?.type === "CallExpression" && parents.get(parent).callee === parent) continue;
    if (node.name === "DocList_TableInfo" && parent?.type === "MemberExpression" && parent.object === node && parent.computed) continue;
    return false;
  }
  return true;
}

function identifierReference(node, parent) {
  if (!parent) return false;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return false;
  if (["Property", "MethodDefinition"].includes(parent.type) && parent.key === node && !parent.computed && !parent.shorthand) return false;
  if ((parent.type === "VariableDeclarator" || parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression") && parent.id === node) return false;
  if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(parent.type) && parent.params.includes(node)) return false;
  return true;
}

function closedReceiptCalculation(receipt, program, bindings, root, model, downstream, source, sourceScripts) {
  const functions = name => program.body.filter(node => node.type === "FunctionDeclaration" && node.id?.name === name);
  const stableFunction = name => {
    const matches = functions(name);
    if (matches.length !== 1 || matches[0].async || matches[0].generator) return undefined;
    const binding = bindings.bindingAtUse(name, matches[0].end);
    return binding?.scope === root && !binding.ambiguous &&
      !binding.effects.some(effect => ["write", "mutation"].includes(effect.kind)) ? matches[0] : undefined;
  };
  const readSelector = node => {
    if (node?.type !== "CallExpression" || node.optional || node.callee.type !== "Identifier" ||
        !["$", "jQuery"].includes(node.callee.name) || node.arguments.length !== 1 ||
        !bindings.isUnshadowedGlobal(node.callee.name, node.start)) return undefined;
    return /^(?:input)?\[name=(["']?)extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)\1\]$/u
      .exec(literal(node.arguments[0]) || "")?.[2];
  };
  const isCall = (node, name, count) => node?.type === "CallExpression" && !node.optional &&
    node.callee?.type === "Identifier" && node.callee.name === name && node.arguments.length === count;
  const statements = node => node?.type === "BlockStatement" ? node.body.filter(n => n.type !== "EmptyStatement") : [node];
  const delegatedCall = call => downstream.some(edge => {
    if (edge.functionName !== call.callee.name) return false;
    const owners = [];
    for (const candidate of sourceScripts.sources || []) {
      let parsed;
      try { parsed = parse(String(candidate.javascript || ""), { ecmaVersion: "latest" }); }
      catch { continue; }
      for (const declaration of parsed.body) if (declaration.type === "FunctionDeclaration" && declaration.id?.name === edge.functionName) {
        owners.push({ sourceRef: candidate.sourceRef || candidate.id, declaration });
      }
    }
    if (owners.length !== 1 || owners[0].sourceRef !== edge.sourceRef) return false;
    if (edge.sourceRef !== (source.sourceRef || source.id)) return bindings.isUnshadowedGlobal(call.callee.name, call.start);
    return stableFunction(call.callee.name)?.start === owners[0].declaration.start;
  });

  // Helpers may mutate their own numeric/date locals, never captured state.
  // This checks the complete reachable local helper bodies, not just a matched
  // receipt read surrounded by unexamined statements.
  const checked = new Set();
  const active = new Set();
  function closedHelper(fn) {
    if (!fn || active.has(fn)) return false;
    if (checked.has(fn)) return true;
    active.add(fn);
    const scope = bindings.scopeAt(fn.body.start + 1).functionScope;
    for (const node of nodes(fn.body)) {
      if (["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration", "ThrowStatement", "TryStatement", "AwaitExpression", "YieldExpression"].includes(node.type)) return false;
      if (node.type === "NewExpression" && (node.callee?.name !== "Date" || !bindings.isUnshadowedGlobal("Date", node.start))) return false;
      const target = node.type === "AssignmentExpression" ? node.left : node.type === "UpdateExpression" ? node.argument : undefined;
      if (target && (target.type !== "Identifier" || bindings.bindingAtUse(target.name, node.start)?.scope.functionScope !== scope)) return false;
      if (node.type !== "CallExpression") continue;
      if (node.optional) return false;
      if (node.callee.type === "Identifier") {
        if (["$", "jQuery", "Number", "theFixedNumTwo", "getFormFieldValue", "getFormRadioValue", "alert"].includes(node.callee.name) &&
            bindings.isUnshadowedGlobal(node.callee.name, node.start)) continue;
        const helper = stableFunction(node.callee.name);
        if (!helper || !closedHelper(helper)) return false;
      } else if (member(node.callee)) {
        const method = node.callee.property.name;
        if (node.callee.object.name === "Math" && ["min", "max", "floor", "round"].includes(method)) continue;
        const receiver = node.callee.object;
        const localReceiver = receiver.type === "Identifier" && bindings.bindingAtUse(receiver.name, node.start)?.scope.functionScope === scope;
        const selectedReceiver = receiver.type === "CallExpression" && ["$", "jQuery"].includes(receiver.callee?.name);
        if (method === "val" && node.arguments.length === 0 && (localReceiver || selectedReceiver) ||
            ["indexOf", "replace", "getTime", "toFixed"].includes(method) && localReceiver) continue;
        if (["setHours", "setMinutes", "setSeconds"].includes(method) && node.callee.object.type === "Identifier") {
          const binding = bindings.bindingAtUse(node.callee.object.name, node.start);
          if (binding?.scope.functionScope === scope && binding.declarations.length === 1 &&
              /^new\s+Date\s*\(/u.test(binding.declarations[0].expression || "")) continue;
        }
        return false;
      } else return false;
    }
    active.delete(fn);
    checked.add(fn);
    return true;
  }
  if (!closedHelper(stableFunction(model.receiptHelperName))) return false;

  function closedCap(name) {
    const fn = stableFunction(name);
    if (!fn || fn.params.length || !closedHelper(fn)) return false;
    const values = new Map();
    let productSeen = false;
    function expression(node) {
      if (node?.type === "Identifier") return values.get(node.name);
      if (node?.type === "Literal") return node.value;
      if (node?.type === "BinaryExpression" && node.operator === "+" && literal(node.right) === 1 &&
          node.left.type === "CallExpression" && node.left.callee.type === "Identifier" && node.left.arguments.length === 0) {
        const dayFunction = stableFunction(node.left.callee.name);
        return dayFunction && closedHelper(dayFunction) ? "days" : undefined;
      }
      if (node?.type === "CallExpression" && member(node.callee) && node.callee.property.name === "val" &&
          node.arguments.length === 0 && readSelector(node.callee.object) === model.personFieldId) return "people";
      if (node?.type === "BinaryExpression" && node.operator === "*" && literal(node.right) === model.receiptCapPerPersonDay &&
          node.left.type === "BinaryExpression" && node.left.operator === "*" &&
          expression(node.left.left) === "days" && expression(node.left.right) === "people") return "cap";
      return undefined;
    }
    function block(body) {
      for (const statement of statements(body)) {
        if (statement.type === "VariableDeclaration") {
          for (const variable of statement.declarations) {
            const value = expression(variable.init);
            if (variable.id.type !== "Identifier" || values.has(variable.id.name) || !["days", "people"].includes(value)) return false;
            values.set(variable.id.name, value);
          }
        } else if (statement.type === "ReturnStatement") {
          const value = expression(statement.argument);
          if (value === "cap") productSeen = true;
          else if (value !== 0) return false;
        } else if (statement.type === "IfStatement" && !statement.alternate && statement.test.type === "LogicalExpression" &&
            statement.test.operator === "&&" && expression(statement.test.left) === "days" && expression(statement.test.right) === "people") {
          if (!block(statement.consequent)) return false;
        } else return false;
      }
      return true;
    }
    return block(fn.body) && productSeen;
  }

  const values = new Map();
  const writtenModes = new Set();
  let downstreamSeen = false;
  function expression(node, available) {
    if (node?.type === "Identifier") return available.get(node.name);
    if (readSelector(node) === model.receiptTargetFieldId) return "target";
    if (isCall(node, model.receiptHelperName, 2) && node.arguments[0]?.name === model.receiptTableVariable &&
        literal(node.arguments[1]) === model.receiptFieldId) return "sum";
    if (isCall(node, "Number", 1) && bindings.isUnshadowedGlobal("Number", node.start)) return expression(node.arguments[0], available);
    if (node?.type === "CallExpression" && member(node.callee) && node.callee.object.name === "Math" &&
        node.callee.property.name === "min" && node.arguments.length === 2 &&
        expression(node.arguments[0], available) === "sum" && expression(node.arguments[1], available) === "cap") return "capped";
    if (node?.type === "CallExpression" && node.callee.type === "Identifier" && node.arguments.length === 0 && closedCap(node.callee.name)) return "cap";
    return undefined;
  }
  function block(body, mode, available = values) {
    for (const statement of statements(body)) {
      if (statement.type === "VariableDeclaration") {
        for (const variable of statement.declarations) {
          const value = expression(variable.init, available);
          if (variable.id.type !== "Identifier" || available.has(variable.id.name) || !value) return false;
          available.set(variable.id.name, value);
        }
      } else if (statement.type === "IfStatement") {
        const test = statement.test;
        if (test.type === "BinaryExpression" && ["==", "==="].includes(test.operator) &&
            test.left.name === model.modeVariableName && literal(test.right) === 0 && !mode && statement.alternate) {
          if (!block(statement.consequent, "city", new Map(available)) || !block(statement.alternate, "domestic", new Map(available))) return false;
        } else if (mode && !statement.alternate && (mode === "city" ? expression(test, available) === "sum" :
            test.type === "LogicalExpression" && test.operator === "&&" && expression(test.left, available) === "sum" && expression(test.right, available) === "cap")) {
          if (!block(statement.consequent, mode, new Map(available))) return false;
        } else return false;
      } else if (statement.type === "ExpressionStatement") {
        const call = statement.expression;
        if (call.type === "CallExpression" && member(call.callee) && call.callee.property.name === "val" &&
            expression(call.callee.object, available) === "target" && call.arguments.length === 1 &&
            expression(call.arguments[0], available) === (mode === "city" ? "sum" : mode === "domestic" ? "capped" : undefined) &&
            !writtenModes.has(mode)) writtenModes.add(mode);
        else if (!mode && !downstreamSeen && writtenModes.size === 2 && call.type === "CallExpression" &&
            call.callee.type === "Identifier" && call.arguments.length === 0 &&
            delegatedCall(call)) downstreamSeen = true;
        else return false;
      } else return false;
    }
    return true;
  }
  return block(receipt.body) && writtenModes.has("city") && writtenModes.has("domestic");
}

function writesProtectedGlobal(node, protectedNames) {
  const target = node.type === "AssignmentExpression" ? node.left :
    node.type === "UpdateExpression" || node.type === "UnaryExpression" && node.operator === "delete" ? node.argument : undefined;
  if (target?.type === "Identifier") return protectedNames.has(target.name);
  if (target?.type !== "MemberExpression") return false;
  let root = target;
  let firstProperty;
  while (root.type === "MemberExpression") {
    firstProperty = root.computed ? literal(root.property) : root.property.name;
    root = root.object;
  }
  return protectedNames.has(root.name) ||
    ["window", "globalThis", "self"].includes(root.name) &&
      (firstProperty === undefined || protectedNames.has(firstProperty));
}

function nodes(root, parents) {
  const result = [];
  function visit(node, parent) {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;
    if (parents && parent) parents.set(node, parent);
    result.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, node));
      else if (value && typeof value === "object") visit(value, node);
    }
  }
  visit(root);
  return result;
}
