const FALLBACK_ENV_KEYS = Object.freeze({
  person: "NEWOA_FALLBACK_PERSON_FD_ID",
  organization: "NEWOA_FALLBACK_ORGANIZATION_FD_ID",
  group: "NEWOA_FALLBACK_GROUP_FD_ID",
  post: "NEWOA_FALLBACK_POST_FD_ID"
});

export function selectFallbackFdIds(env = {}) {
  return Object.fromEntries(
    Object.entries(FALLBACK_ENV_KEYS)
      .map(([kind, envKey]) => [kind, optionalText(env?.[envKey])])
      .filter(([, value]) => value !== undefined)
  );
}

function optionalText(value) {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}
