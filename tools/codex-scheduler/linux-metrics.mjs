import { existsSync, readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const UNIT = /^mk-codex-task-([a-f0-9]{64})(?:-r([1-9]|10))?\.service$/;
const properties = ["Id", "ActiveState", "InvocationID", "ControlGroup", "CPUUsageNSec", "MemoryCurrent", "MemoryPeak", "MemorySwapCurrent", "TasksCurrent", "IOReadBytes", "IOWriteBytes"];
const optionalText = (path) => { try { return readFileSync(path, "utf8").trim(); } catch { return null; } };
const unsigned = (value) => typeof value === "string" && /^\d+$/.test(value) && value !== "18446744073709551615" ? BigInt(value).toString() : null;
const number = (value) => { const parsed = unsigned(value); return parsed !== null && Number.isSafeInteger(Number(parsed)) ? Number(parsed) : null; };

export function readHostMetrics(config, { procRoot = "/proc", filesystem = statfsSync } = {}) {
  const errors = [];
  const mem = optionalText(join(procRoot, "meminfo"));
  const memory = Object.fromEntries([...(mem || "").matchAll(/^(\w+):\s+(\d+) kB$/gm)].map((match) => [match[1], Number(match[2]) * 1024]));
  const stat = optionalText(join(procRoot, "stat"));
  const cpu = stat?.match(/^cpu\s+(.+)$/m)?.[1].trim().split(/\s+/).slice(0, 8).map(Number);
  const cpuCounters = cpu?.length === 8 && cpu.every((value) => Number.isSafeInteger(value) && value >= 0)
    ? { total: cpu.reduce((sum, value) => sum + value, 0), idle: cpu[3], iowait: cpu[4] } : null;
  const load = optionalText(join(procRoot, "loadavg"))?.split(/\s+/).slice(0, 3).map(Number);
  const uptime = optionalText(join(procRoot, "uptime"))?.split(/\s+/)[0];
  let disk = { totalBytes: null, availableBytes: null };
  try {
    const fs = filesystem(config.stateDir);
    disk = { totalBytes: Number(fs.blocks) * Number(fs.bsize), availableBytes: Number(fs.bavail) * Number(fs.bsize) };
  } catch { errors.push("filesystem_unavailable"); }
  if (!cpuCounters) errors.push("cpu_counters_unavailable");
  if (memory.MemAvailable === undefined) errors.push("memory_unavailable");
  const usedBytes = memory.MemTotal !== undefined && memory.MemAvailable !== undefined ? memory.MemTotal - memory.MemAvailable : null;
  return {
    bootId: optionalText(join(procRoot, "sys/kernel/random/boot_id")),
    uptimeSeconds: uptime !== undefined && uptime !== null && Number.isFinite(Number(uptime)) ? Number(uptime) : null,
    cpuCount: stat?.match(/^cpu\d+\s/gm)?.length || null, cpuCounters,
    loadAverage: load?.length === 3 && load.every(Number.isFinite) ? load : null,
    memory: { totalBytes: memory.MemTotal ?? null, availableBytes: memory.MemAvailable ?? null, usedBytes },
    swap: { totalBytes: memory.SwapTotal ?? null, freeBytes: memory.SwapFree ?? null,
      usedBytes: memory.SwapTotal !== undefined && memory.SwapFree !== undefined ? memory.SwapTotal - memory.SwapFree : null },
    disk, errors
  };
}

function command(args) {
  const result = spawnSync("systemctl", args, { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 ** 2 });
  if (result.status !== 0) throw new Error("systemd_metrics_unavailable");
  return result.stdout;
}

export function parseUnitProperties(text) {
  return text.trim().split(/\n\s*\n/).filter(Boolean).map((block) => Object.fromEntries(block.split("\n").filter((line) => line.includes("=")).map((line) => {
    const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
  })));
}

function ioCounters(text) {
  if (text === null) return null;
  if (text === "") return { read: 0, write: 0 };
  const sums = { read: 0, write: 0 };
  for (const [key, field] of [["read", "rbytes"], ["write", "wbytes"]]) {
    const matches = [...text.matchAll(new RegExp(`(?:^|\\s)${field}=(\\d+)`, "g"))];
    if (!matches.length) sums[key] = null;
    else for (const match of matches) { const value = number(match[1]); if (value === null) { sums[key] = null; break; } sums[key] += value; }
  }
  return sums;
}

/** cgroup v2 counters include descendants. On v1, use available systemd accounting properties. */
export function unitMetrics(properties, { cgroupRoot = "/sys/fs/cgroup" } = {}) {
  const match = properties.Id?.match(UNIT);
  if (!match) return null;
  const controlGroup = properties.ControlGroup;
  const safeGroup = typeof controlGroup === "string" && controlGroup.startsWith("/") && controlGroup !== "/" && !controlGroup.split("/").includes("..");
  const v2 = safeGroup && existsSync(join(cgroupRoot, "cgroup.controllers"));
  const path = v2 ? join(cgroupRoot, controlGroup) : null;
  const read = (file) => path ? optionalText(join(path, file)) : null;
  const usageUSec = read("cpu.stat")?.match(/^usage_usec (\d+)$/m)?.[1];
  const io = ioCounters(read("io.stat"));
  const row = {
    taskId: match[1], repairAttempt: Number(match[2] || 0), unit: properties.Id, activeState: properties.ActiveState || null,
    invocationId: properties.InvocationID || null, controlGroup: controlGroup || null,
    cpuUsageNSec: unsigned(usageUSec) !== null ? (BigInt(usageUSec) * 1000n).toString() : unsigned(properties.CPUUsageNSec),
    memoryBytes: number(read("memory.current")) ?? number(properties.MemoryCurrent),
    memoryPeakBytes: number(read("memory.peak")) ?? number(properties.MemoryPeak),
    swapBytes: number(read("memory.swap.current")) ?? number(properties.MemorySwapCurrent),
    tasksCurrent: number(read("pids.current")) ?? number(properties.TasksCurrent),
    ioReadBytes: io?.read ?? number(properties.IOReadBytes), ioWriteBytes: io?.write ?? number(properties.IOWriteBytes)
  };
  row.unavailable = ["cpuUsageNSec", "memoryBytes", "memoryPeakBytes", "swapBytes", "tasksCurrent", "ioReadBytes", "ioWriteBytes"].filter((key) => row[key] === null);
  return row;
}

export function readSessionMetrics({ run = command, cgroupRoot } = {}) {
  const listing = run(["list-units", "--all", "--type=service", "--plain", "--no-legend", "--full", "mk-codex-task-*.service"]);
  const names = listing.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter((name) => UNIT.test(name));
  const sessions = [];
  for (let index = 0; index < names.length; index += 100) {
    const selected = names.slice(index, index + 100);
    const found = parseUnitProperties(run(["show", ...selected, `--property=${properties.join(",")}`]));
    for (const name of selected) {
      const unit = found.find((entry) => entry.Id === name) || { Id: name, ActiveState: "gone" };
      sessions.push(unitMetrics(unit, { cgroupRoot }));
    }
  }
  return sessions;
}
