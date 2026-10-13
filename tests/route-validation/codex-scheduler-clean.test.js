import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { DEFAULTS, initialize, loadState, readJson, taskDirectory, writeJson } from "../../tools/codex-scheduler/common.mjs";
import { executeCommand } from "../../tools/codex-scheduler/cli.mjs";
import { cleanInput } from "../../tools/codex-scheduler/clean-command.mjs";

const fixtureDir = fileURLToPath(new URL("../fixtures/route-validation/codex-scheduler/", import.meta.url));
const contract = readJson(join(fixtureDir, "clean-output.json"));
function setup(t, mode = "real-clean") {
  const root = mkdtempSync(join(tmpdir(), "mk-clean-output-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = join(root, "fixture-engine.mjs");
  writeFileSync(command, `#!${process.execPath}\nimport { runCleanFixture } from ${JSON.stringify(new URL("../fixtures/route-validation/codex-scheduler/clean-engine.mjs", import.meta.url).href)}; await runCleanFixture(${JSON.stringify(mode)}, process.argv.slice(2));\n`);
  chmodSync(command, 0o700);
  const config = { ...DEFAULTS, stateDir: join(root, "state"), engineCommand: command };
  initialize(config);
  const source = join(root, "large_SysFormTemplate.xml");
  const xml = readFileSync(resolve(fixtureDir, contract.source), "utf8");
  writeFileSync(source, xml);
  const manifest = join(root, "manifest.json");
  writeJson(manifest, { version: 1, baseUrl: "https://p-sit.onewo.com", targetCategoryId: "fixture-category", actor: "test",
    userInstruction: "Offline import fixture; no external writes", items: [{ sourcePath: source }] });
  return { root, config, source, manifest };
}

describe("large clean output during scheduler intake", () => {
  it("reproduces ENOBUFS with the old pipe limit even though the real cleaner already wrote the artifact", (t) => {
    const { root, config, source } = setup(t);
    const output = join(root, "old-output.json");
    const result = spawnSync(config.engineCommand, ["run", "--", "clean", source, "--out", output], {
      encoding: "utf8", timeout: 60_000, maxBuffer: contract.oldMaxBufferBytes
    });
    assert.equal(result.error?.code, "ENOBUFS");
    assert.equal(existsSync(output), true);
    assert.equal(readJson(output).source.sourceId, contract.sourceId);
    assert.ok(Buffer.byteLength(result.stdout) >= contract.oldMaxBufferBytes);
  });

  it("imports a real clean result with stdout larger than 2 MiB and preserves complete private output logs", async (t) => {
    const { config, manifest } = setup(t);
    const result = await executeCommand(config, "import", { manifest, "confirm-write": true });
    assert.equal(result.imported, 1);
    const state = loadState(config);
    assert.equal(state.paused, true);
    assert.equal(state.tasks[0].status, "queued");
    const dir = taskDirectory(config, state.tasks[0].id);
    const report = readJson(join(dir, "clean.command.json"));
    assert.equal(report.exitCode, 0);
    assert.equal(report.errorCode, null);
    assert.ok(report.stdoutBytes > contract.oldMaxBufferBytes);
    assert.equal(statSync(join(dir, "clean.stdout.log")).mode & 0o777, 0o600);
    const stdout = readJson(join(dir, "clean.stdout.log"));
    assert.equal(stdout.ok, true);
    assert.deepEqual(stdout.sourceDraft, readJson(join(dir, "source-draft.json")));
  });

  it("keeps the exit code and stderr without admitting a nonzero command that wrote an artifact", async (t) => {
    const { config, manifest } = setup(t, "nonzero");
    await assert.rejects(executeCommand(config, "import", { manifest, "confirm-write": true }), /exit=23/);
    const intake = readdirSync(config.stateDir).find((name) => name.startsWith("intake-"));
    const dir = join(config.stateDir, intake);
    const report = readJson(join(dir, "clean.command.json"));
    assert.equal(report.exitCode, 23);
    assert.equal(report.outputExists, true);
    assert.equal(report.errorCode, null);
    assert.match(readFileSync(join(dir, "clean.stderr.log"), "utf8"), /FIXTURE_CLEAN_FAILURE_DETAIL/);
    assert.equal(readJson(join(dir, "intake-failure.json")).cleanReport, "clean.command.json");
    assert.equal(loadState(config).tasks.length, 0);
  });

  it("rejects an exit-zero command without an output artifact and retains its receipt", async (t) => {
    const { config, manifest } = setup(t, "missing-output");
    await assert.rejects(executeCommand(config, "import", { manifest, "confirm-write": true }), /output=false/);
    const intake = readdirSync(config.stateDir).find((name) => name.startsWith("intake-"));
    assert.equal(readJson(join(config.stateDir, intake, "clean.command.json")).outputExists, false);
    assert.equal(loadState(config).tasks.length, 0);
  });

  it("retains a timeout and its partial logs without treating it as a successful clean", (t) => {
    const { root, config, source } = setup(t, "timeout");
    assert.throws(() => cleanInput(config, source, join(root, "timeout-output.json"), { timeoutMs: 750 }), /ETIMEDOUT/);
    const receipt = readJson(join(root, "clean.command.json"));
    assert.equal(receipt.errorCode, "ETIMEDOUT");
    assert.notEqual(receipt.exitCode, 0);
    assert.equal(receipt.outputExists, false);
    assert.match(readFileSync(join(root, "clean.stderr.log"), "utf8"), /FIXTURE_CLEAN_WAITING/);
  });
});
