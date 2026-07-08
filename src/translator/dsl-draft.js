import { catalogRefs, validationPolicyRef } from "../dsl/catalogs.js";
import { SOURCE_DRAFT_VERSION } from "./source-draft.js";
import { draftMkScriptsFromSourceScripts } from "./sysform-jsp-scripts.js";

export const MIGRATION_DSL_VERSION = "2.0-migration";

export function draftSourceDraft(sourceDraft, options = {}) {
  if (sourceDraft?.version !== SOURCE_DRAFT_VERSION || sourceDraft?.artifact !== "source-draft") {
    throw new Error("draft requires a source-draft artifact");
  }

  const form = draftForm(sourceDraft.form || {});

  return pruneUndefined({
    version: MIGRATION_DSL_VERSION,
    artifact: "dsl-draft",
    derivedFrom: {
      sourceDraftVersion: sourceDraft.version,
      sourceId: sourceDraft.source?.sourceId || sourceDraft.source?.path || "source"
    },
    catalogs: catalogRefs(),
    validationPolicy: validationPolicyRef(),
    trust: {
      level: "draft",
      executable: false,
      model: {
        mode: "none",
        reason: "The first version reserves target mapping for external Codex Agent trust."
      }
    },
    template: {
      name: sourceDraft.template?.name || "未命名模板",
      categoryPath: sourceDraft.template?.categoryPath || "",
      sourceRef: sourceDraft.source?.sourceId || sourceDraft.source?.path || ""
    },
    form,
    formRules: draftFormRules(sourceDraft.formRules),
    scripts: draftMkScriptsFromSourceScripts(sourceDraft.scripts),
    workflow: sourceDraft.workflow ? draftWorkflow(sourceDraft.workflow) : undefined,
    review: {
      warnings: sourceIssuesToWarnings(sourceDraft.issues || []),
      errors: sourceIssuesToErrors(sourceDraft.issues || []),
      reviewCandidates: reviewCandidatesFromIssues(sourceDraft.issues || []),
      decisions: undefined
    },
    digests: {
      sourceDraft: options.sourceDraftDigest || ""
    }
  });
}

function draftForm(sourceForm) {
  const controls = Array.isArray(sourceForm.controls) ? sourceForm.controls : [];
  const detailTables = Array.isArray(sourceForm.detailTables) ? sourceForm.detailTables : [];
  const fields = [
    ...controls.map(draftFieldFromSourceControl),
    ...detailTables.map(draftDetailTableFromSource)
  ];

  return {
    fields,
    layout: {
      sourceGrid: sourceForm.layout || { source: "fdDesignerHtml", rows: [] },
      mkTree: draftMkTree(sourceForm.layout || {}, new Set(detailTables.map((table) => table.id)))
    }
  };
}

function draftFieldFromSourceControl(control) {
  return pruneUndefined({
    id: control.id,
    title: control.title,
    type: normalizeFieldType(control.sourceType),
    componentId: componentForSourceType(control.sourceType, control),
    props: propsFromSource(control),
    sourceProps: control.sourceProps || {},
    sourceRef: control.sourceRef,
    generated: false
  });
}

function draftDetailTableFromSource(table) {
  return pruneUndefined({
    id: table.id,
    title: table.title,
    type: "detailTable",
    componentId: "xform-detail-table",
    props: {},
    sourceProps: table.sourceProps || {},
    sourceRef: table.sourceRef,
    generated: false,
    columns: (table.columns || []).map((column) => pruneUndefined({
      id: column.id,
      title: column.title,
      type: normalizeFieldType(column.sourceType),
      componentId: componentForSourceType(column.sourceType, column),
      props: propsFromSource(column),
      sourceProps: column.sourceProps || {},
      sourceRef: column.sourceRef,
      generated: false
    }))
  });
}

function propsFromSource(source) {
  const props = {};
  if (source.required) props.required = true;
  if (Array.isArray(source.options) && source.options.length) {
    props.options = source.options.map((option) => ({ label: option.label, value: option.value }));
  }

  if (componentForSourceType(source.sourceType, source) === "xform-textarea") {
    const maxLength = positiveInteger(
      source.sourceProps?.designerValues?.maxLength ??
        source.sourceProps?.designerValues?.maxlength ??
        source.sourceProps?.metadataAttributes?.maxLength ??
        source.sourceProps?.metadataAttributes?.maxlength ??
        source.sourceProps?.metadataAttributes?.length
    );
    if (maxLength !== undefined) props.maxLength = maxLength;

    const height = normalizeHeight(
      source.sourceProps?.designerValues?.height ??
        source.sourceProps?.designerValues?.style
    );
    if (height !== undefined) props.height = height;
  }

  return props;
}

function draftMkTree(layout, detailTableIds) {
  const rows = Array.isArray(layout.rows) ? layout.rows : [];
  return rows.map((row, rowIndex) => {
    const cells = Array.isArray(row.cells) ? row.cells : [];
    const columns = Math.max(1, Math.min(4, cells.length || 1));
    return {
      id: `layout.${row.id || `row-${rowIndex}`}`,
      componentId: `xform-flex-1-${columns}-layout`,
      props: {
        columns,
        sourceColumns: row.columns || cells.length || 1
      },
      sourceRef: row.sourceRef || `source.form.layout.row.${row.id || `row-${rowIndex}`}`,
      sourceMarkers: Array.isArray(row.sourceMarkers) && row.sourceMarkers.length ? row.sourceMarkers : undefined,
      children: cells.map((cell, cellIndex) => {
        const references = Array.isArray(cell.references) ? cell.references : [];
        return {
          id: `layout.${cell.id || `${row.id || `row-${rowIndex}`}.cell.${cellIndex}`}`,
          refType: references.some((ref) => detailTableIds.has(ref.referenceId)) ? "detailTable" : "field",
          refIds: references.map((ref) => ref.referenceId),
          sourceRef: cell.sourceRef,
          column: cell.column ?? cellIndex,
          colspan: cell.colspan ?? 1
        };
      })
    };
  });
}

function draftFormRules(sourceFormRules) {
  const linkage = Array.isArray(sourceFormRules?.linkage) ? sourceFormRules.linkage : [];
  if (!linkage.length) return undefined;
  return {
    linkage: linkage.map((rule) => pruneUndefined({
      id: rule.id,
      trigger: rule.trigger || "change",
      source: rule.source,
      logic: rule.logic || "and",
      when: Array.isArray(rule.when) ? rule.when.map((condition) => ({
        field: condition.field,
        op: condition.op,
        value: condition.value
      })) : [],
      effects: draftRuleEffects(rule.effects),
      else: draftRuleEffects(rule.else),
      meta: rule.meta,
      translationStatus: rule.translationStatus || "executable"
    })),
    validations: [],
    impliedRequired: [],
    review: sourceFormRules.review || {}
  };
}

function draftRuleEffects(effects) {
  return Array.isArray(effects)
    ? effects.map((effect) => ({
        type: effect.type,
        target: effect.target,
        value: effect.value
      }))
    : undefined;
}

function draftWorkflow(sourceWorkflow) {
  const nodeById = new Map((sourceWorkflow.nodes || []).map((node) => [node.id, node]));
  return {
    process: sourceWorkflow.process || {},
    nodes: (sourceWorkflow.nodes || []).map((node) => {
      const nodeType = mapWorkflowNodeType(node, nodeById);
      return pruneUndefined({
        id: node.id,
        type: nodeType.type,
        element: nodeType.element,
        name: node.name || "",
        sourceType: node.sourceType,
        sourceRef: node.sourceRef,
        attributes: node.attributes || {},
        definition: node.definition,
        participants: nodeType.participants === false ? undefined : participantsFromSourceNode(node),
        translationStatus: nodeType.needsReview ? "pending_review" : "executable"
      });
    }),
    edges: (sourceWorkflow.edges || []).map((edge) => {
      const hasCondition = Boolean(edge.condition || edge.displayCondition);
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        name: edge.name || "",
        sourceRef: edge.sourceRef,
        attributes: edge.attributes || {},
        condition: {
          sourceText: edge.condition || "",
          displayText: edge.displayCondition || "",
          targetText: edge.condition || "",
          translationStatus: hasCondition ? "display_only" : "executable"
        }
      };
    }),
    topologicalOrder: sourceWorkflow.topologicalOrder || []
  };
}

function participantsFromSourceNode(node) {
  const attrs = node.attributes || {};
  const handlerIds = splitList(attrs.handlerIds);
  const handlerNames = splitList(attrs.handlerNames);
  if (handlerIds.length && !handlerIds.some((id) => id.startsWith("$"))) {
    return {
      mode: "explicit",
      members: handlerIds.map((id, index) => ({
        id,
        name: handlerNames[index] || id,
        type: "user_or_org"
      }))
    };
  }

  if (handlerIds.some((id) => /\b(drafter|initiator|creator)\b/i.test(id))) {
    return {
      mode: "initiator_select",
      sourceSemantics: "source handler expression references drafter/initiator selection"
    };
  }

  return {
    mode: "empty",
    reason: "source did not specify executable participants"
  };
}

function mapWorkflowNodeType(node = {}, nodeById = new Map()) {
  const sourceType = node.sourceType || "";
  const normalized = String(sourceType).toLowerCase();
  if (normalized.includes("split")) return parallelGatewayNodeType(node, nodeById, "split");
  if (normalized.includes("join")) return parallelGatewayNodeType(node, nodeById, "join");
  if (normalized.includes("start")) return { type: "generalStart", element: "startEvent" };
  if (normalized.includes("draft")) return { type: "draft", element: "manualTask" };
  if (normalized.includes("send") || normalized.includes("cc")) return { type: "send", element: "manualTask" };
  if (normalized.includes("end")) return { type: "generalEnd", element: "endEvent" };
  if (normalized.includes("gateway") || normalized.includes("branch")) return { type: "conditionBranch", element: "exclusiveGateway" };
  if (normalized.includes("robot")) return { type: "robot", element: "robot" };
  if (normalized.includes("review") || normalized.includes("manual") || normalized.includes("task") || normalized.includes("approval")) {
    return { type: "review", element: "manualTask" };
  }
  return { type: "review", element: "manualTask", needsReview: true };
}

function parallelGatewayNodeType(node, nodeById, type) {
  return {
    type,
    element: "parallelGateway",
    participants: false,
    needsReview: !isExecutableAllParallelGateway(node, nodeById, type)
  };
}

function isExecutableAllParallelGateway(node, nodeById, type) {
  const attrs = sourceNodeAttributes(node);
  const relatedIds = splitRelatedNodeIds(attrs.relatedNodeIds);
  if (relatedIds.length !== 1) return false;

  const related = nodeById.get(relatedIds[0]);
  if (!related) return false;

  const relatedType = String(related.sourceType || "").toLowerCase();
  const expectedRelatedType = type === "split" ? "join" : "split";
  if (!relatedType.includes(expectedRelatedType)) return false;

  const modeKey = type === "split" ? "splitType" : "joinType";
  const relatedModeKey = type === "split" ? "joinType" : "splitType";
  if (!isAllParallelMode(attrs[modeKey])) return false;
  if (!isAllParallelMode(sourceNodeAttributes(related)[relatedModeKey])) return false;

  const relatedBackIds = splitRelatedNodeIds(sourceNodeAttributes(related).relatedNodeIds);
  return relatedBackIds.length === 1 && relatedBackIds[0] === node.id;
}

function sourceNodeAttributes(node) {
  return {
    ...(node?.attributes || {}),
    ...(node?.definition?.attributes || {})
  };
}

function isAllParallelMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "all" || normalized === "1";
}

function splitRelatedNodeIds(value = "") {
  return String(value || "").split(/[;,，\s]+/).map((item) => item.trim()).filter(Boolean);
}

function componentForSourceType(type, source) {
  if (source.sourceProps?.designerType === "address") return "xform-address";
  return {
    text: source.sourceProps?.metadataKind === "element" ? "xform-address" : "xform-input",
    longText: "xform-textarea",
    number: "xform-number",
    date: "xform-datetime",
    dateTime: "xform-datetime",
    singleSelect: "xform-select",
    multiSelect: "xform-select~multi",
    radio: "xform-radio",
    checkbox: "xform-checkbox",
    attachment: "xform-attach",
    description: "xform-description"
  }[type] || "xform-input";
}

function normalizeFieldType(type) {
  return {
    date: "dateTime"
  }[type] || type || "text";
}

function sourceIssuesToWarnings(issues) {
  return issues
    .filter((issue) => issue.level !== "error")
    .map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.sourcePath,
      details: issue.evidence
    }));
}

function sourceIssuesToErrors(issues) {
  const errors = issues
    .filter((issue) => issue.level === "error")
    .map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.sourcePath,
      details: issue.evidence
    }));
  return errors.length ? errors : undefined;
}

function reviewCandidatesFromIssues(issues) {
  return issues
    .filter((issue) => issue.level !== "error")
    .map((issue, index) => ({
      id: `candidate-${index + 1}`,
      status: "pending_review",
      decisionType: issue.code || "source_issue",
      sourceRefs: issue.evidence?.id ? [String(issue.evidence.id)] : [],
      targetRefs: [],
      rationale: issue.message,
      result: "review_required"
    }));
}

function positiveInteger(value) {
  if (value === undefined || value === null) return undefined;
  const number = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function normalizeHeight(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  const styleHeight = text.match(/(?:^|;)\s*height\s*:\s*([^;]+)/i)?.[1]?.trim();
  if (styleHeight) return normalizeHeight(styleHeight);
  const numericHeight = text.match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  if (numericHeight) return Number(numericHeight[1]);
  return text;
}

function splitList(value = "") {
  return String(value || "").split(";").map((item) => item.trim()).filter(Boolean);
}

function pruneUndefined(value) {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, pruneUndefined(entry)])
  );
}
