import { createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { requireValue } from "./common.mjs";

export const REQUEST_FORMAT = "mk-migrate-offline-request-v1";
export const TICKET_FORMAT = "mk-migrate-offline-ticket-v1";
export const HANDOFF_REQUEST = ".offline-request.json";
export const HANDOFF_KEY = ".offline-transport.key";
export function readPrivateIdentity(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireValue(stat.isFile() && stat.size <= 16384 && (stat.mode & 0o077) === 0, "Private identity must be a regular file with mode 600");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
export function validateRequest(request) {
  requireValue(request?.format === REQUEST_FORMAT && /^[a-f0-9]{32}$/.test(request.requestId || ""), "Invalid offline request");
  requireValue(/^[a-f0-9]{64}$/.test(request.sha256 || "") && /^age1[0-9a-z]+$/.test(request.recipient || ""), "Invalid request digest or recipient");
  requireValue(Number.isSafeInteger(request.expiresAt) && request.expiresAt > Date.now(), "Offline request expired; prepare a new session");
  return request;
}
export function receiptProof(receipt, secret) {
  requireValue(/^[a-f0-9]{64}$/.test(secret || ""), "Invalid receipt authentication key");
  const fields = [receipt.status, receipt.releaseId, receipt.sha256, receipt.runtime, receipt.requestId];
  requireValue(fields.every((value) => typeof value === "string"), "Invalid offline receipt");
  return createHmac("sha256", Buffer.from(secret, "hex")).update(JSON.stringify(fields)).digest("hex");
}
export function verifyReceiptProof(receipt, secret) {
  requireValue(/^[a-f0-9]{64}$/.test(receipt.proof || ""), "Missing offline receipt proof");
  requireValue(timingSafeEqual(Buffer.from(receiptProof(receipt, secret), "hex"), Buffer.from(receipt.proof, "hex")), "Offline receipt proof mismatch; private key retained");
}
