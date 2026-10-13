import { spawn, spawnSync } from "node:child_process";
import { closeSync, createReadStream, existsSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { assessEvidence } from "./evidence.mjs";
import { verifySnapshot } from "./intake.mjs";
import { codexArguments, taskPrompt } from "./prompt.mjs";
import { jsonDigest, readJson, regularFile, requireValue, writeJson } from "./common.mjs";
import { verifyRepairContext } from "./repair.mjs";
import { systemdState } from "./controller.mjs";

export function engineStatus(config) {
  const result = spawnSync(config.engineCommand, ["status"], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  requireValue(result.status === 0, "Cannot read encrypted engine status");
  const status = JSON.parse(result.stdout);
  requireValue(status.status === "unlocked" && status.releaseId && status.sha256, "Encrypted engine is not unlocked");
  return status;
}

async function eventSummary(path) {
  const result = { threadId: null, usage: null };
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started") result.threadId = event.thread_id;
      if (event.type === "turn.completed") result.usage = event.usage;
    } catch { /* Raw private logs are retained even when an event is incomplete. */ }
  }
  return result;
}

export async function runWorker(dir, { status = engineStatus, spawnCodex = spawn, inspect = systemdState } = {}) {
  let result;
  let codexStarted = false;
  const startedAt = new Date().toISOString();
  // A worker is single-attempt even if systemd or an operator accidentally starts it twice.
  writeJson(join(dir, "worker-start.json"), { pid: process.pid, startedAt }, { exclusive: true });
  try {
    const task = readJson(regularFile(join(dir, "task.json")));
    const launch = readJson(regularFile(join(dir, "launch-intent.json")));
    const config = readJson(regularFile(join(dir, "run-config.json")));
    requireValue(launch.taskDigest === jsonDigest(task) && launch.configDigest === jsonDigest(config), "Launch scope changed");
    let repair = null;
    if (existsSync(join(dir, "repair-context.json")) || launch.repairContextDigest) {
      repair = readJson(regularFile(join(dir, "repair-context.json")));
      requireValue(launch.repairContextDigest === jsonDigest(repair), "Repair scope changed");
      verifyRepairContext(config, task, dir, repair, inspect);
    }
    verifySnapshot(task, dir);
    regularFile(config.skillPath);
    const current = status(config);
    requireValue(current.releaseId === task.engine.releaseId && current.sha256 === task.engine.sha256, "Engine changed since task import");
    const prompt = taskPrompt(config, task, dir, repair);
    const out = openSync(join(dir, "events.jsonl"), "wx", 0o600);
    const err = openSync(join(dir, "stderr.log"), "wx", 0o600);
    let processResult;
    try {
      processResult = await new Promise((resolveResult) => {
        const env = { ...process.env };
        for (const name of ["NODE_OPTIONS", "NODE_COMPILE_CACHE", "NODE_V8_COVERAGE"]) delete env[name];
        const child = spawnCodex(config.codexCommand, codexArguments(config, dir), { cwd: join(dir, "work"), env, stdio: ["pipe", out, err] });
        child.once("spawn", () => { codexStarted = true; });
        child.once("error", () => resolveResult({ code: null, signal: null, spawnFailed: true }));
        child.once("close", (code, signal) => resolveResult({ code, signal }));
        child.stdin.on("error", () => {});
        child.stdin.end(prompt);
      });
    } finally { closeSync(out); closeSync(err); }
    verifySnapshot(task, dir);
    const summary = await eventSummary(join(dir, "events.jsonl"));
    result = { ...assessEvidence(task, dir, processResult), process: processResult, ...summary };
  } catch {
    // Do not print provider/config errors that could contain credentials.
    result = { status: codexStarted ? "outcome_unknown" : "needs_attention", reason: codexStarted ? "worker_runtime_failed" : "worker_preflight_failed" };
  }
  const completedAt = new Date().toISOString();
  const completion = { ...result, startedAt, completedAt, durationSeconds: (Date.parse(completedAt) - Date.parse(startedAt)) / 1000 };
  writeJson(join(dir, "completion.json"), completion, { exclusive: true });
  return completion;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runWorker(resolve(process.argv[2])); }
  catch { console.error("Worker stopped; inspect retained evidence. Do not replay this task."); process.exitCode = 1; }
}
