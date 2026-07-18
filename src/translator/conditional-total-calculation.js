export function conditionalTotalCalculationModel(source = {}, sourceScripts = {}) {
  const text = maskComments(String(source.javascript || ""));
  for (const fn of namedFunctions(text)) {
    const model = conditionalFunctionModel(fn, source, sourceScripts);
    if (model) return model;
  }
  return undefined;
}

function conditionalFunctionModel(fn, source, sourceScripts) {
  if (!/\bXForm_GetChinaValue\s*\(/u.test(fn.body)) return undefined;
  const selected = selectedFieldVariables(fn.body);
  if (selected.size < 4) return undefined;
  const condition = fn.body.match(/\bif\s*\(\s*([A-Za-z_$][\w$]*)\s*={2,3}\s*(-?(?:\d+\.?\d*|\.\d+))\s*\)\s*\{/u);
  if (!condition) return undefined;
  const trueOpen = condition.index + condition[0].length - 1;
  const trueClose = balancedClose(fn.body, trueOpen);
  if (trueClose <= trueOpen) return undefined;
  const afterTrue = fn.body.slice(trueClose + 1).match(/^\s*else\s*\{/u);
  if (!afterTrue) return undefined;
  const falseOpen = trueClose + 1 + afterTrue[0].length - 1;
  const falseClose = balancedClose(fn.body, falseOpen);
  if (falseClose <= falseOpen) return undefined;

  const trueBranch = branchTotalModel(fn.body.slice(trueOpen + 1, trueClose), selected);
  const falseBranch = branchTotalModel(fn.body.slice(falseOpen + 1, falseClose), selected);
  if (!trueBranch || !falseBranch || trueBranch.totalVariable !== falseBranch.totalVariable) return undefined;
  const allSourceFieldIds = uniqueStrings([...trueBranch.fieldIds, ...falseBranch.fieldIds]);
  if (allSourceFieldIds.length < 2) return undefined;

  const totalTarget = uniqueSelectedWrite(fn.body, selected, trueBranch.totalVariable);
  if (!totalTarget) return undefined;
  const upperConversions = [...fn.body.matchAll(new RegExp(
    `\\bvar\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*XForm_GetChinaValue\\(\\s*${escapeRegExp(trueBranch.totalVariable)}\\s*\\)\\s*;`,
    "gu"
  ))];
  if (upperConversions.length !== 1) return undefined;
  const [upperConversion] = upperConversions;
  const upperTarget = uniqueSelectedWrite(fn.body, selected, upperConversion[1]);
  if (!upperTarget) return undefined;
  const roundings = [...fn.body.matchAll(new RegExp(
    `\\b${escapeRegExp(trueBranch.totalVariable)}\\s*=\\s*theFixedNumTwo\\(\\s*${escapeRegExp(trueBranch.totalVariable)}\\s*\\)\\s*;`,
    "gu"
  ))];
  if (roundings.length !== 1) return undefined;
  const [rounding] = roundings;
  if (!(
    falseClose < rounding.index &&
    rounding.index < totalTarget.match.index &&
    totalTarget.match.index < upperConversion.index &&
    upperConversion.index < upperTarget.match.index
  )) return undefined;
  if (hasUnclassifiedMutation(
    fn.body,
    falseClose + 1,
    upperTarget.match.index + upperTarget.match[0].length,
    [trueBranch.totalVariable, upperConversion[1]],
    [rounding, totalTarget.match, upperConversion, upperTarget.match]
  )) return undefined;

  const modeFieldId = sourceModeFieldId(sourceScripts, condition[1]);
  if (!modeFieldId) return undefined;
  const externalCalls = uniqueStrings(
    [...fn.body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)\s*;/gu)]
      .map((match) => match[1])
      .filter((name) => name !== fn.name)
  );
  const evidence = fn.body.slice(condition.index, falseClose + 1).replace(/\s+/gu, " ").trim();

  return {
    sourceRef: source.sourceRef,
    functionName: fn.name,
    modeFieldId,
    modeValue: Number(condition[2]),
    trueFieldIds: trueBranch.fieldIds,
    falseFieldIds: falseBranch.fieldIds,
    sourceFieldIds: allSourceFieldIds,
    totalTargetFieldId: selected.get(totalTarget.variable),
    uppercaseTargetFieldId: selected.get(upperTarget.variable),
    externalCalls,
    evidence,
    coveredCalculationRanges: [
      functionBodyRange(source, fn, "conditional-total", condition.index, falseClose + 1),
      functionBodyRange(source, fn, "fixed-two-rounding", rounding.index, rounding.index + rounding[0].length),
      functionBodyRange(source, fn, "total-target-write", totalTarget.match.index, totalTarget.match.index + totalTarget.match[0].length),
      functionBodyRange(source, fn, "uppercase-conversion", upperConversion.index, upperConversion.index + upperConversion[0].length),
      functionBodyRange(source, fn, "uppercase-target-write", upperTarget.match.index, upperTarget.match.index + upperTarget.match[0].length)
    ]
  };
}

function uniqueSelectedWrite(body, selected, valueVariable) {
  const writes = [];
  for (const variable of selected.keys()) {
    for (const match of body.matchAll(new RegExp(
      `\\b${escapeRegExp(variable)}\\.val\\(\\s*${escapeRegExp(valueVariable)}\\s*\\)`,
      "gu"
    ))) writes.push({ variable, match });
  }
  return writes.length === 1 ? writes[0] : undefined;
}

function functionBodyRange(source, fn, name, start, end) {
  return {
    sourceRef: source.sourceRef,
    name: `${fn.name}.${name}`,
    start: fn.bodyStart + start,
    end: fn.bodyStart + end
  };
}

function hasUnclassifiedMutation(body, start, end, variables, allowedRanges) {
  const fragment = body.slice(start, end).split("");
  for (const range of allowedRanges) {
    const localStart = Math.max(0, range.index - start);
    const localEnd = Math.min(fragment.length, range.index + range[0].length - start);
    for (let index = localStart; index < localEnd; index += 1) {
      if (fragment[index] !== "\n" && fragment[index] !== "\r") fragment[index] = " ";
    }
  }
  const residual = stripComments(fragment.join(""));
  return variables.some((variable) => new RegExp(
    `\\b${escapeRegExp(variable)}\\s*(?:[+\\-*/%]?=|\\+\\+|--)`,
    "u"
  ).test(residual));
}

function branchTotalModel(body, selected) {
  const executable = stripComments(body).trim();
  const assignment = executable.match(/^(?:var\s+)?([A-Za-z_$][\w$]*)\s*=\s*([^;]+)\s*;$/u);
  if (!assignment) return undefined;
  const variables = [...assignment[2].matchAll(/Number\(\s*([A-Za-z_$][\w$]*)\.val\(\)/gu)]
    .map((match) => match[1]);
  if (variables.length < 2) return undefined;
  const fieldIds = variables.map((variable) => selected.get(variable));
  if (fieldIds.some((fieldId) => !fieldId)) return undefined;
  const withoutTerms = assignment[2]
    .replace(/Number\(\s*([A-Za-z_$][\w$]*)\.val\(\)\s*\?\s*\1\.val\(\)\s*:\s*0\s*\)/gu, "1")
    .replace(/[\s+()]/gu, "");
  if (withoutTerms && !/^1+$/u.test(withoutTerms)) return undefined;
  return { totalVariable: assignment[1], fieldIds };
}

function stripComments(value) {
  return String(value || "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\r\n]*/gu, "");
}

function sourceModeFieldId(sourceScripts, modeVariable) {
  const pattern = new RegExp(
    `\\b(?:var\\s+)?${escapeRegExp(modeVariable)}\\s*=\\s*Number\\(\\s*getFormRadioValue\\(\\s*(["'])(fd_[A-Za-z0-9_]+)\\1\\s*\\)\\s*\\)`,
    "gu"
  );
  const fieldIds = new Set();
  for (const source of sourceScripts?.sources || []) {
    for (const match of maskComments(String(source.javascript || "")).matchAll(pattern)) fieldIds.add(match[2]);
  }
  return fieldIds.size === 1 ? [...fieldIds][0] : undefined;
}

function selectedFieldVariables(text) {
  const values = new Map();
  const pattern = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*\$\([^;\n]*?extendDataFormInfo\.value\((fd_[A-Za-z0-9_]+)\)[^;\n]*?\)\s*;/gu;
  for (const match of String(text).matchAll(pattern)) values.set(match[1], match[2]);
  return values;
}

function maskComments(value) {
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

function namedFunctions(text) {
  const functions = [];
  const pattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gu;
  for (const match of String(text).matchAll(pattern)) {
    const open = match.index + match[0].length - 1;
    const close = balancedClose(text, open);
    if (close > open) functions.push({
      name: match[1],
      params: match[2].split(",").map((value) => value.trim()).filter(Boolean),
      body: text.slice(open + 1, close),
      bodyStart: open + 1,
      start: match.index,
      end: close + 1
    });
  }
  return functions;
}

function balancedClose(text, open) {
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

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
