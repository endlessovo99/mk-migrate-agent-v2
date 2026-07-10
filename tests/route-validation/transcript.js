import { integrityError } from "./integrity.js";

const ENTRY_KEYS_BY_OPERATION = new Map([
  ["login", new Set(["operation"])],
  ["init", new Set(["operation"])],
  ["generate-table-name", new Set(["operation"])],
  ["load-parent-category", new Set(["operation", "categoryId"])],
  ["add", new Set(["operation", "templateId", "draft"])],
  ["get-before-update", new Set(["operation", "templateId"])],
  ["update", new Set(["operation", "templateId"])],
  ["save-workflow-draft", new Set(["operation", "templateId", "draft"])],
  ["get-workflow-detail", new Set(["operation", "templateId", "definitionId"])],
  ["get-readback", new Set(["operation", "templateId"])]
]);
const FORBIDDEN_KEY = /authorization|cookie|credential|password|secret|token|username/i;

export function appendTranscriptEntry(transcript, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || !ENTRY_KEYS_BY_OPERATION.has(entry.operation)) {
    throw integrityError("route.transcript.invalid", "Transcript entries require an operation.");
  }
  const allowedKeys = ENTRY_KEYS_BY_OPERATION.get(entry.operation);
  const unknown = Object.keys(entry).filter((key) => !allowedKeys.has(key));
  if (unknown.length) {
    throw integrityError("route.transcript.invalid", "Transcript entry contains non-semantic data.", { unknown });
  }
  for (const key of ["templateId", "categoryId"]) {
    if (Object.hasOwn(entry, key) && !nonEmptyString(entry[key])) {
      throw integrityError("route.transcript.invalid", `Transcript ${key} must be a non-empty string.`);
    }
  }
  if (Object.hasOwn(entry, "definitionId") && typeof entry.definitionId !== "string") {
    throw integrityError("route.transcript.invalid", "Transcript definitionId must be a string.");
  }
  if (Object.hasOwn(entry, "draft") && typeof entry.draft !== "boolean") {
    throw integrityError("route.transcript.invalid", "Transcript draft must be a boolean.");
  }
  transcript.push(structuredClone(entry));
}

export function sanitizedTranscript(transcript) {
  const copy = structuredClone(transcript);
  assertNoSecretLeak(copy, []);
  return copy;
}

export function assertNoSecretLeak(value, secrets) {
  walk(value, (key, entry) => {
    if (key && FORBIDDEN_KEY.test(key)) {
      throw integrityError("route.secret_leak", `Secret-bearing key appeared in Route artifacts: ${key}`);
    }
    if (typeof entry === "string" && secrets.some((secret) => secret && entry.includes(secret))) {
      throw integrityError("route.secret_leak", "A credential value appeared in Route artifacts.");
    }
  });
}

function walk(value, visit, key = "") {
  visit(key, value);
  if (Array.isArray(value)) {
    value.forEach((entry) => walk(entry, visit));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, entry] of Object.entries(value)) walk(entry, visit, childKey);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
