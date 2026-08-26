import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { isDirectInvocation, startCli } from "../../src/cli/main.js";
import {
  DEFAULT_ENV_FILE,
  loadDefaultEnvironment
} from "../../src/default-environment.js";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/route-validation/default-environment/", import.meta.url));
const PROJECT_ENV_FILE = fileURLToPath(new URL("../../.tmp/newoa.env", import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL("../../src/cli/main.js", import.meta.url));
const SOURCE_FIXTURE = fileURLToPath(new URL("../fixtures/source/route-validation-lbpm/", import.meta.url));

describe("default environment route validation", () => {
  it("uses .tmp/newoa.env at the project root", () => {
    assert.equal(DEFAULT_ENV_FILE, PROJECT_ENV_FILE);
  });

  it("loads the environment fixture while cleaning supported XML through CLI startup", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mk-migrate-env-route-"));
    const outputPath = join(tempDir, "source-draft.json");
    const env = { ROUTE_ENV_EXPORTED: "from-shell" };
    const originalLog = console.log;

    try {
      console.log = () => {};
      await startCli(["clean", SOURCE_FIXTURE, "--out", outputPath], {
        defaultEnvFile: join(FIXTURE_DIR, "newoa.env"),
        env
      });

      assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).artifact, "source-draft");
      assert.equal(env.ROUTE_ENV_FROM_FILE, "loaded-from-fixture");
      assert.equal(env.ROUTE_ENV_EXPORTED, "from-shell");
    } finally {
      console.log = originalLog;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps startup available when the project-local env file is missing", () => {
    const env = {};

    assert.equal(loadDefaultEnvironment({ path: join(FIXTURE_DIR, "missing.env"), env }), false);
    assert.deepEqual(env, {});
  });

  it("recognizes a package-bin-style symlink as the CLI entry", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mk-migrate-bin-entry-"));
    const binPath = join(tempDir, "mk-migrate-v2");

    try {
      symlinkSync(CLI_ENTRY, binPath);
      assert.equal(isDirectInvocation(binPath), true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
