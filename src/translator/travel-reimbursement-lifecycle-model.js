import { inlineOnChangeSourceActionKey } from "./source-action-key.js";
import { DETAIL_TABLE_IDS, FIELD_IDS, SOURCE_IDS } from "./travel-reimbursement-lifecycle-contract.js";
import {
  hasExactTravelReimbursementBehaviorEvidence,
  inspectTravelReimbursementStaticEvidence
} from "./travel-reimbursement-lifecycle-evidence.js";

const lifecycleModelCache = new WeakMap();

export function getTravelReimbursementLifecycleModel(sourceScripts = {}, form = {}, formRules = {}) {
  if (!sourceScripts || typeof sourceScripts !== "object") {
    return buildModel(sourceScripts, form, formRules);
  }
  const evidence = modelInputEvidence(sourceScripts, form, formRules);
  const cached = lifecycleModelCache.get(sourceScripts);
  if (
    cached &&
    sameModelInputEvidence(cached.evidence, evidence)
  ) {
    return cached.model;
  }
  const model = buildModel(sourceScripts, form, formRules);
  lifecycleModelCache.set(sourceScripts, { evidence, model });
  return model;
}

function modelInputEvidence(sourceScripts, form, formRules) {
  const sources = Array.isArray(sourceScripts?.sources)
    ? sourceScripts.sources
    : [];
  const relevantFieldIds = new Set([
    FIELD_IDS.firstCostCenter,
    FIELD_IDS.secondCostCenter,
    FIELD_IDS.payeeTotal,
    FIELD_IDS.payeeDifference
  ]);
  return {
    sources: sources.map((source) => ({
      source,
      id: source?.id,
      sourceRef: source?.sourceRef,
      displayGate: source?.displayGate,
      javascript: source?.javascript
    })),
    form: JSON.stringify((form?.fields || [])
      .filter((field) =>
        field?.type !== "detailTable" &&
        relevantFieldIds.has(field?.id)
      )
      .map((field) => ({
        id: field.id,
        componentId: field.componentId,
        options: field.props?.options,
        calculation: field.props?.calculation
      }))),
    rules: JSON.stringify((formRules?.linkage || []).filter((rule) =>
      rule?.source === FIELD_IDS.cityMode
    ))
  };
}

function sameModelInputEvidence(left, right) {
  return (
    left.form === right.form &&
    left.rules === right.rules &&
    left.sources.length === right.sources.length &&
    left.sources.every((entry, index) => {
      const candidate = right.sources[index];
      return (
        entry.source === candidate.source &&
        entry.id === candidate.id &&
        entry.sourceRef === candidate.sourceRef &&
        entry.displayGate === candidate.displayGate &&
        entry.javascript === candidate.javascript
      );
    })
  );
}

function buildModel(sourceScripts = {}, form = {}, formRules = {}) {
  const sources = Array.isArray(sourceScripts?.sources) ? sourceScripts.sources : [];
  const byId = new Map(sources.map((source, index) => [source.id, { source, index }]));
  if (Object.values(SOURCE_IDS).some((id) => !byId.has(id))) return undefined;

  const wbsEntry = byId.get(SOURCE_IDS.wbs);
  const costEntry = byId.get(SOURCE_IDS.costCenter);
  const constantsEntry = byId.get(SOURCE_IDS.constants);
  const lifecycleEntry = byId.get(SOURCE_IDS.lifecycle);
  const financeEntry = byId.get(SOURCE_IDS.finance);
  if (
    wbsEntry.source.displayGate !== "xform:editShow" ||
    costEntry.source.displayGate !== "xform:editShow" ||
    lifecycleEntry.source.displayGate !== "xform:editShow" ||
    financeEntry.source.displayGate !== "xform:editShow" ||
    lifecycleEntry.index >= financeEntry.index
  ) {
    return undefined;
  }

  const staticEvidence = inspectTravelReimbursementStaticEvidence({
    sources,
    wbsSource: wbsEntry.source.javascript,
    constantsSource: constantsEntry.source.javascript,
    financeSource: financeEntry.source.javascript
  });
  if (!staticEvidence) return undefined;
  const { commonWbs, financeFlagRange } = staticEvidence;

  const firstField = mainField(form, FIELD_IDS.firstCostCenter);
  const secondField = mainField(form, FIELD_IDS.secondCostCenter);
  const firstOptions = cloneOptions(firstField?.props?.options);
  const secondOptions = cloneOptions(secondField?.props?.options);
  if (!firstOptions.length || !secondOptions.length) return undefined;

  const changeCostCenter = namedFunctionRange(
    costEntry.source.javascript,
    "changeBsegValue"
  );
  const optionGroups = changeCostCenter
    ? parseCostCenterGroups(changeCostCenter.text, firstOptions, secondOptions)
    : undefined;
  if (!optionGroups) return undefined;

  const firstCostCenterBinding = namedValueChangeBinding(
    costEntry.source.javascript,
    FIELD_IDS.firstCostCenter,
    "changeBsegValue"
  );
  const secondCostCenterBinding = inlineValueChangeBinding(
    costEntry.source.javascript,
    FIELD_IDS.secondCostCenter
  );
  if (!firstCostCenterBinding || !secondCostCenterBinding) return undefined;

  const cityBinding = inlineValueChangeBinding(
    lifecycleEntry.source.javascript,
    FIELD_IDS.cityMode
  );
  const departmentBinding = inlineValueChangeBinding(
    lifecycleEntry.source.javascript,
    FIELD_IDS.department
  );
  const loadBinding = windowLoadBinding(lifecycleEntry.source.javascript);
  const submitBinding = submitBindingRange(lifecycleEntry.source.javascript);
  const clearTraffic = namedFunctionRange(
    lifecycleEntry.source.javascript,
    "clearTrainData"
  );
  const setDepartment = namedFunctionRange(
    lifecycleEntry.source.javascript,
    "setDepartMentSelect"
  );
  if (
    !cityBinding ||
    !departmentBinding ||
    !loadBinding ||
    !submitBinding ||
    !clearTraffic ||
    !setDepartment
  ) {
    return undefined;
  }

  const citySourceActionKey = inlineOnChangeSourceActionKey(
    lifecycleEntry.source.sourceRef,
    cityBinding.start
  );
  const cityNativeRules = (formRules?.linkage || []).filter((rule) =>
    rule?.translationStatus === "executable" &&
    rule?.source === FIELD_IDS.cityMode &&
    rule?.meta?.sourceActionKey === citySourceActionKey
  );
  if (cityNativeRules.length !== 1) return undefined;

  const trafficCalculation = sources
    .map((entry) => ({
      source: entry,
      range: namedFunctionRange(entry.javascript, "trafficCityChange")
    }))
    .find((entry) => entry.range);
  const payeeCalculation = sources
    .map((entry) => ({
      source: entry,
      range: namedFunctionRange(entry.javascript, "payeeListSum")
    }))
    .find((entry) => entry.range);
  const payeeAggregate = payeeCalculation
    ? namedFunctionRange(payeeCalculation.source.javascript, "payeeListCal")
    : undefined;
  const roundingHelpers = sources
    .map((entry) => ({
      source: entry,
      range: namedFunctionRange(entry.javascript, "theFixedNumTwo")
    }))
    .filter((entry) => entry.range);
  const roundingHelper = roundingHelpers.length === 1
    ? roundingHelpers[0]
    : undefined;
  if (
    !trafficCalculation ||
    !payeeCalculation ||
    !payeeAggregate ||
    !roundingHelper ||
    !hasExactTravelReimbursementBehaviorEvidence({
      lifecycleParts: {
        cityBinding,
        departmentBinding,
        loadBinding,
        submitBinding,
        clearTraffic,
        setDepartment
      },
      changeCostCenterText: changeCostCenter.text,
      trafficCalculationText: trafficCalculation.range.text,
      payeeCalculationSourceText: payeeCalculation.source.javascript,
      payeeCalculationText: payeeCalculation.range.text,
      payeeAggregateText: payeeAggregate.text,
      roundingText: roundingHelper.range.text,
      form
    })
  ) {
    return undefined;
  }

  const constantsRange = sourceRange(
    constantsEntry.source,
    0,
    constantsEntry.source.javascript.length,
    "travel-global-constants"
  );
  const wbsRange = sourceRange(
    wbsEntry.source,
    0,
    wbsEntry.source.javascript.length,
    "wbs-constant-pools"
  );

  return {
    sources: {
      wbs: wbsEntry.source,
      costCenter: costEntry.source,
      constants: constantsEntry.source,
      lifecycle: lifecycleEntry.source,
      finance: financeEntry.source,
      trafficCalculation: trafficCalculation.source,
      payeeCalculation: payeeCalculation.source,
      roundingHelper: roundingHelper.source
    },
    commonWbs,
    firstOptions,
    secondOptions,
    optionGroups,
    citySourceActionKey,
    cityNativeRuleId: cityNativeRules[0].id,
    bindings: {
      firstCostCenter: firstCostCenterBinding,
      secondCostCenter: secondCostCenterBinding,
      city: cityBinding,
      department: departmentBinding,
      load: loadBinding,
      submit: submitBinding
    },
    ranges: {
      wbs: wbsRange,
      constants: constantsRange,
      financeFlag: sourceRange(
        financeEntry.source,
        financeFlagRange.start,
        financeFlagRange.end,
        "theFinanceFlag=1"
      ),
      changeCostCenter: sourceRange(
        costEntry.source,
        changeCostCenter.start,
        changeCostCenter.end,
        "changeBsegValue"
      ),
      firstCostCenterBinding: sourceRange(
        costEntry.source,
        firstCostCenterBinding.start,
        firstCostCenterBinding.end,
        "first-cost-center-onChange"
      ),
      secondCostCenterBinding: sourceRange(
        costEntry.source,
        secondCostCenterBinding.start,
        secondCostCenterBinding.end,
        "second-cost-center-finance-mirror"
      ),
      city: sourceRange(
        lifecycleEntry.source,
        cityBinding.start,
        cityBinding.end,
        "city-mode-onChange"
      ),
      department: sourceRange(
        lifecycleEntry.source,
        departmentBinding.start,
        departmentBinding.end,
        "department-onChange"
      ),
      load: sourceRange(
        lifecycleEntry.source,
        loadBinding.start,
        loadBinding.end,
        "travel-window-load"
      ),
      submit: sourceRange(
        lifecycleEntry.source,
        submitBinding.start,
        submitBinding.end,
        "travel-submit"
      ),
      clearTraffic: sourceRange(
        lifecycleEntry.source,
        clearTraffic.start,
        clearTraffic.end,
        "clearTrainData"
      ),
      setDepartment: sourceRange(
        lifecycleEntry.source,
        setDepartment.start,
        setDepartment.end,
        "setDepartMentSelect"
      ),
      trafficCalculation: sourceRange(
        trafficCalculation.source,
        trafficCalculation.range.start,
        trafficCalculation.range.end,
        "trafficCityChange"
      ),
      payeeCalculation: sourceRange(
        payeeCalculation.source,
        payeeCalculation.range.start,
        payeeCalculation.range.end,
        "payeeListSum"
      ),
      payeeAggregate: sourceRange(
        payeeCalculation.source,
        payeeAggregate.start,
        payeeAggregate.end,
        "payeeListCal"
      ),
      roundingHelper: sourceRange(
        roundingHelper.source,
        roundingHelper.range.start,
        roundingHelper.range.end,
        "theFixedNumTwo"
      )
    }
  };
}

function parseCostCenterGroups(functionText, firstOptions, secondOptions) {
  const groups = {};
  const pattern =
    /(?:^|\})\s*else\s+if\s*\(\s*firstCostCenterVal\s*==+\s*(["'])([^"']+)\1\s*\)\s*\{|(?:^|[^\w])if\s*\(\s*firstCostCenterVal\s*==+\s*(["'])([^"']+)\3\s*\)\s*\{/gm;
  for (const match of functionText.matchAll(pattern)) {
    const value = match[2] || match[4];
    const open = match.index + match[0].lastIndexOf("{");
    const close = findBalancedClose(functionText, open, "{", "}");
    if (!value || close <= open) return undefined;
    const options = [];
    const body = functionText.slice(open + 1, close);
    const optionPattern =
      /secondCostCenter\.append\(\s*(["'])<option\s+value=(["'])([^"']+)\2>([^<]+)<\/option>\1\s*\)/g;
    for (const optionMatch of body.matchAll(optionPattern)) {
      options.push({ label: optionMatch[4], value: optionMatch[3] });
    }
    if (!options.length || groups[value]) return undefined;
    groups[value] = options;
  }

  const expectedFirstValues = firstOptions.map((option) => String(option.value)).sort();
  const observedFirstValues = Object.keys(groups).sort();
  if (expectedFirstValues.some((value) => !observedFirstValues.includes(value))) {
    return undefined;
  }
  const knownSecond = new Set(
    secondOptions.map((option) => `${option.value}\u0000${option.label}`)
  );
  if (
    Object.values(groups).flat().some((option) =>
      !knownSecond.has(`${option.value}\u0000${option.label}`)
    )
  ) {
    return undefined;
  }
  return groups;
}

function inlineValueChangeBinding(text, fieldId) {
  const pattern = new RegExp(
    `AttachXFormValueChangeEventById\\(\\s*(["'])${escapeRegExp(fieldId)}\\1\\s*,\\s*function\\s*\\([^)]*\\)\\s*\\{`,
    "g"
  );
  const matches = [...String(text || "").matchAll(pattern)];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  const open = match.index + match[0].lastIndexOf("{");
  const close = findBalancedClose(text, open, "{", "}");
  if (close <= open) return undefined;
  const end = findCallEnd(text, close + 1);
  return {
    start: match.index,
    end,
    text: text.slice(match.index, end)
  };
}

function namedValueChangeBinding(text, fieldId, callbackName) {
  const pattern = new RegExp(
    `AttachXFormValueChangeEventById\\(\\s*(["'])${escapeRegExp(fieldId)}\\1\\s*,\\s*${escapeRegExp(callbackName)}\\s*\\)\\s*;?`,
    "g"
  );
  const matches = [...String(text || "").matchAll(pattern)];
  if (matches.length !== 1) return undefined;
  return {
    start: matches[0].index,
    end: matches[0].index + matches[0][0].length,
    text: matches[0][0]
  };
}

function windowLoadBinding(text) {
  const pattern =
    /Com_AddEventListener\(\s*window\s*,\s*(["'])load\1\s*,\s*function\s*\([^)]*\)\s*\{/g;
  const matches = [...String(text || "").matchAll(pattern)];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  const open = match.index + match[0].lastIndexOf("{");
  const close = findBalancedClose(text, open, "{", "}");
  if (close <= open) return undefined;
  const end = findCallEnd(text, close + 1);
  return {
    start: match.index,
    end,
    text: text.slice(match.index, end)
  };
}

function submitBindingRange(text) {
  const pattern =
    /Com_Parameter\.event(?:\s*\[\s*["']submit["']\s*\]|\s*\.\s*submit)\s*\.push\s*\(\s*function\s*\([^)]*\)\s*\{/g;
  const matches = [...String(text || "").matchAll(pattern)];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  const open = match.index + match[0].lastIndexOf("{");
  const close = findBalancedClose(text, open, "{", "}");
  if (close <= open) return undefined;
  const end = findCallEnd(text, close + 1);
  return {
    start: match.index,
    end,
    text: text.slice(match.index, end)
  };
}

function namedFunctionRange(text, name) {
  const pattern = new RegExp(`\\bfunction\\s+${escapeRegExp(name)}\\s*\\([^)]*\\)\\s*\\{`, "g");
  const matches = [...String(text || "").matchAll(pattern)];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  const open = match.index + match[0].lastIndexOf("{");
  const close = findBalancedClose(text, open, "{", "}");
  if (close <= open) return undefined;
  return {
    start: match.index,
    end: close + 1,
    text: text.slice(match.index, close + 1)
  };
}

function sourceRange(source, start, end, name) {
  return {
    sourceRef: source.sourceRef,
    name,
    start,
    end
  };
}

function mainField(form, fieldId) {
  return (form?.fields || []).find((field) =>
    field?.id === fieldId && field?.type !== "detailTable"
  );
}

function cloneOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .filter((option) => option && option.label !== undefined && option.value !== undefined)
    .map((option) => ({
      label: String(option.label),
      value: String(option.value)
    }));
}

function findCallEnd(text, start) {
  let index = start;
  while (/\s/.test(text[index] || "")) index += 1;
  if (text[index] === ")") index += 1;
  while (/\s/.test(text[index] || "")) index += 1;
  if (text[index] === ";") index += 1;
  return index;
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
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
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
    if (["'", "\"", "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (char === openChar) depth += 1;
    else if (char === closeChar && --depth === 0) return index;
  }
  return -1;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
