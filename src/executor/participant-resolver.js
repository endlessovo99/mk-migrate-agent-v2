const PARTICIPANT_RESOLUTION_STAGE = "resolveWorkflowParticipants";

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

export async function resolveWorkflowParticipants(dsl, { client } = {}) {
  const nextDsl = structuredClone(dsl);
  const identities = collectParticipantIdentities(nextDsl);
  if (identities.size === 0) {
    return {
      dsl: nextDsl,
      resolvedCount: 0,
      identityCount: 0
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

  const issues = resolutions.flatMap((resolution) => resolution.issue ? [resolution.issue] : []);
  if (issues.length) {
    throw new ParticipantResolutionError(issues);
  }

  let resolvedCount = 0;
  for (const resolution of resolutions) {
    for (const member of resolution.members) {
      member.id = resolution.target.fdId;
      member.name = resolution.target.fdName;
      member.targetOrgType = resolution.target.fdOrgType;
      if (resolution.kind === "source") resolvedCount += 1;
    }
  }

  return {
    dsl: nextDsl,
    resolvedCount,
    identityCount: identities.size
  };
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
