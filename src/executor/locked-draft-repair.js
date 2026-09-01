import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Digest } from "../agent-review/digest.js";
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

const PARTITIONS = Object.freeze(["envelope", "form", "rules", "scripts", "workflow"]);
const AUTHORIZATION_COLLECTIONS = Object.freeze([
  "readers",
  "editors",
  "allReaders",
  "allEditors",
  "temporaryReaders",
  "temporaryEditors"
]);
const AUTHORIZATION_NATIVE_FIELDS = Object.freeze({
  readers: "fdReaders",
  editors: "fdEditors",
  allReaders: "fdAllReaders",
  allEditors: "fdAllEditors",
  temporaryReaders: "fdTmpReaders",
  temporaryEditors: "fdTmpEditors"
});

/** Repair one already-created draft through a strictly allowlisted native delta. */
export async function repairLockedDraft(input, options = {}) {
  const artifactDiagnostics = validateArtifactDigests(input, options);
  if (artifactDiagnostics.length) return invalid(artifactDiagnostics);
  const priorInput = options.priorDsl || input;
  const evolution = options.repairKind === "calculation"
    ? validateCalculationDslEvolution(priorInput, input, options.priorExecutionReport)
    : { ok: true };
  if (!evolution.ok) return invalid(evolution.diagnostics);
  const trusted = repairDsl(options.sourceDraft, input, options.priorExecutionReport);
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
  let stateCreated = false;
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
  const recordState = (status, extra = {}) => {
    if (!stateCreated) return;
    writeFileSync(
      join(options.artifactsDir, "locked-draft-state.json"),
      `${JSON.stringify({
        status,
        targetTemplateId,
        repairKind: options.repairKind,
        recordId: transferRecordPayload?.fdId,
        writeStarted,
        writeOutcomeUnknown: writeStarted && !writeCompleted,
        ...extra
      }, null, 2)}\n`,
      { mode: 0o600, flag: "w", flush: true }
    );
  };

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
    const preparedRepair = await prepareRepair({
      client,
      before,
      dsl: conditionResolution.dsl,
      sourceDsl: trusted.dsl,
      priorExecutionReport: options.priorExecutionReport,
      repairKind: options.repairKind
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
    writeFileSync(
      join(options.artifactsDir, "locked-draft-state.json"),
      `${JSON.stringify({
        status: "prepared",
        targetTemplateId,
        repairKind: options.repairKind,
        evidenceDigest,
        writeStarted: false,
        writeOutcomeUnknown: false
      }, null, 2)}\n`,
      { mode: 0o600, flag: "wx", flush: true }
    );
    stateCreated = true;
    writeArtifact(options.artifactsDir, "before.template.json", before.template);
    writeArtifact(options.artifactsDir, "before.workflow.json", before.workflow);
    writeArtifact(options.artifactsDir, "repair.plan.json", preparedRepair.plan);
    writeArtifact(options.artifactsDir, "update-template.payload.json", preparedRepair.template);
    if (preparedRepair.workflow) {
      writeArtifact(options.artifactsDir, "save-workflow.payload.json", preparedRepair.workflow);
    }

    writeStarted = true;
    recordState("write_started", { evidenceDigest, writeStage: "updateTemplate" });
    apiStages.push(stage("updateTemplate"));
    await client.updateTemplate(preparedRepair.template);
    okStage(apiStages);
    if (preparedRepair.workflow) {
      recordState("write_started", { evidenceDigest, writeStage: "saveWorkflowDraft" });
      apiStages.push(stage("saveWorkflowDraft"));
      await client.saveWorkflowDraft(preparedRepair.workflow);
      okStage(apiStages);
    }
    writeCompleted = true;
    recordState("awaiting_readback", { evidenceDigest });

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
      recordState("readback_failed", { evidenceDigest });
      return result;
    }

    const recordIdFactory = options.transferRecordIdFactory || generateTransferRecordId;
    transferRecordPayload = buildTransferRecordPayload(trusted.dsl, {
      fdId: recordIdFactory(),
      targetTemplateId,
      now: options.now || new Date()
    });
    apiStages.push(stage("addTransferRecord"));
    recordState("record_started", { evidenceDigest, writeStage: "addTransferRecord" });
    try {
      await client.addTransferRecord(transferRecordPayload);
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
      recordState("record_outcome_unknown", { evidenceDigest });
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
    recordState("verified", { evidenceDigest });
    return result;
  } catch (error) {
    if (apiStages.at(-1)?.status === "started") apiStages.at(-1).status = "failed";
    recordState(writeStarted ? "failed" : "blocked", { errorCode: error?.code });
    return {
      ok: false,
      status: writeStarted ? "failed" : "blocked",
      stage: apiStages.at(-1)?.name || "lockedDraftRepair",
      failedAt: apiStages.at(-1)?.name || "lockedDraftRepair",
      ...baseResult(),
      writeOutcomeUnknown: writeStarted && !writeCompleted,
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

async function prepareRepair({ client, before, dsl, sourceDsl, priorExecutionReport, repairKind }) {
  if (repairKind === "template_authorization") {
    return prepareAuthorizationRepair({
      client,
      before,
      dsl,
      sourceDsl,
      priorExecutionReport
    });
  }
  if (repairKind === "calculation") {
    return prepareCalculationRepair({ before, dsl, priorExecutionReport });
  }
  throw coded("locked_draft.repair_kind_unsupported");
}

async function prepareAuthorizationRepair({ client, before, sourceDsl, priorExecutionReport }) {
  const mismatch = (priorExecutionReport.diagnostics || []).filter((diagnostic) => (
    diagnostic?.level === "error" &&
    diagnostic?.code === "readback.workflow.template_authorization_mismatch"
  ));
  requireValue(mismatch.length === 1, "locked_draft.authorization_evidence_required");
  const expected = mismatch[0].details?.expected;
  const actual = mismatch[0].details?.actual;
  requireValue(expected && actual, "locked_draft.authorization_evidence_required");
  const observed = observedAuthorization(before.template);
  for (const collection of AUTHORIZATION_COLLECTIONS) {
    requireValue(
      stableStringify(observed[collection]) === stableStringify(sortedIds(actual[collection])),
      "locked_draft.authorization_snapshot_mismatch"
    );
  }

  const desiredEditors = unionIds(expected.editors, expected.allEditors);
  const editorIds = new Set(desiredEditors);
  const desiredReaders = unionIds(
    expected.readers,
    (expected.allReaders || []).filter((id) => !editorIds.has(id))
  );
  const desired = {
    readers: desiredReaders,
    editors: desiredEditors,
    allReaders: sortedIds(expected.allReaders),
    allEditors: sortedIds(expected.allEditors),
    temporaryReaders: sortedIds(expected.temporaryReaders),
    temporaryEditors: sortedIds(expected.temporaryEditors)
  };
  const missingIds = [...new Set(
    AUTHORIZATION_COLLECTIONS.flatMap((collection) => (
      desired[collection].filter((id) => !observed[collection].includes(id))
    ))
  )].sort();
  requireValue(missingIds.length > 0, "locked_draft.authorization_no_change");
  const elements = await client.getElementInfo(missingIds);
  const elementById = new Map((elements || []).map((member) => [member?.fdId, member]));
  for (const id of missingIds) {
    const sourceMember = sourceAuthorizationMember(sourceDsl, id);
    const target = elementById.get(id);
    requireValue(
      target?.fdId === id && text(target.fdName) &&
        Number(target.fdOrgType) === Number(sourceMember?.sourceOrgType),
      "locked_draft.authorization_identity_mismatch"
    );
  }

  const template = structuredClone(before.template);
  for (const collection of AUTHORIZATION_COLLECTIONS) {
    const nativeField = AUTHORIZATION_NATIVE_FIELDS[collection];
    template[nativeField] = membersForIds(
      desired[collection],
      before.template[nativeField],
      elementById
    );
  }
  template.mechanisms.lbpmTemplate[0].fdReaders = structuredClone(template.fdReaders);
  template.mechanisms.lbpmTemplate[0].fdEditors = structuredClone(template.fdEditors);
  const workflow = structuredClone(before.workflow);
  workflow.fdReaders = structuredClone(template.fdReaders);
  workflow.fdEditors = structuredClone(template.fdEditors);

  const changedPaths = authorizationChangedPaths(before, { template, workflow });
  const allowedPaths = [
    "/fdAllEditors",
    "/fdAllReaders",
    "/fdEditors",
    "/mechanisms/lbpmTemplate/0/fdEditors",
    "/workflowDetail/fdEditors"
  ];
  requireValue(
    stableStringify(changedPaths) === stableStringify(allowedPaths),
    "locked_draft.authorization_delta_outside_scope"
  );
  requireValue(
    digest(protectedAuthorizationBundle(before)) ===
      digest(protectedAuthorizationBundle({ template, workflow })),
    "locked_draft.authorization_delta_outside_scope"
  );

  return {
    before,
    template,
    workflow,
    plan: {
      repairKind: "template_authorization",
      targetTemplateId: template.fdId,
      missingIds,
      changedPaths
    },
    verify(after) {
      const afterObserved = observedAuthorization(after.template);
      const authorizationOk = AUTHORIZATION_COLLECTIONS.every((collection) => (
        stableStringify(afterObserved[collection]) === stableStringify(desired[collection])
      ));
      const bindingsOk = stableStringify(ids(after.template.mechanisms.lbpmTemplate[0].fdReaders)) ===
          stableStringify(desired.readers) &&
        stableStringify(ids(after.template.mechanisms.lbpmTemplate[0].fdEditors)) ===
          stableStringify(desired.editors) &&
        stableStringify(ids(after.workflow?.fdReaders)) === stableStringify(desired.readers) &&
        stableStringify(ids(after.workflow?.fdEditors)) === stableStringify(desired.editors);
      const protectedOk = digest(protectedAuthorizationBundle(before)) ===
        digest(protectedAuthorizationBundle(after));
      return {
        ok: authorizationOk && bindingsOk && protectedOk,
        checks: { authorizationOk, bindingsOk, protectedOk }
      };
    }
  };
}

function prepareCalculationRepair({ before, dsl, priorExecutionReport }) {
  const calculationDiagnostics = (priorExecutionReport.diagnostics || []).filter((diagnostic) => (
    diagnostic?.level === "error" && [
      "readback.form.calculation_order_mismatch",
      "readback.form.prop_calculation_mismatch"
    ].includes(diagnostic.code)
  ));
  requireValue(
    calculationDiagnostics.length === 2 &&
      calculationDiagnostics.some((diagnostic) => diagnostic.code === "readback.form.calculation_order_mismatch") &&
      calculationDiagnostics.some((diagnostic) => diagnostic.code === "readback.form.prop_calculation_mismatch"),
    "locked_draft.calculation_evidence_required"
  );
  const propMismatch = calculationDiagnostics.find((diagnostic) => (
    diagnostic.code === "readback.form.prop_calculation_mismatch"
  ));
  const aggregateFieldId = text(propMismatch?.details?.fieldId);
  const aggregateField = findDslField(dsl, aggregateFieldId);
  const aggregate = aggregateField?.props?.calculation;
  requireValue(
    aggregate?.kind === "aggregate" && aggregate.operation === "sum" &&
      text(aggregate.tableId) && text(aggregate.fieldId),
    "locked_draft.calculation_dsl_mismatch"
  );
  const detailTable = (dsl.form?.fields || []).find((field) => (
    field?.type === "detailTable" && field.id === aggregate.tableId
  ));
  const rowField = detailTable?.columns?.find((field) => field.id === aggregate.fieldId);
  requireValue(rowField?.props?.calculation?.kind === "formula", "locked_draft.calculation_row_formula_required");

  const projection = preparePersistedTemplate({
    dsl,
    envelope: executionEnvelope(
      before.template,
      before.workflow,
      before.template.fdCategory.fdId
    ),
    baseTemplate: before.template
  });
  requireValue(projection.ok, "locked_draft.calculation_projection_failed");
  const candidateConfig = parsedXformConfig(projection.update);
  const currentConfig = parsedXformConfig(before.template);
  const nextConfig = structuredClone(currentConfig);

  const candidateFormAttr = parsedFormAttr(candidateConfig);
  const nextFormAttr = parsedFormAttr(nextConfig);
  requireValue(
    Array.isArray(candidateFormAttr.formRule?.compute) &&
      candidateFormAttr.formRule.compute.length > 0,
    "locked_draft.calculation_compute_required"
  );
  nextFormAttr.formRule = nextFormAttr.formRule || {};
  nextFormAttr.formRule.compute = structuredClone(candidateFormAttr.formRule.compute);
  nextConfig.attribute.formAttr = JSON.stringify(nextFormAttr);

  const candidateRow = nativeDetailField(candidateConfig, aggregate.tableId, aggregate.fieldId);
  const nextRow = nativeDetailField(nextConfig, aggregate.tableId, aggregate.fieldId);
  const candidateAttribute = parsedNativeAttribute(candidateRow);
  const nextAttribute = parsedNativeAttribute(nextRow);
  const expressionFormulaVO = candidateAttribute.config?.controlProps?.expressionFormulaVO;
  requireValue(expressionFormulaVO && typeof expressionFormulaVO === "object",
    "locked_draft.calculation_expression_required");
  nextAttribute.config = nextAttribute.config || {};
  nextAttribute.config.controlProps = nextAttribute.config.controlProps || {};
  nextAttribute.config.controlProps.expressionFormulaVO = structuredClone(expressionFormulaVO);
  nextRow.fdAttribute = JSON.stringify(nextAttribute);

  const signKey = `${aggregate.fieldId}.expressionFormulaVO`;
  requireValue(
    text(candidateConfig.sign?.formula?.[signKey]),
    "locked_draft.calculation_sign_required"
  );
  nextConfig.sign = nextConfig.sign || {};
  nextConfig.sign.formula = nextConfig.sign.formula || {};
  nextConfig.sign.formula[signKey] = candidateConfig.sign.formula[signKey];

  const template = structuredClone(before.template);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(nextConfig);
  const changedPaths = [
    "/mechanisms/sys-xform/fdConfig/attribute/formAttr/formRule/compute",
    `/mechanisms/sys-xform/fdConfig/dataModel[detail:${aggregate.tableId}]/fdFields[${aggregate.fieldId}]/fdAttribute/config/controlProps/expressionFormulaVO`,
    `/mechanisms/sys-xform/fdConfig/sign/formula/${signKey}`
  ];
  requireValue(
    digest(protectedCalculationTemplate(before.template, {
      tableId: aggregate.tableId,
      fieldId: aggregate.fieldId
    })) === digest(protectedCalculationTemplate(template, {
      tableId: aggregate.tableId,
      fieldId: aggregate.fieldId
    })),
    "locked_draft.calculation_delta_outside_scope"
  );

  return {
    before,
    template,
    workflow: undefined,
    plan: {
      repairKind: "calculation",
      targetTemplateId: template.fdId,
      aggregateFieldId,
      detailTableId: aggregate.tableId,
      rowFormulaFieldId: aggregate.fieldId,
      changedPaths
    },
    verify(after) {
      const afterConfig = parsedXformConfig(after.template);
      const afterFormAttr = parsedFormAttr(afterConfig);
      const afterRowAttribute = parsedNativeAttribute(
        nativeDetailField(afterConfig, aggregate.tableId, aggregate.fieldId)
      );
      const computeOk = stableStringify(afterFormAttr.formRule?.compute || []) ===
        stableStringify(candidateFormAttr.formRule.compute);
      const expressionOk = stableStringify(
        afterRowAttribute.config?.controlProps?.expressionFormulaVO
      ) === stableStringify(expressionFormulaVO);
      const signOk = afterConfig.sign?.formula?.[signKey] === candidateConfig.sign.formula[signKey];
      const protectedOk = digest(protectedCalculationTemplate(before.template, {
        tableId: aggregate.tableId,
        fieldId: aggregate.fieldId
      })) === digest(protectedCalculationTemplate(after.template, {
        tableId: aggregate.tableId,
        fieldId: aggregate.fieldId
      }));
      return {
        ok: computeOk && expressionOk && signOk && protectedOk,
        checks: { computeOk, expressionOk, signOk, protectedOk }
      };
    }
  };
}

function observedAuthorization(template) {
  return Object.fromEntries(AUTHORIZATION_COLLECTIONS.map((collection) => [
    collection,
    ids(template?.[AUTHORIZATION_NATIVE_FIELDS[collection]])
  ]));
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

function parsedXformConfig(template) {
  const value = template?.mechanisms?.["sys-xform"]?.fdConfig;
  requireValue(typeof value === "string", "locked_draft.xform_config_required");
  try {
    const parsed = JSON.parse(value);
    requireValue(parsed && typeof parsed === "object" && !Array.isArray(parsed),
      "locked_draft.xform_config_invalid");
    return parsed;
  } catch (error) {
    if (error?.code) throw error;
    throw coded("locked_draft.xform_config_invalid");
  }
}

function parsedFormAttr(config) {
  const value = config?.attribute?.formAttr;
  requireValue(typeof value === "string", "locked_draft.form_attr_required");
  try {
    const parsed = JSON.parse(value);
    requireValue(parsed && typeof parsed === "object" && !Array.isArray(parsed),
      "locked_draft.form_attr_invalid");
    return parsed;
  } catch (error) {
    if (error?.code) throw error;
    throw coded("locked_draft.form_attr_invalid");
  }
}

function nativeDetailField(config, tableId, fieldId) {
  const models = (config?.dataModel || []).filter((model) => (
    model?.fdType === "detail" && model?.dynamicProps?.detailFieldName === tableId
  ));
  requireValue(models.length === 1, "locked_draft.calculation_detail_model_mismatch");
  const fields = (models[0].fdFields || []).filter((field) => field?.fdName === fieldId);
  requireValue(fields.length === 1, "locked_draft.calculation_detail_field_mismatch");
  return fields[0];
}

function parsedNativeAttribute(field) {
  requireValue(typeof field?.fdAttribute === "string", "locked_draft.calculation_attribute_required");
  try {
    const parsed = JSON.parse(field.fdAttribute);
    requireValue(parsed && typeof parsed === "object" && !Array.isArray(parsed),
      "locked_draft.calculation_attribute_invalid");
    return parsed;
  } catch (error) {
    if (error?.code) throw error;
    throw coded("locked_draft.calculation_attribute_invalid");
  }
}

function protectedCalculationTemplate(template, { tableId, fieldId }) {
  const copy = normalizedProtected(structuredClone(template));
  const config = parsedXformConfig(copy);
  const formAttr = parsedFormAttr(config);
  if (formAttr.formRule) delete formAttr.formRule.compute;
  config.attribute.formAttr = formAttr;
  const row = nativeDetailField(config, tableId, fieldId);
  const attribute = parsedNativeAttribute(row);
  if (attribute.config?.controlProps) {
    delete attribute.config.controlProps.expressionFormulaVO;
  }
  row.fdAttribute = attribute;
  if (config.sign?.formula) delete config.sign.formula[`${fieldId}.expressionFormulaVO`];
  copy.mechanisms["sys-xform"].fdConfig = config;
  return copy;
}

function sourceAuthorizationMember(dsl, sourceId) {
  return AUTHORIZATION_COLLECTIONS
    .flatMap((collection) => dsl?.template?.authorization?.[collection] || [])
    .find((member) => member?.sourceId === sourceId || member?.id === sourceId);
}

function membersForIds(expectedIds, existing, elementById) {
  const existingById = new Map((existing || []).map((member) => [member?.fdId, member]));
  return expectedIds.map((id) => {
    if (existingById.has(id)) return structuredClone(existingById.get(id));
    const target = elementById.get(id);
    return { fdId: target.fdId, fdName: target.fdName, fdOrgType: Number(target.fdOrgType) };
  });
}

function authorizationChangedPaths(before, after) {
  const paths = [];
  for (const field of ["fdEditors", "fdAllReaders", "fdAllEditors"]) {
    if (stableStringify(ids(before.template[field])) !== stableStringify(ids(after.template[field]))) {
      paths.push(`/${field}`);
    }
  }
  if (stableStringify(ids(before.template.mechanisms.lbpmTemplate[0].fdEditors)) !==
    stableStringify(ids(after.template.mechanisms.lbpmTemplate[0].fdEditors))) {
    paths.push("/mechanisms/lbpmTemplate/0/fdEditors");
  }
  if (stableStringify(ids(before.workflow?.fdEditors)) !== stableStringify(ids(after.workflow?.fdEditors))) {
    paths.push("/workflowDetail/fdEditors");
  }
  return paths.sort();
}

function protectedAuthorizationBundle(bundle) {
  const copy = normalizedProtected(structuredClone(bundle));
  for (const field of ["fdEditors", "fdAllReaders", "fdAllEditors"]) delete copy.template[field];
  if (copy.template?.mechanisms?.lbpmTemplate?.[0]) {
    delete copy.template.mechanisms.lbpmTemplate[0].fdEditors;
  }
  if (copy.workflow) delete copy.workflow.fdEditors;
  return copy;
}

function normalizedProtected(value) {
  const copy = withoutMechanismTokens(value);
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    delete node.fdAlter;
    delete node.fdAlterTime;
    for (const child of Object.values(node)) visit(child);
  };
  visit(copy);
  const normalize = (owner, fields) => {
    if (!owner || typeof owner !== "object") return;
    for (const field of fields) {
      if (Array.isArray(owner[field])) owner[field] = ids(owner[field]);
    }
  };
  normalize(copy, Object.values(AUTHORIZATION_NATIVE_FIELDS));
  normalize(copy?.mechanisms?.lbpmTemplate?.[0], ["fdReaders", "fdEditors"]);
  normalize(copy.template, Object.values(AUTHORIZATION_NATIVE_FIELDS));
  normalize(copy.template?.mechanisms?.lbpmTemplate?.[0], ["fdReaders", "fdEditors"]);
  normalize(copy.workflow, ["fdReaders", "fdEditors"]);
  return copy;
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

function repairDsl(sourceDraft, input, priorExecutionReport) {
  if (sha256Digest(sourceDraft) !== input?.trust?.digests?.sourceDraft) {
    return { ok: false, diagnostics: [{
      level: "error",
      code: "locked_draft.source_digest_mismatch",
      message: "Current Source XML does not match the trusted Source Draft.",
      path: "/sourceDraft"
    }] };
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
  if ((report?.apiStages || []).some((entry) => entry?.name === "addTransferRecord") || report?.transferRecord != null || report?.writeOutcomeUnknown === true) fail("locked_draft.prior_callback_present");
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

function membersById(values) {
  const result = new Map();
  for (const member of values || []) {
    requireValue(text(member?.fdId) && !result.has(member.fdId), "locked_draft.authorization_member_invalid");
    result.set(member.fdId, member);
  }
  return result;
}

function ids(values) { return [...membersById(values).keys()].sort(); }
function sortedIds(values) { return [...new Set((values || []).filter(text))].sort(); }
function unionIds(...values) { return sortedIds(values.flat()); }
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
