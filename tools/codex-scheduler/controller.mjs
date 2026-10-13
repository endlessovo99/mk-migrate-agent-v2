import { existsSync, readFileSync, statfsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freemem } from "node:os";
import { admission, scheduleAt } from "./schedule.mjs";
import { readCompletion } from "./evidence.mjs";
import { attemptDirectory, jsonDigest, readJson, requireValue, saveState, taskDirectory, taskUnitName, writeJson } from "./common.mjs";
import { prepareRepair, repairDecision } from "./repair.mjs";

export const unitName = taskUnitName;
const activeStates = new Set(["active", "activating", "deactivating", "reloading"]);

export function resources(config) {
  let availableMemoryMB = freemem() / 1024 ** 2;
  if (process.platform === "linux") {
    const match = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB$/m);
    requireValue(match, "Cannot read MemAvailable");
    availableMemoryMB = Number(match[1]) / 1024;
  }
  const disk = statfsSync(config.stateDir);
  return { availableMemoryMB, freeDiskMB: Number(disk.bavail) * Number(disk.bsize) / 1024 ** 2 };
}

export function systemdState(id, attempt = 0) {
  const result = spawnSync("systemctl", ["show", unitName(id, attempt), "--property=ActiveState", "--value"], { encoding: "utf8", timeout: 10_000 });
  requireValue(!result.error && [0, 1].includes(result.status), "Cannot inspect worker units; admission stopped");
  const state = result.stdout.trim();
  requireValue(["active", "activating", "deactivating", "reloading", "inactive", "failed"].includes(state), "Worker unit state is unavailable");
  return state;
}

export function launchSystemd(config, task, dir) {
  const result = spawnSync("systemd-run", ["--quiet", "--collect", `--unit=${unitName(task.id, task.repairAttempts || 0)}`, "--service-type=exec",
    "--property=Restart=no", "--property=UMask=0077", "--property=MemoryAccounting=yes",
    "--property=CPUAccounting=yes", "--property=IOAccounting=yes", "--property=TasksAccounting=yes",
    "--property=EnvironmentFile=-/etc/mk-migrate/codex-scheduler.env", "--setenv=HOME=/root",
    process.execPath, fileURLToPath(new URL("./worker.mjs", import.meta.url)), dir], { encoding: "utf8", timeout: 30_000 });
  // systemd-run can time out after accepting the job. The intent is retained either way.
  return result.status === 0;
}

export function reconcile(config, state, { inspect = systemdState, now = new Date() } = {}) {
  for (const pending of state.pendingAdmissions || []) {
    const id = typeof pending === "string" ? pending : pending.id;
    const attempt = typeof pending === "string" ? 0 : pending.attempt;
    const entry = state.tasks.find((task) => task.id === id);
    if (!entry) continue;
    const dir = attemptDirectory(config, id, attempt);
    if (existsSync(join(dir, "launch-intent.json"))) {
      const intent = readJson(join(dir, "launch-intent.json"));
      Object.assign(entry, { status: "dispatched", repairAttempts: attempt, dispatchedAt: intent.dispatchedAt, unitSettled: false });
    } else if (attempt || existsSync(join(dir, "run-config.json"))) {
      Object.assign(entry, { status: "needs_attention", repairAttempts: attempt, reason: "interrupted_launch_preparation" });
    }
  }
  state.pendingAdmissions = [];
  let active = 0;
  for (const entry of state.tasks) {
    if (!["dispatched", "running", "outcome_unknown"].includes(entry.status) || !entry.dispatchedAt) continue;
    if (entry.status === "outcome_unknown" && entry.unitSettled) continue;
    const dir = attemptDirectory(config, entry.id, entry.repairAttempts || 0);
    const unitState = inspect(entry.id, entry.repairAttempts || 0);
    const alive = activeStates.has(unitState);
    const completion = readCompletion(dir);
    if (alive) {
      active++;
      entry.status = "running";
      entry.longRunning = now.getTime() - Date.parse(entry.dispatchedAt) >= config.longSessionMinutes * 60_000;
    } else if (completion) {
      requireValue(["succeeded", "needs_attention", "needs_repair", "outcome_unknown"].includes(completion.status), "Invalid worker completion");
      Object.assign(entry, { status: completion.status, completedAt: completion.completedAt, durationSeconds: completion.durationSeconds,
        threadId: completion.threadId, templateId: completion.templateId, reason: completion.reason, unitSettled: true });
    } else {
      Object.assign(entry, { status: "outcome_unknown", reason: "unit_ended_without_completion" });
    }
  }
  return active;
}

export async function dispatch(config, state, { now = new Date(), manualCount, taskId, inspect = systemdState,
  measure = resources, launch = launchSystemd } = {}) {
  const active = reconcile(config, state, { inspect, now });
  const schedule = scheduleAt(now, config.schedule);
  saveState(config, state);
  if (state.paused) return { started: 0, reason: "paused", active, schedule };
  const manual = manualCount !== undefined;
  if (!manual && (!schedule.due || state.slots[schedule.slot])) return { started: 0, reason: "not_due_or_already_dispatched", active, schedule };
  const capacity = admission(config, { active, ...measure(config) }, manual ? manualCount : schedule.batchSize);
  const decisions = new Map();
  for (const entry of state.tasks.filter((entry) => entry.status === "needs_attention" && (!taskId || entry.id === taskId))) {
    const decision = repairDecision(config, entry, inspect);
    entry.autoRepair = { eligible: decision.eligible, reason: decision.reason, ...(decision.detail ? { detail: decision.detail } : {}) };
    if (decision.eligible) decisions.set(entry.id, decision.context);
  }
  const candidates = state.tasks.filter((entry) => (entry.status === "queued" || decisions.has(entry.id)) && (!taskId || entry.id === taskId)).slice(0, capacity.count);
  if (taskId) requireValue(state.tasks.some((entry) => entry.id === taskId && (entry.status === "queued" || decisions.has(entry.id))), "Task is not queued or eligible for safe repair; evidence cannot be bypassed");
  // Consume this slot before starting any process. A crash cannot dispatch the same wave twice.
  if (!manual) state.slots[schedule.slot] = { at: now.toISOString(), count: candidates.length, reason: capacity.reason };
  state.pendingAdmissions = candidates.map((entry) => ({ id: entry.id, attempt: decisions.get(entry.id)?.attempt || 0 }));
  saveState(config, state);
  for (const entry of candidates) {
    const context = decisions.get(entry.id);
    const dir = context ? prepareRepair(config, entry, context) : taskDirectory(config, entry.id);
    const task = readJson(join(dir, "task.json"));
    requireValue(!existsSync(join(dir, "launch-intent.json")), "Task has an earlier launch intent; investigate before any action");
    writeJson(join(dir, "run-config.json"), config, { exclusive: true });
    writeJson(join(dir, "launch-intent.json"), { taskDigest: jsonDigest(task), configDigest: jsonDigest(config),
      ...(context ? { repairContextDigest: jsonDigest(context) } : {}),
      dispatchedAt: now.toISOString(), unit: unitName(task.id, context?.attempt || 0), mode: manual ? "manual" : schedule.mode }, { exclusive: true });
    entry.repairAttempts = context?.attempt || 0;
    for (const key of ["completedAt", "durationSeconds", "threadId", "templateId", "reason", "autoRepair", "longRunning", "launchAcknowledged"]) delete entry[key];
    entry.unitSettled = false;
    entry.status = "dispatched";
    entry.dispatchedAt = now.toISOString();
  }
  state.pendingAdmissions = [];
  saveState(config, state);
  for (const entry of candidates) {
    try { entry.launchAcknowledged = await launch(config, entry, attemptDirectory(config, entry.id, entry.repairAttempts || 0)); }
    catch { entry.launchAcknowledged = false; }
    // No direct retry: the service manager may already be running the task.
  }
  saveState(config, state);
  return { started: candidates.length, acknowledged: candidates.filter((entry) => entry.launchAcknowledged).length,
    activeBefore: active, schedule, reason: candidates.length ? "dispatched" : capacity.count ? "queue_empty" : capacity.reason };
}

export function statusReport(config, state, now = new Date()) {
  const counts = {};
  for (const entry of state.tasks) counts[entry.status] = (counts[entry.status] || 0) + 1;
  const completed = state.tasks.filter((entry) => entry.durationSeconds !== undefined).map((entry) => entry.durationSeconds).sort((a, b) => a - b);
  return { paused: state.paused, maxSessions: config.maxSessions, maxAutoRepairAttempts: config.maxAutoRepairAttempts ?? 10,
    repairAttemptsUsed: state.tasks.reduce((sum, entry) => sum + (entry.repairAttempts || 0), 0),
    schedule: scheduleAt(now, config.schedule), total: state.tasks.length, counts,
    durationSampleCount: completed.length,
    averageDurationSeconds: completed.length ? completed.reduce((a, b) => a + b, 0) / completed.length : null,
    p95DurationSeconds: completed.length ? completed[Math.ceil(completed.length * 0.95) - 1] : null,
    longRunning: state.tasks.filter((entry) => entry.status === "running" && entry.longRunning).map((entry) => entry.id) };
}
