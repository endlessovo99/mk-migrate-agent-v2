import { createHash } from "node:crypto";
import { parseExpressionAt } from "acorn";
import { scanHtmlTags, findMatchingCloseTag } from "./designer-html-tokenizer.js";
import { parseDesignerFdValues, parseStaticDesignerStringValues } from "./designer-control-values.js";
import { parseStaticMarkupAttributes, staticSourceMarkup } from "./source-static-markup.js";
import { parseMetadataXml } from "./sysform-metadata.js";
import { attrValue } from "./xml-utils.js";

const hash = value => createHash("sha256").update(String(value || "")).digest("hex");
const ref = value => `source-private:sha256:${hash(value)}`;
const identifier = /^[A-Za-z_][\w-]*$/;
const fieldReference = value => /^\$([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)\$$/.exec(value || "")?.[1];
const secretName = name => /secret|password|token|auth|api.?key|credential|cookie/i.test(name);

/** Static source requirements only. These facts never establish a native binding. */
export function remoteSelectorSourceContracts(template = {}) {
  const designer = String(template.fdDesignerHtml || ""), markup = staticSourceMarkup(designer);
  if (markup === undefined) return {};
  const tokens = [...scanHtmlTags(markup)].filter(token => !token.closing);
  const tables = tokens.filter(token => attrValue(token.attrs, "fd_type").toLowerCase() === "detailstable").map(token => ({
    id: parseDesignerFdValues(token.attrs).id, start: token.start, end: findMatchingCloseTag(markup, token.end, token.name)
  }));
  const metadata = parseMetadataXml(template.fdMetadataXml || "").fields;
  const sourceOrigin = { templateId: template.fdId, modelId: template.fdModelId,
    designerSha256: hash(designer), displaySha256: hash(template.fdDisplayJsp), metadataSha256: hash(template.fdMetadataXml) };
  const found = new Map();
  for (const token of tokens) {
    const parsed = parseDesignerFdValues(token.attrs), type = attrValue(token.attrs, "fd_type").toLowerCase();
    const kind = [type, String(parsed.businessType || "").toLowerCase()].find(value => ["restdialog", "sqldialog"].includes(value));
    if (!kind || !identifier.test(parsed.id || "")) continue;
    const contexts = tables.filter(table => table.start < token.start && token.end < table.end);
    const tableId = contexts.length === 1 ? contexts[0].id : undefined;
    const identity = tableId ? `${tableId}.${parsed.id}` : parsed.id;
    const reasons = [];
    if ([type, String(parsed.businessType || "").toLowerCase()].some(value => ["restdialog", "sqldialog"].includes(value) && value !== kind)) reasons.push("selector_kind_conflict");
    const keys = new Set(Object.keys(parsed));
    const values = parseStaticDesignerStringValues(token.attrs, keys, keys);
    if (!values) reasons.push("designer_values_not_complete_static_strings");
    if (contexts.length > 1 || contexts.some(table => !identifier.test(table.id || ""))) reasons.push("table_identity_ambiguous");
    const fields = tableId ? metadata.filter(field => field.id === tableId && field.type === "detailTable").flatMap(table => table.columns || []).filter(field => field.id === parsed.id)
      : metadata.filter(field => field.id === parsed.id && field.type !== "detailTable");
    if (fields.length !== 1) reasons.push("metadata_field_not_unique");
    const declaration = { start: token.start, end: token.end, sha256: hash(designer.slice(token.start, token.end)) };
    const fact = { version: 1, kind: kind === "restdialog" ? "REST" : "SQL", fieldId: parsed.id, ...(tableId ? { tableId } : {}),
      sourceOrigin, declarations: [declaration], bindingStatus: "unbound", targetResourceVerified: false, reasons };
    if (values) {
      const inputs = mappingList(values._inputParams, "inputParams", reasons);
      const outputs = mappingList(values._outputParams, "outputParams", reasons);
      fact.inputMappings = inputs?.map((item, index) => {
        if (!record(item) || !identifier.test(item.inputParamName || "") || !fieldReference(item.idField)) reasons.push("input_mapping_unproven");
        if (secretName(item?.inputParamName || "")) { reasons.push("private_input_binding_required"); return { index, opaqueRef: ref(JSON.stringify(item)), private: true }; }
        return { index, parameterName: item?.inputParamName, sourceField: fieldReference(item?.idField) };
      });
      fact.outputMappings = outputs?.map((item, index) => {
        const column = item?.outParamName || item?.name;
        const enabled = kind === "restdialog" ? true : item?.isUse === "true";
        if (!record(item) || !identifier.test(column || "") || kind === "sqldialog" && !["true", "false"].includes(item.isUse) ||
          enabled && !fieldReference(item.idField)) reasons.push("output_mapping_unproven");
        if (secretName(column || "")) { reasons.push("private_output_mapping_required"); return { index, opaqueRef: ref(JSON.stringify(item)), private: true }; }
        return { index, sourceColumn: column, enabled, targetField: fieldReference(item?.idField) };
      });
      fact.selection = { multiSelect: boolean(values.multiSelect, reasons, "multi_select"),
        readOnlyText: boolean(values.txtReadOnly, reasons, "readonly_text"),
        preload: boolean(values.isLoadData, reasons, "preload"), tree: boolean(values.isShowTree, reasons, "tree") };
      const callbackNames = kind === "restdialog" ? ["RestApiChangeBefore", "RestApiChangeAfter"] : ["SQLValueChangeBefore", "SQLValueChangeAfter"];
      fact.callbacks = Object.fromEntries(callbackNames.map(name => [name, { present: Boolean(values[name]), sha256: hash(values[name]),
        ...(values[name] ? { opaqueRef: ref(values[name]) } : {}) }]));
      if (kind === "restdialog") {
        fact.requestResource = restResource(values, reasons);
        fact.businessDataSource = { kind: "behind-REST-resource", targetIdentity: "unverified" };
        if (secretName(values.searchKey || "")) { fact.privateSearchKeyRef = ref(values.searchKey); reasons.push("private_search_key_required"); }
        else fact.searchKey = values.searchKey;
        if (!identifier.test(values.searchKey || "")) reasons.push("search_key_unproven");
      } else {
        fact.requestResource = { kind: "SQL-query", querySha256: hash(values.sqlvalue), queryRef: ref(values.sqlvalue),
          declaredSearchColumns: (values.queryColumn || "").split(",").map(column => column.trim()).filter(Boolean),
          orderBySha256: hash(values.orderByValue), orderByRef: ref(values.orderByValue) };
        fact.businessDataSource = { kind: "source-SQL-resource", sourceId: values.sqlResource, targetIdentity: "unverified" };
        if (/[\r\n]/.test(values.sqlvalue || "")) fact.requestResource.exportedQuerySha256 = hash(values.sqlvalue.replace(/\r\n|\r|\n/g, " "));
        if (!values.sqlvalue || !identifier.test(values.sqlResource || "") && !/^[a-f\d]{32}$/i.test(values.sqlResource || "")) reasons.push("SQL_resource_or_query_unproven");
      }
    }
    if (!found.has(identity)) found.set(identity, []);
    found.get(identity).push(fact);
  }
  return Object.fromEntries([...found].map(([identity, facts]) => {
    const first = facts[0];
    if (facts.length > 1) { first.reasons.push("duplicate_source_selector_declaration"); first.declarations = facts.flatMap(fact => fact.declarations); }
    first.reasons = [...new Set(first.reasons)];
    first.status = first.reasons.length ? "unproven" : "static";
    return [identity, first];
  }));
}

function restResource(values, reasons) {
  const locator = values.restApiPath || "";
  const resource = { kind: "REST-request", locatorSha256: hash(locator), locatorRef: ref(locator), method: values.requestMethod };
  if (!locator || /\$\{|#\{|<%|\!\{/.test(locator)) { reasons.push("REST_locator_not_static"); return resource; }
  if (!["GET", "POST"].includes(values.requestMethod)) reasons.push("REST_method_unproven");
  let url;
  try { url = new URL(locator, "https://source-application.invalid"); } catch { reasons.push("REST_locator_invalid"); return resource; }
  if (!["http:", "https:"].includes(url.protocol)) { reasons.push("REST_protocol_unsupported"); return resource; }
  const relative = !/^https?:\/\//i.test(locator) && !locator.startsWith("//");
  resource.usesSourceApplicationOrigin = relative;
  if (!relative) resource.origin = url.origin;
  resource.protocolRelative = locator.startsWith("//");
  resource.needsPrivateBinding = Boolean(url.username || url.password || [...url.searchParams.keys()].some(secretName) ||
    values.secret || values.secretKey || values.isEnableSecret === "true");
  if (resource.needsPrivateBinding) resource.privateBindingRef = ref(JSON.stringify([locator, values.secretKey, values.secret]));
  resource.responseEnvelope = "not-declared-in-widget";
  return resource;
}
function boolean(value, reasons, name) {
  if (!["true", "false"].includes(value)) { reasons.push(`${name}_not_explicit_boolean`); return undefined; }
  return value === "true";
}
function record(value) { return value && typeof value === "object" && !Array.isArray(value); }
function mappingList(text, key, reasons) {
  let ast, comments = [];
  try { ast = parseExpressionAt(String(text || ""), 0, { ecmaVersion: "latest", onComment: comments }); } catch { reasons.push(`${key}_not_static_literal`); return undefined; }
  if (comments.length || String(text).slice(0, ast.start).trim() || String(text).slice(ast.end).trim()) { reasons.push(`${key}_not_static_literal`); return undefined; }
  const convert = node => {
    if (node.type === "Literal" && !node.regex) return node.value;
    if (node.type === "ArrayExpression") return node.elements.map(element => { if (!element) throw Error(); return convert(element); });
    if (node.type !== "ObjectExpression") throw Error();
    const result = Object.create(null);
    for (const property of node.properties) {
      const name = property.key?.type === "Identifier" ? property.key.name : property.key?.value;
      if (property.type !== "Property" || property.kind !== "init" || property.method || property.computed || property.shorthand ||
        typeof name !== "string" || Object.hasOwn(result, name)) throw Error();
      result[name] = convert(property.value);
    }
    return result;
  };
  try { const result = convert(ast); if (!record(result) || Object.keys(result).length !== 1 || !Array.isArray(result[key])) throw Error(); return result[key]; }
  catch { reasons.push(`${key}_not_static_literal`); return undefined; }
}
