import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "acorn";
import { checkExecute } from "../dsl/checks.js";
import { NewoaClient, normalizeBaseUrl } from "./newoa-client.js";
import { applyFormPayload } from "./persistence/form-writer.js";
import { stableStringify } from "./persistence/normalize.js";
import { markedDispatcherActionFunction } from "./persistence/script-dispatcher-contract.js";

export function publishedFormSnapshotDigest(template, officialForm) {
  return digest(withoutMechanismTokens({ template, officialForm }));
}

/** Mechanism tokens authorize the current request; they are not persisted template state. */
export function withoutMechanismTokens(value) {
  const copy = structuredClone(value);
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    const auth = node.mechanisms?.["sys-auth"];
    if (auth && typeof auth === "object") delete auth.mechAuthToken;
    for (const child of Object.values(node)) visit(child);
  };
  visit(copy);
  return copy;
}

/** Patch only an explicitly selected current official form version, never its workflow. */
export async function executePublishedFormPatch(dsl, options = {}) {
  const validation = checkExecute(dsl);
  if (!validation.ok) return { ok: false, status: "invalid", diagnostics: validation.diagnostics };
  let stage = "safety";
  let stateCreated = false;
  let writeStarted = false;
  let saved = false;
  let baseUrl;
  const state = (status, extra = {}) => ({
    status, stage, templateId: options.targetTemplateId,
    writeStarted, writeOutcomeUnknown: writeStarted && !saved, ...extra
  });
  const record = (name, value, exclusive = false) => writeFileSync(
    join(options.artifactsDir, name), `${JSON.stringify(withoutMechanismTokens(value), null, 2)}\n`,
    { mode: 0o600, flag: exclusive ? "wx" : "w", flush: true }
  );
  try {
    requireValue(options.confirmWrite === true && options.publishedFormPatch === true, "published.confirmation_required");
    for (const key of ["targetTemplateId", "targetCategoryId", "artifactsDir"]) {
      requireValue(typeof options[key] === "string" && options[key].trim(), `published.${key}_required`);
    }
    requireValue(/^[a-f0-9]{64}$/.test(options.expectedSnapshotDigest || ""), "published.snapshot_digest_required");
    requireValue(options.credentials?.username && options.credentials?.encryptedPassword, "published.credentials_required");
    requireValue(validIds(options.readonlyFieldIds) && validIds(options.scriptActionIds), "published.explicit_scope_required");
    requireValue(options.readonlyFieldIds.length + options.scriptActionIds.length > 0, "published.empty_scope");
    baseUrl = normalizeBaseUrl(options.baseUrl);
    mkdirSync(options.artifactsDir, { recursive: true, mode: 0o700 });
    record("write-state.json", state("preparing"), true);
    stateCreated = true;
    const client = options.client || new NewoaClient({ baseUrl, fetchImpl: options.fetchImpl });
    stage = "login";
    await client.login(options.credentials);
    stage = "snapshot";
    const template = await client.getTemplate(options.targetTemplateId);
    validateTemplate(template, options);
    const officialForm = await client.getOfficialForm(template.mechanisms["sys-xform"].fdVersionId);
    requireValue(publishedFormSnapshotDigest(template, officialForm) === options.expectedSnapshotDigest, "published.snapshot_changed");
    record("before.template.json", template, true);
    record("before.official-form.json", officialForm, true);
    stage = "prepare";
    const prepared = preparePublishedFormPatch(dsl, template, officialForm, options);
    record("plan.json", prepared.plan, true);
    record("save.payload.json", prepared.payload, true);
    if (!prepared.plan.changed) {
      const result = { ok: true, status: "unchanged", templateId: template.fdId, createdFdIds: [], updatedFdIds: [], readback: prepared.verify(template, officialForm) };
      record("write-state.json", state("verified"));
      return result;
    }
    stage = "compareSnapshot";
    const latestTemplate = await client.getTemplate(template.fdId);
    validateTemplate(latestTemplate, options);
    const latestForm = await client.getOfficialForm(latestTemplate.mechanisms["sys-xform"].fdVersionId);
    requireValue(publishedFormSnapshotDigest(latestTemplate, latestForm) === options.expectedSnapshotDigest, "published.snapshot_changed");
    stage = "saveOfficialForm";
    writeStarted = true;
    record("write-state.json", state("write_started"));
    await client.saveOfficialForm({ ...prepared.payload, mechanisms: latestForm.mechanisms || {} });
    saved = true;
    stage = "readback";
    record("write-state.json", state("awaiting_readback"));
    const afterForm = await client.getOfficialForm(officialForm.fdId);
    const afterTemplate = await client.getTemplate(template.fdId);
    record("after.official-form.json", afterForm, true);
    record("after.template.json", afterTemplate, true);
    const readback = prepared.verify(afterTemplate, afterForm);
    const result = {
      ok: readback.ok, status: readback.ok ? "updated" : "readback_failed", baseUrl,
      templateId: template.fdId, officialVersionId: officialForm.fdId,
      createdFdIds: [], updatedFdIds: [template.fdId], writeOutcomeUnknown: false,
      plan: prepared.plan, readback, artifactsDir: options.artifactsDir
    };
    record("result.json", result);
    record("write-state.json", state(readback.ok ? "verified" : "readback_failed"));
    return result;
  } catch (error) {
    const result = {
      ok: false, status: writeStarted ? "failed" : "blocked", stage, baseUrl,
      templateId: options.targetTemplateId, createdFdIds: [],
      updatedFdIds: saved ? [options.targetTemplateId] : [],
      writeOutcomeUnknown: writeStarted && !saved,
      diagnostics: [{ level: "error", code: error.code || "published.update_failed", message: "Published form patch stopped; no automatic retry or rollback was attempted." }]
    };
    if (stateCreated) {
      record("result.json", result);
      record("write-state.json", state(result.status));
    }
    return result;
  }
}

export function preparePublishedFormPatch(dsl, template, officialForm, options) {
  validateTemplate(template, options);
  const xform = template.mechanisms["sys-xform"];
  requireValue(officialForm?.fdId === xform.fdVersionId && officialForm.fdXForm?.fdId === template.fdId &&
    officialForm.fdEntityId === template.fdId && officialForm.fdStatus === "official" &&
    officialForm.fdTableName === template.fdTableName, "published.official_binding_mismatch");
  const candidate = applyFormPayload(template, dsl);
  const candidateConfig = JSON.parse(candidate.mechanisms["sys-xform"].fdConfig);
  const candidateActions = JSON.parse(candidateConfig.attribute.formAttr).controlAction;
  const config = JSON.parse(officialForm.fdConfig);
  const next = patchedConfig(config, candidateActions, dsl, options, template.fdTableName);
  const designBefore = JSON.parse(xform.fdConfig);
  const designAfter = patchedConfig(designBefore, candidateActions, dsl, options, template.fdTableName);
  const payload = { fdId: officialForm.fdId, fdConfig: JSON.stringify(next.config), mechanisms: officialForm.mechanisms || {} };
  return {
    payload,
    plan: { templateId: template.fdId, officialVersionId: officialForm.fdId, categoryId: options.targetCategoryId,
      changed: digest(next.config) !== digest(config), readonlyFields: options.readonlyFieldIds, scripts: next.scripts,
      snapshotDigest: publishedFormSnapshotDigest(template, officialForm) },
    verify(afterTemplate, afterForm) {
      const checks = {};
      try {
        validateTemplate(afterTemplate, options);
        const profiles = /^[a-f0-9]{32}$/i.test(officialForm.fdProfileId || "") && /^[a-f0-9]{32}$/i.test(afterForm.fdProfileId || "");
        checks.templateAndWorkflow = digest(protectedTemplate(afterTemplate, profiles ? afterForm.fdProfileId : undefined)) ===
          digest(protectedTemplate(template, profiles ? officialForm.fdProfileId : undefined));
        checks.officialIdentity = digest(protectedOfficial(afterForm, profiles)) === digest(protectedOfficial(officialForm, profiles));
        checks.officialConfig = digest(configWithoutViewAudit(JSON.parse(afterForm.fdConfig))) === digest(configWithoutViewAudit(next.config));
        const design = digest(configWithoutViewAudit(JSON.parse(afterTemplate.mechanisms["sys-xform"].fdConfig)));
        const expectedDesign = digest(configWithoutViewAudit(designAfter.config));
        checks.designConfig = design === digest(configWithoutViewAudit(designBefore)) || design === expectedDesign;
        return { ok: Object.values(checks).every(Boolean), checks, designConfigUpdated: design === expectedDesign,
          runtimeProfileRegenerated: profiles && officialForm.fdProfileId !== afterForm.fdProfileId };
      } catch {
        return { ok: false, checks, decodeFailed: true };
      }
    }
  };
}

function patchedConfig(config, candidateActions, dsl, options, tableName) {
  const next = structuredClone(config);
  const model = next.dataModel?.find((entry) => entry.fdType === "main" && entry.fdTableName === tableName);
  requireValue(model && Array.isArray(next.auth) && next.auth.length, "published.native_form_unreadable");
  for (const id of options.readonlyFieldIds) {
    const field = dsl.form.fields.find((field) => field.id === id && field.type !== "detailTable");
    requireValue(field?.props?.readOnly === true && model.fdFields.filter((field) => field.fdName === id && !field.fdIsSystem).length === 1, "published.readonly_field_mismatch");
    for (const entry of next.auth) for (const mode of ["add", "edit"]) {
      const authority = entry?.[mode]?.[tableName]?.fields?.[id];
      requireValue(typeof authority?.editable === "boolean", "published.native_authority_missing");
      authority.editable = false;
    }
  }
  const attr = JSON.parse(next.attribute.formAttr);
  const scripts = [];
  for (const id of options.scriptActionIds) {
    const action = dsl.scripts?.actions?.find((action) => action.id === id);
    requireValue(action?.scope === "global" && action.event === "onLoad" && action.translationStatus === "mapped", "published.action_scope_invalid");
    const textIds = new Set((action.branchProvenance?.conditions || []).filter((condition) => condition.emptyText === true).map((condition) => condition.origin.slice(6)));
    requireValue(textIds.size, "published.action_text_evidence_required");
    const before = actionLocation(attr.controlAction, id);
    const after = actionLocation(candidateActions, id);
    const newFunction = after.function.replace(/^function\s+[A-Za-z_$][\w$]*/, `function ${before.name}`);
    requireValue(scriptSemantics(before.function, textIds) === scriptSemantics(newFunction, textIds), "published.script_change_outside_text_normalization");
    const offset = before.owner.function.indexOf(before.function);
    requireValue(offset >= 0 && offset === before.owner.function.lastIndexOf(before.function), "published.action_body_ambiguous");
    before.owner.function = before.owner.function.slice(0, offset) + newFunction + before.owner.function.slice(offset + before.function.length);
    scripts.push({ id, beforeSha256: digest(before.function), afterSha256: digest(newFunction), textFieldIds: [...textIds] });
  }
  next.attribute.formAttr = JSON.stringify(attr);
  return { config: next, scripts };
}

function actionLocation(actions, id) {
  const matches = [];
  for (const owner of actions?.global?.onLoad || []) for (const action of owner.migrationActions || []) {
    if (action.id !== id) continue;
    const fn = markedDispatcherActionFunction(owner.function, action.name);
    requireValue(fn, "published.action_body_missing");
    matches.push({ owner, name: action.name, function: fn });
  }
  requireValue(matches.length === 1, "published.action_binding_mismatch");
  return matches[0];
}

function scriptSemantics(source, textIds) {
  const ast = parse(source, { ecmaVersion: "latest" });
  requireValue(ast.body.length === 1 && ast.body[0].type === "FunctionDeclaration", "published.action_function_invalid");
  ast.body[0].id.name = "__action__";
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== "object") return value;
    if (value.type === "CallExpression" && value.callee.type === "Identifier" && value.callee.name === "String" && value.arguments.length === 1) {
      const expression = value.arguments[0];
      const read = expression.left;
      if (expression.type === "LogicalExpression" && expression.operator === "??" && expression.right.type === "Literal" && expression.right.value === "" &&
        read?.type === "CallExpression" && read.callee.type === "MemberExpression" && !read.callee.computed &&
        read.callee.object.name === "MKXFORM" && read.callee.property.name === "getValue" && read.arguments.length === 1 &&
        read.arguments[0].type === "Literal" && textIds.has(read.arguments[0].value)) return normalize(read);
    }
    return Object.fromEntries(Object.entries(value).filter(([key]) => !["start", "end", "raw"].includes(key)).map(([key, item]) => [key, normalize(item)]));
  };
  return stableStringify(normalize(ast));
}

function validateTemplate(template, options) {
  requireValue(template?.fdId === options.targetTemplateId && template.fdName?.startsWith("MK_TEST_") &&
    template.fdCategory?.fdId === options.targetCategoryId && Number(template.fdStatus) === 2, "published.target_mismatch");
  const xform = template.mechanisms?.["sys-xform"];
  const workflow = template.mechanisms?.lbpmTemplate?.[0];
  requireValue(xform?.fdStatus === "official" && xform.fdVersionId && xform.fdTableName === template.fdTableName &&
    workflow?.fdStatus === "published" && workflow.isDraft === false, "published.published_state_required");
}

function protectedTemplate(template, profileId) {
  const copy = withoutMechanismTokens(template);
  delete copy.fdAlter;
  delete copy.fdAlterTime;
  const xform = copy.mechanisms["sys-xform"];
  delete xform.fdAlter;
  delete xform.fdAlterTime;
  delete xform.fdConfig;
  if (profileId) for (const workflow of copy.mechanisms.lbpmTemplate || []) {
    for (const property of Object.values(workflow.fdFormFields?.[template.fdId]?.properties || {})) {
      if (typeof property.$ref === "string") property.$ref = normalizedProfileReference(property.$ref, profileId);
    }
    for (const property of Object.values(workflow.defaultFormMetaData?.properties || {})) {
      const argument = property.features?.["com.landray.framework.meta.DialogArgument"];
      if (typeof argument?.value === "string") argument.value = normalizedProfileReference(argument.value, profileId);
    }
  }
  return copy;
}

function protectedOfficial(form, regeneratedProfile) {
  const copy = withoutMechanismTokens(form);
  for (const key of ["fdConfig", "fdAlter", "fdAlterTime"]) delete copy[key];
  if (regeneratedProfile) delete copy.fdProfileId;
  return copy;
}

function normalizedProfileReference(value, profileId) {
  const prefix = "sys-xform:XFormComponent:";
  if (!value.startsWith(prefix)) return value;
  const descriptor = JSON.parse(value.slice(prefix.length));
  if (descriptor.fdProfileId === profileId) descriptor.fdProfileId = "__current_official_form_profile__";
  return prefix + stableStringify(descriptor);
}

function configWithoutViewAudit(config) {
  const copy = structuredClone(config);
  for (const view of copy.viewModel || []) {
    delete view.fdAlter;
    delete view.fdAlterTime;
  }
  return copy;
}

function validIds(ids) {
  return Array.isArray(ids) && new Set(ids).size === ids.length && ids.every((id) => typeof id === "string" && id.trim() === id && id.length);
}

function requireValue(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function digest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
