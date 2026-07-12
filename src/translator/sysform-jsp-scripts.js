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
  const sources = [...designerScriptSources, ...displayScriptSources].map((source) => {
    const functionAudit = auditFunctionWhitelist(source.javascript, whitelist, { path: source.sourceRef });
    return {
      ...source,
      functionAudit,
      semanticFacts: extractLegacyScriptSemanticFacts(source.javascript, functionAudit)
    };
  });

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
    .flatMap((source, sourceIndex) => eventCandidatesFromSource(source, sourceIndex, options)));
  const actions = [];
  const warnings = [];
  candidates.forEach((candidate, index) => {
    const action = mkActionFromCandidate(candidate, index, options);
    const target = scriptTargetWarning(action, options.form);
    if (target) {
      warnings.push(target);
      return;
    }
    actions.push(action);
  });
  return {
    source: sourceScripts.source || "sysform-jsp",
    actions,
    warnings,
    javascript: actions.map((action) => action.function).filter(Boolean).join("\n\n")
  };
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

function extractLegacyScriptSemanticFacts(javascript = "", functionAudit = {}) {
  const text = String(javascript || "");
  return pruneUndefined({
    legacyFunctionCalls: legacyFunctionCallsFromAudit(functionAudit),
    fieldIds: uniqueStrings([...text.matchAll(/\bfd_[A-Za-z0-9_]+\b/g)].map((match) => match[0])),
    rowMarkers: rowMarkersFromLegacyScript(text),
    eventBindings: eventBindingsFromLegacyScript(text)
  });
}

function legacyFunctionCallsFromAudit(functionAudit = {}) {
  return [...(functionAudit.matched || []), ...(functionAudit.violations || [])]
    .map((item) => {
      const occurrences = Array.isArray(item.occurrences) ? item.occurrences : [];
      return pruneUndefined({
        name: item.name,
        intent: item.intent,
        translationKind: item.translationKind,
        safety: item.safety,
        targetApis: item.targetApis,
        occurrenceCount: occurrences.length,
        firstIndex: occurrences[0]?.index,
        firstSnippet: occurrences[0]?.snippet
      });
    });
}

function rowMarkersFromLegacyScript(text = "") {
  const markers = [];
  const pattern = /common_dom_row_set_show_required_reset\(\s*(["'])([^"']+)\1\s*,\s*(true|false)\s*,\s*(true|false)\s*,\s*(true|false)\s*\)/g;
  for (const match of String(text || "").matchAll(pattern)) {
    markers.push({
      rowId: match[2],
      visible: match[3] === "true",
      required: match[4] === "true",
      reset: match[5] === "true",
      index: match.index,
      evidence: oneLine(match[0])
    });
  }
  return markers;
}

function eventBindingsFromLegacyScript(text = "") {
  const bindings = [];
  const valueChange = /AttachXFormValueChangeEventById\(\s*(["'])([^"']+)\1\s*,/g;
  for (const match of String(text || "").matchAll(valueChange)) {
    bindings.push({
      legacyApi: "AttachXFormValueChangeEventById",
      event: "onChange",
      controlId: match[2],
      index: match.index,
      evidence: oneLine(String(text || "").slice(match.index, Math.min(String(text || "").length, match.index + 180)))
    });
  }

  const load = /Com_AddEventListener\(\s*window\s*,\s*(["'])load\1/g;
  for (const match of String(text || "").matchAll(load)) {
    bindings.push({
      legacyApi: "Com_AddEventListener",
      event: "onLoad",
      index: match.index,
      evidence: oneLine(String(text || "").slice(match.index, Math.min(String(text || "").length, match.index + 180)))
    });
  }
  return bindings;
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
  return extractScriptBlocks(fragment.content).map((script, index) => ({
    id: `${fragment.id}.script.${index + 1}`,
    sourceRef: `${fragment.sourceRef}.script.${index + 1}`,
    sourceKey: fragment.sourceKey,
    sourceType: fragment.sourceType,
    fragmentId: fragment.id,
    ...script
  }));
}

function extractDisplayJspScripts(jsp = "") {
  return extractScriptBlocks(decodeDeep(jsp)).map((script, index) => ({
    id: `fdDisplayJsp.script.${index + 1}`,
    sourceRef: `source.form.jsp.fdDisplayJsp.script.${index + 1}`,
    sourceKey: "fdDisplayJsp",
    sourceType: "display-jsp",
    ...script
  }));
}

function extractScriptBlocks(text = "") {
  const decoded = decodeDeep(text);
  const displayGates = [];
  const scripts = [];
  const tokenPattern = /<\/?xform:(editShow|viewShow)\b[^>]*>|<script\b[^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of decoded.matchAll(tokenPattern)) {
    if (match[2] !== undefined) {
      const javascript = decodeDeep(match[2]).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
      if (!javascript) continue;
      scripts.push(pruneUndefined({
        javascript,
        displayGate: displayGates.at(-1)
      }));
      continue;
    }

    const displayGate = normalizeDisplayGate(match[1]);
    if (/^<\//.test(match[0])) {
      const index = displayGates.lastIndexOf(displayGate);
      if (index >= 0) displayGates.splice(index, 1);
    } else {
      displayGates.push(displayGate);
    }
  }

  return scripts;
}

function normalizeDisplayGate(value = "") {
  return String(value).toLowerCase() === "viewshow" ? "xform:viewShow" : "xform:editShow";
}

function hiddenInputValue(html = "") {
  const match = html.match(/<input\b[\s\S]*?\bvalue\s*=\s*(["'])([\s\S]*?)\1[\s\S]*?>/i);
  return match ? match[2] : "";
}

function mkActionFromCandidate(candidate, index, options = {}) {
  const functionName = candidate.event;
  const functionMappings = candidate.functionMappings || functionMappingsFromAudit(candidate.source.functionAudit);
  const coverage = scriptCoverageForExecutableFormRules(candidate.coverage || scriptCoverageFromSource({
    javascript: candidate.javascript,
    sourceRef: candidate.source.sourceRef,
    displayGate: candidate.source.displayGate,
    form: options.form
  }), options.formRules);
  const translationStatus = candidate.translationStatus || "needs_review";
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
    runWhen: runWhenFromDisplayGate(candidate.source.displayGate),
    function: fn,
    sourceRefs: [candidate.source.sourceRef].filter(Boolean),
    translationStatus,
    coverage,
    functionMappings,
    semanticHints: candidate.semanticHints,
    unmappedFunctions: (candidate.source.functionAudit?.violations || []).map((violation) => violation.name)
  });
}

function scriptCoverageForExecutableFormRules(coverage, formRules) {
  const nativeRules = Array.isArray(coverage?.nativeRules) ? coverage.nativeRules : [];
  if (!nativeRules.length || !Array.isArray(formRules?.linkage)) return coverage;

  const rulesByEvidenceId = new Map();
  for (const rule of formRules.linkage) {
    for (const evidenceId of uniqueStrings([rule.id, ...(rule.meta?.sourceRuleIds || [])])) {
      rulesByEvidenceId.set(evidenceId, rule);
    }
  }

  const executableNativeRules = [];
  const reviewNativeRules = [];
  for (const evidenceId of nativeRules) {
    const rule = rulesByEvidenceId.get(evidenceId);
    if (rule?.translationStatus === "executable") {
      executableNativeRules.push(rule.id);
    } else {
      reviewNativeRules.push(rule?.id || evidenceId);
    }
  }
  const canonicalExecutableRules = uniqueStrings(executableNativeRules);
  const canonicalReviewRules = uniqueStrings(reviewNativeRules);
  if (!canonicalReviewRules.length) {
    return {
      ...coverage,
      nativeRules: canonicalExecutableRules
    };
  }

  const residuals = [
    ...(Array.isArray(coverage.residuals) ? coverage.residuals : []),
    ...canonicalReviewRules.map((ruleId) => scriptResidual({
      code: "script.residual.form_rule_needs_review",
      type: "formRuleNeedsReview",
      message: `Native form rule ${ruleId} still needs review and cannot be counted as executable script coverage.`,
      evidence: ruleId
    }))
  ];

  return {
    ...coverage,
    status: residuals.length ? (canonicalExecutableRules.length ? "partial" : "uncovered") : (canonicalExecutableRules.length ? "covered" : "none"),
    nativeRules: canonicalExecutableRules,
    residuals
  };
}

function scriptResidual(input) {
  return pruneUndefined({
    code: input.code,
    type: input.type,
    message: input.message,
    target: input.target,
    trigger: input.trigger,
    callback: input.callback,
    evidence: input.evidence
  });
}

function scriptCoverageFromSource(source) {
  const staticProps = source.displayGate
    ? []
    : staticRequiredCoverage(source.javascript, source.form);
  if (staticProps.length) {
    return {
      status: "covered",
      nativeRules: [],
      staticProps,
      residuals: []
    };
  }

  const analysis = analyzeLegacyScriptFormRules(source);
  const nativeEligible = source.displayGate !== "xform:viewShow";
  const gatedRules = nativeEligible ? [] : analysis.linkage;
  const nativeRules = nativeEligible ? analysis.linkage.map((rule) => rule.id) : [];
  const residuals = [
    ...analysis.residuals,
    ...gatedRules.map((rule) => ({
      code: "script.residual.gated_native_form_rule",
      type: "gatedNativeFormRule",
      message: `Native form rule ${rule.id} is not emitted because ${source.displayGate} behavior must remain view-status gated.`,
      sourceRef: source.sourceRef,
      evidence: rule.id
    }))
  ];
  return {
    status: residuals.length ? (nativeRules.length ? "partial" : "uncovered") : (nativeRules.length ? "covered" : "none"),
    nativeRules,
    residuals
  };
}

function staticRequiredCoverage(javascript, form) {
  const load = String(javascript || "").match(
    /^\s*Com_AddEventListener\(\s*window\s*,\s*(["'])load\1\s*,\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\}\s*\)\s*;?\s*$/
  );
  if (!load) return [];

  const required = load[2].match(
    /^\s*\$\(\s*(["'])\[name=(["'])extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)\2\]\1\s*\)\s*\.attr\(\s*(["'])validate\4\s*,\s*(["'])required\5\s*\)\s*;?\s*$/
  );
  if (!required) return [];

  const fieldId = required[3];
  const field = (Array.isArray(form?.fields) ? form.fields : [])
    .find((candidate) => candidate?.id === fieldId && candidate?.type !== "detailTable");
  if (field?.props?.required !== true) return [];

  return [{ fieldId, prop: "required", value: true }];
}

function runWhenFromDisplayGate(displayGate) {
  if (displayGate === "xform:editShow") return { viewStatusIn: ["add", "edit"] };
  if (displayGate === "xform:viewShow") return { viewStatusIn: ["view"] };
  return undefined;
}

function eventCandidatesFromSource(source, sourceIndex, options = {}) {
  if (!hasExecutableJavascript(source.javascript)) return [];

  const legacyHelperDefinitions = legacyHelperDefinitionsCandidate(source);
  if (legacyHelperDefinitions) {
    return [{
      ...legacyHelperDefinitions,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.1`,
      source
    }];
  }

  const legacyAttachmentRuntime = legacyAttachmentRuntimeCandidate(source, options.form);
  if (legacyAttachmentRuntime) {
    return [{
      ...legacyAttachmentRuntime,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.1`,
      source
    }];
  }

  const legacyDetailRuntime = legacyDetailRuntimeCandidate(source, options.form);
  if (legacyDetailRuntime) {
    return [{
      ...legacyDetailRuntime,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.1`,
      source
    }];
  }

  const legacyRequiredToggle = legacyRequiredToggleCandidate(source, options.form);
  if (legacyRequiredToggle) {
    return [{
      ...legacyRequiredToggle,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.1`,
      source
    }];
  }

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

function legacyHelperDefinitionsCandidate(source) {
  const text = String(source.javascript || "").trim();
  if (!containsOnlyFunctionDeclarations(text)) return undefined;

  return legacyRuntimeOmission(text, "legacy helper function definitions", "inlined translated script actions");
}

function containsOnlyFunctionDeclarations(text) {
  let rest = String(text || "").trim();
  if (!rest) return false;
  let count = 0;

  while (rest) {
    const match = rest.match(/^function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/);
    if (!match) return false;
    const close = findBalancedClose(rest, match[0].length - 1, "{", "}");
    if (close < 0) return false;
    count += 1;
    rest = rest.slice(close + 1).replace(/^\s*;?\s*/, "");
  }

  return count > 0;
}

function legacyAttachmentRuntimeCandidate(source, form) {
  const text = String(source.javascript || "").trim();
  const hasAttachment = (form?.fields || []).some((field) => field?.type === "attachment");
  if (!hasAttachment || !isLegacyAttachmentRuntimePatch(text)) return undefined;

  return legacyRuntimeOmission(text, "legacy WebUploader CSS/refresh patch", "xform-attach native rendering");
}

function legacyRequiredToggleCandidate(source, form) {
  const text = String(source.javascript || "").trim();
  const toggle = legacyRequiredToggle(text);
  if (!toggle) return undefined;

  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const trigger = fields.find((field) => field?.id === toggle.triggerFieldId && field.type !== "detailTable");
  const target = fields.find((field) => field?.id === toggle.targetFieldId && field.type !== "detailTable");
  if (!trigger || !target) return undefined;

  return {
    index: toggle.index,
    event: "onChange",
    scope: "control",
    controlId: toggle.triggerFieldId,
    javascript: toggle.javascript,
    function: [
      "function onChange(value, rowNum, parentRowNum) {",
      `  const required = String(value || "").indexOf(${JSON.stringify(toggle.matchValue)}) >= 0`,
      `  MKXFORM.setFieldAttr(${JSON.stringify(toggle.targetFieldId)}, required ? 3 : 6)`,
      "}"
    ].join("\n"),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "AttachXFormValueChangeEventById + set_required/set_not_required",
      target: "MKXFORM.setFieldAttr",
      basis: "semantic-translation",
      reviewRequired: false
    }]
  };
}

function legacyRequiredToggle(text) {
  if (!/\bfunction\s+set_required\s*\(/.test(text) || !/\bfunction\s+set_not_required\s*\(/.test(text)) {
    return undefined;
  }
  if (!/\.attr\(\s*(["'])validate\1\s*,\s*(["'])required\2\s*\)/.test(text)) return undefined;
  if (!/\.attr\(\s*(["'])validate\1\s*,\s*(["'])\s*\2\s*\)/.test(text)) return undefined;

  const bindingPattern = /AttachXFormValueChangeEventById\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*,\s*function\s*\(([^)]*)\)\s*\{/g;
  for (const match of text.matchAll(bindingPattern)) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findBalancedClose(text, bodyStart - 1, "{", "}");
    if (bodyEnd < bodyStart) continue;

    const valueParam = String(match[3] || "").split(",")[0]?.trim() || "value";
    const toggle = requiredToggleFromBody(text.slice(bodyStart, bodyEnd), valueParam);
    if (!toggle) continue;

    return {
      index: match.index,
      triggerFieldId: match[2],
      targetFieldId: toggle.targetFieldId,
      matchValue: toggle.matchValue,
      javascript: text.slice(match.index, findCallEnd(text, bodyEnd + 1)).trim()
    };
  }
  return undefined;
}

function requiredToggleFromBody(body, valueParam) {
  const bodyText = String(body || "");
  const setRequiredCalls = [...bodyText.matchAll(/\bset_required\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*\)/g)];
  const setNotRequiredCalls = [...bodyText.matchAll(/\bset_not_required\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*\)/g)];
  if (setRequiredCalls.length !== 1 || setNotRequiredCalls.length < 1) return undefined;

  const targetFieldId = setRequiredCalls[0][2];
  if (!setNotRequiredCalls.every((call) => call[2] === targetFieldId)) return undefined;

  const condition = new RegExp(
    `if\\s*\\(\\s*${escapeRegExp(valueParam)}\\.indexOf\\(\\s*(["'])([^"']+)\\1\\s*\\)\\s*>=\\s*0\\s*\\)\\s*\\{[\\s\\S]*?set_required\\(\\s*(["'])${escapeRegExp(targetFieldId)}\\3\\s*\\)[\\s\\S]*?\\}\\s*else\\s*\\{[\\s\\S]*?set_not_required\\(\\s*(["'])${escapeRegExp(targetFieldId)}\\4\\s*\\)[\\s\\S]*?\\}`
  );
  const match = bodyText.match(condition);
  if (!match) return undefined;

  return {
    targetFieldId,
    matchValue: match[2]
  };
}

function isLegacyAttachmentRuntimePatch(text) {
  const normalized = String(text || "");
  return normalized.includes("document.createElement('style')") &&
    normalized.includes(".swfuploadbutton") &&
    normalized.includes('div[id^="rt_rt_"]') &&
    normalized.includes("attachmentObject_") &&
    normalized.includes("uploader.refresh()") &&
    normalized.includes("window.onload") &&
    !/\b(?:MKXFORM|GetXFormFieldById|AttachXFormValueChangeEventById|Com_Parameter|setValue|\.value\s*=)\b/.test(normalized);
}

function legacyDetailRuntimeCandidate(source, form) {
  const text = String(source.javascript || "").trim();
  if (/^Com_IncludeFile\(\s*(['"])doclist\.js\1\s*\)\s*;?\s*$/.test(text)) {
    return legacyDetailRuntimeOmission(text, "Com_IncludeFile", "MK detail-table runtime");
  }
  const detailTableIds = new Set((form?.fields || [])
    .filter((field) => field?.type === "detailTable" && field.id)
    .map((field) => field.id));
  const tableId = legacyDetailTableId(text);
  if (!tableId || !detailTableIds.has(tableId)) return undefined;

  if (new RegExp(`^DocList_Info\\.push\\(\\s*(['"])TABLE_DL_${escapeRegExp(tableId)}\\1\\s*\\)\\s*;?\\s*$`).test(text)) {
    return legacyDetailRuntimeOmission(text, "DocList_Info.push", "MK detail-table registration");
  }
  if (isLegacyDetailDefaultRowScript(text, tableId) && source.displayGate === "xform:editShow") {
    return {
      index: 0,
      event: "onLoad",
      scope: "global",
      javascript: text,
      function: `function onLoad() {\n  MKXFORM.addRow('${tableId}', {})\n}`,
      translationStatus: "mapped",
      coverage: { status: "translated", nativeRules: [], residuals: [] },
      functionMappings: [{
        source: "DocList_AddRow",
        target: "MKXFORM.addRow",
        basis: "semantic-translation",
        reviewRequired: false
      }]
    };
  }
  if (isLegacyDetailWidthScript(text, tableId)) {
    return legacyDetailRuntimeOmission(text, "legacy detail-table width styling", "MK responsive detail-table layout");
  }
  return undefined;
}

function legacyDetailRuntimeOmission(javascript, sourceName, target) {
  return legacyRuntimeOmission(javascript, sourceName, target);
}

function legacyRuntimeOmission(javascript, sourceName, target) {
  return {
    index: 0,
    event: "onLoad",
    scope: "global",
    javascript,
    function: "",
    translationStatus: "omitted",
    coverage: { status: "covered", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: sourceName,
      target,
      basis: "legacy-runtime-noop",
      reviewRequired: false
    }]
  };
}

function legacyDetailTableId(text) {
  const match = String(text || "").match(/TABLE_DL_(fd_[A-Za-z0-9_]+)/);
  return match?.[1];
}

function isLegacyDetailDefaultRowScript(text, tableId) {
  return new RegExp(
    `^Com_AddEventListener\\(\\s*window\\s*,\\s*(['"])load\\1\\s*,[\\s\\S]*?DocList_AddRow\\(\\s*document\\.getElementById\\(\\s*(['"])TABLE_DL_${escapeRegExp(tableId)}\\2\\s*\\)\\s*\\)[\\s\\S]*?\\)\\s*;?\\s*$`
  ).test(text);
}

function isLegacyDetailWidthScript(text, tableId) {
  const normalized = String(text || "");
  return normalized.includes(`TABLE_DL_${tableId}`) &&
    normalized.includes(`TABLE_DL_${tableId}_div`) &&
    normalized.includes("tr[type='titleRow']") &&
    normalized.includes("tds.each") &&
    normalized.includes(".css('width'") &&
    normalized.includes(".css('width','100%')");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExecutableJavascript(value = "") {
  const text = String(value);
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
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
      return true;
    }
    if (!/\s/.test(char)) return true;
  }

  return false;
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
    semanticHints: [{
      kind: "detail_row_visibility",
      triggerTableId: parts.trigger.tableId,
      triggerControlId: parts.trigger.controlId,
      targetControlId: parts.target.controlId,
      hiddenControlId: parts.hiddenControlId,
      targetApiCandidates: [
        "MKXFORM.updateControl",
        "MKXFORM.updateControlStyle",
        "MKXFORM.setDetailFieldItemAttr"
      ],
      evidence: "Legacy DOM display toggle appears to write same-row hidden state, show/hide a detail-row control, and toggle required validation from a same-row purchase type value."
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
        semanticHints: [{
          kind: "detail_row_load_initialization",
          triggerTableId: detailDisplay.trigger.tableId,
          triggerControlId: detailDisplay.trigger.controlId,
          targetControlId: detailDisplay.target.controlId,
          hiddenControlId: detailDisplay.hiddenControlId,
          targetApiCandidates: [
            "MKXFORM.getValue",
            "MKXFORM.updateControl",
            "MKXFORM.updateControlStyle",
            "MKXFORM.setDetailFieldItemAttr"
          ],
          evidence: "Legacy window-load code initializes same-row detail control display from existing row values."
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
    const key = `${candidate.dedupeKey}:${candidate.source?.displayGate || "ungated"}`;
    if (seen.has(key)) continue;
    seen.add(key);
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

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
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
