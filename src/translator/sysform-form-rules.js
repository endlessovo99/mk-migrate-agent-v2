import { parse, tokenizer } from "acorn";
import {
  buildConditionOperandResolver,
  parseProvenanceCondition
} from "../dsl/script-condition-provenance.js";
import { nativeFormRuleProjectionRef } from "../dsl/native-form-rule-projection.js";
import { isProvablyInertVariableDeclaration } from "./pure-declarations.js";
import { inlineOnChangeSourceActionKey } from "./source-action-key.js";

const VALUE_CHANGE_API = "AttachXFormValueChangeEventById";
const ROW_EFFECT_HELPER = "common_dom_row_set_show_required_reset";

export function sourceFormRulesFromLegacyScripts(scripts) {
  const sources = Array.isArray(scripts?.sources) ? scripts.sources : [];
  const linkageById = new Map();

  for (const source of sources) {
    if (source.displayGate === "xform:viewShow") continue;
    for (const rule of analyzeLegacyScriptFormRules(source).linkage) {
      mergeLinkageRule(
        linkageById,
        rule,
        JSON.stringify([
          source.sourceRef || source.id || "source-unproven",
          rule.meta?.sourceActionKey || "action-unproven",
          rule.id
        ])
      );
    }
  }

  const linkage = globallyUniqueRuleIds([...linkageById.entries()]);
  if (!linkage.length) return undefined;
  return {
    linkage,
    validations: [],
    impliedRequired: [],
    review: {}
  };
}

function globallyUniqueRuleIds(entries) {
  const counts = new Map();
  for (const [, rule] of entries) {
    const baseId = rule.meta?.sourceRuleIds?.[0] || rule.id;
    counts.set(baseId, (counts.get(baseId) || 0) + 1);
  }
  return entries.map(([, rule]) => {
    const baseId = rule.meta?.sourceRuleIds?.[0] || rule.id;
    if (counts.get(baseId) > 1) return rule;
    return {
      ...rule,
      id: baseId,
      meta: {
        ...rule.meta,
        sourceRuleIds: [rule.id]
      }
    };
  });
}

export function analyzeLegacyScriptFormRules(source) {
  const javascript = source?.javascript || "";
  const callbackExtraction = extractXFormValueChangeCallbacks(javascript, source);
  const callbacks = callbackExtraction.callbacks;
  const linkageById = new Map();
  const conflictedRuleIds = new Set();
  const provenRowEffectCallStarts = provenUnshadowedDirectCallStarts(
    javascript,
    ROW_EFFECT_HELPER
  );
  const untranslatedRowEffects = callbackExtraction.unprovenBindings.map((binding) => residual({
    code: "script.residual.value_change_binding_unproven",
    type: "valueChangeBindingUnproven",
    message: `${VALUE_CHANGE_API} is not proven to be the unshadowed platform global at this call site.`,
    sourceRef: source.sourceRef,
    trigger: binding.trigger,
    evidence: binding.evidence
  }));

  for (const callback of callbacks) {
    const resolveOperand = buildConditionOperandResolver(callback.body, {
      eventParameter: callback.parameter
    });
    let loweredRowCallCount = 0;
    const nativeChainStarts = new Set();
    const rowEffectContext = {
      absoluteBodyStart: callback.bodyStart,
      provenCallStarts: provenRowEffectCallStarts
    };
    for (const chain of extractTopLevelConditionalChains(callback.body)) {
      const conditionSourceUnproven = chain.branches.some((branch) => !conditionSpec(
        branch.condition,
        callback.source,
        resolveOperand,
        branch.conditionStart
      ));
      const rules = conditionSourceUnproven
        ? []
        : lowerConditionalChain(
            chain,
            callback.source,
            source,
            resolveOperand,
            callback.sourceActionKey,
            rowEffectContext
          );
      if (
        conditionSourceUnproven &&
        !isScaffoldingOnlyConditionalChain(chain, resolveOperand)
      ) {
        untranslatedRowEffects.push(residual({
          code: "script.residual.form_rule_condition_source_unproven",
          type: "formRuleConditionSourceUnproven",
          message: "The branch condition cannot be proven to derive from this onChange action input.",
          sourceRef: source.sourceRef,
          trigger: callback.source,
          evidence: oneLine(chain.branches.map((branch) => branch.condition).join(" | "))
        }));
      }
      if (rules.length) {
        loweredRowCallCount += countDirectRowEffectCallsInChain(chain, rowEffectContext);
        nativeChainStarts.add(chain.start);
      }
      for (const rule of rules) {
        if (conflictedRuleIds.has(rule.id)) continue;
        const existing = linkageById.get(rule.id);
        if (
          existing &&
          existing.meta?.sourceActionKey !== rule.meta?.sourceActionKey
        ) {
          linkageById.delete(rule.id);
          conflictedRuleIds.add(rule.id);
          untranslatedRowEffects.push(residual({
            code: "script.residual.form_rule_action_identity_collision",
            type: "formRuleActionIdentityCollision",
            message: "Equivalent native-rule ids were produced by different source callbacks and cannot be assigned to one action.",
            sourceRef: source.sourceRef,
            trigger: callback.source,
            evidence: rule.id
          }));
          continue;
        }
        mergeLinkageRule(linkageById, rule);
        if (linkageRuleHasConflictingBranchEffects(linkageById.get(rule.id))) {
          linkageById.delete(rule.id);
          conflictedRuleIds.add(rule.id);
          untranslatedRowEffects.push(residual({
            code: "script.residual.form_rule_effect_conflict",
            type: "formRuleEffectConflict",
            message: "One native rule branch writes conflicting values to the same target dimension.",
            sourceRef: source.sourceRef,
            trigger: callback.source,
            evidence: rule.id
          }));
        }
      }
    }
    const sourceRowCallCount = countRowEffectCalls(callback.body);
    if (loweredRowCallCount < sourceRowCallCount) {
      untranslatedRowEffects.push(residual({
        code: "script.residual.form_rule_chain_untranslated",
        type: "formRuleChainUntranslated",
        message: `${sourceRowCallCount - loweredRowCallCount} of ${sourceRowCallCount} row visibility/required calls could not be represented by native formRules.`,
        sourceRef: source.sourceRef,
        trigger: callback.source,
        evidence: `${loweredRowCallCount}/${sourceRowCallCount} row visibility/required calls lowered for ${callback.source}`
      }));
    }
    const uncoveredBehavior = uncoveredNativeCallbackBehavior(
      callback.body,
      nativeChainStarts,
      resolveOperand
    );
    if (uncoveredBehavior.length) {
      untranslatedRowEffects.push(residual({
        code: "script.residual.form_rule_behavior_uncovered",
        type: "formRuleBehaviorUncovered",
        message: "The onChange callback contains behavior outside the proven native row-rule projection.",
        sourceRef: source.sourceRef,
        trigger: callback.source,
        evidence: uncoveredBehavior.slice(0, 3).join(" | ")
      }));
    }
  }

  return {
    linkage: [...linkageById.values()].map(actionScopedRule),
    residuals: [...extractScriptResiduals(source), ...untranslatedRowEffects]
  };
}

function actionScopedRule(rule) {
  const identity = JSON.stringify([
    rule.meta?.sourceJsp || "source-unproven",
    rule.meta?.sourceActionKey || "action-unproven",
    rule.id
  ]);
  return {
    ...rule,
    id: `${rule.id}.origin.~${Buffer.from(identity, "utf8").toString("hex")}`,
    meta: {
      ...rule.meta,
      sourceRuleIds: [rule.id]
    }
  };
}

function linkageRuleHasConflictingBranchEffects(rule) {
  return [rule?.effects, rule?.else].some((effects) => {
    const valuesByTarget = new Map();
    for (const effect of Array.isArray(effects) ? effects : []) {
      const key = `${effect?.type || ""}:${effect?.target || ""}`;
      if (!valuesByTarget.has(key)) valuesByTarget.set(key, new Set());
      valuesByTarget.get(key).add(effect?.value);
    }
    return [...valuesByTarget.values()].some((values) => values.size > 1);
  });
}

function lowerConditionalChain(
  chain,
  field,
  source,
  resolveOperand,
  sourceActionKey,
  rowEffectContext
) {
  // A conditional chain is one ordered behavior. Emitting native rules for
  // only the reset=false/literal subset lets those independent rules race the
  // residual script and can reverse the legacy final state. Require every row
  // helper call in the chain to be directly representable before lowering any
  // part of it.
  if (
    countDirectRowEffectCallsInChain(chain, rowEffectContext) !==
    countRowEffectCallsInChain(chain)
  ) {
    return [];
  }
  const branches = chain.branches.map((branch) => ({
    condition: conditionSpec(branch.condition, field, resolveOperand, branch.conditionStart),
    effects: extractDirectRowEffects(branch.body, rowEffectContext, branch.bodyStart)
  }));
  const elseEffects = extractDirectRowEffects(
    chain.elseBody,
    rowEffectContext,
    chain.elseBodyStart
  );
  if (
    !branches.length ||
    branches.some((branch) => !branch.condition || !branch.effects.length) ||
    !elseEffects.length
  ) return [];

  const runWhen = runWhenFromDisplayGate(source.displayGate);
  const meta = pruneUndefined({
    sourceJsp: source.sourceRef,
    displayGate: source.displayGate,
    runWhen,
    conditionSource: "event:value",
    sourceActionKey,
    nativeProjection: runWhen ? nativeFormRuleProjectionRef() : undefined
  });

  if (branches.length === 1) {
    const [{ condition, effects }] = branches;
    if (!effectValueMap(effects) || !effectValueMap(elseEffects)) return [];
    return [{
      id: `linkage.${field}.${condition.idPart}`,
      trigger: "change",
      source: field,
      logic: condition.logic,
      when: condition.when,
      effects,
      else: elseEffects,
      meta: { ...meta, conditionSemantics: condition.semantics },
      translationStatus: "executable"
    }];
  }

  // NewOA evaluates every native rule independently. Lower a chain as deltas
  // from its final else baseline so non-matching rules cannot overwrite the
  // active branch. Fail closed unless each state key has a complete baseline
  // and is changed by at most one branch.
  if (branches.some((branch) => branch.condition.when.length !== 1)) return [];
  const baseline = effectValueMap(elseEffects);
  if (!baseline) return [];
  const baselineDeltaGroup = [
    "baseline-delta",
    source.sourceRef,
    field,
    ...branches.map((branch) => branch.condition.idPart)
  ].filter(Boolean).join(":");
  const branchDeltas = [];
  const changedKeys = new Set();
  for (const branch of branches) {
    const values = effectValueMap(branch.effects);
    if (!values || values.size !== baseline.size) return [];
    if ([...baseline.keys()].some((key) => !values.has(key))) return [];
    const effects = branch.effects.filter((effect) =>
      effect.value !== baseline.get(effectKey(effect))
    );
    if (!effects.length) return [];
    for (const effect of effects) {
      const key = effectKey(effect);
      if (changedKeys.has(key)) return [];
      changedKeys.add(key);
    }
    branchDeltas.push({
      ...branch,
      effects,
      elseEffects: effects.map((effect) => ({
        ...effect,
        value: baseline.get(effectKey(effect))
      }))
    });
  }
  // A dimension can be explicitly written to the same value in every branch
  // (for example file_row.required=false). It still belongs to the source
  // behavior, but it does not produce a delta against the final else
  // baseline. Attach each such constant dimension to the first mutually
  // exclusive rule with the same value in both branches so the native rules
  // preserve it without introducing another independent writer.
  const constantEffects = elseEffects.filter((effect) => !changedKeys.has(effectKey(effect)));
  if (branchDeltas.length && constantEffects.length) {
    branchDeltas[0].effects.push(...constantEffects);
    branchDeltas[0].elseEffects.push(...constantEffects);
    for (const effect of constantEffects) changedKeys.add(effectKey(effect));
  }
  if (changedKeys.size !== baseline.size) return [];

  const inversePrefix = [];
  const inverseSemantics = [];
  const rules = [];
  for (const { condition, effects, elseEffects: branchElse } of branchDeltas) {
    const clause = condition.when[0];
    const inverse = invertConditionClause(clause);
    if (!inverse) return [];
    const when = [...inversePrefix, clause];
    rules.push({
      id: `linkage.${field}.${when.map(conditionClauseIdPart).join(".and.")}`,
      trigger: "change",
      source: field,
      logic: "and",
      when,
      effects,
      else: branchElse,
      meta: {
        ...meta,
        baselineDeltaGroup,
        conditionSemantics: [...inverseSemantics, condition.semantics[0]]
      },
      translationStatus: "executable"
    });
    inversePrefix.push(inverse);
    inverseSemantics.push(condition.semantics[0]);
  }
  return rules;
}

function effectValueMap(effects) {
  const values = new Map();
  for (const effect of effects || []) {
    const key = effectKey(effect);
    if (!key || values.has(key)) return undefined;
    values.set(key, effect.value);
  }
  return values;
}

function effectKey(effect) {
  return effect?.type && effect?.target ? `${effect.type}:${effect.target}` : undefined;
}

function conditionClauseIdPart(clause) {
  const value = Array.isArray(clause?.value) ? clause.value.join("_") : clause?.value;
  return `${stableIdPart(clause?.op)}${value === undefined ? "" : `.${stableIdPart(value)}`}`;
}

function invertConditionClause(clause) {
  const inverse = {
    eq: "ne",
    ne: "eq",
    contains: "notContains",
    notContains: "contains",
    empty: "notEmpty",
    notEmpty: "empty"
  }[clause?.op];
  return inverse ? { ...clause, op: inverse } : undefined;
}

function mergeLinkageRule(linkageById, rule, identity = rule.id) {
  const existing = linkageById.get(identity);
  if (!existing) {
    const next = {
      ...rule,
      effects: dedupeEffects(rule.effects)
    };
    if (Array.isArray(rule.else)) next.else = dedupeEffects(rule.else);
    linkageById.set(identity, next);
    return;
  }

  existing.effects = mergeEffects(existing.effects, rule.effects);
  if (Array.isArray(rule.else)) existing.else = mergeEffects(existing.else, rule.else);
  existing.meta = mergeRuleMeta(existing.meta, rule.meta);
}

function mergeRuleMeta(left = {}, right = {}) {
  const sourceJsps = uniqueStrings([
    left.sourceJsp,
    ...(left.sourceJsps || []),
    right.sourceJsp,
    ...(right.sourceJsps || [])
  ]);
  return {
    ...left,
    ...right,
    sourceJsp: left.sourceJsp || right.sourceJsp,
    sourceJsps: sourceJsps.length > 1 ? sourceJsps : undefined
  };
}

function mergeEffects(left = [], right = []) {
  return dedupeEffects([...(left || []), ...(right || [])]);
}

function dedupeEffects(effects = []) {
  const result = [];
  const seen = new Set();
  for (const effect of effects || []) {
    addEffect(result, seen, effect);
  }
  return result;
}

function extractScriptResiduals(source = {}) {
  const javascript = source.javascript || "";
  return [
    ...extractFieldValueAssignmentResiduals(javascript, source),
    ...extractUnsupportedEventResiduals(javascript, source)
  ];
}

function extractFieldValueAssignmentResiduals(javascript, source) {
  const text = String(javascript || "");
  const events = [];
  const declarations = /(?:^|[^\w$])(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*GetXFormFieldById\(\s*(["'])([^"']+)\2\s*\)(?:\s*\[\s*0\s*\])?/g;
  for (const match of text.matchAll(declarations)) {
    events.push({
      kind: "declaration",
      index: match.index,
      variable: match[1],
      target: match[3]
    });
  }
  const assignments = /([A-Za-z_$][\w$]*)(?:\s*\[\s*0\s*\])?\s*\.\s*value\s*=\s*([^;\n]+)/g;
  for (const match of text.matchAll(assignments)) {
    events.push({
      kind: "assignment",
      index: match.index,
      variable: match[1],
      evidence: match[0]
    });
  }
  events.sort((left, right) => left.index - right.index);

  const variables = new Map();
  const residuals = [];
  for (const event of events) {
    if (event.kind === "declaration") {
      variables.set(event.variable, event.target);
      continue;
    }
    const target = variables.get(event.variable);
    if (!target) continue;
    residuals.push(residual({
      code: "script.residual.field_value_assignment",
      type: "fieldValueAssignment",
      message: `Field value assignment for ${target} is not represented by native formRules.`,
      sourceRef: source.sourceRef,
      target,
      evidence: oneLine(event.evidence)
    }));
  }
  return residuals;
}

function extractUnsupportedEventResiduals(javascript, source) {
  const residuals = [];
  const text = String(javascript || "");
  const namedValueChange = /AttachXFormValueChangeEventById\(\s*(["'])([^"']+)\1\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
  for (const match of text.matchAll(namedValueChange)) {
    residuals.push(residual({
      code: "script.residual.named_value_change_callback",
      type: "namedValueChangeCallback",
      message: `Named value-change callback ${match[3]} for ${match[2]} requires manual script translation.`,
      sourceRef: source.sourceRef,
      trigger: match[2],
      callback: match[3],
      evidence: oneLine(match[0])
    }));
  }

  const loadListener = /Com_AddEventListener\(\s*window\s*,\s*(["'])load\1/g;
  for (const match of text.matchAll(loadListener)) {
    residuals.push(residual({
      code: "script.residual.window_load_listener",
      type: "windowLoadListener",
      message: "Window load listener is not represented by native formRules.",
      sourceRef: source.sourceRef,
      evidence: oneLine(text.slice(match.index, Math.min(text.length, match.index + 160)))
    }));
  }
  return residuals;
}

function residual(input) {
  return pruneUndefined({
    code: input.code,
    type: input.type,
    message: input.message,
    sourceRef: input.sourceRef,
    target: input.target,
    trigger: input.trigger,
    callback: input.callback,
    evidence: input.evidence
  });
}

function extractXFormValueChangeCallbacks(javascript, source = {}) {
  const callbacks = [];
  const unprovenBindings = [];
  const pattern = /AttachXFormValueChangeEventById\(\s*(["'])([^"']+)\1\s*,\s*function\s*\(([^)]*)\)\s*\{/g;
  const codeMask = javascriptCodeMask(javascript);
  const platformCallStarts = provenPlatformValueChangeCallStarts(javascript);

  for (const match of javascript.matchAll(pattern)) {
    if (!codeMask.startsWith("AttachXFormValueChangeEventById", match.index)) continue;
    if (!platformCallStarts.has(match.index)) {
      unprovenBindings.push({
        trigger: match[2],
        evidence: oneLine(javascript.slice(match.index, Math.min(javascript.length, match.index + 180)))
      });
      continue;
    }
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findBalancedClose(codeMask, bodyStart - 1, "{", "}");
    if (bodyEnd < bodyStart) continue;
    callbacks.push({
      source: match[2],
      parameter: firstParameter(match[3]),
      sourceActionKey: source.sourceActionKey || inlineOnChangeSourceActionKey(
        source.sourceRef || source.id,
        match.index
      ),
      bodyStart,
      body: javascript.slice(bodyStart, bodyEnd)
    });
  }

  return { callbacks, unprovenBindings };
}

function firstParameter(parameters) {
  const first = String(parameters || "").split(",")[0]?.trim();
  return /^[A-Za-z_$][\w$]*$/.test(first) ? first : undefined;
}

function extractTopLevelConditionalChains(body) {
  const chains = [];
  const codeMask = javascriptCodeMask(body);
  let cursor = 0;

  while (cursor < body.length) {
    const nextIf = findNextTopLevelIf(codeMask, cursor);
    if (nextIf < 0) break;
    const branches = [];
    let elseBody = "";
    let elseBodyStart = 0;
    let branchStart = nextIf;
    let chainEnd = nextIf + 2;

    while (branchStart >= 0) {
      const conditionOpen = codeMask.indexOf("(", branchStart + 2);
      if (conditionOpen < 0) break;
      const conditionClose = findBalancedClose(codeMask, conditionOpen, "(", ")");
      if (conditionClose < 0) break;
      const thenOpen = skipWhitespace(codeMask, conditionClose + 1);
      if (codeMask[thenOpen] !== "{") break;
      const thenClose = findBalancedClose(codeMask, thenOpen, "{", "}");
      if (thenClose < 0) break;
      branches.push({
        condition: body.slice(conditionOpen + 1, conditionClose),
        conditionStart: conditionOpen + 1,
        bodyStart: thenOpen + 1,
        body: body.slice(thenOpen + 1, thenClose)
      });
      chainEnd = thenClose + 1;

      const afterThen = skipWhitespace(codeMask, thenClose + 1);
      if (!isKeywordAt(codeMask, afterThen, "else")) break;
      const afterElse = skipWhitespace(codeMask, afterThen + 4);
      if (isKeywordAt(codeMask, afterElse, "if")) {
        branchStart = afterElse;
        continue;
      }
      if (codeMask[afterElse] === "{") {
        const elseClose = findBalancedClose(codeMask, afterElse, "{", "}");
        if (elseClose >= 0) {
          elseBodyStart = afterElse + 1;
          elseBody = body.slice(afterElse + 1, elseClose);
          chainEnd = elseClose + 1;
        }
      }
      break;
    }

    if (branches.length) chains.push({
      start: nextIf,
      end: chainEnd,
      branches,
      elseBody,
      elseBodyStart
    });
    cursor = Math.max(chainEnd, nextIf + 2);
  }

  return chains;
}

export function provenPlatformValueChangeCallStarts(javascript = "") {
  return provenUnshadowedDirectCallStarts(javascript, VALUE_CHANGE_API);
}

function provenUnshadowedDirectCallStarts(javascript, functionName) {
  const text = String(javascript || "");
  let ast;
  try {
    ast = parse(text, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowHashBang: true
    });
  } catch {
    return new Set();
  }
  const resolver = buildConditionOperandResolver(text);
  const starts = new Set();
  walkJavaScriptAst(ast, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === functionName &&
      resolver.isUnshadowedGlobal(functionName, node.callee.start)
    ) {
      starts.add(node.callee.start);
    }
  });
  return starts;
}

function uncoveredNativeCallbackBehavior(body, nativeChainStarts, resolveOperand) {
  if (!nativeChainStarts.size) return [];
  let ast;
  try {
    ast = parse(String(body || ""), {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true
    });
  } catch {
    return [oneLine(body)];
  }

  const uncovered = [];
  for (const statement of ast.body) {
    if (statement.type === "IfStatement" && nativeChainStarts.has(statement.start)) {
      collectUncoveredNativeConditionalStatements(statement, body, resolveOperand, uncovered);
      continue;
    }
    if (isCoveredCallbackStatement(statement, body, resolveOperand)) continue;
    uncovered.push(oneLine(body.slice(statement.start, statement.end)));
  }
  return uncovered.filter(Boolean);
}

function collectUncoveredNativeConditionalStatements(statement, body, resolveOperand, uncovered) {
  collectUncoveredNativeBranchStatements(statement.consequent, body, resolveOperand, uncovered);
  let alternate = statement.alternate;
  while (alternate?.type === "IfStatement") {
    collectUncoveredNativeBranchStatements(alternate.consequent, body, resolveOperand, uncovered);
    alternate = alternate.alternate;
  }
  if (alternate) collectUncoveredNativeBranchStatements(alternate, body, resolveOperand, uncovered);
}

function collectUncoveredNativeBranchStatements(statement, body, resolveOperand, uncovered) {
  const statements = statement?.type === "BlockStatement" ? statement.body : [statement];
  for (const child of statements.filter(Boolean)) {
    if (isNativeRowEffectStatement(child, resolveOperand)) continue;
    if (isCoveredCallbackStatement(child, body, resolveOperand)) continue;
    uncovered.push(oneLine(body.slice(child.start, child.end)));
  }
}

function isCoveredCallbackStatement(statement, body, resolveOperand) {
  if (!statement || statement.type === "EmptyStatement" || statement.directive) return true;
  if (statement.type === "BreakStatement" || statement.type === "ContinueStatement") return true;
  if (statement.type === "ExpressionStatement") {
    return isScaffoldingExpressionStatement(statement.expression);
  }
  if (statement.type === "VariableDeclaration") {
    const source = body.slice(statement.start, statement.end);
    if (isProvablyInertVariableDeclaration(source)) return true;
    if (isScaffoldingVariableDeclaration(statement)) return true;
    return statement.declarations.every((declaration) => {
      if (declaration.id?.type !== "Identifier") return false;
      if (!declaration.init) return true;
      const trace = resolveOperand.trace(
        body.slice(declaration.init.start, declaration.init.end),
        { beforeIndex: declaration.init.start }
      );
      return trace?.origin === "event:value";
    });
  }
  if (statement.type === "ForStatement" || statement.type === "WhileStatement") {
    return isScaffoldingLoopStatement(statement, body, resolveOperand);
  }
  if (statement.type === "IfStatement") {
    return isScaffoldingOnlyIfStatement(statement, body, resolveOperand);
  }
  return false;
}

function isScaffoldingOnlyConditionalChain(chain, resolveOperand) {
  const bodies = [
    ...(Array.isArray(chain?.branches) ? chain.branches.map((branch) => branch.body) : []),
    ...(chain?.elseBody ? [chain.elseBody] : [])
  ].filter((body) => String(body || "").trim());
  if (!bodies.length) return false;
  return bodies.every((bodyText) => isScaffoldingOnlyBodyText(bodyText, resolveOperand));
}

function isScaffoldingOnlyBodyText(bodyText, resolveOperand) {
  let ast;
  try {
    ast = parse(String(bodyText || ""), {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true
    });
  } catch {
    return false;
  }
  const statements = ast.body.filter((statement) => statement.type !== "EmptyStatement");
  if (!statements.length) return false;
  return statements.every((statement) => {
    if (isNativeRowEffectStatement(statement, resolveOperand)) return false;
    return isCoveredCallbackStatement(statement, bodyText, resolveOperand);
  });
}

function isScaffoldingOnlyIfStatement(statement, body, resolveOperand) {
  if (isNativeRowEffectStatement(statement.consequent, resolveOperand)) return false;
  if (!isScaffoldingBranchBody(statement.consequent, body, resolveOperand)) return false;
  let alternate = statement.alternate;
  while (alternate?.type === "IfStatement") {
    if (!isScaffoldingBranchBody(alternate.consequent, body, resolveOperand)) return false;
    alternate = alternate.alternate;
  }
  if (alternate && !isScaffoldingBranchBody(alternate, body, resolveOperand)) return false;
  return true;
}

function isScaffoldingBranchBody(statement, body, resolveOperand) {
  const statements = statement?.type === "BlockStatement"
    ? statement.body
    : [statement];
  const filtered = statements.filter(Boolean).filter((child) => child.type !== "EmptyStatement");
  if (!filtered.length) return false;
  return filtered.every((child) => {
    if (isNativeRowEffectStatement(child, resolveOperand)) return false;
    return isCoveredCallbackStatement(child, body, resolveOperand);
  });
}

function isScaffoldingLoopStatement(statement, body, resolveOperand) {
  const loopBody = statement.body;
  const statements = loopBody?.type === "BlockStatement" ? loopBody.body : [loopBody];
  const filtered = (statements || []).filter(Boolean).filter((child) => child.type !== "EmptyStatement");
  if (!filtered.length) return false;
  return filtered.every((child) => {
    if (isNativeRowEffectStatement(child, resolveOperand)) return false;
    return isCoveredCallbackStatement(child, body, resolveOperand);
  });
}

function isScaffoldingExpressionStatement(expression) {
  if (!expression) return false;
  if (isTableValidateCall(expression)) return true;
  if (
    expression.type === "AssignmentExpression" &&
    isGetXFormFieldByIdCall(expression.right)
  ) return true;
  if (isLocalValueCaptureAssignment(expression)) return true;
  if (isDetailFieldStyleDisplayAssignment(expression)) return true;
  if (isOnclickSetAttributeCall(expression)) return true;
  if (isDetailFieldPlaceholderSetAttributeCall(expression)) return true;
  return false;
}

function isLocalValueCaptureAssignment(expression) {
  if (
    expression?.type !== "AssignmentExpression" ||
    expression.operator !== "=" ||
    expression.left?.type !== "Identifier"
  ) return false;
  const right = expression.right;
  if (right?.type !== "MemberExpression") return false;
  const name = propertyName(right.property);
  return name === "value" || name === "checked";
}

function isScaffoldingVariableDeclaration(statement) {
  return (statement.declarations || []).every((declaration) => {
    if (declaration.id?.type !== "Identifier") return false;
    if (!declaration.init) return true;
    if (isNullLiteral(declaration.init)) return true;
    if (isGetXFormFieldByIdCall(declaration.init)) return true;
    if (isDetailTableDomLookup(declaration.init)) return true;
    if (isImgCollectionLookup(declaration.init)) return true;
    if (isDetailFieldNameLookup(declaration.init)) return true;
    return false;
  });
}

function isTableValidateCall(expression) {
  return expression?.type === "CallExpression" &&
    expression.callee?.type === "Identifier" &&
    /^set\w*(Table)?(No)?Validate$/i.test(expression.callee.name) &&
    (expression.arguments || []).length === 0;
}

function isGetXFormFieldByIdCall(expression) {
  return expression?.type === "CallExpression" &&
    expression.callee?.type === "Identifier" &&
    expression.callee.name === "GetXFormFieldById" &&
    (expression.arguments || []).length >= 1;
}

function isDetailTableDomLookup(expression) {
  return expression?.type === "CallExpression" &&
    expression.callee?.type === "MemberExpression" &&
    expression.callee.object?.type === "Identifier" &&
    expression.callee.object.name === "document" &&
    propertyName(expression.callee.property) === "getElementById" &&
    expression.arguments?.[0]?.type === "Literal" &&
    /^TABLE_DL_/i.test(String(expression.arguments[0].value || ""));
}

function isImgCollectionLookup(expression) {
  return expression?.type === "CallExpression" &&
    expression.callee?.type === "MemberExpression" &&
    expression.callee.object?.type === "Identifier" &&
    expression.callee.object.name === "document" &&
    propertyName(expression.callee.property) === "getElementsByTagName" &&
    expression.arguments?.[0]?.type === "Literal" &&
    String(expression.arguments[0].value || "").toLowerCase() === "img";
}

function isDetailFieldNameLookup(expression) {
  if (
    expression?.type === "MemberExpression" &&
    expression.computed &&
    isDetailFieldNameLookup(expression.object)
  ) return true;
  return expression?.type === "CallExpression" &&
    expression.callee?.type === "MemberExpression" &&
    expression.callee.object?.type === "Identifier" &&
    expression.callee.object.name === "document" &&
    propertyName(expression.callee.property) === "getElementsByName" &&
    expressionContainsDetailFieldName(expression.arguments?.[0]);
}

function expressionContainsDetailFieldName(expression) {
  if (!expression) return false;
  if (expression.type === "Literal") {
    return /extendDataFormInfo\.value\(/.test(String(expression.value || ""));
  }
  if (expression.type === "BinaryExpression" && expression.operator === "+") {
    return expressionContainsDetailFieldName(expression.left) ||
      expressionContainsDetailFieldName(expression.right);
  }
  if (expression.type === "TemplateLiteral") {
    return (expression.quasis || []).some((quasi) =>
      /extendDataFormInfo\.value\(/.test(String(quasi.value?.cooked || quasi.value?.raw || ""))
    );
  }
  return false;
}

function isDetailFieldElementAccess(expression) {
  return expression?.type === "MemberExpression" &&
    expression.computed &&
    isDetailFieldNameLookup(expression.object);
}

function isDetailFieldStyleDisplayAssignment(expression) {
  if (expression?.type !== "AssignmentExpression" || expression.operator !== "=") return false;
  const left = expression.left;
  if (
    left?.type !== "MemberExpression" ||
    propertyName(left.property) !== "display"
  ) return false;
  const styleObject = left.object;
  if (
    styleObject?.type !== "MemberExpression" ||
    propertyName(styleObject.property) !== "style"
  ) return false;
  return isDetailFieldElementAccess(styleObject.object);
}

function isOnclickSetAttributeCall(expression) {
  if (
    expression?.type !== "CallExpression" ||
    expression.callee?.type !== "MemberExpression" ||
    propertyName(expression.callee.property) !== "setAttribute"
  ) return false;
  const attr = expression.arguments?.[0];
  return attr?.type === "Literal" && String(attr.value || "").toLowerCase() === "onclick";
}

function isDetailFieldPlaceholderSetAttributeCall(expression) {
  if (
    expression?.type !== "CallExpression" ||
    expression.callee?.type !== "MemberExpression" ||
    propertyName(expression.callee.property) !== "setAttribute"
  ) return false;
  const attr = expression.arguments?.[0];
  if (attr?.type !== "Literal" || String(attr.value || "").toLowerCase() !== "placeholder") {
    return false;
  }
  return isDetailFieldElementAccess(expression.callee.object);
}

function isNullLiteral(expression) {
  return expression?.type === "Literal" && expression.value === null;
}

function propertyName(node) {
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return String(node.value || "");
  return "";
}

function isNativeRowEffectStatement(statement, resolveOperand) {
  const call = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  if (
    call?.type !== "CallExpression" ||
    call.callee?.type !== "Identifier" ||
    call.callee.name !== "common_dom_row_set_show_required_reset" ||
    !resolveOperand.isUnshadowedGlobal(call.callee.name, call.callee.start) ||
    call.arguments?.length !== 4
  ) return false;
  const [target, visible, required, reset] = call.arguments;
  return target?.type === "Literal" && typeof target.value === "string" &&
    visible?.type === "Literal" && typeof visible.value === "boolean" &&
    required?.type === "Literal" && typeof required.value === "boolean" &&
    reset?.type === "Literal" && reset.value === false;
}

function walkJavaScriptAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["start", "end", "loc"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) walkJavaScriptAst(child, visit);
    } else if (value && typeof value === "object") {
      walkJavaScriptAst(value, visit);
    }
  }
}

function isKeywordAt(text, index, keyword) {
  return text.slice(index, index + keyword.length) === keyword &&
    !/[A-Za-z0-9_$]/.test(text[index - 1] || "") &&
    !/[A-Za-z0-9_$]/.test(text[index + keyword.length] || "");
}

function findNextTopLevelIf(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && text.startsWith("if", index) && !/[A-Za-z0-9_$]/.test(text[index - 1] || "") && !/[A-Za-z0-9_$]/.test(text[index + 2] || "")) {
      return index;
    }
  }
  return -1;
}

function conditionSpec(condition, field, resolveOperand, beforeIndex) {
  const parsed = parseProvenanceCondition(condition, resolveOperand, { beforeIndex });
  if (!parsed || parsed.operand !== "event:value") return undefined;
  if (parsed.kind === "regex-set") {
    const values = uniqueStrings(parsed.values);
    return {
      idPart: `eq.${values.map(stableIdPart).join("_")}`,
      logic: values.length > 1 ? "or" : "and",
      when: values.map((value) => ({ field, op: "eq", value })),
      semantics: values.map(() => conditionSemantic(parsed))
    };
  }
  if (parsed.kind === "contains") {
    return {
      idPart: `contains.${stableIdPart(parsed.value)}`,
      logic: "and",
      when: [{ field, op: "contains", value: parsed.value }],
      semantics: [conditionSemantic(parsed)]
    };
  }
  if (parsed.kind !== "eq") return undefined;
  return {
    idPart: `eq.${stableIdPart(parsed.value)}`,
    logic: "and",
    when: [{ field, op: "eq", value: parsed.value }],
    semantics: [conditionSemantic(parsed)]
  };
}

function conditionSemantic(parsed) {
  return pruneUndefined({
    origin: parsed.operand,
    transforms: parsed.transforms?.length ? parsed.transforms : [],
    predicate: parsed.predicate,
    pattern: parsed.pattern
  });
}

function runWhenFromDisplayGate(displayGate) {
  if (displayGate === "xform:editShow") return { viewStatusIn: ["add", "edit"] };
  if (displayGate === "xform:viewShow") return { viewStatusIn: ["view"] };
  return undefined;
}

function extractDirectRowEffects(body, context, bodyStart) {
  const effects = [];
  const seen = new Set();

  for (const match of directRowEffectMatches(body, context, bodyStart)) {
    const target = match[2];
    const visible = match[3] === "true";
    const required = match[4] === "true";
    addEffect(effects, seen, { type: "visible", target, value: visible });
    addEffect(effects, seen, { type: "required", target, value: required });
  }

  return effects;
}

function countDirectRowEffectCallsInChain(chain, context) {
  return chain.branches.reduce(
    (count, branch) => count + directRowEffectMatches(
      branch.body,
      context,
      branch.bodyStart
    ).length,
    directRowEffectMatches(chain.elseBody, context, chain.elseBodyStart).length
  );
}

function countRowEffectCallsInChain(chain) {
  return chain.branches.reduce(
    (count, branch) => count + countRowEffectCalls(branch.body),
    countRowEffectCalls(chain.elseBody)
  );
}

function directRowEffectMatches(body, context, bodyStart = 0) {
  const directBody = stripNestedBlocks(body);
  // The last argument resets the row value. Native display/required rules do
  // not implement that destructive side effect, so only reset=false is safe
  // to lower; reset=true remains explicit residual script behavior.
  const pattern = /\bcommon_dom_row_set_show_required_reset\(\s*(["'])([^"']+)\1\s*,\s*(true|false)\s*,\s*(true|false)\s*,\s*false\s*\)/g;
  const codeMask = javascriptCodeMask(directBody);
  return [...directBody.matchAll(pattern)].filter((match) =>
    codeMask.startsWith(ROW_EFFECT_HELPER, match.index) &&
    context?.provenCallStarts?.has(
      context.absoluteBodyStart + bodyStart + match.index
    )
  );
}

function countRowEffectCalls(body) {
  const text = String(body || "");
  const codeMask = javascriptCodeMask(text);
  return [...text.matchAll(/\bcommon_dom_row_set_show_required_reset\s*\(/g)]
    .filter((match) => codeMask.startsWith("common_dom_row_set_show_required_reset", match.index))
    .length;
}

function stripNestedBlocks(text) {
  const source = String(text || "");
  const codeMask = javascriptCodeMask(source);
  const output = [...source];
  let depth = 0;
  for (let index = 0; index < codeMask.length; index += 1) {
    const char = codeMask[index];
    if (char === "{") {
      output[index] = " ";
      depth += 1;
      continue;
    }
    if (char === "}") {
      output[index] = " ";
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0 && source[index] !== "\n" && source[index] !== "\r") output[index] = " ";
  }
  return output.join("");
}

function javascriptCodeMask(source) {
  const text = String(source || "");
  const output = [...text].map((char) => char === "\n" || char === "\r" ? char : " ");
  try {
    const tokens = tokenizer(text, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowHashBang: true
    });
    while (true) {
      const token = tokens.getToken();
      if (token.type.label === "eof") break;
      if (["string", "regexp", "template", "`"].includes(token.type.label)) continue;
      for (let index = token.start; index < token.end; index += 1) {
        output[index] = text[index];
      }
    }
  } catch {
    // An un-tokenizable script is not safe to lower. Returning an empty mask
    // keeps extraction fail-closed while retaining source offsets.
  }
  return output.join("");
}

function addEffect(effects, seen, effect) {
  const key = `${effect.type}:${effect.target}:${effect.value}`;
  if (seen.has(key)) return;
  seen.add(key);
  effects.push(effect);
}

function findBalancedClose(text, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = "";
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const prev = text[index - 1];
    if (quote) {
      if (char === quote && prev !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function skipWhitespace(text, index) {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function stableIdPart(value) {
  const text = String(value || "value");
  if (/^[A-Za-z0-9_-]+$/.test(text)) return text;
  // "~" is outside the unchanged alphabet, so the UTF-8 hex branch cannot
  // collide with an unchanged source value (unlike lossy underscore folding).
  return `~${Buffer.from(text, "utf8").toString("hex")}`;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function oneLine(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function pruneUndefined(value) {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, pruneUndefined(child)])
  );
}
