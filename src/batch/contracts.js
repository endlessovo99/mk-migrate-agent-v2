import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sha256Digest } from "../agent-review/digest.js";

export const now = () => new Date().toISOString();
export const newId = (prefix) => `${prefix}-${randomUUID()}`;
export const json = (value) => JSON.parse(JSON.stringify(value));
export function requireValue(condition, message, code = "BATCH_INVALID_ARGUMENT") {
  if (!condition) throw Object.assign(new Error(message), { code });
}
export function exactKeys(value, keys, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  requireValue(Object.keys(value).every((key) => keys.includes(key)), `${label} contains unsupported properties`);
}
export function text(value, label) {
  requireValue(typeof value === "string" && value.trim().length > 0, `${label} is required`);
  return value.trim();
}
export function integer(value, fallback, max = 32) {
  const parsed = value === undefined ? fallback : Number(value);
  requireValue(Number.isInteger(parsed) && parsed > 0 && parsed <= max, `Expected an integer from 1 to ${max}`);
  return parsed;
}

const mappingKeys = {
  participantOverrides: "sourceId",
  templateAuthorizationOverrides: "sourceId",
  directParticipantOverrides: "sourceTargetId"
};
export function executionOptions(value = {}) {
  exactKeys(value, [...Object.keys(mappingKeys), "fallbackFdIds", "allowTemplateAuthorizationFallback",
    "allowMissingDirectPersonFallback", "allowMissingDirectPostFallback", "directPersonFallbackIds"], "executionOptions");
  for (const [key, sourceKey] of Object.entries(mappingKeys)) {
    if (!(key in value)) continue;
    requireValue(Array.isArray(value[key]), `${key} must be an array`);
    const seen = new Set();
    for (const mapping of value[key]) {
      exactKeys(mapping, [sourceKey, "targetFdId"], key);
      const id = text(mapping[sourceKey], sourceKey);
      text(mapping.targetFdId, "targetFdId");
      requireValue(!seen.has(id), `${key} contains a duplicate source identity`);
      seen.add(id);
    }
  }
  for (const key of ["allowTemplateAuthorizationFallback", "allowMissingDirectPersonFallback", "allowMissingDirectPostFallback"]) {
    if (key in value) requireValue(typeof value[key] === "boolean", `${key} must be boolean`);
  }
  if ("fallbackFdIds" in value) {
    exactKeys(value.fallbackFdIds, ["person", "organization", "group", "post", "role"], "fallbackFdIds");
    for (const id of Object.values(value.fallbackFdIds)) text(id, "fallback fdId");
  }
  if ("directPersonFallbackIds" in value) {
    requireValue(Array.isArray(value.directPersonFallbackIds), "directPersonFallbackIds must be an array");
    value.directPersonFallbackIds.forEach((id) => text(id, "direct person fdId"));
  }
  return json(value);
}

/** Hash the executable sources and contracts, including uncommitted changes. */
export function engineDigest() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const files = [];
  function visit(relative) {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push([path, sha256Digest(readFileSync(join(root, path), "utf8"))]);
    }
  }
  visit("src");
  visit("catalogs");
  files.push(["package-lock.json", sha256Digest(readFileSync(join(root, "package-lock.json"), "utf8"))]);
  return sha256Digest(files);
}

export function itemBinding(item) {
  return { id: item.id, sourceDigest: item.sourceDigest, dslDigest: item.dslDigest,
    sourceDraftDigest: item.sourceDraftDigest, engineDigest: item.engineDigest, executionOptions: item.executionOptions };
}

export function safeFailure(error) {
  return { level: "error", code: /^BATCH_[A-Z_]+$/.test(error?.code || "") ? error.code : "batch.operation_failed",
    message: "Operation failed; inspect the retained stage evidence before retrying." };
}
