import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_LOCK_ROOT = join(
  homedir(),
  ".codex",
  "mk-migrate-agent-v2",
  "locked-draft-locks"
);

/** Create one permanent local write-attempt lock for a target draft. */
export function createLockedDraftState({
  baseUrl,
  targetTemplateId,
  operation,
  evidenceDigest,
  artifactsDir,
  testLockRoot,
  allowTestLockRoot = false
}) {
  const lockRoot = allowTestLockRoot && testLockRoot
    ? testLockRoot
    : DEFAULT_LOCK_ROOT;
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const lockId = createHash("sha256")
    .update(JSON.stringify({ baseUrl, targetTemplateId }))
    .digest("hex");
  const globalPath = join(lockRoot, `${lockId}.json`);
  const artifactPath = join(artifactsDir, "locked-draft-state.json");
  const base = {
    operation,
    baseUrl,
    targetTemplateId,
    evidenceDigest
  };
  const write = (path, value, flag) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag,
      flush: true
    });
  };
  const initial = {
    ...base,
    status: "prepared",
    templateWriteStarted: false,
    templateWriteCompleted: false,
    templateWriteOutcomeUnknown: false,
    transferRecordStarted: false,
    transferRecordCompleted: false,
    transferRecordOutcomeUnknown: false
  };
  write(globalPath, initial, "wx");
  try {
    write(artifactPath, initial, "wx");
  } catch (error) {
    // The permanent target lock intentionally remains after any preparation
    // ambiguity; callers must investigate rather than choose another directory.
    throw error;
  }

  return {
    globalPath,
    artifactPath,
    record(status, extra = {}) {
      const value = { ...base, status, ...extra };
      write(globalPath, value, "w");
      write(artifactPath, value, "w");
    }
  };
}
