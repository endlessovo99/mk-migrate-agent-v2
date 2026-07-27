const DETAIL_CASCADE_BASIS = "deterministic-detail-cascade-actions";

/**
 * Recognize the narrow 2/17-column detail cascade used by the Route fixture.
 *
 * The source keeps three primary/secondary select pairs in one detail row,
 * mirrors their values into stored helper columns, restores those values on
 * load, and toggles the secondary controls for one kind value. Dynamic options
 * are projected separately as structured rowOptions; these actions never
 * mutate select props at runtime.
 */
export function detailCascadeActionCandidates(source = {}, form = {}, sourceScripts = {}) {
  const model = detailCascadeModelForSource(source, form, sourceScripts);
  if (!model) return [];

  if (model.load.sourceId === source.id) {
    return [loadCandidate(model)];
  }

  return model.bindings
    .filter((binding) => binding.sourceId === source.id)
    .map((binding) => changeCandidate(model, binding))
    .filter(Boolean);
}

export function detailCascadeModels(sourceScripts = {}, form = {}) {
  const sources = Array.isArray(sourceScripts?.sources) ? sourceScripts.sources : [];
  const fragments = new Map();
  for (const source of sources) {
    if (!source?.fragmentId) continue;
    if (!fragments.has(source.fragmentId)) fragments.set(source.fragmentId, []);
    fragments.get(source.fragmentId).push(source);
  }
  return [...fragments.values()]
    .map((fragmentSources) => analyzeDetailCascadeFragment(fragmentSources, form))
    .filter(Boolean);
}

export function applyDetailCascadeRowOptions(form = {}, sourceScripts = {}) {
  const models = detailCascadeModels(sourceScripts, form);
  if (!models.length) return form;
  const modelByTableId = new Map(models.map((model) => [model.tableId, model]));
  return {
    ...form,
    fields: (form.fields || []).map((field) => {
      const model = modelByTableId.get(field.id);
      if (!model) return field;
      const rowOptionsByColumnId = new Map(
        model.groups.flatMap((group) => [
          [group.primaryId, group.primaryRowOptions],
          [group.secondaryId, group.secondaryRowOptions]
        ])
      );
      return {
        ...field,
        columns: (field.columns || []).map((column) => {
          const rowOptions = rowOptionsByColumnId.get(column.id);
          if (!rowOptions) return column;
          return {
            ...column,
            props: {
              ...(column.props || {}),
              rowOptions
            }
          };
        })
      };
    })
  };
}

function detailCascadeModelForSource(source, form, sourceScripts) {
  if (!source?.fragmentId) return undefined;
  const fragmentSources = (Array.isArray(sourceScripts?.sources)
    ? sourceScripts.sources
    : []
  ).filter((candidate) => candidate.fragmentId === source.fragmentId);
  return analyzeDetailCascadeFragment(fragmentSources, form);
}

function analyzeDetailCascadeFragment(sources, form) {
  if (sources.length < 2) return undefined;
  const bindings = sources.flatMap(extractNamedBindings);
  if (
    bindings.length !== 7 ||
    new Set(bindings.map((binding) => binding.controlId)).size !== 7
  ) {
    return undefined;
  }

  const detailTables = (Array.isArray(form?.fields) ? form.fields : [])
    .filter((field) => field?.type === "detailTable");
  const targetTable = detailTables.find((table) =>
    table.columns?.length === 17 &&
    bindings.every((binding) => columnByAlias(table, binding.controlId))
  );
  if (
    !targetTable ||
    !detailTables.some((table) => table.id !== targetTable.id && table.columns?.length === 2)
  ) {
    return undefined;
  }

  const columns = targetTable.columns || [];
  const canonicalBindings = bindings.map((binding) => {
    const control = columnByAlias(targetTable, binding.controlId);
    const refs = literalColumnRefs(binding.functionText, targetTable);
    return {
      ...binding,
      controlId: control.id,
      selectRefs: refs.filter((fieldId) => isSelectColumn(columns, fieldId)),
      storeRefs: refs.filter((fieldId) => !isSelectColumn(columns, fieldId))
    };
  });
  if (!canonicalBindings.every((binding) => isSelectColumn(columns, binding.controlId))) {
    return undefined;
  }

  const boundControlIds = new Set(canonicalBindings.map((binding) => binding.controlId));
  const kindBinding = canonicalBindings.find((binding) =>
    binding.selectRefs.filter((fieldId) => fieldId !== binding.controlId).length >= 4
  );
  if (!kindBinding) return undefined;

  const primaryBindings = canonicalBindings.filter((binding) => {
    if (binding === kindBinding) return false;
    const otherSelects = binding.selectRefs.filter((fieldId) => fieldId !== binding.controlId);
    return otherSelects.length === 1 && boundControlIds.has(otherSelects[0]);
  });
  if (primaryBindings.length !== 3) return undefined;

  const primaryControlIds = new Set(primaryBindings.map((binding) => binding.controlId));
  const secondaryBindings = canonicalBindings.filter((binding) =>
    binding !== kindBinding &&
    !primaryControlIds.has(binding.controlId)
  );
  if (
    secondaryBindings.length !== 3 ||
    secondaryBindings.some((binding) =>
      binding.selectRefs.some((fieldId) => fieldId !== binding.controlId)
    )
  ) {
    return undefined;
  }

  const secondaryByControl = new Map(secondaryBindings.map((binding) => [
    binding.controlId,
    binding
  ]));
  const groups = primaryBindings.map((primary) => {
    const secondaryId = primary.selectRefs.find((fieldId) =>
      fieldId !== primary.controlId && secondaryByControl.has(fieldId)
    );
    const secondary = secondaryByControl.get(secondaryId);
    const secondaryStoreId = only(secondary?.storeRefs);
    const primaryStoreId = only(primary.storeRefs.filter((fieldId) =>
      fieldId !== secondaryStoreId
    ));
    if (!secondary || !primaryStoreId || !secondaryStoreId) return undefined;
    return {
      primaryId: primary.controlId,
      secondaryId,
      primaryStoreId,
      secondaryStoreId,
      primaryClearsSecondaryStore: primary.storeRefs.includes(secondaryStoreId),
      primaryBinding: primary,
      secondaryBinding: secondary
    };
  });
  if (
    groups.some((group) => !group) ||
    new Set(groups.map((group) => group.secondaryId)).size !== 3
  ) {
    return undefined;
  }

  const groupStoreIds = new Set(groups.flatMap((group) => [
    group.primaryStoreId,
    group.secondaryStoreId
  ]));
  const kindStoreId = only(kindBinding.storeRefs.filter((fieldId) =>
    !groupStoreIds.has(fieldId)
  ));
  const activeValue = detailCascadeActiveValue(kindBinding.functionText);
  if (!kindStoreId || !activeValue) return undefined;
  const kindState = detailCascadeStateTargets(kindBinding.functionText, targetTable);
  const missingKindTargetIds = unresolvedLiteralFieldIds(
    kindBinding.functionText,
    targetTable
  );
  const kindClearFieldIds = detailCascadeKindClearTargets(
    kindBinding.functionText,
    targetTable
  );

  const loadCalls = sources.flatMap(extractWindowLoadCalls);
  if (loadCalls.length !== 1) return undefined;
  const load = loadCalls[0];
  const loadSource = sources.find((candidate) => candidate.id === load.sourceId);
  if (!loadSource?.javascript?.includes(targetTable.id)) return undefined;
  if (groups.some((group) => [
    group.primaryId,
    group.secondaryId,
    group.primaryStoreId,
    group.secondaryStoreId
  ].some((fieldId) => !load.javascript.includes(fieldId)))) {
    return undefined;
  }

  const combinedSource = sources.map((candidate) => candidate.javascript || "").join("\n");
  if (
    !/\.empty\s*\(\s*\)/.test(combinedSource) ||
    !/\.append\s*\(\s*(["'])<option\b/.test(combinedSource) ||
    !/(?:\.css\s*\(\s*(["'])display\1|style\.display)/.test(combinedSource) ||
    !/(?:\.attr\s*\(\s*(["'])validate\1|setAttribute\s*\(\s*(["'])validate\2)/.test(combinedSource)
  ) {
    return undefined;
  }

  const functionDefinitions = sources.flatMap(extractNamedFunctions);
  const loadState = detailCascadeLoadState(
    load.javascript,
    functionDefinitions
  );
  const enrichedBindings = canonicalBindings.map((binding) => ({
    ...binding,
    evidence: eventEvidence(binding, functionDefinitions)
  }));
  const bindingByControl = new Map(enrichedBindings.map((binding) => [
    binding.controlId,
    binding
  ]));
  const enrichedGroups = groups.map((group) => ({
    ...group,
    primaryBinding: bindingByControl.get(group.primaryId),
    secondaryBinding: bindingByControl.get(group.secondaryId)
  }));
  const optionGroups = detailCascadeOptionGroups({
    groups: enrichedGroups,
    columns,
    kindBinding: bindingByControl.get(kindBinding.controlId),
    activeValue,
    functionDefinitions
  });
  if (!optionGroups) return undefined;

  return {
    fragmentId: sources[0].fragmentId,
    tableId: targetTable.id,
    kindControlId: kindBinding.controlId,
    kindStoreId,
    activeValue,
    kindVisibilitySecondaryIds: kindState.visibility,
    kindRequiredSecondaryIds: kindState.required,
    kindNonrequiredSecondaryIds: kindState.nonrequired,
    kindClearFieldIds,
    missingKindTargetIds,
    groups: optionGroups,
    bindings: enrichedBindings,
    load: {
      ...load,
      state: loadState,
      evidence: transitiveEvidence(
        [rangeEvidence(load, "window.load")],
        load.javascript,
        functionDefinitions
      )
    }
  };
}

function detailCascadeOptionGroups({
  groups,
  columns,
  kindBinding,
  activeValue,
  functionDefinitions
}) {
  const projected = groups.map((group) => {
    const primary = columns.find((column) => column.id === group.primaryId);
    const secondary = columns.find((column) => column.id === group.secondaryId);
    const primaryRowOptions = detailCascadePrimaryRowOptions({
      column: primary,
      dependencyFieldId: kindBinding.controlId,
      activeValue,
      kindFunctionText: kindBinding.functionText,
      functionDefinitions
    });
    const secondaryRowOptions = detailCascadeConditionalRowOptions({
      column: secondary,
      dependencyFieldId: group.primaryId,
      functionDefinitions
    });
    if (!primaryRowOptions || !secondaryRowOptions) return undefined;
    return {
      ...group,
      primaryRowOptions,
      secondaryRowOptions
    };
  });
  return projected.every(Boolean) ? projected : undefined;
}

function detailCascadePrimaryRowOptions({
  column,
  dependencyFieldId,
  activeValue,
  kindFunctionText,
  functionDefinitions
}) {
  const conditional = detailCascadeConditionalRowOptions({
    column,
    dependencyFieldId,
    functionDefinitions
  });
  if (conditional) return conditional;

  const staticOptions = nativeStaticOptions(column);
  if (!staticOptions.length) return undefined;
  const staticPairs = optionPairSet(staticOptions);
  const builders = functionDefinitions.flatMap((definition) => {
    const options = optionBuilderOptions(definition.javascript, staticPairs);
    if (!options) return [];
    const state = optionBuilderStateForActiveValue(
      kindFunctionText,
      definition.functionName,
      activeValue
    );
    return state ? [{ state, options }] : [];
  });
  const activeBuilders = builders.filter((builder) => builder.state === "active");
  const defaultBuilders = builders.filter((builder) => builder.state === "default");
  if (activeBuilders.length !== 1 || defaultBuilders.length !== 1) return undefined;
  const activeOptions = activeBuilders[0].options;
  const defaultOptions = defaultBuilders[0].options;
  if (
    !uniqueOptionValues(activeOptions) ||
    !uniqueOptionValues(defaultOptions) ||
    !sameOptionPairSet([...activeOptions, ...defaultOptions], staticOptions)
  ) {
    return undefined;
  }
  return {
    dependencyFieldId,
    cases: [{ value: activeValue, options: activeOptions }],
    defaultOptions
  };
}

function detailCascadeConditionalRowOptions({
  column,
  dependencyFieldId,
  functionDefinitions
}) {
  const staticOptions = nativeStaticOptions(column);
  if (!staticOptions.length) return undefined;
  const staticPairs = optionPairSet(staticOptions);
  const candidates = functionDefinitions.flatMap((definition) => {
    const options = optionBuilderOptions(definition.javascript, staticPairs);
    if (!options) return [];
    const projection = conditionalOptionProjection(
      definition.javascript,
      staticPairs
    );
    if (!projection) return [];
    const projectedOptions = [
      ...projection.cases.flatMap((entry) => entry.options),
      ...projection.defaultOptions
    ];
    if (
      projectedOptions.length !== options.length ||
      !projection.cases.every((entry) => uniqueOptionValues(entry.options)) ||
      !uniqueOptionValues(projection.defaultOptions) ||
      !sameOptionPairSet(projectedOptions, staticOptions)
    ) {
      return [];
    }
    return [projection];
  });
  if (candidates.length !== 1) return undefined;
  return {
    dependencyFieldId,
    cases: candidates[0].cases,
    defaultOptions: candidates[0].defaultOptions
  };
}

function conditionalOptionProjection(functionText, staticPairs) {
  const cases = [];
  let defaultOptions;
  const branchPattern =
    /\bif\s*\(\s*[A-Za-z_$][\w$]*\s*={2,3}\s*(["'])([^"']*)\1\s*\)\s*\{/g;
  for (const match of String(functionText || "").matchAll(branchPattern)) {
    const open = match.index + match[0].lastIndexOf("{");
    const close = findBalancedClose(functionText, open);
    if (close < 0) return undefined;
    const options = optionPairsFromText(
      functionText.slice(open + 1, close),
      staticPairs
    );
    if (!options?.length) return undefined;
    cases.push({ value: match[2], options });

    const remainder = functionText.slice(close + 1);
    const elseMatch = remainder.match(/^\s*else\s*\{/);
    if (!elseMatch) continue;
    const elseOpen = close + 1 + elseMatch[0].lastIndexOf("{");
    const elseClose = findBalancedClose(functionText, elseOpen);
    if (elseClose < 0) return undefined;
    defaultOptions = optionPairsFromText(
      functionText.slice(elseOpen + 1, elseClose),
      staticPairs
    );
    if (defaultOptions === undefined) return undefined;
  }
  if (!cases.length || defaultOptions === undefined) return undefined;
  if (new Set(cases.map((entry) => entry.value)).size !== cases.length) {
    return undefined;
  }
  return { cases, defaultOptions };
}

function optionBuilderStateForActiveValue(
  functionText,
  functionName,
  activeValue
) {
  const pattern =
    /\bif\s*\(\s*[A-Za-z_$][\w$]*\s*(===|==|!==|!=)\s*(["'])([^"']*)\2\s*\)\s*\{/g;
  for (const match of String(functionText || "").matchAll(pattern)) {
    if (match[3] !== activeValue) continue;
    const open = match.index + match[0].lastIndexOf("{");
    const close = findBalancedClose(functionText, open);
    if (close < 0) return undefined;
    const trueBody = functionText.slice(open + 1, close);
    const remainder = functionText.slice(close + 1);
    const elseMatch = remainder.match(/^\s*else\s*\{/);
    if (!elseMatch) continue;
    const elseOpen = close + 1 + elseMatch[0].lastIndexOf("{");
    const elseClose = findBalancedClose(functionText, elseOpen);
    if (elseClose < 0) return undefined;
    const falseBody = functionText.slice(elseOpen + 1, elseClose);
    const callPattern = new RegExp(`\\b${escapeRegExp(functionName)}\\s*\\(`);
    const inTrue = callPattern.test(trueBody);
    const inFalse = callPattern.test(falseBody);
    if (inTrue === inFalse) continue;
    const equality = match[1] === "==" || match[1] === "===";
    if (inTrue) return equality ? "active" : "default";
    return equality ? "default" : "active";
  }
  return undefined;
}

function optionBuilderOptions(functionText, staticPairs) {
  const allOptions = optionPairsFromText(functionText);
  if (!allOptions.length) return undefined;
  const nonPlaceholderOptions = allOptions.filter((option) => option.value);
  if (
    !nonPlaceholderOptions.length ||
    nonPlaceholderOptions.some((option) =>
      !staticPairs.has(optionPairKey(option))
    )
  ) {
    return undefined;
  }
  return nonPlaceholderOptions;
}

function optionPairsFromText(functionText, staticPairs) {
  const options = [];
  const pattern =
    /<option\b[^>]*\bvalue=(?:\\)?(["'])(.*?)(?:\\)?\1[^>]*>(.*?)<\/option>/g;
  for (const match of String(functionText || "").matchAll(pattern)) {
    const option = {
      label: match[3].trim(),
      value: match[2].trim()
    };
    if (!option.value) continue;
    if (staticPairs && !staticPairs.has(optionPairKey(option))) return undefined;
    options.push(option);
  }
  return options;
}

function nativeStaticOptions(column) {
  return (Array.isArray(column?.props?.options) ? column.props.options : [])
    .map((option) => ({
      label: String(option?.label ?? ""),
      value: String(option?.value ?? "")
    }))
    .filter((option) => option.label && option.value);
}

function sameOptionPairSet(left, right) {
  const leftSet = optionPairSet(left);
  const rightSet = optionPairSet(right);
  return leftSet.size === rightSet.size &&
    [...leftSet].every((key) => rightSet.has(key));
}

function optionPairSet(options) {
  return new Set((options || []).map(optionPairKey));
}

function optionPairKey(option) {
  return JSON.stringify([option.label, option.value]);
}

function uniqueOptionValues(options) {
  return new Set((options || []).map((option) => option.value)).size ===
    (options || []).length;
}

function loadCandidate(model) {
  return deterministicCandidate({
    index: model.load.index,
    event: "onLoad",
    scope: "global",
    javascript: model.load.javascript,
    function: buildLoadFunction(model),
    evidence: model.load.evidence,
    model
  });
}

function changeCandidate(model, binding) {
  const groupByPrimary = model.groups.find((group) =>
    group.primaryId === binding.controlId
  );
  const groupBySecondary = model.groups.find((group) =>
    group.secondaryId === binding.controlId
  );
  const role = binding.controlId === model.kindControlId
    ? "kind"
    : groupByPrimary ? "primary" : groupBySecondary ? "secondary" : undefined;
  if (!role) return undefined;

  const functionText = role === "kind"
    ? buildKindChangeFunction(model)
    : role === "primary"
      ? buildPrimaryChangeFunction(model, groupByPrimary)
      : buildSecondaryChangeFunction(model, groupBySecondary);
  return deterministicCandidate({
    index: binding.index,
    event: "onChange",
    scope: "control",
    tableId: model.tableId,
    controlId: binding.controlId,
    javascript: binding.javascript,
    function: functionText,
    evidence: binding.evidence,
    model
  });
}

function deterministicCandidate(candidate) {
  const coveredCalculationRanges = candidate.evidence.map((item) => ({
    sourceRef: item.sourceRef,
    name: item.name,
    start: item.start,
    end: item.end
  }));
  return {
    index: candidate.index,
    event: candidate.event,
    scope: candidate.scope,
    tableId: candidate.tableId,
    controlId: candidate.controlId,
    javascript: candidate.javascript,
    function: candidate.function,
    runWhen: { viewStatusIn: ["add", "edit"] },
    translationStatus: "mapped",
    coverage: { status: "translated", nativeRules: [], residuals: [] },
    functionMappings: [{
      source: "same-fragment detail-row cascade with named handlers and stored row helpers",
      target: "structured rowOptions + MKXFORM row update/visibility/required actions",
      basis: DETAIL_CASCADE_BASIS,
      reviewRequired: false
    }],
    sourceRefs: unique(candidate.evidence.map((item) => item.sourceRef)),
    semanticHints: {
      detailCascade: {
        tableId: candidate.model.tableId,
        kindControlId: candidate.model.kindControlId,
        kindStoreId: candidate.model.kindStoreId,
        activeValue: candidate.model.activeValue,
        kindVisibilitySecondaryIds: candidate.model.kindVisibilitySecondaryIds,
        kindRequiredSecondaryIds: candidate.model.kindRequiredSecondaryIds,
        kindNonrequiredSecondaryIds: candidate.model.kindNonrequiredSecondaryIds,
        loadState: candidate.model.load.state,
        kindClearFieldIds: candidate.model.kindClearFieldIds,
        missingKindTargetIds: candidate.model.missingKindTargetIds,
        groups: candidate.model.groups.map((group) => ({
          primaryId: group.primaryId,
          secondaryId: group.secondaryId,
          primaryStoreId: group.primaryStoreId,
          secondaryStoreId: group.secondaryStoreId,
          primaryClearsSecondaryStore: group.primaryClearsSecondaryStore
        }))
      },
      coveredCalculationRanges
    }
  };
}

function buildLoadFunction(model) {
  const table = tablePlaceholder(model.tableId);
  const lines = [
    "function onLoad() {",
    `  var rows = MKXFORM.getValue(${JSON.stringify(table)}) || []`,
    "  for (var rowNum = 0; rowNum < rows.length; rowNum += 1) {",
    "    var row = rows[rowNum] || {}",
    `    var kindValue = row[${JSON.stringify(model.kindStoreId)}] || row[${JSON.stringify(model.kindControlId)}] || ""`,
    `    var active = String(kindValue) === ${JSON.stringify(model.activeValue)}`
  ];
  for (const group of model.groups) {
    lines.push(
      `    MKXFORM.updateControl(${JSON.stringify(`${table}.${group.primaryId}`)}, rowNum, row[${JSON.stringify(group.primaryStoreId)}] || "")`,
      "    if (active) {",
      `      MKXFORM.updateControl(${JSON.stringify(`${table}.${group.secondaryId}`)}, rowNum, row[${JSON.stringify(group.secondaryStoreId)}] || "")`,
      "    }",
      ...detailRowStateLines(table, group.secondaryId, "    ", {
        visibility: true,
        required: model.load.state.requiredActive,
        nonrequired: model.load.state.nonrequiredInactive
      })
    );
  }
  lines.push("  }", "}");
  return lines.join("\n");
}

function buildKindChangeFunction(model) {
  const table = tablePlaceholder(model.tableId);
  const lines = [
    "function onChange(value, rowNum, parentRowNum) {",
    "  var selectedValue = Array.isArray(value) ? value[0] : value",
    "  selectedValue = selectedValue == null ? \"\" : String(selectedValue)",
    `  var active = selectedValue === ${JSON.stringify(model.activeValue)}`,
    `  MKXFORM.updateControl(${JSON.stringify(`${table}.${model.kindStoreId}`)}, rowNum, selectedValue)`
  ];
  for (const group of model.groups) {
    for (const fieldId of [
      group.primaryId,
      group.secondaryId,
      group.primaryStoreId,
      group.secondaryStoreId
    ].filter((candidate) => model.kindClearFieldIds.includes(candidate))) {
      lines.push(`  MKXFORM.updateControl(${JSON.stringify(`${table}.${fieldId}`)}, rowNum, "")`);
    }
    lines.push(...detailRowStateLines(table, group.secondaryId, "  ", {
      visibility: model.kindVisibilitySecondaryIds.includes(group.secondaryId),
      required: model.kindRequiredSecondaryIds.includes(group.secondaryId),
      nonrequired: model.kindNonrequiredSecondaryIds.includes(group.secondaryId)
    }));
  }
  lines.push("}");
  return lines.join("\n");
}

function buildPrimaryChangeFunction(model, group) {
  const table = tablePlaceholder(model.tableId);
  return [
    "function onChange(value, rowNum, parentRowNum) {",
    "  var selectedValue = Array.isArray(value) ? value[0] : value",
    "  selectedValue = selectedValue == null ? \"\" : String(selectedValue)",
    `  MKXFORM.updateControl(${JSON.stringify(`${table}.${group.primaryStoreId}`)}, rowNum, selectedValue)`,
    `  MKXFORM.updateControl(${JSON.stringify(`${table}.${group.secondaryId}`)}, rowNum, "")`,
    ...(group.primaryClearsSecondaryStore
      ? [`  MKXFORM.updateControl(${JSON.stringify(`${table}.${group.secondaryStoreId}`)}, rowNum, "")`]
      : []),
    "}"
  ].join("\n");
}

function buildSecondaryChangeFunction(model, group) {
  const table = tablePlaceholder(model.tableId);
  return [
    "function onChange(value, rowNum, parentRowNum) {",
    "  var selectedValue = Array.isArray(value) ? value[0] : value",
    "  selectedValue = selectedValue == null ? \"\" : String(selectedValue)",
    `  MKXFORM.updateControl(${JSON.stringify(`${table}.${group.secondaryStoreId}`)}, rowNum, selectedValue)`,
    "}"
  ].join("\n");
}

function detailRowStateLines(table, controlId, indent, effects = {}) {
  const visibility = effects.visibility !== false;
  const required = effects.required !== false;
  const nonrequired = effects.nonrequired === true;
  const attrCall = (attribute, callIndent = indent) =>
    `${callIndent}MKXFORM.setDetailFieldItemAttr(${JSON.stringify(table)}, ${attribute}, rowNum, ${JSON.stringify(`${table}.${controlId}`)})`;
  return [
    ...(visibility
      ? [attrCall("active ? 5 : 4")]
      : []),
    ...(required
      ? [attrCall("active ? 3 : 6")]
      : nonrequired
        ? [
            `${indent}if (!active) {`,
            attrCall("6", `${indent}  `),
            `${indent}}`
          ]
      : [])
  ];
}

function extractNamedBindings(source) {
  const text = String(source?.javascript || "");
  const bindings = [];
  const pattern = /AttachXFormValueChangeEventById\(\s*(["'])(fd_[A-Za-z0-9_]+)\1\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
  const definitions = extractNamedFunctions(source);
  const definitionsByName = new Map(definitions.map((definition) => [
    definition.functionName,
    definition
  ]));
  for (const match of text.matchAll(pattern)) {
    const definition = definitionsByName.get(match[3]);
    if (!definition) continue;
    bindings.push({
      index: match.index,
      sourceId: source.id,
      sourceRef: source.sourceRef || source.id,
      controlId: match[2],
      functionName: match[3],
      functionText: definition.javascript,
      functionRange: definition,
      javascript: `${definition.javascript}\n${match[0]}`
    });
  }
  return bindings;
}

function extractWindowLoadCalls(source) {
  const text = String(source?.javascript || "");
  const calls = [];
  const pattern = /Com_AddEventListener\(\s*window\s*,\s*(["'])load\1\s*,\s*function\s*\([^)]*\)\s*\{/g;
  for (const match of text.matchAll(pattern)) {
    const open = match.index + match[0].lastIndexOf("{");
    const close = findBalancedClose(text, open);
    if (close < 0) continue;
    const end = callEnd(text, close + 1);
    calls.push({
      index: match.index,
      start: match.index,
      end,
      sourceId: source.id,
      sourceRef: source.sourceRef || source.id,
      javascript: text.slice(match.index, end)
    });
  }
  return calls;
}

function extractNamedFunctions(source) {
  const text = String(source?.javascript || "");
  const definitions = [];
  const pattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  for (const match of text.matchAll(pattern)) {
    const open = match.index + match[0].lastIndexOf("{");
    const close = findBalancedClose(text, open);
    if (close < 0) continue;
    definitions.push({
      sourceId: source.id,
      sourceRef: source.sourceRef || source.id,
      functionName: match[1],
      name: match[1],
      start: match.index,
      end: close + 1,
      javascript: text.slice(match.index, close + 1)
    });
  }
  return definitions;
}

function eventEvidence(binding, definitions) {
  return transitiveEvidence([
    {
      sourceRef: binding.functionRange.sourceRef,
      name: binding.functionName,
      start: binding.functionRange.start,
      end: binding.functionRange.end
    },
    {
      sourceRef: binding.sourceRef,
      name: `${binding.functionName}.binding`,
      start: binding.index,
      end: binding.index + binding.javascript.split("\n").at(-1).length
    }
  ], binding.functionText, definitions);
}

function transitiveEvidence(initial, seedText, definitions) {
  const byName = new Map(definitions.map((definition) => [
    definition.functionName,
    definition
  ]));
  const evidence = [...initial];
  const queue = [String(seedText || "")];
  const visited = new Set();
  while (queue.length) {
    const text = queue.shift();
    for (const [name, definition] of byName) {
      if (visited.has(name)) continue;
      if (!new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(text)) continue;
      visited.add(name);
      evidence.push({
        sourceRef: definition.sourceRef,
        name,
        start: definition.start,
        end: definition.end
      });
      queue.push(definition.javascript);
    }
  }
  return uniqueRanges(evidence);
}

function detailCascadeLoadState(seedText, definitions) {
  const text = transitiveFunctionText(seedText, definitions);
  return {
    requiredActive:
      /\.attr\s*\(\s*(["'])validate\1\s*,\s*(["'])required\2\s*\)/.test(text) ||
      /\.setAttribute\s*\(\s*(["'])validate\1\s*,\s*(["'])required\2\s*\)/.test(text),
    nonrequiredInactive:
      /\.attr\s*\(\s*(["'])validate\1\s*,\s*(["'])\2\s*\)/.test(text) ||
      /\.setAttribute\s*\(\s*(["'])validate\1\s*,\s*(["'])\2\s*\)/.test(text)
  };
}

function transitiveFunctionText(seedText, definitions) {
  const byName = new Map(definitions.map((definition) => [
    definition.functionName,
    definition
  ]));
  const queue = [String(seedText || "")];
  const texts = [...queue];
  const visited = new Set();
  while (queue.length) {
    const text = queue.shift();
    for (const [name, definition] of byName) {
      if (visited.has(name)) continue;
      if (!new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(text)) continue;
      visited.add(name);
      texts.push(definition.javascript);
      queue.push(definition.javascript);
    }
  }
  return texts.join("\n");
}

function rangeEvidence(range, name) {
  return {
    sourceRef: range.sourceRef,
    name,
    start: range.start,
    end: range.end
  };
}

function detailCascadeActiveValue(functionText) {
  const text = String(functionText || "");
  const equality = text.match(/\bvalue\s*={2,3}\s*(["'])([^"']+)\1/);
  if (equality) return equality[2];
  return text.match(/\bvalue\s*!={1,2}\s*(["'])([^"']+)\1/)?.[2];
}

function detailCascadeStateTargets(functionText, table) {
  const text = String(functionText || "");
  const variableFields = detailCascadeVariableFields(text, table);
  const visibility = new Set();
  const required = new Set();
  const nonrequired = new Set();
  const add = (set, variableName) => {
    const fieldId = variableFields.get(variableName);
    if (fieldId) set.add(fieldId);
  };

  for (const match of text.matchAll(/\bsetRouteSecondaryState\(\s*([A-Za-z_$][\w$]*)\s*,/g)) {
    add(visibility, match[1]);
    add(required, match[1]);
    add(nonrequired, match[1]);
  }
  for (const match of text.matchAll(/\bsetSelect1(Multi)?\(\s*[^,]+,\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    add(visibility, match[2]);
    if (!match[1]) add(nonrequired, match[2]);
  }
  for (const match of text.matchAll(/\$\(\s*([A-Za-z_$][\w$]*)\s*\)\.css\(\s*(["'])display\2/g)) {
    add(visibility, match[1]);
  }
  for (const match of text.matchAll(/\$\(\s*([A-Za-z_$][\w$]*)\s*\)\.attr\(\s*(["'])validate\2\s*,\s*(["'])required\3/g)) {
    add(required, match[1]);
  }
  for (const match of text.matchAll(/\$\(\s*([A-Za-z_$][\w$]*)\s*\)\.attr\(\s*(["'])validate\2\s*,\s*(["'])\3/g)) {
    add(nonrequired, match[1]);
  }

  return {
    visibility: [...visibility],
    required: [...required],
    nonrequired: [...nonrequired]
  };
}

function detailCascadeKindClearTargets(functionText, table) {
  const text = String(functionText || "");
  const direct = [];
  for (const match of text.matchAll(/\bclearRouteCascade\(([^)]*)\)/g)) {
    direct.push(...literalColumnRefs(match[1], table));
  }
  if (direct.length) return unique(direct);

  const variableFields = detailCascadeVariableFields(text, table);
  const primaryTargets = [];
  for (const match of text.matchAll(/\bsetSelect1(?:Multi)?\(\s*([A-Za-z_$][\w$]*)\s*,/g)) {
    const fieldId = variableFields.get(match[1]);
    if (fieldId) primaryTargets.push(fieldId);
  }
  return unique(primaryTargets);
}

function detailCascadeVariableFields(text, table) {
  const fields = new Map();
  const assignments = [...String(text || "").matchAll(
    /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g
  )].map((match) => ({ name: match[1], expression: match[2] }));

  for (const assignment of assignments) {
    const fieldId = assignment.expression.match(
      /\.replace\(\s*(["'])[^"']+\1\s*,\s*(["'])(fd_[A-Za-z0-9_]+)\2\s*\)/
    )?.[3] || assignment.expression.match(
      /\brouteSecondaryField\(\s*[^,]+,\s*(["'])[^"']+\1\s*,\s*(["'])(fd_[A-Za-z0-9_]+)\2\s*\)/
    )?.[3];
    const column = fieldId ? columnByAlias(table, fieldId) : undefined;
    if (column) fields.set(assignment.name, column.id);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const assignment of assignments) {
      if (fields.has(assignment.name)) continue;
      const source = [...fields].find(([variableName]) =>
        new RegExp(`\\b${escapeRegExp(variableName)}\\b`).test(assignment.expression)
      );
      if (!source) continue;
      fields.set(assignment.name, source[1]);
      changed = true;
    }
  }
  return fields;
}

function literalColumnRefs(text, table) {
  const refs = [];
  for (const column of table.columns || []) {
    for (const alias of columnAliases(column)) {
      if (!new RegExp(`(["'])${escapeRegExp(alias)}\\1`).test(text)) continue;
      refs.push(column.id);
      break;
    }
  }
  return unique(refs);
}

function unresolvedLiteralFieldIds(text, table) {
  const knownAliases = new Set((table.columns || []).flatMap(columnAliases));
  return unique([...String(text || "").matchAll(/(["'])(fd_[A-Za-z0-9_]+)\1/g)]
    .map((match) => match[2])
    .filter((fieldId) => !knownAliases.has(fieldId)));
}

function columnByAlias(table, fieldId) {
  return (table.columns || []).find((column) =>
    columnAliases(column).includes(fieldId)
  );
}

function columnAliases(column) {
  return unique([
    column?.id,
    column?.sourceProps?.originalId,
    column?.sourceProps?.designerId,
    column?.sourceProps?.designerValues?.id,
    column?.sourceProps?.metadataId
  ]);
}

function isSelectColumn(columns, fieldId) {
  const column = columns.find((candidate) => candidate.id === fieldId);
  return column?.componentId === "xform-select" || column?.type === "singleSelect";
}

function tablePlaceholder(tableId) {
  return `\${table:${tableId}}`;
}

function only(values) {
  const distinct = unique(values);
  return distinct.length === 1 ? distinct[0] : undefined;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function uniqueRanges(ranges) {
  const seen = new Set();
  return ranges.filter((range) => {
    if (
      !range?.sourceRef ||
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.end <= range.start
    ) {
      return false;
    }
    const key = `${range.sourceRef}:${range.start}:${range.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function callEnd(text, start) {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (text[index] === ")") index += 1;
  while (index < text.length && /[\s;]/.test(text[index])) index += 1;
  return index;
}

function findBalancedClose(text, open) {
  let depth = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < text.length; index += 1) {
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
    if (char === "{") depth += 1;
    if (char !== "}") continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { DETAIL_CASCADE_BASIS };
