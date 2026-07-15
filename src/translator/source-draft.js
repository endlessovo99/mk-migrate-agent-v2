import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { auditSourceScriptRowMarkerOrphans, ORPHAN_ROW_MARKER_WARNING_CODE } from "./row-marker-orphan-audit.js";
import { translateLbpmProcessDefinitionXml } from "./lbpm-process-definition-adapter.js";
import { sourceFormRulesFromLegacyScripts } from "./sysform-form-rules.js";
import { translateSysFormTemplateXml } from "./sysform-template-adapter.js";
import { cleanText, parseRootHashMapStringPuts } from "./xml-utils.js";

export const SOURCE_DRAFT_VERSION = "2.0-source-draft";

export function cleanSourceFile(path, options = {}) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    return cleanSourceDirectory(path, options);
  }

  if (!/_SysFormTemplate\.xml$/i.test(path)) {
    if (/_LbpmProcessDefinition\.xml$/i.test(path)) {
      throw new Error("LbpmProcessDefinition cleaning requires the paired SysFormTemplate; pass the source directory");
    }
    throw new Error("v2 clean currently supports source directories or *_SysFormTemplate.xml source files");
  }

  const legacyFormDsl = translateSysFormTemplateXml(readFileSync(path, "utf8"), {
    sourcePath: path,
    functionWhitelist: options.functionWhitelist,
    templateName: options.templateName
  });

  return sourceDraftFromLegacyDsl(legacyFormDsl, {
    sourcePath: path,
    sourceKind: "sysform-template-xml"
  });
}

export function sourceDraftFromLegacyDsl(legacyDsl, context = {}) {
  const source = legacyDsl.source || {};
  const fields = Array.isArray(legacyDsl.form?.fields) ? legacyDsl.form.fields : [];
  const dataFields = Array.isArray(legacyDsl.form?.dataFields) ? legacyDsl.form.dataFields : [];
  const allFields = [...fields, ...dataFields];
  const detailTableIds = new Set(fields.filter((field) => field.type === "detailTable").map((field) => field.id));
  const normalControls = fields.filter((field) => field.type !== "detailTable").map(sourceControlFromField);
  const sourceDataFields = dataFields.map(sourceDataFieldFromField);
  const detailTables = fields.filter((field) => field.type === "detailTable").map(sourceDetailTableFromField);
  const layout = sourceLayoutFromLegacyLayout(legacyDsl.form?.layout, detailTableIds);
  const scripts = sourceScriptsFromLegacy(legacyDsl.scripts);
  const workflow = legacyDsl.workflow ? sourceWorkflowFromLegacyWorkflow(legacyDsl.workflow, {
    nodeDataAuthorities: legacyDsl.form?.nodeDataAuthorities,
    fields: allFields
  }) : undefined;

  return pruneUndefined({
    version: SOURCE_DRAFT_VERSION,
    artifact: "source-draft",
    source: normalizeSourceMetadata(source, context),
    template: {
      name: legacyDsl.template?.name || basename(context.sourcePath || source.path || "source"),
      categoryPath: legacyDsl.template?.categoryPath || ""
    },
    form: {
      controls: normalControls,
      dataFields: sourceDataFields,
      detailTables,
      layout
    },
    formRules: sourceFormRulesFromLegacyScripts(legacyDsl.scripts),
    scripts,
    workflow,
    issues: [
      ...sourceIssuesFromReview(legacyDsl.review),
      ...sourceScriptRowMarkerOrphanIssues(scripts, layout)
    ]
  });
}

function sourceDataFieldFromField(field) {
  return pruneUndefined({
    id: field.id,
    sourceRef: sourceRef("form.dataField", field.id),
    title: field.title,
    sourceType: field.type,
    required: Boolean(field.required),
    dataOnly: true,
    options: cloneOptions(field.options),
    sourceProps: sourcePropsFromField(field),
    evidence: evidenceForField(field)
  });
}

function cleanSourceDirectory(path, options = {}) {
  const entries = readdirSync(path);
  const sysFormName = requireSingle(entries, /_SysFormTemplate\.xml$/i, "SysFormTemplate");
  const lbpmProcessName = requireSingle(entries, /_LbpmProcessDefinition\.xml$/i, "LbpmProcessDefinition");
  const kmReviewTemplateName = requireOptional(entries, /_KmReviewTemplate\.xml$/i, "KmReviewTemplate");
  const sysFormPath = join(path, sysFormName);
  const lbpmProcessPath = join(path, lbpmProcessName);
  const kmReviewTemplate = kmReviewTemplateName
    ? readKmReviewTemplateName(join(path, kmReviewTemplateName))
    : undefined;

  const formDsl = translateSysFormTemplateXml(readFileSync(sysFormPath, "utf8"), {
    sourcePath: sysFormPath,
    functionWhitelist: options.functionWhitelist,
    templateName: String(options.templateName || "").trim() || kmReviewTemplate?.name
  });
  const workflowDsl = translateLbpmProcessDefinitionXml(readFileSync(lbpmProcessPath, "utf8"), {
    sourcePath: lbpmProcessPath
  });

  const formTemplateId = formDsl.source.fdModelId;
  const processTemplateId = workflowDsl.source.templateId;
  if (formTemplateId && processTemplateId && formTemplateId !== processTemplateId) {
    throw new Error(`source directory template mismatch: SysFormTemplate fdModelId ${formTemplateId} does not match LbpmProcessDefinition templateId ${processTemplateId}`);
  }
  if (kmReviewTemplate?.fdId && formTemplateId && kmReviewTemplate.fdId !== formTemplateId) {
    throw new Error(`source directory template mismatch: KmReviewTemplate fdId ${kmReviewTemplate.fdId} does not match SysFormTemplate fdModelId ${formTemplateId}`);
  }
  if (kmReviewTemplate?.fdId && processTemplateId && kmReviewTemplate.fdId !== processTemplateId) {
    throw new Error(`source directory template mismatch: KmReviewTemplate fdId ${kmReviewTemplate.fdId} does not match LbpmProcessDefinition templateId ${processTemplateId}`);
  }

  return sourceDraftFromLegacyDsl({
    ...formDsl,
    source: {
      kind: "source-directory",
      path,
      sysFormTemplate: formDsl.source,
      lbpmProcessDefinition: workflowDsl.source,
      ...(kmReviewTemplate ? {
        kmReviewTemplate: {
          path: join(path, kmReviewTemplateName),
          fdId: kmReviewTemplate.fdId
        }
      } : {})
    },
    workflow: workflowDsl.workflow,
    review: mergeSourceReviews(formDsl.review, workflowDsl.review)
  }, {
    sourcePath: path,
    sourceKind: "source-directory"
  });
}

function mergeSourceReviews(formReview, workflowReview) {
  if (!workflowReview) return formReview;
  const merged = { ...(formReview || {}) };
  if (Array.isArray(workflowReview.warnings) && workflowReview.warnings.length) {
    merged.warnings = [...(formReview?.warnings || []), ...workflowReview.warnings];
  }
  if (Array.isArray(workflowReview.errors) && workflowReview.errors.length) {
    merged.errors = [...(formReview?.errors || []), ...workflowReview.errors];
  }
  return merged;
}

function readKmReviewTemplateName(path) {
  const values = parseRootHashMapStringPuts(readFileSync(path, "utf8"));
  const name = cleanText(values.fdName || "");
  if (!name) {
    throw new Error(`KmReviewTemplate XML is missing root fdName: ${basename(path)}`);
  }
  return {
    name,
    fdId: cleanText(values.fdId || "") || undefined
  };
}

function normalizeSourceMetadata(source, context) {
  if (source.kind === "source-directory") {
    return {
      kind: "source-directory",
      path: source.path || context.sourcePath,
      sourceId: basename(source.path || context.sourcePath || "source-directory"),
      sysFormTemplate: source.sysFormTemplate,
      lbpmProcessDefinition: source.lbpmProcessDefinition,
      kmReviewTemplate: source.kmReviewTemplate
    };
  }

  return {
    kind: context.sourceKind || source.kind || "sysform-template-xml",
    path: source.path || context.sourcePath,
    sourceId: source.fdModelId || source.fdId || basename(source.path || context.sourcePath || "source"),
    fdId: source.fdId,
    fdTemplateEdition: source.fdTemplateEdition,
    fdModelName: source.fdModelName,
    fdModelId: source.fdModelId
  };
}

function sourceControlFromField(field) {
  return pruneUndefined({
    id: field.id,
    sourceRef: sourceRef("form.control", field.id),
    title: field.title,
    sourceType: field.type,
    required: Boolean(field.required),
    options: cloneOptions(field.options),
    sourceProps: sourcePropsFromField(field),
    evidence: evidenceForField(field)
  });
}

function sourceDetailTableFromField(field) {
  return pruneUndefined({
    id: field.id,
    sourceRef: sourceRef("form.detailTable", field.id),
    title: field.title,
    sourceType: "detailTable",
    required: Boolean(field.required),
    sourceProps: sourcePropsFromField(field),
    evidence: evidenceForField(field),
    columns: (field.columns || []).map((column) => pruneUndefined({
      id: column.id,
      sourceRef: sourceRef(`form.detailTable.${field.id}.column`, column.id),
      title: column.title,
      sourceType: column.type,
      required: Boolean(column.required),
      options: cloneOptions(column.options),
      sourceProps: sourcePropsFromField(column),
      evidence: evidenceForField(column)
    }))
  });
}

function sourcePropsFromField(field) {
  return pruneUndefined({
    designerId: field.source?.designerId,
    designerType: field.source?.designerType,
    designerValues: field.source?.designerValues,
    designerTableName: field.source?.designerTableName,
    restDialog: field.source?.restDialog,
    metadataId: field.source?.metadataId,
    metadataKind: field.source?.metadataKind,
    metadataAttributes: field.source?.metadataAttributes
  });
}

function evidenceForField(field) {
  return pruneUndefined({
    designerId: field.source?.designerId,
    metadataId: field.source?.metadataId,
    title: field.title
  });
}

function sourceLayoutFromLegacyLayout(layout = {}, detailTableIds = new Set()) {
  const rows = Array.isArray(layout.rows) ? layout.rows : [];
  return {
    source: layout.source || "fdDesignerHtml",
    rows: rows.map((row, rowIndex) => ({
      id: row.id || `row-${rowIndex}`,
      sourceRef: sourceRef("form.layout.row", row.id || `row-${rowIndex}`),
      sourceRow: row.sourceRow ?? String(rowIndex),
      sourceMarkers: Array.isArray(row.sourceMarkers) && row.sourceMarkers.length ? row.sourceMarkers : undefined,
      columns: row.columns,
      cells: (row.cells || []).map((cell, cellIndex) => {
        const refs = cellFieldIds(cell).map((fieldId) => ({
          referenceType: detailTableIds.has(fieldId) ? "detailTable" : "control",
          referenceId: fieldId,
          sourceRef: sourceRef(detailTableIds.has(fieldId) ? "form.detailTable" : "form.control", fieldId)
        }));
        return pruneUndefined({
          id: cell.id || `${row.id || `row-${rowIndex}`}-cell-${cellIndex}`,
          sourceRef: sourceRef("form.layout.cell", cell.id || `${row.id || `row-${rowIndex}`}-cell-${cellIndex}`),
          column: cell.column,
          colspan: cell.colspan,
          references: refs,
          evidence: {
            row: row.sourceRow ?? String(rowIndex),
            column: cell.column,
            colspan: cell.colspan
          }
        });
      })
    }))
  };
}

function sourceWorkflowFromLegacyWorkflow(workflow, context = {}) {
  const requiredFields = buildRequiredFieldIndex(context.fields || []);
  const nodeDataAuthorities = context.nodeDataAuthorities || {};
  const nodes = (workflow.nodes || []).map((node) => ({
    id: node.id,
    sourceRef: sourceRef("workflow.node", node.id),
    sourceType: node.type,
    name: node.name || "",
    attributes: node.attributes || {},
    handlerEntities: node.handlerEntities,
    optionalHandlerEntities: node.optionalHandlerEntities,
    definition: node.definition ? {
      sourceType: node.definition.type,
      attributes: node.definition.attributes || {}
    } : undefined,
    dataAuthority: sourceNodeDataAuthority(nodeDataAuthorities[node.id], requiredFields),
    incoming: (workflow.edges || []).filter((edge) => edge.target === node.id).map((edge) => edge.id),
    outgoing: (workflow.edges || []).filter((edge) => edge.source === node.id).map((edge) => edge.id),
    evidence: { id: node.id, name: node.name || "", sourceType: node.type }
  }));

  const edges = (workflow.edges || []).map((edge) => ({
    id: edge.id,
    sourceRef: sourceRef("workflow.edge", edge.id),
    source: edge.source,
    target: edge.target,
    name: edge.name || "",
    condition: edge.condition || "",
    displayCondition: edge.displayCondition || "",
    attributes: edge.attributes || {},
    evidence: { id: edge.id, source: edge.source, target: edge.target }
  }));

  return {
    process: workflow.process || {},
    nodes,
    edges,
    topologicalOrder: workflow.topologicalOrder || []
  };
}

function sourceNodeDataAuthority(authority, requiredFields) {
  const fields = authority?.fields || {};
  const entries = Object.entries(fields).map(([fieldId, entry]) => {
    const required = requiredFields.has(fieldId);
    return [fieldId, pruneUndefined({
      ...authorityFlags(entry.mode, required),
      sourceMode: entry.mode,
      sourceRef: entry.sourceRef
    })];
  });

  if (!entries.length) return undefined;
  return {
    enabled: true,
    fields: Object.fromEntries(entries)
  };
}

function authorityFlags(mode, fieldRequired) {
  if (mode === "hidden") return { visible: false, editable: false, required: false };
  if (mode === "view") return { visible: true, editable: false, required: false };
  return { visible: true, editable: true, required: Boolean(fieldRequired) };
}

function buildRequiredFieldIndex(fields) {
  const required = new Set();
  for (const field of fields || []) {
    if (!field) continue;
    if (field.type === "detailTable") {
      for (const column of field.columns || []) {
        if (column?.id && column.required) required.add(column.id);
      }
      continue;
    }
    if (field.id && field.required) required.add(field.id);
  }
  return required;
}

function sourceScriptsFromLegacy(scripts) {
  if (!scripts || !Array.isArray(scripts.sources) || scripts.sources.length === 0) return undefined;
  return {
    source: scripts.source || "sysform-jsp",
    displayJsp: scripts.displayJsp,
    fragments: scripts.fragments || [],
    sources: scripts.sources.map((source) => pruneUndefined({
      id: source.id,
      sourceRef: source.sourceRef,
      sourceKey: source.sourceKey,
      sourceType: source.sourceType,
      fragmentId: source.fragmentId,
      displayGate: source.displayGate,
      javascript: source.javascript,
      functionAudit: source.functionAudit,
      semanticFacts: source.semanticFacts
    }))
  };
}

function sourceScriptRowMarkerOrphanIssues(scripts, layout) {
  const layoutMarkers = new Set(
    (layout?.rows || []).flatMap((row) => Array.isArray(row.sourceMarkers) ? row.sourceMarkers : [])
  );

  return (scripts?.sources || []).flatMap((source, sourceIndex) => {
    const evidence = auditSourceScriptRowMarkerOrphans(source, layoutMarkers);
    if (!evidence) return [];
    return [{
      level: "warning",
      code: ORPHAN_ROW_MARKER_WARNING_CODE,
      message: "Source script row markers have no current source layout target and are proven safe orphan no-op calls.",
      sourcePath: `/scripts/sources/${sourceIndex}/semanticFacts/rowMarkers`,
      evidence
    }];
  });
}

function sourceIssuesFromReview(review = {}) {
  const warnings = (review.warnings || []).map((warning) => sourceIssueFromDiagnostic("warning", warning));
  const errors = (review.errors || []).map((item) => sourceIssueFromDiagnostic("error", item));
  const existingFunctionViolationKeys = new Set(
    [...warnings, ...errors]
      .filter((issue) => issue.code === "source.function_not_whitelisted")
      .map(functionViolationKey)
  );
  const functionViolations = (review.functionWhitelist?.violations || []).map((violation) => ({
    level: "warning",
    code: "source.function_not_whitelisted",
    message: `Source function ${violation.name} is not in the function catalog.`,
    sourcePath: review.functionWhitelist.path || "/fdDesignerHtml",
    evidence: {
      functionName: violation.name,
      occurrences: violation.occurrences || []
    }
  })).filter((issue) => !existingFunctionViolationKeys.has(functionViolationKey(issue)));

  return [...warnings, ...errors, ...functionViolations];
}

function functionViolationKey(issue) {
  return `${issue.sourcePath || ""}:${issue.evidence?.functionName || ""}`;
}

function sourceIssueFromDiagnostic(level, diagnostic) {
  return {
    level,
    code: diagnostic.code || `source.${level}`,
    message: diagnostic.message || "Source issue.",
    sourcePath: diagnostic.path || "",
    evidence: diagnostic.details || {}
  };
}

function sourceRef(scope, id) {
  return `source.${scope}.${String(id || "missing").replace(/[^a-zA-Z0-9_.:-]+/g, "_")}`;
}

function cellFieldIds(cell) {
  if (Array.isArray(cell.fieldIds) && cell.fieldIds.length) return cell.fieldIds;
  return cell.fieldId ? [cell.fieldId] : [];
}

function cloneOptions(options) {
  return Array.isArray(options) && options.length
    ? options.map((option) => ({ label: option.label, value: option.value }))
    : undefined;
}

function requireSingle(entries, pattern, label) {
  const matches = entries.filter((entry) => pattern.test(entry));
  if (matches.length !== 1) {
    throw new Error(`source directory requires exactly one ${label} XML file; found ${matches.length}`);
  }
  return matches[0];
}

function requireOptional(entries, pattern, label) {
  const matches = entries.filter((entry) => pattern.test(entry));
  if (matches.length > 1) {
    throw new Error(`source directory allows at most one ${label} XML file; found ${matches.length}`);
  }
  return matches[0];
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
