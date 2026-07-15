export const REDACTED_CREDENTIAL_VALUE = "__REDACTED_CREDENTIAL__";

const CREDENTIAL_NAMES = new Set([
  "accesstoken",
  "apikey",
  "authkey",
  "authorization",
  "clientsecret",
  "cookie",
  "password",
  "passwd",
  "secret",
  "secretkey",
  "setcookie",
  "token",
  "username"
]);

const HEADER_NAME_FIELDS = new Set(["fieldname", "headername", "key", "name"]);
const HEADER_VALUE_FIELDS = new Set(["fieldvalue", "headervalue", "value"]);
const CREDENTIAL_NAME_SUFFIXES = [
  "accesstoken",
  "apikey",
  "authkey",
  "authorization",
  "clientsecret",
  "password",
  "secretkey",
  "token",
  "username"
];

export function sanitizeCredentialMaterial(value, options = {}) {
  const redactedPaths = [];
  const sanitized = sanitizeValue(value, options.path || "", redactedPaths);
  return {
    value: sanitized,
    redactedPaths: [...new Set(redactedPaths)]
  };
}

export function findUnredactedCredentialPaths(value, options = {}) {
  return sanitizeCredentialMaterial(value, options).redactedPaths;
}

function sanitizeValue(value, path, redactedPaths) {
  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizeValue(entry, joinPath(path, index), redactedPaths));
  }

  if (isRecord(value)) {
    return sanitizeRecord(value, path, redactedPaths);
  }

  if (typeof value === "string") {
    return sanitizeString(value, path, redactedPaths);
  }

  return value;
}

function sanitizeRecord(value, path, redactedPaths) {
  const result = { ...value };
  const headerName = Object.entries(value).find(([key]) => HEADER_NAME_FIELDS.has(canonicalName(key)));
  const sensitiveHeader = headerName && isCredentialTransportName(headerName[1]);
  const headerValueKeys = sensitiveHeader
    ? Object.keys(value).filter((key) => HEADER_VALUE_FIELDS.has(canonicalName(key)))
    : [];

  for (const key of headerValueKeys) {
    if (!hasUnredactedValue(value[key])) continue;
    result[key] = REDACTED_CREDENTIAL_VALUE;
    redactedPaths.push(joinPath(path, key));
  }

  for (const [key, entry] of Object.entries(value)) {
    if (headerValueKeys.includes(key)) continue;
    const entryPath = joinPath(path, key);
    if (isCredentialPropertyName(key)) {
      if (hasUnredactedValue(entry)) {
        result[key] = REDACTED_CREDENTIAL_VALUE;
        redactedPaths.push(entryPath);
      }
      continue;
    }
    result[key] = sanitizeValue(entry, entryPath, redactedPaths);
  }

  return result;
}

function sanitizeString(value, path, redactedPaths) {
  if (!hasUnredactedValue(value)) return value;

  const structured = parseStructuredJson(value);
  if (structured !== undefined) {
    const before = redactedPaths.length;
    const sanitized = sanitizeValue(structured, path, redactedPaths);
    return redactedPaths.length === before ? value : JSON.stringify(sanitized);
  }

  const parsedUrl = parseHttpUrl(value);
  if (!parsedUrl) return value;

  const entries = [...parsedUrl.searchParams.entries()];
  let changed = false;
  parsedUrl.search = "";
  for (const [key, entry] of entries) {
    if (isCredentialTransportName(key) && hasUnredactedValue(entry)) {
      parsedUrl.searchParams.append(key, REDACTED_CREDENTIAL_VALUE);
      redactedPaths.push(joinPath(joinPath(path, "query"), key));
      changed = true;
    } else {
      parsedUrl.searchParams.append(key, entry);
    }
  }

  return changed ? parsedUrl.toString() : value;
}

function parseStructuredJson(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) || Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function hasUnredactedValue(value) {
  if (value === undefined || value === null || value === "") return false;
  return value !== REDACTED_CREDENTIAL_VALUE;
}

function isCredentialPropertyName(value) {
  return CREDENTIAL_NAMES.has(canonicalName(value));
}

function isCredentialTransportName(value) {
  const canonical = canonicalName(value);
  return CREDENTIAL_NAMES.has(canonical) ||
    CREDENTIAL_NAME_SUFFIXES.some((suffix) => canonical.endsWith(suffix));
}

function canonicalName(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function joinPath(path, segment) {
  const escaped = String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
  return `${path}/${escaped}`;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
