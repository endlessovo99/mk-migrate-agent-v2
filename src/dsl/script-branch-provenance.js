import { parse } from "acorn";
import {
  buildConditionOperandResolver,
  parseProvenanceCondition
} from "./script-condition-provenance.js";

export const SCRIPT_BRANCH_PROVENANCE_VERSION = 3;

const PROVENANCE_STATUSES = new Set(["none", "proven", "unproven"]);
const PROVENANCE_EVENTS = new Set(["onChange", "onLoad"]);

export function buildScriptBranchProvenance({
  event,
  source,
  sourceRef,
  sourceActionKey,
  eventFunctionName,
  eventFunctionStart,
  programIsEntrypoint = false
} = {}) {
  const analysis = analyzeScriptBranchConditions(source, {
    event,
    eventFunctionName,
    eventFunctionStart,
    programIsEntrypoint
  });
  return pruneUndefined({
    version: SCRIPT_BRANCH_PROVENANCE_VERSION,
    event,
    sourceRef,
    sourceActionKey,
    status: analysis.status,
    conditions: analysis.conditions,
    reason: analysis.reason
  });
}

export function analyzeScriptBranchConditions(source, {
  event,
  eventFunctionName,
  eventFunctionStart,
  programIsEntrypoint = false
} = {}) {
  const text = String(source || "");
  const ast = parseScript(text);
  if (!ast) {
    return {
      status: "unproven",
      conditions: [],
      reason: "javascript_parse_failed",
      issues: [{ reason: "javascript_parse_failed" }]
    };
  }
  const resolver = buildConditionOperandResolver(text, {
    event,
    eventFunctionName,
    eventFunctionStart,
    programIsEntrypoint
  });
  if (["onChange", "onLoad"].includes(event) && !resolver.entrypoint) {
    return {
      status: "unproven",
      conditions: [],
      reason: "action_entrypoint_unproven",
      issues: [{ reason: "action_entrypoint_unproven" }]
    };
  }
  const { nodes, parentByNode, issues: entrypointIssues } = collectAstNodes(
    ast,
    resolver.entrypoint,
    resolver
  );
  const candidates = [];
  const usedAliases = new Set();
  const issues = [...entrypointIssues];

  for (const conditional of nodes.filter((node) => node.type === "IfStatement")) {
    const exclusionGuard = binaryExclusionReturnGuard(conditional, resolver, text);
    if (exclusionGuard) {
      exclusionGuard.forEach((condition, order) => candidates.push({
        index: conditional.test.start,
        order,
        condition: normalizedCondition(condition)
      }));
      continue;
    }
    collectCondition(conditional.test, "condition_not_statically_supported");
  }

  for (const conditional of nodes.filter((node) => node.type === "ConditionalExpression")) {
    const wholeExpression = text.slice(conditional.start, conditional.end);
    if (resolver.trace(wholeExpression, { beforeIndex: conditional.start })) continue;
    collectCondition(conditional.test, "ternary_condition_not_statically_supported");
  }

  if (nodes.some((node) => node.type === "SwitchStatement")) {
    issues.push({ reason: "switch_condition_not_supported" });
  }
  for (const loop of nodes.filter((node) => loopCondition(node))) {
    issues.push({ reason: "loop_condition_not_supported", index: loopCondition(loop).start });
  }
  for (const logical of nodes.filter((node) => node.type === "LogicalExpression")) {
    if (withinCollectedControlTest(logical, parentByNode)) continue;
    if (resolver.trace(text.slice(logical.start, logical.end), { beforeIndex: logical.start })) continue;
    issues.push({ reason: "logical_branch_not_statically_supported", index: logical.start });
  }
  for (const assignment of nodes.filter(logicalAssignment)) {
    const operand = text.slice(assignment.left.start, assignment.left.end);
    if (assignment.operator === "??=") {
      issues.push({
        reason: "nullish_assignment_condition_not_statically_supported",
        index: assignment.start
      });
      continue;
    }
    const expression = assignment.operator === "&&=" ? operand : `!(${operand})`;
    const parsed = parseProvenanceCondition(
      expression,
      resolver,
      { beforeIndex: assignment.start }
    );
    if (!parsed) {
      issues.push({
        reason: "logical_assignment_condition_not_statically_supported",
        index: assignment.start
      });
      continue;
    }
    candidates.push({
      index: assignment.start,
      condition: normalizedCondition(parsed)
    });
  }

  const conditions = candidates
    .sort((left, right) => left.index - right.index || (left.order || 0) - (right.order || 0))
    .map((candidate) => candidate.condition)
    .filter((condition, index, all) => (
      all.findIndex((candidate) => conditionKey(candidate) === conditionKey(condition)) === index
    ));
  if (issues.length) {
    return {
      status: "unproven",
      conditions,
      reason: issues[0].reason,
      issues
    };
  }
  if (!conditions.length) return { status: "none", conditions: [] };

  const invalidOrigin = conditions.find((condition) => !originAllowedForEvent(condition.origin, event));
  if (invalidOrigin) {
    return {
      status: "unproven",
      conditions,
      reason: event === "onChange"
        ? "on_change_operand_not_event_input"
        : event === "onLoad"
          ? "on_load_operand_not_static_field_read"
          : "branch_event_not_supported"
    };
  }
  return { status: "proven", conditions };

  function collectCondition(test, reason) {
    const expression = text.slice(test.start, test.end);
    const alias = test.type === "Identifier"
      ? conditionAliasAtUse(resolver, test.name, test.start)
      : undefined;
    const parsed = alias?.condition || parseProvenanceCondition(
      expression,
      resolver,
      { beforeIndex: test.start }
    );
    if (!parsed) {
      issues.push({ reason, index: test.start });
      return;
    }
    if (alias) {
      if (usedAliases.has(alias.binding.id)) return;
      usedAliases.add(alias.binding.id);
    }
    candidates.push({
      index: alias?.index ?? test.start,
      condition: normalizedCondition(parsed)
    });
  }
}

export function inspectMappedScriptBranchProvenance(action, expected = action?.branchProvenance) {
  const shape = inspectScriptBranchProvenanceEvidence(expected, action);
  if (!shape.ok) return shape;
  if (action?.translationStatus !== "mapped") {
    return { ok: true, status: "not_mapped", expected };
  }

  const observed = analyzeScriptBranchConditions(action?.function, { event: action?.event });
  if (expected.status === "unproven") {
    return invalid("source_branch_provenance_unproven", expected, observed);
  }
  if (expected.status === "none") {
    return observed.status === "none"
      ? { ok: true, status: "matched", expected, observed }
      : invalid("source_unconditional_target_conditional", expected, observed);
  }
  if (observed.status !== "proven") {
    return invalid("target_branch_provenance_unproven", expected, observed);
  }
  if (!sameConditionSequence(expected.conditions, observed.conditions)) {
    return invalid("branch_condition_provenance_changed", expected, observed);
  }
  return { ok: true, status: "matched", expected, observed };
}

export function inspectScriptBranchProvenanceEvidence(evidence, action = {}) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { ok: false, reason: "branch_provenance_type_invalid", expected: evidence };
  }
  if (evidence.version !== SCRIPT_BRANCH_PROVENANCE_VERSION) {
    return { ok: false, reason: "branch_provenance_version_invalid", expected: evidence };
  }
  if (!PROVENANCE_STATUSES.has(evidence.status)) {
    return { ok: false, reason: "branch_provenance_status_invalid", expected: evidence };
  }
  if (!PROVENANCE_EVENTS.has(evidence.event) || evidence.event !== action?.event) {
    return { ok: false, reason: "branch_provenance_event_mismatch", expected: evidence };
  }
  if (!Array.isArray(evidence.conditions)) {
    return { ok: false, reason: "branch_provenance_conditions_invalid", expected: evidence };
  }
  if (evidence.status === "none" && evidence.conditions.length) {
    return { ok: false, reason: "branch_provenance_none_with_conditions", expected: evidence };
  }
  if (evidence.status === "proven" && !evidence.conditions.length) {
    return { ok: false, reason: "branch_provenance_proven_without_conditions", expected: evidence };
  }
  if (
    evidence.status === "proven" &&
    evidence.conditions.some((condition) => !validCondition(condition, evidence.event))
  ) {
    return { ok: false, reason: "branch_provenance_condition_invalid", expected: evidence };
  }
  if (evidence.sourceRef !== undefined && !(action?.sourceRefs || []).includes(evidence.sourceRef)) {
    return { ok: false, reason: "branch_provenance_source_ref_mismatch", expected: evidence };
  }
  if ((evidence.sourceActionKey ?? undefined) !== (action?.sourceActionKey ?? undefined)) {
    return { ok: false, reason: "branch_provenance_source_action_mismatch", expected: evidence };
  }
  return { ok: true, expected: evidence };
}

function conditionAliasAtUse(resolver, name, useIndex) {
  const initializer = resolver.stableInitializer?.(name, {
    beforeIndex: useIndex,
    sameFunction: true
  });
  if (!initializer) return undefined;
  const condition = parseProvenanceCondition(
    initializer.expression,
    resolver,
    { beforeIndex: initializer.expressionIndex }
  );
  return condition ? { ...initializer, condition } : undefined;
}

function binaryExclusionReturnGuard(conditional, resolver, source) {
  if (!emptyReturnStatement(conditional.consequent)) return undefined;
  const test = conditional.test;
  if (test.type !== "LogicalExpression" || test.operator !== "&&") return undefined;
  const conditions = [test.left, test.right].map((clause) => {
    if (clause.type !== "BinaryExpression" || !["!=", "!=="].includes(clause.operator)) {
      return undefined;
    }
    const equality = clause.operator === "!==" ? "===" : "==";
    const parsed = parseProvenanceCondition(
      `${source.slice(clause.left.start, clause.left.end)} ${equality} ${source.slice(clause.right.start, clause.right.end)}`,
      resolver,
      { beforeIndex: clause.start }
    );
    return parsed?.kind === "eq" ? parsed : undefined;
  });
  if (conditions.some((condition) => !condition)) return undefined;
  if (new Set(conditions.map((condition) => condition.operand)).size !== 1) return undefined;
  if (new Set(conditions.map((condition) => String(condition.value))).size !== 2) return undefined;
  return conditions;
}

function emptyReturnStatement(statement) {
  if (statement?.type === "ReturnStatement") return statement.argument === null;
  return statement?.type === "BlockStatement" &&
    statement.body.length === 1 &&
    statement.body[0].type === "ReturnStatement" &&
    statement.body[0].argument === null;
}

function parseScript(source) {
  try {
    return parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowHashBang: true
    });
  } catch {
    return undefined;
  }
}

function collectAstNodes(ast, entrypoint, resolver) {
  const nodes = [];
  const parentByNode = new WeakMap();
  const nestedFunctions = [];
  const entryNode = entrypoint?.type === "function"
    ? findAstNode(ast, (node) => (
        isFunctionNode(node) &&
        node.start === entrypoint.start &&
        node.end === entrypoint.end
      ))
    : ast;
  const root = entryNode?.type === "Program" ? entryNode : entryNode?.body;
  const visit = (node, parent) => {
    if (!isAstNode(node)) return;
    if (isFunctionNode(node)) {
      nestedFunctions.push({ node, parent });
      return;
    }
    nodes.push(node);
    if (parent) parentByNode.set(node, parent);
    for (const child of astChildren(node)) visit(child, node);
  };
  visit(root);
  const issues = [];
  for (let index = 0; index < nestedFunctions.length; index += 1) {
    const { node, parent } = nestedFunctions[index];
    if (provablyScheduledCallback(node, parent, resolver)) {
      visit(node.body, parent);
      continue;
    }
    const invokedNames = new Set(nodes
      .filter((candidate) => (
        candidate.type === "CallExpression" && candidate.callee?.type === "Identifier"
      ))
      .map((candidate) => candidate.callee.name));
    if (
      subtreeHasBranch(node.body) &&
      coercionHookMayRun(node, parent, nodes)
    ) {
      issues.push({
        reason: "nested_coercion_branch_not_statically_supported",
        index: node.start
      });
      continue;
    }
    if (subtreeHasBranch(node.body) && nestedFunctionMayRun(node, parent, invokedNames)) {
      issues.push({
        reason: "nested_callable_branch_not_statically_supported",
        index: node.start
      });
    }
  }
  return { nodes, parentByNode, issues };
}

function provablyScheduledCallback(node, parent, resolver) {
  if (parent?.type !== "CallExpression") return false;
  if (parent.callee === node) return true;
  if (parent.arguments?.[0] !== node || parent.callee?.type !== "Identifier") return false;
  if (!["queueMicrotask", "setTimeout"].includes(parent.callee.name)) return false;
  return resolver?.isUnshadowedGlobal?.(parent.callee.name, parent.callee.start) === true;
}

function nestedFunctionMayRun(node, parent, invokedNames) {
  if (parent?.type === "CallExpression") {
    return parent.callee === node || (parent.arguments || []).includes(node);
  }
  if (node.type === "FunctionDeclaration") return invokedNames.has(node.id?.name);
  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
    return invokedNames.has(parent.id.name);
  }
  return false;
}

function coercionHookMayRun(node, parent, nodes) {
  if (coercionHookProperty(parent, node)) return true;
  if (
    parent?.type === "AssignmentExpression" &&
    parent.right === node &&
    coercionHookMember(parent.left)
  ) return true;
  const bindingName = nestedFunctionBindingName(node, parent);
  if (!bindingName) return false;
  return nodes.some((candidate) => (
    (candidate.type === "Property" || candidate.type === "MethodDefinition") &&
    coercionHookKey(candidate.key, candidate.computed) &&
    candidate.value?.type === "Identifier" &&
    candidate.value.name === bindingName
  )) || nodes.some((candidate) => (
    candidate.type === "AssignmentExpression" &&
    candidate.right?.type === "Identifier" &&
    candidate.right.name === bindingName &&
    coercionHookMember(candidate.left)
  ));
}

function coercionHookProperty(parent, node) {
  return (
    parent?.value === node &&
    ["Property", "MethodDefinition"].includes(parent.type) &&
    coercionHookKey(parent.key, parent.computed)
  );
}

function coercionHookKey(key, computed) {
  if (!computed && key?.type === "Identifier") {
    return ["toString", "valueOf"].includes(key.name);
  }
  if (key?.type === "Literal") {
    return ["toString", "valueOf"].includes(key.value);
  }
  return key?.type === "MemberExpression" &&
    key.object?.type === "Identifier" &&
    key.object.name === "Symbol" &&
    ((!key.computed && key.property?.name === "toPrimitive") ||
      (key.computed && key.property?.type === "Literal" && key.property.value === "toPrimitive"));
}

function coercionHookMember(node) {
  if (node?.type !== "MemberExpression") return false;
  if (!node.computed && ["toString", "valueOf"].includes(node.property?.name)) return true;
  if (node.computed && node.property?.type === "Literal") {
    return ["toString", "valueOf"].includes(node.property.value);
  }
  return coercionHookKey(node.property, true);
}

function nestedFunctionBindingName(node, parent) {
  if (node.type === "FunctionDeclaration") return node.id?.name;
  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
    return parent.id.name;
  }
  return node.id?.name;
}

function subtreeHasBranch(root) {
  if (!isAstNode(root)) return false;
  if (["IfStatement", "ConditionalExpression", "SwitchStatement"].includes(root.type)) return true;
  if (logicalAssignment(root)) return true;
  if (loopCondition(root)) return true;
  if (root.type === "LogicalExpression") return true;
  return astChildren(root).some(subtreeHasBranch);
}

function logicalAssignment(node) {
  return node?.type === "AssignmentExpression" &&
    ["&&=", "||=", "??="].includes(node.operator);
}

function findAstNode(root, predicate) {
  if (!isAstNode(root)) return undefined;
  if (predicate(root)) return root;
  for (const child of astChildren(root)) {
    const match = findAstNode(child, predicate);
    if (match) return match;
  }
  return undefined;
}

function isFunctionNode(node) {
  return ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node?.type);
}

function withinCollectedControlTest(node, parentByNode) {
  for (let current = node; current; current = parentByNode.get(current)) {
    const parent = parentByNode.get(current);
    if (!parent) return false;
    if (
      (parent.type === "IfStatement" || parent.type === "ConditionalExpression") &&
      parent.test?.start <= node.start && node.end <= parent.test?.end
    ) return true;
    const loopTest = loopCondition(parent);
    if (loopTest?.start <= node.start && node.end <= loopTest?.end) return true;
  }
  return false;
}

function loopCondition(node) {
  if (["WhileStatement", "DoWhileStatement", "ForStatement"].includes(node?.type)) {
    return node.test;
  }
  if (["ForInStatement", "ForOfStatement"].includes(node?.type)) return node.right;
  return undefined;
}

function astChildren(node) {
  const result = [];
  for (const [key, value] of Object.entries(node || {})) {
    if (["start", "end", "loc", "range", "raw", "regex"].includes(key)) continue;
    if (isAstNode(value)) result.push(value);
    else if (Array.isArray(value)) {
      for (const entry of value) if (isAstNode(entry)) result.push(entry);
    }
  }
  return result;
}

function isAstNode(value) {
  return Boolean(value && typeof value === "object" && typeof value.type === "string");
}

function normalizedCondition(condition) {
  return pruneUndefined({
    kind: condition.kind,
    value: condition.value,
    values: condition.values,
    origin: condition.operand,
    transforms: Array.isArray(condition.transforms) ? condition.transforms : [],
    predicate: condition.predicate,
    pattern: condition.pattern
  });
}

function sameConditionSequence(expected, observed) {
  return expected.length === observed.length && expected.every((condition, index) => (
    conditionKey(condition) === conditionKey(observed[index])
  ));
}

function conditionKey(condition) {
  return JSON.stringify({
    kind: condition.kind,
    value: condition.value,
    values: condition.values,
    origin: condition.origin
  });
}

function validCondition(condition, event) {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) return false;
  if (!["eq", "contains", "regex-set", "truthy"].includes(condition.kind)) return false;
  if (condition.kind === "regex-set") {
    if (!Array.isArray(condition.values) || !condition.values.length || condition.values.some((value) => typeof value !== "string")) {
      return false;
    }
  } else if (condition.kind === "truthy") {
    if (!["truthy", "falsy"].includes(condition.value)) return false;
  } else if (typeof condition.value !== "string") return false;
  return originAllowedForEvent(condition.origin, event);
}

function originAllowedForEvent(origin, event) {
  if (event === "onChange") return origin === "event:value";
  if (event === "onLoad") return typeof origin === "string" && /^field:[A-Za-z0-9_.-]+$/.test(origin);
  return false;
}

function invalid(reason, expected, observed) {
  return { ok: false, reason, expected, observed };
}

function pruneUndefined(value) {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, pruneUndefined(entry)])
  );
}
