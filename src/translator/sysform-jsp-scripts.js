import { auditFunctionWhitelist, loadFunctionWhitelist } from "./function-whitelist.js";
import { resolveScriptControlTarget } from "../dsl/scripts.js";
import { analyzeLegacyScriptFormRules } from "./sysform-form-rules.js";
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

export function draftMkScriptsFromSourceScripts(sourceScripts = {}, options = {}) {
  const sources = Array.isArray(sourceScripts.sources) ? sourceScripts.sources : [];
  if (!sources.length) return undefined;

  const candidates = dedupeCandidatesByKey(sources
    .flatMap((source, sourceIndex) => eventCandidatesFromSource(source, sourceIndex)));
  const actions = [];
  const warnings = [];
  candidates.forEach((candidate, index) => {
    const action = mkActionFromCandidate(candidate, index);
    const target = scriptTargetWarning(action, options.form);
    if (target) {
      warnings.push(target);
      return;
    }
    actions.push(omitCoveredHiddenHelperAction(action, candidate, options));
  });
  return {
    source: sourceScripts.source || "sysform-jsp",
    actions,
    warnings,
    javascript: actions.map((action) => action.function).filter(Boolean).join("\n\n")
  };
}

function omitCoveredHiddenHelperAction(action, candidate, options = {}) {
  const nativeRules = coveredNativeRules(action, candidate, options);
  if (!nativeRules.length) return action;

  return {
    ...action,
    function: "",
    translationStatus: "omitted",
    coverage: {
      status: "covered",
      nativeRules,
      residuals: []
    },
    functionMappings: [
      ...(action.functionMappings || []),
      {
        source: "legacy hidden helper row script",
        target: "native formRules.linkage",
        description: "Visible/required row behavior is represented by native formRules; hidden helper field state is not generated in MK.",
        basis: "deterministic-pattern",
        reviewRequired: false
      }
    ]
  };
}

function coveredNativeRules(action, candidate, options = {}) {
  const residuals = action.coverage?.residuals || [];
  if (!residuals.length) return [];

  if (
    action.coverage?.nativeRules?.length &&
    residuals.every((residual) => residual.type === "fieldValueAssignment" && !formHasField(options.form, residual.target))
  ) {
    return action.coverage.nativeRules;
  }

  if (
    action.event === "onLoad" &&
    residuals.every((residual) => residual.type === "windowLoadListener")
  ) {
    const helperIds = fieldIdsFromLegacyScript(candidate.javascript);
    const rowTargets = rowTargetsFromLegacyRowReset(candidate.javascript);
    if (!helperIds.length || !rowTargets.length) return [];
    if (helperIds.some((id) => formHasField(options.form, id))) return [];
    return nativeRulesCoveringRows(options.formRules, rowTargets);
  }

  return [];
}

function fieldIdsFromLegacyScript(text = "") {
  return [...String(text || "").matchAll(/GetXFormFieldById\(\s*(["'])([^"']+)\1\s*\)/g)]
    .map((match) => match[2]);
}

function rowTargetsFromLegacyRowReset(text = "") {
  return [...String(text || "").matchAll(/common_dom_row_set_show_required_reset\(\s*(["'])([^"']+)\1/g)]
    .map((match) => match[2]);
}

function nativeRulesCoveringRows(formRules = {}, rowTargets = []) {
  const matchingRules = (formRules.linkage || []).filter((rule) => {
    const effectTargets = [
      ...(rule.effects || []),
      ...(rule.else || [])
    ].map((effect) => effect.target);
    return rowTargets.every((target) => effectTargets.includes(target));
  });
  return matchingRules.length ? matchingRules.map((rule) => rule.id) : [];
}

function scriptTargetWarning(action, form) {
  if (!form || action.scope !== "control") return undefined;
  const target = resolveScriptControlTarget(form, action);
  if (target.ok) return undefined;
  return {
    level: "warning",
    code: `script.${target.code}`,
    message: "JSP control script target does not exist in the generated form and was not drafted as an executable action.",
    sourceRefs: action.sourceRefs || [],
    controlId: target.controlId,
    tableId: target.tableId
  };
}

function formHasField(form = {}, fieldId) {
  if (!fieldId) return false;
  for (const field of form.fields || []) {
    if (field.id === fieldId) return true;
    if ((field.columns || []).some((column) => column.id === fieldId)) return true;
  }
  return false;
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

function mkActionFromCandidate(candidate, index) {
  const functionName = candidate.event;
  const functionMappings = candidate.functionMappings || functionMappingsFromAudit(candidate.source.functionAudit);
  const coverage = candidate.coverage || scriptCoverageFromSource({
    javascript: candidate.javascript,
    sourceRef: candidate.source.sourceRef
  });
  const translationStatus = candidate.translationStatus || (coverage.status === "covered" ? "omitted" : "needs_review");
  const fn = translationStatus === "omitted"
    ? ""
    : candidate.function || buildMkFunction(candidate, functionMappings, candidate.source.functionAudit?.violations || []);

  return pruneUndefined({
    id: stableActionId(candidate.id || `${candidate.event}.${index + 1}`),
    name: functionName,
    event: candidate.event,
    scope: candidate.scope,
    controlId: candidate.controlId,
    tableId: candidate.tableId,
    function: fn,
    sourceRefs: [candidate.source.sourceRef].filter(Boolean),
    translationStatus,
    coverage,
    functionMappings,
    unmappedFunctions: (candidate.source.functionAudit?.violations || []).map((violation) => violation.name)
  });
}

function scriptCoverageFromSource(source) {
  const analysis = analyzeLegacyScriptFormRules(source);
  const nativeRules = analysis.linkage.map((rule) => rule.id);
  return {
    status: analysis.residuals.length ? (nativeRules.length ? "partial" : "uncovered") : (nativeRules.length ? "covered" : "none"),
    nativeRules,
    residuals: analysis.residuals
  };
}

function eventCandidatesFromSource(source, sourceIndex) {
  const candidates = [
    ...extractValueChangeCandidates(source),
    ...extractDetailControlDisplayCandidates(source),
    ...extractWindowLoadCandidates(source),
    ...extractSubmitQueueCandidates(source, "submit", "onBeforeSubmit"),
    ...extractSubmitQueueCandidates(source, "afterSubmit", "onAfterSubmit")
  ].sort((left, right) => left.index - right.index);

  const events = candidates.length ? candidates : [fallbackCandidate(source)];
  return events.map((candidate, index) => ({
    ...candidate,
    id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
    source
  }));
}

function extractValueChangeCandidates(source) {
  const text = source.javascript || "";
  const candidates = [];
  const inlinePattern = /AttachXFormValueChangeEventById\(\s*(["'])([^"']+)\1\s*,\s*function\s*\(([^)]*)\)\s*\{/g;
  for (const match of text.matchAll(inlinePattern)) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findBalancedClose(text, bodyStart - 1, "{", "}");
    if (bodyEnd < bodyStart) continue;
    const end = findCallEnd(text, bodyEnd + 1);
    candidates.push({
      index: match.index,
      event: "onChange",
      scope: "control",
      controlId: match[2],
      javascript: text.slice(match.index, end).trim()
    });
  }

  const namedPattern = /AttachXFormValueChangeEventById\(\s*(["'])([^"']+)\1\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
  for (const match of text.matchAll(namedPattern)) {
    const fn = findNamedFunction(text, match[3]);
    const end = findCallEnd(text, match.index + match[0].length);
    candidates.push({
      index: match.index,
      event: "onChange",
      scope: "control",
      controlId: match[2],
      javascript: [fn, text.slice(match.index, end).trim()].filter(Boolean).join("\n")
    });
  }

  return dedupeCandidates(candidates);
}

function extractDetailControlDisplayCandidates(source) {
  const text = source.javascript || "";
  const parts = detailControlDisplayParts(text);
  if (!parts) return [];

  const binding = snippetAround(text, parts.trigger.index, 420);
  return [{
    index: text.indexOf(parts.functionText),
    event: "onChange",
    scope: "control",
    tableId: parts.trigger.tableId,
    controlId: parts.trigger.controlId,
    dedupeKey: `detail-control-display:${parts.trigger.tableId}.${parts.trigger.controlId}:${parts.target.controlId}`,
    javascript: [parts.functionText, binding].filter(Boolean).join("\n\n"),
    function: buildDetailControlDisplayFunction(parts.trigger.tableId, parts.target.controlId),
    translationStatus: "mapped",
    coverage: { status: "none", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "detail-row DOM display toggle",
      target: "detail column onChange + MKXFORM.updateControlStyle",
      description: `Show ${parts.target.controlId} in the same ${parts.trigger.tableId} row when ${parts.trigger.controlId} is gh; hide it otherwise.`,
      basis: "deterministic-pattern",
      reviewRequired: false
    }]
  }];
}

function detailControlDisplayParts(text) {
  const functionText = findNamedFunction(text, "controlDisplay");
  if (!functionText || !text.includes("controlDisplay(")) return undefined;

  const target = detailDisplayTargetFromControlDisplay(functionText);
  if (!target) return undefined;

  const trigger = detailControlDisplayTrigger(text, target.tableId, target.controlId);
  if (!trigger) return undefined;

  return {
    functionText,
    target,
    trigger,
    hiddenControlId: detailHiddenControlFromControlDisplay(functionText, target.tableId, target.controlId)
  };
}

function detailDisplayTargetFromControlDisplay(functionText) {
  const fields = detailFieldReferences(functionText);
  const displayField = fields.find((field) => field.snippet.includes(".style.display"));
  return displayField
    ? { tableId: displayField.tableId, controlId: displayField.controlId }
    : undefined;
}

function detailHiddenControlFromControlDisplay(functionText, tableId, targetControlId) {
  const hiddenField = detailFieldReferences(functionText)
    .find((field) => field.tableId === tableId && field.controlId !== targetControlId && /\bhidden\b/.test(field.snippet));
  return hiddenField?.controlId;
}

function detailControlDisplayTrigger(text, tableId, targetControlId) {
  const bindingPattern = /var\s+([A-Za-z_$][\w$]*)\s*=\s*document\.getElementsByName\("extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\."\+i\+"\.(fd_[A-Za-z0-9_]+)\)"\)\[\d+\];\s*\1\.setAttribute\(\s*(["'])onclick\4\s*,[\s\S]{0,220}?controlDisplay\(/g;
  for (const match of text.matchAll(bindingPattern)) {
    const candidate = {
      index: match.index,
      tableId: match[2],
      controlId: match[3]
    };
    if (candidate.tableId === tableId && candidate.controlId !== targetControlId) return candidate;
  }
  return undefined;
}

function detailFieldReferences(text) {
  const references = [];
  const pattern = /extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\."\+i\+"\.(fd_[A-Za-z0-9_]+)\)/g;
  for (const match of text.matchAll(pattern)) {
    references.push({
      index: match.index,
      tableId: match[1],
      controlId: match[2],
      snippet: snippetAround(text, match.index, 160)
    });
  }
  return references;
}

function buildDetailControlDisplayFunction(tableId, targetControlId) {
  const controlId = "${table:" + tableId + "}." + targetControlId;
  return [
    "function onChange(value, rowNum, parentRowNum) {",
    "  var showReplacementAsset = value === \"gh\"",
    `  MKXFORM.updateControlStyle("${controlId}", rowNum, { display: showReplacementAsset ? "block" : "none" })`,
    "}"
  ].join("\n");
}

function buildDetailControlLoadFunction(tableId, triggerControlId, targetControlId, hiddenControlId) {
  const tableControlId = "${table:" + tableId + "}";
  const targetRuntimeId = "${table:" + tableId + "}." + targetControlId;
  const hiddenLine = hiddenControlId
    ? `    var hiddenValue = row && row["${hiddenControlId}"]`
    : "    var hiddenValue = \"\"";
  return [
    "function onLoad() {",
    `  var tableValue = MKXFORM.getValue("${tableControlId}") || []`,
    "  var rows = Array.isArray(tableValue) ? tableValue : (tableValue && Array.isArray(tableValue.value) ? tableValue.value : [])",
    "  rows.forEach(function(row, rowNum) {",
    `    var buyType = row && row["${triggerControlId}"]`,
    hiddenLine,
    "    var showReplacementAsset = buyType === \"gh\" || hiddenValue === \"true\"",
    `    MKXFORM.updateControlStyle("${targetRuntimeId}", rowNum, { display: showReplacementAsset ? "block" : "none" })`,
    "  })",
    "}"
  ].join("\n");
}

function extractWindowLoadCandidates(source) {
  const text = source.javascript || "";
  const candidates = [];
  const inlinePattern = /Com_AddEventListener\(\s*window\s*,\s*(["'])load\1\s*,\s*function\s*\([^)]*\)\s*\{/g;
  for (const match of text.matchAll(inlinePattern)) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findBalancedClose(text, bodyStart - 1, "{", "}");
    if (bodyEnd < bodyStart) continue;
    const end = findCallEnd(text, bodyEnd + 1);
    const detailDisplay = detailControlDisplayParts(text);
    candidates.push({
      index: match.index,
      event: "onLoad",
      scope: "global",
      javascript: text.slice(match.index, end).trim(),
      ...(detailDisplay ? {
        function: buildDetailControlLoadFunction(
          detailDisplay.trigger.tableId,
          detailDisplay.trigger.controlId,
          detailDisplay.target.controlId,
          detailDisplay.hiddenControlId
        ),
        translationStatus: "mapped",
        coverage: { status: "none", nativeRules: [], residuals: [] },
        functionMappings: [{
          source: "window-load detail row DOM initialization",
          target: "onLoad + MKXFORM.getValue + MKXFORM.updateControlStyle",
          description: `Initialize ${detailDisplay.target.controlId} display for existing ${detailDisplay.trigger.tableId} rows without DOM event binding.`,
          basis: "deterministic-pattern",
          reviewRequired: false
        }]
      } : {})
    });
  }
  return candidates;
}

function extractSubmitQueueCandidates(source, queueName, event) {
  const text = source.javascript || "";
  const candidates = [];
  const queuePattern = queueName === "submit"
    ? /Com_Parameter\.event(?:\s*\[\s*["']submit["']\s*\]|\s*\.\s*submit)\s*\.push\s*\(\s*/g
    : /Com_Parameter\.event(?:\s*\[\s*["']afterSubmit["']\s*\]|\s*\.\s*afterSubmit)\s*\.push\s*\(\s*/g;

  for (const match of text.matchAll(queuePattern)) {
    const afterOpen = match.index + match[0].length;
    const inline = text.slice(afterOpen).match(/^function\s*\([^)]*\)\s*\{/);
    if (inline) {
      const bodyStart = afterOpen + inline[0].length;
      const bodyEnd = findBalancedClose(text, bodyStart - 1, "{", "}");
      if (bodyEnd < bodyStart) continue;
      const end = findCallEnd(text, bodyEnd + 1);
      candidates.push({
        index: match.index,
        event,
        scope: "global",
        javascript: text.slice(match.index, end).trim()
      });
      continue;
    }

    const named = text.slice(afterOpen).match(/^([A-Za-z_$][\w$]*)/);
    if (!named) continue;
    const fn = findNamedFunction(text, named[1]);
    const end = findCallEnd(text, afterOpen + named[0].length);
    candidates.push({
      index: match.index,
      event,
      scope: "global",
      javascript: [fn, text.slice(match.index, end).trim()].filter(Boolean).join("\n")
    });
  }

  return candidates;
}

function fallbackCandidate(source) {
  const event = /Com_Parameter\.event(?:\s*\[\s*["']submit["']\s*\]|\s*\.\s*submit)\s*\.push/i.test(source.javascript || "")
    ? "onBeforeSubmit"
    : "onLoad";
  return {
    index: 0,
    event,
    scope: "global",
    javascript: source.javascript || ""
  };
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
      basis: "function-catalog",
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

function buildMkFunction(candidate, mappings, violations) {
  const functionName = candidate.event;
  const signature = functionSignature(candidate);
  const lines = [
    `${signature} {`,
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

  lines.push("", "  // Source JSP JavaScript:", ...commentLines(candidate.javascript));
  if (functionName === "onBeforeSubmit") {
    lines.push("", "  if (context && context.isDraft) return true", "  return true");
  }
  lines.push("}");
  return lines.join("\n");
}

function functionSignature(candidate) {
  if (candidate.event === "onChange") return "function onChange(value, rowNum, parentRowNum)";
  if (candidate.event === "onBeforeSubmit") return "function onBeforeSubmit(context)";
  return `function ${candidate.event}()`;
}

function commentLines(text = "") {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => `  // ${line}`);
}

function findNamedFunction(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\bfunction\\s+${escaped}\\s*\\([^)]*\\)\\s*\\{`);
  const match = pattern.exec(text);
  if (!match) return "";
  const open = match.index + match[0].length - 1;
  const close = findBalancedClose(text, open, "{", "}");
  return close > open ? text.slice(match.index, close + 1).trim() : "";
}

function findCallEnd(text, start) {
  let cursor = skipWhitespace(text, start);
  if (text[cursor] === ")") cursor += 1;
  cursor = skipWhitespace(text, cursor);
  if (text[cursor] === ";") cursor += 1;
  return cursor;
}

function findBalancedClose(text, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === "\\" && index + 1 < text.length) {
        index += 1;
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (["\"", "'", "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function skipWhitespace(text, start) {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = `${candidate.index}:${candidate.event}:${candidate.scope}:${candidate.tableId || ""}:${candidate.controlId || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function dedupeCandidatesByKey(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (!candidate.dedupeKey) {
      result.push(candidate);
      continue;
    }
    if (seen.has(candidate.dedupeKey)) continue;
    seen.add(candidate.dedupeKey);
    result.push(candidate);
  }
  return result;
}

function snippetAround(text, index, length) {
  return String(text || "").slice(index, Math.min(String(text || "").length, index + length)).trim();
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
