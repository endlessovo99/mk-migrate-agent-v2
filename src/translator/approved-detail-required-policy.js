import { buildFormRuleRefIndex, resolveEffectTarget } from "../dsl/form-rules.js";
import { componentSupportsProp } from "../dsl/catalogs.js";
import { hasVerifiedDeterministicScriptBranchProof } from "../dsl/deterministic-script-translations.js";
import { parse } from "acorn";
import { canonicalJson } from "../agent-review/digest.js";

export const CONFIRMED_DETAIL_REQUIRED_KIND = "confirmed-detail-required";

export function validateConfirmedDetailRequiredDecisions(decisions) {
  const valid = Array.isArray(decisions) && decisions.length > 0 && decisions.every(decision => {
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) return false;
    const keys = Object.keys(decision).sort().join(",");
    return keys === "id,kind,ruleId,sourceRef" && decision.kind === CONFIRMED_DETAIL_REQUIRED_KIND &&
      [decision.id, decision.sourceRef, decision.ruleId].every(value => typeof value === "string" && value.trim());
  }) && new Set(decisions.map(decision => decision.id)).size === decisions.length &&
    new Set(decisions.map(decision => decision.sourceRef)).size === decisions.length;
  return valid ? { ok: true, diagnostics: [] } : { ok: false, diagnostics: [{
    level: "error", code: "policy.detail_required.invalid",
    message: "A confirmed detail requirement needs a unique decision, source column and existing conditional rule."
  }] };
}

/** A row helper can act on validators the exported designer did not expose.
 * Surface this conflict without turning every explicitly optional column required. */
export function ambiguousDetailRequiredWarnings(form, sourceRules = {}) {
  const index = buildFormRuleRefIndex(form), warnings = [];
  for (const rule of sourceRules.linkage || []) {
    if (rule.trigger !== "change") continue;
    for (const effect of rule.effects || []) {
      if (effect.type !== "required" || effect.value !== true ||
          !(rule.else || []).some(other => other.type === "required" && other.value === false && other.target === effect.target)) continue;
      const resolved = resolveEffectTarget(index, effect.target);
      if (resolved?.source !== "rowMarker" || resolved.unresolved?.length) continue;
      for (const table of resolved.targets.filter(target => target.kind === "detailTable")) {
        const fields = (table.columns || []).map(entry => entry.field).filter(field =>
          field.props?.required === false && field.dataOnly !== true && field.props?.readOnly !== true &&
          field.sourceProps?.hardHidden !== true && componentSupportsProp(field.componentId, "required"));
        if (fields.length) warnings.push({ level: "warning", code: "source.form.detail_conditional_required_ambiguous",
          path: "/form/fields", message: "A conditional row requirement overlaps explicitly optional detail columns; verify source runtime or obtain a field-specific business decision.",
          details: { ruleId: rule.id, tableId: table.id, fields: fields.map(field => ({ id: field.id, sourceRef: field.sourceRef })) } });
      }
    }
  }
  return warnings;
}

export function applyConfirmedDetailRequiredPolicies(sourceDraft, baseDraft, decisions) {
  if (!validateConfirmedDetailRequiredDecisions(decisions).ok) throw new Error("Invalid confirmed detail requirement.");
  const draft = structuredClone(baseDraft), index = buildFormRuleRefIndex(draft.form), audits = [];
  const changedActionIds = [];
  for (const decision of decisions) {
    const originals = (sourceDraft.form?.detailTables || []).flatMap(table =>
      (table.columns || []).filter(column => column.sourceRef === decision.sourceRef).map(column => ({ table, column })));
    const targets = (draft.form?.fields || []).filter(table => table.type === "detailTable").flatMap(table =>
      (table.columns || []).filter(column => column.sourceRef === decision.sourceRef).map(column => ({ table, column })));
    if (originals.length !== 1 || targets.length !== 1) throw new Error("The confirmed detail column is not unique.");
    const original = originals[0], target = targets[0];
    if (original.table.id !== target.table.id || original.column.id !== target.column.id ||
        original.column.required !== false || target.column.props?.required !== false || target.column.dataOnly === true ||
        target.column.sourceProps?.hardHidden === true || target.column.props?.readOnly === true ||
        !componentSupportsProp(target.column.componentId, "required")) {
      throw new Error("The confirmed detail column is not an editable optional source field.");
    }
    const sourceRules = (sourceDraft.formRules?.linkage || []).filter(rule => rule.id === decision.ruleId);
    if (sourceRules.length !== 1 || sourceRules[0].trigger !== "change") {
      throw new Error("The confirmed conditional rule is not uniquely executable.");
    }
    const sourceRule = sourceRules[0];
    const pairs = (sourceRule.effects || []).filter(effect => effect.type === "required" && effect.value === true &&
      (sourceRule.else || []).some(other => other.type === "required" && other.value === false && other.target === effect.target));
    const matches = pairs.filter(effect => {
      const resolved = resolveEffectTarget(index, effect.target);
      return resolved?.source === "rowMarker" && !resolved.unresolved?.length &&
        resolved.targets.filter(item => item.kind === "detailTable" && item.id === target.table.id).length === 1 &&
        (sourceRule.effects || []).some(item => item.type === "visible" && item.value === true && item.target === effect.target) &&
        (sourceRule.else || []).some(item => item.type === "visible" && item.value === false && item.target === effect.target) &&
        (sourceRule.effects || []).some(item => item.type === "required" && item.value === true && item.target === effect.target) &&
        (sourceRule.else || []).some(item => item.type === "required" && item.value === false && item.target === effect.target);
    });
    if (matches.length !== 1) throw new Error("The conditional rule does not uniquely own the target detail table.");
    const marker = matches[0].target;
    const rules = (draft.formRules?.linkage || []).filter(rule => rule.id === decision.ruleId &&
      rule.trigger === "change" && rule.translationStatus === "executable" &&
      (rule.effects || []).some(effect => effect.type === "required" && effect.value === true && effect.target === marker) &&
      (rule.else || []).some(effect => effect.type === "required" && effect.value === false && effect.target === marker));
    const actions = (draft.scripts?.actions || []).filter(action => action.event === "onChange" &&
      action.controlId === sourceRule.source && action.sourceActionKey === sourceRule.meta?.sourceActionKey &&
      action.sourceRefs?.includes(sourceRule.meta?.sourceJsp) && action.translationStatus === "mapped" &&
      hasVerifiedDeterministicScriptBranchProof(action) && hasRequiredCalls(action.function, marker));
    if (rules.length + actions.length !== 1) throw new Error("The confirmed conditional rule has no unique native owner.");
    if (rules.length && (rules[0].source !== sourceRule.source || rules[0].logic !== sourceRule.logic ||
        canonicalJson(rules[0].when) !== canonicalJson(sourceRule.when))) {
      throw new Error("The native condition differs from the confirmed source rule.");
    }
    const conflicts = (draft.formRules?.linkage || []).filter(other => other.id !== decision.ruleId &&
      other.translationStatus === "executable").some(other => [...(other.effects || []), ...(other.else || [])]
      .filter(effect => effect.type === "required").some(effect => {
        const resolved = resolveEffectTarget(index, effect.target);
        return resolved?.targets?.some(item => item.kind === "detailTable" && item.id === target.table.id ||
          item.kind === "detailColumn" && item.parentId === target.table.id && item.id === target.column.id);
      }));
    if (conflicts) throw new Error("Another executable rule also controls this detail column.");
    const conditions = sourceRule.when || [];
    if (conditions.length !== 1 || conditions[0].field !== sourceRule.source ||
        !["eq", "contains"].includes(conditions[0].op) ||
        typeof conditions[0].value !== "string" || !conditions[0].value ||
        typeof sourceRule.meta?.sourceJsp !== "string") {
      throw new Error("The confirmed conditional selector is outside the supported single-value profile.");
    }
    const selectors = (draft.form?.fields || []).filter(field => field.id === sourceRule.source);
    if (selectors.length !== 1 || !["radio", "singleSelect"].includes(selectors[0].type) ||
        selectors[0].props?.multiple === true) {
      throw new Error("The confirmed conditional selector must be a single-choice main field.");
    }
    const owner = (sourceDraft.scripts?.sources || []).filter(item => item.sourceRef === sourceRule.meta.sourceJsp);
    const offset = /#onChange@(\d+)$/.exec(sourceRule.meta.sourceActionKey || "");
    let program;
    try { program = owner.length === 1 ? parse(owner[0].javascript, { ecmaVersion: "latest" }) : undefined; }
    catch { throw new Error("The original conditional selector is not parseable."); }
    const statements = (program?.body || []).filter(node => offset && node.start === Number(offset[1]));
    const originalCall = statements[0]?.expression;
    if (statements.length !== 1 || originalCall?.type !== "CallExpression" ||
        originalCall.callee?.type !== "Identifier" || originalCall.arguments?.length !== 2 ||
        originalCall.callee?.name !== "AttachXFormValueChangeEventById" ||
        originalCall.arguments?.[0]?.value !== sourceRule.source) {
      throw new Error("The original conditional selector is not unique.");
    }
    target.column.props = { ...target.column.props, required: true };
    draft.scripts = draft.scripts || { actions: [] };
    draft.scripts.actions = draft.scripts.actions || [];
    for (const event of ["onLoad", "onChange"]) {
      const actionId = `policy.detail-required.${decision.id}.${event}`;
      if (draft.scripts.actions.some(action => action.id === actionId)) throw new Error("Duplicate detail requirement action.");
      const read = event === "onLoad" ? `MKXFORM.getValue(${JSON.stringify(sourceRule.source)})` : "value";
      const expected = JSON.stringify(conditions[0].value);
      const condition = conditions[0].op === "eq" ? `current === ${expected}` : `current.indexOf(${expected}) >= 0`;
      const qualified = `\${table:${target.table.id}}.${target.column.id}`;
      draft.scripts.actions.push({ id: actionId, name: event, event, scope: event === "onLoad" ? "global" : "control",
        ...(event === "onChange" ? { controlId: sourceRule.source } : {}),
        translationStatus: "mapped", sourceRefs: [sourceRule.meta.sourceJsp],
        semanticHints: { confirmedDetailRequiredSupplement: {
          version: 1, sourceRef: sourceRule.meta.sourceJsp, ruleId: decision.ruleId,
          columnSourceRef: decision.sourceRef, event
        } },
        function: `function ${event}(${event === "onLoad" ? "context" : "value, rowNum, parentRowNum"}) {\n` +
          `  if (MKXFORM.viewStatus !== "add" && MKXFORM.viewStatus !== "edit") return;\n` +
          `  var raw = ${read};\n  var current = String((Array.isArray(raw) ? raw[0] : raw) ?? "");\n` +
          `  MKXFORM.setDetailFieldAttr(${JSON.stringify(qualified)}, ${condition} ? 3 : 6);\n}` });
      changedActionIds.push(actionId);
    }
    audits.push({ kind: decision.kind, decisionId: decision.id, sourceRef: decision.sourceRef,
      ruleId: decision.ruleId, tableId: target.table.id, columnId: target.column.id, nativeSourceRefs: [sourceRule.meta.sourceJsp],
      approvedDifference: "The caller confirmed this source-optional detail column is required only while its existing row condition is active." });
  }
  return { draft, audits, changedActionIds };
}

function hasRequiredCalls(source, marker) {
  let ast;
  try { ast = parse(String(source || ""), { ecmaVersion: "latest" }); } catch { return false; }
  const found = new Set();
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression" && !node.callee.computed &&
        node.callee.object?.name === "MKXFORM" && node.callee.property?.name === "setFieldAttr" &&
        node.arguments.length === 2 && node.arguments[0]?.value === marker && [3, 6].includes(node.arguments[1]?.value)) {
      found.add(node.arguments[1].value);
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(ast);
  return found.has(3) && found.has(6);
}
