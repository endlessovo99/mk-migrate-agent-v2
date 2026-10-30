import { parse } from "acorn";
import { canonicalRowTarget } from "./layout-row-targets.js";
import { hasVerifiedDeterministicScriptBranchProof } from "./deterministic-script-translations.js";
import { hasSourceBackedEmptySelect } from "./source-select-empty-event.js";

/** Find load rules that also react to a row-owning change action. */
export function bridgedRowVisibilityConflicts(formRules, scripts, form) {
  const actions = Array.isArray(scripts?.actions) ? scripts.actions : [];
  return (Array.isArray(formRules?.linkage) ? formRules.linkage : []).flatMap((rule) => {
    const row = bridgedVisibilityRow(rule, form);
    if (!row) return [];
    return actions.filter((action) => changeOwnsRow(action, rule, row)).map((action) => ({
      ruleId: rule.id,
      actionId: action.id,
      row
    }));
  });
}

/** The initialization anchor must stay inert after the native initial rule pass. */
export function bridgedInitialVisibilityIssues(formRules, scripts, form, review) {
  const metadata = formRules?.review?.bridgedInitialVisibility;
  const list = (value) => Array.isArray(value) ? value : [];
  const decisions = list(review?.decisions).filter((decision) => decision?.decisionType === "deterministic_script_ownership");
  const fields = list(form?.fields), rules = list(formRules?.linkage), actions = list(scripts?.actions);
  if (!metadata) return decisions.length || fields.some((field) => field?.sourceProps?.generatedInitialVisibilityAnchor === true) ||
    rules.some((rule) => rule?.meta?.bridgedInitialVisibility !== undefined)
    ? ["initialization_metadata_missing"] : [];
  if (metadata.version !== 1 || typeof metadata.anchorId !== "string" || !Array.isArray(metadata.entries) || !metadata.entries.length) {
    return ["initialization_metadata_invalid"];
  }
  const issues = [], anchorId = metadata.anchorId, entries = metadata.entries;
  if (new Set(entries.map((entry) => entry?.ruleId)).size !== entries.length ||
      entries.some((entry) => !entry?.ruleId || !entry.row || !entry.changeActionId || !entry.loadActionId)) {
    issues.push("initialization_entries_invalid");
  }
  const anchors = fields.filter((field) => field?.id === anchorId);
  if (anchors.length !== 1 || anchors[0].componentId !== "xform-hidden" || anchors[0].generated !== true ||
      anchors[0].sourceProps?.generatedInitialVisibilityAnchor !== true || anchors[0].props?.defaultValue !== undefined ||
      anchors[0].props?.required !== false) issues.push("initialization_anchor_invalid");
  const references = list(form?.layout?.mkTree).flatMap((row) => list(row?.children))
    .filter((child) => child?.refType === "field" && Array.isArray(child.refIds) && child.refIds.includes(anchorId));
  if (references.length !== 1) issues.push("initialization_anchor_layout_invalid");
  for (const entry of entries) {
    if (!entry?.ruleId || !entry.row || !entry.changeActionId || !entry.loadActionId) continue;
    const matches = rules.filter((rule) => rule?.id === `initial.${entry.ruleId}`);
    const rule = matches[0];
    if (matches.length !== 1 || rule.trigger !== "load" || rule.source !== anchorId || rule.logic !== "and" ||
        rule.translationStatus !== "executable" || rule.when?.length !== 1 || rule.when[0]?.field !== anchorId ||
        rule.when[0]?.op !== "empty" || rule.effects?.length !== 1 || rule.effects[0]?.type !== "visible" ||
        rule.effects[0]?.value !== false || canonicalRowTarget(form, rule.effects[0]?.target) !== entry.row ||
        rule.else !== undefined || rule.meta?.bridgedInitialVisibility?.version !== 1 ||
        rule.meta.bridgedInitialVisibility.originalRuleId !== entry.ruleId) {
      issues.push("initialization_rule_invalid");
    }
    const changeActions = actions.filter((action) => action?.id === entry.changeActionId && action.event === "onChange" && action.translationStatus === "mapped");
    if (changeActions.length !== 1 ||
        actions.filter((action) => action?.id === entry.loadActionId && action.event === "onLoad" && action.translationStatus === "mapped").length !== 1) {
      issues.push("initialization_owner_invalid");
    }
    if (changeActions.length === 1) {
      const selector = fields.filter((field) => field?.id === changeActions[0].controlId);
      if (selector.length !== 1 || selector[0].type === "singleSelect" &&
          !bridgedEmptySelectEventFunction(changeActions[0], form)) issues.push("initialization_empty_select_unproven");
    }
  }
  if (rules.filter((rule) => rule?.source === anchorId || list(rule?.when).some((condition) => condition?.field === anchorId)).length !== entries.length) {
    issues.push("initialization_anchor_rule_invalid");
  }
  if (rules.some((rule) => [...list(rule?.effects), ...list(rule?.else)].some((effect) => effect?.target === anchorId))) {
    issues.push("initialization_anchor_targeted_by_rule");
  }
  if (actions.some((action) => String(action?.function || "").includes(anchorId))) issues.push("initialization_anchor_used_by_script");
  if (actions.some((action) => hasUnprovenAnchorAccess(action, form))) issues.push("initialization_dynamic_write_unproven");
  for (const decision of decisions) {
    const ruleId = String(decision.id || "").replace(/^script-owned-load-/, "");
    if (!entries.some((entry) => entry.ruleId === ruleId)) issues.push("initialization_decision_unmatched");
  }
  return [...new Set(issues)];
}

/** Project the native null clear to a source-proven blank only for a closed row callback. */
export function bridgedEmptySelectEventFunction(action, form) {
  if (action?.event !== "onChange" || action.scope !== "control" || action.tableId ||
      action.semanticHints?.ownsLegacyRowEffects !== true || !hasVerifiedDeterministicScriptBranchProof(action) ||
      !hasSourceBackedEmptySelect(form, action.controlId)) return undefined;
  const source = String(action.function || "");
  let fn;
  try { fn = parse(`(${source})`, { ecmaVersion: "latest" }).body[0]?.expression; } catch { return undefined; }
  if (fn?.type !== "FunctionExpression" || fn.params?.[0]?.type !== "Identifier" ||
      fn.body?.type !== "BlockStatement" || fn.body.body.length !== 1) return undefined;
  const branch = fn.body.body[0], test = branch?.test, index = test?.left;
  if (branch?.type !== "IfStatement" || !branch.alternate || test?.type !== "BinaryExpression" || test.operator !== ">=" ||
      test.right?.type !== "Literal" || test.right.value !== 0 || index?.type !== "CallExpression" ||
      index.callee?.type !== "MemberExpression" || index.callee.computed || index.callee.property?.name !== "indexOf" ||
      index.arguments?.length !== 1 || index.arguments[0]?.type !== "Literal" || typeof index.arguments[0].value !== "string" ||
      index.callee.object?.type !== "Identifier" || index.callee.object.name !== fn.params[0].name) return undefined;
  const receiver = index.callee.object, parameter = fn.params[0].name;
  let references = 0, otherUse = false;
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "Identifier" && node.name === parameter) {
      references += 1;
      if (node !== receiver) otherUse = true;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(fn.body);
  if (references !== 1 || otherUse) return undefined;
  const replacement = `(${parameter} === null ? "" : ${parameter})`;
  return source.slice(0, receiver.start - 1) + replacement + source.slice(receiver.end - 1);
}

function hasUnprovenAnchorAccess(action, form) {
  if (action?.translationStatus !== "mapped" || !action.function) return false;
  let ast;
  try { ast = parse(`(${action.function})`, { ecmaVersion: "latest" }); } catch { return true; }
  function visit(node, parent) {
    if (!node || typeof node !== "object") return false;
    if (node.type === "Identifier" && node.name === "MKXFORM" &&
        !(parent?.type === "MemberExpression" && parent.object === node)) return true;
    if (node.type === "MemberExpression" && node.object?.name === "MKXFORM") {
      const property = node.computed ? node.property?.type === "Literal" && node.property.value : node.property?.name;
      if (typeof property !== "string") return true;
      const call = parent?.type === "CallExpression" && parent.callee === node;
      const detailUpdate = ["updateControl", "updateControlStyle"].includes(property);
      if (call && !["getValue", "setValue", "setFieldAttr", "updateControl", "updateControlStyle"].includes(property)) return true;
      if (detailUpdate && (!call || !isUniqueDetailTarget(parent.arguments?.[0], form))) return true;
      if (["setValue", "setFieldAttr"].includes(property) &&
          (!call || parent.arguments?.[0]?.type !== "Literal" || typeof parent.arguments[0].value !== "string")) return true;
    }
    return Object.values(node).some((value) => Array.isArray(value) ? value.some((child) => visit(child, node)) :
      value && typeof value === "object" && visit(value, node));
  }
  return visit(ast, undefined);
}

function isUniqueDetailTarget(argument, form) {
  if (argument?.type !== "Literal" || typeof argument.value !== "string") return false;
  const match = /^\$\{table:([^{}]+)\}\.([^\.\s]+)$/u.exec(argument.value);
  if (!match) return false;
  const tables = (Array.isArray(form?.fields) ? form.fields : []).filter((field) => field?.type === "detailTable" && field.id === match[1]);
  return tables.length === 1 && Array.isArray(tables[0].columns) && tables[0].columns.filter((column) => column?.id === match[2]).length === 1;
}

function bridgedVisibilityRow(rule, form) {
  if (rule?.trigger !== "load" || rule.translationStatus !== "executable" ||
      rule.meta?.partialNativeRowEffects !== true ||
      typeof rule.meta?.sourceJsp !== "string" || typeof rule.meta?.bridgeSourceJsp !== "string" ||
      rule.logic !== "and" || rule.when?.length !== 1 || rule.when[0]?.op !== "contains" ||
      rule.when[0]?.field !== rule.source || typeof rule.when[0]?.value !== "string" || !rule.when[0].value ||
      rule.effects?.length !== 1 || rule.else?.length !== 1) return undefined;
  const [yes] = rule.effects, [no] = rule.else;
  if (yes?.type !== "visible" || yes.value !== true || no?.type !== "visible" || no.value !== false) return undefined;
  const row = canonicalRowTarget(form, yes.target);
  return row && row === canonicalRowTarget(form, no.target) ? row : undefined;
}

function changeOwnsRow(action, rule, row) {
  if (action?.event !== "onChange" || action.scope !== "control" || action.controlId !== rule.source ||
      action.semanticHints?.ownsLegacyRowEffects !== true ||
      !action.sourceRefs?.includes(rule.meta.bridgeSourceJsp) ||
      !action.functionMappings?.some((mapping) => mapping?.basis === "deterministic-inline-radio-row-effects") ||
      !hasVerifiedDeterministicScriptBranchProof(action)) return false;
  let fn;
  try { fn = parse(`(${action.function})`, { ecmaVersion: "latest" }).body[0]?.expression; }
  catch { return false; }
  if (!["FunctionExpression", "ArrowFunctionExpression"].includes(fn?.type) || fn.body?.type !== "BlockStatement" ||
      fn.params?.[0]?.type !== "Identifier" || fn.body.body.length !== 1) return false;
  const branch = fn.body.body[0], test = branch?.test;
  const index = test?.left;
  if (branch?.type !== "IfStatement" || !branch.alternate || test?.type !== "BinaryExpression" ||
      test.operator !== ">=" || test.right?.type !== "Literal" || test.right.value !== 0 ||
      index?.type !== "CallExpression" || index.callee?.type !== "MemberExpression" || index.callee.computed ||
      index.callee.object?.name !== fn.params[0].name || index.callee.property?.name !== "indexOf" ||
      index.arguments?.length !== 1 || index.arguments[0]?.type !== "Literal" ||
      index.arguments[0].value !== rule.when[0].value) return false;
  return hasRowAttribute(branch.consequent, row, 5) && hasRowAttribute(branch.alternate, row, 4);
}

function hasRowAttribute(branch, row, attribute) {
  const statements = branch?.type === "BlockStatement" ? branch.body : [branch];
  return statements.some((statement) => {
    const call = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
    return call?.type === "CallExpression" && call.callee?.type === "MemberExpression" && !call.callee.computed &&
      call.callee.object?.name === "MKXFORM" && call.callee.property?.name === "setFieldAttr" &&
      call.arguments?.length === 2 && call.arguments[0]?.type === "Literal" && call.arguments[0].value === row &&
      call.arguments[1]?.type === "Literal" && call.arguments[1].value === attribute;
  });
}
