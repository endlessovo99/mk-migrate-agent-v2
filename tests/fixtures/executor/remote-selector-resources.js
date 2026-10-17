import { ticConnectionSemanticDigest, ticInterfaceSemanticDigest } from "../../../src/executor/remote-selector-resources.js";

// All identities, upstream address, schema and credentials here are synthetic.
// This fixture proves a supplied wire contract; it makes no claim about an
// unavailable real service or the response envelope of an exported legacy URL.
export function remoteSelectorFixture({ id = "fixture_lookup", inputs = [], columns, rowsPath = ["rows"] } = {}) {
  const responseColumns = columns || [
    { name: "id", title: "Code", type: "String" },
    { name: "name", title: "Name", type: "String" },
    { name: "description", title: "Description", type: "String" }
  ];
  const inputSchema = { type: "object", properties: Object.fromEntries(["keyword", ...inputs].map(name => [name, { type: "string" }])) };
  const type = column => ({ type: column.type === "Number" ? "number" : column.type === "Boolean" ? "boolean" : "string", ...(column.type === "Date" ? { format: "date-time" } : {}) });
  let outputSchema = { type: "array", items: { type: "object", properties: Object.fromEntries(responseColumns.map(column => [column.name, type(column)])) } };
  for (const part of [...rowsPath].reverse()) outputSchema = { type: "object", properties: { [part]: outputSchema } };
  const connection = { fdId: "fixture_connection", fdCode: "fixture_connection_code", fdName: "Fixture connection", fdType: "REST", fdStatus: 1,
    fdSystem: { fdId: "fixture_system", fdName: "Fixture system" }, protocolData: {
      fdServiceAddress: "https://upstream.example.invalid", fdAuthWay: "NoAuth", fdConnectTimeout: 1000, fdReadTimeout: 1000,
      fdHeaderFixedValue: "synthetic-private-server-secret"
    } };
  const nativeInterface = { fdId: id, fdCode: id + "_code", fdName: "Fixture selector", fdType: "REST", fdStatus: 1,
    fdUsageScene: "read", fdFunctionType: 1, fdSupportPage: false, fdInterfaceAbilityList: [], fdAllowAjaxCall: true, fdLogEnabled: false,
    fdConnection: { fdId: connection.fdId, fdType: "REST" }, fdSystem: { fdId: connection.fdSystem.fdId },
    fdAjaxCallers: [{ fdId: "fixture_caller", fdName: "Fixture active person", fdOrgType: 8 }],
    // Native load exposes the body schema but omits derived save fdOutParam.
    fdInParam: JSON.stringify(inputSchema),
    protocolData: { fdRequestWay: "getQuery", fdResponseWay: "body", fdRequestUrl: "/fixture/lookup?privateKey=synthetic-source-secret",
      fdQueryParam: JSON.stringify(inputSchema), fdBodyResponse: JSON.stringify(outputSchema), fdEnableErrorHandle: false,
      fdBodyParam: null, fdHeaderParam: null, fdCookieParam: null, fdDownloadStream: false }
  };
  const decision = { id: "decision_" + id, kind: "native-tic-rest-selector", sourceRef: "fixture-source#" + id,
    contractDigest: "sha256:" + "1".repeat(64), runtimeFactDigest: "sha256:" + "2".repeat(64), wireEvidenceSha256: "sha256:" + "3".repeat(64), scopeOrigin: "https://qas.example.invalid",
    request: { searchParameter: "keyword", inputParameters: inputs.map(name => ({ sourceParameter: name, targetParameter: name })) },
    server: { fdId: nativeInterface.fdId, code: nativeInterface.fdCode, semanticDigest: ticInterfaceSemanticDigest(nativeInterface),
      connectionId: connection.fdId, connectionSemanticDigest: ticConnectionSemanticDigest(connection), callerIds: ["fixture_caller"], readOnlyVerified: true, readOnlyEvidenceSha256: "sha256:" + "4".repeat(64) },
    response: { rowsPath, valueColumn: "id", labelColumn: "name", columns: responseColumns, emptySelection: "clear-bound-values" }
  };
  const calls = [];
  const client = {
    baseUrl: decision.scopeOrigin,
    async getTicInterface(fdId) { calls.push({ method: "getTicInterface", fdId }); return structuredClone(nativeInterface); },
    async getTicConnection(fdId) { calls.push({ method: "getTicConnection", fdId }); return structuredClone(connection); },
    async getElementInfo(ids, options) { calls.push({ method: "getElementInfo", ids, options }); return ids.map(fdId => ({ fdId, fdOrgType: 8, fdIsAvailable: true })); }
  };
  const dsl = { migrationPolicies: { scope: { baseUrl: decision.scopeOrigin }, decisions: [decision] } };
  return { dsl, decision, nativeInterface, connection, client, calls, inputSchema, outputSchema };
}
