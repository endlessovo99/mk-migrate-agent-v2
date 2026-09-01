import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { main } from "../../src/cli/main.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("recover-transfer-record CLI", () => {
  it("passes fixed recovery evidence and explicit confirmations to the recovery seam", async () => {
    const priorExecutionReport = {
      status: "readback_failed",
      templateId: "target-template-id"
    };
    const { request, output } = await runRecoveryCli({
      priorExecutionReport,
      argv: [
        "--confirm-write",
        "--confirm-no-successful-transfer-record",
        "--transfer-record-id", "fixed-record-id",
        "--target-category-id", "target-category-id",
        "--target-template-id", "target-template-id",
        "--participant-override", "source-person=target-person",
        "--template-authorization-override", "source-post=target-post",
        "--base-url", "http://oadev.shanghai-electric.com"
      ]
    });

    assert.equal(request.options.confirmWrite, true);
    assert.equal(request.options.confirmNoSuccessfulTransferRecord, true);
    assert.equal(request.options.transferRecordId, "fixed-record-id");
    assert.equal(request.options.targetCategoryId, "target-category-id");
    assert.equal(request.options.targetTemplateId, "target-template-id");
    assert.equal(request.options.baseUrl, "http://oadev.shanghai-electric.com");
    assert.deepEqual(request.options.priorExecutionReport, priorExecutionReport);
    assert.deepEqual(request.options.participantOverrides, [{
      sourceId: "source-person",
      targetFdId: "target-person"
    }]);
    assert.deepEqual(request.options.templateAuthorizationOverrides, [{
      sourceId: "source-post",
      targetFdId: "target-post"
    }]);
    assert.equal(output.join("\n").includes("cli-recovery-encrypted-password"), false);
  });

  it("requires an explicit prior execution report path", async () => {
    const { request, exitCode, output } = await runRecoveryCli({
      omitPriorReportArgument: true
    });

    assert.equal(request, undefined);
    assert.equal(exitCode, 1);
    assert.match(JSON.parse(output.at(-1)).message, /prior-execution-report/);
  });

  it("rejects subprocess overrides instead of silently ignoring them", async () => {
    const { request, exitCode, output } = await runRecoveryCli({
      argv: ["--subprocess-template-override", "source-child=target-child"]
    });

    assert.equal(request, undefined);
    assert.equal(exitCode, 1);
    assert.match(JSON.parse(output.at(-1)).message, /supported only by execute/);
  });
});

async function runRecoveryCli({
  argv = [],
  priorExecutionReport = {},
  omitPriorReportArgument = false
} = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "mk-migrate-cli-transfer-recovery-"));
  const inputPath = join(tempDir, "migration.dsl.json");
  const priorReportPath = join(tempDir, "prior-execution.report.json");
  const output = [];
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  let request;
  let exitCode;

  writeFileSync(inputPath, `${JSON.stringify(sampleTrustedDsl(), null, 2)}\n`);
  writeFileSync(priorReportPath, `${JSON.stringify(priorExecutionReport, null, 2)}\n`);
  console.log = (value) => output.push(String(value));
  process.exitCode = undefined;
  try {
    await main([
      "recover-transfer-record",
      inputPath,
      ...(!omitPriorReportArgument
        ? ["--prior-execution-report", priorReportPath]
        : []),
      ...argv
    ], {
      env: {
        NEWOA_USERNAME: "cli-recovery-user",
        NEWOA_ENCRYPTED_PASSWORD: "cli-recovery-encrypted-password"
      },
      recoverVerifiedTransferRecord: async (dsl, options) => {
        request = { dsl, options };
        return { ok: true, status: "transfer_record_recorded" };
      }
    });
    exitCode = process.exitCode;
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
    rmSync(tempDir, { recursive: true, force: true });
  }

  return { request, output, exitCode };
}
