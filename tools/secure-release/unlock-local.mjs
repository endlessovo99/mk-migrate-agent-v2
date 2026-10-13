#!/usr/bin/env node
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { command, parseOptions, requireValue, sha256 } from "./common.mjs";

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
export function unlockRelease(options) {
  requireValue(options.release && /^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(options.host || ""), "Provide --release and a configured SSH --host");
  requireValue(options["remote-package"]?.startsWith("/"), "Provide an absolute --remote-package");
  const release = resolve(options.release);
  const receiptPath = join(release, "unlock-receipt.json");
  requireValue(!existsSync(receiptPath), "This release has an unlock receipt; inspect it instead of unlocking again");
  const metadata = JSON.parse(readFileSync(join(release, "release.json"), "utf8"));
  requireValue(/^[a-f0-9]{64}$/.test(metadata.sha256) && typeof metadata.releaseId === "string", "Invalid local release metadata");
  const keyPath = join(release, "private/unlock.key");
  const fd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let identity;
  try {
    const info = fstatSync(fd);
    requireValue(info.isFile() && info.size <= 16384 && (info.mode & 0o077) === 0, "Local private key must be a private regular file (mode 600)");
    identity = readFileSync(fd);
  } finally { closeSync(fd); }
  try {
    const remote = ["env", "-u", "NODE_OPTIONS", "-u", "NODE_COMPILE_CACHE", "-u", "NODE_V8_COVERAGE", "NODE_DISABLE_COMPILE_CACHE=1", "node", options["remote-launcher"] || "/opt/mk-migrate/launcher/server.mjs", "unlock", "--package", options["remote-package"], "--sha256", metadata.sha256];
    for (const name of ["runtime", "data", "config", "registry"]) if (options[name]) remote.push(`--${name}`, options[name]);
    let receipt;
    try {
      const output = command("ssh", ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", options.host, remote.map(shellQuote).join(" ")], {
        input: identity, encoding: "utf8", maxBuffer: 65536, stdio: ["pipe", "pipe", "inherit"]
      });
      receipt = JSON.parse(output);
    } catch {
      throw new Error("Unlock did not return a verified receipt. Key retained locally. Check server status; do not assume it stayed locked.");
    }
    requireValue(receipt.status === "unlocked" && receipt.sha256 === metadata.sha256 && receipt.releaseId === metadata.releaseId, "Unlock receipt mismatch; key retained locally");
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    requireValue(sha256(readFileSync(keyPath)) === sha256(identity), "Private key changed; receipt saved but key was not removed");
    unlinkSync(keyPath);
    return { ...receipt, localKeyRemoved: true };
  } finally { identity.fill(0); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { options, rest } = parseOptions(process.argv.slice(2), ["release", "host", "remote-package", "remote-launcher", "runtime", "data", "config", "registry"]);
    requireValue(rest.length === 0, "Unexpected positional arguments");
    console.log(JSON.stringify(unlockRelease(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
