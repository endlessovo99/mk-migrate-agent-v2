import { auditFunctionWhitelist, loadFunctionWhitelist } from "./function-whitelist.js";
import { attrValue, decodeEntities } from "./xml-utils.js";

export function extractSysFormJspScripts(template = {}, options = {}) {
  const whitelist = options.functionWhitelist || loadFunctionWhitelist();
  const designerFragments = extractDesignerJspFragments(template.fdDesignerHtml || "");
  const designerScriptSources = designerFragments.flatMap((fragment) => scriptSourcesFromFragment(fragment));
  const displayScriptSources = designerScriptSources.length
    ? []
    : extractDisplayJspScripts(template.fdDisplayJsp || "");
  const sources = [...designerScriptSources, ...displayScriptSources].map((source) => ({
    ...source,
    functionAudit: auditFunctionWhitelist(source.javascript, whitelist, { path: source.sourceRef })
  }));

  if (!designerFragments.length && !sources.length && !template.fdDisplayJsp) return undefined;

  return pruneUndefined({
    source: "sysform-jsp",
    displayJsp: template.fdDisplayJsp ? {
      sourceKey: "fdDisplayJsp",
      length: template.fdDisplayJsp.length,
      usedForScripts: designerScriptSources.length === 0 && displayScriptSources.length > 0
    } : undefined,
    fragments: designerFragments,
    sources
  });
}

export function draftMkScriptsFromSourceScripts(sourceScripts = {}) {
  const sources = Array.isArray(sourceScripts.sources) ? sourceScripts.sources : [];
  if (!sources.length) return undefined;

  const actions = sources.map((source, index) => mkActionFromSource(source, index));
  return {
    source: sourceScripts.source || "sysform-jsp",
    actions,
    javascript: actions.map((action) => action.function).join("\n\n")
  };
}

function extractDesignerJspFragments(html = "") {
  const decoded = html.includes("<") ? String(html) : decodeEntities(html);
  const fragments = [];
  const pattern = /<([A-Za-z][\w:-]*)\b([^>]*\bfd_type\s*=\s*(["'])jsp\3[^>]*)>([\s\S]*?)<\/\1>/gi;

  for (const match of decoded.matchAll(pattern)) {
    const attrs = match[2];
    const id = attrValue(attrs, "id") || `jsp-${fragments.length + 1}`;
    const rawContent = hiddenInputValue(match[4]);
    const content = decodeDeep(rawContent);
    fragments.push(pruneUndefined({
      id,
      sourceRef: `source.form.jsp.${id}`,
      sourceKey: "fdDesignerHtml",
      sourceType: "designer-jsp",
      length: content.length,
      contentPreview: compactPreview(content),
      content
    }));
  }

  return fragments;
}

function scriptSourcesFromFragment(fragment) {
  return extractScriptBlocks(fragment.content).map((javascript, index) => ({
    id: `${fragment.id}.script.${index + 1}`,
    sourceRef: `${fragment.sourceRef}.script.${index + 1}`,
    sourceKey: fragment.sourceKey,
    sourceType: fragment.sourceType,
    fragmentId: fragment.id,
    javascript
  }));
}

function extractDisplayJspScripts(jsp = "") {
  return extractScriptBlocks(decodeDeep(jsp)).map((javascript, index) => ({
    id: `fdDisplayJsp.script.${index + 1}`,
    sourceRef: `source.form.jsp.fdDisplayJsp.script.${index + 1}`,
    sourceKey: "fdDisplayJsp",
    sourceType: "display-jsp",
    javascript
  }));
}

function extractScriptBlocks(text = "") {
  const decoded = decodeDeep(text);
  return [...decoded.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => decodeDeep(match[1]).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim())
    .filter(Boolean);
}

function hiddenInputValue(html = "") {
  const match = html.match(/<input\b[\s\S]*?\bvalue\s*=\s*(["'])([\s\S]*?)\1[\s\S]*?>/i);
  return match ? match[2] : "";
}

function mkActionFromSource(source, index) {
  const event = eventFromSource(source.javascript);
  const functionName = event === "onBeforeSubmit" ? "onBeforeSubmit" : "onLoad";
  const functionMappings = functionMappingsFromAudit(source.functionAudit);
  const translationStatus = functionMappings.some((mapping) => mapping.reviewRequired) ||
    source.functionAudit?.violations?.length
    ? "needs_review"
    : "mapped";
  const fn = buildMkFunction(functionName, source.javascript, functionMappings, source.functionAudit?.violations || []);

  return pruneUndefined({
    id: stableActionId(source.id || `${event}.${index + 1}`),
    name: functionName,
    event,
    function: fn,
    sourceRefs: [source.sourceRef].filter(Boolean),
    translationStatus,
    functionMappings,
    unmappedFunctions: (source.functionAudit?.violations || []).map((violation) => violation.name)
  });
}

function eventFromSource(source = "") {
  if (/Com_Parameter\.event(?:\s*\[\s*["']submit["']\s*\]|\s*\.\s*submit)\s*\.push/i.test(source)) {
    return "onBeforeSubmit";
  }
  return "onLoad";
}

function functionMappingsFromAudit(audit = {}) {
  const byName = new Map();
  for (const item of audit.matched || []) {
    if (!item.name || byName.has(item.name)) continue;
    const mkFunction = item.mkFunction || "";
    byName.set(item.name, {
      source: item.name,
      target: mkFunction,
      description: item.description || "",
      reviewRequired: mappingNeedsReview(mkFunction)
    });
  }
  return [...byName.values()].sort((left, right) => left.source.localeCompare(right.source));
}

function mappingNeedsReview(mkFunction = "") {
  const normalized = String(mkFunction).trim();
  return !normalized ||
    /^无\b/.test(normalized) ||
    /^同/.test(normalized) ||
    /^需要/.test(normalized) ||
    normalized.includes("对应表单动作") ||
    normalized.includes("onChange") ||
    normalized.includes("人工");
}

function buildMkFunction(functionName, source, mappings, violations) {
  const lines = [
    `function ${functionName}(context) {`,
    "  var values = MKXFORM.getFormValues()",
    "",
    "  // Generated from EKP JSP script. Review before marking trusted/executable.",
    "  // EKP -> MK function mappings:"
  ];

  if (mappings.length) {
    for (const mapping of mappings) {
      lines.push(`  // - ${mapping.source} => ${oneLine(mapping.target || "review_required")}`);
    }
  } else {
    lines.push("  // - no cataloged EKP function calls found");
  }

  if (violations.length) {
    lines.push("  // Unmapped EKP functions:");
    for (const violation of violations) {
      lines.push(`  // - ${violation.name}`);
    }
  }

  lines.push("", "  // Source JSP JavaScript:", ...commentLines(source));
  if (functionName === "onBeforeSubmit") lines.push("", "  return true");
  lines.push("}");
  return lines.join("\n");
}

function commentLines(text = "") {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => `  // ${line}`);
}

function decodeDeep(value = "") {
  let current = String(value);
  for (let index = 0; index < 5; index += 1) {
    const next = decodeEntities(current);
    if (next === current) return next;
    current = next;
  }
  return current;
}

function compactPreview(value = "") {
  return oneLine(value).slice(0, 240);
}

function oneLine(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function stableActionId(value = "") {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, "_");
}

function pruneUndefined(value) {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, pruneUndefined(child)])
  );
}
