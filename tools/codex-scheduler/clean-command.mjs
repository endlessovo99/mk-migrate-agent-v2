import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, fstatSync, openSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { requireValue, writeJson } from "./common.mjs";

/** clean --out also prints the Source Draft; route stdout/stderr to private files, never a bounded pipe. */
export function cleanInput(config, input, output, { timeoutMs = 60_000 } = {}) {
  requireValue(!existsSync(output), "Refusing to overwrite an existing clean artifact");
  const dir = dirname(output), descriptors = [];
  const startedAt = new Date().toISOString(), started = Date.now();
  let result, stdoutBytes, stderrBytes;
  try {
    descriptors.push(openSync(join(dir, "clean.stdout.log"), "wx", 0o600));
    descriptors.push(openSync(join(dir, "clean.stderr.log"), "wx", 0o600));
    result = spawnSync(config.engineCommand, ["run", "--", "clean", input, "--out", output], {
      timeout: timeoutMs, stdio: ["ignore", descriptors[0], descriptors[1]]
    });
    stdoutBytes = fstatSync(descriptors[0]).size;
    stderrBytes = fstatSync(descriptors[1]).size;
  } finally {
    for (const descriptor of descriptors) {
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    }
  }
  const receipt = { version: 1, startedAt, completedAt: new Date().toISOString(), elapsedMs: Date.now() - started, timeoutMs,
    exitCode: result.status, signal: result.signal, errorCode: result.error?.code || null, outputExists: existsSync(output),
    outputFile: basename(output), stdoutLog: "clean.stdout.log", stderrLog: "clean.stderr.log", stdoutBytes, stderrBytes };
  writeJson(join(dir, "clean.command.json"), receipt, { exclusive: true });
  requireValue(!result.error && result.status === 0 && !result.signal && receipt.outputExists,
    `Input clean failed (exit=${receipt.exitCode}, signal=${receipt.signal}, error=${receipt.errorCode}, output=${receipt.outputExists}); evidence: ${join(dir, "clean.command.json")}`);
  return receipt;
}
