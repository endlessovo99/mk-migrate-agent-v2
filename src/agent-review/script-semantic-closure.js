import { analyzeScriptFunction } from "../dsl/scripts.js";
import {
  buildConditionOperandResolver,
  parseProvenanceCondition
} from "../dsl/script-condition-provenance.js";
import { legacySourceFromGeneratedFunction } from "./row-marker-policy.js";

// This is intentionally a recognizer for the two reviewed script shapes used
// by tracked routes, not a JavaScript evaluator. Any condition, nesting, or
// call placement that cannot be associated statically with the source branch
// model returns `ok: false` and leaves the residual open.
export function validateAssignmentBranchSemantics({
  sourceFunction,
  reviewedFunction,
  residuals
}) {
  const expectedAssignments = (residuals || []).map(parseResidualAssignment);
  if (
    !expectedAssignments.length ||
    expectedAssignments.some((assignment) => !assignment.target || !assignment.valueSignature)
  ) {
    return invalid("assignment_evidence_unparseable");
  }

  const source = legacySourceFromGeneratedFunction(sourceFunction);
  const sourceModel = sourceAssignmentModel(source, expectedAssignments);
  if (!sourceModel.ok) return sourceModel;

  const targetModel = targetAssignmentModel(reviewedFunction, expectedAssignments);
  if (!targetModel.ok) return targetModel;

  if (!sameConditionSequence(sourceModel.conditions, targetModel.conditions)) {
    return invalid("condition_chain_changed", {
      expectedConditions: sourceModel.conditions,
      observedConditions: targetModel.conditions
    });
  }
  if (!sameBranchAssignments(sourceModel.branches, targetModel.branches)) {
    return invalid("assignment_branch_association_changed", {
      expectedBranches: sourceModel.branches,
      observedBranches: targetModel.branches
    });
  }
  return { ok: true };
}

export function validateRowMarkerBranchSemantics({
  sourceFunction,
  reviewedFunction,
  resolvedMarkers,
  primaryMarkerByAlias
}) {
  const resolved = new Set(resolvedMarkers || []);
  if (!resolved.size) return { ok: true };
  const canonicalTarget = (marker) => primaryMarkerByAlias.get(marker) || marker;
  const targetIds = new Set([...resolved].map(canonicalTarget));
  const source = legacySourceFromGeneratedFunction(sourceFunction);
  const sourceModel = sourceRowModel(source, resolved, canonicalTarget);
  if (!sourceModel.ok) return sourceModel;
  if (sourceModel.trivial === true) {
    const targetModel = targetTrivialRowModel(reviewedFunction, targetIds);
    if (!targetModel.ok) return targetModel;
    const stateMismatch = compareScenarioStates(sourceModel.states, targetModel.states);
    return stateMismatch
      ? invalid("row_branch_association_changed", stateMismatch)
      : { ok: true };
  }

  const conditional = targetConditionalRowModel(
    reviewedFunction,
    targetIds,
    sourceModel.conditions
  );
  const targetModel = conditional.ok
    ? conditional
    : targetTernaryRowModel(reviewedFunction, targetIds, sourceModel.conditions);
  if (!targetModel.ok) {
    return invalid("row_control_flow_unverified", {
      conditionalReason: conditional.reason,
      ternaryReason: targetModel.reason,
      conditionalDetails: conditional,
      ternaryDetails: targetModel
    });
  }
  if (!sameConditionSequence(sourceModel.conditions, targetModel.conditions)) {
    return invalid("row_condition_chain_changed", {
      expectedConditions: sourceModel.conditions,
      observedConditions: targetModel.conditions
    });
  }

  const stateMismatch = compareScenarioStates(sourceModel.states, targetModel.states);
  if (stateMismatch) {
    return invalid("row_branch_association_changed", stateMismatch);
  }
  return { ok: true };
}

function sourceAssignmentModel(source, expectedAssignments) {
  if (!source) return invalid("source_function_missing");
  const masked = maskStringsAndComments(source);
  const calls = legacyAssignmentCalls(source, masked);
  if (calls.length !== expectedAssignments.length) {
    return invalid("source_assignment_count_changed", {
      expectedCount: expectedAssignments.length,
      observedCount: calls.length
    });
  }
  const pairedCalls = calls.map((call, index) => ({
    ...call,
    target: expectedAssignments[index]?.target
  }));
  if (pairedCalls.some((call, index) => (
    call.valueSignature !== expectedAssignments[index]?.valueSignature
  ))) {
    return invalid("source_assignment_evidence_order_changed");
  }

  const candidate = selectSingleChain(source, masked, pairedCalls);
  if (!candidate.ok) return candidate;
  const model = assignmentBranchesForChain(
    candidate.chain,
    pairedCalls,
    masked,
    buildOperandResolver(source, masked)
  );
  if (!model.ok) return model;
  if (model.flattenedCallCount !== pairedCalls.length) {
    return invalid("source_assignment_outside_condition_chain");
  }
  return model;
}

function targetAssignmentModel(functionText, expectedAssignments) {
  const source = String(functionText || "");
  const masked = maskStringsAndComments(source);
  const functionBody = primaryFunctionBody(masked);
  if (!functionBody) return invalid("target_function_body_unparseable");
  const expectedTargets = new Set(expectedAssignments.map((assignment) => assignment.target));
  const allCalls = targetCalls(source, "MKXFORM.setValue");
  if (allCalls.some((call) => call.target === undefined)) {
    return invalid("dynamic_set_value_target");
  }
  const calls = allCalls.filter((call) => expectedTargets.has(call.target));
  if (calls.length !== expectedAssignments.length) {
    return invalid("target_assignment_count_changed", {
      expectedCount: expectedAssignments.length,
      observedCount: calls.length
    });
  }
  const candidate = selectSingleChain(source, masked, calls, functionBody.depth);
  if (!candidate.ok) return candidate;
  const model = assignmentBranchesForChain(
    candidate.chain,
    calls,
    masked,
    buildOperandResolver(source, masked)
  );
  if (!model.ok) return model;
  if (model.flattenedCallCount !== calls.length) {
    return invalid("target_assignment_outside_condition_chain");
  }
  return model;
}

function assignmentBranchesForChain(chain, calls, masked, resolveOperand) {
  const conditions = chain.branches.map((branch) => (
    conditionSpec(branch.condition, resolveOperand, branch.conditionStart)
  ));
  if (conditions.some((condition) => !condition)) {
    return invalid("condition_not_statically_supported");
  }
  const branches = chain.branches.map((branch) => assignmentSignatures(
    directCalls(calls, masked, branch.bodyStart, branch.bodyEnd, chain.depth + 1)
  ));
  if (!chain.elseBody) return invalid("assignment_else_branch_missing");
  branches.push(assignmentSignatures(
    directCalls(calls, masked, chain.elseBody.start, chain.elseBody.end, chain.depth + 1)
  ));
  if (branches.some((branch) => branch.length === 0)) {
    return invalid("assignment_branch_empty");
  }
  return {
    ok: true,
    conditions,
    branches,
    flattenedCallCount: branches.reduce((count, branch) => count + branch.length, 0)
  };
}

function assignmentSignatures(calls) {
  return calls.map((call) => `${call.target}:${call.valueSignature}`);
}

function sourceRowModel(source, resolved, canonicalTarget) {
  if (!source) return invalid("source_function_missing");
  const masked = maskStringsAndComments(source);
  const calls = legacyRowCalls(source, masked)
    .filter((call) => resolved.has(call.target))
    .map((call) => ({ ...call, target: canonicalTarget(call.target) }));
  if (!calls.length) return invalid("source_row_effects_missing");
  const candidate = selectSingleChain(source, masked, calls);
  if (!candidate.ok) {
    const attributesByState = new Map();
    for (const call of calls) {
      const key = `${call.target}:${attributeDimension(call.attribute)}`;
      if (!attributesByState.has(key)) attributesByState.set(key, new Set());
      attributesByState.get(key).add(call.attribute);
    }
    if (
      candidate.reason === "condition_chain_missing" &&
      [...attributesByState.values()].every((attributes) => attributes.size === 1)
    ) {
      return {
        ok: true,
        trivial: true,
        conditions: [],
        states: new Map([["always", applyRowCalls(calls)]])
      };
    }
    return candidate;
  }
  return rowModelForConditionalChain(candidate.chain, calls, masked, {
    allowPrelude: true,
    sourceMode: true,
    resolveOperand: buildOperandResolver(source, masked)
  });
}

function targetTrivialRowModel(functionText, targetIds) {
  const source = String(functionText || "");
  const masked = maskStringsAndComments(source);
  const functionBody = primaryFunctionBody(masked);
  if (!functionBody) return invalid("target_function_body_unparseable");
  const allCalls = targetCalls(source, "MKXFORM.setFieldAttr");
  if (allCalls.some((call) => call.target === undefined)) {
    return invalid("dynamic_set_field_attr_target");
  }
  const calls = allCalls.filter((call) => targetIds.has(call.target));
  if (!calls.length) return invalid("target_row_effects_missing");
  if (calls.some((call) => braceDepthAt(masked, call.index) !== functionBody.depth)) {
    return invalid("target_row_effect_not_top_level");
  }
  if (calls.some((call) => !Number.isInteger(call.attribute))) {
    return invalid("target_row_attribute_not_static");
  }
  const stateKeys = calls.map((call) => `${call.target}:${attributeDimension(call.attribute)}`);
  if (new Set(stateKeys).size !== stateKeys.length) {
    return invalid("target_row_state_enumerated");
  }
  return {
    ok: true,
    conditions: [],
    states: new Map([["always", applyRowCalls(calls)]])
  };
}

function targetConditionalRowModel(functionText, targetIds, expectedConditions) {
  const source = String(functionText || "");
  const masked = maskStringsAndComments(source);
  const functionBody = primaryFunctionBody(masked);
  if (!functionBody) return invalid("target_function_body_unparseable");
  const allCalls = targetCalls(source, "MKXFORM.setFieldAttr");
  if (allCalls.some((call) => call.target === undefined)) {
    return invalid("dynamic_set_field_attr_target");
  }
  const calls = allCalls.filter((call) => targetIds.has(call.target));
  if (!calls.length) return invalid("target_row_effects_missing");
  const candidate = selectSingleChain(source, masked, calls, functionBody.depth);
  if (!candidate.ok) return candidate;
  const model = rowModelForConditionalChain(candidate.chain, calls, masked, {
    allowPrelude: true,
    sourceMode: false,
    resolveOperand: buildOperandResolver(source, masked)
  });
  if (!model.ok) return model;
  if (!sameConditionSequence(expectedConditions, model.conditions)) {
    return invalid("target_row_condition_chain_changed", {
      expectedConditions,
      observedConditions: model.conditions
    });
  }
  return model;
}

function rowModelForConditionalChain(chain, calls, masked, options) {
  const conditions = chain.branches.map((branch) => (
    conditionSpec(branch.condition, options.resolveOperand, branch.conditionStart)
  ));
  if (conditions.some((condition) => !condition)) {
    return invalid("condition_not_statically_supported");
  }
  const block = enclosingBlock(masked, chain.start);
  if (!block) return invalid("condition_parent_block_unparseable");
  const prelude = options.allowPrelude
    ? directCalls(calls, masked, block.start + 1, chain.start, chain.depth)
    : [];
  const branchCalls = chain.branches.map((branch) => (
    directCalls(calls, masked, branch.bodyStart, branch.bodyEnd, chain.depth + 1)
  ));
  const elseCalls = chain.elseBody
    ? directCalls(calls, masked, chain.elseBody.start, chain.elseBody.end, chain.depth + 1)
    : [];
  const coveredCount = prelude.length + elseCalls.length +
    branchCalls.reduce((count, branch) => count + branch.length, 0);
  if (coveredCount !== calls.length) {
    return invalid("row_effect_outside_condition_chain");
  }
  if (branchCalls.some((branch) => branch.length === 0)) {
    return invalid("row_effect_branch_empty");
  }
  const allStateCalls = [...prelude, ...branchCalls.flat(), ...elseCalls];
  if (allStateCalls.some((call) => !Number.isInteger(call.attribute))) {
    return invalid(options.sourceMode
      ? "source_row_attribute_unparseable"
      : "target_row_attribute_not_static");
  }

  const states = new Map();
  conditions.forEach((condition, index) => {
    states.set(conditionKey(condition), applyRowCalls(prelude, branchCalls[index]));
  });
  if (chain.elseBody || prelude.length) {
    states.set("else", applyRowCalls(prelude, elseCalls));
  }
  return { ok: true, conditions, states };
}

function targetTernaryRowModel(functionText, targetIds, expectedConditions) {
  if (expectedConditions.some((condition) => condition.kind !== "eq")) {
    return invalid("ternary_mode_requires_equality_conditions");
  }
  const source = String(functionText || "");
  const masked = maskStringsAndComments(source);
  const functionBody = primaryFunctionBody(masked);
  if (!functionBody) return invalid("target_function_body_unparseable");
  const allCalls = targetCalls(source, "MKXFORM.setFieldAttr");
  if (allCalls.some((call) => call.target === undefined)) {
    return invalid("dynamic_set_field_attr_target");
  }
  const calls = allCalls.filter((call) => targetIds.has(call.target));
  if (!calls.length) return invalid("target_row_effects_missing");
  if (calls.some((call) => braceDepthAt(masked, call.index) !== functionBody.depth)) {
    return invalid("target_row_effect_not_top_level");
  }

  const resolveOperand = buildOperandResolver(source, masked);
  const aliases = conditionAliases(source, masked, functionBody.depth, resolveOperand);
  const expectedKeys = new Set(expectedConditions.map(conditionKey));
  const observedKeys = new Set([...aliases.values()].map(conditionKey));
  const missingKeys = [...expectedKeys].filter((key) => !observedKeys.has(key));
  if (
    missingKeys.length > 0 &&
    !guardedBinaryEqualityDomain(
      source,
      expectedConditions,
      observedKeys,
      resolveOperand
    )
  ) {
    return invalid("target_row_condition_alias_missing");
  }

  const compiledCalls = calls.map((call) => compileTernaryRowCall(call, aliases));
  if (compiledCalls.some((call) => !call)) {
    return invalid("target_row_ternary_unparseable");
  }
  const states = new Map();
  for (const condition of expectedConditions) {
    const key = conditionKey(condition);
    states.set(key, applyCompiledRowCalls(compiledCalls, key));
  }
  states.set("else", applyCompiledRowCalls(compiledCalls, "else"));
  return { ok: true, conditions: expectedConditions, states };
}

function compileTernaryRowCall(call, aliases) {
  const expression = String(call.attributeExpression || "").trim();
  if (/^[3-6]$/.test(expression)) {
    return { target: call.target, when: undefined, yes: Number(expression), no: Number(expression) };
  }
  const match = expression.match(/^([A-Za-z_$][\w$]*)\s*\?\s*([3-6])\s*:\s*([3-6])$/);
  const condition = match ? aliases.get(match[1]) : undefined;
  if (!condition) return undefined;
  const yes = Number(match[2]);
  const no = Number(match[3]);
  if (attributeDimension(yes) !== attributeDimension(no)) return undefined;
  return { target: call.target, when: conditionKey(condition), yes, no };
}

function applyCompiledRowCalls(calls, scenario) {
  const state = new Map();
  for (const call of calls) {
    const attribute = call.when === undefined || call.when === scenario ? call.yes : call.no;
    state.set(`${call.target}:${attributeDimension(attribute)}`, attribute);
  }
  return state;
}

function conditionAliases(source, masked, depth, resolveOperand) {
  const aliases = new Map();
  const pattern = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  for (const match of source.matchAll(pattern)) {
    if (!codeVisibleAt(masked, match.index) || braceDepthAt(masked, match.index) !== depth) continue;
    const condition = conditionSpec(match[2], resolveOperand, match.index);
    if (condition) aliases.set(match[1], condition);
  }
  return aliases;
}

function selectSingleChain(source, masked, calls, requiredDepth) {
  const candidates = conditionalChains(source, masked)
    .filter((chain) => requiredDepth === undefined || chain.depth === requiredDepth)
    .filter((chain) => chain.branches.some((branch) => (
      directCalls(calls, masked, branch.bodyStart, branch.bodyEnd, chain.depth + 1).length > 0
    )));
  if (candidates.length !== 1) {
    return invalid(candidates.length ? "multiple_condition_chains" : "condition_chain_missing", {
      candidateCount: candidates.length
    });
  }
  return { ok: true, chain: candidates[0] };
}

function conditionalChains(source, masked = maskStringsAndComments(source)) {
  const chains = [];
  for (let index = 0; index < masked.length; index += 1) {
    if (!isKeywordAt(masked, index, "if") || precededByElse(masked, index)) continue;
    const chain = parseConditionalChain(source, masked, index);
    if (chain) chains.push(chain);
  }
  return chains;
}

function parseConditionalChain(source, masked, start) {
  const branches = [];
  let branchStart = start;
  let end = start;
  while (branchStart >= 0) {
    const conditionOpen = skipWhitespace(masked, branchStart + 2);
    if (masked[conditionOpen] !== "(") return undefined;
    const conditionClose = findBalancedClose(masked, conditionOpen, "(", ")");
    if (conditionClose < 0) return undefined;
    const bodyOpen = skipWhitespace(masked, conditionClose + 1);
    if (masked[bodyOpen] !== "{") return undefined;
    const bodyClose = findBalancedClose(masked, bodyOpen, "{", "}");
    if (bodyClose < 0) return undefined;
    branches.push({
      condition: source.slice(conditionOpen + 1, conditionClose),
      conditionStart: conditionOpen + 1,
      bodyStart: bodyOpen + 1,
      bodyEnd: bodyClose
    });
    end = bodyClose + 1;

    const elseIndex = skipWhitespace(masked, bodyClose + 1);
    if (!isKeywordAt(masked, elseIndex, "else")) break;
    const afterElse = skipWhitespace(masked, elseIndex + 4);
    if (isKeywordAt(masked, afterElse, "if")) {
      branchStart = afterElse;
      continue;
    }
    if (masked[afterElse] !== "{") return undefined;
    const elseClose = findBalancedClose(masked, afterElse, "{", "}");
    if (elseClose < 0) return undefined;
    return {
      start,
      end: elseClose + 1,
      depth: braceDepthAt(masked, start),
      branches,
      elseBody: { start: afterElse + 1, end: elseClose }
    };
  }
  return { start, end, depth: braceDepthAt(masked, start), branches, elseBody: undefined };
}

function targetCalls(source, name) {
  return analyzeScriptFunction(source).calls
    .filter((call) => call.name === name)
    .map((call) => {
      const args = parseCallArguments(source, call.index, call.name);
      return {
        index: call.index,
        target: args ? staticStringValue(args[0]) : undefined,
        value: args?.[1]?.trim(),
        valueSignature: args ? valueExpressionSignature(args[1]) : undefined,
        attribute: args && /^[3-6]$/.test(args[1].trim()) ? Number(args[1].trim()) : undefined,
        attributeExpression: args?.[1]
      };
    });
}

function legacyAssignmentCalls(source, masked) {
  const calls = [];
  const pattern = /\b[A-Za-z_$][\w$]*(?:\s*\[\s*0\s*\])?\s*\.\s*value\s*=\s*([^;\n]+)/g;
  for (const match of source.matchAll(pattern)) {
    if (!codeVisibleAt(masked, match.index)) continue;
    calls.push({
      index: match.index,
      value: match[1].trim(),
      valueSignature: valueExpressionSignature(match[1])
    });
  }
  return calls;
}

function legacyRowCalls(source, masked) {
  const calls = [];
  const pattern = /\bcommon_dom_row_set_show_required_reset\(\s*(["'`])([^"'`]+)\1\s*,\s*(true|false)\s*,\s*(true|false)\s*,\s*(true|false)\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    if (!codeVisibleAt(masked, match.index)) continue;
    calls.push({
      index: match.index,
      target: match[2],
      visible: match[3] === "true",
      required: match[4] === "true",
      reset: match[5] === "true",
      attributes: [match[3] === "true" ? 5 : 4, match[4] === "true" ? 3 : 6]
    });
  }
  return calls.flatMap((call) => call.attributes.map((attribute) => ({
    index: call.index,
    target: call.target,
    attribute,
    reset: call.reset
  })));
}

function directCalls(calls, masked, start, end, depth) {
  return calls.filter((call) => (
    call.index >= start && call.index < end && braceDepthAt(masked, call.index) === depth
  ));
}

function applyRowCalls(...groups) {
  const state = new Map();
  for (const call of groups.flat()) {
    state.set(`${call.target}:${attributeDimension(call.attribute)}`, call.attribute);
  }
  return state;
}

function compareScenarioStates(expectedStates, observedStates) {
  for (const [scenario, expected] of expectedStates) {
    const observed = observedStates.get(scenario);
    if (!observed) return { scenario, reason: "scenario_missing" };
    for (const [key, value] of expected) {
      if (observed.get(key) !== value) {
        return {
          scenario,
          state: key,
          expected: value,
          observed: observed.get(key)
        };
      }
    }
  }
  return undefined;
}

function sameConditionSequence(left, right) {
  return left.length === right.length && left.every((condition, index) => (
    conditionKey(condition) === conditionKey(right[index])
  ));
}

function sameBranchAssignments(left, right) {
  return left.length === right.length && left.every((branch, index) => (
    branch.length === right[index].length &&
    branch.every((signature, assignmentIndex) => signature === right[index][assignmentIndex])
  ));
}

function buildOperandResolver(source, masked = maskStringsAndComments(source)) {
  void masked;
  return buildConditionOperandResolver(source);
}

function conditionSpec(expression, resolveOperand, beforeIndex) {
  const parsed = parseProvenanceCondition(expression, resolveOperand, { beforeIndex });
  return parsed && ["eq", "contains"].includes(parsed.kind) ? parsed : undefined;
}

function guardedBinaryEqualityDomain(source, expectedConditions, observedKeys, resolveOperand) {
  const expectedOperands = new Set(expectedConditions.map((condition) => condition.operand));
  if (
    expectedConditions.length !== 2 ||
    expectedConditions.some((condition) => condition.kind !== "eq") ||
    expectedOperands.size !== 1 ||
    observedKeys.size !== 1 ||
    (
      !observedKeys.has(conditionKey(expectedConditions[0])) &&
      !observedKeys.has(conditionKey(expectedConditions[1]))
    )
  ) {
    return false;
  }
  const expectedValues = new Set(expectedConditions.map((condition) => String(condition.value)));
  const guard = String(source || "").match(
    /\bif\s*\(\s*([A-Za-z_$][\w$]*)\s*!==?\s*(["'`])([^"'`]+)\2\s*&&\s*\1\s*!==?\s*(["'`])([^"'`]+)\4\s*\)\s*return\b/
  );
  return guard !== null &&
    expectedValues.size === 2 &&
    expectedValues.has(guard[3]) &&
    expectedValues.has(guard[5]) &&
    resolveOperand?.(guard[1], { beforeIndex: guard.index }) === expectedConditions[0].operand;
}

function conditionKey(condition) {
  return `${condition.operand}:${condition.kind}:${JSON.stringify(condition.value)}`;
}

function attributeDimension(attribute) {
  if (attribute === 4 || attribute === 5) return "visible";
  if (attribute === 3 || attribute === 6) return "required";
  return "unknown";
}

function parseResidualAssignment(residual) {
  const evidence = String(residual?.evidence || "").trim();
  const match = evidence.match(/\.\s*value\s*=\s*([\s\S]+?)\s*;?$/);
  const value = match?.[1]?.trim();
  return {
    target: typeof residual?.target === "string" && residual.target.trim()
      ? residual.target
      : undefined,
    valueSignature: valueExpressionSignature(value)
  };
}

function parseCallArguments(source, callIndex, callName) {
  let index = callIndex + callName.length;
  while (/\s/.test(source[index] || "")) index += 1;
  if (source[index] !== "(") return undefined;
  const close = findBalancedClose(maskStringsAndComments(source), index, "(", ")");
  if (close < 0) return undefined;
  const args = [];
  let start = index + 1;
  let parenDepth = 1;
  let bracketDepth = 0;
  let braceDepth = 0;
  const masked = maskStringsAndComments(source);
  for (let cursor = index + 1; cursor < close; cursor += 1) {
    const char = masked[cursor];
    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    else if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "," && parenDepth === 1 && bracketDepth === 0 && braceDepth === 0) {
      args.push(source.slice(start, cursor).trim());
      start = cursor + 1;
    }
  }
  args.push(source.slice(start, close).trim());
  return args;
}

function valueExpressionSignature(expression) {
  if (typeof expression !== "string" || !expression.trim()) return undefined;
  const text = expression.trim().replace(/;\s*$/, "").trim();
  const stringValue = staticStringValue(text);
  if (stringValue !== undefined) return `string:${JSON.stringify(stringValue)}`;
  if (/^(?:true|false|null|undefined|-?(?:\d+(?:\.\d*)?|\.\d+))$/.test(text)) {
    return `primitive:${text}`;
  }
  return undefined;
}

function staticStringValue(expression) {
  if (typeof expression !== "string" || expression.length < 2) return undefined;
  const text = expression.trim();
  const quote = text[0];
  if (!["'", "\"", "`"].includes(quote) || text.at(-1) !== quote) return undefined;
  if (quote === "`" && text.includes("${")) return undefined;
  try {
    if (quote === "\"") return JSON.parse(text);
  } catch {
    return undefined;
  }
  let output = "";
  for (let index = 1; index < text.length - 1; index += 1) {
    if (text[index] !== "\\") {
      output += text[index];
      continue;
    }
    index += 1;
    if (index >= text.length - 1) return undefined;
    const escaped = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" }[text[index]];
    output += escaped === undefined ? text[index] : escaped;
  }
  return output;
}

function primaryFunctionBody(masked) {
  const match = /\bfunction\b[^\n{]*\([^)]*\)\s*\{/.exec(masked);
  if (!match) return undefined;
  const open = masked.indexOf("{", match.index);
  const close = findBalancedClose(masked, open, "{", "}");
  if (close < 0) return undefined;
  return { start: open + 1, end: close, depth: braceDepthAt(masked, open) + 1 };
}

function enclosingBlock(masked, index) {
  const stack = [];
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (masked[cursor] === "{") stack.push(cursor);
    else if (masked[cursor] === "}") stack.pop();
  }
  const start = stack.at(-1);
  if (start === undefined) return { start: -1, end: masked.length };
  const end = findBalancedClose(masked, start, "{", "}");
  return end < 0 ? undefined : { start, end };
}

function braceDepthAt(masked, index) {
  let depth = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (masked[cursor] === "{") depth += 1;
    else if (masked[cursor] === "}") depth -= 1;
  }
  return depth;
}

function maskStringsAndComments(source) {
  let output = "";
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        output += "\n";
      } else output += " ";
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 1;
        blockComment = false;
      } else output += char === "\n" ? "\n" : " ";
      continue;
    }
    if (quote) {
      if (char === "\\") {
        output += "  ";
        index += 1;
      } else if (char === quote) {
        output += " ";
        quote = "";
      } else output += char === "\n" ? "\n" : " ";
      continue;
    }
    if (char === "/" && next === "/") {
      output += "  ";
      index += 1;
      lineComment = true;
    } else if (char === "/" && next === "*") {
      output += "  ";
      index += 1;
      blockComment = true;
    } else if (["'", "\"", "`"].includes(char)) {
      output += " ";
      quote = char;
    } else output += char;
  }
  return output;
}

function stripOuterParentheses(expression) {
  let text = expression;
  while (text.startsWith("(")) {
    const masked = maskStringsAndComments(text);
    const close = findBalancedClose(masked, 0, "(", ")");
    if (close !== text.length - 1) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

function findBalancedClose(text, openIndex, openChar, closeChar) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === openChar) depth += 1;
    else if (text[index] === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function skipWhitespace(text, index) {
  let cursor = index;
  while (/\s/.test(text[cursor] || "")) cursor += 1;
  return cursor;
}

function isKeywordAt(text, index, keyword) {
  return text.slice(index, index + keyword.length) === keyword &&
    !/[A-Za-z0-9_$]/.test(text[index - 1] || "") &&
    !/[A-Za-z0-9_$]/.test(text[index + keyword.length] || "");
}

function precededByElse(masked, index) {
  const prefix = masked.slice(0, index);
  return /\belse\s*$/.test(prefix);
}

function codeVisibleAt(masked, index) {
  return masked[index] !== " ";
}

function invalid(reason, details = {}) {
  return { ok: false, reason, ...details };
}
