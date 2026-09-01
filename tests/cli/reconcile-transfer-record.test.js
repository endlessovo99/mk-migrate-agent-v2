import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { main } from "../../src/cli/main.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";

describe("reconcile-transfer-record CLI", () => {
  it("passes bound evidence and confirmation inputs to the reconciliation seam", async () => {
    const root = mkdtempSync(join(tmpdir(), "mk-reconcile-cli-"));
    const source = cleanSourceFile("tests/fixtures/route-validation/workflow-data-authority");
    const dsl = createTrustedMigrationDsl(source, draftSourceDraft(source), {
      externalAgentReviewed: true
    });
    const inputPath = join(root, "migration.dsl.json");
    const priorPath = join(root, "prior-report.json");
    writeFileSync(inputPath, JSON.stringify(dsl));
    writeFileSync(priorPath, JSON.stringify({ status: "readback_failed" }));
    const output = [];
    const originalLog = console.log;
    const originalExitCode = process.exitCode;
    let request;
    console.log = (value) => output.push(String(value));
    process.exitCode = undefined;
    try {
      await main([
        "reconcile-transfer-record",
        inputPath,
        "--source", "tests/fixtures/route-validation/workflow-data-authority",
        "--prior-execution-report", priorPath,
        "--target-template-id", "target-template",
        "--target-category-id", "target-category",
        "--expected-dsl-digest", "b".repeat(64),
        "--expected-prior-report-digest", "c".repeat(64),
        "--base-url", "http://oadev.shanghai-electric.com",
        "--confirm-write",
        "--expected-evidence-digest", "a".repeat(64),
        "--artifacts-dir", join(root, "artifacts")
      ], {
        env: {
          NEWOA_USERNAME: "cli-reconcile-user",
          NEWOA_ENCRYPTED_PASSWORD: "cli-reconcile-secret"
        },
        reconcileTransferRecord: async (input, options) => {
          request = { input, options };
          return { ok: true, status: "transfer_record_recorded" };
        }
      });
    } finally {
      console.log = originalLog;
      process.exitCode = originalExitCode;
      rmSync(root, { recursive: true, force: true });
    }

    assert.equal(request.options.confirmWrite, true);
    assert.equal(request.options.targetTemplateId, "target-template");
    assert.equal(request.options.targetCategoryId, "target-category");
    assert.equal(request.options.expectedEvidenceDigest, "a".repeat(64));
    assert.equal(request.options.expectedDslDigest, "b".repeat(64));
    assert.equal(request.options.expectedPriorReportDigest, "c".repeat(64));
    assert.equal(request.options.sourceDraft.source.sourceId, source.source.sourceId);
    assert.equal(request.options.priorExecutionReport.status, "readback_failed");
    assert.equal(output.join("\n").includes("cli-reconcile-secret"), false);
  });
});
