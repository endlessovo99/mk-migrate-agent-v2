import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEvidenceBackedPatches, runAgentReview } from "../../src/agent-review/index.js";
import { hmacSha256Digest, sha256Digest } from "../../src/agent-review/digest.js";
import { main } from "../../src/cli/main.js";
import { draftSourceDraft } from "../../src/translator/dsl-draft.js";
import { sampleDraftDsl, sampleSourceDraft } from "../helpers/sample-dsl.js";

const actionIds = ["checkpoint-1.event.1", "checkpoint-2.event.1"];
const sourceRefs = ["source.form.jsp.checkpoint.1", "source.form.jsp.checkpoint.2"];
const CHECKPOINT_SIGNING_KEY = "test-agent-review-checkpoint-key-32-bytes";

describe("Agent Review checkpoint resume", () => {
  it("resumes from validated partial patches after a later batch fails", async () => {
    const source = sourceDraft();
    const draft = dslDraft();
    const firstProvider = new CloseThenFailProvider(providerMetadata("fake-checkpoint-a"));
    const interrupted = await runAgentReview(source, draft, reviewOptions(firstProvider));

    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.report.stage, "agent-review.network");
    assert.equal(interrupted.checkpoint.artifact, "agent-review-checkpoint");
    assert.equal(interrupted.checkpoint.status, "partial");
    assert.equal(interrupted.checkpoint.acceptedPatches.length, 4);
    assert.match(interrupted.checkpoint.cacheKey, /^sha256:[a-f0-9]{64}$/);
    assert.match(interrupted.checkpoint.contract.reviewContractDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(interrupted.checkpoint.auth.algorithm, "hmac-sha256");
    assert.match(interrupted.checkpoint.auth.signature, /^hmac-sha256:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(interrupted.checkpoint).includes(CHECKPOINT_SIGNING_KEY), false);

    const resumeProvider = new CompleteScopedProvider(providerMetadata("fake-checkpoint-b"));
    const resumed = await runAgentReview(source, draft, {
      ...reviewOptions(resumeProvider),
      resumeCheckpoint: interrupted.checkpoint
    });

    assert.equal(resumed.ok, true);
    assert.equal(resumed.dsl.trust.executable, true);
    assert.match(resumed.dsl.trust.digests.sourceDraft, /^sha256:[a-f0-9]{64}$/);
    assert.match(resumed.dsl.trust.digests.dslDraft, /^sha256:[a-f0-9]{64}$/);
    assert.equal(resumeProvider.calls.length, 1);
    assert.deepEqual(resumeProvider.calls[0].actionIds, [actionIds[1]]);
    assert.deepEqual(
      resumed.report.reviewers.map((reviewer) => reviewer.provider),
      ["fake-checkpoint-a", "fake-checkpoint-b"]
    );
    assert.deepEqual(
      resumed.dsl.review.agentReview.reviewers.map((reviewer) => reviewer.provider),
      ["fake-checkpoint-a", "fake-checkpoint-b"]
    );
    assert.deepEqual(
      resumed.dsl.scripts.actions.map((action) => action.translationStatus),
      ["mapped", "mapped"]
    );
  });

  it("rejects a tampered checkpoint before calling the provider", async () => {
    const source = sourceDraft();
    const draft = dslDraft();
    const interrupted = await runAgentReview(source, draft, reviewOptions(new CloseThenFailProvider()));
    const tampered = structuredClone(interrupted.checkpoint);
    tampered.patchSetDigest = "sha256:tampered";
    const provider = new CompleteScopedProvider();

    const result = await runAgentReview(source, draft, {
      ...reviewOptions(provider),
      resumeCheckpoint: tampered
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.checkpoint");
    assert.equal(provider.calls.length, 0);
  });

  it("rejects forged patches even when public digests are recomputed", async () => {
    const source = sourceDraft();
    const draft = dslDraft();
    const completed = await runAgentReview(source, draft, reviewOptions(new CompleteScopedProvider()));
    const forged = structuredClone(completed.checkpoint);
    forged.acceptedPatches[0].value = "function onLoad() {\n  MKXFORM.setValue('fd_subject', 'FORGED')\n}";
    forged.patchSetDigest = sha256Digest(forged.acceptedPatches);
    const replay = applyEvidenceBackedPatches(draft, forged.acceptedPatches, {
      sourceRefs: new Set(sourceRefs)
    });
    assert.equal(replay.ok, true);
    forged.reviewedDslDraftDigest = sha256Digest(replay.dslDraft);
    const provider = new FailIfCalledProvider();

    const result = await runAgentReview(source, draft, {
      ...reviewOptions(provider),
      resumeCheckpoint: forged
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.checkpoint");
    assert.equal(provider.calls.length, 0);
    assert.equal(
      result.report.diagnostics.some((diagnostic) => diagnostic.code === "agent.checkpoint.signature_mismatch"),
      true
    );
  });

  it("reuses a complete checkpoint without calling the provider", async () => {
    const source = sourceDraft();
    const draft = dslDraft();
    const completed = await runAgentReview(source, draft, reviewOptions(new CompleteScopedProvider()));
    assert.equal(completed.ok, true);
    assert.equal(completed.checkpoint.status, "complete");

    const provider = new FailIfCalledProvider();
    const reused = await runAgentReview(source, draft, {
      ...reviewOptions(provider),
      reviewedAt: "2026-07-12T00:00:00.000Z",
      resumeCheckpoint: completed.checkpoint
    });

    assert.equal(reused.ok, true);
    assert.equal(reused.dsl.trust.executable, true);
    assert.equal(provider.calls.length, 0);
    assert.equal(reused.report.acceptedPatchCount, completed.report.acceptedPatchCount);
    assert.equal(reused.dsl.review.agentReview.reviewedAt, "2026-07-11T00:00:00.000Z");
    assert.equal(reused.dsl.trust.trustCheck.checkedAt, "2026-07-12T00:00:00.000Z");
    assert.equal(reused.report.reviewedAt, "2026-07-11T00:00:00.000Z");
    assert.equal(reused.report.reusedAt, "2026-07-12T00:00:00.000Z");
    assert.equal(reused.checkpoint.reviewer.reviewedAt, "2026-07-11T00:00:00.000Z");
  });

  it("rejects a checkpoint created for different source input before calling the provider", async () => {
    const source = sourceDraft();
    const draft = dslDraft();
    const completed = await runAgentReview(source, draft, reviewOptions(new CompleteScopedProvider()));
    const changedSource = structuredClone(source);
    changedSource.source.sourceId = "different-source.xml";
    const provider = new CompleteScopedProvider();

    const result = await runAgentReview(changedSource, draft, {
      ...reviewOptions(provider),
      resumeCheckpoint: completed.checkpoint
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.checkpoint");
    assert.equal(provider.calls.length, 0);
    assert.equal(
      result.report.diagnostics.some((diagnostic) => diagnostic.code === "agent.checkpoint.digest_mismatch"),
      true
    );
  });

  it("rejects malformed signed batch history without throwing or calling the provider", async () => {
    const source = sourceDraft();
    const draft = dslDraft();
    const completed = await runAgentReview(source, draft, reviewOptions(new CompleteScopedProvider()));
    const malformed = structuredClone(completed.checkpoint);
    malformed.batches = [null];
    resign(malformed);
    const provider = new FailIfCalledProvider();

    const result = await runAgentReview(source, draft, {
      ...reviewOptions(provider),
      resumeCheckpoint: malformed
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.checkpoint");
    assert.equal(provider.calls.length, 0);
    assert.equal(
      result.report.diagnostics.some((diagnostic) => diagnostic.code === "agent.checkpoint.batch_invalid"),
      true
    );
  });

  it("rejects a signed checkpoint whose nested review contract was changed", async () => {
    const source = sourceDraft();
    const draft = dslDraft();
    const completed = await runAgentReview(source, draft, reviewOptions(new CompleteScopedProvider()));
    const changedContract = structuredClone(completed.checkpoint);
    changedContract.contract.catalogs.targetApis.digest = "sha256:changed-contract";
    resign(changedContract);
    const provider = new FailIfCalledProvider();

    const result = await runAgentReview(source, draft, {
      ...reviewOptions(provider),
      resumeCheckpoint: changedContract
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.checkpoint");
    assert.equal(provider.calls.length, 0);
    assert.equal(
      result.report.diagnostics.some((diagnostic) => diagnostic.code === "agent.checkpoint.contract_mismatch"),
      true
    );
  });

  it("rejects a signed checkpoint with a missing review contract without throwing", async () => {
    const source = sourceDraft();
    const draft = dslDraft();
    const completed = await runAgentReview(source, draft, reviewOptions(new CompleteScopedProvider()));
    const missingContract = structuredClone(completed.checkpoint);
    delete missingContract.contract;
    resign(missingContract);
    const provider = new FailIfCalledProvider();

    const result = await runAgentReview(source, draft, {
      ...reviewOptions(provider),
      resumeCheckpoint: missingContract
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.checkpoint");
    assert.equal(provider.calls.length, 0);
    assert.equal(
      result.report.diagnostics.some((diagnostic) => diagnostic.code === "agent.checkpoint.contract_mismatch"),
      true
    );
  });

  it("does not start checkpoint persistence without a signing key", async () => {
    const provider = new CompleteScopedProvider();
    const result = await runAgentReview(sourceDraft(), dslDraft(), {
      provider,
      batchSize: 1,
      onCheckpoint: async () => {}
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.stage, "agent-review.checkpoint");
    assert.equal(provider.calls.length, 0);
    assert.equal(result.report.diagnostics[0].code, "agent.checkpoint.signing_key_required");
  });

  it("persists and resumes a checkpoint through the CLI without leaving stale trusted output", async () => {
    const tempDir = join(".tmp", "agent-review-tests", "checkpoint-cli");
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    const sourcePath = join(tempDir, "source-draft.json");
    const draftPath = join(tempDir, "dsl-draft.json");
    const outputPath = join(tempDir, "migration.dsl.json");
    const reportPath = join(tempDir, "agent-review.report.json");
    const checkpointPath = join(tempDir, "agent-review.checkpoint.json");
    writeJson(sourcePath, sourceDraft());
    writeJson(draftPath, dslDraft());
    writeJson(outputPath, { artifact: "stale-migration-dsl" });

    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const restoreLog = captureConsoleLog();
    await main([
      "agent-review", sourcePath, draftPath,
      "--out", outputPath,
      "--report-out", reportPath,
      "--checkpoint-out", checkpointPath,
      "--review-batch-size", "1"
    ], {
      agentReviewProvider: new CloseThenFailProvider(),
      agentReviewCheckpointKey: CHECKPOINT_SIGNING_KEY,
      reviewedAt: "2026-07-11T00:00:00.000Z"
    });
    restoreLog();

    assert.equal(process.exitCode, 1);
    assert.equal(existsSync(reportPath), true);
    assert.equal(existsSync(checkpointPath), true);
    assert.equal(existsSync(outputPath), false);
    assert.equal(JSON.parse(readFileSync(checkpointPath, "utf8")).status, "partial");

    process.exitCode = undefined;
    const resumeProvider = new CompleteScopedProvider();
    const restoreResumeLog = captureConsoleLog();
    await main([
      "agent-review", sourcePath, draftPath,
      "--out", outputPath,
      "--report-out", reportPath,
      "--checkpoint-out", checkpointPath,
      "--resume-from", checkpointPath,
      "--review-batch-size", "1"
    ], {
      agentReviewProvider: resumeProvider,
      agentReviewCheckpointKey: CHECKPOINT_SIGNING_KEY,
      reviewedAt: "2026-07-11T00:00:00.000Z"
    });
    restoreResumeLog();

    assert.equal(process.exitCode, undefined);
    assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).artifact, "migration-dsl");
    assert.deepEqual(resumeProvider.calls[0].actionIds, [actionIds[1]]);
    process.exitCode = previousExitCode;
  });
});

class CloseThenFailProvider {
  constructor(info = providerMetadata()) {
    this.calls = [];
    this.info = info;
  }

  metadata() {
    return this.info;
  }

  async review({ reviewScope }) {
    this.calls.push(structuredClone(reviewScope));
    if (this.calls.length > 1) {
      return {
        ok: false,
        status: "blocked",
        stage: "agent-review.network",
        ...this.info,
        diagnostics: [{
          level: "error",
          code: "agent.provider.network_error",
          path: "/provider/network",
          message: "Injected interruption after the first reviewed batch."
        }]
      };
    }
    return received(reviewScope.actionIndexes.slice(0, 1).flatMap(scriptClosurePatches), this.info);
  }
}

class CompleteScopedProvider {
  constructor(info = providerMetadata()) {
    this.calls = [];
    this.info = info;
  }

  metadata() {
    return this.info;
  }

  async review({ reviewScope }) {
    this.calls.push(structuredClone(reviewScope));
    return received(reviewScope.actionIndexes.flatMap(scriptClosurePatches), this.info);
  }
}

class FailIfCalledProvider extends CompleteScopedProvider {
  async review(input) {
    this.calls.push(structuredClone(input.reviewScope));
    throw new Error("A complete checkpoint must not call the review provider.");
  }
}

function reviewOptions(provider) {
  return {
    provider,
    batchSize: 1,
    maxAttemptsPerAction: 2,
    checkpointSigningKey: CHECKPOINT_SIGNING_KEY,
    reviewedAt: "2026-07-11T00:00:00.000Z"
  };
}

function providerMetadata(provider = "fake-checkpoint") {
  return {
    provider,
    baseUrl: "fake://agent-review",
    model: "fake-model"
  };
}

function received(patches, info = providerMetadata()) {
  return {
    ok: true,
    status: "received",
    stage: "agent-review.provider",
    ...info,
    promptVersion: "test-checkpoint-v1",
    rawText: JSON.stringify({
      summary: "Reviewed the current checkpoint batch.",
      patches,
      diagnostics: []
    })
  };
}

function sourceDraft() {
  return sampleSourceDraft({
    scripts: {
      source: "sysform-jsp",
      sources: sourceRefs.map((sourceRef, index) => ({
        id: `checkpoint-${index + 1}`,
        sourceRef,
        javascript: [
          "Com_AddEventListener(window, 'load', function() {",
          `  SetXFormFieldValueById('fd_subject', 'value-${index + 1}');`,
          "});"
        ].join("\n"),
        functionAudit: { matched: [], violations: [] }
      }))
    }
  });
}

function dslDraft() {
  const rebuiltScripts = draftSourceDraft(sourceDraft()).scripts;
  return sampleDraftDsl({
    scripts: rebuiltScripts
  });
}

function scriptClosurePatches(actionIndex) {
  const sourceRef = sourceRefs[actionIndex];
  const patch = (property, value, rationale) => ({
    op: "replace",
    path: `/scripts/actions/${actionIndex}/${property}`,
    value,
    sourceRefs: [sourceRef],
    evidence: [`${sourceRef} contains one field assignment.`],
    confidence: 0.95,
    rationale
  });
  return [
    patch("function", `function onLoad() {\n  MKXFORM.setValue('fd_subject', 'value-${actionIndex + 1}')\n}`, "Translate the assignment."),
    patch("translationStatus", "mapped", "Close the reviewed action."),
    patch("functionMappings", [{
      source: "SetXFormFieldValueById",
      target: "MKXFORM.setValue",
      basis: "function-catalog",
      reviewRequired: false
    }], "Record the function mapping."),
    patch("coverage", { status: "translated", nativeRules: [], residuals: [] }, "Record complete coverage.")
  ];
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function captureConsoleLog() {
  const original = console.log;
  console.log = () => {};
  return () => {
    console.log = original;
  };
}

function resign(checkpoint) {
  const { auth: _auth, ...payload } = checkpoint;
  checkpoint.auth.signature = hmacSha256Digest(payload, CHECKPOINT_SIGNING_KEY);
}
