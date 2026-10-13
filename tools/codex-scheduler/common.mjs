import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_SCHEDULE, validateSchedule } from "./schedule.mjs";

export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const jsonDigest = (value) => digest(JSON.stringify(value));
export function requireValue(value, message) { if (!value) throw new Error(message); }
export function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
export function directory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  requireValue(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), `Not a regular directory: ${path}`);
}
export function syncDirectory(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function writeJson(path, value, { exclusive = false } = {}) {
  const target = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const fd = openSync(target, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  if (!exclusive) renameSync(target, path);
  syncDirectory(dirname(path));
}
export function regularFile(path) {
  const stat = lstatSync(path);
  requireValue(stat.isFile() && !stat.isSymbolicLink(), `Not a regular file: ${path}`);
  return path;
}
export function origin(value) {
  const url = new URL(value);
  requireValue(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
    "baseUrl must be an HTTP/HTTPS root origin without credentials");
  return url.origin;
}
export function nonempty(value, name) {
  requireValue(typeof value === "string" && value.trim().length > 0, `${name} is required`);
  return value.trim();
}
export function integer(value, min, max, name) {
  requireValue(Number.isInteger(value) && value >= min && value <= max, `${name} must be an integer from ${min} to ${max}`);
  return value;
}
export function exactKeys(value, keys, name) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  requireValue(Object.keys(value).every((key) => keys.includes(key)), `Unsupported ${name} property`);
}
export const DEFAULTS = Object.freeze({
  version: 1, stateDir: "/var/lib/mk-migrate/codex-scheduler", codexCommand: "/usr/local/bin/codex",
  engineCommand: "/usr/local/bin/mk-migrate-secure", runtimeDir: "/run/mk-migrate",
  skillPath: "/root/.agents/skills/mk-migrate-server/SKILL.md", maxSessions: 20,
  minAvailableMemoryMB: 3072, estimatedSessionMemoryMB: 512, minFreeDiskMB: 5120,
  maxLocalRepairAttempts: 2, maxAutoRepairAttempts: 10, longSessionMinutes: 120, schedule: DEFAULT_SCHEDULE
});
export function loadConfig(path) {
  const supplied = readJson(regularFile(path));
  exactKeys(supplied, Object.keys(DEFAULTS), "scheduler config");
  const config = { ...DEFAULTS, ...supplied };
  requireValue(config.version === 1, "Unsupported scheduler config version");
  for (const key of ["stateDir", "codexCommand", "engineCommand", "runtimeDir", "skillPath"]) {
    requireValue(isAbsolute(config[key]), `${key} must be absolute`);
    config[key] = resolve(config[key]);
  }
  requireValue(config.stateDir !== "/" && !config.stateDir.startsWith(`${config.runtimeDir}/`) && config.stateDir !== config.runtimeDir,
    "Scheduler data must be outside the engine runtime");
  integer(config.maxSessions, 1, 200, "maxSessions");
  for (const key of ["minAvailableMemoryMB", "estimatedSessionMemoryMB", "minFreeDiskMB"]) integer(config[key], 1, 1_000_000, key);
  integer(config.maxLocalRepairAttempts, 0, 3, "maxLocalRepairAttempts");
  integer(config.maxAutoRepairAttempts, 0, 10, "maxAutoRepairAttempts");
  integer(config.longSessionMinutes, 1, 1440, "longSessionMinutes");
  validateSchedule(config.schedule);
  return config;
}

export function applyConfig(configPath, candidatePath) {
  const current = loadConfig(configPath), candidate = loadConfig(candidatePath);
  for (const key of ["stateDir", "codexCommand", "engineCommand", "runtimeDir", "skillPath"])
    requireValue(current[key] === candidate[key], `config-apply cannot change ${key}; use the installation procedure`);
  writeJson(configPath, candidate);
  return { applied: true, configDigest: jsonDigest(candidate), affects: "future admissions only", schedule: candidate.schedule };
}
export function taskDirectory(config, id) {
  requireValue(/^[a-f0-9]{64}$/.test(id), "Invalid task id");
  return join(config.stateDir, "tasks", id);
}
export function attemptDirectory(config, id, attempt = 0) {
  integer(attempt, 0, 10, "repairAttempts");
  const root = taskDirectory(config, id);
  return attempt ? join(root, "attempts", String(attempt).padStart(3, "0")) : root;
}
export const taskUnitName = (id, attempt = 0) => `mk-codex-task-${id}${attempt ? `-r${attempt}` : ""}.service`;
export function loadState(config) {
  const path = join(config.stateDir, "state.json");
  requireValue(existsSync(path), "Run init first; do not replace or delete an existing state directory");
  const state = readJson(regularFile(path));
  requireValue(state.version === 1 && Array.isArray(state.tasks) && state.slots && typeof state.paused === "boolean", "Invalid scheduler state");
  return state;
}
export const saveState = (config, state) => writeJson(join(config.stateDir, "state.json"), state);
export function initialize(config) {
  directory(config.stateDir);
  directory(join(config.stateDir, "tasks"));
  if (existsSync(join(config.stateDir, "state.json"))) return loadState(config);
  writeJson(join(config.stateDir, "state.json"), { version: 1, paused: true, tasks: [], slots: {}, createdAt: new Date().toISOString() }, { exclusive: true });
  return loadState(config);
}
