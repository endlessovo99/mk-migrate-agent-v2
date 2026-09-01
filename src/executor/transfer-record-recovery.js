import { buildDryRunPlan } from "./dry-run.js";
import {
  assertCurrentWorkflowTopLinkage,
  assertWorkflowTemplateDetail,
  attachWorkflowReadback,
  buildExecutionEnvelope,
  validateExistingTargetTemplate
} from "./execute.js";
import { resolveConditionOrgs } from "./condition-org-resolver.js";
import { NewoaClient, normalizeBaseUrl } from "./newoa-client.js";
import { resolveWorkflowParticipants } from "./participant-resolver.js";
import { preparePersistedTemplate } from "./persistence.js";
import { attachRequiredTemplateNumberRuleReadback } from "./template-number-rule.js";
import { buildTransferRecordPayload } from "./transfer-record.js";

/**
 * Recover only the missing transfer record for an already-written draft.
 * This path never calls a template or workflow write API.
 */
export async function recoverVerifiedTransferRecord(input, options = {}) {
  const plan = buildDryRunPlan(input);
  if (!plan.ok) {
    return {
      ok: false,
      status: "invalid",
      diagnostics: plan.diagnostics,
      plan
    };
  }

  const target = normalizeTargetBaseUrl(options.baseUrl);
  const safetyDiagnostics = [
    ...validateRecoverySafety(options),
    ...target.diagnostics,
    ...validatePriorExecutionEvidence(options.priorExecutionReport, {
      baseUrl: target.baseUrl,
      plan,
      targetTemplateId: text(options.targetTemplateId)
    })
  ];
  if (safetyDiagnostics.length) {
    return blocked(plan, safetyDiagnostics, target.baseUrl);
  }

  const baseUrl = target.baseUrl;
  const targetTemplateId = options.targetTemplateId.trim();
  const targetCategoryId = options.targetCategoryId.trim();
  const credentials = options.credentials || {};
  const client = options.client || new NewoaClient({
    baseUrl,
    fetchImpl: options.fetchImpl
  });
  const diagnostics = [...plan.diagnostics];
  const apiStages = [];
  let readback;
  let transferRecordPayload;

  try {
    apiStages.push(stage("login", { status: "started" }));
    await client.login(credentials);
    currentStage(apiStages).status = "ok";

    apiStages.push(stage("transferRecordPreflight", { status: "started" }));
    if (
      typeof client.assertTransferRecordAuthentication !== "function" ||
      typeof client.addTransferRecord !== "function"
    ) {
      throw recoveryError(
        "transferRecordPreflight",
        "NewOA client does not implement the transfer-record contract."
      );
    }
    await client.assertTransferRecordAuthentication();
    transferRecordPayload = buildTransferRecordPayload(input, {
      fdId: options.transferRecordId,
      targetTemplateId,
      now: options.now || new Date()
    });
    currentStage(apiStages).status = "ok";
    currentStage(apiStages).recordId = transferRecordPayload.fdId;

    apiStages.push(stage("getTargetTemplate", {
      status: "started",
      templateId: targetTemplateId
    }));
    const template = await client.getTemplate(targetTemplateId);
    currentStage(apiStages).status = "ok";

    apiStages.push(stage("validateTargetTemplate", {
      status: "started",
      templateId: targetTemplateId
    }));
    const targetDiagnostics = validateExistingTargetTemplate(template, {
      templateId: targetTemplateId,
      targetCategoryId
    });
    if (targetDiagnostics.length) {
      currentStage(apiStages).status = "failed";
      return failedBeforeCallback({
        plan,
        diagnostics: [...diagnostics, ...targetDiagnostics],
        apiStages,
        baseUrl,
        targetTemplateId,
        stageName: "validateTargetTemplate"
      });
    }
    currentStage(apiStages).status = "ok";

    apiStages.push(stage("resolveWorkflowParticipants", { status: "started" }));
    const participantResolution = await resolveWorkflowParticipants(input, {
      client,
      targetBaseUrl: baseUrl,
      fallbackFdIds: options.fallbackFdIds,
      participantOverrides: options.participantOverrides,
      templateAuthorizationOverrides: options.templateAuthorizationOverrides,
      directParticipantOverrides: options.directParticipantOverrides,
      allowTemplateAuthorizationFallback: options.allowTemplateAuthorizationFallback,
      allowMissingDirectPersonFallback: options.allowMissingDirectPersonFallback,
      allowMissingDirectPostFallback: options.allowMissingDirectPostFallback,
      directPersonFallbackIds: options.directPersonFallbackIds
    });
    currentStage(apiStages).status = "ok";
    currentStage(apiStages).resolvedCount = participantResolution.resolvedCount;
    currentStage(apiStages).identityCount = participantResolution.identityCount;

    apiStages.push(stage("resolveConditionOrgs", { status: "started" }));
    const conditionResolution = await resolveConditionOrgs(participantResolution.dsl, {
      client,
      targetBaseUrl: baseUrl,
      fallbackFdIds: options.fallbackFdIds
    });
    currentStage(apiStages).status = "ok";
    currentStage(apiStages).resolvedCount = conditionResolution.resolvedCount;

    apiStages.push(stage("readbackProjection", {
      status: "started",
      templateId: targetTemplateId
    }));
    const tableName = template.fdTableName ||
      template.mechanisms?.["sys-xform"]?.fdTableName || "";
    const prepared = preparePersistedTemplate({
      dsl: conditionResolution.dsl,
      envelope: buildExecutionEnvelope({
        templateId: targetTemplateId,
        templateName: template.fdName,
        categoryId: targetCategoryId,
        tableName,
        detail: template
      }),
      baseTemplate: template
    });
    if (!prepared.ok) {
      currentStage(apiStages).status = "failed";
      return failedBeforeCallback({
        plan,
        diagnostics: [...diagnostics, ...prepared.diagnostics],
        apiStages,
        baseUrl,
        targetTemplateId,
        stageName: "readbackProjection"
      });
    }
    currentStage(apiStages).status = "ok";

    let nativeReadback = template;
    const workflowTemplateId = template.mechanisms?.lbpmTemplate?.[0]?.fdId || "";
    if (conditionResolution.dsl.workflow) {
      apiStages.push(stage("getWorkflowTemplateDetail", {
        status: "started",
        templateId: workflowTemplateId
      }));
      const workflowDetail = await client.getWorkflowTemplateDetail({
        templateId: workflowTemplateId,
        definitionId: ""
      });
      assertWorkflowTemplateDetail(workflowDetail, workflowTemplateId, targetCategoryId);
      assertCurrentWorkflowTopLinkage(template, workflowDetail, workflowTemplateId);
      nativeReadback = attachWorkflowReadback(template, workflowDetail);
      currentStage(apiStages).status = "ok";
    }

    apiStages.push(stage("readback", {
      status: "started",
      templateId: targetTemplateId
    }));
    readback = attachRequiredTemplateNumberRuleReadback(
      prepared.verify(nativeReadback),
      template
    );
    currentStage(apiStages).status = "ok";
    diagnostics.push(...readback.diagnostics);
    if (!completeReadbackVerified(readback)) {
      return {
        ...failedBeforeCallback({
          plan,
          diagnostics,
          apiStages,
          baseUrl,
          targetTemplateId,
          stageName: "readback",
          status: "readback_failed"
        }),
        readback
      };
    }

    apiStages.push(stage("addTransferRecord", {
      status: "started",
      recordId: transferRecordPayload.fdId,
      templateId: targetTemplateId
    }));
    try {
      await client.addTransferRecord(transferRecordPayload);
      currentStage(apiStages).status = "ok";
    } catch {
      currentStage(apiStages).status = "failed";
      currentStage(apiStages).writeOutcomeUnknown = true;
      return {
        ok: false,
        status: "transfer_record_failed",
        stage: "addTransferRecord",
        failedAt: "addTransferRecord",
        baseUrl,
        templateId: targetTemplateId,
        createdFdIds: [],
        updatedFdIds: [],
        diagnostics: [
          ...diagnostics,
          {
            level: "error",
            code: "transfer_record.write_outcome_unknown",
            message: "The existing draft was fully verified, but the recovery transfer-record write outcome is unknown. Do not retry this callback.",
            path: "/transferRecord"
          }
        ],
        apiStages,
        plan,
        readback,
        transferRecord: transferRecordSummary(transferRecordPayload, {
          status: "outcome_unknown",
          writeOutcomeUnknown: true
        })
      };
    }

    return {
      ok: true,
      status: "transfer_record_recorded",
      stage: "complete",
      baseUrl,
      templateId: targetTemplateId,
      createdFdIds: [],
      updatedFdIds: [],
      diagnostics,
      apiStages,
      plan,
      readback,
      transferRecord: transferRecordSummary(transferRecordPayload, {
        status: "recorded",
        recovery: true
      })
    };
  } catch (error) {
    if (currentStage(apiStages)?.status === "started") {
      currentStage(apiStages).status = "failed";
    }
    const failedAt = error?.stage || currentStage(apiStages)?.name || "recovery";
    return failedBeforeCallback({
      plan,
      diagnostics: [
        ...diagnostics,
        {
          level: "error",
          code: error?.code || "transfer_record.recovery_failed",
          message: redactCredentials(
            error instanceof Error ? error.message : String(error),
            credentials
          ),
          path: failedAt === "resolveWorkflowParticipants"
            ? "/workflow/participants"
            : "/transferRecord/recovery",
          ...(Array.isArray(error?.issues) ? { details: { issues: error.issues } } : {})
        }
      ],
      apiStages,
      baseUrl,
      targetTemplateId,
      stageName: failedAt
    });
  }
}

function validateRecoverySafety(options) {
  const diagnostics = [];
  requiredConfirmation(
    options.confirmWrite,
    "safety.confirm_write_required",
    "Transfer-record recovery requires --confirm-write.",
    "/confirmWrite",
    diagnostics
  );
  requiredConfirmation(
    options.confirmNoSuccessfulTransferRecord,
    "safety.confirm_no_successful_transfer_record_required",
    "Transfer-record recovery requires explicit confirmation that there is no successful or outcome-unknown prior callback evidence.",
    "/confirmNoSuccessfulTransferRecord",
    diagnostics
  );
  requiredText(options.targetTemplateId, "safety.target_template_required", "Transfer-record recovery requires --target-template-id.", "/targetTemplateId", diagnostics);
  requiredText(options.targetCategoryId, "safety.target_category_required", "Transfer-record recovery requires --target-category-id.", "/targetCategoryId", diagnostics);
  requiredText(options.transferRecordId, "safety.transfer_record_id_required", "Transfer-record recovery requires one fixed --transfer-record-id.", "/transferRecordId", diagnostics);
  if (text(options.transferRecordId) && !/^[a-z0-9]{36}$/.test(options.transferRecordId.trim())) {
    diagnostics.push({
      level: "error",
      code: "safety.transfer_record_id_invalid",
      message: "Transfer-record recovery requires the fixed 36-character lowercase alphanumeric record id format.",
      path: "/transferRecordId"
    });
  }
  requiredText(options.credentials?.username, "safety.username_required", "Transfer-record recovery requires NEWOA_USERNAME.", "/credentials/username", diagnostics);
  requiredText(options.credentials?.encryptedPassword, "safety.encrypted_password_required", "Transfer-record recovery requires NEWOA_ENCRYPTED_PASSWORD.", "/credentials/encryptedPassword", diagnostics);
  return diagnostics;
}

function validatePriorExecutionEvidence(report, { baseUrl, plan, targetTemplateId }) {
  const diagnostics = [];
  const fail = (code, message, details) => diagnostics.push({
    level: "error",
    code,
    message,
    path: "/priorExecutionReport",
    ...(details ? { details } : {})
  });
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    fail("safety.prior_execution_report_required", "Transfer-record recovery requires the prior execution report object.");
    return diagnostics;
  }
  if (
    report.status !== "readback_failed" ||
    report.failedAt !== "readback" ||
    report.readback?.ok !== false
  ) {
    fail(
      "safety.prior_execution_not_readback_failed",
      "The prior execution evidence must be a readback_failed result that stopped before callback."
    );
  }
  if (
    report.templateId !== targetTemplateId ||
    report.createdFdIds?.length !== 1 ||
    report.createdFdIds[0] !== targetTemplateId ||
    (report.updatedFdIds?.length || 0) !== 0
  ) {
    fail(
      "safety.prior_execution_target_mismatch",
      "The prior execution evidence must identify exactly this created target and no updated targets."
    );
  }
  if (normalizeEvidenceBaseUrl(report.baseUrl) !== baseUrl) {
    fail(
      "safety.prior_execution_base_url_mismatch",
      "The prior execution evidence belongs to a different NewOA origin."
    );
  }
  const callbackStages = Array.isArray(report.apiStages)
    ? report.apiStages.filter((entry) => entry?.name === "addTransferRecord")
    : [];
  const requiredStages = ["add", "update", "readback"];
  if (
    !Array.isArray(report.apiStages) ||
    requiredStages.some((name) => (
      report.apiStages.filter((entry) => entry?.name === name && entry?.status === "ok").length !== 1
    )) ||
    report.apiStages.at(-1)?.name !== "readback" ||
    report.apiStages.at(-1)?.status !== "ok"
  ) {
    fail(
      "safety.prior_execution_write_sequence_invalid",
      "The prior execution evidence must show one completed add, update, and final readback, with no later stage."
    );
  }
  if (
    report.transferRecord !== undefined && report.transferRecord !== null ||
    callbackStages.length > 0 ||
    report.writeOutcomeUnknown === true
  ) {
    fail(
      "safety.prior_transfer_record_evidence_present",
      "Prior successful, attempted, or outcome-unknown transfer-record evidence forbids recovery retry."
    );
  }
  if (report.plan?.template?.name !== plan.template?.name) {
    fail(
      "safety.prior_execution_template_mismatch",
      "The prior execution evidence belongs to a different source template."
    );
  }
  const priorDigests = report.plan?.trust?.digests;
  const currentDigests = plan.trust?.digests;
  if (
    !priorDigests ||
    !currentDigests ||
    priorDigests.sourceDraft !== currentDigests.sourceDraft ||
    priorDigests.dslDraft !== currentDigests.dslDraft
  ) {
    fail(
      "safety.prior_execution_trust_mismatch",
      "The prior execution evidence does not belong to this trusted migration DSL."
    );
  }
  return diagnostics;
}

function completeReadbackVerified(readback) {
  const partitions = readback?.partitions || {};
  return readback?.ok === true &&
    readback?.status === "verified" &&
    readback?.numberRule?.status === "verified" &&
    ["envelope", "form", "rules", "scripts", "workflow"]
      .every((partition) => partitions[partition] === "verified");
}

function failedBeforeCallback({
  plan,
  diagnostics,
  apiStages,
  baseUrl,
  targetTemplateId,
  stageName,
  status = "blocked"
}) {
  return {
    ok: false,
    status,
    stage: stageName,
    failedAt: stageName,
    baseUrl,
    templateId: targetTemplateId,
    createdFdIds: [],
    updatedFdIds: [],
    diagnostics,
    apiStages,
    plan
  };
}

function transferRecordSummary(payload, extra) {
  return {
    ...extra,
    fdId: payload.fdId,
    fdOriginalId: payload.fdOriginalId,
    fdTargetId: payload.fdTargetId,
    fdName: payload.fdName,
    fdCreateTime: payload.fdCreateTime
  };
}

function normalizeTargetBaseUrl(value) {
  try {
    return { baseUrl: normalizeBaseUrl(value), diagnostics: [] };
  } catch (error) {
    return {
      baseUrl: undefined,
      diagnostics: [{
        level: "error",
        code: "safety.base_url_invalid",
        message: error instanceof Error ? error.message : String(error),
        path: "/baseUrl"
      }]
    };
  }
}

function normalizeEvidenceBaseUrl(value) {
  try {
    return normalizeBaseUrl(value);
  } catch {
    return undefined;
  }
}

function requiredConfirmation(value, code, message, path, diagnostics) {
  if (value === true) return;
  diagnostics.push({ level: "error", code, message, path });
}

function requiredText(value, code, message, path, diagnostics) {
  if (text(value)) return;
  diagnostics.push({ level: "error", code, message, path });
}

function stage(name, details = {}) {
  return { name, ...details };
}

function currentStage(apiStages) {
  return apiStages.at(-1);
}

function recoveryError(stageName, message) {
  const error = new Error(message);
  error.stage = stageName;
  return error;
}

function blocked(plan, diagnostics, baseUrl) {
  return {
    ok: false,
    status: "blocked",
    ...(baseUrl ? { baseUrl } : {}),
    diagnostics,
    plan
  };
}

function redactCredentials(value, credentials = {}) {
  let result = String(value);
  for (const secret of [credentials.username, credentials.encryptedPassword]
    .filter(text)
    .sort((left, right) => right.length - left.length)) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
