const PARTICIPANT_RESOLUTION_STAGE = "resolveWorkflowParticipants";
const NEWOA_SIT_ORIGIN = "https://p-sit.onewo.com";
const SIT_FALLBACK_PARTICIPANT_ID = "1j8mu7vviw1owgp04w2v4p47v1rmcohi3tw0";
const SIT_FALLBACK_REASONS = new Set(["not_found", "missing_source_evidence"]);

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

export async function resolveWorkflowParticipants(dsl, { client, targetBaseUrl } = {}) {
  const nextDsl = structuredClone(dsl);
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
  const elementCache = new Map();
  const resolutions = await Promise.all(
    [...identities.values()].map(async (identity) => {
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
    })
  );

  const unresolvedResolutions = resolutions.filter((resolution) => resolution.issue);
  const fallbackResolutions = isSitTarget(targetBaseUrl)
    ? unresolvedResolutions.filter(isSitFallbackEligible)
    : [];
  const fallbackResolutionSet = new Set(fallbackResolutions);
  const blockingResolutions = unresolvedResolutions.filter((resolution) => !fallbackResolutionSet.has(resolution));
  if (blockingResolutions.length) {
    throw new ParticipantResolutionError(unresolvedResolutions.map((resolution) => resolution.issue));
  }
  if (fallbackResolutions.length) {
    const fallbackTarget = await resolveSitFallbackTarget(client, elementCache, fallbackResolutions);
    for (const resolution of fallbackResolutions) {
      resolution.target = fallbackTarget;
      resolution.fallback = true;
      resolution.issue = undefined;
    }
  }

  const issues = resolutions.flatMap((resolution) => resolution.issue ? [resolution.issue] : []);
  if (issues.length) {
    throw new ParticipantResolutionError(issues);
  }

  let resolvedCount = 0;
  let fallbackCount = 0;
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

  return {
    dsl: nextDsl,
    resolvedCount,
    identityCount: identities.size,
    fallbackCount,
    fallbackIdentityCount: fallbackResolutions.length,
    ...(fallbackCount ? { fallbackTargetId: SIT_FALLBACK_PARTICIPANT_ID } : {})
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

async function resolveSitFallbackTarget(client, elementCache, resolutions) {
  const paths = resolutions.flatMap((resolution) => resolution.paths);
  if (typeof client?.getElementInfo !== "function") {
    throw new ParticipantResolutionError([{
      reason: "fallback_validation_unavailable",
      targetId: SIT_FALLBACK_PARTICIPANT_ID,
      paths,
      message: "NewOA client does not provide fallback participant validation."
    }]);
  }

  try {
    const validation = await validateCurrentTargetIdentity({
      kind: "target",
      member: { id: SIT_FALLBACK_PARTICIPANT_ID, name: "SIT fallback participant" },
      members: [],
      paths
    }, client, elementCache);
    if (validation.issue) {
      throw new ParticipantResolutionError([{
        ...validation.issue,
        reason: "fallback_target_not_found",
        targetId: SIT_FALLBACK_PARTICIPANT_ID,
        paths
      }]);
    }
    if (normalizeOrgType(validation.target.fdOrgType) !== "8") {
      throw new ParticipantResolutionError([{
        reason: "fallback_target_not_person",
        targetId: SIT_FALLBACK_PARTICIPANT_ID,
        targetOrgType: validation.target.fdOrgType,
        paths
      }]);
    }
    return validation.target;
  } catch (error) {
    if (error instanceof ParticipantResolutionError) throw error;
    throw new ParticipantResolutionError([{
      reason: "fallback_validation_failed",
      targetId: SIT_FALLBACK_PARTICIPANT_ID,
      paths,
      message: error instanceof Error ? error.message : String(error)
    }], { cause: error });
  }
}

function isSitTarget(value) {
  try {
    const url = new URL(value);
    return url.origin.toLowerCase() === NEWOA_SIT_ORIGIN;
  } catch {
    return false;
  }
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
      await searchCurrentCandidates(sourceLoginName, client, caches.searchCache)
    );
    const loginMatches = matchPersonLoginCandidates(identity.member, loginCandidates);
    if (loginMatches.length > 0) {
      return resolutionFromMatches(identity, loginMatches);
    }
  }

  const candidates = uniqueCurrentCandidates(await searchCurrentCandidates(name, client, caches.searchCache));
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

function searchCurrentCandidates(key, client, searchCache) {
  let candidatesPromise = searchCache.get(key);
  if (!candidatesPromise) {
    candidatesPromise = Promise.resolve(client.searchOrg(key));
    searchCache.set(key, candidatesPromise);
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
  const sourceParentName = normalizeText(member.sourceParentName);
  if (!sourceName || !sourceParentName) return [];
  return sameType.filter((candidate) => (
    normalizeText(candidate.fdName) === sourceName &&
    normalizeText(candidateParentName(candidate)) === sourceParentName
  ));
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
