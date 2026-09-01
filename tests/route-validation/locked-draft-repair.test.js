import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { sha256Digest } from "../../src/agent-review/digest.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import {
  lockedDraftEvidenceDigest,
  repairLockedDraft
} from "../../src/executor/locked-draft-repair.js";
import { preparePersistedTemplate } from "../../src/executor/persistence.js";
import { applyRequiredTemplateNumberRule } from "../../src/executor/template-number-rule.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { sampleBaseTemplate, sampleEnvelope } from "../helpers/persistence.js";

const TARGET_TEMPLATE_ID = "locked-target-template-id";
const WORKFLOW_TEMPLATE_ID = "locked-workflow-template-id";
const CATEGORY_ID = "locked-category-id";
const MEMBER_ID = "locked-maintainer-id";
const CREDENTIALS = Object.freeze({
  username: "locked-route-user",
  encryptedPassword: "locked-route-secret"
});

describe("scoped locked-draft repair Route", () => {
  it("repairs only the evidenced authorization collections and records the migration", async (t) => {
    const fixture = authorizationFixture();
    const client = new LockedDraftFakeClient(fixture.template, fixture.workflow);
    const preview = await repairLockedDraft(fixture.dsl, repairOptions(fixture, {
      client,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport,
      repairKind: "template_authorization"
    }));

    assert.equal(preview.ok, true, JSON.stringify(preview.diagnostics));
    assert.equal(preview.status, "repair_ready");
    assert.deepEqual(preview.plan.changedPaths, [
      "/fdAllEditors",
      "/fdAllReaders",
      "/fdEditors",
      "/mechanisms/lbpmTemplate/0/fdEditors",
      "/workflowDetail/fdEditors"
    ]);
    assert.equal(client.hasWrite(), false);

    const root = mkdtempSync(join(tmpdir(), "mk-locked-auth-repair-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const originalTemplate = structuredClone(client.template);
    const originalWorkflow = structuredClone(client.workflow);
    const result = await repairLockedDraft(fixture.dsl, repairOptions(fixture, {
      client,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport,
      repairKind: "template_authorization",
      confirmWrite: true,
      expectedEvidenceDigest: preview.evidenceDigest,
      artifactsDir: join(root, "execution")
    }));

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.status, "repaired_and_recorded");
    assert.deepEqual(client.ids(client.template.fdEditors), [MEMBER_ID]);
    assert.deepEqual(client.ids(client.template.fdAllReaders), [MEMBER_ID]);
    assert.deepEqual(client.ids(client.template.fdAllEditors), [MEMBER_ID]);
    assert.deepEqual(client.ids(client.workflow.fdEditors), [MEMBER_ID]);
    client.template = originalTemplate;
    client.workflow = originalWorkflow;
    const bypassAttempt = await repairLockedDraft(fixture.dsl, repairOptions(fixture, {
      client,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport,
      repairKind: "template_authorization",
      confirmWrite: true,
      expectedEvidenceDigest: preview.evidenceDigest,
      artifactsDir: join(root, "different-execution-directory")
    }));
    assert.equal(bypassAttempt.ok, false);
    assert.equal(client.calls.filter((call) => call.operation === "update-template").length, 1);
    assert.equal(client.calls.filter((call) => call.operation === "save-workflow-draft").length, 1);
    assert.equal(client.calls.filter((call) => call.operation === "add-transfer-record").length, 1);
    assert.equal(client.calls.some((call) => call.operation === "add-template"), false);
  });

  it("repairs only the three calculation-native paths without saving workflow", async (t) => {
    const fixture = calculationFixture();
    const client = new LockedDraftFakeClient(fixture.template);
    const preview = await repairLockedDraft(fixture.dsl, repairOptions(fixture, {
      client,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport,
      repairKind: "calculation"
    }));

    assert.equal(preview.ok, true, JSON.stringify(preview.diagnostics));
    assert.equal(preview.status, "repair_ready");
    assert.deepEqual(preview.plan.changedPaths, [
      "/mechanisms/sys-xform/fdConfig/attribute/formAttr/formRule/compute",
      "/mechanisms/sys-xform/fdConfig/dataModel[detail:table]/fdFields[fd_35523eceb856e4]/fdAttribute/config/controlProps/expressionFormulaVO",
      "/mechanisms/sys-xform/fdConfig/sign/formula/fd_35523eceb856e4.expressionFormulaVO"
    ]);
    assert.equal(client.hasWrite(), false);

    const root = mkdtempSync(join(tmpdir(), "mk-locked-calculation-repair-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const result = await repairLockedDraft(fixture.dsl, repairOptions(fixture, {
      client,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport,
      repairKind: "calculation",
      confirmWrite: true,
      expectedEvidenceDigest: preview.evidenceDigest,
      artifactsDir: join(root, "execution")
    }));

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.status, "repaired_and_recorded");
    assert.equal(client.calls.filter((call) => call.operation === "update-template").length, 1);
    assert.equal(client.calls.some((call) => call.operation === "save-workflow-draft"), false);
    assert.equal(client.calls.filter((call) => call.operation === "add-transfer-record").length, 1);
  });

  it("fails readback and withholds the record when unrelated native state changes", async (t) => {
    const fixture = authorizationFixture();
    const client = new LockedDraftFakeClient(fixture.template, fixture.workflow);
    const preview = await repairLockedDraft(fixture.dsl, repairOptions(fixture, {
      client,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport,
      repairKind: "template_authorization"
    }));
    const root = mkdtempSync(join(tmpdir(), "mk-locked-unrelated-change-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    client.afterWorkflowSave = () => {
      const config = JSON.parse(client.template.mechanisms["sys-xform"].fdConfig);
      config.manualSetting = { changedOutsideRepair: true };
      client.template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    };

    const result = await repairLockedDraft(fixture.dsl, repairOptions(fixture, {
      client,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport,
      repairKind: "template_authorization",
      confirmWrite: true,
      expectedEvidenceDigest: preview.evidenceDigest,
      artifactsDir: join(root, "execution")
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, "readback_failed");
    assert.equal(client.calls.some((call) => call.operation === "add-transfer-record"), false);
  });

  it("locks an uncertain two-stage authorization repair before any retry", async (t) => {
    const fixture = authorizationFixture();
    const client = new LockedDraftFakeClient(fixture.template, fixture.workflow);
    const preview = await repairLockedDraft(fixture.dsl, repairOptions(fixture, {
      client,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport,
      repairKind: "template_authorization"
    }));
    const root = mkdtempSync(join(tmpdir(), "mk-locked-uncertain-repair-"));
    const artifactsDir = join(root, "execution");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    client.failWorkflowSave = true;
    const options = repairOptions(fixture, {
      client,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport,
      repairKind: "template_authorization",
      confirmWrite: true,
      expectedEvidenceDigest: preview.evidenceDigest,
      artifactsDir
    });

    const first = await repairLockedDraft(fixture.dsl, options);
    const second = await repairLockedDraft(fixture.dsl, options);

    assert.equal(first.ok, false);
    assert.equal(first.writeOutcomeUnknown, true);
    assert.equal(second.ok, false);
    assert.equal(client.calls.filter((call) => call.operation === "update-template").length, 1);
    assert.equal(client.calls.filter((call) => call.operation === "save-workflow-draft").length, 1);
    assert.equal(client.calls.some((call) => call.operation === "add-transfer-record"), false);
  });

  it("blocks a calculation repair when an allowlisted path drifted after the failure report", async () => {
    const fixture = calculationFixture();
    const config = JSON.parse(fixture.template.mechanisms["sys-xform"].fdConfig);
    const formAttr = JSON.parse(config.attribute.formAttr);
    formAttr.formRule.compute = [{ id: "manual-compute-after-failure" }];
    config.attribute.formAttr = JSON.stringify(formAttr);
    fixture.template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
    const client = new LockedDraftFakeClient(fixture.template);

    const result = await repairLockedDraft(fixture.dsl, repairOptions(fixture, {
      client,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport,
      repairKind: "calculation"
    }));

    assert.equal(result.ok, false);
    assert.equal(client.hasWrite(), false);
  });
});

function authorizationFixture() {
  const sourceDraft = cleanSourceFile(
    "tests/fixtures/route-validation/workflow-data-authority"
  );
  const sourceMember = {
    type: "user_or_org",
    sourceId: MEMBER_ID,
    name: "Legacy Maintainer",
    sourceOrgType: 8,
    sourceOrgClass: "com.landray.kmss.sys.organization.model.SysOrgPerson",
    sourceLoginName: "legacy-maintainer",
    sourceRef: "source.template.authorization.authAllEditors.0"
  };
  sourceDraft.template.authorization = {
    readerFlag: false,
    readers: [],
    editors: [],
    allReaders: [structuredClone(sourceMember)],
    allEditors: [structuredClone(sourceMember)],
    temporaryReaders: [],
    temporaryEditors: []
  };
  const dslDraft = draftSourceDraft(sourceDraft);
  const dsl = createTrustedMigrationDsl(sourceDraft, dslDraft, {
    externalAgentReviewed: true,
    reviewerName: "route-validation",
    checkedAt: "2026-09-01T00:00:00.000Z",
    sourceDraftDigest: sha256Digest(sourceDraft),
    dslDraftDigest: sha256Digest(dslDraft)
  });
  const resolved = structuredClone(dsl);
  for (const key of ["allReaders", "allEditors"]) {
    Object.assign(resolved.template.authorization[key][0], {
      id: MEMBER_ID,
      name: "Current Maintainer",
      targetOrgType: 8
    });
  }
  const base = sampleBaseTemplate({
    fdId: TARGET_TEMPLATE_ID,
    fdName: "MK_TEST_授权修复_20260901120000",
    fdCategory: { fdId: CATEGORY_ID },
    mechanisms: {
      "sys-xform": {
        fdId: TARGET_TEMPLATE_ID,
        fdName: "MK_TEST_授权修复_20260901120000",
        fdTableName: "mk_model_locked_auth",
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
    dsl: resolved,
    envelope: sampleEnvelope({
      templateId: TARGET_TEMPLATE_ID,
      templateName: base.fdName,
      categoryId: CATEGORY_ID,
      tableName: "mk_model_locked_auth",
      bindings: {
        formFdId: TARGET_TEMPLATE_ID,
        workflowFdId: WORKFLOW_TEMPLATE_ID
      }
    }),
    baseTemplate: base
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
  const desired = applyRequiredTemplateNumberRule(structuredClone(prepared.update));
  Object.assign(desired.mechanisms.lbpmTemplate[0], workflowEnvelope());
  const template = structuredClone(desired);
  for (const key of ["fdEditors", "fdAllReaders", "fdAllEditors"]) template[key] = [];
  template.mechanisms.lbpmTemplate[0].fdEditors = [];
  const workflow = structuredClone(template.mechanisms.lbpmTemplate[0]);
  const plan = buildDryRunPlan(dsl);
  const priorExecutionReport = {
    ok: false,
    status: "readback_failed",
    stage: "readback",
    failedAt: "readback",
    baseUrl: "https://p-sit.onewo.com",
    templateId: TARGET_TEMPLATE_ID,
    createdFdIds: [TARGET_TEMPLATE_ID],
    updatedFdIds: [],
    readback: { ok: false, status: "readback_failed" },
    diagnostics: [{
      level: "error",
      code: "readback.workflow.template_authorization_mismatch",
      details: {
        expected: {
          readers: [], editors: [], allReaders: [MEMBER_ID], allEditors: [MEMBER_ID],
          temporaryReaders: [], temporaryEditors: []
        },
        actual: {
          readers: [], editors: [], allReaders: [], allEditors: [],
          temporaryReaders: [], temporaryEditors: []
        }
      }
    }],
    apiStages: [
      {
        name: "resolveWorkflowParticipants",
        status: "ok",
        overrides: [{
          sourceEvidence: { sourceId: MEMBER_ID },
          target: { fdId: MEMBER_ID, fdName: "Current Maintainer", fdOrgType: 8 },
          paths: [
            "/template/authorization/allReaders/0",
            "/template/authorization/allEditors/0"
          ]
        }]
      },
      { name: "add", status: "ok" },
      { name: "update", status: "ok" },
      { name: "saveWorkflowDraft", status: "ok" },
      { name: "getWorkflowTemplateDetail", status: "ok" },
      { name: "readback", status: "ok" }
    ],
    plan
  };
  return {
    sourceDraft,
    dsl,
    template,
    workflow,
    priorExecutionReport,
    dslDigest: lockedDraftEvidenceDigest(dsl),
    priorReportDigest: lockedDraftEvidenceDigest(priorExecutionReport)
  };
}

function calculationFixture() {
  const sourceDraft = cleanSourceFile(
    "tests/fixtures/source4/188d28d4a52c772acda09c04a739f0c0/188d28da17a2f4450dcc7af497f9e9e3_SysFormTemplate.xml"
  );
  const priorSourceDraft = structuredClone(sourceDraft);
  priorSourceDraft.issues = [
    ...(priorSourceDraft.issues || []),
    {
      level: "warning",
      code: "source.function_not_whitelisted",
      message: "Historical parser-only warning.",
      sourcePath: "/fdDesignerHtml",
      evidence: { functionName: "legacy-sql-keyword" }
    }
  ];
  const dslDraft = draftSourceDraft(sourceDraft);
  const dsl = createTrustedMigrationDsl(sourceDraft, dslDraft, {
    externalAgentReviewed: true,
    reviewerName: "route-validation",
    checkedAt: "2026-09-01T00:00:00.000Z",
    sourceDraftDigest: sha256Digest(priorSourceDraft),
    dslDraftDigest: sha256Digest(dslDraft)
  });
  const priorDsl = structuredClone(dsl);
  priorDsl.catalogs.components.version = "2026-08-28.v14";
  const priorAggregate = findTestDslField(priorDsl, "fd_35523eca33541a");
  priorAggregate.props.calculation.tableId = "fd_legacy_table";
  delete findTestDslField(priorDsl, "fd_35523eceb856e4").props.calculation;
  const base = sampleBaseTemplate({
    fdId: TARGET_TEMPLATE_ID,
    fdName: "MK_TEST_计算修复_20260901120000",
    fdCategory: { fdId: CATEGORY_ID },
    mechanisms: {
      "sys-xform": {
        fdId: TARGET_TEMPLATE_ID,
        fdName: "MK_TEST_计算修复_20260901120000",
        fdTableName: "mk_model_locked_calculation",
        fdStatus: "draft",
        fdConfig: "{}"
      },
      lbpmTemplate: []
    }
  });
  const prepared = preparePersistedTemplate({
    dsl,
    envelope: sampleEnvelope({
      templateId: TARGET_TEMPLATE_ID,
      templateName: base.fdName,
      categoryId: CATEGORY_ID,
      tableName: "mk_model_locked_calculation",
      bindings: { formFdId: TARGET_TEMPLATE_ID, workflowFdId: "" }
    }),
    baseTemplate: base
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
  const desired = applyRequiredTemplateNumberRule(structuredClone(prepared.update));
  const template = structuredClone(desired);
  const config = JSON.parse(template.mechanisms["sys-xform"].fdConfig);
  const formAttr = JSON.parse(config.attribute.formAttr);
  formAttr.formRule.compute = [];
  config.attribute.formAttr = JSON.stringify(formAttr);
  const detail = config.dataModel.find((model) => (
    model.fdType === "detail" && model.dynamicProps?.detailFieldName === "table"
  ));
  detail.dynamicProps = {};
  const rowField = detail.fdFields.find((field) => field.fdName === "fd_35523eceb856e4");
  const rowAttribute = JSON.parse(rowField.fdAttribute);
  delete rowAttribute.config.controlProps.expressionFormulaVO;
  rowField.fdAttribute = JSON.stringify(rowAttribute);
  delete config.sign.formula["fd_35523eceb856e4.expressionFormulaVO"];
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  const plan = buildDryRunPlan(dsl);
  const priorPlan = structuredClone(plan);
  priorPlan.catalogs.components.version = "2026-08-28.v14";
  const priorExecutionReport = {
    ok: false,
    status: "readback_failed",
    stage: "readback",
    failedAt: "readback",
    baseUrl: "https://p-sit.onewo.com",
    templateId: TARGET_TEMPLATE_ID,
    createdFdIds: [TARGET_TEMPLATE_ID],
    updatedFdIds: [],
    readback: { ok: false, status: "readback_failed" },
    diagnostics: [
      {
        level: "error",
        code: "readback.form.calculation_order_mismatch",
        details: { expected: ["fd_35523eca33541a"], actual: [] }
      },
      {
        level: "error",
        code: "readback.form.prop_calculation_mismatch",
        details: {
          fieldId: "fd_35523eca33541a",
          expected: {
            kind: "aggregate",
            operation: "sum",
            tableId: "fd_legacy_table",
            fieldId: "fd_35523eceb856e4"
          }
        }
      }
    ],
    apiStages: [
      { name: "add", status: "ok" },
      { name: "update", status: "ok" },
      { name: "readback", status: "ok" }
    ],
    plan: priorPlan
  };
  return {
    sourceDraft,
    priorSourceDraft,
    dsl,
    priorDsl,
    template,
    priorExecutionReport,
    dslDigest: lockedDraftEvidenceDigest(dsl),
    priorDslDigest: lockedDraftEvidenceDigest(priorDsl),
    priorSourceDraftDigest: lockedDraftEvidenceDigest(priorSourceDraft),
    priorReportDigest: lockedDraftEvidenceDigest(priorExecutionReport)
  };
}

function repairOptions(fixture, overrides = {}) {
  const options = {
    credentials: CREDENTIALS,
    confirmWrite: false,
    targetCategoryId: CATEGORY_ID,
    targetTemplateId: TARGET_TEMPLATE_ID,
    baseUrl: "https://p-sit.onewo.com",
    expectedDslDigest: fixture.dslDigest,
    expectedPriorReportDigest: fixture.priorReportDigest,
    ...(fixture.priorDsl ? {
      priorDsl: fixture.priorDsl,
      expectedPriorDslDigest: fixture.priorDslDigest
    } : {}),
    ...(fixture.priorSourceDraft ? {
      priorSourceDraft: fixture.priorSourceDraft,
      expectedPriorSourceDraftDigest: fixture.priorSourceDraftDigest
    } : {}),
    transferRecordIdFactory: () => "lockedrepair000000000000000000000000",
    ...overrides
  };
  if (overrides.artifactsDir && !overrides.testLockRoot) {
    options.testLockRoot = join(overrides.artifactsDir, "..", "locks");
  }
  return options;
}

function findTestDslField(dsl, fieldId) {
  for (const field of dsl.form.fields || []) {
    if (field.id === fieldId) return field;
    if (field.type === "detailTable") {
      const column = (field.columns || []).find((candidate) => candidate.id === fieldId);
      if (column) return column;
    }
  }
  return undefined;
}

function workflowEnvelope() {
  return {
    fdEntityId: TARGET_TEMPLATE_ID,
    fdCategory: { fdId: CATEGORY_ID },
    fdContentType: "json",
    fdSystemCode: "INNER_SYSTEM",
    fdRunType: 1,
    fdDisableBpmInit: false,
    fdFormCategory: { fdFormCategoryId: CATEGORY_ID },
    fdStatus: "draft",
    isDraft: true
  };
}

class LockedDraftFakeClient {
  constructor(template, workflow) {
    this.template = structuredClone(template);
    this.workflow = structuredClone(workflow);
    this.calls = [];
  }

  async login() { this.calls.push({ operation: "login" }); }
  async assertTransferRecordAuthentication() {
    this.calls.push({ operation: "transfer-record-auth-preflight" });
  }
  async getTemplate() {
    this.calls.push({ operation: "get-template" });
    return structuredClone(this.template);
  }
  async getWorkflowTemplateDetail() {
    this.calls.push({ operation: "get-workflow-detail" });
    return structuredClone(this.workflow);
  }
  async getElementInfo(targets) {
    this.calls.push({ operation: "get-element-info", targets });
    return targets.map((fdId) => ({ fdId, fdName: "Current Maintainer", fdOrgType: 8 }));
  }
  async updateTemplate(payload) {
    this.calls.push({ operation: "update-template" });
    this.template = structuredClone(payload);
    return { fdId: payload.fdId };
  }
  async saveWorkflowDraft(payload) {
    this.calls.push({ operation: "save-workflow-draft" });
    if (this.failWorkflowSave) throw new Error("unknown workflow-save outcome");
    this.workflow = structuredClone(payload);
    this.template.mechanisms.lbpmTemplate[0] = structuredClone(payload);
    this.afterWorkflowSave?.();
    return { fdId: payload.fdId };
  }
  async addTransferRecord(payload) {
    this.calls.push({ operation: "add-transfer-record", payload: structuredClone(payload) });
    return { fdId: payload.fdId };
  }
  async addTemplate() {
    this.calls.push({ operation: "add-template" });
    throw new Error("locked repair must not create templates");
  }
  ids(values) {
    return (values || []).map((value) => value.fdId).sort();
  }
  hasWrite() {
    return this.calls.some((call) => [
      "update-template", "save-workflow-draft", "add-transfer-record", "add-template"
    ].includes(call.operation));
  }
}
