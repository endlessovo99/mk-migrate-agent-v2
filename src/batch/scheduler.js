import { sha256Digest } from "../agent-review/digest.js";
import { integer, itemBinding, newId, now, requireValue, text } from "./contracts.js";

export async function setTargetLimit(store, batchId, limit, actor) {
  const executionConcurrency = integer(limit, undefined, 16);
  text(actor, "actor");
  const initial = await store.get("batch", batchId);
  requireValue(initial, "Batch not found");
  return store.transaction(async (tx) => {
    const target = await tx.get("target", initial.targetId);
    const batches = await tx.list("batch", { baseUrl: initial.baseUrl });
    requireValue(batches.every((batch) => batch.status === "paused"), "Pause every batch for this origin before changing its limit");
    const active = await tx.list("item", { baseUrl: initial.baseUrl, status: "running" }, { fields: [] });
    requireValue(active.length === 0, "Wait for in-flight execution or recover expired workers before changing the limit");
    for (const batch of batches) await tx.mutate("batch", batch.id, (current) => ({ ...current, executionConcurrency, approval: null }));
    return tx.mutate("target", target.id, (current) => ({ ...current, executionConcurrency,
      history: [...(current.history || []), { actor, changedAt: now(), before: target.executionConcurrency, after: executionConcurrency }] }));
  });
}

export async function setBatchStatus(store, batchId, status) {
  requireValue(["paused", "running"].includes(status), "Invalid batch status");
  return store.transaction(async (tx) => {
    const batch = await tx.get("batch", batchId);
    requireValue(batch, "Batch not found");
    if (status === "running") {
      const runs = await tx.list("repair_run", { batchId });
      requireValue(!runs.some((run) => run.status === "applying"), "A scoped repair is still applying; investigate its retained evidence", "BATCH_REPAIR_IN_PROGRESS");
    }
    return tx.mutate("batch", batchId, (value) => ({ ...value, status, updatedAt: now() }));
  });
}

export async function claimItem(store, batchId, phase, { workerId, leaseMs, engineDigest }) {
  const initial = await store.get("batch", batchId);
  requireValue(initial, "Batch not found");
  return store.transaction(async (tx) => {
    if (phase === "execute") await tx.mutate("target", initial.targetId, () => null);
    const batch = await tx.get("batch", batchId);
    if (batch.status !== "running") return null;
    if (phase === "execute") {
      requireValue(batch.approval, "Approve the current prepared batch before execution", "BATCH_APPROVAL_REQUIRED");
      requireValue(batch.approval.batchId === batch.id && batch.approval.baseUrl === batch.baseUrl &&
        batch.approval.targetCategoryId === batch.targetCategoryId && batch.approval.migrationKey === batch.migrationKey,
      "Batch target differs from its approval", "BATCH_APPROVAL_STALE");
      const { digest, actor, approvedAt, ...proposal } = batch.approval;
      requireValue(sha256Digest(proposal) === digest, "Approval evidence has changed", "BATCH_APPROVAL_STALE");
      for (const active of await tx.list("item", { baseUrl: batch.baseUrl, status: "running" })) {
        if (Date.parse(active.leaseUntil) <= Date.now()) await recoverItem(tx, active.id);
      }
    }
    const candidates = await tx.list("item", { batchId, status: phase === "execute" ? "ready" : "pending",
      ...(phase === "execute" ? { approvedFor: batch.approval.digest } : {}) }, { limit: 1 });
    if (candidates.length && phase === "execute") {
      const active = await tx.list("item", { baseUrl: batch.baseUrl, status: "running" }, { fields: [] });
      if (active.length >= batch.executionConcurrency) return { waiting: true };
    }
    for (const candidate of candidates) {
      if (phase === "execute") {
        const approved = batch.approval.items.find((entry) => entry.id === candidate.id);
        if (!approved) continue;
        requireValue(sha256Digest(approved) === sha256Digest(itemBinding(candidate)), "Prepared item differs from the approved batch", "BATCH_APPROVAL_STALE");
        requireValue(sha256Digest(candidate.dsl) === candidate.dslDigest && sha256Digest(candidate.sourceDraft) === candidate.sourceDraftDigest &&
          sha256Digest({ snapshot: candidate.snapshot, templateName: candidate.templateName }) === candidate.sourceDigest,
        "Actual artifacts differ from their approved digests", "BATCH_APPROVAL_STALE");
        if (candidate.engineDigest !== engineDigest) {
          await tx.mutate("item", candidate.id, (item) => ({ ...item, status: "blocked",
            diagnostics: [...item.diagnostics, { level: "error", code: "BATCH_ENGINE_CHANGED",
              message: "Code or catalogs changed. Apply a recorded reprepare repair, then approve the regenerated DSL." }] }));
          return { rejected: true };
        }
        requireValue(!candidate.writeStarted && !candidate.targetTemplateId, "Item has previous remote effects", "BATCH_REMOTE_EFFECTS");
      }
      const attemptId = newId("attempt");
      return tx.mutate("item", candidate.id, (item) => ({ ...item,
        status: phase === "execute" ? "running" : "preparing", activeAttemptId: attemptId, workerId, attemptCount: (item.attemptCount || 0) + 1,
        leaseUntil: new Date(Date.now() + leaseMs).toISOString(),
        attempts: [...item.attempts, { id: attemptId, phase, status: "running", startedAt: now(), engineDigest,
          steps: [], ...(phase === "execute" ? { sourceDraft: item.sourceDraft, dsl: item.dsl } : {}) }]
      }));
    }
    return null;
  });
}

export function assertClaim(item, attemptId, { allowExpired = false } = {}) {
  requireValue(item && item.activeAttemptId === attemptId && ["preparing", "running"].includes(item.status), "Worker no longer owns this task", "BATCH_LEASE_LOST");
  requireValue(allowExpired || Date.parse(item.leaseUntil) > Date.now(), "Worker lease expired", "BATCH_LEASE_LOST");
}

export function renewClaim(store, itemId, attemptId, leaseMs) {
  return store.mutate("item", itemId, (item) => {
    assertClaim(item, attemptId);
    return { ...item, leaseUntil: new Date(Date.now() + leaseMs).toISOString() };
  });
}

export function updateClaim(store, itemId, attemptId, update) {
  return store.mutate("item", itemId, (item) => {
    assertClaim(item, attemptId);
    return update(item);
  });
}

export function executionJournal(store, itemId, attemptId) {
  return {
    beforeWrite: async (event) => updateClaim(store, itemId, attemptId, (item) => {
      const attempt = item.attempts.find((value) => value.id === attemptId);
      requireValue(!attempt.steps.some((step) => step.outcome === "pending"), "An earlier write has no durable receipt", "BATCH_WRITE_UNKNOWN");
      attempt.steps.push({ ...event, outcome: "pending", startedAt: now() });
      return { ...item, writeStarted: true };
    }),
    afterWrite: async (event) => updateClaim(store, itemId, attemptId, (item) => {
      const attempt = item.attempts.find((value) => value.id === attemptId);
      const step = attempt.steps.at(-1);
      requireValue(step?.outcome === "pending" && step.operation === event.operation, "Unexpected write receipt", "BATCH_WRITE_UNKNOWN");
      Object.assign(step, { ...event, outcome: "confirmed", completedAt: now() });
      return { ...item, targetTemplateId: event.result?.targetTemplateId || event.targetTemplateId || item.targetTemplateId };
    })
  };
}

export async function recoverBatch(store, batchId) {
  return store.transaction(async (tx) => {
    const batch = await tx.get("batch", batchId);
    requireValue(batch, "Batch not found");
    const recovered = [];
    const active = [...await tx.list("item", { batchId, status: "preparing" }), ...await tx.list("item", { batchId, status: "running" })];
    for (const candidate of active) {
      if (!["preparing", "running"].includes(candidate.status) || Date.parse(candidate.leaseUntil) > Date.now()) continue;
      const item = await recoverItem(tx, candidate.id);
      recovered.push({ itemId: item.id, status: item.status });
    }
    return { batchId, recovered };
  });
}

export async function retryItem(store, batchId, itemId) {
  return store.transaction(async (tx) => {
    const batch = await tx.get("batch", batchId);
    requireValue(batch?.status === "paused", "Pause the batch before retrying");
    return tx.mutate("item", itemId, (item) => {
      requireValue(item.batchId === batchId && item.status === "blocked" && !item.writeStarted && !item.targetTemplateId, "Only prewrite blocked items can be retried", "BATCH_RETRY_FORBIDDEN");
      requireValue(!item.diagnostics.some((entry) => entry.code === "BATCH_ENGINE_CHANGED"), "Use a recorded reprepare repair after an engine upgrade", "BATCH_RETRY_FORBIDDEN");
      return { ...item, status: item.dsl ? "ready" : "pending" };
    });
  });
}

function recoverItem(tx, itemId) {
  return tx.mutate("item", itemId, (item) => {
    const attempt = item.attempts.find((entry) => entry.id === item.activeAttemptId);
    const unknown = attempt.steps.some((step) => step.outcome === "pending");
    attempt.status = "interrupted";
    attempt.completedAt = now();
    const status = unknown ? "outcome_unknown" : item.writeStarted ? "needs_repair" : attempt.phase === "execute" ? "ready" : "pending";
    return { ...item, status, activeAttemptId: null, workerId: null, leaseUntil: null,
      diagnostics: [...item.diagnostics, { level: "error", code: "batch.worker_interrupted", message: "Worker lease expired; retained writes determine recovery eligibility." }] };
  });
}
