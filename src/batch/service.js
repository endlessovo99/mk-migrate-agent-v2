import { sha256Digest } from "../agent-review/digest.js";
import { runAgentReview } from "../agent-review/index.js";
import { draftSourceDraft } from "../translator/index.js";
import { checkTrust } from "../dsl/trust.js";
import { buildDryRunPlan } from "../executor/dry-run.js";
import { executeDsl } from "../executor/execute.js";
import { setTimeout as delay } from "node:timers/promises";
import { cleanSnapshot } from "./intake.js";
import { engineDigest, integer, itemBinding, json, newId, now, requireValue, safeFailure, text } from "./contracts.js";
import { claimItem, executionJournal, recoverBatch, renewClaim, setBatchStatus, updateClaim } from "./scheduler.js";

export async function inspectBatch(store, batchId) {
  const batch = await store.get("batch", batchId);
  requireValue(batch, "Batch not found");
  const items = await store.list("item", { batchId }, { fields: ["sourceId", "name", "sourceDigest", "sourceDraftDigest", "dslDigest", "engineDigest",
    "executionOptions", "status", "targetTemplateId", "diagnostics", "attemptCount", "repairHistory"] });
  const ready = items.filter((item) => item.status === "ready").map(itemBinding);
  const proposal = { batchId, baseUrl: batch.baseUrl, targetCategoryId: batch.targetCategoryId, migrationKey: batch.migrationKey, items: ready };
  const counts = {};
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  return { batch, counts, approvalDigest: sha256Digest(proposal), proposal,
    items: items.map((item) => ({ id: item.id, sourceId: item.sourceId, name: item.name,
      status: item.status, targetTemplateId: item.targetTemplateId, diagnostics: item.diagnostics,
      attempts: item.attemptCount || 0, repairHistory: item.repairHistory })) };
}

export async function approveBatch(store, batchId, { expectedDigest, confirmWrite, actor }) {
  requireValue(confirmWrite === true, "Batch write approval requires --confirm-write", "BATCH_APPROVAL_REQUIRED");
  text(actor, "actor");
  return store.transaction(async (tx) => {
    const report = await inspectBatch(tx, batchId);
    requireValue(report.proposal.items.length > 0, "No prepared items to approve");
    requireValue(report.approvalDigest === expectedDigest, "Batch preview changed", "BATCH_APPROVAL_STALE");
    for (const item of report.proposal.items) await tx.mutate("item", item.id, (current) => ({ ...current, approvedFor: expectedDigest }));
    return tx.mutate("batch", batchId, (batch) => ({ ...batch,
      approval: { ...report.proposal, digest: expectedDigest, actor, approvedAt: now() } }));
  });
}

export async function prepareBatch(store, batchId, options = {}) {
  return runWorkers(store, batchId, "prepare", options, async (item, context) => {
    const sourceDraft = cleanSnapshot(item.snapshot, item.templateName);
    const dslDraft = draftSourceDraft(sourceDraft);
    await updateClaim(store, item.id, item.activeAttemptId, (current) => json({ ...current, sourceDraft, sourceDraftDigest: sha256Digest(sourceDraft), dslDraft }));
    const result = await (options.review || runAgentReview)(sourceDraft, dslDraft, {
      provider: options.provider, providerOptions: { env: options.env || process.env },
      checkpointSigningKey: options.checkpointSigningKey || options.env?.AGENT_REVIEW_CHECKPOINT_KEY,
      ...(item.checkpoint ? { resumeCheckpoint: item.checkpoint } : {}),
      onCheckpoint: async (checkpoint) => updateClaim(store, item.id, item.activeAttemptId, (current) => ({ ...current, checkpoint }))
    });
    const trust = result.ok ? checkTrust(sourceDraft, result.dsl) : null;
    const plan = result.ok && trust.ok ? buildDryRunPlan(result.dsl) : null;
    const ok = Boolean(result.ok && trust.ok && plan?.ok);
    return { status: ok ? "ready" : "blocked", sourceDraft, dslDraft,
      dsl: ok ? result.dsl : null, dslDigest: ok ? sha256Digest(result.dsl) : null, engineDigest: context.engineDigest,
      diagnostics: [...(result.report?.diagnostics || []), ...(trust?.diagnostics || []), ...(plan?.diagnostics || [])],
      report: { review: result.report, trust, plan } };
  });
}

export async function executeBatch(store, batchId, options = {}) {
  requireValue(options.confirmWrite === true, "Execution requires --confirm-write", "BATCH_APPROVAL_REQUIRED");
  requireValue(options.credentials?.username && options.credentials?.encryptedPassword, "NewOA credentials must be provided through environment variables");
  const initial = await store.get("batch", batchId);
  requireValue(initial?.approval, "Approve the prepared batch first", "BATCH_APPROVAL_REQUIRED");
  return runWorkers(store, batchId, "execute", options, async (item) => {
    const batch = await store.get("batch", batchId);
    requireValue(checkTrust(item.sourceDraft, item.dsl).ok && buildDryRunPlan(item.dsl).ok, "Prepared DSL is no longer valid", "BATCH_DSL_INVALID");
    const timeout = integer(options.requestTimeoutMs, 60000, 600000);
    const report = await (options.execute || executeDsl)(item.dsl, {
      ...item.executionOptions, confirmWrite: true, baseUrl: batch.baseUrl, targetCategoryId: batch.targetCategoryId,
      credentials: options.credentials,
      ...(options.clientFactory ? { client: await options.clientFactory({ itemId: item.id, baseUrl: batch.baseUrl }) } : {}),
      fetchImpl: (url, init = {}) => (options.fetchImpl || globalThis.fetch)(url, { ...init,
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) }),
      journal: executionJournal(store, item.id, item.activeAttemptId)
    });
    return { status: report.ok ? "succeeded" : "blocked", diagnostics: report.diagnostics || [],
      targetTemplateId: report.templateId || item.targetTemplateId, report };
  });
}

async function runWorkers(store, batchId, phase, options, perform) {
  const concurrency = integer(options.concurrency, 2);
  const leaseMs = integer(options.leaseMs, 300000, 3600000);
  requireValue(leaseMs >= 1000, "leaseMs must be at least 1000");
  const context = { engineDigest: options.engineDigest || engineDigest(), workerId: options.workerId || newId("worker"), leaseMs };
  await recoverBatch(store, batchId);
  await setBatchStatus(store, batchId, "running");
  let firstError;
  const worker = async () => {
    while (!firstError) {
      let item;
      try { item = await claimItem(store, batchId, phase, context); }
      catch (error) { firstError ||= error; return; }
      if (!item) return;
      if (item.rejected) continue;
      if (item.waiting) {
        await delay(100);
        await recoverBatch(store, batchId);
        continue;
      }
      let heartbeatError;
      const heartbeat = setInterval(() => {
        renewClaim(store, item.id, item.activeAttemptId, leaseMs).catch((error) => { heartbeatError ||= error; });
      }, Math.max(250, Math.floor(leaseMs / 3)));
      heartbeat.unref();
      let result;
      try { result = json(await perform(item, context)); }
      catch (error) { result = { status: "blocked", diagnostics: [safeFailure(error)], report: { ok: false, code: safeFailure(error).code } }; }
      finally { clearInterval(heartbeat); }
      if (heartbeatError) result.diagnostics = [...(result.diagnostics || []), {
        level: "warning", code: "batch.heartbeat_failed", message: "A heartbeat could not be saved; the actual operation result is retained." }];
      try { await finishClaim(store, item, result); }
      catch (error) {
        // A stale worker may retain observations, but cannot regain ownership or change task status.
        try {
          await store.mutate("item", item.id, (current) => {
            const attempt = current.attempts.find((entry) => entry.id === item.activeAttemptId);
            if (!attempt) return null;
            attempt.observations = [...(attempt.observations || []), { receivedAt: now(), result }];
            return current;
          });
        } catch { /* The earlier durable intent still fences remote effects while storage is unavailable. */ }
        firstError ||= error;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (firstError) throw firstError;
  return inspectBatch(store, batchId);
}

async function finishClaim(store, claimed, result) {
  return updateClaim(store, claimed.id, claimed.activeAttemptId, (item) => {
    const attempt = item.attempts.find((entry) => entry.id === claimed.activeAttemptId);
    attempt.completedAt = now();
    attempt.report = result.report;
    const uncertain = result.report?.writeOutcomeUnknown || attempt.steps.some((step) => step.outcome === "pending");
    const touched = item.writeStarted || result.report?.remoteWriteAttempted || Boolean(result.targetTemplateId);
    const status = uncertain ? "outcome_unknown" : result.status !== "succeeded" && touched ? "needs_repair" : result.status;
    attempt.status = status;
    const { report, ...fields } = result;
    return { ...item, ...fields, status, writeStarted: Boolean(touched), activeAttemptId: null, workerId: null, leaseUntil: null };
  });
}
