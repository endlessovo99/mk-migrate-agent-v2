import {
  catalogRefs,
  COMPONENTS_BY_ID,
  componentSupportsProp,
  validationPolicyRef
} from "../dsl/catalogs.js";
import { translateLegacyConditionContextReferences } from "../dsl/condition-context.js";
import { buildFormRuleRefIndex, resolveDirectRef, resolveEffectTarget } from "../dsl/form-rules.js";
import { inspectNativeFormRuleProjection } from "../dsl/native-form-rule-projection.js";
import { deterministicManualResidualDecisionId } from "../dsl/deterministic-script-translations.js";
import { packLayoutGrid, projectLayoutGrid } from "../dsl/layout-pack.js";
import {
  applyFieldIdMapToForm,
  applyFieldIdMapToScripts,
  applyFieldIdMapToSourceFormRules,
  applyFieldIdMapToWorkflow,
  buildFieldIdMap
} from "./field-id-remap.js";
import { SOURCE_DRAFT_VERSION } from "./source-draft.js";
import {
  draftMkScriptsFromSourceScripts,
  sourceNumericDetailFieldInferences
} from "./sysform-jsp-scripts.js";
import {
  classifyWorkflowDynamicParticipant,
  classifyWorkflowFormulaParticipant
} from "./workflow-formula-participants.js";
import {
  conditionalParallelSplitIds,
  isSupportedConditionalParallelCondition
} from "./conditional-parallel.js";
import { componentForSourceType } from "./field-component.js";
import { conditionalTotalCalculationModel } from "./conditional-total-calculation.js";
import { analyzeLegacyDetailSumHelper } from "./legacy-detail-sum.js";
import { projectDynamicHyperlinkForm } from "./dynamic-hyperlink.js";
import { multiRadioRowHelperFormRules } from "./multi-radio-row-helper.js";

export const MIGRATION_DSL_VERSION = "2.0-migration";

const TABLE_LAYOUT_COMPONENT_ID = "xform-multi-row-table-layout";
const TABLE_LAYOUT_MAX_COLUMNS = tableLayoutMaxColumns();
const LEGACY_DATE_TIME_DISPLAY_PATTERN = "yyyy-MM-dd hh:mm";

export function draftSourceDraft(sourceDraft, options = {}) {
  if (sourceDraft?.version !== SOURCE_DRAFT_VERSION || sourceDraft?.artifact !== "source-draft") {
    throw new Error("draft requires a source-draft artifact");
  }

  const rawForm = projectDynamicHyperlinkForm(
    applySourceNumericDetailInferences(
      applyNativeCalculationInferences(
        draftForm(sourceDraft.form || {}),
        sourceDraft.scripts
      ),
      sourceDraft.scripts
    ),
    sourceDraft.scripts
  );
  const fieldIdMap = buildFieldIdMap(rawForm);
  const form = applyFieldIdMapToForm(rawForm, fieldIdMap);
  const knownSourceFieldIds = collectFormFieldIds(rawForm);
  const multiRadioFormRules = multiRadioRowHelperFormRules(sourceDraft.scripts, form);
  const formRules = draftFormRules(
    applyFieldIdMapToSourceFormRules(
      mergeSourceFormRules(sourceDraft.formRules, multiRadioFormRules),
      fieldIdMap
    ),
    form
  );
  const mappedScripts = applyFieldIdMapToScripts(
    draftMkScriptsFromSourceScripts(sourceDraft.scripts, { form, formRules }),
    fieldIdMap
  );
  const scripts = attachCalculationDecisions(mappedScripts, form, sourceDraft.scripts);
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

function applySourceNumericDetailInferences(form, sourceScripts) {
  const inferences = sourceNumericDetailFieldInferences(sourceScripts, form);
  const byRef = new Map(inferences.map((inference) => [
    `${inference.tableId}.${inference.fieldId}`,
    inference
  ]));
  if (!byRef.size) return form;
  return {
    ...form,
    fields: (form.fields || []).map((field) => {
      if (field.type !== "detailTable") return field;
      return {
        ...field,
        columns: (field.columns || []).map((column) => {
          const inference = byRef.get(`${field.id}.${column.id}`);
          if (!inference || column.type !== "text" || column.componentId !== "xform-input") return column;
          return {
            ...column,
            type: "number",
            componentId: "xform-number",
            sourceProps: {
              ...(column.sourceProps || {}),
              numericCalculationInference: {
                classification: "source",
                originalType: column.type,
                originalComponentId: column.componentId,
                sourceRef: inference.sourceRef,
                evidence: inference.evidence
              }
            }
          };
        })
      };
    })
  };
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

function attachCalculationDecisions(scripts, form, sourceScripts = {}) {
  const actions = scripts?.actions || [];
  const decisions = [];
  const coveredRangesBySourceRef = new Map();
  const nativeFormulaCoverage = nativeFormulaSourceCoverage(sourceScripts, form);
  const nativeSourceCoverageByTarget = nativeFormulaCoverage.rangesByTarget;
  const scriptResidualKeys = new Set();
  const fields = (form.fields || []).flatMap((field) =>
    field.type === "detailTable"
      ? (field.columns || []).map((column) => ({ field: column, tableId: field.id }))
      : [{ field }]
  );

  for (const { field, tableId } of fields) {
    const calculation = field.props?.calculation;
    if (!calculation) continue;
    const inferred = field.sourceProps?.inferredCalculation;
    const targetRef = tableId ? `${tableId}.${field.id}` : field.id;
    const nativeSourceCoverage = nativeSourceCoverageByTarget.get(targetRef) || [];
    const dependentCallSemantics = (inferred?.dependentCalls || []).map((name) => {
      const targets = [...(nativeFormulaCoverage.targetsByFunctionName.get(name) || [])];
      const nativeTarget = targets.length === 1 && nativeFormulaDependsOnRef(form, targets[0], targetRef)
        ? targets[0]
        : undefined;
      return {
        name,
        handling: nativeTarget ? "native_dependency_recalculation" : "manual",
        ...(nativeTarget ? { nativeTarget } : {})
      };
    });
    const sourceRefs = uniqueStrings([
      field.sourceRef,
      inferred?.sourceRef,
      ...nativeSourceCoverage.map((range) => range.sourceRef)
    ]);
    addCoveredCalculationRanges(coveredRangesBySourceRef, inferred?.coveredCalculationRanges);
    addCoveredCalculationRanges(coveredRangesBySourceRef, nativeSourceCoverage);
    decisions.push({
      id: `calculation.native.${tableId ? `${tableId}.` : ""}${field.id}`,
      classification: "native",
      sourceRefs,
      targetRefs: [targetRef],
      evidence: inferred?.evidence || calculation.expression ||
        `${calculation.operation}(${calculation.tableId}.${calculation.fieldId})`,
      semantics: {
        ...calculation,
        ...(inferred?.postTransform ? { postTransform: inferred.postTransform } : {}),
        ...(dependentCallSemantics.length ? { sourceDependentCalls: dependentCallSemantics } : {})
      }
    });
    for (const call of dependentCallSemantics.filter((item) => item.handling === "manual")) {
      decisions.push({
        id: `calculation.manual.${tableId ? `${tableId}.` : ""}${field.id}.dependent-call.${call.name}`,
        classification: "manual",
        sourceRefs,
        targetRefs: [targetRef],
        evidence: `${call.name}();`,
        reason: `The source aggregate invokes ${call.name}(); no unique downstream native calculation proves equivalent dependent recalculation.`,
        code: "calculation.dependent_call_unmapped"
      });
    }
    for (const [index, residual] of (inferred?.residuals || []).entries()) {
      decisions.push({
        id: `calculation.manual.${tableId ? `${tableId}.` : ""}${field.id}.${index + 1}`,
        classification: "manual",
        sourceRefs,
        targetRefs: [tableId ? `${tableId}.${field.id}` : field.id],
        evidence: inferred.evidence,
        reason: residual.reason,
        code: residual.code
      });
    }
  }

  for (const action of actions) {
    const mappingManualResiduals = (action.functionMappings || [])
      .flatMap((mapping) => mapping.manualResiduals || []);
    if (action.translationStatus !== "mapped") continue;
    const recordsScriptCalculation = (action.functionMappings || []).some((mapping) =>
      /calculation|finance-detail-generation/u.test(String(mapping.basis || mapping.source || ""))
    );
    if (!recordsScriptCalculation && !mappingManualResiduals.length) continue;
    for (const range of action.semanticHints?.coveredCalculationRanges || []) {
      addCoveredCalculationRanges(coveredRangesBySourceRef, [range]);
    }
    if (recordsScriptCalculation) {
      decisions.push({
        id: `calculation.script.${action.id}`,
        classification: "script",
        sourceRefs: action.sourceRefs || [],
        triggerRefs: [action.tableId ? `${action.tableId}.${action.controlId}` : action.controlId].filter(Boolean),
        targetRefs: uniqueStrings([
          ...calculationScriptTargetRefs(action.function),
          action.semanticHints?.targetDetailTableId
        ]),
        evidence: (action.functionMappings || []).map((mapping) => mapping.source).filter(Boolean).join("; "),
        actionId: action.id
      });
    }
    for (const residual of mappingManualResiduals) {
      const sourceKey = (action.sourceRefs || []).join("|");
      const residualKey = `${sourceKey}|${residual.code || residual.reason}`;
      if (scriptResidualKeys.has(residualKey)) continue;
      scriptResidualKeys.add(residualKey);
      decisions.push({
        id: deterministicManualResidualDecisionId(action, residual),
        classification: "manual",
        sourceRefs: action.sourceRefs || [],
        targetRefs: calculationScriptTargetRefs(action.function),
        evidence: (action.functionMappings || []).map((mapping) => mapping.source).filter(Boolean).join("; "),
        reason: residual.reason,
        code: residual.code
      });
    }
  }

  const sourceFieldMap = sourceToTargetFieldMap(form);
  for (const source of sourceScripts?.sources || []) {
    const residualSource = sourceWithoutCoveredRanges(
      source.javascript,
      coveredRangesBySourceRef.get(source.sourceRef)
    );
    if (!hasUncoveredCalculationBehavior(residualSource)) continue;
    const targetRefs = uniqueStrings(
      [...String(residualSource || "").matchAll(/\bfd_[A-Za-z0-9_]+\b/gu)]
        .map((match) => sourceFieldMap.get(match[0]))
        .filter(Boolean)
    );
    if (!targetRefs.length) continue;
    decisions.push({
      id: `calculation.manual.${String(source.sourceRef || "source").replace(/[^A-Za-z0-9_.-]+/gu, "-")}`,
      classification: "manual",
      sourceRefs: [source.sourceRef].filter(Boolean),
      targetRefs,
      evidence: calculationEvidencePreview(residualSource),
      reason: "The source calculation uses branching, detail lifecycle, DOM state, or a helper closure that is not yet proven equivalent in the constrained MK native/script catalogs."
    });
  }

  if (!scripts && !decisions.length) return scripts;
  return {
    ...(scripts || { source: sourceScripts?.source || "sysform-jsp", actions: [], warnings: [], javascript: "" }),
    calculationDecisions: decisions
  };
}

function nativeFormulaSourceCoverage(sourceScripts = {}, form = {}) {
  const formulaFieldByTarget = new Map(
    (form.fields || [])
      .filter((field) => field.type !== "detailTable" && field.props?.calculation?.kind === "formula")
      .map((field) => [field.id, field])
  );
  const rangesByTarget = new Map();
  const targetsByFunctionName = new Map();
  for (const source of sourceScripts?.sources || []) {
    const text = String(source.javascript || "");
    for (const fn of namedCalculationFunctions(text)) {
      const model = additiveSourceFunctionModel(fn.body);
      if (!model) continue;
      const field = formulaFieldByTarget.get(model.targetFieldId);
      if (!isEquivalentAdditiveFormula(field?.props?.calculation, model.dependencyFieldIds)) continue;
      if (model.roundsToTwo && field?.props?.precision !== 2) continue;
      const ranges = rangesByTarget.get(model.targetFieldId) || [];
      ranges.push(...model.coveredRanges.map((range) => sourceRange(
        source,
        fn.bodyStart + range.start,
        fn.bodyStart + range.end,
        `${fn.name}.${range.name}`
      )));
      rangesByTarget.set(model.targetFieldId, ranges);
      const targets = targetsByFunctionName.get(fn.name) || new Set();
      targets.add(model.targetFieldId);
      targetsByFunctionName.set(fn.name, targets);
    }
  }
  return { rangesByTarget, targetsByFunctionName };
}

function nativeFormulaDependsOnRef(form, formulaTargetId, dependencyRef) {
  const field = (form.fields || []).find((candidate) => candidate.id === formulaTargetId);
  if (field?.type === "detailTable" || field?.props?.calculation?.kind !== "formula") return false;
  return (field.props.calculation.fieldIds || []).includes(dependencyRef);
}

function additiveSourceFunctionModel(body) {
  const selected = selectedFieldIdVariables(body);
  if (selected.size < 3) return undefined;
  if (/\b(?:if|else|switch|for|while|do|try|catch|finally|return|throw)\b/u.test(stripSourceComments(body))) {
    return undefined;
  }
  const assignmentPattern = /(?:^|[;\n])\s*(?:var\s+)?([A-Za-z_$][\w$]*)\s*=\s*([^;]+)\s*;/gu;
  const numericTerm = /Number\(\s*([A-Za-z_$][\w$]*)\.val\(\)\s*\?\s*\1\.val\(\)\s*:\s*0\s*\)/gu;
  for (const assignment of body.matchAll(assignmentPattern)) {
    const resultVariable = assignment[1];
    const rhs = assignment[2];
    const dependencyVariables = [...rhs.matchAll(numericTerm)].map((match) => match[1]);
    if (dependencyVariables.length < 2) continue;
    const normalized = rhs.replace(numericTerm, "1").replace(/[\s()]/gu, "");
    if (!/^1(?:\+1)+$/u.test(normalized)) continue;
    const dependencyFieldIds = dependencyVariables.map((variable) => selected.get(variable));
    if (dependencyFieldIds.some((fieldId) => !fieldId)) continue;
    for (const [targetVariable, targetFieldId] of selected) {
      if (dependencyVariables.includes(targetVariable)) continue;
      const targetWrite = new RegExp(
        `\\b${escapeRegExp(targetVariable)}\\s*\\.\\s*val\\(\\s*${escapeRegExp(resultVariable)}\\s*\\)`,
        "u"
      );
      const targetMatch = targetWrite.exec(body);
      if (!targetMatch) continue;
      if (targetMatch.index <= assignment.index + assignment[0].length) continue;
      const rounding = new RegExp(
        `\\b${escapeRegExp(resultVariable)}\\s*=\\s*theFixedNumTwo\\(\\s*${escapeRegExp(resultVariable)}\\s*\\)\\s*;`,
        "u"
      ).exec(body);
      const betweenStart = assignment.index + assignment[0].length;
      const betweenEnd = targetMatch.index;
      const between = body.slice(betweenStart, betweenEnd).split("");
      const roundingBetween = rounding && rounding.index >= betweenStart && rounding.index < betweenEnd;
      if (rounding && !roundingBetween) continue;
      if (roundingBetween) {
        const localStart = rounding.index - betweenStart;
        for (let index = localStart; index < localStart + rounding[0].length; index += 1) {
          if (between[index] !== "\n" && between[index] !== "\r") between[index] = " ";
        }
      }
      const resultMutation = new RegExp(
        `\\b${escapeRegExp(resultVariable)}\\s*(?:[+\\-*/%]?=|\\+\\+|--)`,
        "u"
      );
      if (resultMutation.test(between.join(""))) continue;
      return {
        targetFieldId,
        dependencyFieldIds,
        roundsToTwo: Boolean(roundingBetween),
        coveredRanges: [
          {
            name: "additive-assignment",
            start: assignment.index,
            end: assignment.index + assignment[0].length
          },
          ...(rounding ? [{
            name: "fixed-two-rounding",
            start: rounding.index,
            end: rounding.index + rounding[0].length
          }] : []),
          {
            name: "target-write",
            start: targetMatch.index,
            end: targetMatch.index + targetMatch[0].length
          }
        ]
      };
    }
  }
  return undefined;
}

function isEquivalentAdditiveFormula(calculation, dependencyFieldIds) {
  if (calculation?.kind !== "formula") return false;
  const expected = [...String(calculation.expression || "").matchAll(/\$([A-Za-z_][\w]*)\$/gu)]
    .map((match) => match[1])
    .sort();
  const observed = [...dependencyFieldIds].sort();
  if (JSON.stringify(expected) !== JSON.stringify(observed)) return false;
  const remainder = String(calculation.expression || "")
    .replace(/\$[A-Za-z_][\w]*\$/gu, "1")
    .replace(/[\s()]/gu, "");
  return /^1(?:\+1)+$/u.test(remainder);
}

function stripSourceComments(value) {
  return String(value || "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\r\n]*/gu, "");
}

function maskSourceComments(value) {
  const characters = String(value || "").split("");
  let quote = "";
  let escaped = false;
  for (let index = 0; index < characters.length; index += 1) {
    const char = characters[index];
    const next = characters[index + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "/" && next === "/") {
      for (; index < characters.length && characters[index] !== "\n" && characters[index] !== "\r"; index += 1) {
        characters[index] = " ";
      }
      index -= 1;
      continue;
    }
    if (char === "/" && next === "*") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 2;
      while (index < characters.length && !(characters[index] === "*" && characters[index + 1] === "/")) {
        if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
        index += 1;
      }
      if (index < characters.length) {
        characters[index] = " ";
        characters[index + 1] = " ";
        index += 1;
      }
    }
  }
  return characters.join("");
}

function namedCalculationFunctions(text) {
  const functions = [];
  const pattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gu;
  for (const match of String(text).matchAll(pattern)) {
    const open = match.index + match[0].length - 1;
    const close = balancedBraceClose(text, open);
    if (close <= open) continue;
    functions.push({
      name: match[1],
      body: text.slice(open + 1, close),
      bodyStart: open + 1,
      start: match.index,
      end: close + 1
    });
  }
  return functions;
}

function addCoveredCalculationRanges(rangesBySourceRef, ranges = []) {
  for (const range of ranges || []) {
    if (!range?.sourceRef || !Number.isInteger(range.start) || !Number.isInteger(range.end)) continue;
    const values = rangesBySourceRef.get(range.sourceRef) || [];
    values.push({ start: range.start, end: range.end, name: range.name });
    rangesBySourceRef.set(range.sourceRef, values);
  }
}

function sourceWithoutCoveredRanges(source, ranges = []) {
  const characters = String(source || "").split("");
  if (!Array.isArray(ranges) || !ranges.length) return characters.join("");
  for (const range of ranges) {
    const start = Math.max(0, Math.min(characters.length, range.start));
    const end = Math.max(start, Math.min(characters.length, range.end));
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
    }
  }
  return characters.join("");
}

function sourceToTargetFieldMap(form = {}) {
  const values = new Map();
  for (const field of form.fields || []) {
    values.set(field.sourceProps?.originalId || field.id, field.id);
    for (const column of field.columns || []) {
      values.set(column.sourceProps?.originalId || column.id, `${field.id}.${column.id}`);
    }
  }
  return values;
}

function calculationScriptTargetRefs(source = "") {
  const targets = [];
  for (const match of String(source).matchAll(/MKXFORM\.(?:setValue|updateControl)\(\s*(["'])([^"']+)\1/gu)) {
    targets.push(match[2].replace(/^\$\{table:([^}]+)\}\./u, "$1."));
  }
  return uniqueStrings(targets);
}

function hasUncoveredCalculationBehavior(source = "") {
  const text = String(source);
  const numericEvidence = /(?:\b(?:sum|total|amount|price|tax|allowance|inspire)\b|\b[A-Za-z_$][\w$]*(?:Sum|Total|Amount|Price|Tax|Allowance|Inspire)\s*\(|Math\.(?:min|max|round|pow)|\.toFixed\s*\(|theFixedNum|XForm_CalculatioFuns_Sum)/iu.test(text);
  const writeEvidence = /(?:SetXFormFieldValueById|\.val\s*\(|\.value\s*=)/u.test(text);
  const executableEvidence = /(?:AttachXFormValueChangeEventById|Com_Parameter\.event|function\s+[A-Za-z_$][\w$]*\s*\()/u.test(text);
  return numericEvidence && writeEvidence && executableEvidence;
}

function calculationEvidencePreview(source = "") {
  const line = String(source)
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find((value) => /(?:Math\.|theFixedNum|\.toFixed\s*\(|\bsum\b|\btotal\b)/iu.test(value));
  return String(line || source).replace(/\s+/gu, " ").trim().slice(0, 320);
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
      props: propsFromSource(column, { detailTableId: table.id }),
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

function propsFromSource(source, options = {}) {
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
  const displayText = source.sourceProps?.displayText?.content;
  const placeholder = typeof inlineHint === "string" && inlineHint.trim()
    ? inlineHint
    : displayText;
  if (componentSupportsProp(componentId, "placeholder") && typeof placeholder === "string" && placeholder.trim()) {
    props.placeholder = placeholder;
  }
  const inlineUnit = source.sourceProps?.inlineUnit?.content;
  if (componentId === "xform-number" && typeof inlineUnit === "string" && inlineUnit.trim()) {
    props.unit = inlineUnit.trim();
  }
  if (Array.isArray(source.options) && source.options.length) {
    props.options = targetOptionsFromSource(source.options);
  }

  if (componentSupportsProp(componentId, "defaultValue")) {
    const defaultValue = legacyDefaultValueFromSource(source);
    if (defaultValue) props.defaultValue = defaultValue;
  }
  if (componentId === "xform-datetime" && source.sourceType === "dateTime") {
    props.displayPattern = LEGACY_DATE_TIME_DISPLAY_PATTERN;
  }

  if (["xform-number", "xform-calculate"].includes(componentId)) {
    const precision = nonNegativeInteger(source.sourceProps?.designerValues?.decimal);
    if (precision !== undefined) props.precision = precision;
  }

  if (componentId === "xform-calculate") {
    const calculation = legacyCalculationFromSource(source, options);
    if (calculation) props.calculation = calculation;
  }

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

function targetOptionsFromSource(options) {
  const byValue = new Map();
  const targetOptions = [];

  for (const option of options) {
    const targetOption = { label: option.label, value: option.value };
    const existing = byValue.get(targetOption.value);
    if (existing) {
      if (existing.labels.has(targetOption.label)) continue;
      existing.labels.add(targetOption.label);
      existing.option.label = [...existing.labels].join(" / ");
      continue;
    }
    byValue.set(targetOption.value, {
      option: targetOption,
      labels: new Set([targetOption.label])
    });
    targetOptions.push(targetOption);
  }

  return targetOptions;
}

function legacyDefaultValueFromSource(source) {
  const candidates = [
    source.sourceProps?.metadataAttributes?.defaultValue,
    source.sourceProps?.designerValues?.defaultValue,
    source.sourceProps?.designerValues?.formula
  ];

  for (const candidate of candidates) {
    const dateTimeDefault = parseLegacyDateTimeDefaultExpression(candidate, source);
    if (dateTimeDefault) return dateTimeDefault;
    const contextDefault = parseLegacyContextDefaultExpression(candidate, source);
    if (contextDefault) return contextDefault;
    const literalDefault = parseLegacyLiteralDefault(candidate, source);
    if (literalDefault) return literalDefault;
  }

  return undefined;
}

function parseLegacyDateTimeDefaultExpression(value, source) {
  if (!["date", "dateTime"].includes(source.sourceType)) return undefined;
  const expression = normalizeLegacyExpression(value).replace(/\s+/gu, "");
  if (/^(?:nowTime|DateTimeFunction\.getNow\(\))$/i.test(expression)) {
    return { kind: "currentTime" };
  }
  return undefined;
}

function parseLegacyLiteralDefault(value, source) {
  const expression = normalizeLegacyExpression(value);
  if (!expression || /^(?:null|undefined|nowTime)$/i.test(expression)) return undefined;
  if (/[\$()]/u.test(expression) || /Function\s*\./i.test(expression)) return undefined;
  if (isLegacyAddressSource(source)) return undefined;

  if (source.sourceType === "number" || String(source.sourceProps?.designerValues?.dataType || "").toLowerCase() === "double") {
    const number = Number(expression);
    if (Number.isFinite(number)) return { kind: "literal", value: number };
  }

  return { kind: "literal", value: expression };
}

function legacyCalculationFromSource(source, options = {}) {
  const values = source.sourceProps?.designerValues || {};
  const metadata = source.sourceProps?.metadataAttributes || {};
  const expression = firstNonEmptyExpression(
    values.expression_id,
    values.formula,
    String(metadata.formula || "").toLowerCase() === "true"
      ? metadata.defaultValue
      : undefined
  );
  if (!expression) return undefined;

  const aggregate = expression.match(/^\$XForm_CalculatioFuns_Sum\$\s*\(\s*\$([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)\$\s*\)$/u);
  if (aggregate) {
    return {
      kind: "aggregate",
      operation: "sum",
      tableId: aggregate[1],
      fieldId: aggregate[2]
    };
  }

  const arithmetic = normalizeArithmeticCalculationExpression(expression, {
    detailTableId: options.detailTableId ||
      values.tableName ||
      source.sourceProps?.designerTableName
  });
  if (!arithmetic) return undefined;
  return pruneUndefined({
    kind: "formula",
    expression: arithmetic.expression,
    displayExpression: normalizeLegacyDisplayExpression(
      values.expression_name || values.defaultValue
    ) || undefined,
    fieldIds: arithmetic.fieldIds
  });
}

function normalizeLegacyDisplayExpression(value) {
  const expression = normalizeLegacyExpression(value);
  if (!expression) return "";
  // DSL keeps leaf labels ("$金额$"); the executor expands them to
  // "$Template.明细表1.金额$" when writing native formula vo.content.
  return expression.replace(/\$([^$.\s]+)\.([^$]+)\$/gu, (_, _table, field) => `$${field}$`);
}

function normalizeArithmeticCalculationExpression(expression, options = {}) {
  const sourceExpression = String(expression || "");
  if (!isSupportedArithmeticExpression(sourceExpression)) return undefined;

  const fieldIds = [];
  let qualifiedTableId;
  let mixedTables = false;
  const rewritten = sourceExpression.replace(
    /\$([A-Za-z_][\w]*)(?:\.([A-Za-z_][\w]*))?\$/gu,
    (token, left, right) => {
      if (right) {
        if (qualifiedTableId && qualifiedTableId !== left) {
          mixedTables = true;
          return token;
        }
        qualifiedTableId = left;
        fieldIds.push(right);
        return `$${right}$`;
      }
      fieldIds.push(left);
      return token;
    }
  );
  if (mixedTables) return undefined;

  if (qualifiedTableId) {
    const detailTableId = options.detailTableId;
    if (detailTableId && qualifiedTableId !== detailTableId) return undefined;
    if (!isSupportedArithmeticExpression(rewritten)) return undefined;
  }

  return {
    expression: rewritten,
    fieldIds: uniqueStrings(fieldIds)
  };
}

function applyNativeCalculationInferences(form, sourceScripts = {}) {
  const candidatesByTarget = new Map();
  for (const source of sourceScripts?.sources || []) {
    const sums = inferDetailSumCalculations(source);
    const conditionalTotal = inferConditionalTotalCalculation(source, sourceScripts);
    for (const inference of [
      ...sums,
      ...inferRuntimeFormulaCalculations(source, sums),
      ...(conditionalTotal ? [conditionalTotal] : [])
    ]) {
      const candidates = candidatesByTarget.get(inference.targetFieldId) || [];
      candidates.push(inference);
      candidatesByTarget.set(inference.targetFieldId, candidates);
    }
  }
  const inferredByTarget = new Map();
  for (const [targetFieldId, candidates] of candidatesByTarget) {
    const semanticKeys = new Set(candidates.map(nativeInferenceSemanticKey));
    if (semanticKeys.size !== 1) continue;
    inferredByTarget.set(targetFieldId, mergeEquivalentNativeInferences(candidates));
  }
  if (!inferredByTarget.size) return form;

  const fields = (form.fields || []).map((field) => {
      const inference = inferredByTarget.get(field.id);
      if (!inference || field.type === "detailTable") return field;
      if (inference.postTransform?.kind === "clamp" && inference.kind === "aggregate") {
        const aggregateCalculation = {
          kind: "aggregate",
          operation: "sum",
          tableId: inference.tableId,
          fieldId: inference.sourceFieldId
        };
        return {
          ...field,
          type: "number",
          componentId: "xform-calculate",
          props: {
            ...(field.props || {}),
            calculation: aggregateCalculation
          },
          sourceProps: {
            ...(field.sourceProps || {}),
            inferredCalculation: inferredCalculationEvidence(inference, field.props?.calculation)
          }
        };
      }
      if (field.props?.calculation && inference.runtimeOverride !== true) {
        if (!sameNativeCalculation(field.props.calculation, inference)) return field;
        return {
          ...field,
          sourceProps: {
            ...(field.sourceProps || {}),
            inferredCalculation: inferredCalculationEvidence(inference)
          }
        };
      }
      const calculation = inference.kind === "formula"
        ? {
            kind: "formula",
            expression: inference.expression,
            displayExpression: inference.displayExpression || inference.expression,
            fieldIds: inference.fieldIds
          }
        : {
            kind: "aggregate",
            operation: "sum",
            tableId: inference.tableId,
            fieldId: inference.sourceFieldId
          };
      return {
        ...field,
        type: "number",
        componentId: "xform-calculate",
        props: {
          ...(field.props || {}),
          calculation
        },
        sourceProps: {
          ...(field.sourceProps || {}),
          inferredCalculation: inferredCalculationEvidence(inference, field.props?.calculation)
        }
      };
    });

  return {
    ...form,
    fields
  };
}

function nativeInferenceSemanticKey(inference) {
  return JSON.stringify({
    kind: inference.kind,
    ...(inference.kind === "aggregate" ? {
      tableId: inference.tableId,
      sourceFieldId: inference.sourceFieldId
    } : {
      expression: inference.expression,
      fieldIds: inference.fieldIds
    }),
    postTransform: inference.postTransform || null,
    composition: inference.composition || null,
    dependentCalls: [...(inference.dependentCalls || [])].sort()
  });
}

function mergeEquivalentNativeInferences(candidates) {
  const [first] = candidates;
  return {
    ...first,
    evidence: uniqueStrings(candidates.map(candidate => candidate.evidence)).join(" | "),
    coveredCalculationRanges: candidates.flatMap(candidate => candidate.coveredCalculationRanges || []),
    dependentCalls: uniqueStrings(candidates.flatMap(candidate => candidate.dependentCalls || [])),
    residuals: candidates.flatMap(candidate => candidate.residuals || [])
  };
}

function inferConditionalTotalCalculation(source, sourceScripts) {
  const model = conditionalTotalCalculationModel(source, sourceScripts);
  if (!model) return undefined;
  const branchExpression = `($${model.modeFieldId}$ == ${model.modeValue} ? (${model.trueFieldIds.map((fieldId) => `$${fieldId}$`).join(" + ")}) : (${model.falseFieldIds.map((fieldId) => `$${fieldId}$`).join(" + ")}))`;
  return {
    kind: "formula",
    targetFieldId: model.totalTargetFieldId,
    expression: `Math.round((${branchExpression}) * 100) / 100`,
    displayExpression: "travel-scope conditional total",
    fieldIds: uniqueStrings([model.modeFieldId, ...model.sourceFieldIds]),
    sourceRef: model.sourceRef,
    evidence: model.evidence,
    coveredCalculationRanges: model.coveredCalculationRanges,
    runtimeOverride: true,
    residuals: []
  };
}

function inferredCalculationEvidence(inference, sourceFormulaOverride) {
  return {
    classification: "native",
    kind: inference.kind,
    sourceRef: inference.sourceRef,
    evidence: inference.evidence,
    ...(inference.coveredCalculationRanges?.length
      ? { coveredCalculationRanges: inference.coveredCalculationRanges }
      : {}),
    ...(inference.dependentCalls?.length ? { dependentCalls: inference.dependentCalls } : {}),
    ...(inference.runtimeOverride && sourceFormulaOverride ? { sourceFormulaOverride } : {}),
    ...(inference.composition ? { composition: inference.composition } : {}),
    ...(inference.postTransform ? { postTransform: inference.postTransform } : {}),
    ...(inference.residuals?.length ? { residuals: inference.residuals } : {})
  };
}

function sameNativeCalculation(calculation, inference) {
  return calculation?.kind === "aggregate" &&
    inference.kind === "aggregate" &&
    calculation.operation === "sum" &&
    calculation.tableId === inference.tableId &&
    calculation.fieldId === inference.sourceFieldId;
}

function inferDetailSumCalculations(source = {}) {
  const text = maskSourceComments(String(source.javascript || ""));
  if (!text) return [];
  const outerTableVars = topLevelAssignedFieldIdVariables(text);
  const results = [];

  const assignedCall = /\b([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*(["'])(fd_[A-Za-z0-9_]+)\3\s*,\s*([A-Za-z_$][\w$]*)\s*\)/gu;
  for (const match of text.matchAll(assignedCall)) {
    const caller = sourceFunctionAtIndex(text, match.index);
    if (!caller) continue;
    const localCallStart = match.index - caller.bodyStart;
    if (isWithinControlFlow(caller.body, localCallStart, localCallStart + match[0].length)) continue;
    const helper = sourceFunction(text, match[1]);
    const semantics = detailSumHelperSemantics(helper);
    const tableId = resolveAssignedFieldId(caller.body, outerTableVars, match[2]);
    const targetFieldId = uniqueSelectedFieldIdVariables(caller.body).get(match[5]);
    if (!tableId || !targetFieldId || !semantics) continue;
    results.push(detailSumInference(source, tableId, match[4], targetFieldId, match[0], semantics, [
      sourceRange(source, match.index, match.index + match[0].length, match[1]),
      sourceFunctionRange(source, helper)
    ], match[1]));
  }

  const returnedCall = /var\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*(["'])(fd_[A-Za-z0-9_]+)\4\s*\)/gu;
  for (const match of text.matchAll(returnedCall)) {
    if (/\bMath\.min\s*\(/u.test(text)) continue;
    const helper = sourceFunction(text, match[2]);
    const semantics = detailSumHelperSemantics(helper);
    const caller = sourceFunctionAtIndex(text, match.index);
    if (!caller) continue;
    const tableId = resolveAssignedFieldId(caller.body, outerTableVars, match[3]);
    if (!tableId || !semantics) continue;
    const localAfterCall = match.index - caller.bodyStart + match[0].length;
    const callerRemainder = caller.body.slice(localAfterCall);
    for (const [variable, targetFieldId] of uniqueSelectedFieldIdVariables(caller.body)) {
      const assignment = new RegExp(`\\b${escapeRegExp(variable)}\\s*\\.\\s*val\\(\\s*${escapeRegExp(match[1])}\\s*\\)`, "u");
      const assignmentMatch = assignment.exec(callerRemainder);
      if (!assignmentMatch) continue;
      const localCallStart = match.index - caller.bodyStart;
      const localWriteEnd = localAfterCall + assignmentMatch.index + assignmentMatch[0].length;
      if (isWithinControlFlow(caller.body, localCallStart, localWriteEnd)) continue;
      if (hasUnsafeInterveningBehavior(
        caller.body,
        localAfterCall,
        localAfterCall + assignmentMatch.index + assignmentMatch[0].length,
        [match[1]]
      )) continue;
      const assignmentStart = caller.bodyStart + localAfterCall + assignmentMatch.index;
      results.push(detailSumInference(source, tableId, match[5], targetFieldId, match[0], semantics, [
        sourceRange(source, match.index, match.index + match[0].length, match[2]),
        sourceRange(source, assignmentStart, assignmentStart + assignmentMatch[0].length, "aggregate-target"),
        sourceFunctionRange(source, helper)
      ], match[2]));
    }
  }
  return dedupeBy(results, (item) => `${item.targetFieldId}:${item.tableId}:${item.sourceFieldId}`);
}

function detailSumInference(source, tableId, sourceFieldId, targetFieldId, evidence, semantics = {}, coveredCalculationRanges = [], helperName) {
  return {
    kind: "aggregate",
    tableId,
    sourceFieldId,
    targetFieldId,
    sourceRef: source.sourceRef,
    helperName,
    evidence: String(evidence).replace(/\s+/gu, " ").trim(),
    coveredCalculationRanges: coveredCalculationRanges.filter(Boolean),
    residuals: semantics.residuals || [],
    ...(semantics.dependentCalls?.length ? { dependentCalls: semantics.dependentCalls } : {}),
    ...(semantics.postTransform ? { postTransform: semantics.postTransform } : {})
  };
}

function inferRuntimeFormulaCalculations(source = {}, sumInferences = []) {
  const text = maskSourceComments(String(source.javascript || ""));
  const outerAssignedIds = topLevelAssignedFieldIdVariables(text);
  const results = [];

  for (const sum of sumInferences) {
    const sumAssignments = [...text.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*(["'])(fd_[A-Za-z0-9_]+)\4\s*\)/gu)]
      .filter((match) => {
        const candidateCaller = sourceFunctionAtIndex(text, match.index);
        return candidateCaller &&
          resolveAssignedFieldId(candidateCaller.body, outerAssignedIds, match[3]) === sum.tableId &&
          match[2] === sum.helperName &&
          match[5] === sum.sourceFieldId;
      });
    for (const sumAssignment of sumAssignments) {
      const caller = sourceFunctionAtIndex(text, sumAssignment.index);
      if (!caller) continue;
      const callerAssignments = sumAssignments.filter((candidate) =>
        sourceFunctionAtIndex(text, candidate.index)?.start === caller.start
      );
      if (callerAssignments.length !== 1) continue;
      const sumVariable = sumAssignment[1];
      const differences = [...caller.body.matchAll(new RegExp(
      `var\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapeRegExp(sumVariable)}\\s*-\\s*Number\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)\\s*;`,
      "gu"
      ))];
      if (differences.length !== 1) continue;
      const [difference] = differences;

      const otherReads = [...caller.body.matchAll(new RegExp(
      `var\\s+${escapeRegExp(difference[2])}\\s*=\\s*getFormFieldValue\\(\\s*(["']?)([A-Za-z_$][\\w$]*)\\1\\s*\\)\\s*;`,
      "gu"
      ))];
      if (otherReads.length !== 1) continue;
      const [otherRead] = otherReads;
      const otherFieldId = otherRead[1]
        ? otherRead[2]
        : resolveAssignedFieldId(caller.body, outerAssignedIds, otherRead[2]);
      if (!otherFieldId) continue;

      const targetWrites = [];
      for (const [targetVariable, targetFieldId] of uniqueSelectedFieldIdVariables(caller.body)) {
        const targetAssignment = new RegExp(
          `\\b${escapeRegExp(targetVariable)}\\s*\\.\\s*val\\(\\s*${escapeRegExp(difference[1])}\\s*\\)`,
          "gu"
        );
        for (const match of caller.body.matchAll(targetAssignment)) targetWrites.push({ targetFieldId, match });
      }
      if (targetWrites.length !== 1) continue;
      const [{ targetFieldId, match: targetMatch }] = targetWrites;
      const localSumIndex = sumAssignment.index - caller.bodyStart;
      if (!(localSumIndex < difference.index && otherRead.index < difference.index && difference.index < targetMatch.index)) {
        continue;
      }
      if (
        isWithinControlFlow(
          caller.body,
          Math.min(localSumIndex, otherRead.index),
          targetMatch.index + targetMatch[0].length
        ) ||
        hasUnsafeInterveningBehavior(
          caller.body,
          localSumIndex + sumAssignment[0].length,
          difference.index,
          [sumVariable]
        ) ||
        hasUnsafeInterveningBehavior(
          caller.body,
          otherRead.index + otherRead[0].length,
          difference.index,
          [difference[2]]
        ) ||
        hasUnsafeInterveningBehavior(
          caller.body,
          difference.index + difference[0].length,
          targetMatch.index + targetMatch[0].length,
          [difference[1]]
        )
      ) continue;
      results.push({
        kind: "formula",
        targetFieldId,
        expression: `$${sum.targetFieldId}$ - $${otherFieldId}$`,
        fieldIds: [sum.targetFieldId, otherFieldId],
        sourceRef: source.sourceRef,
        evidence: difference[0].replace(/\s+/gu, " ").trim(),
        coveredCalculationRanges: [
          sourceRange(source, sumAssignment.index, sumAssignment.index + sumAssignment[0].length, sumAssignment[2]),
          sourceRange(source, caller.bodyStart + difference.index, caller.bodyStart + difference.index + difference[0].length, "difference"),
          sourceRange(source, caller.bodyStart + targetMatch.index, caller.bodyStart + targetMatch.index + targetMatch[0].length, "formula-target")
        ],
        runtimeOverride: true,
        residuals: []
      });
    }
  }
  return dedupeBy(results, (item) => item.targetFieldId);
}

function assignedFieldIdVariables(text) {
  const values = new Map();
  for (const match of text.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(fd_[A-Za-z0-9_]+)\2\s*;/gu)) {
    values.set(match[1], match[3]);
  }
  return values;
}

function uniqueAssignedFieldIdVariables(text) {
  return uniqueVariableValues(
    [...String(text).matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(fd_[A-Za-z0-9_]+)\2\s*;/gu)]
      .map((match) => [match[1], match[3]])
  );
}

function topLevelAssignedFieldIdVariables(text) {
  const commentFree = maskSourceComments(String(text || ""));
  const characters = commentFree.split("");
  for (const fn of namedCalculationFunctions(commentFree)) {
    for (let index = fn.start; index < fn.end; index += 1) {
      if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
    }
  }
  return uniqueAssignedFieldIdVariables(characters.join(""));
}

function resolveAssignedFieldId(callerBody, outerValues, variable) {
  const localValues = uniqueAssignedFieldIdVariables(callerBody);
  if (declaresVariable(callerBody, variable)) return localValues.get(variable);
  return outerValues.get(variable);
}

function declaresVariable(text, variable) {
  return new RegExp(`\\bvar\\s+${escapeRegExp(variable)}\\b`, "u").test(text);
}

function selectedFieldIdVariables(text) {
  const values = new Map();
  const pattern = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*\$\([^\n;]*?extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)[^\n;]*[;\n]/gu;
  for (const match of text.matchAll(pattern)) values.set(match[1], match[2]);
  return values;
}

function uniqueSelectedFieldIdVariables(text) {
  const pattern = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*\$\([^\n;]*?extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)[^\n;]*[;\n]/gu;
  return uniqueVariableValues([...String(text).matchAll(pattern)].map((match) => [match[1], match[2]]));
}

function uniqueVariableValues(entries) {
  const values = new Map();
  const ambiguous = new Set();
  for (const [name, value] of entries) {
    if (values.has(name) && values.get(name) !== value) ambiguous.add(name);
    else if (!ambiguous.has(name)) values.set(name, value);
  }
  for (const name of ambiguous) values.delete(name);
  return values;
}

function detailSumHelperSemantics(helper) {
  const analysis = analyzeLegacyDetailSumHelper(helper);
  if (!analysis) return undefined;
  return {
    residuals: [],
    dependentCalls: analysis.dependentCalls,
    ...(analysis.postTransform ? { postTransform: analysis.postTransform } : {})
  };
}

function sourceFunction(text, name) {
  const pattern = new RegExp(`\\bfunction\\s+${escapeRegExp(name)}\\s*\\(([^)]*)\\)\\s*\\{`, "gu");
  const definitions = [];
  for (const match of String(text).matchAll(pattern)) {
    const open = match.index + match[0].length - 1;
    const close = balancedBraceClose(text, open);
    if (close <= open) return undefined;
    definitions.push({
      name,
      params: match[1].split(","),
      body: text.slice(open + 1, close),
      start: match.index,
      end: close + 1
    });
  }
  return definitions.length === 1 ? definitions[0] : undefined;
}

function hasUnsafeInterveningBehavior(body, start, end, variables) {
  const fragment = String(body).slice(start, end);
  if (/\b(?:if|else|switch|for|while|do|try|catch|continue|break|return|throw)\b/u.test(stripSourceComments(fragment))) {
    return true;
  }
  return variables.some((variable) => new RegExp(
    `\\b(?:var\\s+)?${escapeRegExp(variable)}\\s*(?:[+\\-*/%]?=|\\+\\+|--)`,
    "u"
  ).test(fragment));
}

function isWithinControlFlow(body, start, end) {
  const text = maskSourceComments(String(body || ""));
  const control = /\b(if|else|switch|for|while|do|try|catch)\b/gu;
  for (const match of text.matchAll(control)) {
    let cursor = match.index + match[0].length;
    while (/\s/u.test(text[cursor] || "")) cursor += 1;
    if (["if", "switch", "for", "while", "catch"].includes(match[1])) {
      if (text[cursor] !== "(") continue;
      cursor = balancedDelimiterClose(text, cursor, "(", ")") + 1;
      if (cursor <= 0) continue;
      while (/\s/u.test(text[cursor] || "")) cursor += 1;
    }
    if (text[cursor] === "{") {
      const close = balancedBraceClose(text, cursor);
      if (cursor < start && end <= close) return true;
      continue;
    }
    const statementEnd = statementSemicolon(text, cursor);
    if (cursor <= start && end <= statementEnd) return true;
  }
  return false;
}

function balancedDelimiterClose(text, open, opening, closing) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === opening) depth += 1;
    if (char === closing && --depth === 0) return index;
  }
  return -1;
}

function statementSemicolon(text, start) {
  let quote = "";
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") quote = char;
    else if (char === ";") return index + 1;
  }
  return text.length;
}

function sourceFunctionAtIndex(text, index) {
  return namedCalculationFunctions(text).find((fn) => fn.bodyStart <= index && index < fn.end);
}

function sourceFunctionRange(source, fn) {
  return fn ? sourceRange(source, fn.start, fn.end, fn.name) : undefined;
}

function sourceRange(source, start, end, name) {
  return { sourceRef: source.sourceRef, name, start, end };
}

function balancedBraceClose(text, open) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

function dedupeBy(values, keyFor) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyFor(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstNonEmptyExpression(...values) {
  for (const value of values) {
    const expression = normalizeLegacyExpression(value);
    if (expression) return expression;
  }
  return "";
}

function isSupportedArithmeticExpression(expression) {
  const withoutFields = String(expression).replace(
    /\$[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?\$/gu,
    "1"
  );
  return /\d/u.test(withoutFields) && /^[\d\s+\-*/().]+$/u.test(withoutFields);
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
  const projectedRows = rows.map((row, rowIndex) => {
    const sourceCells = Array.isArray(row.cells) ? row.cells : [];
    const sourceRowId = row.id || `row-${rowIndex}`;
    const sourceColumns = Math.max(
      Number.isInteger(row.columns) ? row.columns : 0,
      ...sourceCells.map((cell) =>
        (Number.isInteger(cell.column) ? cell.column : 0) +
        (Number.isInteger(cell.colspan) ? cell.colspan : 1)
      ),
      1
    );
    const preserveNestedGeometry =
      sourceCells.some(hasLayoutReference) &&
      sourceCells.every((cell) =>
        hasLayoutReference(cell) ||
        (Array.isArray(cell.references) ? cell.references.length : 0) <= 1
      );
    const sourcePacked = preserveNestedGeometry
      ? projectLayoutGrid(sourceCells, { rows: 1, columns: sourceColumns })
      : packLayoutGrid(sourceCells);
    const segments = splitDetailTableLayoutSegments(sourcePacked.cells, detailTableIds);
    const baseSegmentIndex = Math.max(
      segments.findIndex((segment) => segment.kind === "detailTable"),
      0
    );

    const nodes = segments.map((segment, segmentIndex) => {
      // sourcePacked has already expanded every inline reference into one cell.
      // Preserve one source <tr> as one logical target grid. The table layout
      // caps each native row at its catalog capability and keeps overflow in
      // additional rows of that same grid so row-marker ownership stays intact.
      const packed = preserveNestedGeometry
        ? projectLayoutGrid(segment.cells, { rows: 1, columns: sourceColumns })
        : packLayoutGrid(segment.cells, {
            columns: Math.max(Math.min(segment.cells.length, TABLE_LAYOUT_MAX_COLUMNS), 1)
          });
      const tableLayout = packed.rows > 1 || packed.columns > 4;
      const baseSegment = segmentIndex === baseSegmentIndex;
      const segmentSuffix = segments.length > 1 && !baseSegment
        ? `.segment-${segmentIndex + 1}`
        : "";
      return {
        id: `layout.${sourceRowId}${segmentSuffix}`,
        componentId: tableLayout
          ? TABLE_LAYOUT_COMPONENT_ID
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
          const refType = layoutCellRefType(references, detailTableIds);
          return {
            id: `layout.${cell.id || `${sourceRowId}.cell.${cellIndex}`}`,
            refType,
            refIds: references.map((ref) => ref.referenceId),
            sourceRef: cell.sourceRef,
            ...(tableLayout ? { row: cell.row } : {}),
            column: cell.column,
            colspan: cell.colspan
          };
        })
      };
    });
    return { sourceRowId, nodes };
  });

  const targetNodeIdsBySourceRowId = new Map(
    projectedRows.map(({ sourceRowId, nodes }) => [
      sourceRowId,
      nodes.map((node) => node.id)
    ])
  );
  return projectedRows.flatMap(({ nodes }) =>
    nodes.map((node) => ({
      ...node,
      children: node.children.map((child) => child.refType === "layout"
        ? {
            ...child,
            refIds: child.refIds.flatMap((sourceRowId) =>
              targetNodeIdsBySourceRowId.get(sourceRowId) ||
              [sourceRowId.startsWith("layout.") ? sourceRowId : `layout.${sourceRowId}`]
            )
          }
        : child)
    }))
  );
}

function hasLayoutReference(cell) {
  return Array.isArray(cell?.references) &&
    cell.references.some((reference) => reference?.referenceType === "layout");
}

function layoutCellRefType(references, detailTableIds) {
  if (references.length && references.every((reference) => reference.referenceType === "layout")) {
    return "layout";
  }
  if (references.some((reference) => detailTableIds.has(reference.referenceId))) {
    return "detailTable";
  }
  return "field";
}

function tableLayoutMaxColumns() {
  const maximum = COMPONENTS_BY_ID.get(TABLE_LAYOUT_COMPONENT_ID)
    ?.propsSchema?.properties?.columns?.maximum;
  if (!Number.isInteger(maximum) || maximum <= 4) {
    throw new Error(`${TABLE_LAYOUT_COMPONENT_ID} must declare an integer columns maximum greater than four.`);
  }
  return maximum;
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

function mergeSourceFormRules(left, right) {
  const linkage = [
    ...(Array.isArray(left?.linkage) ? left.linkage : []),
    ...(Array.isArray(right?.linkage) ? right.linkage : [])
  ];
  if (!linkage.length) return left || right || undefined;
  return {
    linkage,
    validations: [
      ...(Array.isArray(left?.validations) ? left.validations : []),
      ...(Array.isArray(right?.validations) ? right.validations : [])
    ],
    impliedRequired: [
      ...(Array.isArray(left?.impliedRequired) ? left.impliedRequired : []),
      ...(Array.isArray(right?.impliedRequired) ? right.impliedRequired : [])
    ],
    review: {
      ...(left?.review || {}),
      ...(right?.review || {})
    }
  };
}

function draftFormRules(sourceFormRules, form) {
  const linkage = Array.isArray(sourceFormRules?.linkage) ? sourceFormRules.linkage : [];
  if (!linkage.length) return undefined;
  const refIndex = buildFormRuleRefIndex(form || {});
  const overlapIssues = mergeRuleIssueMaps(
    baselineDeltaTargetOverlapIssues(linkage, refIndex),
    independentNativeTargetWriterIssues(linkage, refIndex)
  );
  const targetIssues = [];
  const executionIssues = [];
  const classifiedLinkage = linkage.map((rule) => {
    const ruleTargetIssues = [
      ...formRuleTargetIssues(rule, refIndex),
      ...(overlapIssues.get(rule.id) || [])
    ];
    const ruleExecutionIssues = formRuleRunWhenIssues(rule);
    targetIssues.push(...ruleTargetIssues);
    executionIssues.push(...ruleExecutionIssues);
    return draftLinkageRule(rule, refIndex, ruleTargetIssues, ruleExecutionIssues);
  });
  const excludedLinkage = classifiedLinkage.filter(hasRuleIssue);
  const draftedLinkage = mergeEquivalentOrRules(classifiedLinkage.filter((rule) => !hasRuleIssue(rule)));
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
      executionIssues: executionIssues.length ? executionIssues : undefined,
      excludedRules: excludedLinkage.length ? excludedLinkage.map(excludedRuleSummary) : undefined,
      mergedRules: mergedRules.length ? mergedRules : undefined
    })
  };
}

function baselineDeltaTargetOverlapIssues(linkage, refIndex) {
  const groups = new Map();
  for (const rule of linkage) {
    const groupId = rule.meta?.baselineDeltaGroup;
    if (!groupId) continue;
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push(rule);
  }

  const issues = new Map();
  for (const rules of groups.values()) {
    if (rules.length < 2) continue;
    const ownersByTarget = new Map();
    for (const rule of rules) {
      for (const effect of rule.effects || []) {
        const resolved = resolveEffectTarget(refIndex, effect.target);
        for (const target of resolved?.targets || []) {
          const targetKey = [effect.type, target.kind, target.parentId, target.id]
            .filter(Boolean)
            .join(":");
          if (!ownersByTarget.has(targetKey)) ownersByTarget.set(targetKey, []);
          ownersByTarget.get(targetKey).push({ rule, effect, target });
        }
      }
    }

    for (const owners of ownersByTarget.values()) {
      const ruleIds = uniqueStrings(owners.map((owner) => owner.rule.id));
      if (ruleIds.length < 2) continue;
      for (const owner of owners) {
        if (!issues.has(owner.rule.id)) issues.set(owner.rule.id, []);
        const ruleIssues = issues.get(owner.rule.id);
        const duplicateKey = `${owner.effect.type}:${owner.target.kind}:${owner.target.parentId || ""}:${owner.target.id}`;
        if (ruleIssues.some((issue) => issue.duplicateKey === duplicateKey)) continue;
        ruleIssues.push({
          code: "form_rule.baseline_delta_target_overlap",
          ruleId: owner.rule.id,
          target: owner.effect.target,
          resolvedTarget: owner.target.id,
          conflictingRuleIds: ruleIds.filter((ruleId) => ruleId !== owner.rule.id),
          duplicateKey,
          message: "Mutually exclusive baseline-delta branches resolve to the same native target and cannot be evaluated independently."
        });
      }
    }
  }
  return issues;
}

function independentNativeTargetWriterIssues(linkage, refIndex) {
  const ownersByTarget = new Map();
  for (const rule of linkage) {
    const seen = new Set();
    for (const effect of [...(rule.effects || []), ...(rule.else || [])]) {
      const resolved = resolveEffectTarget(refIndex, effect.target);
      for (const target of resolved?.targets || []) {
        const targetKey = [effect.type, target.kind, target.parentId, target.id]
          .filter(Boolean)
          .join(":");
        if (seen.has(targetKey)) continue;
        seen.add(targetKey);
        if (!ownersByTarget.has(targetKey)) ownersByTarget.set(targetKey, []);
        ownersByTarget.get(targetKey).push({ rule, effect, target });
      }
    }
  }

  const issues = new Map();
  for (const owners of ownersByTarget.values()) {
    const ruleIds = uniqueStrings(owners.map((owner) => owner.rule.id));
    if (ruleIds.length < 2) continue;
    const baselineGroups = uniqueStrings(owners.map((owner) => owner.rule.meta?.baselineDeltaGroup));
    if (baselineGroups.length === 1 && owners.every((owner) => owner.rule.meta?.baselineDeltaGroup)) {
      continue;
    }
    for (const owner of owners) {
      if (!issues.has(owner.rule.id)) issues.set(owner.rule.id, []);
      issues.get(owner.rule.id).push({
        code: "form_rule.native_target_writer_conflict",
        ruleId: owner.rule.id,
        target: owner.effect.target,
        resolvedTarget: owner.target.id,
        conflictingRuleIds: ruleIds.filter((ruleId) => ruleId !== owner.rule.id),
        message: "Multiple independently evaluated native rules write the same target dimension; final runtime state depends on rule evaluation order."
      });
    }
  }
  return issues;
}

function mergeRuleIssueMaps(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [ruleId, issues] of map) {
      if (!merged.has(ruleId)) merged.set(ruleId, []);
      merged.get(ruleId).push(...issues);
    }
  }
  return merged;
}

function hasRuleIssue(rule) {
  return (rule.review?.targetIssues || []).length > 0 ||
    (rule.review?.executionIssues || []).length > 0;
}

function excludedRuleSummary(rule) {
  const issues = [
    ...(rule.review?.targetIssues || []),
    ...(rule.review?.executionIssues || [])
  ];
  const targets = uniqueStrings(issues.map((issue) => issue.target));
  return pruneUndefined({
    ruleId: rule.id,
    code: issues[0]?.code,
    source: rule.source,
    target: targets.length === 1 ? targets[0] : undefined,
    targets: targets.length > 1 ? targets : undefined,
    detailTableRefs: uniqueStrings(issues.flatMap((issue) => issue.detailTableRefs || [])),
    sourceJsp: rule.meta?.sourceJsp,
    displayGate: rule.meta?.displayGate,
    runWhen: rule.meta?.runWhen,
    message: issues[0]?.message
  });
}

function mergeEquivalentOrRules(rules) {
  const groups = new Map();
  for (const rule of rules) {
    const cannotFlattenAsOr =
      (rule.logic === "and" && (rule.when || []).length > 1) ||
      Array.isArray(rule.meta?.conditionSemantics);
    const key = JSON.stringify({
      trigger: rule.trigger,
      source: rule.source,
      sourceJsp: rule.meta?.sourceJsp,
      displayGate: rule.meta?.displayGate,
      runWhen: rule.meta?.runWhen,
      effects: rule.effects,
      else: rule.else,
      translationStatus: rule.translationStatus,
      ...(cannotFlattenAsOr ? { mutuallyExclusiveRuleId: rule.id } : {})
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

function draftLinkageRule(rule, refIndex, targetIssues = [], executionIssues = []) {
  const reviewIssues = [...targetIssues, ...executionIssues];
  const translationStatus = reviewIssues.length && (rule.translationStatus || "executable") === "executable"
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
    review: reviewIssues.length ? pruneUndefined({
      targetIssues: targetIssues.length ? targetIssues : undefined,
      executionIssues: executionIssues.length ? executionIssues : undefined
    }) : undefined,
    translationStatus
  });
}

function formRuleTargetIssues(rule, refIndex) {
  const result = [];
  for (const [branch, effects] of [["effects", rule.effects], ["else", rule.else]]) {
    const valuesByResolvedTarget = new Map();
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
      } else {
        for (const target of resolved.targets) {
          const targetKey = [effect.type, target.kind, target.parentId, target.id]
            .filter(Boolean)
            .join(":");
          if (!valuesByResolvedTarget.has(targetKey)) valuesByResolvedTarget.set(targetKey, new Set());
          valuesByResolvedTarget.get(targetKey).add(effect.value);
        }
      }
    }
    for (const [targetKey, values] of valuesByResolvedTarget) {
      if (values.size < 2) continue;
      result.push({
        code: "form_rule.branch_effect_conflict",
        ruleId: rule.id,
        branch,
        resolvedTarget: targetKey,
        values: [...values],
        message: "One native rule branch resolves to conflicting values for the same target dimension."
      });
    }
  }
  return result;
}

function formRuleRunWhenIssues(rule) {
  if (rule?.meta?.runWhen === undefined) return [];
  const inspection = inspectNativeFormRuleProjection(rule);
  if (inspection.ok) return [];
  const capabilityMissing = inspection.issues.includes("native_projection_capability_missing");
  return [{
    code: capabilityMissing
      ? "form_rule.run_when_not_persistable"
      : "form_rule.native_projection_unproven",
    ruleId: rule.id,
    sourceJsp: rule.meta?.sourceJsp,
    displayGate: rule.meta?.displayGate,
    runWhen: rule.meta.runWhen,
    issues: inspection.issues,
    message: capabilityMissing
      ? "A view-gated native form rule requires the versioned formula-condition projection capability."
      : "The native formula-condition projection is not traceable to the matching control onChange input."
  }];
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
        ...(nodeType.type === "manualBranch"
          ? { decisionType: manualBranchDecisionType(node) }
          : {}),
        help: node.help,
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

function manualBranchDecisionType(node) {
  return booleanAttribute(sourceNodeAttributes(node), "decidedBranchOnDraft") === true ? "2" : "1";
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
  if (normalized.includes("manualbranch")) return { type: "manualBranch", element: "exclusiveGateway" };
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
    calculate: "number",
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

function nonNegativeInteger(value) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const number = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
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
