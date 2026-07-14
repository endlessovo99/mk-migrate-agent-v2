import { applyFormPayload } from "./persistence/form-writer.js";
import { applyWorkflowPayload, buildWorkflowDraftPayload } from "./persistence/workflow-writer.js";
import { buildExpectedInvariants } from "./persistence/expected.js";
import { observeNativeTemplate } from "./persistence/observer.js";
import { compareInvariants } from "./persistence/compare.js";
import { buildFormSummary, buildWorkflowSummary } from "./persistence/summaries.js";
import { projectionError } from "./persistence/diagnostics.js";
import { INVARIANT_VERSION } from "./persistence/invariants.js";
import {
  applyScopedWorkflowRepair,
  verifyScopedWorkflowRepair
} from "./persistence/workflow-repair.js";

export { buildWorkflowDraftPayload, INVARIANT_VERSION };

/**
 * Prepare a native template update and a bound deterministic verify capability.
 * Seam: after first getTemplate, before updateTemplate.
 */
export function preparePersistedTemplate({ dsl, envelope, baseTemplate, workflowUpdateMode = "full" }) {
  if (!dsl || typeof dsl !== "object") {
    return {
      ok: false,
      diagnostics: [projectionError("projection.dsl.invalid", "Persistence preparation requires a trusted DSL object.")]
    };
  }
  if (!envelope || typeof envelope !== "object") {
    return {
      ok: false,
      diagnostics: [projectionError("projection.envelope.invalid", "Persistence preparation requires an execution envelope.")]
    };
  }
  if (!baseTemplate || typeof baseTemplate !== "object") {
    return {
      ok: false,
      diagnostics: [projectionError("projection.base_template.invalid", "Persistence preparation requires the created template detail.")]
    };
  }

  if (!["full", "scoped-repair"].includes(workflowUpdateMode)) {
    return {
      ok: false,
      diagnostics: [projectionError(
        "projection.workflow_update_mode_invalid",
        `Unsupported workflow update mode: ${workflowUpdateMode}`
      )]
    };
  }

  const expectedDsl = workflowUpdateMode === "scoped-repair"
    ? { ...dsl, workflow: undefined }
    : dsl;
  const expectedResult = buildExpectedInvariants(expectedDsl, envelope);
  if (!expectedResult.ok) {
    return {
      ok: false,
      diagnostics: expectedResult.diagnostics
    };
  }

  let update;
  let workflowRepairPlan;
  try {
    const withCategory = {
      ...clone(baseTemplate),
      fdId: envelope.templateId || baseTemplate.fdId,
      fdCategory: { fdId: envelope.categoryId },
      fdName: envelope.templateName || baseTemplate.fdName,
      fdTableName: envelope.tableName || baseTemplate.fdTableName,
      fdStatus: envelope.lifecycle?.fdStatus ?? baseTemplate.fdStatus ?? 0
    };
    if (withCategory.mechanisms?.["sys-xform"]) {
      withCategory.mechanisms["sys-xform"] = {
        ...withCategory.mechanisms["sys-xform"],
        fdTableName: envelope.tableName || withCategory.mechanisms["sys-xform"].fdTableName,
        fdId: envelope.templateId || withCategory.mechanisms["sys-xform"].fdId
      };
    }
    const formUpdate = applyFormPayload(withCategory, dsl);
    if (workflowUpdateMode === "scoped-repair") {
      const repair = applyScopedWorkflowRepair(formUpdate, dsl);
      update = repair.update;
      workflowRepairPlan = repair.plan;
    } else {
      update = applyWorkflowPayload(formUpdate, dsl);
    }
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        projectionError(
          error?.code || "projection.internal_error",
          error instanceof Error ? error.message : String(error),
          error?.details
        )
      ]
    };
  }

  const expected = expectedResult.expected;
  return {
    ok: true,
    update,
    verify(readbackTemplate) {
      const verified = verifyPrepared(expected, readbackTemplate);
      if (workflowUpdateMode !== "scoped-repair") return verified;
      const workflow = verifyScopedWorkflowRepair(workflowRepairPlan, readbackTemplate);
      const observed = observeNativeTemplate(readbackTemplate || {});
      return {
        ...verified,
        ok: verified.ok && workflow.ok,
        status: verified.ok && workflow.ok ? "verified" : "mismatch",
        partitions: {
          ...verified.partitions,
          workflow: workflow.ok ? "verified" : "mismatch"
        },
        workflow: observed.workflow.status === "decode_failed"
          ? undefined
          : buildWorkflowSummary(observed.workflow.value),
        diagnostics: [...verified.diagnostics, ...workflow.diagnostics]
      };
    }
  };
}

function verifyPrepared(expected, readbackTemplate) {
  const observed = observeNativeTemplate(readbackTemplate || {});
  const comparison = compareInvariants(expected, observed);
  const formSummary = observed.form.status === "decode_failed"
    ? emptyFormSummary()
    : buildFormSummary(observed.form.value, observed.rules.value, observed.scripts.value);
  const workflowSummary = expected.workflow?.expected
    ? (observed.workflow.status === "decode_failed" || observed.workflow.status === "not_expected"
      ? undefined
      : buildWorkflowSummary(observed.workflow.value))
    : undefined;

  return {
    ok: comparison.ok,
    status: comparison.status,
    invariantVersion: comparison.invariantVersion,
    partitions: comparison.partitions,
    form: formSummary,
    workflow: workflowSummary,
    diagnostics: comparison.diagnostics
  };
}

function emptyFormSummary() {
  return {
    fieldCount: 0,
    fields: [],
    detailTableCount: 0,
    subjectRule: undefined,
    persistence: { mainTableName: "", detailTables: [] },
    layoutRowCount: 0,
    layoutRows: [],
    scripts: { actionCount: 0, events: [], controlEvents: [], actions: [] },
    formRules: { displayRuleCount: 0, requireRuleCount: 0, displayRules: [], requireRules: [] }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}
