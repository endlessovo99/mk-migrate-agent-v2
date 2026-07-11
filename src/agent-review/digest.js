import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

export function sha256Digest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function hmacSha256Digest(value, key) {
  return `hmac-sha256:${createHmac("sha256", key).update(canonicalJson(value)).digest("hex")}`;
}

export function secureDigestEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortKeys(value[key])])
  );
}
