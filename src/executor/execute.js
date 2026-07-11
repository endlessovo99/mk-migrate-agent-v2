import { buildDryRunPlan } from "./dry-run.js";
import { assertAllowedBaseUrl, NewoaClient, NEWOA_SIT_BASE_URL } from "./newoa-client.js";
import { resolveWorkflowParticipants } from "./participant-resolver.js";
import { resolveConditionOrgs } from "./condition-org-resolver.js";
import { preparePersistedTemplate, buildWorkflowDraftPayload } from "./persistence.js";

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
  let executableDsl = input;

  try {
    apiStages.push({ name: "login", status: "started" });
    await client.login(credentials);
    apiStages[apiStages.length - 1].status = "ok";
    apiStages.push({ name: "resolveWorkflowParticipants", status: "started" });
    const participantResolution = await resolveWorkflowParticipants(input, {
      client,
      targetBaseUrl: baseUrl
    });
    executableDsl = participantResolution.dsl;
    apiStages[apiStages.length - 1].status = "ok";
    apiStages[apiStages.length - 1].resolvedCount = participantResolution.resolvedCount;
    apiStages[apiStages.length - 1].identityCount = participantResolution.identityCount;
    if (participantResolution.fallbackCount > 0) {
      apiStages[apiStages.length - 1].fallbackCount = participantResolution.fallbackCount;
      apiStages[apiStages.length - 1].fallbackIdentityCount = participantResolution.fallbackIdentityCount;
      apiStages[apiStages.length - 1].fallbackTargetId = participantResolution.fallbackTargetId;
      diagnostics.push({
        level: "warning",
        code: "workflow.participant_sit_fallback_applied",
        message: "Unresolved source workflow participants were replaced with the configured NewOA SIT fallback participant.",
        path: "/workflow/participants",
        details: {
          referenceCount: participantResolution.fallbackCount,
          identityCount: participantResolution.fallbackIdentityCount,
          targetFdId: participantResolution.fallbackTargetId
        }
      });
    }
    apiStages.push({ name: "resolveConditionOrgs", status: "started" });
    const conditionOrgResolution = await resolveConditionOrgs(executableDsl, {
      client,
      targetBaseUrl: baseUrl
    });
    executableDsl = conditionOrgResolution.dsl;
    apiStages[apiStages.length - 1].status = "ok";
    apiStages[apiStages.length - 1].resolvedCount = conditionOrgResolution.resolvedCount;
    apiStages[apiStages.length - 1].nameCount = conditionOrgResolution.nameCount;
    if (conditionOrgResolution.fallbackCount > 0) {
      apiStages[apiStages.length - 1].fallbackCount = conditionOrgResolution.fallbackCount;
      diagnostics.push({
        level: "warning",
        code: "workflow.condition_org_sit_fallback_applied",
        message: "Unresolved address-field branch condition organization names were replaced with the configured NewOA SIT address-book sample orgs.",
        path: "/workflow/conditions",
        details: {
          fallbackNames: conditionOrgResolution.fallbackNames,
          fallbackOrgs: conditionOrgResolution.fallbackNames.map((name) => ({
            sourceName: name,
            target: executableDsl.runtime?.conditionOrgByName?.[name]
          }))
        }
      });
    }
    if (conditionOrgResolution.unresolvedNames.length) {
      apiStages[apiStages.length - 1].unresolvedCount = conditionOrgResolution.unresolvedNames.length;
      diagnostics.push({
        level: "warning",
        code: "workflow.condition_org_unresolved",
        message: "Some address-field branch condition organization names could not be uniquely resolved; those predicates fall back to string contains.",
        path: "/workflow/conditions",
        details: {
          unresolvedNames: conditionOrgResolution.unresolvedNames
        }
      });
    }
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
    const createPayload = buildCreatePayload(baseTemplate, executableDsl, options, {
      fdTableName,
      parentCategory
    });
    const created = await client.addTemplate(createPayload);
    templateId = created.fdId;
    apiStages[apiStages.length - 1].status = "ok";
    apiStages[apiStages.length - 1].templateId = templateId;
    apiStages.push({ name: "get", status: "started", templateId });
    const detail = await client.getTemplate(templateId);
    apiStages[apiStages.length - 1].status = "ok";

    const envelope = {
      templateId,
      templateName: createPayload.fdName,
      categoryId: options.targetCategoryId,
      tableName: fdTableName || detail.fdTableName || detail.mechanisms?.["sys-xform"]?.fdTableName || "",
      lifecycle: {
        draft: true,
        unpublished: true,
        fdStatus: detail.fdStatus ?? 0,
        xformStatus: "draft",
        lbpmStatus: "draft",
        lbpmIsDraft: true
      },
      bindings: {
        formFdId: templateId,
        workflowFdId: detail.mechanisms?.lbpmTemplate?.[0]?.fdId || ""
      }
    };

    let prepared;
    try {
      prepared = preparePersistedTemplate({
        dsl: executableDsl,
        envelope,
        baseTemplate: detail
      });
    } catch (error) {
      return projectionFailure({
        plan,
        diagnostics,
        apiStages,
        templateId,
        credentials,
        error
      });
    }

    if (!prepared.ok) {
      return {
        ok: false,
        status: "failed",
        stage: "projection",
        failedAt: "projection",
        templateId,
        createdFdIds: [templateId].filter(Boolean),
        cleanup: { attempted: false, reason: "automatic rollback is out of scope for v2 route-validation" },
        diagnostics: [...diagnostics, ...prepared.diagnostics],
        apiStages,
        plan
      };
    }

    const savePayload = prepared.update;
    apiStages.push({ name: "update", status: "started", templateId });
    await client.updateTemplate(savePayload);
    apiStages[apiStages.length - 1].status = "ok";
    let workflowTemplateDetail;
    const workflowTemplateId = savePayload.mechanisms?.lbpmTemplate?.[0]?.fdId || "";
    if (executableDsl.workflow) {
      apiStages.push({ name: "saveWorkflowDraft", status: "started", templateId: workflowTemplateId });
      const savedWorkflowDraft = await client.saveWorkflowDraft(buildWorkflowDraftPayload(savePayload));
      const draftId = requireWorkflowDraftId(savedWorkflowDraft);
      apiStages[apiStages.length - 1].status = "ok";
      apiStages[apiStages.length - 1].draftId = draftId;
      apiStages.push({
        name: "getWorkflowTemplateDetail",
        status: "started",
        templateId: workflowTemplateId,
        draftId
      });
      workflowTemplateDetail = await client.getWorkflowTemplateDetail({
        templateId: workflowTemplateId,
        definitionId: ""
      });
      assertWorkflowTemplateDetail(workflowTemplateDetail, workflowTemplateId, options.targetCategoryId);
      apiStages[apiStages.length - 1].status = "ok";
    }
    apiStages.push({ name: "readback", status: "started", templateId });
    const readbackTemplate = await client.getTemplate(templateId);
    if (workflowTemplateDetail) {
      assertCurrentWorkflowTopLinkage(readbackTemplate, workflowTemplateDetail, workflowTemplateId);
    }
    apiStages[apiStages.length - 1].status = "ok";
    const readback = prepared.verify(
      workflowTemplateDetail
        ? attachWorkflowReadback(readbackTemplate, workflowTemplateDetail)
        : readbackTemplate
    );
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
          code: error?.code || "execute.newoa_api_failed",
          message: redactCredentialValues(error instanceof Error ? error.message : String(error), credentials),
          path: error?.stage === "resolveWorkflowParticipants" ? "/workflow/participants" : "/execute",
          ...(Array.isArray(error?.issues)
            ? { details: { issues: redactParticipantIssues(error.issues, credentials) } }
            : {})
        }
      ],
      apiStages,
      plan
    };
  }
}

function projectionFailure({ plan, diagnostics, apiStages, templateId, credentials, error }) {
  return {
    ok: false,
    status: "failed",
    stage: "projection",
    failedAt: "projection",
    templateId,
    createdFdIds: [templateId].filter(Boolean),
    cleanup: { attempted: false, reason: "automatic rollback is out of scope for v2 route-validation" },
    diagnostics: [
      ...diagnostics,
      {
        level: "error",
        code: "projection.internal_error",
        message: redactCredentialValues(error instanceof Error ? error.message : String(error), credentials),
        path: "/projection"
      }
    ],
    apiStages,
    plan
  };
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
  lbpm.fdContentType ||= "json";
  lbpm.fdSystemCode = "INNER_SYSTEM";
  lbpm.fdRunType ??= "1";
  lbpm.fdDisableBpmInit ??= false;
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

function redactParticipantIssues(issues, credentials) {
  return issues.map((issue) => ({
    ...issue,
    ...(issue?.message
      ? { message: redactCredentialValues(issue.message, credentials) }
      : {})
  }));
}

function requireWorkflowDraftId(result) {
  const draftId = result?.fdDefinitionId ||
    result?.definitionId ||
    result?.fdId ||
    result?.data?.fdDefinitionId ||
    result?.data?.definitionId ||
    result?.data?.fdId ||
    "";
  if (!nonEmptyString(draftId)) {
    throw stagedError(
      "saveWorkflowDraft",
      "Workflow draft save response did not include a draft id."
    );
  }
  return draftId;
}

function assertWorkflowTemplateDetail(detail, workflowTemplateId, targetCategoryId) {
  if (!nonEmptyString(detail?.fdId)) {
    throw stagedError(
      "getWorkflowTemplateDetail",
      "Workflow detail readback did not include the LBPM template id."
    );
  }
  if (detail.fdId !== workflowTemplateId) {
    throw stagedError(
      "getWorkflowTemplateDetail",
      "Workflow detail readback belongs to a different LBPM template."
    );
  }
  if (detail.isDraft !== true || detail.fdStatus !== "draft") {
    throw stagedError(
      "getWorkflowTemplateDetail",
      "Workflow detail readback is not a draft."
    );
  }
  const envelopeChecks = [
    [detail.fdContentType === "json", "fdContentType=json"],
    [detail.fdSystemCode === "INNER_SYSTEM", "fdSystemCode=INNER_SYSTEM"],
    [String(detail.fdRunType) === "1", "fdRunType=1"],
    [detail.fdDisableBpmInit === false, "fdDisableBpmInit=false"],
    [detail.fdFormCategory?.fdFormCategoryId === targetCategoryId, "the requested fdFormCategory"]
  ];
  for (const [matches, expectation] of envelopeChecks) {
    if (!matches) {
      throw stagedError(
        "getWorkflowTemplateDetail",
        `Workflow detail readback did not preserve ${expectation}.`
      );
    }
  }
  if (!nonEmptyString(detail.fdContent)) {
    throw stagedError(
      "getWorkflowTemplateDetail",
      "Workflow detail readback did not include designer content."
    );
  }
}

function assertCurrentWorkflowTopLinkage(template, workflowDetail, workflowTemplateId) {
  const topWorkflow = template?.mechanisms?.lbpmTemplate?.[0];
  if (!nonEmptyString(topWorkflow?.fdId) || topWorkflow.fdId !== workflowTemplateId) {
    throw stagedError(
      "readback",
      "Top-level template readback is not linked to the current LBPM template."
    );
  }
  if (!nonEmptyString(topWorkflow.fdContent)) {
    throw stagedError(
      "readback",
      "Top-level template readback did not include current workflow designer content."
    );
  }
  if (canonicalWorkflowContent(topWorkflow.fdContent) !== canonicalWorkflowContent(workflowDetail.fdContent)) {
    throw stagedError(
      "readback",
      "Top-level template workflow content differs from the current LBPM detail."
    );
  }
}

function canonicalWorkflowContent(value) {
  try {
    return JSON.stringify(sortJsonValue(JSON.parse(value)));
  } catch {
    throw stagedError("readback", "Current workflow designer content is not valid JSON.");
  }
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])])
  );
}

function stagedError(stage, message) {
  const error = new Error(message);
  error.stage = stage;
  return error;
}

function attachWorkflowReadback(template, workflowTemplateDetail) {
  const next = clone(template);
  next.mechanisms = next.mechanisms || {};
  next.mechanisms.lbpmTemplate = [clone(workflowTemplateDetail)];
  return next;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}
