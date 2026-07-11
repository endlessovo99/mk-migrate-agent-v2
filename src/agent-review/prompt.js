import { COMPONENT_CATALOG, FUNCTION_CATALOG, VALIDATION_POLICY } from "../dsl/catalogs.js";
import { scriptTargetApiSummary } from "../dsl/scripts.js";
import { JSP_TRANSLATION_PLAYBOOK } from "./playbook.js";
import {
  classifyActionRowMarkers,
  legacySourceFromGeneratedFunction,
  rowMarkersFromText
} from "./row-marker-policy.js";

export const AGENT_REVIEW_PROMPT_VERSION = "agent-review.scoped-batches.v3";

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

export function buildAgentReviewPrompt(sourceDraft, dslDraft, options = {}) {
  const reviewScope = options.reviewScope === undefined
    ? undefined
    : normalizeReviewScope(options.reviewScope, dslDraft?.scripts?.actions);
  const concretePatchTargets = buildConcretePatchTargets(dslDraft, reviewScope);
  const allowedConcretePatchPaths = concretePatchTargets.flatMap((target) => target.allowedPatchPaths);
  const focusedActionIndexes = reviewScope?.actionIndexes;
  const focusedScriptSourceRefs = focusedSourceRefsForScripts(dslDraft?.scripts, focusedActionIndexes);
  const allowedPatchPaths = allowedPatchPatterns(reviewScope);

  return {
    promptVersion: AGENT_REVIEW_PROMPT_VERSION,
    system: [
      "You review a NewOA/MK migration DSL draft after deterministic translation.",
      "Return only strict JSON with exactly these top-level keys: summary, patches, diagnostics.",
      "Do not return a complete DSL.",
      "Only propose evidence-backed replace patches for allowed form and script DSL paths.",
      "Patch paths must be copied exactly from allowedConcretePatchPaths. Do not invent array indexes or paths.",
      "When reviewScope is present, it is authoritative. Do not patch form fields or script actions outside that scope.",
      "Workflow is diagnostic-only in this version. Never patch workflow, trust, executor safety, source artifact, credentials, environment, or config paths.",
      "Every patch must include op, path, value, sourceRefs, evidence, confidence, and rationale. evidence must be a non-empty string array.",
      "Every diagnostic must include level, code, path, and message. Use diagnostics: [] when there are no diagnostics.",
      "The summary must be a non-empty string.",
      "Use sourceRef strings from the provided source draft. Do not use raw XML or invent source evidence.",
      "Title patches require confidence >= 0.7. Type, componentId, and props patches require confidence >= 0.85.",
      "Script patches require confidence >= 0.85 and must preserve the deterministic action boundary. Do not create, delete, or retarget script actions.",
      "scripts.actions[].runWhen is immutable source-derived execution context. Never patch, remove, or reproduce it inside the reviewed business function; the executor injects the canonical MKXFORM.viewStatus guard.",
      "Gated native coverage may remove only the action-local behavior covered by executable formRules; it does not remove or weaken the immutable runWhen audit context.",
      "Keep runWhen on any residual JavaScript, and translate only residual behavior such as marker setValue or effects not represented by native/static coverage.",
      "Do not duplicate visible or required effects already covered by native formRules in residual JavaScript.",
      "A gated action may be omitted only when its function is empty, coverage.status=\"covered\", coverage.nativeRules references executable rules, coverage.residuals is empty, and native coverage fully covers the action-local behavior; preserve runWhen as audit evidence.",
      "Translate JSP scripts semantically using jspTranslationPlaybook, functionCatalog, source evidence, formRules evidence, and targetApi. Pattern matching is evidence extraction only, not the translation authority.",
      "Trusted mapped scripts must not use document/window DOM APIs.",
      "Use dslDraft.scripts.actions[].actionSource as the action-local JSP excerpt. Treat sourceDraft.scripts.sources[].javascriptWindows as background context; do not charge helper definitions or other callbacks to a specific action unless the action-local excerpt invokes them and their behavior is not otherwise covered.",
      "Use reviewOpportunities only as evidence scaffolding. They are not deterministic translation results; accept them only when action-local source, formRules, targetApi, and playbook coverage standards agree.",
      "Native-covered closure rule: when action-local behavior is fully covered, coverage.status=\"covered\", coverage.nativeRules references executable rules, and coverage.residuals is empty, close that action as native-covered omitted while preserving runWhen audit evidence. Patch function:\"\", translationStatus:\"omitted\", functionMappings to native-form-rule evidence, and preserve covered coverage/nativeRules/residuals. Do not invent residuals from DOM/helper noise for these already-covered actions.",
      "Static-property closure rule: when an ungated action only sets a form property already present in the DSL, coverage.staticProps records the exact {fieldId,prop,value} evidence. If coverage.status=\"covered\" and residuals is empty, patch function:\"\", translationStatus:\"omitted\", functionMappings with basis static-form-prop, and preserve nativeRules:[], staticProps, and residuals:[]; never invent a formRule id.",
      "For detail-row visibility candidates, legacy onclick/setAttribute/__xformDispatch snippets are event-binding scaffolding when the DSL action already has event=onChange and matching tableId/controlId. Do not treat that scaffolding as residual; translate the action-local business function body instead.",
      "Use sourceDraft.scripts.sources[].javascriptWindows as layered source excerpts. When javascriptLength exceeds the excerpt length, do not assume the excerpt is the complete source.",
      "Non-whitelisted EKP functions are not automatically blocking. First infer their intent from source evidence and surrounding script context, then translate safely to targetApi JavaScript when confidence is high.",
      "If a non-whitelisted function cannot be safely inferred, leave the action needs_review or manual and explain the unresolved function in diagnostics.",
      "Do not downgrade deterministic mapped or coverage-backed omitted script actions to needs_review or manual. If confidence is insufficient, leave the action unchanged and emit a warning diagnostic.",
      "Legacy APIs listed in jspTranslationPlaybook are semantic examples and guidance; still verify each patch against the concrete source/action context.",
      "Detail-table control scripts use tableId plus controlId; preserve rowNum for row-scoped APIs.",
      "When a detail-table function refers to a runtime control id inside a detail row, use ${table:<sourceDetailTableId>}.<controlId>; the executor resolves this placeholder to mk_model_fd_... at write time.",
      "Whole-row or whole detail-table container visibility/required state must prefer native formRules.linkage against layout sourceMarkers (including detail-table-only rows). Do not use ${table:<detailTableId>} or the detail-table field id as an MKXFORM.setFieldAttr target.",
      "Only the first sourceMarker on a layout row is persisted as migrationRowId. When a row lists multiple sourceMarkers, rewrite every co-located alias to that primary marker in MKXFORM.setFieldAttr calls.",
      "Treat a literal missing row marker as an auditable orphan no-op only when sourceDraft.issues contains source.sysform.script_row_marker_orphan_noop for the action sourceRef and its proof says absentFromLayout=true, onlyHelperTarget=true, resetAlwaysFalse=true, and dynamicDomCreationDetected=false.",
      "Never generate MKXFORM.setFieldAttr for an orphan marker. Translate every remaining resolved marker and helper behavior, use coverage.status=translated only when no unresolved residual remains, and preserve the Source Draft warning in the Trusted DSL audit record.",
      "If native formRules already cover a JSP visibility/required rule, do not duplicate that rule in generated JavaScript.",
      "If native formRules.linkage entries with meta.sourceJsp or meta.sourceJsps matching the action sourceRefs fully cover the action-local JSP behavior, patch the action to function:\"\", translationStatus:\"omitted\", and coverage:{status:\"covered\",nativeRules:[executable rule ids],residuals:[]}; preserve runWhen.",
      "When native formRules cover only part of an action, retain mapped residual JavaScript for uncovered setValue or other behavior, preserve runWhen, exclude covered visible/required calls, and close coverage with the executable native rule ids plus no remaining residuals.",
      "When generated JavaScript alone covers source JSP behavior, patch coverage to {status:\"translated\", nativeRules:[], residuals:[]}.",
      "Do not patch coverage for existing deterministic mapped or coverage-backed omitted actions to partial, uncovered, or residual-bearing coverage.",
      "Review-grade targetApi calls may be used only when the action has explicit functionMappings, coverage.status is translated or covered, and residuals are empty.",
      "onBeforeSubmit must explicitly handle context.isDraft and return true, false, or Promise<boolean>.",
      "If a workflow concern is found, emit a diagnostic instead of a patch.",
      "If no safe patches are needed, return exactly this shape with your own non-empty summary: {\"summary\":\"Reviewed form DSL; no safe patches proposed.\",\"patches\":[],\"diagnostics\":[]}"
    ].join("\n"),
    context: {
      promptVersion: AGENT_REVIEW_PROMPT_VERSION,
      reviewScope,
      task: reviewScope
        ? "Review only the scoped form targets and script actions, then propose restricted patches only when evidence is clear."
        : "Review source-draft form evidence and dsl-draft form semantics, then propose restricted patches only when evidence is clear.",
      responseContract: {
        topLevelKeys: ["summary", "patches", "diagnostics"],
        patchKeys: ["op", "path", "value", "sourceRefs", "evidence", "confidence", "rationale"],
        supportedPatchOps: ["replace"],
        validPatchExample: validPatchExample(concretePatchTargets)
      },
      allowedPatchPaths,
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
        mayPatch: reviewScope && !reviewScope.includeFormTargets ? [] : [
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
          "scripts.actions[].runWhen",
          "scripts.actions[] array shape or order"
        ],
        statuses: {
          mapped: "fully translated and locally executable",
          needs_review: "AI attempted or source remains ambiguous; blocks execution",
          manual: "requires human-authored JavaScript; blocks execution",
          omitted: "source fragment is fully covered by native formRules or verified static form properties and no JavaScript should run"
        },
        coverageStatuses: {
          none: "no source behavior was identified for coverage accounting",
          partial: "native rules cover some behavior but residual JSP behavior remains",
          uncovered: "source behavior remains untranslated",
          covered: "native formRules or verified static form properties cover all source behavior and no JavaScript should run",
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
        scripts: scriptSourceSummary(sourceDraft?.scripts, focusedScriptSourceRefs, reviewScope !== undefined),
        issues: sourceIssueSummary(sourceDraft?.issues),
        workflowSummary: summarizeWorkflow(sourceDraft?.workflow)
      },
      dslDraft: {
        form: dslFormSummary(dslDraft?.form),
        formRules: formRulesSummary(dslDraft?.formRules),
        scripts: scriptActionReviewSummary(dslDraft?.scripts, dslDraft?.formRules, dslDraft?.form, focusedActionIndexes, sourceDraft),
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
  const base = buildAgentReviewPrompt(sourceDraft, dslDraft, { reviewScope: repair.reviewScope });
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

function normalizeReviewScope(reviewScope, actions = []) {
  const availableActions = Array.isArray(actions) ? actions : [];
  const actionIndexes = [...new Set(Array.isArray(reviewScope?.actionIndexes) ? reviewScope.actionIndexes : [])]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < availableActions.length)
    .sort((left, right) => left - right);
  return {
    actionIndexes,
    actionIds: actionIndexes.map((index) => availableActions[index]?.id || `action-${index}`),
    includeFormTargets: reviewScope?.includeFormTargets === true
  };
}

function allowedPatchPatterns(reviewScope) {
  if (!reviewScope) return ALLOWED_PATCH_PATHS;
  const patterns = [];
  if (reviewScope.includeFormTargets) patterns.push(...ALLOWED_PATCH_PATHS.slice(0, 8));
  if (reviewScope.actionIndexes.length) patterns.push(...ALLOWED_PATCH_PATHS.slice(8));
  return patterns;
}

function buildConcretePatchTargets(dslDraft, reviewScope) {
  const fields = Array.isArray(dslDraft?.form?.fields) ? dslDraft.form.fields : [];
  const scriptActions = Array.isArray(dslDraft?.scripts?.actions) ? dslDraft.scripts.actions : [];
  const targets = [];
  const patchProperties = ["title", "type", "componentId", "props"];
  const scriptPatchProperties = ["function", "translationStatus", "functionMappings", "coverage"];

  if (!reviewScope || reviewScope.includeFormTargets) fields.forEach((field, fieldIndex) => {
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
    if (reviewScope && !reviewScope.actionIndexes.includes(actionIndex)) return;
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
    return undefined;
  }
  if (target.scope === "scriptAction") {
    return {
      op: "replace",
      path: `${target.pathBase}/translationStatus`,
      value: "mapped",
      sourceRefs: target.sourceRefs || [],
      evidence: [`${target.sourceRefs?.[0] || target.pathBase} supports a complete semantic script translation`],
      confidence: 0.9,
      rationale: "Use only paths from the scoped allowedConcretePatchPaths."
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
  const dataFields = Array.isArray(form?.dataFields) ? form.dataFields : [];
  const detailTables = Array.isArray(form?.detailTables) ? form.detailTables : [];
  return {
    controlCount: controls.length,
    dataFieldCount: dataFields.length,
    detailTableCount: detailTables.length,
    layout: layoutSummary(form?.layout),
    controls: controls.map(sourceControlSummary),
    dataFields: dataFields.map(sourceControlSummary),
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

function sourceIssueSummary(issues = []) {
  if (!Array.isArray(issues)) return [];
  return issues
    .filter((issue) => issue?.code === "source.sysform.script_row_marker_orphan_noop")
    .map((issue) => pruneUndefined({
      level: issue?.level,
      code: issue?.code,
      message: issue?.message,
      sourcePath: issue?.sourcePath,
      evidence: issue?.evidence
    }));
}

function sourceControlSummary(control = {}) {
  return pruneUndefined({
    id: control.id,
    title: control.title,
    sourceRef: control.sourceRef,
    sourceType: control.sourceType,
    required: control.required,
    dataOnly: control.dataOnly,
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
    dataOnly: field.dataOnly,
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
      "kind",
      "canDisplay",
      "canShow",
      "showStatus"
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
        persistedMarker: row.sourceMarkers[0],
        aliasMarkers: row.sourceMarkers.slice(1),
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

function scriptSourceSummary(scripts = {}, focusedRefs, hasExplicitFocus = false) {
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
      const focused = hasExplicitFocus
        ? hasFocusedRefs && (focusedRefs.has(source.sourceRef) || focusedRefs.has(source.id))
        : !hasFocusedRefs || focusedRefs.has(source.sourceRef) || focusedRefs.has(source.id);
      return {
        id: source.id,
        sourceRef: source.sourceRef,
        sourceKey: source.sourceKey,
        sourceType: source.sourceType,
        fragmentId: source.fragmentId,
        displayGate: source.displayGate,
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

function focusedSourceRefsForScripts(scripts = {}, focusedActionIndexes) {
  const actions = Array.isArray(scripts?.actions) ? scripts.actions : [];
  const refs = new Set();
  const focusedActions = Array.isArray(focusedActionIndexes)
    ? focusedActionIndexes.map((index) => actions[index]).filter(Boolean)
    : actions.filter((action) => action.translationStatus === "needs_review").slice(0, 12);
  focusedActions
    .forEach((action) => {
      for (const ref of action.sourceRefs || []) refs.add(ref);
    });
  return refs;
}

function scriptActionReviewSummary(scripts = {}, formRules = {}, form = {}, focusedActionIndexes, sourceDraft = {}) {
  const actions = Array.isArray(scripts?.actions) ? scripts.actions : [];
  const focusedIndexes = new Set(Array.isArray(focusedActionIndexes)
    ? focusedActionIndexes
    : actions
        .map((action, index) => ({ action, index }))
        .filter(({ action }) => action.translationStatus === "needs_review")
        .slice(0, 12)
        .map(({ index }) => index));

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
        runWhen: action.runWhen,
        sourceRefs: action.sourceRefs,
        translationStatus: action.translationStatus,
        coverage: coverageSummary(action.coverage, focused ? 4 : 0),
        functionMappings: functionMappingSummary(action.functionMappings, focused ? 8 : 0),
        semanticHints: action.semanticHints,
        reviewOpportunities: focused ? reviewOpportunitiesForAction(action, formRules, index, form, sourceDraft) : undefined,
        actionSource: focused ? actionSourceSummary(action, 6200) : actionSourceSummary(action, 520),
        unmappedFunctions: focused ? action.unmappedFunctions : undefined,
        functionLength: String(action.function || "").length,
        functionPreview: previewText(action.function, focused ? 2200 : 180)
      };
    })
  });
}

function actionSourceSummary(action = {}, limit = 1200) {
  const source = legacySourceFromGeneratedFunction(action.function);
  if (!source) return undefined;
  return pruneUndefined({
    excerptLength: Math.min(source.length, limit),
    originalLength: source.length,
    truncated: source.length > limit,
    excerpt: previewText(source, limit),
    fieldIds: uniqueStrings([...source.matchAll(/\bfd_[A-Za-z0-9_]+\b/g)].map((match) => match[0])).slice(0, 32),
    rowMarkers: rowMarkersFromText(source).slice(0, 32),
    legacyCalls: legacyCallsFromText(source).slice(0, 16)
  });
}

function legacyCallsFromText(text = "") {
  const names = [
    "AttachXFormValueChangeEventById",
    "Com_AddEventListener",
    "GetXFormFieldById",
    "GetXFormFieldValueById",
    "SetXFormFieldValueById",
    "common_dom_row_set_show_required_reset",
    "document.getElementById",
    "document.getElementsByName",
    "document.getElementsByTagName"
  ];
  return names
    .map((name) => ({
      name,
      occurrenceCount: countOccurrences(text, name),
      firstSnippet: snippetAround(text, String(text || "").indexOf(name), 180)
    }))
    .filter((item) => item.occurrenceCount > 0);
}

function reviewOpportunitiesForAction(action = {}, formRules = {}, actionIndex, form = {}, sourceDraft = {}) {
  const opportunities = [];
  const coverage = action.coverage || {};
  const residuals = Array.isArray(coverage.residuals) ? coverage.residuals : [];
  const staticProps = Array.isArray(coverage.staticProps) ? coverage.staticProps : [];
  if (action.runWhen === undefined && coverage.status === "covered" && staticProps.length && residuals.length === 0) {
    opportunities.push({
      kind: "static_property_coverage_candidate",
      actionIndex,
      candidatePatchPaths: [
        `/scripts/actions/${actionIndex}/function`,
        `/scripts/actions/${actionIndex}/translationStatus`,
        `/scripts/actions/${actionIndex}/functionMappings`,
        `/scripts/actions/${actionIndex}/coverage`
      ],
      staticProps,
      requiredDecision: "Patch this action to omitted because verified static form properties fully cover the action-local behavior; do not invent a native formRule id.",
      requiredPatchShape: {
        function: "",
        translationStatus: "omitted",
        functionMappings: [{
          source: "legacy JSP static form-property assignment",
          target: "form.fields[].props",
          basis: "static-form-prop",
          reviewRequired: false
        }],
        coverage: {
          status: "covered",
          nativeRules: [],
          staticProps,
          residuals: []
        }
      },
      residualPolicy: "Keep the action needs_review if its source body performs anything beyond the listed static properties."
    });
  }
  if (coverage.status === "covered" && Array.isArray(coverage.nativeRules) && coverage.nativeRules.length && residuals.length === 0) {
    opportunities.push({
      kind: "native_coverage_candidate",
      actionIndex,
      candidatePatchPaths: [
        `/scripts/actions/${actionIndex}/function`,
        `/scripts/actions/${actionIndex}/translationStatus`,
        `/scripts/actions/${actionIndex}/functionMappings`,
        `/scripts/actions/${actionIndex}/coverage`
      ],
      nativeRules: nativeRuleSummaries(formRules, coverage.nativeRules),
      requiredDecision: "Patch this action to omitted/native-covered. The draft coverage fact already says native formRules fully cover this action: status=covered, nativeRules non-empty, residuals empty.",
      requiredPatchShape: {
        function: "",
        translationStatus: "omitted",
        functionMappings: [{
          source: "legacy JSP row visibility/required behavior",
          target: "native formRules.linkage",
          basis: "native-form-rule",
          reviewRequired: false
        }],
        coverage: {
          status: "covered",
          nativeRules: coverage.nativeRules,
          residuals: []
        }
      },
      residualPolicy: "Do not keep this action needs_review because of DOM/helper calls in the same JSP source file or callback scaffolding. Only actions whose coverage is partial/uncovered/none need new residual adjudication."
    });
  }

  for (const hint of action.semanticHints || []) {
    if (hint.kind === "detail_row_visibility") {
      opportunities.push({
        kind: "detail_row_visibility_candidate",
        actionIndex,
        targetApis: hint.targetApiCandidates || ["MKXFORM.updateControl", "MKXFORM.updateControlStyle", "MKXFORM.setDetailFieldItemAttr"],
        tableId: hint.triggerTableId,
        triggerControlId: hint.triggerControlId,
        targetControlId: hint.targetControlId,
        hiddenControlId: hint.hiddenControlId,
        requiredBusinessSemantics: [
          "Normalize the onChange value and compare it with the legacy trigger value gh.",
          "Write same-row hidden helper state when hiddenControlId is present.",
          "Show/hide the same-row targetControlId.",
          "Set required/not-required state for the same-row targetControlId when the source validate attribute toggles required."
        ],
        eventScaffoldingPolicy: "Ignore legacy onclick/setAttribute/__xformDispatch event-binding scaffolding after verifying the DSL action already preserves event=onChange, tableId, and controlId.",
        safeDecision: "If the complete action-local business function body is visible, map to onChange(value,rowNum,parentRowNum), use ${table:<tableId>}.<controlId> placeholders, and cover hidden state, display, and required-state semantics with targetApi.",
        suggestedPatchShape: {
          function: `function onChange(value, rowNum, parentRowNum) {
  var selectedValue = Array.isArray(value) ? value[0] : value
  var isReplacement = selectedValue === 'gh'
  var targetField = '\${table:${hint.triggerTableId || "fd_detail"}}.${hint.targetControlId || "fd_target"}'
  var hiddenField = '\${table:${hint.triggerTableId || "fd_detail"}}.${hint.hiddenControlId || "fd_hidden"}'
  MKXFORM.updateControl(hiddenField, rowNum, isReplacement ? 'true' : '')
  MKXFORM.updateControlStyle(targetField, rowNum, { display: isReplacement ? 'block' : 'none' })
  MKXFORM.setDetailFieldItemAttr(targetField, rowNum, isReplacement ? 3 : 6)
}`,
          translationStatus: "mapped",
          functionMappings: [{
            source: "detail-row DOM hidden value/display/required behavior",
            target: "MKXFORM.updateControl + MKXFORM.updateControlStyle + MKXFORM.setDetailFieldItemAttr",
            basis: "semantic-translation",
            reviewRequired: false
          }],
          coverage: { status: "translated", nativeRules: [], residuals: [] }
        },
        coverageDecision: "Use coverage.status translated with empty residuals when hidden helper write, display toggle, and required toggle are represented with targetApi; do not add residuals for event-binding scaffolding already represented by the DSL action boundary."
      });
    }
    if (hint.kind === "detail_row_load_initialization") {
      opportunities.push({
        kind: "detail_row_load_initialization_candidate",
        actionIndex,
        targetApis: hint.targetApiCandidates || ["MKXFORM.getValue", "MKXFORM.updateControlStyle"],
        tableId: hint.triggerTableId,
        triggerControlId: hint.triggerControlId,
        targetControlId: hint.targetControlId,
        hiddenControlId: hint.hiddenControlId,
        safeDecision: "If the action-local onLoad source is fully understood, initialize row marker visibility/required state with MKXFORM.setFieldAttr(<sourceMarker>, 4|5|3|6) and initialize detail-row target visibility by reading MKXFORM.getValue('${table:<tableId>}') and using rowNum in MKXFORM.updateControlStyle. Never pass ${table:<detailTableId>} to setFieldAttr.",
        unsafeDecision: "Keep needs_review when the onLoad body includes DOM lifecycle, row add/delete hooks, validation routines, or selected-value reconstruction that cannot be fully expressed with targetApi and native formRules."
      });
    }
  }

  const rowMarkerOpportunity = rowMarkerVisibilityOpportunity(action, actionIndex, form, sourceDraft);
  if (rowMarkerOpportunity) opportunities.push(rowMarkerOpportunity);

  return opportunities.length ? opportunities : undefined;
}

function rowMarkerVisibilityOpportunity(action = {}, actionIndex, form = {}, sourceDraft = {}) {
  const {
    markers,
    resolvedMarkers,
    orphanMarkers,
    unresolvedMarkers
  } = classifyActionRowMarkers(action, form, sourceDraft);
  if (!markers.length) return undefined;

  // Collapse co-located aliases to the persisted primary marker per layout row.
  const primaryByAlias = new Map();
  for (const row of Array.isArray(form?.layout?.mkTree) ? form.layout.mkTree : []) {
    const markers = (Array.isArray(row?.sourceMarkers) ? row.sourceMarkers : [])
      .map((marker) => String(marker || "").trim())
      .filter(Boolean);
    if (!markers.length) continue;
    for (const alias of markers) primaryByAlias.set(alias, markers[0]);
  }
  const persistedMarkers = uniqueStrings(
    resolvedMarkers.map((marker) => primaryByAlias.get(marker) || marker)
  );
  const markerEffectLines = persistedMarkers.flatMap((marker) => [
    `  MKXFORM.setFieldAttr(${JSON.stringify(marker)}, active ? 5 : 4)`,
    `  MKXFORM.setFieldAttr(${JSON.stringify(marker)}, active ? 3 : 6)`
  ]).join("\n");
  const eventName = action.event || action.name || "onLoad";
  const isChange = eventName === "onChange";
  const functionShape = isChange
    ? `function onChange(value, rowNum, parentRowNum) {
  var selectedValue = Array.isArray(value) ? value[0] : value
  var active = /* compare selectedValue with the legacy trigger values */
${markerEffectLines}
}`
    : `function onLoad() {
  var storedValue = MKXFORM.getValue(/* helper or trigger field id */)
  var normalizedValue = Array.isArray(storedValue) ? storedValue[0] : storedValue
  var active = /* compare normalizedValue with the legacy trigger values */
${markerEffectLines}
}`;

  return {
    kind: "row_marker_visibility_candidate",
    actionIndex,
    targetApis: ["MKXFORM.setFieldAttr", "MKXFORM.getValue", "MKXFORM.setValue"],
    rowMarkers: persistedMarkers,
    resolvedRowMarkers: persistedMarkers,
    orphanRowMarkers: orphanMarkers,
    unresolvedRowMarkers: unresolvedMarkers,
    requiredBusinessSemantics: [
      "Use the persisted primary layout sourceMarker (first entry in sourceMarkers / persistedMarker) as the MKXFORM.setFieldAttr target.",
      "When multiple sourceMarkers share one layout row, collapse co-located aliases to that primary marker; do not call setFieldAttr on aliasMarkers.",
      "Treat only warning-proven orphanRowMarkers as auditable no-ops and never emit MKXFORM.setFieldAttr for them.",
      "Do not substitute ${table:<detailTableId>} or the detail-table field id for whole-row/container visibility.",
      "Preserve helper-field writes when the source persists marker state for view/onLoad reconstruction."
    ],
    safeDecision: "Map resolvedRowMarkers with setFieldAttr, omit only warning-proven orphanRowMarkers as auditable no-ops, and translate any remaining helper behavior. Never invent a target for unresolvedRowMarkers.",
    suggestedPatchShape: persistedMarkers.length && unresolvedMarkers.length === 0 ? {
      function: functionShape,
      translationStatus: "mapped",
      functionMappings: [{
        source: "common_dom_row_set_show_required_reset",
        target: "MKXFORM.setFieldAttr",
        basis: "semantic-translation",
        reviewRequired: false
      }],
      coverage: { status: "translated", nativeRules: [], residuals: [] }
    } : undefined,
    coverageDecision: "Use coverage.status translated with empty residuals only when every resolved row toggle and remaining helper behavior is translated, every omitted marker is listed in orphanRowMarkers, and unresolvedRowMarkers is empty; preserve the Source Draft warning. Otherwise keep needs_review."
  };
}

function nativeRuleSummaries(formRules = {}, ruleIds = []) {
  const rules = Array.isArray(formRules?.linkage) ? formRules.linkage : [];
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  return ruleIds.map((id) => {
    const rule = byId.get(id);
    return pruneUndefined({
      id,
      trigger: rule?.trigger,
      source: rule?.source,
      when: rule?.when,
      effects: rule?.effects,
      else: rule?.else,
      translationStatus: rule?.translationStatus,
      meta: rule?.meta
    });
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

function countOccurrences(text = "", needle = "") {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  const source = String(text || "");
  while (true) {
    const index = source.indexOf(needle, cursor);
    if (index < 0) return count;
    count += 1;
    cursor = index + needle.length;
  }
}

function snippetAround(text = "", index = 0, radius = 160) {
  if (!Number.isInteger(index) || index < 0) return undefined;
  const source = String(text || "");
  return oneLine(source.slice(Math.max(0, index - radius), Math.min(source.length, index + radius)));
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function oneLine(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
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
    staticProps: Array.isArray(coverage.staticProps) ? coverage.staticProps.slice(0, 8) : coverage.staticProps,
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
