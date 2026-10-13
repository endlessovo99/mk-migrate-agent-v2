#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { canonicalDirectory, cleanNodeEnvironment, requireValue } from "./common.mjs";
import { serverOptions } from "./server-worker.mjs";

try {
  requireValue(process.platform === "linux" && process.getuid?.() === 0, "Server commands require Linux root");
  const args = process.argv.slice(2);
  const config = serverOptions(args);
  canonicalDirectory(dirname(config.runtime), { create: true });
  const parent = statSync(dirname(config.runtime));
  requireValue(parent.uid === 0 && (parent.mode & 0o022) === 0, "Runtime parent must be owned by root and not writable by other users");
  const lockPath = `${config.runtime}.control.lock`;
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    requireValue(stat.isFile() && stat.nlink === 1 && stat.uid === 0 && (stat.mode & 0o077) === 0, "Unsafe control lock");
  } finally { closeSync(fd); }
  const worker = fileURLToPath(new URL("./server-worker.mjs", import.meta.url));
  const mode = ["run", "status"].includes(config.action) ? "--shared" : "--exclusive";
  const child = spawn("flock", ["--nonblock", "--conflict-exit-code", "75", "--no-fork", mode, lockPath, process.execPath, worker, ...args], {
    stdio: "inherit", env: cleanNodeEnvironment()
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => { console.error(`Cannot start server controller: ${error.code}`); process.exitCode = 1; });
  child.on("exit", (code, signal) => {
    if (code === 75) console.error("Runtime is busy; stop accepting new jobs and wait for active commands before locking or replacing it.");
    process.exitCode = code ?? (signal ? 128 : 1);
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
