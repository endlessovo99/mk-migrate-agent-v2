import { createHash } from "node:crypto";
import { bridgedInitialVisibilityIssues as schemaInitialVisibilityIssues, bridgedRowVisibilityConflicts } from "../dsl/bridged-row-visibility.js";
import { hasSourceBackedEmptySelect } from "../dsl/source-select-empty-event.js";
import { canonicalRowTarget } from "../dsl/layout-row-targets.js";
import { canonicalJson } from "./digest.js";
import { classifyActionRowMarkers } from "./row-marker-policy.js";
import { validateRowMarkerBranchSemantics } from "./script-semantic-closure.js";

/** Rebuild each proposed ownership change from the fixed source and its draft. */
export function bridgedRowOwnershipProofs(sourceDraft, expectedDraft, reviewedDraft) {
  if (!sourceDraft || !expectedDraft || !reviewedDraft) return [];
  const expectedActions = expectedDraft.scripts?.actions || [];
  const actualActions = reviewedDraft.scripts?.actions || [];
  const sourceRules = sourceDraft.formRules?.linkage || [];
  const expectedRules = expectedDraft.formRules?.linkage || [];
  const aliases = primaryMarkerByAlias(expectedDraft.form);
  const overlaps = bridgedRowVisibilityConflicts(expectedDraft.formRules, expectedDraft.scripts, expectedDraft.form);

  return overlaps.flatMap((overlap) => {
    const rules = expectedRules.filter((rule) => rule.id === overlap.ruleId);
    const changes = expectedActions.filter((action) => action.id === overlap.actionId);
    if (rules.length !== 1 || changes.length !== 1) return [];
    const [rule] = rules, [change] = changes;
    const sourceChanges = sourceRules.filter((item) => item.trigger === "change" &&
      item.translationStatus === "executable" && item.source === rule.source &&
      item.meta?.sourceJsp === rule.meta.bridgeSourceJsp && item.meta?.sourceActionKey === change.sourceActionKey &&
      item.logic === rule.logic && canonicalJson(item.when) === canonicalJson(rule.when) &&
      sameVisibility(item.effects, rule.effects, expectedDraft.form) &&
      sameVisibility(item.else, rule.else, expectedDraft.form));
    if (sourceChanges.length !== 1) return [];

    const loads = expectedActions.filter((action) => {
      const conditions = action.branchProvenance?.conditions || [];
      if (action.event !== "onLoad" || action.scope !== "global" ||
          !action.sourceRefs?.includes(rule.meta.sourceJsp) || action.branchProvenance?.status !== "proven" ||
          conditions.length !== 1 || conditions[0].kind !== "eq" ||
          conditions[0].value !== rule.when[0].value || !conditions[0].origin?.startsWith("field:")) return false;
      const policy = classifyActionRowMarkers(action, expectedDraft.form, sourceDraft);
      return !policy.unresolvedMarkers.length && policy.resolvedMarkers.length === 1 &&
        canonicalRowTarget(expectedDraft.form, policy.resolvedMarkers[0]) === overlap.row;
    });
    if (loads.length !== 1) return [];
    const [load] = loads;
    const actualChange = actualActions.filter((action) => action.id === change.id);
    const actualLoad = actualActions.filter((action) => action.id === load.id);
    let verified = actualChange.length === 1 && actualLoad.length === 1 &&
      actualChange[0].function === change.function &&
      canonicalJson(actualChange[0].deterministicBranchProof) === canonicalJson(change.deterministicBranchProof) &&
      canonicalJson(actualChange[0].sourceRefs) === canonicalJson(change.sourceRefs) &&
      canonicalJson(actualChange[0].runWhen) === canonicalJson(change.runWhen) &&
      actualChange[0].sourceActionKey === change.sourceActionKey &&
      actualLoad[0].translationStatus === "mapped" && actualLoad[0].event === "onLoad" && actualLoad[0].scope === "global" &&
      canonicalJson(actualLoad[0].sourceRefs) === canonicalJson(load.sourceRefs) &&
      canonicalJson(actualLoad[0].runWhen) === canonicalJson(load.runWhen) &&
      canonicalJson(actualLoad[0].branchProvenance) === canonicalJson(load.branchProvenance) &&
      actualLoad[0].coverage?.status === "translated" && Array.isArray(actualLoad[0].coverage?.nativeRules) &&
      actualLoad[0].coverage.nativeRules.length === 0 && Array.isArray(actualLoad[0].coverage?.residuals) &&
      actualLoad[0].coverage.residuals.length === 0 &&
      bridgedRowVisibilityConflicts({ linkage: [rule] }, reviewedDraft.scripts, reviewedDraft.form)
        .some((item) => item.actionId === change.id && item.row === overlap.row);
    if (verified) {
      const policy = classifyActionRowMarkers(load, expectedDraft.form, sourceDraft);
      verified = validateRowMarkerBranchSemantics({
        sourceFunction: load.function,
        reviewedFunction: actualLoad[0].function,
        resolvedMarkers: policy.resolvedMarkers,
        primaryMarkerByAlias: aliases,
        sourceControls: sourceDraft.form?.controls,
        sourceForm: sourceDraft.form,
        sourceScripts: sourceDraft.scripts,
        sourceRefs: load.sourceRefs,
        auditedOrphanMarkers: policy.orphanMarkers,
        targetFields: reviewedDraft.form?.fields
      }).ok;
    }
    return [{ rule, row: overlap.row, changeActionId: change.id, loadActionId: load.id, verified,
      initialHiddenProven: initialHiddenIsSourceBacked(load, change, rule, expectedDraft.form, reviewedDraft.form) }];
  });
}

export function reconcileBridgedRowOwnership(sourceDraft, expectedDraft, reviewedDraft) {
  const proofs = bridgedRowOwnershipProofs(sourceDraft, expectedDraft, reviewedDraft);
  const removed = proofs.filter((proof) => {
    const rules = (reviewedDraft.formRules?.linkage || []).filter((rule) => rule.id === proof.rule.id);
    return proof.verified && proof.initialHiddenProven && rules.length === 1 &&
      canonicalJson(rules[0]) === canonicalJson(proof.rule) &&
      proofs.filter((item) => item.rule.id === proof.rule.id).length === 1;
  });
  if (!removed.length) return { draft: reviewedDraft, removed: [] };
  const ids = new Set(removed.map((proof) => proof.rule.id));
  const retired = proofs.filter((proof) => proof.verified && proof.initialHiddenProven &&
    (ids.has(proof.rule.id) || !(reviewedDraft.formRules?.linkage || []).some((rule) => rule.id === proof.rule.id)));
  const plan = initialVisibilityPlan(proofs, retired);
  if (!plan || !canInstallInitialVisibility(plan, expectedDraft, reviewedDraft)) return { draft: reviewedDraft, removed: [] };
  const fields = (reviewedDraft.form.fields || []).filter((field) => field.id !== plan.field.id);
  const rows = (reviewedDraft.form.layout?.mkTree || []).filter((row) => row.id !== plan.row.id);
  const initIds = new Set(plan.rules.map((rule) => rule.id));
  const candidate = { ...reviewedDraft,
      form: { ...reviewedDraft.form, fields: [...fields, plan.field],
        layout: { ...reviewedDraft.form.layout, mkTree: [...rows, plan.row] } },
      formRules: { ...reviewedDraft.formRules,
        linkage: [...reviewedDraft.formRules.linkage.filter((rule) => !ids.has(rule.id) && !initIds.has(rule.id)), ...plan.rules],
        review: { ...reviewedDraft.formRules.review, bridgedInitialVisibility: plan.metadata } } };
  if (schemaInitialVisibilityIssues(candidate.formRules, candidate.scripts, candidate.form, candidate.review).length) {
    return { draft: reviewedDraft, removed: [] };
  }
  return { draft: candidate, removed };
}

/** Recreate the initialization artifacts so trust never relies on review claims. */
export function bridgedInitialVisibilityIssues(sourceDraft, expectedDraft, reviewedDraft) {
  const proofs = bridgedRowOwnershipProofs(sourceDraft, expectedDraft, reviewedDraft);
  const current = reviewedDraft?.formRules?.linkage || [];
  const retired = proofs.filter((proof) => !current.some((rule) => rule.id === proof.rule.id));
  const issues = [];
  if (retired.some((proof) => !proof.verified || !proof.initialHiddenProven)) issues.push("retired_rule_not_proven");
  const plan = retired.length && retired.every((proof) => proof.verified && proof.initialHiddenProven)
    ? initialVisibilityPlan(proofs, retired) : undefined;
  const metadata = reviewedDraft?.formRules?.review?.bridgedInitialVisibility;
  const anchorFields = (reviewedDraft?.form?.fields || []).filter((field) => field.sourceProps?.generatedInitialVisibilityAnchor === true);
  const generated = current.filter((rule) => rule.meta?.bridgedInitialVisibility?.version === 1);
  if (!plan) {
    if (retired.length) issues.push("initialization_plan_unavailable");
    if (metadata !== undefined || anchorFields.length || generated.length) issues.push("unexpected_initialization_metadata");
    return issues;
  }
  if (canonicalJson(metadata) !== canonicalJson(plan.metadata)) issues.push("initialization_metadata_mismatch");
  const fields = (reviewedDraft.form?.fields || []).filter((field) => field.id === plan.field.id);
  const rows = (reviewedDraft.form?.layout?.mkTree || []).filter((row) => row.id === plan.row.id);
  if (fields.length !== 1 || canonicalJson(fields[0]) !== canonicalJson(plan.field)) issues.push("initialization_anchor_mismatch");
  if (anchorFields.length !== 1 || anchorFields[0].id !== plan.field.id) issues.push("unexpected_initialization_anchor");
  if (rows.length !== 1 || canonicalJson(rows[0]) !== canonicalJson(plan.row)) issues.push("initialization_layout_mismatch");
  for (const expected of plan.rules) {
    const matches = current.filter((rule) => rule.id === expected.id);
    if (matches.length !== 1 || canonicalJson(matches[0]) !== canonicalJson(expected)) issues.push("initialization_rule_mismatch");
  }
  if (generated.length !== plan.rules.length || generated.some((rule) => !plan.rules.some((expected) => expected.id === rule.id))) {
    issues.push("unexpected_initialization_rule");
  }
  if ((reviewedDraft.scripts?.actions || []).some((action) => String(action.function || "").includes(plan.field.id))) {
    issues.push("initialization_anchor_used_by_script");
  }
  return [...new Set(issues)];
}

function initialHiddenIsSourceBacked(load, change, rule, expectedForm, actualForm) {
  const condition = load.branchProvenance?.conditions?.[0];
  const helperId = condition?.origin?.startsWith("field:") ? condition.origin.slice(6) : "";
  const find = (form, id) => (form?.fields || []).filter((field) => field.id === id);
  const expectedHelpers = find(expectedForm, helperId), actualHelpers = find(actualForm, helperId);
  const expectedSelectors = find(expectedForm, change.controlId), actualSelectors = find(actualForm, change.controlId);
  if (expectedHelpers.length !== 1 || actualHelpers.length !== 1 || expectedSelectors.length !== 1 || actualSelectors.length !== 1) return false;
  const [helper] = expectedHelpers, [selector] = expectedSelectors;
  if (helper.componentId !== "xform-hidden" || helper.sourceProps?.hardHidden !== true ||
      helper.sourceProps?.designerValues?.defaultValue !== "" ||
      (helper.sourceProps?.designerValues?.formula || "") !== "" ||
      ![undefined, "", "false"].includes(helper.sourceProps?.designerValues?.reCalculate) ||
      ![undefined, ""].includes(helper.sourceProps?.metadataAttributes?.defaultValue) ||
      helper.props?.defaultValue !== undefined) return false;
  const helperContract = (field) => ({ componentId: field.componentId, dataOnly: field.dataOnly,
    defaultValue: field.props?.defaultValue, hardHidden: field.sourceProps?.hardHidden,
    sourceDefault: field.sourceProps?.designerValues?.defaultValue, sourceFormula: field.sourceProps?.designerValues?.formula,
    sourceRecalculate: field.sourceProps?.designerValues?.reCalculate, metadataDefault: field.sourceProps?.metadataAttributes?.defaultValue });
  const selectorContract = (field) => ({ type: field.type, componentId: field.componentId, defaultValue: field.props?.defaultValue });
  if (canonicalJson(helperContract(helper)) !== canonicalJson(helperContract(actualHelpers[0])) ||
      canonicalJson(selectorContract(selector)) !== canonicalJson(selectorContract(actualSelectors[0]))) return false;
  if (selector.type === "singleSelect" && (!hasSourceBackedEmptySelect(expectedForm, selector.id) ||
      !hasSourceBackedEmptySelect(actualForm, selector.id) ||
      canonicalJson(selector.sourceProps?.runtimeSelectEmpty) !== canonicalJson(actualSelectors[0].sourceProps?.runtimeSelectEmpty) ||
      canonicalJson(selector.props?.options) !== canonicalJson(actualSelectors[0].props?.options))) return false;
  const defaultValue = selector.props?.defaultValue;
  if (defaultValue !== undefined && (defaultValue.kind !== "literal" || typeof defaultValue.value !== "string")) return false;
  const value = defaultValue?.value || "";
  return ["singleSelect", "radio"].includes(selector.type) && value.indexOf(rule.when[0].value) < 0;
}

function initialVisibilityPlan(proofs, retired) {
  if (!proofs.length || !retired.length || new Set(proofs.map((proof) => proof.rule.id)).size !== proofs.length) return undefined;
  const ordered = [...proofs].sort((a, b) => a.rule.id.localeCompare(b.rule.id));
  const token = createHash("sha256").update(canonicalJson(ordered.map((proof) => proof.rule.id))).digest("hex").slice(0, 12);
  const anchorId = `fd_vinit_${token}`, sourceRef = ordered[0].rule.meta.sourceJsp;
  const reason = "Anchor source-proven initial row visibility without reacting to category changes.";
  const field = { id: anchorId, title: "Initial visibility anchor", type: "text", componentId: "xform-hidden",
    props: { required: false }, sourceProps: { generatedInitialVisibilityAnchor: true }, generated: true, reason, sourceRef };
  const row = { id: `layout.initial-visibility.${token}`, componentId: "xform-flex-1-1-layout",
    props: { columns: 1, sourceColumns: 1 }, generated: true, reason, sourceRef,
    children: [{ id: `layout.initial-visibility.${token}.cell`, refType: "field", refIds: [anchorId],
      generated: true, reason, sourceRef, column: 0, colspan: 1 }] };
  const entries = [...retired].sort((a, b) => a.rule.id.localeCompare(b.rule.id)).map((proof) => ({
    ruleId: proof.rule.id, row: proof.row, changeActionId: proof.changeActionId, loadActionId: proof.loadActionId
  }));
  const rules = entries.map((entry) => {
    const original = retired.find((proof) => proof.rule.id === entry.ruleId).rule;
    return { id: `initial.${entry.ruleId}`, trigger: "load", source: anchorId, logic: "and",
      when: [{ field: anchorId, op: "empty" }], effects: structuredClone(original.else),
      meta: { sourceJsp: original.meta.sourceJsp, bridgedInitialVisibility: { version: 1, originalRuleId: entry.ruleId } },
      translationStatus: "executable" };
  });
  return { field, row, rules, metadata: { version: 1, anchorId, entries } };
}

function canInstallInitialVisibility(plan, expectedDraft, reviewedDraft) {
  const layoutIds = (form) => (form?.layout?.mkTree || []).flatMap((row) => [row.id, ...(row.children || []).map((child) => child.id)]);
  if ((expectedDraft.form?.fields || []).some((field) => field.id === plan.field.id ||
      (field.columns || []).some((column) => column.id === plan.field.id)) ||
      layoutIds(expectedDraft.form).some((id) => id === plan.row.id || id === plan.row.children[0].id)) return false;
  if ((reviewedDraft.form?.fields || []).some((field) => (field.columns || []).some((column) => column.id === plan.field.id))) return false;
  if (layoutIds(reviewedDraft.form).filter((id) => id === plan.row.children[0].id).length >
      (reviewedDraft.form?.layout?.mkTree || []).filter((row) => row.id === plan.row.id).length) return false;
  if ((reviewedDraft.scripts?.actions || []).some((action) => String(action.function || "").includes(plan.field.id))) return false;
  const fields = (reviewedDraft.form?.fields || []).filter((field) => field.id === plan.field.id);
  const rows = (reviewedDraft.form?.layout?.mkTree || []).filter((row) => row.id === plan.row.id);
  if (fields.length > 1 || fields.length === 1 && canonicalJson(fields[0]) !== canonicalJson(plan.field) ||
      rows.length > 1 || rows.length === 1 && canonicalJson(rows[0]) !== canonicalJson(plan.row)) return false;
  return plan.rules.every((expected) => {
    const rules = (reviewedDraft.formRules?.linkage || []).filter((rule) => rule.id === expected.id);
    return rules.length === 0 || rules.length === 1 && canonicalJson(rules[0]) === canonicalJson(expected);
  });
}

function sameVisibility(sourceEffects, expectedEffects, form) {
  const keys = (effects) => (effects || []).filter((effect) => effect.type === "visible")
    .map((effect) => [canonicalRowTarget(form, effect.target), effect.value])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const left = keys(sourceEffects), right = keys(expectedEffects);
  return left.length > 0 && left.every(([row, value]) => row && typeof value === "boolean") &&
    canonicalJson(left) === canonicalJson(right);
}

function primaryMarkerByAlias(form) {
  const aliases = new Map();
  for (const row of form?.layout?.mkTree || []) {
    const markers = (row.sourceMarkers || []).filter(Boolean);
    for (const marker of markers) aliases.set(marker, markers[0]);
  }
  return aliases;
}
