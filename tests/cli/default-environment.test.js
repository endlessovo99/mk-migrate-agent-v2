import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_ENV_FILE,
  loadDefaultEnvironment
} from "../../src/default-environment.js";

describe("default project environment", () => {
  it("uses .tmp/newoa.env at the project root", () => {
    assert.equal(DEFAULT_ENV_FILE, resolve(".tmp/newoa.env"));
  });

  it("loads missing values without overriding the caller environment", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mk-migrate-default-env-"));
    const envPath = join(tempDir, "newoa.env");
    const env = { ALREADY_EXPORTED: "from-shell" };

    try {
      writeFileSync(envPath, "FROM_ENV_FILE=loaded\nALREADY_EXPORTED=from-file\n");

      assert.equal(loadDefaultEnvironment({ path: envPath, env }), true);
      assert.equal(env.FROM_ENV_FILE, "loaded");
      assert.equal(env.ALREADY_EXPORTED, "from-shell");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
