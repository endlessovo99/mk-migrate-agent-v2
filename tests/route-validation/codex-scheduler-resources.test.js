import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { DEFAULTS, applyConfig, directory, initialize, jsonDigest, loadConfig, readJson, saveState, taskDirectory, writeJson } from "../../tools/codex-scheduler/common.mjs";
import { DEFAULT_SCHEDULE, scheduleAt, validateSchedule } from "../../tools/codex-scheduler/schedule.mjs";
import { dispatch } from "../../tools/codex-scheduler/controller.mjs";
import { readHostMetrics, readSessionMetrics, unitMetrics } from "../../tools/codex-scheduler/linux-metrics.mjs";
import { addRates, readMetrics, sampleResources } from "../../tools/codex-scheduler/metrics.mjs";

const fixture = readJson(fileURLToPath(new URL("../fixtures/route-validation/codex-scheduler/resources.json", import.meta.url)));
const plenty = () => ({ availableMemoryMB: 100_000, freeDiskMB: 100_000 });
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "mk-scheduler-resources-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { ...DEFAULTS, stateDir: join(root, "state") };
  const state = initialize(config);
  const configPath = join(root, "config.json"); writeJson(configPath, config);
  return { root, config, configPath, state };
}
function write(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function resourceReaders(root, frame) {
  const proc = join(root, "proc"), cgroup = join(root, "cgroup");
  write(join(proc, "sys/kernel/random/boot_id"), fixture.bootId);
  for (const name of ["meminfo", "loadavg"]) write(join(proc, name), fixture[name]);
  for (const name of ["stat", "uptime"]) write(join(proc, name), frame[name]);
  const unit = `mk-codex-task-${fixture.taskId}.service`, group = `/system.slice/${unit}`;
  write(join(cgroup, "cgroup.controllers"), "cpu memory io pids");
  for (const [name, text] of Object.entries({ "cpu.stat": frame.cpuStat, "memory.current": frame.memoryCurrent,
    "memory.peak": "209715200", "memory.swap.current": "0", "pids.current": "3", "io.stat": frame.ioStat })) write(join(cgroup, group, name), text);
  const run = (args) => {
    if (args[0] === "list-units") return `${unit} loaded active running Task\n`;
    assert.equal(args[0], "show");
    return `Id=${unit}\nActiveState=active\nInvocationID=invocation-one\nControlGroup=${group}\nMemoryCurrent=1\nCPUUsageNSec=1\n`;
  };
  return { host: (config) => readHostMetrics(config, { procRoot: proc, filesystem: () => ({ blocks: 100_000, bavail: 80_000, bsize: 4096 }) }),
    sessions: () => readSessionMetrics({ run, cgroupRoot: cgroup }) };
}

describe("configurable Codex dispatch and independent resource history", () => {
  it("retains old config defaults and validates window bounds, intervals, overlap and unique ids", (t) => {
    const { configPath, config } = setup(t);
    const { schedule, ...legacy } = config; writeJson(configPath, legacy);
    assert.deepEqual(loadConfig(configPath).schedule, DEFAULT_SCHEDULE);
    const invalid = [
      { ...structuredClone(schedule), weekday: [{ id: "zero", start: "07:00", end: "07:00", batchSize: 1, intervalMinutes: 1 }] },
      { ...structuredClone(schedule), weekend: [{ id: "bad", start: "24:00", end: "07:00", batchSize: 1, intervalMinutes: 1 }] },
      { ...structuredClone(schedule), weekend: [{ id: "bad", start: "07:00", end: "24:00", batchSize: 1, intervalMinutes: 0 }] }
    ];
    const overlapping = structuredClone(schedule); overlapping.weekday[0].end = "20:00"; invalid.push(overlapping);
    const duplicated = structuredClone(schedule); duplicated.weekend[0].id = duplicated.weekday[0].id; invalid.push(duplicated);
    for (const value of invalid) assert.throws(() => validateSchedule(value));
    assert.doesNotThrow(() => validateSchedule({ weekday: [], weekend: [] }));
  });

  it("anchors arbitrary intervals to configured cross-midnight windows and allows closed gaps", () => {
    const schedule = { weekday: [{ id: "custom-night", start: "21:10", end: "06:10", batchSize: 7, intervalMinutes: 17 }], weekend: [] };
    assert.equal(scheduleAt(new Date("2026-10-12T13:10:00Z"), schedule).due, true);
    assert.equal(scheduleAt(new Date("2026-10-12T13:27:00Z"), schedule).due, true);
    assert.equal(scheduleAt(new Date("2026-10-12T16:00:00Z"), schedule).due, true);
    assert.equal(scheduleAt(new Date("2026-10-12T16:01:00Z"), schedule).due, false);
    assert.equal(scheduleAt(new Date("2026-10-12T22:10:00Z"), schedule).mode, "outside-window");
    assert.equal(scheduleAt(new Date("2026-10-17T14:00:00Z"), schedule).mode, "outside-window");
  });

  it("atomically applies new windows only to future dispatches without replacing running configs or duplicating a slot", async (t) => {
    const { root, config, configPath, state } = setup(t);
    for (let index = 0; index < 30; index++) {
      const id = jsonDigest(`live-${index}`), dir = taskDirectory(config, id);
      directory(dir); directory(join(dir, "work")); writeJson(join(dir, "task.json"), { id });
      state.tasks.push({ id, status: "queued" });
    }
    state.paused = false; saveState(config, state);
    const operations = { inspect: () => "active", measure: plenty, launch: () => true };
    assert.equal((await dispatch(config, state, { ...operations, now: new Date("2026-10-11T23:00:00Z") })).started, 10);
    const oldConfigPath = join(taskDirectory(config, state.tasks[0].id), "run-config.json");
    const oldBytes = readFileSync(oldConfigPath);
    const candidate = structuredClone(config); candidate.schedule.weekday[0].batchSize = 3; candidate.schedule.weekday[0].intervalMinutes = 5;
    const candidatePath = join(root, "candidate.json"); writeJson(candidatePath, candidate);
    applyConfig(configPath, candidatePath);
    const updated = loadConfig(configPath);
    assert.equal((await dispatch(updated, state, { ...operations, now: new Date("2026-10-11T23:00:30Z") })).started, 0);
    assert.equal((await dispatch(updated, state, { ...operations, now: new Date("2026-10-11T23:05:00Z") })).started, 3);
    assert.deepEqual(readFileSync(oldConfigPath), oldBytes);
    assert.equal(readJson(join(taskDirectory(config, state.tasks[10].id), "run-config.json")).schedule.weekday[0].batchSize, 3);
    candidate.maxSessions = 5; writeJson(candidatePath, candidate); applyConfig(configPath, candidatePath);
    assert.equal((await dispatch(loadConfig(configPath), state, { ...operations, now: new Date("2026-10-11T23:10:00Z") })).started, 0);
    assert.equal(state.tasks.filter((entry) => entry.status === "running").length, 13);
    candidate.stateDir = join(root, "another-state"); writeJson(candidatePath, candidate);
    const before = readFileSync(configPath);
    assert.throws(() => applyConfig(configPath, candidatePath), /stateDir/);
    assert.deepEqual(readFileSync(configPath), before);
  });

  it("saves immutable minute history while paused/off-slot, measures host and whole-session rates and keeps queue state unchanged", (t) => {
    const { root, config, state } = setup(t);
    state.tasks.push({ id: fixture.taskId, sourceId: "fixture-source", status: "running", dispatchedAt: "2026-10-12T01:00:00Z" });
    saveState(config, state);
    const queueBefore = readFileSync(join(config.stateDir, "state.json"));
    const first = sampleResources(config, { now: new Date(fixture.before.at), ...resourceReaders(root, fixture.before) });
    assert.equal(first.saved, true);
    const firstBytes = readFileSync(first.path);
    assert.equal(statSync(first.path).mode & 0o777, 0o600);
    assert.equal(readMetrics(config).server.cpuPercent, null);
    assert.equal(readMetrics(config).sessions[0].cpuPercent, null);
    assert.equal(readMetrics(config).paused, true);
    assert.equal(scheduleAt(new Date(fixture.before.at)).due, false);
    assert.equal(sampleResources(config, { now: new Date(fixture.before.at), host: () => assert.fail("duplicate read") }).saved, false);
    sampleResources(config, { now: new Date(fixture.after.at), ...resourceReaders(root, fixture.after) });
    const latest = readMetrics(config);
    assert.equal(latest.intervalSeconds, 60);
    assert.equal(latest.server.cpuPercent, 45);
    assert.equal(latest.server.iowaitPercent, 5);
    assert.equal(latest.server.memory.availableBytes, 8 * 1024 ** 3);
    assert.equal(latest.server.swap.usedBytes, 512 * 1024 ** 2);
    assert.equal(latest.sessions[0].cpuPercent, 100);
    assert.equal(latest.sessions[0].cpuMachinePercent, 50);
    assert.equal(latest.sessions[0].memoryBytes, 150 * 1024 ** 2);
    assert.equal(latest.sessions[0].memoryPeakBytes, 200 * 1024 ** 2);
    assert.equal(latest.sessions[0].tasksCurrent, 3);
    assert.equal(latest.sessions[0].ioReadBytesPerSecond, 1000);
    assert.equal(latest.sessions[0].ioWriteBytesPerSecond, 500);
    assert.equal(latest.sessions[0].sourceId, "fixture-source");
    assert.deepEqual(readFileSync(first.path), firstBytes);
    assert.deepEqual(readFileSync(join(config.stateDir, "state.json")), queueBefore);
    assert.equal(readMetrics(config, { date: "2026-10-12", taskId: fixture.taskId }).length, 2);
    assert.equal(readMetrics(config, { taskId: "b".repeat(64) }).sessions.length, 0);
    assert.throws(() => readMetrics(config, { date: "../secret" }), /date/);
  });

  it("keeps unavailable counters null on old accounting, unit disappearance and sampling errors", (t) => {
    const { root, config } = setup(t);
    const row = unitMetrics({ Id: `mk-codex-task-${fixture.taskId}.service`, ActiveState: "active", ControlGroup: "/../../private",
      CPUUsageNSec: "18446744073709551615", MemoryCurrent: "[not set]", TasksCurrent: "0" }, { cgroupRoot: root });
    assert.equal(row.cpuUsageNSec, null); assert.equal(row.memoryBytes, null); assert.equal(row.tasksCurrent, 0);
    assert.ok(row.unavailable.includes("ioReadBytes"));
    const readers = resourceReaders(root, fixture.before);
    sampleResources(config, { now: new Date(fixture.before.at), host: readers.host, sessions: () => { throw new Error("systemd gone"); } });
    assert.ok(readMetrics(config).errors.includes("session_metrics_unavailable"));
    assert.equal(readMetrics(config).server.cpuCount, 2);
    const disappeared = readSessionMetrics({ run: (args) => args[0] === "list-units" ? `mk-codex-task-${fixture.taskId}.service loaded active\n` : "" });
    assert.equal(disappeared[0].activeState, "gone");
    assert.equal(disappeared[0].memoryBytes, null);
  });

  it("resets rates after reboot/invocation change and rotates files at Shanghai midnight", (t) => {
    const { root, config } = setup(t);
    sampleResources(config, { now: new Date("2026-10-12T15:59:00Z"), ...resourceReaders(root, fixture.before) });
    const before = readMetrics(config);
    sampleResources(config, { now: new Date("2026-10-12T16:00:00Z"), ...resourceReaders(root, fixture.after) });
    const after = readMetrics(config);
    assert.ok(existsSync(join(config.stateDir, "metrics/2026-10-12/2359.json")));
    assert.ok(existsSync(join(config.stateDir, "metrics/2026-10-13/0000.json")));
    after.server.bootId = "rebooted";
    assert.equal(addRates(after, before).sessions[0].cpuPercent, null);
    after.server.bootId = before.server.bootId; after.sessions[0].invocationId = "restarted";
    assert.equal(addRates(after, before).sessions[0].cpuPercent, null);
  });

  it("retains new history when the latest-sample cache is malformed", (t) => {
    const { root, config } = setup(t);
    sampleResources(config, { now: new Date(fixture.before.at), ...resourceReaders(root, fixture.before) });
    writeJson(join(config.stateDir, "metrics/latest.json"), { invalid: true });
    sampleResources(config, { now: new Date(fixture.after.at), ...resourceReaders(root, fixture.after) });
    const sample = readMetrics(config);
    assert.ok(sample.errors.includes("previous_sample_unavailable"));
    assert.equal(sample.server.cpuPercent, null);
    assert.equal(sample.sessions[0].memoryBytes, 150 * 1024 ** 2);
    assert.equal(readMetrics(config, { date: "2026-10-12" }).length, 2);
  });
});
