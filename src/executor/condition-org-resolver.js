/**
 * Resolve organization names/numbers referenced by address-field branch conditions.
 *
 * Source Landray often writes:
 * - `$字符串.包含$($addressField$, "部门名")`
 * - `$addressField$.fdNo.equals("ORG_NO")`
 *
 * NewOA address predicates need concrete org objects (`belongany` / `notbelong`),
 * so names and fdNo codes are resolved through the read-only org search API before
 * workflow projection.
 *
 * On allowed temporary-fallback origins (SIT and Shanghai Electric POC/dev), unresolved
 * names/fdNos fall back to a known department target and are revalidated before use.
 */

import { allowsTemporaryOrgFallbacks } from "./newoa-client.js";
import {
  DEFAULT_TEMPORARY_ORG_FALLBACKS,
  resolveTemporaryOrgFallbacks
} from "./temporary-org-fallbacks.js";

const CONDITION_ORG_RESOLUTION_STAGE = "resolveConditionOrgs";

/** Department fallback for unresolved address-field condition org names/fdNos. */
export const SIT_CONDITION_ORG_FALLBACKS = Object.freeze([
  DEFAULT_TEMPORARY_ORG_FALLBACKS.organization
]);

export class ConditionOrgResolutionError extends Error {
  constructor(issues, options = {}) {
    const count = issues.length;
    super(
      `Could not uniquely resolve ${count} workflow condition ${count === 1 ? "organization" : "organizations"} in current NewOA.`,
      options.cause ? { cause: options.cause } : undefined
    );
    this.name = "ConditionOrgResolutionError";
    this.stage = CONDITION_ORG_RESOLUTION_STAGE;
    this.code = "workflow.condition_org_resolution_failed";
    this.issues = issues;
  }
}

export async function resolveConditionOrgs(dsl, { client, targetBaseUrl, fallbackFdIds } = {}) {
  const nextDsl = structuredClone(dsl);
  const configuredOrganizationFallback = resolveTemporaryOrgFallbacks(fallbackFdIds).organization;
  const names = collectAddressConditionOrgNames(nextDsl);
  const fdNos = collectAddressConditionOrgFdNos(nextDsl);
  if (names.size === 0 && fdNos.size === 0) {
    return {
      dsl: nextDsl,
      resolvedCount: 0,
      nameCount: 0,
      fdNoCount: 0,
      unresolvedNames: [],
      unresolvedFdNos: [],
      fallbackCount: 0,
      fallbackNames: [],
      fallbackFdNos: []
    };
  }

  if (typeof client?.searchOrg !== "function") {
    throw new ConditionOrgResolutionError([{
      reason: "missing_client_capability",
      message: "condition organization resolution requires client.searchOrg"
    }]);
  }

  const searchCache = new Map();
  const conditionOrgByName = {};
  const conditionOrgByFdNo = {};
  const unresolvedNames = [];
  const unresolvedFdNos = [];
  const allowSitFallback = allowsTemporaryOrgFallbacks(targetBaseUrl);

  for (const name of names) {
    try {
      const candidates = uniqueCandidates(await searchCurrentCandidates(name, 2, client, searchCache));
      const match = pickOrgCandidate(name, candidates);
      if (!match) {
        unresolvedNames.push(name);
        continue;
      }
      conditionOrgByName[name] = normalizeOrgValue(match);
    } catch (error) {
      throw new ConditionOrgResolutionError([{
        reason: "search_failed",
        name,
        message: error instanceof Error ? error.message : String(error)
      }], { cause: error });
    }
  }

  for (const fdNo of fdNos) {
    try {
      const candidates = uniqueCandidates(await searchCurrentCandidates(fdNo, 2, client, searchCache));
      const match = pickOrgCandidateByFdNo(fdNo, candidates);
      if (!match) {
        unresolvedFdNos.push(fdNo);
        continue;
      }
      conditionOrgByFdNo[fdNo] = normalizeOrgValue(match);
    } catch (error) {
      throw new ConditionOrgResolutionError([{
        reason: "search_failed",
        fdNo,
        message: error instanceof Error ? error.message : String(error)
      }], { cause: error });
    }
  }

  const fallbackNames = [];
  const fallbackFdNos = [];
  if (allowSitFallback && (unresolvedNames.length || unresolvedFdNos.length)) {
    const assignments = [
      ...unresolvedNames.map((name) => ({
        kind: "name",
        key: name,
        fallback: configuredOrganizationFallback
      })),
      ...unresolvedFdNos.map((fdNo) => ({
        kind: "fdNo",
        key: fdNo,
        fallback: configuredOrganizationFallback
      }))
    ];
    const validatedFallbacks = await validateSitConditionOrgFallbacks(
      client,
      assignments.map((assignment) => assignment.fallback)
    );
    assignments.forEach(({ kind, key, fallback }) => {
      const current = validatedFallbacks.get(fallback.fdId);
      const normalized = normalizeOrgValue(current);
      if (kind === "name") {
        conditionOrgByName[key] = normalized;
        fallbackNames.push(key);
      } else {
        conditionOrgByFdNo[key] = {
          ...normalized,
          fdNo: key
        };
        fallbackFdNos.push(key);
      }
    });
    unresolvedNames.length = 0;
    unresolvedFdNos.length = 0;
  }

  if (unresolvedFdNos.length) {
    throw new ConditionOrgResolutionError(unresolvedFdNos.map((fdNo) => ({
      reason: "fd_no_not_found",
      fdNo,
      message: `Organization number could not be uniquely resolved: ${fdNo}`
    })));
  }

  nextDsl.runtime = {
    ...(nextDsl.runtime && typeof nextDsl.runtime === "object" ? nextDsl.runtime : {}),
    conditionOrgByName,
    conditionOrgByFdNo
  };

  return {
    dsl: nextDsl,
    resolvedCount:
      Object.keys(conditionOrgByName).length - fallbackNames.length +
      Object.keys(conditionOrgByFdNo).length - fallbackFdNos.length,
    nameCount: names.size,
    fdNoCount: fdNos.size,
    unresolvedNames,
    unresolvedFdNos,
    fallbackCount: fallbackNames.length + fallbackFdNos.length,
    fallbackNames,
    fallbackFdNos
  };
}

export function collectAddressConditionOrgNames(dsl) {
  const names = new Set();
  const formFieldById = buildFormFieldIndex(dsl?.form);
  const edges = Array.isArray(dsl?.workflow?.edges) ? dsl.workflow.edges : [];

  for (const edge of edges) {
    const condition = edgeConditionText(edge);
    for (const match of String(condition || "").matchAll(
      /\$字符串\.包含\$\(\s*\$([^$]+)\$\s*,\s*(["'])([\s\S]*?)\2\s*\)/g
    )) {
      const fieldId = String(match[1] || "").trim();
      const value = match[3];
      const field = formFieldById.get(fieldId);
      if (!isAddressField(field) || !String(value || "").trim()) continue;
      names.add(value);
    }
  }

  return names;
}

export function collectAddressConditionOrgFdNos(dsl) {
  const fdNos = new Set();
  const formFieldById = buildFormFieldIndex(dsl?.form);
  const edges = Array.isArray(dsl?.workflow?.edges) ? dsl.workflow.edges : [];

  for (const edge of edges) {
    const condition = edgeConditionText(edge);
    for (const match of String(condition || "").matchAll(
      /\$([^$]+)\$\s*\.\s*fdNo\s*\.\s*equals\s*\(\s*["']([^"']+)["']\s*\)/gi
    )) {
      const fieldId = String(match[1] || "").trim();
      const fdNo = String(match[2] || "").trim();
      const field = formFieldById.get(fieldId);
      if (!isAddressField(field) || !fdNo) continue;
      fdNos.add(fdNo);
    }
  }

  return fdNos;
}

function pickOrgCandidate(name, candidates) {
  const normalized = normalizeText(name);
  const exact = candidates.filter((candidate) => normalizeText(candidate.fdName) === normalized);
  if (exact.length === 0) return undefined;

  const preferredTypes = new Set(["1", "2"]);
  const typed = exact.filter((candidate) => preferredTypes.has(normalizeOrgType(candidate.fdOrgType)));
  const pool = typed.length ? typed : exact;
  if (pool.length === 1) return pool[0];

  const depts = pool.filter((candidate) => normalizeOrgType(candidate.fdOrgType) === "2");
  if (depts.length === 1) return depts[0];
  return undefined;
}

function pickOrgCandidateByFdNo(fdNo, candidates) {
  const key = String(fdNo || "").trim();
  if (!key) return undefined;
  const exact = candidates.filter((candidate) => String(candidate.fdNo || "").trim() === key);
  const candidatesWithOtherFdNos = candidates.filter((candidate) => String(candidate.fdNo || "").trim());
  if (exact.length === 0 && candidatesWithOtherFdNos.length > 0) return undefined;
  const pool = exact.length ? exact : candidates;
  if (pool.length === 0) return undefined;

  const preferredTypes = new Set(["1", "2"]);
  const typed = pool.filter((candidate) => preferredTypes.has(normalizeOrgType(candidate.fdOrgType)));
  const preferred = typed.length ? typed : pool;
  if (preferred.length === 1) return preferred[0];

  const depts = preferred.filter((candidate) => normalizeOrgType(candidate.fdOrgType) === "2");
  if (depts.length === 1) return depts[0];
  // When searching by fdNo, ACCURATE mode often returns a unique org even without fdNo echo.
  if (preferred.length === 1) return preferred[0];
  if (pool.length === 1) return pool[0];
  return undefined;
}

function searchCurrentCandidates(key, sourceOrgType, client, searchCache) {
  const cacheKey = `${sourceOrgType}\0${key}`;
  let candidatesPromise = searchCache.get(cacheKey);
  if (!candidatesPromise) {
    candidatesPromise = Promise.resolve(client.searchOrg(key, sourceOrgType));
    searchCache.set(cacheKey, candidatesPromise);
  }
  return candidatesPromise;
}

function uniqueCandidates(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Map();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const fdId = String(candidate.fdId || "").trim();
    const fdName = String(candidate.fdName || "").trim();
    if (!fdId || !fdName) continue;
    if (!unique.has(fdId)) unique.set(fdId, candidate);
  }
  return [...unique.values()];
}

async function validateSitConditionOrgFallbacks(client, fallbacks) {
  const targets = [...new Set(fallbacks.map((fallback) => String(fallback.fdId || "").trim()).filter(Boolean))];
  if (typeof client?.getElementInfo !== "function") {
    throw new ConditionOrgResolutionError([{
      reason: "fallback_validation_unavailable",
      targets,
      message: "condition organization fallback requires client.getElementInfo"
    }]);
  }

  let candidates;
  try {
    candidates = uniqueCandidates(await client.getElementInfo(targets));
  } catch (error) {
    throw new ConditionOrgResolutionError([{
      reason: "fallback_validation_failed",
      targets,
      message: error instanceof Error ? error.message : String(error)
    }], { cause: error });
  }

  const byId = new Map(candidates.map((candidate) => [String(candidate.fdId), candidate]));
  const issues = [];
  for (const targetId of targets) {
    const candidate = byId.get(targetId);
    if (!candidate) {
      issues.push({
        reason: "fallback_target_not_found",
        targetId,
        message: "condition organization fallback target is not available in current NewOA"
      });
      continue;
    }
    if (normalizeOrgType(candidate.fdOrgType) !== "2") {
      issues.push({
        reason: "fallback_target_not_department",
        targetId,
        targetOrgType: candidate.fdOrgType,
        message: "condition organization fallback target must be a current department"
      });
    }
  }
  if (issues.length) throw new ConditionOrgResolutionError(issues);
  return byId;
}

function normalizeOrgValue(value) {
  return {
    fdId: String(value.fdId),
    fdName: String(value.fdName),
    fdOrgType: Number(value.fdOrgType) || 2,
    ...(value.fdNo ? { fdNo: String(value.fdNo) } : {})
  };
}

function buildFormFieldIndex(form) {
  const index = new Map();
  for (const field of Array.isArray(form?.fields) ? form.fields : []) {
    if (field?.id) index.set(field.id, field);
  }
  return index;
}

function edgeConditionText(edge) {
  if (edge?.condition && typeof edge.condition === "object") {
    return edge.condition.targetText || edge.condition.sourceText || edge.condition.displayText || "";
  }
  return edge?.condition || edge?.displayCondition || "";
}

export function isAddressField(field) {
  if (!field || typeof field !== "object") return false;
  const componentId = String(field.componentId || "").toLowerCase();
  if (componentId.includes("address")) return true;
  const designerType = String(field.sourceProps?.designerType || "").toLowerCase();
  if (designerType === "address") return true;
  const metadataKind = String(field.sourceProps?.metadataKind || "").toLowerCase();
  return metadataKind === "element";
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function normalizeOrgType(value) {
  const text = String(value ?? "").trim();
  return text ? text : "";
}
