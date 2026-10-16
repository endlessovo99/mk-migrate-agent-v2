import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { MemoryBatchStore } from "../../src/batch/store.js";
import { createBatch } from "../../src/batch/intake.js";
import { prepareBatch } from "../../src/batch/service.js";
import { createFakeReviewProvider } from "./fake-review-provider.js";
import { withNetworkGuard } from "./network-guard.js";

const repairs = JSON.parse(readFileSync(new URL("../fixtures/route-validation/batch-repair-status-projection/repairs.json", import.meta.url), "utf8"));
const options = {
  engineDigest: "repair-status-projection-engine",
  concurrency: 1,
  checkpointSigningKey: "offline-repair-status-checkpoint-key-32-characters"
};

// Exercise the actual store projection. Delivering any immutable history body
// to the scheduler violates this route's bounded status-read contract.
class StatusReadStore extends MemoryBatchStore {
  repairStatusReads = 0;
  transaction(operation) {
    return super.transaction(tx => operation({
      ...tx,
      list: async (kind, filters, projection) => {
        const rows = await tx.list(kind, filters, projection);
        if (kind === "repair_run") {
          this.repairStatusReads++;
          assert.ok(rows.every(row => Object.keys(row).every(key => ["id", "version", "status"].includes(key))),
            "A batch status gate may receive only id, version and status, never nested immutable repair snapshots");
        }
        return rows;
      }
    }));
  }
}

async function setup(applying = false) {
  const path = fileURLToPath(new URL("../fixtures/batch/manifest.json", import.meta.url));
  const store = new StatusReadStore();
  const batch = await createBatch(store, JSON.parse(readFileSync(path, "utf8")), { relativeTo: dirname(path) });
  for (const run of repairs.retainedRuns) await store.create("repair_run", run.id, { ...run, batchId: batch.id });
  // Another batch's repair must neither block nor enter this status read.
  await store.create("repair_run", "repair-run-other-batch", { ...repairs.applyingRun, batchId: "unrelated-batch" });
  if (applying) await store.create("repair_run", repairs.applyingRun.id, { ...repairs.applyingRun, batchId: batch.id });
  const history = await store.list("repair_run");
  return { store, batch, history };
}

it("Route-validation prepares an XML batch without delivering retained repair snapshots to the status gate", async () => {
  await withNetworkGuard(async () => {
    const { store, batch, history } = await setup();
    const result = await prepareBatch(store, batch.id, { ...options, provider: createFakeReviewProvider("accept") });
    assert.equal(result.counts.ready, 2);
    assert.equal(store.repairStatusReads, 1);
    assert.deepEqual(await store.list("repair_run"), history);
  });
});

it("Route-validation still blocks an applying scoped repair before claiming any XML item", async () => {
  await withNetworkGuard(async () => {
    const { store, batch, history } = await setup(true);
    await assert.rejects(prepareBatch(store, batch.id, { ...options, provider: createFakeReviewProvider("accept") }),
      { code: "BATCH_REPAIR_IN_PROGRESS" });
    assert.equal(store.repairStatusReads, 1);
    assert.equal((await store.get("batch", batch.id)).status, "paused");
    for (const item of await store.list("item", { batchId: batch.id })) {
      assert.equal(item.status, "pending");
      assert.equal(item.activeAttemptId, null);
      assert.equal(item.workerId, null);
      assert.equal(item.leaseUntil, null);
      assert.equal(item.writeStarted, false);
      assert.equal(item.targetTemplateId, null);
      assert.deepEqual(item.attempts, []);
    }
    assert.deepEqual(await store.list("repair_run"), history);
  });
});
