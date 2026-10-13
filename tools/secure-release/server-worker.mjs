import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { decodeBundle, extractBundle } from "./bundle.mjs";
import { canonicalDirectory, command, inside, MAX_ENCRYPTED_BYTES, parseOptions, requireValue, sha256 } from "./common.mjs";
import { acceptOffline, prepareOffline } from "./offline-server.mjs";
import { HANDOFF_REQUEST, receiptProof } from "./offline-common.mjs";

export function serverOptions(argv) {
  const [action, ...args] = argv;
  requireValue(["unlock", "prepare-unlock", "unlock-ticket", "run", "lock", "status"].includes(action), "Usage: server.mjs <prepare-unlock|unlock-ticket|unlock|run|lock|status> [options] [-- CLI arguments]");
  const { options, rest } = parseOptions(args, ["runtime", "data", "config", "package", "sha256", "registry", "request-out", "ticket", "receipt-out"]);
  const config = {
    action, rest, runtime: options.runtime || "/run/mk-migrate/engine",
    data: options.data || "/var/lib/mk-migrate", config: options.config || "/etc/mk-migrate/newoa.env",
    package: options.package, sha256: options.sha256, registry: options.registry || "https://registry.npmmirror.com",
    requestOut: options["request-out"], ticket: options.ticket, receiptOut: options["receipt-out"]
  };
  for (const path of [config.runtime, config.data, config.config]) requireValue(isAbsolute(path) && resolve(path) === path && path !== "/", "Use normalized absolute server paths");
  requireValue(!inside(config.runtime, config.data) && !inside(config.data, config.runtime) && !inside(config.runtime, config.config), "Code, data and config must be separate");
  requireValue(action === "run" || rest.length === 0, "Only run accepts CLI arguments");
  if (["unlock", "prepare-unlock"].includes(action)) {
    requireValue(config.package && isAbsolute(config.package) && !inside(config.runtime, config.package), "Encrypted package must be outside the runtime directory");
    requireValue(/^[a-f0-9]{64}$/.test(config.sha256 || ""), "Expected encrypted package SHA-256 is required");
  }
  if (["unlock", "prepare-unlock", "unlock-ticket"].includes(action)) {
    const registry = new URL(config.registry);
    requireValue(registry.protocol === "https:" && !registry.username && !registry.password, "npm registry must use HTTPS without credentials");
  }
  return config;
}

export function mountState(runtime, { allowStacked = false } = {}) {
  const result = spawnSync("findmnt", ["--mountpoint", runtime, "--list", "--json", "--output", "ID,TARGET,SOURCE,FSTYPE,OPTIONS"], { encoding: "utf8" });
  if (result.status === 1) return null;
  requireValue(!result.error && result.status === 0, "Cannot inspect runtime mount");
  const mounts = JSON.parse(result.stdout).filesystems;
  const fd = openSync(runtime, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    // Bind mounts can hide another entry at the same path. The opened directory
    // identifies the mount actually reached in this process's mount namespace.
    const info = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
    const mountId = Number(info.match(/^mnt_id:[ \t]+([0-9]+)[ \t]*$/m)?.[1]);
    const mount = selectRuntimeMount(mounts, runtime, mountId);
    requireValue(allowStacked || mounts.length === 1, "Stacked runtime mounts: use the ordinary server terminal for unlock/lock operations");
    return mount;
  } finally { closeSync(fd); }
}

export function selectRuntimeMount(mounts, runtime, mountId) {
  requireValue(Array.isArray(mounts) && Number.isSafeInteger(mountId) && mountId > 0, "Cannot identify visible runtime mount");
  const matches = mounts.filter((mount) => Number(mount?.id) === mountId && mount.target === runtime);
  requireValue(matches.length === 1, "Cannot identify visible runtime mount");
  const mount = matches[0];
  requireValue(mount.fstype === "tmpfs" && mount.source === "mk-migrate-secure", "Refusing a mount not owned by this launcher");
  return mount;
}

async function readIdentity() {
  requireValue(!process.stdin.isTTY, "Pass the private key through stdin, not a terminal");
  const parts = [];
  let size = 0;
  for await (const part of process.stdin) {
    size += part.length;
    requireValue(size <= 16384, "Identity input is too large");
    parts.push(part);
  }
  const key = Buffer.concat(parts);
  for (const part of parts) part.fill(0);
  requireValue(key.length > 0, "Private key input is empty");
  return key;
}

async function unlock(config, handoff = {}) {
  const currentMount = mountState(config.runtime);
  requireValue(handoff.prepared ? Boolean(currentMount) : !currentMount, "Unexpected runtime mount state; inspect status before taking action");
  canonicalDirectory(config.runtime, { create: true });
  requireValue(readdirSync(config.runtime).length === 0, "Unmounted runtime directory must be empty");
  const packageStat = lstatSync(config.package);
  requireValue(packageStat.isFile() && packageStat.size <= MAX_ENCRYPTED_BYTES, "Invalid encrypted package");
  const encrypted = readFileSync(config.package);
  requireValue(sha256(encrypted) === config.sha256, "Encrypted package SHA-256 mismatch");
  const identity = handoff.identity || await readIdentity();
  let mounted = Boolean(handoff.prepared);
  try {
    if (!mounted) command("mount", ["-t", "tmpfs", "-o", "size=256m,mode=0700,nosuid,nodev,noexec", "mk-migrate-secure", config.runtime]);
    mounted = true;
    requireValue(mountState(config.runtime), "Runtime tmpfs verification failed");
    // Decrypt exactly the bytes whose digest was checked, even if the upload is replaced.
    const ciphertextPath = join(config.runtime, ".ciphertext.age");
    writeFileSync(ciphertextPath, encrypted, { flag: "wx", mode: 0o600 });
    let compressed;
    let bundle;
    try {
      compressed = command("age", ["--decrypt", "--identity", "-", ciphertextPath], { input: identity });
      bundle = decodeBundle(compressed);
    } finally { identity.fill(0); compressed?.fill(0); }
    unlinkSync(ciphertextPath);
    // An authenticated package is fully validated before any file is extracted.
    extractBundle(bundle, config.runtime);
    command("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", config.registry], {
      cwd: config.runtime, stdio: ["ignore", 2, 2]
    });
    // Capture syntax diagnostics so a failing import cannot copy code into logs.
    command(process.execPath, ["--input-type=module", "-e", "await import(process.argv[1])", pathToFileURL(join(config.runtime, "src/cli/main.js")).href]);
    const receipt = { status: "unlocked", releaseId: bundle.releaseId, sha256: config.sha256, source: bundle.source, runtime: config.runtime };
    if (handoff.requestId) {
      receipt.requestId = handoff.requestId;
      receipt.proof = receiptProof(receipt, handoff.receiptSecret);
    }
    writeFileSync(join(config.runtime, ".release-ready.json"), `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx" });
    command("mount", ["-o", "remount,ro", config.runtime]);
    requireValue(mountState(config.runtime)?.options.split(",").includes("ro"), "Runtime must be read-only before use");
    return receipt;
  } catch (error) {
    if (mounted) {
      try { command("umount", [config.runtime]); }
      catch { throw new Error("Unlock failed and tmpfs cleanup failed; inspect status and lock it before continuing"); }
    }
    throw error;
  } finally { identity.fill(0); }
}

function status(config) {
  const mount = mountState(config.runtime, { allowStacked: true });
  if (!mount) return { status: "locked", runtime: config.runtime };
  if (existsSync(join(config.runtime, HANDOFF_REQUEST))) {
    const request = JSON.parse(readFileSync(join(config.runtime, HANDOFF_REQUEST), "utf8"));
    return { status: request.expiresAt > Date.now() ? "awaiting-ticket" : "expired-ticket", requestId: request.requestId, expiresAt: new Date(request.expiresAt).toISOString(), runtime: config.runtime };
  }
  if (!mount.options.split(",").includes("ro") || !existsSync(join(config.runtime, ".release-ready.json"))) return { status: "incomplete", runtime: config.runtime };
  return JSON.parse(readFileSync(join(config.runtime, ".release-ready.json"), "utf8"));
}

async function run(config) {
  requireValue(status(config).status === "unlocked", "Project is locked or incomplete; unlock it first");
  requireValue(config.rest.length > 0, "Supply the existing CLI command after --");
  canonicalDirectory(config.data, { create: true });
  for (const name of ["input", "dsl", "reports"]) canonicalDirectory(join(config.data, name), { create: true });
  if (existsSync(config.config)) {
    const info = lstatSync(config.config);
    requireValue(info.isFile() && info.uid === 0 && (info.mode & 0o077) === 0, "Config must be a root-owned regular file with mode 600");
  }
  process.chdir(config.data);
  const { startCli } = await import(pathToFileURL(join(config.runtime, "src/cli/main.js")).href);
  await startCli(config.rest, { defaultEnvFile: config.config });
}

export async function serverAction(config) {
  requireValue(process.platform === "linux" && process.getuid?.() === 0, "Server commands require Linux root");
  if (config.action === "unlock") return unlock(config);
  if (config.action === "prepare-unlock") return prepareOffline(config, { mountState });
  if (config.action === "unlock-ticket") return acceptOffline(config, { mountState, unlock });
  if (config.action === "status") return status(config);
  if (config.action === "run") return run(config);
  if (mountState(config.runtime)) command("umount", [config.runtime]);
  return { status: "locked", runtime: config.runtime };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await serverAction(serverOptions(process.argv.slice(2)));
    if (result) console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
