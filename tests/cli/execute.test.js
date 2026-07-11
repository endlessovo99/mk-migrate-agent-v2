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
});

async function runExecuteCli({ argv = [], env = {} } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "mk-migrate-cli-execute-"));
  const inputPath = join(tempDir, "migration.dsl.json");
  const output = [];
  const originalLog = console.log;
  let request;

  writeFileSync(inputPath, `${JSON.stringify(sampleTrustedDsl(), null, 2)}\n`);
  console.log = (value) => output.push(String(value));
  try {
    await main(["execute", inputPath, ...argv], {
      env: {
        NEWOA_USERNAME: "cli-route-user",
        NEWOA_ENCRYPTED_PASSWORD: "cli-route-encrypted-password",
        ...env
      },
      executeDsl: async (dsl, options) => {
        request = { dsl, options };
        return { ok: true, status: "written", templateId: "template-1" };
      }
    });
  } finally {
    console.log = originalLog;
    rmSync(tempDir, { recursive: true, force: true });
  }

  return { request, output };
}
