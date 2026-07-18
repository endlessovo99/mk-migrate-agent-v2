import { CONTROL_EVENTS_BY_COMPONENT, CONTROL_EVENTS_CATALOG, JS_METHOD_CATALOG } from "./catalogs.js";
import {
  isExecutableTargetApi,
  resolveTargetApiCall,
  TARGET_API_BY_NAME,
  TARGET_API_SAFETY,
  targetApiCatalogSummary
} from "./target-api-catalog.js";

export const SCRIPT_EVENTS = new Set(Object.keys(CONTROL_EVENTS_CATALOG.events || {}));
export const SCRIPT_GLOBAL_EVENTS = new Set(CONTROL_EVENTS_CATALOG.global?.events || []);
export const SCRIPT_SINGLETON_GLOBAL_EVENTS = new Set(["onLoad", "onBeforeSubmit", "onAfterSubmit"]);
export const SCRIPT_CONTROL_EVENTS = new Set(
  [...CONTROL_EVENTS_BY_COMPONENT.values()].flatMap((component) => component.events || [])
);
export const SCRIPT_SCOPES = new Set(["global", "control"]);
export const SCRIPT_TRANSLATION_STATUSES = new Set(["mapped", "needs_review", "manual", "omitted"]);

export const ALLOWED_SCRIPT_TARGET_FUNCTIONS = new Set(
  [...TARGET_API_BY_NAME.values()]
    .filter((api) => api.safety === TARGET_API_SAFETY.safe || api.safety === TARGET_API_SAFETY.review)
    .map((api) => api.name)
);

const ALLOWED_BUILTIN_CALLS = catalogNameSet(JS_METHOD_CATALOG.globals);
const ALLOWED_STATIC_METHODS = catalogNameSet(JS_METHOD_CATALOG.staticMethods);
const ALLOWED_INSTANCE_METHODS = catalogNameSet(JS_METHOD_CATALOG.instanceMethods);

export function buildScriptTargetIndex(form = {}) {
  const mainFields = new Map();
  const detailTables = new Map();
  const detailColumns = new Map();
  const detailColumnIds = new Set();

  for (const field of Array.isArray(form.fields) ? form.fields : []) {
    if (!field?.id) continue;
    if (field.type === "detailTable") {
      detailTables.set(field.id, field);
      for (const column of Array.isArray(field.columns) ? field.columns : []) {
        if (!column?.id) continue;
        detailColumnIds.add(column.id);
        detailColumns.set(`${field.id}.${column.id}`, { table: field, column });
      }
      continue;
    }
    mainFields.set(field.id, field);
  }

  return { mainFields, detailTables, detailColumns, detailColumnIds };
}

export function resolveScriptControlTarget(form = {}, action = {}) {
  const index = buildScriptTargetIndex(form);
  const controlId = action.controlId;
  const tableId = action.tableId;

  if (!controlId) {
    return { ok: false, code: "missing_control", message: "Control script actions require controlId." };
  }

  if (tableId) {
    if (tableId === controlId && index.detailTables.has(tableId)) {
      const field = index.detailTables.get(tableId);
      return {
        ok: true,
        kind: "detailTable",
        tableId,
        controlId,
        table: field,
        field
      };
    }
    const target = index.detailColumns.get(`${tableId}.${controlId}`);
    if (!target) {
      return {
        ok: false,
        code: "detail_control_unresolved",
        message: "Control script tableId/controlId must resolve to a detail table column.",
        tableId,
        controlId
      };
    }
    return {
      ok: true,
      kind: "detail",
      tableId,
      controlId,
      table: target.table,
      field: target.column
    };
  }

  if (index.mainFields.has(controlId)) {
    const field = index.mainFields.get(controlId);
    if (field.dataOnly === true) {
      return {
        ok: false,
        code: "data_only_control_action_forbidden",
        message: "Data-only fields exist in the data model but cannot host control event actions.",
        controlId
      };
    }
    return {
      ok: true,
      kind: "main",
      controlId,
      field
    };
  }

  if (index.detailTables.has(controlId)) {
    const field = index.detailTables.get(controlId);
    return { ok: true, kind: "detailTable", tableId: controlId, controlId, table: field, field };
  }

  if (index.detailColumnIds.has(controlId)) {
    return {
      ok: false,
      code: "detail_control_table_required",
      message: "Detail column control script actions must include tableId.",
      controlId
    };
  }

  return {
    ok: false,
    code: "control_unresolved",
    message: "Control script controlId must resolve to a form field.",
    controlId
  };
}

export function resolveControlEventSupport(target, event) {
  const componentId = target?.field?.componentId;
  if (!componentId) {
    return {
      status: "unknown",
      componentId,
      event,
      reason: "target componentId is missing"
    };
  }

  const entry = CONTROL_EVENTS_BY_COMPONENT.get(componentId);
  if (!entry) {
    return {
      status: "unknown",
      componentId,
      event,
      reason: "component is not present in the control-events catalog"
    };
  }

  if (target?.kind === "detail") {
    if (entry.detailColumn === true) {
      return eventSupported(entry, event, "detailColumn");
    }
    if (entry.detailColumn === false) {
      return {
        status: "unsupported",
        componentId,
        event,
        scope: "detailColumn",
        supportedEvents: entry.events || [],
        reason: "component catalog marks detail-column control actions unsupported"
      };
    }
    return {
      status: "unknown",
      componentId,
      event,
      scope: "detailColumn",
      supportedEvents: entry.events || [],
      reason: "detail-column event support has not been verified"
    };
  }


  if (target?.kind === "detailTable") {
    return eventSupported(entry, event, "detailTable");
  }

  return eventSupported(entry, event, "field");
}

export function summarizeScriptActionSupport(actions = [], form = {}) {
  const counts = { supported: 0, unsupported: 0, unknown: 0 };
  const components = new Set();
  const details = [];

  for (const action of Array.isArray(actions) ? actions : []) {
    if (action?.scope !== "control") continue;
    const target = resolveScriptControlTarget(form, action);
    if (!target.ok) {
      counts.unknown += 1;
      details.push({
        id: action.id,
        event: action.event || action.name,
        status: "unknown",
        reason: target.code,
        controlId: action.controlId,
        tableId: action.tableId
      });
      continue;
    }
    const support = resolveControlEventSupport(target, action.event || action.name);
    counts[support.status] = (counts[support.status] || 0) + 1;
    if (support.componentId) components.add(support.componentId);
    details.push({
      id: action.id,
      event: action.event || action.name,
      status: support.status,
      componentId: support.componentId,
      controlId: action.controlId,
      tableId: action.tableId,
      scope: support.scope,
      reason: support.reason
    });
  }

  return {
    counts,
    components: [...components],
    detailActions: details.filter((item) => item.tableId).length,
    details
  };
}

export function analyzeScriptFunction(text = "") {
  const source = String(text || "");
  const masked = maskStringsAndComments(source);
  const unsupportedSyntax = extractUnsupportedMkSyntax(masked, source);
  const promiseReturns = extractPromiseReturns(masked, source);
  const localFunctions = extractLocalFunctionNames(masked);
  const calls = extractCalls(masked, source, localFunctions);
  const domUsages = extractDomUsages(masked, source);
  const targetCalls = calls
    .filter((call) => call.name.startsWith("MKXFORM."))
    .map((call) => ({
      ...call,
      targetApi: resolveTargetApiCall(call.name)
    }));
  const disallowedTargetCalls = targetCalls
    .filter((call) =>
      call.targetApi.safety === TARGET_API_SAFETY.blocked ||
      call.targetApi.safety === TARGET_API_SAFETY.unknown
    );
  const reviewTargetCalls = targetCalls
    .filter((call) => call.targetApi.safety === TARGET_API_SAFETY.review);
  const disallowedCalls = calls
    .filter((call) => !call.name.startsWith("MKXFORM."))
    .filter((call) => !isAllowedCall(call.name, localFunctions));

  return {
    unsupportedSyntax,
    promiseReturns,
    calls,
    targetCalls,
    domUsages,
    disallowedTargetCalls,
    reviewTargetCalls,
    disallowedCalls
  };
}

function extractUnsupportedMkSyntax(masked, source) {
  const usages = [];
  const asyncPatterns = [
    /\basync\s+function\b/g,
    /\basync\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
    /\basync\s+\*?\s*[A-Za-z_$][\w$]*\s*\(/g
  ];
  for (const pattern of asyncPatterns) {
    for (const match of masked.matchAll(pattern)) {
      usages.push({
        keyword: "async",
        index: match.index,
        snippet: snippetAt(source, match.index)
      });
    }
  }
  if (usages.length) {
    for (const match of masked.matchAll(/\bawait\b/g)) {
      if (isPropertyIdentifier(masked, match.index, match[0].length)) continue;
      usages.push({
        keyword: "await",
        index: match.index,
        snippet: snippetAt(source, match.index)
      });
    }
  }
  return usages.sort((left, right) => left.index - right.index);
}

function extractPromiseReturns(masked, source) {
  const usages = [];
  for (const match of masked.matchAll(/\breturn\b/g)) {
    const expression = returnExpressionAt(masked, match.index + match[0].length);
    if (!/(?:\bPromise\b|\.(?:then|catch|finally)\s*\()/.test(expression)) continue;
    usages.push({ index: match.index, snippet: snippetAt(source, match.index) });
  }
  return usages;
}

function returnExpressionAt(source, start) {
  const stack = [];
  let expression = "";
  const pairs = { "(": ")", "[": "]", "{": "}" };
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (pairs[char]) stack.push(pairs[char]);
    else if (stack.at(-1) === char) stack.pop();
    else if (!stack.length && (char === ";" || char === "}")) break;
    else if (!stack.length && char === "\n") {
      const next = source.slice(index + 1).match(/\S/)?.[0] || "";
      if (next !== ".") break;
    }
    expression += char;
  }
  return expression;
}

function isPropertyIdentifier(source, index, length) {
  const before = source.slice(0, index);
  const after = source.slice(index + length);
  const previous = before.match(/\S(?=\s*$)/)?.[0] || "";
  const next = after.match(/^\s*(\S)/)?.[1] || "";
  if (previous === "." || next === ":") return true;
  if (/\b(?:var|let|const)\s*$/.test(before)) return true;
  return ["{", ","].includes(previous) && [",", "}"].includes(next);
}

/**
 * Literal first-args of MKXFORM.setFieldAttr(...).
 * Whole-row / main-field visibility must use a main field id or layout sourceMarker —
 * never a ${table:...} placeholder or detail-table id.
 */
export function extractSetFieldAttrLiteralTargets(text = "") {
  const source = String(text || "");
  const targets = [];
  const pattern = /MKXFORM\.setFieldAttr\s*\(\s*(["'`])([^"'`]*?)\1/g;
  for (const match of source.matchAll(pattern)) {
    targets.push({
      target: match[2],
      quote: match[1],
      index: match.index,
      snippet: snippetAt(source, match.index)
    });
  }
  return targets;
}

export function buildSetFieldAttrTargetIndex(form = {}) {
  const mainFields = new Set();
  const detailTables = new Set();
  const persistedRowTargets = new Set();
  const secondaryMarkerToPrimary = new Map();

  for (const field of Array.isArray(form.fields) ? form.fields : []) {
    if (!field?.id) continue;
    if (field.type === "detailTable") {
      detailTables.add(field.id);
      continue;
    }
    mainFields.add(field.id);
  }

  for (const row of Array.isArray(form.layout?.mkTree) ? form.layout.mkTree : []) {
    const markers = (Array.isArray(row?.sourceMarkers) ? row.sourceMarkers : [])
      .map((marker) => String(marker || "").trim())
      .filter(Boolean);
    const persistedTarget = markers[0] || String(row?.id || "").trim();
    if (persistedTarget) persistedRowTargets.add(persistedTarget);
    for (const alias of markers.slice(1)) {
      if (!secondaryMarkerToPrimary.has(alias)) {
        secondaryMarkerToPrimary.set(alias, persistedTarget);
      }
    }
  }

  return { mainFields, detailTables, persistedRowTargets, secondaryMarkerToPrimary };
}

export function validateSetFieldAttrTargets(functionText = "", form = {}) {
  const index = buildSetFieldAttrTargetIndex(form);
  const issues = [];

  for (const entry of extractSetFieldAttrCalls(functionText)) {
    if (entry.dynamic) {
      issues.push({
        code: "dynamic_target",
        target: "",
        snippet: entry.snippet,
        message: "MKXFORM.setFieldAttr first argument must be a literal main field id or the persisted layout row target."
      });
      continue;
    }
    const target = entry.target;
    if (/\$\{\s*table\s*:/.test(target) || target.includes("${table:")) {
      issues.push({
        code: "table_placeholder",
        target,
        snippet: entry.snippet,
        message: "MKXFORM.setFieldAttr must target a main field or layout sourceMarker; ${table:...} is only for detail-column APIs."
      });
      continue;
    }
    if (index.detailTables.has(target)) {
      issues.push({
        code: "detail_table_id",
        target,
        snippet: entry.snippet,
        message: "MKXFORM.setFieldAttr must not target a detail-table id; use the layout sourceMarker for whole-container visibility."
      });
      continue;
    }
    if (index.mainFields.has(target) || index.persistedRowTargets.has(target)) {
      continue;
    }
    const primary = index.secondaryMarkerToPrimary.get(target);
    if (primary) {
      issues.push({
        code: "secondary_marker",
        target,
        primary,
        snippet: entry.snippet,
        message: `MKXFORM.setFieldAttr must use the persisted primary sourceMarker "${primary}", not co-located alias "${target}".`
      });
      continue;
    }
    issues.push({
      code: "unresolved",
      target,
      snippet: entry.snippet,
      message: "MKXFORM.setFieldAttr target must resolve to a main field id or layout sourceMarker."
    });
  }

  return issues;
}

function extractSetFieldAttrCalls(text = "") {
  const source = String(text || "");
  const literalByIndex = new Map(
    extractSetFieldAttrLiteralTargets(source).map((entry) => [entry.index, entry])
  );
  const calls = [];
  for (const match of source.matchAll(/MKXFORM\.setFieldAttr\s*\(\s*/g)) {
    const literal = literalByIndex.get(match.index);
    calls.push(literal || {
      dynamic: true,
      index: match.index,
      snippet: snippetAt(source, match.index)
    });
  }
  return calls;
}

export function parseNamedFunctionParams(text = "", name = "") {
  if (!name) return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(text || "").match(new RegExp(`\\bfunction\\s+${escaped}\\s*\\(([^)]*)\\)`));
  if (!match) return undefined;
  return match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function hasExplicitBeforeSubmitReturn(text = "") {
  return /\breturn\s+(?:true|false)\b/.test(text);
}

export function handlesDraftContext(text = "") {
  return /\bcontext\s*(?:&&\s*)?(?:\.\s*isDraft|\[\s*["']isDraft["']\s*\])/.test(text);
}

export function scriptTargetApiSummary() {
  return {
    allowedPrefixes: ["MKXFORM."],
    catalog: targetApiCatalogSummary(),
    allowedFunctions: [...ALLOWED_SCRIPT_TARGET_FUNCTIONS].sort(),
    jsMethodsCatalog: {
      id: JS_METHOD_CATALOG.id,
      version: JS_METHOD_CATALOG.version,
      globals: [...ALLOWED_BUILTIN_CALLS],
      staticMethods: [...ALLOWED_STATIC_METHODS],
      instanceMethods: [...ALLOWED_INSTANCE_METHODS]
    }
  };
}

function eventSupported(entry, event, scope) {
  const supportedEvents = entry.events || [];
  if (supportedEvents.includes(event)) {
    return {
      status: "supported",
      componentId: entry.componentId,
      event,
      scope,
      supportedEvents,
      evidence: entry.evidence
    };
  }
  return {
    status: entry.status === "unknown" ? "unknown" : "unsupported",
    componentId: entry.componentId,
    event,
    scope,
    supportedEvents,
    evidence: entry.evidence,
    reason: supportedEvents.length
      ? "event is not listed for this component"
      : "component has no supported control events"
  };
}

function extractCalls(masked, source, localFunctions) {
  const calls = [];
  const pattern = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;
  for (const match of masked.matchAll(pattern)) {
    const name = match[1];
    const previous = masked[match.index - 1] || "";
    if (previous === ".") continue;
    if (["if", "for", "while", "switch", "catch", "function", "return", "typeof", "new"].includes(name)) continue;
    if (isFunctionDeclaration(masked, match.index)) continue;
    calls.push({ name, index: match.index, snippet: snippetAt(source, match.index) });
  }
  return calls.filter((call) => !localFunctions.has(call.name));
}

function extractLocalFunctionNames(text = "") {
  const names = new Set();
  for (const match of text.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*function\b/g)) {
    names.add(match[1]);
  }
  return names;
}

function extractDomUsages(masked, source) {
  const patterns = [
    /\bdocument\s*\./g,
    /\bwindow\s*\.\s*document\b/g,
    /\b(?:getElementById|getElementsByName|getElementsByTagName|getElementsByClassName|querySelector|querySelectorAll)\s*\(/g,
    /\.\s*(?:setAttribute|getAttribute|removeAttribute)\s*\(/g,
    /\.\s*(?:style|className|classList)\b/g,
    /\bHTML[A-Za-z]*Element\b/g
  ];
  const usages = [];
  for (const pattern of patterns) {
    for (const match of masked.matchAll(pattern)) {
      usages.push({
        pattern: pattern.source,
        index: match.index,
        snippet: snippetAt(source, match.index)
      });
    }
  }
  usages.sort((left, right) => left.index - right.index);
  return usages;
}

function isAllowedCall(name, localFunctions) {
  if (localFunctions.has(name)) return true;
  if (name.startsWith("MKXFORM.")) return isExecutableTargetApi(name);
  if (name.includes(".") && ALLOWED_INSTANCE_METHODS.has(name.slice(name.lastIndexOf(".") + 1))) return true;
  if (ALLOWED_BUILTIN_CALLS.has(name)) return true;
  return ALLOWED_STATIC_METHODS.has(name);
}

function catalogNameSet(entries = []) {
  return new Set(
    (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry?.status === "supported")
      .map((entry) => entry.name)
      .filter(Boolean)
  );
}

function isFunctionDeclaration(text, index) {
  return /\bfunction\s+$/.test(text.slice(Math.max(0, index - 20), index));
}

function maskStringsAndComments(text) {
  let result = "";
  let index = 0;
  let mode = "";
  let quote = "";

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (!mode && char === "/" && next === "/") {
      mode = "line-comment";
      result += "  ";
      index += 2;
      continue;
    }
    if (!mode && char === "/" && next === "*") {
      mode = "block-comment";
      result += "  ";
      index += 2;
      continue;
    }
    if (!mode && ["\"", "'", "`"].includes(char)) {
      mode = "string";
      quote = char;
      result += " ";
      index += 1;
      continue;
    }

    if (mode === "line-comment") {
      result += char === "\n" ? "\n" : " ";
      if (char === "\n") mode = "";
      index += 1;
      continue;
    }
    if (mode === "block-comment") {
      result += char === "\n" ? "\n" : " ";
      if (char === "*" && next === "/") {
        result += " ";
        index += 2;
        mode = "";
      } else {
        index += 1;
      }
      continue;
    }
    if (mode === "string") {
      if (char === "\\" && index + 1 < text.length) {
        result += "  ";
        index += 2;
        continue;
      }
      result += char === "\n" ? "\n" : " ";
      if (char === quote) {
        mode = "";
        quote = "";
      }
      index += 1;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

function snippetAt(text, index) {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + 140);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}
