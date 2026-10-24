import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sha256Digest } from "../../src/agent-review/digest.js";
import { createPrewriteBlockedDisposition, verifyPrewriteBlockedDisposition } from "../../src/batch/prewrite-disposition.js";
import { sourceSnapshot, cleanSnapshot } from "../../src/batch/intake.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { runFixtureRouteCase } from "./run-route-case.js";

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/route-validation/subprocess-dependency/${name}`, import.meta.url), "utf8"));
const definition = fixture("prewrite-disposition.json");
const routeCase = fixture("route-cases.json").cases[0];
const native = fixture("native-reads.json");

class MissingDependencyAdapter extends FakeNewoaAdapter {
  async getWorkflowTemplateDetail({ templateId }) {
    this.record({ operation: "get-workflow-detail", templateId, definitionId: "" });
    throw Object.assign(new Error("Fixture dependency absent"), { stage: "getWorkflowTemplateDetail", response: native.missingDetailResponse });
  }
  async getWorkflowSubProcessParams() { throw new Error("Must stop after absent detail"); }
}

async function evidence() {
  const route = await runFixtureRouteCase(routeCase, { adapterFactory: (_, options) => new MissingDependencyAdapter("persist", options) });
  const snapshot = sourceSnapshot(fileURLToPath(new URL("../fixtures/route-validation/subprocess/", import.meta.url)));
  const sourceDraft = cleanSnapshot(snapshot, "");
  const batch = { id: definition.batchId, baseUrl: "https://p-sit.onewo.com", targetCategoryId: definition.targetCategoryId,
    migrationKey: definition.migrationKey, status: "paused" };
  const item = { id: definition.itemId, batchId: batch.id, baseUrl: batch.baseUrl, sourceId: "route-subprocess-template", templateName: "",
    snapshot, sourceDigest: sha256Digest({ snapshot, templateName: "" }), sourceDraft, sourceDraftDigest: sha256Digest(sourceDraft),
    dsl: route.dsl, dslDigest: sha256Digest(route.dsl), engineDigest: sha256Digest("route-engine"), status: "blocked", writeStarted: false,
    targetTemplateId: null, activeAttemptId: null, workerId: null, leaseUntil: null,
    identityKey: sha256Digest({ baseUrl: batch.baseUrl, targetCategoryId: batch.targetCategoryId, sourceId: "route-subprocess-template", migrationKey: batch.migrationKey }),
    attempts: [{ id: "attempt-route", phase: "execute", status: "blocked", steps: [], dsl: route.dsl, sourceDraft, report: route.execution }] };
  return { item, batch, expected: { ...definition, sourceId: item.sourceId, baseUrl: batch.baseUrl,
    revision: "r001", sourceDigest: item.sourceDigest, sourceDraftDigest: item.sourceDraftDigest, dslDigest: item.dslDigest, engineDigest: item.engineDigest },
    callsByAttempt: { "attempt-route": structuredClone(definition.calls) } };
}

describe("sealed prewrite blocked disposition Route-validation", () => {
  it("retains the real production zero-write failure while allowing only independent-item continuation", async () => {
    const input = await evidence(), before = sha256Digest(input);
    const disposition = createPrewriteBlockedDisposition(input);
    assert.equal(disposition.kind, "prewrite_blocked");
    assert.equal(disposition.continueIndependentItems, true);
    for (const key of ["reviewCompleted", "migrationSucceeded", "allIssuesResolved"]) assert.equal(disposition[key], false);
    assert.equal(disposition.binding.itemId, input.item.id);
    assert.equal(disposition.binding.dslDigest, input.item.dslDigest);
    assert.equal(verifyPrewriteBlockedDisposition(disposition, input), true);
    assert.equal(sha256Digest(input), before);
  });

  const mutations = {
    "successful item": input => { input.item.status = "succeeded"; },
    "existing target": input => { input.item.targetTemplateId = "retained-target"; },
    "beforeWrite journal entry": input => { input.item.attempts[0].steps.push({ outcome: "pending" }); },
    "historical unknown write": input => { input.item.attempts.unshift({ phase: "execute", status: "outcome_unknown", steps: [], report: { writeOutcomeUnknown: true } }); },
    "historical acknowledged write": input => { input.item.attempts.unshift({ id: "old-prepare", phase: "prepare", status: "blocked", steps: [], report: { remoteWriteAttempted: true } }); },
    "historical created receipt": input => { input.item.attempts.unshift({ id: "old-prepare", phase: "prepare", status: "blocked", steps: [], report: { createdFdIds: ["retained-old-target"] } }); },
    "historical preparation target": input => { input.item.attempts.unshift({ id: "old-prepare", phase: "prepare", status: "blocked", steps: [], report: { templateId: "retained-old-target" } }); },
    "historical preparation readback": input => { input.item.attempts.unshift({ id: "old-prepare", phase: "prepare", status: "blocked", steps: [], report: { readback: { ok: true } } }); },
    "historical preparation transfer record": input => { input.item.attempts.unshift({ id: "old-prepare", phase: "prepare", status: "blocked", steps: [], report: { transferRecord: { status: "recorded" } } }); },
    "missing historical preparation report": input => { input.item.attempts.unshift({ id: "old-prepare", phase: "prepare", status: "blocked", steps: [] }); },
    "reported remote write": input => { input.item.attempts[0].report.remoteWriteAttempted = true; },
    "missing explicit write outcome": input => { delete input.item.attempts[0].report.writeOutcomeUnknown; },
    "created target receipt": input => { input.item.attempts[0].report.createdFdIds.push("created-target"); },
    "updated target receipt": input => { input.item.attempts[0].report.updatedFdIds.push("updated-target"); },
    "active lease": input => { input.item.workerId = "active-worker"; },
    "untyped false write flag": input => { input.item.writeOutcomeUnknown = 0; },
    "missing terminal lease state": input => { delete input.item.leaseUntil; },
    "changed source draft": input => { input.item.sourceDraft.template.name += " changed"; },
    "changed engine": input => { input.item.engineDigest = sha256Digest("other-engine"); },
    "missing historical call ledger": input => { input.item.attempts.unshift({ ...structuredClone(input.item.attempts[0]), id: "old-execute" }); },
    "changed batch": input => { input.batch.id = "another-batch"; },
    "changed migration key": input => { input.batch.migrationKey = "another-key"; },
    "changed source": input => { input.item.sourceId = "another-source"; },
    "changed source bytes": input => { input.item.snapshot.files[0].content += " "; },
    "changed DSL": input => { input.item.dsl.template.name += " changed"; },
    "missing native call receipt": input => { input.callsByAttempt["attempt-route"].pop(); },
    "complete pair missing from native ledger": input => { input.callsByAttempt["attempt-route"].splice(2); },
    "ledger with wrong dependency identity": input => { input.callsByAttempt["attempt-route"][2].templateId = "another-child"; },
    "ledger with wrong native outcome": input => { input.callsByAttempt["attempt-route"][3].status = 200; },
    "missing native read reason": input => { delete input.item.attempts[0].report.apiStages[1].dependencies[0].reads[0].reason; },
    "missing both reported and raw dependency read": input => { input.item.attempts[0].report.apiStages[1].dependencies[0].reads = []; input.callsByAttempt["attempt-route"].splice(2); },
    "unknown native receipt field": input => { input.item.attempts[0].report.apiStages[1].dependencies[0].reads[0].writeOutcomeUnknown = true; },
    "unknown native endpoint": input => { input.callsByAttempt["attempt-route"][2].path = "/data/km-review/kmReviewTemplate/add"; },
    "out-of-order native receipt": input => { input.callsByAttempt["attempt-route"][3].id = 1; },
    "unfinished API stage": input => { input.item.attempts[0].report.apiStages[0].status = "started"; },
    "stage-level unknown write": input => { input.item.attempts[0].report.apiStages.at(-1).writeOutcomeUnknown = true; },
    "write stage after failed stage": input => { input.item.attempts[0].report.apiStages.push({ name: "add", status: "ok" }); },
    "unknown stage after failed stage": input => { input.item.attempts[0].report.apiStages.push({ name: "addTemplate", status: "ok" }); },
    "read stage after failed stage": input => { input.item.attempts[0].report.apiStages.push({ name: "login", status: "ok" }); }
  };
  for (const [name, mutate] of Object.entries(mutations)) it(`rejects ${name}`, async () => {
    const input = await evidence(); mutate(input);
    assert.throws(() => createPrewriteBlockedDisposition(input), { code: "BATCH_PREWRITE_DISPOSITION_INVALID" });
  });

  it("rejects altered or stale sealed evidence", async () => {
    const input = await evidence(), disposition = createPrewriteBlockedDisposition(input);
    disposition.allIssuesResolved = true;
    assert.throws(() => verifyPrewriteBlockedDisposition(disposition, input), { code: "BATCH_PREWRITE_DISPOSITION_INVALID" });
  });

  it("does not interpret business JSON text as an execution receipt", async () => {
    const input = await evidence();
    input.item.attempts[0].report.diagnostics[0].message = '{"templateId":"business-value","writeOutcomeUnknown":true}';
    assert.equal(verifyPrewriteBlockedDisposition(createPrewriteBlockedDisposition(input), input), true);
  });
});
