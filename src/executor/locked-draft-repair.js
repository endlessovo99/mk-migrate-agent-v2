import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CATALOG_VERSIONS } from "../dsl/catalogs.js";
import { checkTrust } from "../dsl/trust.js";
import { buildDryRunPlan } from "./dry-run.js";
import { NewoaClient, normalizeBaseUrl } from "./newoa-client.js";
import { preparePersistedTemplate } from "./persistence.js";
import { stableStringify } from "./persistence/normalize.js";
import { withoutMechanismTokens } from "./published-form-patch.js";
import { resolveConditionOrgs } from "./condition-org-resolver.js";
import { resolveWorkflowParticipants } from "./participant-resolver.js";
import { attachRequiredTemplateNumberRuleReadback } from "./template-number-rule.js";
import { buildTransferRecordPayload, generateTransferRecordId } from "./transfer-record.js";
import { createLockedDraftState } from "./locked-draft-state.js";
import { prepareLockedDraftRepair } from "./locked-draft-repair-plan.js";
import { validateLockedDraftSourceEvidence } from "./locked-draft-source-evidence.js";

const PARTITIONS = Object.freeze(["envelope", "form", "rules", "scripts", "workflow"]);

/** Repair one already-created draft through a strictly allowlisted native delta. */
export async function repairLockedDraft(input, options = {}) {
  const artifactDiagnostics = validateArtifactDigests(input, options);
  if (artifactDiagnostics.length) return invalid(artifactDiagnostics);
  const priorInput = options.priorDsl || input;
  const evolution = options.repairKind === "calculation"
    ? validateCalculationDslEvolution(priorInput, input, options.priorExecutionReport)
    : { ok: true };
  if (!evolution.ok) return invalid(evolution.diagnostics);
  const trusted = repairDsl(
    options.sourceDraft,
    options.priorSourceDraft,
    input,
    options.priorExecutionReport
  );
  if (!trusted.ok) return invalid(trusted.diagnostics);
  const plan = buildDryRunPlan(trusted.dsl);
  if (!plan.ok) return { ...invalid(plan.diagnostics), plan };
  const priorResolution = applyPriorResolutionEvidence(trusted.dsl, options.priorExecutionReport);
  if (!priorResolution.ok) return invalid(priorResolution.diagnostics);
  const target = normalizedTarget(options.baseUrl);
  const safety = [
    ...validateSafety(options),
    ...target.diagnostics,
    ...validatePriorExecution(options.priorExecutionReport, {
      input: priorInput,
      plan,
      baseUrl: target.baseUrl,
      targetTemplateId: text(options.targetTemplateId),
      repairKind: options.repairKind
    })
  ];
  if (safety.length) return blocked(safety, plan, target.baseUrl);

  const baseUrl = target.baseUrl;
  const targetTemplateId = options.targetTemplateId.trim();
  const targetCategoryId = options.targetCategoryId.trim();
  const client = options.client || new NewoaClient({ baseUrl, fetchImpl: options.fetchImpl });
  const credentials = options.credentials || {};
  const apiStages = [];
  const diagnostics = [...plan.diagnostics];
  let writeStarted = false;
  let writeCompleted = false;
  let operationState;
  let transferRecordStarted = false;
  let transferRecordCompleted = false;
  let transferRecordPayload;

  const baseResult = () => ({
    baseUrl,
    templateId: targetTemplateId,
    createdFdIds: [],
    updatedFdIds: writeCompleted ? [targetTemplateId] : [],
    validationPolicy: trusted.dsl.validationPolicy,
    catalogs: trusted.dsl.catalogs,
    apiStages,
    plan
  });
  try {
    apiStages.push(stage("login"));
    await client.login(credentials);
    okStage(apiStages);
    apiStages.push(stage("transferRecordPreflight"));
    requireValue(
      typeof client.assertTransferRecordAuthentication === "function" &&
        typeof client.addTransferRecord === "function",
      "locked_draft.transfer_record_client_required"
    );
    await client.assertTransferRecordAuthentication();
    okStage(apiStages);

    apiStages.push(stage("resolveWorkflowParticipants"));
    const participantResolution = await resolveWorkflowParticipants(priorResolution.dsl, {
      client,
      targetBaseUrl: baseUrl,
      fallbackFdIds: options.fallbackFdIds
    });
    okStage(apiStages);
    apiStages.at(-1).resolvedCount = participantResolution.resolvedCount;
    apiStages.push(stage("resolveConditionOrgs"));
    const conditionResolution = await resolveConditionOrgs(participantResolution.dsl, {
      client,
      targetBaseUrl: baseUrl,
      fallbackFdIds: options.fallbackFdIds
    });
    okStage(apiStages);

    const before = await readBundle(client, {
      apiStages,
      targetTemplateId,
      targetCategoryId,
      expectsWorkflow: Boolean(conditionResolution.dsl.workflow),
      label: "first"
    });
    const preparedRepair = await prepareLockedDraftRepair({
      client,
      before,
      dsl: conditionResolution.dsl,
      sourceDsl: trusted.dsl,
      priorExecutionReport: options.priorExecutionReport,
      repairKind: options.repairKind,
      envelope: executionEnvelope(before.template, before.workflow, targetCategoryId)
    });
    const second = await readBundle(client, {
      apiStages,
      targetTemplateId,
      targetCategoryId,
      expectsWorkflow: Boolean(conditionResolution.dsl.workflow),
      label: "second"
    });
    requireValue(bundleDigest(before) === bundleDigest(second), "locked_draft.snapshot_changed");
    requireValue(
      bundleDigest(preparedRepair.before) === bundleDigest(before),
      "locked_draft.repair_snapshot_mismatch"
    );

    const evidenceDigest = lockedDraftEvidenceDigest({
      sourceDraft: options.sourceDraft,
      priorSourceDraft: options.priorSourceDraft,
      originalInput: input,
      priorInput,
      calculationDslEvolution: evolution.audit,
      executableInput: trusted.dsl,
      catalogBridge: trusted.catalogBridge,
      resolvedDsl: conditionResolution.dsl,
      priorResolutionEvidence: priorResolution.audit,
      priorExecutionReport: options.priorExecutionReport,
      baseUrl,
      targetTemplateId,
      targetCategoryId,
      repairKind: options.repairKind,
      snapshotDigest: bundleDigest(second),
      repairPlan: preparedRepair.plan
    });

    if (options.confirmWrite !== true) {
      return {
        ok: true,
        status: "repair_ready",
        stage: "preview",
        ...baseResult(),
        diagnostics,
        evidenceDigest,
        snapshotDigest: bundleDigest(second),
        plan: preparedRepair.plan
      };
    }

    requireValue(text(options.expectedEvidenceDigest) === evidenceDigest, "locked_draft.evidence_digest_mismatch");
    requireValue(!existsSync(options.artifactsDir), "locked_draft.artifacts_dir_used");
    mkdirSync(options.artifactsDir, { recursive: true, mode: 0o700 });
    operationState = createLockedDraftState({
      baseUrl,
      targetTemplateId,
      operation: `repair_${options.repairKind}`,
      evidenceDigest,
      artifactsDir: options.artifactsDir,
      testLockRoot: options.testLockRoot,
      allowTestLockRoot: Boolean(options.client)
    });
    writeArtifact(options.artifactsDir, "before.template.json", before.template);
    writeArtifact(options.artifactsDir, "before.workflow.json", before.workflow);
    writeArtifact(options.artifactsDir, "repair.plan.json", preparedRepair.plan);
    writeArtifact(options.artifactsDir, "update-template.payload.json", preparedRepair.template);
    if (preparedRepair.workflow) {
      writeArtifact(options.artifactsDir, "save-workflow.payload.json", preparedRepair.workflow);
    }

    writeStarted = true;
    operationState.record("template_write_started", {
      repairKind: options.repairKind,
      writeStage: "updateTemplate",
      templateWriteStarted: true,
      templateWriteCompleted: false,
      templateWriteOutcomeUnknown: true,
      transferRecordStarted: false,
      transferRecordCompleted: false,
      transferRecordOutcomeUnknown: false
    });
    apiStages.push(stage("updateTemplate"));
    await client.updateTemplate(preparedRepair.template);
    okStage(apiStages);
    if (preparedRepair.workflow) {
      operationState.record("template_write_started", {
        repairKind: options.repairKind,
        writeStage: "saveWorkflowDraft",
        templateWriteStarted: true,
        templateWriteCompleted: false,
        templateWriteOutcomeUnknown: true,
        transferRecordStarted: false,
        transferRecordCompleted: false,
        transferRecordOutcomeUnknown: false
      });
      apiStages.push(stage("saveWorkflowDraft"));
      await client.saveWorkflowDraft(preparedRepair.workflow);
      okStage(apiStages);
    }
    writeCompleted = true;
    operationState.record("awaiting_readback", {
      repairKind: options.repairKind,
      templateWriteStarted: true,
      templateWriteCompleted: true,
      templateWriteOutcomeUnknown: false,
      transferRecordStarted: false,
      transferRecordCompleted: false,
      transferRecordOutcomeUnknown: false
    });

    const after = await readBundle(client, {
      apiStages,
      targetTemplateId,
      targetCategoryId,
      expectsWorkflow: Boolean(conditionResolution.dsl.workflow),
      label: "after"
    });
    writeArtifact(options.artifactsDir, "after.template.json", after.template);
    writeArtifact(options.artifactsDir, "after.workflow.json", after.workflow);
    const nativeVerification = preparedRepair.verify(after);
    const persisted = preparePersistedTemplate({
      dsl: conditionResolution.dsl,
      envelope: executionEnvelope(after.template, after.workflow, targetCategoryId),
      baseTemplate: after.template
    });
    requireValue(persisted.ok, "locked_draft.readback_projection_failed");
    const readback = attachRequiredTemplateNumberRuleReadback(
      persisted.verify(attachedReadback(after)),
      after.template
    );
    diagnostics.push(...readback.diagnostics);
    if (!nativeVerification.ok || !completeReadback(readback)) {
      const result = {
        ok: false,
        status: "readback_failed",
        stage: "readback",
        failedAt: "readback",
        ...baseResult(),
        diagnostics,
        evidenceDigest,
        nativeVerification,
        readback,
        artifactsDir: options.artifactsDir
      };
      writeArtifact(options.artifactsDir, "result.json", result);
      operationState.record("readback_failed", {
        repairKind: options.repairKind,
        templateWriteStarted: true,
        templateWriteCompleted: true,
        templateWriteOutcomeUnknown: false,
        transferRecordStarted: false,
        transferRecordCompleted: false,
        transferRecordOutcomeUnknown: false
      });
      return result;
    }

    const recordIdFactory = options.transferRecordIdFactory || generateTransferRecordId;
    transferRecordPayload = buildTransferRecordPayload(trusted.dsl, {
      fdId: recordIdFactory(),
      targetTemplateId,
      now: options.now || new Date()
    });
    apiStages.push(stage("addTransferRecord"));
    transferRecordStarted = true;
    operationState.record("transfer_record_started", {
      repairKind: options.repairKind,
      recordId: transferRecordPayload.fdId,
      templateWriteStarted: true,
      templateWriteCompleted: true,
      templateWriteOutcomeUnknown: false,
      transferRecordStarted: true,
      transferRecordCompleted: false,
      transferRecordOutcomeUnknown: true
    });
    try {
      await client.addTransferRecord(transferRecordPayload);
      transferRecordCompleted = true;
      okStage(apiStages);
    } catch {
      apiStages.at(-1).status = "failed";
      apiStages.at(-1).writeOutcomeUnknown = true;
      const result = {
        ok: false,
        status: "transfer_record_failed",
        stage: "addTransferRecord",
        failedAt: "addTransferRecord",
        ...baseResult(),
        writeOutcomeUnknown: true,
        diagnostics: [
          ...diagnostics,
          {
            level: "error",
            code: "transfer_record.write_outcome_unknown",
            message: "The repaired draft transfer-record outcome is unknown. Do not retry.",
            path: "/transferRecord"
          }
        ],
        readback,
        transferRecord: transferRecordSummary(transferRecordPayload, {
          status: "outcome_unknown",
          writeOutcomeUnknown: true
        })
      };
      writeArtifact(options.artifactsDir, "result.json", result);
      operationState.record("transfer_record_outcome_unknown", {
        repairKind: options.repairKind,
        recordId: transferRecordPayload.fdId,
        templateWriteStarted: true,
        templateWriteCompleted: true,
        templateWriteOutcomeUnknown: false,
        transferRecordStarted: true,
        transferRecordCompleted: false,
        transferRecordOutcomeUnknown: true
      });
      return result;
    }

    const result = {
      ok: true,
      status: "repaired_and_recorded",
      stage: "complete",
      ...baseResult(),
      diagnostics,
      evidenceDigest,
      nativeVerification,
      readback,
      transferRecord: transferRecordSummary(transferRecordPayload, { status: "recorded" }),
      artifactsDir: options.artifactsDir
    };
    writeArtifact(options.artifactsDir, "result.json", result);
    operationState.record("verified", {
      repairKind: options.repairKind,
      recordId: transferRecordPayload.fdId,
      templateWriteStarted: true,
      templateWriteCompleted: true,
      templateWriteOutcomeUnknown: false,
      transferRecordStarted: true,
      transferRecordCompleted: true,
      transferRecordOutcomeUnknown: false
    });
    return result;
  } catch (error) {
    if (apiStages.at(-1)?.status === "started") apiStages.at(-1).status = "failed";
    operationState?.record(writeStarted ? "failed" : "blocked", {
      repairKind: options.repairKind,
      errorCode: error?.code,
      templateWriteStarted: writeStarted,
      templateWriteCompleted: writeCompleted,
      templateWriteOutcomeUnknown: writeStarted && !writeCompleted,
      transferRecordStarted,
      transferRecordCompleted,
      transferRecordOutcomeUnknown: transferRecordStarted && !transferRecordCompleted
    });
    return {
      ok: false,
      status: writeStarted ? "failed" : "blocked",
      stage: apiStages.at(-1)?.name || "lockedDraftRepair",
      failedAt: apiStages.at(-1)?.name || "lockedDraftRepair",
      ...baseResult(),
      writeOutcomeUnknown: (writeStarted && !writeCompleted) ||
        (transferRecordStarted && !transferRecordCompleted),
      diagnostics: [
        ...diagnostics,
        {
          level: "error",
          code: error?.code || "locked_draft.repair_failed",
          message: "Locked-draft repair stopped; no automatic retry or rollback was attempted.",
          path: "/lockedDraftRepair"
        }
      ]
    };
  }
}

export function lockedDraftEvidenceDigest(value) {
  return digest(withoutMechanismTokens(value));
}

async function readBundle(client, {
  apiStages,
  targetTemplateId,
  targetCategoryId,
  expectsWorkflow,
  label
}) {
  apiStages.push(stage(`${label}TargetRead`));
  const template = await client.getTemplate(targetTemplateId);
  validateDraft(template, { targetTemplateId, targetCategoryId, expectsWorkflow });
  let workflow;
  if (expectsWorkflow) {
    const workflowId = template.mechanisms.lbpmTemplate[0].fdId;
    workflow = await client.getWorkflowTemplateDetail({ templateId: workflowId, definitionId: "" });
    validateWorkflow(workflow, { workflowId, targetCategoryId });
  }
  okStage(apiStages);
  return { template, workflow };
}

function validateDraft(template, { targetTemplateId, targetCategoryId, expectsWorkflow }) {
  requireValue(
    template?.fdId === targetTemplateId && template.fdName?.startsWith("MK_TEST_") &&
      template.fdCategory?.fdId === targetCategoryId && Number(template.fdStatus) === 0 &&
      template.mechanisms?.["sys-xform"]?.fdStatus === "draft",
    "locked_draft.target_mismatch"
  );
  if (expectsWorkflow) {
    const workflow = template.mechanisms?.lbpmTemplate?.[0];
    requireValue(text(workflow?.fdId) && workflow.fdStatus === "draft" && workflow.isDraft === true,
      "locked_draft.workflow_draft_required");
  }
}

function validateWorkflow(workflow, { workflowId, targetCategoryId }) {
  const status = workflow?.fdStatus !== undefined && workflow.fdStatus !== null && workflow.fdStatus !== ""
    ? workflow.fdStatus === "draft"
    : String(workflow?.latestDefinitionStatus) === "0";
  requireValue(
    workflow?.fdId === workflowId && workflow.isDraft === true && status &&
      workflow.fdContentType === "json" && workflow.fdSystemCode === "INNER_SYSTEM" &&
      String(workflow.fdRunType) === "1" && workflow.fdDisableBpmInit === false &&
      workflow.fdFormCategory?.fdFormCategoryId === targetCategoryId && text(workflow.fdContent),
    "locked_draft.workflow_binding_mismatch"
  );
}

function executionEnvelope(template, workflow, categoryId) {
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
      workflowFdId: workflow?.fdId || template.mechanisms?.lbpmTemplate?.[0]?.fdId || ""
    }
  };
}

function attachedReadback(bundle) {
  if (!bundle.workflow) return bundle.template;
  const template = structuredClone(bundle.template);
  template.mechanisms.lbpmTemplate = [structuredClone(bundle.workflow)];
  return template;
}

function completeReadback(readback) {
  return readback?.ok === true && readback.status === "verified" &&
    readback.numberRule?.status === "verified" &&
    PARTITIONS.filter((partition) => partition !== "workflow")
      .every((partition) => readback.partitions?.[partition] === "verified") &&
    ["verified", "not_expected"].includes(readback.partitions?.workflow);
}

function bundleDigest(bundle) {
  return digest(withoutMechanismTokens(bundle));
}

function repairDsl(sourceDraft, priorSourceDraft, input, priorExecutionReport) {
  const sourceDiagnostics = validateLockedDraftSourceEvidence(
    sourceDraft,
    priorSourceDraft,
    input
  );
  if (sourceDiagnostics.length) {
    return { ok: false, diagnostics: sourceDiagnostics };
  }
  const trust = checkTrust(sourceDraft, input);
  if (trust.ok) return { ok: true, dsl: input };
  const errors = trust.diagnostics.filter((diagnostic) => diagnostic.level === "error");
  if (errors.some((diagnostic) => diagnostic.code !== "catalog.components.version_mismatch")) {
    return { ok: false, diagnostics: trust.diagnostics };
  }
  const fromVersion = input?.catalogs?.components?.version;
  if (
    fromVersion !== "2026-08-28.v14" || CATALOG_VERSIONS.components !== "2026-09-01.v15" ||
    priorExecutionReport?.plan?.catalogs?.components?.version !== fromVersion
  ) return { ok: false, diagnostics: trust.diagnostics };
  const adapted = structuredClone(input);
  adapted.catalogs.components.version = CATALOG_VERSIONS.components;
  const adaptedTrust = checkTrust(sourceDraft, adapted);
  if (!adaptedTrust.ok) return { ok: false, diagnostics: adaptedTrust.diagnostics };
  return {
    ok: true,
    dsl: adapted,
    catalogBridge: {
      fromVersion,
      toVersion: CATALOG_VERSIONS.components,
      originalDslDigest: digest(input),
      adaptedDslDigest: digest(adapted)
    }
  };
}

function applyPriorResolutionEvidence(dsl, report) {
  const stageEvidence = (report?.apiStages || []).find((entry) => (
    entry?.name === "resolveWorkflowParticipants" && entry?.status === "ok"
  ));
  const overrides = Array.isArray(stageEvidence?.overrides) ? stageEvidence.overrides : [];
  const next = structuredClone(dsl);
  const audit = [];
  try {
    for (const entry of overrides) {
      const sourceId = text(entry?.sourceEvidence?.sourceId);
      const target = entry?.target;
      requireValue(sourceId && text(target?.fdId) && text(target?.fdName) &&
        Number.isInteger(Number(target.fdOrgType)) && Array.isArray(entry.paths),
      "locked_draft.prior_resolution_invalid");
      for (const path of entry.paths) {
        const member = valueAtPointer(next, path);
        requireValue(member?.sourceId === sourceId, "locked_draft.prior_resolution_mismatch");
        Object.assign(member, {
          id: target.fdId.trim(),
          name: target.fdName.trim(),
          targetOrgType: Number(target.fdOrgType)
        });
        for (const key of ["sourceId", "sourceOrgType", "sourceOrgClass", "sourceParentName", "sourceLoginName", "sourceRef"]) {
          delete member[key];
        }
      }
      audit.push({ sourceId, target, paths: [...entry.paths] });
    }
    return { ok: true, dsl: next, audit };
  } catch (error) {
    return { ok: false, diagnostics: [{
      level: "error",
      code: error?.code || "locked_draft.prior_resolution_invalid",
      message: "Prior resolution evidence does not bind to this DSL.",
      path: "/priorExecutionReport"
    }] };
  }
}

function validateSafety(options) {
  const diagnostics = [];
  for (const [value, code, path] of [
    [options.targetTemplateId, "locked_draft.target_required", "/targetTemplateId"],
    [options.targetCategoryId, "locked_draft.category_required", "/targetCategoryId"],
    [options.expectedDslDigest, "locked_draft.dsl_digest_required", "/expectedDslDigest"],
    [options.expectedPriorReportDigest, "locked_draft.report_digest_required", "/expectedPriorReportDigest"],
    [options.credentials?.username, "locked_draft.username_required", "/credentials/username"],
    [options.credentials?.encryptedPassword, "locked_draft.password_required", "/credentials/encryptedPassword"]
  ]) requiredText(value, code, path, diagnostics);
  if (!["template_authorization", "calculation"].includes(options.repairKind)) {
    diagnostics.push({ level: "error", code: "locked_draft.kind_required", message: "Repair kind is unsupported.", path: "/repairKind" });
  }
  if (options.repairKind === "calculation") {
    if (!options.priorDsl || typeof options.priorDsl !== "object" || Array.isArray(options.priorDsl)) {
      diagnostics.push({ level: "error", code: "locked_draft.prior_dsl_required", message: "Calculation repair requires the historical migration DSL.", path: "/priorDsl" });
    }
    requiredText(
      options.expectedPriorDslDigest,
      "locked_draft.prior_dsl_digest_required",
      "/expectedPriorDslDigest",
      diagnostics
    );
  }
  if (options.confirmWrite === true) {
    requiredText(options.expectedEvidenceDigest, "locked_draft.evidence_required", "/expectedEvidenceDigest", diagnostics);
    requiredText(options.artifactsDir, "locked_draft.artifacts_required", "/artifactsDir", diagnostics);
  }
  return diagnostics;
}

function validateArtifactDigests(input, options) {
  const diagnostics = [];
  if (!/^[a-f0-9]{64}$/.test(options.expectedDslDigest || "") || digest(input) !== options.expectedDslDigest) {
    diagnostics.push({ level: "error", code: "locked_draft.dsl_digest_mismatch", message: "DSL digest mismatch.", path: "/expectedDslDigest" });
  }
  if (!/^[a-f0-9]{64}$/.test(options.expectedPriorReportDigest || "") ||
    digest(options.priorExecutionReport) !== options.expectedPriorReportDigest) {
    diagnostics.push({ level: "error", code: "locked_draft.report_digest_mismatch", message: "Prior report digest mismatch.", path: "/expectedPriorReportDigest" });
  }
  if (options.repairKind === "calculation" && (
    !/^[a-f0-9]{64}$/.test(options.expectedPriorDslDigest || "") ||
    digest(options.priorDsl) !== options.expectedPriorDslDigest
  )) {
    diagnostics.push({ level: "error", code: "locked_draft.prior_dsl_digest_mismatch", message: "Historical DSL digest mismatch.", path: "/expectedPriorDslDigest" });
  }
  if (options.priorSourceDraft && (
    !/^[a-f0-9]{64}$/.test(options.expectedPriorSourceDraftDigest || "") ||
    digest(options.priorSourceDraft) !== options.expectedPriorSourceDraftDigest
  )) {
    diagnostics.push({ level: "error", code: "locked_draft.prior_source_digest_mismatch", message: "Historical Source Draft digest mismatch.", path: "/expectedPriorSourceDraftDigest" });
  }
  return diagnostics;
}

function validateCalculationDslEvolution(priorDsl, currentDsl, report) {
  const propMismatch = (report?.diagnostics || []).find((diagnostic) => (
    diagnostic?.code === "readback.form.prop_calculation_mismatch"
  ));
  const aggregateFieldId = text(propMismatch?.details?.fieldId);
  const currentAggregate = findDslField(currentDsl, aggregateFieldId)?.props?.calculation;
  const rowFieldId = currentAggregate?.fieldId;
  const currentRow = findDslField(currentDsl, rowFieldId)?.props?.calculation;
  if (
    currentAggregate?.kind !== "aggregate" || currentAggregate.operation !== "sum" ||
    currentRow?.kind !== "formula" ||
    priorDsl?.catalogs?.components?.version !== "2026-08-28.v14" ||
    currentDsl?.catalogs?.components?.version !== "2026-09-01.v15"
  ) {
    return {
      ok: false,
      diagnostics: [{ level: "error", code: "locked_draft.calculation_dsl_evolution_invalid", message: "Calculation repair DSL evolution is outside the approved scope.", path: "/dsl" }]
    };
  }
  const adapted = structuredClone(priorDsl);
  adapted.catalogs.components.version = currentDsl.catalogs.components.version;
  const adaptedAggregate = findDslField(adapted, aggregateFieldId);
  const adaptedRow = findDslField(adapted, rowFieldId);
  if (!adaptedAggregate || !adaptedRow) {
    return {
      ok: false,
      diagnostics: [{ level: "error", code: "locked_draft.calculation_dsl_evolution_invalid", message: "Calculation repair DSL fields are missing.", path: "/dsl/form" }]
    };
  }
  adaptedAggregate.props.calculation = structuredClone(currentAggregate);
  adaptedRow.props.calculation = structuredClone(currentRow);
  if (stableStringify(adapted) !== stableStringify(currentDsl)) {
    return {
      ok: false,
      diagnostics: [{ level: "error", code: "locked_draft.calculation_dsl_evolution_invalid", message: "Calculation repair DSL changed outside catalog and two calculation fields.", path: "/dsl" }]
    };
  }
  return {
    ok: true,
    audit: {
      priorDslDigest: digest(priorDsl),
      currentDslDigest: digest(currentDsl),
      changedPaths: [
        "/catalogs/components/version",
        `/form/fields/${aggregateFieldId}/props/calculation`,
        `/form/detailColumns/${rowFieldId}/props/calculation`
      ]
    }
  };
}

function validatePriorExecution(report, { input, plan, baseUrl, targetTemplateId, repairKind }) {
  const diagnostics = [];
  const fail = (code) => diagnostics.push({ level: "error", code, message: "Prior report is not eligible for this repair.", path: "/priorExecutionReport" });
  if (report?.status !== "readback_failed" || report.failedAt !== "readback" || report.readback?.ok !== false) fail("locked_draft.prior_readback_required");
  if (report?.templateId !== targetTemplateId || stableStringify(report.createdFdIds) !== stableStringify([targetTemplateId]) || (report.updatedFdIds?.length || 0)) fail("locked_draft.prior_target_mismatch");
  if (normalizedEvidenceUrl(report?.baseUrl) !== baseUrl) fail("locked_draft.prior_origin_mismatch");
  const stages = Array.isArray(report?.apiStages) ? report.apiStages : [];
  const requiredStages = [
    "add",
    "update",
    ...(input?.workflow ? ["saveWorkflowDraft", "getWorkflowTemplateDetail"] : []),
    "readback"
  ];
  if (requiredStages.some((name) => (
    stages.filter((entry) => entry?.name === name && entry?.status === "ok").length !== 1
  )) || stages.at(-1)?.name !== "readback" || stages.at(-1)?.status !== "ok") {
    fail("locked_draft.prior_write_sequence_invalid");
  }
  if (stages.some((entry) => entry?.name === "addTransferRecord") ||
    report?.transferRecord != null || report?.writeOutcomeUnknown === true ||
    report?.transferRecord?.outcomeUnknown === true) fail("locked_draft.prior_callback_present");
  if (report?.plan?.template?.name !== plan.template?.name ||
    stableStringify(report?.plan?.trust?.digests || {}) !== stableStringify(input?.trust?.digests || {}) ||
    stableStringify(report?.plan?.catalogs || {}) !== stableStringify(input?.catalogs || {})) fail("locked_draft.prior_dsl_mismatch");
  const expectedCode = repairKind === "template_authorization"
    ? "readback.workflow.template_authorization_mismatch"
    : "readback.form.calculation_order_mismatch";
  if (!(report?.diagnostics || []).some((diagnostic) => diagnostic?.code === expectedCode)) fail("locked_draft.prior_error_kind_mismatch");
  return diagnostics;
}

function transferRecordSummary(payload, extra) {
  return { ...extra, fdId: payload.fdId, fdOriginalId: payload.fdOriginalId,
    fdTargetId: payload.fdTargetId, fdName: payload.fdName, fdCreateTime: payload.fdCreateTime };
}

function writeArtifact(directory, name, value) {
  if (value === undefined) return;
  writeFileSync(join(directory, name), `${JSON.stringify(withoutMechanismTokens(value), null, 2)}\n`,
    { mode: 0o600, flag: "wx", flush: true });
}

function findDslField(dsl, fieldId) {
  for (const field of dsl?.form?.fields || []) {
    if (field?.id === fieldId) return field;
    if (field?.type === "detailTable") {
      const column = (field.columns || []).find((candidate) => candidate?.id === fieldId);
      if (column) return column;
    }
  }
  return undefined;
}

function valueAtPointer(root, pointer) { return pointer.split("/").slice(1).reduce((value, token) => value?.[token.replaceAll("~1", "/").replaceAll("~0", "~")], root); }
function normalizedTarget(value) { try { return { baseUrl: normalizeBaseUrl(value), diagnostics: [] }; } catch (error) { return { baseUrl: undefined, diagnostics: [{ level: "error", code: "safety.base_url_invalid", message: error.message, path: "/baseUrl" }] }; } }
function normalizedEvidenceUrl(value) { try { return normalizeBaseUrl(value); } catch { return undefined; } }
function stage(name) { return { name, status: "started" }; }
function okStage(stages) { stages.at(-1).status = "ok"; }
function invalid(diagnostics) { return { ok: false, status: "invalid", diagnostics }; }
function blocked(diagnostics, plan, baseUrl) { return { ok: false, status: "blocked", baseUrl, diagnostics, plan }; }
function coded(code) { return Object.assign(new Error(code), { code }); }
function requireValue(value, code) { if (!value) throw coded(code); }
function requiredText(value, code, path, diagnostics) { if (text(value)) return; diagnostics.push({ level: "error", code, message: "Locked-draft repair is missing required input.", path }); }
function text(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function digest(value) { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
