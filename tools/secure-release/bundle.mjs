import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { MAX_BUNDLE_BYTES, requireValue, sha256 } from "./common.mjs";

const FORMAT = "mk-migrate-release-v1";
const REQUIRED = ["package.json", "package-lock.json", "src/cli/main.js", "src/default-environment.js"];
export function validBundlePath(path) {
  return typeof path === "string" && path.length < 240 &&
    /^(?:package(?:-lock)?\.json|(?:src|catalogs)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:js|json|sql))$/.test(path);
}
export function buildBundle(root, source = {}) {
  const files = [];
  let total = 0;
  function collect(path) {
    const full = join(root, path);
    const stat = lstatSync(full);
    requireValue(!stat.isSymbolicLink(), `Source symlink is not allowed: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(full).sort()) collect(`${path}/${name}`);
      return;
    }
    requireValue(stat.isFile() && validBundlePath(path), `Unexpected runtime file: ${path}`);
    total += stat.size;
    requireValue(total <= MAX_BUNDLE_BYTES / 2, "Runtime payload is too large");
    const bytes = readFileSync(full);
    files.push({ path, sha256: sha256(bytes), content: bytes.toString("base64") });
  }
  for (const path of ["src", "catalogs", "package.json", "package-lock.json"]) collect(path);
  const bundle = { format: FORMAT, releaseId: randomUUID(), createdAt: new Date().toISOString(), source, files };
  validateBundle(bundle);
  const serialized = Buffer.from(JSON.stringify(bundle));
  requireValue(serialized.length <= MAX_BUNDLE_BYTES, "Serialized runtime is too large");
  return { bundle, bytes: gzipSync(serialized) };
}
export function validateBundle(bundle) {
  requireValue(bundle?.format === FORMAT && /^[a-f0-9-]{36}$/.test(bundle.releaseId), "Invalid release format");
  requireValue(Array.isArray(bundle.files) && bundle.files.length > 0 && bundle.files.length <= 2000, "Invalid file list");
  const paths = new Set();
  let total = 0;
  for (const file of bundle.files) {
    requireValue(validBundlePath(file.path) && !paths.has(file.path), "Unsafe or duplicate release path");
    requireValue(typeof file.content === "string" && /^[a-f0-9]{64}$/.test(file.sha256), "Invalid file entry");
    const bytes = Buffer.from(file.content, "base64");
    total += bytes.length;
    requireValue(total <= MAX_BUNDLE_BYTES / 2 && bytes.toString("base64") === file.content && sha256(bytes) === file.sha256, "Release file integrity check failed");
    paths.add(file.path);
  }
  requireValue(REQUIRED.every((path) => paths.has(path)) && [...paths].some((path) => path.startsWith("catalogs/")), "Missing runtime files");
  for (const path of paths) {
    for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) requireValue(!paths.has(parent), "File/directory collision");
  }
  return bundle;
}
export function decodeBundle(bytes) {
  return validateBundle(JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_BUNDLE_BYTES }).toString("utf8")));
}
export function extractBundle(bundle, destination) {
  validateBundle(bundle);
  // The caller must first create an empty, private tmpfs destination.
  requireValue(readdirSync(destination).length === 0, "Extraction destination must be empty");
  for (const file of bundle.files) {
    const path = join(destination, file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, Buffer.from(file.content, "base64"), { flag: "wx", mode: 0o600 });
  }
}
