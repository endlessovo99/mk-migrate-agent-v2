import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_ENCRYPTED_BYTES = 32 * 1024 * 1024;
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function requireValue(value, message) {
  if (!value) throw new Error(message);
}
export function parseOptions(argv, allowed) {
  const options = {};
  let rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") { rest = argv.slice(i + 1); break; }
    const key = argv[i].replace(/^--/, "");
    requireValue(argv[i].startsWith("--") && allowed.includes(key) && !(key in options), `Invalid or repeated option: ${argv[i]}`);
    requireValue(argv[i + 1] && !argv[i + 1].startsWith("--"), `Missing value: ${argv[i]}`);
    options[key] = argv[++i];
  }
  return { options, rest };
}
export function inside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
export function cleanNodeEnvironment(env = process.env) {
  const copy = { ...env };
  for (const name of ["NODE_OPTIONS", "NODE_COMPILE_CACHE", "NODE_V8_COVERAGE", "NODE_REPL_HISTORY"]) delete copy[name];
  copy.NODE_DISABLE_COMPILE_CACHE = "1";
  return copy;
}
export function command(program, args, options = {}) {
  const result = spawnSync(program, args, { maxBuffer: MAX_ENCRYPTED_BYTES, env: cleanNodeEnvironment(), ...options });
  requireValue(!result.error && result.status === 0, `${program} failed (${result.error?.code || result.status || result.signal || "unknown"})`);
  return result.stdout;
}
export function canonicalDirectory(path, { create = false } = {}) {
  requireValue(isAbsolute(path) && resolve(path) !== sep, "A non-root absolute directory is required");
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const resolved = resolve(path);
  requireValue(realpathSync(resolved) === resolved && lstatSync(resolved).isDirectory(), "Directory must not contain symbolic links");
  return resolved;
}
