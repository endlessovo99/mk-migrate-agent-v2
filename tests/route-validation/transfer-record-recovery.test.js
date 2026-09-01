import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { NEWOA_SIT_BASE_URL } from "../../src/executor/newoa-client.js";
import { preparePersistedTemplate } from "../../src/executor/persistence.js";
import { applyRequiredTemplateNumberRule } from "../../src/executor/template-number-rule.js";
import { recoverVerifiedTransferRecord } from "../../src/executor/transfer-record-recovery.js";
import { sampleBaseTemplate, sampleEnvelope } from "../helpers/persistence.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

const TARGET_TEMPLATE_ID = "recovery-target-template-id";
const WORKFLOW_TEMPLATE_ID = "recovery-workflow-template-id";
const CATEGORY_ID = "recovery-category-id";
const RECORD_ID = "recovery0000000000000000000000000000";
const NOW = new Date("2026-09-01T04:00:00.000Z");
const CREDENTIALS = Object.freeze({
  username: "route-recovery-user",
  encryptedPassword: "route-recovery-encrypted-password"
});

describe("transfer-record recovery Route-validation", () => {
  it("verifies the existing draft and adds exactly one missing record without template writes", async () => {
    const fixture = recoveryFixture();
    const client = new RecoveryFakeClient(fixture.template);

    const result = await recoverVerifiedTransferRecord(fixture.dsl, recoveryOptions({
      client,
      priorExecutionReport: fixture.priorExecutionReport
    }));

    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.status, "transfer_record_recorded");
    assert.deepEqual(result.readback.partitions, {
      envelope: "verified",
      form: "verified",
      rules: "verified",
      scripts: "verified",
      workflow: "verified"
    });
    assert.equal(result.readback.numberRule.status, "verified");
    assert.deepEqual(client.operations(), [
      "login",
      "transfer-record-auth-preflight",
      "get-template",
      "get-workflow-detail",
      "add-transfer-record"
    ]);
    assert.equal(client.calls.filter((call) => call.operation === "add-transfer-record").length, 1);
    assert.equal(client.calls.some((call) => (
      ["add-template", "update-template", "save-workflow-draft"].includes(call.operation)
    )), false);
    assert.deepEqual(client.calls.at(-1), {
      operation: "add-transfer-record",
      fdId: RECORD_ID,
      fdOriginalId: "sample-source",
      fdTargetId: TARGET_TEMPLATE_ID,
      fdName: "示例流程",
      fdCreateTime: NOW.getTime()
    });
  });

  it("blocks before callback when any native readback partition mismatches", async () => {
    const fixture = recoveryFixture();
    const template = structuredClone(fixture.template);
    const config = JSON.parse(template.mechanisms["sys-xform"].fdConfig);
    config.dataModel[0].fdFields[0].fdLabel = "损坏的字段标题";
    template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    const client = new RecoveryFakeClient(template);

    const result = await recoverVerifiedTransferRecord(fixture.dsl, recoveryOptions({
      client,
      priorExecutionReport: fixture.priorExecutionReport
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, "readback_failed");
    assert.equal(result.stage, "readback");
    assert.equal(result.readback.partitions.form, "mismatch");
    assert.equal(client.operations().includes("add-transfer-record"), false);
    assert.equal(client.operations().includes("update-template"), false);
  });

  it("refuses recovery when prior callback evidence exists", async () => {
    const fixture = recoveryFixture();
    fixture.priorExecutionReport.apiStages.push({
      name: "addTransferRecord",
      status: "failed",
      writeOutcomeUnknown: true
    });
    const client = new RecoveryFakeClient(fixture.template);

    const result = await recoverVerifiedTransferRecord(fixture.dsl, recoveryOptions({
      client,
      priorExecutionReport: fixture.priorExecutionReport
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(
      result.diagnostics.some((item) => (
        item.code === "safety.prior_transfer_record_evidence_present"
      )),
      true
    );
    assert.deepEqual(client.operations(), []);
  });

  it("marks an uncertain callback and never retries it", async () => {
    const fixture = recoveryFixture();
    const client = new RecoveryFakeClient(fixture.template, {
      transferRecordError: new Error("connection closed after callback POST")
    });

    const result = await recoverVerifiedTransferRecord(fixture.dsl, recoveryOptions({
      client,
      priorExecutionReport: fixture.priorExecutionReport
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, "transfer_record_failed");
    assert.equal(result.transferRecord.writeOutcomeUnknown, true);
    assert.equal(client.calls.filter((call) => call.operation === "add-transfer-record").length, 1);
    assert.equal(
      result.diagnostics.some((item) => (
        item.code === "transfer_record.write_outcome_unknown"
      )),
      true
    );
  });
});

function recoveryFixture() {
  const dsl = sampleTrustedDsl({
    trust: {
      digests: {
        sourceDraft: "sha256:recovery-source",
        dslDraft: "sha256:recovery-dsl"
      }
    }
  });
  const baseTemplate = sampleBaseTemplate({
    fdId: TARGET_TEMPLATE_ID,
    fdName: "MK_TEST_示例流程_20260901120000",
    fdCategory: { fdId: CATEGORY_ID },
    mechanisms: {
      "sys-xform": {
        fdId: TARGET_TEMPLATE_ID,
        fdName: "MK_TEST_示例流程_20260901120000",
        fdTableName: "mk_model_recovery",
        fdConfig: "{}"
      },
      lbpmTemplate: [{
        fdId: WORKFLOW_TEMPLATE_ID,
        fdStatus: "draft",
        isDraft: true,
        fdTemplateForms: []
      }]
    }
  });
  const prepared = preparePersistedTemplate({
    dsl,
    envelope: sampleEnvelope({
      templateId: TARGET_TEMPLATE_ID,
      templateName: baseTemplate.fdName,
      categoryId: CATEGORY_ID,
      tableName: "mk_model_recovery",
      bindings: {
        formFdId: TARGET_TEMPLATE_ID,
        workflowFdId: WORKFLOW_TEMPLATE_ID
      }
    }),
    baseTemplate
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
  const template = applyRequiredTemplateNumberRule(structuredClone(prepared.update));
  const plan = buildDryRunPlan(dsl);
  return {
    dsl,
    template,
    priorExecutionReport: {
      ok: false,
      status: "readback_failed",
      stage: "readback",
      failedAt: "readback",
      baseUrl: NEWOA_SIT_BASE_URL,
      templateId: TARGET_TEMPLATE_ID,
      createdFdIds: [TARGET_TEMPLATE_ID],
      updatedFdIds: [],
      readback: { ok: false, status: "readback_failed" },
      apiStages: [
        { name: "add", status: "ok" },
        { name: "update", status: "ok" },
        { name: "readback", status: "ok" }
      ],
      plan
    }
  };
}

function recoveryOptions(overrides = {}) {
  return {
    credentials: CREDENTIALS,
    confirmWrite: true,
    confirmNoSuccessfulTransferRecord: true,
    targetCategoryId: CATEGORY_ID,
    targetTemplateId: TARGET_TEMPLATE_ID,
    transferRecordId: RECORD_ID,
    baseUrl: NEWOA_SIT_BASE_URL,
    now: NOW,
    ...overrides
  };
}

class RecoveryFakeClient {
  constructor(template, options = {}) {
    this.template = structuredClone(template);
    this.transferRecordError = options.transferRecordError;
    this.calls = [];
  }

  async login() {
    this.calls.push({ operation: "login" });
  }

  async assertTransferRecordAuthentication() {
    this.calls.push({ operation: "transfer-record-auth-preflight" });
  }

  async getTemplate(fdId) {
    this.calls.push({ operation: "get-template", fdId });
    return structuredClone(this.template);
  }

  async getWorkflowTemplateDetail({ templateId, definitionId }) {
    this.calls.push({ operation: "get-workflow-detail", templateId, definitionId });
    return structuredClone(this.template.mechanisms.lbpmTemplate[0]);
  }

  async addTransferRecord(payload) {
    this.calls.push({
      operation: "add-transfer-record",
      fdId: payload.fdId,
      fdOriginalId: payload.fdOriginalId,
      fdTargetId: payload.fdTargetId,
      fdName: payload.fdName,
      fdCreateTime: payload.fdCreateTime
    });
    if (this.transferRecordError) throw this.transferRecordError;
    return { fdId: payload.fdId };
  }

  async addTemplate() {
    this.calls.push({ operation: "add-template" });
    throw new Error("recovery must not create templates");
  }

  async updateTemplate() {
    this.calls.push({ operation: "update-template" });
    throw new Error("recovery must not update templates");
  }

  async saveWorkflowDraft() {
    this.calls.push({ operation: "save-workflow-draft" });
    throw new Error("recovery must not save workflow drafts");
  }

  operations() {
    return this.calls.map((call) => call.operation);
  }
}
