import {
  NATIVE_FORM_RULE_FORMULA_CAPABILITY as FORMULA_CAPABILITY,
  nativeFormRuleProjectionRef
} from "./native-form-rule-capability.js";

const FORMULA_PROJECTION_KIND = FORMULA_CAPABILITY.projection.kind;
const FORMULA_PROJECTION_VERSION = FORMULA_CAPABILITY.projection.version;
const EDIT_VIEW_STATUSES = FORMULA_CAPABILITY.projection.viewStatusIn;
const FORMULA_OPERATORS = new Set(FORMULA_CAPABILITY.projection.operators);
const FORMULA_TRANSFORMS = new Set(FORMULA_CAPABILITY.projection.transforms);
const FORMULA_PREDICATES = new Set(FORMULA_CAPABILITY.projection.predicates);

export { nativeFormRuleProjectionRef };

export function inspectNativeFormRuleProjection(rule) {
  if (rule?.meta?.runWhen === undefined) {
    return { ok: true, kind: "ordinary-condition" };
  }

  const issues = [];
  const projection = rule?.meta?.nativeProjection;
  if (
    projection?.kind !== FORMULA_PROJECTION_KIND ||
    projection?.version !== FORMULA_PROJECTION_VERSION
  ) {
    issues.push("native_projection_capability_missing");
  }
  if (rule?.meta?.displayGate !== FORMULA_CAPABILITY.projection.displayGate) {
    issues.push("display_gate_not_edit_show");
  }
  if (!sameStrings(rule?.meta?.runWhen?.viewStatusIn, EDIT_VIEW_STATUSES)) {
    issues.push("run_when_not_edit_domain");
  }
  if (rule?.trigger !== FORMULA_CAPABILITY.projection.trigger) {
    issues.push("trigger_not_change");
  }
  if (rule?.meta?.conditionSource !== FORMULA_CAPABILITY.projection.conditionSource) {
    issues.push("condition_source_not_event_value");
  }
  if (!nonEmptyString(rule?.source)) {
    issues.push("source_missing");
  }
  const conditions = Array.isArray(rule?.when) ? rule.when : [];
  if (!conditions.length) {
    issues.push("conditions_missing");
  }
  if (conditions.some((condition) => condition?.field !== rule?.source)) {
    issues.push("condition_field_not_action_source");
  }
  if (conditions.some((condition) => !FORMULA_OPERATORS.has(condition?.op))) {
    issues.push("condition_operator_not_formula_safe");
  }
  const conditionSemantics = rule?.meta?.conditionSemantics;
  if (!Array.isArray(conditionSemantics) || conditionSemantics.length !== conditions.length) {
    issues.push("condition_semantics_missing");
  } else {
    if (conditionSemantics.some((semantic) => semantic?.origin !== "event:value")) {
      issues.push("condition_semantics_origin_mismatch");
    }
    if (conditionSemantics.some((semantic) => !formulaSafeConditionSemantic(semantic))) {
      issues.push("condition_semantics_unsupported");
    }
    if (conditionSemantics.some((semantic, index) => (
      !conditionSemanticMatchesClause(semantic, conditions[index])
    ))) {
      issues.push("condition_semantics_clause_mismatch");
    }
    if (!regexConditionSetMatchesSource(conditions, conditionSemantics, rule?.logic)) {
      issues.push("condition_semantics_regex_set_mismatch");
    }
  }
  if (!nonEmptyString(rule?.meta?.sourceJsp)) {
    issues.push("source_evidence_missing");
  }
  if (!nonEmptyString(rule?.meta?.sourceActionKey)) {
    issues.push("source_action_identity_missing");
  }

  return {
    ok: issues.length === 0,
    kind: FORMULA_PROJECTION_KIND,
    issues
  };
}

export function requiresNativeFormRuleFormula(dsl) {
  return (Array.isArray(dsl?.formRules?.linkage) ? dsl.formRules.linkage : [])
    .some((rule) => (
      rule?.translationStatus === "executable" && rule?.meta?.runWhen !== undefined
    ));
}

export function inspectNativeFormRuleActionBinding(rule, scripts) {
  if (rule?.meta?.runWhen === undefined) return { ok: true, matches: [] };
  const actions = Array.isArray(scripts?.actions) ? scripts.actions : [];
  const matches = actions.filter((action) => nativeFormRuleBelongsToAction(rule, action));
  return {
    ok: matches.length === 1,
    matches: matches.map((action) => action.id).filter(nonEmptyString),
    issues: matches.length === 0
      ? ["matching_on_change_action_missing"]
      : matches.length > 1
        ? ["matching_on_change_action_ambiguous"]
        : []
  };
}

export function nativeFormRuleBelongsToAction(rule, action) {
  if (!inspectNativeFormRuleProjection(rule).ok) return false;
  const sourceRefs = Array.isArray(action?.sourceRefs) ? action.sourceRefs : [];
  const ruleSourceRefs = [
    rule?.meta?.sourceJsp,
    ...(Array.isArray(rule?.meta?.sourceJsps) ? rule.meta.sourceJsps : [])
  ].filter(nonEmptyString);
  return action?.event === "onChange" &&
    action?.scope === "control" &&
    action?.controlId === rule?.source &&
    sameOptionalRunWhen(action?.runWhen, rule?.meta?.runWhen) &&
    action?.sourceActionKey === rule?.meta?.sourceActionKey &&
    ruleSourceRefs.length > 0 &&
    ruleSourceRefs.some((sourceRef) => sourceRefs.includes(sourceRef));
}

export function compileNativeFormRuleFormula(rule, {
  branch = "when",
  resolveFieldName = (field) => field
} = {}) {
  const inspection = inspectNativeFormRuleProjection(rule);
  if (!inspection.ok || inspection.kind !== FORMULA_PROJECTION_KIND) {
    const error = new Error("Native form-rule formula projection is not statically proven.");
    error.code = "projection.form_rule.native_projection_unproven";
    error.details = { ruleId: rule?.id, issues: inspection.issues || [] };
    throw error;
  }

  const fieldNames = uniqueStrings(
    rule.when.map((condition) => resolveFieldName(condition.field))
  );
  if (fieldNames.length !== 1 || fieldNames.some((field) => !nonEmptyString(field))) {
    const error = new Error("Native form-rule formula fields could not be resolved uniquely.");
    error.code = "projection.form_rule.formula_field_unresolved";
    error.details = { ruleId: rule?.id, fieldNames };
    throw error;
  }

  const clauses = rule.when.map((condition, index) => compileClause(
    condition,
    resolveFieldName(condition.field),
    rule.meta.conditionSemantics[index]
  ));
  const joiner = rule.logic === "or" ? " || " : " && ";
  const conditionExpression = clauses.length === 1
    ? clauses[0]
    : `(${clauses.join(joiner)})`;
  const branchExpression = branch === "else"
    ? `!(${conditionExpression})`
    : conditionExpression;
  const gate = `(${EDIT_VIEW_STATUSES
    .map((status) => `MKXFORM.viewStatus === ${JSON.stringify(status)}`)
    .join(" || ")})`;

  return {
    script: `${gate} && (${branchExpression})`,
    varIds: fieldNames
  };
}

export function nativeFormRuleProjectionDiagnostic(rule, scripts) {
  const inspection = inspectNativeFormRuleProjection(rule);
  const actionBinding = inspection.ok
    ? inspectNativeFormRuleActionBinding(rule, scripts)
    : { ok: false, issues: [] };
  if (inspection.ok && actionBinding.ok) return undefined;
  const capabilityMissing = inspection.issues.includes("native_projection_capability_missing");
  const issues = [...inspection.issues, ...(actionBinding.issues || [])];
  return {
    code: capabilityMissing
      ? "form_rule.run_when_not_persistable"
      : "form_rule.native_projection_unproven",
    ruleId: rule?.id,
    sourceJsp: rule?.meta?.sourceJsp,
    displayGate: rule?.meta?.displayGate,
    runWhen: rule?.meta?.runWhen,
    issues,
    message: capabilityMissing
      ? "A view-gated native form rule requires the versioned formula-condition projection capability."
      : "The native formula-condition projection is not traceable to exactly one matching control onChange input."
  };
}

function compileClause(condition, fieldName, semantic) {
  const valueExpression = `\${data.biz.${fieldName}}`;
  const operand = applyTransforms(valueExpression, semantic.transforms);
  const literal = JSON.stringify(condition.value ?? "");
  let positive;
  if (semantic.predicate === "regex-char-set") {
    positive = `RegExp(${JSON.stringify(semantic.pattern)}).test(${operand})`;
  } else if (["indexOf", "includes"].includes(semantic.predicate)) {
    const method = semantic.predicate === "includes" ? "includes" : "indexOf";
    positive = method === "includes"
      ? `(${operand} != null && ${operand}.includes(${literal}))`
      : `(${operand} != null && ${operand}.indexOf(${literal}) >= 0)`;
  } else if ([
    "strict-equality",
    "loose-equality",
    "strict-numeric-equality",
    "loose-numeric-equality"
  ].includes(semantic.predicate)) {
    const numeric = semantic.predicate.endsWith("numeric-equality");
    const comparisonLiteral = numeric
      ? String(Number(condition.value))
      : literal;
    const operator = semantic.predicate.startsWith("loose-") ? "==" : "===";
    positive = `${operand} ${operator} ${comparisonLiteral}`;
  }
  switch (condition.op) {
    case "eq":
    case "contains":
      return positive;
    case "ne":
    case "notContains":
      return `!(${positive})`;
    default: {
      const error = new Error(`Unsupported native formula operator: ${condition.op}`);
      error.code = "projection.form_rule.formula_operator_unsupported";
      throw error;
    }
  }
}

function applyTransforms(expression, transforms) {
  return transforms.reduce((current, transform) => {
    if (transform === "array-first") {
      return `(Array.isArray(${current}) ? ${current}[0] : ${current})`;
    }
    if (transform === "index-first") return `${current}[0]`;
    if (transform === "default-empty") return `(${current} || \"\")`;
    if (transform === "nullish-empty") return `(${current} == null ? \"\" : ${current})`;
    if (transform === "string") return `String(${current})`;
    return current;
  }, expression);
}

function formulaSafeConditionSemantic(semantic) {
  const transforms = Array.isArray(semantic?.transforms) ? semantic.transforms : [];
  if (transforms.some((transform) => !FORMULA_TRANSFORMS.has(transform))) return false;
  if (!FORMULA_PREDICATES.has(semantic?.predicate)) return false;
  if ([
    "indexOf",
    "includes",
    "strict-equality",
    "loose-equality",
    "strict-numeric-equality",
    "loose-numeric-equality"
  ].includes(semantic?.predicate)) {
    return semantic.pattern === undefined;
  }
  return semantic?.predicate === "regex-char-set" && /^\[[A-Za-z0-9]+\]$/.test(semantic.pattern || "");
}

function conditionSemanticMatchesClause(semantic, condition) {
  if (!FORMULA_OPERATORS.has(condition?.op)) return false;
  if (["indexOf", "includes"].includes(semantic?.predicate)) {
    return ["contains", "notContains"].includes(condition.op) &&
      typeof condition.value === "string";
  }
  if ([
    "strict-equality",
    "loose-equality"
  ].includes(semantic?.predicate)) {
    return ["eq", "ne"].includes(condition.op) && typeof condition.value === "string";
  }
  if ([
    "strict-numeric-equality",
    "loose-numeric-equality"
  ].includes(semantic?.predicate)) {
    return ["eq", "ne"].includes(condition.op) &&
      Number.isFinite(Number(condition.value));
  }
  if (semantic?.predicate === "regex-char-set") {
    const values = [...new Set([...String(semantic.pattern || "").slice(1, -1)])];
    return condition.op === "eq" &&
      typeof condition.value === "string" &&
      condition.value.length === 1 &&
      values.includes(condition.value);
  }
  return false;
}

function regexConditionSetMatchesSource(conditions, semantics, logic) {
  const regexIndexes = semantics
    .map((semantic, index) => semantic?.predicate === "regex-char-set" ? index : -1)
    .filter((index) => index >= 0);
  if (!regexIndexes.length) return true;
  if (regexIndexes.length !== conditions.length) return false;
  const patterns = uniqueStrings(regexIndexes.map((index) => semantics[index].pattern));
  if (patterns.length !== 1) return false;
  const expected = [...new Set([...patterns[0].slice(1, -1)])];
  const actual = uniqueStrings(conditions.map((condition) => condition.value));
  return sameUnorderedStrings(actual, expected) &&
    (expected.length === 1 ? logic === "and" : logic === "or");
}

function sameUnorderedStrings(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sameStrings(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function sameOptionalRunWhen(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return sameStrings(left?.viewStatusIn, right?.viewStatusIn || []);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(nonEmptyString))];
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
