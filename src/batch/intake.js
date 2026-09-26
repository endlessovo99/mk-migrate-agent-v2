import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { sha256Digest } from "../agent-review/digest.js";
import { cleanSourceFile } from "../translator/index.js";
import { normalizeBaseUrl } from "../executor/newoa-client.js";
import { exactKeys, executionOptions, integer, newId, now, requireValue, text } from "./contracts.js";

/** Source bytes are frozen at import; workers never reread mutable intake paths. */
export function sourceSnapshot(sourcePath) {
  const directory = statSync(sourcePath).isDirectory();
  const names = directory ? readdirSync(sourcePath).filter((name) => /_(SysFormTemplate|LbpmProcessDefinition|KmReviewTemplate)\.xml$/i.test(name)).sort() : [basename(sourcePath)];
  requireValue(names.length > 0, "No supported source XML files found");
  return { directory, files: names.map((name) => ({ name, content: readFileSync(directory ? join(sourcePath, name) : sourcePath, "utf8") })) };
}

export function cleanSnapshot(snapshot, templateName) {
  const root = mkdtempSync(join(tmpdir(), "mk-batch-source-"));
  try {
    const input = join(root, `source-${sha256Digest(snapshot).slice(0, 24)}`);
    mkdirSync(input, { mode: 0o700 });
    for (const file of snapshot.files) {
      requireValue(basename(file.name) === file.name, "Invalid source filename");
      writeFileSync(join(input, file.name), file.content, { mode: 0o600 });
    }
    const draft = cleanSourceFile(snapshot.directory ? input : join(input, snapshot.files[0].name), { templateName });
    // Source paths are evidence labels; use stable snapshot-relative labels for checkpoint hashes.
    return JSON.parse(JSON.stringify(draft).split(root).join("batch-source"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function createBatch(store, manifest, { relativeTo = process.cwd() } = {}) {
  exactKeys(manifest, ["version", "name", "migrationKey", "baseUrl", "targetCategoryId", "executionConcurrency", "items"], "batch manifest");
  requireValue(manifest.version === 1, "batch manifest version must be 1");
  const name = text(manifest.name, "batch name");
  const migrationKey = text(manifest.migrationKey, "migrationKey");
  const baseUrl = normalizeBaseUrl(text(manifest.baseUrl, "baseUrl"));
  const targetCategoryId = text(manifest.targetCategoryId, "targetCategoryId");
  const executionConcurrency = integer(manifest.executionConcurrency, 1, 16);
  requireValue(Array.isArray(manifest.items) && manifest.items.length > 0, "items must be nonempty");
  const batchId = newId("batch");
  const targetId = sha256Digest(baseUrl);
  const items = manifest.items.map((entry) => {
    exactKeys(entry, ["sourcePath", "templateName", "executionOptions"], "batch item");
    const sourcePath = resolve(relativeTo, text(entry.sourcePath, "sourcePath"));
    const snapshot = sourceSnapshot(sourcePath);
    const templateName = entry.templateName === undefined ? "" : text(entry.templateName, "templateName");
    const sourceDraft = cleanSnapshot(snapshot, templateName);
    const sourceId = text(sourceDraft.source?.sysFormTemplate?.fdModelId || sourceDraft.source?.lbpmProcessDefinition?.templateId || sourceDraft.source?.fdModelId || sourceDraft.source?.fdId || sourceDraft.source?.sourceId, "source identity");
    const sourceDigest = sha256Digest({ snapshot, templateName });
    return { id: newId("item"), batchId, baseUrl, sourceId, name: sourceDraft.template.name, sourcePath, snapshot, templateName, sourceDigest,
      identityKey: sha256Digest({ baseUrl, targetCategoryId, sourceId, migrationKey }),
      executionOptions: executionOptionsFor(entry), sourceDraft, sourceDraftDigest: sha256Digest(sourceDraft), dslDraft: null, dsl: null, dslDigest: null,
      engineDigest: null, checkpoint: null, status: "pending", diagnostics: [], attempts: [], attemptCount: 0, repairHistory: [],
      activeAttemptId: null, workerId: null, leaseUntil: null, writeStarted: false, targetTemplateId: null, createdAt: now() };
  });
  requireValue(new Set(items.map((item) => item.identityKey)).size === items.length, "A source identity occurs more than once in this migration scope", "BATCH_CONFLICT");
  try { await store.create("target", targetId, { origin: baseUrl, executionConcurrency }); }
  catch (error) { if (error.code !== "BATCH_CONFLICT") throw error; }
  return store.transaction(async (tx) => {
    const target = await tx.get("target", targetId);
    requireValue(target.executionConcurrency === executionConcurrency, "This origin already has a different executionConcurrency", "BATCH_CONFLICT");
    const batch = await tx.create("batch", batchId, { name, migrationKey, baseUrl, targetId, targetCategoryId,
      executionConcurrency, status: "paused", approval: null, createdAt: now() });
    for (const item of items) await tx.create("item", item.id, item);
    return { ...batch, itemCount: items.length };
  });
}

function executionOptionsFor(entry) { return executionOptions(entry.executionOptions || {}); }
