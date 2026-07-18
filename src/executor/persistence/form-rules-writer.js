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
  const compute = buildNativeComputeRules(form, nativeIndex);

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
    compute,
    summary: summarizeFormRules({ ...(formRules || {}), linkage })
  };
}

export function mergeNativeFormRules(existingFormRule, generated) {
  const current = existingFormRule && typeof existingFormRule === "object" ? existingFormRule : {};
  return {
    ...current,
    pattern: current.pattern && typeof current.pattern === "object" ? current.pattern : {},
    display: mergeGeneratedRules(current.display, generated.display),
    require: mergeGeneratedRules(current.require, generated.require),
    compute: mergeGeneratedRules(current.compute, generated.compute)
  };
}

export function summarizeNativeFormRuleConfig(formRule = {}) {
  const display = Array.isArray(formRule.display) ? formRule.display : [];
  const require = Array.isArray(formRule.require) ? formRule.require : [];
  const compute = Array.isArray(formRule.compute) ? formRule.compute : [];
  return {
    displayRuleCount: display.length,
    requireRuleCount: require.length,
    computeRuleCount: compute.length,
    displayRules: display.map(summarizeNativeRule),
    requireRules: require.map(summarizeNativeRule),
    computeRules: compute.map(summarizeNativeRule)
  };
}

function buildNativeComputeRules(form = {}, nativeIndex) {
  const calculations = [];
  for (const entry of calculationFields(form)) {
    const { field, tableId, ref } = entry;
    const target = nativeIndex.byRef.get(ref);
    if (!target) continue;
    const item = buildNativeComputeItem(field, target, nativeIndex);
    if (!item) continue;
    calculations.push({
      id: stableId("compute-rule", ref),
      ruleName: `${GENERATED_RULE_PREFIX}compute:${ref}`,
      active: true,
      choices: { items: [item] },
      meta: {
        generatedBy: GENERATED_BY,
        sourceFieldId: field.id,
        ...(tableId ? { sourceTableId: tableId } : {}),
        ruleType: "compute"
      }
    });
  }
  return calculations;
}

function calculationFields(form = {}) {
  const entries = (form.fields || []).flatMap((field) => {
    if (field?.type !== "detailTable") {
      return field?.props?.calculation ? [{ field, ref: field.id }] : [];
    }
    return (field.columns || [])
      .filter((column) => column?.props?.calculation)
      .map((column) => ({
        field: column,
        tableId: field.id,
        ref: `${field.id}.${column.id}`
      }));
  });
  const knownRefs = new Set(entries.map((entry) => entry.ref));
  const pending = entries.map((entry) => ({
    ...entry,
    dependencies: nativeCalculationDependencies(entry, knownRefs)
  }));
  const ordered = [];
  const emitted = new Set();

  while (pending.length) {
    const index = pending.findIndex((entry) => entry.dependencies.every((ref) => emitted.has(ref)));
    if (index === -1) {
      const error = new Error("Native calculation dependency cycle detected.");
      error.code = "projection.form.calculation_dependency_cycle";
      error.details = { fieldRefs: pending.map((entry) => entry.ref) };
      throw error;
    }
    const [entry] = pending.splice(index, 1);
    ordered.push(entry);
    emitted.add(entry.ref);
  }
  return ordered;
}

function nativeCalculationDependencies(entry, knownRefs) {
  const calculation = entry.field.props.calculation;
  if (calculation.kind === "aggregate") {
    const ref = `${calculation.tableId}.${calculation.fieldId}`;
    return knownRefs.has(ref) ? [ref] : [];
  }
  if (calculation.kind !== "formula") return [];
  return (calculation.fieldIds || [])
    .map((fieldId) => entry.tableId ? `${entry.tableId}.${fieldId}` : fieldId)
    .filter((ref) => knownRefs.has(ref));
}

function buildNativeComputeItem(field, target, nativeIndex) {
  const calculation = field.props.calculation;
  const base = {
    autoCompute: "",
    fieldKey: target.controlId || target.fieldKey,
    formula: "",
    label: target.label,
    fieldName: target.fieldName
  };

  if (calculation.kind === "formula") {
    const expression = String(calculation.expression || "").trim();
    if (!expression) return undefined;
    const fieldIds = Array.isArray(calculation.fieldIds) ? calculation.fieldIds : [];
    return {
      ...base,
      type: "FORMULA",
      statisticField: "",
      value: {
        type: "Eval",
        script: expression.replace(/\$([A-Za-z_][\w]*)\$/gu, (_, fieldId) => `\${data.biz.${fieldId}}`),
        vo: {
          mode: "formula",
          content: calculation.displayExpression || expression
        },
        varIds: fieldIds
      }
    };
  }

  if (calculation.kind === "aggregate" && calculation.operation === "sum") {
    const source = nativeIndex.byRef.get(`${calculation.tableId}.${calculation.fieldId}`);
    if (!source?.tableName) return undefined;
    return {
      ...base,
      type: "SUM",
      statisticField: [`${source.tableName}.${source.fieldName}`],
      value: ""
    };
  }

  return undefined;
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
        const key = `${JSON.stringify(result.fieldName)}:${result.tableType}:${result.type}:${result.displayFlag}`;
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
  if (target?.kind === "detailTable" && nativeIndex.byDetailTable?.has(target.id)) {
    return nativeIndex.byDetailTable.get(target.id);
  }
  const keys = target.parentId ? [`${target.parentId}.${target.id}`, target.id] : [target.id];
  for (const key of keys) {
    if (nativeIndex.byRef.has(key)) return nativeIndex.byRef.get(key);
  }
  return undefined;
}

function buildDisplayResult(target, visible, ruleId, branch, effectIndex) {
  const seed = `${ruleId}:${branch}:display:${effectIndex}:${target.tableType}:${Array.isArray(target.fieldName) ? target.fieldName[0] : target.fieldName}`;
  if (target.isDetailTableContainer) {
    const columns = Array.isArray(target.columns) ? target.columns : [];
    return {
      fieldName: ["all", ...columns.map((column) => column.fieldName)],
      fieldKey: [null, ...columns.map((column) => column.fieldKey)],
      label: ["----", ...columns.map((column) => column.label)],
      tableType: "detail",
      type: target.tableName,
      displayFlag: visible ? "display" : "hide",
      title: "",
      fieldID: stableId("result-field", seed),
      actionID: stableId("result-action", seed),
      tID: stableId("result-table", seed),
      tableTypeID: stableId("result-table-type", seed),
      required: ""
    };
  }
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
  const byDetailTable = new Map();

  for (const model of dataModels) {
    const tableFieldName = model?.dynamicProps?.detailFieldName || detailFieldNameFromTable(model?.fdTableName);
    const isDetail = model?.fdType === "detail";
    const fields = (model?.fdFields || []).filter((field) => field?.fdName && !field.fdIsSystem);
    const columns = [];

    for (const field of fields) {
      const controlProps = parseJsonObject(field.fdAttribute).config?.controlProps || {};
      const column = {
        fieldName: field.fdName,
        fieldKey: controlProps.id || controlProps.name || field.fdName,
        label: field.fdLabel || controlProps.title || field.fdName
      };
      if (isDetail) columns.push(column);

      const ref = {
        fieldName: field.fdName,
        fieldKey: controlProps.name || field.fdName,
        label: column.label,
        tableType: model.fdType || (isDetail ? "detail" : "main"),
        type: isDetail ? model.fdTableName : "main",
        tableName: model.fdTableName,
        controlId: controlProps.id || controlProps.name || field.fdName,
        field,
        model
      };
      addRef(byRef, field.fdName, ref);
      if (isDetail && tableFieldName) addRef(byRef, `${tableFieldName}.${field.fdName}`, ref);
      if (isDetail && model.fdTableName) addRef(byRef, `${model.fdTableName}.${field.fdName}`, ref);
    }

    if (isDetail && tableFieldName) {
      const containerRef = {
        fieldName: tableFieldName,
        fieldKey: tableFieldName,
        label: model.fdName || tableFieldName,
        tableType: "main",
        type: "main",
        tableName: model.fdTableName,
        isDetailTableContainer: true,
        columns,
        model
      };
      addRef(byDetailTable, tableFieldName, containerRef);
      addRef(byRef, tableFieldName, containerRef);
      if (model.fdTableName) addRef(byRef, model.fdTableName, containerRef);
    }
  }

  return { byRef, byDetailTable };
}

function detailFieldNameFromTable(tableName) {
  const normalized = typeof tableName === "string" ? tableName.trim() : "";
  if (!normalized.startsWith("mk_model_")) return undefined;
  const fieldName = normalized.slice("mk_model_".length);
  return fieldName || undefined;
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
