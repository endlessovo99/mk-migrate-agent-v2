export function inlineOnChangeSourceActionKey(sourceRef, callbackIndex) {
  if (typeof sourceRef !== "string" || !sourceRef.trim()) return undefined;
  if (!Number.isInteger(callbackIndex) || callbackIndex < 0) return undefined;
  return `${sourceRef}#onChange@${callbackIndex}`;
}

export function normalizeHelperInjectedSourceActionKey(sourceActionKey, source = {}) {
  const sourceRef = source?.sourceRef || source?.id;
  const helperJavascript = typeof source?.helperJavascript === "string"
    ? source.helperJavascript
    : "";
  const injectedPrefix = helperJavascript ? `${helperJavascript}\n\n` : "";
  if (
    typeof sourceActionKey !== "string" ||
    !injectedPrefix ||
    typeof source?.javascript !== "string" ||
    !source.javascript.startsWith(injectedPrefix)
  ) return sourceActionKey;

  const keyPrefix = `${sourceRef}#onChange@`;
  if (!sourceActionKey.startsWith(keyPrefix)) return sourceActionKey;
  const injectedIndex = Number(sourceActionKey.slice(keyPrefix.length));
  if (!Number.isInteger(injectedIndex) || injectedIndex < injectedPrefix.length) {
    return sourceActionKey;
  }
  return inlineOnChangeSourceActionKey(
    sourceRef,
    injectedIndex - injectedPrefix.length
  );
}
