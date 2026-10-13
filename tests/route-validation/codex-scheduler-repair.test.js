import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { DEFAULTS, applyConfig, attemptDirectory, digest, directory, initialize, loadConfig, loadState, readJson, taskDirectory, taskUnitName, writeJson } from "../../tools/codex-scheduler/common.mjs";
import { dispatch, reconcile, statusReport } from "../../tools/codex-scheduler/controller.mjs";
import { assessEvidence } from "../../tools/codex-scheduler/evidence.mjs";
import { repairDecision, evidenceManifest } from "../../tools/codex-scheduler/repair.mjs";
import { importManifest } from "../../tools/codex-scheduler/intake.mjs";
import { runWorker } from "../../tools/codex-scheduler/worker.mjs";
import { taskPrompt } from "../../tools/codex-scheduler/prompt.mjs";
import { executeCommand } from "../../tools/codex-scheduler/cli.mjs";
import { unitMetrics } from "../../tools/codex-scheduler/linux-metrics.mjs";
import { cleanSourceFile } from "../../src/translator/index.js";
import { withNetworkGuard } from "./network-guard.js";

const fixtures = fileURLToPath(new URL("../fixtures/route-validation/codex-scheduler/", import.meta.url));
const fixture = readJson(join(fixtures, "repair.json"));
const engine = { status: "unlocked", releaseId: "fixture-release", sha256: "a".repeat(64) };
const inactive = () => "inactive";
const operations = { inspect: inactive, measure: () => ({ availableMemoryMB: 100_000, freeDiskMB: 100_000 }), launch: () => true };
const time = (minutes = 0) => new Date(Date.parse("2026-10-11T06:00:00Z") + minutes * 60_000);

async function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mk-scheduler-repair-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = join(root, "fake-codex"); copyFileSync(join(fixtures, "fake-codex.mjs"), fake); chmodSync(fake, 0o700);
  const config = { ...DEFAULTS, stateDir: join(root, "state"), codexCommand: fake,
    skillPath: fileURLToPath(new URL("../../skills/mk-migrate-server/SKILL.md", import.meta.url)) };
  const state = initialize(config);
  const manifest = { version: 1, baseUrl: "https://p-sit.onewo.com", targetCategoryId: "fixture-category", actor: "fixture",
    userInstruction: "Migrate the authorized fixture", items: [{ sourcePath: join(fixtures, "../multi-batch/route-multi-batch_SysFormTemplate.xml") }] };
  await importManifest(config, state, manifest, { relativeTo: root, confirmWrite: true, engine,
    clean: async (input, output) => writeJson(output, cleanSourceFile(input)) });
  state.paused = false;
  await dispatch(config, state, { ...operations, now: time() });
  const entry = state.tasks[0], dir = taskDirectory(config, entry.id), task = readJson(join(dir, "task.json"));
  const env = { root, config, state, entry, dir, task };
  finish(env);
  return env;
}

function finish(env, changes = {}, number = "001") {
  const dir = attemptDirectory(env.config, env.entry.id, env.entry.repairAttempts || 0);
  const dsl = { derivedFrom: { sourceId: env.task.sourceId } }, dslFile = `migration-${number}.dsl.json`;
  writeJson(join(dir, "work", dslFile), dsl);
  const dslSha256 = digest(readFileSync(join(dir, "work", dslFile)));
  writeJson(join(dir, "work", `write-intent-${number}.json`), { version: 1, taskId: env.task.id,
    baseUrl: env.task.baseUrl, targetCategoryId: env.task.targetCategoryId, dslFile, dslSha256, reportFile: `execution-${number}.report.json` });
  writeJson(join(dir, "work", `execution-${number}.report.json`), { ...structuredClone(fixture.safeFailure), baseUrl: env.task.baseUrl, ...changes });
  const process = { code: 0, signal: null };
  const completion = { ...assessEvidence(env.task, dir, process), process, durationSeconds: 30, completedAt: time().toISOString() };
  writeJson(join(dir, "completion.json"), completion);
  reconcile(env.config, env.state, { inspect: inactive });
  return dir;
}

it("continues legacy safe failures on a future slot, preserves all history, and exposes attempts", async (t) => {
  const env = await setup(t);
  const completion = readJson(join(env.dir, "completion.json")); delete completion.noRemoteWriteConfirmed;
  writeJson(join(env.dir, "completion.json"), completion); // v3 completions do not have the new field.
  const before = evidenceManifest(env.dir);
  assert.equal(repairDecision(env.config, env.entry, inactive).eligible, true);
  assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(1) })).started, 0);
  assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(15) })).started, 1);
  assert.equal(env.entry.repairAttempts, 1);
  const dir = attemptDirectory(env.config, env.entry.id, 1);
  assert.equal(readJson(join(dir, "launch-intent.json")).unit, taskUnitName(env.entry.id, 1));
  assert.deepEqual(evidenceManifest(env.dir), before);
  const context = readJson(join(dir, "repair-context.json"));
  assert.equal(context.history.length, 1);
  const prompt = taskPrompt(env.config, env.task, dir, context);
  assert.ok(prompt.includes("第 1/10 轮自动修复")); assert.ok(prompt.includes("repair-plan.json"));
  const result = await withNetworkGuard(() => runWorker(dir, { status: () => engine, inspect: inactive }));
  assert.equal(result.status, "succeeded");
  reconcile(env.config, env.state, { inspect: inactive });
  assert.equal(env.entry.status, "succeeded");
  assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(30) })).started, 0);
  const item = await executeCommand(env.config, "item", { task: env.entry.id });
  assert.equal(item.attempts.length, 2); assert.equal(item.directory, dir);
  assert.equal(item.attempts[0].completion.status, "needs_attention");
  assert.deepEqual(evidenceManifest(env.dir), before);
});

it("allows exactly ten automatic repair admissions, persists the count across restarts, and never creates an eleventh", async (t) => {
  const env = await setup(t);
  for (let attempt = 1; attempt <= fixture.maxAutomaticRepairs; attempt++) {
    assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(attempt * 15) })).started, 1);
    assert.equal(env.entry.repairAttempts, attempt);
    finish(env);
    env.state = loadState(env.config); // dispatch persisted the new attempt before starting it.
    env.entry = env.state.tasks[0]; reconcile(env.config, env.state, { inspect: inactive });
  }
  assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(165) })).started, 0);
  assert.equal(env.entry.autoRepair.reason, "retry_limit_reached");
  assert.equal(env.entry.status, "needs_attention");
  assert.equal(statusReport(env.config, env.state).repairAttemptsUsed, 10);
  assert.equal(existsSync(join(env.dir, "attempts/011")), false);
});

it("raises an exhausted five-round budget to ten without resetting counts or changing old evidence", async (t) => {
  const env = await setup(t);
  env.config.maxAutoRepairAttempts = 5;
  for (let attempt = 1; attempt <= 5; attempt++) {
    assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(attempt * 15) })).started, 1);
    finish(env);
  }
  assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(90) })).started, 0);
  assert.equal(env.entry.autoRepair.reason, "retry_limit_reached");
  const old = evidenceManifest(attemptDirectory(env.config, env.entry.id, 5));
  const configPath = join(env.root, "config.json"), candidatePath = join(env.root, "candidate.json");
  writeJson(configPath, env.config); writeJson(candidatePath, { ...env.config, maxAutoRepairAttempts: 10 });
  applyConfig(configPath, candidatePath); env.config = loadConfig(configPath);
  assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(105) })).started, 1);
  assert.equal(env.entry.repairAttempts, 6);
  const context = readJson(join(attemptDirectory(env.config, env.entry.id, 6), "repair-context.json"));
  assert.equal(context.history.length, 6);
  assert.deepEqual(evidenceManifest(attemptDirectory(env.config, env.entry.id, 5)), old);
  assert.equal(readJson(join(attemptDirectory(env.config, env.entry.id, 5), "run-config.json")).maxAutoRepairAttempts, 5);
  const result = await withNetworkGuard(() => runWorker(attemptDirectory(env.config, env.entry.id, 6), { status: () => engine, inspect: inactive }));
  assert.equal(result.status, "succeeded");
});

it("blocks every remote-effect marker even when state incorrectly says needs_attention", async (t) => {
  for (const changes of fixture.unsafeChanges) {
    const env = await setup(t); finish(env, changes); env.entry.status = "needs_attention";
    assert.equal(repairDecision(env.config, env.entry, inactive).eligible, false, JSON.stringify(changes));
    assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(15) })).started, 0);
  }
});

it("blocks missing reports, orphan intents, modified DSL, changed receipts and unbound receipts", async (t) => {
  for (const change of [
    (e) => rmSync(join(e.dir, "work/execution-001.report.json")),
    (e) => writeJson(join(e.dir, "work/write-intent-002.json"), {}),
    (e) => writeJson(join(e.dir, "work/migration-001.dsl.json"), {}),
    (e) => writeJson(join(e.dir, "work/execution-001.report.json"), { ...fixture.safeFailure, baseUrl: e.task.baseUrl, changed: true }),
    (e) => writeJson(join(e.dir, "work/unbound.json"), { remoteWriteAttempted: true }),
    (e) => rmSync(join(e.dir, "completion.json"))
  ]) {
    const env = await setup(t); change(env);
    assert.equal(repairDecision(env.config, env.entry, inactive).eligible, false);
  }
});

it("accepts retained CLI stdout copies only when they match their bound no-write execution receipt", async (t) => {
  for (const copy of fixture.stdoutCopies) {
    const env = await setup(t), reportPath = join(env.dir, "work/execution-001.report.json");
    const report = readJson(reportPath);
    // The real CLI prints {...report, wrote: args.out}; property order is not report content.
    const output = { ...Object.fromEntries(Object.entries(report).reverse()), ...(copy.includeWrote ? { wrote: reportPath } : {}) };
    writeJson(join(env.dir, "work", copy.name), output);
    const before = evidenceManifest(env.dir);
    assert.equal(repairDecision(env.config, env.entry, inactive).eligible, true, copy.name);
    assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(15) })).started, 1);
    const result = await withNetworkGuard(() => runWorker(attemptDirectory(env.config, env.entry.id, 1), { status: () => engine, inspect: inactive }));
    assert.equal(result.status, "succeeded");
    assert.deepEqual(evidenceManifest(env.dir), before);
  }
});

it("keeps changed, unbound and misleading stdout evidence out of automatic repair", async (t) => {
  const cases = [
    { change: (r) => ({ ...r, remoteWriteAttempted: true }), detail: "stdout_receipt_mismatch" },
    { change: (r) => ({ ...r, writeOutcomeUnknown: true }), detail: "stdout_receipt_mismatch" },
    { change: (r) => ({ ...r, templateId: "created-target" }), detail: "stdout_receipt_mismatch" },
    { change: (r) => ({ ...r, baseUrl: "https://other.invalid" }), detail: "stdout_receipt_mismatch" },
    { change: (r) => ({ ...r, extra: "untrusted-secret-sentinel" }), detail: "stdout_receipt_mismatch" },
    { change: (r) => { const { remoteWriteAttempted, ...rest } = r; return rest; }, detail: "stdout_receipt_mismatch" },
    { change: (r) => ({ ...r, wrote: "/another/execution-001.report.json" }), detail: "stdout_receipt_path_mismatch" },
    { change: (r) => ({ ...r, wrote: "execution-001.report.json" }), detail: "stdout_receipt_path_mismatch" },
    { name: "execution-002.stdout.json", detail: "unbound_execution_evidence" },
    { name: "blocker-summary.json", detail: "unbound_execution_evidence" }
  ];
  for (const example of cases) {
    const env = await setup(t), report = readJson(join(env.dir, "work/execution-001.report.json"));
    writeJson(join(env.dir, "work", example.name || "execution-001.stdout.json"), example.change ? example.change(report) : report);
    const decision = repairDecision(env.config, env.entry, inactive);
    assert.equal(decision.eligible, false); assert.equal(decision.detail, example.detail);
    assert.equal(JSON.stringify(decision).includes("untrusted-secret-sentinel"), false);
    assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(15) })).started, 0);
    assert.equal(env.entry.autoRepair.detail, example.detail);
  }
});

it("binds both stdout naming variants to their numbered reports across local execution attempts", async (t) => {
  const env = await setup(t); finish(env, { stage: "resolveConditionOrgs" }, "002");
  for (const [number, prefix] of [["001", "execute"], ["002", "execution"]]) {
    const reportPath = join(env.dir, "work", `execution-${number}.report.json`);
    writeJson(join(env.dir, "work", `${prefix}-${number}.stdout.json`), { ...readJson(reportPath), wrote: reportPath });
  }
  assert.equal(repairDecision(env.config, env.entry, inactive).eligible, true);
  const path = join(env.dir, "work/execution-002.stdout.json"), value = readJson(path);
  value.wrote = join(env.dir, "work/execution-001.report.json"); writeJson(path, value);
  assert.equal(repairDecision(env.config, env.entry, inactive).detail, "stdout_receipt_path_mismatch");
});

it("reports invalid JSON without exposing its content or treating it as no-write evidence", async (t) => {
  const env = await setup(t);
  writeFileSync(join(env.dir, "work/execution-001.stdout.json"), "{untrusted-secret-sentinel");
  const decision = repairDecision(env.config, env.entry, inactive);
  assert.equal(decision.eligible, false); assert.equal(decision.detail, "evidence_json_invalid");
  assert.equal(JSON.stringify(decision).includes("untrusted-secret-sentinel"), false);
});

it("does not treat missing execution evidence or exit zero as proof of no writes", async (t) => {
  const env = await setup(t);
  for (const name of ["execution-001.report.json", "write-intent-001.json"]) rmSync(join(env.dir, "work", name));
  writeJson(join(env.dir, "completion.json"), { status: "needs_attention", reason: "no_execution_receipt", process: { code: 0 }, evidence: [] });
  writeJson(join(env.dir, "work/blocked-001.report.json"), { remoteWriteAttempted: false, writeOutcomeUnknown: false });
  const decision = repairDecision(env.config, env.entry, inactive);
  assert.equal(decision.eligible, false); assert.equal(decision.detail, "execution_receipt_missing");
});

it("rechecks all prior history before admission and again before launching a repair Codex process", async (t) => {
  const env = await setup(t);
  await dispatch(env.config, env.state, { ...operations, now: time(15) });
  writeJson(join(env.dir, "extra-evidence.json"), { changed: true });
  const result = await runWorker(attemptDirectory(env.config, env.entry.id, 1), {
    status: () => engine, inspect: inactive, spawnCodex: () => assert.fail("unsafe child launched")
  });
  assert.equal(result.status, "needs_attention"); assert.equal(result.reason, "worker_preflight_failed");
  reconcile(env.config, env.state, { inspect: inactive });
  assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(30) })).started, 0);
});

it("never repairs while a prior unit is live, while paused, off-slot, or above resource/concurrency limits", async (t) => {
  const env = await setup(t);
  assert.equal(repairDecision(env.config, env.entry, () => "active").eligible, false);
  env.state.paused = true;
  assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(15) })).reason, "paused");
  env.state.paused = false;
  assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(1) })).started, 0);
  assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(15), measure: () => ({ availableMemoryMB: 1, freeDiskMB: 1 }) })).started, 0);
  const id = "b".repeat(64), dir = taskDirectory(env.config, id); directory(dir);
  env.state.tasks.push({ id, status: "running", dispatchedAt: time().toISOString() });
  env.config.maxSessions = 1;
  assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(30), inspect: (id) => id === env.entry.id ? "inactive" : "active" })).started, 0);
  assert.equal(existsSync(join(env.dir, "attempts")), false);
});

it("consumes a partially prepared retry on crash, and never relaunches an uncertain admission", async (t) => {
  const env = await setup(t);
  env.state.pendingAdmissions = [{ id: env.entry.id, attempt: 1 }];
  directory(attemptDirectory(env.config, env.entry.id, 1));
  reconcile(env.config, env.state, { inspect: inactive });
  assert.equal(env.entry.repairAttempts, 1);
  assert.equal(env.entry.reason, "interrupted_launch_preparation");
  assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(15) })).started, 0);
  const other = await setup(t);
  await dispatch(other.config, other.state, { ...operations, now: time(15), launch: () => { throw new Error("ack lost"); } });
  reconcile(other.config, other.state, { inspect: inactive });
  assert.equal(other.entry.status, "outcome_unknown");
  assert.equal((await dispatch(other.config, other.state, { ...operations, now: time(30) })).started, 0);
  assert.equal(reconcile(other.config, other.state, { inspect: (_id, attempt) => attempt === 1 ? "active" : "inactive" }), 1);
});

it("supports disabling repairs, rejects budgets above ten, and recognizes two-digit retry resource units", async (t) => {
  const env = await setup(t), configPath = join(env.root, "config.json");
  const legacy = { ...env.config }; delete legacy.maxAutoRepairAttempts;
  writeJson(configPath, legacy); assert.equal(loadConfig(configPath).maxAutoRepairAttempts, 10);
  writeJson(configPath, { ...env.config, maxAutoRepairAttempts: 11 }); assert.throws(() => loadConfig(configPath), /maxAutoRepairAttempts/);
  env.config.maxAutoRepairAttempts = 0;
  assert.equal((await dispatch(env.config, env.state, { ...operations, now: time(15) })).started, 0);
  assert.equal(env.entry.autoRepair.reason, "disabled");
  const metrics = unitMetrics({ Id: taskUnitName(env.entry.id, 10), ActiveState: "active" });
  assert.equal(metrics.taskId, env.entry.id); assert.equal(metrics.repairAttempt, 10);
  assert.equal(unitMetrics({ Id: taskUnitName(env.entry.id, 11), ActiveState: "active" }), null);
});
