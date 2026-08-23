import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { translateLbpmProcessDefinitionXml } from "./lbpm-process-definition-adapter.js";

const HANDLER_REFERENCE_ATTRIBUTES = Object.freeze([
  {
    attribute: "handlerIds",
    entities: "handlerEntities",
    selectionAttribute: "handlerSelectType"
  },
  {
    attribute: "optHandlerIds",
    entities: "optionalHandlerEntities",
    selectionAttribute: "optHandlerSelectType"
  }
]);

export function resolveWorkflowReference(sourceWorkflow, referenceDirectory) {
  const directory = normalizedReferenceDirectory(referenceDirectory);
  if (!directory) return undefined;

  let referenceStat;
  try {
    referenceStat = statSync(directory);
  } catch {
    throw new Error(`workflow reference directory is unavailable: ${directory}`);
  }
  if (!referenceStat.isDirectory()) {
    throw new Error(`workflow reference path must be a directory: ${directory}`);
  }

  const sourceProcessId = normalizedText(sourceWorkflow?.process?.id);
  const sourceTemplateId = normalizedText(sourceWorkflow?.process?.templateId);
  if (!sourceProcessId || !sourceTemplateId) {
    throw new Error("workflow reference requires source process and template IDs");
  }

  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /_LbpmProcessDefinition\.xml$/i.test(entry.name))
    .map((entry) => {
      const path = join(directory, entry.name);
      let parsed;
      try {
        parsed = translateLbpmProcessDefinitionXml(readFileSync(path, "utf8"));
      } catch (cause) {
        throw new Error(`workflow reference process could not be parsed: ${path}: ${String(cause?.message || cause)}`);
      }
      return { path, workflow: parsed.workflow };
    })
    .filter(({ workflow }) => (
      normalizedText(workflow?.process?.id) === sourceProcessId &&
      normalizedText(workflow?.process?.templateId) === sourceTemplateId
    ));

  if (candidates.length !== 1) {
    const count = candidates.length;
    throw new Error(
      count === 0
        ? `workflow reference has no exact process/template match for ${sourceProcessId}/${sourceTemplateId}`
        : `workflow reference has ${count} exact process/template matches for ${sourceProcessId}/${sourceTemplateId}`
    );
  }

  const candidate = candidates[0];
  return {
    workflow: candidate.workflow,
    metadata: {
      directory,
      lbpmProcessDefinition: candidate.path,
      processId: sourceProcessId,
      templateId: sourceTemplateId
    }
  };
}

export function applyWorkflowReferenceTargets(sourceWorkflow, referenceWorkflow) {
  const referenceNodes = new Map(
    (referenceWorkflow?.nodes || [])
      .filter((node) => normalizedText(node?.id))
      .map((node) => [node.id, node])
  );

  return {
    ...sourceWorkflow,
    nodes: (sourceWorkflow?.nodes || []).map((sourceNode) => {
      const referenceNode = referenceNodes.get(sourceNode?.id);
      if (!referenceNode) return sourceNode;
      return HANDLER_REFERENCE_ATTRIBUTES.reduce(
        (node, descriptor) => applyReferenceHandlerTargets(node, referenceNode, descriptor),
        sourceNode
      );
    })
  };
}

function applyReferenceHandlerTargets(sourceNode, referenceNode, {
  attribute,
  entities,
  selectionAttribute
}) {
  const sourceIds = splitHandlerIds(sourceNode?.attributes?.[attribute]);
  const referenceIds = splitHandlerIds(referenceNode?.attributes?.[attribute]);
  const eligibleIndexes = sourceFixedPostIndexes(
    sourceNode,
    sourceIds,
    attribute,
    entities,
    selectionAttribute
  );
  if (eligibleIndexes.size === 0) return sourceNode;
  const directTargets = matchingReferenceDirectTargets(
    referenceNode?.[entities],
    sourceIds,
    referenceIds,
    eligibleIndexes
  );
  const ambiguities = matchingReferenceAmbiguities(
    referenceNode?.directTargetAmbiguities,
    attribute,
    sourceIds,
    referenceIds,
    eligibleIndexes
  );
  if (directTargets.size === 0 && ambiguities.length === 0) return sourceNode;

  const directIndexes = new Set(directTargets.keys());
  const blockedIndexes = new Set(ambiguities.map((ambiguity) => ambiguity.index));
  const changedIndexes = new Set([...directIndexes, ...blockedIndexes]);
  const currentEntities = Array.isArray(sourceNode?.[entities]) ? sourceNode[entities] : [];
  const nextEntities = currentEntities
    .filter((entity) => !changedIndexes.has(entity?.index))
    .concat([...directTargets.values()])
    .sort(compareHandlerEntityPosition);
  const existingAmbiguities = Array.isArray(sourceNode?.directTargetAmbiguities)
    ? sourceNode.directTargetAmbiguities.filter((ambiguity) => !(
      ambiguity?.attribute === attribute && directIndexes.has(ambiguity?.index)
    ))
    : [];
  const next = { ...sourceNode };
  if (nextEntities.length) next[entities] = nextEntities;
  else delete next[entities];
  const mergedAmbiguities = mergeAmbiguities(existingAmbiguities, ambiguities);
  if (mergedAmbiguities.length) next.directTargetAmbiguities = mergedAmbiguities;
  else delete next.directTargetAmbiguities;
  return next;
}

function matchingReferenceDirectTargets(referenceEntities, sourceIds, referenceIds, eligibleIndexes) {
  const targets = new Map();
  for (const entity of referenceEntities || []) {
    if (!isDirectFixedPostTarget(entity)) continue;
    const index = entity.index;
    if (!eligibleIndexes.has(index)) continue;
    if (!sameCachedSourceId(sourceIds, referenceIds, index)) continue;
    targets.set(index, {
      ...entity,
      id: entity.directTargetId,
      directTargetId: entity.directTargetId,
      directTargetOrgType: 4,
      directTargetEvidence: "workflow-reference"
    });
  }
  return targets;
}

function matchingReferenceAmbiguities(referenceAmbiguities, attribute, sourceIds, referenceIds, eligibleIndexes) {
  return (referenceAmbiguities || [])
    .filter((ambiguity) => (
      ambiguity?.attribute === attribute &&
      Number.isSafeInteger(ambiguity?.index) &&
      eligibleIndexes.has(ambiguity.index) &&
      sameCachedSourceId(sourceIds, referenceIds, ambiguity.index)
    ))
    .map((ambiguity) => ({
      attribute,
      index: ambiguity.index,
      cachedId: ambiguity.cachedId,
      targetIds: Array.isArray(ambiguity.targetIds) ? [...ambiguity.targetIds].sort() : []
    }));
}

function isDirectFixedPostTarget(entity) {
  return Number(entity?.directTargetOrgType) === 4 &&
    Number.isSafeInteger(entity?.index) &&
    entity.index >= 0 &&
    Boolean(normalizedText(entity?.directTargetId));
}

function sameCachedSourceId(sourceIds, referenceIds, index) {
  const sourceId = normalizedText(sourceIds[index]);
  const referenceId = normalizedText(referenceIds[index]);
  return Boolean(sourceId && referenceId && sourceId === referenceId);
}

function sourceFixedPostIndexes(sourceNode, sourceIds, attribute, entities, selectionAttribute) {
  if (String(sourceNode?.attributes?.[selectionAttribute] || "").trim().toLowerCase() !== "org") {
    return new Set();
  }

  const nonPostIndexes = new Set(
    (Array.isArray(sourceNode?.[entities]) ? sourceNode[entities] : [])
      .filter((entity) => (
        Number.isSafeInteger(entity?.index) &&
        entity.index >= 0 &&
        Number(entity?.orgType) !== 4
      ))
      .map((entity) => entity.index)
  );
  const ambiguousIndexes = new Set(
    (Array.isArray(sourceNode?.directTargetAmbiguities) ? sourceNode.directTargetAmbiguities : [])
      .filter((ambiguity) => (
        ambiguity?.attribute === attribute &&
        Number.isSafeInteger(ambiguity?.index) &&
        ambiguity.index >= 0
      ))
      .map((ambiguity) => ambiguity.index)
  );

  return new Set(sourceIds
    .map((id, index) => ({ id: normalizedText(id), index }))
    .filter(({ id, index }) => (
      isLiteralHandlerId(id) &&
      !nonPostIndexes.has(index) &&
      !ambiguousIndexes.has(index)
    ))
    .map(({ index }) => index));
}

function isLiteralHandlerId(value) {
  return !/[${}<>()[\]]/.test(value);
}

function mergeAmbiguities(...groups) {
  const byKey = new Map();
  for (const ambiguity of groups.flat()) {
    if (!ambiguity || typeof ambiguity !== "object") continue;
    const targetIds = Array.isArray(ambiguity.targetIds)
      ? ambiguity.targetIds.map((id) => normalizedText(id)).filter(Boolean).sort()
      : [];
    const key = JSON.stringify([
      normalizedText(ambiguity.attribute),
      ambiguity.index,
      normalizedText(ambiguity.cachedId),
      targetIds
    ]);
    if (!byKey.has(key)) {
      byKey.set(key, {
        attribute: ambiguity.attribute,
        index: ambiguity.index,
        cachedId: ambiguity.cachedId,
        targetIds
      });
    }
  }
  return [...byKey.values()].sort((left, right) => (
    String(left.attribute).localeCompare(String(right.attribute)) ||
    Number(left.index) - Number(right.index)
  ));
}

function compareHandlerEntityPosition(left, right) {
  return (left?.index ?? Number.MAX_SAFE_INTEGER) - (right?.index ?? Number.MAX_SAFE_INTEGER);
}

function splitHandlerIds(value) {
  return String(value || "").split(";").map((item) => item.trim());
}

function normalizedReferenceDirectory(value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("workflow reference directory must be a non-empty path");
  }
  return value.trim();
}

function normalizedText(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}
