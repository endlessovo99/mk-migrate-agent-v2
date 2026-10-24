import { sha256Digest } from "../agent-review/digest.js";
import { requireValue } from "./contracts.js";

// This bounded evidence contract covers authentication and exact native
// subprocess metadata reads. It never authorizes a retry or a remote write.
const readPaths = { login: "/data/sys-auth/login", getWorkflowTemplateDetail: "/data/sys-lbpm/lbpmTemplate/details", getWorkflowSubProcessParams: "/data/sys-lbpm/params/find" };
const digest = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const empty = value => Array.isArray(value) && value.length === 0;
const absentOrFalse = value => value === undefined || value === false;
const absentOrEmpty = value => value === undefined || empty(value);
const onlyKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const requireProof = (condition, message) => requireValue(condition, message, "BATCH_PREWRITE_DISPOSITION_INVALID");

/** Produce a deterministic, immutable-evidence binding for an unsuccessful item. */
export function createPrewriteBlockedDisposition({ item, batch, expected, callsByAttempt }) {
  requireProof(item && batch && expected, "Complete item, batch and expected scope are required");
  const binding = { itemId: item.id, batchId: item.batchId, sourceId: item.sourceId, baseUrl: batch.baseUrl,
    targetCategoryId: batch.targetCategoryId, migrationKey: batch.migrationKey, revision: expected.revision,
    sourceDigest: item.sourceDigest, sourceDraftDigest: item.sourceDraftDigest, dslDigest: item.dslDigest,
    engineDigest: item.engineDigest, identityKey: item.identityKey };
  for (const key of ["itemId", "batchId", "sourceId", "baseUrl", "targetCategoryId", "migrationKey", "sourceDigest", "sourceDraftDigest", "dslDigest", "engineDigest"]) {
    requireProof(typeof binding[key] === "string" && binding[key] && binding[key] === expected[key], `Original ${key} must match`);
  }
  requireProof(typeof binding.revision === "string" && /^r\d{3}$/.test(binding.revision), "Explicit original revision is required");
  requireProof(item.batchId === batch.id && item.baseUrl === batch.baseUrl && batch.status === "paused", "Original batch must be paused");
  requireProof(item.identityKey === sha256Digest({ baseUrl: batch.baseUrl, targetCategoryId: batch.targetCategoryId,
    sourceId: item.sourceId, migrationKey: batch.migrationKey }), "Original identity key must match");
  requireProof(digest(item.engineDigest) && item.snapshot && item.sourceDraft && item.dsl && sha256Digest({ snapshot: item.snapshot, templateName: item.templateName }) === item.sourceDigest &&
    sha256Digest(item.sourceDraft) === item.sourceDraftDigest && sha256Digest(item.dsl) === item.dslDigest, "Artifacts must match their retained digests");
  requireProof(item.status === "blocked" && item.writeStarted === false && item.targetTemplateId === null &&
    item.activeAttemptId === null && item.workerId === null && item.leaseUntil === null && absentOrFalse(item.remoteWriteAttempted) && absentOrFalse(item.writeOutcomeUnknown) &&
    absentOrEmpty(item.createdFdIds) && absentOrEmpty(item.updatedFdIds),
  "Item must be terminal, blocked and untouched");
  requireProof(Array.isArray(item.attempts) && item.attempts.length > 0, "Complete attempt history is required");
  requireProof(new Set(item.attempts.map(attempt => attempt.id)).size === item.attempts.length &&
    item.attempts.every(attempt => typeof attempt.id === "string" && attempt.id), "Attempt identities must be complete and unique");
  const executionAttempts = item.attempts.filter(attempt => attempt.phase === "execute");
  requireProof(executionAttempts.length > 0 && callsByAttempt && typeof callsByAttempt === "object" &&
    !Array.isArray(callsByAttempt) && Object.keys(callsByAttempt).length === executionAttempts.length,
  "Every execution attempt needs its complete read-only call evidence");
  for (const attempt of item.attempts) {
    requireProof(["prepare", "execute"].includes(attempt.phase) && ["blocked", "ready"].includes(attempt.status) &&
      empty(attempt.steps) && absentOrEmpty(attempt.observations) && absentOrFalse(attempt.remoteWriteAttempted) && absentOrFalse(attempt.writeOutcomeUnknown) &&
      !attempt.targetTemplateId && absentOrEmpty(attempt.createdFdIds) && absentOrEmpty(attempt.updatedFdIds),
    "Every historical attempt must be terminal with no write intent or observation");
    if (attempt.phase !== "execute") {
      requireProof(attempt.report && typeof attempt.report === "object" && !Array.isArray(attempt.report) &&
        absentOrFalse(attempt.report.remoteWriteAttempted) && absentOrFalse(attempt.report.writeOutcomeUnknown) &&
        absentOrEmpty(attempt.report.createdFdIds) && absentOrEmpty(attempt.report.updatedFdIds) &&
        !["templateId", "targetTemplateId", "readback", "transferRecord", "apiStages", "writeOutcomeUnknownStage"].some(key => Object.hasOwn(attempt.report, key)),
      "Preparation history must contain no remote effect");
      continue;
    }
    const report = attempt.report;
    requireProof(attempt.status === "blocked" && report?.ok === false && report.status === "blocked" && report.baseUrl === batch.baseUrl &&
      report.remoteWriteAttempted === false && report.writeOutcomeUnknown === false && empty(report.createdFdIds) && empty(report.updatedFdIds) &&
      !report.templateId && !report.readback && !report.transferRecord && !report.writeOutcomeUnknownStage && report.failedAt && report.stage === report.failedAt &&
      Array.isArray(report.apiStages),
    "Every execution report must explicitly prove a completed prewrite failure");
    verifyReadCalls(callsByAttempt[attempt.id], batch.baseUrl, report, attempt.dsl);
  }
  const last = executionAttempts.at(-1);
  requireProof(last === item.attempts.at(-1) && last.dsl && last.sourceDraft && sha256Digest(last.dsl) === item.dslDigest && sha256Digest(last.sourceDraft) === item.sourceDraftDigest,
    "Latest execution must bind the unchanged current source and DSL");
  return { version: 1, kind: "prewrite_blocked", status: "blocked", binding,
    migrationSucceeded: false, reviewCompleted: false, allIssuesResolved: false, continueIndependentItems: true,
    itemDigest: sha256Digest(item), batchDigest: sha256Digest(batch), callsDigest: sha256Digest(callsByAttempt),
    executionAttempts: executionAttempts.map(attempt => ({ id: attempt.id, reportDigest: sha256Digest(attempt.report), failedAt: attempt.report.failedAt })) };
}

export function verifyPrewriteBlockedDisposition(disposition, evidence) {
  requireProof(sha256Digest(disposition) === sha256Digest(createPrewriteBlockedDisposition(evidence)), "Disposition or retained evidence changed");
  return true;
}

function verifyReadCalls(calls, baseUrl, report, dsl) {
  const stages = report.apiStages;
  requireProof(stages.length === 2 && stages[0]?.name === "login" && stages[0].status === "ok" && !Object.hasOwn(stages[0], "dependencies") &&
    stages[1]?.name === "verifyWorkflowSubProcessDependencies" && stages[1].status === "failed" && report.failedAt === stages[1].name &&
    stages.every(stage => onlyKeys(stage, ["name", "status", "dependencies", "remoteWriteAttempted", "writeOutcomeUnknown", "createdFdIds", "updatedFdIds"]) &&
      absentOrFalse(stage.remoteWriteAttempted) && absentOrFalse(stage.writeOutcomeUnknown) &&
      absentOrEmpty(stage.createdFdIds) && absentOrEmpty(stage.updatedFdIds) &&
      !["templateId", "targetTemplateId", "readback", "transferRecord", "writeOutcomeUnknownStage"].some(key => Object.hasOwn(stage, key))),
  "Only the evidenced read preflight sequence ending at its failed stage is eligible");
  const references = new Map();
  for (const node of dsl?.workflow?.nodes || []) if (node.type === "startSubProcess") {
    const id = node.subProcess?.templateId;
    if (!references.has(id)) references.set(id, []);
    references.get(id).push(node.id);
  }
  const dependencies = stages[1].dependencies, expectedCalls = [{ name: "login", status: "ok" }];
  requireProof(references.size > 0 && Array.isArray(dependencies) && dependencies.length === references.size &&
    dependencies.some(dependency => dependency.status === "failed"), "Complete DSL-bound dependency evidence is required");
  for (const [index, [templateId, nodeIds]] of [...references].entries()) {
    const dependency = dependencies[index];
    requireProof(onlyKeys(dependency, ["templateId", "nodeIds", "status", "reads", "definitionId"]) && typeof templateId === "string" && templateId &&
      dependency.templateId === templateId && Array.isArray(dependency.nodeIds) && sha256Digest(dependency.nodeIds) === sha256Digest(nodeIds) &&
      ["ok", "failed"].includes(dependency.status) && Array.isArray(dependency.reads) && dependency.reads.length >= 1 && dependency.reads.length <= 2,
    "Every dependency read must bind the exact DSL reference");
    for (const [readIndex, read] of dependency.reads.entries()) {
      const name = ["getWorkflowTemplateDetail", "getWorkflowSubProcessParams"][readIndex];
      requireProof(onlyKeys(read, ["name", "status", "readStage", "transportFailure", "reason", "httpStatus", "upstreamCodes"]) && read.name === name &&
        ["ok", "failed"].includes(read.status) && (read.status === "ok" ? onlyKeys(read, ["name", "status"])
          : readIndex === dependency.reads.length - 1 && read.readStage === name && typeof read.transportFailure === "boolean" &&
            read.transportFailure === (read.reason === "transport_failure") && ["invalid_response", "authentication_failed", "authorization_failed", "no_record", "transport_failure", "native_api_failed"].includes(read.reason)) &&
        (read.httpStatus === undefined || Number.isInteger(read.httpStatus) && read.httpStatus >= 100 && read.httpStatus <= 599) &&
        (read.upstreamCodes === undefined || Array.isArray(read.upstreamCodes) && read.upstreamCodes.every(code => ["errors.noRecord", "error.params"].includes(code))),
      "Native read receipts must be complete and ordered");
      expectedCalls.push({ ...read, templateId });
    }
    requireProof(dependency.status !== "ok" || dependency.reads.length === 2 && dependency.reads.every(read => read.status === "ok"),
      "Successful dependency metadata must include both completed reads");
  }
  requireProof(Array.isArray(calls) && calls.length === expectedCalls.length * 2, "Every reported native read needs exactly one request/receipt pair");
  for (let index = 0; index < calls.length; index += 2) {
    const request = calls[index], receipt = calls[index + 1], read = expectedCalls[index / 2];
    requireProof(request?.event === "request" && request.id === index / 2 + 1 && request.origin === baseUrl && request.method === "POST" &&
      request.path === readPaths[read.name] && request.templateId === read.templateId && receipt?.id === request.id && (receipt.event === "response" && Number.isInteger(receipt.status) &&
        receipt.status >= 100 && receipt.status <= 599 || receipt.event === "error" && receipt.code === "REQUEST_FAILED"),
    "Only complete, ordered receipts for evidenced native read endpoints are eligible");
    requireProof(read.status === "ok" ? receipt.event === "response" && receipt.status >= 200 && receipt.status < 300
      : read.transportFailure ? receipt.event === "error"
        : receipt.event === "response" && (read.httpStatus === undefined || receipt.status === read.httpStatus),
    "Native call outcomes must match the reported read result");
  }
}
