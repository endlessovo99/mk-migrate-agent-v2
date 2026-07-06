import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { translateLbpmProcessDefinitionXml } from "./lbpm-process-definition-adapter.js";
import { translateSysFormTemplateXml } from "./sysform-template-adapter.js";

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
    functionWhitelist: options.functionWhitelist
  });

  return sourceDraftFromLegacyDsl(legacyFormDsl, {
    sourcePath: path,
    sourceKind: "sysform-template-xml"
  });
}

export function sourceDraftFromLegacyDsl(legacyDsl, context = {}) {
  const source = legacyDsl.source || {};
  const fields = Array.isArray(legacyDsl.form?.fields) ? legacyDsl.form.fields : [];
  const detailTableIds = new Set(fields.filter((field) => field.type === "detailTable").map((field) => field.id));
  const normalControls = fields.filter((field) => field.type !== "detailTable").map(sourceControlFromField);
  const detailTables = fields.filter((field) => field.type === "detailTable").map(sourceDetailTableFromField);
  const workflow = legacyDsl.workflow ? sourceWorkflowFromLegacyWorkflow(legacyDsl.workflow) : undefined;

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
      detailTables,
      layout: sourceLayoutFromLegacyLayout(legacyDsl.form?.layout, detailTableIds)
    },
    workflow,
    issues: sourceIssuesFromReview(legacyDsl.review)
  });
}

function cleanSourceDirectory(path, options = {}) {
  const entries = readdirSync(path);
  const sysFormName = requireSingle(entries, /_SysFormTemplate\.xml$/i, "SysFormTemplate");
  const lbpmProcessName = requireSingle(entries, /_LbpmProcessDefinition\.xml$/i, "LbpmProcessDefinition");
  const sysFormPath = join(path, sysFormName);
  const lbpmProcessPath = join(path, lbpmProcessName);

  const formDsl = translateSysFormTemplateXml(readFileSync(sysFormPath, "utf8"), {
    sourcePath: sysFormPath,
    functionWhitelist: options.functionWhitelist
  });
  const workflowDsl = translateLbpmProcessDefinitionXml(readFileSync(lbpmProcessPath, "utf8"), {
    sourcePath: lbpmProcessPath
  });

  const formTemplateId = formDsl.source.fdModelId;
  const processTemplateId = workflowDsl.source.templateId;
  if (formTemplateId && processTemplateId && formTemplateId !== processTemplateId) {
    throw new Error(`source directory template mismatch: SysFormTemplate fdModelId ${formTemplateId} does not match LbpmProcessDefinition templateId ${processTemplateId}`);
  }

  return sourceDraftFromLegacyDsl({
    ...formDsl,
    source: {
      kind: "source-directory",
      path,
      sysFormTemplate: formDsl.source,
      lbpmProcessDefinition: workflowDsl.source
    },
    workflow: workflowDsl.workflow
  }, {
    sourcePath: path,
    sourceKind: "source-directory"
  });
}

function normalizeSourceMetadata(source, context) {
  if (source.kind === "source-directory") {
    return {
      kind: "source-directory",
      path: source.path || context.sourcePath,
      sourceId: basename(source.path || context.sourcePath || "source-directory"),
      sysFormTemplate: source.sysFormTemplate,
      lbpmProcessDefinition: source.lbpmProcessDefinition
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

function sourceWorkflowFromLegacyWorkflow(workflow) {
  const nodes = (workflow.nodes || []).map((node) => ({
    id: node.id,
    sourceRef: sourceRef("workflow.node", node.id),
    sourceType: node.type,
    name: node.name || "",
    attributes: node.attributes || {},
    definition: node.definition ? {
      sourceType: node.definition.type,
      attributes: node.definition.attributes || {}
    } : undefined,
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

function sourceIssuesFromReview(review = {}) {
  const warnings = (review.warnings || []).map((warning) => sourceIssueFromDiagnostic("warning", warning));
  const errors = (review.errors || []).map((item) => sourceIssueFromDiagnostic("error", item));
  const functionViolations = (review.functionWhitelist?.violations || []).map((violation) => ({
    level: "error",
    code: "source.function_not_whitelisted",
    message: `Source function ${violation.name} is not in the function catalog.`,
    sourcePath: review.functionWhitelist.path || "/fdDesignerHtml",
    evidence: {
      functionName: violation.name,
      occurrences: violation.occurrences || []
    }
  }));

  return [...warnings, ...errors, ...functionViolations];
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

function pruneUndefined(value) {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, pruneUndefined(entry)])
  );
}
