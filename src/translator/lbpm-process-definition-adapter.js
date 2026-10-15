import { sanitizeCredentialMaterial } from "../credential-material.js";
import { parseRootHashMapValue } from "./xml-utils.js";
import { scanHtmlTags, findMatchingCloseTag } from "./designer-html-tokenizer.js";

export function translateLbpmProcessDefinitionXml(xml, options = {}) {
  const contents = extractFdContents(xml);
  const processXml = findProcessContent(contents);
  const nodeDefinitions = parseNodeDefinitionContents(contents);
  const handlerIndex = indexNodeDefinitionHandlers(parseRootHashMapValue(xml, "nodeDefinitionHandlers"));
  const process = parseProcessXml(processXml, nodeDefinitions.definitions, handlerIndex);
  const graph = buildDirectedAcyclicGraph(process);

  return {
    source: {
      kind: "lbpm-process-definition-xml",
      path: options.sourcePath,
      fdId: process.id,
      templateId: process.templateId,
      lbpmTemplateId: process.lbpmTemplateId,
      modelName: process.modelName,
      modelKey: process.modelKey
    },
    workflow: {
      process: {
        id: process.id,
        templateId: process.templateId,
        lbpmTemplateId: process.lbpmTemplateId,
        modelName: process.modelName,
        modelKey: process.modelKey,
        attributes: process.attributes,
        privilegerEntities: process.privilegerEntities
      },
      nodes: graph.nodes,
      edges: graph.edges,
      topologicalOrder: graph.topologicalOrder
    },
    ...(nodeDefinitions.warnings.length ? {
      review: { warnings: nodeDefinitions.warnings }
    } : {})
  };
}

export function parseLbpmProcessDefinitionXml(xml) {
  const contents = extractFdContents(xml);
  const handlerIndex = indexNodeDefinitionHandlers(parseRootHashMapValue(xml, "nodeDefinitionHandlers"));
  const nodeDefinitions = parseNodeDefinitionContents(contents);
  return buildDirectedAcyclicGraph(parseProcessXml(findProcessContent(contents), nodeDefinitions.definitions, handlerIndex));
}

function extractFdContents(xml = "") {
  return [...String(xml).matchAll(/<string>fdContent<\/string>\s*<string>([\s\S]*?)<\/string>/g)]
    .map((match) => decodeEntities(match[1]).trim());
}

function findProcessContent(contents) {
  const processXml = contents.find((candidate) => /^<process\b/i.test(candidate));

  if (!processXml) {
    throw new Error("LbpmProcessDefinition XML does not contain process fdContent");
  }

  return processXml;
}

function parseNodeDefinitionContents(contents) {
  const definitions = new Map();
  const warnings = [];

  for (const content of contents) {
    if (/^<process\b/i.test(content)) continue;

    const root = scanStartTags(content).find((token) => token.name.endsWith("Node"));
    if (!root) continue;

    const parsedAttributes = parseXmlAttributes(root.attributesText);
    const sanitized = sanitizeCredentialMaterial(parsedAttributes, { path: "/attributes" });
    const attributes = sanitized.value;
    if (!attributes.id) continue;
    if (definitions.has(attributes.id)) {
      if (root.name === "signNode" || definitions.get(attributes.id).type === "signNode") {
        definitions.get(attributes.id).operations = [{ duplicateDefinition: true }];
        definitions.get(attributes.id).signSourceIssues = ["duplicate-sign-definition"];
      }
      continue;
    }

    const sanitizedRoot = replaceSanitizedAttributes(root.sourceXml, parsedAttributes, attributes);
    const sourceXml = content.replace(root.sourceXml, sanitizedRoot);

    definitions.set(attributes.id, {
      type: root.name,
      attributes,
      sourceXml,
      ...(root.name === "signNode" ? {
        operations: signOperationEvidence(sourceXml, attributes.id, "definition") || [],
        ...(duplicateAttributeNames(root.attributesText).length ? { signSourceIssues: duplicateAttributeNames(root.attributesText).map(name => `duplicate-root-attribute:${name}`) } : {})
      } : {})
    });

    if (sanitized.redactedPaths.length) {
      warnings.push({
        code: "source.workflow.credential_redacted",
        message: "Credential material was redacted from workflow source evidence.",
        path: `/workflow/nodes/${jsonPointerSegment(attributes.id)}/definition`,
        details: {
          redactedPaths: sanitized.redactedPaths
        }
      });
    }
  }

  return { definitions, warnings };
}

function signOperationEvidence(xml, nodeId, location) {
  const tokens = [...scanHtmlTags(xml)], root = tokens[0];
  if (!root || root.selfClosing) return undefined;
  const close = findMatchingCloseTag(xml, root.end, root.name);
  if (close < root.end) return [{ invalidRoot: true }];
  const rootName = xml.slice(root.start + 1).match(/^([\w:-]+)/)?.[1];
  if (xml.slice(close).match(/^<\/([\w:-]+)\s*>/)?.[1] !== rootName) return [{ invalidRoot: true }];
  if (location === "definition") {
    const end = scanHtmlTags(xml, close).next().value?.end;
    const outside = xml.slice(0, root.start) + xml.slice(end);
    if (outside.replace(/<!--[\s\S]*?-->/g, "").trim()) return [{ unsupportedDefinitionEnvelope: true }];
  }
  const body = xml.slice(root.end, close), children = [...scanHtmlTags(body)];
  const result = [], consumed = []; let depth = 0;
  for (const token of children) {
    if (token.closing) { depth--; continue; }
    if (depth === 0) {
      const end = token.selfClosing ? token.end : findMatchingCloseTag(body, token.end, token.name);
      const text = token.selfClosing ? "" : body.slice(token.end, end);
      const closing = token.selfClosing ? token : end >= token.end ? scanHtmlTags(body, end).next().value : undefined;
      const rawName = body.slice(token.start + 1).match(/^([\w:-]+)/)?.[1];
      if (closing?.end >= token.end) consumed.push([token.start, closing.end]);
      const attributes = sanitizeCredentialMaterial(parseXmlAttributes(token.attrs), { path: "/operations/attributes" }).value;
      result.push({
        sourceRef: `source.workflow.node.${nodeId}.${location}.operations.${result.length}`,
        attributes, childElementCount: [...scanHtmlTags(text)].filter(item => !item.closing).length,
        text: text.trim() ? "[unsupported operation content]" : text,
        ...(rawName !== "operations" || duplicateAttributeNames(token.attrs).length || end < token.end ||
          (!token.selfClosing && body.slice(end).match(/^<\/([\w:-]+)\s*>/)?.[1] !== "operations") ? { unsupportedShape: true } : {})
      });
    }
    if (!token.selfClosing) depth++;
  }
  let residual = body;
  for (const [start, end] of consumed.reverse()) residual = residual.slice(0, start) + residual.slice(end);
  if (depth !== 0 || residual.replace(/<!--[\s\S]*?-->/g, "").trim()) result.push({ unsupportedRootContent: true });
  return result;
}

function duplicateAttributeNames(text) {
  const seen = new Set(), duplicates = new Set();
  // Consume each quoted value before looking for the next XML attribute name.
  for (const match of text.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    if (seen.has(match[1])) duplicates.add(match[1]);
    seen.add(match[1]);
  }
  return [...duplicates];
}

function replaceSanitizedAttributes(sourceXml, original, sanitized) {
  let result = sourceXml;
  for (const [name, value] of Object.entries(sanitized)) {
    if (value === original[name]) continue;
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(\\b${escapedName}\\s*=\\s*)([\"'])([\\s\\S]*?)\\2`);
    result = result.replace(pattern, (_match, prefix, quote) =>
      `${prefix}${quote}${encodeXmlAttribute(value, quote)}${quote}`
    );
  }
  return result;
}

function encodeXmlAttribute(value, quote) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(quote === "\"" ? /"/g : /'/g, quote === "\"" ? "&quot;" : "&apos;");
}

function jsonPointerSegment(value) {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}

function parseProcessXml(processXml, nodeDefinitions = new Map(), handlerIndex = new Map()) {
  const processMatch = processXml.match(/<process\b([^>]*)>/i);
  if (!processMatch) {
    throw new Error("LbpmProcessDefinition fdContent does not contain a process element");
  }

  const attributes = parseXmlAttributes(processMatch[1]);
  const description = parseProcessDescription(attributes.description || "");
  const nodes = [];
  const edges = [];

  for (const token of scanStartTags(processXml)) {
    const tag = token.name;
    if (tag === "process" || tag === "nodes" || tag === "lines") continue;

    const tagAttributes = parseXmlAttributes(token.attributesText);
    if (tag === "line") {
      edges.push(edgeFromAttributes(tagAttributes, token.sourceXml));
      continue;
    }

    if (tag.endsWith("Node")) {
      const node = nodeFromAttributes(tag, tagAttributes, nodeDefinitions.get(tagAttributes.id), token.sourceXml, handlerIndex);
      if (tag === "signNode" || node.definition?.type === "signNode" || node.definition?.signSourceIssues?.length) {
        const duplicateNames = duplicateAttributeNames(token.attributesText);
        if (duplicateNames.length) node.signSourceIssues = duplicateNames.map(name => `duplicate-root-attribute:${name}`);
        const operations = signOperationEvidence(processXml.slice(token.start), node.id, "direct");
        if (operations !== undefined) node.operations = operations;
      }
      nodes.push(node);
    }
  }

  return {
    id: attributes.fdId || "",
    templateId: description.templateId || "",
    lbpmTemplateId: description.lbpmTmpId || "",
    modelName: description.modelName || "",
    modelKey: description.modelKey || "",
    attributes,
    privilegerEntities: handlerEntitiesFor(handlerIndex, "00", "privilegerIds", attributes.privilegerNames),
    nodes,
    edges
  };
}

function scanStartTags(xml) {
  const tags = [];

  for (let index = 0; index < xml.length; index += 1) {
    if (xml[index] !== "<") continue;
    const next = xml[index + 1];
    if (next === "/" || next === "!" || next === "?") continue;

    const nameMatch = /^[A-Za-z][\w-]*/.exec(xml.slice(index + 1));
    if (!nameMatch) continue;

    const name = nameMatch[0];
    let cursor = index + 1 + name.length;
    const attributesStart = cursor;
    let quote = "";

    for (; cursor < xml.length; cursor += 1) {
      const char = xml[cursor];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === "\"" || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }

    if (cursor >= xml.length) {
      throw new Error(`LbpmProcessDefinition contains an unterminated ${name} tag`);
    }

    tags.push({
      start: index,
      name,
      attributesText: xml.slice(attributesStart, cursor),
      sourceXml: xml.slice(index, cursor + 1)
    });
    index = cursor;
  }

  return tags;
}

function buildDirectedAcyclicGraph(process) {
  const nodeIds = new Set();
  const edgeIds = new Set();
  const indegree = new Map();
  const outgoing = new Map();

  for (const node of process.nodes) {
    if (!node.id) throw new Error(`LbpmProcessDefinition contains a ${node.type} without id`);
    if (nodeIds.has(node.id)) throw new Error(`LbpmProcessDefinition contains duplicate node id ${node.id}`);
    nodeIds.add(node.id);
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of process.edges) {
    if (!edge.id) throw new Error("LbpmProcessDefinition contains a line without id");
    if (edgeIds.has(edge.id)) throw new Error(`LbpmProcessDefinition contains duplicate line id ${edge.id}`);
    edgeIds.add(edge.id);

    if (!nodeIds.has(edge.source)) {
      throw new Error(`LbpmProcessDefinition line ${edge.id} references missing start node ${edge.source}`);
    }
    if (!nodeIds.has(edge.target)) {
      throw new Error(`LbpmProcessDefinition line ${edge.id} references missing end node ${edge.target}`);
    }

    outgoing.get(edge.source).push(edge.target);
    indegree.set(edge.target, indegree.get(edge.target) + 1);
  }

  const queue = process.nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id);
  const topologicalOrder = [];

  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    topologicalOrder.push(nodeId);

    for (const target of outgoing.get(nodeId)) {
      const nextDegree = indegree.get(target) - 1;
      indegree.set(target, nextDegree);
      if (nextDegree === 0) queue.push(target);
    }
  }

  // Real LBPM templates may contain retry/reject loops. Preserve the full graph and
  // complete topologicalOrder with remaining cyclic nodes in source order so downstream
  // DSL validation can warn on back-edges instead of blocking clean.
  if (topologicalOrder.length !== process.nodes.length) {
    const ordered = new Set(topologicalOrder);
    for (const node of process.nodes) {
      if (!ordered.has(node.id)) {
        topologicalOrder.push(node.id);
        ordered.add(node.id);
      }
    }
  }

  return {
    nodes: process.nodes,
    edges: process.edges,
    topologicalOrder
  };
}

function nodeFromAttributes(type, attributes, definition, sourceXml, handlerIndex) {
  const help = normalizeNodeHelp(attributes.description);
  const node = {
    id: attributes.id || "",
    type,
    name: attributes.name || "",
    attributes,
    sourceXml,
    ...(help
      ? {
          help,
          helpEvidence: {
            sourceAttribute: "description",
            normalization: "safe-text-v1"
          }
        }
      : {})
  };

  if (definition) {
    node.definition = definition;
  }

  const handlerEvidence = handlerEntityEvidenceFor(
    handlerIndex,
    node.id,
    "handlerIds",
    attributes.handlerNames,
    {
      cachedIds: attributes.handlerIds,
      selectionType: attributes.handlerSelectType
    }
  );
  const optionalHandlerEvidence = handlerEntityEvidenceFor(
    handlerIndex,
    node.id,
    "optHandlerIds",
    attributes.optHandlerNames,
    {
      cachedIds: attributes.optHandlerIds,
      selectionType: attributes.optHandlerSelectType
    }
  );
  const { entities: handlerEntities } = handlerEvidence;
  const { entities: optionalHandlerEntities } = optionalHandlerEvidence;
  if (handlerEntities.length) node.handlerEntities = handlerEntities;
  if (optionalHandlerEntities.length) node.optionalHandlerEntities = optionalHandlerEntities;
  const directTargetAmbiguities = [
    ...handlerEvidence.directTargetAmbiguities,
    ...optionalHandlerEvidence.directTargetAmbiguities
  ];
  if (directTargetAmbiguities.length) node.directTargetAmbiguities = directTargetAmbiguities;

  return node;
}

function normalizeNodeHelp(value = "") {
  let text = String(value || "");
  for (let index = 0; index < 3; index += 1) {
    const decoded = decodeEntities(text);
    if (decoded === text) break;
    text = decoded;
  }
  text = text
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|pre|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function indexNodeDefinitionHandlers(value) {
  const index = new Map();
  if (!Array.isArray(value)) return index;

  for (const record of value) {
    if (!record || typeof record !== "object") continue;
    const factId = String(record.fdFactId || "").trim();
    const attribute = String(record.fdAttribute || "").trim();
    const handler = record.fdHandler;
    if (!factId || !attribute || !handler || typeof handler !== "object") continue;

    const entity = compactObject({
      id: stringValue(handler.fdId),
      name: stringValue(handler.fdName),
      orgType: numberValue(handler.fdOrgType),
      class: stringValue(handler.class),
      parent: stringValue(handler["hbmParent.fdName"]),
      index: numberValue(record.fdIndex),
      loginName: stringValue(handler.fdLoginName)
    });
    const key = handlerIndexKey(factId, attribute);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(entity);
  }

  for (const entities of index.values()) {
    entities.sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER));
  }
  return index;
}

function handlerEntitiesFor(index, factId, attribute, fallbackNames = "", options = {}) {
  return handlerEntityEvidenceFor(index, factId, attribute, fallbackNames, options).entities;
}

function handlerEntityEvidenceFor(index, factId, attribute, fallbackNames = "", options = {}) {
  const names = String(fallbackNames || "").split(";").map((name) => name.trim());
  const cachedIds = splitHandlerIds(options.cachedIds);
  const staticOrgSelection = String(options.selectionType || "").trim().toLowerCase() === "org";
  const structuredEntities = index.get(handlerIndexKey(factId, attribute)) || [];
  const directTargetAmbiguities = staticOrgSelection
    ? directTargetAmbiguitiesFor(structuredEntities, attribute, cachedIds)
    : [];
  const ambiguousIndexes = new Set(directTargetAmbiguities.map((ambiguity) => ambiguity.index));

  return {
    entities: structuredEntities.map((entity) => {
      const cachedId = cachedIds[entity.index];
      const directTarget = staticOrgSelection &&
        !ambiguousIndexes.has(entity.index) &&
        isStructuredDirectTarget(entity, cachedId);
      return compactObject({
        ...entity,
        name: entity.name || names[entity.index] || entity.loginName || entity.id,
        ...(directTarget ? {
          directTargetId: entity.id,
          directTargetOrgType: entity.orgType
        } : {})
      });
    }),
    directTargetAmbiguities
  };
}

function directTargetAmbiguitiesFor(entities, attribute, cachedIds) {
  const targetIdsByIndex = new Map();
  for (const entity of entities) {
    if (!Number.isSafeInteger(entity?.index) || entity.index < 0) continue;
    const targetId = String(entity.id || "").trim();
    if (!targetId) continue;
    if (!targetIdsByIndex.has(entity.index)) targetIdsByIndex.set(entity.index, new Set());
    targetIdsByIndex.get(entity.index).add(targetId);
  }

  const ambiguities = new Map();
  for (const entity of entities) {
    const cachedId = cachedIds[entity.index];
    if (!isStructuredDirectTarget(entity, cachedId)) continue;
    const targetIds = targetIdsByIndex.get(entity.index);
    if (!targetIds || targetIds.size < 2) continue;
    ambiguities.set(entity.index, {
      attribute,
      index: entity.index,
      cachedId: String(cachedId).trim(),
      targetIds: [...targetIds].sort()
    });
  }

  return [...ambiguities.values()].sort((left, right) => left.index - right.index);
}

function isStructuredDirectTarget(entity, cachedId) {
  if (!Number.isSafeInteger(entity?.index) || entity.index < 0) {
    return false;
  }
  const targetId = String(entity.id || "").trim();
  if (entity.orgType === 8) return Boolean(targetId);
  if (entity.orgType !== 4) return false;
  const sourceId = String(cachedId || "").trim();
  return Boolean(targetId && sourceId && isLiteralHandlerId(sourceId) && sourceId !== targetId);
}

function splitHandlerIds(value) {
  return String(value || "").split(";").map((item) => item.trim());
}

function isLiteralHandlerId(value) {
  return !/[${}<>()[\]]/.test(value);
}

function handlerIndexKey(factId, attribute) {
  return `${factId}\u0000${attribute}`;
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

function edgeFromAttributes(attributes, sourceXml) {
  return {
    id: attributes.id || "",
    source: attributes.startNodeId || "",
    target: attributes.endNodeId || "",
    name: attributes.name || "",
    condition: attributes.condition || "",
    displayCondition: attributes.disCondition || "",
    sourcePosition: attributes.startPosition || "",
    targetPosition: attributes.endPosition || "",
    points: attributes.points || "",
    priority: attributes.priority || "",
    attributes,
    sourceXml
  };
}

function parseProcessDescription(description = "") {
  const result = {};
  for (const part of decodeEntities(description).split("&")) {
    const [key, ...rest] = part.split("=");
    if (!key || rest.length === 0) continue;
    result[key] = rest.join("=");
  }
  return result;
}

function parseXmlAttributes(text = "") {
  const result = {};
  for (const match of text.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    result[match[1]] = decodeEntities(match[3]);
  }
  return result;
}

function decodeEntities(value = "") {
  return String(value)
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&amp;#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
