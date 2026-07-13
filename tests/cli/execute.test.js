import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main } from "../../src/cli/main.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("execute CLI", () => {
  it("passes NEWOA_BASE_URL from the environment to the executor", async () => {
    const { request } = await runExecuteCli({
      env: { NEWOA_BASE_URL: "https://oa.example.com" }
    });

    assert.equal(request.options.baseUrl, "https://oa.example.com");
  });

  it("prefers --base-url over NEWOA_BASE_URL", async () => {
    const { request } = await runExecuteCli({
      argv: ["--base-url", "http://127.0.0.1:8080"],
      env: { NEWOA_BASE_URL: "https://oa.example.com" }
    });

    assert.equal(request.options.baseUrl, "http://127.0.0.1:8080");
  });

  it("falls back to NEWOA_BASE_URL when --base-url is whitespace-only", async () => {
    const { request } = await runExecuteCli({
      argv: ["--base-url", "   "],
      env: { NEWOA_BASE_URL: "https://oa.example.com" }
    });

    assert.equal(request.options.baseUrl, "https://oa.example.com");
  });

  it("treats an empty or whitespace-only NEWOA_BASE_URL as unspecified", async () => {
    const baseUrls = [];

    for (const value of ["", "   "]) {
      const { request } = await runExecuteCli({ env: { NEWOA_BASE_URL: value } });
      baseUrls.push(request.options.baseUrl);
    }

    assert.deepEqual(baseUrls, [undefined, undefined]);
  });

  it("reads NewOA credentials at the CLI seam without printing them", async () => {
    const credentials = {
      username: "cli-route-user",
      encryptedPassword: "cli-route-encrypted-password"
    };
    const { request, output } = await runExecuteCli({
      argv: ["--confirm-write", "--target-category-id", "category-1"],
      env: {
        NEWOA_USERNAME: credentials.username,
        NEWOA_ENCRYPTED_PASSWORD: credentials.encryptedPassword
      }
    });

    assert.equal(request.dsl.artifact, "migration-dsl");
    assert.deepEqual(request.options.credentials, credentials);
    assert.equal(request.options.confirmWrite, true);
    assert.equal(request.options.targetCategoryId, "category-1");
    assert.equal(output.join("\n").includes(credentials.username), false);
    assert.equal(output.join("\n").includes(credentials.encryptedPassword), false);
  });

  it("passes configured fallback fdIds from the environment to the executor", async () => {
    const { request } = await runExecuteCli({
      env: {
        NEWOA_FALLBACK_PERSON_FD_ID: " person-fallback-id ",
        NEWOA_FALLBACK_ORGANIZATION_FD_ID: "organization-fallback-id",
        NEWOA_FALLBACK_GROUP_FD_ID: "group-fallback-id",
        NEWOA_FALLBACK_POST_FD_ID: "post-fallback-id",
        NEWOA_UNUSED_FALLBACK_FD_ID: "ignored",
        NEWOA_FALLBACK_UNUSED_FD_ID: "   "
      }
    });

    assert.deepEqual(request.options.fallbackFdIds, {
      person: "person-fallback-id",
      organization: "organization-fallback-id",
      group: "group-fallback-id",
      post: "post-fallback-id"
    });
  });

  it("treats blank fallback fdId environment values as unspecified", async () => {
    const { request } = await runExecuteCli({
      env: {
        NEWOA_FALLBACK_PERSON_FD_ID: " ",
        NEWOA_FALLBACK_ORGANIZATION_FD_ID: "",
        NEWOA_FALLBACK_GROUP_FD_ID: "\t",
        NEWOA_FALLBACK_POST_FD_ID: "  "
      }
    });

    assert.deepEqual(request.options.fallbackFdIds, {});
  });

  it("returns a non-zero process status when execution is blocked", async () => {
    const { exitCode, output } = await runExecuteCli({
      executeResult: {
        ok: false,
        status: "blocked",
        diagnostics: [{ level: "error", code: "safety.existing_template_not_draft" }]
      }
    });

    assert.equal(exitCode, 1);
    assert.equal(JSON.parse(output.at(-1)).status, "blocked");
  });
});

async function runExecuteCli({ argv = [], env = {}, executeResult } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "mk-migrate-cli-execute-"));
  const inputPath = join(tempDir, "migration.dsl.json");
  const output = [];
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  let request;
  let exitCode;

  writeFileSync(inputPath, `${JSON.stringify(sampleTrustedDsl(), null, 2)}\n`);
  console.log = (value) => output.push(String(value));
  process.exitCode = undefined;
  try {
    await main(["execute", inputPath, ...argv], {
      env: {
        NEWOA_USERNAME: "cli-route-user",
        NEWOA_ENCRYPTED_PASSWORD: "cli-route-encrypted-password",
        ...env
      },
      executeDsl: async (dsl, options) => {
        request = { dsl, options };
        return executeResult || { ok: true, status: "written", templateId: "template-1" };
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
