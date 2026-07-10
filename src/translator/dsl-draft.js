import { catalogRefs, validationPolicyRef } from "../dsl/catalogs.js";
import { buildFormRuleRefIndex, resolveDirectRef, resolveEffectTarget } from "../dsl/form-rules.js";
import { SOURCE_DRAFT_VERSION } from "./source-draft.js";
import { draftMkScriptsFromSourceScripts } from "./sysform-jsp-scripts.js";

export const MIGRATION_DSL_VERSION = "2.0-migration";

export function draftSourceDraft(sourceDraft, options = {}) {
  if (sourceDraft?.version !== SOURCE_DRAFT_VERSION || sourceDraft?.artifact !== "source-draft") {
    throw new Error("draft requires a source-draft artifact");
  }

  const form = draftForm(sourceDraft.form || {});
  const formRules = draftFormRules(sourceDraft.formRules, form);

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
    scripts: draftMkScriptsFromSourceScripts(sourceDraft.scripts, { form, formRules }),
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

  const defaultValue = legacyDefaultValueFromSource(source);
  if (defaultValue) props.defaultValue = defaultValue;

  if (componentForSourceType(source.sourceType, source) === "xform-description") {
    const content = source.sourceProps?.designerValues?.content || source.title;
    if (content) props.content = content;
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

function draftFormRules(sourceFormRules, form) {
  const linkage = Array.isArray(sourceFormRules?.linkage) ? sourceFormRules.linkage : [];
  if (!linkage.length) return undefined;
  const refIndex = buildFormRuleRefIndex(form || {});
  const targetIssues = [];
  const classifiedLinkage = linkage.map((rule) => {
    const ruleTargetIssues = formRuleTargetIssues(rule, refIndex);
    targetIssues.push(...ruleTargetIssues);
    return draftLinkageRule(rule, ruleTargetIssues);
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

function draftLinkageRule(rule, targetIssues = []) {
  const translationStatus = targetIssues.length && (rule.translationStatus || "executable") === "executable"
    ? "needs_review"
    : rule.translationStatus || "executable";

  return pruneUndefined({
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
        continue;
      }

      const detailTableRefs = resolved.source === "rowMarker"
        ? (resolved.marker?.refIds || []).filter((refId) => resolveDirectRef(refIndex, refId)?.kind === "detailTable")
        : [];
      if (detailTableRefs.length) {
        result.push({
          code: "form_rule.target_detail_table",
          ruleId: rule.id,
          branch,
          effectIndex,
          target: effect.target,
          type: effect.type,
          detailTableRefs,
          message: "Native form rules currently expand detail-table row markers to columns and cannot represent whole-container visibility or required semantics."
        });
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

function draftWorkflow(sourceWorkflow) {
  const sourceNodes = sourceWorkflow.nodes || [];
  const nodeById = new Map(sourceNodes.map((node) => [node.id, node]));
  const draftParticipantSelections = participantSelectionsFromDraftNodes(sourceNodes);
  return {
    process: sourceWorkflow.process || {},
    nodes: sourceNodes.map((node) => {
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
        dataAuthority: draftDataAuthority(node.dataAuthority),
        participants: nodeType.participants === false
          ? undefined
          : participantsFromSourceNode(node, draftParticipantSelections.get(node.id)),
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

function participantSelectionsFromDraftNodes(nodes) {
  const selections = new Map();
  for (const node of nodes) {
    if (!String(node.sourceType || "").toLowerCase().includes("draft")) continue;
    const attrs = sourceNodeAttributes(node);
    for (const attribute of ["mustModifyHandlerNodeIds", "canModifyHandlerNodeIds"]) {
      for (const targetNodeId of splitRelatedNodeIds(attrs[attribute])) {
        if (selections.has(targetNodeId)) continue;
        selections.set(targetNodeId, {
          sourceNodeId: node.id,
          attribute,
          targetNodeId
        });
      }
    }
  }
  return selections;
}

function draftDataAuthority(dataAuthority) {
  if (!dataAuthority || typeof dataAuthority !== "object") return undefined;
  const fields = Object.fromEntries(
    Object.entries(dataAuthority.fields || {}).map(([fieldId, value]) => [fieldId, pruneUndefined({
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

function participantsFromSourceNode(node, draftSelection) {
  const attrs = node.attributes || {};
  const handlerIds = splitList(attrs.handlerIds);
  const handlerNames = splitList(attrs.handlerNames);
  const formFieldParticipant = formFieldParticipantFromFormulaHandler(attrs, handlerIds, handlerNames);
  if (formFieldParticipant) return formFieldParticipant;
  const roleLineParticipant = roleLineParticipantFromFormulaHandler(attrs, handlerIds, handlerNames);
  if (roleLineParticipant) return roleLineParticipant;

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

  if (draftSelection && handlerIds.length === 0) {
    return {
      mode: "initiator_select",
      sourceSemantics: `draft node ${draftSelection.sourceNodeId} ${draftSelection.attribute} includes ${draftSelection.targetNodeId}`
    };
  }

  return {
    mode: "empty",
    reason: "source did not specify executable participants"
  };
}

function formFieldParticipantFromFormulaHandler(attrs, handlerIds, handlerNames) {
  if (attrs.handlerSelectType !== "formula") return undefined;
  if (handlerIds.length !== 1) return undefined;

  const fieldId = simpleDollarExpressionValue(handlerIds[0]);
  if (!fieldId || !fieldId.startsWith("fd_")) return undefined;

  const fieldTitle = simpleDollarExpressionValue(handlerNames[0]) || fieldId;
  return {
    mode: "form_field",
    fieldId,
    fieldTitle,
    sourceExpression: handlerIds[0],
    sourceNameExpression: handlerNames[0] || ""
  };
}

function roleLineParticipantFromFormulaHandler(attrs, handlerIds, handlerNames) {
  if (attrs.handlerSelectType !== "formula") return undefined;
  if (handlerIds.length !== 1) return undefined;

  const parsed = parseRoleLineFormula(handlerIds[0]);
  if (!parsed || !parsed.subject.startsWith("fd_")) return undefined;

  const nameParsed = parseRoleLineFormula(handlerNames[0]);
  const fieldTitle = nameParsed?.subject && !nameParsed.subject.startsWith("fd_")
    ? nameParsed.subject
    : parsed.subject;

  return {
    mode: "role_line",
    fieldId: parsed.subject,
    fieldTitle,
    companyRole: parsed.companyRole,
    departmentRole: parsed.departmentRole,
    sourceExpression: handlerIds[0],
    sourceNameExpression: handlerNames[0] || ""
  };
}

function parseRoleLineFormula(value) {
  const text = normalizeLegacyExpression(value);
  const match = text.match(/^\$组织架构\.解释角色线\$\s*\((.*)\)$/);
  if (!match) return undefined;

  const args = splitFunctionArguments(match[1]);
  if (args.length < 3) return undefined;

  const subject = simpleDollarExpressionValue(args[0]);
  if (!subject) return undefined;

  return {
    subject,
    companyRole: unquoteLegacyArgument(args[1]),
    departmentRole: unquoteLegacyArgument(args[2])
  };
}

function splitFunctionArguments(value) {
  const args = [];
  const text = String(value || "");
  let quote = "";
  let depth = 0;
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const previous = text[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === "," && depth === 0) {
      args.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }

  args.push(text.slice(start).trim());
  return args.filter(Boolean);
}

function unquoteLegacyArgument(value) {
  const text = normalizeLegacyExpression(value);
  const match = text.match(/^["']([\s\S]*)["']$/);
  return match ? match[1].replace(/\\"/g, "\"").replace(/\\'/g, "'") : text;
}

function simpleDollarExpressionValue(value) {
  const text = String(value || "").trim();
  const match = text.match(/^\$([^$()]+)\$$/);
  return match ? match[1].trim() : "";
}

function mapWorkflowNodeType(node = {}, nodeById = new Map()) {
  const sourceType = node.sourceType || "";
  const normalized = String(sourceType).toLowerCase();
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
