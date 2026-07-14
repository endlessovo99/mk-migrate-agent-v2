import { isDeepStrictEqual } from "node:util";
import { applyWorkflowPayload, buildWorkflowDraftPayload } from "./workflow-writer.js";

const CONDITION_KEYS = Object.freeze([
  "formula",
  "formulaName",
  "formulaType",
  "defaultTrend",
  "priority"
]);

const DOC_CREATOR_KEYS = Object.freeze([
  "handlerIds",
  "handlerNames",
  "handlerSelectType",
  "handlers"
]);

const GATEWAY_KEYS = Object.freeze([
  "type",
  "element",
  "splitType",
  "joinType",
  "relateId",
  "gatewayDirection",
  "scope",
  "hidden"
]);

/**
 * Patch only route-validation semantics that have explicit repair evidence.
 * The live workflow remains the source of truth for every other property.
 */
export function applyScopedWorkflowRepair(template, dsl) {
  if (!dsl?.workflow) {
    return { update: clone(template), plan: emptyPlan(template) };
  }

  const update = clone(template);
  const projected = applyWorkflowPayload(template, dsl);
  const baseLbpm = firstWorkflow(update);
  const projectedLbpm = firstWorkflow(projected);
  const baseContent = parseWorkflowContent(baseLbpm.fdContent, "existing");
  const projectedContent = parseWorkflowContent(projectedLbpm.fdContent, "projected");
  const baseElements = indexElements(baseContent, "existing");
  const projectedElements = indexElements(projectedContent, "projected");
  const targets = buildTargets(dsl.workflow);

  for (const target of targets) {
    const baseElement = requireElement(baseElements, target, "existing");
    const projectedElement = requireElement(projectedElements, target, "projected");
    copyKeys(baseElement, projectedElement, target.keys);
  }

  baseLbpm.fdContent = JSON.stringify(baseContent);

  return {
    update,
    plan: {
      enabled: true,
      baselineAuth: clone(baseLbpm.fdTemplateFormAuths || {}),
      baselineDraftShell: workflowDraftShell(firstWorkflow(template)),
      baselineContent: clone(parseWorkflowContent(firstWorkflow(template).fdContent, "existing")),
      projectedContent: clone(projectedContent),
      targets
    }
  };
}

export function verifyScopedWorkflowRepair(plan, readbackTemplate) {
  if (!plan?.enabled) {
    return { ok: true, diagnostics: [] };
  }

  const diagnostics = [];
  let readbackLbpm;
  let readbackContent;
  try {
    readbackLbpm = firstWorkflow(readbackTemplate);
    readbackContent = parseWorkflowContent(readbackLbpm.fdContent, "readback");
  } catch (error) {
    return {
      ok: false,
      diagnostics: [diagnostic(
        error?.code || "readback.workflow.scoped_repair_decode_failed",
        error instanceof Error ? error.message : String(error),
        "/workflow"
      )]
    };
  }

  if (!isDeepStrictEqual(normalizeAuth(plan.baselineAuth), normalizeAuth(readbackLbpm.fdTemplateFormAuths || {}))) {
    diagnostics.push(diagnostic(
      "readback.workflow.scoped_repair_data_authority_changed",
      "Scoped workflow repair changed form data authority outside the authorized repair boundary.",
      "/workflow/fdTemplateFormAuths"
    ));
  }

  let readbackDraftShell;
  try {
    readbackDraftShell = workflowDraftShell(readbackLbpm);
  } catch (error) {
    diagnostics.push(diagnostic(
      "readback.workflow.scoped_repair_draft_shell_invalid",
      error instanceof Error ? error.message : String(error),
      "/workflow"
    ));
  }
  if (readbackDraftShell && !isDeepStrictEqual(plan.baselineDraftShell, readbackDraftShell)) {
    diagnostics.push(diagnostic(
      "readback.workflow.scoped_repair_policy_changed",
      "Scoped workflow repair changed LBPM-level workflow policy outside the authorized repair boundary.",
      "/workflow"
    ));
  }

  const baselineShell = { ...plan.baselineContent, elements: undefined };
  const readbackShell = { ...readbackContent, elements: undefined };
  if (!isDeepStrictEqual(baselineShell, readbackShell)) {
    diagnostics.push(diagnostic(
      "readback.workflow.scoped_repair_content_shell_changed",
      "Scoped workflow repair changed workflow content outside the element repair boundary.",
      "/workflow/fdContent"
    ));
  }

  const baselineElements = safeIndexElements(plan.baselineContent, diagnostics, "baseline");
  const projectedElements = safeIndexElements(plan.projectedContent, diagnostics, "projected");
  const readbackElements = safeIndexElements(readbackContent, diagnostics, "readback");
  if (!baselineElements || !projectedElements || !readbackElements) {
    return { ok: false, diagnostics };
  }

  const baselineIds = plan.baselineContent.elements.map((element) => element.id);
  const readbackIds = readbackContent.elements.map((element) => element.id);
  if (!isDeepStrictEqual(baselineIds, readbackIds)) {
    diagnostics.push(diagnostic(
      "readback.workflow.scoped_repair_graph_changed",
      "Scoped workflow repair added, removed, or reordered workflow elements.",
      "/workflow/elements"
    ));
  }

  const targetById = new Map(plan.targets.map((target) => [target.id, target]));
  for (const [id, baselineElement] of baselineElements) {
    const readbackElement = readbackElements.get(id);
    if (!readbackElement) continue;
    const target = targetById.get(id);
    if (!target) {
      if (!isDeepStrictEqual(baselineElement, readbackElement)) {
        diagnostics.push(diagnostic(
          "readback.workflow.scoped_repair_unrelated_element_changed",
          `Scoped workflow repair changed unrelated workflow element ${id}.`,
          `/workflow/elements/${id}`
        ));
      }
      continue;
    }

    const baselineRemainder = omitKeys(baselineElement, target.keys);
    const readbackRemainder = omitKeys(readbackElement, target.keys);
    if (!isDeepStrictEqual(baselineRemainder, readbackRemainder)) {
      diagnostics.push(diagnostic(
        "readback.workflow.scoped_repair_target_overwrite",
        `Scoped workflow repair changed non-repair properties on workflow element ${id}.`,
        `/workflow/elements/${id}`
      ));
    }

    const projectedElement = projectedElements.get(id);
    for (const key of target.keys) {
      if (!isDeepStrictEqual(readbackElement[key], projectedElement?.[key])) {
        diagnostics.push(diagnostic(
          "readback.workflow.scoped_repair_target_mismatch",
          `Scoped workflow repair did not persist ${key} on workflow element ${id}.`,
          `/workflow/elements/${id}/${key}`
        ));
      }
    }
  }

  return { ok: diagnostics.length === 0, diagnostics };
}

function buildTargets(workflow) {
  const targets = new Map();
  const criticalEdges = (workflow.edges || []).filter((edge) => edge.condition?.critical === true);
  const splitIds = new Set(criticalEdges.map((edge) => edge.source));
  const gatewayIds = new Set(splitIds);

  for (const node of workflow.nodes || []) {
    if (splitIds.has(node.id) && node.type === "split" && node.attributes?.relatedNodeIds) {
      gatewayIds.add(node.attributes.relatedNodeIds);
    }
    if (node.participants?.mode === "doc_creator") {
      targets.set(node.id, { id: node.id, kind: "doc_creator", keys: DOC_CREATOR_KEYS });
    }
  }
  for (const edge of criticalEdges) {
    targets.set(edge.id, { id: edge.id, kind: "critical_condition", keys: CONDITION_KEYS });
  }
  for (const id of gatewayIds) {
    targets.set(id, { id, kind: "conditional_parallel_gateway", keys: GATEWAY_KEYS });
  }
  return [...targets.values()];
}

function firstWorkflow(template) {
  const lbpm = template?.mechanisms?.lbpmTemplate?.[0];
  if (!lbpm || typeof lbpm !== "object") {
    throw repairError("projection.workflow.scoped_repair_lbpm_missing", "Scoped workflow repair requires an existing LBPM template.");
  }
  return lbpm;
}

function parseWorkflowContent(value, label) {
  try {
    const content = typeof value === "string" ? JSON.parse(value) : clone(value);
    if (!content || typeof content !== "object" || !Array.isArray(content.elements)) {
      throw new Error("designer content does not contain an elements array");
    }
    return content;
  } catch (error) {
    throw repairError(
      "projection.workflow.scoped_repair_content_invalid",
      `Scoped workflow repair could not decode ${label} workflow content: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function indexElements(content, label) {
  const indexed = new Map();
  for (const element of content.elements) {
    if (!element || typeof element.id !== "string" || !element.id) {
      throw repairError("projection.workflow.scoped_repair_element_invalid", `${label} workflow contains an element without an id.`);
    }
    if (indexed.has(element.id)) {
      throw repairError("projection.workflow.scoped_repair_element_duplicate", `${label} workflow contains duplicate element id ${element.id}.`);
    }
    indexed.set(element.id, element);
  }
  return indexed;
}

function safeIndexElements(content, diagnostics, label) {
  try {
    return indexElements(content, label);
  } catch (error) {
    diagnostics.push(diagnostic(
      "readback.workflow.scoped_repair_graph_invalid",
      error instanceof Error ? error.message : String(error),
      "/workflow/elements"
    ));
    return undefined;
  }
}

function requireElement(elements, target, label) {
  const element = elements.get(target.id);
  if (!element) {
    throw repairError(
      "projection.workflow.scoped_repair_target_missing",
      `Scoped workflow repair target ${target.id} (${target.kind}) is missing from ${label} workflow content.`
    );
  }
  return element;
}

function copyKeys(target, source, keys) {
  for (const key of keys) {
    if (source[key] === undefined) delete target[key];
    else target[key] = clone(source[key]);
  }
}

function omitKeys(value, keys) {
  const next = clone(value);
  for (const key of keys) delete next[key];
  return next;
}

function normalizeAuth(value) {
  const normalized = {};
  for (const nodeId of Object.keys(value || {}).sort()) {
    normalized[nodeId] = {};
    for (const fieldId of Object.keys(value[nodeId] || {}).sort()) {
      const auth = value[nodeId][fieldId] || {};
      normalized[nodeId][fieldId] = {
        isShow: authFlag(auth.isShow),
        isEdit: authFlag(auth.isEdit),
        isRequire: authFlag(auth.isRequire)
      };
    }
  }
  return normalized;
}

function workflowDraftShell(lbpm) {
  const payload = buildWorkflowDraftPayload({ mechanisms: { lbpmTemplate: [lbpm] } });
  delete payload.fdContent;
  delete payload.fdTemplateFormAuths;
  delete payload.dynamicProps;
  return normalizeServerMetadata(payload);
}

function normalizeServerMetadata(value) {
  if (Array.isArray(value)) return value.map(normalizeServerMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["fdFieldId", "fdNodeId", "fdDefinitionId", "definitionId"].includes(key))
      .map(([key, item]) => [key, normalizeServerMetadata(item)])
  );
}

function authFlag(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function emptyPlan(template) {
  return {
    enabled: false,
    baselineAuth: clone(firstWorkflow(template).fdTemplateFormAuths || {}),
    baselineDraftShell: {},
    baselineContent: { elements: [] },
    projectedContent: { elements: [] },
    targets: []
  };
}

function diagnostic(code, message, path) {
  return { level: "error", code, message, path };
}

function repairError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}
