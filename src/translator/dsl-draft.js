import { catalogRefs, componentSupportsProp, validationPolicyRef } from "../dsl/catalogs.js";
import { translateLegacyConditionContextReferences } from "../dsl/condition-context.js";
import { buildFormRuleRefIndex, resolveDirectRef, resolveEffectTarget } from "../dsl/form-rules.js";
import { packLayoutGrid } from "../dsl/layout-pack.js";
import {
  applyFieldIdMapToForm,
  applyFieldIdMapToScripts,
  applyFieldIdMapToSourceFormRules,
  applyFieldIdMapToWorkflow,
  buildFieldIdMap
} from "./field-id-remap.js";
import { SOURCE_DRAFT_VERSION } from "./source-draft.js";
import { draftMkScriptsFromSourceScripts } from "./sysform-jsp-scripts.js";
import {
  classifyWorkflowDynamicParticipant,
  classifyWorkflowFormulaParticipant
} from "./workflow-formula-participants.js";
import {
  conditionalParallelSplitIds,
  isSupportedConditionalParallelCondition
} from "./conditional-parallel.js";
import { componentForSourceType } from "./field-component.js";

export const MIGRATION_DSL_VERSION = "2.0-migration";

export function draftSourceDraft(sourceDraft, options = {}) {
  if (sourceDraft?.version !== SOURCE_DRAFT_VERSION || sourceDraft?.artifact !== "source-draft") {
    throw new Error("draft requires a source-draft artifact");
  }

  const rawForm = draftForm(sourceDraft.form || {});
  const fieldIdMap = buildFieldIdMap(rawForm);
  const form = applyFieldIdMapToForm(rawForm, fieldIdMap);
  const knownSourceFieldIds = collectFormFieldIds(rawForm);
  const formRules = draftFormRules(
    applyFieldIdMapToSourceFormRules(sourceDraft.formRules, fieldIdMap),
    form
  );
  const scripts = applyFieldIdMapToScripts(
    draftMkScriptsFromSourceScripts(sourceDraft.scripts, { form, formRules }),
    fieldIdMap
  );
  const workflow = sourceDraft.workflow
    ? applyFieldIdMapToWorkflow(draftWorkflow(sourceDraft.workflow, knownSourceFieldIds), fieldIdMap)
    : undefined;

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
    formRules,
    scripts,
    workflow,
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

function collectFormFieldIds(form = {}) {
  const fieldIds = new Set();
  for (const field of form.fields || []) {
    if (field?.id) fieldIds.add(field.id);
    for (const column of field?.columns || []) {
      if (column?.id) fieldIds.add(column.id);
    }
  }
  return fieldIds;
}

function draftForm(sourceForm) {
  const controls = Array.isArray(sourceForm.controls) ? sourceForm.controls : [];
  const detailTables = Array.isArray(sourceForm.detailTables) ? sourceForm.detailTables : [];
  const dataFields = Array.isArray(sourceForm.dataFields) ? sourceForm.dataFields : [];
  const fields = [
    ...controls.map(draftFieldFromSourceControl),
    ...detailTables.map(draftDetailTableFromSource),
    ...dataFields.map(draftDataFieldFromSource)
  ];

  return {
    fields,
    layout: {
      sourceGrid: sourceForm.layout || { source: "fdDesignerHtml", rows: [] },
      mkTree: draftMkTree(sourceForm.layout || {}, new Set(detailTables.map((table) => table.id)))
    }
  };
}

function draftDataFieldFromSource(field) {
  return {
    ...draftFieldFromSourceControl(field),
    dataOnly: true
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
    title: targetDetailTableTitle(table),
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

function targetDetailTableTitle(table) {
  const baseTitle = String(table?.title ?? "");
  const hint = String(table?.sourceProps?.detailTitleHint?.content ?? "")
    .replace(/[\s\u00a0]+/gu, "");
  return hint ? `${baseTitle}(${hint})` : baseTitle;
}

function propsFromSource(source) {
  const componentId = componentForSourceType(source.sourceType, source);

  // Description is display-only; catalog allows only content/style.
  if (componentId === "xform-description") {
    const props = {};
    const content = source.sourceProps?.designerValues?.content || source.title;
    if (content) props.content = content;
    const style = descriptionStyleFromSource(source);
    if (style) props.style = style;
    return props;
  }

  const props = {};
  if (source.required) props.required = true;
  const inlineHint = source.sourceProps?.inlineHint?.content;
  if (componentSupportsProp(componentId, "placeholder") && typeof inlineHint === "string" && inlineHint.trim()) {
    props.placeholder = inlineHint;
  }
  if (Array.isArray(source.options) && source.options.length) {
    props.options = source.options.map((option) => ({ label: option.label, value: option.value }));
  }

  const defaultValue = legacyDefaultValueFromSource(source);
  if (defaultValue) props.defaultValue = defaultValue;

  if (componentId === "xform-textarea") {
    const maxLength = positiveInteger(
      source.sourceProps?.designerValues?.maxLength ??
        source.sourceProps?.designerValues?.maxlength ??
        source.sourceProps?.metadataAttributes?.maxLength ??
        source.sourceProps?.metadataAttributes?.maxlength ??
        source.sourceProps?.metadataAttributes?.length
    );
    if (maxLength !== undefined) props.maxLength = maxLength;

  }

  return props;
}

function legacyDefaultValueFromSource(source) {
  const candidates = [
    source.sourceProps?.metadataAttributes?.defaultValue,
    source.sourceProps?.designerValues?.defaultValue,
    source.sourceProps?.designerValues?.formula
  ];

  for (const candidate of candidates) {
    const defaultValue = parseLegacyContextDefaultExpression(candidate, source);
    if (defaultValue) return defaultValue;
  }

  return undefined;
}

function descriptionStyleFromSource(source) {
  const values = source.sourceProps?.designerValues || {};
  const style = {};
  const color = cssColorFromDesigner(values.color);
  if (color) style.color = color;
  if (String(values.b || "").toLowerCase() === "true") style.fontWeight = "bold";
  return Object.keys(style).length ? style : undefined;
}

function cssColorFromDesigner(value) {
  const color = String(value || "").trim();
  if (!color) return undefined;
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    const full = raw.length === 3
      ? raw.split("").map((ch) => ch + ch).join("")
      : raw;
    const r = Number.parseInt(full.slice(0, 2), 16);
    const g = Number.parseInt(full.slice(2, 4), 16);
    const b = Number.parseInt(full.slice(4, 6), 16);
    return `rgba(${r},${g},${b},1)`;
  }
  return color;
}

function parseLegacyContextDefaultExpression(value, source) {
  const expression = normalizeLegacyExpression(value);
  if (!expression) return undefined;

  if (isLegacyAddressSource(source) && /^ORG_TYPE_PERSON$/i.test(expression)) {
    return { kind: "context", source: "creator" };
  }

  if (isLegacyAddressSource(source) && /^ORG_TYPE_DEPT$/i.test(expression)) {
    return { kind: "context", source: "creatorDept" };
  }

  if (/^\$(?:docCreator|申请人)\$\s*\.\s*getFdName\s*\(\s*\)$/i.test(expression)) {
    return { kind: "context", source: "creator", property: "fdName" };
  }

  if (/^\$(?:fdDepartment|部门)\$\s*\.\s*getFdName\s*\(\s*\)$/i.test(expression)) {
    return { kind: "context", source: "creatorDept", property: "fdName" };
  }

  if (/^\$组织架构\.当前用户\$\s*\(\s*\)\s*\.\s*getFdName\s*\(\s*\)$/.test(expression)) {
    return { kind: "context", source: "creator", property: "fdName" };
  }

  if (/^OrgFunction\s*\.\s*getCurrentUser\s*\(\s*\)\s*\.\s*getFdName\s*\(\s*\)$/i.test(expression)) {
    return { kind: "context", source: "creator", property: "fdName" };
  }

  if (/^OrgFunction\s*\.\s*getCurrentDept\s*\(\s*\)\s*\.\s*getFdName\s*\(\s*\)$/i.test(expression)) {
    return { kind: "context", source: "creatorDept", property: "fdName" };
  }

  if (/^OrgFunction\s*\.\s*getCurrentUser\s*\(\s*\)$/i.test(expression)) {
    return { kind: "context", source: "creator" };
  }

  if (/^OrgFunction\s*\.\s*getCurrentDept\s*\(\s*\)$/i.test(expression)) {
    return { kind: "context", source: "creatorDept" };
  }

  return undefined;
}

function isLegacyAddressSource(source) {
  return source.sourceProps?.designerType === "address" || source.sourceProps?.metadataKind === "element";
}

function normalizeLegacyExpression(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#36;/g, "$")
    .replace(/&amp;/g, "&")
    .trim();
}

function draftMkTree(layout, detailTableIds) {
  const rows = Array.isArray(layout.rows) ? layout.rows : [];
  return rows.flatMap((row, rowIndex) => {
    const sourceCells = Array.isArray(row.cells) ? row.cells : [];
    const sourceRowId = row.id || `row-${rowIndex}`;
    const sourcePacked = packLayoutGrid(sourceCells);
    const segments = splitDetailTableLayoutSegments(sourcePacked.cells, detailTableIds);
    const baseSegmentIndex = Math.max(
      segments.findIndex((segment) => segment.kind === "detailTable"),
      0
    );

    return segments.map((segment, segmentIndex) => {
      // sourcePacked has already expanded every inline reference into one cell.
      // Preserve one source <tr> as one target row even when it needs more than
      // the four columns offered by the designer's quick flex layouts.
      const packed = packLayoutGrid(segment.cells, {
        columns: Math.max(segment.cells.length, 1),
        rows: 1
      });
      const tableLayout = packed.rows > 1 || packed.columns > 4;
      const baseSegment = segmentIndex === baseSegmentIndex;
      const segmentSuffix = segments.length > 1 && !baseSegment
        ? `.segment-${segmentIndex + 1}`
        : "";
      return {
        id: `layout.${sourceRowId}${segmentSuffix}`,
        componentId: tableLayout
          ? "xform-multi-row-table-layout"
          : `xform-flex-1-${packed.columns}-layout`,
        props: tableLayout
          ? { rows: packed.rows, columns: packed.columns }
          : {
              columns: packed.columns,
              sourceColumns: row.columns || sourceCells.length || 1
            },
        sourceRef: row.sourceRef || `source.form.layout.row.${sourceRowId}`,
        sourceMarkers:
          baseSegment && Array.isArray(row.sourceMarkers) && row.sourceMarkers.length
            ? row.sourceMarkers
            : undefined,
        children: packed.cells.map((cell, cellIndex) => {
          const references = Array.isArray(cell.references) ? cell.references : [];
          return {
            id: `layout.${cell.id || `${sourceRowId}.cell.${cellIndex}`}`,
            refType: references.some((ref) => detailTableIds.has(ref.referenceId)) ? "detailTable" : "field",
            refIds: references.map((ref) => ref.referenceId),
            sourceRef: cell.sourceRef,
            ...(tableLayout ? { row: cell.row } : {}),
            column: cell.column,
            colspan: cell.colspan
          };
        })
      };
    });
  });
}

function splitDetailTableLayoutSegments(cells, detailTableIds) {
  const segments = [];
  let ordinaryCells = [];
  const flushOrdinary = () => {
    if (!ordinaryCells.length) return;
    segments.push({ kind: "field", cells: ordinaryCells });
    ordinaryCells = [];
  };

  for (const cell of cells) {
    const references = Array.isArray(cell.references) ? cell.references : [];
    const detailTable = references.some((reference) =>
      detailTableIds.has(reference.referenceId)
    );
    if (detailTable) {
      flushOrdinary();
      segments.push({ kind: "detailTable", cells: [cell] });
    } else {
      ordinaryCells.push(cell);
    }
  }
  flushOrdinary();
  return segments;
}

function draftFormRules(sourceFormRules, form) {
  const linkage = Array.isArray(sourceFormRules?.linkage) ? sourceFormRules.linkage : [];
  if (!linkage.length) return undefined;
  const refIndex = buildFormRuleRefIndex(form || {});
  const targetIssues = [];
  const classifiedLinkage = linkage.map((rule) => {
    const ruleTargetIssues = formRuleTargetIssues(rule, refIndex);
    targetIssues.push(...ruleTargetIssues);
    return draftLinkageRule(rule, refIndex, ruleTargetIssues);
  });
  const excludedLinkage = classifiedLinkage.filter(hasTargetIssue);
  const draftedLinkage = mergeEquivalentOrRules(classifiedLinkage.filter((rule) => !hasTargetIssue(rule)));
  const mergedRules = draftedLinkage
    .filter((rule) => (rule.meta?.sourceRuleIds || []).length > 1)
    .map((rule) => ({ ruleId: rule.id, sourceRuleIds: rule.meta.sourceRuleIds }));

  return {
    linkage: draftedLinkage,
    validations: [],
    impliedRequired: [],
    review: pruneUndefined({
      ...(sourceFormRules.review || {}),
      targetIssues: targetIssues.length ? targetIssues : undefined,
      excludedRules: excludedLinkage.length ? excludedLinkage.map(excludedRuleSummary) : undefined,
      mergedRules: mergedRules.length ? mergedRules : undefined
    })
  };
}

function hasTargetIssue(rule) {
  return (rule.review?.targetIssues || []).length > 0;
}

function excludedRuleSummary(rule) {
  const issues = rule.review?.targetIssues || [];
  const targets = uniqueStrings(issues.map((issue) => issue.target));
  return pruneUndefined({
    ruleId: rule.id,
    code: issues[0]?.code,
    target: targets.length === 1 ? targets[0] : undefined,
    targets: targets.length > 1 ? targets : undefined,
    detailTableRefs: uniqueStrings(issues.flatMap((issue) => issue.detailTableRefs || [])),
    sourceJsp: rule.meta?.sourceJsp,
    displayGate: rule.meta?.displayGate,
    message: issues[0]?.message
  });
}

function mergeEquivalentOrRules(rules) {
  const groups = new Map();
  for (const rule of rules) {
    const key = JSON.stringify({
      trigger: rule.trigger,
      displayGate: rule.meta?.displayGate,
      runWhen: rule.meta?.runWhen,
      effects: rule.effects,
      else: rule.else,
      translationStatus: rule.translationStatus
    });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rule);
  }

  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    const first = group[0];
    const sourceJsps = uniqueStrings(group.flatMap((rule) => [
      rule.meta?.sourceJsp,
      ...(rule.meta?.sourceJsps || [])
    ]));
    const sourceRuleIds = uniqueStrings(group.flatMap((rule) => [
      rule.id,
      ...(rule.meta?.sourceRuleIds || [])
    ]));
    const sources = uniqueStrings(group.map((rule) => rule.source));
    const targetIssues = group.flatMap((rule) => rule.review?.targetIssues || []);
    return pruneUndefined({
      ...first,
      id: `${first.id}.merged`,
      source: sources.length === 1 ? sources[0] : undefined,
      logic: "or",
      when: dedupeConditions(group.flatMap((rule) => rule.when || [])),
      meta: {
        ...(first.meta || {}),
        sourceJsp: sourceJsps[0],
        sourceJsps,
        sourceRuleIds
      },
      review: targetIssues.length ? { targetIssues } : undefined
    });
  });
}

function dedupeConditions(conditions) {
  const seen = new Set();
  return conditions.filter((condition) => {
    const key = JSON.stringify(condition);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function draftLinkageRule(rule, refIndex, targetIssues = []) {
  const translationStatus = targetIssues.length && (rule.translationStatus || "executable") === "executable"
    ? "needs_review"
    : rule.translationStatus || "executable";
  const canonicalSource = resolveDirectRef(refIndex, rule.source)?.id || rule.source;
  const when = Array.isArray(rule.when)
    ? rule.when.map((condition) => ({
        field: resolveDirectRef(refIndex, condition.field)?.id || condition.field,
        op: condition.op,
        value: condition.value
      }))
    : [];

  return pruneUndefined({
    id: rule.id,
    trigger: rule.trigger || "change",
    source: canonicalSource,
    logic: rule.logic || "and",
    when,
    effects: draftRuleEffects(rule.effects),
    else: draftRuleEffects(rule.else),
    meta: rule.meta,
    review: targetIssues.length ? { targetIssues } : undefined,
    translationStatus
  });
}

function formRuleTargetIssues(rule, refIndex) {
  const result = [];
  for (const [branch, effects] of [["effects", rule.effects], ["else", rule.else]]) {
    for (const [effectIndex, effect] of (Array.isArray(effects) ? effects : []).entries()) {
      if (!effect?.target) continue;
      const resolved = resolveEffectTarget(refIndex, effect.target);
      if (!resolved || resolved.unresolved?.length || !resolved.targets?.length) {
        result.push(pruneUndefined({
          code: "form_rule.target_unresolved",
          ruleId: rule.id,
          branch,
          effectIndex,
          target: effect.target,
          type: effect.type,
          unresolved: resolved?.unresolved,
          message: "Form rule row target does not resolve to a direct field or mkTree.sourceMarkers entry."
        }));
      } else if (resolved.targets.some((target) => target.field?.dataOnly === true)) {
        result.push(pruneUndefined({
          code: "form_rule.target_data_only",
          ruleId: rule.id,
          branch,
          effectIndex,
          target: effect.target,
          type: effect.type,
          dataOnlyFieldIds: resolved.targets
            .filter((target) => target.field?.dataOnly === true)
            .map((target) => target.id),
          message: "Form rule visibility/required effects cannot target data-only fields."
        }));
      }
    }
  }
  return result;
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

function draftWorkflow(sourceWorkflow, knownFieldIds = null) {
  const sourceNodes = sourceWorkflow.nodes || [];
  const nodeById = new Map(sourceNodes.map((node) => [node.id, node]));
  const conditionalSplitIds = conditionalParallelSplitIds(
    sourceNodes,
    sourceNodeAttributes,
    normalizeParallelMode
  );
  const subProcessByNodeId = draftSubProcessPairs(sourceNodes);
  const participantSelections = participantSelectionsFromWorkflowNodes(sourceNodes);
  return {
    process: sourceWorkflow.process || {},
    nodes: sourceNodes.map((node) => {
      const nodeType = mapWorkflowNodeType(node, nodeById);
      const participants = nodeType.participants === false
        ? undefined
        : participantsFromSourceNode(node, participantSelections.get(node.id));
      const formulaNeedsReview = participants?.mode === "unmapped_formula";
      const subProcessNeedsReview = ["startSubProcess", "recoverSubProcess"].includes(nodeType.type) &&
        !subProcessByNodeId.has(node.id);
      return pruneUndefined({
        id: node.id,
        type: nodeType.type,
        element: nodeType.element,
        name: node.name || "",
        sourceType: node.sourceType,
        sourceRef: node.sourceRef,
        attributes: node.attributes || {},
        definition: node.definition,
        handlerEntities: node.handlerEntities,
        optionalHandlerEntities: node.optionalHandlerEntities,
        dataAuthority: draftDataAuthority(node.dataAuthority, knownFieldIds),
        participantSelections: participantSelections.get(node.id),
        participants,
        subProcess: subProcessByNodeId.get(node.id),
        translationStatus: nodeType.needsReview || formulaNeedsReview || subProcessNeedsReview ? "pending_review" : "executable"
      });
    }),
    edges: (sourceWorkflow.edges || []).map((edge) => {
      const hasCondition = Boolean(edge.condition || edge.displayCondition);
      const conditionalParallel = conditionalSplitIds.has(edge.source);
      const conditionExecutable = conditionalParallel &&
        isSupportedConditionalParallelCondition(edge.condition, knownFieldIds || []);
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
          targetText: translateLegacyConditionContextReferences(edge.condition, knownFieldIds || []),
          translationStatus: conditionalParallel
            ? conditionExecutable ? "executable" : hasCondition ? "display_only" : "pending_review"
            : hasCondition ? "display_only" : "executable",
          ...(conditionalParallel ? { critical: true } : {})
        }
      };
    }),
    topologicalOrder: sourceWorkflow.topologicalOrder || []
  };
}

function draftSubProcessPairs(nodes) {
  const result = new Map();
  const configs = new Map(nodes.map((node) => [node.id, parseSubProcessConfig(node)]));
  for (const start of nodes.filter((node) => String(node.sourceType || "").toLowerCase() === "startsubprocessnode")) {
    const startConfig = configs.get(start.id);
    if (!startConfig?.subProcess?.templateId) continue;
    const recover = nodes.find((node) => {
      if (String(node.sourceType || "").toLowerCase() !== "recoversubprocessnode") return false;
      return configs.get(node.id)?.subProcessNode === start.id;
    });
    if (!recover) continue;
    const recoverConfig = configs.get(recover.id);
    const flowType = nativeSubProcessFlowType(recoverConfig);
    if (!flowType) continue;
    const common = {
      templateId: startConfig.subProcess.templateId,
      templateName: startConfig.subProcess.templateName || "",
      modelName: startConfig.subProcess.modelName || "",
      dictBean: startConfig.subProcess.dictBean || "",
      createParam: startConfig.subProcess.createParam || "",
      startIdentity: startConfig.startIdentity || { type: 1, names: "", values: "" },
      startCountType: String(startConfig.startCountType || 1),
      autoSubmit: startConfig.skipDraftNode === true,
      flowType,
      startParamConfig: parameterMappings(startConfig.startParamenters, "parent_to_child"),
      recoverParamConfig: parameterMappings(recoverConfig.recoverParamenters, "child_to_parent"),
      variableScope: recoverConfig.variableScope,
      recoverRule: recoverConfig.recoverRule
    };
    result.set(start.id, { ...common, recoverNodeId: recover.id });
    result.set(recover.id, {
      startNodeId: start.id,
      variableScope: recoverConfig.variableScope,
      recoverRule: recoverConfig.recoverRule,
      recoverParamConfig: common.recoverParamConfig
    });
  }
  return result;
}

function nativeSubProcessFlowType(recoverConfig) {
  const expression = recoverConfig?.recoverRule?.expression;
  const emptyExpression = !expression?.text && !expression?.value;
  if (Number(recoverConfig?.variableScope) === 2 && Number(recoverConfig?.recoverRule?.type) === 1 && emptyExpression) {
    return "2";
  }
  return undefined;
}

function parseSubProcessConfig(node) {
  const raw = node?.definition?.attributes?.configContent || node?.attributes?.configContent;
  if (!raw || typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parameterMappings(parameters, direction) {
  return (Array.isArray(parameters) ? parameters : []).map((parameter) => ({
    direction,
    source: parameter.expression,
    target: parameter.name,
    mappingItems: [{
      source: parameter.expression,
      target: parameter.name
    }]
  }));
}

function participantSelectionsFromWorkflowNodes(nodes) {
  const selections = new Map();
  for (const node of nodes) {
    const attrs = sourceNodeAttributes(node);
    for (const attribute of ["mustModifyHandlerNodeIds", "canModifyHandlerNodeIds"]) {
      for (const targetNodeId of splitRelatedNodeIds(attrs[attribute])) {
        if (!selections.has(targetNodeId)) selections.set(targetNodeId, []);
        selections.get(targetNodeId).push({
          sourceNodeId: node.id,
          sourceNodeType: node.sourceType,
          attribute,
          targetNodeId
        });
      }
    }
  }
  return selections;
}

function draftDataAuthority(dataAuthority, knownFieldIds = null) {
  if (!dataAuthority || typeof dataAuthority !== "object") return undefined;
  const fields = Object.fromEntries(
    Object.entries(dataAuthority.fields || {})
      .filter(([fieldId]) => !knownFieldIds || knownFieldIds.has(fieldId))
      .map(([fieldId, value]) => [fieldId, pruneUndefined({
        visible: value.visible,
        editable: value.editable,
        required: value.required,
        sourceMode: value.sourceMode,
        sourceRef: value.sourceRef
      })])
  );

  if (!Object.keys(fields).length) return undefined;
  return {
    enabled: dataAuthority.enabled !== false,
    fields
  };
}

function participantsFromSourceNode(node, participantSelections) {
  const attrs = sourceNodeAttributes(node);
  const handlerIds = splitList(attrs.handlerIds);
  const handlerNames = splitList(attrs.handlerNames);
  const handlerMembers = participantMembersFromHandlerEntities(node.handlerEntities);
  const alternativeMembers = participantMembersFromHandlerEntities(node.optionalHandlerEntities);
  const participantEvidence = {
    alternativeMembers: alternativeMembers.length ? alternativeMembers : undefined,
    useAlternativeOnly: alternativeMembers.length ? booleanAttribute(attrs, "useOptHandlerOnly") : undefined
  };

  const formulaParticipant = classifyWorkflowFormulaParticipant(attrs);
  if (formulaParticipant) return pruneUndefined({ ...formulaParticipant, ...participantEvidence });

  const dynamicParticipant = classifyWorkflowDynamicParticipant(attrs, node.handlerEntities);
  if (dynamicParticipant) return pruneUndefined({ ...dynamicParticipant, ...participantEvidence });

  if (handlerMembers.length) {
    return pruneUndefined({
      mode: "explicit",
      members: handlerMembers,
      ...participantEvidence
    });
  }

  if (handlerIds.length && !handlerIds.some((id) => id.startsWith("$"))) {
    return pruneUndefined({
      mode: "explicit",
      members: handlerIds.map((id, index) => ({
        id,
        name: handlerNames[index] || id,
        type: "user_or_org"
      })),
      ...participantEvidence
    });
  }

  if (handlerIds.some((id) => /\b(drafter|initiator|creator)\b/i.test(id))) {
    return pruneUndefined({
      mode: "initiator_select",
      sourceSemantics: "source handler expression references drafter/initiator selection",
      ...participantEvidence
    });
  }

  if (Array.isArray(participantSelections) && participantSelections.length && handlerIds.length === 0) {
    return pruneUndefined({
      mode: "initiator_select",
      sourceSemantics: participantSelections.map(participantSelectionSemantics).join("; "),
      ...participantEvidence
    });
  }

  return pruneUndefined({
    mode: "empty",
    reason: "source did not specify executable participants",
    ...participantEvidence
  });
}

function participantMembersFromHandlerEntities(entities) {
  if (!Array.isArray(entities)) return [];
  return entities.map((entity) => pruneUndefined({
    name: entity.name || entity.id,
    type: "user_or_org",
    sourceId: entity.id,
    sourceOrgType: entity.orgType,
    sourceOrgClass: entity.class,
    sourceParentName: entity.parent,
    sourceLoginName: entity.loginName
  }));
}

function participantSelectionSemantics(selection) {
  const nodeKind = String(selection.sourceNodeType || "").toLowerCase().includes("draft")
    ? "draft node"
    : "workflow node";
  return `${nodeKind} ${selection.sourceNodeId} ${selection.attribute} includes ${selection.targetNodeId}`;
}

function booleanAttribute(attributes, key) {
  if (!Object.prototype.hasOwnProperty.call(attributes, key)) return undefined;
  return String(attributes[key]).trim().toLowerCase() === "true";
}

function mapWorkflowNodeType(node = {}, nodeById = new Map()) {
  const sourceType = node.sourceType || "";
  const normalized = String(sourceType).toLowerCase();
  if (normalized === "startsubprocessnode") return { type: "startSubProcess", element: "subProcess", participants: false };
  if (normalized === "recoversubprocessnode") return { type: "recoverSubProcess", element: "subProcess", participants: false };
  if (normalized.includes("subprocess")) return { type: "review", element: "manualTask", needsReview: true };
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
    needsReview: !isExecutableParallelGateway(node, nodeById, type)
  };
}

function isExecutableParallelGateway(node, nodeById, type) {
  const attrs = sourceNodeAttributes(node);
  const relatedIds = splitRelatedNodeIds(attrs.relatedNodeIds);
  if (relatedIds.length !== 1) return false;

  const related = nodeById.get(relatedIds[0]);
  if (!related) return false;

  const relatedType = String(related.sourceType || "").toLowerCase();
  const expectedRelatedType = type === "split" ? "join" : "split";
  if (!relatedType.includes(expectedRelatedType)) return false;

  if (!isSupportedParallelGatewayPair(attrs, sourceNodeAttributes(related), type)) return false;

  const relatedBackIds = splitRelatedNodeIds(sourceNodeAttributes(related).relatedNodeIds);
  return relatedBackIds.length === 1 && relatedBackIds[0] === node.id;
}

function isSupportedParallelGatewayPair(attrs, relatedAttrs, type) {
  const modeKey = type === "split" ? "splitType" : "joinType";
  const relatedModeKey = type === "split" ? "joinType" : "splitType";
  const mode = normalizeParallelMode(attrs[modeKey]);
  const relatedMode = normalizeParallelMode(relatedAttrs[relatedModeKey]);

  // Legacy `condition` splits fan out to every matching branch and pair with
  // an `all` join. NewOA persists this paired gateway shape as splitType "1".
  return (mode === "all" && relatedMode === "all") ||
    (type === "split" && mode === "condition" && relatedMode === "all") ||
    (type === "join" && mode === "all" && relatedMode === "condition");
}

function sourceNodeAttributes(node) {
  return {
    ...(node?.attributes || {}),
    ...(node?.definition?.attributes || {})
  };
}

function isAllParallelMode(value) {
  const normalized = normalizeParallelMode(value);
  return normalized === "all" || normalized === "1";
}

function normalizeParallelMode(value) {
  return String(value || "").trim().toLowerCase();
}

function splitRelatedNodeIds(value = "") {
  return String(value || "").split(/[;,，\s]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizeFieldType(type) {
  return {
    date: "dateTime",
    RestDialog: "text",
    LinkLabel: "description"
  }[type] || type || "text";
}

function sourceIssuesToWarnings(issues) {
  return issues
    .filter((issue) => issue.level !== "error" || isNonBlockingSourceIssue(issue))
    .map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.sourcePath,
      details: issue.evidence
    }));
}

function sourceIssuesToErrors(issues) {
  const errors = issues
    .filter((issue) => issue.level === "error" && !isNonBlockingSourceIssue(issue))
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
    .filter((issue) => issue.level !== "error" || isNonBlockingSourceIssue(issue))
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

function isNonBlockingSourceIssue(issue) {
  return issue?.code === "source.function_not_whitelisted";
}

function positiveInteger(value) {
  if (value === undefined || value === null) return undefined;
  const number = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function splitList(value = "") {
  return String(value || "").split(";").map((item) => item.trim()).filter(Boolean);
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
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
