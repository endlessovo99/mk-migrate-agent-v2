#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyConfig, attemptDirectory, directory, initialize, integer, loadConfig, loadState, readJson, requireValue, saveState, taskDirectory, taskUnitName, writeJson } from "./common.mjs";
import { dispatch, reconcile, resources, statusReport } from "./controller.mjs";
import { discoverSources, importManifest } from "./intake.mjs";
import { engineStatus } from "./worker.mjs";
import { readMetrics, sampleResources } from "./metrics.mjs";
import { cleanInput } from "./clean-command.mjs";

const HELP = `mk-codex-scheduler <command> [options]
  init                         Create a paused queue, preserving existing state
  doctor                       Check local prerequisites and engine state (no model/NewOA call)
  plan --input-root PATH --base-url ORIGIN --target-category-id ID
       --actor NAME --instruction-file PATH --out NEW_MANIFEST
  import --manifest PATH --confirm-write   Freeze and authorize exact task scope; queue must be paused
  resume | pause               Allow/stop new admissions; running workers continue
  tick                         Dispatch only the current Asia/Shanghai calendar slot
  start --count N [--task ID]   Manual dispatch sharing the same queue and capacity limit
  status [--out NEW_FILE]       Counts, duration samples, long-running sessions
  list [--status STATE] [--out NEW_FILE]    Task IDs and retained outcomes
  item --task ID               Task scope and completion evidence
  sample                       Save this minute's host/session resource sample
  metrics [--date YYYY-MM-DD] [--task ID] [--out NEW_FILE]   Latest sample or a Shanghai day's history
  config [--out NEW_FILE]       Show the effective configuration, including schedule defaults
  config-apply --file PATH      Validate and atomically apply configuration for future dispatches
  --config PATH                Default /etc/mk-migrate/codex-scheduler.json
Only needs_attention with complete proof of no remote writes may continue, up to maxAutoRepairAttempts (0-10).
There is no reset or replay command for written, uncertain or unproven tasks.
`;

function parse(argv) {
  const command = argv.shift();
  const options = {};
  const allowed = {
    init: [], doctor: [], pause: [], resume: [], tick: [], status: ["out"], list: ["status", "out"], item: ["task"],
    plan: ["input-root", "base-url", "target-category-id", "actor", "instruction-file", "out"],
    import: ["manifest", "confirm-write"], start: ["count", "task"], sample: [],
    metrics: ["date", "task", "out"], config: ["out"], "config-apply": ["file"]
  };
  requireValue(Object.hasOwn(allowed, command), HELP);
  while (argv.length) {
    const token = argv.shift();
    requireValue(token.startsWith("--"), "Unexpected argument");
    const key = token.slice(2);
    requireValue(["config", ...allowed[command]].includes(key) && !(key in options), `Unexpected or duplicate option: ${key}`);
    if (key === "confirm-write") options[key] = true;
    else {
      requireValue(argv[0] && !argv[0].startsWith("--"), `Missing value: ${key}`);
      options[key] = argv.shift();
    }
  }
  return { command, options };
}

function checkCommand(command, args, expected = 0) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 ** 2 });
  requireValue(result.status === expected, `Prerequisite command failed: ${command}`);
  return result.stdout;
}

export async function executeCommand(config, command, options) {
  if (command === "sample") return sampleResources(config);
  if (command === "config-apply") {
    requireValue(options.file, "Missing --file");
    return applyConfig(options.configPath, resolve(options.file));
  }
  if (["config", "metrics"].includes(command)) {
    const result = command === "config" ? config : readMetrics(config, { date: options.date, taskId: options.task });
    if (options.out) { writeJson(resolve(options.out), result, { exclusive: true }); return { wrote: resolve(options.out) }; }
    return result;
  }
  if (command === "init") return initialize(config);
  if (command === "doctor") {
    requireValue(existsSync(config.skillPath), "Install mk-migrate-server skill for the worker account first");
    const help = checkCommand(config.codexCommand, ["exec", "--help"]);
    for (const flag of ["--json", "--skip-git-repo-check", "--sandbox", "--add-dir", "--output-last-message"])
      requireValue(help.includes(flag), `Installed Codex lacks ${flag}`);
    checkCommand("systemctl", ["show", "--property=Version", "--value"]);
    checkCommand("systemd-run", ["--version"]);
    return { ok: true, engine: engineStatus(config), ...resources(config), maxSessions: config.maxSessions,
      note: "Local preflight only; model auth, sandbox execution, NewOA and sustained capacity are not verified." };
  }
  if (command === "plan") {
    for (const key of ["input-root", "base-url", "target-category-id", "actor", "instruction-file", "out"]) requireValue(options[key], `Missing --${key}`);
    const manifest = { version: 1, baseUrl: options["base-url"], targetCategoryId: options["target-category-id"], actor: options.actor,
      userInstruction: readFileSync(options["instruction-file"], "utf8"), items: discoverSources(options["input-root"]).map((sourcePath) => ({ sourcePath })) };
    writeJson(resolve(options.out), manifest, { exclusive: true });
    return { wrote: resolve(options.out), itemCount: manifest.items.length, authorized: false };
  }
  const state = loadState(config);
  if (command === "import") {
    requireValue(options.manifest, "Missing --manifest");
    return importManifest(config, state, readJson(options.manifest), { relativeTo: dirname(resolve(options.manifest)),
      confirmWrite: options["confirm-write"], engine: engineStatus(config), clean: (input, output) => cleanInput(config, input, output) });
  }
  if (["pause", "resume"].includes(command)) {
    state.paused = command === "pause";
    saveState(config, state);
    return { paused: state.paused, runningWorkersUnaffected: true };
  }
  if (command === "tick") return dispatch(config, state);
  if (command === "start") {
    const count = integer(Number(options.count), 1, 200, "count");
    return dispatch(config, state, { manualCount: count, taskId: options.task });
  }
  if (command === "item") {
    requireValue(state.tasks.some((task) => task.id === options.task), "Unknown task");
    const entry = state.tasks.find((task) => task.id === options.task);
    const attempts = Array.from({ length: (entry.repairAttempts || 0) + 1 }, (_, attempt) => {
      const dir = attemptDirectory(config, entry.id, attempt);
      return { attempt, unit: taskUnitName(entry.id, attempt), directory: dir,
        completion: existsSync(join(dir, "completion.json")) ? readJson(join(dir, "completion.json")) : null };
    });
    const current = attempts.at(-1);
    return { state: entry, task: readJson(join(taskDirectory(config, entry.id), "task.json")),
      completion: current.completion, directory: current.directory, attempts };
  }
  reconcile(config, state);
  saveState(config, state);
  const result = command === "status" ? statusReport(config, state) : state.tasks.filter((task) => !options.status || task.status === options.status);
  if (options.out) { writeJson(resolve(options.out), result, { exclusive: true }); return { wrote: resolve(options.out) }; }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.umask(0o077);
    const argv = process.argv.slice(2);
    if (!argv.length || ["help", "--help"].includes(argv[0])) { console.log(HELP); }
    else {
      const locked = argv[0] === "--locked";
      if (locked) argv.shift();
      const { command, options } = parse([...argv]);
      requireValue(process.platform === "linux" && process.getuid?.() === 0, "Server scheduler requires Linux root, matching mk-migrate-secure");
      const path = resolve(options.config || "/etc/mk-migrate/codex-scheduler.json");
      const config = loadConfig(path);
      directory(config.stateDir);
      if (!locked) {
        // Kernel lock serializes timer ticks, imports and manual starts, including across crashes.
        const lock = ["sample", "metrics"].includes(command) ? "sampling.lock" : "control.lock";
        const child = spawnSync("flock", ["--nonblock", "--conflict-exit-code", "75", "--close", join(config.stateDir, lock),
          process.execPath, fileURLToPath(import.meta.url), "--locked", ...argv], { stdio: "inherit" });
        process.exitCode = child.status ?? 1;
        if (child.status === 75) console.error("Scheduler is busy; no task was dispatched by this invocation.");
      } else console.log(JSON.stringify(await executeCommand(config, command, { ...options, configPath: path }), null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
