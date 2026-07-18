export function analyzeLegacyDetailSumHelper(helper) {
  if (!helper) return undefined;
  const params = helper.params.map((param) => param.trim()).filter(Boolean);
  if (params.length < 2 || params.length > 3) return undefined;
  const [tableParam, controlParam, targetParam] = params;
  const body = String(helper.body || "");

  const tableId = new RegExp(
    `\\bvar\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(["'])TABLE_DL_\\2\\s*\\+\\s*${escapeRegExp(tableParam)}\\s*;`,
    "u"
  ).exec(body);
  if (!tableId) return undefined;
  const tableInfo = new RegExp(
    `\\bvar\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*DocList_TableInfo\\s*\\[\\s*${escapeRegExp(tableId[1])}\\s*\\]\\s*;`,
    "u"
  ).exec(body);
  if (!tableInfo) return undefined;
  const sumInit = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*0(?:\.0+)?\s*;/u.exec(body);
  if (!sumInit) return undefined;
  const sumVariable = sumInit[1];

  const loopHeader = new RegExp(
    `\\bfor\\s*\\(\\s*var\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*0\\s*;\\s*\\1\\s*<\\s*${escapeRegExp(tableInfo[1])}\\.lastIndex\\s*-\\s*1\\s*;\\s*(?:\\1\\+\\+|\\1\\s*\\+=\\s*1)\\s*\\)\\s*\\{`,
    "u"
  ).exec(body);
  if (!loopHeader || [...body.matchAll(/\bfor\s*\(/gu)].length !== 1) return undefined;
  const loopOpen = loopHeader.index + loopHeader[0].length - 1;
  const loopClose = balancedBraceClose(body, loopOpen);
  if (loopClose <= loopOpen) return undefined;
  const loopBody = body.slice(loopOpen + 1, loopClose);
  const loopVariable = loopHeader[1];

  const rowAssignment = [...loopBody.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+)\s*;/gu)]
    .find((match) => isRowIdExpression(match[2], [tableParam, loopVariable, controlParam]));
  if (!rowAssignment) return undefined;
  const rowVariable = rowAssignment[1];
  const valueAssignment = [...loopBody.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+)\s*;/gu)]
    .find((match) => isRowValueExpression(match[2], rowVariable));
  if (!valueAssignment) return undefined;
  const valueVariable = valueAssignment[1];
  const sumUpdate = new RegExp(
    `\\b${escapeRegExp(sumVariable)}\\s*=\\s*(?:theFixedNumTwo\\s*\\(\\s*)?${escapeRegExp(sumVariable)}\\s*\\+\\s*Number\\s*\\(\\s*${escapeRegExp(valueVariable)}\\s*\\)\\s*\\)?\\s*;`,
    "u"
  ).exec(loopBody);
  if (!sumUpdate) return undefined;
  if (!(rowAssignment.index < valueAssignment.index && valueAssignment.index < sumUpdate.index)) {
    return undefined;
  }
  if (/\b(?:if|else|switch|for|while|do|try|catch|continue|break|return|throw)\b/u.test(stripComments(loopBody))) {
    return undefined;
  }
  if (!containsOnlyRanges(loopBody, [rowAssignment, valueAssignment, sumUpdate])) return undefined;

  const sumMutations = [...body.matchAll(new RegExp(
    `\\b${escapeRegExp(sumVariable)}\\s*(?:[+\\-*/%]?=|\\+\\+|--)`,
    "gu"
  ))];
  if (sumMutations.length !== 2) return undefined;

  const returnSum = new RegExp(`\\breturn\\s+${escapeRegExp(sumVariable)}\\s*;`, "u").exec(body);
  if (!returnSum) return undefined;
  let targetWrite;
  let clampsNonnegative = false;
  if (targetParam) {
    targetWrite = new RegExp(
      `\\b${escapeRegExp(targetParam)}\\s*(?:\\.val\\(\\s*(Math\\.max\\(\\s*${escapeRegExp(sumVariable)}\\s*,\\s*0\\s*\\)|${escapeRegExp(sumVariable)})\\s*\\)|\\.value\\s*=\\s*(Math\\.max\\(\\s*${escapeRegExp(sumVariable)}\\s*,\\s*0\\s*\\)|${escapeRegExp(sumVariable)}))\\s*;?`,
      "u"
    ).exec(body);
    if (!targetWrite) return undefined;
    clampsNonnegative = String(targetWrite[1] || targetWrite[2]).startsWith("Math.max");
  }

  if (!(tableId.index < tableInfo.index && tableInfo.index < sumInit.index && sumInit.index < loopHeader.index)) {
    return undefined;
  }
  if (targetWrite && !(loopClose < targetWrite.index && targetWrite.index < returnSum.index)) return undefined;
  if (!targetWrite && !(loopClose < returnSum.index)) return undefined;

  const guard = guardAroundLoop(body, tableInfo[1], loopHeader.index, loopClose);
  if (guard === false) return undefined;
  const dependentCalls = [...body.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(\s*\)\s*;/gu)]
    .map((match) => ({ name: match[2], index: match.index + match[1].length, text: match[0].slice(match[1].length) }));
  const callsAfter = targetWrite ? targetWrite.index + targetWrite[0].length : loopClose + 1;
  if (dependentCalls.some((call) => !(callsAfter <= call.index && call.index < returnSum.index))) return undefined;
  const allowedRanges = [tableId, tableInfo, sumInit, returnSum, ...(targetWrite ? [targetWrite] : [])];
  if (guard) allowedRanges.push(guard);
  else allowedRanges.push({ index: loopHeader.index, 0: body.slice(loopHeader.index, loopClose + 1) });
  allowedRanges.push(...dependentCalls.map((call) => ({ index: call.index, 0: call.text })));
  if (!containsOnlyRanges(body, allowedRanges)) return undefined;

  return {
    dependentCalls: [...new Set(dependentCalls.map((call) => call.name))],
    ...(clampsNonnegative ? { postTransform: { kind: "clamp", min: 0 } } : {})
  };
}

function guardAroundLoop(body, tableInfo, loopStart, loopClose) {
  const pattern = new RegExp(
    `\\bif\\s*\\(\\s*typeof\\s*(?:\\(\\s*${escapeRegExp(tableInfo)}\\s*\\)|${escapeRegExp(tableInfo)})\\s*!=\\s*(["'])undefined\\1\\s*\\)\\s*\\{`,
    "u"
  );
  const guard = pattern.exec(body);
  if (!guard) return undefined;
  const open = guard.index + guard[0].length - 1;
  const close = balancedBraceClose(body, open);
  if (close <= open || !(open < loopStart && loopClose < close)) return false;
  const inside = body.slice(open + 1, close);
  const localLoopStart = loopStart - open - 1;
  const localLoopEnd = loopClose - open;
  if (!containsOnlyRanges(inside, [{
    index: localLoopStart,
    0: inside.slice(localLoopStart, localLoopEnd)
  }])) return false;
  return { index: guard.index, 0: body.slice(guard.index, close + 1) };
}

function isRowIdExpression(expression, identifiers) {
  const [tableParam, loopVariable, controlParam] = identifiers.map(escapeRegExp);
  return new RegExp(
    `^\\s*${tableParam}\\s*\\+\\s*(["'])\\.\\1\\s*\\+\\s*${loopVariable}\\s*\\+\\s*(["'])\\.\\2\\s*\\+\\s*${controlParam}\\s*$`,
    "u"
  ).test(String(expression));
}

function isRowValueExpression(expression, rowVariable) {
  return new RegExp(
    `^\\$\\(\\s*(["'])(?:input)?\\[name=(["']?)extendDataFormInfo\\.value\\(\\1\\s*\\+\\s*${escapeRegExp(rowVariable)}\\s*\\+\\s*\\1\\)\\2\\]\\1\\s*\\)\\.val\\(\\)\\s*$`,
    "u"
  ).test(String(expression).trim());
}

function containsOnlyRanges(text, ranges) {
  const characters = String(text).split("");
  for (const range of ranges) maskRange(characters, range.index, range.index + range[0].length);
  return stripComments(characters.join("")).trim() === "";
}

function stripComments(value) {
  return String(value || "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\r\n]*/gu, "");
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

function maskRange(characters, start, end) {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
