const SAFE_DESIGNER_VALUE_KEYS = new Set([
  "id",
  "label",
  "title",
  "required",
  "canShow",
  "showStatus",
  "requestMethod",
  "searchKey",
  "_label_bind_id",
  "b",
  "color",
  "size",
  "content",
  "items",
  "tableName"
]);

export function sanitizeDesignerValues(normalizedType, values) {
  if (!["restdialog", "linklabel"].includes(normalizedType)) return values;
  return Object.fromEntries(
    Object.entries(values || {}).filter(([key]) => SAFE_DESIGNER_VALUE_KEYS.has(key))
  );
}

export function restDialogEvidence(values = {}) {
  const outputText = values._outputParams || values.outputParams || "";
  const outputMappings = [];
  for (const match of String(outputText).matchAll(/\{[^{}]*["']?outParamName["']?\s*:\s*(["'])([^"']+)\1[^{}]*\}/gi)) {
    const fragment = match[0];
    const fieldId = legacyObjectStringValue(fragment, "idField").replace(/^\$|\$$/g, "");
    const fieldTitle = legacyObjectStringValue(fragment, "nameField").replace(/^\$|\$$/g, "");
    outputMappings.push({
      outputName: match[2],
      ...(fieldId ? { fieldId } : {}),
      ...(fieldTitle ? { fieldTitle } : {})
    });
  }
  return {
    remoteConfigured: Boolean(values.restApiPath || values._restApiPath || values.apiPath),
    requestMethod: String(values.requestMethod || "").toUpperCase(),
    searchKey: values.searchKey || "",
    outputMappings
  };
}

function legacyObjectStringValue(fragment, key) {
  const match = String(fragment).match(new RegExp(`["']?${key}["']?\\s*:\\s*(["'])([^"']*)\\1`, "i"));
  return match?.[2] || "";
}
