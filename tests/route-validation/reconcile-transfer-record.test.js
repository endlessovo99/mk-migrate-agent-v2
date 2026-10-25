import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { draftSourceDraft, cleanSourceFile } from "../../src/translator/index.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { attachMigrationPolicies, migrationPolicySourceDigest } from "../../src/translator/approved-migration-policies.js";
import { buildRadioReadOnlyPresentationDecision } from "../../src/translator/radio-readonly-presentation.js";
import { sha256Digest } from "../../src/agent-review/digest.js";
import { NEWOA_SIT_BASE_URL } from "../../src/executor/newoa-client.js";
import {
  reconcileTransferRecord,
  reconciliationEvidenceDigest
} from "../../src/executor/reconcile-transfer-record.js";
import { sampleSourceDraft, sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareRequiredTemplateTheme } from "../../src/executor/template-theme.js";

const TARGET_TEMPLATE_ID = "reconcile-target-template-id";
const WORKFLOW_TEMPLATE_ID = "reconcile-workflow-template-id";
const CATEGORY_ID = "reconcile-category-id";
const NOW = new Date("2026-09-01T04:00:00.000Z");
const CREDENTIALS = Object.freeze({
  username: "route-reconcile-user",
  encryptedPassword: "route-reconcile-encrypted-password"
});

describe("transfer-record reconciliation Route", () => {
  it("does not reconcile a valid new readonly-radio policy through the retained v14 metadata bridge", async () => {
    const raw = cleanSourceFile("tests/fixtures/route-validation/radio-readonly-presentation");
    const stripFlow = value => { if (value && typeof value === "object") { delete value.contentFlow; Object.values(value).forEach(stripFlow); } };
    stripFlow(raw.form.layout);
    const decision = buildRadioReadOnlyPresentationDecision(raw, ["source.form.control.fd_leader"]);
    const sourceDraft = attachMigrationPolicies(raw, { version: 1, sourceDraftSha256: migrationPolicySourceDigest(raw),
      scope: { baseUrl: NEWOA_SIT_BASE_URL, targetCategoryId: CATEGORY_ID },
      authorization: { actor: "hypothetical-fixture-only", evidenceSha256: sha256Digest("No real authorization") }, decisions: [decision] });
    const draft = draftSourceDraft(sourceDraft), dsl = createTrustedMigrationDsl(sourceDraft, draft, {
      externalAgentReviewed: true, reviewerName: "fixture", sourceDraftDigest: sha256Digest(sourceDraft)
    });
    assert.equal(checkTrust(sourceDraft, dsl).ok, true);
    const fixture = reconciliationFixture();
    fixture.dsl = dsl; fixture.sourceDraft = sourceDraft;
    fixture.dsl.catalogs.components.version = "2026-08-28.v14";
    fixture.priorExecutionReport.plan.catalogs.components.version = "2026-08-28.v14";
    fixture.dslDigest = reconciliationEvidenceDigest(fixture.dsl);
    fixture.priorReportDigest = reconciliationEvidenceDigest(fixture.priorExecutionReport);
    const client = new ReconciliationFakeClient(fixture.template);
    const result = await reconcileTransferRecord(fixture.dsl, reconcileOptions(fixture, { client, sourceDraft, priorExecutionReport: fixture.priorExecutionReport }));
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(d => d.code === "catalog.components.version_mismatch"), JSON.stringify(result.diagnostics));
    assert.equal(client.calls.length, 0);
  });

  it("does not bridge v14 input maxLength even when its v19 source proof is otherwise valid", async () => {
    const fixture = reconciliationFixture();
    const field = fixture.dsl.form.fields.find((field) => field.componentId === "xform-input");
    const source = fixture.sourceDraft.form.controls.find((source) => source.sourceRef === field.sourceRef);
    source.sourceProps = { designerValues: { maxlength: "18" }, metadataAttributes: { length: "18" } };
    field.props.maxLength = 18;
    fixture.dsl.review.warnings.push(...draftSourceDraft(fixture.sourceDraft).review.warnings.filter((warning) => warning.code === "source.form.input_length_target_counting"));
    fixture.dsl.trust.digests.sourceDraft = sha256Digest(fixture.sourceDraft);
    assert.equal(checkTrust(fixture.sourceDraft, fixture.dsl).ok, true);
    fixture.dsl.catalogs.components.version = "2026-08-28.v14";
    fixture.priorExecutionReport.plan.catalogs.components.version = "2026-08-28.v14";
    fixture.dslDigest = reconciliationEvidenceDigest(fixture.dsl);
    fixture.priorReportDigest = reconciliationEvidenceDigest(fixture.priorExecutionReport);
    const client = new ReconciliationFakeClient(fixture.template);
    const result = await reconcileTransferRecord(fixture.dsl, reconcileOptions(fixture, {
      client, sourceDraft: fixture.sourceDraft, priorExecutionReport: fixture.priorExecutionReport
    }));
    assert.equal(result.ok, false);
    assert.equal(client.calls.length, 0);
    assert.ok(result.diagnostics.some((item) => item.code === "catalog.components.version_mismatch"));
  });

  it("keeps the v14 bridge tied to the exact retained version and report digest", async () => {
    for (const mutation of ["other-version", "report-version", "stale-report-digest"]) {
      const fixture = reconciliationFixture();
      fixture.dsl.catalogs.components.version = mutation === "other-version" ? "2026-10-15.v17" : "2026-08-28.v14";
      fixture.priorExecutionReport.plan.catalogs.components.version = mutation === "report-version" ? "2026-10-15.v17" : fixture.dsl.catalogs.components.version;
      fixture.dslDigest = reconciliationEvidenceDigest(fixture.dsl);
      fixture.priorReportDigest = reconciliationEvidenceDigest(fixture.priorExecutionReport);
      if (mutation === "stale-report-digest") fixture.priorExecutionReport.templateId = "tampered-retained-target";
      const client = new ReconciliationFakeClient(fixture.template);
      const result = await reconcileTransferRecord(fixture.dsl, reconcileOptions(fixture, {
        client, sourceDraft: fixture.sourceDraft, priorExecutionReport: fixture.priorExecutionReport
      }));
      assert.equal(result.ok, false, mutation);
      assert.equal(client.calls.length, 0, mutation);
      assert.ok(result.diagnostics.some((item) => item.code === (mutation === "stale-report-digest" ? "reconcile.prior_report_digest_mismatch" : "catalog.components.version_mismatch")));
    }
  });
  it("rejects missing native cooperation without inventing a default during record-only recovery", async () => {
    const fixture = reconciliationFixture();
    const client = new ReconciliationFakeClient(fixture.template);
    const workflow = client.template.mechanisms.lbpmTemplate[0];
    const content = JSON.parse(workflow.fdContent);
    delete content.elements.find(node => node.id === "N2").cooperateType;
    workflow.fdContent = JSON.stringify(content);
    const result = await reconcileTransferRecord(fixture.dsl, reconcileOptions(fixture, {
      client, sourceDraft: fixture.sourceDraft, priorExecutionReport: fixture.priorExecutionReport
    }));
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(item => item.code === "readback.workflow.cooperation_type_mismatch"));
    assert.equal(client.hasTemplateWrite(), false);
    assert.equal(client.operations().includes("add-transfer-record"), false);
  });

  it("retains a recorded theme requirement during reconciliation without rewriting the theme", async () => {
    const fixture = reconciliationFixture();
    fixture.priorExecutionReport.readback.theme = { contractVersion: 1, status: "mismatch", desktop: "classic", mobile: "classic" };
    fixture.priorReportDigest = reconciliationEvidenceDigest(fixture.priorExecutionReport);
    const client = new ReconciliationFakeClient(fixture.template);
    const options = reconcileOptions(fixture, {
      client, sourceDraft: fixture.sourceDraft, priorExecutionReport: fixture.priorExecutionReport
    });
    const missing = await reconcileTransferRecord(fixture.dsl, options);
    assert.equal(missing.ok, false);
    assert.equal(missing.readback.theme.status, "mismatch");
    assert.equal(client.hasTemplateWrite(), false);
    assert.equal(client.operations().includes("add-transfer-record"), false);

    client.template = prepareRequiredTemplateTheme(fixture.template).update;
    const retained = await reconcileTransferRecord(fixture.dsl, options);
    assert.equal(retained.ok, true, JSON.stringify(retained.diagnostics));
    assert.equal(retained.readback.theme.status, "verified");
    assert.equal(client.hasTemplateWrite(), false);
  });

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
    const bypassAttempt = await reconcileTransferRecord(fixture.dsl, reconcileOptions(fixture, {
      client,
      confirmWrite: true,
      expectedEvidenceDigest: preview.evidenceDigest,
      artifactsDir: join(artifactsRoot, "different-execution-directory"),
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport
    }));
    assert.equal(bypassAttempt.ok, false);
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

  it("bridges evidenced v14 to current v19 only for readback verification", async () => {
    const fixture = reconciliationFixture();
    assert.equal(fixture.dsl.catalogs.components.version, "2026-10-25.v19");
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

  for (const change of [
    ...[true, false].map((readOnly) => ({ name: `new hyperlink readOnly=${readOnly} capability`, mutate(dsl) {
      const field = dsl.form.fields.find((candidate) => candidate.type !== "detailTable");
      field.type = "hyperlinks";
      field.componentId = "xform-hyperlinks";
      field.props = { readOnly };
    } })),
    { name: "content-flow layout", mutate(dsl) {
      const cell = dsl.form.layout.mkTree.flatMap((row) => row.children).find((cell) => cell.refType === "field");
      cell.contentFlow = { lines: [cell.refIds], items: cell.refIds.map((referenceId) => ({ referenceId })) };
    } },
    { name: "new detail-table hidden-label capability", mutate(dsl) {
      dsl.form.fields.find((field) => field.componentId === "xform-detail-table").props.hiddenLabel = true;
    } }
  ]) {
    it(`does not bridge v14 evidence containing ${change.name}`, async () => {
      const fixture = reconciliationFixture();
      fixture.dsl.catalogs.components.version = "2026-08-28.v14";
      fixture.priorExecutionReport.plan.catalogs.components.version = "2026-08-28.v14";
      change.mutate(fixture.dsl);
      fixture.dslDigest = reconciliationEvidenceDigest(fixture.dsl);
      fixture.priorReportDigest = reconciliationEvidenceDigest(fixture.priorExecutionReport);
      const client = new ReconciliationFakeClient(fixture.template);
      const result = await reconcileTransferRecord(fixture.dsl, reconcileOptions(fixture, {
        client, sourceDraft: fixture.sourceDraft, priorExecutionReport: fixture.priorExecutionReport
      }));
      assert.equal(result.ok, false);
      assert.equal(client.calls.length, 0);
    });
  }

  it("blocks new participant or fallback choices outside the retained execution evidence", async () => {
    const fixture = reconciliationFixture();
    const client = new ReconciliationFakeClient(fixture.template);

    const result = await reconcileTransferRecord(fixture.dsl, reconcileOptions(fixture, {
      client,
      sourceDraft: fixture.sourceDraft,
      priorExecutionReport: fixture.priorExecutionReport,
      participantOverrides: [{ sourceId: "new", targetFdId: "new" }]
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(client.calls.length, 0);
  });
});

function reconciliationFixture() {
  const sourceDraft = sampleSourceDraft();
  sourceDraft.form.detailTables[0].columns.push({
    id: "fd_code",
    sourceRef: "source.form.detailTable.fd_detail.column.fd_code"
  });
  sourceDraft.workflow.nodes.push({ id: "N3", sourceRef: "source.workflow.node.N3" });
  sourceDraft.workflow.edges.push({ id: "L2", sourceRef: "source.workflow.edge.L2" });
  const dsl = independentDetailAuthorityDsl();
  dsl.trust.digests = {
    sourceDraft: sha256Digest(sourceDraft),
    dslDraft: "sha256:tracked-independent-native-evidence"
  };

  const template = JSON.parse(readFileSync(
    "tests/fixtures/executor/persistence/form-only-native-readback.json",
    "utf8"
  ));
  Object.assign(template, {
    fdId: TARGET_TEMPLATE_ID,
    fdCategory: { fdId: CATEGORY_ID }
  });
  Object.assign(template.mechanisms["sys-xform"], {
    fdId: TARGET_TEMPLATE_ID,
    fdStatus: "draft"
  });
  const config = JSON.parse(template.mechanisms["sys-xform"].fdConfig);
  const formAttr = JSON.parse(config.attribute.formAttr);
  formAttr.subjectRule = {};
  config.attribute.formAttr = JSON.stringify(formAttr);
  const detailModel = config.dataModel.find((model) => (
    model.fdType === "detail" && model.dynamicProps?.detailFieldName === "fd_detail"
  ));
  const nameField = detailModel.fdFields.find((field) => field.fdName === "fd_name");
  const codeField = structuredClone(nameField);
  Object.assign(codeField, {
    fdId: "native-detail-code-field-id",
    fdLabel: "编码",
    fdName: "fd_code",
    fdOrder: 2
  });
  const codeAttribute = JSON.parse(codeField.fdAttribute);
  codeAttribute.uuid = "fd_code";
  codeAttribute.config.key = "@elem/xform-input~native-code";
  Object.assign(codeAttribute.config.controlProps, {
    id: "@elem/xform-input~native-code",
    name: "fd_code",
    uuid: "fd_code",
    title: "编码"
  });
  Object.assign(codeAttribute.config, { label: "编码" });
  codeAttribute.config.labelProps.title = "编码";
  codeField.fdAttribute = JSON.stringify(codeAttribute);
  detailModel.fdFields.splice(1, 0, codeField);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
  template.mechanisms.sysnumber = [JSON.parse(readFileSync(
    "tests/fixtures/route-validation/template-number-rule/expected-number-rule.json",
    "utf8"
  ))];

  const nativeWorkflow = JSON.parse(readFileSync(
    "tests/fixtures/executor/persistence/workflow-detail-authority-native.json",
    "utf8"
  ));
  nativeWorkflow.fdContent.elements.find(node => node.id === "N2").cooperateType = "2";
  const viewOnly = { isShow: true, isEdit: false, isRequire: false };
  const operations = nativeWorkflow.fdTemplateFormAuths.N2.fd_detail.operations;
  nativeWorkflow.fdTemplateFormAuths.N2 = {
    "fd_detail.fd_name": structuredClone(viewOnly),
    "fd_detail.fd_code": structuredClone(viewOnly),
    fd_detail: { ...viewOnly, operations }
  };
  const workflow = {
    ...template.mechanisms.lbpmTemplate[0],
    fdId: WORKFLOW_TEMPLATE_ID,
    fdContent: JSON.stringify(nativeWorkflow.fdContent),
    fdTemplateFormAuths: nativeWorkflow.fdTemplateFormAuths,
    fdContentType: "json",
    fdSystemCode: "INNER_SYSTEM",
    fdRunType: 1,
    fdDisableBpmInit: false,
    fdFormCategory: { fdFormCategoryId: CATEGORY_ID },
    fdStatus: "draft",
    isDraft: true
  };
  template.mechanisms.lbpmTemplate = [structuredClone(workflow)];
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
    dslDigest: reconciliationEvidenceDigest(dsl),
    priorReportDigest: reconciliationEvidenceDigest(priorExecutionReport)
  };
}

function independentDetailAuthorityDsl() {
  const dsl = sampleTrustedDsl();
  const detail = dsl.form.fields.find((field) => field.id === "fd_detail");
  detail.columns.push({
    id: "fd_code",
    title: "编码",
    type: "text",
    componentId: "xform-input",
    props: {},
    sourceProps: { metadataKind: "simple" },
    sourceRef: "source.form.detailTable.fd_detail.column.fd_code",
    generated: false
  });
  const viewOnly = { visible: true, editable: false, required: false };
  dsl.workflow = {
    process: { id: "process-detail-authority" },
    nodes: [
      {
        id: "N1", type: "generalStart", element: "startEvent", name: "开始",
        sourceType: "startNode", sourceRef: "source.workflow.node.N1",
        attributes: {}, translationStatus: "executable"
      },
      {
        id: "N2", type: "review", element: "manualTask", name: "明细权限节点",
        sourceType: "reviewNode", sourceRef: "source.workflow.node.N2",
        attributes: {}, translationStatus: "executable",
        dataAuthority: {
          enabled: true,
          fields: {
            fd_detail: viewOnly,
            fd_name: viewOnly,
            fd_code: viewOnly
          }
        }
      },
      {
        id: "N3", type: "generalEnd", element: "endEvent", name: "结束",
        sourceType: "endNode", sourceRef: "source.workflow.node.N3",
        attributes: {}, translationStatus: "executable"
      }
    ],
    edges: [
      testEdge("L1", "N1", "N2"),
      testEdge("L2", "N2", "N3")
    ],
    topologicalOrder: ["N1", "N2", "N3"]
  };
  return dsl;
}

function testEdge(id, source, target) {
  return {
    id,
    source,
    target,
    name: "",
    sourceRef: `source.workflow.edge.${id}`,
    attributes: {},
    condition: {
      sourceText: "",
      displayText: "",
      targetText: "",
      translationStatus: "executable"
    }
  };
}

function reconcileOptions(fixture, overrides = {}) {
  const options = {
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
  if (overrides.artifactsDir && !overrides.testLockRoot) {
    options.testLockRoot = join(overrides.artifactsDir, "..", "locks");
  }
  return options;
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
