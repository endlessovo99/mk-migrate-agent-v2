import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { digest, directory, exactKeys, jsonDigest, nonempty, origin, readJson, regularFile, requireValue, saveState, syncDirectory, taskDirectory, writeJson } from "./common.mjs";

const sourcePattern = /_SysFormTemplate\.xml$/i;
const xmlPattern = /_(SysFormTemplate|LbpmProcessDefinition|KmReviewTemplate)\.xml$/i;

export function discoverSources(root) {
  const result = [];
  function visit(path) {
    const stat = lstatSync(path);
    requireValue(!stat.isSymbolicLink(), `Input symlinks are not supported: ${path}`);
    if (stat.isFile()) { if (sourcePattern.test(path)) result.push(path); return; }
    requireValue(stat.isDirectory(), "Unsupported input path");
    const entries = readdirSync(path).sort();
    const forms = entries.filter((name) => sourcePattern.test(name));
    if (forms.length) {
      const companions = entries.filter((name) => /_(LbpmProcessDefinition|KmReviewTemplate)\.xml$/i.test(name));
      requireValue(forms.length === 1 || !companions.length, `Ambiguous paired directory: ${path}`);
      if (companions.length) result.push(path);
      else result.push(...forms.map((name) => join(path, name)));
    }
    for (const name of entries) {
      const child = join(path, name);
      const stat = lstatSync(child);
      requireValue(!stat.isSymbolicLink(), `Input symlinks are not supported: ${child}`);
      if (stat.isDirectory()) visit(child);
    }
  }
  visit(resolve(root));
  requireValue(result.length > 0, "No supported source XML found");
  return result;
}

function snapshot(sourcePath) {
  const stat = lstatSync(sourcePath);
  requireValue(!stat.isSymbolicLink(), "Source symlinks are not supported");
  const isDirectory = stat.isDirectory();
  const names = isDirectory ? readdirSync(sourcePath).filter((name) => xmlPattern.test(name)).sort() : [basename(sourcePath)];
  requireValue(names.filter((name) => sourcePattern.test(name)).length === 1, "Each task requires exactly one SysFormTemplate XML");
  const files = names.map((name) => {
    const bytes = readFileSync(regularFile(isDirectory ? join(sourcePath, name) : sourcePath));
    return { name, bytes, sha256: digest(bytes) };
  });
  return { isDirectory, files, sourceDigest: jsonDigest(files.map(({ name, sha256 }) => ({ name, sha256 }))) };
}

export function verifySnapshot(task, dir) {
  for (const file of task.files) requireValue(digest(readFileSync(regularFile(join(dir, "source", file.name)))) === file.sha256, "Source snapshot changed");
}

/** Uses the installed encrypted engine's clean command; no translator implementation is shipped here. */
export async function importManifest(config, state, manifest, { relativeTo, confirmWrite, clean, engine }) {
  exactKeys(manifest, ["version", "baseUrl", "targetCategoryId", "actor", "userInstruction", "items"], "manifest");
  requireValue(confirmWrite === true, "Import requires --confirm-write for the exact manifest scope");
  requireValue(state.paused, "Pause admission before importing tasks");
  requireValue(manifest.version === 1 && Array.isArray(manifest.items) && manifest.items.length > 0, "Invalid manifest");
  const baseUrl = origin(nonempty(manifest.baseUrl, "baseUrl"));
  const targetCategoryId = nonempty(manifest.targetCategoryId, "targetCategoryId");
  const authorization = { actor: nonempty(manifest.actor, "actor"), userInstruction: nonempty(manifest.userInstruction, "userInstruction"),
    manifestDigest: jsonDigest(manifest), confirmedAt: new Date().toISOString(), action: "new-MK_TEST-draft" };
  requireValue(engine.status === "unlocked" && engine.releaseId && engine.sha256, "Engine must be unlocked with a release identity");
  const indexed = new Map(state.tasks.map((task) => [task.id, task]));
  const counts = { imported: 0, existing: 0 };
  try {
    for (const item of manifest.items) {
      exactKeys(item, ["sourcePath"], "manifest item");
      const sourcePath = resolve(relativeTo, nonempty(item.sourcePath, "sourcePath"));
      const snap = snapshot(sourcePath);
      const staging = mkdtempSync(join(config.stateDir, "intake-"));
      let failed = false;
      try {
        directory(join(staging, "source"));
        for (const file of snap.files) writeFileSync(join(staging, "source", file.name), file.bytes, { flag: "wx", mode: 0o400 });
        const input = snap.isDirectory ? join(staging, "source") : join(staging, "source", snap.files[0].name);
        const draftPath = join(staging, "source-draft.json");
        await clean(input, draftPath);
        const draft = readJson(regularFile(draftPath));
        requireValue(draft.ok !== false, "Source clean failed");
        const source = draft.source;
        const sourceId = nonempty(source?.lbpmProcessDefinition?.templateId || source?.sysFormTemplate?.fdModelId || source?.fdModelId || source?.sourceId, "cleaned source identity");
        // Category/path/manifest changes cannot bypass an earlier attempt against this origin/source.
        const id = jsonDigest({ baseUrl, sourceId });
        const dir = taskDirectory(config, id);
        const task = { version: 1, id, sourceId, sourcePath, baseUrl, targetCategoryId, sourceDigest: snap.sourceDigest,
          directoryInput: snap.isDirectory, files: snap.files.map(({ name, sha256 }) => ({ name, sha256 })),
          authorization, engine: { releaseId: engine.releaseId, sha256: engine.sha256 }, createdAt: new Date().toISOString() };
        if (existsSync(dir)) {
          const previous = readJson(regularFile(join(dir, "task.json")));
          requireValue(previous.sourceDigest === task.sourceDigest && previous.baseUrl === baseUrl && previous.sourceId === sourceId &&
            previous.targetCategoryId === targetCategoryId, `Task already exists with different input or target: ${id}`);
          verifySnapshot(previous, dir);
          if (!indexed.has(id)) {
            requireValue(!existsSync(join(dir, "launch-intent.json")), `Unindexed attempted task requires investigation: ${id}`);
            const entry = { id, sourceId, status: "queued", createdAt: previous.createdAt };
            state.tasks.push(entry); indexed.set(id, entry); counts.imported++;
          } else counts.existing++;
          continue;
        }
        requireValue(!indexed.has(id), `Missing task evidence: ${id}`);
        writeJson(join(staging, "task.json"), task, { exclusive: true });
        mkdirSync(join(staging, "work"), { mode: 0o700 });
        // Clean paths were temporary evidence labels; Codex repeats clean against the frozen final input.
        renameSync(staging, dir);
        syncDirectory(dirname(dir));
        const entry = { id, sourceId, status: "queued", createdAt: task.createdAt };
        state.tasks.push(entry); indexed.set(id, entry); counts.imported++;
        if (counts.imported % 50 === 0) saveState(config, state);
      } catch (error) {
        failed = true;
        writeJson(join(staging, "intake-failure.json"), { sourcePath, at: new Date().toISOString(),
          reason: "Import failed before admission; retain this snapshot and inspect the original input.",
          ...(existsSync(join(staging, "clean.command.json")) ? { cleanReport: "clean.command.json" } : {}) }, { exclusive: true });
        throw error;
      } finally { if (!failed) rmSync(staging, { recursive: true, force: true }); }
    }
  } finally { saveState(config, state); }
  return counts;
}
