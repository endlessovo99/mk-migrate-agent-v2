import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sha256Digest } from "../../src/agent-review/digest.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { reconcileTransferRecord, reconciliationEvidenceDigest } from "../../src/executor/reconcile-transfer-record.js";
import { applyRequiredTemplateNumberRule } from "../../src/executor/template-number-rule.js";
import { prepareSample } from "../helpers/persistence.js";
import { sampleSourceDraft, sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { withNetworkGuard } from "./network-guard.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/route-validation/reconcile-retained-authorization/authorization.json", import.meta.url), "utf8"));
const origin = "https://oaqas.shanghai-electric.com";
const pathReader = "/template/authorization/allReaders/0";
const pathEditor = "/template/authorization/allEditors/0";

describe("retained singleton authorization reconciliation Route", () => {
  it("binds only historical singleton identities, uses exact lookup, and records once after full double readback", async (t) => {
    await withNetworkGuard(async () => {
      const f = scenario();
      const before = JSON.stringify({ dsl: f.dsl, source: f.source, report: f.report });
      const client = new Client(f.template);
      const preview = await reconcileTransferRecord(f.dsl, options(f, client));
      assert.equal(preview.ok, true, JSON.stringify(preview.diagnostics));
      assert.equal(preview.status, "verified_unrecorded");
      assert.equal(preview.readback.ok, true);
      assert.deepEqual(client.calls.filter(c => c.operation === "exact").map(c => c.ids), [["reader-r"], ["editor-e"]]);
      assert.equal(client.calls.filter(c => c.operation === "get-template").length, 2);
      assert.deepEqual(preview.priorResolutionEvidence.map(e => e.paths[0]), [pathReader, pathEditor]);
      assert.ok(preview.priorResolutionEvidence.every(e => e.kind === "retained_singleton_authorization"));
      assert.equal(JSON.stringify({ dsl: f.dsl, source: f.source, report: f.report }), before);
      const directory = mkdtempSync(join(tmpdir(), "retained-auth-route-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const confirm = { confirmWrite: true, expectedEvidenceDigest: preview.evidenceDigest, artifactsDir: join(directory, "attempt"), testLockRoot: join(directory, "locks") };
      const result = await reconcileTransferRecord(f.dsl, options(f, client, confirm));
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(result.status, "transfer_record_recorded");
      const again = await reconcileTransferRecord(f.dsl, options(f, client, { ...confirm, artifactsDir: join(directory, "another") }));
      assert.equal(again.ok, false);
      assert.equal(client.calls.filter(c => c.operation === "record").length, 1);
      assert.equal(client.calls.some(c => ["search", "template-write"].includes(c.operation)), false);
    });
  });

  for (const [name, mutate] of [
    ["missing type", f => { delete f.dsl.template.authorization.allReaders[0].sourceOrgType; }],
    ["wrong type", f => { for (const a of [f.dsl.template.authorization, f.source.template.authorization]) a.allReaders[0].sourceOrgType = 4; }],
    ["wrong source class", f => { for (const a of [f.dsl.template.authorization, f.source.template.authorization]) a.allReaders[0].sourceOrgClass = "com.landray.kmss.sys.organization.model.SysOrgDept"; }],
    ["source mismatch", f => { f.source.template.authorization.allReaders[0].sourceId = "another-source"; }],
    ["multiple source members", f => { f.dsl.template.authorization.allReaders.push({ ...f.dsl.template.authorization.allReaders[0], sourceId: "second-source" }); }],
    ["other collection", f => { f.dsl.template.authorization.temporaryReaders = [structuredClone(f.dsl.template.authorization.allReaders[0])]; }],
    ["editor is not retained same ID", f => { f.dsl.template.authorization.allEditors[0].sourceId = "old-editor"; f.source.template.authorization.allEditors[0].sourceId = "old-editor"; }],
    ["multiple expected members", f => { f.report.diagnostics[1].details.expected.allReaders.push("second-target"); }],
    ["duplicate expected member", f => { f.report.diagnostics[1].details.expected.allReaders.push("reader-r"); }],
    ["wrong expected collection", f => { f.report.diagnostics[1].details.expected.readers = ["other-reader"]; }],
    ["new invariant", f => { f.report.readback.invariantVersion = 30; }],
    ["unknown invariant", f => { delete f.report.readback.invariantVersion; }],
    ["missing resolution stage", f => { f.report.apiStages.shift(); }],
    ["duplicate resolution stage", f => { f.report.apiStages.unshift(structuredClone(f.report.apiStages[0])); }],
    ["multiple fallback references", f => { f.report.apiStages[0].fallbackCount = 2; }],
    ["multiple fallback identities", f => { f.report.apiStages[0].fallbackIdentityCount = 2; }],
    ["multiple fallback targets", f => { f.report.apiStages[0].fallbackTargetIds.push("other-reader"); }],
    ["fallback type mismatch", f => { f.report.apiStages[0].fallbackTargetsByOrgType["8"].targetOrgType = 4; }],
    ["warning mismatch", f => { f.report.diagnostics[0].details.referenceCount = 2; }],
    ["warning level", f => { f.report.diagnostics[0].level = "info"; }],
    ["missing warning level", f => { delete f.report.diagnostics[0].level; }],
    ["warning count type", f => { f.report.diagnostics[0].details.referenceCount = "1"; }],
    ["warning detail type", f => { f.report.diagnostics[0].details = []; }],
    ...["fallbackCount", "fallbackIdentityCount"].map(key => [`condition ${key}`, f => { f.report.apiStages[1][key] = 1; }]),
    ["condition fallback target", f => { f.report.apiStages[1].fallbackTargetId = "reader-r"; }],
    ["condition fallback targets", f => { f.report.apiStages[1].fallbackTargetIds = ["reader-r"]; }],
    ["condition typed fallback", f => { f.report.apiStages[1].fallbackTargetsByOrgType = { "8": { targetFdId: "reader-r" } }; }],
    ["condition count type", f => { f.report.apiStages[1].fallbackCount = "0"; }],
    ["condition target list type", f => { f.report.apiStages[1].fallbackTargetIds = {}; }],
    ["condition names", f => { f.report.apiStages[1].fallbackNames = ["department"]; }],
    ["condition warning", f => { f.report.diagnostics.push({ level: "warning", code: "workflow.condition_org_sit_fallback_applied", details: {} }); }],
    ["direct fallback evidence", f => { f.report.apiStages[0].directTargetFallbackCount = 1; }],
    ["mixed override evidence", f => { f.report.apiStages[0].overrides = [{}]; }],
    ["workflow source identity", f => { f.dsl.workflow.nodes[0].participants = { mode: "explicit", members: [structuredClone(f.dsl.template.authorization.allReaders[0])] }; }],
    ["configured formula fallback", f => { f.dsl.workflow.nodes[0].participants = { mode: "configured_person_fallback" }; }],
    ["unknown write", f => { f.report.writeOutcomeUnknown = true; }],
    ["prior callback", f => { f.report.transferRecord = { status: "recorded" }; }]
  ]) {
    it(`rejects ${name} without source search or writes`, async () => {
      const f = scenario(); mutate(f);
      f.dsl.trust.digests.sourceDraft = sha256Digest(f.source);
      const client = new Client(f.template);
      const result = await reconcileTransferRecord(f.dsl, options(f, client));
      assert.equal(result.ok, false, name);
      assert.equal(client.calls.some(c => ["search", "record", "template-write"].includes(c.operation)), false, name);
    });
  }

  for (const [name, replacement] of [
    ["missing current ID", []],
    ["wrong current ID", [{ fdId: "other-reader", fdName: "Other", fdOrgType: 8 }]],
    ["ambiguous current ID", [fixture.targets[0], fixture.targets[0]]],
    ["wrong current type", [{ ...fixture.targets[0], fdOrgType: 4 }]]
  ]) {
    it(`rejects ${name} using only the historical exact ID`, async () => {
      const f = scenario(); const client = new Client(f.template); client.readerResult = replacement;
      const result = await reconcileTransferRecord(f.dsl, options(f, client));
      assert.equal(result.ok, false);
      assert.ok(client.calls.some(c => c.operation === "exact" && c.ids[0] === "reader-r"));
      assert.equal(client.calls.some(c => ["search", "record"].includes(c.operation)), false);
    });
  }

  it("retains source/report digests, stable snapshots and complete invariants", async () => {
    for (const kind of ["dsl-digest", "report-digest", "snapshot", "invariant", "new-fallback"]) {
      const f = scenario(); const client = new Client(f.template); let extra = {};
      if (kind === "dsl-digest") extra.expectedDslDigest = "0".repeat(64);
      if (kind === "report-digest") extra.expectedPriorReportDigest = "0".repeat(64);
      if (kind === "snapshot") client.drift = true;
      if (kind === "invariant") client.template.fdAllReaders.push({ fdId: "stranger", fdName: "Stranger" });
      if (kind === "new-fallback") extra.allowTemplateAuthorizationFallback = true;
      const result = await reconcileTransferRecord(f.dsl, options(f, client, extra));
      assert.equal(result.ok, false, kind);
      assert.equal(client.calls.some(c => ["search", "record", "template-write"].includes(c.operation)), false);
    }
  });

  it("keeps already typed workflow targets unchanged and permits explicit empty condition fallback counters", async () => {
    const f = scenario(true);
    Object.assign(f.report.apiStages[1], { fallbackCount: 0, fallbackIdentityCount: 0, fallbackTargetId: "", fallbackTargetIds: [], fallbackTargetsByOrgType: {} });
    const client = new Client(f.template);
    const result = await reconcileTransferRecord(f.dsl, options(f, client));
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.deepEqual([...new Set(client.calls.filter(c => c.operation === "exact").flatMap(c => c.ids))].sort(), ["editor-e", "reader-r", "target-a", "target-b"]);
    assert.equal(client.calls.some(c => c.operation === "search"), false);
  });

  it("never replays an uncertain transfer record through another artifact directory", async (t) => {
    const f = scenario(); const client = new Client(f.template);
    const preview = await reconcileTransferRecord(f.dsl, options(f, client));
    assert.equal(preview.ok, true);
    const directory = mkdtempSync(join(tmpdir(), "retained-auth-unknown-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    client.recordError = new Error("uncertain callback");
    const confirm = { confirmWrite: true, expectedEvidenceDigest: preview.evidenceDigest, artifactsDir: join(directory, "first"), testLockRoot: join(directory, "locks") };
    const failed = await reconcileTransferRecord(f.dsl, options(f, client, confirm));
    assert.equal(failed.ok, false);
    assert.equal(failed.transferRecord.writeOutcomeUnknown, true);
    const repeated = await reconcileTransferRecord(f.dsl, options(f, client, { ...confirm, artifactsDir: join(directory, "second") }));
    assert.equal(repeated.ok, false);
    assert.equal(client.calls.filter(c => c.operation === "record").length, 1);
  });
});

function scenario(withDirectTargets = false) {
  const source = sampleSourceDraft({ template: { authorization: structuredClone(fixture.source) } });
  const dsl = sampleTrustedDsl({ template: { authorization: structuredClone(fixture.source) } });
  if (withDirectTargets) {
    source.workflow.nodes.push({ id: "N3", sourceRef: "source.workflow.node.N3" });
    source.workflow.edges.push({ id: "L2", sourceRef: "source.workflow.edge.L2" });
    dsl.workflow.nodes.splice(1, 0, { id: "N3", type: "review", element: "manualTask", name: "Typed targets", sourceType: "reviewNode", sourceRef: "source.workflow.node.N3", attributes: {}, translationStatus: "executable", participants: { mode: "explicit", members: ["editor-e", "target-a", "target-b"].map(id => ({ id, name: id, type: "user_or_org", targetOrgType: 8 })) } });
    const edge = dsl.workflow.edges[0];
    dsl.workflow.edges = [{ ...edge, target: "N3" }, { ...edge, id: "L2", source: "N3", sourceRef: "source.workflow.edge.L2" }];
    dsl.workflow.topologicalOrder = ["N1", "N3", "N2"];
  }
  dsl.trust.digests = { sourceDraft: sha256Digest(source), dslDraft: "sha256:retained-singleton-fixture" };
  const resolved = structuredClone(dsl);
  for (const [collection, target] of [["allReaders", fixture.targets[0]], ["allEditors", fixture.targets[1]]]) {
    Object.assign(resolved.template.authorization[collection][0], { id: target.fdId, name: target.fdName, targetOrgType: target.fdOrgType });
  }
  const template = applyRequiredTemplateNumberRule(prepareSample(resolved).update);
  const expected = structuredClone(fixture.expectedV29);
  const actual = { ...structuredClone(expected), allReaders: ["editor-e", "reader-r"] };
  const typed = { "8": { sourceOrgType: 8, targetOrgType: 8, targetFdId: "reader-r", targetName: fixture.targets[0].fdName } };
  const warning = { level: "warning", code: "workflow.participant_sit_fallback_applied", details: { referenceCount: 1, identityCount: 1, targetFdIds: ["reader-r"], targetsByOrgType: structuredClone(typed) } };
  const error = { level: "error", code: "readback.workflow.template_authorization_mismatch", details: { expected, actual } };
  const report = {
    ok: false, status: "readback_failed", stage: "readback", failedAt: "readback", baseUrl: origin,
    templateId: template.fdId, createdFdIds: [template.fdId], updatedFdIds: [], remoteWriteAttempted: true, writeOutcomeUnknown: false,
    plan: buildDryRunPlan(dsl), diagnostics: [warning, error],
    readback: { ok: false, status: "mismatch", invariantVersion: 29, diagnostics: [structuredClone(error)], workflow: { templateAuthorization: structuredClone(actual) } },
    apiStages: [
      { name: "resolveWorkflowParticipants", status: "ok", resolvedCount: 2, identityCount: withDirectTargets ? 5 : 2, fallbackCount: 1, fallbackIdentityCount: 1, fallbackTargetId: "reader-r", fallbackTargetIds: ["reader-r"], fallbackTargetsByOrgType: typed },
      { name: "resolveConditionOrgs", status: "ok", resolvedCount: 0, nameCount: 0, fdNoCount: 0 },
      ...["add", "update", "saveWorkflowDraft", "getWorkflowTemplateDetail", "readback"].map(name => ({ name, status: "ok" }))
    ]
  };
  return { source, dsl, template, report };
}

function options(f, client, extra = {}) {
  return {
    client, sourceDraft: f.source, priorExecutionReport: f.report, baseUrl: origin,
    targetTemplateId: f.template.fdId, targetCategoryId: f.template.fdCategory.fdId,
    credentials: { username: "route-user", encryptedPassword: "route-password" },
    expectedDslDigest: reconciliationEvidenceDigest(f.dsl), expectedPriorReportDigest: reconciliationEvidenceDigest(f.report),
    now: new Date("2026-10-15T00:00:00Z"), transferRecordIdFactory: () => "retained-auth-record", ...extra
  };
}

class Client {
  constructor(template) { this.template = structuredClone(template); this.calls = []; this.reads = 0; }
  async login() { this.calls.push({ operation: "login" }); }
  async assertTransferRecordAuthentication() { this.calls.push({ operation: "record-auth" }); }
  async getElementInfo(ids) { this.calls.push({ operation: "exact", ids }); return ids[0] === "reader-r" && this.readerResult !== undefined ? this.readerResult : [...fixture.targets, ...["target-a", "target-b"].map(fdId => ({ fdId, fdName: fdId, fdOrgType: 8, fdIsBusiness: true }))].filter(t => ids.includes(t.fdId)); }
  async searchOrg() { this.calls.push({ operation: "search" }); throw new Error("retained authorization must never search"); }
  async getTemplate() { this.calls.push({ operation: "get-template" }); this.reads++; const t = structuredClone(this.template); if (this.drift && this.reads > 1) t.fdName += "changed"; return t; }
  async getWorkflowTemplateDetail() { this.calls.push({ operation: "get-workflow" }); return structuredClone(this.template.mechanisms.lbpmTemplate[0]); }
  async addTransferRecord() { this.calls.push({ operation: "record" }); if (this.recordError) throw this.recordError; return {}; }
  async updateTemplate() { this.calls.push({ operation: "template-write" }); throw new Error("forbidden"); }
  async saveWorkflowDraft() { return this.updateTemplate(); }
  async addTemplate() { return this.updateTemplate(); }
}
