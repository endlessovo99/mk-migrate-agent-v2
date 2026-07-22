export function inlineOnChangeSourceActionKey(sourceRef, callbackIndex) {
  if (typeof sourceRef !== "string" || !sourceRef.trim()) return undefined;
  if (!Number.isInteger(callbackIndex) || callbackIndex < 0) return undefined;
  return `${sourceRef}#onChange@${callbackIndex}`;
}
