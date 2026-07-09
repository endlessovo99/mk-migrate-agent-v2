import { COMPONENT_CATALOG, FUNCTION_CATALOG, VALIDATION_POLICY } from "../dsl/catalogs.js";
import { scriptTargetApiSummary } from "../dsl/scripts.js";

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
      "Translate JSP scripts using the provided functionCatalog and targetApi. Trusted mapped scripts must not use document/window DOM APIs.",
      "Non-whitelisted EKP functions are not automatically blocking. First infer their intent from source evidence and surrounding script context, then translate safely to targetApi JavaScript when confidence is high.",
      "If a non-whitelisted function cannot be safely inferred, leave the action needs_review or manual and explain the unresolved function in diagnostics.",
      "AttachXFormValueChangeEventById must translate to the existing control-scope onChange action candidate for that control.",
      "Detail-table control scripts use tableId plus controlId; preserve rowNum for row-scoped APIs.",
      "When a detail-table function refers to a runtime control id, use ${table:<sourceDetailTableId>}.<controlId>; the executor resolves this placeholder to mk_model_fd_... at write time.",
      "If native formRules already cover a JSP visibility/required rule, do not duplicate that rule in generated JavaScript.",
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
          safeOutcome: "Patch function, translationStatus=mapped, functionMappings, and coverage only when the translated JavaScript uses targetApi and passes local execution validation.",
          unsafeOutcome: "Keep translationStatus as needs_review or manual and emit diagnostics naming unresolved functions and why targetApi translation was not safe."
        }
      },
      functionCatalog: functionCatalogSummary(),
      sourceDraft: {
        form: {
          controls: sourceDraft?.form?.controls || [],
          detailTables: sourceDraft?.form?.detailTables || [],
          layout: sourceDraft?.form?.layout || {}
        },
        scripts: scriptSourceSummary(sourceDraft?.scripts),
        workflowSummary: summarizeWorkflow(sourceDraft?.workflow)
      },
      dslDraft: {
        form: dslDraft?.form || {},
        scripts: dslDraft?.scripts || {},
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
      mkFunction: fn.mkFunction || ""
    }))
  };
}

function scriptSourceSummary(scripts = {}) {
  if (!scripts) return {};
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
    sources: (scripts.sources || []).map((source) => ({
      id: source.id,
      sourceRef: source.sourceRef,
      sourceKey: source.sourceKey,
      sourceType: source.sourceType,
      fragmentId: source.fragmentId,
      javascript: source.javascript,
      functionAudit: source.functionAudit
    }))
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
  return {
    process: workflow.process || {},
    nodes: (workflow.nodes || []).map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type || node.sourceType,
      element: node.element,
      translationStatus: node.translationStatus
    })),
    edges: (workflow.edges || []).map((edge) => ({
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

function previewText(value = "") {
  const text = String(value || "");
  return text.length > 6000 ? `${text.slice(0, 6000)}...` : text;
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
