#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { command, parseOptions, requireValue, sha256 } from "./common.mjs";
import { readPrivateIdentity, TICKET_FORMAT, validateRequest, verifyReceiptProof } from "./offline-common.mjs";

export function authorizeOffline(options) {
  const release = resolve(options.release);
  requireValue(!existsSync(join(release, "unlock-receipt.json")), "Release already has a successful unlock receipt");
  requireValue(/^[a-f0-9]{64}$/.test(options["request-sha256"] || ""), "Copy --request-sha256 from the trusted bastion terminal");
  requireValue(lstatSync(options.request).isFile() && lstatSync(options.request).size <= 16384, "Invalid request file");
  const requestBytes = readFileSync(options.request);
  requireValue(sha256(requestBytes) === options["request-sha256"], "Request fingerprint mismatch; no authorization created");
  const request = validateRequest(JSON.parse(requestBytes.toString("utf8")));
  const metadata = JSON.parse(readFileSync(join(release, "release.json"), "utf8"));
  requireValue(request.sha256 === metadata.sha256, "Request targets a different release");
  const statePath = join(release, "private", `offline-${request.requestId}.json`);
  const output = join(release, "upload", `unlock-ticket-${request.requestId}.age`);
  requireValue(!existsSync(statePath) && !existsSync(output), "Authorization already exists; do not create another ticket for this session");
  const identity = readPrivateIdentity(join(release, "private/unlock.key"));
  const receiptSecret = randomBytes(32).toString("hex");
  let plaintext;
  try {
    plaintext = Buffer.from(JSON.stringify({ format: TICKET_FORMAT, requestId: request.requestId, sha256: metadata.sha256, expiresAt: request.expiresAt, identity: identity.toString("utf8"), receiptSecret }));
    const encrypted = command("age", ["--encrypt", "--recipient", request.recipient], { input: plaintext });
    writeFileSync(statePath, `${JSON.stringify({ requestId: request.requestId, releaseId: metadata.releaseId, sha256: metadata.sha256, runtime: request.runtime, identitySha256: sha256(identity), receiptSecret })}\n`, { flag: "wx", mode: 0o600 });
    writeFileSync(output, encrypted, { flag: "wx", mode: 0o600 });
    return { status: "authorized", ticketFile: output, requestId: request.requestId, expiresAt: new Date(request.expiresAt).toISOString(), localKeyRetained: true };
  } finally { identity.fill(0); plaintext?.fill(0); }
}

export function completeOffline(options) {
  const release = resolve(options.release);
  requireValue(!existsSync(join(release, "unlock-receipt.json")), "Release already completed; do not repeat completion");
  requireValue(lstatSync(options.receipt).isFile() && lstatSync(options.receipt).size <= 16384, "Invalid receipt file");
  const receipt = JSON.parse(readFileSync(options.receipt, "utf8"));
  requireValue(/^[a-f0-9]{32}$/.test(receipt.requestId || ""), "Invalid receipt request ID");
  const statePath = join(release, "private", `offline-${receipt.requestId}.json`);
  const stateBytes = readPrivateIdentity(statePath);
  let state;
  try { state = JSON.parse(stateBytes.toString("utf8")); } finally { stateBytes.fill(0); }
  const metadata = JSON.parse(readFileSync(join(release, "release.json"), "utf8"));
  requireValue(receipt.status === "unlocked" && receipt.releaseId === metadata.releaseId && receipt.sha256 === metadata.sha256 && receipt.runtime === state.runtime && receipt.requestId === state.requestId, "Offline receipt mismatch; private key retained");
  verifyReceiptProof(receipt, state.receiptSecret);
  const currentIdentity = readPrivateIdentity(join(release, "private/unlock.key"));
  try { requireValue(sha256(currentIdentity) === state.identitySha256, "Private key changed since authorization; it was not removed"); }
  finally { currentIdentity.fill(0); }
  writeFileSync(join(release, "unlock-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  unlinkSync(join(release, "private/unlock.key"));
  unlinkSync(statePath);
  return { ...receipt, localKeyRemoved: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2);
    const { options, rest } = parseOptions(args, ["release", "request", "request-sha256", "receipt"]);
    requireValue(options.release && rest.length === 0 && ["authorize", "complete"].includes(action), "Usage: offline-local.mjs <authorize|complete> --release <directory> [request/receipt options]");
    console.log(JSON.stringify(action === "authorize" ? authorizeOffline(options) : completeOffline(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
