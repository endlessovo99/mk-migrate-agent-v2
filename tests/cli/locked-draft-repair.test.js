import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { main } from "../../src/cli/main.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

describe("repair-locked-draft CLI", () => {
  it("passes the exact repair scope and evidence pins to the repair seam", async () => {
    const root = mkdtempSync(join(tmpdir(), "mk-locked-repair-cli-"));
    const sourcePath = "tests/fixtures/route-validation/workflow-data-authority";
    const source = cleanSourceFile(sourcePath);
    const dsl = createTrustedMigrationDsl(source, draftSourceDraft(source), {
      externalAgentReviewed: true
    });
    const inputPath = join(root, "migration.dsl.json");
    const reportPath = join(root, "prior-report.json");
    writeFileSync(inputPath, JSON.stringify(dsl));
    writeFileSync(reportPath, JSON.stringify({ status: "readback_failed" }));
    const output = [];
    const originalLog = console.log;
    const originalExitCode = process.exitCode;
    let request;
    console.log = (value) => output.push(String(value));
    process.exitCode = undefined;
    try {
      await main([
        "repair-locked-draft", inputPath,
        "--source", sourcePath,
        "--prior-execution-report", reportPath,
        "--repair-kind", "template_authorization",
        "--target-template-id", "target-template",
        "--target-category-id", "target-category",
        "--expected-dsl-digest", "a".repeat(64),
        "--expected-prior-report-digest", "b".repeat(64),
        "--confirm-write",
        "--expected-evidence-digest", "c".repeat(64),
        "--artifacts-dir", join(root, "artifacts")
      ], {
        env: {
          NEWOA_BASE_URL: "http://oadev.shanghai-electric.com",
          NEWOA_USERNAME: "locked-cli-user",
          NEWOA_ENCRYPTED_PASSWORD: "locked-cli-secret"
        },
        repairLockedDraft: async (input, options) => {
          request = { input, options };
          return { ok: true, status: "repaired_and_recorded" };
        }
      });
    } finally {
      console.log = originalLog;
      process.exitCode = originalExitCode;
      rmSync(root, { recursive: true, force: true });
    }

    assert.equal(request.options.repairKind, "template_authorization");
    assert.equal(request.options.confirmWrite, true);
    assert.equal(request.options.expectedDslDigest, "a".repeat(64));
    assert.equal(request.options.expectedPriorReportDigest, "b".repeat(64));
    assert.equal(request.options.expectedEvidenceDigest, "c".repeat(64));
    assert.equal(request.options.sourceDraft.source.sourceId, source.source.sourceId);
    assert.equal(output.join("\n").includes("locked-cli-secret"), false);
  });
});
