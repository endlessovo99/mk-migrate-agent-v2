import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { DEFAULTS, directory, initialize, jsonDigest, loadConfig, loadState, readJson, saveState, taskDirectory, writeJson } from "../../tools/codex-scheduler/common.mjs";
import { admission, scheduleAt } from "../../tools/codex-scheduler/schedule.mjs";
import { discoverSources, importManifest, verifySnapshot } from "../../tools/codex-scheduler/intake.mjs";
import { dispatch, reconcile, statusReport } from "../../tools/codex-scheduler/controller.mjs";
import { assessEvidence } from "../../tools/codex-scheduler/evidence.mjs";
import { codexArguments, taskPrompt } from "../../tools/codex-scheduler/prompt.mjs";
import { runWorker } from "../../tools/codex-scheduler/worker.mjs";
import { packageScheduler } from "../../tools/codex-scheduler/package.mjs";
import { cleanSourceFile } from "../../src/translator/index.js";
import { withNetworkGuard } from "./network-guard.js";

const fixtureDir = fileURLToPath(new URL("../fixtures/route-validation/codex-scheduler/", import.meta.url));
const contract = readJson(join(fixtureDir, "contract.json"));
const engine = { status: "unlocked", releaseId: "fake-release", sha256: "a".repeat(64) };
const clean = async (input, output) => writeJson(output, cleanSourceFile(input), { exclusive: true });
const plenty = () => ({ availableMemoryMB: 100_000, freeDiskMB: 100_000 });
const at = (time) => new Date(time);

function setup(t, overrides = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mk-codex-scheduler-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { ...DEFAULTS, stateDir: join(root, "state"), ...overrides };
  const state = initialize(config);
  return { root, config, state };
}

function seed(config, state, count) {
  for (let index = 0; index < count; index++) {
    const id = jsonDigest(`source-${state.tasks.length}`);
    const dir = taskDirectory(config, id);
    directory(dir); directory(join(dir, "work"));
    writeJson(join(dir, "task.json"), { id, sourceId: id, files: [], engine }, { exclusive: true });
    state.tasks.push({ id, sourceId: id, status: "queued" });
  }
  state.paused = false;
  saveState(config, state);
}

function manifest(sourcePath) {
  return { version: 1, baseUrl: "https://p-sit.onewo.com", targetCategoryId: "fake-category", actor: "test-operator",
    userInstruction: "迁移清单中的一个测试流程到指定目标和分类，只新建草稿。", items: [{ sourcePath }] };
}

async function imported(t) {
  const env = setup(t);
  const source = resolve(fixtureDir, contract.source);
  await importManifest(env.config, env.state, manifest(source), { relativeTo: env.root, confirmWrite: true, clean, engine });
  const dir = taskDirectory(env.config, env.state.tasks[0].id);
  return { ...env, dir, task: readJson(join(dir, "task.json")), source };
}

async function runFake(t, mode = "success") {
  const env = await imported(t);
  const fake = join(env.root, "codex");
  cpSync(join(fixtureDir, "fake-codex.mjs"), fake);
  chmodSync(fake, 0o700);
  env.config.codexCommand = fake;
  env.config.skillPath = fileURLToPath(new URL("../../skills/mk-migrate-server/SKILL.md", import.meta.url));
  env.state.paused = false;
  await dispatch(env.config, env.state, { manualCount: 1, inspect: () => "inactive", measure: plenty, launch: () => true });
  const previous = process.env.MK_FAKE_CODEX_MODE;
  process.env.MK_FAKE_CODEX_MODE = mode;
  let result;
  try { result = await withNetworkGuard(() => runWorker(env.dir, { status: () => engine })); }
  finally { if (previous === undefined) delete process.env.MK_FAKE_CODEX_MODE; else process.env.MK_FAKE_CODEX_MODE = previous; }
  return { ...env, result };
}

describe("Codex server session scheduler route", () => {
  it("uses Shanghai weekdays, exact transition slots and weekend cadence independently of host timezone", () => {
    for (const example of contract.cases) {
      const slot = scheduleAt(at(example.at));
      assert.equal(slot.timeZone, contract.timeZone);
      assert.equal(slot.mode, example.mode, example.at);
      assert.equal(slot.batchSize, example.size, example.at);
      assert.equal(slot.due, example.due, example.at);
    }
    for (const [start, expected] of [["2026-10-11T16:00:00Z", 1320], ["2026-10-16T16:00:00Z", 1920]]) {
      let count = 0;
      for (let minute = 0; minute < 1440; minute++) {
        const slot = scheduleAt(new Date(Date.parse(start) + minute * 60_000));
        if (slot.due) count += slot.batchSize;
      }
      assert.equal(count, expected);
    }
  });

  it("limits admission by all active sessions, available memory and disk, without killing tasks", () => {
    const metrics = { active: 17, availableMemoryMB: 15_000, freeDiskMB: 10_000 };
    assert.equal(admission(DEFAULTS, metrics, 20).count, 3);
    assert.equal(admission(DEFAULTS, { ...metrics, active: 0, availableMemoryMB: 3600 }, 20).count, 1);
    assert.equal(admission(DEFAULTS, { ...metrics, freeDiskMB: 100 }, 20).reason, "disk_reserve");
    assert.equal(admission(DEFAULTS, { ...metrics, active: 30 }, 20).count, 0);
  });

  it("dispatches a high wave once, shares capacity with manual starts and survives a controller restart", async (t) => {
    const { config, state } = setup(t, { maxSessions: 25 }); seed(config, state, 60);
    let launched = 0;
    const options = { now: at("2026-10-12T11:00:00Z"), measure: plenty, inspect: () => "active", launch: () => { launched++; return true; } };
    assert.equal((await dispatch(config, state, options)).started, 20);
    const restored = loadState(config);
    assert.equal((await dispatch(config, restored, options)).started, 0);
    assert.equal((await dispatch(config, restored, { ...options, manualCount: 10 })).started, 5);
    assert.equal(launched, 25);
    assert.equal((await dispatch(config, restored, { ...options, now: at("2026-10-12T11:15:00Z") })).started, 0);
    assert.equal((await dispatch(config, restored, { ...options, now: at("2026-10-12T11:16:00Z") })).started, 0);
  });

  it("switches to daytime without terminating night workers, and does not backfill missed slots", async (t) => {
    const { config, state } = setup(t, { maxSessions: 50 }); seed(config, state, 90);
    const common = { measure: plenty, inspect: () => "active", launch: () => true };
    assert.equal((await dispatch(config, state, { ...common, now: at("2026-10-11T22:45:00Z") })).started, 20);
    assert.equal((await dispatch(config, state, { ...common, now: at("2026-10-11T23:00:00Z") })).started, 10);
    assert.equal(state.tasks.filter((task) => ["running", "dispatched"].includes(task.status)).length, 30);
    assert.equal((await dispatch(config, state, { ...common, now: at("2026-10-12T01:03:00Z") })).started, 0);
    assert.equal((await dispatch(config, state, { ...common, now: at("2026-10-12T01:20:00Z") })).started, 10);
  });

  it("pause prevents both manual and timer admission while reconciliation still observes existing workers", async (t) => {
    const { config, state } = setup(t); seed(config, state, 5);
    await dispatch(config, state, { manualCount: 1, measure: plenty, launch: () => true });
    state.paused = true;
    const common = { now: at("2026-10-12T11:00:00Z"), inspect: () => "active", measure: plenty, launch: () => assert.fail("paused") };
    assert.equal((await dispatch(config, state, common)).reason, "paused");
    assert.equal((await dispatch(config, state, { ...common, manualCount: 1 })).started, 0);
    assert.equal(state.tasks[0].status, "running");
  });

  it("retains launch uncertainty, counts late-running units and never requeues failed attempts", async (t) => {
    const { config, state } = setup(t); seed(config, state, 1);
    await dispatch(config, state, { manualCount: 1, measure: plenty, launch: () => { throw new Error("systemd response lost"); } });
    assert.equal(state.tasks[0].launchAcknowledged, false);
    reconcile(config, state, { inspect: () => "inactive" });
    assert.equal(state.tasks[0].status, "outcome_unknown");
    assert.equal(reconcile(config, state, { inspect: () => "activating" }), 1);
    reconcile(config, state, { inspect: () => "failed" });
    assert.equal((await dispatch(config, state, { manualCount: 1, measure: plenty, inspect: () => "inactive", launch: () => assert.fail("replayed") })).started, 0);
    await assert.rejects(dispatch(config, state, { manualCount: 1, taskId: state.tasks[0].id, inspect: () => "inactive", measure: plenty }), /not queued/);
  });

  it("recovers a crash between durable launch preparation and queue persistence without replay", (t) => {
    const { config, state } = setup(t); seed(config, state, 2);
    state.pendingAdmissions = state.tasks.map((task) => task.id);
    writeJson(join(taskDirectory(config, state.tasks[0].id), "launch-intent.json"), { dispatchedAt: "2026-10-12T11:00:00Z" });
    writeJson(join(taskDirectory(config, state.tasks[1].id), "run-config.json"), config);
    reconcile(config, state, { inspect: () => "inactive" });
    assert.equal(state.tasks[0].status, "outcome_unknown");
    assert.equal(state.tasks[1].status, "needs_attention");
    assert.deepEqual(state.pendingAdmissions, []);
  });

  it("uses the real cleaner for frozen identity, rejects category bypass and preserves successful state on duplicate import", async (t) => {
    const env = await imported(t);
    assert.equal(env.task.sourceId, "route-multi-batch-template");
    env.state.tasks[0].status = "succeeded";
    const repeated = await importManifest(env.config, env.state, manifest(env.source), { relativeTo: env.root, confirmWrite: true, clean, engine });
    assert.deepEqual(repeated, { imported: 0, existing: 1 });
    assert.equal(env.state.tasks[0].status, "succeeded");
    await assert.rejects(importManifest(env.config, env.state, { ...manifest(env.source), targetCategoryId: "another-category" },
      { relativeTo: env.root, confirmWrite: true, clean, engine }), /different input or target/);
    await assert.rejects(importManifest(env.config, env.state, manifest(env.source), { relativeTo: env.root, confirmWrite: false, clean, engine }), /confirm-write/);
    const snapshotPath = join(env.dir, "source", env.task.files[0].name);
    chmodSync(snapshotPath, 0o600); writeFileSync(snapshotPath, "changed");
    assert.throws(() => verifySnapshot(env.task, env.dir), /changed/);
  });

  it("discovers single inputs and paired directories and rejects ambiguous/symlinked intake", (t) => {
    const { root } = setup(t);
    const inputs = join(root, "input"); directory(inputs);
    writeFileSync(join(inputs, "a_SysFormTemplate.xml"), "a");
    assert.deepEqual(discoverSources(inputs), [join(inputs, "a_SysFormTemplate.xml")]);
    writeFileSync(join(inputs, "a_LbpmProcessDefinition.xml"), "b");
    assert.deepEqual(discoverSources(inputs), [inputs]);
    writeFileSync(join(inputs, "b_SysFormTemplate.xml"), "c");
    assert.throws(() => discoverSources(inputs), /Ambiguous/);
    const linked = join(root, "linked"); symlinkSync(inputs, linked);
    assert.throws(() => discoverSources(linked), /symlink/);
  });

  it("keeps a real form/workflow pair together and deduplicates the same source copied to another path", async (t) => {
    const { root, config, state } = setup(t);
    const source = resolve(fixtureDir, "../paired");
    await importManifest(config, state, manifest(source), { relativeTo: root, confirmWrite: true, clean, engine });
    const task = readJson(join(taskDirectory(config, state.tasks[0].id), "task.json"));
    assert.equal(task.directoryInput, true);
    assert.ok(task.files.some((file) => file.name.endsWith("_LbpmProcessDefinition.xml")));
    const duplicate = join(root, "copied-input"); cpSync(source, duplicate, { recursive: true });
    assert.equal((await importManifest(config, state, manifest(duplicate), { relativeTo: root, confirmWrite: true, clean, engine })).existing, 1);
    assert.equal(state.tasks.length, 1);
  });

  it("retains rejected intake evidence and never starts it", async (t) => {
    const { root, config, state } = setup(t);
    await assert.rejects(importManifest(config, state, manifest(resolve(fixtureDir, contract.source)), {
      relativeTo: root, confirmWrite: true, engine, clean: async () => { throw new Error("fake parser rejection"); }
    }), /fake parser rejection/);
    assert.equal(loadState(config).paused, true);
    assert.equal(loadState(config).tasks.length, 0);
    const retained = readdirSync(config.stateDir).find((name) => name.startsWith("intake-"));
    assert.ok(existsSync(join(config.stateDir, retained, "intake-failure.json")));
    assert.ok(readdirSync(join(config.stateDir, retained, "source")).length > 0);
  });

  it("runs a real fake-Codex subprocess, persists its thread and accepts only scoped successful receipts", async (t) => {
    const env = await runFake(t);
    assert.equal(env.result.status, "succeeded");
    assert.equal(env.result.threadId, "fake-thread-001");
    assert.equal(env.result.usage.input_tokens, 100);
    reconcile(env.config, env.state, { inspect: () => "inactive" });
    assert.equal(statusReport(env.config, env.state).counts.succeeded, 1);
    assert.equal(statusReport(env.config, env.state).durationSampleCount, 1);
    await assert.rejects(runWorker(env.dir, { status: () => engine }), /EEXIST/);
    assert.ok(codexArguments(env.config, env.dir).includes('approval_policy="never"'));
    assert.ok(!codexArguments(env.config, env.dir).includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(taskPrompt(env.config, env.task, env.dir).includes("最多允许 2 次"));
    assert.ok(taskPrompt(env.config, env.task, env.dir).includes("必须使用绝对路径"));
  });

  for (const [mode, expected] of [["prose-only", "needs_attention"], ["unknown", "outcome_unknown"], ["interrupted", "outcome_unknown"], ["readback-failed", "needs_repair"]]) {
    it(`does not mistake ${mode} for success or auto-retry it`, async (t) => {
      const env = await runFake(t, mode);
      assert.equal(env.result.status, expected);
      reconcile(env.config, env.state, { inspect: () => "inactive" });
      assert.equal((await dispatch(env.config, env.state, { manualCount: 1, inspect: () => "inactive", measure: plenty, launch: () => assert.fail("replayed") })).started, 0);
    });
  }

  it("rejects changed source/target/DSL evidence and missing intent even when the report says success", async (t) => {
    const env = await runFake(t);
    const intentPath = join(env.dir, "work/write-intent-001.json");
    const intent = readJson(intentPath);
    writeJson(intentPath, { ...intent, targetCategoryId: "wrong" });
    assert.equal(assessEvidence(env.task, env.dir, { code: 0 }).status, "outcome_unknown");
    writeJson(intentPath, intent);
    writeFileSync(join(env.dir, "work/migration-001.dsl.json"), "{}");
    assert.equal(assessEvidence(env.task, env.dir, { code: 0 }).status, "outcome_unknown");
    rmSync(intentPath);
    assert.equal(assessEvidence(env.task, env.dir, { code: 0 }).status, "outcome_unknown");
  });

  it("blocks an engine upgrade before Codex starts and preserves the claimed task", async (t) => {
    const env = await imported(t);
    env.config.skillPath = fileURLToPath(new URL("../../skills/mk-migrate-server/SKILL.md", import.meta.url));
    env.state.paused = false;
    await dispatch(env.config, env.state, { manualCount: 1, measure: plenty, launch: () => true });
    const result = await runWorker(env.dir, { status: () => ({ ...engine, releaseId: "changed" }), spawnCodex: () => assert.fail("started") });
    assert.equal(result.status, "needs_attention");
    assert.equal(existsSync(join(env.dir, "events.jsonl")), false);
  });

  it("validates configuration and packages only the standalone scheduler and operator skill", (t) => {
    const { root, config } = setup(t);
    const path = join(root, "config.json"); writeJson(path, config);
    assert.equal(loadConfig(path).maxSessions, 20);
    writeJson(path, { ...config, maxSessions: 0 }); assert.throws(() => loadConfig(path), /maxSessions/);
    writeJson(path, { ...config, providerKey: "not-allowed" }); assert.throws(() => loadConfig(path), /Unsupported/);
    const result = packageScheduler(join(root, "package"));
    const manifestText = readFileSync(join(root, "package/mk-codex-scheduler/MANIFEST.sha256"), "utf8");
    assert.ok(manifestText.includes("mk-migrate-server/SKILL.md"));
    assert.ok(!manifestText.includes("src/executor"));
    assert.ok(!manifestText.includes(".env"));
    assert.equal(spawnSync("sh", ["-n", join(root, "package/mk-codex-scheduler/install.sh")]).status, 0);
    const listing = spawnSync("tar", ["-tzf", result.archive], { encoding: "utf8" });
    assert.equal(listing.status, 0);
    assert.ok(listing.stdout.includes("mk-codex-scheduler/worker.mjs"));
    assert.ok(!listing.stdout.includes("node_modules"));
    assert.ok(readFileSync(join(root, "package/INSTALL.md"), "utf8").includes("--confirm-write"));
  });
});
