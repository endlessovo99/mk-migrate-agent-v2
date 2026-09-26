import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { main } from "../../src/cli/main.js";
import { MemoryBatchStore } from "../../src/batch/store.js";

async function invoke(argv, options) {
  const lines = [];
  const original = console.log;
  const previousExit = process.exitCode;
  try {
    console.log = (line) => lines.push(line);
    process.exitCode = undefined;
    await main(["batch", ...argv], options);
    return { result: JSON.parse(lines.at(-1)), exitCode: process.exitCode || 0 };
  } finally { console.log = original; process.exitCode = previousExit; }
}

test("batch CLI persists source snapshots, emits private exports and fails closed without approval", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mk-batch-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = join(root, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ version: 1, name: "CLI batch", migrationKey: "test", baseUrl: "https://p-sit.onewo.com",
    targetCategoryId: "category", items: [{ sourcePath: resolve("tests/fixtures/route-validation/paired") }] }));
  const batchStore = new MemoryBatchStore();
  const options = { batchStore, env: { NEWOA_USERNAME: "private-user", NEWOA_ENCRYPTED_PASSWORD: "private-password" } };
  const created = await invoke(["create", manifest], options);
  assert.equal(created.exitCode, 0);
  assert.equal(created.result.itemCount, 1);
  const batchId = created.result.id;
  const inspected = await invoke(["status", batchId], options);
  assert.equal(inspected.result.counts.pending, 1);
  assert.equal(JSON.stringify(inspected).includes("private-password"), false);
  assert.equal(JSON.stringify(inspected).includes("<root>"), false);
  const denied = await invoke(["run", batchId, "--confirm-write"], options);
  assert.equal(denied.exitCode, 1);
  assert.match(denied.result.message, /Approve/);
  const out = join(root, "status.json");
  const exported = await invoke(["status", batchId, "--out", out], options);
  assert.equal(exported.result.wrote, out);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).counts.pending, 1);
  const duplicate = await invoke(["create", manifest], options);
  assert.equal(duplicate.exitCode, 1);
  assert.equal((await batchStore.list("batch")).length, 1);
  const limit = await invoke(["limit", batchId, "2", "--actor", "operator"], options);
  assert.equal(limit.result.executionConcurrency, 2);
  assert.deepEqual(limit.result.history.map((entry) => [entry.actor, entry.before, entry.after]), [["operator", 1, 2]]);
  await invoke(["resume", batchId], options);
  assert.equal((await invoke(["limit", batchId, "3", "--actor", "operator"], options)).exitCode, 1);
});

test("batch CLI rejects unknown options and missing durable store configuration", async () => {
  const unknown = await invoke(["list", "--confirm-writes"], { batchStore: new MemoryBatchStore(), env: {} });
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.result.message, /Unknown batch option/);
  const missing = await invoke(["list"], { env: {} });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.result.message, /MK_BATCH_DATABASE_URL/);
  const ambiguous = await invoke(["run", "batch-one", "--confirm-write", "false"], { batchStore: new MemoryBatchStore(), env: {} });
  assert.equal(ambiguous.exitCode, 1);
  assert.match(ambiguous.result.message, /unexpected positional/);
});

test("repair CLI exposes definitions, explicit preview and per-item application history", async () => {
  const batchStore = new MemoryBatchStore();
  await batchStore.create("repair", "repair-one", { definition: { title: "Repair mapping", action: { kind: "reprepare" } } });
  await batchStore.create("repair_application", "application-one", { batchId: "batch-one", itemId: "item-one", repairId: "repair-one", status: "applied" });
  const options = { batchStore, env: {} };
  assert.equal((await invoke(["repairs"], options)).result[0].id, "repair-one");
  assert.equal((await invoke(["repair-show", "repair-one"], options)).result.definition.title, "Repair mapping");
  assert.equal((await invoke(["repair-history", "--item", "item-one"], options)).result[0].id, "application-one");
  assert.deepEqual((await invoke(["repair-history", "--item", "another-item"], options)).result, []);
});
