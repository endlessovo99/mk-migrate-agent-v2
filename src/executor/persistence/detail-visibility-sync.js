import { buildFormRuleRefIndex, resolveEffectTarget } from "../../dsl/form-rules.js";
import {
  inspectNativeFormRuleActionBinding,
  inspectNativeFormRuleProjection,
  nativeFormRuleBelongsToAction
} from "../../dsl/native-form-rule-projection.js";

// Whole-detail native display rules can update a table's label without updating
// the form builder's invalid flag. Project a source-bound SDK visibility call
// alongside the original rule; do not alter the public DSL or hidden row data.
export function withDetailVisibilitySync(scripts = {}, form = {}, formRules = {}) {
  const actions = Array.isArray(scripts?.actions) ? scripts.actions : [];
  const rules = (Array.isArray(formRules?.linkage) ? formRules.linkage : [])
    .filter(rule => rule?.translationStatus === "executable");
  const index = buildFormRuleRefIndex(form);
  const ownership = new Map();
  for (const rule of rules) {
    const ids = new Set([...visibleTables(rule.effects, index), ...visibleTables(rule.else, index)]);
    for (const id of ids) ownership.set(id, (ownership.get(id) || 0) + 1);
  }
  const out = [];
  for (const action of actions) {
    out.push(action);
    if (action?.translationStatus !== "mapped" || action.coverage?.status !== "translated" ||
        action.scope !== "control" || action.event !== "onChange" || action.tableId || !action.id) continue;
    const selectors = (form?.fields || []).filter(field => field?.id === action.controlId);
    if (selectors.length !== 1 || !isSupportedSelector(selectors[0])) continue;
    const plans = [];
    for (const rule of rules) {
      const binding = inspectNativeFormRuleActionBinding(rule, scripts);
      if (!binding.ok || binding.matches[0] !== action.id || !nativeFormRuleBelongsToAction(rule, action) ||
          !action.coverage?.nativeRules?.includes(rule.id) || !inspectNativeFormRuleProjection(rule).ok ||
          !safeConditions(rule)) continue;
      const yes = visibleTables(rule.effects, index, true);
      const no = visibleTables(rule.else, index, false);
      const contradictory = [...visibleTables(rule.effects, index, false), ...visibleTables(rule.else, index, true)];
      if (!yes.length || yes.length !== no.length || yes.some(id =>
        !no.includes(id) || contradictory.includes(id) || ownership.get(id) !== 1)) continue;
      for (const id of yes) plans.push({ id, expression: conditionExpression(rule) });
    }
    if (!plans.length || new Set(plans.map(plan => plan.id)).size !== plans.length) continue;
    const id = `${action.id}.detail-visibility-sync`;
    if (actions.some(candidate => candidate?.id === id)) {
      const error = new Error("A source action collides with the reserved detail visibility bridge identity.");
      error.code = "projection.detail_visibility_action_collision";
      throw error;
    }
    out.push({
      id, name: "onChange", event: "onChange", scope: "control", controlId: action.controlId,
      translationStatus: "mapped", ...(action.runWhen ? { runWhen: action.runWhen } : {}),
      function: renderSync(plans)
    });
  }
  return { ...scripts, actions: out };
}

function isSupportedSelector(field) {
  if (field.componentId === "xform-radio") return true;
  if (field.componentId !== "xform-select" || field.type !== "singleSelect" || field.dataOnly || field.props?.multi === true) return false;
  const options = field.props?.options;
  return Array.isArray(options) && options.length > 0 &&
    options.every(option => typeof option?.value === "string" && option.value.length > 0) &&
    new Set(options.map(option => option.value)).size === options.length;
}

export function requiresDetailVisibilitySync(scripts = {}, form = {}, formRules = {}) {
  const before = new Set((Array.isArray(scripts?.actions) ? scripts.actions : []).map(action => action?.id));
  return withDetailVisibilitySync(scripts, form, formRules).actions.some(action =>
    action.id?.endsWith(".detail-visibility-sync") && !before.has(action.id));
}

function visibleTables(effects, index, expected) {
  const found = [];
  for (const effect of Array.isArray(effects) ? effects : []) {
    if (effect?.type !== "visible" || expected !== undefined && effect.value !== expected) continue;
    const resolved = resolveEffectTarget(index, effect.target);
    if (!resolved || resolved.unresolved?.length) continue;
    for (const target of resolved.targets || []) {
      if (target.kind === "detailTable" && !found.includes(target.id)) found.push(target.id);
    }
  }
  return found;
}

function safeConditions(rule) {
  return ["and", "or"].includes(rule.logic) && Array.isArray(rule.when) && rule.when.length > 0 &&
    rule.when.every((condition, index) => condition.field === rule.source &&
      ["contains", "notContains"].includes(condition.op) && typeof condition.value === "string" &&
      condition.value.length > 0 && rule.meta?.conditionSemantics?.[index]?.predicate === "indexOf" &&
      Array.isArray(rule.meta.conditionSemantics[index].transforms) &&
      rule.meta.conditionSemantics[index].transforms.length === 0);
}

function conditionExpression(rule) {
  const clauses = rule.when.map(condition =>
    `value.indexOf(${JSON.stringify(condition.value)}) ${condition.op === "contains" ? ">=" : "<"} 0`);
  return clauses.map(clause => `(${clause})`).join(rule.logic === "or" ? " || " : " && ");
}

function renderSync(plans) {
  return [
    "function onChange(value, rowNum, parentRowNum) {",
    '  if (MKXFORM.viewStatus !== "add" && MKXFORM.viewStatus !== "edit") return;',
    '  if (value === null || value === undefined) value = "";',
    '  if (typeof value !== "string") return;',
    "  var host = MKXFORM.$$FORM && MKXFORM.$$FORM.current;",
    "  var mechanisms = host && host.detachedValues && host.detachedValues.mechanisms;",
    '  var auth = mechanisms && mechanisms["sys-auth"] && mechanisms["sys-auth"].fieldPermission;',
    '  if (!auth || typeof MKXFORM.setFieldAttr !== "function") return;',
    ...plans.map(plan => `  if (auth[${JSON.stringify(plan.id)}] && auth[${JSON.stringify(plan.id)}].visible === true) MKXFORM.setFieldAttr(${JSON.stringify(plan.id)}, (${plan.expression}) ? 5 : 4);`),
    "}"
  ].join("\n");
}
