import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalDirectory, command, inside, MAX_ENCRYPTED_BYTES, requireValue, sha256 } from "./common.mjs";
import { HANDOFF_KEY, HANDOFF_REQUEST, REQUEST_FORMAT, TICKET_FORMAT, validateRequest } from "./offline-common.mjs";

function newOutput(path, runtime) {
  requireValue(typeof path === "string" && isAbsolute(path) && resolve(path) === path && !inside(runtime, path), "Public output must be an absolute path outside tmpfs");
  canonicalDirectory(dirname(path));
  requireValue(!existsSync(path), "Output already exists; use a new filename");
}

export function prepareOffline(config, { mountState }) {
  newOutput(config.requestOut, config.runtime);
  requireValue(!mountState(config.runtime), "Runtime already mounted; check status and lock before preparing a new session");
  canonicalDirectory(config.runtime, { create: true });
  requireValue(readdirSync(config.runtime).length === 0, "Unmounted runtime directory must be empty");
  const info = lstatSync(config.package);
  requireValue(info.isFile() && info.size <= MAX_ENCRYPTED_BYTES && sha256(readFileSync(config.package)) === config.sha256, "Encrypted package SHA-256 mismatch");
  let mounted = false;
  let identity;
  try {
    command("mount", ["-t", "tmpfs", "-o", "size=256m,mode=0700,nosuid,nodev,noexec", "mk-migrate-secure", config.runtime]);
    mounted = true;
    requireValue(mountState(config.runtime), "Runtime tmpfs verification failed");
    identity = command("age-keygen", []);
    const recipient = command("age-keygen", ["-y"], { input: identity, encoding: "utf8" }).trim();
    const request = validateRequest({ format: REQUEST_FORMAT, requestId: randomBytes(16).toString("hex"), sha256: config.sha256, recipient, expiresAt: Date.now() + 30 * 60 * 1000, package: config.package, runtime: config.runtime });
    const bytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`);
    writeFileSync(join(config.runtime, HANDOFF_KEY), identity, { flag: "wx", mode: 0o600 });
    writeFileSync(join(config.runtime, HANDOFF_REQUEST), bytes, { flag: "wx", mode: 0o600 });
    command("mount", ["-o", "remount,ro", config.runtime]);
    requireValue(mountState(config.runtime)?.options.split(",").includes("ro"), "Pending session must be read-only");
    writeFileSync(config.requestOut, bytes, { flag: "wx", mode: 0o600 });
    return { status: "awaiting-ticket", requestId: request.requestId, requestFile: config.requestOut, requestSha256: sha256(bytes), expiresAt: new Date(request.expiresAt).toISOString() };
  } catch (error) {
    if (mounted) {
      try { command("umount", [config.runtime]); }
      catch { throw new Error("Preparation failed and tmpfs cleanup failed; inspect status and lock before continuing"); }
    }
    throw error;
  } finally { identity?.fill(0); }
}

export async function acceptOffline(config, { mountState, unlock }) {
  newOutput(config.receiptOut, config.runtime);
  requireValue(mountState(config.runtime) && existsSync(join(config.runtime, HANDOFF_REQUEST)), "No pending offline session; prepare one first");
  let activated = false;
  let plaintext;
  let projectIdentity;
  try {
    const request = validateRequest(JSON.parse(readFileSync(join(config.runtime, HANDOFF_REQUEST), "utf8")));
    requireValue(request.runtime === config.runtime, "Offline request runtime mismatch");
    requireValue(typeof config.ticket === "string" && isAbsolute(config.ticket) && !inside(config.runtime, config.ticket), "Ticket must be outside the runtime directory");
    const stat = lstatSync(config.ticket);
    requireValue(stat.isFile() && stat.size <= 32768, "Invalid offline ticket file");
    plaintext = command("age", ["--decrypt", "--identity", join(config.runtime, HANDOFF_KEY)], { input: readFileSync(config.ticket), maxBuffer: 32768 });
    const ticket = JSON.parse(plaintext.toString("utf8"));
    requireValue(ticket.format === TICKET_FORMAT && ticket.requestId === request.requestId && ticket.sha256 === request.sha256 && ticket.expiresAt === request.expiresAt, "Offline ticket does not match this session");
    requireValue(typeof ticket.identity === "string" && ticket.identity.length <= 16384 && /^[a-f0-9]{64}$/.test(ticket.receiptSecret || ""), "Invalid offline authorization");
    projectIdentity = Buffer.from(ticket.identity);
    command("mount", ["-o", "remount,rw", config.runtime]);
    unlinkSync(join(config.runtime, HANDOFF_KEY));
    unlinkSync(join(config.runtime, HANDOFF_REQUEST));
    const receipt = await unlock({ ...config, package: request.package, sha256: request.sha256 }, {
      identity: projectIdentity, prepared: true, requestId: request.requestId, receiptSecret: ticket.receiptSecret
    });
    activated = true;
    writeFileSync(config.receiptOut, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return receipt;
  } finally {
    plaintext?.fill(0);
    projectIdentity?.fill(0);
    if (!activated && mountState(config.runtime)) command("umount", [config.runtime]);
  }
}
