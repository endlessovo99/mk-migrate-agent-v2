import { buildDryRunPlan } from "./dry-run.js";
import { applyFormPayload } from "./form-payload.js";
import { assertAllowedBaseUrl, NewoaClient, NEWOA_SIT_BASE_URL } from "./newoa-client.js";
import { verifyReadback } from "./readback.js";
import { applyWorkflowPayload, workflowMappingDiagnostics } from "./workflow-payload.js";

export async function executeDsl(input, options = {}) {
  const plan = buildDryRunPlan(input);

  if (!plan.ok) {
    return {
      ok: false,
      status: "invalid",
      diagnostics: plan.diagnostics,
      validationPolicy: input?.validationPolicy,
      catalogs: input?.catalogs,
      plan
    };
  }

  const credentials = options.credentials || {};
  const safety = validateSafety(options);
  if (safety.length) {
    return blocked(plan, safety);
  }

  const baseUrl = assertAllowedBaseUrl(options.baseUrl || NEWOA_SIT_BASE_URL);
  const client = options.client || new NewoaClient({ baseUrl, fetchImpl: options.fetchImpl });
  const diagnostics = [...plan.diagnostics];
  const apiStages = [];
  let templateId = "";

  try {
    apiStages.push({ name: "login", status: "started" });
    await client.login(credentials);
    apiStages[apiStages.length - 1].status = "ok";
    apiStages.push({ name: "init", status: "started" });
    const baseTemplate = await client.initTemplate();
    apiStages[apiStages.length - 1].status = "ok";
    apiStages.push({ name: "generateTableName", status: "started" });
    const fdTableName = await client.generateTableName();
    apiStages[apiStages.length - 1].status = "ok";
    apiStages[apiStages.length - 1].fdTableName = fdTableName || undefined;
    apiStages.push({ name: "loadParentCategory", status: "started" });
    const parentCategory = await client.loadParentCategory(options.targetCategoryId);
    apiStages[apiStages.length - 1].status = "ok";
    apiStages.push({ name: "add", status: "started" });
    const created = await client.addTemplate(buildCreatePayload(baseTemplate, input, options, {
      fdTableName,
      parentCategory
    }));
    templateId = created.fdId;
    apiStages[apiStages.length - 1].status = "ok";
    apiStages[apiStages.length - 1].templateId = templateId;
    apiStages.push({ name: "get", status: "started", templateId });
    const detail = await client.getTemplate(templateId);
    apiStages[apiStages.length - 1].status = "ok";
    diagnostics.push(...workflowMappingDiagnostics(input.workflow));
    const savePayload = applyWorkflowPayload(applyFormPayload({
      ...detail,
      fdCategory: { fdId: options.targetCategoryId }
    }, input), input);
    apiStages.push({ name: "update", status: "started", templateId });
    await client.updateTemplate(savePayload);
    apiStages[apiStages.length - 1].status = "ok";
    apiStages.push({ name: "readback", status: "started", templateId });
    const readbackTemplate = await client.getTemplate(templateId);
    apiStages[apiStages.length - 1].status = "ok";
    const readback = verifyReadback(input, readbackTemplate);
    diagnostics.push(...readback.diagnostics);

    if (!readback.ok) {
      return {
        ok: false,
        status: "readback_failed",
        stage: "readback",
        failedAt: "readback",
        templateId,
        createdFdIds: [templateId].filter(Boolean),
        cleanup: { attempted: false, reason: "automatic rollback is out of scope for v2 route-validation" },
        diagnostics,
        apiStages,
        plan,
        readback
      };
    }

    return {
      ok: true,
      status: diagnostics.some((diagnostic) => diagnostic.level === "warning") ? "written_with_warnings" : "written",
      templateId,
      createdFdIds: [templateId].filter(Boolean),
      validationPolicy: input?.validationPolicy,
      catalogs: input?.catalogs,
      diagnostics,
      apiStages,
      plan,
      readback
    };
  } catch (error) {
    if (apiStages.length && apiStages[apiStages.length - 1].status === "started") {
      apiStages[apiStages.length - 1].status = "failed";
    }
    return {
      ok: false,
      status: "failed",
      stage: error?.stage || inferFailureStage(error),
      failedAt: error?.stage || inferFailureStage(error),
      templateId: templateId || undefined,
      createdFdIds: [templateId].filter(Boolean),
      cleanup: { attempted: false, reason: "automatic rollback is out of scope for v2 route-validation" },
      validationPolicy: input?.validationPolicy,
      catalogs: input?.catalogs,
      diagnostics: [
        ...diagnostics,
        {
          level: "error",
          code: "execute.newoa_api_failed",
          message: redactCredentialValues(error instanceof Error ? error.message : String(error), credentials),
          path: "/execute"
        }
      ],
      apiStages,
      plan
    };
  }
}

function validateSafety(options) {
  const diagnostics = [];
  if (options.confirmWrite !== true) {
    diagnostics.push({
      level: "error",
      code: "safety.confirm_write_required",
      message: "execute requires --confirm-write.",
      path: "/confirmWrite"
    });
  }
  if (!nonEmptyString(options.targetCategoryId)) {
    diagnostics.push({
      level: "error",
      code: "safety.target_category_required",
      message: "execute requires --target-category-id.",
      path: "/targetCategoryId"
    });
  }
  if (!nonEmptyString(options.credentials?.username)) {
    diagnostics.push({
      level: "error",
      code: "safety.username_required",
      message: "execute requires NEWOA_USERNAME.",
      path: "/credentials/username"
    });
  }
  if (!nonEmptyString(options.credentials?.encryptedPassword)) {
    diagnostics.push({
      level: "error",
      code: "safety.encrypted_password_required",
      message: "execute requires NEWOA_ENCRYPTED_PASSWORD.",
      path: "/credentials/encryptedPassword"
    });
  }
  try {
    assertAllowedBaseUrl(options.baseUrl || NEWOA_SIT_BASE_URL);
  } catch (error) {
    diagnostics.push({
      level: "error",
      code: "safety.base_url_not_allowed",
      message: error instanceof Error ? error.message : String(error),
      path: "/baseUrl"
    });
  }
  return diagnostics;
}

function buildCreatePayload(baseTemplate, input, options, context = {}) {
  const name = buildTestTemplateName(input?.template?.name || "未命名模板", options.now || new Date());
  const payload = clone(baseTemplate);
  payload.fdName = name;
  payload.fdSimpleName = name;
  payload.fdMode = 1;
  payload.fdStatus = payload.fdStatus ?? 0;
  payload.fdCategory = { fdId: options.targetCategoryId };
  payload.fdOrder = payload.fdOrder || 99999;
  payload.fdIcon = payload.fdIcon || '{"name":"category-default","type":"complex"}';
  payload.fdCode = payload.fdCode || buildTemplateCode(options.now || new Date());
  if (context.fdTableName) {
    payload.fdTableName = context.fdTableName;
  }
  payload.dynamicProps = {
    ...(payload.dynamicProps || {}),
    fdName: localizedText(name),
    fdSimpleName: localizedText(name)
  };
  prepareDraftLbpmTemplate(payload, {
    targetCategoryId: options.targetCategoryId,
    parentCategory: context.parentCategory
  });
  return payload;
}

function buildTestTemplateName(name, now) {
  const timestamp = new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const normalized = String(name).replace(/\s+/g, "").slice(0, 60) || "未命名模板";
  return `MK_TEST_${normalized}_${timestamp}`;
}

function buildTemplateCode(now) {
  return `template_${new Date(now).getTime().toString(36).slice(-6)}`;
}

function prepareDraftLbpmTemplate(payload, { targetCategoryId, parentCategory }) {
  payload.mechanisms = payload.mechanisms || {};
  payload.mechanisms.lbpmTemplate = Array.isArray(payload.mechanisms.lbpmTemplate)
    ? payload.mechanisms.lbpmTemplate
    : [{}];
  const lbpm = payload.mechanisms.lbpmTemplate[0] || {};
  payload.mechanisms.lbpmTemplate[0] = lbpm;

  lbpm.fdReaders = payload.fdReaders || lbpm.fdReaders || [];
  lbpm.fdEditors = payload.fdEditors || lbpm.fdEditors || [];
  lbpm.fdTemplateCode = payload.fdCode;
  lbpm.fdSystemCode = "INNER_SYSTEM";
  lbpm.fdSystemName = "MK-PaaS内部系统";
  lbpm.fdModuleCode = "km-review";
  lbpm.fdStatus = lbpm.fdStatus || "draft";
  lbpm.fdPublishType = lbpm.fdPublishType || "instant";
  lbpm.isDraft = true;
  delete lbpm.fdCategory;
  lbpm.fdFormCategory = normalizeFormCategory(parentCategory, targetCategoryId, lbpm.fdFormCategory);
  lbpm.fdTemplateForms = Array.isArray(lbpm.fdTemplateForms) ? lbpm.fdTemplateForms : [];

  if (lbpm.fdTemplateForms.length === 0) {
    const formCode = payload.fdId || payload.fdCode;
    lbpm.fdTemplateForms.push({
      fdConfigType: 2,
      fdName: payload.fdName,
      fdFormCode: formCode,
      fdFormCreateUrl: `/current/km-review/add/${formCode}`,
      fdFormHandleUrl: "/current/km-review/view/${formId}",
      fdIsDefault: true,
      fdFormKey: formCode
    });
  }

  lbpm.fdTemplateForms[0].fdSystemCode = "INNER_SYSTEM";
  lbpm.fdTemplateForms[0].fdSystemName = "MK-PaaS内部系统";
  lbpm.fdTemplateForms[0].fdModuleCode = "km-review";
}

function normalizeFormCategory(parentCategory, targetCategoryId, currentCategory) {
  const category = clone(parentCategory || currentCategory || {});
  pruneEmptyParentCategory(category);
  category.fdFormCategoryId = category.fdFormCategoryId || targetCategoryId;
  return category;
}

function pruneEmptyParentCategory(category) {
  if (!category || typeof category !== "object") return;
  if (!category.fdFormParentCategory) return;
  if (!category.fdFormParentCategory.fdFormCategoryId) {
    delete category.fdFormParentCategory;
    return;
  }
  pruneEmptyParentCategory(category.fdFormParentCategory);
}

function localizedText(value) {
  return {
    default: value,
    Cn: value,
    Us: value
  };
}

function blocked(plan, diagnostics) {
  return {
    ok: false,
    status: "blocked",
    diagnostics,
    plan
  };
}

function inferFailureStage(error) {
  if (String(error?.message || "").includes("fdId")) return "add";
  return "execute";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function redactCredentialValues(value, credentials = {}) {
  let result = String(value);
  const secrets = [credentials.username, credentials.encryptedPassword]
    .filter(nonEmptyString)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}
