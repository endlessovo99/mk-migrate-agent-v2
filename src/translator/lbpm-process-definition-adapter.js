import { parseRootHashMapValue } from "./xml-utils.js";

export function translateLbpmProcessDefinitionXml(xml, options = {}) {
  const contents = extractFdContents(xml);
  const processXml = findProcessContent(contents);
  const nodeDefinitions = parseNodeDefinitionContents(contents);
  const handlerIndex = indexNodeDefinitionHandlers(parseRootHashMapValue(xml, "nodeDefinitionHandlers"));
  const process = parseProcessXml(processXml, nodeDefinitions, handlerIndex);
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
    }
  };
}

export function parseLbpmProcessDefinitionXml(xml) {
  const contents = extractFdContents(xml);
  const handlerIndex = indexNodeDefinitionHandlers(parseRootHashMapValue(xml, "nodeDefinitionHandlers"));
  return buildDirectedAcyclicGraph(parseProcessXml(findProcessContent(contents), parseNodeDefinitionContents(contents), handlerIndex));
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

  for (const content of contents) {
    if (/^<process\b/i.test(content)) continue;

    const root = scanStartTags(content).find((token) => token.name.endsWith("Node"));
    if (!root) continue;

    const attributes = parseXmlAttributes(root.attributesText);
    if (!attributes.id || definitions.has(attributes.id)) continue;

    definitions.set(attributes.id, {
      type: root.name,
      attributes,
      sourceXml: content
    });
  }

  return definitions;
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
      nodes.push(nodeFromAttributes(tag, tagAttributes, nodeDefinitions.get(tagAttributes.id), token.sourceXml, handlerIndex));
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
  const node = {
    id: attributes.id || "",
    type,
    name: attributes.name || "",
    attributes,
    sourceXml
  };

  if (definition) {
    node.definition = definition;
  }

  const handlerEntities = handlerEntitiesFor(handlerIndex, node.id, "handlerIds", attributes.handlerNames);
  const optionalHandlerEntities = handlerEntitiesFor(handlerIndex, node.id, "optHandlerIds", attributes.optHandlerNames);
  if (handlerEntities.length) node.handlerEntities = handlerEntities;
  if (optionalHandlerEntities.length) node.optionalHandlerEntities = optionalHandlerEntities;

  return node;
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

function handlerEntitiesFor(index, factId, attribute, fallbackNames = "") {
  const names = String(fallbackNames || "").split(";").map((name) => name.trim());
  return (index.get(handlerIndexKey(factId, attribute)) || []).map((entity) => ({
    ...entity,
    name: entity.name || names[entity.index] || entity.loginName || entity.id
  }));
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
