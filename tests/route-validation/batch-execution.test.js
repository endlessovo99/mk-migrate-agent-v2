import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { MemoryBatchStore } from "../../src/batch/store.js";
import { createBatch } from "../../src/batch/intake.js";
import { prepareBatch, approveBatch, executeBatch } from "../../src/batch/service.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";
import { withNetworkGuard } from "./network-guard.js";

it("Route-validation imports paired XML, prepares and approves a batch, then persists and verifies each native draft once", async () => {
  await withNetworkGuard(async () => {
    const fixturePath = fileURLToPath(new URL("../fixtures/batch/manifest.json", import.meta.url));
    const manifest = JSON.parse(readFileSync(fixturePath, "utf8"));
    const store = new MemoryBatchStore();
    const batch = await createBatch(store, manifest, { relativeTo: dirname(fixturePath) });
    const prepared = await prepareBatch(store, batch.id, {
      engineDigest: "route-batch-engine", provider: createFakeReviewProvider("accept"), concurrency: 2,
      checkpointSigningKey: "offline-batch-checkpoint-signing-key-32-characters"
    });
    assert.equal(prepared.counts.ready, 2);
    await approveBatch(store, batch.id, {
      expectedDigest: prepared.approvalDigest, confirmWrite: true, actor: "route-batch-reviewer"
    });
    const clients = new Map();
    const options = {
      engineDigest: "route-batch-engine", concurrency: 3, confirmWrite: true,
      credentials: { username: "route-test-user", encryptedPassword: "route-test-encrypted-password" },
      clientFactory: async ({ itemId }) => {
        const item = await store.get("item", itemId);
        const client = new FakeNewoaAdapter("persist", { templateAuthorization: item.dsl.template.authorization });
        clients.set(itemId, client);
        return client;
      }
    };
    const executed = await executeBatch(store, batch.id, options);
    assert.equal(executed.counts.succeeded, 2, JSON.stringify(executed.items));
    for (const item of await store.list("item", { batchId: batch.id })) {
      assert.deepEqual(item.attempts.map((attempt) => attempt.phase), ["prepare", "execute"]);
      const attempt = item.attempts[1];
      assert.equal(attempt.report.ok, true);
      assert.equal(attempt.report.readback.ok, true);
      assert.ok(attempt.steps.length >= 3);
      assert.ok(attempt.steps.every((step) => step.outcome === "confirmed"));
      assert.equal(clients.get(item.id).transcript().filter((entry) => entry.operation === "add").length, 1);
      assert.equal(clients.get(item.id).transcript().filter((entry) => entry.operation === "add-transfer-record").length, 1);
      assert.ok(item.targetTemplateId);
    }
    const replay = await executeBatch(store, batch.id, options);
    assert.equal(replay.counts.succeeded, 2);
    assert.equal(clients.size, 2);
    for (const item of await store.list("item", { batchId: batch.id })) assert.equal(item.attempts.length, 2);
  });
});
