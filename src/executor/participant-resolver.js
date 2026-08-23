import { allowsTemporaryOrgFallbacks } from "./newoa-client.js";
import {
  DEFAULT_TEMPORARY_ORG_FALLBACKS,
  resolveTemporaryOrgFallbacks
} from "./temporary-org-fallbacks.js";

const PARTICIPANT_RESOLUTION_STAGE = "resolveWorkflowParticipants";
const SIT_FALLBACK_REASONS = new Set(["not_found", "missing_source_evidence", "search_failed"]);

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

export async function resolveWorkflowParticipants(dsl, {
  client,
  targetBaseUrl,
  fallbackFdIds,
  participantOverrides
} = {}) {
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
  const explicitOverrides = prepareParticipantOverrides(identities, participantOverrides);
  if (identities.size === 0) {
    return {
      dsl: nextDsl,
      resolvedCount: 0,
      identityCount: 0,
      fallbackCount: 0,
      fallbackIdentityCount: 0,
      overrideCount: 0,
      overrideIdentityCount: 0
    };
  }
  const capabilityIssues = requiredClientCapabilityIssues(identities, client, explicitOverrides);
  if (capabilityIssues.length) {
    throw new ParticipantResolutionError(capabilityIssues);
  }

  const searchCache = new Map();
  const resolutions = await mapWithConcurrency(
    [...identities.values()],
    1,
    async (identity) => {
      const explicitOverride = explicitOverrides.get(normalizeText(identity.member?.sourceId));
      try {
        if (explicitOverride) {
          return await resolveExplicitParticipantOverride(
            identity,
            explicitOverride,
            client,
            elementCache
          );
        }
        return await resolveIdentity(identity, client, { searchCache, elementCache });
      } catch (error) {
        if (error instanceof ParticipantResolutionError) throw error;
        return {
          ...identity,
          issue: {
            reason: explicitOverride
              ? "override_target_validation_failed"
              : identity.kind === "target" ? "target_validation_failed" : "search_failed",
            name: identity.member.name,
            sourceId: identity.member.sourceId,
            ...(explicitOverride ? { targetId: explicitOverride.targetFdId } : {}),
            paths: identity.paths,
            message: error instanceof Error ? error.message : String(error)
          }
        };
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

  const overrideResolutions = resolutions.filter((resolution) => resolution.override);
  const overrideAudits = overrideResolutions.map(buildParticipantOverrideAudit);
  const overrideTargetIds = [...new Set(
    overrideResolutions.map((resolution) => resolution.target.fdId)
  )].sort();
  let resolvedCount = 0;
  let fallbackCount = configuredFormulaFallback.referenceCount;
  let overrideCount = 0;
  for (const resolution of resolutions) {
    for (const member of resolution.members) {
      member.id = resolution.target.fdId;
      member.name = resolution.target.fdName;
      member.targetOrgType = resolution.target.fdOrgType;
      if (resolution.kind === "source") resolvedCount += 1;
      if (resolution.fallback) fallbackCount += 1;
      if (resolution.override) overrideCount += 1;
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
    overrideCount,
    overrideIdentityCount: overrideResolutions.length,
    ...(overrideCount ? {
      overrideTargetIds,
      overrides: overrideAudits
    } : {}),
    ...(fallbackCount ? {
      fallbackTargetIds,
      fallbackTargetsByOrgType,
      ...(fallbackTargetIds.length === 1 ? { fallbackTargetId: fallbackTargetIds[0] } : {})
    } : {})
  };
}

function prepareParticipantOverrides(identities, overrides) {
  if (overrides === undefined) return new Map();
  if (!Array.isArray(overrides)) {
    throw new ParticipantResolutionError([{
      reason: "override_configuration_invalid",
      message: "Explicit participant overrides must be an array of sourceId/targetFdId mappings.",
      paths: ["/execute/participantOverrides"]
    }]);
  }

  const bySourceId = new Map();
  const issues = [];
  overrides.forEach((override, index) => {
    const path = `/execute/participantOverrides/${index}`;
    const sourceId = normalizeText(override?.sourceId);
    const targetFdId = normalizeText(override?.targetFdId);
    if (!override || typeof override !== "object" || !sourceId || !targetFdId) {
      issues.push({
        reason: "override_configuration_invalid",
        sourceId,
        targetId: targetFdId,
        paths: [path],
        message: "Each explicit participant override requires non-empty sourceId and targetFdId."
      });
      return;
    }
    if (bySourceId.has(sourceId)) {
      issues.push({
        reason: "override_source_duplicate",
        sourceId,
        targetId: targetFdId,
        paths: [path],
        message: "A source participant may be explicitly overridden only once."
      });
      return;
    }
    bySourceId.set(sourceId, { sourceId, targetFdId, path });
  });

  const presentSourceIds = new Set(
    [...identities.values()]
      .filter((identity) => identity.kind === "source")
      .map((identity) => normalizeText(identity.member?.sourceId))
      .filter(Boolean)
  );
  for (const override of bySourceId.values()) {
    const matchingIdentities = [...identities.values()].filter((identity) => (
      identity.kind === "source" &&
      normalizeText(identity.member?.sourceId) === override.sourceId
    ));
    if (!presentSourceIds.has(override.sourceId)) {
      issues.push({
        reason: "override_source_not_found",
        sourceId: override.sourceId,
        targetId: override.targetFdId,
        paths: [override.path],
        message: "Explicit participant override sourceId does not exist in the trusted DSL."
      });
    } else if (matchingIdentities.length !== 1) {
      issues.push({
        reason: "override_source_ambiguous",
        sourceId: override.sourceId,
        targetId: override.targetFdId,
        paths: [
          override.path,
          ...matchingIdentities.flatMap((identity) => identity.paths)
        ],
        message: "Explicit participant override sourceId refers to multiple distinct source identities."
      });
    }
  }
  if (issues.length) throw new ParticipantResolutionError(issues);
  return bySourceId;
}

async function resolveExplicitParticipantOverride(identity, override, client, elementCache) {
  const evidenceIssue = validateSourceEvidence(identity);
  if (evidenceIssue) {
    return {
      ...identity,
      issue: {
        ...evidenceIssue,
        reason: "override_source_evidence_invalid",
        targetId: override.targetFdId
      }
    };
  }

  const { candidates, exactMatches } = await currentElementsByExactId(
    override.targetFdId,
    client,
    elementCache
  );
  if (candidates.length !== 1 || exactMatches.length !== 1) {
    return {
      ...identity,
      issue: {
        reason: exactMatches.length === 0 ? "override_target_not_found" : "override_target_ambiguous",
        name: identity.member.name,
        sourceId: override.sourceId,
        sourceOrgType: identity.member.sourceOrgType,
        targetId: override.targetFdId,
        paths: identity.paths,
        candidateIds: candidates.map((candidate) => candidate.fdId)
      }
    };
  }

  const target = exactMatches[0];
  const sourceOrgType = normalizeOrgType(identity.member.sourceOrgType);
  const targetOrgType = normalizeOrgType(target.fdOrgType);
  if (targetOrgType !== sourceOrgType) {
    return {
      ...identity,
      issue: {
        reason: "override_target_type_mismatch",
        name: identity.member.name,
        sourceId: override.sourceId,
        sourceOrgType: identity.member.sourceOrgType,
        targetId: override.targetFdId,
        targetOrgType: target.fdOrgType,
        expectedOrgType: identity.member.sourceOrgType,
        paths: identity.paths
      }
    };
  }

  return {
    ...identity,
    target,
    override: true,
    overrideSpec: override
  };
}

function buildParticipantOverrideAudit(resolution) {
  const member = resolution.member;
  return {
    sourceEvidence: {
      sourceId: normalizeText(member.sourceId),
      name: normalizeText(member.name),
      sourceOrgType: member.sourceOrgType,
      ...(normalizeText(member.sourceOrgClass)
        ? { sourceOrgClass: normalizeText(member.sourceOrgClass) }
        : {}),
      ...(normalizeText(member.sourceParentName)
        ? { sourceParentName: normalizeText(member.sourceParentName) }
        : {}),
      ...(normalizeText(member.sourceLoginName)
        ? { sourceLoginName: normalizeText(member.sourceLoginName) }
        : {})
    },
    target: {
      fdId: normalizeText(resolution.target.fdId),
      fdName: normalizeText(resolution.target.fdName),
      fdOrgType: resolution.target.fdOrgType
    },
    referenceCount: resolution.members.length,
    paths: [...resolution.paths]
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
  if (normalizeOrgType(resolution.member?.sourceOrgType) === "32") return false;
  if (resolution.issue.reason === "not_found" || resolution.issue.reason === "search_failed") return true;
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

  const stableRoleResolution = await resolveStableSourceRoleIdentity(
    identity,
    client,
    caches.elementCache
  );
  if (stableRoleResolution) return stableRoleResolution;
  if (
    hasStableSourceRoleId(identity.member) &&
    !normalizeText(identity.member.sourceParentName) &&
    !isBracketedGenericRole(identity.member)
  ) {
    return resolutionFromMatches(identity, []);
  }

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

async function resolveStableSourceRoleIdentity(identity, client, elementCache) {
  const roleId = normalizeText(identity.member?.sourceId);
  if (
    normalizeOrgType(identity.member?.sourceOrgType) !== "32" ||
    !roleId ||
    typeof client?.getElementInfo !== "function"
  ) {
    return undefined;
  }

  const { exactMatches } = await currentElementsByExactId(
    roleId,
    client,
    elementCache
  );
  if (exactMatches.length === 0) return undefined;
  if (exactMatches.length !== 1) {
    return {
      ...identity,
      issue: {
        reason: "source_role_id_ambiguous",
        name: identity.member.name,
        sourceId: roleId,
        sourceOrgType: identity.member.sourceOrgType,
        paths: identity.paths,
        candidateIds: exactMatches.map((candidate) => candidate.fdId)
      }
    };
  }

  const target = exactMatches[0];
  if (normalizeOrgType(target.fdOrgType) !== "32") {
    return {
      ...identity,
      issue: {
        reason: "source_role_id_type_mismatch",
        name: identity.member.name,
        sourceId: roleId,
        sourceOrgType: identity.member.sourceOrgType,
        targetOrgType: target.fdOrgType,
        paths: identity.paths
      }
    };
  }

  return {
    ...identity,
    target
  };
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

  const { candidates, exactMatches } = await currentElementsByExactId(
    targetId,
    client,
    elementCache
  );
  if (candidates.length === 1 && exactMatches.length === 1) {
    return {
      ...identity,
      target: exactMatches[0]
    };
  }

  const hasTarget = exactMatches.length > 0;
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

async function currentElementsByExactId(targetId, client, elementCache) {
  let candidatesPromise = elementCache.get(targetId);
  if (!candidatesPromise) {
    candidatesPromise = Promise.resolve(client.getElementInfo([targetId]));
    elementCache.set(targetId, candidatesPromise);
  }
  const candidates = currentElementCandidates(await candidatesPromise);
  return {
    candidates,
    exactMatches: candidates.filter((candidate) => (
      normalizeText(candidate.fdId) === targetId
    ))
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
  if (!personHasLogin && !hasStableSourceRoleId(member) && !normalizeText(member.sourceParentName)) {
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

function hasStableSourceRoleId(member = {}) {
  return normalizeOrgType(member.sourceOrgType) === "32" &&
    Boolean(normalizeText(member.sourceId));
}

function isBracketedGenericRole(member = {}) {
  return normalizeOrgType(member.sourceOrgType) === "32" &&
    /^<\s*[^<>]+\s*>$/.test(normalizeText(member.name));
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
  if (isBracketedGenericRole(member) && !sourceParentName) {
    return sameType.filter((candidate) => normalizeText(candidate.fdName) === sourceName);
  }
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

function requiredClientCapabilityIssues(identities, client, explicitOverrides = new Map()) {
  const issues = [];
  const values = [...identities.values()];
  const unresolvedSources = values.filter((identity) => (
    identity.kind === "source" &&
    !explicitOverrides.has(normalizeText(identity.member?.sourceId))
  ));
  const stableRoleSources = unresolvedSources.filter((identity) => (
    hasStableSourceRoleId(identity.member)
  ));
  const searchedSources = unresolvedSources.filter((identity) => (
    !hasStableSourceRoleId(identity.member) ||
    Boolean(normalizeText(identity.member?.sourceParentName)) ||
    isBracketedGenericRole(identity.member)
  ));
  const overriddenSources = values.filter((identity) => (
    identity.kind === "source" &&
    explicitOverrides.has(normalizeText(identity.member?.sourceId))
  ));
  if (searchedSources.length > 0 && typeof client?.searchOrg !== "function") {
    issues.push({
      reason: "search_unavailable",
      message: "NewOA client does not provide current organization search.",
      paths: searchedSources.flatMap((identity) => identity.paths)
    });
  }
  if (stableRoleSources.length > 0 && typeof client?.getElementInfo !== "function") {
    issues.push({
      reason: "source_role_validation_unavailable",
      message: "NewOA client does not provide exact role-line identity validation.",
      paths: stableRoleSources.flatMap((identity) => identity.paths)
    });
  }
  const targetIdentities = values.filter((identity) => identity.kind === "target");
  if (targetIdentities.length > 0 && typeof client?.getElementInfo !== "function") {
    issues.push({
      reason: "target_validation_unavailable",
      message: "NewOA client does not provide current organization element validation.",
      paths: targetIdentities.flatMap((identity) => identity.paths)
    });
  }
  if (overriddenSources.length > 0 && typeof client?.getElementInfo !== "function") {
    issues.push({
      reason: "override_target_validation_unavailable",
      message: "NewOA client does not provide explicit participant override target validation.",
      paths: overriddenSources.flatMap((identity) => identity.paths)
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
