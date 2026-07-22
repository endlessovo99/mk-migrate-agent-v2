export function findScriptFunctionBody(source = "", functionName = "") {
  const text = String(source || "");
  const masked = maskStringsAndComments(text);
  const namePattern = functionName
    ? escapeRegExp(functionName)
    : "[A-Za-z_$][\\w$]*";
  const declaration = new RegExp(`\\bfunction\\s+${namePattern}\\s*\\(`).exec(masked);
  if (!declaration) return undefined;

  const openParen = masked.indexOf("(", declaration.index);
  const closeParen = findMatchingDelimiter(masked, openParen, "(", ")");
  if (closeParen < 0) return undefined;
  const openBrace = skipTrivia(text, closeParen + 1);
  if (text[openBrace] !== "{") return undefined;
  return { openBrace, bodyStart: openBrace + 1 };
}

export function inspectLeadingViewStatusGuard(source = "", options = {}) {
  const text = String(source || "");
  const functionBody = findScriptFunctionBody(text, options.functionName);
  if (!functionBody) return undefined;

  const statementStart = skipTrivia(text, functionBody.bodyStart);
  if (!keywordAt(text, statementStart, "if")) return undefined;
  const openParen = skipTrivia(text, statementStart + 2);
  if (text[openParen] !== "(") return undefined;
  const closeParen = findMatchingDelimiter(text, openParen, "(", ")");
  if (closeParen < 0) return undefined;

  const statuses = parseViewStatusCondition(text.slice(openParen + 1, closeParen));
  if (!statuses?.length) return undefined;
  const fallback = parseGuardFallback(text, closeParen + 1);
  if (!fallback) return undefined;

  const expectedFallback = options.event === "onBeforeSubmit" ? "return true" : "return";
  if (fallback.kind !== expectedFallback) return undefined;
  return {
    statuses,
    statementStart,
    statementEnd: fallback.end,
    bodyStart: functionBody.bodyStart
  };
}

export function hasEquivalentLeadingViewStatusGuard(source, statuses, options = {}) {
  if (!Array.isArray(statuses) || !statuses.length) return false;
  const guard = inspectLeadingViewStatusGuard(source, options);
  return Boolean(guard) && sameStrings(guard.statuses, statuses);
}

function parseGuardFallback(source, start) {
  const index = skipTrivia(source, start);
  if (source[index] === "{") {
    const closeBrace = findMatchingDelimiter(source, index, "{", "}");
    if (closeBrace < 0) return undefined;
    const inner = parseBareReturn(source, index + 1, closeBrace);
    if (!inner || skipTrivia(source, inner.end) !== closeBrace) return undefined;
    return { ...inner, end: closeBrace + 1 };
  }
  return parseBareReturn(source, index);
}

function parseBareReturn(source, start, boundary = source.length) {
  let index = skipTrivia(source, start);
  if (!keywordAt(source, index, "return")) return undefined;
  index = skipTrivia(source, index + "return".length);

  let kind = "return";
  if (keywordAt(source, index, "true")) {
    kind = "return true";
    index = skipTrivia(source, index + "true".length);
  }

  if (source[index] === ";") return { kind, end: index + 1 };
  if (index === boundary || source[index] === "}") return { kind, end: index };
  return undefined;
}

function parseViewStatusCondition(condition) {
  const tokens = tokenizeCondition(condition);
  if (!tokens) return undefined;
  let index = 0;

  function parseExpression() {
    const statuses = parseTerm();
    if (!statuses) return undefined;
    while (tokens[index]?.type === "and") {
      index += 1;
      const right = parseTerm();
      if (!right) return undefined;
      statuses.push(...right);
    }
    return statuses;
  }

  function parseTerm() {
    if (tokens[index]?.type === "open") {
      index += 1;
      const nested = parseExpression();
      if (!nested || tokens[index]?.type !== "close") return undefined;
      index += 1;
      return nested;
    }
    const sequence = tokens.slice(index, index + 5);
    if (
      sequence[0]?.type !== "identifier" || sequence[0].value !== "MKXFORM" ||
      sequence[1]?.type !== "dot" ||
      sequence[2]?.type !== "identifier" || sequence[2].value !== "viewStatus" ||
      sequence[3]?.type !== "not-equal" ||
      sequence[4]?.type !== "string"
    ) {
      return undefined;
    }
    index += 5;
    return [sequence[4].value];
  }

  const statuses = parseExpression();
  return statuses?.length && index === tokens.length ? statuses : undefined;
}

function tokenizeCondition(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    index = skipTrivia(source, index);
    if (index >= source.length) break;
    if (source.startsWith("!==", index)) {
      tokens.push({ type: "not-equal" });
      index += 3;
      continue;
    }
    if (source.startsWith("&&", index)) {
      tokens.push({ type: "and" });
      index += 2;
      continue;
    }
    if (source[index] === ".") {
      tokens.push({ type: "dot" });
      index += 1;
      continue;
    }
    if (source[index] === "(") {
      tokens.push({ type: "open" });
      index += 1;
      continue;
    }
    if (source[index] === ")") {
      tokens.push({ type: "close" });
      index += 1;
      continue;
    }
    if (source[index] === "\"" || source[index] === "'") {
      const literal = readStringLiteral(source, index);
      if (!literal) return undefined;
      tokens.push({ type: "string", value: literal.value });
      index = literal.end;
      continue;
    }
    const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(index));
    if (identifier) {
      tokens.push({ type: "identifier", value: identifier[0] });
      index += identifier[0].length;
      continue;
    }
    return undefined;
  }
  return tokens;
}

function readStringLiteral(source, start) {
  const quote = source[start];
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1];
      if (next === undefined || next === "\n" || next === "\r") return undefined;
      value += next;
      index += 1;
      continue;
    }
    if (char === quote) return { value, end: index + 1 };
    if (char === "\n" || char === "\r") return undefined;
    value += char;
  }
  return undefined;
}

function findMatchingDelimiter(source, start, open, close) {
  if (source[start] !== open) return -1;
  let depth = 0;
  let mode = "";
  let quote = "";
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (!mode && char === "/" && next === "/") {
      mode = "line-comment";
      index += 1;
      continue;
    }
    if (!mode && char === "/" && next === "*") {
      mode = "block-comment";
      index += 1;
      continue;
    }
    if (!mode && ["\"", "'", "`"].includes(char)) {
      mode = "string";
      quote = char;
      continue;
    }
    if (mode === "line-comment") {
      if (char === "\n") mode = "";
      continue;
    }
    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        mode = "";
        index += 1;
      }
      continue;
    }
    if (mode === "string") {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        mode = "";
        quote = "";
      }
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function skipTrivia(source, start) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    break;
  }
  return index;
}

function keywordAt(source, index, keyword) {
  if (!source.startsWith(keyword, index)) return false;
  const before = source[index - 1] || "";
  const after = source[index + keyword.length] || "";
  return !/[\w$]/.test(before) && !/[\w$]/.test(after);
}

function maskStringsAndComments(source) {
  let result = "";
  let mode = "";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (!mode && char === "/" && next === "/") {
      mode = "line-comment";
      result += "  ";
      index += 1;
      continue;
    }
    if (!mode && char === "/" && next === "*") {
      mode = "block-comment";
      result += "  ";
      index += 1;
      continue;
    }
    if (!mode && ["\"", "'", "`"].includes(char)) {
      mode = "string";
      quote = char;
      result += " ";
      continue;
    }
    if (mode === "line-comment") {
      result += char === "\n" ? "\n" : " ";
      if (char === "\n") mode = "";
      continue;
    }
    if (mode === "block-comment") {
      result += char === "\n" ? "\n" : " ";
      if (char === "*" && next === "/") {
        result += " ";
        index += 1;
        mode = "";
      }
      continue;
    }
    if (mode === "string") {
      if (char === "\\") {
        result += "  ";
        index += 1;
      } else {
        result += char === "\n" ? "\n" : " ";
        if (char === quote) {
          mode = "";
          quote = "";
        }
      }
      continue;
    }
    result += char;
  }
  return result;
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
