import { MK_JS_SNIPPETS_CATALOG } from "./catalogs.js";

export const TARGET_API_SAFETY = {
  safe: "safe",
  review: "review",
  blocked: "blocked",
  unknown: "unknown"
};

const SAFE_TARGET_APIS = new Set([
  "MKXFORM.$",
  "MKXFORM.addNestRow",
  "MKXFORM.addRow",
  "MKXFORM.ajax",
  "MKXFORM.cacluColumnValue",
  "MKXFORM.callOrg",
  "MKXFORM.checkDetailRow",
  "MKXFORM.checkNestDetailRow",
  "MKXFORM.getControlHtml",
  "MKXFORM.getControlValue",
  "MKXFORM.getFieldAttr",
  "MKXFORM.getFormValues",
  "MKXFORM.getLocale",
  "MKXFORM.getNestControlValue",
  "MKXFORM.getNestRowCount",
  "MKXFORM.getPageControlValue",
  "MKXFORM.getRowCount",
  "MKXFORM.getSelectedNestRowIndex",
  "MKXFORM.getSelectedRowIndex",
  "MKXFORM.getValue",
  "MKXFORM.getValueText",
  "MKXFORM.reload",
  "MKXFORM.setDetailFieldAttr",
  "MKXFORM.setDetailFieldItemAttr",
  "MKXFORM.setDetailRowAttr",
  "MKXFORM.setDetailValues",
  "MKXFORM.setFieldAttr",
  "MKXFORM.setNestDetailFieldItemAttr",
  "MKXFORM.setProps",
  "MKXFORM.setStyle",
  "MKXFORM.setValue",
  "MKXFORM.updateControl",
  "MKXFORM.updateControlStyle",
  "MKXFORM.updateNestControl",
  "MKXFORM.updateNestControlStyle",
  "MKXFORM.updateNestRow",
  "MKXFORM.updateRow",
  "MKXFORM.validateFields"
]);

const REVIEW_TARGET_APIS = new Set([
  "MKXFORM.authOperation",
  "MKXFORM.callLbpm",
  "MKXFORM.controlDetailRowCanDelete",
  "MKXFORM.deleteNestRow",
  "MKXFORM.deleteRow",
  "MKXFORM.disabledNestOperation",
  "MKXFORM.disabledOperation",
  "MKXFORM.getFormConfigs",
  "MKXFORM.getIdentity",
  "MKXFORM.getLbpmFormValues",
  "MKXFORM.getOperationParameter",
  "MKXFORM.HTMLModal",
  "MKXFORM.message.success",
  "MKXFORM.mobileModal",
  "MKXFORM.modal",
  "MKXFORM.tableModal",
  "MKXFORM.toast"
]);

const BLOCKED_TARGET_APIS = new Set([
  "MKXFORM.executeOperation"
]);

export const TARGET_API_CATALOG = buildTargetApiCatalog();
export const TARGET_API_BY_NAME = new Map(TARGET_API_CATALOG.functions.map((api) => [api.name, api]));

export function resolveTargetApiCall(name) {
  if (!String(name || "").startsWith("MKXFORM.")) {
    return { name, safety: TARGET_API_SAFETY.unknown };
  }
  return TARGET_API_BY_NAME.get(name) || {
    name,
    safety: TARGET_API_SAFETY.unknown,
    status: "unsupported",
    reason: "MKXFORM call is not present in the target API catalog"
  };
}

export function isExecutableTargetApi(name) {
  const api = resolveTargetApiCall(name);
  return api.safety === TARGET_API_SAFETY.safe || api.safety === TARGET_API_SAFETY.review;
}

export function targetApiCatalogSummary() {
  const grouped = groupBySafety(TARGET_API_CATALOG.functions);
  return {
    id: TARGET_API_CATALOG.id,
    version: TARGET_API_CATALOG.version,
    source: TARGET_API_CATALOG.source,
    policy: {
      safe: "May be used in mapped script actions when the script otherwise validates.",
      review: "May be used in mapped script actions only when coverage is translated/covered, functionMappings are present, and no residual behavior remains.",
      blocked: "Must not appear in mapped or executable script actions."
    },
    safe: summarizeEntries(grouped.safe),
    review: summarizeEntries(grouped.review),
    blocked: summarizeEntries(grouped.blocked)
  };
}

function buildTargetApiCatalog() {
  const functions = new Map();
  for (const category of MK_JS_SNIPPETS_CATALOG.categories || []) {
    for (const snippet of category.functions || []) {
      const calls = extractMkXformCalls([snippet.insertedCode, snippet.sourceExample].filter(Boolean).join("\n"));
      for (const name of calls) {
        if (!functions.has(name)) {
          functions.set(name, {
            name,
            safety: classifySafety(name),
            categoryId: category.id,
            categoryName: category.name,
            snippetName: snippet.name,
            title: snippet.title,
            purpose: snippet.purpose,
            evidence: snippet.sourceExample || snippet.insertedCode || ""
          });
        }
      }
    }
  }

  return {
    id: MK_JS_SNIPPETS_CATALOG.id,
    version: MK_JS_SNIPPETS_CATALOG.version,
    source: MK_JS_SNIPPETS_CATALOG.source,
    functions: [...functions.values()].sort((left, right) => left.name.localeCompare(right.name))
  };
}

function extractMkXformCalls(text = "") {
  const calls = new Set();
  for (const match of String(text || "").matchAll(/\b(MKXFORM(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g)) {
    calls.add(match[1]);
  }
  return [...calls];
}

function classifySafety(name) {
  if (BLOCKED_TARGET_APIS.has(name)) return TARGET_API_SAFETY.blocked;
  if (REVIEW_TARGET_APIS.has(name)) return TARGET_API_SAFETY.review;
  if (SAFE_TARGET_APIS.has(name)) return TARGET_API_SAFETY.safe;
  return TARGET_API_SAFETY.review;
}

function groupBySafety(functions) {
  return functions.reduce((grouped, api) => {
    const key = api.safety || TARGET_API_SAFETY.unknown;
    grouped[key] = grouped[key] || [];
    grouped[key].push(api);
    return grouped;
  }, { safe: [], review: [], blocked: [] });
}

function summarizeEntries(entries = []) {
  return entries.map((api) => ({
    name: api.name,
    categoryId: api.categoryId,
    title: api.title || "",
    purpose: api.purpose || ""
  }));
}
