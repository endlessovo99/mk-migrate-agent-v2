// Optional Linux packaging/CLI/flock smoke. Fake systemd, Codex and engine; no network or business writes.
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { packageScheduler } from "../tools/codex-scheduler/package.mjs";

function command(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 ** 2 });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return result.stdout;
}

if (process.argv.includes("--inside")) {
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid(), 0);
  for (const dir of ["/etc/systemd/system", "/var/lib/mk-migrate/input", "/tmp/fake-units"]) mkdirSync(dir, { recursive: true });
  function executable(path, text) { writeFileSync(path, text); chmodSync(path, 0o700); }
  executable("/usr/local/bin/systemctl", `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'list-units') {
  for (const name of fs.readdirSync('/tmp/fake-units').filter(x => x.endsWith('.service')))
    console.log(name + ' loaded ' + fs.readFileSync('/tmp/fake-units/' + name, 'utf8') + ' running Task');
}
if (args[0] === 'show') {
  if (args.includes('--property=Version')) console.log('fake-systemd');
  else if (args.some(x => x.startsWith('--property=Id,'))) {
    for (const name of args.filter(x => /^mk-codex-task-[a-f0-9]+(?:-r(?:[1-9]|10))?\\.service$/.test(x))) {
      const state = fs.existsSync('/tmp/fake-units/' + name) ? fs.readFileSync('/tmp/fake-units/' + name, 'utf8') : 'inactive';
      console.log('Id=' + name + '\\nActiveState=' + state + '\\nInvocationID=invocation-' + name + '\\nCPUUsageNSec=1000000000\\nMemoryCurrent=104857600\\nMemoryPeak=18446744073709551615\\nTasksCurrent=3\\nIOReadBytes=1000\\nIOWriteBytes=500\\n');
    }
  }
  else { const path = '/tmp/fake-units/' + args[1]; console.log(fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : 'inactive'); }
}
if (['stop', 'kill', 'restart'].includes(args[0]) && args.some(x => x.startsWith('mk-codex-task-'))) process.exit(99);
`);
  executable("/usr/local/bin/systemd-run", `#!/usr/bin/env node
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-systemd'); process.exit(0); }
if (args[0] === 'supervise') {
  const [_, unit, program, ...rest] = args;
  const child = spawn(program, rest, {stdio:'ignore'});
  child.on('exit', () => fs.writeFileSync('/tmp/fake-units/' + unit, 'inactive'));
  child.on('error', () => fs.writeFileSync('/tmp/fake-units/' + unit, 'failed'));
} else {
  const unit = args.find(x => x.startsWith('--unit=')).slice(7);
  if (!args.includes('--service-type=exec') || !args.includes('--property=Restart=no')) process.exit(2);
  const start = args.findIndex(x => x.startsWith('/'));
  fs.writeFileSync('/tmp/fake-units/' + unit, 'active');
  fs.writeFileSync('/tmp/fake-units/' + unit + '.command.json', JSON.stringify(args.slice(start)));
  const child = spawn(process.execPath, [__filename, 'supervise', unit, ...args.slice(start)], {detached:true, stdio:'ignore'});
  child.unref();
}
`);
  executable("/usr/local/bin/codex", `#!/bin/sh
if [ "$2" = '--help' ]; then
  printf '%s\n' '--json --skip-git-repo-check --sandbox --add-dir --output-last-message'
  exit 0
fi
export MK_FAKE_CODEX_WAIT_FILE=/tmp/fake-codex-release
if [ -f /tmp/fake-codex-mode ]; then export MK_FAKE_CODEX_MODE="$(cat /tmp/fake-codex-mode)"; fi
exec node /repo/tests/fixtures/route-validation/codex-scheduler/fake-codex.mjs "$@"
`);
  executable("/usr/local/bin/mk-migrate-secure", `#!/usr/bin/env node
(async () => {
  const fs = require('node:fs');
  const args = process.argv.slice(2);
  if (args[0] === 'status') { console.log(JSON.stringify({status:'unlocked', releaseId:'fake-release',sha256:'a'.repeat(64)})); return; }
  if (args[2] !== 'clean') process.exit(2);
  const {cleanSourceFile} = await import('/repo/src/translator/index.js');
  const draft = cleanSourceFile(args[3]);
  fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify(draft));
  if (fs.existsSync('/tmp/clean-large-output')) {
    console.log(JSON.stringify({ok:true,sourceDraft:draft}));
    process.stdout.write(' '.repeat(3 * 1024 * 1024));
  }
})().catch(() => process.exit(1));
`);
  let firstInstaller = "/delivery/mk-codex-scheduler/install.sh";
  if (process.env.MK_SMOKE_LEGACY === "1") {
    mkdirSync("/tmp/legacy"); command("tar", ["-xzf", "/legacy.tar.gz", "-C", "/tmp/legacy"]);
    firstInstaller = "/tmp/legacy/mk-codex-scheduler/install.sh";
  }
  console.log('Linux smoke: install the initial package');
  const output = command("sh", [firstInstaller]);
  assert.ok(output.includes("队列保持暂停"));
  const configPath = "/etc/mk-migrate/codex-scheduler.json";
  const config = JSON.parse(readFileSync(configPath));
  Object.assign(config, { maxSessions: 2, minAvailableMemoryMB: 1, estimatedSessionMemoryMB: 1, minFreeDiskMB: 1 });
  writeFileSync(configPath, JSON.stringify(config));
  assert.equal(JSON.parse(command("mk-codex-scheduler", ["doctor"])).ok, true);
  assert.equal(JSON.parse(command("mk-codex-scheduler", ["status"])).paused, true);
  const xml = readFileSync("/repo/tests/fixtures/route-validation/multi-batch/route-multi-batch_SysFormTemplate.xml", "utf8");
  for (let index = 0; index < 3; index++) writeFileSync(`/var/lib/mk-migrate/input/task-${index}_SysFormTemplate.xml`, xml.replaceAll("route-multi-batch-template", `test-source-${index}`));
  writeFileSync("/tmp/instruction.txt", "仅测试：迁移三个假流程到测试目标分类。");
  command("mk-codex-scheduler", ["plan", "--input-root", "/var/lib/mk-migrate/input", "--base-url", "https://p-sit.onewo.com",
    "--target-category-id", "fake-category", "--actor", "linux-smoke", "--instruction-file", "/tmp/instruction.txt", "--out", "/tmp/manifest.json"]);
  console.log('Linux smoke: import fixture tasks and check admission lock');
  assert.equal(JSON.parse(command("mk-codex-scheduler", ["import", "--manifest", "/tmp/manifest.json", "--confirm-write"])).imported, 3);
  command("mk-codex-scheduler", ["resume"]);
  const lock = spawn("flock", [join(config.stateDir, "control.lock"), "sh", "-c", "touch /tmp/lock-ready; sleep 2"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { readFileSync("/tmp/lock-ready"); break; } catch { await delay(10); } }
  const conflict = spawnSync("mk-codex-scheduler", ["start", "--count", "2"], { encoding: "utf8" });
  assert.equal(conflict.status, 75);
  await new Promise((resolve) => lock.once("exit", resolve));
  const started = JSON.parse(command("mk-codex-scheduler", ["start", "--count", "3"]));
  assert.equal(started.started, 2);
  command("mk-codex-scheduler", ["pause"]);
  const statePath = join(config.stateDir, "state.json");
  const liveTasks = JSON.parse(readFileSync(statePath)).tasks.filter(task => task.dispatchedAt);
  for (let attempt = 0; attempt < 200; attempt++) {
    if (liveTasks.every(task => existsSync(join(config.stateDir, 'tasks', task.id, 'events.jsonl')) &&
      readFileSync(join(config.stateDir, 'tasks', task.id, 'events.jsonl'), 'utf8').includes('thread.started'))) break;
    await delay(25);
  }
  const runningEvidence = liveTasks.map(task => ({
    path: join(config.stateDir, 'tasks', task.id, 'run-config.json'),
    before: readFileSync(join(config.stateDir, 'tasks', task.id, 'run-config.json')),
    pid: JSON.parse(readFileSync(join(config.stateDir, 'tasks', task.id, 'worker-start.json'))).pid,
    workerPath: JSON.parse(readFileSync('/tmp/fake-units/mk-codex-task-' + task.id + '.service.command.json'))[1]
  }));
  // Upgrade while two old workers are alive; their absolute code paths and run configs must survive.
  console.log('Linux smoke: upgrade with two live workers');
  command("sh", ["/delivery/mk-codex-scheduler/install.sh"]);
  const effective = JSON.parse(command("mk-codex-scheduler", ["config"]));
  assert.equal(effective.maxSessions, 2);
  assert.equal(effective.maxAutoRepairAttempts, config.maxAutoRepairAttempts ?? 10);
  assert.equal(effective.schedule.weekday[0].intervalMinutes, 20);
  const proposed = structuredClone(effective); proposed.schedule.weekday[0].intervalMinutes = 7;
  proposed.maxAutoRepairAttempts = 10;
  writeFileSync('/tmp/proposed.json', JSON.stringify(proposed));
  assert.equal(JSON.parse(command('mk-codex-scheduler', ['config-apply', '--file', '/tmp/proposed.json'])).applied, true);
  assert.equal(JSON.parse(command('mk-codex-scheduler', ['config'])).maxAutoRepairAttempts, 10);
  for (const evidence of runningEvidence) {
    assert.deepEqual(readFileSync(evidence.path), evidence.before);
    assert.ok(existsSync(evidence.workerPath));
    process.kill(evidence.pid, 0);
  }
  console.log('Linux smoke: sample under a held admission lock, then finish workers');
  const samplingLock = spawn('flock', [join(config.stateDir, 'control.lock'), 'sh', '-c', 'touch /tmp/sampling-lock-ready; sleep 3'], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !existsSync('/tmp/sampling-lock-ready'); i++) await delay(10);
  command('mk-codex-scheduler', ['sample']);
  const metrics = JSON.parse(command('mk-codex-scheduler', ['metrics']));
  assert.equal(metrics.paused, true);
  assert.equal(metrics.sessions.filter(row => row.activeState === 'active').length, 2);
  assert.ok(metrics.server.memory.availableBytes > 0);
  assert.equal(metrics.sessions[0].memoryBytes, 104857600);
  if (samplingLock.exitCode === null) await new Promise(resolve => samplingLock.once('exit', resolve));
  assert.ok(readdirSync(join(config.stateDir, 'metrics')).includes('latest.json'));
  const exported = '/tmp/resource-history.json';
  command('mk-codex-scheduler', ['metrics', '--date', metrics.slot.slice(0, 10), '--out', exported]);
  assert.ok(JSON.parse(readFileSync(exported)).length >= 1);
  writeFileSync('/tmp/fake-codex-release', 'continue');
  let status;
  for (let index = 0; index < 100; index++) {
    status = JSON.parse(command("mk-codex-scheduler", ["status"]));
    if (status.counts.succeeded === 2) break;
    await delay(50);
  }
  assert.equal(status.counts.succeeded, 2, JSON.stringify(status));
  assert.equal(status.counts.queued, 1);
  assert.equal(JSON.parse(command("mk-codex-scheduler", ["start", "--count", "1"])).reason, "paused");
  command("mk-codex-scheduler", ["resume"]);
  assert.equal(JSON.parse(command("mk-codex-scheduler", ["start", "--count", "1"])).started, 1);
  for (let index = 0; index < 100; index++) {
    status = JSON.parse(command("mk-codex-scheduler", ["status"]));
    if (status.counts.succeeded === 3) break;
    await delay(50);
  }
  assert.equal(status.counts.succeeded, 3);
  const thirdTask = JSON.parse(readFileSync(statePath)).tasks.find(task => !liveTasks.some(old => old.id === task.id));
  assert.equal(JSON.parse(readFileSync(join(config.stateDir, 'tasks', thirdTask.id, 'run-config.json'))).schedule.weekday[0].intervalMinutes, 7);
  assert.equal(JSON.parse(command("mk-codex-scheduler", ["start", "--count", "3"])).started, 0);
  command("mk-codex-scheduler", ["pause"]);
  console.log('Linux smoke: import clean output above 2 MiB through the installed package');
  writeFileSync('/tmp/clean-large-output', 'enabled');
  const largeSource = '/var/lib/mk-migrate/input/large_SysFormTemplate.xml';
  writeFileSync(largeSource, xml.replaceAll('route-multi-batch-template', 'test-large-buffer'));
  const largeManifest = JSON.parse(readFileSync('/tmp/manifest.json'));
  largeManifest.items = [{sourcePath:largeSource}];
  writeFileSync('/tmp/large-manifest.json', JSON.stringify(largeManifest));
  assert.equal(JSON.parse(command('mk-codex-scheduler', ['import', '--manifest', '/tmp/large-manifest.json', '--confirm-write'])).imported, 1);
  const largeTask = JSON.parse(readFileSync(statePath)).tasks.find(task => task.sourceId === 'test-large-buffer');
  const cleanReceipt = JSON.parse(readFileSync(join(config.stateDir, 'tasks', largeTask.id, 'clean.command.json')));
  assert.ok(cleanReceipt.stdoutBytes > 2 * 1024 * 1024);
  assert.equal(cleanReceipt.exitCode, 0);
  assert.equal(cleanReceipt.errorCode, null);
  assert.equal(largeTask.status, 'queued');
  console.log('Linux smoke: continue a proven no-write failure through the installed repair worker');
  writeFileSync('/tmp/fake-codex-mode', 'no-write');
  command('mk-codex-scheduler', ['resume']);
  assert.equal(JSON.parse(command('mk-codex-scheduler', ['start', '--count', '1'])).started, 1);
  for (let index = 0; index < 100; index++) {
    status = JSON.parse(command('mk-codex-scheduler', ['status']));
    if (status.counts.needs_attention === 1) break;
    await delay(50);
  }
  assert.equal(status.counts.needs_attention, 1);
  const originalCompletion = join(config.stateDir, 'tasks', largeTask.id, 'completion.json');
  const originalBytes = readFileSync(originalCompletion);
  const retainedReportPath = join(config.stateDir, 'tasks', largeTask.id, 'work/execution-001.report.json');
  const retainedStdoutPath = join(dirname(retainedReportPath), 'execute-001.stdout.json');
  writeFileSync(retainedStdoutPath, JSON.stringify({ ...JSON.parse(readFileSync(retainedReportPath)), wrote: retainedReportPath }));
  const retainedStdoutBytes = readFileSync(retainedStdoutPath);
  writeFileSync('/tmp/fake-codex-mode', 'success');
  rmSync('/tmp/fake-codex-release');
  assert.equal(JSON.parse(command('mk-codex-scheduler', ['start', '--count', '1'])).started, 1);
  const retryUnit = 'mk-codex-task-' + largeTask.id + '-r1.service';
  const retryCommand = JSON.parse(readFileSync('/tmp/fake-units/' + retryUnit + '.command.json'));
  const { readSessionMetrics } = await import(join(dirname(retryCommand[1]), 'linux-metrics.mjs'));
  const retryRow = readSessionMetrics().find(row => row.unit === retryUnit);
  assert.equal(retryRow.taskId, largeTask.id); assert.equal(retryRow.repairAttempt, 1);
  assert.equal(retryRow.activeState, 'active');
  writeFileSync('/tmp/fake-codex-release', 'continue');
  for (let index = 0; index < 100; index++) {
    status = JSON.parse(command('mk-codex-scheduler', ['status']));
    if (status.counts.succeeded === 4) break;
    await delay(50);
  }
  assert.equal(status.counts.succeeded, 4);
  const repairItem = JSON.parse(command('mk-codex-scheduler', ['item', '--task', largeTask.id]));
  assert.equal(repairItem.attempts.length, 2);
  assert.equal(repairItem.state.repairAttempts, 1);
  assert.deepEqual(readFileSync(originalCompletion), originalBytes);
  assert.deepEqual(readFileSync(retainedStdoutPath), retainedStdoutBytes);
  assert.equal(JSON.parse(command('mk-codex-scheduler', ['start', '--count', '1'])).started, 0);
  const units = readFileSync("/etc/systemd/system/mk-codex-scheduler.timer", "utf8");
  assert.ok(units.includes("Persistent=false"));
  assert.ok(readFileSync('/etc/systemd/system/mk-codex-sampler.timer', 'utf8').includes('OnCalendar=*-*-* *:*:00'));
  console.log(JSON.stringify({ ok: true, linux: true, realFlock: true, installedPackage: true,
    liveWorkerUpgrade: true, legacyUpgrade: process.env.MK_SMOKE_LEGACY === '1', independentSampling: true,
    realLinuxHostMetrics: true, largeOutputImport: true, safeAutomaticRepair: true, boundStdoutCopies: true, retryUnitMetrics: true,
    fakeCodexProcesses: 5, fakeSystemd: true, realModel: false, realNewoa: false }));
} else {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temporary = mkdtempSync(join(tmpdir(), "mk-scheduler-linux-"));
  try {
    const release = packageScheduler(join(temporary, "delivery"));
    const legacy = process.env.MK_SCHEDULER_LEGACY_ARCHIVE;
    const result = spawnSync("docker", ["run", "--rm", "--platform", "linux/amd64", "--network", "none",
      ...(legacy ? ['-e', 'MK_SMOKE_LEGACY=1', '-v', `${legacy}:/legacy.tar.gz:ro`] : []),
      "-v", `${root}:/repo:ro`, "-v", `${release.directory}:/delivery:ro`, "node:22-bookworm-slim",
      "node", "/repo/scripts/codex-scheduler-linux-smoke.mjs", "--inside"], { stdio: 'inherit', timeout: 180_000 });
    assert.equal(result.status, 0, result.error?.message || 'Linux smoke failed');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
