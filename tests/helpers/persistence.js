import { preparePersistedTemplate } from "../../src/executor/persistence.js";
import { buildWorkflowContent, buildWorkflowDraftPayload } from "../../src/executor/persistence/workflow-writer.js";
import { observeNativeTemplate } from "../../src/executor/persistence/observer.js";
import { buildFormSummary, buildWorkflowSummary } from "../../src/executor/persistence/summaries.js";

export { buildWorkflowContent, buildWorkflowDraftPayload };

export function sampleEnvelope(overrides = {}) {
  return {
    templateId: "template-id",
    templateName: "MK_TEST_示例流程_20260710120000",
    categoryId: "category-id",
    tableName: "mk_model_test",
    lifecycle: {
      draft: true,
      unpublished: true,
      fdStatus: 0,
      xformStatus: "draft",
      lbpmStatus: "draft",
      lbpmIsDraft: true
    },
    bindings: {
      formFdId: "template-id",
      workflowFdId: "workflow-template-id"
    },
    ...overrides
  };
}

export function sampleBaseTemplate(overrides = {}) {
  return {
    fdId: "template-id",
    fdName: "MK_TEST_示例流程_20260710120000",
    fdStatus: 0,
    fdTableName: "mk_model_test",
    fdCategory: { fdId: "category-id" },
    mechanisms: {
      "sys-xform": {
        fdId: "template-id",
        fdName: "MK_TEST_示例流程_20260710120000",
        fdTableName: "mk_model_test",
        fdConfig: "{}"
      },
      lbpmTemplate: [{
        fdId: "workflow-template-id",
        fdStatus: "draft",
        isDraft: true,
        fdTemplateForms: []
      }]
    },
    ...overrides
  };
}

export function prepareSample(dsl, options = {}) {
  const providedBase = options.baseTemplate ? clone(options.baseTemplate) : sampleBaseTemplate();
  const envelope = sampleEnvelope({
    templateId: providedBase.fdId || "template-id",
    templateName: providedBase.fdName?.startsWith?.("MK_TEST_")
      ? providedBase.fdName
      : `MK_TEST_${providedBase.fdName || "示例流程"}_20260710120000`,
    tableName: providedBase.fdTableName ||
      providedBase.mechanisms?.["sys-xform"]?.fdTableName ||
      "mk_model_test",
    categoryId: providedBase.fdCategory?.fdId || "category-id",
    bindings: {
      formFdId: providedBase.fdId || "template-id",
      workflowFdId: providedBase.mechanisms?.lbpmTemplate?.[0]?.fdId || "workflow-template-id"
    },
    ...options.envelope
  });
  // Ensure envelope name prefix requirement is satisfied for non-MK_TEST bases used by older tests.
  if (!String(envelope.templateName).startsWith("MK_TEST_")) {
    envelope.templateName = `MK_TEST_${envelope.templateName}_20260710120000`;
  }
  if (!providedBase.fdName?.startsWith?.("MK_TEST_")) {
    providedBase.fdName = envelope.templateName;
  }
  if (providedBase.mechanisms?.["sys-xform"] && !providedBase.mechanisms["sys-xform"].fdTableName) {
    providedBase.mechanisms["sys-xform"].fdTableName = envelope.tableName;
  }
  if (!providedBase.fdCategory) {
    providedBase.fdCategory = { fdId: envelope.categoryId };
  }
  if (!providedBase.fdStatus && providedBase.fdStatus !== 0) {
    providedBase.fdStatus = 0;
  }

  const prepared = preparePersistedTemplate({
    dsl,
    envelope,
    baseTemplate: providedBase,
    workflowUpdateMode: options.workflowUpdateMode
  });
  if (!prepared.ok) {
    const error = new Error(prepared.diagnostics.map((item) => item.message).join("; "));
    error.diagnostics = prepared.diagnostics;
    throw error;
  }
  return prepared;
}

/** Project DSL through the persistence Module Interface. */
export function projectTemplate(dsl, baseTemplate) {
  return prepareSample(dsl, baseTemplate ? { baseTemplate } : {}).update;
}

/** Verify a native template through the bound persistence verify capability. */
export function verifyTemplate(dsl, template, options = {}) {
  const envelope = sampleEnvelope({
    templateId: template?.fdId || "template-id",
    templateName: template?.fdName?.startsWith?.("MK_TEST_")
      ? template.fdName
      : `MK_TEST_${template?.fdName || "示例流程"}_20260710120000`,
    categoryId: template?.fdCategory?.fdId || "category-id",
    tableName: template?.mechanisms?.["sys-xform"]?.fdTableName ||
      template?.fdTableName ||
      "mk_model_test",
    lifecycle: {
      draft: true,
      unpublished: true,
      fdStatus: template?.fdStatus ?? 0,
      xformStatus: "draft",
      lbpmStatus: "draft",
      lbpmIsDraft: true
    },
    bindings: {
      formFdId: template?.fdId || "template-id",
      workflowFdId: template?.mechanisms?.lbpmTemplate?.[0]?.fdId || "workflow-template-id"
    },
    ...options.envelope
  });
  const prepared = preparePersistedTemplate({
    dsl,
    envelope,
    baseTemplate: sampleBaseTemplate({
      fdId: envelope.templateId,
      fdName: envelope.templateName,
      fdTableName: envelope.tableName,
      fdCategory: { fdId: envelope.categoryId },
      fdStatus: envelope.lifecycle.fdStatus,
      mechanisms: {
        "sys-xform": {
          fdId: envelope.templateId,
          fdName: envelope.templateName,
          fdTableName: envelope.tableName,
          fdConfig: "{}"
        },
        lbpmTemplate: [{
          fdId: envelope.bindings.workflowFdId || "workflow-template-id",
          fdStatus: "draft",
          isDraft: true,
          fdTemplateForms: []
        }]
      }
    })
  });
  if (!prepared.ok) {
    const error = new Error(prepared.diagnostics.map((item) => item.message).join("; "));
    error.diagnostics = prepared.diagnostics;
    throw error;
  }
  return prepared.verify(template);
}

export function summarizeProjectedForm(template) {
  const observed = observeNativeTemplate(template);
  return buildFormSummary(observed.form.value, observed.rules.value, observed.scripts.value);
}

export function summarizeProjectedWorkflow(template) {
  const observed = observeNativeTemplate(template);
  return buildWorkflowSummary(observed.workflow.value);
}

export function persistAndVerify(dsl, options = {}) {
  const prepared = prepareSample(dsl, options);
  const template = options.mutate
    ? options.mutate(clone(prepared.update))
    : prepared.update;
  return {
    prepared,
    template,
    readback: prepared.verify(template)
  };
}

export function xformConfig(template) {
  return JSON.parse(template.mechanisms["sys-xform"].fdConfig);
}

export function formAttr(template) {
  return JSON.parse(xformConfig(template).attribute.formAttr);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
