import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  DEFAULT_ENV_FILE,
  loadDefaultEnvironment
} from "../../src/default-environment.js";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/route-validation/default-environment/", import.meta.url));
const PROJECT_ENV_FILE = fileURLToPath(new URL("../../.tmp/newoa.env", import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL("../../src/cli/main.js", import.meta.url));

describe("default environment startup Route case", () => {
  it("uses .tmp/newoa.env at the project root", () => {
    assert.equal(DEFAULT_ENV_FILE, PROJECT_ENV_FILE);
  });

  it("loads the environment fixture without overriding exported values", () => {
    const env = { ROUTE_ENV_EXPORTED: "from-shell" };

    assert.equal(loadDefaultEnvironment({ path: join(FIXTURE_DIR, "newoa.env"), env }), true);
    assert.equal(env.ROUTE_ENV_FROM_FILE, "loaded-from-fixture");
    assert.equal(env.ROUTE_ENV_EXPORTED, "from-shell");
  });

  it("keeps startup available when the project-local env file is missing", () => {
    const env = {};

    assert.equal(loadDefaultEnvironment({ path: join(FIXTURE_DIR, "missing.env"), env }), false);
    assert.deepEqual(env, {});
  });

  it("starts the CLI through a package-bin-style symlink", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mk-migrate-bin-entry-"));
    const binPath = join(tempDir, "mk-migrate-v2");

    try {
      symlinkSync(CLI_ENTRY, binPath);
      const result = spawnSync(process.execPath, [binPath], {
        encoding: "utf8",
        env: {}
      });

      assert.equal(result.status, 2);
      assert.match(result.stderr, /^Usage:/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
