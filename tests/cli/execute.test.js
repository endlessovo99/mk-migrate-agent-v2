import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main } from "../../src/cli/main.js";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";

describe("execute CLI", () => {
  it("reads NewOA credentials at the CLI seam without printing them", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mk-migrate-cli-execute-"));
    const inputPath = join(tempDir, "migration.dsl.json");
    const credentials = {
      username: "cli-route-user",
      encryptedPassword: "cli-route-encrypted-password"
    };
    let request;
    const output = [];
    const originalLog = console.log;

    writeFileSync(inputPath, `${JSON.stringify(sampleTrustedDsl(), null, 2)}\n`);
    console.log = (value) => output.push(String(value));
    try {
      await main([
        "execute",
        inputPath,
        "--confirm-write",
        "--target-category-id",
        "category-1"
      ], {
        env: {
          NEWOA_USERNAME: credentials.username,
          NEWOA_ENCRYPTED_PASSWORD: credentials.encryptedPassword
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

    assert.equal(request.dsl.artifact, "migration-dsl");
    assert.deepEqual(request.options.credentials, credentials);
    assert.equal(request.options.confirmWrite, true);
    assert.equal(request.options.targetCategoryId, "category-1");
    assert.equal(output.join("\n").includes(credentials.username), false);
    assert.equal(output.join("\n").includes(credentials.encryptedPassword), false);
  });
});
