import { validateNativeImportCalculationPlan, buildNativeImportCalculationSpec } from "../translator/native-import-calculations.js";
import { parse } from "acorn";
import { canonicalJson, sha256Digest } from "../agent-review/digest.js";
import { hasVerifiedDeterministicScriptBranchProof } from "./deterministic-script-translations.js";
import { nativeDetailImportFunction, NATIVE_DETAIL_IMPORT_PROFILE, NATIVE_DETAIL_IMPORT_CALCULATION_PROFILE, NATIVE_IMPORT_CALCULATION_POLICY_PROFILE } from "../translator/native-detail-import-runtime.js";

const identifier = value => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,24}$/.test(value) && !["__proto__", "prototype", "constructor", "mechanisms"].includes(value);
const fieldIdentifier = value => identifier(value) || typeof value === "string" && value.endsWith(".name") && identifier(value.slice(0, -5));
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));

// Only the complete fixed generator is admitted. Similar-looking HTTP or DOM
// code continues through the ordinary restrictive script checks.
export function inspectNativeDetailImportFunction(source) {
  if (typeof source !== "string" || !source.startsWith("function onClick() {\n  var spec = ") || !source.includes("nativeImportFormData")) return undefined;
  try {
    const program = parse(source, { ecmaVersion: "latest" }), fn = program.body[0], declaration = fn?.body?.body?.[0];
    if (program.body.length !== 1 || fn.type !== "FunctionDeclaration" || fn.id?.name !== "onClick" || fn.params.length || declaration?.type !== "VariableDeclaration" || declaration.declarations.length !== 1 || declaration.declarations[0].id?.name !== "spec") return undefined;
    const init = declaration.declarations[0].init, spec = JSON.parse(source.slice(init.start, init.end));
    const calculated = Object.hasOwn(spec, "calculationPlan"), keys = ["targetOrigin", "tableId", "fields", "allFieldIds", "maxPolls", "systemFieldNames", "xformId", "entry", ...(calculated ? ["calculationPlan"] : [])];
    if (!exact(spec, keys) || spec.entry !== "import" || spec.xformId !== "${xform:id}" || spec.maxPolls !== 300) return undefined;
    const origin = new URL(spec.targetOrigin), table = /^\$\{table:([^}]+)\}$/.exec(spec.tableId);
    if (origin.origin !== spec.targetOrigin || !["https:", "http:"].includes(origin.protocol) || !table || !identifier(table[1])) return undefined;
    if (!Array.isArray(spec.allFieldIds) || !spec.allFieldIds.length || spec.allFieldIds.length > 256 || !spec.allFieldIds.every(fieldIdentifier) || new Set(spec.allFieldIds).size !== spec.allFieldIds.length) return undefined;
    if (!Array.isArray(spec.systemFieldNames) || spec.systemFieldNames.length > 64 || !spec.systemFieldNames.every(identifier) || new Set(spec.systemFieldNames).size !== spec.systemFieldNames.length) return undefined;
    if (!Array.isArray(spec.fields) || !spec.fields.length || spec.fields.length > spec.allFieldIds.length || spec.fields.some(field => !exact(field, ["id", "title", "required"]) || !spec.allFieldIds.includes(field.id) || typeof field.title !== "string" || !field.title || typeof field.required !== "boolean") || new Set(spec.fields.map(field => field.id)).size !== spec.fields.length) return undefined;
    const { xformId: _xform, entry: _entry, ...input } = spec; input.tableId = table[1];
    if (calculated) {
      if (!input.calculationPlan || input.calculationPlan.tableId !== spec.tableId || !Array.isArray(input.calculationPlan.mainSums) || input.calculationPlan.mainSums.some(sum => !sum || sum.tableId !== spec.tableId)) return undefined;
      input.calculationPlan = { ...input.calculationPlan, tableId: table[1], mainSums: input.calculationPlan.mainSums.map(sum => ({ ...sum, tableId: table[1] })) };
      if (!validateNativeImportCalculationPlan(input.calculationPlan).ok) return undefined;
    }
    if (nativeDetailImportFunction(input, "import") !== source) return undefined;
    return { profile: calculated ? NATIVE_DETAIL_IMPORT_CALCULATION_PROFILE : NATIVE_DETAIL_IMPORT_PROFILE, spec: input };
  } catch { return undefined; }
}

export function nativeDetailImportDslDiagnostics(dsl) {
  const diagnostics = [], fail = (action, reason) => diagnostics.push({ level: "error", code: "dsl.native_import_profile_invalid", path: "/scripts/actions", message: reason, details: { actionId: action?.id } });
  for (const action of Array.isArray(dsl?.scripts?.actions) ? dsl.scripts.actions : []) {
    if (!action || typeof action !== "object") continue;
    const inspected = inspectNativeDetailImportFunction(action.function), hint = action.semanticHints?.approvedNativeImport;
    if (!inspected && !hint) continue;
    const calculated = inspected?.profile === NATIVE_DETAIL_IMPORT_CALCULATION_PROFILE;
    if (!inspected || !dsl.migrationPolicies || !hint || hint.profile !== inspected.profile || hint.entry !== "import" || hint.noCalculatedFields !== !calculated || !/^sha256:[a-f0-9]{64}$/.test(hint.witnessSha256 || "") || !hasVerifiedDeterministicScriptBranchProof(action)) { fail(action, "The native import requires its exact fixed implementation and approved source-policy proof."); continue; }
    const decision = (Array.isArray(dsl.migrationPolicies.decisions) ? dsl.migrationPolicies.decisions : []).filter(decision => decision?.id === hint.decisionId && decision.kind === "native-detail-import-replace");
    const fields = Array.isArray(dsl.form?.fields) ? dsl.form.fields : [], tables = fields.filter(field => field?.id === inspected.spec.tableId && field.type === "detailTable"), buttons = fields.filter(field => field?.id === action.controlId && field.type === "button" && field.componentId === "xform-button");
    if (decision.length !== 1 || tables.length !== 1 || buttons.length !== 1 || inspected.spec.targetOrigin !== dsl.migrationPolicies.scope?.baseUrl || decision[0].tableId !== inspected.spec.tableId || decision[0].sourceActionId !== action.id || decision[0].downloadFieldSourceRef !== buttons[0].sourceRef || action.scope !== "control" || action.event !== "onClick" || action.tableId !== undefined || canonicalJson(action.runWhen?.viewStatusIn) !== canonicalJson(["add", "edit"])) { fail(action, "The native import must retain its approved origin, source table and source-backed button binding."); continue; }
    if (inspected.spec.calculationPlan) calculatedImportDiagnostics(dsl, action, inspected, decision[0], hint, fail);
    const columns = Array.isArray(tables[0].columns) ? tables[0].columns : [], hasCalculated = field => field?.props?.formula !== undefined || field?.props?.calculation !== undefined || field?.type === "calculation" || (Array.isArray(field?.columns) ? field.columns : []).some(hasCalculated);
    if (!inspected.spec.calculationPlan && fields.some(hasCalculated) || (dsl.formRules?.calculations || []).length || tables[0].props?.popup === true || canonicalJson(inspected.spec.allFieldIds) !== canonicalJson(columns.map(column => column.id)) || inspected.spec.fields.some(selected => { const matches = columns.filter(column => column.id === selected.id); return matches.length !== 1 || !["text", "longText", "number", "date", "dateTime", "singleSelect", "radio"].includes(matches[0].type) || matches[0].componentId === "xform-address" || matches[0].title !== selected.title || (matches[0].props?.required === true) !== selected.required; })) fail(action, "This native import profile requires exact primitive import fields and a form without calculated, nested or popup details.");
  }
  return diagnostics;
}

function calculatedImportDiagnostics(dsl, action, inspected, decision, hint, fail) {
  const plan = inspected.spec.calculationPlan;
  if (decision.calculationProfile !== NATIVE_IMPORT_CALCULATION_POLICY_PROFILE || hint.calculationProfile !== NATIVE_IMPORT_CALCULATION_POLICY_PROFILE || hint.calculationPlanSha256 !== sha256Digest(plan)) {
    fail(action, "Calculated imports require the exact typed decision and native calculation plan digest."); return;
  }
  const audits = (dsl.migrationPolicyAudit?.audits || []).filter(audit => audit.decisionId === decision.id && audit.kind === "native-detail-import-replace");
  const outer = audits[0], native = outer?.nativeImport;
  if (audits.length !== 1 || outer.status !== "applied" || outer.sourceRef !== decision.sourceRef || outer.sourceJavascriptSha256 !== decision.sourceDeclarationSha256 || native?.profile !== inspected.profile || native.calculationPlanSha256 !== hint.calculationPlanSha256 || canonicalJson(native.calculationPlan) !== canonicalJson(plan) || sha256Digest(native.witness) !== hint.witnessSha256 || native.witness?.sourceRef !== decision.sourceRef || native.witness?.sourceJavascriptSha256 !== decision.sourceDeclarationSha256) {
    fail(action, "Calculated imports require their complete exact source, witness, plan and audit binding."); return;
  }
  const refs = [...new Set([decision.sourceRef, ...plan.currencyEffects.map(effect => effect.sourceRef)])];
  if (canonicalJson(action.sourceRefs) !== canonicalJson(refs)) { fail(action, "Calculated imports must retain every original calculation source reference."); return; }
  const effectIds = new Set();
  for (const effect of plan.currencyEffects) {
    const candidates = (dsl.scripts?.actions || []).filter(original => original.id === effect.actionId);
    const original = candidates[0], ranges = effect.coveredCalculationRanges;
    if (candidates.length !== 1 || original.translationStatus !== "mapped" || original.scope !== "control" || original.event !== "onChange" || original.controlId !== effect.triggerId || original.function !== effect.compiledFunction || canonicalJson(original.sourceRefs) !== canonicalJson([effect.sourceRef]) || original.sourceActionKey !== effect.sourceRef + "#onChange@" + ranges[0].start || canonicalJson(original.runWhen?.viewStatusIn || []) !== canonicalJson(effect.viewStatusIn) || canonicalJson(original.semanticHints?.coveredCalculationRanges) !== canonicalJson(ranges) || !hasVerifiedDeterministicScriptBranchProof(original) || original.deterministicBranchProof.basis !== "deterministic-local-currency-helper" || !original.functionMappings?.every(mapping => mapping.basis === "deterministic-local-currency-helper")) {
      fail(action, "The native currency effect must retain its complete verified original source action."); return;
    }
    effectIds.add(effect.actionId);
  }
  try {
    // DSL has no raw source scripts. Raw provenance is independently rebuilt by
    // checkTrust; schema admission checks the sealed native audit plus the exact
    // already-verified source action and declared calculation bindings.
    const structuralDraft = { ...dsl, scripts: { ...dsl.scripts, actions: (dsl.scripts?.actions || []).filter(original => !effectIds.has(original.id)) } };
    const rebuilt = buildNativeImportCalculationSpec(structuralDraft, inspected.spec.tableId);
    if (canonicalJson({ ...rebuilt, currencyEffects: plan.currencyEffects }) !== canonicalJson(plan)) fail(action, "The native calculation plan differs from its exact declared form bindings.");
  } catch { fail(action, "The declared native calculation closure cannot be rebuilt."); }
}
