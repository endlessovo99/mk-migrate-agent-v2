import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { sha256Digest } from "../../src/agent-review/digest.js";
import { NEWOA_SIT_BASE_URL } from "../../src/executor/newoa-client.js";
import { preparePersistedTemplate } from "../../src/executor/persistence.js";
import {
  reconcileTransferRecord,
  reconciliationEvidenceDigest
} from "../../src/executor/reconcile-transfer-record.js";
import { applyRequiredTemplateNumberRule } from "../../src/executor/template-number-rule.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sampleBaseTemplate, sampleEnvelope } from "../helpers/persistence.js";

const TARGET_TEMPLATE_ID = "reconcile-target-template-id";
const WORKFLOW_TEMPLATE_ID = "reconcile-workflow-template-id";
const CATEGORY_ID = "reconcile-category-id";
const NOW = new Date("2026-09-01T04:00:00.000Z");
const CREDENTIALS = Object.freeze({
  username: "route-reconcile-user",
  encryptedPassword: "route-reconcile-encrypted-password"
});

describe("transfer-record reconciliation Route", () => {
  it("previews without writes, then records exactly once without template or workflow mutation", async (t) => {
    const fixture = reconciliationFixture();
    const client = new ReconciliationFakeClient(fixture.template);

    const preview = await reconcileTransferRecord(fixture.dsl, reconcileOptions(fixture, {
      client,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport
    }));

    assert.equal(preview.ok, true, JSON.stringify(preview.diagnostics));
    assert.equal(preview.status, "verified_unrecorded");
    assert.match(preview.evidenceDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(preview.readback.partitions, {
      envelope: "verified",
      form: "verified",
      rules: "verified",
      scripts: "verified",
      workflow: "verified"
    });
    assert.equal(client.operations().includes("add-transfer-record"), false);
    assert.equal(client.hasTemplateWrite(), false);

    const artifactsRoot = mkdtempSync(join(tmpdir(), "mk-reconcile-route-"));
    t.after(() => rmSync(artifactsRoot, { recursive: true, force: true }));
    const confirmed = await reconcileTransferRecord(fixture.dsl, reconcileOptions(fixture, {
      client,
      confirmWrite: true,
      expectedEvidenceDigest: preview.evidenceDigest,
      artifactsDir: join(artifactsRoot, "execution"),
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport
    }));

    assert.equal(confirmed.ok, true, JSON.stringify(confirmed.diagnostics));
    assert.equal(confirmed.status, "transfer_record_recorded");
    assert.deepEqual(confirmed.createdFdIds, []);
    assert.deepEqual(confirmed.updatedFdIds, []);
    assert.equal(client.calls.filter((call) => call.operation === "add-transfer-record").length, 1);
    assert.equal(client.hasTemplateWrite(), false);
  });

  it("rejects complete-DSL tampering between preview and confirmation even when trust strings are unchanged", async (t) => {
    const fixture = reconciliationFixture();
    const client = new ReconciliationFakeClient(fixture.template);
    const preview = await reconcileTransferRecord(fixture.dsl, reconcileOptions(fixture, {
      client,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport
    }));
    assert.equal(preview.ok, true, JSON.stringify(preview.diagnostics));
    const tampered = structuredClone(fixture.dsl);
    tampered.trust.reviewer.name = "tampered after trust";
    const artifactsRoot = mkdtempSync(join(tmpdir(), "mk-reconcile-tamper-"));
    t.after(() => rmSync(artifactsRoot, { recursive: true, force: true }));

    const result = await reconcileTransferRecord(tampered, reconcileOptions(fixture, {
      client,
      confirmWrite: true,
      expectedEvidenceDigest: preview.evidenceDigest,
      artifactsDir: join(artifactsRoot, "execution"),
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(client.operations().includes("add-transfer-record"), false);
    assert.equal(client.hasTemplateWrite(), false);
  });

  it("persists an uncertain callback lock so a second invocation cannot post again", async (t) => {
    const fixture = reconciliationFixture();
    const client = new ReconciliationFakeClient(fixture.template);
    const preview = await reconcileTransferRecord(fixture.dsl, reconcileOptions(fixture, {
      client,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport
    }));
    assert.equal(preview.ok, true, JSON.stringify(preview.diagnostics));
    client.transferRecordError = new Error("connection closed after POST");
    const artifactsRoot = mkdtempSync(join(tmpdir(), "mk-reconcile-uncertain-"));
    const artifactsDir = join(artifactsRoot, "execution");
    t.after(() => rmSync(artifactsRoot, { recursive: true, force: true }));
    const options = reconcileOptions(fixture, {
      client,
      confirmWrite: true,
      expectedEvidenceDigest: preview.evidenceDigest,
      artifactsDir,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport
    });

    const first = await reconcileTransferRecord(fixture.dsl, options);
    const second = await reconcileTransferRecord(fixture.dsl, options);

    assert.equal(first.status, "transfer_record_failed");
    assert.equal(first.transferRecord.writeOutcomeUnknown, true);
    assert.equal(second.ok, false);
    assert.equal(client.calls.filter((call) => call.operation === "add-transfer-record").length, 1);
    assert.equal(client.hasTemplateWrite(), false);
  });

  it("does not create a record when any persisted partition still mismatches", async () => {
    const fixture = reconciliationFixture();
    const damaged = structuredClone(fixture.template);
    const config = JSON.parse(damaged.mechanisms["sys-xform"].fdConfig);
    const main = config.dataModel.find((model) => model.fdType === "main");
    main.fdFields.find((field) => field.fdIsSystem !== true).fdLabel = "damaged title";
    damaged.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    const client = new ReconciliationFakeClient(damaged);

    const result = await reconcileTransferRecord(fixture.dsl, reconcileOptions(fixture, {
      client,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, "readback_failed");
    assert.equal(client.operations().includes("add-transfer-record"), false);
    assert.equal(client.hasTemplateWrite(), false);
  });

  it("bridges the evidenced v14 component catalog only for readback verification", async () => {
    const fixture = reconciliationFixture();
    fixture.dsl.catalogs.components.version = "2026-08-28.v14";
    fixture.priorExecutionReport.plan.catalogs.components.version = "2026-08-28.v14";
    fixture.dslDigest = reconciliationEvidenceDigest(fixture.dsl);
    fixture.priorReportDigest = reconciliationEvidenceDigest(fixture.priorExecutionReport);
    const client = new ReconciliationFakeClient(fixture.template);

    const result = await reconcileTransferRecord(fixture.dsl, reconcileOptions(fixture, {
      client,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport
    }));

    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.status, "verified_unrecorded");
    assert.equal(client.hasTemplateWrite(), false);
  });
});

function reconciliationFixture() {
  const sourceDraft = cleanSourceFile(
    "tests/fixtures/route-validation/workflow-data-authority"
  );
  const dslDraft = draftSourceDraft(sourceDraft);
  const dsl = createTrustedMigrationDsl(sourceDraft, dslDraft, {
    externalAgentReviewed: true,
    reviewerName: "route-validation",
    checkedAt: "2026-09-01T00:00:00.000Z",
    sourceDraftDigest: sha256Digest(sourceDraft),
    dslDraftDigest: sha256Digest(dslDraft)
  });
  const baseTemplate = sampleBaseTemplate({
    fdId: TARGET_TEMPLATE_ID,
    fdName: "MK_TEST_示例流程_20260901120000",
    fdCategory: { fdId: CATEGORY_ID },
    mechanisms: {
      "sys-xform": {
        fdId: TARGET_TEMPLATE_ID,
        fdName: "MK_TEST_示例流程_20260901120000",
        fdTableName: "mk_model_reconcile",
        fdStatus: "draft",
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
      tableName: "mk_model_reconcile",
      bindings: {
        formFdId: TARGET_TEMPLATE_ID,
        workflowFdId: WORKFLOW_TEMPLATE_ID
      }
    }),
    baseTemplate
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
  const template = applyRequiredTemplateNumberRule(structuredClone(prepared.update));
  Object.assign(template.mechanisms.lbpmTemplate[0], {
    fdEntityId: TARGET_TEMPLATE_ID,
    fdCategory: { fdId: CATEGORY_ID },
    fdContentType: "json",
    fdSystemCode: "INNER_SYSTEM",
    fdRunType: 1,
    fdDisableBpmInit: false,
    fdFormCategory: { fdFormCategoryId: CATEGORY_ID },
    fdStatus: "draft",
    isDraft: true
  });
  const plan = buildDryRunPlan(dsl);
  const priorExecutionReport = {
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
  };
  return {
    sourceDraft,
    dsl,
    template,
    priorExecutionReport,
    dslDigest: reconciliationEvidenceDigest(dsl),
    priorReportDigest: reconciliationEvidenceDigest(priorExecutionReport)
  };
}

function reconcileOptions(fixture, overrides = {}) {
  return {
    credentials: CREDENTIALS,
    confirmWrite: false,
    targetCategoryId: CATEGORY_ID,
    targetTemplateId: TARGET_TEMPLATE_ID,
    baseUrl: NEWOA_SIT_BASE_URL,
    expectedDslDigest: fixture.dslDigest,
    expectedPriorReportDigest: fixture.priorReportDigest,
    now: NOW,
    transferRecordIdFactory: () => "reconcile0000000000000000000000000000",
    ...overrides
  };
}

class ReconciliationFakeClient {
  constructor(template) {
    this.template = structuredClone(template);
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
    this.calls.push({ operation: "add-transfer-record", payload: structuredClone(payload) });
    if (this.transferRecordError) throw this.transferRecordError;
    return { fdId: payload.fdId };
  }

  async addTemplate() {
    this.calls.push({ operation: "add-template" });
    throw new Error("reconciliation must not create templates");
  }

  async updateTemplate() {
    this.calls.push({ operation: "update-template" });
    throw new Error("reconciliation must not update templates");
  }

  async saveWorkflowDraft() {
    this.calls.push({ operation: "save-workflow-draft" });
    throw new Error("reconciliation must not save workflow drafts");
  }

  operations() {
    return this.calls.map((call) => call.operation);
  }

  hasTemplateWrite() {
    return this.calls.some((call) => [
      "add-template",
      "update-template",
      "save-workflow-draft"
    ].includes(call.operation));
  }
}
