import { nativeFormRuleProjectionRef } from "../dsl/native-form-rule-projection.js";
import { inlineOnChangeSourceActionKey } from "./source-action-key.js";

const SELECTOR = /jQuery\(\s*["']select\[name=["']extendDataFormInfo\.value\(([^)]+)\)["']\]["']\s*\)/;

export function jqueryContainerVisibilityAnalysis(source = {}) {
  const text = String(source.javascript || "");
  if (source.displayGate !== "xform:editShow") return undefined;
  const selector = text.match(SELECTOR);
  if (!selector) return undefined;
  const controlId = selector[1];
  const binding = text.match(/\b([A-Za-z_$][\w$]*)\.on\(\s*(["'])change\2\s*,\s*function\s*\([^)]*\)\s*\{/);
  if (!binding) return undefined;
  const bindingIndex = binding.index;
  const functionMatch = text.match(/function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]*)\}\s*;?\s*\}\s*\)?\s*$/);
  if (!functionMatch) return undefined;
  const [, functionName, parameter, body] = functionMatch;
  if (!new RegExp(`\\b${escapeRegExp(functionName)}\\s*\\(`).test(text.slice(0, bindingIndex))) {
    return undefined;
  }

  const targets = new Map();
  for (const match of body.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*jQuery\(\s*(["'])#([^"']+)\2\s*\)\s*;/g)) {
    targets.set(match[1], normalizeContainerTarget(match[3]));
  }
  if (targets.size < 2) return undefined;

  const branches = [];
  const branchPattern = new RegExp(
    `(?:if|else\\s+if)\\s*\\(\\s*${escapeRegExp(parameter)}\\s*={2,3}\\s*(["'])([^"']+)\\1\\s*\\)\\s*\\{([\\s\\S]*?)\\}`,
    "g"
  );
  for (const match of body.matchAll(branchPattern)) {
    const effects = visibilityEffects(match[3], targets);
    if (!effects.length) return undefined;
    branches.push({ value: match[2], effects });
  }
  const elseMatch = body.match(/else\s*\{([\s\S]*?)\}\s*;?\s*$/);
  const elseEffects = visibilityEffects(elseMatch?.[1] || "", targets);
  if (branches.length < 2 || elseEffects.length !== targets.size) return undefined;
  if (branches.some((branch) => branch.effects.length !== targets.size)) return undefined;

  const sourceRef = source.sourceRef || source.id;
  const sourceActionKey = inlineOnChangeSourceActionKey(sourceRef, bindingIndex);
  const runWhen = { viewStatusIn: ["add", "edit"] };
  const rules = [];
  for (const trigger of ["change"]) {
    for (const target of targets.values()) {
      const active = branches.filter((branch) =>
        branch.effects.some((effect) => effect.target === target && effect.value === true)
      );
      if (active.length !== 1) return undefined;
      const branch = active[0];
      if (!branch.effects.some((effect) => effect.target === target && effect.value === true)) return undefined;
      if (!elseEffects.some((effect) => effect.target === target && effect.value === false)) return undefined;
      const id = `linkage.${controlId}.eq.${stableIdPart(branch.value)}.${stableIdPart(target)}.${trigger}`;
      rules.push({
        id,
        trigger,
        source: controlId,
        logic: "and",
        when: [{ field: controlId, op: "eq", value: branch.value }],
        effects: [{ type: "visible", target, value: true }],
        else: [{ type: "visible", target, value: false }],
        meta: {
          sourceJsp: sourceRef,
          displayGate: source.displayGate,
          runWhen,
          conditionSource: "event:value",
          conditionSemantics: [{
            origin: "event:value",
            transforms: [],
            predicate: "strict-equality"
          }],
          sourceActionKey,
          nativeProjection: nativeFormRuleProjectionRef(),
          sourceRuleIds: [id]
        },
        translationStatus: "executable"
      });
    }
  }
  return { controlId, sourceActionKey, rules, bindingIndex };
}

export function jqueryContainerVisibilityCandidates(source = {}, formRules = {}) {
  const analysis = jqueryContainerVisibilityAnalysis(source);
  if (!analysis) return [];
  const sourceRef = source.sourceRef || source.id;
  const nativeRules = (formRules.linkage || [])
    .filter((rule) => rule.meta?.sourceJsp === sourceRef && rule.meta?.sourceActionKey === analysis.sourceActionKey)
    .map((rule) => rule.id);
  if (nativeRules.length !== analysis.rules.length) return [];
  return [{
    index: analysis.bindingIndex,
    event: "onChange",
    scope: "control",
    controlId: analysis.controlId,
    sourceActionKey: analysis.sourceActionKey,
    javascript: source.javascript,
    translationStatus: "omitted",
    coverage: { status: "covered", nativeRules, residuals: [] },
    functionMappings: [{
      source: "legacy jQuery select-driven container visibility",
      target: "native formRules.linkage",
      basis: "native-form-rule",
      reviewRequired: false
    }],
    semanticHints: {
      coveredLegacyFunctions: (source.functionAudit?.violations || []).map((entry) => entry.name)
    }
  }];
}

function visibilityEffects(body, targets) {
  const effects = [];
  const seen = new Set();
  for (const match of String(body).matchAll(/\b([A-Za-z_$][\w$]*)\.(show|hide)\(\s*\)\s*;/g)) {
    const target = targets.get(match[1]);
    if (!target || seen.has(target)) return [];
    seen.add(target);
    effects.push({ type: "visible", target, value: match[2] === "show" });
  }
  return effects;
}

function normalizeContainerTarget(target) {
  const detail = String(target).match(/^TABLE_DL_(.+)_div$/);
  return detail?.[1] || target;
}

function stableIdPart(value) {
  return String(value).replace(/[^A-Za-z0-9_-]+/g, "_") || "empty";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
