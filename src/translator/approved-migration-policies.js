import {applyRemoteOmissionPolicies} from "./omitted-remote-selectors.js";
import {validateRemoteOmissionDecisions,remoteOmissionDslDiagnostics} from "../dsl/omitted-remote-selector.js";
import {applyApprovedRemotePolicies,validateApprovedRemoteDecisions} from "./approved-remote-policies.js";
import {inspectNativeRemoteSelectorFunction,nativeRemoteSelectorDslDiagnostics} from "../dsl/native-remote-selector-profile.js";
import {applyApprovedMainStringLoadPolicies,validateApprovedMainStringLoadDecisions} from "./approved-main-string-load-policies.js";
import {SUBMIT_CURRENT_VALUES_KIND,OMIT_UNBOUND_DIAGNOSTIC_KIND,applyApprovedSubmitCurrentValuePolicies,validateApprovedSubmitCurrentValueDecisions,applyApprovedUnboundDiagnosticPolicies,validateApprovedUnboundDiagnosticDecisions} from "./approved-submit-current-values-policies.js";
import {SOURCE_FORM_RADIO_ORDINAL_LOAD_KIND,applyApprovedRadioOrdinalPolicies,validateApprovedRadioOrdinalDecisions} from "./approved-radio-ordinal-policy.js";
import { canonicalJson, sha256Digest } from "../agent-review/digest.js";
import { buildDeterministicScriptBranchProof } from "../dsl/deterministic-script-translations.js";
import { applyApprovedAuxiliaryPolicies, validateApprovedAuxiliaryDecisions } from "./approved-auxiliary-policies.js";
import { applyApprovedRuntimePolicies, validateApprovedRuntimePolicyDecisions } from "./approved-runtime-policies.js";
import { applyApprovedImportPolicies, validateApprovedImportDecisions } from "./approved-import-policies.js";
import { inspectNativeDetailImportFunction, nativeDetailImportDslDiagnostics } from "../dsl/native-detail-import-profile.js";
import {SUPPORTED_DETAIL_STATE_KIND, validateSupportedDetailStateDecisions, applySupportedDetailStatePolicies} from "./approved-detail-state-policy.js";

export const APPROVED_MIGRATION_POLICY_BASIS = "deterministic-approved-migration-policy";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const groups = [
  {kinds:[SUPPORTED_DETAIL_STATE_KIND],validate:validateSupportedDetailStateDecisions,apply:applySupportedDetailStatePolicies},
  {kinds:["omit-remote-selector"],validate:validateRemoteOmissionDecisions,apply:applyRemoteOmissionPolicies},
  {kinds:["native-tic-rest-selector"],validate:validateApprovedRemoteDecisions,apply:applyApprovedRemotePolicies},
  {kinds:["main-string-current-value-load"],validate:validateApprovedMainStringLoadDecisions,apply:applyApprovedMainStringLoadPolicies},
  {kinds:[SUBMIT_CURRENT_VALUES_KIND],validate:validateApprovedSubmitCurrentValueDecisions,apply:applyApprovedSubmitCurrentValuePolicies},
  {kinds:[OMIT_UNBOUND_DIAGNOSTIC_KIND],validate:validateApprovedUnboundDiagnosticDecisions,apply:applyApprovedUnboundDiagnosticPolicies},
  {kinds:[SOURCE_FORM_RADIO_ORDINAL_LOAD_KIND],validate:validateApprovedRadioOrdinalDecisions,apply:applyApprovedRadioOrdinalPolicies},
  { kinds: ["retire_missing_auxiliary_bindings", "current_selected_string_reads"], validate: validateApprovedAuxiliaryDecisions, apply: applyApprovedAuxiliaryPolicies },
  { kinds: ["shared-json-ordinary-runtime", "detail-card-number-advice-column"], validate: validateApprovedRuntimePolicyDecisions, apply: applyApprovedRuntimePolicies },
  { kinds: ["native-detail-import-replace"], validate: validateApprovedImportDecisions, apply: applyApprovedImportPolicies }
];

export function migrationPolicySourceDigest(sourceDraft) {
  const { migrationPolicies: _policy, ...original } = sourceDraft || {};
  return sha256Digest(original);
}

export function validateMigrationPolicies(policy, sourceDraft, scope) {
  const diagnostics = [];
  const fail = message => diagnostics.push({ level: "error", code: "migration.policy.invalid", message });
  if (!exact(policy, ["version", "sourceDraftSha256", "scope", "authorization", "decisions"]) || policy.version !== 1) fail("Explicit versioned migration policies are required.");
  if (!DIGEST.test(policy?.sourceDraftSha256 || "") || sourceDraft && policy.sourceDraftSha256 !== migrationPolicySourceDigest(sourceDraft)) fail("Migration policies do not match the original Source Draft digest.");
  if (!exact(policy?.scope, ["baseUrl", "targetCategoryId"]) || !rootOrigin(policy?.scope?.baseUrl) || !text(policy?.scope?.targetCategoryId)) fail("Migration policy target scope must be an exact root origin and category.");
  if (scope && (scope.baseUrl !== policy?.scope?.baseUrl || scope.targetCategoryId !== policy?.scope?.targetCategoryId)) fail("Migration policy target scope differs from this operation.");
  if (!exact(policy?.authorization, ["actor", "evidenceSha256"]) || !text(policy?.authorization?.actor) || !DIGEST.test(policy?.authorization?.evidenceSha256 || "")) fail("Migration policies must retain explicit caller authorization evidence.");
  if (!Array.isArray(policy?.decisions) || !policy.decisions.length) fail("A nonempty typed decision list is required.");
  else {
    const seen = new Set(), remoteRefs = new Set();
    for (const decision of policy.decisions) {
      const group = groups.find(group => group.kinds.includes(decision?.kind));
      if (!group) { fail("Unknown migration policy decision kind."); continue; }
      if (["omit-remote-selector","native-tic-rest-selector"].includes(decision.kind)) {if(remoteRefs.has(decision.sourceRef)) fail("A remote selector cannot have competing migration/omission decisions.");remoteRefs.add(decision.sourceRef);}
      const key = canonicalJson(decision);
      if (seen.has(key)) fail("Duplicate migration policy decision.");
      seen.add(key);
    }
    for (const group of groups) {
      const selected = policy.decisions.filter(decision => group.kinds.includes(decision?.kind));
      if (!selected.length) continue;
      try { const result = group.validate(selected); if (!result?.ok) diagnostics.push(...(result?.diagnostics || [{level:"error",code:"migration.policy.invalid",message:"Decision validation failed."}])); }
      catch { fail("Decision structure is invalid."); }
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

export function attachMigrationPolicies(sourceDraft, policy, scope) {
  const result = validateMigrationPolicies(policy, sourceDraft, scope);
  if (!result.ok) throw Object.assign(new Error(result.diagnostics.map(d => d.message).join(" ")), { code: "BATCH_MIGRATION_POLICY_INVALID" });
  return { ...sourceDraft, migrationPolicies: structuredClone(policy) };
}

export function applyApprovedMigrationPolicies(sourceDraft, baseDraft) {
  const policy = sourceDraft?.migrationPolicies;
  if (policy === undefined) return baseDraft;
  const validation = validateMigrationPolicies(policy, sourceDraft);
  if (!validation.ok) throw Object.assign(new Error(validation.diagnostics.map(d => d.message).join(" ")), { code: "BATCH_MIGRATION_POLICY_INVALID" });
  let draft = structuredClone(baseDraft);
  const audits = [], changedIds = new Set();
  for (const group of groups) {
    const decisions = policy.decisions.filter(decision => group.kinds.includes(decision.kind));
    if (!decisions.length) continue;
    const result = group.apply(sourceDraft, draft, decisions);
    if (!result?.draft || !Array.isArray(result.audits) || !Array.isArray(result.changedActionIds)) throw new Error("Invalid approved policy adapter result.");
    draft = result.draft; audits.push(...result.audits);
    for (const id of result.changedActionIds) { if (changedIds.has(id)) throw new Error("Two approved policy adapters modify the same action."); changedIds.add(id); }
  }
  const policyDigest = sha256Digest(policy), sourceByRef = new Map((sourceDraft.scripts?.sources || []).map(source => [source.sourceRef || source.id, source]));
  const changedActions = (draft.scripts?.actions || []).filter(action => changedIds.has(action.id));
  // Generated lookup runtime may be absent from ordinary authored JSP sources.
  // Only an independently rebuilt, explicitly omitted field runtime may bind it.
  for(const audit of audits.filter(item=>item.kind==="omit-remote-selector"))for(const source of audit.sourceScripts||[]){
    if(source.carrier!=="verified-field-runtime")continue;
    const fields=[...(sourceDraft.form?.controls||[]),...(sourceDraft.form?.dataFields||[]),...(sourceDraft.form?.detailTables||[]).flatMap(table=>table.columns||[])].filter(field=>field.sourceRef===source.sourceRef);
    const fact=fields[0]?.sourceProps?.remoteSelectorOmissionSourceFact;
    if(fields.length!==1||fact?.status!=="verified"||fact.digest!==audit.omissionFactDigest||fact.script?.javascriptSha256!==source.javascriptSha256||fact.script?.javascriptLength!==source.length||fact.script?.foreignReferences!==false)throw new Error("Omitted field runtime source binding is unproved.");
    sourceByRef.set(source.sourceRef,{omittedRuntimeLength:source.length});
  }
  for (const action of changedActions) {
    const refs = action.sourceRefs || [];
    if (!refs.length || refs.some(ref => !sourceByRef.has(ref))) throw new Error("Approved policy action has no original authored source binding.");
    if (action.translationStatus !== "mapped") continue;
    const allSourcesClosed = refs.every(ref => (draft.scripts.actions || []).filter(candidate => candidate.sourceRefs?.includes(ref)).every(candidate => candidate.translationStatus === "mapped"));
    const ranges = allSourcesClosed ? refs.map(ref => ({ sourceRef: ref, name: "approvedSourceBehavior", start: 0, end: sourceByRef.get(ref).javascript?.length??sourceByRef.get(ref).omittedRuntimeLength })) : action.semanticHints?.coveredCalculationRanges;
    if (!ranges?.length) throw new Error("Approved policy action lacks source ranges.");
    action.functionMappings = [{ source: "Explicit caller-approved migration behavior", target: "Fixed native implementation of the approved policy", basis: APPROVED_MIGRATION_POLICY_BASIS, policyDigest, reviewRequired: false }];
    action.coverage = { status: "translated", nativeRules: [], residuals: [] };
    action.semanticHints = { ...action.semanticHints, coveredCalculationRanges: ranges, approvedMigrationPolicy: { policyDigest } };
    if (action.branchProvenance !== undefined) {
      action.semanticHints.sourceBranchProvenanceBeforePolicy = action.branchProvenance;
      delete action.branchProvenance;
    }
    action.deterministicBranchProof = buildDeterministicScriptBranchProof(action);
    if (!action.deterministicBranchProof) throw new Error("Approved policy action could not build its fixed source proof.");
  }
  const preservedNativeSources = new Set(audits.filter(audit=>audit.kind === SUPPORTED_DETAIL_STATE_KIND).flatMap(audit=>audit.sourceScripts.map(source=>source.sourceRef)));
  const ownedSources = new Set(changedActions.filter(action => action.translationStatus === "mapped").flatMap(action => action.sourceRefs || []).filter(ref=>!preservedNativeSources.has(ref))
    .filter(ref => (draft.scripts?.actions || []).filter(action => action.sourceRefs?.includes(ref)).every(action => action.translationStatus === "mapped")));
  const ownedRuleIds = new Set([
    ...(draft.formRules?.linkage || []).filter(rule => ownedSources.has(rule.meta?.sourceJsp)).map(rule => rule.id),
    ...(draft.formRules?.review?.excludedRules || []).filter(rule => ownedSources.has(rule.sourceJsp)).map(rule => rule.ruleId)
  ]);
  if (draft.formRules && (ownedSources.size > 0 || preservedNativeSources.size === 0)) {
    draft.formRules.linkage = (draft.formRules.linkage || []).filter(rule => !ownedSources.has(rule.meta?.sourceJsp));
    if (draft.formRules.review) {
      draft.formRules.review.excludedRules = (draft.formRules.review.excludedRules || []).filter(rule => !ownedSources.has(rule.sourceJsp));
      draft.formRules.review.targetIssues = (draft.formRules.review.targetIssues || []).filter(issue =>
        !ownedRuleIds.has(issue.ruleId) || (issue.conflictingRuleIds || []).some(id => !ownedRuleIds.has(id)));
    }
  }
  const fixedFields = changedFields(baseDraft.form, draft.form);
  draft.migrationPolicies = structuredClone(policy);
  draft.migrationPolicyAudit = { version: 2, policyDigest, audits, changedActionIds: [...changedIds].sort(),
    nativeRuleOwnership: { sourceRefs: [...ownedSources].sort(), ruleIds: [...ownedRuleIds].sort() }, fixedFields,
    formDigestProjection: "unaffected-field-titles-v1", formDigest: sha256Digest(policyFormProjection(draft.form, fixedFields)), formRulesDigest: sha256Digest(draft.formRules ?? null),
    actionBindingsDigest: sha256Digest(actionBindings(draft)),
    changedActionDigests: changedActions.map(action => ({id:action.id,digest:sha256Digest(action)})) };
  if (draft.scripts) draft.scripts.javascript = (draft.scripts.actions || []).map(action => action.function).filter(Boolean).join("\n\n");
  return draft;
}

export function migrationPolicyDslDiagnostics(dsl) {
  const policyActions = scriptActions(dsl).filter(action =>
    action.functionMappings?.some(mapping => String(mapping.basis || "").startsWith("deterministic-approved-")) ||
    action.semanticHints?.approvedRemoteOmission || action.semanticHints?.approvedMigrationPolicy || action.semanticHints?.approvedRuntimePolicy || action.semanticHints?.approvedNativeImport || inspectNativeDetailImportFunction(action.function) || action.semanticHints?.approvedNativeLookup || inspectNativeRemoteSelectorFunction(action.function));
  const policyFields = flattenFields(dsl?.form).some(({field}) => field.sourceProps?.approvedRuntimePolicy || field.sourceProps?.approvedRemoteOmissions);
  if (dsl?.migrationPolicies === undefined && dsl?.migrationPolicyAudit === undefined) {
    return policyActions.length || policyFields ? [{level:"error",code:"dsl.migration_policy_envelope_required",
      message:"Approved migration recipes and derived fields require their exact authorization envelope and scope.",path:"/migrationPolicies"}] : [];
  }
  const diagnostics = [...validateMigrationPolicies(dsl?.migrationPolicies).diagnostics, ...nativeDetailImportDslDiagnostics(dsl), ...nativeRemoteSelectorDslDiagnostics(dsl), ...remoteOmissionDslDiagnostics(dsl)];
  const fail = (message,details) => diagnostics.push({level:"error",code:"dsl.migration_policy_binding_mismatch",message,path:"/migrationPolicyAudit",...(details?{details}:{})});
  const audit = dsl?.migrationPolicyAudit, digest = sha256Digest(dsl?.migrationPolicies ?? null);
  for (const entry of Array.isArray(audit?.audits) ? audit.audits : []) if (entry?.kind === SUPPORTED_DETAIL_STATE_KIND && entry.workflowBefore !== sha256Digest(dsl.workflow ?? null)) fail("Supported-only detail state must preserve the complete workflow.");
  for(const decision of (dsl?.migrationPolicies?.decisions||[]).filter(value=>[SUBMIT_CURRENT_VALUES_KIND,OMIT_UNBOUND_DIAGNOSTIC_KIND,SOURCE_FORM_RADIO_ORDINAL_LOAD_KIND].includes(value.kind))){
    const bindings=(audit?.audits||[]).filter(value=>value.kind===decision.kind&&value.actionId===decision.actionId&&value.sourceRef===decision.sourceRef);
    if(bindings.length!==1||bindings[0].workflowBefore!==sha256Digest(dsl.workflow??null))fail("Approved source-bound value, diagnostic and radio policies must preserve the complete workflow routes and permissions.");
  }
  if (audit?.version !== 2 || audit.formDigestProjection !== "unaffected-field-titles-v1" || audit.policyDigest !== digest || !Array.isArray(audit.changedActionIds) ||
      new Set(audit.changedActionIds).size !== audit.changedActionIds.length) fail("Migration policy implementation must retain its exact decision digest and action identities.");
  if (canonicalJson([...new Set(policyActions.map(action => action.id))].sort()) !==
      canonicalJson(Array.isArray(audit?.changedActionIds) ? [...audit.changedActionIds].sort() : [])) fail("Every approved recipe action must be bound by the exact policy action list.");
  if (audit?.formDigest !== sha256Digest(policyFormProjection(dsl?.form, audit?.fixedFields)) || audit?.formRulesDigest !== sha256Digest(dsl?.formRules ?? null) ||
      audit?.actionBindingsDigest !== sha256Digest(actionBindings(dsl))) fail("Migration policy form, rule and action bindings changed after deterministic construction.", { bindingMismatches: [
      ["form",audit?.formDigest,sha256Digest(policyFormProjection(dsl?.form,audit?.fixedFields))],
      ["formRules",audit?.formRulesDigest,sha256Digest(dsl?.formRules??null)],
      ["actionBindings",audit?.actionBindingsDigest,sha256Digest(actionBindings(dsl))]
    ].filter(([,expected,actual])=>expected!==actual).map(([partition,expected,actual])=>({partition,expectedDigest:typeof expected==="string"&&DIGEST.test(expected)?expected:null,actualDigest:actual})) });
  for (const id of Array.isArray(audit?.changedActionIds) ? audit.changedActionIds : []) {
    const actions = scriptActions(dsl).filter(action => action.id === id);
    if (actions.length !== 1) { fail("Migration policy action is missing or duplicated."); continue; }
    const action = actions[0];
    const seals = (Array.isArray(audit?.changedActionDigests) ? audit.changedActionDigests : []).filter(seal => seal.id === id);
    if (seals.length !== 1 || seals[0].digest !== sha256Digest(action)) fail("Approved action implementation changed after its fixed policy construction.");
    if (action.translationStatus !== "mapped") continue;
    if (!action.functionMappings?.every(mapping => mapping.basis === APPROVED_MIGRATION_POLICY_BASIS && mapping.policyDigest === digest) ||
        action.semanticHints?.approvedMigrationPolicy?.policyDigest !== digest) fail("Approved action no longer references the fixed migration policy digest.");
  }
  return diagnostics;
}

export function migrationPolicyProvenanceDiagnostics(sourceDraft, expectedDraft, actual) {
  const diagnostics = [], fail = (message, path) => diagnostics.push({level:"error",code:"trust.migration_policy_source_mismatch",message,path});
  if (canonicalJson(sourceDraft?.migrationPolicies) !== canonicalJson(actual?.migrationPolicies)) fail("Migration policies must exactly retain the authorized source policies.", "/migrationPolicies");
  if (canonicalJson(expectedDraft?.migrationPolicyAudit) !== canonicalJson(actual?.migrationPolicyAudit)) fail("Migration policy audit must match the independently rebuilt implementation.", "/migrationPolicyAudit");
  for (const item of expectedDraft?.migrationPolicyAudit?.fixedFields || []) {
    const fields = flattenFields(actual?.form).filter(field => field.key === item.key);
    if (fields.length !== 1 || sha256Digest(fields[0].field) !== item.digest) fail("Policy-affected native fields must retain the fixed approved implementation.", "/form/fields");
  }
  return diagnostics;
}

function changedFields(before, after) {
  const old = new Map(flattenFields(before).map(item => [item.key, item.field]));
  return flattenFields(after).filter(item => canonicalJson(item.field) !== canonicalJson(old.get(item.key)))
    .map(item => ({key:item.key,digest:sha256Digest(item.field)}));
}
function policyFormProjection(form, fixedFields) {
  const projected = structuredClone(form ?? null), fixed = new Set((Array.isArray(fixedFields) ? fixedFields : []).map(item => item?.key));
  // Normal review may rename unrelated source-backed fields. Every other form
  // property, and the entire policy-affected field/table, remains sealed.
  for (const field of Array.isArray(projected?.fields) ? projected.fields : []) {
    if (!record(field) || fixed.has(field.id)) continue;
    delete field.title;
    if (field.type === "detailTable") for (const column of Array.isArray(field.columns) ? field.columns : []) {
      if (record(column) && !fixed.has(field.id + "." + column.id)) delete column.title;
    }
  }
  return projected;
}
function flattenFields(form) { return (Array.isArray(form?.fields) ? form.fields : []).filter(record).flatMap(field => [{key:field.id,field},
  ...(field.type === "detailTable" && Array.isArray(field.columns) ? field.columns.filter(record).map(column => ({key:field.id+"."+column.id,field:column})) : [])]); }
function scriptActions(draft) { return (Array.isArray(draft?.scripts?.actions) ? draft.scripts.actions : []).filter(record); }
function actionBindings(draft) { return scriptActions(draft).map(action => ({id:action.id,event:action.event,scope:action.scope,tableId:action.tableId,controlId:action.controlId,sourceActionKey:action.sourceActionKey,sourceRefs:action.sourceRefs})); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)); }
function text(value) { return typeof value === "string" && value.length > 0 && value.trim() === value; }
function rootOrigin(value) { try { const url = new URL(value); return ["http:","https:"].includes(url.protocol) && url.origin === value && !url.username && !url.password; } catch { return false; } }
