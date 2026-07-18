const LEGACY_RUNTIME_FUNCTIONS = new Set([
  "SetXFormFieldValueById",
  "getFormFieldValue",
  "_DocList_FormFieldValue",
  "_DocList_FormRowValue",
  "_DocList_AddRows",
  "buildDetailTableFieldId"
]);

export function financeDetailGenerationTranslation({ handler, sources = [] } = {}) {
  if (!handler || !Array.isArray(sources) || !sources.length) return undefined;

  const definitions = sources.flatMap(functionDefinitions);
  const handlerDefinitions = definitions.filter(definition => definition.name === handler);
  if (handlerDefinitions.length !== 1) return undefined;
  const handlerDefinition = handlerDefinitions[0];

  const replacementHelpers = definitions.filter(definition =>
    definition.name === "_DocList_AddRows" && replacementHelperModel(definition)
  );
  if (replacementHelpers.length !== 1) return undefined;
  const replacementHelper = replacementHelpers[0];

  const replacementCall = handlerDefinition.text.match(
    /\b_DocList_AddRows\s*\(\s*([A-Za-z_$][\w$]*|["']fd_[A-Za-z0-9_]+["'])\s*,\s*([A-Za-z_$][\w$]*)\s*\)/
  );
  if (!replacementCall) return undefined;

  const closure = functionClosure(handlerDefinition, definitions);
  if (!closure) return undefined;
  const globalCandidates = globalLiteralDeclarations(sources, definitions);
  const referencedGlobalNames = closureFreeVariableNames(closure);
  if (!referencedGlobalNames) return undefined;
  const mutatedClosureGlobals = [...referencedGlobalNames].filter(name => closure.some(definition =>
    hasVariableMutation(definition.text, name, { includeDeclaration: false })
  ));
  if (mutatedClosureGlobals.length) return undefined;
  const targetTableVariable = identifierFromExpression(replacementCall[1]);
  if (targetTableVariable) referencedGlobalNames.add(targetTableVariable);
  const globals = uniqueGlobalDeclarations(globalCandidates, referencedGlobalNames);
  if (!globals) return undefined;
  const targetDetailTableId = resolveTableId(replacementCall[1], globals);
  if (!targetDetailTableId) return undefined;
  const rowConstructor = closure.find(definition =>
    /this\s*\[\s*buildDetailTableFieldId\s*\(/.test(definition.text)
  );
  const rowModel = rowConstructorModel(rowConstructor, globals, targetDetailTableId);
  if (!rowModel) return undefined;

  const payeeFunction = closure.find(definition =>
    /\bDocList_TableInfo\b/.test(definition.text) &&
    /extendDataFormInfo\.value\s*\(/.test(definition.text) &&
    /\.lastIndex\b/.test(definition.text)
  );
  const payeeModel = payeeFunction ? payeeFunctionModel(payeeFunction, globals) : undefined;
  if (payeeFunction && !payeeModel) return undefined;

  const tableVariables = referencedTableVariables(closure, payeeModel);
  tableVariables.add(identifierFromExpression(replacementCall[1]));
  const referencedGlobals = [...globals.values()].filter(declaration =>
    closure.some(definition => hasIdentifier(definition.text, declaration.name))
  );
  for (const declaration of referencedGlobals) {
    if (tableVariables.has(declaration.name) && !isTableId(declaration.value)) return undefined;
  }

  const sourceRefs = new Set([
    handlerDefinition.sourceRef,
    replacementHelper.sourceRef,
    ...closure.map(definition => definition.sourceRef),
    ...referencedGlobals.map(declaration => declaration.sourceRef)
  ]);
  const globalLines = referencedGlobals.map(declaration => {
    const value = tableVariables.has(declaration.name)
      ? tablePlaceholder(declaration.value)
      : declaration.value;
    return `  var ${declaration.name} = ${JSON.stringify(value)};`;
  });

  const translatedFunctions = [];
  for (const definition of closure) {
    if (definition.name === rowConstructor.name) {
      translatedFunctions.push(indentFunction(renderRowConstructor(rowModel), 2));
      continue;
    }
    if (payeeFunction && definition.name === payeeFunction.name) {
      translatedFunctions.push(indentFunction(renderPayeeFunction(payeeModel), 2));
      continue;
    }
    const translated = translateLegacyFunction(definition.text);
    if (containsLegacyRuntime(translated)) return undefined;
    translatedFunctions.push(indentFunction(translated, 2));
  }

  const fn = [
    "function onClick() {",
    ...globalLines,
    ...runtimeHelpers().map(helper => indentFunction(helper, 2)),
    ...translatedFunctions,
    `  return ${handler}();`,
    "}"
  ].join("\n");
  if (containsLegacyRuntime(fn)) return undefined;

  return {
    function: fn,
    targetDetailTableId,
    translationBasis: "deterministic-finance-detail-generation",
    sourceRefs: [...sourceRefs].filter(Boolean),
    coveredCalculationSourceRefs: [...new Set(closure.map(definition => definition.sourceRef).filter(Boolean))],
    coveredCalculationRanges: closure.map(definition => ({
      sourceRef: definition.sourceRef,
      name: definition.name,
      start: definition.start,
      end: definition.end
    }))
  };
}

function functionDefinitions(source) {
  const text = String(source?.javascript || "");
  const definitions = [];
  const pattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  let match;
  while ((match = pattern.exec(text))) {
    const openingBrace = pattern.lastIndex - 1;
    const end = matchingBraceEnd(text, openingBrace);
    if (end < 0) break;
    definitions.push({
      name: match[1],
      text: text.slice(match.index, end),
      start: match.index,
      end,
      sourceRef: source.sourceRef
    });
    pattern.lastIndex = end;
  }
  return definitions;
}

function matchingBraceEnd(text, openingBrace) {
  let depth = 0;
  let quote;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingBrace; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (current === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = undefined;
      continue;
    }
    if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === "\"" || current === "'" || current === "`") {
      quote = current;
      continue;
    }
    if (current === "{") depth += 1;
    if (current === "}" && --depth === 0) return index + 1;
  }
  return -1;
}

function globalLiteralDeclarations(sources, definitions) {
  const definitionsBySource = new Map();
  for (const definition of definitions) {
    const items = definitionsBySource.get(definition.sourceRef) || [];
    items.push(definition);
    definitionsBySource.set(definition.sourceRef, items);
  }

  const declarations = new Map();
  const topLevels = [];
  for (const source of sources) {
    let topLevel = String(source.javascript || "");
    const sourceDefinitions = [...(definitionsBySource.get(source.sourceRef) || [])]
      .sort((left, right) => right.start - left.start);
    for (const definition of sourceDefinitions) {
      topLevel = `${topLevel.slice(0, definition.start)}${" ".repeat(definition.end - definition.start)}${topLevel.slice(definition.end)}`;
    }
    topLevel = stripComments(topLevel);
    topLevels.push(topLevel);
    for (const match of topLevel.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])([^"']*)\2\s*;/g)) {
      const values = declarations.get(match[1]) || [];
      const declaration = { name: match[1], value: match[3], sourceRef: source.sourceRef };
      values.push(declaration);
      declarations.set(match[1], values);
    }
    for (const match of topLevel.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*\[([\s\S]*?)\]\s*;/g)) {
      const values = [...match[2].matchAll(/(["'])([^"']*)\1/g)].map(item => item[2]);
      if (!values.length) continue;
      const declarationsForName = declarations.get(match[1]) || [];
      const declaration = { name: match[1], value: values, sourceRef: source.sourceRef };
      declarationsForName.push(declaration);
      declarations.set(match[1], declarationsForName);
    }
  }
  for (const [name, values] of declarations) {
    const directAssignments = topLevels.reduce((total, topLevel) => total + [
      ...maskCodeLiteralsAndComments(topLevel).matchAll(new RegExp(
        `\\b${escapeRegExp(name)}\\s*(?:[+\\-*/%]?=|\\+\\+|--)`,
        "gu"
      ))
    ].length, 0);
    const mutable = directAssignments !== values.length || topLevels.some(topLevel =>
      hasVariableMutation(topLevel, name, { includeDeclaration: false })
    );
    for (const value of values) value.mutable = mutable;
  }
  return declarations;
}

function hasVariableMutation(text, name, { includeDeclaration } = {}) {
  let code = maskCodeLiteralsAndComments(text);
  if (!includeDeclaration) {
    code = code.replace(new RegExp(
      `\\bvar\\s+${escapeRegExp(name)}\\s*=\\s*(?:\\[[\\s\\S]*?\\]|[^;]+)\\s*;`,
      "gu"
    ), match => " ".repeat(match.length));
  }
  const memberWrite = new RegExp(
    `\\b${escapeRegExp(name)}\\s*(?:\\[[^\\]]+\\]|\\.[A-Za-z_$][\\w$]*)\\s*(?:[+\\-*/%]?=|\\+\\+|--)`,
    "u"
  );
  const mutatorCall = new RegExp(
    `\\b${escapeRegExp(name)}\\s*\\.\\s*(?:copyWithin|fill|pop|push|reverse|shift|sort|splice|unshift)\\s*\\(`,
    "u"
  );
  const directWrite = new RegExp(
    `\\b${escapeRegExp(name)}\\s*(?:[+\\-*/%]?=|\\+\\+|--)`,
    "u"
  );
  return memberWrite.test(code) || mutatorCall.test(code) || directWrite.test(code);
}

function uniqueGlobalDeclarations(candidates, names) {
  const globals = new Map();
  for (const name of names) {
    const declarations = candidates.get(name) || [];
    if (!declarations.length || declarations.some(declaration => declaration.mutable)) return undefined;
    const value = JSON.stringify(declarations[0].value);
    if (declarations.some(declaration => JSON.stringify(declaration.value) !== value)) return undefined;
    globals.set(name, declarations[0]);
  }
  return globals;
}

function closureFreeVariableNames(closure) {
  const closureNames = new Set(closure.map(definition => definition.name));
  const free = new Set();
  for (const definition of closure) {
    const parts = definitionParts(definition);
    if (!parts) return undefined;
    const declared = new Set([definition.name, ...parts.params]);
    const code = maskCodeLiteralsAndComments(definition.text);
    for (const match of code.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/gu)) declared.add(match[1]);
    for (const match of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/gu)) declared.add(match[1]);
    for (const match of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/gu)) declared.add(match[1]);
    for (const match of code.matchAll(/[A-Za-z_$][\w$]*/gu)) {
      const name = match[0];
      if (declared.has(name) || closureNames.has(name) || FREE_IDENTIFIER_ALLOWLIST.has(name)) continue;
      let previous = match.index - 1;
      while (previous >= 0 && /\s/u.test(code[previous])) previous -= 1;
      if (code[previous] === ".") continue;
      let next = match.index + name.length;
      while (next < code.length && /\s/u.test(code[next])) next += 1;
      if (code[next] === ":") continue;
      free.add(name);
    }
  }
  return free;
}

const FREE_IDENTIFIER_ALLOWLIST = new Set([
  "Array", "Boolean", "Date", "Infinity", "JSON", "Map", "Math", "NaN", "Number", "Object", "RegExp", "Set", "String",
  "break", "case", "catch", "const", "continue", "debugger", "default", "delete", "do", "else", "false", "finally", "for", "function",
  "if", "in", "instanceof", "let", "new", "null", "return", "switch", "this", "throw", "true", "try", "typeof", "undefined", "var", "void", "while", "with", "yield",
  "console", "decodeURIComponent", "encodeURIComponent", "isFinite", "isNaN", "parseFloat", "parseInt",
  "$", "jQuery", "DocList_TableInfo", "DocList_AddRow", "DocListFunc_RefreshIndex", "document",
  "SetXFormFieldValueById", "getFormFieldValue", "buildDetailTableFieldId",
  "_DocList_FormFieldValue", "_DocList_FormRowValue", "_DocList_AddRows"
]);

function maskCodeLiteralsAndComments(value) {
  const characters = stripComments(String(value || "")).split("");
  let quote = "";
  let escaped = false;
  for (let index = 0; index < characters.length; index += 1) {
    const char = characters[index];
    if (quote) {
      if (char !== "\n" && char !== "\r") characters[index] = " ";
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      characters[index] = " ";
    }
  }
  return characters.join("");
}

function functionClosure(handlerDefinition, definitions) {
  const byName = new Map();
  for (const definition of definitions) {
    const candidates = byName.get(definition.name) || [];
    candidates.push(definition);
    byName.set(definition.name, candidates);
  }
  const result = [];
  const seen = new Set();
  const pending = [handlerDefinition];
  while (pending.length) {
    const definition = pending.shift();
    const name = definition.name;
    if (seen.has(name) || LEGACY_RUNTIME_FUNCTIONS.has(name)) continue;
    seen.add(name);
    result.push(definition);
    for (const calledName of calledFunctionNames(definition.text)) {
      if (seen.has(calledName) || LEGACY_RUNTIME_FUNCTIONS.has(calledName)) continue;
      const candidates = byName.get(calledName) || [];
      if (!candidates.length) continue;
      if (candidates.length !== 1) return undefined;
      pending.push(candidates[0]);
    }
  }
  return result;
}

function calledFunctionNames(text) {
  const names = [];
  const pattern = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of String(text || "").matchAll(pattern)) {
    if (!["if", "for", "while", "switch", "catch", "function", "typeof"].includes(match[2])) names.push(match[2]);
  }
  return names;
}

function rowConstructorModel(definition, globals, targetDetailTableId) {
  if (!definition) return undefined;
  const parts = definitionParts(definition);
  if (!parts || parts.params.length !== 1) return undefined;
  const [parameter] = parts.params;
  const loopHeader = /\bfor\s*\(\s*var\s+([A-Za-z_$][\w$]*)\s*=\s*0\s*;\s*\1\s*<\s*([A-Za-z_$][\w$]*)\.length\s*;\s*(?:\1\+\+|\1\s*\+=\s*1)\s*\)\s*\{/u.exec(parts.body);
  if (!loopHeader || [...parts.body.matchAll(/\bfor\s*\(/gu)].length !== 1) return undefined;
  const loopOpen = loopHeader.index + loopHeader[0].length - 1;
  const loopClose = balancedBraceClose(parts.body, loopOpen);
  if (loopClose <= loopOpen) return undefined;
  const loopBody = parts.body.slice(loopOpen + 1, loopClose);
  const columnStatement = new RegExp(
    `\\bvar\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapeRegExp(loopHeader[2])}\\s*\\[\\s*${escapeRegExp(loopHeader[1])}\\s*\\]\\s*;`,
    "u"
  ).exec(loopBody);
  if (!columnStatement) return undefined;
  const assignment = new RegExp(
    `\\bthis\\s*\\[\\s*buildDetailTableFieldId\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*,\\s*${escapeRegExp(columnStatement[1])}\\s*\\)\\s*\\]\\s*=\\s*${escapeRegExp(parameter)}\\s*\\[\\s*${escapeRegExp(columnStatement[1])}\\s*\\]\\s*;?`,
    "u"
  ).exec(loopBody);
  if (!assignment || !(columnStatement.index < assignment.index)) return undefined;
  if (!containsOnlyRanges(loopBody, [columnStatement, assignment])) return undefined;
  if (!containsOnlyRanges(parts.body, [{
    index: loopHeader.index,
    0: parts.body.slice(loopHeader.index, loopClose + 1)
  }])) return undefined;

  const columns = globals.get(loopHeader[2])?.value;
  const tableId = resolveTableId(assignment[1], globals);
  if (!Array.isArray(columns) || !columns.length || tableId !== targetDetailTableId) return undefined;
  return { name: definition.name, parameter, columns };
}

function payeeFunctionModel(definition, globals) {
  const parts = definitionParts(definition);
  if (!parts || parts.params.length !== 2) return undefined;
  const [dataParameter, detailParameter] = parts.params;
  const columnDeclarations = [...parts.body.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(fd_[A-Za-z0-9_]+)\2\s*;/gu)];
  if (columnDeclarations.length !== 3) return undefined;
  const [amountDeclaration, nameDeclaration, cardDeclaration] = columnDeclarations;

  const tableAssignment = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])TABLE_DL_\2\s*\+\s*([A-Za-z_$][\w$]*)\s*;/u.exec(parts.body);
  const directInfoAssignment = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*DocList_TableInfo\s*\[\s*(["'])TABLE_DL_\2\s*\+\s*([A-Za-z_$][\w$]*)\s*\]\s*;/u.exec(parts.body);
  const tableVariable = tableAssignment?.[3] || directInfoAssignment?.[3];
  const tableId = globals.get(tableVariable)?.value;
  const infoAssignment = tableAssignment
    ? new RegExp(
      `\\bvar\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*DocList_TableInfo\\s*\\[\\s*${escapeRegExp(tableAssignment[1])}\\s*\\]\\s*;`,
      "u"
    ).exec(parts.body)
    : directInfoAssignment;
  if (!infoAssignment || !isTableId(tableId)) return undefined;

  const guard = new RegExp(
    `\\bif\\s*\\(\\s*typeof\\s*(?:\\(\\s*${escapeRegExp(infoAssignment[1])}\\s*\\)|${escapeRegExp(infoAssignment[1])})\\s*!={1,2}\\s*(["'])undefined\\1\\s*\\)\\s*\\{`,
    "u"
  ).exec(parts.body);
  if (!guard) return undefined;
  const guardOpen = guard.index + guard[0].length - 1;
  const guardClose = balancedBraceClose(parts.body, guardOpen);
  if (guardClose <= guardOpen) return undefined;
  const guardBody = parts.body.slice(guardOpen + 1, guardClose);
  const loopHeader = new RegExp(
    `\\bfor\\s*\\(\\s*var\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*0\\s*;\\s*\\1\\s*<\\s*${escapeRegExp(infoAssignment[1])}\\.lastIndex\\s*-\\s*1\\s*;\\s*(?:\\1\\+\\+|\\1\\s*\\+=\\s*1)\\s*\\)\\s*\\{`,
    "u"
  ).exec(guardBody);
  if (!loopHeader || [...guardBody.matchAll(/\bfor\s*\(/gu)].length !== 1) return undefined;
  const loopOpen = loopHeader.index + loopHeader[0].length - 1;
  const loopClose = balancedBraceClose(guardBody, loopOpen);
  if (loopClose <= loopOpen) return undefined;
  const loopBody = guardBody.slice(loopOpen + 1, loopClose);

  const rowAssignments = [amountDeclaration, nameDeclaration, cardDeclaration].map(declaration =>
    [...loopBody.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+)\s*;/gu)]
      .find(match => isExactRowIdExpression(match[2], tableVariable, loopHeader[1], declaration[1]))
  );
  if (rowAssignments.some(match => !match)) return undefined;
  const allValueDeclarations = [...loopBody.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+)\s*;/gu)];
  const valueAssignments = rowAssignments.map(rowAssignment =>
    allValueDeclarations.filter(match => isExactLegacyRowValue(match[2], rowAssignment[1]))
  );
  if (valueAssignments[0].length !== 1 || valueAssignments[1].length > 1 || valueAssignments[2].length > 1) return undefined;
  const amountValue = valueAssignments[0][0];
  const amountConversions = allValueDeclarations.filter(match => new RegExp(
    `^\\s*Number\\s*\\(\\s*${escapeRegExp(amountValue[1])}\\s*\\)\\s*$`,
    "u"
  ).test(match[2]));
  if (amountConversions.length > 1) return undefined;
  const amountExpression = amountConversions.length
    ? amountConversions[0][1]
    : `Number(${amountValue[1]})`;

  const targetAssignments = [...loopBody.matchAll(new RegExp(
    `\\b${escapeRegExp(detailParameter)}\\.(fd_[A-Za-z0-9_]+)\\s*=\\s*([^;]+)\\s*;`,
    "gu"
  ))];
  if (targetAssignments.length !== 2) return undefined;
  const selectedRowForExpression = expression => {
    for (let index = 0; index < rowAssignments.length; index += 1) {
      if (isExactLegacyRowValue(expression, rowAssignments[index][1])) return index;
      if (valueAssignments[index].some(match => String(expression).trim() === match[1])) return index;
    }
    return -1;
  };
  if (selectedRowForExpression(targetAssignments[0][2]) !== 1) return undefined;
  if (selectedRowForExpression(targetAssignments[1][2]) !== 2) return undefined;

  const splitCalls = [...loopBody.matchAll(new RegExp(
    `\\b${escapeRegExp(dataParameter)}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\(\\s*${escapeRegExp(dataParameter)}\\s*,\\s*${escapeRegExp(amountExpression)}\\s*,\\s*1\\s*,\\s*${escapeRegExp(detailParameter)}\\s*\\)\\s*;`,
    "gu"
  ))];
  if (splitCalls.length !== 1) return undefined;
  const positiveGuard = exactPositiveGuard(loopBody, splitCalls[0], amountExpression);
  if (!positiveGuard) return undefined;

  const loopRanges = [
    ...rowAssignments,
    ...valueAssignments.flat(),
    ...amountConversions,
    ...targetAssignments,
    positiveGuard
  ];
  if (!containsOnlyRanges(loopBody, loopRanges)) return undefined;
  if (!containsOnlyRanges(guardBody, [{
    index: loopHeader.index,
    0: guardBody.slice(loopHeader.index, loopClose + 1)
  }])) return undefined;
  if (!containsOnlyRanges(parts.body, [
    ...columnDeclarations,
    ...(tableAssignment ? [tableAssignment] : []),
    infoAssignment,
    { index: guard.index, 0: parts.body.slice(guard.index, guardClose + 1) }
  ])) return undefined;
  const tableBindingIndex = tableAssignment?.index ?? infoAssignment.index;
  if (!(
    columnDeclarations[2].index < tableBindingIndex &&
    tableBindingIndex <= infoAssignment.index &&
    infoAssignment.index < guard.index &&
    rowAssignments[0].index < rowAssignments[1].index &&
    rowAssignments[1].index < rowAssignments[2].index &&
    rowAssignments[2].index < amountValue.index &&
    (!amountConversions.length || amountValue.index < amountConversions[0].index) &&
    (!valueAssignments[1].length || (
      rowAssignments[1].index < valueAssignments[1][0].index &&
      valueAssignments[1][0].index < targetAssignments[0].index
    )) &&
    (!valueAssignments[2].length || (
      rowAssignments[2].index < valueAssignments[2][0].index &&
      valueAssignments[2][0].index < targetAssignments[1].index
    )) &&
    amountValue.index < targetAssignments[0].index &&
    targetAssignments[0].index < targetAssignments[1].index &&
    (amountConversions[0]?.index ?? amountValue.index) < positiveGuard.index &&
    targetAssignments[1].index < positiveGuard.index
  )) return undefined;

  return {
    name: definition.name,
    dataParameter,
    detailParameter,
    tableVariable,
    tableId,
    amountColumn: amountDeclaration[3],
    nameColumn: nameDeclaration[3],
    cardColumn: cardDeclaration[3],
    payeeTarget: targetAssignments[0][1],
    cardTarget: targetAssignments[1][1],
    splitName: splitCalls[0][1]
  };
}

function replacementHelperModel(definition) {
  const parts = definitionParts(definition);
  if (!parts || parts.params.length !== 2) return undefined;
  const [tableParameter, rowsParameter] = parts.params;
  const tableAssignment = new RegExp(
    `\\bvar\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*document\\.getElementById\\s*\\(\\s*(["'])TABLE_DL_\\2\\s*\\+\\s*${escapeRegExp(tableParameter)}\\s*\\)\\s*;`,
    "u"
  ).exec(parts.body);
  if (!tableAssignment) return undefined;
  const infoAssignment = new RegExp(
    `\\bvar\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*DocList_TableInfo\\s*\\[\\s*${escapeRegExp(tableAssignment[1])}\\.id\\s*\\]\\s*;`,
    "u"
  ).exec(parts.body);
  if (!infoAssignment) return undefined;
  const guard = new RegExp(
    `\\bif\\s*\\(\\s*${escapeRegExp(infoAssignment[1])}\\s*\\)\\s*\\{`,
    "u"
  ).exec(parts.body);
  if (!guard) return undefined;
  const guardOpen = guard.index + guard[0].length - 1;
  const guardClose = balancedBraceClose(parts.body, guardOpen);
  if (guardClose <= guardOpen) return undefined;
  const guardBody = parts.body.slice(guardOpen + 1, guardClose);
  const deleteLoop = new RegExp(
    `\\bfor\\s*\\(\\s*var\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapeRegExp(infoAssignment[1])}\\.lastIndex\\s*-\\s*1\\s*;\\s*\\1\\s*>\\s*0\\s*;\\s*(?:\\1--|\\1\\s*-=\\s*1)\\s*\\)\\s*\\{?`,
    "u"
  ).exec(guardBody);
  if (!deleteLoop) return undefined;
  let deleteRange;
  if (deleteLoop[0].trimEnd().endsWith("{")) {
    const deleteOpen = deleteLoop.index + deleteLoop[0].length - 1;
    const deleteClose = balancedBraceClose(guardBody, deleteOpen);
    if (deleteClose <= deleteOpen) return undefined;
    const deleteBody = guardBody.slice(deleteOpen + 1, deleteClose);
    const deleteRow = new RegExp(
      `\\b${escapeRegExp(tableAssignment[1])}\\.deleteRow\\s*\\(\\s*${escapeRegExp(deleteLoop[1])}\\s*\\)\\s*;`,
      "u"
    ).exec(deleteBody);
    if (!deleteRow) return undefined;
    const indexDecrement = new RegExp(
      `\\b${escapeRegExp(infoAssignment[1])}\\.lastIndex\\s*(?:--|-=\\s*1)\\s*;`,
      "u"
    ).exec(deleteBody);
    const refreshLoop = new RegExp(
      `\\bfor\\s*\\(\\s*var\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapeRegExp(deleteLoop[1])}\\s*;\\s*\\1\\s*<\\s*${escapeRegExp(infoAssignment[1])}\\.lastIndex\\s*;\\s*(?:\\1\\+\\+|\\1\\s*\\+=\\s*1)\\s*\\)\\s*\\{`,
      "u"
    ).exec(deleteBody);
    const deleteRanges = [deleteRow];
    if (indexDecrement || refreshLoop) {
      if (!indexDecrement || !refreshLoop || !(deleteRow.index < indexDecrement.index && indexDecrement.index < refreshLoop.index)) {
        return undefined;
      }
      const refreshOpen = refreshLoop.index + refreshLoop[0].length - 1;
      const refreshClose = balancedBraceClose(deleteBody, refreshOpen);
      if (refreshClose <= refreshOpen) return undefined;
      const refreshBody = deleteBody.slice(refreshOpen + 1, refreshClose);
      const refreshCall = new RegExp(
        `\\bDocListFunc_RefreshIndex\\s*\\(\\s*${escapeRegExp(infoAssignment[1])}\\s*,\\s*${escapeRegExp(refreshLoop[1])}\\s*\\)\\s*;`,
        "u"
      ).exec(refreshBody);
      if (!refreshCall || !containsOnlyRanges(refreshBody, [refreshCall])) return undefined;
      deleteRanges.push(indexDecrement, {
        index: refreshLoop.index,
        0: deleteBody.slice(refreshLoop.index, refreshClose + 1)
      });
    }
    if (!containsOnlyRanges(deleteBody, deleteRanges)) return undefined;
    deleteRange = { index: deleteLoop.index, 0: guardBody.slice(deleteLoop.index, deleteClose + 1) };
  } else {
    const remainder = guardBody.slice(deleteLoop.index + deleteLoop[0].length);
    const deleteRow = new RegExp(
      `^\\s*${escapeRegExp(tableAssignment[1])}\\.deleteRow\\s*\\(\\s*${escapeRegExp(deleteLoop[1])}\\s*\\)\\s*;`,
      "u"
    ).exec(remainder);
    if (!deleteRow) return undefined;
    deleteRange = {
      index: deleteLoop.index,
      0: guardBody.slice(deleteLoop.index, deleteLoop.index + deleteLoop[0].length + deleteRow[0].length)
    };
  }
  if (!containsOnlyRanges(guardBody, [deleteRange])) return undefined;

  const afterGuard = parts.body.slice(guardClose + 1);
  const addLoop = new RegExp(
    `\\bfor\\s*\\(\\s*var\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*0\\s*;\\s*\\1\\s*<\\s*${escapeRegExp(rowsParameter)}\\.length\\s*;\\s*(?:\\1\\+\\+|\\1\\s*\\+=\\s*1)\\s*\\)\\s*\\{?`,
    "u"
  ).exec(afterGuard);
  if (!addLoop) return undefined;
  let addRange;
  if (addLoop[0].trimEnd().endsWith("{")) {
    const addOpen = addLoop.index + addLoop[0].length - 1;
    const addClose = balancedBraceClose(afterGuard, addOpen);
    if (addClose <= addOpen) return undefined;
    const addBody = afterGuard.slice(addOpen + 1, addClose);
    const addCall = exactAddRowCall(addBody, tableAssignment[1], rowsParameter, addLoop[1]);
    if (!addCall || !containsOnlyRanges(addBody, [addCall])) return undefined;
    addRange = { index: addLoop.index, 0: afterGuard.slice(addLoop.index, addClose + 1) };
  } else {
    const remainder = afterGuard.slice(addLoop.index + addLoop[0].length);
    const addCall = exactAddRowCall(remainder, tableAssignment[1], rowsParameter, addLoop[1]);
    if (!addCall || stripComments(remainder.slice(0, addCall.index)).trim()) return undefined;
    addRange = {
      index: addLoop.index,
      0: afterGuard.slice(addLoop.index, addLoop.index + addLoop[0].length + addCall.index + addCall[0].length)
    };
  }
  if (!containsOnlyRanges(afterGuard, [addRange])) return undefined;
  if (!(tableAssignment.index < infoAssignment.index && infoAssignment.index < guard.index)) return undefined;
  if (!containsOnlyRanges(parts.body, [
    tableAssignment,
    infoAssignment,
    { index: guard.index, 0: parts.body.slice(guard.index, guardClose + 1) },
    { index: guardClose + 1 + addRange.index, 0: addRange[0] }
  ])) return undefined;
  return { tableParameter, rowsParameter };
}

function exactAddRowCall(text, tableVariable, rowsParameter, indexVariable) {
  return new RegExp(
    `\\bDocList_AddRow\\s*\\(\\s*${escapeRegExp(tableVariable)}\\s*,\\s*null\\s*,\\s*${escapeRegExp(rowsParameter)}\\s*\\[\\s*${escapeRegExp(indexVariable)}\\s*\\]\\s*\\)\\s*;`,
    "u"
  ).exec(text);
}

function definitionParts(definition) {
  const signature = /^\s*function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)\s*\{/u.exec(String(definition?.text || ""));
  if (!signature) return undefined;
  const open = signature.index + signature[0].length - 1;
  const close = balancedBraceClose(definition.text, open);
  if (close <= open || stripComments(definition.text.slice(close + 1)).trim()) return undefined;
  return {
    params: signature[1].split(",").map(value => value.trim()).filter(Boolean),
    body: definition.text.slice(open + 1, close)
  };
}

function isExactRowIdExpression(expression, tableVariable, rowVariable, columnVariable) {
  return new RegExp(
    `^\\s*${escapeRegExp(tableVariable)}\\s*\\+\\s*(["'])\\.\\1\\s*\\+\\s*${escapeRegExp(rowVariable)}\\s*\\+\\s*(["'])\\.\\2\\s*\\+\\s*${escapeRegExp(columnVariable)}\\s*$`,
    "u"
  ).test(String(expression));
}

function isExactLegacyRowValue(expression, rowVariable) {
  return new RegExp(
    `^\\s*\\$\\(\\s*(["'])(?:input)?\\[name=(["']?)extendDataFormInfo\\.value\\(\\1\\s*\\+\\s*${escapeRegExp(rowVariable)}\\s*\\+\\s*\\1\\)\\2\\]\\1\\s*\\)\\.val\\(\\)\\s*$`,
    "u"
  ).test(String(expression));
}

function exactPositiveGuard(body, call, amountExpression) {
  const headerPattern = new RegExp(
    `\\bif\\s*\\(\\s*${escapeRegExp(amountExpression)}\\s*>\\s*0\\s*\\)\\s*\\{`,
    "gu"
  );
  for (const header of String(body).matchAll(headerPattern)) {
    const open = header.index + header[0].length - 1;
    const close = balancedBraceClose(body, open);
    if (close <= open || !(open < call.index && call.index < close)) continue;
    const inside = body.slice(open + 1, close);
    const localCall = { index: call.index - open - 1, 0: call[0] };
    if (containsOnlyRanges(inside, [localCall])) {
      return { index: header.index, 0: body.slice(header.index, close + 1) };
    }
  }
  const single = new RegExp(
    `\\bif\\s*\\(\\s*${escapeRegExp(amountExpression)}\\s*>\\s*0\\s*\\)\\s*${escapeRegExp(call[0])}`,
    "u"
  ).exec(body);
  return single && single.index <= call.index ? single : undefined;
}

function containsOnlyRanges(text, ranges) {
  const characters = String(text).split("");
  for (const range of ranges) {
    for (let index = range.index; index < range.index + range[0].length; index += 1) {
      if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
    }
  }
  return stripComments(characters.join("")).trim() === "";
}

function balancedBraceClose(text, open) {
  const end = matchingBraceEnd(text, open);
  return end < 0 ? -1 : end - 1;
}

function referencedTableVariables(closure, payeeModel) {
  const variables = new Set();
  for (const definition of closure) {
    for (const match of definition.text.matchAll(
      /\b(?:_DocList_FormFieldValue|_DocList_FormRowValue|_DocList_AddRows)\s*\(\s*([A-Za-z_$][\w$]*)/g
    )) variables.add(match[1]);
  }
  if (payeeModel?.tableVariable) variables.add(payeeModel.tableVariable);
  return variables;
}

function renderRowConstructor(model) {
  return [
    `function ${model.name}(${model.parameter}) {`,
    "  var row = {};",
    `  var columns = ${JSON.stringify(model.columns)};`,
    "  for (var index = 0; index < columns.length; index += 1) {",
    "    var column = columns[index];",
    `    row[column] = ${model.parameter}[column];`,
    "  }",
    "  return row;",
    "}"
  ].join("\n");
}

function renderPayeeFunction(model) {
  return [
    `function ${model.name}(${model.dataParameter}, ${model.detailParameter}) {`,
    `  var rows = mkDetailRows(${model.tableVariable}, ${JSON.stringify([model.amountColumn, model.nameColumn, model.cardColumn])}, false);`,
    "  for (var index = 0; index < rows.length; index += 1) {",
    "    var row = rows[index] || {};",
    `    var amount = Number(row.${model.amountColumn} || 0);`,
    `    ${model.detailParameter}.${model.payeeTarget} = row.${model.nameColumn} || "";`,
    `    ${model.detailParameter}.${model.cardTarget} = row.${model.cardColumn} || "";`,
    `    if (amount > 0) ${model.dataParameter} = ${model.splitName}(${model.dataParameter}, amount, 1, ${model.detailParameter});`,
    "  }",
    `  return ${model.dataParameter};`,
    "}"
  ].join("\n");
}

function translateLegacyFunction(text) {
  const translated = stripComments(String(text || ""))
    .replace(/^\s*console\.log\([^\n]*\);?\s*$/gm, "")
    .replace(/\bSetXFormFieldValueById\s*\(/g, "MKXFORM.setValue(")
    .replace(/\bgetFormFieldValue\s*\(/g, "mkGetValue(")
    .replace(/\b_DocList_FormFieldValue\s*\(/g, "mkDetailColumn(")
    .replace(/\b_DocList_FormRowValue\s*\(/g, "mkDetailRows(")
    .replace(/\b_DocList_AddRows\s*\(/g, "MKXFORM.setDetailValues(")
    .replace(/\bnew\s+Object\s*\(\s*\)/g, "{}")
    .replace(
      /\$\(\s*(["'])(?:input|textarea|select)?\[name=(["'])extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)\2\]\1\s*\)/g,
      (_match, _outer, _inner, fieldId) => `mkField(${JSON.stringify(fieldId)})`
    )
    .replace(
      /\b(mkDetailColumn|mkDetailRows|MKXFORM\.setDetailValues)\(\s*(["'])(fd_[A-Za-z0-9_]+)\2/g,
      (_match, functionName, _quote, tableId) => `${functionName}(${JSON.stringify(tablePlaceholder(tableId))}`
    );
  return rewriteMkFieldCalls(translated)
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function rewriteMkFieldCalls(source) {
  let translated = String(source || "")
    .replace(
      /mkField\(("fd_[A-Za-z0-9_]+")\)\.val\(\s*((?:"[^"]*"|'[^']*'))\s*\)/g,
      (_match, fieldId, value) => `MKXFORM.setValue(${fieldId}, ${value})`
    )
    .replace(
      /mkField\(("fd_[A-Za-z0-9_]+")\)\.val\(\s*\)/g,
      (_match, fieldId) => `mkGetValue(${fieldId})`
    );
  const bindings = [...translated.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*mkField\(("fd_[A-Za-z0-9_]+")\)/g)];
  for (const binding of bindings) {
    const variable = escapeRegExp(binding[1]);
    const fieldId = binding[2];
    translated = translated
      .replace(
        new RegExp(`\\b${variable}\\.val\\(\\s*((?:\"[^\"]*\"|'[^']*'))\\s*\\)`, "g"),
        (_match, value) => `MKXFORM.setValue(${fieldId}, ${value})`
      )
      .replace(
        new RegExp(`\\b${variable}\\.val\\(\\s*\\)`, "g"),
        `mkGetValue(${fieldId})`
      );
  }
  return translated;
}

function runtimeHelpers() {
  return [
    [
      "function mkGetValue(id) {",
      "  var value = MKXFORM.getValue(id);",
      "  return Array.isArray(value) && value.length === 1 ? value[0] : value;",
      "}"
    ].join("\n"),
    [
      "function mkField(id) {",
      "  return { val: function(next) {",
      "    if (arguments.length > 0) { MKXFORM.setValue(id, next); return next; }",
      "    return mkGetValue(id);",
      "  } };",
      "}"
    ].join("\n"),
    [
      "function mkDetailRows(tableId, fieldIds, containSelectText) {",
      "  var tableValue = MKXFORM.getValue(tableId) || [];",
      "  var rows = Array.isArray(tableValue) ? tableValue : (tableValue.values || []);",
      "  var result = [];",
      "  for (var rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {",
      "    var sourceRow = rows[rowIndex] || {};",
      "    var targetRow = {};",
      "    for (var fieldIndex = 0; fieldIndex < fieldIds.length; fieldIndex += 1) {",
      "      var fieldId = fieldIds[fieldIndex];",
      "      var value = sourceRow[fieldId];",
      "      if (Array.isArray(value) && value.length === 1) value = value[0];",
      "      if (containSelectText) {",
      "        var text = MKXFORM.getValueText(tableId + '.' + fieldId, { detailRowIndex: rowIndex }) || '';",
      "        value = (text ? text : '') + '|' + (value ? value : '');",
      "      }",
      "      targetRow[fieldId] = value ? value : '';",
      "    }",
      "    result.push(targetRow);",
      "  }",
      "  return result;",
      "}"
    ].join("\n"),
    [
      "function mkDetailColumn(tableId, fieldId) {",
      "  var rows = mkDetailRows(tableId, [fieldId], false);",
      "  var values = [];",
      "  for (var index = 0; index < rows.length; index += 1) {",
      "    if (rows[index][fieldId]) values.push(rows[index][fieldId]);",
      "  }",
      "  return values;",
      "}"
    ].join("\n")
  ];
}

function stripComments(text) {
  let result = "";
  let quote;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (current === "\n") {
        lineComment = false;
        result += current;
      }
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (current === "\n") result += current;
      continue;
    }
    if (quote) {
      result += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = undefined;
      continue;
    }
    if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    result += current;
    if (current === "\"" || current === "'" || current === "`") quote = current;
  }
  return result;
}

function containsLegacyRuntime(text) {
  return /\b(?:document|DocList_TableInfo|DocList_AddRow|buildDetailTableFieldId|SetXFormFieldValueById|getFormFieldValue|_DocList_[A-Za-z0-9_]+)\b|jQuery|\$\(/.test(text);
}

function resolveTableId(expression, globals) {
  const literal = String(expression || "").match(/^["'](fd_[A-Za-z0-9_]+)["']$/)?.[1];
  if (literal) return literal;
  const value = globals.get(String(expression || ""))?.value;
  return isTableId(value) ? value : undefined;
}

function identifierFromExpression(expression) {
  return /^[A-Za-z_$][\w$]*$/.test(String(expression || "")) ? expression : undefined;
}

function isTableId(value) {
  return typeof value === "string" && /^fd_[A-Za-z0-9_]+$/.test(value);
}

function tablePlaceholder(tableId) {
  return `\${table:${tableId}}`;
}

function hasIdentifier(text, identifier) {
  return new RegExp(`\\b${escapeRegExp(identifier)}\\b`).test(text);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indentFunction(text, spaces) {
  const prefix = " ".repeat(spaces);
  return String(text || "").split("\n").map(line => `${prefix}${line}`).join("\n");
}
