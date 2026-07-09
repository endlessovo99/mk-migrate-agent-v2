import { COMPONENT_CATALOG, FUNCTION_CATALOG, VALIDATION_POLICY } from "../dsl/catalogs.js";
import { scriptTargetApiSummary } from "../dsl/scripts.js";
import { JSP_TRANSLATION_PLAYBOOK } from "./playbook.js";

export const AGENT_REVIEW_PROMPT_VERSION = "agent-review.form-patch.v1";

export const ALLOWED_PATCH_PATHS = [
  "/form/fields/*/title",
  "/form/fields/*/type",
  "/form/fields/*/componentId",
  "/form/fields/*/props",
  "/form/fields/*/columns/*/title",
  "/form/fields/*/columns/*/type",
  "/form/fields/*/columns/*/componentId",
  "/form/fields/*/columns/*/props",
  "/scripts/actions/*/function",
  "/scripts/actions/*/translationStatus",
  "/scripts/actions/*/functionMappings",
  "/scripts/actions/*/coverage"
];

export function buildAgentReviewPrompt(sourceDraft, dslDraft) {
  const concretePatchTargets = buildConcretePatchTargets(dslDraft);
  const allowedConcretePatchPaths = concretePatchTargets.flatMap((target) => target.allowedPatchPaths);
  const focusedScriptSourceRefs = focusedSourceRefsForScripts(dslDraft?.scripts);

  return {
    promptVersion: AGENT_REVIEW_PROMPT_VERSION,
    system: [
      "You review a NewOA/MK migration DSL draft after deterministic translation.",
      "Return only strict JSON with exactly these top-level keys: summary, patches, diagnostics.",
      "Do not return a complete DSL.",
      "Only propose evidence-backed replace patches for allowed form and script DSL paths.",
      "Patch paths must be copied exactly from allowedConcretePatchPaths. Do not invent array indexes or paths.",
      "Workflow is diagnostic-only in this version. Never patch workflow, trust, executor safety, source artifact, credentials, environment, or config paths.",
      "Every patch must include op, path, value, sourceRefs, evidence, confidence, and rationale. evidence must be a non-empty string array.",
      "Every diagnostic must include level, code, path, and message. Use diagnostics: [] when there are no diagnostics.",
      "The summary must be a non-empty string.",
      "Use sourceRef strings from the provided source draft. Do not use raw XML or invent source evidence.",
      "Title patches require confidence >= 0.7. Type, componentId, and props patches require confidence >= 0.85.",
      "Script patches require confidence >= 0.85 and must preserve the deterministic action boundary. Do not create, delete, or retarget script actions.",
      "Translate JSP scripts semantically using jspTranslationPlaybook, functionCatalog, source evidence, formRules evidence, and targetApi. Pattern matching is evidence extraction only, not the translation authority.",
      "Trusted mapped scripts must not use document/window DOM APIs.",
      "Use sourceDraft.scripts.sources[].javascriptWindows as layered source excerpts. When javascriptLength exceeds the excerpt length, do not assume the excerpt is the complete source.",
      "Non-whitelisted EKP functions are not automatically blocking. First infer their intent from source evidence and surrounding script context, then translate safely to targetApi JavaScript when confidence is high.",
      "If a non-whitelisted function cannot be safely inferred, leave the action needs_review or manual and explain the unresolved function in diagnostics.",
      "Do not downgrade deterministic mapped or native-covered omitted script actions to needs_review or manual. If confidence is insufficient, leave the action unchanged and emit a warning diagnostic.",
      "Legacy APIs listed in jspTranslationPlaybook are semantic examples and guidance; still verify each patch against the concrete source/action context.",
      "Detail-table control scripts use tableId plus controlId; preserve rowNum for row-scoped APIs.",
      "When a detail-table function refers to a runtime control id, use ${table:<sourceDetailTableId>}.<controlId>; the executor resolves this placeholder to mk_model_fd_... at write time.",
      "If native formRules already cover a JSP visibility/required rule, do not duplicate that rule in generated JavaScript.",
      "If native formRules.linkage entries with meta.sourceJsp matching the action sourceRefs fully cover the JSP behavior, patch the action to function:\"\", translationStatus:\"omitted\", and coverage:{status:\"covered\",nativeRules:[rule ids],residuals:[]}.",
      "When generated JavaScript covers source JSP behavior, patch coverage to {status:\"translated\", nativeRules:[], residuals:[]} unless native formRules cover it.",
      "Do not patch coverage for existing deterministic mapped or native-covered omitted actions to partial, uncovered, or residual-bearing coverage.",
      "Review-grade targetApi calls may be used only when the action has explicit functionMappings, coverage.status is translated or covered, and residuals are empty.",
      "onBeforeSubmit must explicitly handle context.isDraft and return true, false, or Promise<boolean>.",
      "If a workflow concern is found, emit a diagnostic instead of a patch.",
      "If no safe patches are needed, return exactly this shape with your own non-empty summary: {\"summary\":\"Reviewed form DSL; no safe patches proposed.\",\"patches\":[],\"diagnostics\":[]}"
    ].join("\n"),
    context: {
      promptVersion: AGENT_REVIEW_PROMPT_VERSION,
      task: "Review source-draft form evidence and dsl-draft form semantics, then propose restricted patches only when evidence is clear.",
      responseContract: {
        topLevelKeys: ["summary", "patches", "diagnostics"],
        patchKeys: ["op", "path", "value", "sourceRefs", "evidence", "confidence", "rationale"],
        supportedPatchOps: ["replace"],
        validPatchExample: validPatchExample(concretePatchTargets)
      },
      allowedPatchPaths: ALLOWED_PATCH_PATHS,
      patchTargetSummary: patchTargetSummary(dslDraft, concretePatchTargets, allowedConcretePatchPaths),
      allowedConcretePatchPaths,
      concretePatchTargets,
      prohibitedPatchScopes: [
        "/workflow",
        "/trust",
        "/executor",
        "/source",
        "/credentials",
        "/env",
        "/config"
      ],
      confidencePolicy: {
        title: 0.7,
        type: 0.85,
        componentId: 0.85,
        props: 0.85
      },
      formReviewPolicy: {
        mayPatch: [
          "form field titles",
          "detail table titles",
          "detail column titles",
          "metadata-supported field or column type/componentId corrections",
          "props.required, props.options, and props.maxLength when evidenced by source facts"
        ],
        mayNotPatch: [
          "workflow nodes",
          "workflow edge conditions",
          "trust metadata",
          "executor safety fields",
          "source artifact content",
          "credentials, environment, or config"
        ],
        suspiciousTitleExamples: ["itTable", "明细表4", "明细表5", "weibaoTable", "quantity", "fee", "buyCat"]
      },
      scriptTranslationPolicy: {
        mayPatch: [
          "scripts.actions[].function",
          "scripts.actions[].translationStatus",
          "scripts.actions[].functionMappings",
          "scripts.actions[].coverage"
        ],
        mayNotPatch: [
          "scripts.actions[].scope",
          "scripts.actions[].event",
          "scripts.actions[].controlId",
          "scripts.actions[].tableId",
          "scripts.actions[] array shape or order"
        ],
        statuses: {
          mapped: "fully translated and locally executable",
          needs_review: "AI attempted or source remains ambiguous; blocks execution",
          manual: "requires human-authored JavaScript; blocks execution",
          omitted: "source fragment is fully covered by native formRules and no JavaScript should run"
        },
        coverageStatuses: {
          none: "no source behavior was identified for coverage accounting",
          partial: "native rules cover some behavior but residual JSP behavior remains",
          uncovered: "source behavior remains untranslated",
          covered: "native formRules cover all source behavior and no JavaScript should run",
          translated: "generated MK JavaScript covers all source JSP behavior"
        },
        targetApi: scriptTargetApiSummary(),
        forbiddenTargetOutput: [
          "document.*",
          "window.document",
          "getElementById/getElementsByName/getElementsByTagName/getElementsByClassName",
          "querySelector/querySelectorAll",
          "setAttribute/getAttribute/removeAttribute",
          "style/className/classList DOM mutation"
        ],
        beforeSubmit: {
          draftGuardRequired: true,
          explicitBooleanOrPromiseReturnRequired: true
        },
        nonWhitelistedFunctions: {
          defaultHandling: "attempt_semantic_translation",
          blockingByDefault: false,
          inferenceSources: [
            "source script body",
            "source form controls and detail tables",
            "dsl script action boundary",
            "functionCatalog mappings for nearby calls",
            "targetApi capabilities"
          ],
          safeOutcome: "Patch function, translationStatus=mapped, functionMappings, and coverage.status=translated or covered only when the translated JavaScript uses targetApi and passes local execution validation.",
          unsafeOutcome: "Keep translationStatus as needs_review or manual and emit diagnostics naming unresolved functions and why targetApi translation was not safe."
        }
      },
      jspTranslationPlaybook: jspTranslationPlaybookSummary(),
      functionCatalog: functionCatalogSummary(),
      sourceDraft: {
        form: sourceFormSummary(sourceDraft?.form),
        scripts: scriptSourceSummary(sourceDraft?.scripts, focusedScriptSourceRefs),
        workflowSummary: summarizeWorkflow(sourceDraft?.workflow)
      },
      dslDraft: {
        form: dslFormSummary(dslDraft?.form),
        formRules: formRulesSummary(dslDraft?.formRules),
        scripts: scriptActionReviewSummary(dslDraft?.scripts),
        review: {
          warnings: dslDraft?.review?.warnings || [],
          reviewCandidates: dslDraft?.review?.reviewCandidates || []
        },
        workflowSummary: summarizeWorkflow(dslDraft?.workflow)
      },
      componentCatalog: componentCatalogSummary(),
      validationPolicy: validationPolicySummary()
    }
  };
}

export function buildAgentReviewRepairPrompt(sourceDraft, dslDraft, repair = {}) {
  const base = buildAgentReviewPrompt(sourceDraft, dslDraft);
  return {
    promptVersion: base.promptVersion,
    system: [
      base.system,
      "",
      "You are repairing a previous invalid agent-review JSON response.",
      "Return a complete replacement JSON response with exactly summary, patches, and diagnostics.",
      "Prefer fixing format, evidence, and concrete path issues only when the source evidence is clear.",
      "If a previous patch cannot be repaired with clear evidence and a concrete allowed path, remove that patch.",
      "The repaired response must pass the same local validator. Do not explain outside JSON."
    ].join("\n"),
    context: {
      ...base.context,
      task: "Repair the previous agent-review response so it satisfies the response contract and concrete patch path rules.",
      repair: {
        attempt: repair.attempt,
        previousDiagnostics: repair.diagnostics || [],
        previousRejectedPatches: repair.rejectedPatches || [],
        previousResponsePreview: previewText(repair.rawText)
      }
    }
  };
}

function buildConcretePatchTargets(dslDraft) {
  const fields = Array.isArray(dslDraft?.form?.fields) ? dslDraft.form.fields : [];
  const scriptActions = Array.isArray(dslDraft?.scripts?.actions) ? dslDraft.scripts.actions : [];
  const targets = [];
  const patchProperties = ["title", "type", "componentId", "props"];
  const scriptPatchProperties = ["function", "translationStatus", "functionMappings", "coverage"];

  fields.forEach((field, fieldIndex) => {
    const pathBase = `/form/fields/${fieldIndex}`;
    targets.push(targetSummary({
      scope: "field",
      index: fieldIndex,
      pathBase,
      value: field,
      allowedPatchPaths: patchProperties.map((property) => `${pathBase}/${property}`)
    }));

    const columns = Array.isArray(field?.columns) ? field.columns : [];
    columns.forEach((column, columnIndex) => {
      const columnPathBase = `${pathBase}/columns/${columnIndex}`;
      targets.push(targetSummary({
        scope: "column",
        fieldIndex,
        columnIndex,
        parentFieldId: field.id,
        pathBase: columnPathBase,
        value: column,
        allowedPatchPaths: patchProperties.map((property) => `${columnPathBase}/${property}`)
      }));
    });
  });

  scriptActions.forEach((action, actionIndex) => {
    const pathBase = `/scripts/actions/${actionIndex}`;
    targets.push(targetSummary({
      scope: "scriptAction",
      index: actionIndex,
      pathBase,
      value: action,
      allowedPatchPaths: scriptPatchProperties.map((property) => `${pathBase}/${property}`)
    }));
  });

  return targets;
}

function targetSummary({ scope, index, fieldIndex, columnIndex, parentFieldId, pathBase, value, allowedPatchPaths }) {
  return pruneUndefined({
    scope,
    index,
    fieldIndex,
    columnIndex,
    parentFieldId,
    pathBase,
    id: value?.id,
    title: value?.title,
    type: value?.type,
    componentId: value?.componentId,
    sourceRef: value?.sourceRef,
    event: value?.event,
    actionScope: value?.scope,
    controlId: value?.controlId,
    tableId: value?.tableId,
    translationStatus: value?.translationStatus,
    sourceRefs: value?.sourceRefs,
    allowedPatchPaths
  });
}

function patchTargetSummary(dslDraft, concretePatchTargets, allowedConcretePatchPaths) {
  const fields = Array.isArray(dslDraft?.form?.fields) ? dslDraft.form.fields : [];
  const scriptActions = Array.isArray(dslDraft?.scripts?.actions) ? dslDraft.scripts.actions : [];
  const detailColumnCount = fields.reduce((sum, field) => sum + (Array.isArray(field?.columns) ? field.columns.length : 0), 0);
  return {
    fieldCount: fields.length,
    validFieldIndexRange: fields.length ? `0..${fields.length - 1}` : "",
    detailColumnCount,
    scriptActionCount: scriptActions.length,
    concreteTargetCount: concretePatchTargets.length,
    concretePatchPathCount: allowedConcretePatchPaths.length
  };
}

function validPatchExample(concretePatchTargets) {
  const target = concretePatchTargets.find((item) => item.sourceRef) || concretePatchTargets[0];
  if (!target) {
    return {
      op: "replace",
      path: "/form/fields/0/title",
      value: "业务字段标题",
      sourceRefs: ["copy-a-sourceRef-from-sourceDraft"],
      evidence: ["copy a specific source fact that supports this patch"],
      confidence: 0.9,
      rationale: "Use only paths from allowedConcretePatchPaths and sourceRefs from sourceDraft."
    };
  }

  return {
    op: "replace",
    path: `${target.pathBase}/title`,
    value: target.title || "业务字段标题",
    sourceRefs: [target.sourceRef].filter(Boolean),
    evidence: [`${target.sourceRef || target.pathBase} provides explicit source evidence for this patch`],
    confidence: 0.9,
    rationale: "The source evidence is explicit and the target path is listed in allowedConcretePatchPaths."
  };
}

function componentCatalogSummary() {
  return COMPONENT_CATALOG.components
    .filter((component) => component.kind === "field")
    .map((component) => ({
      componentId: component.componentId,
      kind: component.kind,
      label: component.label,
      allowedScopes: component.allowedScopes,
      props: Object.keys(component.propsSchema?.properties || {})
    }));
}

function functionCatalogSummary() {
  return {
    id: FUNCTION_CATALOG.id,
    version: FUNCTION_CATALOG.version,
    source: FUNCTION_CATALOG.source,
    functions: FUNCTION_CATALOG.functions.map((fn) => ({
      name: fn.name,
      description: fn.description || "",
      mkFunction: fn.mkFunction || "",
      intent: fn.intent || "",
      targetApis: fn.targetApis || [],
      translationKind: fn.translationKind || "",
      safety: fn.safety || "",
      notes: fn.notes || ""
    }))
  };
}

function jspTranslationPlaybookSummary() {
  return {
    id: JSP_TRANSLATION_PLAYBOOK.id,
    version: JSP_TRANSLATION_PLAYBOOK.version,
    goal: JSP_TRANSLATION_PLAYBOOK.goal,
    principles: JSP_TRANSLATION_PLAYBOOK.principles,
    legacyApis: JSP_TRANSLATION_PLAYBOOK.legacyApis,
    targetApiCapabilities: JSP_TRANSLATION_PLAYBOOK.targetApiCapabilities,
    allowedPatterns: JSP_TRANSLATION_PLAYBOOK.allowedPatterns,
    forbiddenPatterns: JSP_TRANSLATION_PLAYBOOK.forbiddenPatterns,
    coverageStandards: JSP_TRANSLATION_PLAYBOOK.coverageStandards,
    fewShotExamples: JSP_TRANSLATION_PLAYBOOK.fewShotExamples
  };
}

function sourceFormSummary(form = {}) {
  const controls = Array.isArray(form?.controls) ? form.controls : [];
  const detailTables = Array.isArray(form?.detailTables) ? form.detailTables : [];
  return {
    controlCount: controls.length,
    detailTableCount: detailTables.length,
    layout: layoutSummary(form?.layout),
    controls: controls.map(sourceControlSummary),
    detailTables: detailTables.map((table) => ({
      id: table.id,
      title: table.title,
      sourceRef: table.sourceRef,
      sourceType: table.sourceType,
      columnCount: Array.isArray(table.columns) ? table.columns.length : 0,
      columns: (table.columns || []).map(sourceControlSummary)
    }))
  };
}

function sourceControlSummary(control = {}) {
  return pruneUndefined({
    id: control.id,
    title: control.title,
    sourceRef: control.sourceRef,
    sourceType: control.sourceType,
    required: control.required,
    sourceProps: compactSourceProps(control.sourceProps),
    evidence: control.evidence
  });
}

function dslFormSummary(form = {}) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  return {
    fieldCount: fields.length,
    layout: layoutSummary(form?.layout),
    fields: fields.map(dslFieldSummary)
  };
}

function dslFieldSummary(field = {}) {
  return pruneUndefined({
    id: field.id,
    title: field.title,
    type: field.type,
    componentId: field.componentId,
    props: field.props,
    sourceRef: field.sourceRef,
    sourceProps: compactSourceProps(field.sourceProps),
    columnCount: Array.isArray(field.columns) ? field.columns.length : undefined,
    columns: Array.isArray(field.columns) ? field.columns.map(dslFieldSummary) : undefined
  });
}

function compactSourceProps(sourceProps = {}) {
  if (!isRecord(sourceProps)) return undefined;
  return pruneUndefined({
    designerType: sourceProps.designerType,
    metadataKind: sourceProps.metadataKind,
    designerValues: pick(sourceProps.designerValues, [
      "label",
      "required",
      "readOnly",
      "businessType",
      "multiSelect",
      "defaultValue",
      "_orgType",
      "_org_org",
      "_org_dept",
      "_org_person"
    ]),
    metadataAttributes: pick(sourceProps.metadataAttributes, [
      "label",
      "type",
      "defaultValue",
      "formula",
      "kind"
    ])
  });
}

function layoutSummary(layout = {}) {
  if (!isRecord(layout)) return undefined;
  const mkTree = Array.isArray(layout.mkTree) ? layout.mkTree : [];
  const rows = Array.isArray(layout.rows) ? layout.rows : [];
  return pruneUndefined({
    rowCount: rows.length || mkTree.length,
    mkTreeCount: mkTree.length,
    cellCount: rows.reduce((sum, row) => sum + (Array.isArray(row?.cells) ? row.cells.length : 0), 0),
    sourceRefs: rows.slice(0, 12).map((row) => row?.sourceRef).filter(Boolean),
    sourceMarkers: mkTree
      .filter((row) => Array.isArray(row?.sourceMarkers) && row.sourceMarkers.length)
      .map((row) => ({
        rowId: row.id,
        sourceMarkers: row.sourceMarkers,
        refIds: (row.children || []).flatMap((child) => childRefIds(child))
      }))
  });
}

function childRefIds(child = {}) {
  if (Array.isArray(child.refIds)) return child.refIds.filter(Boolean);
  return child.refId ? [child.refId] : [];
}

function formRulesSummary(formRules = {}) {
  const linkage = Array.isArray(formRules?.linkage) ? formRules.linkage : [];
  return {
    linkageCount: linkage.length,
    linkage: linkage.map((rule) => ({
      id: rule.id,
      trigger: rule.trigger,
      source: rule.source,
      logic: rule.logic,
      when: rule.when,
      effects: rule.effects,
      else: rule.else,
      translationStatus: rule.translationStatus,
      meta: rule.meta
    }))
  };
}

function scriptSourceSummary(scripts = {}, focusedRefs) {
  if (!scripts) return {};
  const hasFocusedRefs = focusedRefs instanceof Set && focusedRefs.size > 0;
  return pruneUndefined({
    source: scripts.source,
    displayJsp: scripts.displayJsp,
    fragments: (scripts.fragments || []).map((fragment) => ({
      id: fragment.id,
      sourceRef: fragment.sourceRef,
      sourceKey: fragment.sourceKey,
      sourceType: fragment.sourceType,
      length: fragment.length
    })),
    sources: (scripts.sources || []).map((source) => {
      const focused = !hasFocusedRefs || focusedRefs.has(source.sourceRef) || focusedRefs.has(source.id);
      return {
        id: source.id,
        sourceRef: source.sourceRef,
        sourceKey: source.sourceKey,
        sourceType: source.sourceType,
        fragmentId: source.fragmentId,
        javascriptLength: String(source.javascript || "").length,
        javascriptWindows: focused ? sourceJavascriptWindows(source) : undefined,
        functionAudit: focused ? compactFunctionAudit(source.functionAudit) : compactFunctionAuditNames(source.functionAudit),
        semanticFacts: semanticFactsSummary(source.semanticFacts, focused)
      };
    })
  });
}

function semanticFactsSummary(facts = {}, focused = false) {
  if (!isRecord(facts)) return undefined;
  const fieldIds = Array.isArray(facts.fieldIds) ? facts.fieldIds : [];
  return pruneUndefined({
    legacyFunctionCalls: (facts.legacyFunctionCalls || []).map((call) => pruneUndefined({
      name: call.name,
      intent: call.intent,
      translationKind: call.translationKind,
      safety: call.safety,
      targetApis: call.targetApis,
      occurrenceCount: call.occurrenceCount,
      firstIndex: call.firstIndex,
      firstSnippet: focused ? previewText(call.firstSnippet, 180) : undefined
    })),
    fieldIdCount: fieldIds.length,
    fieldIds: fieldIds.slice(0, focused ? 40 : 12),
    rowMarkers: (facts.rowMarkers || []).slice(0, focused ? 24 : 6),
    eventBindings: (facts.eventBindings || []).slice(0, focused ? 12 : 4)
  });
}

function focusedSourceRefsForScripts(scripts = {}) {
  const actions = Array.isArray(scripts?.actions) ? scripts.actions : [];
  const refs = new Set();
  actions
    .filter((action) => action.translationStatus === "needs_review")
    .slice(0, 12)
    .forEach((action) => {
      for (const ref of action.sourceRefs || []) refs.add(ref);
    });
  return refs;
}

function scriptActionReviewSummary(scripts = {}) {
  const actions = Array.isArray(scripts?.actions) ? scripts.actions : [];
  const focusedIndexes = new Set(
    actions
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => action.translationStatus === "needs_review")
      .slice(0, 12)
      .map(({ index }) => index)
  );

  return pruneUndefined({
    source: scripts?.source,
    actionCount: actions.length,
    focusedActionIndexes: [...focusedIndexes],
    actions: actions.map((action, index) => {
      const focused = focusedIndexes.has(index);
      return {
        index,
        id: action.id,
        name: action.name,
        event: action.event,
        scope: action.scope,
        controlId: action.controlId,
        tableId: action.tableId,
        sourceRefs: action.sourceRefs,
        translationStatus: action.translationStatus,
        coverage: coverageSummary(action.coverage, focused ? 4 : 0),
        functionMappings: functionMappingSummary(action.functionMappings, focused ? 8 : 0),
        semanticHints: action.semanticHints,
        unmappedFunctions: focused ? action.unmappedFunctions : undefined,
        functionLength: String(action.function || "").length,
        functionPreview: previewText(action.function, focused ? 2200 : 180)
      };
    })
  });
}

function sourceJavascriptWindows(source = {}) {
  const text = String(source.javascript || "");
  if (!text) return [];
  if (text.length <= 1800) {
    return [{ label: "full", start: 0, end: text.length, text }];
  }

  const windows = [];
  pushWindow(windows, text, "head", 0, 700);
  pushWindow(windows, text, "tail", Math.max(0, text.length - 700), text.length);
  for (const occurrence of selectedAuditOccurrences(source.functionAudit)) {
    const start = Math.max(0, occurrence.index - 260);
    const end = Math.min(text.length, occurrence.index + 520);
    pushWindow(windows, text, `around:${occurrence.name}`, start, end);
  }
  return windows;
}

function selectedAuditOccurrences(functionAudit = {}) {
  const items = [];
  const matched = Array.isArray(functionAudit?.matched) ? functionAudit.matched : [];
  for (const fn of matched) {
    const occurrences = Array.isArray(fn?.occurrences) ? fn.occurrences : [];
    for (const occurrence of occurrences) {
      if (Number.isInteger(occurrence?.index)) {
        items.push({
          name: fn.name,
          index: occurrence.index,
          priority: auditOccurrencePriority(fn)
        });
      }
    }
  }
  return items
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .filter(dedupeBySourceRegion())
    .slice(0, 8);
}

function auditOccurrencePriority(fn = {}) {
  if (["AttachXFormValueChangeEventById", "Com_AddEventListener"].includes(fn.name)) return 0;
  if (fn.translationKind === "action_boundary") return 1;
  if (fn.translationKind === "native_rule_or_style") return 2;
  if (fn.safety === "blocked") return 3;
  return 4;
}

function dedupeBySourceRegion() {
  const seen = new Set();
  return (item) => {
    const bucket = Math.floor(item.index / 900);
    const key = `${item.name}:${bucket}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function pushWindow(windows, text, label, start, end) {
  const normalizedStart = Math.max(0, start);
  const normalizedEnd = Math.min(text.length, end);
  if (normalizedEnd <= normalizedStart) return;
  const overlaps = windows.some((window) => (
    normalizedStart >= window.start - 120 &&
    normalizedEnd <= window.end + 120
  ));
  if (overlaps) return;
  windows.push({
    label,
    start: normalizedStart,
    end: normalizedEnd,
    text: text.slice(normalizedStart, normalizedEnd)
  });
}

function compactFunctionAudit(functionAudit = {}) {
  if (!functionAudit) return undefined;
  return pruneUndefined({
    sourcePath: functionAudit.sourcePath,
    matched: compactAuditEntries(functionAudit.matched, false),
    violations: compactAuditEntries(functionAudit.violations, true)
  });
}

function compactFunctionAuditNames(functionAudit = {}) {
  if (!functionAudit) return undefined;
  return pruneUndefined({
    sourcePath: functionAudit.sourcePath,
    matched: compactAuditNameEntries(functionAudit.matched),
    violations: compactAuditNameEntries(functionAudit.violations)
  });
}

function compactAuditNameEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => pruneUndefined({
    name: entry?.name,
    intent: entry?.intent || "",
    translationKind: entry?.translationKind || "",
    safety: entry?.safety || "",
    occurrenceCount: Array.isArray(entry?.occurrences) ? entry.occurrences.length : 0
  }));
}

function compactAuditEntries(entries, includeSnippet) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    const occurrences = Array.isArray(entry?.occurrences) ? entry.occurrences : [];
    return pruneUndefined({
      name: entry?.name,
      intent: entry?.intent || "",
      targetApis: entry?.targetApis || [],
      translationKind: entry?.translationKind || "",
      safety: entry?.safety || "",
      occurrenceCount: occurrences.length,
      firstIndex: occurrences[0]?.index,
      lastIndex: occurrences.length > 1 ? occurrences.at(-1)?.index : undefined,
      sample: includeSnippet ? compactOccurrence(occurrences[0]) : undefined
    });
  });
}

function compactOccurrence(occurrence) {
  if (!occurrence) return undefined;
  return {
    index: occurrence.index,
    snippet: previewText(occurrence.snippet, 220)
  };
}

function coverageSummary(coverage = {}, maxResiduals = 1) {
  if (!coverage) return undefined;
  return pruneUndefined({
    status: coverage.status,
    nativeRules: Array.isArray(coverage.nativeRules) ? coverage.nativeRules.slice(0, 8) : coverage.nativeRules,
    residuals: Array.isArray(coverage.residuals)
      ? coverage.residuals.slice(0, maxResiduals).map(compactResidual)
      : coverage.residuals,
    residualCount: Array.isArray(coverage.residuals) ? coverage.residuals.length : undefined
  });
}

function functionMappingSummary(functionMappings, maxMappings) {
  if (!Array.isArray(functionMappings)) return functionMappings;
  if (maxMappings <= 0) {
    return { count: functionMappings.length };
  }
  return {
    count: functionMappings.length,
    items: functionMappings.slice(0, maxMappings).map((mapping) => pruneUndefined({
      source: mapping?.source,
      target: mapping?.target,
      basis: mapping?.basis,
      reviewRequired: mapping?.reviewRequired
    }))
  };
}

function compactResidual(residual) {
  if (!isRecord(residual)) return residual;
  return pruneUndefined({
    code: residual.code,
    type: residual.type,
    message: residual.message,
    sourceRef: residual.sourceRef,
    evidence: previewText(residual.evidence, 260)
  });
}

function validationPolicySummary() {
  return {
    id: VALIDATION_POLICY.id,
    version: VALIDATION_POLICY.version,
    blocking: VALIDATION_POLICY.blocking,
    warnings: VALIDATION_POLICY.warnings
  };
}

function summarizeWorkflow(workflow) {
  if (!workflow) return undefined;
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  const nodeLimit = 30;
  const edgeLimit = 30;
  return {
    process: workflow.process || {},
    nodeCount: nodes.length,
    edgeCount: edges.length,
    omittedNodeCount: Math.max(0, nodes.length - nodeLimit),
    omittedEdgeCount: Math.max(0, edges.length - edgeLimit),
    nodes: nodes.slice(0, nodeLimit).map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type || node.sourceType,
      element: node.element,
      translationStatus: node.translationStatus
    })),
    edges: edges.slice(0, edgeLimit).map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      name: edge.name,
      condition: summarizeWorkflowCondition(edge)
    }))
  };
}

function summarizeWorkflowCondition(edge) {
  if (isRecord(edge.condition)) {
    return {
      sourceText: edge.condition.sourceText || "",
      displayText: edge.condition.displayText || "",
      targetText: edge.condition.targetText || "",
      translationStatus: edge.condition.translationStatus
    };
  }
  if (edge.condition || edge.displayCondition) {
    return {
      sourceText: edge.condition || "",
      displayText: edge.displayCondition || "",
      targetText: edge.condition || "",
      translationStatus: edge.condition ? "source_condition" : undefined
    };
  }
  return undefined;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function previewText(value = "", maxLength = 6000) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function pick(value, keys) {
  if (!isRecord(value)) return undefined;
  const picked = {};
  for (const key of keys) {
    if (value[key] !== undefined) picked[key] = value[key];
  }
  return Object.keys(picked).length ? picked : undefined;
}

function pruneUndefined(value) {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, pruneUndefined(child)])
  );
}
