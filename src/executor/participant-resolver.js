import { allowsTemporaryOrgFallbacks } from "./newoa-client.js";
import {
  DEFAULT_TEMPORARY_ORG_FALLBACKS,
  resolveTemporaryOrgFallbacks
} from "./temporary-org-fallbacks.js";

const PARTICIPANT_RESOLUTION_STAGE = "resolveWorkflowParticipants";
const SIT_FALLBACK_REASONS = new Set(["not_found", "missing_source_evidence"]);

/** NewOA orgType: 1 机构, 2 部门, 4 岗位, 8 人员, 16 群组, 32 角色, 128 公共岗位, 256 身份 */
export const SIT_PARTICIPANT_FALLBACKS = Object.freeze({
  person: DEFAULT_TEMPORARY_ORG_FALLBACKS.person,
  post: DEFAULT_TEMPORARY_ORG_FALLBACKS.post,
  group: DEFAULT_TEMPORARY_ORG_FALLBACKS.group,
  department: DEFAULT_TEMPORARY_ORG_FALLBACKS.organization
});

export class ParticipantResolutionError extends Error {
  constructor(issues, options = {}) {
    const count = issues.length;
    super(
      `Could not uniquely resolve ${count} explicit workflow participant ${count === 1 ? "identity" : "identities"} in current NewOA.`,
      options.cause ? { cause: options.cause } : undefined
    );
    this.name = "ParticipantResolutionError";
    this.stage = PARTICIPANT_RESOLUTION_STAGE;
    this.code = "workflow.participant_resolution_failed";
    this.issues = issues;
  }
}

export async function resolveWorkflowParticipants(dsl, { client, targetBaseUrl, fallbackFdIds } = {}) {
  const nextDsl = structuredClone(dsl);
  const configuredFallbacks = resolveTemporaryOrgFallbacks(fallbackFdIds);
  const elementCache = new Map();
  const configuredFormulaFallback = await materializeConfiguredPersonFallbacks(nextDsl, {
    client,
    targetBaseUrl,
    configuredFallbacks,
    elementCache
  });
  const identities = collectParticipantIdentities(nextDsl);
  if (identities.size === 0) {
    return {
      dsl: nextDsl,
      resolvedCount: 0,
      identityCount: 0,
      fallbackCount: 0,
      fallbackIdentityCount: 0
    };
  }
  const capabilityIssues = requiredClientCapabilityIssues(identities, client);
  if (capabilityIssues.length) {
    throw new ParticipantResolutionError(capabilityIssues);
  }

  const searchCache = new Map();
  const resolutions = await mapWithConcurrency(
    [...identities.values()],
    1,
    async (identity) => {
      try {
        return await resolveIdentity(identity, client, { searchCache, elementCache });
      } catch (error) {
        if (error instanceof ParticipantResolutionError) throw error;
        throw new ParticipantResolutionError([{
          reason: identity.kind === "target" ? "target_validation_failed" : "search_failed",
          name: identity.member.name,
          sourceId: identity.member.sourceId,
          paths: identity.paths,
          message: error instanceof Error ? error.message : String(error)
        }], { cause: error });
      }
    }
  );

  const unresolvedResolutions = resolutions.filter((resolution) => resolution.issue);
  const fallbackResolutions = allowsTemporaryOrgFallbacks(targetBaseUrl)
    ? unresolvedResolutions.filter(isSitFallbackEligible)
    : [];
  const fallbackResolutionSet = new Set(fallbackResolutions);
  const blockingResolutions = unresolvedResolutions.filter((resolution) => !fallbackResolutionSet.has(resolution));
  if (blockingResolutions.length) {
    throw new ParticipantResolutionError(unresolvedResolutions.map((resolution) => resolution.issue));
  }
  let fallbackTargetsByOrgType = configuredFormulaFallback.targetsByOrgType;
  if (fallbackResolutions.length) {
    const validatedTargets = await resolveSitFallbackTargets(
      client,
      elementCache,
      fallbackResolutions,
      configuredFallbacks
    );
    for (const resolution of fallbackResolutions) {
      const fallback = temporaryFallbackForSourceOrgType(
        resolution.member?.sourceOrgType,
        configuredFallbacks
      );
      const target = validatedTargets.get(fallbackValidationKey(fallback));
      resolution.target = target;
      resolution.fallback = true;
      resolution.fallbackSpec = fallback;
      resolution.issue = undefined;
    }
    fallbackTargetsByOrgType = {
      ...fallbackTargetsByOrgType,
      ...Object.fromEntries(
      [...new Map(
        fallbackResolutions.map((resolution) => {
          const sourceOrgType = normalizeOrgType(resolution.member?.sourceOrgType) || "8";
          return [sourceOrgType, {
            sourceOrgType: Number(sourceOrgType),
            targetFdId: resolution.fallbackSpec.fdId,
            targetOrgType: resolution.fallbackSpec.fdOrgType,
            targetName: resolution.target.fdName
          }];
        })
      ).entries()].sort(([left], [right]) => Number(left) - Number(right))
      )
    };
  }

  const issues = resolutions.flatMap((resolution) => resolution.issue ? [resolution.issue] : []);
  if (issues.length) {
    throw new ParticipantResolutionError(issues);
  }

  let resolvedCount = 0;
  let fallbackCount = configuredFormulaFallback.referenceCount;
  for (const resolution of resolutions) {
    for (const member of resolution.members) {
      member.id = resolution.target.fdId;
      member.name = resolution.target.fdName;
      member.targetOrgType = resolution.target.fdOrgType;
      if (resolution.kind === "source") resolvedCount += 1;
      if (resolution.fallback) fallbackCount += 1;
    }
  }
  deduplicateResolvedParticipantCollections(nextDsl);

  const fallbackTargetIds = [...new Set([
    ...configuredFormulaFallback.targetFdIds,
    ...fallbackResolutions.map((resolution) => resolution.fallbackSpec.fdId)
  ])].sort();

  return {
    dsl: nextDsl,
    resolvedCount,
    identityCount: identities.size,
    fallbackCount,
    fallbackIdentityCount: configuredFormulaFallback.identityCount + fallbackResolutions.length,
    ...(fallbackCount ? {
      fallbackTargetIds,
      fallbackTargetsByOrgType,
      ...(fallbackTargetIds.length === 1 ? { fallbackTargetId: fallbackTargetIds[0] } : {})
    } : {})
  };
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  };
  const workerCount = Math.min(limit, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function materializeConfiguredPersonFallbacks(dsl, {
  client,
  targetBaseUrl,
  configuredFallbacks,
  elementCache
}) {
  const nodes = Array.isArray(dsl?.workflow?.nodes) ? dsl.workflow.nodes : [];
  const requests = nodes.flatMap((node, nodeIndex) => {
    if (node?.participants?.mode !== "configured_person_fallback") return [];
    return [{
      node,
      member: { sourceOrgType: 8 },
      paths: [`/workflow/nodes/${nodeIndex}/participants`]
    }];
  });
  if (requests.length === 0) {
    return { referenceCount: 0, identityCount: 0, targetFdIds: [], targetsByOrgType: {} };
  }
  if (!allowsTemporaryOrgFallbacks(targetBaseUrl)) {
    throw new ParticipantResolutionError(requests.map((request) => ({
      reason: "configured_fallback_origin_forbidden",
      fallbackKind: "person",
      paths: request.paths,
      message: "Configured formula participant fallbacks are restricted to the allowed SIT/dev origins."
    })));
  }

  const validatedTargets = await resolveSitFallbackTargets(
    client,
    elementCache,
    requests,
    configuredFallbacks
  );
  const fallback = configuredFallbacks.person;
  const target = validatedTargets.get(fallbackValidationKey(fallback));
  for (const request of requests) {
    request.node.participants = {
      mode: "explicit",
      members: [{
        id: target.fdId,
        name: target.fdName,
        type: "user_or_org",
        targetOrgType: fallback.fdOrgType
      }]
    };
  }

  return {
    referenceCount: requests.length,
    identityCount: 1,
    targetFdIds: [fallback.fdId],
    targetsByOrgType: {
      "8": {
        sourceOrgType: 8,
        targetFdId: fallback.fdId,
        targetOrgType: fallback.fdOrgType,
        targetName: target.fdName
      }
    }
  };
}

function deduplicateResolvedParticipantCollections(dsl) {
  const nodes = Array.isArray(dsl?.workflow?.nodes) ? dsl.workflow.nodes : [];
  for (const node of nodes) {
    const participants = node?.participants;
    if (!participants || typeof participants !== "object") continue;
    for (const collectionName of ["members", "alternativeMembers"]) {
      if (!Array.isArray(participants[collectionName])) continue;
      const seen = new Set();
      participants[collectionName] = participants[collectionName].filter((member) => {
        const id = normalizeText(member?.id);
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }
  }
}

function isSitFallbackEligible(resolution) {
  if (resolution.kind !== "source" || !SIT_FALLBACK_REASONS.has(resolution.issue?.reason)) return false;
  if (resolution.issue.reason === "not_found") return true;
  return Array.isArray(resolution.issue.missing) &&
    resolution.issue.missing.length > 0 &&
    resolution.issue.missing.every((field) => field === "sourceParentName");
}

function temporaryFallbackForSourceOrgType(sourceOrgType, fallbacks) {
  const normalized = normalizeOrgType(sourceOrgType);
  const bySourceOrgType = {
    1: fallbacks.organization,
    2: fallbacks.organization,
    4: fallbacks.post,
    8: fallbacks.person,
    16: fallbacks.group,
    32: fallbacks.person,
    128: fallbacks.post,
    256: fallbacks.person
  };
  return bySourceOrgType[normalized] || fallbacks.person;
}

async function resolveSitFallbackTargets(client, elementCache, resolutions, fallbacksByKind) {
  const paths = resolutions.flatMap((resolution) => resolution.paths);
  const fallbacks = [...new Map(
    resolutions.map((resolution) => {
      const fallback = temporaryFallbackForSourceOrgType(
        resolution.member?.sourceOrgType,
        fallbacksByKind
      );
      return [fallbackValidationKey(fallback), fallback];
    })
  ).values()].sort((left, right) => left.fdId.localeCompare(right.fdId));
  const targetIds = [...new Set(fallbacks.map((fallback) => fallback.fdId))];

  if (typeof client?.getElementInfo !== "function") {
    throw new ParticipantResolutionError(fallbacks.map((fallback) => ({
      reason: "fallback_validation_unavailable",
      targetId: fallback.fdId,
      paths,
      message: "NewOA client does not provide fallback participant validation."
    })));
  }

  try {
    let candidatesPromise = elementCache.get(targetIds.join("\0"));
    if (!candidatesPromise) {
      candidatesPromise = Promise.resolve(client.getElementInfo(targetIds));
      elementCache.set(targetIds.join("\0"), candidatesPromise);
      for (const targetId of targetIds) {
        if (!elementCache.has(targetId)) {
          elementCache.set(targetId, candidatesPromise.then((candidates) => (
            currentElementCandidates(candidates).filter((candidate) => normalizeText(candidate.fdId) === targetId)
          )));
        }
      }
    }
    const candidates = currentElementCandidates(await candidatesPromise);
    const byId = new Map(candidates.map((candidate) => [normalizeText(candidate.fdId), candidate]));
    const validated = new Map();
    const issues = [];

    for (const fallback of fallbacks) {
      const candidate = byId.get(fallback.fdId);
      if (!candidate) {
        issues.push({
          reason: "fallback_target_not_found",
          targetId: fallback.fdId,
          paths
        });
        continue;
      }
      if (normalizeOrgType(candidate.fdOrgType) !== String(fallback.fdOrgType)) {
        issues.push({
          reason: "fallback_target_type_mismatch",
          targetId: fallback.fdId,
          targetOrgType: candidate.fdOrgType,
          expectedOrgType: fallback.fdOrgType,
          paths
        });
        continue;
      }
      validated.set(fallbackValidationKey(fallback), {
        ...candidate,
        fdName: normalizeText(candidate.fdName) || fallback.fdName,
        fdOrgType: fallback.fdOrgType
      });
    }
    if (issues.length) throw new ParticipantResolutionError(issues);
    return validated;
  } catch (error) {
    if (error instanceof ParticipantResolutionError) throw error;
    throw new ParticipantResolutionError([{
      reason: "fallback_validation_failed",
      targetIds,
      paths,
      message: error instanceof Error ? error.message : String(error)
    }], { cause: error });
  }
}

function fallbackValidationKey(fallback) {
  return `${fallback.fdId}\0${fallback.fdOrgType}`;
}

function collectParticipantIdentities(dsl) {
  const identities = new Map();
  const nodes = Array.isArray(dsl?.workflow?.nodes) ? dsl.workflow.nodes : [];

  nodes.forEach((node, nodeIndex) => {
    const participants = node?.participants;
    if (!participants || typeof participants !== "object") return;
    for (const collectionName of ["members", "alternativeMembers"]) {
      const members = participants[collectionName];
      if (!Array.isArray(members)) continue;
      members.forEach((member, memberIndex) => {
        if (!member || typeof member !== "object") return;
        const kind = hasSourceEvidence(member) ? "source" : "target";
        const key = participantIdentityKey(member, kind);
        const path = `/workflow/nodes/${nodeIndex}/participants/${collectionName}/${memberIndex}`;
        const current = identities.get(key);
        if (current) {
          current.members.push(member);
          current.paths.push(path);
          return;
        }
        identities.set(key, {
          kind,
          member,
          members: [member],
          paths: [path]
        });
      });
    }
  });

  return identities;
}

async function resolveIdentity(identity, client, caches) {
  if (identity.kind === "target") {
    return validateCurrentTargetIdentity(identity, client, caches.elementCache);
  }

  const evidenceIssue = validateSourceEvidence(identity);
  if (evidenceIssue) return { ...identity, issue: evidenceIssue };

  const name = normalizeText(identity.member.name);
  const sourceOrgType = normalizeOrgType(identity.member.sourceOrgType);
  const sourceLoginName = normalizeText(identity.member.sourceLoginName);
  if (sourceOrgType === "8" && sourceLoginName) {
    const loginCandidates = uniqueCurrentCandidates(
      await searchCurrentCandidates(sourceLoginName, Number(sourceOrgType), client, caches.searchCache)
    );
    const loginMatches = matchPersonLoginCandidates(identity.member, loginCandidates);
    if (loginMatches.length > 0) {
      return resolutionFromMatches(identity, loginMatches);
    }
  }

  const searchName = participantSearchName(identity.member, sourceOrgType);
  const candidates = uniqueCurrentCandidates(
    await searchCurrentCandidates(searchName, Number(sourceOrgType), client, caches.searchCache)
  );
  const matches = matchCurrentCandidates(identity.member, candidates);
  return resolutionFromMatches(identity, matches);
}

async function validateCurrentTargetIdentity(identity, client, elementCache) {
  const targetId = normalizeText(identity.member.id);
  if (!targetId) {
    return {
      ...identity,
      issue: {
        reason: "missing_target_id",
        name: identity.member.name,
        paths: identity.paths
      }
    };
  }

  let candidatesPromise = elementCache.get(targetId);
  if (!candidatesPromise) {
    candidatesPromise = Promise.resolve(client.getElementInfo([targetId]));
    elementCache.set(targetId, candidatesPromise);
  }
  const candidates = currentElementCandidates(await candidatesPromise);
  if (candidates.length === 1 && normalizeText(candidates[0].fdId) === targetId) {
    return {
      ...identity,
      target: candidates[0]
    };
  }

  const hasTarget = candidates.some((candidate) => normalizeText(candidate.fdId) === targetId);
  return {
    ...identity,
    issue: {
      reason: candidates.length > 1 && hasTarget ? "ambiguous" : "not_found",
      name: identity.member.name,
      targetId,
      paths: identity.paths,
      candidateIds: candidates.map((candidate) => candidate.fdId)
    }
  };
}

function resolutionFromMatches(identity, matches) {
  if (matches.length === 1) {
    return {
      ...identity,
      target: matches[0]
    };
  }

  return {
    ...identity,
    issue: {
      reason: matches.length === 0 ? "not_found" : "ambiguous",
      name: identity.member.name,
      sourceId: identity.member.sourceId,
      sourceOrgType: identity.member.sourceOrgType,
      sourceParentName: identity.member.sourceParentName,
      paths: identity.paths,
      candidateIds: matches.map((candidate) => candidate.fdId)
    }
  };
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

function validateSourceEvidence(identity) {
  const member = identity.member;
  const sourceOrgType = normalizeOrgType(member.sourceOrgType);
  const missing = [];
  if (!normalizeText(member.name)) missing.push("name");
  if (!sourceOrgType) missing.push("sourceOrgType");

  const personHasLogin = sourceOrgType === "8" && normalizeText(member.sourceLoginName);
  if (!personHasLogin && !normalizeText(member.sourceParentName)) {
    missing.push("sourceParentName");
  }
  if (missing.length === 0) return undefined;

  return {
    reason: "missing_source_evidence",
    name: member.name,
    sourceId: member.sourceId,
    paths: identity.paths,
    missing
  };
}

function matchCurrentCandidates(member, candidates) {
  const sourceOrgType = normalizeOrgType(member.sourceOrgType);
  const sameType = candidates.filter((candidate) => normalizeOrgType(candidate.fdOrgType) === sourceOrgType);

  if (sourceOrgType === "8") {
    const loginMatches = matchPersonLoginCandidates(member, sameType);
    if (loginMatches.length > 0) return loginMatches;
  }

  const sourceName = normalizeText(member.name);
  const sourceLeafName = participantSearchName(member, sourceOrgType);
  const sourceParentName = normalizeText(member.sourceParentName);
  if (!sourceName || !sourceParentName) return [];
  return sameType.filter((candidate) => (
    [sourceName, sourceLeafName].includes(normalizeText(candidate.fdName)) &&
    parentNameMatches(sourceParentName, candidateParentName(candidate))
  ));
}

function participantSearchName(member, sourceOrgType) {
  const name = normalizeText(member?.name);
  if (!["4", "32", "128"].includes(normalizeOrgType(sourceOrgType))) return name;
  const separatorIndex = name.lastIndexOf("_");
  return separatorIndex >= 0 ? normalizeText(name.slice(separatorIndex + 1)) || name : name;
}

function parentNameMatches(sourceParentName, candidateValue) {
  const source = normalizeText(sourceParentName);
  const candidate = normalizeText(candidateValue);
  if (!source || !candidate) return false;
  return candidate === source ||
    candidate.endsWith(`/${source}`) ||
    candidate.endsWith(`\\${source}`);
}

function matchPersonLoginCandidates(member, candidates) {
  const sourceLoginName = normalizeText(member.sourceLoginName);
  if (!sourceLoginName) return [];
  return candidates.filter((candidate) => (
    normalizeOrgType(candidate.fdOrgType) === "8" &&
    [candidate.fdLoginName, candidate.fdNo]
      .some((value) => normalizeText(value) === sourceLoginName)
  ));
}

function uniqueCurrentCandidates(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Map();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const fdId = normalizeText(candidate.fdId);
    const fdName = normalizeText(candidate.fdName);
    if (!fdId || !fdName) continue;
    if (!unique.has(fdId)) unique.set(fdId, candidate);
  }
  return [...unique.values()];
}

function currentElementCandidates(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate) => (
    candidate &&
    typeof candidate === "object" &&
    normalizeText(candidate.fdId) &&
    normalizeText(candidate.fdName) &&
    normalizeOrgType(candidate.fdOrgType)
  ));
}

function candidateParentName(candidate) {
  return candidate.fdParentName ??
    candidate.parentName ??
    candidate.hbmParent?.fdName ??
    candidate.fdParent?.fdName ??
    "";
}

function participantIdentityKey(member, kind) {
  if (kind === "target") {
    return JSON.stringify(["target", normalizeText(member.id)]);
  }
  return JSON.stringify([
    "source",
    normalizeText(member.sourceId),
    normalizeText(member.name),
    normalizeOrgType(member.sourceOrgType),
    normalizeText(member.sourceOrgClass),
    normalizeText(member.sourceParentName),
    normalizeText(member.sourceLoginName)
  ]);
}

function hasSourceEvidence(member) {
  return [
    "sourceId",
    "sourceOrgType",
    "sourceOrgClass",
    "sourceParentName",
    "sourceLoginName"
  ].some((key) => Object.hasOwn(member, key));
}

function requiredClientCapabilityIssues(identities, client) {
  const issues = [];
  const values = [...identities.values()];
  if (values.some((identity) => identity.kind === "source") && typeof client?.searchOrg !== "function") {
    issues.push({
      reason: "search_unavailable",
      message: "NewOA client does not provide current organization search.",
      paths: values.filter((identity) => identity.kind === "source").flatMap((identity) => identity.paths)
    });
  }
  if (values.some((identity) => identity.kind === "target") && typeof client?.getElementInfo !== "function") {
    issues.push({
      reason: "target_validation_unavailable",
      message: "NewOA client does not provide current organization element validation.",
      paths: values.filter((identity) => identity.kind === "target").flatMap((identity) => identity.paths)
    });
  }
  return issues;
}

function normalizeOrgType(value) {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? String(numeric) : normalized;
}

function normalizeText(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}
