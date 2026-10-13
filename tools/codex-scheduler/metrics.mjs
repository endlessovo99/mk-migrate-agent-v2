import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { directory, jsonDigest, loadState, readJson, regularFile, requireValue, writeJson } from "./common.mjs";
import { shanghaiMinute } from "./schedule.mjs";
import { readHostMetrics, readSessionMetrics } from "./linux-metrics.mjs";

const rounded = (value) => Math.round(value * 100) / 100;
const delta = (current, previous) => current !== null && previous !== null && current !== undefined && previous !== undefined && current >= previous ? current - previous : null;

export function addRates(sample, previous) {
  const server = sample.server;
  const sameBoot = Boolean(previous?.server?.bootId && previous.server.bootId === server.bootId);
  const elapsed = sameBoot ? delta(server.uptimeSeconds, previous.server.uptimeSeconds) : null;
  sample.intervalSeconds = elapsed > 0 ? elapsed : null;
  server.cpuPercent = null;
  server.iowaitPercent = null;
  if (elapsed > 0 && server.cpuCounters && previous.server.cpuCounters) {
    const total = delta(server.cpuCounters.total, previous.server.cpuCounters.total);
    const idle = delta(server.cpuCounters.idle, previous.server.cpuCounters.idle);
    const wait = delta(server.cpuCounters.iowait, previous.server.cpuCounters.iowait);
    if (total > 0 && idle !== null && wait !== null && idle + wait <= total) {
      server.cpuPercent = rounded(100 * (total - idle - wait) / total);
      server.iowaitPercent = rounded(100 * wait / total);
    }
  }
  const oldSessions = new Map((previous?.sessions || []).map((session) => [session.unit || session.taskId, session]));
  for (const session of sample.sessions) {
    const old = oldSessions.get(session.unit || session.taskId);
    const comparable = elapsed > 0 && old && session.invocationId && old.invocationId === session.invocationId;
    session.cpuPercent = null;
    session.cpuMachinePercent = null;
    session.ioReadBytesPerSecond = null;
    session.ioWriteBytesPerSecond = null;
    if (comparable) {
      if (typeof session.cpuUsageNSec === "string" && /^\d+$/.test(session.cpuUsageNSec) && typeof old.cpuUsageNSec === "string" && /^\d+$/.test(old.cpuUsageNSec)) {
        const time = BigInt(session.cpuUsageNSec) - BigInt(old.cpuUsageNSec);
        if (time >= 0n) {
          session.cpuPercent = rounded(Number(time) / 1e9 / elapsed * 100);
          session.cpuMachinePercent = server.cpuCount ? rounded(session.cpuPercent / server.cpuCount) : null;
        }
      }
      for (const key of ["ioReadBytes", "ioWriteBytes"]) {
        const bytes = delta(session[key], old[key]);
        if (bytes !== null) session[`${key}PerSecond`] = rounded(bytes / elapsed);
      }
    }
  }
  return sample;
}

/** Called by a separate timer/lock, including when dispatch is paused or busy importing. */
export function sampleResources(config, { now = new Date(), host = readHostMetrics, sessions = readSessionMetrics } = {}) {
  const root = join(config.stateDir, "metrics");
  const slot = shanghaiMinute(now).slot;
  const day = slot.slice(0, 10), minute = slot.slice(11).replace(":", "");
  directory(join(root, day));
  const path = join(root, day, `${minute}.json`);
  if (existsSync(path)) return { saved: false, reason: "already_sampled", path };
  const errors = [];
  let state = null, previous = null, rows = [];
  try { state = loadState(config); } catch { errors.push("queue_state_unavailable"); }
  try {
    if (existsSync(join(root, "latest.json"))) {
      previous = readJson(regularFile(join(root, "latest.json")));
      requireValue(previous?.version === 1 && previous.server && Array.isArray(previous.sessions), "Invalid previous resource sample");
    }
  } catch { previous = null; errors.push("previous_sample_unavailable"); }
  try { rows = sessions(); } catch { errors.push("session_metrics_unavailable"); }
  const indexed = new Map((state?.tasks || []).map((entry) => [entry.id, entry]));
  for (const row of rows) {
    const task = indexed.get(row.taskId);
    row.sourceId = task?.sourceId ?? null;
    row.dispatchedAt = (row.repairAttempt || 0) === (task?.repairAttempts || 0) ? task?.dispatchedAt ?? null : null;
  }
  const sample = addRates({ version: 1, sampledAt: now.toISOString(), slot, timeZone: "Asia/Shanghai", paused: state?.paused ?? null,
    configDigest: jsonDigest(config), server: host(config), sessions: rows, errors }, previous);
  writeJson(path, sample, { exclusive: true });
  writeJson(join(root, "latest.json"), sample);
  return { saved: true, path, sampledAt: sample.sampledAt, sessionCount: rows.length, errors: [...errors, ...sample.server.errors] };
}

export function readMetrics(config, { date, taskId } = {}) {
  if (taskId) requireValue(/^[a-f0-9]{64}$/.test(taskId), "Invalid task id");
  const root = join(config.stateDir, "metrics");
  const select = (sample) => taskId ? { ...sample, sessions: sample.sessions.filter((entry) => entry.taskId === taskId) } : sample;
  if (!date) {
    requireValue(existsSync(join(root, "latest.json")), "No resource sample yet; run sample or enable mk-codex-sampler.timer");
    return select(readJson(regularFile(join(root, "latest.json"))));
  }
  requireValue(/^\d{4}-\d{2}-\d{2}$/.test(date), "Metrics date must be YYYY-MM-DD in Asia/Shanghai");
  const path = join(root, date);
  if (!existsSync(path)) return [];
  return readdirSync(path).filter((name) => /^\d{4}\.json$/.test(name)).sort().map((name) => select(readJson(regularFile(join(path, name)))));
}
