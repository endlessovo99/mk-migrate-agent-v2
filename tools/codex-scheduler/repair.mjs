import { createHash } from "node:crypto";
import { closeSync, copyFileSync, chmodSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { attemptDirectory, directory, integer, jsonDigest, readJson, regularFile, requireValue, taskDirectory, writeJson } from "./common.mjs";
import { assessEvidence, readCompletion } from "./evidence.mjs";
import { verifySnapshot } from "./intake.mjs";

const denialDetails = new Set([
  "previous_session_not_settled", "task_scope_changed", "launch_scope_changed", "no_completed_safe_attempt",
  "execution_receipt_missing", "no_remote_write_not_proven", "execution_evidence_changed", "unbound_execution_evidence",
  "stdout_receipt_mismatch", "stdout_receipt_path_mismatch", "retained_history_changed", "unexpected_attempt_history", "evidence_json_invalid"
]);

function denialDetail(error) {
  if (denialDetails.has(error?.message)) return error.message;
  if (error instanceof SyntaxError) return "evidence_json_invalid";
  if (error?.code === "ENOENT") return "evidence_file_missing";
  if (error?.message === "Source snapshot changed") return "source_snapshot_changed";
  return "evidence_validation_failed";
}

function verifyStdoutCopy(name, value, work, receipts) {
  const match = /^(?:execute|execution)-(\d{3})\.stdout\.json$/.exec(name);
  requireValue(match, "unbound_execution_evidence");
  const reportName = `execution-${match[1]}.report.json`;
  requireValue(receipts.has(reportName), "unbound_execution_evidence");
  const reportPath = join(work, reportName);
  const { wrote, ...body } = value;
  // The CLI emits {...report, wrote: args.out}; only this bound path metadata is extra.
  if (Object.hasOwn(value, "wrote")) requireValue(typeof wrote === "string" && isAbsolute(wrote) && resolve(wrote) === reportPath,
    "stdout_receipt_path_mismatch");
  requireValue(isDeepStrictEqual(body, readJson(regularFile(reportPath))), "stdout_receipt_mismatch");
}

// Hash large private event logs without buffering them in memory.
function fileDigest(path) {
  const fd = openSync(regularFile(path), "r"), hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
  try { let size; while ((size = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size)); }
  finally { closeSync(fd); }
  return hash.digest("hex");
}

export function evidenceManifest(dir) {
  const files = [];
  function visit(path, prefix = "") {
    requireValue(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), "Invalid evidence directory");
    for (const name of readdirSync(path).sort()) {
      if (!prefix && name === "attempts") continue;
      const child = join(path, name), relative = prefix + name;
      const stat = lstatSync(child);
      requireValue(!stat.isSymbolicLink(), "Symlink in retained evidence");
      if (stat.isDirectory()) visit(child, relative + "/");
      else files.push({ file: relative, sha256: fileDigest(child) });
    }
  }
  visit(dir);
  return files;
}

function validateAttempt(config, task, attempt, inspect) {
  const dir = attemptDirectory(config, task.id, attempt);
  requireValue(["inactive", "failed"].includes(inspect(task.id, attempt)), "previous_session_not_settled");
  requireValue(jsonDigest(readJson(regularFile(join(dir, "task.json")))) === jsonDigest(task), "task_scope_changed");
  verifySnapshot(task, dir);
  const launch = readJson(regularFile(join(dir, "launch-intent.json")));
  requireValue(launch.taskDigest === jsonDigest(task) && launch.configDigest === jsonDigest(readJson(regularFile(join(dir, "run-config.json")))), "launch_scope_changed");
  const completion = readCompletion(dir);
  requireValue(completion?.status === "needs_attention" && completion.process?.code === 0 && !completion.process.signal && !completion.process.spawnFailed,
    "no_completed_safe_attempt");
  const assessed = assessEvidence(task, dir, completion.process);
  requireValue(assessed.reason !== "no_execution_receipt", "execution_receipt_missing");
  requireValue(assessed.status === "needs_attention" && assessed.noRemoteWriteConfirmed === true, "no_remote_write_not_proven");
  requireValue(jsonDigest(assessed.evidence) === jsonDigest(completion.evidence), "execution_evidence_changed");
  // Retained stdout can duplicate a bound receipt, but cannot introduce another execution outcome.
  const receipts = new Set(assessed.evidence.map((row) => row.file));
  for (const name of readdirSync(join(dir, "work")).filter((name) => name.endsWith(".json"))) {
    const value = readJson(regularFile(join(dir, "work", name)));
    requireValue(value !== null, "evidence_json_invalid");
    if (!receipts.has(name) && (/^(?:execute|execution)-\d{3}\.stdout\.json$/.test(name) ||
        Object.hasOwn(value, "remoteWriteAttempted") || Object.hasOwn(value, "writeOutcomeUnknown"))) {
      verifyStdoutCopy(name, value, join(dir, "work"), receipts);
    }
  }
  return { attempt, directory: dir, files: evidenceManifest(dir) };
}

function validateHistory(config, task, count, inspect) {
  const history = [];
  for (let attempt = 0; attempt <= count; attempt++) {
    const row = validateAttempt(config, task, attempt, inspect);
    if (attempt) {
      const context = readJson(regularFile(join(row.directory, "repair-context.json")));
      const launch = readJson(join(row.directory, "launch-intent.json"));
      requireValue(context.attempt === attempt && context.taskId === task.id &&
        launch.repairContextDigest === jsonDigest(context) && jsonDigest(context.history) === jsonDigest(history), "retained_history_changed");
    }
    history.push(row);
  }
  return history;
}

export function repairDecision(config, entry, inspect) {
  const count = entry.repairAttempts ?? 0;
  try {
    integer(count, 0, 10, "repairAttempts");
    const limit = integer(config.maxAutoRepairAttempts ?? 10, 0, 10, "maxAutoRepairAttempts");
    if (entry.status !== "needs_attention") return { eligible: false, reason: "not_needs_attention" };
    if (!limit || count >= limit) return { eligible: false, reason: limit ? "retry_limit_reached" : "disabled" };
    const root = taskDirectory(config, entry.id), attempts = join(root, "attempts");
    const names = existsSync(attempts) ? readdirSync(attempts).sort() : [];
    requireValue(jsonDigest(names) === jsonDigest(Array.from({ length: count }, (_, i) => String(i + 1).padStart(3, "0"))), "unexpected_attempt_history");
    const task = readJson(regularFile(join(root, "task.json")));
    requireValue(task.id === entry.id && task.authorization?.action === "new-MK_TEST-draft", "task_scope_changed");
    const history = validateHistory(config, task, count, inspect);
    return { eligible: true, reason: "confirmed_no_remote_write", context: { version: 1, taskId: task.id, attempt: count + 1, history } };
  } catch (error) {
    // Missing, changed, uncertain or active history must never become a retry just because a process exited.
    return { eligible: false, reason: "no_remote_write_not_proven", detail: denialDetail(error) };
  }
}

export function prepareRepair(config, entry, context) {
  const root = taskDirectory(config, entry.id), dir = attemptDirectory(config, entry.id, context.attempt);
  directory(join(root, "attempts"));
  mkdirSync(dir, { mode: 0o700 }); // Exclusive: crashes never overwrite a previous attempt.
  directory(join(dir, "source")); directory(join(dir, "work"));
  const task = readJson(join(root, "task.json"));
  for (const name of ["task.json", "source-draft.json", ...task.files.map((file) => join("source", file.name))]) {
    copyFileSync(regularFile(join(root, name)), join(dir, name)); chmodSync(join(dir, name), 0o400);
  }
  writeJson(join(dir, "repair-context.json"), context, { exclusive: true });
  return dir;
}

export function verifyRepairContext(config, task, dir, context, inspect) {
  integer(context.attempt, 1, 10, "repair attempt");
  requireValue(context.taskId === task.id && resolve(dir) === attemptDirectory(config, task.id, context.attempt), "Invalid repair scope");
  const history = validateHistory(config, task, context.attempt - 1, inspect);
  requireValue(jsonDigest(history) === jsonDigest(context.history), "Retained history changed after admission");
}
