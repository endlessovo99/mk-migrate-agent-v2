import { canonicalJson, sha256Digest } from "../agent-review/digest.js";

const KIND = "native-tic-rest-selector";
const HASH = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const WORD = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const UNSAFE = new Set(["__proto__", "prototype", "constructor", "__lookupKey"]);
const record = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const identity = value => typeof value === "string" && ID.test(value);
const word = value => typeof value === "string" && WORD.test(value) && !UNSAFE.has(value);
const exactSet = (left, right) => canonicalJson([...left].sort()) === canonicalJson([...right].sort());

// Only these root editor/audit fields are excluded. Unknown configuration,
// protocolData (including authentication), ACL types and system/connection
// identity remain sealed. Display fields on the three native reference shapes
// are excluded separately; no arbitrary recursive key deletion is performed.
const DISPLAY_AUDIT_FIELDS = new Set([
  "fdName", "fdDesc", "dynamicProps", "mechanisms", "fdCreateTime", "fdAlterTime",
  "fdCreator", "fdAlteror"
]);
const SCHEMA_FIELDS = new Set([
  "fdInParam", "fdOutParam", "fdQueryParam", "fdBodyParam", "fdHeaderParam", "fdCookieParam",
  "fdBodyResponse", "fdErrorBodyResponse", "fdCookieResponse", "fdHeaderResponse", "fdHttpStatusResponse", "fdOriginalOutParam"
]);

function schema(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!record(parsed)) throw new Error("Invalid native schema.");
  return parsed;
}

function digestEntity(entity) {
  if (!record(entity)) throw new TypeError("TIC metadata must be an object.");
  const projection = Object.fromEntries(Object.entries(entity).filter(([key]) => !DISPLAY_AUDIT_FIELDS.has(key)));
  for (const key of ["fdSystem", "fdConnection"]) {
    if (record(projection[key])) {
      projection[key] = Object.fromEntries(Object.entries(projection[key]).filter(([name]) => !["fdName", "dynamicProps"].includes(name)));
    }
  }
  if (Array.isArray(projection.fdAjaxCallers)) {
    projection.fdAjaxCallers = projection.fdAjaxCallers.map(caller => record(caller)
      ? Object.fromEntries(Object.entries(caller).filter(([key]) => key !== "fdName")) : caller)
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  }
  const normalizeSchemas = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [key,
    SCHEMA_FIELDS.has(key) && value !== null && value !== "" ? schema(value) : value
  ]));
  const normalized = normalizeSchemas(projection);
  if (record(normalized.protocolData)) normalized.protocolData = normalizeSchemas(normalized.protocolData);
  return sha256Digest(normalized);
}

export const ticInterfaceSemanticDigest = digestEntity;
export const ticConnectionSemanticDigest = digestEntity;

function origin(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}

function publicSpec(decision) {
  const server = decision?.server, response = decision?.response, request = decision?.request;
  if (!record(server) || !record(request) || !record(response) || !origin(decision.scopeOrigin) || !HASH.test(decision.wireEvidenceSha256 || "") ||
      !identity(server.fdId) || !identity(server.code) || !identity(server.connectionId) || !HASH.test(server.semanticDigest || "") ||
      !HASH.test(server.connectionSemanticDigest || "") || server.readOnlyVerified !== true || !HASH.test(server.readOnlyEvidenceSha256 || "") ||
      !Array.isArray(server.callerIds) || !server.callerIds.length || !server.callerIds.every(identity) || new Set(server.callerIds).size !== server.callerIds.length ||
      !word(request.searchParameter) || !Array.isArray(request.inputParameters) || request.inputParameters.some(item => !record(item) || !word(item.sourceParameter) || !word(item.targetParameter)) ||
      response.emptySelection !== "clear-bound-values" || !Array.isArray(response.rowsPath) || response.rowsPath.length > 8 || !response.rowsPath.every(word) || !word(response.valueColumn) || !word(response.labelColumn) ||
      !Array.isArray(response.columns) || !response.columns.length || response.columns.some(column => !record(column) || !word(column.name) || !["String", "Number", "Boolean", "Date"].includes(column.type))) throw new Error("Invalid binding.");
  const parameters = [request.searchParameter, ...request.inputParameters.map(item => item.targetParameter)];
  if (new Set(parameters).size !== parameters.length || new Set(response.columns.map(column => column.name)).size !== response.columns.length ||
      ![response.valueColumn, response.labelColumn].every(name => response.columns.some(column => column.name === name))) throw new Error("Conflicting binding.");
  return { server, response, request, parameters };
}

function nativeAcl(entity, callerIds) {
  const callers = entity.fdAjaxCallers;
  return Array.isArray(callers) && callers.length === callerIds.length && callers.every(caller => record(caller) && identity(caller.fdId) && caller.fdOrgType === 8) &&
    new Set(callers.map(caller => caller.fdId)).size === callers.length && exactSet(callers.map(caller => caller.fdId), callerIds);
}

function scalarType(node, expected, { nullable = true } = {}) {
  if (!record(node) || node.$ref || node.anyOf || node.oneOf || node.allOf || node.not) return false;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (!types.length || new Set(types).size !== types.length || !nullable && types.includes("null")) return false;
  const allowed = expected === "Number" ? ["number", "integer"] : expected === "Boolean" ? ["boolean"] : ["string"];
  if (!types.some(type => allowed.includes(type)) || types.some(type => !allowed.includes(type) && !(nullable && type === "null"))) return false;
  return expected !== "Date" || ["date", "date-time"].includes(node.format);
}

function simpleObject(node) {
  return record(node) && node.type === "object" && record(node.properties) && !node.$ref && !node.anyOf && !node.oneOf && !node.allOf && !node.not;
}

function verifySchemas(entity, spec) {
  // Native module79344 disposeRequest assigns C=x in equalQuery(getQuery),
  // hence fdInParam and fdQueryParam are identical for this profile. Its
  // disposeResponse assigns d=u in body mode. The native save assembler only
  // rewrites fdOutParam for error handling, which this profile prohibits. The
  // observed native load omits that derived save field: validate the body
  // schema directly and compare fdOutParam only when the load returns it.
  // Simple String query inputs and scalar row schemas below are a conservative
  // supported subset, not a general implementation of native JSON Schema.
  const input = schema(entity.fdInParam), query = schema(entity.protocolData.fdQueryParam);
  if (!simpleObject(input) || canonicalJson(input) !== canonicalJson(query) || !exactSet(Object.keys(input.properties), spec.parameters) ||
      spec.parameters.some(name => !scalarType(input.properties[name], "String", { nullable: false }))) return false;
  const body = schema(entity.protocolData.fdBodyResponse);
  if (Object.hasOwn(entity, "fdOutParam") && canonicalJson(schema(entity.fdOutParam)) !== canonicalJson(body)) return false;
  let rows = body;
  for (const segment of spec.response.rowsPath) {
    if (!simpleObject(rows) || !Object.hasOwn(rows.properties, segment)) return false;
    rows = rows.properties[segment];
  }
  if (!record(rows) || rows.type !== "array" || !simpleObject(rows.items) || rows.$ref || rows.anyOf || rows.oneOf || rows.allOf) return false;
  return spec.response.columns.every(column => Object.hasOwn(rows.items.properties, column.name) && scalarType(rows.items.properties[column.name], column.type));
}

function nativeInterface(entity, spec) {
  const { server } = spec, protocol = entity?.protocolData;
  if (!record(entity) || entity.fdId !== server.fdId || entity.fdCode !== server.code || entity.fdType !== "REST" || entity.fdStatus !== 1 ||
      entity.fdUsageScene !== "read" || entity.fdAllowAjaxCall !== true || entity.fdLogEnabled !== false || entity.fdSupportPage !== false || entity.fdFunctionType !== 1 ||
      !record(protocol) || protocol.fdRequestWay !== "getQuery" || protocol.fdResponseWay !== "body" || protocol.fdEnableErrorHandle !== false ||
      protocol.fdDownloadStream === true || protocol.fdEnableIgnoreException === true || !nativeAcl(entity, server.callerIds) ||
      entity.fdConnection?.fdId !== server.connectionId || entity.fdConnection?.fdType !== "REST" || !identity(entity.fdSystem?.fdId) ||
      !Array.isArray(entity.fdInterfaceAbilityList) || entity.fdInterfaceAbilityList.length ||
      typeof protocol.fdRequestUrl !== "string" || !protocol.fdRequestUrl.startsWith("/") || protocol.fdRequestUrl.startsWith("//") || /[\r\n#\\]/.test(protocol.fdRequestUrl)) return false;
  // This profile exposes query String inputs only. Hidden body/header/cookie
  // argument schemas cannot be smuggled alongside the approved public schema.
  if ([protocol.fdBodyParam, protocol.fdHeaderParam, protocol.fdCookieParam].some(value => value !== null && value !== "" && value !== undefined)) return false;
  return ticInterfaceSemanticDigest(entity) === server.semanticDigest && verifySchemas(entity, spec);
}

function nativeConnection(entity, spec, systemId) {
  if (!record(entity) || entity.fdId !== spec.server.connectionId || entity.fdType !== "REST" || entity.fdStatus !== 1 ||
      entity.fdSystem?.fdId !== systemId || !record(entity.protocolData)) return false;
  const address = entity.protocolData.fdServiceAddress;
  try {
    const url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) return false;
  } catch { return false; }
  return ticConnectionSemanticDigest(entity) === spec.server.connectionSemanticDigest;
}

/** Metadata reads only: never invokes TIC execute, executeForAjax or a write. */
export async function verifyRemoteSelectorResources(dsl, { client, baseUrl } = {}) {
  const decisions = dsl?.migrationPolicies?.decisions;
  if (decisions === undefined && dsl?.migrationPolicies === undefined) return { ok: true, resources: [], diagnostics: [] };
  const selected = Array.isArray(decisions) ? decisions.filter(decision => decision?.kind === KIND) : undefined;
  if (selected?.length === 0) return { ok: true, resources: [], diagnostics: [] };
  const resources = [], diagnostics = [];
  const fail = code => diagnostics.push({ level: "error", code: `executor.remote_selector.${code}`, message: "Controlled REST selector metadata validation failed; no upstream request was made." });
  if (!selected || !origin(baseUrl) || client?.baseUrl !== undefined && client.baseUrl !== baseUrl ||
      typeof client?.getTicInterface !== "function" || typeof client?.getTicConnection !== "function" || typeof client?.getElementInfo !== "function") {
    fail("metadata_unavailable"); return { ok: false, resources, diagnostics };
  }
  const unique = new Map(), connectionDigests = new Map();
  try {
    for (const decision of selected) {
      const spec = publicSpec(decision);
      if (decision.scopeOrigin !== baseUrl || dsl.migrationPolicies?.scope?.baseUrl !== baseUrl) throw new Error("Origin mismatch.");
      // Same native resource must not be approved with competing schema or ACL
      // expectations, even when selected by two independent form controls.
      const signature = canonicalJson({ server: spec.server, response: spec.response, request: spec.request });
      if (unique.has(spec.server.fdId) && unique.get(spec.server.fdId).signature !== signature) throw new Error("Conflicting resource.");
      unique.set(spec.server.fdId, { spec, signature });
      const previousDigest = connectionDigests.get(spec.server.connectionId);
      if (previousDigest !== undefined && previousDigest !== spec.server.connectionSemanticDigest) throw new Error("Conflicting connection.");
      connectionDigests.set(spec.server.connectionId, spec.server.connectionSemanticDigest);
    }
  } catch { fail("binding_invalid"); return { ok: false, resources, diagnostics }; }
  const connections = new Map();
  for (const { spec } of unique.values()) {
    try {
      const entity = await client.getTicInterface(spec.server.fdId);
      if (!nativeInterface(entity, spec)) { fail("interface_invalid"); continue; }
      if (!connections.has(spec.server.connectionId)) connections.set(spec.server.connectionId, await client.getTicConnection(spec.server.connectionId));
      if (!nativeConnection(connections.get(spec.server.connectionId), spec, entity.fdSystem.fdId)) { fail("connection_invalid"); continue; }
      const callers = await client.getElementInfo(spec.server.callerIds, { departmentEvidence: true });
      if (!Array.isArray(callers) || callers.length !== spec.server.callerIds.length || callers.some(caller => !record(caller) || !identity(caller.fdId) || caller.fdOrgType !== 8 || caller.fdIsAvailable !== true) ||
          new Set(callers.map(caller => caller.fdId)).size !== callers.length || !exactSet(callers.map(caller => caller.fdId), spec.server.callerIds)) { fail("caller_invalid"); continue; }
      resources.push({ fdId: spec.server.fdId, code: spec.server.code, semanticDigest: spec.server.semanticDigest,
        connectionId: spec.server.connectionId, connectionSemanticDigest: spec.server.connectionSemanticDigest, callerIds: [...spec.server.callerIds].sort() });
    } catch { fail("metadata_unavailable"); }
  }
  return { ok: diagnostics.length === 0, resources, diagnostics };
}
