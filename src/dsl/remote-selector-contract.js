const KIND = "native-tic-rest-selector", HASH = /^sha256:[a-f0-9]{64}$/;
const word = value => typeof value === "string" && /^[A-Za-z_][\w-]*$/.test(value) && !["__proto__", "constructor", "prototype", "__lookupKey"].includes(value);
const opaqueId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
const text = value => typeof value === "string" && value.length > 0 && value.trim() === value && !/[\r\n]/.test(value);
const privateName = name => /secret|password|token|auth|api.?key|credential|cookie/i.test(name);
const record = value => value && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => record(value) && keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key));
const rootOrigin = value => { try { const url = new URL(value); return url.origin === value && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; } };
const diagnostic = (code, message) => ({ level: "error", code, message });

export function validateRemoteSelectorDecisions(decisions) {
  const diagnostics = [], ids = new Set(), refs = new Set();
  if (!Array.isArray(decisions)) return { ok: false, diagnostics: [diagnostic("migration.policy.remote.invalid", "REST decisions must be an array.")] };
  for (const decision of decisions) {
    const server = decision?.server, response = decision?.response, request = decision?.request;
    const valid = exact(decision, ["id", "kind", "sourceRef", "contractDigest", "runtimeFactDigest", "scopeOrigin", "server", "response", "request", "wireEvidenceSha256"]) &&
      text(decision.id) && decision.kind === KIND && text(decision.sourceRef) && HASH.test(decision.contractDigest) && HASH.test(decision.runtimeFactDigest) && HASH.test(decision.wireEvidenceSha256) && rootOrigin(decision.scopeOrigin) &&
      exact(server, ["fdId", "code", "semanticDigest", "connectionId", "connectionSemanticDigest", "callerIds", "readOnlyVerified", "readOnlyEvidenceSha256"]) && opaqueId(server.fdId) && opaqueId(server.code) && HASH.test(server.semanticDigest) && opaqueId(server.connectionId) && HASH.test(server.connectionSemanticDigest) &&
      Array.isArray(server.callerIds) && server.callerIds.length > 0 && server.callerIds.every(opaqueId) && new Set(server.callerIds).size === server.callerIds.length &&
      server.readOnlyVerified === true && HASH.test(server.readOnlyEvidenceSha256) &&
      exact(request, ["searchParameter", "inputParameters"]) && word(request.searchParameter) && !privateName(request.searchParameter) && Array.isArray(request.inputParameters) && request.inputParameters.length <= 64 &&
      request.inputParameters.every(mapping => exact(mapping,["sourceParameter","targetParameter"]) && word(mapping.sourceParameter) && word(mapping.targetParameter) && !privateName(mapping.sourceParameter) && !privateName(mapping.targetParameter)) &&
      new Set(request.inputParameters.map(mapping=>mapping.sourceParameter)).size === request.inputParameters.length && new Set([request.searchParameter,...request.inputParameters.map(mapping=>mapping.targetParameter)]).size === request.inputParameters.length+1 &&
      exact(response, ["rowsPath", "valueColumn", "labelColumn", "columns", "emptySelection"]) && response.emptySelection === "clear-bound-values" && Array.isArray(response.rowsPath) && response.rowsPath.length <= 8 && response.rowsPath.every(word) &&
      word(response.valueColumn) && word(response.labelColumn) && Array.isArray(response.columns) && response.columns.length > 0 && response.columns.length <= 64 &&
      response.columns.every(column => !/secret|password|token|auth|api.?key|credential|cookie/i.test(column?.name || "") && exact(column, ["name", "title", "type"]) && word(column.name) && text(column.title) && ["String", "Number", "Boolean", "Date"].includes(column.type)) &&
      new Set(response.columns.map(column => column.name)).size === response.columns.length && [response.valueColumn, response.labelColumn].every(name => response.columns.some(column => column.name === name));
    if (!valid || ids.has(decision?.id) || refs.has(decision?.sourceRef)) diagnostics.push(diagnostic("migration.policy.remote.invalid", "REST decision identity, private-free typed resource binding, read-only evidence and response schema must be exact and unique."));
    ids.add(decision?.id); refs.add(decision?.sourceRef);
  }
  return { ok: diagnostics.length === 0, diagnostics };
}
