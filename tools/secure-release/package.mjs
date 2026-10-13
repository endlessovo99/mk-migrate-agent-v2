#!/usr/bin/env node
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildBundle } from "./bundle.mjs";
import { canonicalDirectory, command, inside, parseOptions, requireValue, sha256 } from "./common.mjs";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
export function packageRelease({ root, out }) {
  root = canonicalDirectory(resolve(root));
  out = resolve(out);
  requireValue(!inside(root, out), "Release output and private key must be outside the repository");
  canonicalDirectory(dirname(out));
  const git = (args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const status = git(["status", "--porcelain"]);
  const { bundle, bytes } = buildBundle(root, { commit: git(["rev-parse", "HEAD"]), workingTreeSnapshot: status === null || status.length > 0 });
  mkdirSync(out, { mode: 0o700 });
  for (const path of ["upload", "upload/launcher", "private", "local-tool"]) mkdirSync(join(out, path), { mode: 0o700 });
  let key;
  try {
    key = command("age-keygen", []);
    const recipient = command("age-keygen", ["-y"], { input: key, encoding: "utf8" }).trim();
    requireValue(/^age1[0-9a-z]+$/.test(recipient), "Unexpected age recipient");
    writeFileSync(join(out, "private/unlock.key"), key, { flag: "wx", mode: 0o600 });
    const encrypted = command("age", ["--encrypt", "--recipient", recipient], { input: bytes });
    const digest = sha256(encrypted);
    writeFileSync(join(out, "upload/engine.mkpkg.age"), encrypted, { flag: "wx", mode: 0o600 });
    writeFileSync(join(out, "upload/engine.mkpkg.age.sha256"), `${digest}  engine.mkpkg.age\n`, { flag: "wx", mode: 0o600 });
    const receipt = { releaseId: bundle.releaseId, sha256: digest, recipient, createdAt: bundle.createdAt, source: bundle.source };
    for (const name of ["server.mjs", "server-worker.mjs", "bundle.mjs", "common.mjs", "offline-common.mjs", "offline-server.mjs", "mk-migrate-secure"]) {
      copyFileSync(join(TOOL_DIR, name), join(out, "upload/launcher", name));
      chmodSync(join(out, "upload/launcher", name), name === "mk-migrate-secure" ? 0o700 : 0o600);
    }
    for (const name of ["unlock-local.mjs", "common.mjs", "offline-local.mjs", "offline-common.mjs"]) copyFileSync(join(TOOL_DIR, name), join(out, "local-tool", name));
    writeFileSync(join(out, "release.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { ...receipt, directory: out, uploadDirectory: join(out, "upload") };
  } finally {
    key?.fill(0);
    bytes.fill(0);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { options, rest } = parseOptions(process.argv.slice(2), ["root", "out"]);
    requireValue(options.out && rest.length === 0, "Usage: node package.mjs --out <new-absolute-directory> [--root <repository>]");
    console.log(JSON.stringify(packageRelease({ root: options.root || resolve(TOOL_DIR, "../.."), out: options.out }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
