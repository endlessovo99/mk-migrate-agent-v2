import { auditFunctionWhitelist, loadFunctionWhitelist } from "./function-whitelist.js";
import { componentSupportsProp } from "../dsl/catalogs.js";
import { buildScriptBranchProvenance } from "../dsl/script-branch-provenance.js";
import { textValueFieldIds } from "../dsl/script-condition-provenance.js";
import { buildDeterministicScriptBranchProof } from "../dsl/deterministic-script-translations.js";
import {
  analyzeJavaScriptFunctionBodyBindings
} from "../dsl/javascript-binding-provenance.js";
import { resolveScriptControlTarget } from "../dsl/scripts.js";
import {
  analyzeLegacyScriptFormRules,
  provenPlatformValueChangeCallStarts
} from "./sysform-form-rules.js";
import {
  inlineOnChangeSourceActionKey,
  normalizeHelperInjectedSourceActionKey
} from "./source-action-key.js";
import {
  hardHiddenValueChangeCandidates,
  inlineRadioRowEffectCandidates
} from "./inline-radio-row-effects.js";
import {
  detailMainRowLifecycleCandidates
} from "./detail-main-row-lifecycle.js";
import {
  inspectLegacyDetailControlTarget,
  qualifyUniqueLegacyDetailControlTarget
} from "./detail-control-target.js";
import { attrValue, decodeEntities } from "./xml-utils.js";
import {
  attachmentNonEmptyCandidate,
  dependentSelectOptionsCandidates,
  detailRowControlStateCandidate,
  detailRowLifecycleCandidate
} from "./sysform-script-recipes.js";
import { isProvablyInertVariableDeclaration } from "./pure-declarations.js";
import { conditionalTotalCalculationModel } from "./conditional-total-calculation.js";
import { financeDetailGenerationTranslation } from "./finance-detail-generation.js";
import { analyzeLegacyDetailSumHelper } from "./legacy-detail-sum.js";
import { namedValueChangeAssignmentCandidates } from "./named-value-change-assignment.js";
import { localCurrencyHelperCandidates } from "./local-currency-helper.js";
import { dynamicHyperlinkCandidates } from "./dynamic-hyperlink.js";
import { multiRadioRowHelperCandidates } from "./multi-radio-row-helper.js";
import { detailCascadeActionCandidates } from "./detail-cascade-actions.js";
import {
  buildDetailRowControlStateFunction,
  buildDetailRowLifecycleFunction,
  coveredRangesForText,
  detailMatchValue as detailControlMatchValue,
  isCompleteDetailControlDisplay
} from "./detail-row-control-state.js";
import {
  travelReimbursementLifecycleCandidates
} from "./travel-reimbursement-lifecycle.js";
import {
  sameRowRadioSelectionCandidates
} from "./same-row-radio-selection.js";
import {
  composeValueChangeCallbackCandidates,
  directValueChangeCallbackCallRange
} from "./value-change-callbacks.js";
import {
  synchronousOnChangeAlertCandidate,
  synchronousSubmitValidationCandidate
} from "./sysform-submit-validation.js";
import { conditionalFieldResetCandidates } from "./conditional-field-reset.js";

export function extractSysFormJspScripts(template = {}, options = {}) {
  const whitelist = options.functionWhitelist || loadFunctionWhitelist();
  const designerFragments = extractDesignerJspFragments(template.fdDesignerHtml || "");
  const designerScriptSources = designerFragments.flatMap((fragment) => {
    const fragmentSources = scriptSourcesFromFragment(fragment);
    const helperSources = fragmentSources.filter((source) =>
      containsOnlyInertDeclarations(String(source.javascript || "").trim())
    );
    const fragmentLocalFunctionNames = [...localFunctionNamesFromSources(fragmentSources)];
    return fragmentSources.map((source) => {
      const helperJavascript = helperSources
        .filter((helper) => helper.id !== source.id)
        .map((helper) => helper.javascript)
        .filter(Boolean)
        .join("\n\n");
      return pruneUndefined({
        ...source,
        fragmentLocalFunctionNames,
        helperJavascript
      });
    });
  });
  const displayScriptSources = designerScriptSources.length
    ? []
    : extractDisplayJspScripts(template.fdDisplayJsp || "");
  const sources = [...designerScriptSources, ...displayScriptSources].map((source) => {
    const functionAudit = auditFunctionWhitelist(source.javascript, whitelist, {
      path: source.sourceRef,
      localFunctionNames: source.fragmentLocalFunctionNames
    });
    return {
      ...source,
      functionAudit,
      semanticFacts: extractLegacyScriptSemanticFacts(source.javascript, functionAudit)
    };
  });
  const buttons = designerFragments.flatMap((fragment) => extractJspButtons(fragment, sources));

  if (!designerFragments.length && !sources.length && !template.fdDisplayJsp) return undefined;

  return pruneUndefined({
    source: "sysform-jsp",
    displayJsp: template.fdDisplayJsp ? {
      sourceKey: "fdDisplayJsp",
      length: template.fdDisplayJsp.length,
      usedForScripts: designerScriptSources.length === 0 && displayScriptSources.length > 0
    } : undefined,
    fragments: designerFragments,
    buttons,
    sources
  });
}

export function draftMkScriptsFromSourceScripts(sourceScripts = {}, options = {}) {
  const sources = Array.isArray(sourceScripts.sources) ? sourceScripts.sources : [];
  const buttons = Array.isArray(sourceScripts.buttons) ? sourceScripts.buttons : [];
  if (!sources.length && !buttons.length) return undefined;

  const sourceCandidates = sources.flatMap((source, sourceIndex) => {
    const primaryCandidates = eventCandidatesFromSource(source, sourceIndex, {
      ...options,
      sourceScripts
    });
    const selectionCandidates = sameRowRadioSelectionCandidates(
      source,
      options.form
    );
    return composeValueChangeCallbackCandidates(
      source,
      primaryCandidates,
      selectionCandidates
    );
  });
  const hydratedTargetIds = new Set(sourceCandidates
    .filter((candidate) => candidate?.semanticHints?.personPropertyHydration)
    .map((candidate) => candidate.semanticHints.personPropertyHydration.targetFieldId));
  const candidates = dedupeCandidatesByKey([
    ...buttons.map(buttonCandidate),
    ...sourceCandidates,
    ...contextPersonPropertyHydrationCandidates(options.form, hydratedTargetIds),
    ...clampedDetailAggregateCandidates(options.form, sourceScripts)
  ]);
  const actions = [];
  const warnings = [];
  candidates.forEach((candidate, index) => {
    const action = qualifyUniqueLegacyDetailControlTarget(
      canonicalizeLandrayScriptTarget(
        mkActionFromCandidate(candidate, index, options),
        options.form
      ),
      options.form
    );
    const target = scriptTargetWarning(action, options.form);
    if (target) {
      warnings.push(target);
      return;
    }
    actions.push(action);
  });
  return {
    source: sourceScripts.source || "sysform-jsp",
    actions,
    warnings,
    javascript: actions.map((action) => action.function).filter(Boolean).join("\n\n")
  };
}

export function applyStaticScriptProperties(form = {}, scripts = {}) {
  const placeholderValuesByField = new Map();
  const monthPatternsByField = new Map();
  const requiredFieldIds = new Set();
  for (const action of Array.isArray(scripts.actions) ? scripts.actions : []) {
    for (const entry of Array.isArray(action.coverage?.staticProps)
      ? action.coverage.staticProps
      : []) {
      if (
        ["dataPattern", "displayPattern"].includes(entry?.prop) &&
        entry.value === "yyyy-MM"
      ) {
        const patterns = monthPatternsByField.get(entry.fieldId) || new Set();
        patterns.add(entry.prop);
        monthPatternsByField.set(entry.fieldId, patterns);
        continue;
      }
      if (entry?.prop === "required" && entry.value === true) {
        requiredFieldIds.add(entry.fieldId);
        continue;
      }
      if (entry?.prop !== "placeholder" || typeof entry.value !== "string" || !entry.value.trim()) continue;
      const values = placeholderValuesByField.get(entry.fieldId) || new Set();
      values.add(entry.value);
      placeholderValuesByField.set(entry.fieldId, values);
    }
  }
  if (!placeholderValuesByField.size && !monthPatternsByField.size && !requiredFieldIds.size) return form;

  return {
    ...form,
    fields: (form.fields || []).map((field) => {
      const requiredField = requiredFieldIds.has(field.id) &&
        field.type !== "detailTable" &&
        componentSupportsProp(field.componentId, "required")
        ? {
            ...field,
            props: { ...(field.props || {}), required: true }
          }
        : field;
      if (
        monthPatternsByField.get(requiredField.id)?.size === 2 &&
        requiredField.type !== "detailTable" &&
        requiredField.type === "text" &&
        requiredField.componentId === "xform-input"
      ) {
        const dateProps = {};
        for (const prop of ["required", "readOnly", "defaultValue"]) {
          if (requiredField.props?.[prop] !== undefined) dateProps[prop] = requiredField.props[prop];
        }
        return {
          ...requiredField,
          type: "dateTime",
          componentId: "xform-datetime",
          props: {
            ...dateProps,
            dataPattern: "yyyy-MM",
            displayPattern: "yyyy-MM"
          },
          sourceProps: {
            ...(requiredField.sourceProps || {}),
            monthPickerInference: {
              classification: "source",
              dataPattern: "yyyy-MM",
              displayPattern: "yyyy-MM"
            }
          }
        };
      }
      const values = placeholderValuesByField.get(requiredField.id);
      if (
        requiredField.type === "detailTable" ||
        values?.size !== 1 ||
        !componentSupportsProp(requiredField.componentId, "placeholder")
      ) return requiredField;
      return {
        ...requiredField,
        props: {
          ...requiredField.props,
          placeholder: [...values][0]
        }
      };
    })
  };
}

function canonicalizeLandrayScriptTarget(action, form) {
  if (!action || action.scope !== "control" || action.tableId || !/^d_[A-Za-z0-9_]+$/.test(action.controlId || "")) {
    return action;
  }
  if (inspectLegacyDetailControlTarget(form, action.controlId).status !== "not_detail") {
    return action;
  }
  const canonicalId = `f${action.controlId}`;
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const targetExists = fields.some((field) =>
    field?.type !== "detailTable" &&
    [field.id, field.sourceProps?.originalId].includes(canonicalId)
  );
  return targetExists ? { ...action, controlId: canonicalId } : action;
}

export function sourceNumericDetailFieldInferences(sourceScripts = {}, form = {}) {
  const inferences = [];
  for (const source of sourceScripts.sources || []) {
    const text = String(source.javascript || "");
    const grouped = groupedDetailCalculationModel(text, form, sourceScripts);
    if (grouped?.tableId && grouped?.amountFieldId) {
      inferences.push({
        tableId: grouped.tableId,
        fieldId: grouped.amountFieldId,
        sourceRef: source.sourceRef,
        evidence: "Source grouped-detail helper converts the row amount parameter with Number() before arithmetic accumulation."
      });
    }
    const allowance = allowanceCalculationModel(text, sourceScripts);
    if (allowance?.receiptFieldId) {
      const table = uniqueDetailTableForFields(form, [allowance.receiptFieldId]);
      if (table) {
        inferences.push({
          tableId: table.id,
          fieldId: allowance.receiptFieldId,
          sourceRef: source.sourceRef,
          evidence: "Source allowance calculation converts and accumulates this detail receipt value as a numeric amount."
        });
      }
    }
  }
  return dedupeCandidatesByKey(inferences.map((inference) => ({
    ...inference,
    event: "numeric-source-evidence",
    scope: inference.tableId,
    controlId: inference.fieldId
  }))).map(({ event: _event, scope: _scope, controlId: _controlId, ...inference }) => inference);
}

export function groupedDetailTaxCalculationInferences(source = {}, form = {}, sourceScripts = {}) {
  const text = String(source.javascript || "");
  const model = groupedDetailCalculationModel(text, form, sourceScripts);
  if (!model?.taxLexicalScopeProven) return [];
  const sourceField = formFieldBySourceId(form, model.taxSourceFieldId);
  if (sourceField?.type !== "number") return [];
  const expression = groupedDetailTaxFormulaExpression({
    ...model,
    taxSourceFieldId: sourceField.id
  });

  return model.taxTargetFieldIds.flatMap((targetFieldId) => {
    const targetField = formFieldBySourceId(form, targetFieldId);
    if (targetField?.type !== "number") return [];
    const targetRanges = model.taxTargetWrites
      .filter((write) => write.fieldId === targetFieldId)
      .map((write) => ({
        sourceRef: source.sourceRef,
        name: "grouped-detail-tax-target",
        start: write.start,
        end: write.end
      }));
    return [{
      kind: "formula",
      targetFieldId: targetField.id,
      expression,
      displayExpression: expression,
      fieldIds: [sourceField.id],
      sourceRef: source.sourceRef,
      evidence: model.taxFormulaEvidence,
      coveredCalculationRanges: [{
        sourceRef: source.sourceRef,
        name: "grouped-detail-tax-formula",
        start: model.taxFormulaStart,
        end: model.taxFormulaEnd
      }, ...targetRanges],
      runtimeOverride: true,
      residuals: []
    }];
  });
}

function buttonCandidate(button) {
  return {
    id: `${button.id}.onClick`,
    event: "onClick",
    scope: "control",
    controlId: button.id,
    javascript: button.javascript,
    function: button.function,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: `${button.handler} legacy JSP click handler`,
      target: "MK native button typeCfg JavaScript",
      basis: button.translationBasis || "deterministic-detail-row-expansion",
      reviewRequired: false
    }],
    source: {
      sourceRef: button.sourceRef,
      displayGate: button.displayGate,
      functionAudit: { matched: [], violations: [] }
    },
    sourceRefs: button.sourceRefs,
    semanticHints: button.targetDetailTableId ? {
      targetDetailTableId: button.targetDetailTableId,
      coveredCalculationSourceRefs: button.coveredCalculationSourceRefs || [],
      coveredCalculationRanges: button.coveredCalculationRanges || []
    } : undefined
  };
}

function scriptTargetWarning(action, form) {
  if (!form || action.scope !== "control") return undefined;
  if (!action.tableId) {
    const legacyDetailTarget = inspectLegacyDetailControlTarget(
      form,
      action.controlId
    );
    if (legacyDetailTarget.status === "ambiguous") {
      return {
        level: "warning",
        code: "script.control_target_ambiguous",
        message: "JSP control id matches both a detail column and another form control, so the action was not drafted.",
        sourceRefs: action.sourceRefs || [],
        controlId: action.controlId
      };
    }
  }
  const target = resolveScriptControlTarget(form, action);
  if (target.ok || sourceOriginalScriptTargetExists(form, action)) return undefined;
  return {
    level: "warning",
    code: `script.${target.code}`,
    message: "JSP control script target does not exist in the generated form and was not drafted as an executable action.",
    sourceRefs: action.sourceRefs || [],
    controlId: target.controlId,
    tableId: target.tableId
  };
}

function sourceOriginalScriptTargetExists(form, action) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  if (!action.tableId) {
    return fields.some((field) =>
      field?.type !== "detailTable" &&
      [field.id, field.sourceProps?.originalId].includes(action.controlId)
    );
  }
  const table = fields.find((field) =>
    field?.type === "detailTable" &&
    [field.id, field.sourceProps?.originalId].includes(action.tableId)
  );
  return (table?.columns || []).some((column) =>
    [column.id, column.sourceProps?.originalId].includes(action.controlId)
  );
}

function extractLegacyScriptSemanticFacts(javascript = "", functionAudit = {}) {
  const text = String(javascript || "");
  return pruneUndefined({
    legacyFunctionCalls: legacyFunctionCallsFromAudit(functionAudit),
    fieldIds: uniqueStrings([...text.matchAll(/\bfd_[A-Za-z0-9_]+\b/g)].map((match) => match[0])),
    rowMarkers: rowMarkersFromLegacyScript(text),
    eventBindings: eventBindingsFromLegacyScript(text)
  });
}

function legacyFunctionCallsFromAudit(functionAudit = {}) {
  return [...(functionAudit.matched || []), ...(functionAudit.violations || [])]
    .map((item) => {
      const occurrences = Array.isArray(item.occurrences) ? item.occurrences : [];
      return pruneUndefined({
        name: item.name,
        intent: item.intent,
        translationKind: item.translationKind,
        safety: item.safety,
        targetApis: item.targetApis,
        occurrenceCount: occurrences.length,
        firstIndex: occurrences[0]?.index,
        firstSnippet: occurrences[0]?.snippet
      });
    });
}

function rowMarkersFromLegacyScript(text = "") {
  const markers = [];
  const pattern = /common_dom_row_set_show_required_reset\(\s*(["'])([^"']+)\1\s*,\s*(true|false)\s*,\s*(true|false)\s*,\s*(true|false)\s*\)/g;
  for (const match of String(text || "").matchAll(pattern)) {
    markers.push({
      rowId: match[2],
      visible: match[3] === "true",
      required: match[4] === "true",
      reset: match[5] === "true",
      index: match.index,
      evidence: oneLine(match[0])
    });
  }
  return markers;
}

function eventBindingsFromLegacyScript(text = "") {
  const bindings = [];
  const valueChange = /AttachXFormValueChangeEventById\(\s*(["'])([^"']+)\1\s*,/g;
  for (const match of String(text || "").matchAll(valueChange)) {
    bindings.push({
      legacyApi: "AttachXFormValueChangeEventById",
      event: "onChange",
      controlId: match[2],
      index: match.index,
      evidence: oneLine(String(text || "").slice(match.index, Math.min(String(text || "").length, match.index + 180)))
    });
  }

  const load = /Com_AddEventListener\(\s*window\s*,\s*(["'])load\1/g;
  for (const match of String(text || "").matchAll(load)) {
    bindings.push({
      legacyApi: "Com_AddEventListener",
      event: "onLoad",
      index: match.index,
      evidence: oneLine(String(text || "").slice(match.index, Math.min(String(text || "").length, match.index + 180)))
    });
  }
  return bindings;
}

function extractDesignerJspFragments(html = "") {
  const decoded = html.includes("<") ? String(html) : decodeEntities(html);
  const fragments = [];
  for (const element of htmlElements(decoded)) {
    if (!/\bfd_type\s*=\s*(["'])jsp\1/i.test(element.attrs)) continue;
    const attrs = element.attrs;
    const id = attrValue(attrs, "id") || `jsp-${fragments.length + 1}`;
    const rawContent = hiddenInputValue(element.content);
    const content = decodeDeep(rawContent);
    fragments.push(pruneUndefined({
      id,
      sourceRef: `source.form.jsp.${id}`,
      sourceKey: "fdDesignerHtml",
      sourceType: "designer-jsp",
      length: content.length,
      contentPreview: compactPreview(content),
      content
    }));
  }

  return fragments;
}

// fdDesignerHtml is decoded before it reaches this parser. A JSP control can
// therefore contain HTML-looking text inside an <input value="..."> attribute.
// Regex matching cannot distinguish that text from real nested elements and
// used to stop at the button's </div> instead of the JSP control's </DIV>.
function htmlElements(html = "") {
  const elements = [];
  let cursor = 0;
  while (cursor < html.length) {
    const opening = nextHtmlTag(html, cursor);
    if (!opening) break;
    cursor = opening.end;
    if (opening.closing || opening.selfClosing) continue;
    if (!/\bfd_type\s*=\s*(["'])jsp\1/i.test(opening.attrs)) continue;

    let depth = 1;
    let nestedCursor = opening.end;
    while (depth > 0) {
      const tag = nextHtmlTag(html, nestedCursor);
      if (!tag) break;
      nestedCursor = tag.end;
      if (tag.name.toLowerCase() !== opening.name.toLowerCase() || tag.selfClosing) continue;
      depth += tag.closing ? -1 : 1;
      if (depth === 0) {
        elements.push({
          name: opening.name,
          attrs: opening.attrs,
          content: html.slice(opening.end, tag.start)
        });
      }
    }
  }
  return elements;
}

function nextHtmlTag(html, from) {
  let start = html.indexOf("<", from);
  while (start >= 0) {
    if (/^<!--[\s\S]*?-->/.test(html.slice(start))) {
      const commentEnd = html.indexOf("-->", start + 4);
      if (commentEnd < 0) return undefined;
      start = html.indexOf("<", commentEnd + 3);
      continue;
    }
    const head = html.slice(start).match(/^<\s*(\/?)\s*([A-Za-z][\w:-]*)\b/);
    if (!head) {
      start = html.indexOf("<", start + 1);
      continue;
    }
    let quote;
    let end = start + head[0].length;
    for (; end < html.length; end += 1) {
      const ch = html[end];
      if (quote) {
        if (ch === quote) quote = undefined;
      } else if (ch === "\"" || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        const raw = html.slice(start, end + 1);
        return {
          start,
          end: end + 1,
          name: head[2],
          attrs: raw.slice(head[0].length, -1),
          closing: Boolean(head[1]),
          selfClosing: /\/\s*>$/.test(raw)
        };
      }
    }
    return undefined;
  }
  return undefined;
}

function scriptSourcesFromFragment(fragment) {
  return extractScriptBlocks(fragment.content).map((script, index) => ({
    id: `${fragment.id}.script.${index + 1}`,
    sourceRef: `${fragment.sourceRef}.script.${index + 1}`,
    sourceKey: fragment.sourceKey,
    sourceType: fragment.sourceType,
    fragmentId: fragment.id,
    ...script
  }));
}

function localFunctionNamesFromSources(sources = []) {
  const names = new Set();
  for (const source of sources) {
    for (const match of String(source.javascript || "").matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      names.add(match[1]);
    }
    for (const match of String(source.javascript || "").matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*function\b/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

function extractJspButtons(fragment, sources) {
  const buttons = [];
  const pattern = /<(button|div)\b([^>]*\bonclick\s*=\s*(["'])\s*([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\3[^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of fragment.content.matchAll(pattern)) {
    const handler = match[4];
    const title = cleanHtmlText(match[5]);
    const source = sources.find((candidate) =>
      new RegExp(`\\bfunction\\s+${escapeRegExp(handler)}\\s*\\(`).test(candidate.javascript)
    );
    const translation = source
      ? detailExpansionTranslation(source.javascript, handler) || financeDetailGenerationTranslation({ handler, sources })
      : undefined;
    if (!title || !translation) continue;
    buttons.push({
      id: fragment.id,
      sourceRef: `${fragment.sourceRef}.button.1`,
      title,
      handler,
      displayGate: displayGateAt(fragment.content, match.index),
      javascript: source.javascript,
      function: translation.function,
      translationBasis: translation.translationBasis,
      sourceRefs: translation.sourceRefs,
      coveredCalculationSourceRefs: translation.coveredCalculationSourceRefs,
      coveredCalculationRanges: translation.coveredCalculationRanges,
      sourceDetailTableId: translation.sourceDetailTableId,
      targetDetailTableId: translation.targetDetailTableId
    });
  }
  return buttons;
}

function detailExpansionTranslation(javascript, handler) {
  if (!new RegExp(`\\bfunction\\s+${escapeRegExp(handler)}\\s*\\(`).test(javascript)) return undefined;
  const sourceVariable = javascript.match(/_DocList_FormFieldValue\(\s*([A-Za-z_$][\w$]*)\s*,\s*(["'])(fd_[\w]+)\2\s*\)/);
  const quantity = javascript.match(/_DocList_FormFieldValue\(\s*([A-Za-z_$][\w$]*)\s*,\s*(["'])(fd_quantity[\w]*)\2\s*\)/);
  const addRows = javascript.match(/_DocList_AddRows\(\s*([A-Za-z_$][\w$]*)\s*,/);
  const partTypes = javascript.match(/\bpartTypes\s*=\s*\[([^\]]+)\]/);
  const assignments = [...javascript.matchAll(/this\[buildDetailTableFieldId\(\s*([A-Za-z_$][\w$]*)\s*,\s*(["'])(fd_[\w]+)\2\s*\)\]\s*=\s*([A-Za-z_$][\w$]*)/g)];
  if (!sourceVariable || !quantity || !addRows || !partTypes || assignments.length < 3) return undefined;
  const variables = Object.fromEntries([...javascript.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(fd_[\w]+)\2/g)]
    .map((match) => [match[1], match[3]]));
  const sourceDetailTableId = variables[sourceVariable[1]];
  const targetDetailTableId = variables[addRows[1]];
  if (!sourceDetailTableId || !targetDetailTableId || sourceVariable[1] !== quantity[1]) return undefined;
  const values = [...partTypes[1].matchAll(/(["'])([^"']+)\1/g)].map((match) => match[2]);
  if (!values.length) return undefined;
  const targetByParam = Object.fromEntries(assignments.map((match) => [match[4], match[3]]));
  const modelTarget = targetByParam.fd_model_desc;
  const quantityTarget = targetByParam.fd_quantity;
  const partTarget = targetByParam.fd_part_type;
  if (!modelTarget || !quantityTarget || !partTarget) return undefined;
  const partTarget2 = assignments.find((match) => match[4] === "fd_part_type" && match[3] !== partTarget)?.[3];
  const rowAssignments = [
    `      row.${modelTarget} = sourceRow.${sourceVariable[3]};`,
    `      row.${quantityTarget} = sourceRow.${quantity[3]};`,
    `      row.${partTarget} = partTypes[j];`,
    ...(partTarget2 ? [`      row.${partTarget2} = partTypes[j];`] : [])
  ];
  return {
    sourceDetailTableId,
    targetDetailTableId,
    function: [
      "function onClick() {",
      "  var formValues = MKXFORM.getFormValues() || {};",
      `  var sourceTable = formValues['\${table:${sourceDetailTableId}}'] || {};`,
      "  var sourceRows = Array.isArray(sourceTable) ? sourceTable : (sourceTable.values || []);",
      `  var partTypes = ${JSON.stringify(values)};`,
      `  MKXFORM.deleteRow('\${table:${targetDetailTableId}}');`,
      "  for (var i = 0; i < sourceRows.length; i += 1) {",
      "    var sourceRow = sourceRows[i] || {};",
      "    for (var j = 0; j < partTypes.length; j += 1) {",
      "      var row = {};",
      ...rowAssignments,
      `      MKXFORM.addRow('\${table:${targetDetailTableId}}', row);`,
      "    }",
      "  }",
      "}"
    ].join("\n")
  };
}

function displayGateAt(content, index) {
  const before = content.slice(0, index);
  const editOpen = before.lastIndexOf("<xform:editShow");
  const editClose = before.lastIndexOf("</xform:editShow");
  if (editOpen > editClose) return "xform:editShow";
  const viewOpen = before.lastIndexOf("<xform:viewShow");
  const viewClose = before.lastIndexOf("</xform:viewShow");
  return viewOpen > viewClose ? "xform:viewShow" : undefined;
}

function cleanHtmlText(value) {
  return decodeDeep(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function extractDisplayJspScripts(jsp = "") {
  return extractScriptBlocks(decodeDeep(jsp)).map((script, index) => ({
    id: `fdDisplayJsp.script.${index + 1}`,
    sourceRef: `source.form.jsp.fdDisplayJsp.script.${index + 1}`,
    sourceKey: "fdDisplayJsp",
    sourceType: "display-jsp",
    ...script
  }));
}

function extractScriptBlocks(text = "") {
  const decoded = decodeDeep(text);
  const displayGates = [];
  const scripts = [];
  const tokenPattern = /<\/?xform:(editShow|viewShow)\b[^>]*>|<script\b[^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of decoded.matchAll(tokenPattern)) {
    if (match[2] !== undefined) {
      const javascript = decodeDeep(match[2]).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
      if (!javascript) continue;
      scripts.push(pruneUndefined({
        javascript,
        displayGate: displayGates.at(-1)
      }));
      continue;
    }

    const displayGate = normalizeDisplayGate(match[1]);
    if (/^<\//.test(match[0])) {
      const index = displayGates.lastIndexOf(displayGate);
      if (index >= 0) displayGates.splice(index, 1);
    } else {
      displayGates.push(displayGate);
    }
  }

  return scripts;
}

function normalizeDisplayGate(value = "") {
  return String(value).toLowerCase() === "viewshow" ? "xform:viewShow" : "xform:editShow";
}

function hiddenInputValue(html = "") {
  const match = html.match(/<input\b[\s\S]*?\bvalue\s*=\s*(["'])([\s\S]*?)\1[\s\S]*?>/i);
  return match ? match[2] : "";
}

function mkActionFromCandidate(candidate, index, options = {}) {
  const functionName = candidate.event;
  const sourceActionKey = normalizeHelperInjectedSourceActionKey(
    candidate.sourceActionKey,
    candidate.source
  );
  const coveredLegacyFunctions = new Set(candidate.semanticHints?.coveredLegacyFunctions || []);
  const functionMappings = candidate.functionMappings || functionMappingsFromAudit(candidate.source.functionAudit);
  let coverage = scriptCoverageForExecutableFormRules(candidate.coverage || scriptCoverageFromSource({
    javascript: candidate.javascript,
    sourceRef: candidate.source.sourceRef,
    sourceActionKey,
    displayGate: candidate.source.displayGate,
    form: options.form
  }), options.formRules, options.form);
  const nativeCalculations = nativeCalculationCoverageForCandidate(candidate, options.form);
  const nativeDisplayFields = nativeDisplayCoverageForCandidate(candidate, options.form);
  if (
    (nativeCalculations.length > 0 || nativeDisplayFields.length > 0) &&
    coverage?.status === "none" &&
    Array.isArray(coverage.residuals) &&
    coverage.residuals.length === 0
  ) {
    coverage = {
      ...coverage,
      status: "covered",
      ...(nativeCalculations.length ? { nativeCalculations } : {}),
      ...(nativeDisplayFields.length ? { nativeDisplayFields } : {})
    };
  }
  if (
    candidate.translationStatus === "mapped" &&
    candidate.coverage?.status === "translated" &&
    coverage?.status === "covered"
  ) {
    coverage = { ...coverage, status: "translated" };
  }
  const nativeCovered = coverage?.status === "covered" &&
    Array.isArray(coverage.nativeRules) && coverage.nativeRules.length > 0 &&
    Array.isArray(coverage.residuals) && coverage.residuals.length === 0;
  let translationStatus = candidate.translationStatus || (nativeCovered ? "omitted" : "needs_review");
  let effectiveMappings = candidate.functionMappings || (nativeCovered ? [{
    source: "legacy JSP row visibility/required behavior",
    target: "native formRules.linkage",
    basis: "native-form-rule",
    reviewRequired: false
  }] : functionMappings);
  let fn = translationStatus === "omitted"
    ? ""
    : candidate.function || buildMkFunction(candidate, effectiveMappings, candidate.source.functionAudit?.violations || []);
  const sourceRefs = uniqueStrings([candidate.source.sourceRef, ...(candidate.sourceRefs || [])]);
  const predeclaredLegacyNoop = candidate.translationStatus === "omitted" &&
    Array.isArray(candidate.functionMappings) &&
    candidate.functionMappings.length > 0 &&
    candidate.functionMappings.every((mapping) => mapping?.basis === "legacy-runtime-noop");
  const provisionalDeterministicProof = buildDeterministicScriptBranchProof({
    event: candidate.event,
    scope: candidate.scope,
    controlId: candidate.controlId,
    tableId: candidate.tableId,
    sourceRefs,
    sourceActionKey,
    function: fn,
    translationStatus,
    coverage,
    functionMappings: effectiveMappings,
    semanticHints: candidate.semanticHints
  });
  const requiresBranchProvenance = ["onChange", "onLoad"].includes(candidate.event) &&
    !provisionalDeterministicProof &&
    !predeclaredLegacyNoop;
  const analyzedBranchProvenance = requiresBranchProvenance
      ? buildScriptBranchProvenance({
          event: candidate.event,
          source: candidate.branchSource || candidate.javascript,
          sourceRef: candidate.source.sourceRef,
          sourceActionKey,
          eventFunctionName: candidate.branchFunctionName,
          eventFunctionStart: candidate.branchFunctionStart,
          textFieldIds: textValueFieldIds(options.form),
          programIsEntrypoint: candidate.branchProgramIsEntrypoint
        })
    : undefined;

  const deterministicBranchProof = buildDeterministicScriptBranchProof({
    event: candidate.event,
    scope: candidate.scope,
    controlId: candidate.controlId,
    tableId: candidate.tableId,
    sourceRefs,
    sourceActionKey,
    function: fn,
    translationStatus,
    coverage,
    functionMappings: effectiveMappings,
    semanticHints: candidate.semanticHints
  });
  // Keep analyzed unproven evidence on legacy-runtime-noop omits. Schema allows
  // omitted+unproven with that basis; stripping bp breaks sourceActionKey actions.
  const branchProvenance = analyzedBranchProvenance;

  return pruneUndefined({
    id: stableActionId(candidate.id || `${candidate.event}.${index + 1}`),
    name: functionName,
    event: candidate.event,
    scope: candidate.scope,
    controlId: candidate.controlId,
    tableId: candidate.tableId,
    runWhen: candidate.runWhen || runWhenFromDisplayGate(candidate.source.displayGate),
    function: fn,
    sourceRefs,
    sourceActionKey,
    branchProvenance,
    deterministicBranchProof,
    translationStatus,
    coverage,
    functionMappings: effectiveMappings,
    recipe: candidate.recipe,
    semanticHints: candidate.semanticHints,
    unmappedFunctions: (candidate.source.functionAudit?.violations || [])
      .map((violation) => violation.name)
      .filter((name) => !coveredLegacyFunctions.has(name))
  });
}

function nativeCalculationCoverageForCandidate(candidate, form = {}) {
  if (
    candidate?.translationStatus === "mapped" ||
    candidate?.event !== "onChange" ||
    candidate?.scope !== "control" ||
    !candidate?.controlId
  ) return [];

  const table = (form?.fields || []).find((field) =>
    field?.type === "detailTable" &&
    (field.id === candidate.tableId ||
      (!candidate.tableId && (field.columns || []).some((column) => column?.id === candidate.controlId)))
  );
  if (!(table?.columns || []).some((column) => column?.id === candidate.controlId)) {
    return [];
  }

  const sourceRefs = new Set(uniqueStrings([
    candidate?.source?.sourceRef,
    ...(candidate?.sourceRefs || [])
  ]));
  if (!sourceRefs.size) return [];

  return uniqueStrings(
    (form?.fields || [])
      .filter((field) => (
        field?.type !== "detailTable" &&
        field?.props?.calculation &&
        sourceRefs.has(field?.sourceProps?.inferredCalculation?.sourceRef)
      ))
      .map((field) => field.id)
  );
}

function nativeDisplayCoverageForCandidate(candidate, form = {}) {
  if (
    candidate?.event !== "onChange" ||
    candidate?.scope !== "control" ||
    !candidate?.controlId ||
    !nativeCalculationCoverageForCandidate(candidate, form).length ||
    !/\bpayeeDiffTip\s*\(/u.test(String(candidate?.source?.javascript || ""))
  ) return [];

  const label = (form?.fields || []).find((field) => field?.id === "fd_jsp_payee_diff_tip");
  return label?.componentId === "xform-description" ? [label.id] : [];
}

function scriptCoverageForExecutableFormRules(coverage, formRules) {
  const nativeRules = Array.isArray(coverage?.nativeRules) ? coverage.nativeRules : [];
  if (!nativeRules.length) return coverage;

  const rulesByEvidenceId = new Map();
  for (const rule of Array.isArray(formRules?.linkage) ? formRules.linkage : []) {
    for (const evidenceId of uniqueStrings([rule.id, ...(rule.meta?.sourceRuleIds || [])])) {
      rulesByEvidenceId.set(evidenceId, rule);
    }
  }

  const executableNativeRules = [];
  const reviewNativeRules = [];
  for (const evidenceId of nativeRules) {
    const rule = rulesByEvidenceId.get(evidenceId) || migratedBridgeLoadRule(evidenceId, formRules?.linkage);
    if (rule?.translationStatus === "executable") {
      executableNativeRules.push(rule.id);
    } else {
      reviewNativeRules.push(rule?.id || evidenceId);
    }
  }
  const canonicalExecutableRules = uniqueStrings(executableNativeRules);
  const canonicalReviewRules = uniqueStrings(reviewNativeRules);
  const sourceResiduals = Array.isArray(coverage.residuals) ? coverage.residuals : [];
  if (!canonicalReviewRules.length && !sourceResiduals.length) {
    return {
      ...coverage,
      status: canonicalExecutableRules.length ? "covered" : coverage.status,
      residuals: [],
      nativeRules: canonicalExecutableRules
    };
  }

  const residuals = [
    ...sourceResiduals,
    ...canonicalReviewRules.map((ruleId) => scriptResidual({
      code: "script.residual.form_rule_needs_review",
      type: "formRuleNeedsReview",
      message: `Native form rule ${ruleId} still needs review and cannot be counted as executable script coverage.`,
      evidence: ruleId
    }))
  ];

  return {
    ...coverage,
    status: residuals.length ? (canonicalExecutableRules.length ? "partial" : "uncovered") : (canonicalExecutableRules.length ? "covered" : "none"),
    nativeRules: canonicalExecutableRules,
    residuals
  };
}

function migratedBridgeLoadRule(evidenceId, rules = []) {
  const match = String(evidenceId || "").match(/^linkage\.fd_[^.]+\.(?:eq|contains)\.([^.]+)$/);
  if (!match) return undefined;
  const value = match[1];
  return rules.find((rule) =>
    rule?.translationStatus === "executable" &&
    rule?.trigger === "load" &&
    String(rule.id || "").endsWith(`.${value}.load`)
  );
}

function scriptResidual(input) {
  return pruneUndefined({
    code: input.code,
    type: input.type,
    message: input.message,
    target: input.target,
    trigger: input.trigger,
    callback: input.callback,
    evidence: input.evidence
  });
}

function scriptCoverageFromSource(source) {
  const staticProps = source.displayGate
    ? []
    : staticPropertyCoverage(source.javascript, source.form);
  if (staticProps.length) {
    return {
      status: "covered",
      nativeRules: [],
      staticProps,
      residuals: []
    };
  }

  const analysis = analyzeLegacyScriptFormRules(source);
  const nativeEligible = source.displayGate !== "xform:viewShow";
  const gatedRules = nativeEligible ? [] : analysis.linkage;
  const nativeRules = nativeEligible ? analysis.linkage.map((rule) => rule.id) : [];
  const residuals = [
    ...analysis.residuals,
    ...gatedRules.map((rule) => ({
      code: "script.residual.gated_native_form_rule",
      type: "gatedNativeFormRule",
      message: `Native form rule ${rule.id} is not emitted because ${source.displayGate} behavior must remain view-status gated.`,
      sourceRef: source.sourceRef,
      evidence: rule.id
    }))
  ];
  return {
    status: residuals.length ? (nativeRules.length ? "partial" : "uncovered") : (nativeRules.length ? "covered" : "none"),
    nativeRules,
    residuals
  };
}

function staticPropertyCoverage(javascript, form) {
  const load = String(javascript || "").match(
    /^\s*Com_AddEventListener\(\s*window\s*,\s*(["'])load\1\s*,\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\}\s*\)\s*;?\s*$/
  );
  if (!load) return [];

  const required = load[2].match(
    /^\s*\$\(\s*(["'])\[name=(["'])extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)\2\]\1\s*\)\s*\.attr\(\s*(["'])validate\4\s*,\s*(["'])required\5\s*\)\s*;?\s*$/
  );
  if (required) {
    const fieldId = required[3];
    const field = findOrdinaryField(form, fieldId);
    return field?.props?.required === true
      ? [{ fieldId, prop: "required", value: true }]
      : [];
  }

  const placeholder = load[2].match(
    /^\s*var\s+([A-Za-z_$][\w$]*)\s*=\s*GetXFormFieldById\(\s*(["'])(fd_[A-Za-z0-9_]+)\2\s*\)\s*\[\s*0\s*\]\s*;?\s*if\s*\(\s*\1\s*\)\s*\{\s*\1\.setAttribute\(\s*(["'])placeholder\4\s*,\s*(["'])([^"'\\]*)\5\s*\)\s*;?\s*\}\s*;?\s*$/
  );
  if (!placeholder) return [];

  const fieldId = placeholder[3];
  const field = findOrdinaryField(form, fieldId);
  if (!field || !componentSupportsProp(field.componentId, "placeholder")) return [];

  return [{
    fieldId,
    prop: "placeholder",
    value: placeholder[6]
  }];
}

function findOrdinaryField(form, fieldId) {
  return (Array.isArray(form?.fields) ? form.fields : [])
    .find((candidate) => candidate?.id === fieldId && candidate?.type !== "detailTable");
}

function runWhenFromDisplayGate(displayGate) {
  if (displayGate === "xform:editShow") return { viewStatusIn: ["add", "edit"] };
  if (displayGate === "xform:viewShow") return { viewStatusIn: ["view"] };
  return undefined;
}

function eventCandidatesFromSource(source, sourceIndex, options = {}) {
  if (!hasExecutableJavascript(source.javascript)) return [];
  const personPropertyHydration = legacyPersonPropertyHydrationCandidates(
    source,
    options.form
  );
  if (personPropertyHydration.length) {
    return personPropertyHydration.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }
  const travelReimbursementLifecycle = travelReimbursementLifecycleCandidates(
    source,
    options
  );
  if (travelReimbursementLifecycle.length) {
    return travelReimbursementLifecycle.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }
  const sourceWithHelpers = source.helperJavascript
    ? { ...source, javascript: `${source.helperJavascript}\n\n${source.javascript}` }
    : source;

  const staticFieldDisabled = staticFieldDisabledCandidate(source, options.form);
  if (staticFieldDisabled) {
    return [{
      ...staticFieldDisabled,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.1`,
      source
    }];
  }

  const monthPicker = staticMonthPickerCandidate(source, options.form);
  if (monthPicker) {
    return [{
      ...monthPicker,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.1`,
      source
    }];
  }

  // Prefer the source-backed view row translation over the generic legacy
  // window-load fallback.  The latter cannot retain the condition's exact
  // row-marker semantics and would leave a deterministic source relation
  // unnecessarily review-required.
  const viewRowMarker = simpleViewRowMarkerCandidate(sourceWithHelpers, options.form);
  if (viewRowMarker.length) {
    return viewRowMarker.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source: sourceWithHelpers
    }));
  }

  const detailCascadeActions = detailCascadeActionCandidates(
    source,
    options.form,
    options.sourceScripts
  );
  if (detailCascadeActions.length) {
    return detailCascadeActions.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }

  const conditionalTotalCalculations = conditionalTotalUppercaseCandidates(
    source,
    options.form,
    options.sourceScripts
  );
  if (conditionalTotalCalculations.length) {
    return conditionalTotalCalculations.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }

  const chinaValueRuntime = chinaValueRuntimeCandidates(source, options.form);
  if (chinaValueRuntime.length) {
    return chinaValueRuntime.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }

  const localCurrencyHelpers = localCurrencyHelperCandidates(source, options.form);
  if (localCurrencyHelpers.length) {
    return localCurrencyHelpers.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }

  const multiRadioRowHelpers = multiRadioRowHelperCandidates(
    source,
    options.form,
    options.sourceScripts
  );
  if (multiRadioRowHelpers.length) {
    return multiRadioRowHelpers.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }

  const procurementPaymentScripts = procurementPaymentScriptCandidates(sourceWithHelpers, options.form);
  if (procurementPaymentScripts.length) {
    return procurementPaymentScripts.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source: sourceWithHelpers
    }));
  }

  const inlineRadioRowEffects = inlineRadioRowEffectCandidates(
    source,
    options.form,
    options.formRules
  );
  if (inlineRadioRowEffects.length) {
    return inlineRadioRowEffects.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }

  const conditionalFieldResets = conditionalFieldResetCandidates(
    source,
    options.form
  );
  if (conditionalFieldResets.length) {
    return conditionalFieldResets.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }

  const hardHiddenValueChanges = hardHiddenValueChangeCandidates(
    source,
    options.form,
    options.formRules
  );

  const detailMainRowLifecycle = detailMainRowLifecycleCandidates(
    source,
    options.form,
    options.sourceScripts
  );
  if (detailMainRowLifecycle.length) {
    return detailMainRowLifecycle.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }

  const dynamicHyperlinks = dynamicHyperlinkCandidates(source, options.form);
  if (dynamicHyperlinks.length) {
    return dynamicHyperlinks.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }

  const calculationAssignments = [
    ...simpleCalculationAssignmentCandidates(source, options.form),
    ...namedValueChangeAssignmentCandidates(source, options.form)
  ];
  if (calculationAssignments.length) {
    return calculationAssignments.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }

  const detailThresholdCalculations = detailThresholdCalculationCandidates(source, options.form);
  if (detailThresholdCalculations.length) {
    return detailThresholdCalculations.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }

  const detailLookupCalculations = detailLookupCalculationCandidates(source, options.form);
  if (detailLookupCalculations.length) {
    return detailLookupCalculations.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }

  const groupedDetailCalculations = groupedDetailCalculationCandidates(
    source,
    options.form,
    options.sourceScripts
  );
  if (groupedDetailCalculations.length) {
    return groupedDetailCalculations.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }

  const personTextCalculations = personTextCalculationCandidates(
    source,
    options.form,
    options.sourceScripts
  );
  if (personTextCalculations.length) {
    return personTextCalculations.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }

  const allowanceCalculations = allowanceCalculationCandidates(source, options.form, options.sourceScripts);
  if (allowanceCalculations.length) {
    return allowanceCalculations.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source
    }));
  }

  const synchronousSubmitValidation = synchronousSubmitValidationCandidate(
    sourceWithHelpers,
    options.form
  );
  if (synchronousSubmitValidation) {
    return [{
      ...synchronousSubmitValidation,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.1`,
      source: sourceWithHelpers
    }];
  }

  const synchronousOnChangeAlert = synchronousOnChangeAlertCandidate(
    sourceWithHelpers,
    options.form
  );
  if (synchronousOnChangeAlert) {
    return [{
      ...synchronousOnChangeAlert,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.1`,
      source: sourceWithHelpers
    }];
  }

  const dependentSelectOptions = dependentSelectOptionsCandidates(sourceWithHelpers, options.form);
  if (dependentSelectOptions.length) {
    return dependentSelectOptions.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source: sourceWithHelpers
    }));
  }

  const attachmentValidation = attachmentNonEmptyCandidate(sourceWithHelpers, options.form);
  if (attachmentValidation) {
    return [{
      ...attachmentValidation,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.1`,
      source: sourceWithHelpers
    }];
  }

  const legacyHelperDefinitions = legacyHelperDefinitionsCandidate(source);
  if (legacyHelperDefinitions) {
    return [{
      ...legacyHelperDefinitions,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.1`,
      source
    }];
  }

  const qualityFastReport = qualityFastReportRowVisibilityCandidates(sourceWithHelpers);
  if (qualityFastReport.length) {
    return qualityFastReport.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source: sourceWithHelpers
    }));
  }

  const legacyAttachmentRuntime = legacyAttachmentRuntimeCandidate(sourceWithHelpers, options.form);
  if (legacyAttachmentRuntime) {
    return [{
      ...legacyAttachmentRuntime,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.1`,
      source: sourceWithHelpers
    }];
  }

  const legacyDetailRuntime = legacyDetailRuntimeCandidate(sourceWithHelpers, options.form);
  if (legacyDetailRuntime) {
    return [{
      ...legacyDetailRuntime,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.1`,
      source: sourceWithHelpers
    }];
  }

  const legacyRequiredToggles = legacyRequiredToggleCandidates(sourceWithHelpers, options.form);
  if (legacyRequiredToggles.length) {
    return legacyRequiredToggles.map((candidate, index) => ({
      ...candidate,
      id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
      source: sourceWithHelpers
    }));
  }

  const directSemanticCandidates = [
    simpleViewRowMarkerCandidate(sourceWithHelpers, options.form),
    payeeDiffDisplayCandidate(sourceWithHelpers, options.form)
  ].flat().filter(Boolean);
  const directSemanticKeys = new Set(directSemanticCandidates.map((candidate) =>
    `${candidate.index}:${candidate.event}:${candidate.scope}:${candidate.tableId || ""}:${candidate.controlId || ""}`
  ));
  const hardHiddenValueChangeKeys = new Set(hardHiddenValueChanges.map(candidateKey));
  const candidates = [
    ...directSemanticCandidates,
    ...hardHiddenValueChanges,
    ...extractValueChangeCandidates(sourceWithHelpers, options)
      .filter((candidate) =>
        !directSemanticKeys.has(candidateKey(candidate)) &&
        !hardHiddenValueChangeKeys.has(candidateKey(candidate))
      ),
    ...extractDetailControlDisplayCandidates(sourceWithHelpers)
      .filter((candidate) => !directSemanticKeys.has(candidateKey(candidate))),
    ...extractWindowLoadCandidates(sourceWithHelpers, options)
      .filter((candidate) => !directSemanticKeys.has(candidateKey(candidate))),
    ...extractSubmitQueueCandidates(sourceWithHelpers, "submit", "onBeforeSubmit"),
    ...extractSubmitQueueCandidates(sourceWithHelpers, "afterSubmit", "onAfterSubmit")
  ].sort((left, right) => left.index - right.index);

  const events = candidates.length ? candidates : [fallbackCandidate(sourceWithHelpers)];
  return events.map((candidate, index) => ({
    ...candidate,
    id: `${source.id || `script.${sourceIndex + 1}`}.event.${index + 1}`,
    source: sourceWithHelpers
  }));
}

function simpleCalculationAssignmentCandidates(source, form) {
  const text = String(source.javascript || "");
  const candidates = [];
  const platformCallStarts = provenPlatformValueChangeCallStarts(text);
  const bindingPattern = /AttachXFormValueChangeEventById\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*,\s*function\s*\(([^)]*)\)\s*\{/g;

  for (const match of text.matchAll(bindingPattern)) {
    if (!platformCallStarts.has(match.index)) continue;
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findBalancedClose(text, bodyStart - 1, "{", "}");
    if (bodyEnd < bodyStart) continue;
    const body = stripComments(text.slice(bodyStart, bodyEnd)).trim();
    const assignment = body.match(
      /^SetXFormFieldValueById\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*,\s*([\s\S]+)\)\s*;?$/
    );
    if (!assignment) continue;

    const triggerId = match[2];
    const targetId = assignment[2];
    const expression = assignment[3].trim();
    if (!mainField(form, triggerId) || !mainField(form, targetId)) continue;
    if (!isSafeSynchronousCalculationExpression(expression, match[3])) continue;

    candidates.push({
      index: match.index,
      sourceActionKey: inlineOnChangeSourceActionKey(source.sourceRef || source.id, match.index),
      event: "onChange",
      scope: "control",
      controlId: triggerId,
      javascript: text.slice(match.index, findCallEnd(text, bodyEnd + 1)).trim(),
      function: [
        "function onChange(value, rowNum, parentRowNum) {",
        `  MKXFORM.setValue(${JSON.stringify(targetId)}, ${expression})`,
        "}"
      ].join("\n"),
      translationStatus: "mapped",
      coverage: { status: "translated", nativeRules: [], residuals: [] },
      functionMappings: [{
        source: "AttachXFormValueChangeEventById + SetXFormFieldValueById arithmetic assignment",
        target: "control onChange + MKXFORM.setValue",
        basis: "deterministic-calculation-assignment",
        reviewRequired: false
      }]
    });
  }

  return candidates;
}

function chinaValueRuntimeCandidates(source, form) {
  const text = String(source.javascript || "").trim();
  if (!/^Com_IncludeFile\(\s*(["'])chinaValue_script\.js\1\s*,\s*(["'])\.\.\/sys\/xform\/designer\/chinaValue\/\2\s*\)\s*;?$/u.test(text)) {
    return [];
  }

  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const ordinaryById = new Map(
    fields
      .filter((field) => field?.type !== "detailTable" && field?.dataOnly !== true)
      .map((field) => [field.id, field])
  );
  const bindings = fields.flatMap((target) => {
    if (
      target?.type === "detailTable" ||
      String(target?.sourceProps?.designerType || "").toLowerCase() !== "chinavalue"
    ) return [];
    const sourceId = String(
      target.sourceProps?.designerValues?.relatedid ||
      target.sourceProps?.metadataAttributes?.relatedid ||
      ""
    ).trim();
    const amount = ordinaryById.get(sourceId);
    if (!sourceId || !amount || amount.type !== "number" || target.type !== "text") return [];
    return [{ sourceId, targetId: target.id }];
  });
  if (!bindings.length) return [];

  return bindings.flatMap(({ sourceId, targetId }, bindingIndex) => [
    chinaValueRuntimeCandidate({
      index: bindingIndex * 2,
      event: "onChange",
      scope: "control",
      controlId: sourceId,
      javascript: text,
      function: chinaValueRuntimeFunction("onChange", sourceId, targetId)
    }, sourceId, targetId, source.sourceRef),
    chinaValueRuntimeCandidate({
      index: bindingIndex * 2 + 1,
      event: "onLoad",
      scope: "global",
      javascript: text,
      function: chinaValueRuntimeFunction("onLoad", sourceId, targetId)
    }, sourceId, targetId, source.sourceRef)
  ]);
}

function chinaValueRuntimeCandidate(candidate, sourceId, targetId, sourceRef) {
  return {
    ...candidate,
    semanticHints: {
      coveredCalculationRanges: [{
        sourceRef,
        name: `china-value-runtime:${sourceId}:${targetId}`,
        start: 0,
        end: candidate.javascript.length
      }]
    },
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: `chinaValue_script.js runtime binding ${targetId}.relatedid=${sourceId}`,
      target: "control onChange/onLoad + MKXFORM synchronous uppercase currency conversion",
      basis: "deterministic-china-value-runtime",
      reviewRequired: false
    }]
  };
}

function chinaValueRuntimeFunction(event, sourceId, targetId) {
  const signature = event === "onLoad"
    ? "function onLoad() {"
    : "function onChange(value, rowNum, parentRowNum) {";
  return [
    signature,
    `  var amountRaw = MKXFORM.getValue(${JSON.stringify(sourceId)})`,
    "  var amount = Number(Array.isArray(amountRaw) ? amountRaw[0] : amountRaw || 0)",
    "  var cnDigits = [\"零\",\"壹\",\"贰\",\"叁\",\"肆\",\"伍\",\"陆\",\"柒\",\"捌\",\"玖\"]",
    "  var cnRadices = [\"\",\"拾\",\"佰\",\"仟\"]",
    "  var cnUnits = [\"\",\"万\",\"亿\",\"兆\"]",
    "  var cnDecimals = [\"角\",\"分\"]",
    "  var negative = amount < 0",
    "  var absolute = Math.abs(amount)",
    "  var chineseAmount = \"\"",
    "  if (!isFinite(absolute) || absolute >= 1000000000000000) {",
    "    chineseAmount = \"\"",
    "  } else if (absolute === 0) {",
    "    chineseAmount = \"零元整\"",
    "  } else {",
    "    var parts = absolute.toFixed(2).split(\".\")",
    "    var integerText = parts[0]",
    "    var decimalText = parts[1]",
    "    var zeroCount = 0",
    "    for (var digitIndex = 0; digitIndex < integerText.length; digitIndex += 1) {",
    "      var digit = Number(integerText.substring(digitIndex, digitIndex + 1))",
    "      var position = integerText.length - digitIndex - 1",
    "      var groupIndex = Math.floor(position / 4)",
    "      var radixIndex = position % 4",
    "      if (digit === 0) {",
    "        zeroCount += 1",
    "      } else {",
    "        if (zeroCount > 0) chineseAmount += cnDigits[0]",
    "        zeroCount = 0",
    "        chineseAmount += cnDigits[digit] + cnRadices[radixIndex]",
    "      }",
    "      if (radixIndex === 0 && zeroCount < 4) chineseAmount += cnUnits[groupIndex]",
    "    }",
    "    if (integerText === \"0\") chineseAmount = cnDigits[0]",
    "    chineseAmount += \"元\"",
    "    var decimalWritten = false",
    "    for (var decimalIndex = 0; decimalIndex < 2; decimalIndex += 1) {",
    "      var decimalDigit = Number(decimalText.substring(decimalIndex, decimalIndex + 1))",
    "      if (decimalDigit !== 0) {",
    "        if (decimalIndex === 1 && Number(decimalText.substring(0, 1)) === 0) chineseAmount += cnDigits[0]",
    "        chineseAmount += cnDigits[decimalDigit] + cnDecimals[decimalIndex]",
    "        decimalWritten = true",
    "      }",
    "    }",
    "    if (!decimalWritten) chineseAmount += \"整\"",
    "    if (negative) chineseAmount = \"负\" + chineseAmount",
    "  }",
    `  MKXFORM.setValue(${JSON.stringify(targetId)}, chineseAmount)`,
    "}"
  ].join("\n");
}

function conditionalTotalUppercaseCandidates(source, form, sourceScripts = {}) {
  const model = conditionalTotalCalculationModel(source, sourceScripts);
  if (!model) return [];
  const mainFieldIds = new Set(
    (form?.fields || [])
      .filter((field) => field?.type !== "detailTable" && field?.dataOnly !== true)
      .flatMap((field) => [field.id, field.sourceProps?.originalId].filter(Boolean))
  );
  const dependencies = uniqueStrings([
    model.modeFieldId,
    ...model.sourceFieldIds,
    model.totalTargetFieldId
  ]);
  if (!mainFieldIds.has(model.uppercaseTargetFieldId) || dependencies.some((fieldId) => !mainFieldIds.has(fieldId))) {
    return [];
  }
  const candidates = dependencies.map((controlId, index) => conditionalTotalUppercaseCandidate({
    index,
    event: "onChange",
    scope: "control",
    controlId,
    javascript: `${model.functionName} recalculates uppercase currency after ${controlId} changes`,
    function: conditionalTotalUppercaseFunction("onChange", model)
  }, model));
  candidates.push(conditionalTotalUppercaseCandidate({
    index: dependencies.length + 1,
    event: "onLoad",
    scope: "global",
    javascript: `${model.functionName} initializes uppercase currency in edit mode`,
    function: conditionalTotalUppercaseFunction("onLoad", model)
  }, model));
  candidates.push(conditionalTotalUppercaseCandidate({
    index: dependencies.length + 2,
    event: "onBeforeSubmit",
    scope: "global",
    javascript: `${model.functionName} recalculates uppercase currency before draft/save/submit`,
    function: conditionalTotalUppercaseFunction("onBeforeSubmit", model)
  }, model));
  const coveredCalculationRanges = model.coveredCalculationRanges;
  return candidates.map((candidate) => ({
    ...candidate,
    semanticHints: { ...(candidate.semanticHints || {}), coveredCalculationRanges }
  }));
}

function conditionalTotalUppercaseCandidate(candidate, model) {
  const manualResiduals = model.externalCalls.map((name) => ({
    code: "calculation.dependent_call_unmapped",
    reason: `The source conditional-total function also invokes ${name}(); that dependent behavior requires its own evidenced translation recipe.`
  }));
  return {
    ...candidate,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "source travel-scope total branch, fixed-two rounding, and XForm_GetChinaValue conversion",
      target: "native conditional calculation + MKXFORM synchronous uppercase currency conversion",
      basis: "deterministic-conditional-total-uppercase",
      reviewRequired: manualResiduals.length > 0,
      ...(manualResiduals.length ? { manualResiduals } : {})
    }]
  };
}

function conditionalTotalUppercaseFunction(event, model) {
  const signature = event === "onBeforeSubmit"
    ? "function onBeforeSubmit(context) {"
    : event === "onLoad" ? "function onLoad() {" : "function onChange(value, rowNum, parentRowNum) {";
  return [
    signature,
    ...(event === "onBeforeSubmit" ? ["  var isDraft = context && context.isDraft"] : []),
    `  var modeRaw = MKXFORM.getValue(${JSON.stringify(model.modeFieldId)})`,
    "  var mode = Number(Array.isArray(modeRaw) ? modeRaw[0] : modeRaw || 0)",
    ...model.sourceFieldIds.map((fieldId, index) =>
      `  var amountPart${index + 1} = Number(MKXFORM.getValue(${JSON.stringify(fieldId)}) || 0)`
    ),
    `  var total = mode == ${model.modeValue} ? ${sumAmountParts(model.trueFieldIds, model)} : ${sumAmountParts(model.falseFieldIds, model)}`,
    "  total = Math.round(total * 100) / 100",
    "  var cnDigits = [\"零\",\"壹\",\"贰\",\"叁\",\"肆\",\"伍\",\"陆\",\"柒\",\"捌\",\"玖\"]",
    "  var cnRadices = [\"\",\"拾\",\"佰\",\"仟\"]",
    "  var cnUnits = [\"\",\"万\",\"亿\",\"兆\"]",
    "  var cnDecimals = [\"角\",\"分\"]",
    "  var negative = total < 0",
    "  var absolute = Math.abs(total)",
    "  var chineseAmount = \"\"",
    "  if (!isFinite(absolute) || absolute >= 1000000000000000) {",
    "    chineseAmount = \"\"",
    "  } else if (absolute === 0) {",
    "    chineseAmount = \"零元整\"",
    "  } else {",
    "    var parts = absolute.toFixed(2).split(\".\")",
    "    var integerText = parts[0]",
    "    var decimalText = parts[1]",
    "    var zeroCount = 0",
    "    for (var digitIndex = 0; digitIndex < integerText.length; digitIndex += 1) {",
    "      var digit = Number(integerText.substring(digitIndex, digitIndex + 1))",
    "      var position = integerText.length - digitIndex - 1",
    "      var groupIndex = Math.floor(position / 4)",
    "      var radixIndex = position % 4",
    "      if (digit === 0) {",
    "        zeroCount += 1",
    "      } else {",
    "        if (zeroCount > 0) chineseAmount += cnDigits[0]",
    "        zeroCount = 0",
    "        chineseAmount += cnDigits[digit] + cnRadices[radixIndex]",
    "      }",
    "      if (radixIndex === 0 && zeroCount < 4) chineseAmount += cnUnits[groupIndex]",
    "    }",
    "    if (integerText === \"0\") chineseAmount = cnDigits[0]",
    "    chineseAmount += \"元\"",
    "    var decimalWritten = false",
    "    for (var decimalIndex = 0; decimalIndex < 2; decimalIndex += 1) {",
    "      var decimalDigit = Number(decimalText.substring(decimalIndex, decimalIndex + 1))",
    "      if (decimalDigit !== 0) {",
    "        if (decimalIndex === 1 && Number(decimalText.substring(0, 1)) === 0) chineseAmount += cnDigits[0]",
    "        chineseAmount += cnDigits[decimalDigit] + cnDecimals[decimalIndex]",
    "        decimalWritten = true",
    "      }",
    "    }",
    "    if (!decimalWritten) chineseAmount += \"整\"",
    "    if (negative) chineseAmount = \"负\" + chineseAmount",
    "  }",
    `  MKXFORM.setValue(${JSON.stringify(model.uppercaseTargetFieldId)}, chineseAmount)`,
    ...(event === "onBeforeSubmit" ? ["  if (isDraft) return true", "  return true"] : []),
    "}"
  ].join("\n");
}

function sumAmountParts(fieldIds, model) {
  return fieldIds
    .map((fieldId) => `amountPart${model.sourceFieldIds.indexOf(fieldId) + 1}`)
    .join(" + ");
}

function mainField(form, fieldId) {
  return (Array.isArray(form?.fields) ? form.fields : [])
    .find((field) => field?.id === fieldId && field.type !== "detailTable" && field.dataOnly !== true);
}

function fieldById(form, fieldId) {
  return (Array.isArray(form?.fields) ? form.fields : [])
    .find((field) => field?.id === fieldId);
}

function isSafeSynchronousCalculationExpression(expression, params = "") {
  const source = String(expression || "").trim();
  if (!source || /[;{}\[\]`]/u.test(source)) return false;
  if (/\b(?:async|await|new|this|window|document|fetch|XMLHttpRequest|Promise|eval|Function)\b/u.test(source)) {
    return false;
  }
  if (/\.(?!round\b|max\b|min\b|abs\b|floor\b|ceil\b|pow\b)/u.test(source)) return false;

  const allowed = new Set([
    "value",
    "rowNum",
    "parentRowNum",
    "Number",
    "Math",
    "round",
    "max",
    "min",
    "abs",
    "floor",
    "ceil",
    "pow",
    "true",
    "false",
    "null",
    "undefined",
    ...String(params || "").split(",").map((param) => param.trim()).filter(Boolean)
  ]);
  const identifiers = source.match(/[A-Za-z_$][\w$]*/gu) || [];
  return identifiers.every((identifier) => allowed.has(identifier));
}

function stripComments(text) {
  return String(text || "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\r\n]*/gu, "");
}

function detailThresholdCalculationCandidates(source, form) {
  const text = String(source.javascript || "");
  const candidates = [];
  const coveredFunctionNames = new Set();
  const functionPattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gu;

  for (const functionMatch of text.matchAll(functionPattern)) {
    const open = functionMatch.index + functionMatch[0].length - 1;
    const close = findBalancedClose(text, open, "{", "}");
    if (close <= open) continue;
    const body = text.slice(open + 1, close);
    const sameRowFields = new Map(
      [...body.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*GetXFormSameRowFieldById\([^,]+,\s*(["'])(fd_[A-Za-z0-9_]+)\2\s*\)\s*\[0\]/gu)]
        .map((match) => [match[1], match[3]])
    );
    if (sameRowFields.size < 2) continue;

    const valueRead = [...body.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/gu)]
      .map((match) => ({
        valueVariable: match[1],
        expression: match[2],
        rowVariable: [...sameRowFields.keys()].find((name) =>
          new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "u").test(match[2])
        )
      }))
      .find((entry) => entry.rowVariable && /(?:\.name\b|\.value\b|\.val\s*\()/u.test(entry.expression));
    if (!valueRead) continue;
    const sourceFieldId = sameRowFields.get(valueRead.rowVariable);
    if (!sourceFieldId) continue;

    const assignment = body.match(new RegExp(
      `([^;\\n]+)\\b${valueRead.valueVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*>\\s*(-?(?:\\d+\\.?\\d*|\\.\\d+))\\s*\\?\\s*(-?(?:\\d+\\.?\\d*|\\.\\d+))\\s*:\\s*(-?(?:\\d+\\.?\\d*|\\.\\d+))[^;\\n]*`,
      "u"
    ));
    if (!assignment) continue;
    const targetVariable = [...sameRowFields.keys()].find((name) =>
      name !== valueRead.rowVariable &&
      new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "u").test(assignment[0])
    );
    const targetFieldId = sameRowFields.get(targetVariable);
    if (!targetFieldId) continue;

    const bindings = valueChangeBindingsCalling(text, functionMatch[1]);
    for (const binding of bindings) {
      const table = uniqueDetailTableForFields(form, [binding.controlId, sourceFieldId, targetFieldId]);
      if (!table) continue;
      const threshold = Number(assignment[2]);
      const whenTrue = Number(assignment[3]);
      const whenFalse = Number(assignment[4]);
      candidates.push({
        index: binding.index,
        event: "onChange",
        scope: "control",
        tableId: table.id,
        controlId: binding.controlId,
        javascript: binding.javascript,
        function: [
          "function onChange(value, rowNum, parentRowNum) {",
          `  var operand = Number(MKXFORM.getValue(${JSON.stringify(`\${table:${table.id}}.${sourceFieldId}`)}, { detailRowIndex: rowNum }) || 0)`,
          `  MKXFORM.updateControl(${JSON.stringify(`\${table:${table.id}}.${targetFieldId}`)}, rowNum, operand > ${threshold} ? ${whenTrue} : ${whenFalse})`,
          "}"
        ].join("\n"),
        translationStatus: "mapped",
        coverage: { status: "translated", nativeRules: [], residuals: [] },
        functionMappings: [{
          source: "same-row numeric threshold calculation",
          target: "detail onChange + MKXFORM.getValue + MKXFORM.updateControl",
          basis: "deterministic-detail-threshold-calculation",
          reviewRequired: false
        }]
      });
      coveredFunctionNames.add(functionMatch[1]);
    }
  }
  const coveredCalculationRanges = coveredFunctionRanges(
    text,
    source.sourceRef,
    [...coveredFunctionNames]
  );
  return dedupeCandidatesByKey(candidates).map((candidate) => ({
    ...candidate,
    semanticHints: { ...(candidate.semanticHints || {}), coveredCalculationRanges }
  }));
}

function valueChangeBindingsCalling(text, functionName) {
  const bindings = [];
  const platformCallStarts = provenPlatformValueChangeCallStarts(text);
  const pattern = /AttachXFormValueChangeEventById\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*,\s*function\s*\([^)]*\)\s*\{/gu;
  for (const match of text.matchAll(pattern)) {
    if (!platformCallStarts.has(match.index)) continue;
    const open = match.index + match[0].length - 1;
    const close = findBalancedClose(text, open, "{", "}");
    if (close <= open) continue;
    const body = text.slice(open + 1, close);
    if (!new RegExp(`\\b${functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`, "u").test(body)) continue;
    bindings.push({
      index: match.index,
      controlId: match[2],
      javascript: text.slice(match.index, findCallEnd(text, close + 1)).trim()
    });
  }
  return bindings;
}

function uniqueDetailTableForFields(form, fieldIds) {
  const matches = (form?.fields || []).filter((field) => {
    if (field?.type !== "detailTable") return false;
    const columnIds = new Set((field.columns || []).map((column) => column.id));
    return fieldIds.every((fieldId) => columnIds.has(fieldId));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function detailLookupCalculationCandidates(source, form) {
  const text = String(source.javascript || "");
  const candidates = [];
  const coveredFunctionNames = new Set();
  const functionPattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gu;

  for (const functionMatch of text.matchAll(functionPattern)) {
    const open = functionMatch.index + functionMatch[0].length - 1;
    const close = findBalancedClose(text, open, "{", "}");
    if (close <= open) continue;
    const body = text.slice(open + 1, close);
    const mapDeclaration = body.match(/var\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Map\s*\(\s*\)/u);
    const dateFieldId = body.match(/getFormFieldValue\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*\)/u)?.[2];
    const cutoff = body.match(/new\s+Date\(\s*(["'])(\d{4}-\d{2}-\d{2}[^"']*)\1\s*\)/u)?.[2];
    const flag = body.match(/var\s+([A-Za-z_$][\w$]*)\s*=\s*true\s*;/u)?.[1];
    if (!mapDeclaration || !dateFieldId || !cutoff || !flag) continue;
    if (!new RegExp(`\\b${escapePattern(flag)}\\s*=\\s*false\\s*;`, "u").test(body)) continue;

    const priceMaps = conditionalMapBranches(body, flag, mapDeclaration[1]);
    if (!priceMaps || !Object.keys(priceMaps.whenTrue).length || !Object.keys(priceMaps.whenFalse).length) continue;
    const sameRowFields = new Map(
      [...body.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*GetXFormSameRowFieldById\([^,]+,\s*(["'])(fd_[A-Za-z0-9_]+)\2\s*\)\s*\[0\]/gu)]
        .map((match) => [match[1], match[3]])
    );
    if (sameRowFields.size < 4) continue;

    const baseLookup = body.match(new RegExp(
      `var\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapePattern(mapDeclaration[1])}\\.get\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)`,
      "u"
    ));
    if (!baseLookup) continue;
    const baseValueVariable = baseLookup[1];
    const addressValueVariable = baseLookup[2];
    const declarations = new Map(
      [...body.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/gu)].map((match) => [match[1], match[2]])
    );
    const addressRowVariable = rowVariableInExpression(declarations.get(addressValueVariable), sameRowFields);
    const addressFieldId = sameRowFields.get(addressRowVariable);
    const incentive = body.match(new RegExp(
      `var\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*\\(\\s*Number\\(\\s*${escapePattern(baseValueVariable)}\\s*\\)\\s*-\\s*Number\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)\\s*\\)\\s*\\*\\s*(-?(?:\\d+\\.?\\d*|\\.\\d+))`,
      "u"
    ));
    if (!incentive || !addressFieldId) continue;
    const incentiveVariable = incentive[1];
    const priceValueVariable = incentive[2];
    const rate = Number(incentive[3]);
    const priceRowVariable = rowVariableInExpression(declarations.get(priceValueVariable), sameRowFields);
    const priceFieldId = sameRowFields.get(priceRowVariable);
    const baseTargetVariable = rowVariableAssignedValue(body, baseValueVariable, sameRowFields);
    const incentiveTargetVariable = rowVariableAssignedValue(body, incentiveVariable, sameRowFields);
    const baseFieldId = sameRowFields.get(baseTargetVariable);
    const incentiveFieldId = sameRowFields.get(incentiveTargetVariable);
    if (!priceFieldId || !baseFieldId || !incentiveFieldId) continue;

    const bindings = valueChangeBindingsCalling(text, functionMatch[1]);
    for (const binding of bindings) {
      const table = uniqueDetailTableForFields(form, [
        binding.controlId,
        addressFieldId,
        priceFieldId,
        baseFieldId,
        incentiveFieldId
      ]);
      if (!table) continue;
      const detailRef = (fieldId) => JSON.stringify(`\${table:${table.id}}.${fieldId}`);
      candidates.push({
        index: binding.index,
        event: "onChange",
        scope: "control",
        tableId: table.id,
        controlId: binding.controlId,
        javascript: binding.javascript,
        function: [
          "function onChange(value, rowNum, parentRowNum) {",
          `  var sourceDate = MKXFORM.getValue(${JSON.stringify(dateFieldId)})`,
          `  var useCurrentRates = !sourceDate || !(new Date(sourceDate) < new Date(${JSON.stringify(cutoff)}))`,
          `  var currentRates = ${JSON.stringify(priceMaps.whenTrue)}`,
          `  var previousRates = ${JSON.stringify(priceMaps.whenFalse)}`,
          "  var rates = useCurrentRates ? currentRates : previousRates",
          `  var rawAddress = MKXFORM.getValue(${detailRef(addressFieldId)}, { detailRowIndex: rowNum })`,
          "  var address = Array.isArray(rawAddress) ? rawAddress[0] : rawAddress",
          `  var price = Number(MKXFORM.getValue(${detailRef(priceFieldId)}, { detailRowIndex: rowNum }) || 0)`,
          "  var basePrice = rates[address]",
          "  if (address && basePrice > 0 && price > 0) {",
          `    MKXFORM.updateControl(${detailRef(baseFieldId)}, rowNum, basePrice)`,
          `    MKXFORM.updateControl(${detailRef(incentiveFieldId)}, rowNum, ((Number(basePrice) - Number(price)) * ${rate}).toFixed(0))`,
          "  } else {",
          `    MKXFORM.updateControl(${detailRef(baseFieldId)}, rowNum, "")`,
          `    MKXFORM.updateControl(${detailRef(incentiveFieldId)}, rowNum, "0")`,
          "  }",
          "}"
        ].join("\n"),
        translationStatus: "mapped",
        coverage: { status: "translated", nativeRules: [], residuals: [] },
        functionMappings: [{
          source: "date-versioned same-row lookup and incentive formula",
          target: "detail onChange + MKXFORM.getValue + MKXFORM.updateControl",
          basis: "deterministic-detail-lookup-calculation",
          reviewRequired: false
        }]
      });
      coveredFunctionNames.add(functionMatch[1]);
    }
  }
  const coveredCalculationRanges = coveredFunctionRanges(text, source.sourceRef, [...coveredFunctionNames]);
  return dedupeCandidatesByKey(candidates).map((candidate) => ({
    ...candidate,
    semanticHints: { ...(candidate.semanticHints || {}), coveredCalculationRanges }
  }));
}

function conditionalMapBranches(body, flag, mapVariable) {
  const branchPattern = new RegExp(`\\bif\\s*\\(\\s*${escapePattern(flag)}\\s*\\)\\s*\\{`, "u");
  const branch = branchPattern.exec(body);
  if (!branch) return undefined;
  const trueOpen = branch.index + branch[0].length - 1;
  const trueClose = findBalancedClose(body, trueOpen, "{", "}");
  if (trueClose <= trueOpen) return undefined;
  const afterTrue = body.slice(trueClose + 1).match(/^\s*else\s*\{/u);
  if (!afterTrue) return undefined;
  const falseOpen = trueClose + 1 + afterTrue[0].length - 1;
  const falseClose = findBalancedClose(body, falseOpen, "{", "}");
  if (falseClose <= falseOpen) return undefined;
  return {
    whenTrue: mapEntries(body.slice(trueOpen + 1, trueClose), mapVariable),
    whenFalse: mapEntries(body.slice(falseOpen + 1, falseClose), mapVariable)
  };
}

function mapEntries(text, mapVariable) {
  const entries = {};
  const pattern = new RegExp(
    `\\b${escapePattern(mapVariable)}\\.set\\(\\s*(["'])([^"']+)\\1\\s*,\\s*(-?(?:\\d+\\.?\\d*|\\.\\d+))\\s*\\)`,
    "gu"
  );
  for (const match of text.matchAll(pattern)) entries[match[2]] = Number(match[3]);
  return entries;
}

function rowVariableInExpression(expression, sameRowFields) {
  const text = String(expression || "");
  return [...sameRowFields.keys()].find((name) =>
    new RegExp(`\\b${escapePattern(name)}\\b`, "u").test(text)
  );
}

function rowVariableAssignedValue(body, valueVariable, sameRowFields) {
  const statement = body.split(";").find((part) =>
    new RegExp(`\\b${escapePattern(valueVariable)}\\b`, "u").test(part) &&
    /(?:\.val\s*\(|\.value\s*=)/u.test(part)
  );
  return rowVariableInExpression(statement, sameRowFields);
}

function escapePattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function groupedDetailCalculationCandidates(source, form, sourceScripts = {}) {
  const text = String(source.javascript || "");
  const model = groupedDetailCalculationModel(text, form, sourceScripts);
  if (!model) return [];
  const candidates = [];
  const dependencies = new Set([model.toolFieldId, model.amountFieldId, model.taxiFieldId]);
  const outputFieldIds = new Set([
    ...model.categories.map((category) => category.targetFieldId),
    model.trafficTotalFieldId,
    model.domesticTotalFieldId,
    model.countFieldId,
    ...model.taxTargetFieldIds
  ]);

  for (const binding of inlineValueChangeBindings(text)) {
    if (!dependencies.has(binding.controlId) || outputFieldIds.has(binding.controlId)) continue;
    const callbackCall = directValueChangeCallbackCallRange(
      source,
      binding.index,
      model.calculationFunctionName
    );
    if (!callbackCall) continue;
    const detail = binding.controlId === model.toolFieldId || binding.controlId === model.amountFieldId;
    candidates.push(groupedDetailCalculationCandidate({
      index: binding.index,
      effectIndex: callbackCall.start,
      sourceActionKey: inlineOnChangeSourceActionKey(
        source.sourceRef || source.id,
        binding.index
      ),
      event: "onChange",
      scope: "control",
      controlId: binding.controlId,
      ...(detail ? { tableId: model.tableId } : {}),
      javascript: binding.javascript,
      function: groupedDetailCalculationFunction("onChange", model),
      semanticHints: {
        coveredCallbackStatementRanges: [{
          sourceRef: source.sourceRef || source.id,
          start: callbackCall.start,
          end: callbackCall.end
        }]
      }
    }));
  }

  if (!candidates.some((candidate) => candidate.controlId === model.modeFieldId)) {
    candidates.push(groupedDetailCalculationCandidate({
      index: 0,
      event: "onChange",
      scope: "control",
      controlId: model.modeFieldId,
      javascript: `cross-source mode change recalculates grouped detail totals for ${model.modeFieldId}`,
      function: groupedDetailCalculationFunction("onChange", model)
    }));
  }
  candidates.push(groupedDetailCalculationCandidate({
    index: text.length,
    event: "onAfterDel",
    scope: "control",
    controlId: model.tableId,
    tableId: model.tableId,
    javascript: "recalculate grouped detail totals after native detail-row deletion",
    function: groupedDetailCalculationFunction("onAfterDel", model)
  }));
  candidates.push(groupedDetailCalculationCandidate({
    index: text.length + 1,
    event: "onLoad",
    scope: "global",
    javascript: "initialize source grouped detail calculations in edit mode",
    function: groupedDetailCalculationFunction("onLoad", model)
  }));
  candidates.push(groupedDetailCalculationCandidate({
    index: text.length + 2,
    event: "onBeforeSubmit",
    scope: "global",
    javascript: "recalculate grouped detail totals before draft/save/submit",
    function: groupedDetailCalculationFunction("onBeforeSubmit", model)
  }));
  const coveredCalculationRanges = coveredFunctionRanges(
    text,
    source.sourceRef,
    model.coveredFunctionNames
  );
  return dedupeCandidatesByKey(candidates).map((candidate) => {
    const callbackRanges = candidate.semanticHints?.coveredCallbackStatementRanges || [];
    return {
      ...candidate,
      semanticHints: {
        ...(candidate.semanticHints || {}),
        coveredCalculationRanges: [
          ...coveredCalculationRanges,
          ...callbackRanges.map((range) => ({
            sourceRef: range.sourceRef,
            name: `onChange:${candidate.controlId}:${model.calculationFunctionName}`,
            start: range.start,
            end: range.end
          }))
        ]
      }
    };
  });
}

function groupedDetailCalculationModel(text, form, sourceScripts) {
  const functions = namedSourceFunctions(text);
  const helper = functions.find((candidate) => {
    const branches = groupedCategoryBranches(candidate.body);
    return branches.length >= 2 && /\.val\(\s*[A-Za-z_$][\w$]*\s*\)/u.test(candidate.body);
  });
  if (!helper) return undefined;
  const branches = groupedCategoryBranches(helper.body);
  const discriminator = branches[0]?.discriminator;
  if (!discriminator || branches.some((branch) => branch.discriminator !== discriminator)) return undefined;

  const selected = selectedFieldVariables(text);
  const tableVariables = new Map(
    [...text.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(fd_[A-Za-z0-9_]+)\2\s*;/gu)]
      .map((match) => [match[1], match[3]])
  );
  const callPattern = new RegExp(
    `\\b${escapePattern(helper.name)}\\(\\s*([A-Za-z_$][\\w$]*)\\s*,\\s*(["'])(fd_[A-Za-z0-9_]+)\\2\\s*,\\s*([A-Za-z_$][\\w$]*)\\s*,\\s*(["'])([^"']+)\\5\\s*\\)`,
    "gu"
  );
  const calls = [...text.matchAll(callPattern)].map((match) => {
    const statementStart = Math.max(text.lastIndexOf(";", match.index), text.lastIndexOf("{", match.index));
    const prefix = stripComments(text.slice(statementStart + 1, match.index));
    const assignments = [...prefix.matchAll(/\b([A-Za-z_$][\w$]*)\s*=/gu)];
    return {
      index: match.index,
      tableVariable: match[1],
      amountFieldId: match[3],
      targetVariable: match[4],
      discriminatorValue: match[6],
      groupVariable: assignments.at(-1)?.[1]
    };
  });
  if (calls.length < 2) return undefined;
  const tableId = tableVariables.get(calls[0].tableVariable);
  const amountFieldId = calls[0].amountFieldId;
  if (!tableId || calls.some((call) =>
    tableVariables.get(call.tableVariable) !== tableId || call.amountFieldId !== amountFieldId
  )) return undefined;

  const fullTotal = text.match(
    /([A-Za-z_$][\w$]*)\.val\(\s*theFixedNumTwo\(\s*([A-Za-z_$][\w$]*)\s*\+\s*([A-Za-z_$][\w$]*)\s*\)\s*\)/u
  );
  const domesticTotal = [...text.matchAll(
    /([A-Za-z_$][\w$]*)\.val\(\s*([A-Za-z_$][\w$]*)\.toFixed\(/gu
  )].find((match) => match[2] === fullTotal?.[3]);
  if (!fullTotal || !domesticTotal) return undefined;
  const calculationFunction = functions.find((fn) => fn.body.includes(fullTotal[0]));
  if (!calculationFunction) return undefined;
  const trafficTotalFieldId = selected.get(fullTotal[1]);
  const fullOnlyGroupVariable = fullTotal[2];
  const domesticGroupVariable = fullTotal[3];
  const domesticTotalFieldId = selected.get(domesticTotal[1]);
  if (!trafficTotalFieldId || !domesticTotalFieldId || domesticTotal[2] !== domesticGroupVariable) {
    return undefined;
  }

  const taxi = text.match(new RegExp(
    `\\b${escapePattern(domesticGroupVariable)}\\s*=\\s*theFixedNumTwo\\(\\s*${escapePattern(domesticGroupVariable)}\\s*\\+\\s*Number\\(\\s*([A-Za-z_$][\\w$]*)\\.val\\(\\)\\s*\\)\\s*\\)`,
    "u"
  ));
  const taxiFieldId = selected.get(taxi?.[1]);
  const modeFieldId = legacyModeSourceFieldId(sourceScripts, "theCityFlag");
  if (!taxiFieldId || !modeFieldId) return undefined;

  const countAssignment = helper.body.match(
    /SetXFormFieldValueById\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*,\s*([A-Za-z_$][\w$]*)\s*\)/u
  );
  const countFieldId = countAssignment?.[2];
  const countVariable = countAssignment?.[3];
  const countCategory = branches.find((branch) =>
    countVariable && new RegExp(`\\b${escapePattern(countVariable)}\\s*\\+\\+`, "u").test(branch.body)
  )?.categoryValue;

  const literalFieldIds = uniqueStrings(
    [...helper.body.matchAll(/\bfd_[A-Za-z0-9_]+\b/gu)].map((match) => match[0])
  );
  const toolFieldId = literalFieldIds.find((fieldId) => fieldId !== countFieldId);
  const table = (form?.fields || []).find((field) => field?.id === tableId && field.type === "detailTable");
  const columnIds = new Set((table?.columns || []).map((column) => column.id));
  if (!toolFieldId || !columnIds.has(toolFieldId) || !columnIds.has(amountFieldId)) return undefined;

  const branchByDiscriminator = new Map(branches.map((branch) => [branch.discriminatorValue, branch]));
  const categories = calls.map((call) => ({
    discriminatorValue: call.discriminatorValue,
    categoryValue: branchByDiscriminator.get(call.discriminatorValue)?.categoryValue,
    targetFieldId: selected.get(call.targetVariable),
    group: call.groupVariable === domesticGroupVariable
      ? "domestic"
      : call.groupVariable === fullOnlyGroupVariable ? "fullOnly" : undefined
  }));
  if (categories.some((category) => !category.categoryValue || !category.targetFieldId || !category.group)) {
    return undefined;
  }

  const scopedCalculationBody = analyzeJavaScriptFunctionBodyBindings(
    calculationFunction.body
  );
  const calculationBody = scopedCalculationBody.sourceWithoutNestedFunctions;
  const calculationBodyStart = calculationFunction.end - calculationFunction.body.length - 1;
  const calculationSelected = selectedFieldVariables(calculationBody);
  const taxFormula = calculationBody.match(
    /var\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*([A-Za-z_$][\w$]*)\.val\(\)\s*\?\s*theFixedNumTwo\(\s*\2\.val\(\)\s*\/\s*(-?(?:\d+\.?\d*|\.\d+))\s*\*\s*(-?(?:\d+\.?\d*|\.\d+))\s*\)\s*:\s*0\s*\)/u
  );
  if (!taxFormula) return undefined;
  const taxSourceFieldId = calculationSelected.get(taxFormula[2]);
  const taxTargetMatches = [...calculationBody.matchAll(new RegExp(
    `\\b([A-Za-z_$][\\w$]*)\\.val\\(\\s*${escapePattern(taxFormula[1])}\\s*\\)`,
    "gu"
  ))];
  const taxTargetVariables = uniqueStrings(taxTargetMatches.map((match) => match[1]));
  const stableTaxVariables = uniqueStrings([
    taxFormula[1],
    taxFormula[2],
    ...taxTargetVariables
  ]);
  if (
    taxTargetVariables.some((variable) => !calculationSelected.has(variable)) ||
    scopedCalculationBody.ok && stableTaxVariables.some((variable) =>
      !scopedCalculationBody.hasSingleStableBinding(variable)
    )
  ) return undefined;
  const taxTargetWrites = taxTargetMatches.map((match) => ({
    fieldId: calculationSelected.get(match[1]),
    start: calculationBodyStart + match.index,
    end: calculationBodyStart + match.index + match[0].length
  }));
  const taxTargetFieldIds = uniqueStrings(taxTargetWrites.map((write) => write.fieldId));
  if (!taxSourceFieldId || !taxTargetFieldIds.length) return undefined;
  const nativeTaxTargetFieldIds = scopedCalculationBody.ok
    ? taxTargetFieldIds.filter((fieldId) =>
      hasEquivalentGroupedDetailTaxCalculation(form, fieldId, {
        taxSourceFieldId,
        taxDivisor: Number(taxFormula[3]),
        taxMultiplier: Number(taxFormula[4])
      })
    )
    : [];

  return {
    tableId,
    toolFieldId,
    amountFieldId,
    taxiFieldId,
    modeFieldId,
    trafficTotalFieldId,
    domesticTotalFieldId,
    countFieldId,
    countCategory,
    categories,
    taxSourceFieldId,
    taxTargetFieldIds,
    scriptTaxTargetFieldIds: taxTargetFieldIds.filter((fieldId) =>
      !nativeTaxTargetFieldIds.includes(fieldId)
    ),
    taxFormulaEvidence: taxFormula[0].replace(/\s+/gu, " ").trim(),
    taxFormulaStart: calculationBodyStart + taxFormula.index,
    taxFormulaEnd: calculationBodyStart + taxFormula.index + taxFormula[0].length,
    taxTargetWrites,
    taxLexicalScopeProven: scopedCalculationBody.ok,
    taxDivisor: Number(taxFormula[3]),
    taxMultiplier: Number(taxFormula[4]),
    coveredFunctionNames: [helper.name, calculationFunction.name],
    calculationFunctionName: calculationFunction.name
  };
}

function groupedCategoryBranches(body) {
  const results = [];
  const pattern = /(?:if|else\s+if)\s*\(\s*([A-Za-z_$][\w$]*)\s*={2,3}\s*(["'])([^"']+)\2\s*&&\s*([A-Za-z_$][\w$]*)\s*={2,3}\s*(["'])([^"']+)\5\s*\)\s*\{/gu;
  for (const match of String(body).matchAll(pattern)) {
    const open = match.index + match[0].length - 1;
    const close = findBalancedClose(body, open, "{", "}");
    if (close <= open) continue;
    results.push({
      discriminator: match[1],
      discriminatorValue: match[3],
      categoryVariable: match[4],
      categoryValue: match[6],
      body: body.slice(open + 1, close)
    });
  }
  return results;
}

function groupedDetailCalculationCandidate(candidate) {
  return {
    ...candidate,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "grouped detail sums, mode branch, count, rounding, and tax calculation",
      target: "MKXFORM synchronous grouped-detail recalculation",
      basis: "deterministic-grouped-detail-calculation",
      reviewRequired: false
    }]
  };
}

function groupedDetailCalculationFunction(event, model) {
  const body = groupedDetailCalculationLines(model, event === "onAfterDel" ? "data || []" : undefined);
  if (event === "onBeforeSubmit") {
    return [
      "function onBeforeSubmit(context) {",
      "  if (context && context.isDraft) {",
      ...body.map((line) => `  ${line}`),
      "    return true",
      "  }",
      ...body,
      "  return true",
      "}"
    ].join("\n");
  }
  const signature = event === "onChange"
    ? "function onChange(value, rowNum, parentRowNum) {"
    : event === "onAfterDel" ? "function onAfterDel(data) {" : "function onLoad() {";
  return [signature, ...body, "}"].join("\n");
}

function clampedDetailAggregateCandidates(form = {}, sourceScripts = {}) {
  const sourcesByRef = new Map(
    (sourceScripts.sources || []).map((source) => [source.sourceRef, source])
  );
  const candidates = [];

  for (const field of form.fields || []) {
    const calculation = field?.props?.calculation;
    const inference = field?.sourceProps?.inferredCalculation;
    const postTransform = inference?.postTransform;
    if (
      field?.type === "detailTable" ||
      field?.dataOnly === true ||
      calculation?.kind !== "aggregate" ||
      calculation.operation !== "sum" ||
      postTransform?.kind !== "clamp" ||
      !Number.isFinite(Number(postTransform.min))
    ) continue;

    const table = (form.fields || []).find((candidate) =>
      candidate?.id === calculation.tableId && candidate.type === "detailTable"
    );
    if (!(table?.columns || []).some((column) => column.id === calculation.fieldId)) continue;

    const source = sourcesByRef.get(inference.sourceRef) || {
      sourceRef: inference.sourceRef || field.sourceRef,
      functionAudit: { matched: [], violations: [] }
    };
    const model = {
      tableId: calculation.tableId,
      fieldId: calculation.fieldId,
      targetFieldId: field.id,
      min: Number(postTransform.min)
    };
    const common = {
      translationStatus: "mapped",
      coverage: { status: "translated", nativeRules: [], residuals: [] },
      source,
      sourceRefs: uniqueStrings([field.sourceRef, inference.sourceRef]),
      functionMappings: [{
        source: `detail SUM with ${postTransform.kind} post-transform`,
        target: "MK native SUM plus synchronous lifecycle clamp",
        basis: "deterministic-clamped-detail-aggregate",
        reviewRequired: false
      }],
      semanticHints: {
        coveredCalculationRanges: inference.coveredCalculationRanges || []
      }
    };
    const idStem = `${inference.sourceRef || field.sourceRef || field.id}.clamped-aggregate.${field.id}`;

    candidates.push(
      {
        ...common,
        id: `${idStem}.source-change`,
        event: "onChange",
        scope: "control",
        controlId: model.fieldId,
        tableId: model.tableId,
        javascript: inference.evidence,
        function: clampedDetailAggregateFunction("onChange", model)
      },
      {
        ...common,
        id: `${idStem}.target-change`,
        event: "onChange",
        scope: "control",
        controlId: model.targetFieldId,
        javascript: inference.evidence,
        function: clampedAggregateTargetFunction(model)
      },
      {
        ...common,
        id: `${idStem}.after-delete`,
        event: "onAfterDel",
        scope: "control",
        controlId: model.tableId,
        tableId: model.tableId,
        javascript: inference.evidence,
        function: clampedDetailAggregateFunction("onAfterDel", model)
      },
      {
        ...common,
        id: `${idStem}.load`,
        event: "onLoad",
        scope: "global",
        javascript: inference.evidence,
        function: clampedDetailAggregateFunction("onLoad", model)
      },
      {
        ...common,
        id: `${idStem}.before-submit`,
        event: "onBeforeSubmit",
        scope: "global",
        javascript: inference.evidence,
        function: clampedDetailAggregateFunction("onBeforeSubmit", model)
      }
    );
  }

  return candidates;
}

function clampedDetailAggregateFunction(event, model) {
  const rowSource = event === "onAfterDel"
    ? "data || []"
    : `MKXFORM.getValue(${JSON.stringify(`\${table:${model.tableId}}`)}) || []`;
  const body = [
    `  var rawRows = ${rowSource}`,
    "  var rows = Array.isArray(rawRows) ? rawRows : (rawRows.values || [])",
    "  var total = 0",
    "  for (var index = 0; index < rows.length; index += 1) {",
    "    var row = rows[index] || {}",
    `    total += Number(row[${JSON.stringify(model.fieldId)}] || 0)`,
    "  }",
    `  var result = Math.max(total, ${model.min})`,
    `  MKXFORM.setValue(${JSON.stringify(model.targetFieldId)}, result)`
  ];
  if (event === "onBeforeSubmit") {
    return [
      "function onBeforeSubmit(context) {",
      "  if (context && context.isDraft) {",
      ...body.map((line) => `  ${line}`),
      "    return true",
      "  }",
      ...body,
      "  return true",
      "}"
    ].join("\n");
  }
  const signature = event === "onChange"
    ? "function onChange(value, rowNum, parentRowNum) {"
    : event === "onAfterDel" ? "function onAfterDel(data) {" : "function onLoad(context) {";
  return [signature, ...body, "}"].join("\n");
}

function clampedAggregateTargetFunction(model) {
  return [
    "function onChange(value) {",
    "  var current = Number(value || 0)",
    `  var result = Math.max(current, ${model.min})`,
    "  if (result !== current) {",
    `    MKXFORM.setValue(${JSON.stringify(model.targetFieldId)}, result)`,
    "  }",
    "}"
  ].join("\n");
}

function groupedDetailCalculationLines(model, rowSource) {
  const sumVariables = model.categories.map((_, index) => `categorySum${index + 1}`);
  const fullOnly = model.categories
    .map((category, index) => category.group === "fullOnly" ? sumVariables[index] : undefined)
    .filter(Boolean);
  const domestic = model.categories
    .map((category, index) => category.group === "domestic" ? sumVariables[index] : undefined)
    .filter(Boolean);
  const countIndex = model.categories.findIndex((category) => category.categoryValue === model.countCategory);
  return [
    rowSource
      ? `  var rawRows = ${rowSource}`
      : `  var rawRows = MKXFORM.getValue(${JSON.stringify(`\${table:${model.tableId}}`)}) || []`,
    "  var rows = Array.isArray(rawRows) ? rawRows : (rawRows.values || [])",
    ...sumVariables.map((variable) => `  var ${variable} = 0`),
    "  var groupedCount = 0",
    "  for (var index = 0; index < rows.length; index += 1) {",
    "    var row = rows[index] || {}",
    `    var rawCategory = row[${JSON.stringify(model.toolFieldId)}]`,
    "    var category = Array.isArray(rawCategory) ? rawCategory[0] : rawCategory",
    `    var amount = Number(row[${JSON.stringify(model.amountFieldId)}] || 0)`,
    ...model.categories.flatMap((item, index) => [
      `    if (category === ${JSON.stringify(item.categoryValue)}) {`,
      `      ${sumVariables[index]} = Math.round((${sumVariables[index]} + amount) * 100) / 100`,
      ...(index === countIndex ? ["      groupedCount += 1"] : []),
      "    }"
    ]),
    "  }",
    `  var taxi = Number(MKXFORM.getValue(${JSON.stringify(model.taxiFieldId)}) || 0)`,
    `  var modeRaw = MKXFORM.getValue(${JSON.stringify(model.modeFieldId)})`,
    "  var mode = Number(Array.isArray(modeRaw) ? modeRaw[0] : modeRaw || 0)",
    `  var domesticTotal = Math.round((${[...domestic, "taxi"].join(" + ")}) * 100) / 100`,
    `  var fullOnlyTotal = Math.round((${fullOnly.length ? fullOnly.join(" + ") : "0"}) * 100) / 100`,
    "  var trafficTotal = mode === 0 ? Math.round(taxi * 100) / 100 : Math.round((fullOnlyTotal + domesticTotal) * 100) / 100",
    ...model.categories.map((category, index) =>
      `  MKXFORM.setValue(${JSON.stringify(category.targetFieldId)}, ${sumVariables[index]})`
    ),
    ...(model.countFieldId ? [`  MKXFORM.setValue(${JSON.stringify(model.countFieldId)}, groupedCount)`] : []),
    `  MKXFORM.setValue(${JSON.stringify(model.trafficTotalFieldId)}, trafficTotal.toFixed(2))`,
    `  MKXFORM.setValue(${JSON.stringify(model.domesticTotalFieldId)}, (mode === 0 ? taxi : domesticTotal).toFixed(2))`,
    ...(model.scriptTaxTargetFieldIds.length ? [
      `  var taxableAmount = Number(MKXFORM.getValue(${JSON.stringify(model.taxSourceFieldId)}) || 0)`,
      `  var tax = taxableAmount ? Math.round((taxableAmount / ${model.taxDivisor} * ${model.taxMultiplier}) * 100) / 100 : 0`,
      ...model.scriptTaxTargetFieldIds.map((fieldId) =>
        `  MKXFORM.setValue(${JSON.stringify(fieldId)}, tax.toFixed(2))`
      )
    ] : [])
  ];
}

function hasEquivalentGroupedDetailTaxCalculation(form, targetFieldId, model) {
  const targetField = formFieldBySourceId(form, targetFieldId);
  const sourceField = formFieldBySourceId(form, model.taxSourceFieldId);
  const calculation = targetField?.props?.calculation;
  if (!sourceField || calculation?.kind !== "formula") return false;
  return calculation.expression === groupedDetailTaxFormulaExpression({
    ...model,
    taxSourceFieldId: sourceField.id
  }) &&
    calculation.fieldIds?.length === 1 &&
    calculation.fieldIds[0] === sourceField.id;
}

function groupedDetailTaxFormulaExpression(model) {
  const sourceRef = `$${model.taxSourceFieldId}$`;
  return `(${sourceRef} ? Math.round((${sourceRef} / ${model.taxDivisor} * ${model.taxMultiplier}) * 100) / 100 : 0)`;
}

function formFieldBySourceId(form, fieldId) {
  return (form?.fields || []).find((field) =>
    field?.id === fieldId || field?.sourceProps?.originalId === fieldId
  );
}

function allowanceCalculationCandidates(source, form, sourceScripts = {}) {
  const text = String(source.javascript || "");
  const model = allowanceCalculationModel(text, sourceScripts);
  if (!model) return [];
  const candidates = [];
  const dependencies = new Set([
    model.modeFieldId,
    model.startFieldId,
    model.endFieldId,
    model.personFieldId,
    model.rateFieldId,
    model.packageModeFieldId,
    model.regularFieldId,
    model.packageFieldId,
    model.radiationFieldId,
    model.receiptFieldId
  ]);

  for (const binding of inlineValueChangeBindings(text)) {
    if (!dependencies.has(binding.controlId)) continue;
    const detailTable = uniqueDetailTableForFields(form, [binding.controlId]);
    candidates.push(calculationScriptCandidate({
      index: binding.index,
      event: "onChange",
      scope: "control",
      controlId: binding.controlId,
      ...(detailTable ? { tableId: detailTable.id } : {}),
      javascript: binding.javascript,
      function: allowanceCalculationFunction("onChange", model)
    }, "deterministic-allowance-calculation"));
  }

  if (!candidates.some((candidate) => candidate.controlId === model.modeFieldId)) {
    candidates.push(calculationScriptCandidate({
      index: 0,
      event: "onChange",
      scope: "control",
      controlId: model.modeFieldId,
      javascript: `cross-source mode change recalculates allowance and receipt cap for ${model.modeFieldId}`,
      function: allowanceCalculationFunction("onChange", model)
    }, "deterministic-allowance-calculation"));
  }
  candidates.push(calculationScriptCandidate({
    index: text.length + 1,
    event: "onLoad",
    scope: "global",
    javascript: "initialize source allowance and receipt calculations in edit mode",
    function: allowanceCalculationFunction("onLoad", model)
  }, "deterministic-allowance-calculation"));
  candidates.push(calculationScriptCandidate({
    index: text.length + 2,
    event: "onBeforeSubmit",
    scope: "global",
    javascript: "recalculate source allowance and receipt calculations before draft/save/submit",
    function: allowanceCalculationFunction("onBeforeSubmit", model)
  }, "deterministic-allowance-calculation"));
  const coveredCalculationRanges = coveredFunctionRanges(
    text,
    source.sourceRef,
    model.coveredFunctionNames
  );
  return dedupeCandidatesByKey(candidates).map((candidate) => ({
    ...candidate,
    semanticHints: { ...(candidate.semanticHints || {}), coveredCalculationRanges }
  }));
}

function personTextCalculationCandidates(source, form, sourceScripts = {}) {
  const text = String(source.javascript || "");
  const model = personTextCalculationModel(text, sourceScripts);
  if (!model) return [];
  const bindings = personTextValueChangeBindings(text);
  const candidates = [];

  for (const binding of bindings) {
    if (!model.descriptionFieldIds.includes(binding.controlId)) continue;
    const isPersonSource = binding.controlId === model.personSourceFieldId;
    if (isPersonSource && binding.callbackName !== model.personFunctionName) continue;
    if (!isPersonSource && binding.callbackName !== model.descriptionFunctionName) continue;
    const detailTable = uniqueDetailTableForFields(form, [binding.controlId]);
    candidates.push(personTextScriptCandidate({
      index: binding.index,
      event: "onChange",
      scope: "control",
      controlId: binding.controlId,
      ...(detailTable ? { tableId: detailTable.id } : {}),
      javascript: binding.javascript,
      function: personTextCalculationFunction(isPersonSource, model),
      sourceRefs: model.dependencySourceRefs
    }));
  }

  if (model.hasDescriptionLoadBinding) {
    candidates.push(personTextScriptCandidate({
      index: text.length + 1,
      event: "onLoad",
      scope: "global",
      javascript: "initialize the source-composed trip description",
      function: personTextDescriptionFunction("onLoad", model),
      sourceRefs: model.dependencySourceRefs
    }));
  }
  const coveredCalculationRanges = coveredFunctionRanges(
    text,
    source.sourceRef,
    model.coveredFunctionNames
  );
  return dedupeCandidatesByKey(candidates).map((candidate) => ({
    ...candidate,
    semanticHints: { ...(candidate.semanticHints || {}), coveredCalculationRanges }
  }));
}

function legacyPersonPropertyHydrationCandidates(source, form) {
  const text = String(source.javascript || "").trim();
  const binding = text.match(
    /^AttachXFormValueChangeEventById\(\s*(["'])(fd_[A-Za-z0-9_]+)\.id\1\s*,\s*function\s*\(\s*value\s*,\s*domElement\s*\)\s*\{/u
  );
  if (
    !binding ||
    !/Data_GetOrgPersonBeanNameByKey\s*\(/u.test(text) ||
    !/data\.GetHashMapArray\s*\(\s*\)/u.test(text) ||
    !/GetXFormFieldById\s*\(\s*toIDs\s*\[\s*i\s*\]\s*\[\s*(["'])id\1\s*\]\s*\)\s*\[\s*0\s*\]\.value/u.test(text)
  ) return [];

  const addressField = findOrdinaryField(form, binding[2]);
  if (addressField?.componentId !== "xform-address") return [];
  const mappings = [...text.matchAll(
    /\{\s*name\s*:\s*(["'])(fdLoginName|fdNo)\1\s*,\s*id\s*:\s*(["'])extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)\3\s*\}/gu
  )].flatMap((match) => {
    const targetField = findOrdinaryField(form, match[4]);
    if (!targetField || targetField.componentId !== "xform-input") return [];
    return [{
      property: match[2],
      targetField,
      index: match.index
    }];
  });
  if (!mappings.length) return [];

  return mappings.flatMap(({ property, targetField, index }, mappingIndex) => {
    const evidence = personPropertyHydrationEvidence(addressField, targetField, property);
    const common = {
      javascript: text,
      translationStatus: "mapped",
      coverage: { status: "translated", nativeRules: [], residuals: [] },
      functionMappings: [personPropertyHydrationMapping()],
      sourceRefs: [addressField.sourceRef, targetField.sourceRef],
      semanticHints: {
        personPropertyHydration: evidence,
        coveredLegacyFunctions: [
          "Data_GetOrgPersonBeanNameByKey",
          "GetXFormFieldById",
          "KMSSData",
          "data.Format",
          "data.GetHashMapArray",
          "kmssdata.AddBeanData",
          "kmssdata.Parse"
        ]
      }
    };
    const onChange = {
      ...common,
      index,
      dedupeKey: `person-property:onChange:${addressField.id}:${targetField.id}`,
      sourceActionKey: inlineOnChangeSourceActionKey(source.sourceRef || source.id, binding.index || 0),
      event: "onChange",
      scope: "control",
      controlId: addressField.id,
      function: personPropertyHydrationFunction("onChange", addressField.id, targetField.id, property)
    };
    const defaultValue = addressField.props?.defaultValue;
    if (defaultValue?.kind !== "context") return [onChange];
    return [
      onChange,
      {
        ...common,
        index: text.length + mappingIndex + 1,
        dedupeKey: `person-property:onLoad:${addressField.id}:${targetField.id}`,
        event: "onLoad",
        scope: "global",
        function: personPropertyHydrationFunction("onLoad", addressField.id, targetField.id, property)
      }
    ];
  });
}

function contextPersonPropertyHydrationCandidates(form = {}, excludedTargetIds = new Set()) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  return fields.flatMap((targetField, index) => {
    if (
      targetField?.type === "detailTable" ||
      targetField?.componentId !== "xform-input" ||
      excludedTargetIds.has(targetField.id)
    ) return [];
    const expression = String(
      targetField.sourceProps?.metadataAttributes?.defaultValue ||
      targetField.sourceProps?.designerValues?.formula ||
      ""
    ).trim();
    const match = expression.match(/^\$([A-Za-z_][\w]*)\$\s*\.\s*(fdNo)$/iu);
    if (!match) return [];
    const addressField = fieldsById.get(match[1]);
    if (
      addressField?.componentId !== "xform-address" ||
      addressField.props?.defaultValue?.kind !== "context"
    ) return [];
    const fallbackAddressFieldIds = fields
      .filter((field) =>
        field.id !== addressField.id &&
        field.componentId === "xform-address" &&
        field.props?.defaultValue?.kind === "context" &&
        field.props.defaultValue.source === addressField.props.defaultValue.source
      )
      .map((field) => field.id);
    const property = match[2];
    const sourceRef = targetField.sourceRef || `source.form.control.${targetField.id}`;
    const common = {
      javascript: expression,
      translationStatus: "mapped",
      coverage: { status: "translated", nativeRules: [], residuals: [] },
      functionMappings: [personPropertyHydrationMapping()],
      sourceRefs: [addressField.sourceRef, targetField.sourceRef],
      semanticHints: {
        personPropertyHydration: personPropertyHydrationEvidence(addressField, targetField, property)
      },
      source: {
        sourceRef,
        javascript: expression,
        functionAudit: { violations: [] }
      }
    };
    return [
      {
        ...common,
        id: `person-property.${targetField.id}.onChange`,
        index,
        dedupeKey: `person-property:onChange:${addressField.id}:${targetField.id}`,
        event: "onChange",
        scope: "control",
        controlId: addressField.id,
        function: personPropertyHydrationFunction("onChange", addressField.id, targetField.id, property)
      },
      {
        ...common,
        id: `person-property.${targetField.id}.onLoad`,
        index: index + fields.length,
        dedupeKey: `person-property:onLoad:${addressField.id}:${targetField.id}`,
        event: "onLoad",
        scope: "global",
        function: personPropertyHydrationFunction(
          "onLoad",
          addressField.id,
          targetField.id,
          property,
          { fallbackAddressFieldIds }
        )
      }
    ];
  });
}

function personPropertyHydrationEvidence(addressField, targetField, property) {
  return {
    addressFieldId: addressField.id,
    targetFieldId: targetField.id,
    property,
    addressSourceRef: addressField.sourceRef,
    targetSourceRef: targetField.sourceRef
  };
}

function personPropertyHydrationMapping() {
  return {
    source: "legacy person address property lookup",
    target: "sysorg.getPersonByPersonId + MKXFORM.setValue",
    basis: "deterministic-person-property-hydration",
    reviewRequired: false
  };
}

function personPropertyHydrationFunction(
  event,
  addressFieldId,
  targetFieldId,
  property,
  { fallbackAddressFieldIds = [] } = {}
) {
  if (event === "onLoad") {
    const fallbackLines = fallbackAddressFieldIds.length > 0
      ? [
          `  var fallbackAddressFieldIds = ${JSON.stringify(fallbackAddressFieldIds)}`,
          "  for (var index = 0; (!person || !person.fdId) && index < fallbackAddressFieldIds.length; index += 1) {",
          "    person = MKXFORM.getValue(fallbackAddressFieldIds[index])",
          "  }"
        ]
      : [];
    return [
      "function onLoad() {",
      `  var person = MKXFORM.getValue(${JSON.stringify(addressFieldId)})`,
      ...fallbackLines,
      "  var personId = person && person.fdId",
      "  if (!personId) {",
      `    MKXFORM.setValue(${JSON.stringify(targetFieldId)}, \"\")`,
      "    return",
      "  }",
      "  MKXFORM.callOrg({",
      "    id: \"sysorg.getPersonByPersonId\",",
      "    param: { fdPersonId: personId }",
      "  }, function(error, result) {",
      `    var nextValue = !error && result ? result[${JSON.stringify(property)}] : \"\"`,
      `    MKXFORM.setValue(${JSON.stringify(targetFieldId)}, nextValue || \"\")`,
      "  })",
      "}"
    ].join("\n");
  }
  const signature = event === "onChange"
    ? "function onChange(value, rowNum, parentRowNum) {"
    : "function onLoad() {";
  const valueLine = event === "onChange"
    ? "  var person = Array.isArray(value) ? value[0] : value"
    : `  var person = MKXFORM.getValue(${JSON.stringify(addressFieldId)})`;
  return [
    signature,
    valueLine,
    "  var personId = person && person.fdId",
    "  if (!personId) {",
    `    MKXFORM.setValue(${JSON.stringify(targetFieldId)}, "")`,
    "    return",
    "  }",
    "  MKXFORM.callOrg({",
    "    id: \"sysorg.getPersonByPersonId\",",
    "    param: { fdPersonId: personId }",
    "  }, function(error, result) {",
    `    var nextValue = !error && result ? result[${JSON.stringify(property)}] : ""`,
    `    MKXFORM.setValue(${JSON.stringify(targetFieldId)}, nextValue || "")`,
    "  })",
    "}"
  ].join("\n");
}

function personTextCalculationModel(text, sourceScripts) {
  const functions = namedSourceFunctions(text);
  const composition = functions.map(compositionFunctionModel).find(Boolean);
  if (!composition || composition.fieldIds.length < 2) return undefined;

  const description = functions.map((fn) => {
    const assignment = fn.body.match(
      /SetXFormFieldValueById\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*,\s*([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\)/u
    );
    if (!assignment || assignment[3] !== composition.functionName) return undefined;
    return { functionName: fn.name, targetFieldId: assignment[2] };
  }).find(Boolean);
  if (!description) return undefined;

  const person = functions.map((fn) => personCountingFunctionModel(fn, description)).find(Boolean);
  if (!person || !composition.fieldIds.includes(person.sourceFieldId)) return undefined;

  const dependencySources = (sourceScripts?.sources || [])
    .filter((candidate) => String(candidate.javascript || "") !== text)
    .map((candidate) => ({
      source: candidate,
      functions: namedSourceFunctions(String(candidate.javascript || ""))
    }));
  const dependencyFunctionNames = new Set(
    dependencySources.flatMap((candidate) => candidate.functions.map((fn) => fn.name))
  );
  if (!person.dependencyCalls.length || !person.dependencyCalls.every((name) => dependencyFunctionNames.has(name))) {
    return undefined;
  }
  const allowanceDependency = dependencySources
    .map((candidate) => ({
      source: candidate.source,
      model: allowanceCalculationModel(String(candidate.source.javascript || ""), sourceScripts)
    }))
    .find((candidate) => candidate.model);
  if (!allowanceDependency) return undefined;

  const bindings = personTextValueChangeBindings(text);
  const descriptionFieldIds = composition.fieldIds.filter((fieldId) =>
    bindings.some((binding) => binding.controlId === fieldId)
  );
  if (descriptionFieldIds.length !== composition.fieldIds.length) return undefined;
  const personBinding = bindings.find((binding) =>
    binding.controlId === person.sourceFieldId && binding.callbackName === person.functionName
  );
  const otherBindingsAreDescription = descriptionFieldIds
    .filter((fieldId) => fieldId !== person.sourceFieldId)
    .every((fieldId) => bindings.some((binding) =>
      binding.controlId === fieldId && binding.callbackName === description.functionName
    ));
  if (!personBinding || !otherBindingsAreDescription) return undefined;

  return {
    descriptionFieldIds: composition.fieldIds,
    descriptionTargetFieldId: description.targetFieldId,
    descriptionFunctionName: description.functionName,
    personFunctionName: person.functionName,
    personSourceFieldId: person.sourceFieldId,
    personCountFieldId: person.countFieldId,
    allowanceModel: allowanceDependency.model,
    dependencySourceRefs: [allowanceDependency.source.sourceRef].filter(Boolean),
    coveredFunctionNames: [
      composition.functionName,
      description.functionName,
      person.functionName
    ],
    hasDescriptionLoadBinding: new RegExp(
      `Com_AddEventListener\\(\\s*window\\s*,\\s*(["'])load\\1\\s*,\\s*${escapePattern(description.functionName)}\\s*\\)`,
      "u"
    ).test(text)
  };
}

function compositionFunctionModel(fn) {
  const returned = fn.body.match(/\breturn\s+([^;]+)\s*;/u)?.[1];
  if (!returned) return undefined;
  const reads = new Map(
    [...fn.body.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*getFormFieldValue\(\s*(["'])(fd_[A-Za-z0-9_]+)\2\s*\)\s*;/gu)]
      .map((match) => [match[1], match[3]])
  );
  const directFieldIds = [...returned.matchAll(/getFormFieldValue\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*\)/gu)]
    .map((match) => match[2]);
  const terms = returned.split("+").map((term) => term.trim()).filter(Boolean);
  const fieldIds = directFieldIds.length === terms.length
    ? directFieldIds
    : terms.map((term) => reads.get(term)).filter(Boolean);
  if (fieldIds.length !== terms.length || uniqueStrings(fieldIds).length !== fieldIds.length) return undefined;
  return { functionName: fn.name, fieldIds };
}

function personCountingFunctionModel(fn, description) {
  if (!new RegExp(`\\b${escapePattern(description.functionName)}\\s*\\(\\s*\\)`, "u").test(fn.body) &&
      !new RegExp(`SetXFormFieldValueById\\([^)]*${escapePattern(description.targetFieldId)}`, "u").test(fn.body)) {
    return undefined;
  }
  const source = fn.body.match(
    /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*getFormFieldValue\(\s*(["'])(fd_[A-Za-z0-9_]+)\2\s*\)\s*;/u
  );
  if (!source) return undefined;
  const replacementPatterns = [...fn.body.matchAll(/\.replace\(\s*(\/(?:\\.|[^/])+\/g)\s*,\s*(["'])、\2\s*\)/gu)]
    .map((match) => match[1]);
  if (!["/，/g", "/,/g", "/\\//g", "/\\\\/g"].every((pattern) => replacementPatterns.includes(pattern))) {
    return undefined;
  }
  const split = fn.body.match(new RegExp(
    `\\bvar\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapePattern(source[1])}\\.split\\(\\s*(["'])、\\2\\s*\\)\\s*;`,
    "u"
  ));
  if (!split) return undefined;
  const count = fn.body.match(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*0\s*;/u);
  if (!count || !new RegExp(`\\b${escapePattern(count[1])}\\s*\\+\\+`, "u").test(fn.body)) return undefined;
  const countTarget = fn.body.match(new RegExp(
    `SetXFormFieldValueById\\(\\s*(["'])(fd_[A-Za-z0-9_]+)\\1\\s*,\\s*${escapePattern(count[1])}\\s*\\)`,
    "u"
  ));
  if (!countTarget || !new RegExp(`if\\s*\\(\\s*${escapePattern(count[1])}\\s*>\\s*0\\s*\\)`, "u").test(fn.body)) {
    return undefined;
  }
  const localNames = new Set([fn.name, description.functionName]);
  const dependencyCalls = uniqueStrings(
    [...fn.body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)\s*;/gu)]
      .map((match) => match[1])
      .filter((name) => !localNames.has(name))
  );
  return {
    functionName: fn.name,
    sourceFieldId: source[3],
    countFieldId: countTarget[2],
    dependencyCalls
  };
}

function personTextValueChangeBindings(text) {
  const bindings = [];
  const platformCallStarts = provenPlatformValueChangeCallStarts(text);
  const pattern = /AttachXFormValueChangeEventById\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*,\s*/gu;
  for (const match of String(text).matchAll(pattern)) {
    if (!platformCallStarts.has(match.index)) continue;
    const rest = text.slice(match.index + match[0].length);
    const named = rest.match(/^([A-Za-z_$][\w$]*)\s*\)/u);
    if (named) {
      bindings.push({
        index: match.index,
        controlId: match[2],
        callbackName: named[1],
        javascript: text.slice(match.index, match.index + match[0].length + named[0].length).trim()
      });
      continue;
    }
    const inline = rest.match(/^function\s*\([^)]*\)\s*\{/u);
    if (!inline) continue;
    const open = match.index + match[0].length + inline[0].length - 1;
    const close = findBalancedClose(text, open, "{", "}");
    if (close <= open) continue;
    const body = text.slice(open + 1, close);
    const callbackName = body.match(/^\s*([A-Za-z_$][\w$]*)\s*\(\s*\)\s*;/u)?.[1];
    if (!callbackName) continue;
    bindings.push({
      index: match.index,
      controlId: match[2],
      callbackName,
      javascript: text.slice(match.index, findCallEnd(text, close + 1)).trim()
    });
  }
  return bindings;
}

function personTextScriptCandidate(candidate) {
  return {
    ...candidate,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "source traveler delimiter normalization, non-empty count, description composition, and explicit dependent calculation calls",
      target: "MKXFORM synchronous traveler and dependent recalculation",
      basis: "deterministic-person-text-calculation",
      reviewRequired: false
    }]
  };
}

function personTextCalculationFunction(includeDependentCalculations, model) {
  if (!includeDependentCalculations) return personTextDescriptionFunction("onChange", model);
  const descriptionLines = personTextDescriptionLines(model);
  return [
    "function onChange(value, rowNum, parentRowNum) {",
    ...descriptionLines,
    `  var personTextRaw = MKXFORM.getValue(${JSON.stringify(model.personSourceFieldId)})`,
    "  var personText = personTextRaw == null ? \"\" : String(personTextRaw)",
    "  personText = personText.replace(/，/g, \"、\").replace(/,/g, \"、\").replace(/\\//g, \"、\").replace(/\\\\/g, \"、\")",
    "  var peopleList = personText.split(\"、\")",
    "  var peopleCount = 0",
    "  for (var index = 0; index < peopleList.length; index += 1) {",
    "    if (peopleList[index].length > 0) peopleCount += 1",
    "  }",
    "  if (peopleCount > 0) {",
    `    MKXFORM.setValue(${JSON.stringify(model.personCountFieldId)}, peopleCount)`,
    ...allowanceCalculationLines(model.allowanceModel).map((line) => `  ${line}`),
    "  }",
    "}"
  ].join("\n");
}

function personTextDescriptionFunction(event, model) {
  const signature = event === "onLoad"
    ? "function onLoad() {"
    : "function onChange(value, rowNum, parentRowNum) {";
  return [signature, ...personTextDescriptionLines(model), "}"].join("\n");
}

function personTextDescriptionLines(model) {
  const terms = model.descriptionFieldIds.map((fieldId, index) => [
    `  var descriptionPart${index + 1}Raw = MKXFORM.getValue(${JSON.stringify(fieldId)})`,
    `  var descriptionPart${index + 1} = descriptionPart${index + 1}Raw == null ? "" : String(descriptionPart${index + 1}Raw)`
  ]).flat();
  return [
    ...terms,
    `  var description = ${model.descriptionFieldIds.map((_, index) => `descriptionPart${index + 1}`).join(" + ")}`,
    `  MKXFORM.setValue(${JSON.stringify(model.descriptionTargetFieldId)}, description)`
  ];
}

function allowanceCalculationModel(text, sourceScripts) {
  const functions = namedSourceFunctions(text);
  const regular = functions.map((fn) => {
    const selected = selectedFieldVariables(fn.body);
    const formula = fn.body.match(/var\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.val\(\)\s*\*\s*([A-Za-z_$][\w$]*)\.val\(\)\s*\*\s*([A-Za-z_$][\w$]*)\.val\(\)\s*;/u);
    if (!formula) return undefined;
    const output = [...selected.keys()].find((variable) =>
      new RegExp(`\\b${escapePattern(variable)}\\.val\\(\\s*${escapePattern(formula[1])}\\s*\\?`, "u").test(fn.body)
    );
    if (!output) return undefined;
    return {
      fn,
      variables: formula.slice(2, 5),
      fieldIds: formula.slice(2, 5).map((variable) => selected.get(variable)),
      outputFieldId: selected.get(output)
    };
  }).find((entry) => entry?.fieldIds.every(Boolean));
  if (!regular) return undefined;

  const packageRule = functions.map((fn) => {
    const reads = new Map(
      [...fn.body.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*Number\(\s*getFormFieldValue\(\s*(["'])(fd_[A-Za-z0-9_]+)\2\s*\)\s*\)\s*;/gu)]
        .map((match) => [match[1], match[3]])
    );
    const formula = fn.body.match(/var\s+([A-Za-z_$][\w$]*)\s*=\s*theFixedNumTwo\(\s*([A-Za-z_$][\w$]*)\s*\*\s*([A-Za-z_$][\w$]*)\s*\*\s*([A-Za-z_$][\w$]*)\s*\+\s*(-?(?:\d+\.?\d*|\.\d+))\s*\)/u);
    const selected = selectedFieldVariables(fn.body);
    if (!formula || !formula.slice(2, 5).every((variable) => reads.has(variable))) return undefined;
    const output = [...selected.keys()].find((variable) =>
      new RegExp(`\\b${escapePattern(variable)}\\.val\\(\\s*${escapePattern(formula[1])}\\.toFixed`, "u").test(fn.body)
    );
    if (!output) return undefined;
    return {
      fn,
      reads,
      formulaVariables: formula.slice(2, 5),
      constant: Number(formula[5]),
      outputFieldId: selected.get(output)
    };
  }).find(Boolean);
  if (!packageRule) return undefined;

  const sharedRegular = regular.fieldIds;
  const sharedPackage = packageRule.formulaVariables.map((variable) => packageRule.reads.get(variable));
  const personFieldId = sharedRegular.find((fieldId) => sharedPackage.includes(fieldId));
  const rateFieldId = sharedRegular.find((fieldId) => fieldId !== personFieldId && sharedPackage.includes(fieldId));
  const allowanceDaysFieldId = sharedRegular.find((fieldId) => !sharedPackage.includes(fieldId));
  const overnightFieldId = sharedPackage.find((fieldId) => !sharedRegular.includes(fieldId));
  if (!personFieldId || !rateFieldId || !allowanceDaysFieldId || !overnightFieldId) return undefined;

  const totalRule = functions.map((fn) => {
    const selected = selectedFieldVariables(fn.body);
    const packageModeFieldId = fn.body.match(/getFormRadioValue\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*\)/u)?.[2];
    const totalVariable = fn.body.match(/var\s+([A-Za-z_$][\w$]*)\s*=\s*0(?:\.0+)?\s*;/u)?.[1];
    if (!packageModeFieldId || !totalVariable) return undefined;
    const outputVariable = [...selected.keys()].find((variable) =>
      new RegExp(`\\b${escapePattern(variable)}\\.val\\(\\s*${escapePattern(totalVariable)}\\.toFixed`, "u").test(fn.body)
    );
    const referencedFields = [...selected.values()];
    const radiationFieldId = referencedFields.find((fieldId) =>
      ![regular.outputFieldId, packageRule.outputFieldId, selected.get(outputVariable)].includes(fieldId)
    );
    if (!outputVariable || !radiationFieldId) return undefined;
    return {
      fn,
      packageModeFieldId,
      totalFieldId: selected.get(outputVariable),
      radiationFieldId
    };
  }).find(Boolean);
  if (!totalRule) return undefined;

  const dateRule = functions.map((fn) => {
    const date = fn.body.match(/timeDifference\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*,\s*(["'])(fd_[A-Za-z0-9_]+)\3(?:\s*,[^)]*)?\)/u);
    if (!date) return undefined;
    const selected = selectedFieldVariables(fn.body);
    if (!selected.size) return undefined;
    return { fn, startFieldId: date[2], endFieldId: date[4] };
  }).find(Boolean);
  if (!dateRule) return undefined;

  const receipt = detailReceiptModel(text, functions);
  const modeFieldId = legacyModeSourceFieldId(sourceScripts, "theCityFlag");
  const rates = cityRateValues(functions, rateFieldId);
  if (!receipt || !modeFieldId || !rates) return undefined;

  return {
    ...dateRule,
    ...totalRule,
    ...receipt,
    modeFieldId,
    personFieldId,
    rateFieldId,
    allowanceDaysFieldId,
    overnightFieldId,
    regularFieldId: regular.outputFieldId,
    packageFieldId: packageRule.outputFieldId,
    packageConstant: packageRule.constant,
    cityRate: rates.cityRate,
    domesticRate: rates.domesticRate,
    coveredFunctionNames: uniqueStrings([
      regular.fn.name,
      packageRule.fn.name,
      totalRule.fn.name,
      dateRule.fn.name,
      functions.some((fn) => fn.name === "timeDifference") ? "timeDifference" : undefined,
      rates.fn.name,
      ...(receipt.coveredFunctionNames || [])
    ])
  };
}

function detailReceiptModel(text, functions) {
  const tableVars = new Map(
    [...text.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(fd_[A-Za-z0-9_]+)\2\s*;/gu)]
      .map((match) => [match[1], match[3]])
  );
  for (const fn of functions) {
    const receipt = fn.body.match(/var\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\(\s*([A-Za-z_$][\w$]*)\s*,\s*(["'])(fd_[A-Za-z0-9_]+)\4\s*\)\s*;/u);
    if (!receipt || !tableVars.has(receipt[3])) continue;
    const helper = functions.find((candidate) => candidate.name === receipt[2]);
    const helperAnalysis = analyzeLegacyDetailSumHelper(helper);
    if (!helperAnalysis || helperAnalysis.dependentCalls.length) continue;
    const selected = selectedFieldVariables(fn.body);
    const targetVariable = [...selected.keys()].find((variable) =>
      new RegExp(`\\b${escapePattern(variable)}\\.val\\(`, "u").test(fn.body)
    );
    const cap = functions
      .map((candidate) => candidate.body.match(/return\s+[A-Za-z_$][\w$]*\s*\*\s*[A-Za-z_$][\w$]*\s*\*\s*(-?(?:\d+\.?\d*|\.\d+))\s*;/u)?.[1])
      .find(Boolean);
    if (!targetVariable || !cap) continue;
    return {
      receiptTableId: tableVars.get(receipt[3]),
      receiptFieldId: receipt[5],
      receiptTargetFieldId: selected.get(targetVariable),
      receiptCapPerPersonDay: Number(cap),
      coveredFunctionNames: [fn.name, helper.name]
    };
  }
  return undefined;
}

function legacyModeSourceFieldId(sourceScripts, modeVariable) {
  const pattern = new RegExp(
    `\\b${escapePattern(modeVariable)}\\s*=\\s*Number\\(\\s*getFormRadioValue\\(\\s*(["'])(fd_[A-Za-z0-9_]+)\\1\\s*\\)\\s*\\)`,
    "u"
  );
  for (const source of sourceScripts?.sources || []) {
    const match = pattern.exec(String(source.javascript || ""));
    if (match) return match[2];
  }
  return undefined;
}

function cityRateValues(functions, rateFieldId) {
  for (const fn of functions) {
    const selected = selectedFieldVariables(fn.body);
    const rateVariable = [...selected.entries()].find(([, fieldId]) => fieldId === rateFieldId)?.[0];
    if (!rateVariable || !/if\s*\([^)]*==\s*0\s*\)/u.test(fn.body)) continue;
    const values = [...fn.body.matchAll(new RegExp(
      `\\b${escapePattern(rateVariable)}\\.val\\(\\s*(-?(?:\\d+\\.?\\d*|\\.\\d+))\\s*\\)`,
      "gu"
    ))].map((match) => Number(match[1]));
    if (values.length >= 2) return { fn, cityRate: values[0], domesticRate: values[1] };
  }
  return undefined;
}

function selectedFieldVariables(text) {
  const values = new Map();
  const pattern = /var\s+([A-Za-z_$][\w$]*)\s*=\s*\$\([^;\n]*?extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)[^;\n]*?\)\s*;/gu;
  for (const match of String(text).matchAll(pattern)) values.set(match[1], match[2]);
  return values;
}

function namedSourceFunctions(text) {
  const functions = [];
  const pattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gu;
  for (const match of String(text).matchAll(pattern)) {
    const open = match.index + match[0].length - 1;
    const close = findBalancedClose(text, open, "{", "}");
    if (close > open) functions.push({
      name: match[1],
      params: match[2].split(","),
      body: text.slice(open + 1, close),
      start: match.index,
      end: close + 1
    });
  }
  return functions;
}

function coveredFunctionRanges(text, sourceRef, names = []) {
  const functions = namedSourceFunctions(text);
  const byName = new Map(functions.map((fn) => [fn.name, fn]));
  const covered = new Set();
  const pending = names.filter(Boolean);
  while (pending.length) {
    const name = pending.shift();
    if (covered.has(name) || !byName.has(name)) continue;
    covered.add(name);
    const fn = byName.get(name);
    for (const match of fn.body.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/gu)) {
      if (byName.has(match[2]) && !covered.has(match[2])) pending.push(match[2]);
    }
  }
  return functions
    .filter((fn) => covered.has(fn.name))
    .map((fn) => ({ sourceRef, name: fn.name, start: fn.start, end: fn.end }));
}

function inlineValueChangeBindings(text) {
  const bindings = [];
  const platformCallStarts = provenPlatformValueChangeCallStarts(text);
  const pattern = /AttachXFormValueChangeEventById\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*,\s*function\s*\([^)]*\)\s*\{/gu;
  for (const match of String(text).matchAll(pattern)) {
    if (!platformCallStarts.has(match.index)) continue;
    const open = match.index + match[0].length - 1;
    const close = findBalancedClose(text, open, "{", "}");
    if (close <= open) continue;
    bindings.push({
      index: match.index,
      controlId: match[2],
      javascript: text.slice(match.index, findCallEnd(text, close + 1)).trim()
    });
  }
  return bindings;
}

function calculationScriptCandidate(candidate, basis) {
  return {
    ...candidate,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "source allowance, receipt-cap, date, rounding, and mode-gating calculations",
      target: "MKXFORM synchronous recalculation",
      basis,
      reviewRequired: false
    }]
  };
}

function allowanceCalculationFunction(event, model) {
  const body = allowanceCalculationLines(model);
  if (event === "onBeforeSubmit") {
    return [
      "function onBeforeSubmit(context) {",
      "  if (context && context.isDraft) {",
      ...body.map((line) => `  ${line}`),
      "    return true",
      "  }",
      ...body,
      "  return true",
      "}"
    ].join("\n");
  }
  const signature = event === "onChange"
    ? "function onChange(value, rowNum, parentRowNum) {"
    : "function onLoad() {";
  return [signature, ...body, "}"].join("\n");
}

function allowanceCalculationLines(model) {
  const detailTable = `\${table:${model.receiptTableId}}`;
  return [
    `  var modeRaw = MKXFORM.getValue(${JSON.stringify(model.modeFieldId)})`,
    "  var mode = Number(Array.isArray(modeRaw) ? modeRaw[0] : modeRaw || 0)",
    `  var startRaw = MKXFORM.getValue(${JSON.stringify(model.startFieldId)})`,
    `  var endRaw = MKXFORM.getValue(${JSON.stringify(model.endFieldId)})`,
    "  var dayDifference = 0",
    "  var hourDifference = 0",
    "  if (startRaw && endRaw) {",
    "    var startDate = new Date(String(startRaw).replace(/-/g, '/'))",
    "    var endDate = new Date(String(endRaw).replace(/-/g, '/'))",
    "    hourDifference = Math.floor((endDate.getTime() - startDate.getTime()) / 3600000)",
    "    startDate.setHours(0, 0, 0, 0)",
    "    endDate.setHours(0, 0, 0, 0)",
    "    dayDifference = Math.floor((endDate.getTime() - startDate.getTime()) / 86400000)",
    "  }",
    `  var people = Number(MKXFORM.getValue(${JSON.stringify(model.personFieldId)}) || 0)`,
    `  var rate = mode === 0 ? ${model.cityRate} : ${model.domesticRate}`,
    "  var overnightDays = mode === 0 || dayDifference < 0 ? 0 : dayDifference",
    "  var allowanceDays = mode === 0 || dayDifference < 0 ? 0 : (dayDifference > 0 ? dayDifference + 1 : (hourDifference >= 8 ? 1 : 0))",
    "  var regular = allowanceDays && people ? allowanceDays * people * rate : 0",
    "  regular = Math.round(regular * 100) / 100",
    `  var packageRaw = MKXFORM.getValue(${JSON.stringify(model.packageModeFieldId)})`,
    "  var packageMode = Array.isArray(packageRaw) ? packageRaw[0] : packageRaw",
    `  var packaged = packageMode === "1" ? Math.round((people * rate * overnightDays + ${model.packageConstant}) * 100) / 100 : 0`,
    "  if (packageMode === \"1\") regular = 0",
    `  var radiation = Number(MKXFORM.getValue(${JSON.stringify(model.radiationFieldId)}) || 0)`,
    "  var allowanceTotal = Math.round(((packageMode === \"1\" ? packaged : regular) + radiation) * 100) / 100",
    `  var receiptRows = MKXFORM.getValue(${JSON.stringify(detailTable)}) || []`,
    "  var receiptTotal = 0",
    "  for (var index = 0; index < receiptRows.length; index += 1) {",
    `    receiptTotal = Math.round((receiptTotal + Number(receiptRows[index][${JSON.stringify(model.receiptFieldId)}] || 0)) * 100) / 100`,
    "  }",
    `  var receiptCap = (dayDifference + 1) * people * ${model.receiptCapPerPersonDay}`,
    "  var receiptResult = mode === 0 ? receiptTotal : Math.min(receiptTotal, Math.max(receiptCap, 0))",
    `  MKXFORM.setValue(${JSON.stringify(model.overnightFieldId)}, overnightDays)`,
    `  MKXFORM.setValue(${JSON.stringify(model.allowanceDaysFieldId)}, allowanceDays)`,
    `  MKXFORM.setValue(${JSON.stringify(model.rateFieldId)}, rate)`,
    `  MKXFORM.setValue(${JSON.stringify(model.regularFieldId)}, regular.toFixed(2))`,
    `  MKXFORM.setValue(${JSON.stringify(model.packageFieldId)}, packaged.toFixed(2))`,
    `  MKXFORM.setValue(${JSON.stringify(model.totalFieldId)}, allowanceTotal.toFixed(2))`,
    `  MKXFORM.setValue(${JSON.stringify(model.receiptTargetFieldId)}, receiptResult)`,
  ];
}

function qualityFastReportRowVisibilityCandidates(source) {
  const text = String(source.javascript || "");
  if (
    !/\bfunction\s+hideAll\s*\(/.test(text) ||
    !/\bfunction\s+judgeMethod(?:View)?\s*\(\s*input1\s*,\s*input2\s*,\s*input3\s*\)/.test(text) ||
    !text.includes("fd_jjzlsj_row") ||
    !text.includes("fd_qylb_con") ||
    !text.includes("fd_sjlb_con") ||
    !text.includes("fd_yxlb_con")
  ) {
    return [];
  }

  const viewMode = source.displayGate === "xform:viewShow";
  const windowLoads = extractWindowLoadCandidates(source).map((candidate) => ({
    ...candidate,
    function: qualityFastReportFunction({
      event: "onLoad",
      viewMode,
      changedControlId: ""
    }),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: qualityFastReportMappings()
  }));

  const valueChanges = viewMode ? [] : extractValueChangeCandidates(source).map((candidate) => ({
    ...candidate,
    function: qualityFastReportFunction({
      event: "onChange",
      viewMode: false,
      changedControlId: candidate.controlId
    }),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: qualityFastReportMappings()
  }));

  return [...windowLoads, ...valueChanges].sort((left, right) => left.index - right.index);
}

function qualityFastReportMappings() {
  return [{
    source: "hideAll + judgeMethod row visibility/required matrix",
    target: "MKXFORM.getValue + MKXFORM.setValue + MKXFORM.setFieldAttr",
    basis: "deterministic-quality-fast-report-row-visibility",
    reviewRequired: false
  }];
}

function qualityFastReportFunction({ event, viewMode, changedControlId }) {
  const editable = !viewMode;
  const readField = (fieldId) => `readValue(${JSON.stringify(fieldId)})`;
  const input1 = changedControlId === "fd_3ded07af4e64c6" ? "value" : readField(viewMode ? "fd_qylb_con" : "fd_3ded07af4e64c6");
  const input2 = changedControlId === "fd_3ded08386a01d2" ? "value" : readField(viewMode ? "fd_sjlb_con" : "fd_3ded08386a01d2");
  const input3 = changedControlId === "fd_3ded0898e10da4" ? "value" : readField(viewMode ? "fd_yxlb_con" : "fd_3ded0898e10da4");
  const signature = event === "onChange"
    ? "function onChange(value, rowNum, parentRowNum)"
    : "function onLoad()";
  return [
    `${signature} {`,
    "  function readValue(fieldId) {",
    "    return normalizeValue(MKXFORM.getValue(fieldId));",
    "  }",
    "  function normalizeValue(raw) {",
    "    if (Array.isArray(raw)) return normalizeValue(raw[0]);",
    "    if (raw && typeof raw === 'object' && raw.value !== undefined) return normalizeValue(raw.value);",
    "    return raw === undefined || raw === null ? '' : String(raw);",
    "  }",
    "  function hideAllRows() {",
    ...QUALITY_FAST_REPORT_ROW_MARKERS.flatMap((marker) => qualityFastReportSetRowLines(marker, "false", "false", "    ")),
    "  }",
    "  function applyRows(input1, input2, input3) {",
    "    input1 = normalizeValue(input1);",
    "    input2 = normalizeValue(input2);",
    "    input3 = normalizeValue(input3);",
    editable ? "    MKXFORM.setValue('fd_qylb_con', input1);" : undefined,
    editable ? "    MKXFORM.setValue('fd_sjlb_con', input2);" : undefined,
    editable ? "    MKXFORM.setValue('fd_yxlb_con', input3);" : undefined,
    "    hideAllRows();",
    ...QUALITY_FAST_REPORT_BRANCHES.map((branch, index) => {
      const prefix = index === 0 ? "    if" : "    else if";
      return [
        `${prefix} (${branch.condition}) {`,
        ...qualityFastReportSetRowLines(branch.rowMarker, "true", editable ? "true" : "false", "      "),
        "    }"
      ].join("\n");
    }),
    ...qualityFastReportSetRowLines("fd_jjzlsj_row", "input2 === 'jjzlsj'", editable ? "true" : "false", "    "),
    "  }",
    `  applyRows(${input1}, ${input2}, ${input3});`,
    "}"
  ].filter((line) => line !== undefined).join("\n");
}

function qualityFastReportSetRowLines(rowMarker, visibleExpression, requiredExpression, indent) {
  return [
    `${indent}MKXFORM.setFieldAttr(${JSON.stringify(rowMarker)}, ${visibleExpression} ? 5 : 4);`,
    `${indent}MKXFORM.setFieldAttr(${JSON.stringify(rowMarker)}, ${requiredExpression} ? 3 : 6);`
  ];
}

const QUALITY_FAST_REPORT_ROW_MARKERS = [
  "fd_jdjjcx_row",
  "fd_jdjjgc_row",
  "fd_jdjjzz_row",
  "fd_jdxmcx_row",
  "fd_jdxmzzgc_row",
  "fd_jdpp_row",
  "fd_zdjjcx_row",
  "fd_zdxmzzgc_row",
  "fd_zdjjgc_row",
  "fd_zdjjzz_row",
  "fd_zdxmcx_row",
  "fd_zdpp_row"
];

const QUALITY_FAST_REPORT_BRANCHES = [
  { condition: "input2 === 'zdzlsj' && input3 === 'ppyx'", rowMarker: "fd_zdpp_row" },
  { condition: "input2 === 'zdzlsj' && input3 === 'xmyx' && (input1 === 'gcqy' || input1 === 'zzqy')", rowMarker: "fd_zdxmzzgc_row" },
  { condition: "input2 === 'zdzlsj' && input3 === 'xmyx' && input1 === 'cxqy'", rowMarker: "fd_zdxmcx_row" },
  { condition: "input2 === 'zdzlsj' && input3 === 'jjyx' && input1 === 'zzqy'", rowMarker: "fd_zdjjzz_row" },
  { condition: "input2 === 'zdzlsj' && input3 === 'jjyx' && input1 === 'gcqy'", rowMarker: "fd_zdjjgc_row" },
  { condition: "input2 === 'zdzlsj' && input3 === 'jjyx' && input1 === 'cxqy'", rowMarker: "fd_zdjjcx_row" },
  { condition: "input2 === 'jdzlsj' && input3 === 'ppyx'", rowMarker: "fd_jdpp_row" },
  { condition: "input2 === 'jdzlsj' && input3 === 'xmyx' && (input1 === 'gcqy' || input1 === 'zzqy')", rowMarker: "fd_jdxmzzgc_row" },
  { condition: "input2 === 'jdzlsj' && input3 === 'xmyx' && input1 === 'cxqy'", rowMarker: "fd_jdxmcx_row" },
  { condition: "input2 === 'jdzlsj' && input3 === 'jjyx' && input1 === 'zzqy'", rowMarker: "fd_jdjjzz_row" },
  { condition: "input2 === 'jdzlsj' && input3 === 'jjyx' && input1 === 'gcqy'", rowMarker: "fd_jdjjgc_row" },
  { condition: "input2 === 'jdzlsj' && input3 === 'jjyx' && input1 === 'cxqy'", rowMarker: "fd_jdjjcx_row" }
];

function procurementPaymentScriptCandidates(source, form) {
  return [
    procurementPaymentAttachmentSubmitCandidate(source, form),
    procurementPaymentWbsVisibilityCandidate(source, form),
    procurementPaymentDepartmentConsistencyCandidate(source, form)
  ].flat().filter(Boolean).sort((left, right) => left.index - right.index);
}

function procurementPaymentAttachmentSubmitCandidate(source, form) {
  const text = String(source.javascript || "");
  if (!/Com_Parameter\.event\.submit\.push/.test(text)) return undefined;
  if (!/Attachment_ObjectInfo\s*\[\s*["']fd_attachment["']\s*\]/.test(text)) return undefined;
  if (!/fd_3b4ec96ec9b8e2/.test(text)) return undefined;
  if (!fieldById(form, "fd_attachment") || !fieldById(form, "fd_3b4ec96ec9b8e2")) return undefined;
  const message = text.match(/alert\(\s*(["'])([^"']+)\1\s*\)/)?.[2] || "请上传附件";
  return {
    index: text.indexOf("Com_Parameter.event.submit.push"),
    event: "onBeforeSubmit",
    scope: "global",
    function: [
      "function onBeforeSubmit(context) {",
      "  if (context && context.isDraft) return true",
      "  var selected = MKXFORM.getValue(\"fd_3b4ec96ec9b8e2\")",
      "  selected = Array.isArray(selected) ? selected[0] : selected",
      "  if (String(selected) === \"1\") {",
      "    var files = MKXFORM.getValue(\"fd_attachment\")",
      "    var hasFiles = Array.isArray(files) ? files.length > 0 : !!files",
      "    if (!hasFiles) {",
      `      MKXFORM.toast(${JSON.stringify(message)})`,
      "      return false",
      "    }",
      "  }",
      "  return true",
      "}"
    ].join("\n"),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "Com_Parameter.event.submit attachment fileList guard",
      target: "onBeforeSubmit + MKXFORM.getValue + MKXFORM.toast",
      basis: "deterministic-procurement-payment-attachment-submit",
      reviewRequired: false
    }],
    semanticHints: {
      coveredCalculationRanges: coveredRangesForText(text, "", {
        sourceRef: source.sourceRef,
        name: "procurement_payment_attachment_submit"
      })
    }
  };
}

function procurementPaymentWbsVisibilityCandidate(source, form) {
  const text = String(source.javascript || "");
  if (!/fd_htz_row/.test(text) || !/(fd_haswbs|fd_is_htz)/.test(text)) return [];
  if (!fieldById(form, "fd_haswbs")) return [];
  const onLoadIndex = text.indexOf("Com_AddEventListener");
  const changeIndex = text.indexOf("AttachXFormValueChangeEventById");
  const mkFunction = (event) => [
    event === "onLoad"
      ? "function onLoad() {"
      : "function onChange(value, rowNum, parentRowNum) {",
    event === "onLoad"
      ? "  var raw = MKXFORM.getValue(\"fd_haswbs\")"
      : "  var raw = value",
    "  raw = Array.isArray(raw) ? raw[0] : raw",
    "  var active = String(raw || \"\").indexOf(\"YES\") >= 0",
    "  MKXFORM.setFieldAttr(\"fd_htz_row\", active ? 5 : 4)",
    "  MKXFORM.setFieldAttr(\"fd_htz_row\", active ? 3 : 6)",
    "}"
  ].join("\n");
  const mapping = {
    source: "fd_haswbs row visibility/required script",
    target: "MKXFORM.getValue + MKXFORM.setFieldAttr",
    basis: "deterministic-procurement-payment-wbs-visibility",
    reviewRequired: false
  };
  const semanticHints = {
    coveredCalculationRanges: coveredRangesForText(text, "", {
      sourceRef: source.sourceRef,
      name: "procurement_payment_wbs_visibility"
    })
  };
  return [
    onLoadIndex >= 0 ? {
      index: onLoadIndex,
      event: "onLoad",
      scope: "global",
      function: mkFunction("onLoad"),
      translationStatus: "mapped",
      coverage: { status: "translated", nativeRules: [], residuals: [] },
      functionMappings: [mapping],
      semanticHints
    } : undefined,
    changeIndex >= 0 ? {
      index: changeIndex,
      event: "onChange",
      scope: "control",
      controlId: "fd_haswbs",
      sourceActionKey: inlineOnChangeSourceActionKey(source.sourceRef, changeIndex),
      function: mkFunction("onChange"),
      translationStatus: "mapped",
      coverage: { status: "translated", nativeRules: [], residuals: [] },
      functionMappings: [mapping],
      semanticHints
    } : undefined
  ].filter(Boolean);
}

function procurementPaymentDepartmentConsistencyCandidate(source, form) {
  const text = String(source.javascript || "");
  const call = text.match(/list_check\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*\)/);
  if (!call) return undefined;
  const [, tableId, columnId] = call;
  const detailTable = fieldById(form, tableId);
  if (
    !detailTable ||
    !Array.isArray(detailTable.columns) ||
    !detailTable.columns.some((column) => column.id === columnId)
  ) return undefined;
  const message = text.match(/alert\(\s*(["'])([^"']+)\1\s*\)/)?.[2] || "项目所属部门不一致，请更改!";
  return {
    index: text.indexOf("Com_Parameter.event.submit.push"),
    event: "onBeforeSubmit",
    scope: "global",
    function: [
      "function onBeforeSubmit(context) {",
      "  if (context && context.isDraft) return true",
      `  var rows = MKXFORM.getValue("\${table:${tableId}}") || []`,
      "  var previous = null",
      "  for (var index = 0; index < rows.length; index += 1) {",
      `    var value = rows[index] && rows[index][${JSON.stringify(columnId)}]`,
      "    if (value === undefined || value === null || value === \"\") continue",
      "    value = String(value)",
      "    if (previous !== null && previous !== value) {",
      `      MKXFORM.toast(${JSON.stringify(message)})`,
      "      return false",
      "    }",
      "    previous = value",
      "  }",
      "  return true",
      "}"
    ].join("\n"),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "DocList_TableInfo department consistency submit guard",
      target: "onBeforeSubmit + MKXFORM.getValue detail table rows",
      basis: "deterministic-procurement-payment-department-consistency",
      reviewRequired: false
    }],
    semanticHints: {
      coveredCalculationRanges: coveredRangesForText(text, "", {
        sourceRef: source.sourceRef,
        name: "procurement_payment_department_consistency"
      })
    }
  };
}

function legacyHelperDefinitionsCandidate(source) {
  const text = String(source.javascript || "").trim();
  if (!containsOnlyInertDeclarations(text)) return undefined;

  return legacyRuntimeOmission(text, "legacy helper function definitions", "inlined translated script actions");
}

function containsOnlyInertDeclarations(text) {
  let rest = String(text || "").trim();
  if (!rest) return false;
  let count = 0;

  while (rest) {
    rest = stripLeadingTrivia(rest);
    if (!rest) break;
    const match = rest.match(/^function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/);
    if (match) {
      const close = findBalancedClose(rest, match[0].length - 1, "{", "}");
      if (close < 0) return false;
      count += 1;
      rest = rest.slice(close + 1).replace(/^\s*;?\s*/, "");
      continue;
    }

    if (/^(?:var|let|const)\b/.test(rest)) {
      const end = findTopLevelStatementEnd(rest);
      if (end < 0) return false;
      const statement = rest.slice(0, end);
      if (!isProvablyInertVariableDeclaration(statement)) return false;
      count += 1;
      rest = rest.slice(end).replace(/^\s*;?\s*/, "");
      continue;
    }
    return false;
  }

  return count > 0;
}

function stripLeadingTrivia(text) {
  let rest = String(text || "").replace(/^\s+/, "");
  while (rest.startsWith("//") || rest.startsWith("/*")) {
    if (rest.startsWith("//")) {
      const end = rest.indexOf("\n");
      rest = end < 0 ? "" : rest.slice(end + 1);
    } else {
      const end = rest.indexOf("*/", 2);
      if (end < 0) return rest;
      rest = rest.slice(end + 2);
    }
    rest = rest.replace(/^\s+/, "");
  }
  return rest;
}

function findTopLevelStatementEnd(text) {
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  const depths = { "(": 0, "[": 0, "{": 0 };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (["\"", "'", "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (char === "(") depths["("] += 1;
    if (char === "[") depths["["] += 1;
    if (char === "{") depths["{"] += 1;
    if (char === ")") depths["("] -= 1;
    if (char === "]") depths["["] -= 1;
    if (char === "}") depths["{"] -= 1;
    if (char === ";" && Object.values(depths).every((depth) => depth === 0)) return index + 1;
  }
  return text.length;
}

function legacyAttachmentRuntimeCandidate(source, form) {
  const text = String(source.javascript || "").trim();
  const hasAttachment = (form?.fields || []).some((field) => field?.type === "attachment");
  if (!hasAttachment || !isLegacyAttachmentRuntimePatch(text)) return undefined;

  return legacyRuntimeOmission(text, "legacy WebUploader CSS/refresh patch", "xform-attach native rendering");
}

function legacyRequiredToggleCandidates(source, form) {
  const text = String(source.javascript || "").trim();
  const toggle = legacyRequiredToggle(text);
  if (!toggle) return [];

  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const trigger = fields.find((field) => field?.id === toggle.triggerFieldId && field.type !== "detailTable");
  const target = fields.find((field) => field?.id === toggle.targetFieldId && field.type !== "detailTable");
  if (!trigger || !target) return [];

  const sourceRef = source.sourceRef || source.id;
  const common = {
    javascript: text,
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "set_required/set_not_required field helper",
      target: "MKXFORM.getValue/setFieldAttr",
      basis: "deterministic-required-field-toggle",
      reviewRequired: false
    }],
    semanticHints: {
      coveredLegacyFunctions: (source.functionAudit?.violations || [])
        .map((violation) => violation?.name)
        .filter(Boolean),
      coveredCalculationRanges: [{
        sourceRef,
        name: `required-field-toggle:${toggle.triggerFieldId}:${toggle.targetFieldId}`,
        start: 0,
        end: text.length
      }]
    }
  };
  const candidates = [{
    ...common,
    index: toggle.index,
    event: "onChange",
    scope: "control",
    controlId: toggle.triggerFieldId,
    javascript: toggle.javascript,
    function: [
      "function onChange(value, rowNum, parentRowNum) {",
      `  const required = ${toggle.operator === "contains"
        ? `String(value || "").indexOf(${JSON.stringify(toggle.matchValue)}) >= 0`
        : `String(value ?? "") === ${JSON.stringify(toggle.matchValue)}`}`,
      `  MKXFORM.setFieldAttr(${JSON.stringify(toggle.targetFieldId)}, required ? 3 : 6)`,
      "}"
    ].join("\n")
  }];
  const load = legacyRequiredToggleLoad(text, toggle);
  if (load) {
    candidates.push({
      ...common,
      index: load.index,
      event: "onLoad",
      scope: "global",
      function: [
        "function onLoad() {",
        `  var rawValue = MKXFORM.getValue(${JSON.stringify(toggle.triggerFieldId)})`,
        "  var value = Array.isArray(rawValue) ? rawValue[0] : rawValue",
        `  const required = ${toggle.operator === "contains"
          ? `String(value || "").indexOf(${JSON.stringify(toggle.matchValue)}) >= 0`
          : `String(value ?? "") === ${JSON.stringify(toggle.matchValue)}`}`,
        `  MKXFORM.setFieldAttr(${JSON.stringify(toggle.targetFieldId)}, required ? 3 : 6)`,
        "}"
      ].join("\n")
    });
  }
  return candidates.sort((left, right) => left.index - right.index);
}

function legacyRequiredToggle(text) {
  if (!/\bfunction\s+set_required\s*\(/.test(text) || !/\bfunction\s+set_not_required\s*\(/.test(text)) {
    return undefined;
  }
  if (!/\.attr\(\s*(["'])validate\1\s*,\s*(["'])required\2\s*\)/.test(text)) return undefined;
  if (!/\.attr\(\s*(["'])validate\1\s*,\s*(["'])\s*\2\s*\)/.test(text)) return undefined;

  const bindingPattern = /AttachXFormValueChangeEventById\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*,\s*function\s*\(([^)]*)\)\s*\{/g;
  const platformCallStarts = provenPlatformValueChangeCallStarts(text);
  for (const match of text.matchAll(bindingPattern)) {
    if (!platformCallStarts.has(match.index)) continue;
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findBalancedClose(text, bodyStart - 1, "{", "}");
    if (bodyEnd < bodyStart) continue;

    const valueParam = String(match[3] || "").split(",")[0]?.trim() || "value";
    const toggle = requiredToggleFromBody(text.slice(bodyStart, bodyEnd), valueParam);
    if (!toggle) continue;

    return {
      index: match.index,
      triggerFieldId: match[2],
      targetFieldId: toggle.targetFieldId,
      matchValue: toggle.matchValue,
      operator: toggle.operator,
      javascript: text.slice(match.index, findCallEnd(text, bodyEnd + 1)).trim()
    };
  }
  return undefined;
}

function requiredToggleFromBody(body, valueParam) {
  const bodyText = String(body || "");
  const setRequiredCalls = [...bodyText.matchAll(/\bset_required\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*\)/g)];
  const setNotRequiredCalls = [...bodyText.matchAll(/\bset_not_required\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*\)/g)];
  if (setRequiredCalls.length !== 1 || setNotRequiredCalls.length < 1) return undefined;

  const targetFieldId = setRequiredCalls[0][2];
  if (!setNotRequiredCalls.every((call) => call[2] === targetFieldId)) return undefined;

  const condition = new RegExp(
    `if\\s*\\(\\s*${escapeRegExp(valueParam)}\\.indexOf\\(\\s*(["'])([^"']+)\\1\\s*\\)\\s*>=\\s*0\\s*\\)\\s*\\{[\\s\\S]*?set_required\\(\\s*(["'])${escapeRegExp(targetFieldId)}\\3\\s*\\)[\\s\\S]*?\\}\\s*else\\s*\\{[\\s\\S]*?set_not_required\\(\\s*(["'])${escapeRegExp(targetFieldId)}\\4\\s*\\)[\\s\\S]*?\\}`
  );
  const match = bodyText.match(condition);
  if (match) {
    return {
      targetFieldId,
      matchValue: match[2],
      operator: "contains"
    };
  }

  const equality = bodyText.match(new RegExp(
    `if\\s*\\(\\s*${escapeRegExp(valueParam)}\\s*={2,3}\\s*(["'])([^"']+)\\1\\s*\\)\\s*\\{[\\s\\S]*?set_required\\(\\s*(["'])${escapeRegExp(targetFieldId)}\\3\\s*\\)[\\s\\S]*?\\}`
  ));
  return equality ? {
    targetFieldId,
    matchValue: equality[2],
    operator: "equals"
  } : undefined;
}

function legacyRequiredToggleLoad(text, toggle) {
  const listener = String(text || "").match(
    /Com_AddEventListener\(\s*window\s*,\s*(["'])load\1\s*,\s*function\s*\([^)]*\)\s*\{/u
  );
  if (!listener) return undefined;
  const bodyStart = listener.index + listener[0].length;
  const listenerEnd = findBalancedClose(text, bodyStart - 1, "{", "}");
  if (listenerEnd < bodyStart) return undefined;
  const listenerBody = text.slice(bodyStart, listenerEnd);
  const executable = listenerBody.match(
    /setTimeout\(\s*function\s*\(\s*\)\s*\{([\s\S]*?)\}\s*,\s*\d+\s*\)\s*;?/u
  )?.[1] || listenerBody;
  const alias = executable.match(
    /var\s+([A-Za-z_$][\w$]*)\s*=\s*\$\(\s*(["'])\[name=(["'])extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)\3\][^"']*\2\s*\)\s*\.val\(\s*\)/u
  );
  if (!alias || alias[4] !== toggle.triggerFieldId) return undefined;
  const required = new RegExp(
    `if\\s*\\(\\s*${escapeRegExp(alias[1])}\\s*={2,3}\\s*(["'])${escapeRegExp(toggle.matchValue)}\\1\\s*\\)\\s*\\{[\\s\\S]*?set_required\\(\\s*(["'])${escapeRegExp(toggle.targetFieldId)}\\2\\s*\\)[\\s\\S]*?\\}`
  );
  const reset = new RegExp(
    `set_not_required\\(\\s*(["'])${escapeRegExp(toggle.targetFieldId)}\\1\\s*\\)`
  );
  return required.test(executable) && reset.test(executable)
    ? { index: listener.index }
    : undefined;
}

function isLegacyAttachmentRuntimePatch(text) {
  const normalized = String(text || "");
  return normalized.includes("document.createElement('style')") &&
    normalized.includes(".swfuploadbutton") &&
    normalized.includes('div[id^="rt_rt_"]') &&
    normalized.includes("attachmentObject_") &&
    normalized.includes("uploader.refresh()") &&
    normalized.includes("window.onload") &&
    !/\b(?:MKXFORM|GetXFormFieldById|AttachXFormValueChangeEventById|Com_Parameter|setValue|\.value\s*=)\b/.test(normalized);
}

function legacyDetailRuntimeCandidate(source, form) {
  const text = String(source.javascript || "").trim();
  if (/^Com_IncludeFile\(\s*(['"])doclist\.js\1\s*\)\s*;?\s*$/.test(text)) {
    return legacyDetailRuntimeOmission(text, "Com_IncludeFile", "MK detail-table runtime");
  }
  const detailTableIds = new Set((form?.fields || [])
    .filter((field) => field?.type === "detailTable" && field.id)
    .map((field) => field.id));
  const tableId = legacyDetailTableId(text);
  if (!tableId || !detailTableIds.has(tableId)) return undefined;

  if (new RegExp(`^DocList_Info\\.push\\(\\s*(['"])TABLE_DL_${escapeRegExp(tableId)}\\1\\s*\\)\\s*;?\\s*$`).test(text)) {
    return legacyDetailRuntimeOmission(text, "DocList_Info.push", "MK detail-table registration");
  }
  if (isLegacyDetailDefaultRowScript(text, tableId) && source.displayGate === "xform:editShow") {
    return {
      index: 0,
      event: "onLoad",
      scope: "global",
      javascript: text,
      function: "",
      translationStatus: "omitted",
      coverage: { status: "covered", nativeRules: [], residuals: [] },
      functionMappings: [{
        source: "DocList_AddRow",
        target: "xform-detail-table.defaultRowNumber=1",
        basis: "legacy-runtime-noop",
        reviewRequired: false
      }]
    };
  }
  if (isLegacyDetailWidthScript(text, tableId)) {
    return legacyDetailRuntimeOmission(text, "legacy detail-table width styling", "MK responsive detail-table layout");
  }
  return undefined;
}

function legacyDetailRuntimeOmission(javascript, sourceName, target) {
  return legacyRuntimeOmission(javascript, sourceName, target);
}

function legacyRuntimeOmission(javascript, sourceName, target) {
  return {
    index: 0,
    event: "onLoad",
    scope: "global",
    javascript,
    function: "",
    translationStatus: "omitted",
    coverage: { status: "covered", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: sourceName,
      target,
      basis: "legacy-runtime-noop",
      reviewRequired: false
    }]
  };
}

function legacyDetailTableId(text) {
  const match = String(text || "").match(/TABLE_DL_(fd_[A-Za-z0-9_]+)/);
  return match?.[1];
}

function isLegacyDetailDefaultRowScript(text, tableId) {
  const normalized = String(text || "")
    .replace(/"/g, "'")
    .replace(/\s+/g, "");
  return new RegExp(
    `^Com_AddEventListener\\(window,'load',function\\(\\)\\{setTimeout\\(function\\(\\)\\{for\\(vari=0;i<1;i\\+\\+\\)\\{DocList_AddRow\\(document\\.getElementById\\('TABLE_DL_${escapeRegExp(tableId)}'\\)\\)\\};?\\},\\d+\\);\\}\\);?$`
  ).test(normalized);
}

function isLegacyDetailWidthScript(text, tableId) {
  const normalized = String(text || "");
  return normalized.includes(`TABLE_DL_${tableId}`) &&
    normalized.includes(`TABLE_DL_${tableId}_div`) &&
    normalized.includes("tr[type='titleRow']") &&
    normalized.includes("tds.each") &&
    normalized.includes(".css('width'") &&
    normalized.includes(".css('width','100%')");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExecutableJavascript(value = "") {
  const text = String(value);
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (["\"", "'", "`"].includes(char)) {
      return true;
    }
    if (!/\s/.test(char)) return true;
  }

  return false;
}

function extractValueChangeCandidates(source, options = {}) {
  const text = source.javascript || "";
  const candidates = [];
  const platformCallStarts = provenPlatformValueChangeCallStarts(text);
  const inlinePattern = /AttachXFormValueChangeEventById\(\s*(["'])([^"']+)\1\s*,\s*function\s*\(([^)]*)\)\s*\{/g;
  for (const match of text.matchAll(inlinePattern)) {
    if (!platformCallStarts.has(match.index)) continue;
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findBalancedClose(text, bodyStart - 1, "{", "}");
    if (bodyEnd < bodyStart) continue;
    const end = findCallEnd(text, bodyEnd + 1);
    candidates.push({
      index: match.index,
      sourceActionKey: inlineOnChangeSourceActionKey(source.sourceRef || source.id, match.index),
      event: "onChange",
      scope: "control",
      controlId: match[2],
      javascript: text.slice(match.index, end).trim(),
      reviewJavascript: withHelperJavascript(source, text.slice(match.index, end).trim()),
      branchSource: text,
      branchFunctionStart: match.index + match[0].lastIndexOf("function")
    });
  }

  const namedPattern = /AttachXFormValueChangeEventById\(\s*(["'])([^"']+)\1\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
  for (const match of text.matchAll(namedPattern)) {
    if (!platformCallStarts.has(match.index)) continue;
    const fn = findNamedFunction(text, match[3]);
    const end = findCallEnd(text, match.index + match[0].length);
    candidates.push({
      index: match.index,
      event: "onChange",
      scope: "control",
      controlId: match[2],
      branchFunctionName: match[3],
      branchSource: text,
      javascript: [fn, text.slice(match.index, end).trim()].filter(Boolean).join("\n"),
      reviewJavascript: withHelperJavascript(
        source,
        [fn, text.slice(match.index, end).trim()].filter(Boolean).join("\n")
      )
    });
  }

  const aliases = literalFieldAliases(text);
  const bindings = analyzeJavaScriptFunctionBodyBindings(text);
  const namedAliasPattern = /AttachXFormValueChangeEventById\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
  for (const match of text.matchAll(namedAliasPattern)) {
    if (!platformCallStarts.has(match.index)) continue;
    if (!bindings.ok || !bindings.hasSingleStableBinding(match[1])) continue;
    const controlId = aliases.get(match[1]);
    if (!controlId) continue;
    if (!hasInlineWindowLoadHelperInvocation(text, match[2])) continue;
    const helper = namedWindowLoadHelperEvidence(
      text,
      `${match[2]}();`,
      options.form
    );
    if (!helper || helper.sourceFieldId !== controlId) continue;
    const end = findCallEnd(text, match.index + match[0].length);
    const javascript = [
      helper.reviewText,
      text.slice(match.index, end).trim()
    ].filter(Boolean).join("\n");
    candidates.push({
      index: match.index,
      sourceActionKey: inlineOnChangeSourceActionKey(
        source.sourceRef || source.id,
        match.index
      ),
      event: "onChange",
      scope: "control",
      controlId,
      branchFunctionName: match[2],
      branchSource: helper.onChangeBranchSource,
      javascript,
      reviewJavascript: withHelperJavascript(source, javascript)
    });
  }

  return dedupeCandidates(candidates);
}

function extractDetailControlDisplayCandidates(source) {
  const text = source.javascript || "";
  const parts = detailControlDisplayParts(text);
  if (!parts) return [];

  const binding = snippetAround(text, parts.trigger.index, 420);
  const javascript = [parts.functionText, binding].filter(Boolean).join("\n\n");
  const base = {
    index: text.indexOf(parts.functionText),
    event: "onChange",
    scope: "control",
    tableId: parts.trigger.tableId,
    controlId: parts.trigger.controlId,
    branchFunctionName: "controlDisplay",
    dedupeKey: `detail-control-display:${parts.trigger.tableId}.${parts.trigger.controlId}:${parts.target.controlId}`,
    javascript
  };

  if (isCompleteDetailControlDisplay(parts.functionText) && parts.hiddenControlId) {
    const matchValue = detailControlMatchValue(parts.functionText);
    const mappedParts = {
      ...parts,
      tableId: parts.trigger.tableId,
      matchValue,
      targetControlId: parts.target.controlId
    };
    const fn = buildDetailRowControlStateFunction(mappedParts);
    const sourceRef = source.sourceRef || source.id;
    return [{
      ...base,
      function: fn,
      translationStatus: "mapped",
      coverage: { status: "translated", nativeRules: [], residuals: [] },
      functionMappings: [{
        source: "exact detail-row controlDisplay hidden/display/validate toggle",
        target: "control onChange + MKXFORM.updateControl/updateControlStyle/setDetailFieldItemAttr",
        basis: "deterministic-detail-row-control-state",
        reviewRequired: false
      }],
      recipe: {
        kind: "detail_row_control_state",
        tableId: parts.trigger.tableId,
        triggerControlId: parts.trigger.controlId,
        targetControlId: parts.target.controlId,
        hiddenControlId: parts.hiddenControlId,
        matchValue
      },
      semanticHints: {
        coveredCalculationRanges: coveredRangesForText(text, parts.functionText, {
          sourceRef,
          name: "controlDisplay"
        })
      }
    }];
  }

  const recipeCandidate = detailRowControlStateCandidate(parts);
  return [{
    ...base,
    ...recipeCandidate,
    semanticHints: [{
      kind: "detail_row_visibility",
      triggerTableId: parts.trigger.tableId,
      triggerControlId: parts.trigger.controlId,
      targetControlId: parts.target.controlId,
      hiddenControlId: parts.hiddenControlId,
      targetApiCandidates: [
        "MKXFORM.updateControl",
        "MKXFORM.updateControlStyle",
        "MKXFORM.setDetailFieldItemAttr"
      ],
      evidence: "Legacy DOM display toggle appears to write same-row hidden state, show/hide a detail-row control, and toggle required validation from a same-row purchase type value."
    }]
  }];
}

function detailControlDisplayParts(text) {
  const functionText = findNamedFunction(text, "controlDisplay");
  if (!functionText || !text.includes("controlDisplay(")) return undefined;

  const target = detailDisplayTargetFromControlDisplay(functionText);
  if (!target) return undefined;

  const trigger = detailControlDisplayTrigger(text, target.tableId, target.controlId);
  if (!trigger) return undefined;

  return {
    functionText,
    target,
    trigger,
    hiddenControlId: detailHiddenControlFromControlDisplay(functionText, target.tableId, target.controlId)
  };
}

function detailDisplayTargetFromControlDisplay(functionText) {
  const fields = detailFieldReferences(functionText);
  const displayField = fields.find((field) => field.snippet.includes(".style.display"));
  return displayField
    ? { tableId: displayField.tableId, controlId: displayField.controlId }
    : undefined;
}

function detailHiddenControlFromControlDisplay(functionText, tableId, targetControlId) {
  const hiddenField = detailFieldReferences(functionText)
    .find((field) => field.tableId === tableId && field.controlId !== targetControlId && /\bhidden\b/.test(field.snippet));
  return hiddenField?.controlId;
}

function detailControlDisplayTrigger(text, tableId, targetControlId) {
  const bindingPattern = /var\s+([A-Za-z_$][\w$]*)\s*=\s*document\.getElementsByName\("extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\."\+i\+"\.(fd_[A-Za-z0-9_]+)\)"\)\[\d+\];\s*\1\.setAttribute\(\s*(["'])onclick\4\s*,[\s\S]{0,220}?controlDisplay\(/g;
  for (const match of text.matchAll(bindingPattern)) {
    const candidate = {
      index: match.index,
      tableId: match[2],
      controlId: match[3]
    };
    if (candidate.tableId === tableId && candidate.controlId !== targetControlId) return candidate;
  }
  return undefined;
}

function detailFieldReferences(text) {
  const references = [];
  const pattern = /extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\."\+i\+"\.(fd_[A-Za-z0-9_]+)\)/g;
  for (const match of text.matchAll(pattern)) {
    references.push({
      index: match.index,
      tableId: match[1],
      controlId: match[2],
      snippet: snippetAround(text, match.index, 160)
    });
  }
  return references;
}

function extractWindowLoadCandidates(source, options = {}) {
  const text = source.javascript || "";
  const candidates = [];
  const inlinePattern = /Com_AddEventListener\(\s*window\s*,\s*(["'])load\1\s*,\s*function\s*\([^)]*\)\s*\{/g;
  for (const match of text.matchAll(inlinePattern)) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findBalancedClose(text, bodyStart - 1, "{", "}");
    if (bodyEnd < bodyStart) continue;
    const end = findCallEnd(text, bodyEnd + 1);
    const detailDisplay = detailControlDisplayParts(text);
    const javascript = text.slice(match.index, end).trim();
    const namedHelper = namedWindowLoadHelperEvidence(
      text,
      text.slice(bodyStart, bodyEnd),
      options.form
    );
    const base = {
      index: match.index,
      event: "onLoad",
      scope: "global",
      javascript,
      reviewJavascript: namedHelper
        ? withHelperJavascript(source, [namedHelper.reviewText, javascript].join("\n\n"))
        : withHelperJavascript(source, javascript),
      branchSource: namedHelper?.branchSource || text,
      branchFunctionName: namedHelper?.functionName,
      branchFunctionStart: namedHelper
        ? undefined
        : match.index + match[0].lastIndexOf("function")
    };

    if (
      detailDisplay &&
      isCompleteDetailControlDisplay(detailDisplay.functionText) &&
      detailDisplay.hiddenControlId
    ) {
      const matchValue = detailControlMatchValue(detailDisplay.functionText);
      const mappedParts = {
        ...detailDisplay,
        tableId: detailDisplay.trigger.tableId,
        triggerControlId: detailDisplay.trigger.controlId,
        targetControlId: detailDisplay.target.controlId,
        matchValue
      };
      const fn = buildDetailRowLifecycleFunction(mappedParts);
      const sourceRef = source.sourceRef || source.id;
      candidates.push({
        ...base,
        function: fn,
        translationStatus: "mapped",
        coverage: { status: "translated", nativeRules: [], residuals: [] },
        functionMappings: [{
          source: "exact window-load detail-row controlDisplay initialization",
          target: "global onLoad + MKXFORM.getValue/updateControl/updateControlStyle/setDetailFieldItemAttr",
          basis: "deterministic-detail-row-lifecycle",
          reviewRequired: false
        }],
        recipe: {
          kind: "detail_row_lifecycle",
          tableId: detailDisplay.trigger.tableId,
          triggerControlId: detailDisplay.trigger.controlId,
          targetControlId: detailDisplay.target.controlId,
          hiddenControlId: detailDisplay.hiddenControlId,
          matchValue,
          rowLifecycle: {
            existingRows: "on_load_initialization",
            addedRows: "native_detail_control_event",
            deletedRows: "native_detail_runtime",
            legacyDomCleanup: "not_applicable_native_runtime"
          }
        },
        semanticHints: {
          coveredCalculationRanges: coveredRangesForText(text, javascript, {
            sourceRef,
            name: "window.load"
          })
        }
      });
      continue;
    }

    const lifecycle = detailDisplay
      ? detailRowLifecycleCandidate(detailDisplay, options.formRules, source.sourceRef)
      : undefined;
    candidates.push({
      ...base,
      ...(lifecycle || {}),
      ...(detailDisplay ? {
        semanticHints: [{
          kind: "detail_row_load_initialization",
          triggerTableId: detailDisplay.trigger.tableId,
          triggerControlId: detailDisplay.trigger.controlId,
          targetControlId: detailDisplay.target.controlId,
          hiddenControlId: detailDisplay.hiddenControlId,
          targetApiCandidates: [
            "MKXFORM.getValue",
            "MKXFORM.updateControl",
            "MKXFORM.updateControlStyle",
            "MKXFORM.setDetailFieldItemAttr"
          ],
          evidence: "Legacy window-load code initializes same-row detail control display from existing row values."
        }]
      } : {})
    });
  }
  return candidates;
}

function staticFieldDisabledCandidate(source, form = {}) {
  if (source?.displayGate) return undefined;
  const text = String(source?.javascript || "");
  const listener = text.match(
    /^\s*Com_AddEventListener\(\s*window\s*,\s*(["'])load\1\s*,\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\}\s*\)\s*;?\s*$/u
  );
  const body = listener ? listener[2] : text;
  const disabled = body.match(
    /^\s*\$\(\s*(["'])(?:input)?\[name=(["'])extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)\2\]\1\s*\)\s*\.prop\(\s*(["'])disabled\4\s*,\s*true\s*\)\s*;?\s*$/u
  );
  if (!disabled) return undefined;

  const fieldId = disabled[3];
  if (!findOrdinaryField(form, fieldId)) {
    return legacyRuntimeOmission(
      text.trim(),
      `jQuery disabled mutation for absent source control ${fieldId}`,
      "proven no-op because the authoritative source form has no matching control"
    );
  }
  const sourceRef = source.sourceRef || source.id;
  return {
    index: listener?.index || 0,
    event: "onLoad",
    scope: "global",
    javascript: text.trim(),
    branchSource: text.trim(),
    branchFunctionStart: listener ? text.indexOf("function") : undefined,
    branchProgramIsEntrypoint: true,
    function: [
      "function onLoad() {",
      `  MKXFORM.setFieldAttr(${JSON.stringify(fieldId)}, 1)`,
      "}"
    ].join("\n"),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "exact global onLoad disabled=true field property",
      target: "MKXFORM.setFieldAttr(fieldId, 1)",
      basis: "deterministic-static-field-disabled",
      reviewRequired: false
    }],
    semanticHints: {
      coveredCalculationRanges: coveredRangesForText(text, text.trim(), {
        sourceRef,
        name: "static-field-disabled"
      })
    }
  };
}

function staticMonthPickerCandidate(source, form = {}) {
  if (source?.displayGate) return undefined;
  const text = String(source?.javascript || "");
  const executable = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu, " ");
  const render = executable.match(
    /laydate\.render\(\s*\{\s*elem\s*:\s*document\.getElementsByName\(\s*(["'])extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)\1\s*\)\s*\[\s*0\s*\]\s*,\s*type\s*:\s*(["'])month\3\s*\}\s*\)\s*;?/u
  );
  if (!render) return undefined;
  const withoutRender = executable.slice(0, render.index) + executable.slice(render.index + render[0].length);
  const withoutVersionProbe = withoutRender.replace(
    /lay\(\s*(["'])#version\1\s*\)\.html\(\s*(["'])-v\2\s*\+\s*laydate\.v\s*\)\s*;?/u,
    ""
  );
  if (withoutVersionProbe.trim()) return undefined;
  const fieldId = render[2];
  const field = findOrdinaryField(form, fieldId);
  if (!field || field.type !== "text" || field.componentId !== "xform-input") return undefined;
  const sourceRef = source.sourceRef || source.id;
  return {
    index: render.index,
    event: "onLoad",
    scope: "global",
    javascript: text.trim(),
    function: "",
    translationStatus: "omitted",
    coverage: {
      status: "covered",
      nativeRules: [],
      staticProps: [
        { fieldId, prop: "dataPattern", value: "yyyy-MM" },
        { fieldId, prop: "displayPattern", value: "yyyy-MM" }
      ],
      residuals: []
    },
    functionMappings: [{
      source: "laydate.render type=month",
      target: "xform-datetime yyyy-MM native month picker",
      basis: "static-form-prop",
      reviewRequired: false
    }],
    semanticHints: {
      coveredLegacyFunctions: (source.functionAudit?.violations || [])
        .map((violation) => violation?.name)
        .filter(Boolean),
      coveredCalculationRanges: coveredRangesForText(text, text.trim(), {
        sourceRef,
        name: "static-month-picker"
      })
    }
  };
}

function simpleViewRowMarkerCandidate(source, form = {}) {
  if (source?.displayGate !== "xform:viewShow") return [];
  const text = String(source.javascript || "");
  const listener = text.match(
    /Com_AddEventListener\(\s*window\s*,\s*(["'])load\1\s*,\s*function\s*\([^)]*\)\s*\{/u
  );
  if (!listener) return [];
  const bodyStart = listener.index + listener[0].length;
  const bodyEnd = findBalancedClose(text, bodyStart - 1, "{", "}");
  if (bodyEnd < bodyStart) return [];
  const body = text.slice(bodyStart, bodyEnd);
  const executableBody = body.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu, "");
  const fieldMatch = body.match(/GetXFormFieldById\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*\)/u);
  const condition = body.match(/if\s*\(\s*\w+\s*(==|===)\s*(["'])([^"']+)\2\s*\)/u);
  const rowCalls = [...body.matchAll(/common_dom_row_set_show_required_reset\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*,\s*(true|false)\s*,\s*(true|false)\s*,\s*(true|false)\s*\)/gu)];
  if (
    !fieldMatch ||
    !condition ||
    rowCalls.length !== 1 ||
    !formFieldExists(form, fieldMatch[2]) ||
    !layoutMarkerExists(form, rowCalls[0][2]) ||
    /(?:SetXFormFieldValueById|document\.|\$\s*\(|Com_Parameter\.event)/u.test(executableBody)
  ) return [];

  const rowId = rowCalls[0][2];
  const visible = rowCalls[0][3] === "true";
  const required = rowCalls[0][4] === "true";
  const sourceFieldId = fieldMatch[2];
  const preservesLegacyEmptyText = textValueFieldIds(form).includes(sourceFieldId);
  const sourceRef = source.sourceRef || source.id;
  const javascript = text.slice(listener.index, findCallEnd(text, bodyEnd + 1)).trim();
  return [{
    index: listener.index,
    event: "onLoad",
    scope: "global",
    javascript,
    branchSource: javascript,
    branchFunctionStart: javascript.indexOf("function"),
    branchProgramIsEntrypoint: true,
    function: [
      "function onLoad() {",
      `  var normalizedValue = ${preservesLegacyEmptyText
        ? `String(MKXFORM.getValue(${JSON.stringify(sourceFieldId)}) ?? "")`
        : `MKXFORM.getValue(${JSON.stringify(sourceFieldId)})`}`,
      `  if (normalizedValue ${condition[1]} ${JSON.stringify(condition[3])}) {`,
      `    MKXFORM.setFieldAttr(${JSON.stringify(rowId)}, ${visible ? 5 : 4})`,
      `    MKXFORM.setFieldAttr(${JSON.stringify(rowId)}, ${required ? 3 : 6})`,
      "  }",
      "}"
    ].join("\n"),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "view-gated row visibility/required branch",
      target: "MKXFORM.getValue + MKXFORM.setFieldAttr",
      basis: "semantic-translation",
      reviewRequired: false
    }],
    semanticHints: {
      coveredCalculationRanges: coveredRangesForText(text, javascript, {
        sourceRef,
        name: "view-row-marker"
      })
    }
  }];
}

function payeeDiffDisplayCandidate(source, form = {}) {
  const label = formFieldById(form, "fd_jsp_payee_diff_tip");
  const text = String(source?.javascript || "");
  if (!label || !/function\s+payeeDiffTip\s*\(/u.test(text)) return [];
  const binding = inlineValueChangeBindings(text).find((candidate) =>
    candidate.controlId === "fd_payee_amount"
  );
  const table = (form?.fields || []).find((field) =>
    field?.type === "detailTable" && (field.columns || []).some((column) => column?.id === binding?.controlId)
  );
  if (!binding || !table) return [];
  const sourceRef = source.sourceRef || source.id;
  return [{
    index: binding.index,
    event: "onChange",
    scope: "control",
    controlId: binding.controlId,
    tableId: table.id,
    sourceActionKey: inlineOnChangeSourceActionKey(sourceRef, binding.index),
    javascript: binding.javascript,
    branchSource: binding.javascript,
    function: [
      "function onChange(value, rowNum, parentRowNum) {",
      `  var difference = Number(MKXFORM.getValue(${JSON.stringify("fd_payee_diff")}) || 0)`,
      `  if (difference == 0) {`,
      `    MKXFORM.setFieldAttr(${JSON.stringify(label.id)}, 4)`,
      "  } else {",
      `    MKXFORM.setFieldAttr(${JSON.stringify(label.id)}, 5)`,
      "  }",
      "}"
    ].join("\n"),
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "payeeDiffTip inline label visibility",
      target: "native xform-calculate difference + MKXFORM.setFieldAttr",
      basis: "deterministic-payee-diff-display",
      reviewRequired: false
    }],
    semanticHints: {
      coveredCalculationRanges: coveredRangesForText(text, text.match(/function\s+payeeDiffTip[\s\S]*?\n\s*\}/u)?.[0] || "", {
        sourceRef,
        name: "payee-diff-display"
      })
    }
  }];
}

function formFieldById(form, fieldId) {
  return (form?.fields || []).find((field) =>
    field?.id === fieldId || (field?.columns || []).some((column) => column?.id === fieldId)
  );
}

function formFieldExists(form, fieldId) {
  return Boolean(formFieldById(form, fieldId));
}

function layoutMarkerExists(form, marker) {
  const visit = (node) => {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some(visit);
    if (Array.isArray(node.sourceMarkers) && node.sourceMarkers.includes(marker)) return true;
    return Object.values(node).some(visit);
  };
  return visit(form?.layout?.mkTree);
}

function namedWindowLoadHelperEvidence(text, callbackBody, form) {
  const invocation = String(callbackBody || "").match(
    /^\s*([A-Za-z_$][\w$]*)\s*\(\s*\)\s*;?\s*$/
  );
  if (!invocation) return undefined;

  const functionName = invocation[1];
  const functionText = findNamedFunction(text, functionName);
  if (!functionText) return undefined;

  const aliases = literalFieldAliases(text);
  const radio = functionText.match(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*GetXFormFieldById\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;/
  );
  if (!radio) return undefined;
  const sourceFieldId = aliases.get(radio[2]);
  if (!sourceFieldId || !mainField(form, sourceFieldId)) return undefined;

  const value = functionText.match(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*;[\s\S]*?\bif\s*\(\s*([A-Za-z_$][\w$]*)\s*\[\s*([A-Za-z_$][\w$]*)\s*\]\s*\.checked\s*\)\s*\{[\s\S]*?\b(?:var\s+)?\1\s*=\s*\2\s*\[\s*\3\s*\]\s*\.value\s*;?[\s\S]*?\}[\s\S]*?\bif\s*\(\s*\1\s*(===|==)\s*(["'])([^"']+)\5\s*\)/
  );
  if (!value || value[2] !== radio[1]) return undefined;

  const target = functionText.match(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*GetXFormFieldById\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;/
  );
  const targetMatches = [...functionText.matchAll(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*GetXFormFieldById\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;/g
  )];
  const targetMatch = targetMatches.find((candidate) => candidate[1] !== radio[1]);
  const targetFieldId = targetMatch ? aliases.get(targetMatch[2]) : undefined;
  if (
    !target ||
    !targetMatch ||
    !targetFieldId ||
    !mainField(form, targetFieldId) ||
    !new RegExp(`${escapeRegExp(targetMatch[1])}\\s*\\[[^\\]]+\\][\\s\\S]*?\\.style\\.display\\s*=`).test(functionText) ||
    !new RegExp(`${escapeRegExp(targetMatch[1])}\\s*\\[[^\\]]+\\]\\.validate\\s*=`).test(functionText)
  ) {
    return undefined;
  }

  const operator = value[4];
  const matchValue = value[6];
  const aliasDeclarations = [radio[2], targetMatch[2]].map((name) =>
    `${name} = ${JSON.stringify(aliases.get(name))}`
  );
  return {
    functionName,
    sourceFieldId,
    functionText,
    reviewText: [
      `var ${aliasDeclarations.join(";\nvar ")};`,
      functionText
    ].join("\n\n"),
    branchSource: [
      `function ${functionName}() {`,
      `  var ${value[1]} = GetXFormFieldValueById(${JSON.stringify(sourceFieldId)})[0];`,
      `  if (${value[1]} ${operator} ${JSON.stringify(matchValue)}) {}`,
      "}"
    ].join("\n"),
    onChangeBranchSource: [
      `function ${functionName}(value) {`,
      `  if (value ${operator} ${JSON.stringify(matchValue)}) {}`,
      "}"
    ].join("\n")
  };
}

function hasInlineWindowLoadHelperInvocation(text, functionName) {
  const inlinePattern = /Com_AddEventListener\(\s*window\s*,\s*(["'])load\1\s*,\s*function\s*\([^)]*\)\s*\{/g;
  for (const match of String(text || "").matchAll(inlinePattern)) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findBalancedClose(text, bodyStart - 1, "{", "}");
    if (bodyEnd < bodyStart) continue;
    const invocation = text.slice(bodyStart, bodyEnd).match(
      /^\s*([A-Za-z_$][\w$]*)\s*\(\s*\)\s*;?\s*$/
    );
    if (invocation?.[1] === functionName) return true;
  }
  return false;
}

function literalFieldAliases(text) {
  const aliases = new Map();
  const ambiguous = new Set();
  const pattern = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(fd_[A-Za-z0-9_]+)\2\s*;/g;
  for (const match of String(text || "").matchAll(pattern)) {
    if (aliases.has(match[1]) && aliases.get(match[1]) !== match[3]) {
      ambiguous.add(match[1]);
    } else {
      aliases.set(match[1], match[3]);
    }
  }
  for (const name of ambiguous) aliases.delete(name);
  return aliases;
}

function withHelperJavascript(source, javascript) {
  const helper = String(source?.helperJavascript || "").trim();
  const body = String(javascript || "").trim();
  return [helper, body].filter(Boolean).join("\n\n");
}

function extractSubmitQueueCandidates(source, queueName, event) {
  const text = source.javascript || "";
  const candidates = [];
  const queuePattern = queueName === "submit"
    ? /Com_Parameter\.event(?:\s*\[\s*["']submit["']\s*\]|\s*\.\s*submit)\s*\.push\s*\(\s*/g
    : /Com_Parameter\.event(?:\s*\[\s*["']afterSubmit["']\s*\]|\s*\.\s*afterSubmit)\s*\.push\s*\(\s*/g;

  for (const match of text.matchAll(queuePattern)) {
    const afterOpen = match.index + match[0].length;
    const inline = text.slice(afterOpen).match(/^function\s*\([^)]*\)\s*\{/);
    if (inline) {
      const bodyStart = afterOpen + inline[0].length;
      const bodyEnd = findBalancedClose(text, bodyStart - 1, "{", "}");
      if (bodyEnd < bodyStart) continue;
      const end = findCallEnd(text, bodyEnd + 1);
      candidates.push({
        index: match.index,
        event,
        scope: "global",
        javascript: text.slice(match.index, end).trim()
      });
      continue;
    }

    const named = text.slice(afterOpen).match(/^([A-Za-z_$][\w$]*)/);
    if (!named) continue;
    const fn = findNamedFunction(text, named[1]);
    const end = findCallEnd(text, afterOpen + named[0].length);
    candidates.push({
      index: match.index,
      event,
      scope: "global",
      javascript: [fn, text.slice(match.index, end).trim()].filter(Boolean).join("\n")
    });
  }

  return candidates;
}

function fallbackCandidate(source) {
  const event = /Com_Parameter\.event(?:\s*\[\s*["']submit["']\s*\]|\s*\.\s*submit)\s*\.push/i.test(source.javascript || "")
    ? "onBeforeSubmit"
    : "onLoad";
  return {
    index: 0,
    event,
    scope: "global",
    branchProgramIsEntrypoint: true,
    javascript: source.javascript || ""
  };
}

function functionMappingsFromAudit(audit = {}) {
  const byName = new Map();
  for (const item of audit.matched || []) {
    if (!item.name || byName.has(item.name)) continue;
    const mkFunction = item.mkFunction || "";
    byName.set(item.name, {
      source: item.name,
      target: mkFunction,
      description: item.description || "",
      basis: "function-catalog",
      reviewRequired: mappingNeedsReview(mkFunction)
    });
  }
  return [...byName.values()].sort((left, right) => left.source.localeCompare(right.source));
}

function mappingNeedsReview(mkFunction = "") {
  const normalized = String(mkFunction).trim();
  return !normalized ||
    /^无\b/.test(normalized) ||
    /^同/.test(normalized) ||
    /^需要/.test(normalized) ||
    normalized.includes("对应表单动作") ||
    normalized.includes("onChange") ||
    normalized.includes("人工");
}

function buildMkFunction(candidate, mappings, violations) {
  const functionName = candidate.event;
  const signature = functionSignature(candidate);
  const lines = [
    `${signature} {`,
    "  // Generated from EKP JSP script. Review before marking trusted/executable.",
    "  // EKP -> MK function mappings:"
  ];

  if (mappings.length) {
    for (const mapping of mappings) {
      lines.push(`  // - ${mapping.source} => ${oneLine(mapping.target || "review_required")}`);
    }
  } else {
    lines.push("  // - no cataloged EKP function calls found");
  }

  if (violations.length) {
    lines.push("  // Unmapped EKP functions:");
    for (const violation of violations) {
      lines.push(`  // - ${violation.name}`);
    }
  }

  lines.push("", "  // Source JSP JavaScript:", ...commentLines(candidate.reviewJavascript || candidate.javascript));
  if (functionName === "onBeforeSubmit") {
    lines.push("", "  if (context && context.isDraft) return true", "  return true");
  }
  lines.push("}");
  return lines.join("\n");
}

function functionSignature(candidate) {
  if (candidate.event === "onChange") return "function onChange(value, rowNum, parentRowNum)";
  if (candidate.event === "onBeforeSubmit") return "function onBeforeSubmit(context)";
  return `function ${candidate.event}()`;
}

function commentLines(text = "") {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => `  // ${line}`);
}

function findNamedFunction(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\bfunction\\s+${escaped}\\s*\\([^)]*\\)\\s*\\{`);
  const match = pattern.exec(text);
  if (!match) return "";
  const open = match.index + match[0].length - 1;
  const close = findBalancedClose(text, open, "{", "}");
  return close > open ? text.slice(match.index, close + 1).trim() : "";
}

function findCallEnd(text, start) {
  let cursor = skipWhitespace(text, start);
  if (text[cursor] === ")") cursor += 1;
  cursor = skipWhitespace(text, cursor);
  if (text[cursor] === ";") cursor += 1;
  return cursor;
}

function findBalancedClose(text, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === "\\" && index + 1 < text.length) {
        index += 1;
        continue;
      }
      if (char === quote) quote = "";
      // JavaScript single/double quoted strings cannot cross an unescaped
      // line break. Recover the structural boundary from malformed legacy JSP
      // instead of letting one missing quote swallow the enclosing callback.
      if ((char === "\n" || char === "\r") && quote !== "`") quote = "";
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (["\"", "'", "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function skipWhitespace(text, start) {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function candidateKey(candidate = {}) {
  return `${candidate.index}:${candidate.event}:${candidate.scope}:${candidate.tableId || ""}:${candidate.controlId || ""}`;
}

function dedupeCandidatesByKey(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (!candidate.dedupeKey) {
      result.push(candidate);
      continue;
    }
    const key = candidate.dedupeKey;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function snippetAround(text, index, length) {
  return String(text || "").slice(index, Math.min(String(text || "").length, index + length)).trim();
}

function decodeDeep(value = "") {
  let current = String(value);
  for (let index = 0; index < 5; index += 1) {
    const next = decodeEntities(current);
    if (next === current) return next;
    current = next;
  }
  return current;
}

function compactPreview(value = "") {
  return oneLine(value).slice(0, 240);
}

function oneLine(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function stableActionId(value = "") {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, "_");
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function pruneUndefined(value) {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, pruneUndefined(child)])
  );
}
