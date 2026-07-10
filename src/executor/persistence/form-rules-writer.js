import {
  buildFormRuleRefIndex,
  resolveDirectRef,
  resolveEffectTarget,
  summarizeFormRules
} from "../../dsl/form-rules.js";

const GENERATED_BY = "mk-migrate-agent-v2";
const GENERATED_RULE_PREFIX = "mk-migrate-agent-v2:";

const OPERATOR_MAP = {
  eq: "=",
  ne: "!=",
  contains: "include",
  notContains: "notInclude",
  in: "$contains",
  empty: "empty",
  notEmpty: "notEmpty"
};

const INVERT_OPERATOR_MAP = {
  eq: "ne",
  ne: "eq",
  contains: "notContains",
  notContains: "contains",
  in: "notContains",
  empty: "notEmpty",
  notEmpty: "empty"
};

export function buildNativeFormRuleConfig(formRules, form, dataModels) {
  const linkage = (Array.isArray(formRules?.linkage) ? formRules.linkage : [])
    .filter((rule) => rule?.translationStatus === "executable");
  const formIndex = buildFormRuleRefIndex(form || {});
  const nativeIndex = buildNativeFieldIndex(dataModels);
  const display = [];
  const require = [];

  linkage.forEach((rule, ruleIndex) => {
    const ruleId = rule.id || `linkage-${ruleIndex + 1}`;
    const when = Array.isArray(rule.when) ? rule.when : [];
    const conditionItems = buildConditionItems(when, formIndex, nativeIndex, `${ruleId}:when`);
    const branch = buildBranch(rule, ruleId, "when", conditionItems, rule.effects, formIndex, nativeIndex);
    display.push(...branch.display);
    require.push(...branch.require);

    if (Array.isArray(rule.else) && rule.else.length) {
      const elseConditions = buildConditionItems(invertClauses(when), formIndex, nativeIndex, `${ruleId}:else`);
      const elseBranch = buildBranch({ ...rule, logic: invertLogic(rule.logic) }, ruleId, "else", elseConditions, rule.else, formIndex, nativeIndex);
      display.push(...elseBranch.display);
      require.push(...elseBranch.require);
    }
  });

  return {
    display,
    require,
    summary: summarizeFormRules({ ...(formRules || {}), linkage })
  };
}

export function mergeNativeFormRules(existingFormRule, generated) {
  const current = existingFormRule && typeof existingFormRule === "object" ? existingFormRule : {};
  return {
    ...current,
    pattern: current.pattern && typeof current.pattern === "object" ? current.pattern : {},
    display: mergeGeneratedRules(current.display, generated.display),
    require: mergeGeneratedRules(current.require, generated.require)
  };
}

export function summarizeNativeFormRuleConfig(formRule = {}) {
  const display = Array.isArray(formRule.display) ? formRule.display : [];
  const require = Array.isArray(formRule.require) ? formRule.require : [];
  return {
    displayRuleCount: display.length,
    requireRuleCount: require.length,
    displayRules: display.map(summarizeNativeRule),
    requireRules: require.map(summarizeNativeRule)
  };
}

function buildBranch(rule, ruleId, branch, conditionItems, effects, formIndex, nativeIndex) {
  const displayResults = [];
  const requireResults = [];
  const displayKeys = new Set();
  const requireKeys = new Set();

  for (const [effectIndex, effect] of (Array.isArray(effects) ? effects : []).entries()) {
    const targets = resolveNativeTargets(effect.target, formIndex, nativeIndex);
    for (const target of targets) {
      if (effect.type === "visible") {
        const result = buildDisplayResult(target, effect.value !== false, ruleId, branch, effectIndex);
        const key = `${result.fieldName}:${result.tableType}:${result.displayFlag}`;
        if (displayKeys.has(key)) continue;
        displayKeys.add(key);
        displayResults.push(result);
      }
      if (effect.type === "required") {
        const result = buildRequireResult(target, effect.value !== false, ruleId, branch, effectIndex);
        const key = `${result.fieldName}:${result.tableType}:${result.required}`;
        if (requireKeys.has(key)) continue;
        requireKeys.add(key);
        requireResults.push(result);
      }
    }
  }

  return {
    display: displayResults.length ? [buildNativeRule(rule, ruleId, branch, "display", conditionItems, displayResults)] : [],
    require: requireResults.length ? [buildNativeRule(rule, ruleId, branch, "require", conditionItems, requireResults)] : []
  };
}

function buildNativeRule(rule, ruleId, branch, type, conditionItems, result) {
  const seed = `${ruleId}:${branch}:${type}`;
  return {
    id: stableId("rule", seed),
    ruleName: `${GENERATED_RULE_PREFIX}${ruleId}:${branch}:${type}`,
    active: rule.active !== false,
    condition: rule.logic === "or" ? "2" : "1",
    choices: {
      items: conditionItems.map((item, index) => ({
        ...item,
        fieldID: stableId("field", `${seed}:condition:${index}`),
        OperaterID: stableId("operator", `${seed}:condition:${index}`),
        formulaID: stableId("formula", `${seed}:condition:${index}`),
        tableFieldID: stableId("table-field", `${seed}:condition:${index}`),
        valueTypeID: stableId("value-type", `${seed}:condition:${index}`),
        tableTypeID: stableId("table-type", `${seed}:condition:${index}`)
      }))
    },
    result,
    meta: {
      generatedBy: GENERATED_BY,
      sourceRuleId: ruleId,
      branch,
      ruleType: type
    }
  };
}

function buildConditionItems(clauses, formIndex, nativeIndex, seed) {
  return clauses.map((clause, index) => {
    const dslTarget = resolveDirectRef(formIndex, clause.field);
    const nativeTarget = dslTarget ? nativeTargetForDslTarget(dslTarget, nativeIndex) : undefined;
    return {
      condNodeType: "condition",
      fieldName: nativeTarget?.fieldName || clause.field,
      fieldKey: nativeTarget?.fieldKey || clause.field,
      label: nativeTarget?.label || clause.field,
      tableType: nativeTarget?.tableType || "main",
      type: nativeTarget?.type || "main",
      operate: OPERATOR_MAP[clause.op] || clause.op,
      valueType: "fixed",
      value: {
        script: ["empty", "notEmpty"].includes(clause.op) ? "" : normalizeRuleValue(clause.value)
      },
      fieldType: "current",
      tableFieldID: stableId("table-field", `${seed}:${index}`)
    };
  });
}

function resolveNativeTargets(ref, formIndex, nativeIndex) {
  const resolved = resolveEffectTarget(formIndex, ref);
  if (!resolved || resolved.unresolved?.length) return [];
  return resolved.targets
    .map((target) => nativeTargetForDslTarget(target, nativeIndex))
    .filter(Boolean);
}

function nativeTargetForDslTarget(target, nativeIndex) {
  const keys = target.parentId ? [`${target.parentId}.${target.id}`, target.id] : [target.id];
  for (const key of keys) {
    if (nativeIndex.byRef.has(key)) return nativeIndex.byRef.get(key);
  }
  return undefined;
}

function buildDisplayResult(target, visible, ruleId, branch, effectIndex) {
  const seed = `${ruleId}:${branch}:display:${effectIndex}:${target.tableType}:${target.fieldName}`;
  return {
    fieldName: target.fieldName,
    fieldKey: target.fieldKey,
    label: target.label,
    tableType: target.tableType,
    type: target.type,
    displayFlag: visible ? "display" : "hide",
    title: "",
    fieldID: stableId("result-field", seed),
    actionID: stableId("result-action", seed),
    tID: stableId("result-table", seed),
    tableTypeID: stableId("result-table-type", seed)
  };
}

function buildRequireResult(target, required, ruleId, branch, effectIndex) {
  const seed = `${ruleId}:${branch}:require:${effectIndex}:${target.tableType}:${target.fieldName}`;
  return {
    fieldName: target.fieldName,
    fieldKey: target.fieldKey,
    label: target.label,
    tableType: target.tableType,
    type: target.type,
    required: required ? "required" : "non-required",
    requiredLabel: required ? "必填" : "非必填",
    tip: required ? `${target.label || target.fieldName}不能为空` : "",
    fieldID: stableId("result-field", seed),
    OperaterID: stableId("result-operator", seed),
    actionID: stableId("result-action", seed),
    tID: stableId("result-table", seed),
    tableTypeID: stableId("result-table-type", seed)
  };
}

function buildNativeFieldIndex(dataModels = []) {
  const byRef = new Map();

  for (const model of dataModels) {
    const tableFieldName = model?.dynamicProps?.detailFieldName;
    const isDetail = model?.fdType === "detail";
    const fields = (model?.fdFields || []).filter((field) => field?.fdName && !field.fdIsSystem);

    for (const field of fields) {
      const controlProps = parseJsonObject(field.fdAttribute).config?.controlProps || {};
      const ref = {
        fieldName: field.fdName,
        fieldKey: controlProps.name || field.fdName,
        label: field.fdLabel || controlProps.title || field.fdName,
        tableType: model.fdType || (isDetail ? "detail" : "main"),
        type: isDetail ? model.fdTableName : "main",
        tableName: model.fdTableName,
        field,
        model
      };
      addRef(byRef, field.fdName, ref);
      if (isDetail && tableFieldName) addRef(byRef, `${tableFieldName}.${field.fdName}`, ref);
      if (isDetail && model.fdTableName) addRef(byRef, `${model.fdTableName}.${field.fdName}`, ref);
    }
  }

  return { byRef };
}

function invertClauses(clauses) {
  return clauses.map((clause) => ({
    ...clause,
    op: INVERT_OPERATOR_MAP[clause.op] || clause.op
  }));
}

function invertLogic(logic) {
  return logic === "or" ? "and" : logic === "and" ? "or" : logic;
}

function mergeGeneratedRules(existing, generated) {
  const kept = (Array.isArray(existing) ? existing : []).filter((rule) => !isGeneratedRule(rule));
  return [...kept, ...generated];
}

function isGeneratedRule(rule) {
  return rule?.meta?.generatedBy === GENERATED_BY || String(rule?.ruleName || "").startsWith(GENERATED_RULE_PREFIX);
}

function summarizeNativeRule(rule) {
  return {
    ruleName: rule.ruleName,
    active: rule.active !== false,
    condition: rule.condition,
    choiceCount: Array.isArray(rule.choices?.items) ? rule.choices.items.length : 0,
    resultCount: Array.isArray(rule.result) ? rule.result.length : 0,
    generated: isGeneratedRule(rule)
  };
}

function normalizeRuleValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (value === undefined || value === null) return "";
  return String(value);
}

function addRef(map, key, value) {
  if (typeof key === "string" && key.trim() && !map.has(key.trim())) {
    map.set(key.trim(), value);
  }
}

function stableId(prefix, seed) {
  return `${prefix}-${stableHexId(seed).slice(0, 16)}`;
}

function stableHexId(value) {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (const char of String(value)) {
    const code = char.charCodeAt(0);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= code + 0x9e37;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }

  let output = "";
  while (output.length < 32) {
    h1 = Math.imul(h1 ^ (h1 >>> 13), 0x5bd1e995) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 15), 0x27d4eb2d) >>> 0;
    output += h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }
  return output.slice(0, 32);
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
