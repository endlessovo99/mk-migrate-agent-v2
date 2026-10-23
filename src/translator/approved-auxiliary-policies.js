import { parse } from "acorn";
import { createHash } from "node:crypto";
import { canonicalJson, sha256Digest } from "../agent-review/digest.js";
import { buildJavaScriptBindingModel } from "../dsl/javascript-binding-provenance.js";
import { inlineRadioRowEffectCandidates } from "./inline-radio-row-effects.js";
import { literalArrayRowLifecycleCandidates } from "./literal-array-row-lifecycle.js";
import { approvedScalarStringReadExpression } from "./approved-scalar-string-read.js";
import { normalizeAuditedSourceRowOrphans } from "./source-row-orphan-normalization.js";

export const APPROVED_AUXILIARY_POLICY_KINDS = Object.freeze(["retire_missing_auxiliary_bindings", "current_selected_string_reads"]);
const hash = text => `sha256:${createHash("sha256").update(String(text)).digest("hex")}`;
const fieldId = value => typeof value === "string" && /^[A-Za-z_][\w]*$/.test(value);
const sha = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const APIs = new Set(["GetXFormFieldById", "GetXFormFieldValueById", "SetXFormFieldValueById", "common_required", "common_not_required"]);
const protectedGlobals = new Set([...APIs, "$", "common_dom_row_set_show_required_reset", "Com_AddEventListener",
  "AttachXFormValueChangeEventById", "setTimeout", "Array"]);

export function validateApprovedAuxiliaryDecisions(decisions) {
  const diagnostics = [];
  const invalid = (message, index) => diagnostics.push({ level: "error", code: "policy.auxiliary.invalid_decision", message, path: `/decisions/${index}` });
  if (!Array.isArray(decisions)) invalid("Decisions must be an array.", 0);
  else {
    const identities = new Set();
    decisions.forEach((decision, index) => {
      const allowed = decision?.kind === "retire_missing_auxiliary_bindings"
        ? ["kind", "sourceRef", "sourceJavascriptSha256", "retiredValueFieldIds", "replacementReadFieldId", "retiredRequiredFieldIds"]
        : decision?.kind === "current_selected_string_reads" ? ["kind", "sourceRef", "sourceJavascriptSha256", "fieldIds"] : [];
      if (!allowed.length || !decision || Object.keys(decision).some(key => !allowed.includes(key)) ||
          typeof decision.sourceRef !== "string" || !decision.sourceRef.trim() || decision.sourceRef !== decision.sourceRef.trim() || !sha(decision.sourceJavascriptSha256)) {
        invalid("Decision kind, source reference, source SHA or keys are invalid.", index); return;
      }
      const key = `${decision.kind}:${decision.sourceRef}`;
      if (identities.has(key)) invalid("A source policy kind must not be duplicated.", index);
      identities.add(key);
      const validList = list => Array.isArray(list) && list.every(fieldId) && new Set(list).size === list.length;
      if (decision.kind === "current_selected_string_reads") {
        if (!validList(decision.fieldIds) || !decision.fieldIds.length) invalid("Selected String reads require unique field IDs.", index);
      } else {
        const values = decision.retiredValueFieldIds, required = decision.retiredRequiredFieldIds;
        if (!validList(values) || !validList(required) || values.some(id => required.includes(id)) || !values.length && !required.length ||
            values.length && (!fieldId(decision.replacementReadFieldId) || values.includes(decision.replacementReadFieldId)) ||
            !values.length && decision.replacementReadFieldId !== undefined) invalid("Retirement fields or replacement read field are invalid.", index);
      }
    });
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

export function applyApprovedAuxiliaryPolicies(sourceDraft, draft, decisions = []) {
  const result = { draft: structuredClone(draft), audits: [], changedActionIds: [] };
  const own = Array.isArray(decisions) ? decisions.filter(d => APPROVED_AUXILIARY_POLICY_KINDS.includes(d?.kind)) : decisions;
  const validation = validateApprovedAuxiliaryDecisions(own);
  if (!validation.ok) { result.audits.push({ status: "rejected", reason: "invalid_decisions", diagnostics: validation.diagnostics }); return result; }
  const policies = sourceDraft?.migrationPolicies;
  const groups = new Map();
  for (const decision of own) {
    if (!groups.has(decision.sourceRef)) groups.set(decision.sourceRef, []);
    groups.get(decision.sourceRef).push(decision);
  }
  for (const [sourceRef, specifications] of groups) {
    const audit = { sourceRef, kinds: specifications.map(d => d.kind), decisionDigests: specifications.map(sha256Digest), status: "rejected", changedActionIds: [] };
    result.audits.push(audit);
    try {
      requireProof(policies?.version === 1 && Array.isArray(policies.decisions) && specifications.every(d =>
        policies.decisions.filter(p => canonicalJson(p) === canonicalJson(d)).length === 1), "approved_manifest_missing_or_changed");
      const matches = (sourceDraft.scripts?.sources || []).filter(s => (s.sourceRef || s.id) === sourceRef);
      requireProof(matches.length === 1, "source_identity_ambiguous");
      const original = matches[0], text = String(original.javascript || "");
      requireProof(specifications.every(d => d.sourceJavascriptSha256 === hash(text)), "source_sha_mismatch");
      const ast = parse(text, { ecmaVersion: "latest" }), bindings = buildJavaScriptBindingModel(text);
      requireProof(bindings.ok && stableApis(sourceDraft.scripts.sources), "source_api_binding_unproven");
      const parents = new WeakMap(); walk(ast, (node, parent) => { if (parent) parents.set(node, parent); });
      const originalCallbacks = callbacks(ast);
      requireProof(originalCallbacks.length > 0, "callback_boundary_missing");
      const patches = [], selectedReads = new Set(), normalized = { ast, bindings, parents, text, patches, selectedReads, form: result.draft.form };
      for (const decision of specifications) {
        if (decision.kind === "retire_missing_auxiliary_bindings") retireBindings(normalized, decision, sourceDraft);
        else approveSelectedReads(normalized, decision, originalCallbacks);
      }
      const ordered = [...patches].sort((a, b) => a.start - b.start);
      requireProof(ordered.length > 0 && ordered.every((p, i) => !i || ordered[i - 1].end <= p.start), "empty_or_overlapping_rewrite");
      const javascript = [...ordered].reverse().reduce((value, p) => value.slice(0, p.start) + p.replacement + value.slice(p.end), text);
      const orphanNormalization = normalizeAuditedSourceRowOrphans({ ...original, javascript }, result.draft.form);
      const normalizedSource = { ...original, javascript: orphanNormalization?.javascript || javascript }, normalizedScripts = { ...sourceDraft.scripts,
        sources: sourceDraft.scripts.sources.map(s => s === original ? normalizedSource : s) };
      audit.sourceJavascriptSha256 = hash(text); audit.normalizedSourceJavascriptSha256 = hash(javascript);
      audit.compilerSourceJavascriptSha256 = hash(normalizedSource.javascript);
      if (orphanNormalization) audit.orphanRowNormalization = orphanNormalization.evidence;
      audit.originalCallbacks = originalCallbacks; audit.approvedScalarReadFieldIds = [...selectedReads];
      audit.rewrites = ordered.map(p => ({ start: p.start, end: p.end, reason: p.reason,
        originalSha256: hash(text.slice(p.start, p.end)), replacementSha256: hash(p.replacement) }));
      const options = { approvedScalarReadFieldIds: [...selectedReads], approvedPolicyNormalization: true };
      const sets = [
        literalArrayRowLifecycleCandidates(normalizedSource, result.draft.form, normalizedScripts, options),
        inlineRadioRowEffectCandidates(normalizedSource, result.draft.form, {}, options)
      ];
      const targets = result.draft.scripts.actions.filter(action => action.sourceRefs?.includes(sourceRef));
      const normalizedCallbacks = callbacks(parse(normalizedSource.javascript, { ecmaVersion: "latest" }));
      requireProof(targets.length === originalCallbacks.length && normalizedCallbacks.length === originalCallbacks.length &&
        targets.every((action, i) => sameBoundary(action, originalCallbacks[i])) &&
        normalizedCallbacks.every((boundary, i) => sameBoundary(boundary, originalCallbacks[i])), "callback_cardinality_or_identity_changed");
      const candidates = sets.find(set => set.length === originalCallbacks.length && set.every((candidate, i) =>
        candidate.translationStatus === "mapped" && candidate.coverage?.status === "translated" &&
        candidate.coverage.residuals?.length === 0 && sameBoundary(candidate, originalCallbacks[i])));
      audit.compilerBoundaries = sets.map(set => set.map(c => ({ event: c.event, controlId: c.controlId, status: c.translationStatus })));
      requireProof(candidates, "callback_not_completely_owned");
      const changed = [];
      targets.forEach((old, index) => {
        const candidate = candidates[index];
        if (old.translationStatus === "mapped" && old.function === candidate.function) return;
        const action = { ...old, function: candidate.function, translationStatus: "mapped", coverage: candidate.coverage,
          functionMappings: candidate.functionMappings, semanticHints: { ...candidate.semanticHints,
            coveredCalculationRanges: [{ sourceRef, name: "approvedAuxiliaryCallback", start: originalCallbacks[index].start, end: originalCallbacks[index].end }] },
          sourceRefs: old.sourceRefs, unmappedFunctions: [] };
        delete action.branchProvenance; delete action.deterministicBranchProof;
        result.draft.scripts.actions[result.draft.scripts.actions.indexOf(old)] = action;
        changed.push(old.id);
      });
      audit.status = "applied";
      audit.changedActionIds = changed; audit.originalSourcePreserved = true;
      result.changedActionIds.push(...changed);
    } catch (error) {
      audit.reason = error.policyReason || "policy_normalization_failed";
      audit.message = error.message;
      if (audit.reason === "callback_not_completely_owned") audit.status = "pending";
    }
  }
  result.changedActionIds = [...new Set(result.changedActionIds)];
  return result;
}

function retireBindings(state, decision, sourceDraft) {
  const retired = [...decision.retiredValueFieldIds, ...decision.retiredRequiredFieldIds], declared = declaredIds(sourceDraft, state.form);
  requireProof(retired.every(id => !declared.has(id)), "retired_field_is_bound");
  if (decision.retiredValueFieldIds.length) requireProof(approvedScalarStringReadExpression(decision.replacementReadFieldId, state.form,
    [decision.replacementReadFieldId]), "replacement_read_binding_unproven");
  const consumed = new Set(), found = new Set(), handledBindings = new Set();
  const add = (node, replacement, reason) => {
    if (!state.patches.some(p => p.start === node.start && p.end === node.end)) state.patches.push({ start: node.start, end: node.end, replacement, reason });
  };
  const read = () => { state.selectedReads.add(decision.replacementReadFieldId); return `GetXFormFieldById(${JSON.stringify(decision.replacementReadFieldId)})[0].value`; };
  walk(state.ast, node => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || !APIs.has(node.callee.name)) return;
    const id = literal(node.arguments[0]);
    if (!retired.includes(id)) return;
    requireProof(state.bindings.isUnshadowedGlobal(node.callee.name, node.start), "retired_api_shadowed");
    consumed.add(node.arguments[0].start); found.add(id);
    const parent = state.parents.get(node);
    if (["common_required", "common_not_required"].includes(node.callee.name)) {
      requireProof(decision.retiredRequiredFieldIds.includes(id) && node.arguments.length === 1 && parent?.type === "ExpressionStatement", "undeclared_required_reference");
      add(parent, ";", "approved-retired-required-toggle"); return;
    }
    requireProof(decision.retiredValueFieldIds.includes(id), "undeclared_value_reference");
    if (node.callee.name === "SetXFormFieldValueById") {
      requireProof([2, 3].includes(node.arguments.length) && typeof literal(node.arguments[1]) === "string" &&
        (node.arguments.length === 2 || literal(node.arguments[2]) === false) && parent?.type === "ExpressionStatement", "retired_write_effect_unproven");
      add(parent, ";", "approved-retired-literal-write"); return;
    }
    requireProof(node.arguments.length === 1 && !node.optional, "retired_read_shape_unproven");
    if (node.callee.name === "GetXFormFieldValueById") { add(node, read(), "approved-retired-read-substitution"); return; }
    const indexed = parent, owner = state.parents.get(indexed);
    requireProof(indexed?.type === "MemberExpression" && indexed.computed && literal(indexed.property) === 0, "retired_handle_shape_unproven");
    if (owner?.type === "MemberExpression" && !owner.computed && owner.property.name === "value") {
      requireProof(state.parents.get(owner)?.type !== "AssignmentExpression", "direct_retired_write_unproven");
      add(owner, read(), "approved-retired-read-substitution"); return;
    }
    const declaration = state.parents.get(owner);
    requireProof(owner?.type === "VariableDeclarator" && owner.init === indexed && owner.id.type === "Identifier" &&
      declaration?.type === "VariableDeclaration" && declaration.kind === "var" && declaration.declarations.length === 1, "retired_handle_alias_unproven");
    const binding = state.bindings.bindingAtUse(owner.id.name, owner.id.start);
    requireProof(binding && !binding.ambiguous && binding.declarations.length === 1, "retired_handle_ambiguous");
    if (handledBindings.has(binding.id)) return;
    handledBindings.add(binding.id);
    const reads = [], writes = [];
    walk(state.ast, (reference, holder) => {
      if (reference.type !== "Identifier" || reference.name !== owner.id.name || reference === owner.id ||
          state.bindings.bindingAtUse(reference.name, reference.start) !== binding || propertyIdentifier(reference, holder)) return;
      requireProof(holder?.type === "MemberExpression" && holder.object === reference && !holder.computed && holder.property.name === "value", "retired_handle_escapes");
      const effect = state.parents.get(holder);
      if (effect?.type === "AssignmentExpression" && effect.left === holder) {
        const statement = state.parents.get(effect);
        requireProof(effect.operator === "=" && typeof literal(effect.right) === "string" && statement?.type === "ExpressionStatement", "retired_handle_write_effect_unproven");
        writes.push(statement);
      } else reads.push(holder);
    });
    if (reads.length) {
      const block = state.parents.get(declaration), next = block?.body?.[block.body.indexOf(declaration) + 1];
      requireProof(reads.length === 1 && !writes.length && next?.type === "IfStatement" &&
        next.test.start <= reads[0].start && next.test.end >= reads[0].end, "retired_handle_read_timing_unproven");
      state.selectedReads.add(decision.replacementReadFieldId);
      add(declaration, `var ${owner.id.name} = GetXFormFieldById(${JSON.stringify(decision.replacementReadFieldId)})[0];`, "approved-retired-control-read");
    } else add(declaration, ";", "approved-retired-handle");
    for (const statement of writes) add(statement, ";", "approved-retired-literal-write");
  });
  walk(state.ast, node => {
    if (node.type === "Literal" && typeof node.value === "string" && retired.some(id => new RegExp(`(^|[^A-Za-z0-9_])${id}($|[^A-Za-z0-9_])`).test(node.value)))
      requireProof(consumed.has(node.start), "undeclared_retired_reference");
  });
  requireProof(retired.every(id => found.has(id)), "declared_retirement_not_used");
}

function approveSelectedReads(state, decision, boundaries) {
  const found = new Set();
  for (const id of decision.fieldIds) requireProof(approvedScalarStringReadExpression(id, state.form, decision.fieldIds), "selected_read_binding_unproven");
  walk(state.ast, node => {
    if (node.type !== "CallExpression" || node.optional || node.arguments.length || node.callee.type !== "MemberExpression" ||
        node.callee.computed || node.callee.property.name !== "val") return;
    const selection = node.callee.object;
    if (selection?.type !== "CallExpression" || selection.callee.type !== "Identifier" || selection.callee.name !== "$" || selection.arguments.length !== 1) return;
    const text = literal(selection.arguments[0]);
    const match = typeof text === "string" && /^\[name=(["'])extendDataFormInfo\.value\(([A-Za-z_][\w]*)\)\1\]$/.exec(text);
    if (!match || !decision.fieldIds.includes(match[2])) return;
    requireProof(state.bindings.isUnshadowedGlobal("$", selection.start) && boundaries.some(b => b.event === "onLoad" && b.start <= node.start && b.end >= node.end), "selected_read_boundary_unproven");
    state.patches.push({ start: node.start, end: node.end, replacement: `GetXFormFieldById(${JSON.stringify(match[2])})[0].value`, reason: "approved-first-match-to-current-selected-string" });
    state.selectedReads.add(match[2]); found.add(match[2]);
  });
  requireProof(decision.fieldIds.every(id => found.has(id)), "declared_selected_read_not_used");
}

function callbacks(ast) {
  return ast.body.flatMap(statement => {
    const call = statement.type === "ExpressionStatement" && statement.expression;
    if (call?.type !== "CallExpression" || call.callee.type !== "Identifier") return [];
    if (call.callee.name === "Com_AddEventListener" && call.arguments[0]?.name === "window" && literal(call.arguments[1]) === "load") return [{ event: "onLoad", start: call.start, end: call.end }];
    if (call.callee.name === "AttachXFormValueChangeEventById" && typeof literal(call.arguments[0]) === "string") return [{ event: "onChange", controlId: literal(call.arguments[0]), start: call.start, end: call.end }];
    return [];
  });
}
function sameBoundary(a, b) { return a.event === b.event && a.controlId === b.controlId; }
function declaredIds(source, draftForm) {
  const ids = new Set();
  // Caption-fold evidence records script nodes that mention missing ids. Those
  // notes are not form declarations and must not block an approved retirement.
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.id && (node.sourceRef || node.type || node.sourceType)) ids.add(node.id);
    for (const key of ["designerId", "metadataId", "originalId"]) if (node[key]) ids.add(node[key]);
    for (const marker of node.sourceMarkers || []) ids.add(marker);
    for (const [key, child] of Object.entries(node)) {
      if (key === "foldedCaption") continue;
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(source.form); visit(draftForm);
  return ids;
}
function stableApis(sources) {
  for (const source of sources) {
    const text = String(source.javascript || ""), model = buildJavaScriptBindingModel(text);
    if (!model.ok || [...protectedGlobals].some(name => !model.isUnshadowedGlobal(name, text.length))) return false;
    let invalid = false;
    walk(parse(text, { ecmaVersion: "latest" }), (node, parent) => {
      if (node.type === "Identifier" && protectedGlobals.has(node.name) && !propertyIdentifier(node, parent) &&
          !(parent?.type === "CallExpression" && parent.callee === node)) invalid = true;
      if (["AssignmentExpression", "UpdateExpression"].includes(node.type) || node.type === "UnaryExpression" && node.operator === "delete") {
        let target = node.left || node.argument;
        if (target?.type === "MemberExpression" && protectedGlobals.has(target.computed ? literal(target.property) : target.property.name)) invalid = true;
        while (target?.type === "MemberExpression") target = target.object;
        if (target?.type === "Identifier" && (protectedGlobals.has(target.name) || ["window", "globalThis", "self"].includes(target.name) && model.isUnshadowedGlobal(target.name, target.start))) invalid = true;
      }
      if (node.type === "Identifier" && ["window", "globalThis", "self"].includes(node.name) && model.isUnshadowedGlobal(node.name, node.start) &&
          !(parent?.type === "MemberExpression" && parent.object === node) &&
          !(parent?.type === "CallExpression" && parent.callee.name === "Com_AddEventListener" && parent.arguments[0] === node)) invalid = true;
      if ((node.type === "CallExpression" || node.type === "NewExpression") && ["eval", "Function"].includes(node.callee?.name)) invalid = true;
    });
    if (invalid) return false;
  }
  return true;
}
function propertyIdentifier(node, parent) { return parent?.type === "MemberExpression" && parent.property === node && !parent.computed || parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand; }
function requireProof(condition, reason) { if (!condition) throw Object.assign(new Error(reason), { policyReason: reason }); }
function literal(node) { return node?.type === "Literal" ? node.value : undefined; }
function walk(node, visit, parent) { if (!node || typeof node !== "object") return; if (Array.isArray(node)) { node.forEach(child => walk(child, visit, parent)); return; } visit(node, parent); for (const child of Object.values(node)) { if (Array.isArray(child)) child.forEach(n => walk(n, visit, node)); else if (child && typeof child === "object") walk(child, visit, node); } }
