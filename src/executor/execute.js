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
      plan
    };
  }

  const safety = validateSafety(options);
  if (safety.length) {
    return blocked(plan, safety);
  }

  const baseUrl = assertAllowedBaseUrl(options.baseUrl || NEWOA_SIT_BASE_URL);
  const client = options.client || new NewoaClient({ baseUrl, fetchImpl: options.fetchImpl });
  const diagnostics = [...plan.diagnostics];
  const username = process.env.NEWOA_USERNAME;
  const encryptedPassword = process.env.NEWOA_ENCRYPTED_PASSWORD;
  const apiStages = [];
  let templateId = "";

  try {
    apiStages.push({ name: "login", status: "started" });
    await client.login({ username, encryptedPassword });
    apiStages[apiStages.length - 1].status = "ok";
    apiStages.push({ name: "add", status: "started" });
    const created = await client.addTemplate(buildCreatePayload(input, options));
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
        templateId,
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
      templateId: templateId || undefined,
      diagnostics: [
        ...diagnostics,
        {
          level: "error",
          code: "execute.newoa_api_failed",
          message: error instanceof Error ? error.message : String(error),
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
  if (!nonEmptyString(process.env.NEWOA_USERNAME)) {
    diagnostics.push({
      level: "error",
      code: "safety.username_required",
      message: "execute requires NEWOA_USERNAME.",
      path: "/credentials/username"
    });
  }
  if (!nonEmptyString(process.env.NEWOA_ENCRYPTED_PASSWORD)) {
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

function buildCreatePayload(input, options) {
  return {
    fdName: buildTestTemplateName(input?.template?.name || "未命名模板", options.now || new Date()),
    fdCategory: {
      fdId: options.targetCategoryId
    },
    fdOrder: 99999
  };
}

function buildTestTemplateName(name, now) {
  const timestamp = new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const normalized = String(name).replace(/\s+/g, "").slice(0, 60) || "未命名模板";
  return `MK_TEST_${normalized}_${timestamp}`;
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
