import { COMPONENT_CATALOG, VALIDATION_POLICY } from "../dsl/catalogs.js";

export const AGENT_REVIEW_PROMPT_VERSION = "agent-review.form-patch.v1";

export const ALLOWED_PATCH_PATHS = [
  "/form/fields/*/title",
  "/form/fields/*/type",
  "/form/fields/*/componentId",
  "/form/fields/*/props",
  "/form/fields/*/columns/*/title",
  "/form/fields/*/columns/*/type",
  "/form/fields/*/columns/*/componentId",
  "/form/fields/*/columns/*/props"
];

export function buildAgentReviewPrompt(sourceDraft, dslDraft) {
  return {
    promptVersion: AGENT_REVIEW_PROMPT_VERSION,
    system: [
      "You review a NewOA/MK migration DSL draft after deterministic translation.",
      "Return only strict JSON with exactly these top-level keys: summary, patches, diagnostics.",
      "Do not return a complete DSL.",
      "Only propose evidence-backed replace patches for allowed form DSL paths.",
      "Workflow is diagnostic-only in this version. Never patch workflow, trust, executor safety, source artifact, credentials, environment, or config paths.",
      "Every patch must include op, path, value, sourceRefs, evidence, confidence, and rationale.",
      "Every diagnostic must include level, code, path, and message. Use diagnostics: [] when there are no diagnostics.",
      "The summary must be a non-empty string.",
      "Use sourceRef strings from the provided source draft. Do not use raw XML or invent source evidence.",
      "Title patches require confidence >= 0.7. Type, componentId, and props patches require confidence >= 0.85.",
      "If a workflow concern is found, emit a diagnostic instead of a patch.",
      "If no safe patches are needed, return exactly this shape with your own non-empty summary: {\"summary\":\"Reviewed form DSL; no safe patches proposed.\",\"patches\":[],\"diagnostics\":[]}"
    ].join("\n"),
    context: {
      promptVersion: AGENT_REVIEW_PROMPT_VERSION,
      task: "Review source-draft form evidence and dsl-draft form semantics, then propose restricted patches only when evidence is clear.",
      responseContract: {
        topLevelKeys: ["summary", "patches", "diagnostics"],
        patchKeys: ["op", "path", "value", "sourceRefs", "evidence", "confidence", "rationale"],
        supportedPatchOps: ["replace"]
      },
      allowedPatchPaths: ALLOWED_PATCH_PATHS,
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
          "props.required, props.options, props.maxLength, and props.height when evidenced by source facts"
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
      sourceDraft: {
        form: {
          controls: sourceDraft?.form?.controls || [],
          detailTables: sourceDraft?.form?.detailTables || [],
          layout: sourceDraft?.form?.layout || {}
        },
        workflowSummary: summarizeWorkflow(sourceDraft?.workflow)
      },
      dslDraft: {
        form: dslDraft?.form || {},
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
