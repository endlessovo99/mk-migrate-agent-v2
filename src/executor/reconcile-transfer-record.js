import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";

import { buildDryRunPlan } from "./dry-run.js";
import { CATALOG_VERSIONS } from "../dsl/catalogs.js";
import { checkTrust } from "../dsl/trust.js";
import { NewoaClient, normalizeBaseUrl } from "./newoa-client.js";
import { resolveConditionOrgs } from "./condition-org-resolver.js";
import { resolveWorkflowParticipants } from "./participant-resolver.js";
import { preparePersistedTemplate } from "./persistence.js";
import { stableStringify } from "./persistence/normalize.js";
import { withoutMechanismTokens } from "./published-form-patch.js";
import { attachRequiredTemplateNumberRuleReadback } from "./template-number-rule.js";
import { buildTransferRecordPayload, generateTransferRecordId } from "./transfer-record.js";
import { createLockedDraftState } from "./locked-draft-state.js";
import { validateLockedDraftSourceEvidence } from "./locked-draft-source-evidence.js";

const VERIFIED_PARTITIONS = Object.freeze([
  "envelope",
  "form",
  "rules",
  "scripts",
  "workflow"
]);

/**
 * Reconcile one known created draft whose original execution stopped before
 * the transfer-record callback. Preview is read-only. Confirmation performs
 * the same reads again and may write only one transfer record.
 */
export async function reconcileTransferRecord(input, options = {}) {
  const artifactDiagnostics = validateArtifactDigests(input, options);
  if (artifactDiagnostics.length) {
    return {
      ok: false,
      status: "invalid",
      diagnostics: artifactDiagnostics
    };
  }
  const trustedInput = reconciliationDsl(
    options.sourceDraft,
    options.priorSourceDraft,
    input,
    options.priorExecutionReport
  );
  if (!trustedInput.ok) {
    return {
      ok: false,
      status: "invalid",
      diagnostics: trustedInput.diagnostics,
      trust: trustedInput.trust
    };
  }
  const executableInput = trustedInput.dsl;
  const plan = buildDryRunPlan(executableInput);
  if (!plan.ok) return invalid(plan);
  const priorResolution = applyPriorResolutionEvidence(
    executableInput,
    options.priorExecutionReport
  );
  if (!priorResolution.ok) {
    return {
      ok: false,
      status: "invalid",
      diagnostics: priorResolution.diagnostics,
      plan
    };
  }

  const target = normalizedTarget(options.baseUrl);
  const safety = [
    ...validateSafety(options),
    ...target.diagnostics,
    ...validatePriorExecution(options.priorExecutionReport, {
      baseUrl: target.baseUrl,
      targetTemplateId: text(options.targetTemplateId),
      plan,
      input
    })
  ];
  if (safety.length) return blocked(plan, safety, target.baseUrl);

  const baseUrl = target.baseUrl;
  const targetTemplateId = options.targetTemplateId.trim();
  const targetCategoryId = options.targetCategoryId.trim();
  const credentials = options.credentials || {};
  const client = options.client || new NewoaClient({
    baseUrl,
    fetchImpl: options.fetchImpl
  });
  const apiStages = [];
  const diagnostics = [...plan.diagnostics];
  let transferRecordPayload;
  let writeStarted = false;
  let writeCompleted = false;
  let operationState;

  const resultBase = () => ({
    baseUrl,
    templateId: targetTemplateId,
    createdFdIds: [],
    updatedFdIds: [],
    validationPolicy: executableInput?.validationPolicy,
    catalogs: executableInput?.catalogs,
    apiStages,
    plan
  });
  try {
    apiStages.push(stage("login", "started"));
    await client.login(credentials);
    current(apiStages).status = "ok";

    apiStages.push(stage("transferRecordPreflight", "started"));
    requireValue(
      typeof client.assertTransferRecordAuthentication === "function" &&
        typeof client.addTransferRecord === "function",
      "reconcile.transfer_record_client_required"
    );
    await client.assertTransferRecordAuthentication();
    current(apiStages).status = "ok";

    apiStages.push(stage("resolveWorkflowParticipants", "started"));
    const participantResolution = await resolveWorkflowParticipants(priorResolution.dsl, {
      client,
      targetBaseUrl: baseUrl
    });
    current(apiStages).status = "ok";
    current(apiStages).resolvedCount = participantResolution.resolvedCount;

    apiStages.push(stage("resolveConditionOrgs", "started"));
    const conditionResolution = await resolveConditionOrgs(participantResolution.dsl, {
      client,
      targetBaseUrl: baseUrl
    });
    current(apiStages).status = "ok";
    current(apiStages).resolvedCount = conditionResolution.resolvedCount;

    const first = await readTarget(client, {
      apiStages,
      targetTemplateId,
      targetCategoryId,
      expectsWorkflow: Boolean(conditionResolution.dsl.workflow),
      label: "first"
    });
    const prepared = preparePersistedTemplate({
      dsl: conditionResolution.dsl,
      envelope: executionEnvelope(first.template, first.workflow, targetCategoryId),
      baseTemplate: first.template
    });
    if (!prepared.ok) {
      return failure({
        ...resultBase(),
        status: "blocked",
        stageName: "readbackProjection",
        diagnostics: [...diagnostics, ...prepared.diagnostics]
      });
    }

    const second = await readTarget(client, {
      apiStages,
      targetTemplateId,
      targetCategoryId,
      expectsWorkflow: Boolean(conditionResolution.dsl.workflow),
      label: "second"
    });
    const firstSnapshot = targetSnapshotDigest(first);
    const secondSnapshot = targetSnapshotDigest(second);
    requireValue(firstSnapshot === secondSnapshot, "reconcile.snapshot_changed");

    apiStages.push(stage("readback", "started"));
    const readback = attachRequiredTemplateNumberRuleReadback(
      prepared.verify(attachedReadback(second.template, second.workflow)),
      second.template
    );
    current(apiStages).status = "ok";
    diagnostics.push(...readback.diagnostics);

    const evidenceDigest = reconciliationEvidenceDigest({
      sourceDraft: options.sourceDraft,
      priorSourceDraft: options.priorSourceDraft,
      originalInput: input,
      executableInput,
      catalogBridge: trustedInput.catalogBridge,
      priorResolutionEvidence: priorResolution.audit,
      resolvedDsl: conditionResolution.dsl,
      priorExecutionReport: options.priorExecutionReport,
      baseUrl,
      targetTemplateId,
      targetCategoryId,
      targetSnapshotDigest: secondSnapshot,
      resolutionOptions: resolutionEvidence()
    });

    if (!completeVerification(readback)) {
      return {
        ...failure({
          ...resultBase(),
          status: "readback_failed",
          stageName: "readback",
          diagnostics
        }),
        evidenceDigest,
        readback
      };
    }

    if (options.confirmWrite !== true) {
      return {
        ok: true,
        status: "verified_unrecorded",
        stage: "readback",
        ...resultBase(),
        diagnostics,
        evidenceDigest,
        targetSnapshotDigest: secondSnapshot,
        readback
      };
    }

    requireValue(
      text(options.expectedEvidenceDigest) === evidenceDigest,
      "reconcile.evidence_digest_mismatch"
    );
    requireValue(text(options.artifactsDir), "reconcile.artifacts_dir_required");
    requireValue(!existsSync(options.artifactsDir), "reconcile.artifacts_dir_used");
    mkdirSync(options.artifactsDir, { recursive: true, mode: 0o700 });
    const recordIdFactory = options.transferRecordIdFactory || generateTransferRecordId;
    transferRecordPayload = buildTransferRecordPayload(executableInput, {
      fdId: recordIdFactory(),
      targetTemplateId,
      now: options.now || new Date()
    });
    operationState = createLockedDraftState({
      baseUrl,
      targetTemplateId,
      operation: "reconcile_transfer_record",
      evidenceDigest,
      artifactsDir: options.artifactsDir,
      testLockRoot: options.testLockRoot,
      allowTestLockRoot: Boolean(options.client)
    });

    apiStages.push(stage("addTransferRecord", "started", {
      recordId: transferRecordPayload.fdId,
      templateId: targetTemplateId
    }));
    writeStarted = true;
    operationState.record("transfer_record_started", {
      recordId: transferRecordPayload.fdId,
      templateWriteStarted: false,
      templateWriteCompleted: false,
      templateWriteOutcomeUnknown: false,
      transferRecordStarted: true,
      transferRecordCompleted: false,
      transferRecordOutcomeUnknown: true
    });
    try {
      await client.addTransferRecord(transferRecordPayload);
      writeCompleted = true;
      current(apiStages).status = "ok";
      operationState.record("recorded", {
        recordId: transferRecordPayload.fdId,
        templateWriteStarted: false,
        templateWriteCompleted: false,
        templateWriteOutcomeUnknown: false,
        transferRecordStarted: true,
        transferRecordCompleted: true,
        transferRecordOutcomeUnknown: false
      });
    } catch {
      current(apiStages).status = "failed";
      current(apiStages).writeOutcomeUnknown = true;
      operationState.record("transfer_record_outcome_unknown", {
        recordId: transferRecordPayload.fdId,
        templateWriteStarted: false,
        templateWriteCompleted: false,
        templateWriteOutcomeUnknown: false,
        transferRecordStarted: true,
        transferRecordCompleted: false,
        transferRecordOutcomeUnknown: true
      });
      return {
        ok: false,
        status: "transfer_record_failed",
        stage: "addTransferRecord",
        failedAt: "addTransferRecord",
        ...resultBase(),
        diagnostics: [
          ...diagnostics,
          {
            level: "error",
            code: "transfer_record.write_outcome_unknown",
            message: "The verified draft transfer-record outcome is unknown. Do not retry this callback.",
            path: "/transferRecord"
          }
        ],
        evidenceDigest,
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
      ...resultBase(),
      diagnostics,
      evidenceDigest,
      readback,
      transferRecord: transferRecordSummary(transferRecordPayload, {
        status: "recorded",
        recovery: true
      }),
      artifactsDir: options.artifactsDir
    };
  } catch (error) {
    if (current(apiStages)?.status === "started") current(apiStages).status = "failed";
    operationState?.record(writeStarted ? "failed" : "blocked", {
      recordId: transferRecordPayload?.fdId,
      templateWriteStarted: false,
      templateWriteCompleted: false,
      templateWriteOutcomeUnknown: false,
      transferRecordStarted: writeStarted,
      transferRecordCompleted: writeCompleted,
      transferRecordOutcomeUnknown: writeStarted && !writeCompleted
    });
    const stageName = current(apiStages)?.name || "reconcile";
    return failure({
      ...resultBase(),
      status: writeStarted ? "failed" : "blocked",
      stageName,
      diagnostics: [
        ...diagnostics,
        {
          level: "error",
          code: error?.code || "reconcile.failed",
          message: "Locked-draft reconciliation stopped; no automatic retry or rollback was attempted.",
          path: "/reconcile"
        }
      ],
      writeOutcomeUnknown: writeStarted && !writeCompleted
    });
  }
}

export function reconciliationEvidenceDigest(value) {
  return digest(withoutMechanismTokens(value));
}

function reconciliationDsl(sourceDraft, priorSourceDraft, input, priorExecutionReport) {
  const sourceDiagnostics = validateLockedDraftSourceEvidence(
    sourceDraft,
    priorSourceDraft,
    input
  );
  if (sourceDiagnostics.length) {
    return {
      ok: false,
      diagnostics: sourceDiagnostics
    };
  }
  const trust = checkTrust(sourceDraft, input);
  if (trust.ok) return { ok: true, dsl: input, trust };
  const errors = trust.diagnostics.filter((diagnostic) => diagnostic.level === "error");
  if (
    errors.length === 0 ||
    errors.some((diagnostic) => diagnostic.code !== "catalog.components.version_mismatch")
  ) {
    return { ok: false, diagnostics: trust.diagnostics, trust };
  }

  const fromVersion = input?.catalogs?.components?.version;
  const toVersion = CATALOG_VERSIONS.components;
  if (
    fromVersion !== "2026-08-28.v14" ||
    toVersion !== "2026-09-01.v15" ||
    priorExecutionReport?.plan?.catalogs?.components?.version !== fromVersion ||
    usesV15OnlyMonthPattern(input)
  ) {
    return { ok: false, diagnostics: trust.diagnostics, trust };
  }

  const adapted = structuredClone(input);
  adapted.catalogs.components.version = toVersion;
  const adaptedTrust = checkTrust(sourceDraft, adapted);
  if (!adaptedTrust.ok) {
    return {
      ok: false,
      diagnostics: adaptedTrust.diagnostics,
      trust: adaptedTrust
    };
  }
  return {
    ok: true,
    dsl: adapted,
    trust: adaptedTrust,
    catalogBridge: {
      kind: "readback_only_component_catalog_version",
      fromVersion,
      toVersion,
      originalDslDigest: digest(input),
      adaptedDslDigest: digest(adapted)
    }
  };
}

function usesV15OnlyMonthPattern(dsl) {
  return (dsl?.form?.fields || []).some((field) => {
    const candidates = field?.type === "detailTable"
      ? [field, ...(field.columns || [])]
      : [field];
    return candidates.some((candidate) => (
      candidate?.componentId === "xform-datetime" &&
      candidate?.props?.dataPattern === "yyyy-MM"
    ));
  });
}

function applyPriorResolutionEvidence(dsl, report) {
  const resolutionStage = (report?.apiStages || []).find((entry) => (
    entry?.name === "resolveWorkflowParticipants" && entry?.status === "ok"
  ));
  const overrides = Array.isArray(resolutionStage?.overrides)
    ? resolutionStage.overrides
    : [];
  if (!overrides.length) return { ok: true, dsl, audit: [] };
  const next = structuredClone(dsl);
  const audit = [];
  try {
    for (const entry of overrides) {
      const sourceId = text(entry?.sourceEvidence?.sourceId);
      const target = entry?.target;
      requireValue(
        sourceId && text(target?.fdId) && text(target?.fdName) &&
          Number.isInteger(Number(target?.fdOrgType)) &&
          Array.isArray(entry?.paths) && entry.paths.length > 0,
        "reconcile.prior_resolution_invalid"
      );
      for (const path of entry.paths) {
        requireValue(
          /^\/(template\/authorization|workflow\/nodes)\//.test(path),
          "reconcile.prior_resolution_path_invalid"
        );
        const member = valueAtPointer(next, path);
        requireValue(
          member && typeof member === "object" && member.sourceId === sourceId,
          "reconcile.prior_resolution_source_mismatch"
        );
        member.id = target.fdId.trim();
        member.name = target.fdName.trim();
        member.targetOrgType = Number(target.fdOrgType);
        for (const key of [
          "sourceId",
          "sourceOrgType",
          "sourceOrgClass",
          "sourceParentName",
          "sourceLoginName",
          "sourceRef"
        ]) delete member[key];
      }
      audit.push({
        sourceId,
        target: {
          fdId: target.fdId.trim(),
          fdName: target.fdName.trim(),
          fdOrgType: Number(target.fdOrgType)
        },
        paths: [...entry.paths]
      });
    }
    return { ok: true, dsl: next, audit };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        level: "error",
        code: error?.code || "reconcile.prior_resolution_invalid",
        message: "Prior participant-resolution evidence does not bind to this DSL.",
        path: "/priorExecutionReport/apiStages/resolveWorkflowParticipants"
      }]
    };
  }
}

function valueAtPointer(root, pointer) {
  return pointer.split("/").slice(1).reduce((value, token) => (
    value?.[token.replaceAll("~1", "/").replaceAll("~0", "~")]
  ), root);
}

function validateSafety(options) {
  const diagnostics = [];
  if (!options.sourceDraft || typeof options.sourceDraft !== "object" || Array.isArray(options.sourceDraft)) {
    diagnostics.push({
      level: "error",
      code: "reconcile.source_draft_required",
      message: "Locked-draft reconciliation requires the bound Source Draft.",
      path: "/sourceDraft"
    });
  }
  requiredText(options.targetTemplateId, "reconcile.target_template_required", "/targetTemplateId", diagnostics);
  requiredText(options.targetCategoryId, "reconcile.target_category_required", "/targetCategoryId", diagnostics);
  requiredText(options.credentials?.username, "reconcile.username_required", "/credentials/username", diagnostics);
  requiredText(options.credentials?.encryptedPassword, "reconcile.password_required", "/credentials/encryptedPassword", diagnostics);
  requiredDigest(options.expectedDslDigest, "reconcile.dsl_digest_required", "/expectedDslDigest", diagnostics);
  requiredDigest(
    options.expectedPriorReportDigest,
    "reconcile.prior_report_digest_required",
    "/expectedPriorReportDigest",
    diagnostics
  );
  if (
    [
      options.participantOverrides,
      options.templateAuthorizationOverrides,
      options.directParticipantOverrides,
      options.directPersonFallbackIds
    ].some((value) => Array.isArray(value) && value.length > 0) ||
    options.allowTemplateAuthorizationFallback === true ||
    options.allowMissingDirectPersonFallback === true ||
    options.allowMissingDirectPostFallback === true
  ) {
    diagnostics.push({
      level: "error",
      code: "reconcile.new_resolution_options_forbidden",
      message: "Reconciliation may use only retained successful resolution evidence and current exact lookup.",
      path: "/resolutionOptions"
    });
  }
  if (options.confirmWrite === true) {
    requiredText(options.expectedEvidenceDigest, "reconcile.evidence_digest_required", "/expectedEvidenceDigest", diagnostics);
    requiredText(options.artifactsDir, "reconcile.artifacts_dir_required", "/artifactsDir", diagnostics);
  }
  return diagnostics;
}

function validateArtifactDigests(input, options) {
  const diagnostics = [];
  if (
    !/^[a-f0-9]{64}$/.test(options.expectedDslDigest || "") ||
    digest(input) !== options.expectedDslDigest
  ) {
    diagnostics.push({
      level: "error",
      code: "reconcile.dsl_digest_mismatch",
      message: "The complete migration DSL does not match the approved artifact digest.",
      path: "/expectedDslDigest"
    });
  }
  if (
    !/^[a-f0-9]{64}$/.test(options.expectedPriorReportDigest || "") ||
    digest(options.priorExecutionReport) !== options.expectedPriorReportDigest
  ) {
    diagnostics.push({
      level: "error",
      code: "reconcile.prior_report_digest_mismatch",
      message: "The prior execution report does not match the approved artifact digest.",
      path: "/expectedPriorReportDigest"
    });
  }
  if (options.priorSourceDraft && (
    !/^[a-f0-9]{64}$/.test(options.expectedPriorSourceDraftDigest || "") ||
    digest(options.priorSourceDraft) !== options.expectedPriorSourceDraftDigest
  )) {
    diagnostics.push({
      level: "error",
      code: "reconcile.prior_source_digest_mismatch",
      message: "Historical Source Draft digest mismatch.",
      path: "/expectedPriorSourceDraftDigest"
    });
  }
  return diagnostics;
}

function validatePriorExecution(report, { baseUrl, targetTemplateId, plan, input }) {
  const diagnostics = [];
  const fail = (code) => diagnostics.push({
    level: "error",
    code,
    message: "Prior execution evidence is not eligible for transfer-record reconciliation.",
    path: "/priorExecutionReport"
  });
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    fail("reconcile.prior_report_required");
    return diagnostics;
  }
  if (report.status !== "readback_failed" || report.failedAt !== "readback" || report.readback?.ok !== false) {
    fail("reconcile.prior_readback_failure_required");
  }
  if (
    report.templateId !== targetTemplateId ||
    !Array.isArray(report.createdFdIds) ||
    report.createdFdIds.length !== 1 ||
    report.createdFdIds[0] !== targetTemplateId ||
    (report.updatedFdIds?.length || 0) !== 0
  ) {
    fail("reconcile.prior_target_mismatch");
  }
  if (normalizedEvidenceUrl(report.baseUrl) !== baseUrl) fail("reconcile.prior_origin_mismatch");
  const stages = Array.isArray(report.apiStages) ? report.apiStages : [];
  const requiredStages = [
    "add",
    "update",
    ...(input?.workflow ? ["saveWorkflowDraft", "getWorkflowTemplateDetail"] : []),
    "readback"
  ];
  if (requiredStages.some((name) => (
    stages.filter((entry) => entry?.name === name && entry?.status === "ok").length !== 1
  )) || stages.at(-1)?.name !== "readback" || stages.at(-1)?.status !== "ok") {
    fail("reconcile.prior_write_sequence_invalid");
  }
  if (
    stages.some((entry) => entry?.name === "addTransferRecord") ||
    report.transferRecord != null ||
    report.writeOutcomeUnknown === true ||
    report.transferRecord?.outcomeUnknown === true
  ) {
    fail("reconcile.prior_callback_evidence_present");
  }
  if (report.plan?.template?.name !== plan.template?.name) fail("reconcile.prior_template_mismatch");
  if (
    stableStringify(report.plan?.trust?.digests || {}) !==
      stableStringify(input?.trust?.digests || {}) ||
    stableStringify(report.plan?.catalogs || {}) !==
      stableStringify(input?.catalogs || {}) ||
    stableStringify(report.plan?.validationPolicy || {}) !==
      stableStringify(input?.validationPolicy || {})
  ) {
    fail("reconcile.prior_dsl_evidence_mismatch");
  }
  return diagnostics;
}

async function readTarget(client, {
  apiStages,
  targetTemplateId,
  targetCategoryId,
  expectsWorkflow,
  label
}) {
  apiStages.push(stage(`${label}TargetRead`, "started", { templateId: targetTemplateId }));
  const template = await client.getTemplate(targetTemplateId);
  validateDraft(template, { targetTemplateId, targetCategoryId, expectsWorkflow });
  let workflow;
  if (expectsWorkflow) {
    const workflowId = template.mechanisms.lbpmTemplate[0].fdId;
    workflow = await client.getWorkflowTemplateDetail({
      templateId: workflowId,
      definitionId: ""
    });
    validateWorkflow(workflow, {
      workflowId,
      targetTemplateId,
      targetCategoryId
    });
  }
  current(apiStages).status = "ok";
  return { template, workflow };
}

function validateDraft(template, { targetTemplateId, targetCategoryId, expectsWorkflow }) {
  requireValue(
    template?.fdId === targetTemplateId &&
      template.fdName?.startsWith("MK_TEST_") &&
      template.fdCategory?.fdId === targetCategoryId &&
      Number(template.fdStatus) === 0 &&
      template.mechanisms?.["sys-xform"]?.fdStatus === "draft",
    "reconcile.target_draft_mismatch"
  );
  if (expectsWorkflow) {
    const workflow = template.mechanisms?.lbpmTemplate?.[0];
    requireValue(
      text(workflow?.fdId) && workflow.fdStatus === "draft" && workflow.isDraft === true,
      "reconcile.workflow_draft_required"
    );
  }
}

function validateWorkflow(workflow, { workflowId, targetTemplateId, targetCategoryId }) {
  const hasExplicitStatus = workflow?.fdStatus !== undefined &&
    workflow.fdStatus !== null && workflow.fdStatus !== "";
  const draftStatus = hasExplicitStatus
    ? workflow.fdStatus === "draft"
    : String(workflow?.latestDefinitionStatus) === "0";
  requireValue(
    workflow?.fdId === workflowId &&
      workflow.isDraft === true &&
      draftStatus &&
      workflow.fdContentType === "json" &&
      workflow.fdSystemCode === "INNER_SYSTEM" &&
      String(workflow.fdRunType) === "1" &&
      workflow.fdDisableBpmInit === false &&
      workflow.fdFormCategory?.fdFormCategoryId === targetCategoryId &&
      text(workflow.fdContent),
    "reconcile.workflow_binding_mismatch"
  );
}

function executionEnvelope(template, workflow, categoryId) {
  const workflowId = workflow?.fdId || template.mechanisms?.lbpmTemplate?.[0]?.fdId || "";
  return {
    templateId: template.fdId,
    templateName: template.fdName,
    categoryId,
    tableName: template.fdTableName || template.mechanisms?.["sys-xform"]?.fdTableName || "",
    lifecycle: {
      draft: true,
      unpublished: true,
      fdStatus: template.fdStatus ?? 0,
      xformStatus: "draft",
      lbpmStatus: "draft",
      lbpmIsDraft: true
    },
    bindings: {
      formFdId: template.fdId,
      workflowFdId: workflowId
    }
  };
}

function attachedReadback(template, workflow) {
  if (!workflow) return template;
  const next = structuredClone(template);
  next.mechanisms = next.mechanisms || {};
  next.mechanisms.lbpmTemplate = [structuredClone(workflow)];
  return next;
}

function targetSnapshotDigest(readback) {
  return digest(withoutMechanismTokens(readback));
}

function resolutionEvidence() {
  return { mode: "prior_execution_evidence_only" };
}

function completeVerification(readback) {
  return readback?.ok === true &&
    readback.status === "verified" &&
    readback.numberRule?.status === "verified" &&
    VERIFIED_PARTITIONS.every((name) => readback.partitions?.[name] === "verified");
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

function normalizedTarget(value) {
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

function normalizedEvidenceUrl(value) {
  try {
    return normalizeBaseUrl(value);
  } catch {
    return undefined;
  }
}

function invalid(plan) {
  return { ok: false, status: "invalid", diagnostics: plan.diagnostics, plan };
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

function failure({ status, stageName, diagnostics, ...values }) {
  return {
    ok: false,
    status,
    stage: stageName,
    failedAt: stageName,
    diagnostics,
    ...values
  };
}

function stage(name, status, details = {}) {
  return { name, status, ...details };
}

function current(stages) {
  return stages.at(-1);
}

function requireValue(condition, code) {
  if (condition) return;
  throw Object.assign(new Error(code), { code });
}

function requiredText(value, code, path, diagnostics) {
  if (text(value)) return;
  diagnostics.push({
    level: "error",
    code,
    message: "Locked-draft reconciliation is missing required input.",
    path
  });
}

function requiredDigest(value, code, path, diagnostics) {
  if (/^[a-f0-9]{64}$/.test(value || "")) return;
  diagnostics.push({
    level: "error",
    code,
    message: "Locked-draft reconciliation requires an approved SHA-256 digest.",
    path
  });
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function digest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
