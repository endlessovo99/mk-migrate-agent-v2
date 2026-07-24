import { attrValue, decodeEntities, parseFdValues, parseXmlAttributes, propertyFieldId } from "./xml-utils.js";

const SUPPORTED_RIGHT_MODES = new Set(["hidden", "view", "edit"]);

export function extractSysFormNodeDataAuthorities(template = {}, options = {}) {
  const errors = [];
  const warnings = [];
  const warningKeys = new Set();
  const knownFieldIds = options.knownFieldIds instanceof Set
    ? options.knownFieldIds
    : undefined;
  const designerSections = extractDesignerRightSections(template.fdDesignerHtml || "");
  const sections = designerSections.length
    ? designerSections
    : extractDisplayRightSections(template.fdDisplayJsp || "");

  const nodes = {};
  const seen = new Map();

  sections.forEach((section, sectionIndex) => {
    const candidateFieldIds = [...new Set(section.fieldIds || [])]
      .filter((fieldId) => fieldId !== section.id);
    const fieldIds = candidateFieldIds
      .filter((fieldId) => !knownFieldIds || knownFieldIds.has(fieldId));
    const nodeIds = Object.keys(section.nodeModes || {});
    if (!fieldIds.length) {
      const warningKey = `${section.sourceRef}:fields_unresolved`;
      if (nodeIds.length && !warningKeys.has(warningKey)) {
        warningKeys.add(warningKey);
        warnings.push({
          code: "source.form_right.fields_unresolved",
          message: `Form right section ${section.id || sectionIndex + 1} does not contain a mapped form field.`,
          path: section.path,
          details: {
            sectionId: section.id,
            nodeIds,
            candidateFieldIds,
            sourceRef: section.sourceRef
          }
        });
      }
      return;
    }

    for (const [nodeId, mode] of Object.entries(section.nodeModes || {})) {
      if (!isWorkflowNodeId(nodeId)) continue;
      if (!SUPPORTED_RIGHT_MODES.has(mode)) {
        errors.push({
          code: "source.form_right.mode_unsupported",
          message: `Form right section ${section.id || sectionIndex + 1} uses unsupported mode ${mode} for ${nodeId}.`,
          path: section.path,
          details: { nodeId, mode, sectionId: section.id }
        });
        continue;
      }

      nodes[nodeId] ||= { fields: {} };
      for (const fieldId of fieldIds) {
        const key = `${nodeId}:${fieldId}`;
        const previous = seen.get(key);
        if (previous && previous.mode !== mode) {
          errors.push({
            code: "source.form_right.conflict",
            message: `Form right sections assign conflicting modes to ${fieldId} on ${nodeId}.`,
            path: section.path,
            details: {
              nodeId,
              fieldId,
              modes: [previous.mode, mode],
              sourceRefs: [previous.sourceRef, section.sourceRef].filter(Boolean)
            }
          });
          continue;
        }

        const sourceRef = sourceRefFor(section, sectionIndex, nodeId, fieldId);
        seen.set(key, { mode, sourceRef });
        nodes[nodeId].fields[fieldId] = {
          mode,
          sourceRef
        };
      }
    }
  });

  return {
    nodeDataAuthorities: pruneEmptyNodes(nodes),
    warnings,
    errors
  };
}

function extractDesignerRightSections(html = "") {
  const decoded = decodeEntities(html);
  const sections = [];
  const rightPattern = /<([a-zA-Z][\w:-]*)\b([^>]*\bfd_type\s*=\s*(["'])right\3[^>]*)>/gi;

  for (const match of decoded.matchAll(rightPattern)) {
    const tagName = match[1];
    const attrs = match[2];
    const openEnd = match.index + match[0].length;
    const end = findMatchingCloseTag(decoded, openEnd, tagName);
    const fragment = end > openEnd ? decoded.slice(match.index, end + `</${tagName}>`.length) : match[0];
    const values = parseFdValues(attrValue(attrs, "fd_values"));
    const id = values.id || attrValue(attrs, "id") || `right-${sections.length + 1}`;
    sections.push({
      id,
      source: "fdDesignerHtml",
      sourceRef: sourceRefBase("fdDesignerHtml", id || sections.length + 1),
      path: "/fdDesignerHtml",
      nodeModes: extractNodeModes(fragment),
      fieldIds: extractDesignerFieldIds(fragment, id)
    });
  }

  return sections;
}

function extractDisplayRightSections(jsp = "") {
  const decoded = decodeEntities(jsp);
  const sections = [];
  const rightPattern = /<xform:right\b([^>]*)>/gi;

  for (const match of decoded.matchAll(rightPattern)) {
    const attrs = match[1];
    const openEnd = match.index + match[0].length;
    const end = findMatchingCloseTag(decoded, openEnd, "xform:right");
    const fragment = end > openEnd ? decoded.slice(match.index, end + "</xform:right>".length) : match[0];
    const id = `xform-right-${sections.length + 1}`;
    sections.push({
      id,
      source: "fdDisplayJsp",
      sourceRef: sourceRefBase("fdDisplayJsp", id),
      path: "/fdDisplayJsp",
      nodeModes: extractNodeModes(attrs),
      fieldIds: extractDisplayFieldIds(fragment)
    });
  }

  return sections;
}

function extractNodeModes(text = "") {
  const modes = {};
  for (const match of text.matchAll(/\bmode_([A-Za-z0-9_-]+)\s*=\s*(["'])([^"']*)\2/g)) {
    const nodeId = match[1];
    if (!isWorkflowNodeId(nodeId)) continue;
    modes[nodeId] = String(match[3] || "").trim().toLowerCase();
  }
  return modes;
}

function extractDesignerFieldIds(fragment = "", sectionId = "") {
  const ids = [];
  const seen = new Set();
  const controlPattern = /<([a-zA-Z][\w:-]*)\b([^>]*\bfd_type\s*=\s*(["'])([^"']+)\3[^>]*)>/gi;

  for (const match of fragment.matchAll(controlPattern)) {
    const fdType = String(match[4] || "").toLowerCase();
    if (fdType === "right") continue;

    const attrs = match[2];
    const values = parseFdValues(attrValue(attrs, "fd_values"));
    const id = values.id || propertyFieldId(attrValue(attrs, "property")) || attrValue(attrs, "id");
    addFieldId(ids, seen, id, sectionId);
  }

  return ids;
}

function extractDisplayFieldIds(fragment = "") {
  const ids = [];
  const seen = new Set();
  for (const match of fragment.matchAll(/<xform:[\w:-]+\b([^>]*)>/gi)) {
    const attrs = parseXmlAttributes(match[1]);
    for (const key of ["property", "propertyId", "propertyName"]) {
      addFieldId(ids, seen, propertyFieldId(attrs[key]), "");
    }
  }
  return ids;
}

function addFieldId(ids, seen, id, sectionId) {
  if (!id || id === sectionId || seen.has(id)) return;
  seen.add(id);
  ids.push(id);
}

function sourceRefFor(section, sectionIndex, nodeId, fieldId) {
  return `${section.sourceRef || sourceRefBase(section.source || "right", section.id || sectionIndex + 1)}.${nodeId}.${fieldId}`
    .replace(/[^A-Za-z0-9_.:-]+/g, "_");
}

function sourceRefBase(source, id) {
  return `source.form.dataAuthority.${source}.${String(id || "right").replace(/[^A-Za-z0-9_.:-]+/g, "_")}`;
}

function isWorkflowNodeId(value) {
  return /^N[A-Za-z0-9_-]*$/i.test(String(value || ""));
}

function pruneEmptyNodes(nodes) {
  return Object.fromEntries(
    Object.entries(nodes).filter(([, value]) => Object.keys(value.fields || {}).length)
  );
}

function findMatchingCloseTag(html, contentStart, tagName) {
  const lower = html.toLowerCase();
  const normalizedTag = String(tagName || "").toLowerCase();
  const openToken = `<${normalizedTag}`;
  const closeToken = `</${normalizedTag}>`;
  let depth = 1;
  let cursor = contentStart;

  while (cursor < html.length) {
    const nextOpen = lower.indexOf(openToken, cursor);
    const nextClose = lower.indexOf(closeToken, cursor);
    if (nextClose === -1) return html.length;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      const openEnd = lower.indexOf(">", nextOpen);
      cursor = openEnd === -1 ? nextOpen + openToken.length : openEnd + 1;
      continue;
    }
    depth -= 1;
    if (depth === 0) return nextClose;
    cursor = nextClose + closeToken.length;
  }

  return html.length;
}
